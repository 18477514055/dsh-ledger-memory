// ═══════════════════════════════════════════════════════════════════════════
// D216 · 拆分的**决定性测量**：强连通分量（SCC）+ 可变顶层状态
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么必须量这两样（它们决定拆分**可不可行**，不是"优化"）：
//
//   ① **SCC（循环依赖）**：ESM 允许模块循环，但**只有 `function` 声明会在实例化阶段
//      就初始化**（提升）；`const`/`let`/`class` 不是。⇒ 循环里"在**函数体**里调用对方"
//      是安全的（调用发生在所有模块求值完之后），而"在**顶层立刻读**对方"会炸 TDZ。
//      ★ 所以要知道：最大的环有多大、环里有没有急切读。
//
//   ② **可变顶层 `let`/`var`**：ESM **禁止给 import 进来的绑定赋值**
//      （`TypeError: Assignment to constant variable`）。⇒ 凡是"在 A 模块的函数里给
//      B 模块的 `let` 赋值"这种拆法，**一拆就坏**。⇒ 必须知道有几个、谁在赋值。
//
// 用法：node tools/_probe-d216-scc.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const g = JSON.parse(fs.readFileSync(path.join(root, "tools", "_d216-graph.json"), "utf8"));
const decls = g.decls;
const lines = fs.readFileSync(path.join(root, "lib", "index.js"), "utf8").split("\n");
const byName = new Map(decls.map((d) => [d.name, d]));

function strip(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}
const bodyOf = (d) => strip(lines.slice(d.line - 1, d.end).join("\n"));

// ── ① 可变顶层 let/var ─────────────────────────────────────────────────────
const lets = decls.filter((d) => d.kind === "let" || d.kind === "var");
console.log(`═══ ① 顶层 let/var：${lets.length} 个 ═══`);
const letAssigners = new Map();
for (const L of lets) {
  const assigners = [];
  for (const d of decls) {
    if (d.name === L.name) continue;
    const b = bodyOf(d);
    const reAssign = new RegExp(`(?<![\\w$.])${L.name}\\s*=(?!=)`, "g");
    const reInc = new RegExp(`(?<![\\w$.])(\\+\\+|--)\\s*${L.name}\\b|(?<![\\w$.])${L.name}\\s*(\\+\\+|--)(?!\\w)`, "g");
    if (reAssign.test(b) || reInc.test(b)) assigners.push(d.name);
  }
  letAssigners.set(L.name, assigners);
  console.log(`  ${L.name.padEnd(28)} L${String(L.line).padStart(5)}  ${String(L.bytes).padStart(7)}B  ← 被这些声明赋值: ${assigners.join(", ") || "(无：只读)"}`);
}

// ── ② 急切 const 的读取者（摆放它们时要让依赖先求值）────────────────────────
const eager = decls.filter((d) => Array.isArray(d.eager) && d.eager.length > 0);
console.log(`\n═══ ② 急切求值的顶层声明：${eager.length} 个 ═══`);
for (const e of eager) {
  const readers = decls.filter((d) => d.refs.includes(e.name)).map((d) => d.name);
  console.log(`  ${e.name.padEnd(34)} L${String(e.line).padStart(5)} ${String(e.bytes).padStart(7)}B`);
  console.log(`      初始化时调用: ${e.eager.join(", ")}`);
  console.log(`      被谁读: ${readers.slice(0, 14).join(", ")}${readers.length > 14 ? ` …(+${readers.length - 14})` : ""}`);
}

// ── ③ 强连通分量（Tarjan）──────────────────────────────────────────────────
const idx = new Map(decls.map((d, i) => [d.name, i]));
const adj = decls.map((d) => d.refs.map((r) => idx.get(r)).filter((x) => x !== undefined));
const N = decls.length;
const index = new Array(N).fill(-1);
const low = new Array(N).fill(0);
const onStack = new Array(N).fill(false);
const stack = [];
let counter = 0;
const sccs = [];

function strongconnect(v) {
  index[v] = counter;
  low[v] = counter;
  counter += 1;
  stack.push(v);
  onStack[v] = true;
  for (const w of adj[v]) {
    if (index[w] === -1) {
      strongconnect(w);
      low[v] = Math.min(low[v], low[w]);
    } else if (onStack[w]) {
      low[v] = Math.min(low[v], index[w]);
    }
  }
  if (low[v] === index[v]) {
    const comp = [];
    for (;;) {
      const w = stack.pop();
      onStack[w] = false;
      comp.push(w);
      if (w === v) break;
    }
    sccs.push(comp);
  }
}
for (let v = 0; v < N; v += 1) if (index[v] === -1) strongconnect(v);

const comps = sccs.map((c) => {
  const members = c.map((i) => decls[i]);
  return {
    members,
    names: members.map((m) => m.name),
    bytes: members.reduce((a, m) => a + m.bytes, 0),
    hasEager: members.some((m) => (m.eager ?? []).length > 0),
  };
});
comps.sort((a, b) => b.bytes - a.bytes);

const big = comps.filter((c) => c.members.length > 1);
const totalBytes = decls.reduce((a, d) => a + d.bytes, 0);
console.log(`\n═══ ③ 强连通分量（SCC）═══`);
console.log(`SCC 总数 ${comps.length}（其中**环**=${big.length} 个）· 声明合计 ${totalBytes} B`);
console.log(`最大环：${big.length ? `${big[0].members.length} 个声明 / ${big[0].bytes} B（占 ${((big[0].bytes / totalBytes) * 100).toFixed(1)}%）` : "无"}`);
console.log(`所有环合计：${big.reduce((a, c) => a + c.bytes, 0)} B（占 ${((big.reduce((a, c) => a + c.bytes, 0) / totalBytes) * 100).toFixed(1)}%）`);
console.log("\n环（按字节降序，前 20）：");
for (const c of big.slice(0, 20)) {
  console.log(`  ${String(c.bytes).padStart(7)}B  ${String(c.members.length).padStart(3)} 个  ${c.hasEager ? "★含急切" : "        "}  ${c.names.slice(0, 8).join(", ")}${c.names.length > 8 ? ` …(+${c.names.length - 8})` : ""}`);
}

const single = comps.filter((c) => c.members.length === 1);
console.log(`\n无环（单例）声明 ${single.length} 个 / ${single.reduce((a, c) => a + c.bytes, 0)} B`);

// ── ④ 最被依赖的核心（拆时它们必须放"叶子层"）──────────────────────────────
console.log(`\n═══ ④ 被引用最多的 20 个声明（放最底层，谁都不依赖）═══`);
for (const d of [...decls].sort((a, b) => b.inDeg - a.inDeg).slice(0, 20)) {
  console.log(`  in=${String(d.inDeg).padStart(3)}  out=${String(d.refs.length).padStart(3)}  ${String(d.bytes).padStart(7)}B  ${d.kind.padEnd(8)} ${d.name}`);
}
