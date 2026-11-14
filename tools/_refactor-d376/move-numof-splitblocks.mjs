/**
 * D376 补丁四：把 `numOf` / `splitBlocks` 从 part1.js 搬到 part1-store.js。
 *
 * ★ 为什么搬（`_probe-unbound-after-split.mjs` 精确指出的 2 处未绑定）：
 *   搬走的那一簇里 `blockHistoryFor` 用了 `numOf`、`recordBlockHistory` 用了 `splitBlocks`，
 *   而这两个留在 part1.js ⇒ 新文件靠 part1.js 反向提供 ⇒ 未绑定。
 *
 * ★ 为什么"搬"而不是"import"：**避免 part1-store → part1 的反向依赖**。
 *   搬走的那一簇里已经有 `import { currentSettings, … } from "./part1.js"` 了吗？
 *   —— 没有。part1-store 目前只 import base / defs / node 内建。
 *   若为了两个小函数再引入 part1，就会形成 part1 ↔ part1-store 的**真环**
 *   （part1 已经 `export { … } from "./part1-store.js"` 了）。
 *   ⇒ 判据：**拆出去的文件不许反向依赖原文件** —— 要么一起搬，要么别拆。
 *
 * ★ 语义簇也支持搬：`numOf`（取一个设置数值）与 `splitBlocks`（按标题切块）
 *   都是"纯计算 + 无状态"，和 store 簇同属基础设施。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRY = process.argv.includes("--dry");

const SRC = path.join(PROJECT_ROOT, "lib", "part1.js");
const DST = path.join(PROJECT_ROOT, "lib", "part1-store.js");
const NAMES = ["numOf", "splitBlocks"];

const srcText = fs.readFileSync(SRC, "utf8");
const srcLines = srcText.split("\n");
const dstText = fs.readFileSync(DST, "utf8");

const chunks = [];
const ranges = [];

for (const name of NAMES) {
  const startIdx = srcLines.findIndex((l) => l.startsWith(`export function ${name}(`));
  if (startIdx < 0) {
    console.error(`找不到 ${name}`);
    process.exit(1);
  }
  let docStart = startIdx;
  {
    let k = startIdx - 1;
    if (srcLines[k] !== undefined && srcLines[k].trim() === "") k -= 1;
    if (srcLines[k] !== undefined && srcLines[k].trim() === "*/") {
      let m = k;
      while (m >= 0 && !/^\s*\/\*\*/.test(srcLines[m])) m -= 1;
      if (m >= 0) docStart = m;
    }
  }
  let endIdx = startIdx;
  while (endIdx < srcLines.length && !/^\}\s*$/.test(srcLines[endIdx])) endIdx += 1;
  if (endIdx >= srcLines.length) {
    console.error(`${name} 找不到闭合行`);
    process.exit(1);
  }
  chunks.push(srcLines.slice(docStart, endIdx + 1).join("\n"));
  ranges.push([docStart, endIdx + 1]);
}

const rest = [...srcLines];
for (const [a, b] of ranges.sort((x, y) => y[0] - x[0])) {
  let bb = b;
  if (rest[bb] !== undefined && rest[bb].trim() === "") bb += 1;
  rest.splice(a, bb - a);
}

// part1.js 需要从 part1-store.js 拿回这两个名字（它自己的其它函数还在用）
let nextSrc = rest.join("\n");
{
  const lines = nextSrc.split("\n");
  let importIdx = -1;
  let reExportIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^import\s*\{.*\}\s*from\s+"\.\/part1-store\.js";?\s*$/.test(lines[i])) importIdx = i;
    if (/^export\s*\{.*\}\s*from\s+"\.\/part1-store\.js";?\s*$/.test(lines[i])) reExportIdx = i;
  }
  if (importIdx < 0 || reExportIdx < 0) {
    console.error("part1.js 里找不到 part1-store 的 import / re-export 行");
    process.exit(1);
  }
  const addNames = (line) => {
    const m = /^(\s*(?:import|export)\s*\{)([\s\S]*?)(\}\s*from\s*"[^"]+";?\s*)$/.exec(line);
    if (!m) return null;
    const cur = m[2].split(",").map((x) => x.trim()).filter(Boolean);
    for (const n of NAMES) if (!cur.includes(n)) cur.push(n);
    return `${m[1]} ${cur.join(", ")} ${m[3]}`;
  };
  const ni = addNames(lines[importIdx]);
  const nr = addNames(lines[reExportIdx]);
  if (ni === null || nr === null) {
    console.error("行格式不匹配");
    process.exit(1);
  }
  lines[importIdx] = ni;
  lines[reExportIdx] = nr;
  nextSrc = lines.join("\n");
}

const nextDst = dstText.replace(/\s+$/, "") + "\n\n" + chunks.join("\n\n") + "\n";

// ── 守恒断言 ───────────────────────────────────────────────────────────────
const problems = [];
for (const n of NAMES) {
  if (!nextDst.includes(`export function ${n}(`)) problems.push(`${n} 没进新文件`);
  if (new RegExp(`^export function ${n}\\(`, "m").test(nextSrc)) problems.push(`${n} 仍在原文件里`);
  if (!nextSrc.includes(n)) problems.push(`part1.js 里再也找不到 ${n}（import/re-export 没加上？）`);
}
for (const [label, text, fname] of [
  ["part1.js", nextSrc, "._chk-p1.mjs"],
  ["part1-store.js", nextDst, "._chk-p1s.mjs"],
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
console.log(`搬走 ${NAMES.join(" / ")}（${chunks.map((c) => c.split("\n").length).join(" + ")} 行）`);
console.log(`  part1.js       ${Buffer.byteLength(srcText)} → ${Buffer.byteLength(nextSrc)} B`);
console.log(`  part1-store.js ${Buffer.byteLength(dstText)} → ${Buffer.byteLength(nextDst)} B`);
console.log(DRY ? "（DRY RUN —— 未写盘）" : "MOVE2-DONE");
