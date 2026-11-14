/**
 * D376 补丁二：把 `blockInjectionEnabled` / `fileAnchorEnabled` 从 part3.js 搬到 part3-settings.js。
 *
 * ★ 为什么必须搬（这是拆模块的**双向依赖**问题，本轮实测才撞到）：
 *   切到 `part3-settings.js` 的 `settingsSnapshotLines` 里**调用了**这两个判定函数，
 *   而它们留在 `part3.js` ⇒ 新文件要靠 `part3.js` 反向提供 ⇒ 运行到那行就
 *   `ReferenceError: blockInjectionEnabled is not defined`。
 *
 * ★ 为什么"搬过去"而不是"从 part3 引入"：
 *   ① 它们只依赖 `precedenceValue` / `currentSettings`（part1 的），**零 part3 依赖**；
 *   ② 若从 part3 引入，就形成 `part3-settings ↔ part3` 的**真环**（不只是 import 环，
 *      而是求值期互相需要）—— 本项目栽过这个形状；
 *   ③ 它们与"设置快照/开关判定"是同一个语义簇，本就该在一起。
 *
 * ★ 判据：**拆模块时，被切走的部分若引用了留在原处的函数，先问"它俩是不是同一个语义簇"** ——
 *   是 ⇒ 一起搬；不是 ⇒ 才用 import。不要一律 import，那会把单文件拆成一堆互指的碎片。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRY = process.argv.includes("--dry");

const SRC = path.join(PROJECT_ROOT, "lib", "part3.js");
const DST = path.join(PROJECT_ROOT, "lib", "part3-settings.js");

const NAMES = ["blockInjectionEnabled", "fileAnchorEnabled"];

let srcText = fs.readFileSync(SRC, "utf8");
const srcLines = srcText.split("\n");
const dstText = fs.readFileSync(DST, "utf8");

const movedChunks = [];
const removeRanges = []; // [startIdx, endIdx] 0-based, end exclusive

for (const name of NAMES) {
  const startIdx = srcLines.findIndex((l) => l.startsWith(`export function ${name}(`));
  if (startIdx < 0) {
    console.error(`找不到 ${name}`);
    process.exit(1);
  }
  // 往前吃掉紧邻的 JSDoc 注释（`/** … */`），让文档跟着函数一起走
  let docStart = startIdx;
  if (startIdx > 0) {
    let k = startIdx - 1;
    if (srcLines[k].trim() === "") k -= 1;
    if (srcLines[k].trim() === "*/") {
      let m = k;
      while (m >= 0 && !/^\s*\/\*\*/.test(srcLines[m])) m -= 1;
      if (m >= 0) docStart = m;
    }
  }
  // 找到函数闭合的 `}`
  let endIdx = startIdx;
  while (endIdx < srcLines.length && !/^\}\s*$/.test(srcLines[endIdx])) endIdx += 1;
  if (endIdx >= srcLines.length) {
    console.error(`${name} 找不到闭合行`);
    process.exit(1);
  }
  const chunk = srcLines.slice(docStart, endIdx + 1);
  movedChunks.push(chunk.join("\n"));
  removeRanges.push([docStart, endIdx + 1]);
}

// 从 part3.js 删掉这些段（从后往前删，索引不漂移）
const rest = [...srcLines];
for (const [a, b] of removeRanges.sort((x, y) => y[0] - x[0])) {
  // 顺带吃掉后面的一个空行
  let bb = b;
  if (rest[bb] !== undefined && rest[bb].trim() === "") bb += 1;
  rest.splice(a, bb - a);
}

// 追加到 part3-settings.js 末尾
const nextDst = dstText.replace(/\s+$/, "") + "\n\n" + movedChunks.join("\n\n") + "\n";
const nextSrc = rest.join("\n");

// 守恒断言：① 两段都在新文件里 ② 原文件里不再有定义 ③ 语法都过
const problems = [];
for (const name of NAMES) {
  if (!nextDst.includes(`export function ${name}(`)) problems.push(`${name} 没进新文件`);
  if (new RegExp(`^export function ${name}\\(`, "m").test(nextSrc)) problems.push(`${name} 仍在原文件里`);
}
for (const [label, text, fname] of [
  ["part3.js", nextSrc, "._chk-part3.mjs"],
  ["part3-settings.js", nextDst, "._chk-part3s.mjs"],
]) {
  const tmp = path.join(PROJECT_ROOT, "tools", "_refactor-d376", fname);
  fs.writeFileSync(tmp, text, "utf8");
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  } catch (e) {
    problems.push(`${label} 语法检查失败：${String(e.stderr ?? e.message).slice(0, 200)}`);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}
if (problems.length > 0) {
  console.log("★ 守恒断言未过，未写盘：");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}

if (!DRY) {
  fs.writeFileSync(SRC, nextSrc, "utf8");
  fs.writeFileSync(DST, nextDst, "utf8");
}
console.log(`搬走 ${NAMES.length} 个函数（${movedChunks.map((c) => c.split("\n").length).join(" + ")} 行）`);
console.log(`  part3.js  ${Buffer.byteLength(srcText)} → ${Buffer.byteLength(nextSrc)} B`);
console.log(`  part3-settings.js ${Buffer.byteLength(dstText)} → ${Buffer.byteLength(nextDst)} B`);
console.log(DRY ? "（DRY RUN —— 未写盘）" : "MOVE-DONE");
