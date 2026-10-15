// ═══════════════════════════════════════════════════════════════════════════
// D216 · 顶层声明扫描（**第 2 版，修掉深度漂移**）+ 依赖图 + 装箱
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 第 1 版为什么错（留档，纪律 7 尺子错）：
//   我用"骨架花括号深度 === 0"来判顶层 —— 骨架剥离（正则判定）不完美 ⇒ 深度**漂移** ⇒
//   后续声明全被算进前一条 ⇒ `commandText` 一条吞了 271KB、总数只报 64（真值 467）。
//   ⇒ ★ **判据错的时候，输出看起来"有数据"，但结论全废。**
//
// ★ 第 2 版判据（简单且可靠，因为本文件格式一致）：
//   **行首（第 0 列）**且匹配 `function|const|let|var|class|export …` ⇒ 一条声明的起点。
//   结束 = 下一条起点之前，去掉尾部空行。
//   ★ 自证必须做：报告"被吸收进声明的字节占比"（若本判据漏了顶层语句，这里会露出来）。
//
// 用法：node tools/_probe-d216-graph.mjs [--top N]
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

const LIB = path.join(process.cwd(), "lib", "index.js");
const src = fs.readFileSync(LIB, "utf8");
const lines = src.split("\n");
const B = (a, b) => Buffer.byteLength(lines.slice(a - 1, b).join("\n"), "utf8");

// ── ① 找顶层声明起点：**第 0 列** + 模式 ────────────────────────────────────
const declRe = /^(export\s+)?(async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
const starts = [];
for (let i = 0; i < lines.length; i += 1) {
  const m = declRe.exec(lines[i]);
  if (m !== null) starts.push({ line: i + 1, kind: m[3], name: m[4], hasExport: m[1] !== undefined });
}

const decls = [];
for (let k = 0; k < starts.length; k += 1) {
  const s = starts[k];
  const nextLine = k + 1 < starts.length ? starts[k + 1].line : lines.length + 1;
  let end = nextLine - 1;
  while (end > s.line && lines[end - 1].trim() === "") end -= 1;
  decls.push({ id: k, ...s, end, bytes: B(s.line, end) });
}

// ── ② 自证：覆盖了多少字节（漏判的顶层语句会留在"未覆盖"里）───────────────
const covered = new Array(lines.length + 2).fill(false);
for (const r of decls) for (let i = r.line; i <= r.end; i += 1) covered[i] = true;
let uncoveredBytes = 0;
const gaps = [];
let gapStart = null;
for (let i = 1; i <= lines.length; i += 1) {
  if (!covered[i]) {
    if (gapStart === null) gapStart = i;
  } else if (gapStart !== null) {
    gaps.push([gapStart, i - 1]);
    uncoveredBytes += B(gapStart, i - 1);
    gapStart = null;
  }
}
if (gapStart !== null) {
  gaps.push([gapStart, lines.length]);
  uncoveredBytes += B(gapStart, lines.length);
}

const total = B(1, lines.length);
console.log(`文件 ${LIB}`);
console.log(`真字节 ${total}（上限 262144）· 行数 ${lines.length}`);
console.log(`顶层声明 ${decls.length} 个 · 覆盖 ${total - uncoveredBytes} B (${(((total - uncoveredBytes) / total) * 100).toFixed(1)}%)`);
console.log(`未覆盖行区间 ${gaps.length} 个 · ${uncoveredBytes} B`);
const bigGaps = gaps
  .map(([a, b]) => ({ a, b, bytes: B(a, b), head: (lines[a - 1] ?? "").trim().slice(0, 70) }))
  .filter((g) => g.bytes > 400)
  .sort((x, y) => y.bytes - x.bytes);
console.log("较大未覆盖区间（前 12，看它们是不是顶层语句）：");
for (const g of bigGaps.slice(0, 12)) console.log(`  L${g.a}-${g.b} ${g.bytes} B  ${g.head}`);

// ── ③ 依赖图（声明粒度）────────────────────────────────────────────────────
const nameToDecl = new Map(decls.map((r) => [r.name, r]));
const allNames = [...nameToDecl.keys()];
// 长度降序，避免 `foo` 命中 `fooBar` 的前缀（配合词边界再判一次）
allNames.sort((a, b) => b.length - a.length);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const rec of decls) {
  const body = lines.slice(rec.line - 1, rec.end).join("\n");
  const refs = [];
  for (const nm of allNames) {
    if (nm === rec.name) continue;
    // 词边界：前面不是标识符字符或 `.`（避开属性访问），后面不是标识符字符
    if (new RegExp(`(?<![\\w$.])${escapeRe(nm)}(?![\\w$])`).test(body)) refs.push(nm);
  }
  rec.refs = refs;
}

// ── ④ ★★★ 急切求值检查（TDZ 的唯一来源）────────────────────────────────────
//   判据：非 function/class 的声明，其初始化表达式**在定义一个对象/数组的成员时**
//   不会求值 —— 只有**在顶层直接调用**才算急切。
//
//   ★★★ 第 2 版判据的错（我当场抓到，纪律 2「判据的输入必须是被测对象自己产生的」）：
//     旧写法 = "body 里出现过 `name(`" ⇒ `const __test = { renderX, renderY }` 里的
//     **简写成员**、`const L0_KINDS = { k: (d) => f(d) }` 里的**箭头函数体**，
//     全都命中了 ⇒ 误报 `__test` 急切、还连带要求挪 49 个声明。
//     ★ 但那些调用**发生在成员被调用时**，不是模块求值时 ⇒ **不是急切**。
//   ⇒ 正确判据：把声明体按**顶层逗号/分号**粗切，只保留**初始化表达式的头部**
//     （`= …` 到第一个 `{`/`[` 之前，或整个表达式若不是对象/数组字面量则全取），
//     再在其中找调用。凡初始化式以 `{` 或 `[` 开头的 ⇒ **一定不是急切**（成员不立即求值）。
function strip(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}
for (const rec of decls) {
  rec.eager = [];
  if (rec.kind === "function" || rec.kind === "class") continue;
  const noStr = strip(lines.slice(rec.line - 1, rec.end).join("\n"));
  // 取初始化表达式：`= ` 之后的部分
  const eq = noStr.indexOf("=");
  if (eq < 0) continue;
  let init = noStr.slice(eq + 1).trim();
  // 对象/数组字面量 ⇒ 成员不立即求值 ⇒ 不急切
  if (/^[{[]/.test(init)) continue;
  // 否则取到第一个 `;` 或换行后的顶层结束（粗取：第一行足够，因为字面量已排除）
  init = init.split("\n")[0];
  for (const r of rec.refs) {
    if (new RegExp(`(?<![\\w$.])${escapeRe(r)}\\s*\\(`).test(init)) rec.eager.push(r);
  }
}

const eager = decls.filter((r) => r.eager.length > 0);
console.log(`\n★ 急切求值的顶层声明（TDZ 风险源）：${eager.length} 个`);
for (const r of eager) console.log(`  L${r.line}-${r.end} ${r.kind} ${r.name} (${r.bytes} B) ⇒ ${r.eager.join(", ")}`);

// ── ⑤ 出入度 ───────────────────────────────────────────────────────────────
const inDeg = new Map(allNames.map((n) => [n, 0]));
for (const r of decls) for (const x of r.refs) inDeg.set(x, (inDeg.get(x) ?? 0) + 1);
for (const r of decls) r.inDeg = inDeg.get(r.name) ?? 0;

const top = Number((process.argv.find((a) => a.startsWith("--top=")) ?? "--top=25").split("=")[1]);
console.log(`\n按字节降序（前 ${top}）：`);
for (const r of [...decls].sort((a, b) => b.bytes - a.bytes).slice(0, top)) {
  console.log(
    `  L${String(r.line).padStart(5)}-${String(r.end).padStart(5)} ${String(r.bytes).padStart(7)}B ${r.kind.padEnd(8)} ${r.name.padEnd(40)} out=${String(r.refs.length).padStart(3)} in=${String(r.inDeg).padStart(3)}${r.eager.length ? " EAGER" : ""}`
  );
}

const outPath = path.join(process.cwd(), "tools", "_d216-graph.json");
fs.writeFileSync(outPath, JSON.stringify({ total, decls }, null, 1), "utf8");
console.log(`\n图已写：${outPath}`);
