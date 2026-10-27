/**
 * _probe-d332-deps.mjs —— 拆之前必须查清：`define*Tool` 四兄弟**依赖 part2 里的哪些东西**
 *
 * ★ 为什么必须先查（D328 教训）：搬实现最容易死在"它用到的东西在新模块里看不见"。
 *   要么一起搬、要么从 part2 反向 import —— 后者可能**造成循环依赖**（part2 ↔ 新模块）。
 *   ⇒ 必须先把依赖列全，再判断"能不能单向拆"。
 *
 * ★ 判据：新模块 `part2-tools.js` 里只能 import：
 *   - node 内置
 *   - `base.js` / `gates.js` / `defs.js` / `card-ops.js` 等**叶子模块**
 *   - **不能** import `part2.js`（否则 part2 → part2-tools → part2 成环）
 */
import fs from "node:fs";
import path from "node:path";

const P2 = path.resolve("lib/part2.js");
const text = fs.readFileSync(P2, "utf8");
const lines = text.split(/\r?\n/);

// ── 1. part2 自己的 import 头部 ─────────────────────────────────────────────
const importLines = [];
for (let i = 0; i < Math.min(lines.length, 200); i += 1) {
  if (/^import\s/.test(lines[i]) || /^}\s*from\s/.test(lines[i]) || /^\s+/.test(lines[i]) && importLines.length > 0 && !/;\s*$/.test(lines[importLines[importLines.length - 1]] ?? "")) {
    if (/^import\s/.test(lines[i])) importLines.push(i);
  }
}
console.log("═══ part2.js 的 import 行号 ═══");
for (const i of importLines) console.log(`  ${i + 1}: ${lines[i].slice(0, 120)}`);

// ── 2. 抓四个 define*Tool 的函数体 ──────────────────────────────────────────
const TARGETS = ["definePrinciplesAccessTool", "defineProposePrincipleTool", "defineLessonsTool", "defineGoalsTool"];

/** 用大括号配平抓一个函数的完整体（从 decl 行到配平处）。 */
function grabFunction(name) {
  const startIdx = lines.findIndex((l) => new RegExp(`^(export\\s+)?function\\s+${name}\\b`).test(l));
  if (startIdx < 0) return null;
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth += 1; started = true; }
      else if (ch === "}") { depth -= 1; }
    }
    if (started && depth === 0) {
      return { start: startIdx, end: i + 1, body: lines.slice(startIdx, i + 1).join("\n") };
    }
  }
  return null;
}

// ── 3. part2 里的全部顶层名字（用来判断"函数体里引用的名字是不是 part2 自家的"） ──
const localNames = new Set();
for (const l of lines) {
  const m =
    /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(l) ||
    /^export\s+const\s+([A-Za-z0-9_$]+)/.exec(l) ||
    /^export\s+let\s+([A-Za-z0-9_$]+)/.exec(l) ||
    /^function\s+([A-Za-z0-9_$]+)/.exec(l) ||
    /^const\s+([A-Za-z0-9_$]+)\s*=/.exec(l) ||
    /^let\s+([A-Za-z0-9_$]+)\s*=/.exec(l);
  if (m) localNames.add(m[1]);
}

const bodies = {};
let totalBytes = 0;
for (const t of TARGETS) {
  const g = grabFunction(t);
  if (g === null) { console.log(`\n🔴 抓不到 ${t} 的完整体 ⇒ 停止`); process.exit(1); }
  bodies[t] = g;
  const b = Buffer.byteLength(g.body, "utf8");
  totalBytes += b;
  console.log(`\n═══ ${t}：行 ${g.start + 1}~${g.end}（${g.end - g.start} 行 / ${b} B）═══`);
}
console.log(`\n四兄弟合计 ${totalBytes} B`);

// ── 4. 逐个体扫"引用了哪些 part2 自家名字" ─────────────────────────────────
console.log(`\n═══ 每个函数体里引用的 **part2 自家顶层名字** ═══`);
const allNeeded = new Map(); // name -> 被哪些 target 用到
for (const t of TARGETS) {
  const body = bodies[t].body;
  const hits = [];
  for (const n of localNames) {
    if (n === t) continue;
    const re = new RegExp(`\\b${n.replace(/[$]/g, "\\$")}\\b`);
    if (re.test(body)) hits.push(n);
  }
  hits.sort();
  console.log(`\n  ${t}（${hits.length} 个）：`);
  for (const n of hits) {
    console.log(`      ${n}`);
    if (!allNeeded.has(n)) allNeeded.set(n, []);
    allNeeded.get(n).push(t);
  }
}

console.log(`\n═══ 汇总：四兄弟共依赖 part2 自家的 ${allNeeded.size} 个名字（并集）═══`);
for (const [n, ts] of [...allNeeded.entries()].sort()) {
  console.log(`  ${n.padEnd(30)} ← ${ts.join(", ")}`);
}

// ── 5. 判断：这些依赖里有没有"非导出的"（那种就必须一起搬或加导出） ─────────
console.log(`\n═══ 依赖里哪些**不是 export**的（搬走会引起"看不见"） ═══`);
const exportNames = new Set();
for (const l of lines) {
  const m = /^export\s+(?:async\s+)?(?:function|const|let)\s+([A-Za-z0-9_$]+)/.exec(l);
  if (m) exportNames.add(m[1]);
}
const nonExported = [...allNeeded.keys()].filter((n) => !exportNames.has(n));
if (nonExported.length === 0) {
  console.log("  （没有）⇒ 全部可以 `import` 进来，**拆出去不会成环也不会看不见**");
} else {
  for (const n of nonExported) console.log(`  🔴 ${n}（未导出）`);
}

console.log("\nPROBE-COMPLETE");
