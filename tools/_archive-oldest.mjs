#!/usr/bin/env node
/**
 * 通用台账归档器：把活跃台账里**最旧的 N 条**回合条目（`- [a5dd] …`）移进归档文件。
 *
 * ★★★ 为什么是脚本、而且必须"零转抄"（本项目第 5 次同类事故后的定论）：
 *   `ledger_archive` 要求同时传 `entries`（移走原文）+ `newActive`（移走后的**全文**）。
 *   这个台账 40 KB / 400 行 ⇒ **两个参数合计 4 万多字符必须由我"打字"输入**，
 *   而前四次失败（`lostLines: 5 / 3 / 6 / 2`）**全是同一个原因**：
 *     **我打出来的文本与磁盘上的文本不可能逐字相同。**
 *   ⇒ 脚本直接操作磁盘：**一个字节都不经过手**。
 *     并自己证明「按原偏移把移走的插回去 === 原始全文」（字节级）。
 *
 * ★ 用法：
 *   node tools/_archive-oldest.mjs --count=2 --label="面板内联布局"            # dry-run
 *   node tools/_archive-oldest.mjs --count=2 --label="面板内联布局" --apply    # 真写
 *
 * ★ 安全设计：
 *   · 默认 **dry-run**；`--apply` 才写。
 *   · 归档文件 **no-clobber**（同名已存在就拒绝 —— 归档只追加，永不改写历史）。
 *   · 写后**从磁盘读回来再验**：归档含原文 · 插回后 === 原文 · 行数 < 400 · 边界条目已移走/未移走的还在。
 *   · 任何一项不过 ⇒ **活跃台账保持原样未动**（先写 .tmp，验过才 rename）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const MEM = path.join(ROOT, "10.项目台账-ledger-memory");
const ACTIVE = path.join(MEM, "LEDGER.md");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
};
const APPLY = process.argv.includes("--apply");
const COUNT = Number(arg("count", "0"));
const LABEL = arg("label", "回合条目");
const LIMIT = Number(arg("limit", "400"));

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

if (!Number.isInteger(COUNT) || COUNT < 1) {
  console.error("✗ 必须给 --count=N（N ≥ 1）");
  process.exit(1);
}

const original = fs.readFileSync(ACTIVE);
const text = original.toString("utf8");
const lines = text.split("\n");

// ── 找出所有回合条目的起始行（0-based） ────────────────────────────────────
const ENTRY = /^-\s*\[[0-9a-f]{4}\]\s/;
const starts = [];
lines.forEach((l, i) => {
  if (ENTRY.test(l)) starts.push(i);
});

if (starts.length < COUNT + 1) {
  console.error(`✗ 只有 ${starts.length} 条回合条目，不够移走 ${COUNT} 条（必须留至少 1 条）`);
  process.exit(1);
}

// 字符偏移：用「前 N 行的长度和」算，避免 indexOf 撞到重复文本
const offsetOfLine = (n) => {
  let off = 0;
  for (let i = 0; i < n; i += 1) off += lines[i].length + 1; // +1 = "\n"
  return off;
};

const firstLine = starts[0];
const cutLine = starts[COUNT]; // 第 COUNT+1 条的开头 = 切片终点
const iStart = offsetOfLine(firstLine);
const iEnd = offsetOfLine(cutLine);

const prefix = text.slice(0, iStart);
const slice = text.slice(iStart, iEnd);
const suffix = text.slice(iEnd);
const newActive = prefix + suffix;
const newLines = newActive.split("\n").length;

// ── 写前自检 ───────────────────────────────────────────────────────────────
// ★ 校验式必须是「**按原偏移插回去**」：slice 来自中间，接在末尾是拼不回的
//   （我第一版就写成 newActive + slice === text，被自己的守卫当场抓住）。
const problems = [];
if (prefix + slice + suffix !== text) problems.push("三段拼接不成立（逻辑写错）");
if (newActive.slice(0, iStart) + slice + newActive.slice(iStart) !== text)
  problems.push("按原偏移插回后与原文不一致（会丢字）");
if (text.split(slice).length - 1 !== 1) problems.push("slice 在原文里不唯一");
if (newLines >= LIMIT) problems.push(`移走后仍有 ${newLines} 行，未低于 ${LIMIT}`);
if (slice.length < 200) problems.push(`slice 只有 ${slice.length} 字符，疑似边界抓错`);
if (slice.split("\n").filter((l) => ENTRY.test(l)).length !== COUNT)
  problems.push(`slice 里条目数不是 ${COUNT}`);

// ── 归档目标路径 ───────────────────────────────────────────────────────────
const now = new Date();
const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
  now.getDate()
).padStart(2, "0")}`;
const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const week = `week${Math.ceil(now.getDate() / 7)}`; // archiveWeekMode = "month"
const safeLabel = LABEL.replace(/[\\/:*?"<>|]/g, "-");
const ARCHIVE = path.join(
  MEM,
  "_ledger-archive",
  ym,
  week,
  `${ymd}-台账§-${safeLabel}（${COUNT}条）.md`
);

console.log("═".repeat(72));
console.log("台账归档（脚本搬运 · 零转抄）");
console.log("═".repeat(72));
console.log(`模式     : ${APPLY ? "APPLY（真写）" : "DRY-RUN（不写任何东西）"}`);
console.log(`活跃台账 : ${Buffer.byteLength(text, "utf8")} B / ${lines.length} 行 / sha ${sha(original)}`);
console.log(`回合条目 : 共 ${starts.length} 条，本次移走最旧 ${COUNT} 条`);
console.log(`  第 1 条行号 : ${firstLine + 1}  ${lines[firstLine].slice(0, 56)}`);
console.log(`  切片终点行 : ${cutLine + 1}  ${lines[cutLine].slice(0, 56)}`);
console.log(`移走     : ${Buffer.byteLength(slice, "utf8")} B / ${slice.split("\n").length} 行`);
console.log(`剩余     : ${Buffer.byteLength(newActive, "utf8")} B / ${newLines} 行`);
console.log(`归档到   : ${ARCHIVE}`);
console.log(`归档已存在: ${fs.existsSync(ARCHIVE) ? "是 ⇒ 将拒绝写入" : "否"}`);

if (problems.length > 0) {
  console.log("\n✗ 自检未通过，什么都不写：");
  for (const p of problems) console.log(`   · ${p}`);
  process.exit(1);
}
console.log("\n✓ 写前自检全过（插回验证 / 唯一性 / 条目数 / 行数）");

if (!APPLY) {
  console.log("\n（dry-run 结束；加 --apply 才真写）");
  console.log("\n切片头 2 行 / 尾 2 行：");
  for (const l of slice.split("\n").slice(0, 2)) console.log("  │ " + l.slice(0, 96));
  console.log("  │ …");
  for (const l of slice.split("\n").slice(-3)) console.log("  │ " + l.slice(0, 96));
  process.exit(0);
}

// ── 真写 ───────────────────────────────────────────────────────────────────
if (fs.existsSync(ARCHIVE)) {
  console.error("✗ 归档文件已存在 ⇒ 拒绝覆盖（归档只追加，永不改写历史）");
  process.exit(1);
}

const heading =
  `# 台账归档 · ${ymd} · ${safeLabel}（${COUNT} 条）\n\n` +
  `> 从活跃台账移出最旧的 ${COUNT} 条回合条目（第 ${firstLine + 1}–${cutLine} 行）。\n` +
  `> 移出原因：活跃台账 ${lines.length} 行，超 ${LIMIT} 行上限。\n` +
  `> 正文是当时的进展记录；**结论与判据仍留在活跃台账的后续条目里**。\n\n`;

fs.mkdirSync(path.dirname(ARCHIVE), { recursive: true });
fs.writeFileSync(ARCHIVE, Buffer.from(heading + slice, "utf8"));

const tmpActive = ACTIVE + ".tmp-" + process.pid;
fs.writeFileSync(tmpActive, Buffer.from(newActive, "utf8"));

const rbArchive = fs.readFileSync(ARCHIVE, "utf8");
const rbNew = fs.readFileSync(tmpActive, "utf8");
const checks = [
  ["归档文件里逐字含移走的原文", rbArchive.includes(slice)],
  ["归档文件保留了我写的标题", rbArchive.startsWith(`# 台账归档 · ${ymd}`)],
  ["按原偏移插回 === 原始全文（字节级，一字未丢）", rbNew.slice(0, iStart) + slice + rbNew.slice(iStart) === text],
  [`活跃台账行数 < ${LIMIT}`, rbNew.split("\n").length < LIMIT],
  ["被移走的那几条已不在活跃台账里", !rbNew.includes(lines[firstLine])],
  ["未移走的第一条仍在（边界没多切）", rbNew.includes(lines[cutLine])],
];
let bad = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) bad += 1;
}

if (bad > 0) {
  fs.rmSync(tmpActive, { force: true });
  console.log(`\n✗ 写后校验有 ${bad} 项不过 ⇒ **活跃台账保持原样未动**（sha ${sha(original)}）`);
  process.exit(1);
}

fs.renameSync(tmpActive, ACTIVE);
const finalText = fs.readFileSync(ACTIVE, "utf8");
console.log("\n" + "─".repeat(72));
console.log(`✓ 新活跃台账：${finalText.split("\n").length} 行 / ${Buffer.byteLength(finalText, "utf8")} B`);
console.log(`  新 sha ${sha(Buffer.from(finalText, "utf8"))}`);
console.log(`  旧 sha ${sha(original)}`);
console.log(`✓ 归档：${ARCHIVE}`);
console.log("─".repeat(72));
