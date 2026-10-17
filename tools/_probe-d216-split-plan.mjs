/**
 * 只读探针（D216）：为「拆分 `lib/index.js`」算出**该沿哪里切**。
 *
 * ★ 为什么必须先算（不许凭感觉切）：
 *   本文件 **21,213 行 / 1,197,256 B**，有 **467 个顶层声明**（144 const + 319 function + 4 class/let/var）
 *   —— 它们**全在同一个模块作用域里互相自由引用**。
 *   而 DSH STORE 的单文件上限是 **262,144 B** ⇒ 至少要切成 **5 个以上**文件。
 *   ★★ 一旦切成 ESM 模块，跨文件的每次引用都必须变成 **显式 import**，
 *     而**循环依赖**在 `apply()` 之前求值的顶层 `const` 上会直接炸（TDZ）。
 *   ⇒ 所以第一个问题不是"怎么切"，而是"**哪里的耦合最松**"。
 *
 * ★ 判据（吃被测对象自己产生的那部分）：
 *   把文件按既有分节切开，统计**每一节从别的节引用了多少符号**。
 *   引用数最少的那条缝 = 最安全的切口。
 *
 * ★ 输出三样：
 *   ① 每节的字节数 / 行数；
 *   ② 跨节引用矩阵（谁依赖谁，各多少）；
 *   ③ 一个**满足 262144 B 预算**的建议分组（贪心：从最大的节开始往回收，优先合并强耦合的）。
 */
import fs from "node:fs";
import path from "node:path";

const LIB = path.join(process.cwd(), "lib", "index.js");
const BUDGET = 262144;
/** 留余量：目标单文件 **≤ 200 KB**（不只 ≤ 262144），避免刚好压线。 */
const TARGET = 200 * 1024;

const src = fs.readFileSync(LIB, "utf8");
const lines = src.split("\n");
console.log(`文件：${LIB}`);
console.log(`大小：${src.length} B（上限 ${BUDGET}，目标 ≤ ${TARGET}）· ${lines.length} 行\n`);

// ── ① 顶层声明：名字 + 所在行 ────────────────────────────────────────────────
const DECL = [];
const RE_DECL =
  /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/;
for (let i = 0; i < lines.length; i += 1) {
  const m = RE_DECL.exec(lines[i]);
  if (m !== null) DECL.push({ name: m[1], line: i + 1 });
}
console.log(`顶层声明 ${DECL.length} 个`);

// ── ② 分节（按既有 `// ═══…` 标记）───────────────────────────────────────────
const SEC = [];
for (let i = 0; i < lines.length; i += 1) {
  if (/^\/\/ ═{20,}/.test(lines[i])) {
    const title = (lines[i + 1] ?? "").replace(/^\/\/ ?/, "").trim().slice(0, 70) || "(无标题)";
    SEC.push({ start: i + 1, title });
  }
}
if (SEC.length === 0 || SEC[0].start !== 1) SEC.unshift({ start: 1, title: "(文件头)" });
for (let k = 0; k < SEC.length; k += 1) {
  SEC[k].end = k + 1 < SEC.length ? SEC[k + 1].start - 1 : lines.length;
  SEC[k].text = lines.slice(SEC[k].start - 1, SEC[k].end).join("\n");
  SEC[k].bytes = Buffer.byteLength(SEC[k].text);
}
console.log(`分节 ${SEC.length} 个\n`);

// ── ③ 每个符号归到哪一节；每节引用了别的节的哪些符号 ────────────────────────
const sectionOfLine = (ln) => {
  for (let k = 0; k < SEC.length; k += 1) {
    if (ln >= SEC[k].start && ln <= SEC[k].end) return k;
  }
  return SEC.length - 1;
};
for (const d of DECL) d.sec = sectionOfLine(d.line);

// 给每节列"本节声明的名字"（同名在本节之外的声明也要算进来 —— 用最长名字优先匹配，
// 避免 `a` 命中 `abc` 的假计数）
const allNames = [...new Set(DECL.map((d) => d.name))].sort((a, b) => b.length - a.length);
for (const s of SEC) s.declared = new Set();
for (const d of DECL) SEC[d.sec].declared.add(d.name);

/** 统计"本节文本里出现了多少个**别节**声明的名字"（按名字计数，不是按次）。 */
const matrix = SEC.map(() => SEC.map(() => 0));
for (let from = 0; from < SEC.length; from += 1) {
  const text = SEC[from].text;
  for (const name of allNames) {
    if (SEC[from].declared.has(name)) continue;
    // 词边界（ASCII 标识符），忽略大小写敏感 —— JS 标识符是大小写敏感的 ⇒ 用 g 精确匹配
    const re = new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/\$/g, "\\$")}([^A-Za-z0-9_$]|$)`, "g");
    if (!re.test(text)) continue;
    // 它由哪几节声明？（理论上只该有一节）
    const owners = new Set(DECL.filter((d) => d.name === name).map((d) => d.sec));
    for (const o of owners) matrix[from][o] += 1;
  }
}

// ── ④ 打印每节概况 + 它的出度/入度 ──────────────────────────────────────────
console.log("── 每节概况（out = 本节引用了多少个外节符号；in = 被多少外节引用）──");
console.log("  行区间              字节    声明  out  in   标题");
const outDeg = SEC.map((_, i) => matrix[i].reduce((a, b, j) => (i === j ? a : a + b), 0));
const inDeg = SEC.map((_, j) => matrix.reduce((a, row, i) => (i === j ? a : a + row[j]), 0));
for (let k = 0; k < SEC.length; k += 1) {
  console.log(
    `  ${String(SEC[k].start).padStart(5)}-${String(SEC[k].end).padStart(5)}  ` +
      `${String(SEC[k].bytes).padStart(8)}  ${String(SEC[k].declared.size).padStart(4)}  ` +
      `${String(outDeg[k]).padStart(3)}  ${String(inDeg[k]).padStart(3)}   ${SEC[k].title}`
  );
}
console.log(`\n合计 ${SEC.reduce((a, s) => a + s.bytes, 0)} B（含文件头）`);

// ── ⑤ 最松的缝：按出度升序给出"可以最先搬走"的节 ────────────────────────────
console.log("\n── 出度最小的 12 节（**最没有依赖、最适合先搬出去**）──");
const ranked = SEC.map((s, i) => ({ i, ...s, out: outDeg[i], in: inDeg[i] }))
  .sort((a, b) => a.out - b.out || a.bytes - b.bytes);
for (const r of ranked.slice(0, 12)) {
  console.log(
    `  out=${String(r.out).padStart(3)} in=${String(r.in).padStart(3)} ` +
      `${String(r.bytes).padStart(8)} B  ${r.title}`
  );
}

// ── ⑥ 贪心建议分组：沿"依赖最少"的顺序累加，直到接近 TARGET ────────────────
//   ★ 只用**尺寸**做第一刀（这是"可行性"问题）；真正的安全性由随后逐步跑自检保证。
console.log(`\n── 建议分组（贪心按 size 装箱，目标 ≤ ${TARGET} B）──`);
const bins = [];
let cur = { bytes: 0, secs: [] };
for (const r of ranked) {
  if (cur.bytes + r.bytes > TARGET && cur.secs.length > 0) {
    bins.push(cur);
    cur = { bytes: 0, secs: [] };
  }
  cur.bytes += r.bytes;
  cur.secs.push(r);
}
if (cur.secs.length > 0) bins.push(cur);
for (let k = 0; k < bins.length; k += 1) {
  const over = bins[k].bytes > BUDGET ? "  ⛔ 超上限" : "";
  console.log(`  箱 ${k + 1}：${bins[k].bytes} B / ${bins[k].secs.length} 节${over}`);
  for (const s of bins[k].secs) console.log(`      ${String(s.bytes).padStart(8)}  ${s.title}`);
}
console.log(
  `\n⇒ ${bins.length} 个箱（含 index.js 自身剩余部分）· ` +
    `最大箱 ${Math.max(...bins.map((b) => b.bytes))} B`
);
