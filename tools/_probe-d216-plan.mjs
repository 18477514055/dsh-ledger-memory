// ═══════════════════════════════════════════════════════════════════════════
// D216 · 模块划分方案（按主题聚类，允许环）+ 硬约束自检
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 依据（全部实测，不是推理）：
//   · 整个文件是**一个大环**（213 声明 / 82.5%）⇒ 不能"按依赖分层从叶子往上搬"
//   · ESM 机制实验 5/5：环里顶层只读**函数**安全；互读 **const** 会 TDZ；**import 的 let 不能赋值**
//   ⇒ 因此划分必须满足三条硬约束：
//       C1 每个**急切 const** 与它初始化时调用的函数**同模块**（或在其后，同模块最省事）
//       C2 每个**可变 let** 与"给它赋值的那个函数"**同模块**
//       C3 每箱 ≤ 目标字节（留余量，因为 import/export 行会增重）
//
// 用法：node tools/_probe-d216-plan.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const g = JSON.parse(fs.readFileSync(path.join(root, "tools", "_d216-graph.json"), "utf8"));
const decls = g.decls;
const lines = fs.readFileSync(path.join(root, "lib", "index.js"), "utf8").split("\n");
const byName = new Map(decls.map((d) => [d.name, d]));
const B = (a, b) => Buffer.byteLength(lines.slice(a - 1, b).join("\n"), "utf8");

const TARGET = 200000; // 留 62KB 余量（上限 262144）

// ── 主题分组（按声明所在的**行号区间**切，与人读的分节标题对齐）──────────────
//   ★ 每条 = [起始行, 结束行, 模块名, 说明]。行号取自侦察（分节注释位置）。
//   ★ 这是**初稿**，随后由 C1/C2 约束自动纠正（约束优先于主题）。
const SECTIONS = [
  [1, 1267, "config.js", "文件头 + 设置规格(SETTING_SPECS) + Config + __test"],
  [1268, 2580, "core-util.js", "设置读写/归一化 + 基础工具函数"],
  [2581, 4452, "capsule-store.js", "胶囊素材落盘 + 被压段索引 + 锚点 + 记忆区块"],
  [4453, 5619, "logs.js", "活动日志（采集/读/写/L0 类型）"],
  [5620, 8908, "goals-principles.js", "根本原则 + 目标树 + 卡片读写入口"],
  [8909, 9990, "inspect.js", "项目状态探测 + Git + 设置面板后端"],
  [9991, 11360, "settings-view.js", "设置快照渲染 + 变更行 + 闸门常量"],
  [11361, 13070, "compact-gate.js", "压缩闸门 + 压缩编排(delegation) + 会话判定"],
  [13071, 14648, "tools-a.js", "工具定义（迁移/init/status/read/lock/compact）"],
  [14649, 16327, "cards.js", "卡片化 + 工具定义（triage/lessons/goals/handoff）"],
  [16328, 18334, "tools-b.js", "工具定义（triage/…）+ 命令 + 高保真压缩 + 增量"],
  [18335, 19635, "compact-run.js", "增量压缩 + 高保真压缩实现 + State"],
  [19636, 21234, "index.js", "apply()（入口，只留它）"],
];

const assign = new Map(); // name -> 模块名
for (const d of decls) {
  const sec = SECTIONS.find(([a, b]) => d.line >= a && d.line <= b);
  assign.set(d.name, sec ? sec[2] : "UNASSIGNED");
}

// ── C1：急切 const 与它调用的函数同模块 ────────────────────────────────────
const fixes1 = [];
for (const d of decls) {
  if (!Array.isArray(d.eager) || d.eager.length === 0) continue;
  const home = assign.get(d.name);
  for (const dep of d.eager) {
    const t = byName.get(dep);
    if (t === undefined) continue;
    if (assign.get(dep) !== home) {
      // ★ 统一挪到**急切声明所在的模块**（比挪声明更安全：改一个而不是改多个）
      assign.set(dep, home);
      fixes1.push(`${dep} → ${home}（被急切声明 ${d.name} 在初始化时调用）`);
    }
  }
}

// ── C2：可变 let 与"给它赋值的那个函数"同模块 ──────────────────────────────
const lets = decls.filter((d) => d.kind === "let" || d.kind === "var");
const fixes2 = [];
// 先算"谁给它赋值"（复用 scc 探针的判据）
function strip(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}
for (const L of lets) {
  const home = assign.get(L.name);
  const writers = [];
  for (const d of decls) {
    if (d.name === L.name) continue;
    const b = strip(lines.slice(d.line - 1, d.end).join("\n"));
    if (new RegExp(`(?<![\\w$.])${L.name}\\s*=(?!=)`).test(b)) writers.push(d.name);
  }
  for (const w of writers) {
    if (assign.get(w) !== home) {
      assign.set(w, home);
      fixes2.push(`${w} → ${home}（它给可变 let ${L.name} 赋值，ESM 不许跨模块赋值）`);
    }
  }
}

// ── 统计 ───────────────────────────────────────────────────────────────────
const buckets = new Map();
for (const d of decls) {
  const m = assign.get(d.name);
  if (!buckets.has(m)) buckets.set(m, []);
  buckets.get(m).push(d);
}
// 未覆盖的（文件头等）归 index.js
const headBytes = B(1, 93);

console.log("═══ 划分初稿 ═══");
let sum = 0;
for (const [name, list] of [...buckets.entries()].sort((a, b) => {
  return a[1][0].line - b[1][0].line;
})) {
  const bytes = list.reduce((a, d) => a + d.bytes, 0);
  sum += bytes;
  const flag = bytes > TARGET ? " ⛔ 超目标" : "";
  const over = bytes > 262144 ? " ⛔⛔ 超硬上限" : "";
  console.log(`  ${name.padEnd(20)} ${String(bytes).padStart(7)} B / ${String(list.length).padStart(3)} 声明${flag}${over}`);
  if (name === "index.js") console.log(`      （+ 文件头 ${headBytes} B ⇒ ${bytes + headBytes} B）`);
}
console.log(`  ${"合计".padEnd(20)} ${sum} B（+ 头 ${headBytes} = ${sum + headBytes}）`);

console.log(`\n═══ 约束纠正 ═══`);
console.log(`C1（急切 const 拉同模块）：${fixes1.length} 处`);
for (const f of fixes1) console.log(`  ${f}`);
console.log(`C2（可变 let 与写者同模块）：${fixes2.length} 处`);
for (const f of fixes2) console.log(`  ${f}`);

const tooBig = [...buckets.entries()].filter(([, l]) => l.reduce((a, d) => a + d.bytes, 0) > TARGET);
console.log(`\n超目标箱：${tooBig.length} 个`);
for (const [n, l] of tooBig) console.log(`  ${n} = ${l.reduce((a, d) => a + d.bytes, 0)} B`);

fs.writeFileSync(path.join(root, "tools", "_d216-plan.json"), JSON.stringify({ SECTIONS, assign: Object.fromEntries(assign) }, null, 1), "utf8");
console.log(`\n方案已写：tools/_d216-plan.json`);
