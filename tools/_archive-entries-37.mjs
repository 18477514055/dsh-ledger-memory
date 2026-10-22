#!/usr/bin/env node
/**
 * 台账归档：把最旧的 6 条回合条目（`- [a5dd] 14:2x` … `- [a5dd] 00:1x`）
 * 从活跃台账移进归档文件。
 *
 * ★★★★★ 为什么用脚本而不是 `ledger_archive` 工具（这是本项目的第 5 次同类事故后的结论）：
 *   `ledger_archive` 要求同时传 `entries`（要移走的原文）与 `newActive`（移走后的**全文**）。
 *   这个台账 59 KB / 531 行 ⇒ **两个参数合起来 5 万多字符必须由我"打字"输入**。
 *   而前四次失败（`lostLines: 5 / 3 / 6 / 2`）**全都是同一个原因**：
 *     **我打出来的文本与磁盘上的文本不可能逐字相同。**
 *   ⇒ 本轮换成：**脚本直接操作磁盘，零转抄**。
 *     脚本自己证明"移走的 + 剩下的 === 原来的"（字节级），不依赖任何人的手。
 *
 * ★ 安全设计：
 *   · 默认 **dry-run**（什么都不写）；加 `--apply` 才真写。
 *   · 归档文件 **no-clobber**：目标已存在就拒绝（绝不覆盖历史）。
 *   · 写完之后**重新从磁盘读回来**再验一遍：
 *       ① 归档文件里真的含那段原文（逐字节）
 *       ② newActive + 移走的 === 原始全文（逐字节）
 *       ③ 活跃台账行数 < 400
 *   · 任何一项不过 ⇒ 立即把活跃台账**还原成原始字节**并退出非 0。
 *
 * ★ 用法：node tools/_archive-entries-37.mjs [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const MEM = path.join(ROOT, "10.项目台账-ledger-memory");
const ACTIVE = path.join(MEM, "LEDGER.md");

const APPLY = process.argv.includes("--apply");

/** 切片边界：从这条**开头**，到那条**开头之前**结束（两条都必须唯一）。 */
const START_MARK = "- [a5dd] 14:2x ";
const END_MARK = "- [a5dd] 00:2x ";

const ARCHIVE = path.join(
  MEM,
  "_ledger-archive",
  "2026-10",
  "week4",
  "2026-10-22-台账§-面板内联布局修复前的回合条目（6条）.md"
);

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const countOcc = (s, sub) => s.split(sub).length - 1;

const original = fs.readFileSync(ACTIVE);
const text = original.toString("utf8");

const nStart = countOcc(text, START_MARK);
const nEnd = countOcc(text, END_MARK);
if (nStart !== 1 || nEnd !== 1) {
  console.error(`✗ 边界标记不唯一：START×${nStart} END×${nEnd} ⇒ 拒绝继续（源码已变）`);
  process.exit(1);
}

const iStart = text.indexOf(START_MARK);
const iEnd = text.indexOf(END_MARK);
if (!(iStart >= 0 && iEnd > iStart)) {
  console.error("✗ 边界顺序不对");
  process.exit(1);
}

const prefix = text.slice(0, iStart);
const slice = text.slice(iStart, iEnd);
const suffix = text.slice(iEnd);
const newActive = prefix + suffix;

// ── 结构自检（写之前就要成立） ──────────────────────────────────────────────
//
//   ★★ 这里我第一版写错了，被自己的守卫当场抓住：
//     我写的是 `newActive + slice !== text` —— 但 slice 是从**中间**切走的，
//     把它接在末尾当然拼不回原文。**错的不是操作，是我的校验式。**
//   ⇒ 正确的不丢字判据是「**按原偏移插回去**」：
//        newActive.slice(0, iStart) + slice + newActive.slice(iStart) === text
//     （iStart 是字符偏移；prefix 长度不变 ⇒ 插回位置仍有效）
const reinserted = newActive.slice(0, iStart) + slice + newActive.slice(iStart);

const problems = [];
if (prefix + slice + suffix !== text) problems.push("三段拼接不成立（逻辑写错）");
if (reinserted !== text) problems.push("按原偏移插回后与原文不一致（会丢字）");
if (newActive !== prefix + suffix) problems.push("newActive 不等于 prefix+suffix");
if (countOcc(text, slice) !== 1) problems.push(`slice 在原文里出现 ${countOcc(text, slice)} 次（必须 1 次）`);
const newLines = newActive.split("\n").length;
if (newLines >= 400) problems.push(`移走后仍有 ${newLines} 行，未低于 400 上限`);
if (slice.length < 1000) problems.push(`slice 只有 ${slice.length} 字符，疑似边界抓错`);

console.log("═".repeat(72));
console.log("台账归档（脚本搬运 · 零转抄）");
console.log("═".repeat(72));
console.log(`模式     : ${APPLY ? "APPLY（真写）" : "DRY-RUN（不写任何东西）"}`);
console.log(`活跃台账 : ${ACTIVE}`);
console.log(`原始     : ${Buffer.byteLength(original, "utf8")} B / ${text.split("\n").length} 行 / sha ${sha(original)}`);
console.log(`移走     : ${Buffer.byteLength(slice, "utf8")} B / ${slice.split("\n").length} 行 / sha ${sha(Buffer.from(slice, "utf8"))}`);
console.log(`剩余     : ${Buffer.byteLength(newActive, "utf8")} B / ${newLines} 行`);
console.log(`归档到   : ${ARCHIVE}`);
console.log(`归档已存在: ${fs.existsSync(ARCHIVE) ? "是 ⇒ 将拒绝写入" : "否"}`);

if (problems.length > 0) {
  console.log("\n✗ 自检未通过，什么都不写：");
  for (const p of problems) console.log(`   · ${p}`);
  process.exit(1);
}
console.log("\n✓ 写前自检全过（round-trip / 唯一性 / 行数 / 体量）");

if (!APPLY) {
  console.log("\n（dry-run 结束；加 --apply 才真写）");
  console.log("\n移走内容的头尾预览：");
  console.log("  ┌─ 头 3 行 ─────────────");
  for (const l of slice.split("\n").slice(0, 3)) console.log("  │ " + l.slice(0, 100));
  console.log("  ├─ 尾 3 行 ─────────────");
  for (const l of slice.split("\n").slice(-4)) console.log("  │ " + l.slice(0, 100));
  console.log("  └───────────────────────");
  process.exit(0);
}

// ── 真写 ───────────────────────────────────────────────────────────────────
if (fs.existsSync(ARCHIVE)) {
  console.error("✗ 归档文件已存在 ⇒ 拒绝覆盖（归档只追加，永不改写历史）");
  process.exit(1);
}

const heading =
  "# 台账归档 · 2026-10-22 · 面板内联布局修复前的回合条目（6 条）\n\n" +
  "> 从活跃台账移出：`- [a5dd] 14:2x` … `- [a5dd] 00:1x`（6 条回合条目）。\n" +
  "> 移出原因：活跃台账 531 行，超 400 行上限多轮。\n" +
  "> 正文全部是当时的进展记录；**结论与判据仍留在活跃台账的后续条目里**。\n\n";

const archiveBody = heading + slice;
const archiveBuf = Buffer.from(archiveBody, "utf8");

fs.mkdirSync(path.dirname(ARCHIVE), { recursive: true });
fs.writeFileSync(ARCHIVE, archiveBuf);

// 先把新活跃台账写到临时文件，验过再换上去（避免"写一半"）
const tmpActive = ACTIVE + ".tmp-" + process.pid;
fs.writeFileSync(tmpActive, Buffer.from(newActive, "utf8"));

// ── 写后从磁盘读回来再验一遍 ───────────────────────────────────────────────
const readBackArchive = fs.readFileSync(ARCHIVE, "utf8");
const readBackNew = fs.readFileSync(tmpActive, "utf8");
const checks = [
  ["归档文件里逐字含移走的原文", readBackArchive.includes(slice)],
  ["归档文件保留了我写的标题（没把原文截断）", readBackArchive.startsWith("# 台账归档 · 2026-10-22")],
  [
    "按原偏移把 slice 插回 newActive === 原始全文（字节级，一个字符都没丢）",
    readBackNew.slice(0, iStart) + slice + readBackNew.slice(iStart) === text,
  ],
  ["活跃台账行数 < 400", readBackNew.split("\n").length < 400],
  ["活跃台账已不含被移走的那 6 条开头", !readBackNew.includes(START_MARK)],
  ["活跃台账仍含未被移走的那条（00:2x）", readBackNew.includes(END_MARK)],
];

let bad = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) bad += 1;
}

if (bad > 0) {
  fs.rmSync(tmpActive, { force: true });
  // 归档文件保留（它是新增的，不损坏原台账）；活跃台账从未被改动。
  console.log(`\n✗ 写后校验有 ${bad} 项不过 ⇒ **活跃台账保持原样未动**（原始 sha ${sha(original)}）`);
  process.exit(1);
}

fs.renameSync(tmpActive, ACTIVE);
// ★ 注意：readFileSync 不传 encoding 返回的是 **Buffer**，Buffer 没有 .split
//   ⇒ 必须先 toString。我第一版漏了这一步，结果**归档已经成功**、
//     只是在最后一行打印时崩了（退出码 1）—— 那种"假失败"最容易让人误以为没写成、于是重跑。
const finalText = fs.readFileSync(ACTIVE, "utf8");
console.log("\n" + "─".repeat(72));
console.log(`✓ 已换上新活跃台账：${finalText.split("\n").length} 行 / ${Buffer.byteLength(finalText, "utf8")} B`);
console.log(`  新 sha ${sha(Buffer.from(finalText, "utf8"))}`);
console.log(`  旧 sha ${sha(original)}`);
console.log(`✓ 归档文件：${ARCHIVE}`);
console.log("─".repeat(72));
