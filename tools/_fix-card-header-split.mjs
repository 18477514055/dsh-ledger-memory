#!/usr/bin/env node
/**
 * 修复 D307 第二刀把「卡片化」标题块劈开的问题（`part4.js:1897-1907`）。
 *
 * 🔴 病：原文件里是
 *     ═══（开）
 *     // ★★★★ 2026-10-14（D202，用户拍板）：**卡片化** —— 一卡一文件
 *     ═══（合）
 *   而我把 re-export 插在了**第 2 行之后**（因为找 ═ 分隔线时从 start 往前退，"开"那行先被撞到）
 *   ⇒ 标题被夹在两条 ═ 之间**劈成两半**，视觉上还多出一个空行。
 *
 * ★ 它**不影响执行**（纯注释），但它**在说谎**：读代码的人会以为那条 ═ 分隔线是标题的下边界，
 *   而标题下面紧接着的其实是 re-export。本项目最忌这类东西（记录存在 ≠ 记录准确）。
 *
 * ★ 修法（字符级最小）：把那条**单独的 ═ 收尾线**从标题中间移走，
 *   让「开 / 标题 / 合」重新连续，re-export 整段落到标题块**之后**。
 * ★ 判据：修完必须满足 ①`开+标题+合` 三行连续出现；② 除这一处移动外**原文其余逐字节不变**。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const PART4 = path.join(PROJECT, "lib", "part4.js");
const APPLY = process.argv.includes("--apply");

const text = fs.readFileSync(PART4, "utf8");
const lines = text.split("\n");

// ── 定位那三行 ─────────────────────────────────────────────────────────────
const iTitle = lines.findIndex((l) => l.includes("2026-10-14（D202，用户拍板）：**卡片化**"));
if (iTitle < 0) {
  console.log("✓ 没找到那条标题 —— 可能已修过，什么都不做。");
  process.exit(0);
}
console.log("═".repeat(72));
console.log("修复 D307 第二刀劈开的「卡片化」标题块");
console.log("═".repeat(72));
console.log(`模式：${APPLY ? "APPLY（真写）" : "DRY-RUN（不写任何东西）"}`);
console.log(`标题行：${iTitle + 1}`);

const isRule = (l) => l !== undefined && l.startsWith("// ═");
const openRule = iTitle - 1;
const afterTitle = iTitle + 1;

// ── 先证明"确实被劈开了" ───────────────────────────────────────────────────
// 症状：标题上一行是 ═（开），标题下一行是空行，再下一行又是 ═（本该是 re-export 的注释起点）
//       而更后面才是 D307 段。
const problems = [];
if (!isRule(lines[openRule])) problems.push(`第 ${openRule + 1} 行不是 ═ 分隔线（前提变了，别动）`);
if (lines[afterTitle].trim() !== "") problems.push(`第 ${afterTitle + 1} 行不是空行（前提变了，别动）`);
if (!isRule(lines[afterTitle + 1])) problems.push(`第 ${afterTitle + 2} 行不是 ═ 分隔线（前提变了，别动）`);
const iD307 = lines.findIndex((l) => l.includes("D307 第二刀"));
if (iD307 < 0) problems.push("找不到 D307 段");
// 确认结构是：开 / 标题 / 空 / 合 / D307注释... / 合 / export
if (problems.length === 0) {
  const okShape =
    isRule(lines[openRule]) &&
    lines[afterTitle].trim() === "" &&
    isRule(lines[afterTitle + 1]) &&
    iD307 > afterTitle + 1;
  if (!okShape) problems.push("整体形状与预期不符（不猜，停手）");
}
console.log("\n现场（标题附近）:");
for (let k = openRule; k <= Math.min(afterTitle + 3, lines.length - 1); k += 1) {
  console.log(`  [${k + 1}] ${JSON.stringify(lines[k]).slice(0, 90)}`);
}

if (problems.length > 0) {
  console.log("\n✗ 前置校验未通过，什么都不写：");
  for (const p of problems) console.log(`   · ${p}`);
  process.exit(1);
}
console.log("\n✓ 已确认：标题被两条 ═ 夹住、中间还隔一个空行 ⇒ 就是被劈开的那处");

if (!APPLY) {
  console.log("\n（dry-run 结束；加 --apply 才真写。）");
  process.exit(0);
}

// ── 修：删掉「标题后的空行 + 那条 ═」(即 afterTitle 与其后一行) ─────────────
//   这样变成 开 / 标题 / 合(原来的第二条) ...，再把紧随其后的 D307 段整体当作"新的一节"
const bak = path.join(os.tmpdir(), `ledger-fix202-${Date.now()}`);
fs.mkdirSync(bak, { recursive: true });
fs.writeFileSync(path.join(bak, "part4.js"), text);

// ★ 具体做法：把 [afterTitle, afterTitle+1] 这两行（空行 + ═）**移到 D307 段之后**不行 ——
//   那会制造新问题。正解是**删掉它们**：原本"标题 / 空 / ═" 这个尾巴本来就是**我给 re-export 加的**
//   （reexport 字符串以 `\n// ═…` 开头），而不是原文的一部分。
const removed = lines.slice(afterTitle, afterTitle + 2);
const next = [...lines.slice(0, afterTitle), ...lines.slice(afterTitle + 2)].join("\n");
fs.writeFileSync(PART4, next, "utf8");
console.log(`\n删掉 2 行（第 ${afterTitle + 1}–${afterTitle + 2}）：`);
for (const r of removed) console.log(`   — ${JSON.stringify(r).slice(0, 90)}`);

// ── 写后校验 ───────────────────────────────────────────────────────────────
const rb = fs.readFileSync(PART4, "utf8");
const R = rb.split("\n");
let bad = 0;
const check = (n, pass, d) => {
  console.log(`  ${pass ? "✓" : "✗"} ${n}${d === undefined ? "" : `  —— ${d}`}`);
  if (!pass) bad += 1;
};
console.log("\n" + "─".repeat(72));
console.log("写后校验");
console.log("─".repeat(72));
const t2 = R.findIndex((l) => l.includes("2026-10-14（D202，用户拍板）：**卡片化**"));
check("标题上一行仍是 ═", isRule(R[t2 - 1]), "");
check("标题**下一行**紧接 ═（标题块闭合了）", isRule(R[t2 + 1]), JSON.stringify(R[t2 + 1] ?? "").slice(0, 60));
check("标题与收尾 ═ 之间不再有空行", R[t2 + 1] === R[t2 + 1].trim() && !isRule(R[t2 + 2]) === false || isRule(R[t2 + 1]), "");
check("D307 段仍在，且在标题块之后", R.findIndex((l) => l.includes("D307 第二刀")) > t2, "");
check("re-export 段仍完整", rb.includes('} from "./card-ops.js";'), "");
check(
  "只少了 2 行（体积差 = 那 2 行）",
  text.length - rb.length === removed.join("\n").length + 1,
  `少 ${text.length - rb.length} 字符 · 删的两行共 ${removed.join("\n").length + 1}`
);
// 最强：把删的两行插回去必须与原文逐字节相同
const rebuilt = [...R];
rebuilt.splice(afterTitle, 0, ...removed);
check("★ 插回那 2 行后与修复前逐字节相同（只删了这 2 行）", rebuilt.join("\n") === text, "");

console.log("\n" + "─".repeat(72));
console.log(bad === 0 ? `✓ 通过 · 备份 ${bak}` : `✗ ${bad} 项不过（用 ${bak} 还原）`);
console.log("─".repeat(72));
process.exit(bad === 0 ? 0 : 1);
