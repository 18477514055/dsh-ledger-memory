#!/usr/bin/env node
/**
 * 把**根目录那份泄露出来的**「用户原话-完整存档.md」并回记忆目录，然后把原文件搬去 `_retired`（**不删**）。
 *
 * ★★★ 为什么不能"直接把根目录那份删掉"（探针 `_probe-usermsg-archive-merge.mjs` 实测）：
 *   根·week3 有 **7 条**、根·week4 有 **29 条**是记忆目录里**没有**的 ⇒ **直接删会丢 36 条用户原话**。
 *   而这份文件的价值正是"一旦记住就永不丢"（D170）—— 丢一条就违背它存在的全部理由。
 *
 * ★★★ 为什么不能"整份覆盖过去"：
 *   记忆目录那份有 **1935 条**，根目录两份合计才 819 条 ⇒ 覆盖 = 丢掉 1100+ 条。
 *   ⇒ 判据：**两个方向都会丢数据，所以只能做"补集合并"**。
 *
 * ★ 合并粒度 = **条目行**（`- YYYY-MM-DD …`），不是字节、不是整份：
 *   要回答的问题是"哪些是多的"，字节比只能回答"它们不一样"。
 *
 * ★ 分桶保持原样（根 week3 → 记忆 week3，根 week4 → 记忆 week4）：
 *   不是审美选择，是因为 `archiveStamp()` 的期间键就是按**淘汰发生时刻**分的
 *   （`part2.js:2304`），跟内容无关 ⇒ 硬改桶名只会把两份不同来源的流搅在一起。
 *   ⚠️ 副作用（如实记录）：根·week4 那 495 条里有 466 条本来就在**记忆·week3** 里
 *   ⇒ 合并后 `记忆·week4` 只装那 29 条**独占**内容，看起来"稀疏"—— 那是真实情况，不是漏了。
 *
 * ★ 旧文件搬去 `$DSH_HOME\plugin-data\dsh-ledger-memory\_retired\<项目名>\` —— 与
 *   `migrateToV3` 第 ⑤ 步**同一个去处、同一条纪律**（挪走不删，删了不可逆）。
 *
 * ★ 用法：
 *   node tools/_merge-leaked-usermsg.mjs            # dry-run
 *   node tools/_merge-leaked-usermsg.mjs --apply    # 真写
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const MEM = path.join(PROJECT, "10.项目台账-ledger-memory");
const NAME = "用户原话-完整存档.md";
const APPLY = process.argv.includes("--apply");

const ENTRY = /^-\s+\d{4}-\d{2}-\d{2}/;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);

const HEADER =
  "# 用户原话 · 完整存档（**只追加，永不删除**）\n\n" +
  "> ★ 这里放的是**从胶囊里被挤出去的**用户原话。\n" +
  "> **胶囊负责「最近的、要进上下文的」；本文件负责「一旦记住就永不丢」。**\n" +
  "> 查法：`ledger_log({view:\"users\"})` 看 **L4**（那是**全量**）；\n" +
  "> 本文件是被挤出去那部分的**兜底副本**，两者互补。\n\n";

/** 读一个文件 → { exists, bytes, entries:[...] } */
function load(p) {
  if (!fs.existsSync(p)) return { exists: false, entries: [] };
  const buf = fs.readFileSync(p);
  const lines = buf.toString("utf8").split("\n");
  return {
    exists: true,
    bytes: buf.length,
    sha: sha(buf),
    entries: lines.filter((l) => ENTRY.test(l)),
  };
}

// ── ① 记忆目录现有全集（跨周合并去重） ────────────────────────────────────
const memArchiveRoot = path.join(MEM, "_ledger-archive");
const memFiles = [];
if (fs.existsSync(memArchiveRoot)) {
  for (const ym of fs.readdirSync(memArchiveRoot, { withFileTypes: true })) {
    if (!ym.isDirectory()) continue;
    for (const wk of fs.readdirSync(path.join(memArchiveRoot, ym.name), { withFileTypes: true })) {
      if (!wk.isDirectory()) continue;
      const p = path.join(memArchiveRoot, ym.name, wk.name, NAME);
      if (fs.existsSync(p)) memFiles.push({ rel: `${ym.name}/${wk.name}`, p, ...load(p) });
    }
  }
}
const memSet = new Set();
for (const f of memFiles) for (const e of f.entries) memSet.add(e);

console.log("═".repeat(78));
console.log("把根目录泄露的原话存档并回记忆目录（补集合并）");
console.log("═".repeat(78));
console.log(`模式：${APPLY ? "APPLY（真写）" : "DRY-RUN（不写任何东西）"}`);
console.log(`记忆目录现有：${memFiles.length} 个期间桶 · 合计 ${memSet.size} 条唯一原话`);
for (const f of memFiles) console.log(`   · ${f.rel}  ${f.bytes} B · ${f.entries.length} 条`);

// ── ② 根目录那几份：算出各自的"记忆目录没有的"条目 ──────────────────────
const rootArchiveRoot = path.join(PROJECT, "_ledger-archive");
const plan = [];
if (fs.existsSync(rootArchiveRoot)) {
  for (const ym of fs.readdirSync(rootArchiveRoot, { withFileTypes: true })) {
    if (!ym.isDirectory()) continue;
    for (const wk of fs.readdirSync(path.join(rootArchiveRoot, ym.name), { withFileTypes: true })) {
      if (!wk.isDirectory()) continue;
      const p = path.join(rootArchiveRoot, ym.name, wk.name, NAME);
      if (!fs.existsSync(p)) continue;
      const got = load(p);
      // ★★ 必须**去重**：`entries` 是行数组，同一句话可能在文件里出现多次
      //   （实测根·week3 有 324 行但唯一条目更少）。不去重 ⇒ ① 会把重复行再追加一遍；
      //   ② 写后校验那条「增量 === totalOrphans」永远对不上（假红）。
      //   ★ 判据：**"行数"与"条数"是两个量**，这里要的是"还没被记住的**那些话**"，是条数。
      const orphans = [...new Set(got.entries.filter((e) => !memSet.has(e)))];
      plan.push({ rel: `${ym.name}/${wk.name}`, p, ...got, orphans, dupInFile: got.entries.length - new Set(got.entries).size });
    }
  }
}

if (plan.length === 0) {
  console.log("\n✓ 根目录下没有「用户原话-完整存档.md」⇒ 没有要合并的东西。");
  process.exit(0);
}

console.log("\n" + "─".repeat(78));
console.log("根目录泄露文件 → 要补进记忆目录的「独占」条目");
console.log("─".repeat(78));
let totalOrphans = 0;
for (const t of plan) {
  totalOrphans += t.orphans.length;
  console.log(`  ${t.rel}：${t.bytes} B · ${t.entries.length} 条 ⇒ **独占 ${t.orphans.length} 条**`);
  const dst = path.join(MEM, "_ledger-archive", t.rel, NAME);
  console.log(`     合并去向：${dst}${fs.existsSync(dst) ? "" : "（文件不存在 ⇒ 会新建）"}`);
  for (const e of t.orphans.slice(0, 3)) console.log(`       + ${e.slice(0, 92)}`);
}
console.log(`\n合计要补：**${totalOrphans}** 条`);

// ── ③ 写 ─────────────────────────────────────────────────────────────────
if (!APPLY) {
  console.log("\n（dry-run 结束；加 --apply 才真写。）");
  process.exit(0);
}

const written = [];
for (const t of plan) {
  if (t.orphans.length === 0) continue;
  const dst = path.join(MEM, "_ledger-archive", t.rel, NAME);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const exists = fs.existsSync(dst);
  let prefix = "";
  if (!exists) {
    prefix = HEADER;
  } else {
    const cur = fs.readFileSync(dst, "utf8");
    if (cur !== "" && !cur.endsWith("\n")) prefix = "\n";
  }
  fs.appendFileSync(dst, prefix + t.orphans.join("\n") + "\n", "utf8");
  written.push({ dst, added: t.orphans.length, created: !exists });
}

// ── ④ 写后从磁盘读回来验（不信自己刚才写的） ─────────────────────────────
const memSet2 = new Set();
for (const f of memFiles) {
  for (const e of load(f.p).entries) memSet2.add(e);
}
for (const w of written) {
  for (const e of load(w.dst).entries) memSet2.add(e);
}
const problems = [];
for (const t of plan) {
  const lost = t.entries.filter((e) => !memSet2.has(e));
  if (lost.length > 0) problems.push(`${t.rel} 仍有 ${lost.length} 条不在记忆目录里`);
}
// ★★★ 校验式必须用「并集是否覆盖」而不是「并集增量 === 补入条数」：
//   后者的前提是"两份源文件之间没有重复"，而实测根·week3 那 7 条**同时也出现在**根·week4 里
//   ⇒ 36 条补进两个桶，并集只涨 29。这不是缺陷，是**同一句话在两次压缩里各被挤出一次**。
//   我第一次写成 增量===36，它报 ✗ —— 那是**尺子错了**（尺子 11：记录存在≠记录准确 的同型）。
console.log("\n" + "─".repeat(78));
console.log("写后校验（真读回磁盘比对）");
console.log("─".repeat(78));
for (const w of written) console.log(`  ✓ 已追加 ${w.added} 条 → ${w.dst}${w.created ? "（新建）" : ""}`);
console.log(`  合并后记忆目录唯一原话：**${memSet2.size}** 条（原 ${memSet.size}）`);
console.log(`  补入 ${totalOrphans} 条 · 并集净增 ${memSet2.size - memSet.size} 条（差额 = 跨桶重复，正常）`);
for (const p of problems) console.log(`  ✗ ${p}`);
if (problems.length > 0) {
  console.log("\n✗ 校验不过 ⇒ **① 不搬走任何根目录文件**（否则就真丢了）。");
  process.exit(1);
}
console.log("  ✓ 根目录两份的**每一条**原话现在都在记忆目录里（零丢失）");

// ── ⑤ 根目录原件搬去 _retired（不删） ────────────────────────────────────
// ★★★ 实测坑（EXDEV）：`rename` 只能在同一卷内原子移动。这份项目在 D:，`$DSH_HOME` 在 C:
//   ⇒ 直接 renameSync 会抛 `EXDEV: cross-device link not permitted`，而且**那时数据已经合并完、
//     根目录原件却还在** —— 半完成状态（最坏的一种：同一句话存在两处，没人知道哪份是权威）。
//   ⇒ 修法：**先复制 → 校验目标字节相同 → 才删源**（跨卷没有原子的"移动"，只能自己造）。
const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const stampSec = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const retiredTo = path.join(
  home,
  "plugin-data",
  "dsh-ledger-memory",
  "_retired",
  path.basename(PROJECT),
  `leaked-usermsg-${stampSec}`
);
fs.mkdirSync(retiredTo, { recursive: true });
for (const t of plan) {
  const to = path.join(retiredTo, t.rel.split("/").join("__") + "__" + NAME);
  const src = fs.readFileSync(t.p);
  fs.writeFileSync(to, src);
  // ★ 复制的判据是**字节相同**，不是"目标文件存在"（后者对空文件也成立）
  if (!fs.readFileSync(to).equals(src)) {
    console.log(`  ✗ 复制校验不通过，**源文件保留不动**：${t.p}`);
    process.exit(1);
  }
  fs.rmSync(t.p);
  console.log(`  → 搬走 ${t.rel}/${NAME} → ${to}（复制校验字节相同后删除源）`);
}
// 清掉根目录下变空的期间目录（只删空目录，不递归删任何文件）
try {
  for (const ym of fs.readdirSync(rootArchiveRoot, { withFileTypes: true })) {
    if (!ym.isDirectory()) continue;
    const ymp = path.join(rootArchiveRoot, ym.name);
    for (const wk of fs.readdirSync(ymp, { withFileTypes: true })) {
      if (!wk.isDirectory()) continue;
      const wkp = path.join(ymp, wk.name);
      if (fs.readdirSync(wkp).length === 0) fs.rmdirSync(wkp);
    }
    if (fs.readdirSync(ymp).length === 0) fs.rmdirSync(ymp);
  }
  if (fs.readdirSync(rootArchiveRoot).length === 0) fs.rmdirSync(rootArchiveRoot);
} catch (e) {
  console.log(`  ⚠ 清理空目录时出错（不影响数据）：${String(e && e.message)}`);
}
console.log("\n" + "─".repeat(78));
console.log(`✓ 完成：补 ${totalOrphans} 条 · 原件搬去 ${retiredTo}`);
console.log(`  根目录 _ledger-archive 是否还在：${fs.existsSync(rootArchiveRoot) ? "在（非空，需人工看）" : "已不存在 ✓"}`);
console.log("─".repeat(78));
