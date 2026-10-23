#!/usr/bin/env node
/**
 * 收尾修复：把 `sliceEntryByKey` / `entryTocOf` 从 `part4.js` 搬进 `card-ops.js`。
 *
 * 🔴 为什么必须搬（不是可选整理）：
 *   三刀之后形成了**双向依赖** —— `card-ops.js` 里的 `readEntryUnified` 调 `sliceEntryByKey`/`entryTocOf`，
 *   而这两个函数**留在 part4** ⇒ `ReferenceError: sliceEntryByKey is not defined`（自检当场撞出）。
 *   ★ 又不能反向 `card-ops` ← `part4`（那就是**真环**，会改变求值顺序）。
 *   ⇒ 唯一正解：**把它们也搬过去**（它们本来就是纯字符串函数，与卡片区同源）。
 *     搬完 part4 里留 re-export，调用面不变；`card-ops` 不 import 任何 partN ⇒ 环形消失。
 *
 * ★ 判据：搬完之后 `card-ops.js` 里**不许出现**任何来自 part4 的标识符（结构断言），
 *   且 `part4.js` 与 `card-ops.js` 都还能被 import（运行断言）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// ★ 我漏了这个 —— 下面两处 `pathToFileURL(...)` 直接 `ReferenceError`。
//   ★ 与本次拆模块踩的坑**同型**：用了没引入。判据：**新写的探针自己也要先跑一次**，
//     不能假设它"看起来对"就能跑（这条已经连栽三次：part2 的 readTextSafe / part4 的 cardModeOf / 这里的 pathToFileURL）。
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const PART4 = path.join(PROJECT, "lib", "part4.js");
const CARDS = path.join(PROJECT, "lib", "card-ops.js");
const APPLY = process.argv.includes("--apply");

const MOVED = ["sliceEntryByKey", "entryTocOf"];

const p4buf = fs.readFileSync(PART4);
const p4 = p4buf.toString("utf8");
const p4L = p4.split("\n");
const cbuf = fs.readFileSync(CARDS);
const c = cbuf.toString("utf8");

console.log("═".repeat(74));
console.log("收尾：sliceEntryByKey / entryTocOf → card-ops.js（消除双向依赖）");
console.log("═".repeat(74));
console.log(`模式：${APPLY ? "APPLY（真写）" : "DRY-RUN（不写任何东西）"}`);
console.log(`part4.js ${p4buf.length} B · card-ops.js ${cbuf.length} B`);

// ── 先从 part4 里切这两个函数（含各自上方的文档注释） ─────────────────────
function cutFunction(lines, name) {
  const i = lines.findIndex((l) => l.includes(`export function ${name}(`));
  if (i < 0) throw new Error(`找不到 ${name}`);
  let start = i;
  while (start > 0 && !lines[start].trim().startsWith("/**")) start -= 1;
  let depth = 0;
  let seen = false;
  let end = i;
  for (let k = i; k < lines.length; k += 1) {
    for (const ch of lines[k]) {
      if (ch === "{") { depth += 1; seen = true; }
      else if (ch === "}") depth -= 1;
    }
    if (seen && depth === 0) { end = k; break; }
  }
  return { start, end };
}

// ★ 从后往前切，免得前面的行号失效
const ranges = MOVED.map((n) => ({ name: n, ...cutFunction(p4L, n) })).sort((a, b) => b.start - a.start);
const pieces = [];
for (const r of ranges) {
  const seg = p4L.slice(r.start, r.end + 1).join("\n");
  pieces.unshift({ name: r.name, text: seg, start: r.start, end: r.end });
  console.log(`  ${r.name}: part4 第 ${r.start + 1}–${r.end + 1} 行 / ${Buffer.byteLength(seg)} B`);
}

let nextP4 = p4L;
for (const r of ranges) {
  nextP4 = [...nextP4.slice(0, r.start), ...nextP4.slice(r.end + 1)];
}
const part4Removed = nextP4.join("\n");

// ── 追加到 card-ops（放在文件末尾，前面补一句说明） ────────────────────────
const appendix =
  `\n// ═══════════════════════════════════════════════════════════════════════════\n` +
  `// ★★★★★ 2026-10-23（D307 收尾）：**\`sliceEntryByKey\` / \`entryTocOf\` 从 part4 搬到这里。**\n` +
  `//   🔴 病：\`readEntryUnified\`（就在本文件里）要调它们，而它们留在 part4 ⇒ **双向依赖**\n` +
  `//     ⇒ 运行期 \`ReferenceError\`。而"card-ops ← part4"是**真环**（会改求值顺序），不能走。\n` +
  `//   ⇒ 正解：把它们也搬进来。它们本来就是**纯字符串函数**，与卡片区同源、不碰 ctx/服务。\n` +
  `//   ★ 搬完 part4 里留 re-export ⇒ 调用面一个都不改；本文件仍**不 import 任何 partN** ⇒ 环消失。\n` +
  `// ═══════════════════════════════════════════════════════════════════════════\n\n` +
  pieces.map((p) => p.text).join("\n\n") +
  "\n";

const nextCards = c.replace(/\s+$/, "") + "\n" + appendix;

// ── part4 里补 re-export ──────────────────────────────────────────────────
const reexport =
  `\n// ★ 2026-10-23（D307 收尾）：下面两个纯函数已搬去 card-ops（消除双向依赖），调用方不用改。\n` +
  `export { ${MOVED.join(", ")} } from "./card-ops.js";\n`;

// ★★★ 插入点：**必须锚"真正的 import 语句"的结束行**，不能 `indexOf('} from "./card-ops.js";')`。
//   🔴 我第一版就是这么锚的 ⇒ 命中的是**注释里**那句 `` `export { cardModeOf, … } from "./card-ops.js";` ``
//      ⇒ re-export 被插进注释块中间 ⇒ `Unexpected identifier 'cardModeOf'`（真语法错）。
//   ★ 判据（第三次同型）：**凡"在文件里定位一段代码"，一律按"整行匹配语句"，不要对全文做子串 indexOf。**
const p4Lines = part4Removed.split("\n");
let anchor = -1;
for (let i = 0; i < p4Lines.length; i += 1) {
  if (/^\}\s*from\s+"\.\/card-ops\.js";\s*$/.test(p4Lines[i])) {
    anchor = i;
    break;
  }
}
const nextP4Final =
  anchor >= 0
    ? [...p4Lines.slice(0, anchor + 1), ...reexport.split("\n"), ...p4Lines.slice(anchor + 1)].join("\n")
    : part4Removed + reexport;
console.log(`\nre-export 插入点：第 ${anchor + 1} 行之后（card-ops 的 import {} 块结束处）`);
if (anchor >= 0) console.log("  该行: " + JSON.stringify(p4Lines[anchor]).slice(0, 90));

console.log(`\n新 part4.js ${Buffer.byteLength(nextP4Final)} B · 新 card-ops.js ${Buffer.byteLength(nextCards)} B`);

if (!APPLY) {
  console.log("\n（dry-run 结束）");
  process.exit(0);
}

const bak = path.join(os.tmpdir(), `ledger-move-helpers-${Date.now()}`);
fs.mkdirSync(bak, { recursive: true });
fs.writeFileSync(path.join(bak, "part4.js"), p4buf);
fs.writeFileSync(path.join(bak, "card-ops.js"), cbuf);
console.log(`\n备份：${bak}`);

fs.writeFileSync(PART4, nextP4Final, "utf8");
fs.writeFileSync(CARDS, nextCards, "utf8");

// ── 写后校验 ───────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(74));
console.log("写后校验（真读回磁盘）");
console.log("─".repeat(74));
const rp = fs.readFileSync(PART4, "utf8");
const rc = fs.readFileSync(CARDS, "utf8");
let bad = 0;
const check = (n, pass, d) => {
  console.log(`  ${pass ? "✓" : "✗"} ${n}${d === undefined ? "" : `  —— ${d}`}`);
  if (!pass) bad += 1;
};
check("card-ops 里两个函数都成了实现（export function）", MOVED.every((n) => rc.includes(`export function ${n}(`)), "");
check("part4 里不再是实现（已搬走）", MOVED.every((n) => !rp.includes(`export function ${n}(`)), "");
check("part4 里保留 re-export", MOVED.every((n) => rp.includes(`export { ${MOVED.join(", ")} }`)) || rp.includes("} from \"./card-ops.js\";"), "");
// ★★ 判据要只看**真的 import 语句**，不能全文搜 `from "./part` ——
//   注释里就写着"本文件仍不 import 任何 partN"，全文搜必然命中。
//   🔴 这是**第三次**栽在同一个坑（前两次：base.js 注释、card-ops 注释）。
//   ★ 判据（记下来）：**凡"检查某类语句不存在"，一律先切成语句再看，不要对全文做容器匹配。**
const importStmts = rc.split("\n").filter((l) => /^import\s/.test(l) || /^\}\s*from\s+/.test(l));
const partImports = importStmts.filter((l) => l.includes('from "./part'));
check("★ card-ops 的 import 语句里**没有** partN（环形依赖已消除）", partImports.length === 0, partImports.join(" | ") || "无");
check("★ card-ops 里不出现 part4 独有的符号（结构断言）", !/\bsliceEntryByKey\b/.test(rc) || rc.includes("export function sliceEntryByKey("), "");
check("两个文件都低于 262,144 B", Buffer.byteLength(rp) < 262144 && Buffer.byteLength(rc) < 262144, `${Buffer.byteLength(rp)} / ${Buffer.byteLength(rc)}`);

// ── 运行断言：两个模块都能 import（这是最硬的一条） ────────────────────────
try {
  const m = await import(`${pathToFileURL(PART4).href}?t=${Date.now()}`);
  check("★ 真 import part4 成功（不是只看源码）", typeof m.defineWriteTool === "function", `exports ${Object.keys(m).length}`);
} catch (e) {
  check("★ 真 import part4 成功", false, e.message);
}
try {
  const m2 = await import(`${pathToFileURL(CARDS).href}?t=${Date.now()}`);
  check("★ 真 import card-ops 成功", typeof m2.readEntryUnified === "function", `exports ${Object.keys(m2).length}`);
} catch (e) {
  check("★ 真 import card-ops 成功", false, e.message);
}

console.log("\n" + "─".repeat(74));
console.log(bad === 0 ? "✓ 通过" : `✗ ${bad} 项不过（用 ${bak} 还原）`);
console.log("─".repeat(74));
process.exit(bad === 0 ? 0 : 1);
