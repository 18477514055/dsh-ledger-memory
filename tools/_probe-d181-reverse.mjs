/**
 * ★★★★★ 反向验证（D181）：摘掉目标树的**核心承诺** ⇒ 断言必须变红。
 *
 * ★ 为什么必须做（纪律 10）：D181 的核心承诺是
 *   **「文件里是卡片，树是算出来的」**（结构是派生物，不是第二份真相）。
 *   而这条承诺**极易被后人"顺手打破"** —— 例如为了"快一点"把 `roots` 缓存到盘上、
 *   或让 `upsert` 只更新卡片而不重算结构。那样**全文仍然语法正确**，
 *   而且**大多数断言仍然绿**（因为"能建树"这件事还成立）。
 *   ⇒ 只有反向验证能证明「74①f（只改文件里的 parent，树跟着变）」真的在拦。
 *
 * ★ 摘法：让 `buildGoalTree` **不再从卡片推导**，而是**返回上一次的缓存结构**
 *   （最典型的"第二份真相"写法）。这会让 74①f 的 `roots.length` 不再跟着文件变。
 *
 * ★ 探针**无条件还原**并逐字节校验（sha256）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const PLUGIN = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const LIB = path.join(PLUGIN, "lib", "index.js");
const SELFTEST = path.join(PLUGIN, "tools", "selftest.mjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const original = fs.readFileSync(LIB);
const origSha = sha(original);
console.log(`⓪ 备份 sha256=${origSha.slice(0, 16)}… (${original.length} B)`);

let s = original.toString("utf8");

// ── 摘点：让"树根"**不按 parent 推导**，而是永远把所有卡都当树根 ────────────
//   ⇒ 这是"不推导结构"的最小复现：卡片还在、但结构不再由文件决定。
//   ★ 选它而不是"缓存到盘上"：后者要改多处、更容易误伤；这一处改动**只动判据本身**。
const NEEDLE = `  for (const c of list) {
    if (c.parent === null || c.parent === undefined) {
      roots.push(c.id);
      continue;
    }`;
const n = s.split(NEEDLE).length - 1;
console.log(`① 树根推导判据命中 ${n} 次（应为 1）`);
if (n !== 1) {
  console.log("★ 定位失败（锚点漂了）⇒ 不改动，退出。★ 这本身也是有用信号。");
  process.exit(1);
}

s = s.replace(
  NEEDLE,
  `  for (const c of list) {
    if (true /* ★反向验证 D181：结构不再由 parent 推导 */) {
      roots.push(c.id);
      continue;
    }`
);
fs.writeFileSync(LIB, s);
console.log(`   已写入退化版 sha256=${sha(fs.readFileSync(LIB)).slice(0, 16)}…`);

console.log(`\n=========== 自检（结构不再推导之后）===========`);
let out = "";
try {
  out = execFileSync(process.execPath, [SELFTEST], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
}
const lines = out.split("\n");
const red = lines.filter((l) => /^\s*FAIL/.test(l));
console.log(`--- 红：${red.length} 条 ---`);
for (const r of red.slice(0, 20)) console.log("   " + r.trim().slice(0, 150));
for (const x of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + x.trim());
fs.writeFileSync(path.join(os.tmpdir(), "d181-reverse-out.txt"), out);

// ★ 无条件还原
fs.writeFileSync(LIB, original);
const restored = sha(fs.readFileSync(LIB));
console.log(`\n④ 已还原。sha256=${restored}`);
console.log(`   ${restored === origSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌（必须手工处理）"}`);
const coreRed = red.some((l) => /74①/.test(l));
console.log(
  coreRed
    ? "\n⇒ ★ 结论：结构不再推导后**确实见红** ⇒ 「树是算出来的」真的有牙 ✅"
    : "\n⇒ ★★ 结论：摘掉后仍全绿 ⇒ ★★★ 那条承诺是摆设，必须重写"
);
