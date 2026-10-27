/**
 * _probe-d332-cycles.mjs —— 拆之前最后一道体检：**会不会成环 / 会不会有运行时顺序问题**
 *
 * ★ 这是拆模块最容易翻车的地方（D323/D328 都撞过）：
 *   ① **成环**：新模块 `part2-tools.js` import `part2.js`，而 `part2.js` 又 export 转发自新模块
 *      ⇒ ESM 允许循环，但**顶层求值顺序**会变，`const` 初始化可能拿到 TDZ。
 *      ⇒ 必须先算清楚：**新模块只用 `function` 声明就安全**（函数声明提升，调用时才解析）。
 *   ② **顶层副作用**：如果新模块里有 `const X = someFn()` 这种顶层求值，成环时会炸。
 *
 * 本探针做四件事：
 *   A. 把四个 define*Tool 的依赖分成「函数声明」与「const/let 求值」两类 —— 后者才有 TDZ 风险
 *   B. 检查四个 tool 函数体里有没有**顶层立即执行**（IIFE / new / 顶层 await）
 *   C. 模拟"part2 转发导出"的形状，看会不会与 part2 形成 import 环
 *   D. 给出**目标字节**（拆完 part2 应降到多少、新模块多大）
 */
import fs from "node:fs";
import path from "node:path";

const P2 = path.resolve("lib/part2.js");
const text = fs.readFileSync(P2, "utf8");
const lines = text.split(/\r?\n/);

const TARGETS = ["definePrinciplesAccessTool", "defineProposePrincipleTool", "defineLessonsTool", "defineGoalsTool"];
const DEPS = [
  "buildGoalTree", "goalAgeOf", "goalStampMs", "goalTimeScope", "goalWeightBasis",
  "idPrefixOfType", "inspect", "kindsOfType", "parseGoalCards", "parseLessonEntries",
  "proposePrinciple", "recordGoalsChange", "registerGoalsInManifest", "renderGoalCard",
  "renderGoalTree", "renderLessonEntry", "upsertGoalCard", "writePrinciples",
];

function grabFunction(name) {
  const startIdx = lines.findIndex((l) => new RegExp(`^(export\\s+)?function\\s+${name}\\b`).test(l));
  if (startIdx < 0) return null;
  let depth = 0, started = false;
  for (let i = startIdx; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth += 1; started = true; }
      else if (ch === "}") depth -= 1;
    }
    if (started && depth === 0) {
      return { start: startIdx, end: i + 1, body: lines.slice(startIdx, i + 1).join("\n") };
    }
  }
  return null;
}

// ── A. 依赖的「声明种类」 ───────────────────────────────────────────────────
console.log("═══ A. 18 个依赖各自是 function 还是 const（后者才有 TDZ 风险）═══");
let fnCount = 0, constCount = 0;
const constDeps = [];
for (const n of DEPS) {
  const declLine = lines.findIndex((l) => new RegExp(`^(export\\s+)?(async\\s+)?(function|const|let)\\s+${n}\\b`).test(l));
  if (declLine < 0) { console.log(`  🔴 ${n} 找不到声明行`); continue; }
  const kind = /function/.test(lines[declLine]) ? "function" : "const/let";
  if (kind === "function") fnCount += 1; else { constCount += 1; constDeps.push(n); }
  console.log(`  ${n.padEnd(28)} ${kind.padEnd(9)} 第 ${declLine + 1} 行`);
}
console.log(`  ⇒ function ${fnCount} 个（**提升，安全**）· const/let ${constCount} 个（成环时有 TDZ 风险）`);
if (constDeps.length > 0) console.log(`  ⚠️ const 依赖：${constDeps.join(", ")}`);

// ── B. 四个 tool 函数体里有没有顶层立即执行 / await ─────────────────────────
console.log("\n═══ B. 四个 tool 函数体：有没有顶层立即执行的东西 ═══");
for (const t of TARGETS) {
  const g = grabFunction(t);
  if (g === null) { console.log(`  🔴 ${t} 抓不到`); continue; }
  const body = g.body;
  const iife = /\(\s*(?:async\s*)?\(\s*\)\s*=>/.test(body) && /\)\(\);?/.test(body);
  const topAwait = /^\s*await\s/m.test(body);
  const newAtTop = /^(?:const|let)\s+\w+\s*=\s*new\s/m.test(body);
  console.log(
    `  ${t.padEnd(30)} IIFE=${iife} 顶层await=${topAwait} 顶层new=${newAtTop} ⇒ ${iife || topAwait || newAtTop ? "⚠️ 需细看" : "干净（纯函数体）"}`
  );
}

// ── C. 环依赖推演 ─────────────────────────────────────────────────────────
console.log("\n═══ C. 环依赖推演 ═══");
console.log("  计划形状：");
console.log("    part2-tools.js  ──import──▶  part2.js （拿 inspect / renderGoalTree … 等 18 个）");
console.log("    part2.js        ──export…from──▶  part2-tools.js （转发 4 个 define*Tool）");
console.log("  ⇒ 这是**双向**引用 = ESM 循环。是否安全取决于：");
console.log("     ① 新模块**只在函数体内**用那些 import（不在顶层求值）");
console.log("     ② part2 转发用的是 `export { x } from './part2-tools.js'`（**不是** import 后再 export）");
console.log("     ★ 只要 ① 成立，循环在 ESM 里是合法的：调用发生在模块求值**之后**。");

// 逐个检查：18 个依赖在四个 tool 里是否只出现在函数体内（而不在顶层）
const toolBodies = TARGETS.map((t) => grabFunction(t)).filter(Boolean).map((g) => g.body);
const topLevelRegions = []; // 顶层区域 = 声明之间（含 import 之后到第一个声明）
console.log("\n  逐依赖检查「是否只出现在 tool 函数体内」：");
let allInsideOnly = true;
for (const n of DEPS) {
  const re = new RegExp(`\\b${n.replace(/[$]/g, "\\$")}\\b`, "g");
  const totalRefs = (text.match(re) ?? []).length;
  let inTools = 0;
  for (const b of toolBodies) inTools += (b.match(re) ?? []).length;
  // 减去声明那一处
  const declRefs = 1;
  const outside = totalRefs - declRefs - inTools;
  const flag = outside > 0 ? "（另有 " + outside + " 处在别处，属正常：别的函数也用）" : "";
  console.log(`    ${n.padEnd(28)} 全文件 ${totalRefs} · 四tool内 ${inTools} · 其余 ${outside} ${flag}`);
  if (inTools === 0) allInsideOnly = false;
}
console.log(`  ⇒ ${allInsideOnly ? "全部依赖都在 tool 函数体内被用到 ⇒ 循环安全" : "⚠️ 有依赖没在 tool 体内用到 ⇒ 可能多余，拆时可删"}`);

// ── D. 目标字节 ───────────────────────────────────────────────────────────
console.log("\n═══ D. 目标字节预估 ═══");
let moveBytes = 0;
for (const t of TARGETS) {
  const g = grabFunction(t);
  moveBytes += Buffer.byteLength(g.body, "utf8") + 2; // +2 = 两个换行
}
const totalBytes = Buffer.byteLength(text, "utf8");
const HEADER = 1400; // 新模块的 import 头 + 注释，估个数
const FORWARD = 700;  // part2 里 4 行 import + 4 行 export from
const afterPart2 = totalBytes - moveBytes + FORWARD;
const newModule = moveBytes + HEADER;
console.log(`  当前 part2.js       = ${totalBytes} B（余量 ${262144 - totalBytes}）`);
console.log(`  搬走四个 tool 体     = ${moveBytes} B`);
console.log(`  新模块 part2-tools  ≈ ${newModule} B（含约 ${HEADER} B 抬头/import）`);
console.log(`  拆后 part2.js       ≈ ${afterPart2} B ⇒ 距 241,664 红线的余量 = ${241664 - afterPart2}`);
console.log(`  拆后 part2.js 距硬限 = ${262144 - afterPart2}`);

console.log("\nPROBE-COMPLETE");
