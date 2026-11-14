/**
 * D376 补丁五（最终形态）：把 `recordBlockHistory` / `blockHistoryFor` 搬回 part1.js。
 *
 * ★★★ 到这里为止，这个坑我已经撞了三轮，必须把判据写清楚：
 *
 *   第一轮：把 `numOf` / `splitBlocks` 搬进 part1-store ⇒ 未绑定（store 里的函数要用它们）
 *   第二轮：把 `numOf` / `splitBlocks` 搬回去   ⇒ 又未绑定（它们自己还在 store 里被别处引用）
 *   第三轮（本轮）：**把"调用方"搬回去，而不是把"被调用方"搬过来**
 *
 * ★★★★ 判据：**拆模块时，边界应该按"依赖方向"切，不是按"函数大小"切。**
 *   - `numOf` / `splitBlocks` 被 **defs.js（叶子）** 引用 ⇒ 它们**不能离开 part1.js**（否则三方环）；
 *   - 那要消掉 part1-store 里的未绑定，就只能把**引用它们的函数**搬走 ——
 *     即 `recordBlockHistory` / `blockHistoryFor` 回 part1.js。
 *   - 剩下留在 part1-store 的，必须是**只依赖 node 内建 + base/defs 纯函数**的那一批。
 *
 * ★ 这也解释了为什么 part1-store 只能省 ~46 KB 而不是全部 47.7 KB ——
 *   **"纯 store" 的边界比"看起来像 store" 的边界更窄**。窄一点没关系，稳更重要。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRY = process.argv.includes("--dry");

const SRC = path.join(PROJECT_ROOT, "lib", "part1-store.js");
const DST = path.join(PROJECT_ROOT, "lib", "part1.js");
const NAMES = ["recordBlockHistory", "blockHistoryFor"];

const srcText = fs.readFileSync(SRC, "utf8");
const srcLines = srcText.split("\n");
const dstText = fs.readFileSync(DST, "utf8");

const chunks = [];
const ranges = [];

for (const name of NAMES) {
  const startIdx = srcLines.findIndex((l) => l.startsWith(`export function ${name}(`));
  if (startIdx < 0) {
    console.error(`part1-store 里找不到 ${name}`);
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

const restStore = [...srcLines];
for (const [a, b] of ranges.sort((x, y) => y[0] - x[0])) {
  let bb = b;
  if (restStore[bb] !== undefined && restStore[bb].trim() === "") bb += 1;
  restStore.splice(a, bb - a);
}
const nextStore = restStore.join("\n");

// part1.js：从 part1-store 的 import/re-export 行去掉这两个，再插回函数体
let nextDst = dstText;
{
  const lines = nextDst.split("\n");
  const stripNames = (line) => {
    const m = /^(\s*(?:import|export)\s*\{)([\s\S]*?)(\}\s*from\s*"[^"]+";?\s*)$/.exec(line);
    if (!m) return line;
    const kept = m[2]
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((x) => {
        const as = /\s+as\s+([A-Za-z_$][\w$]*)$/.exec(x);
        const local = as ? as[1] : x;
        return !NAMES.includes(local);
      });
    return `${m[1]} ${kept.join(", ")} ${m[3]}`;
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (/from "\.\/part1-store\.js"/.test(lines[i])) lines[i] = stripNames(lines[i]);
  }
  nextDst = lines.join("\n");
}
{
  const idx = nextDst.indexOf("export function settingDefaults()");
  if (idx < 0) {
    console.error("part1.js 里找不到 settingDefaults，无法定位插入点");
    process.exit(1);
  }
  nextDst = nextDst.slice(0, idx) + chunks.join("\n\n") + "\n\n" + nextDst.slice(idx);
}

// ── 守恒断言 ───────────────────────────────────────────────────────────────
const problems = [];
for (const n of NAMES) {
  if (!new RegExp(`^export function ${n}\\(`, "m").test(nextDst)) problems.push(`part1.js 里没有 ${n}`);
  if (new RegExp(`^export function ${n}\\(`, "m").test(nextStore)) problems.push(`part1-store.js 里仍有 ${n}`);
}
// ★ 关键断言：part1-store.js **不许**再引用 numOf / splitBlocks（那正是本轮的病根）
for (const n of ["numOf", "splitBlocks"]) {
  const re = new RegExp(`\\b${n}\\s*\\(`);
  // 去掉注释与字符串后判断
  const cleaned = nextStore
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''"))
    .join("\n");
  if (re.test(cleaned)) problems.push(`part1-store.js 仍在调用 ${n}（应已随调用方搬走）`);
}
for (const [label, text, fname] of [
  ["part1.js", nextDst, "._chk-p1c.mjs"],
  ["part1-store.js", nextStore, "._chk-p1sc.mjs"],
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
  fs.writeFileSync(SRC, nextStore, "utf8");
  fs.writeFileSync(DST, nextDst, "utf8");
}
console.log(`把 ${NAMES.join(" / ")} 搬回 part1.js（${chunks.map((c) => c.split("\n").length).join(" + ")} 行）`);
console.log(`  part1-store.js ${Buffer.byteLength(srcText)} → ${Buffer.byteLength(nextStore)} B`);
console.log(`  part1.js       ${Buffer.byteLength(dstText)} → ${Buffer.byteLength(nextDst)} B`);
console.log(DRY ? "（DRY RUN —— 未写盘）" : "FINAL-MOVE-DONE");
