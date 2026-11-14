/**
 * D376 回退之二：把 `currentSettings` / `numOf` / `splitBlocks` 搬回 part1.js。
 *
 * ★★★ 为什么必须搬回（本轮最硬的一课）：
 *   `defs.js`（**叶子模块**）第 2 行从 `part1.js` 引入 40+ 个符号，其中包含
 *   `currentSettings` / `numOf` / `splitBlocks`。
 *   我把这三个搬进 `part1-store.js` 之后，引用链变成：
 *       `defs.js` → `part1.js` → `part1-store.js` → `defs.js`
 *   ⇒ **三方环**。ESM 在这种环里，先求值的一方拿到的 re-export 是 `undefined`
 *   ⇒ 运行时 `ReferenceError: currentSettings is not defined`
 *   ⇒ 22 个工具里 3 个注册失败（ledger_log / ledger_recall / ledger_triage）。
 *
 * ★★★ 判据（本轮最值钱）：**"拆出去"之前先查"谁在引用它"** ——
 *   若某个符号被**叶子模块**（这里是 defs.js）引用，那它**不能离开原模块**，
 *   否则必然把叶子拖进环。**`node --check` 与"模块能加载"都发现不了这个**，
 *   只有真跑起来才炸。
 *
 * ★ 做法：把这三个函数从 part1-store.js 切回 part1.js（原位置附近即可），
 *   并从 part1.js 的 import/re-export 列表里去掉它们。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRY = process.argv.includes("--dry");

const SRC = path.join(PROJECT_ROOT, "lib", "part1-store.js"); // 搬出方
const DST = path.join(PROJECT_ROOT, "lib", "part1.js"); // 搬回方
const NAMES = ["numOf", "splitBlocks"];

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

// part1.js：① 从 import/re-export 列表去掉这三个 ② 把函数体插到 settingDefaults 之前
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
    if (/^import\s*\{.*\}\s*from\s+"\.\/part1-store\.js";?\s*$/.test(lines[i])) lines[i] = stripNames(lines[i]);
    if (/^export\s*\{.*\}\s*from\s+"\.\/part1-store\.js";?\s*$/.test(lines[i])) lines[i] = stripNames(lines[i]);
  }
  nextDst = lines.join("\n");
}

// 把函数体插到 `export function settingDefaults()` 之前（那里是"设置取值"区）
{
  const idx = nextDst.indexOf("export function settingDefaults()");
  if (idx < 0) {
    console.error("part1.js 里找不到 settingDefaults，无法定位插入点");
    process.exit(1);
  }
  const insert = chunks.join("\n\n") + "\n\n";
  nextDst = nextDst.slice(0, idx) + insert + nextDst.slice(idx);
}

// ── 守恒断言 ───────────────────────────────────────────────────────────────
const problems = [];
for (const n of NAMES) {
  if (!new RegExp(`^export function ${n}\\(`, "m").test(nextDst)) problems.push(`part1.js 里没有 ${n} 的定义`);
  if (new RegExp(`^export function ${n}\\(`, "m").test(nextStore)) problems.push(`part1-store.js 里仍有 ${n} 的定义`);
  // import / re-export 行里不许再出现
  for (const line of nextDst.split("\n")) {
    if (/from "\.\/part1-store\.js"/.test(line)) {
      const body = (/\{([\s\S]*?)\}/.exec(line) ?? [, ""])[1];
      const names = body.split(",").map((x) => x.trim()).filter(Boolean);
      if (names.includes(n)) problems.push(`part1.js 的 part1-store 行里仍列着 ${n}`);
    }
  }
}
for (const [label, text, fname] of [
  ["part1.js", nextDst, "._chk-p1b.mjs"],
  ["part1-store.js", nextStore, "._chk-p1sb.mjs"],
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
console.log(DRY ? "（DRY RUN —— 未写盘）" : "MOVE-BACK-DONE");
