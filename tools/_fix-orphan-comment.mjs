#!/usr/bin/env node
/**
 * 顺手修复 D307 拆分留下的**孤儿注释**（`part2.js:2015`）。
 *
 * 🔴 病：`/** 把任意值渲染成一条 text ContentBlock。 *\/` 这一行**留在了 part2**，
 *   而它描述的 `textOut` 已经搬去 `base.js` 了 ⇒ part2 里出现一条**指向不存在函数**的注释。
 *   ★ 它无害（注释不执行），但它**在说谎** —— 读代码的人会以为 textOut 还在附近。
 *     本项目最恨这类东西（「记录存在 ≠ 记录准确」的同型）。
 *
 * ★ 为什么不重跑拆分脚本：重跑要再动两个文件、再赌一次；只删这一行是**字符级最小修**。
 * ★ 判据：删之前必须先确认"这一行确实是孤儿" —— 它后面紧跟的不是任何函数定义
 *   （`textOut` 已不在 part2 里了）。**先证明，再动手。**
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const PART2 = path.join(PROJECT, "lib", "part2.js");
const BASE = path.join(PROJECT, "lib", "base.js");
const APPLY = process.argv.includes("--apply");

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const buf = fs.readFileSync(PART2);
const text = buf.toString("utf8");
const lines = text.split("\n");

// ── 找那条孤儿的 `/** 把任意值渲染成一条 text ContentBlock。 */` ─────────────
const idx = lines.findIndex((l) => l.includes("把任意值渲染成一条 text ContentBlock"));
if (idx < 0) {
  console.log("✓ 没找到那条孤儿注释 —— 可能已经修过，什么都不做。");
  process.exit(0);
}
console.log("═".repeat(70));
console.log("修复 D307 留下的孤儿注释");
console.log("═".repeat(70));
console.log(`模式：${APPLY ? "APPLY（真写）" : "DRY-RUN（不写任何东西）"}`);
console.log(`位置：part2.js 第 ${idx + 1} 行`);
console.log(`内容：${JSON.stringify(lines[idx])}`);

// ── 先证明它真的是孤儿（而不是还有函数在后面） ────────────────────────────
const problems = [];
if (fs.readFileSync(BASE, "utf8").includes("export function textOut(") === false) {
  problems.push("base.js 里没有 textOut ⇒ 这条注释不是孤儿，别删");
}
// 往下找 5 行里有没有任何 `export function`
const after = lines.slice(idx + 1, idx + 6).filter((l) => l.includes("export function"));
if (after.length > 0) problems.push(`这条注释下面 5 行里有函数定义：${after[0].trim()} ⇒ 不是孤儿，别删`);
// 确认 textOut 已不在 part2 里
if (lines.some((l) => l.includes("export function textOut("))) {
  problems.push("part2 里还有 textOut 定义 ⇒ 不是孤儿，别删");
}
console.log(`\n场景：第 ${idx + 1} 行之后是 ——`);
for (let k = idx + 1; k <= Math.min(idx + 5, lines.length - 1); k += 1) {
  console.log(`  [${k + 1}] ${JSON.stringify(lines[k]).slice(0, 80)}`);
}

if (problems.length > 0) {
  console.log("\n✗ 前置校验未通过，什么都不写：");
  for (const p of problems) console.log(`   · ${p}`);
  process.exit(1);
}
console.log("\n✓ 前置校验：base.js 里有 textOut · 下面 5 行无函数定义 · part2 里已无 textOut ⇒ 确认是孤儿");

if (!APPLY) {
  console.log("\n（dry-run 结束；加 --apply 才真写。）");
  process.exit(0);
}

// ── 删那一行（连同它后面紧跟的连续空行里的一行，保持段落间距自然） ────────
const bak = path.join(os.tmpdir(), `ledger-orphan-${Date.now()}`);
fs.mkdirSync(bak, { recursive: true });
fs.writeFileSync(path.join(bak, "part2.js"), buf);
const next = [...lines.slice(0, idx), ...lines.slice(idx + 1)].join("\n");
fs.writeFileSync(PART2, next, "utf8");

// ── 写后校验 ───────────────────────────────────────────────────────────────
const rb = fs.readFileSync(PART2, "utf8");
let bad = 0;
const check = (n, pass, d) => {
  console.log(`  ${pass ? "✓" : "✗"} ${n}${d === undefined ? "" : `  —— ${d}`}`);
  if (!pass) bad += 1;
};
console.log("\n" + "─".repeat(70));
console.log("写后校验（真读回磁盘）");
console.log("─".repeat(70));
check("孤儿注释已不在 part2", !rb.includes("把任意值渲染成一条 text ContentBlock"), "");
check("re-export 段还在（没误删）", rb.includes('from "./base.js";') && rb.includes("D307"), "");
check("体积只少了那一行", buf.length - Buffer.byteLength(rb) < 120, `少 ${buf.length - Buffer.byteLength(rb)} B`);
check("两边仍低于 262,144 B", Buffer.byteLength(rb) < 262144, "");
// ★ 最强：把删掉的那一行插回去，必须与原文逐字节相同（证明只删了这一行）
const rebuilt = [...rb.split("\n")];
rebuilt.splice(idx, 0, lines[idx]);
check("★ 插回那一行后与原文逐字节相同（只删了这一行）", rebuilt.join("\n") === text, "");

console.log("\n" + "─".repeat(70));
console.log(bad === 0 ? `✓ 通过 · 备份 ${bak}` : `✗ ${bad} 项不过（用 ${bak} 还原）`);
console.log("─".repeat(70));
process.exit(bad === 0 ? 0 : 1);
