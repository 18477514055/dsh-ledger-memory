// ═══════════════════════════════════════════════════════════════════════════
// D216 · `lib/index.js` 拆分生成器（**在隔离副本上跑，绝不直接改真源码**）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 设计依据（全部**实测**，见 `_probe-d216-esm-mechanism.mjs` 5/5 与 `_probe-d216-scc.mjs`）：
//   · 整个文件是**一个大环**（213 声明 / 82.5%）⇒ 不能"按依赖分层、从叶子往上搬"
//   · ESM 里 **`function` 声明在实例化阶段就初始化**（提升）⇒ 环里顶层读**函数**是安全的
//   · 顶层读**另一个模块的 const** ⇒ **TDZ**
//   · **给 import 进来的 `let` 赋值** ⇒ TypeError
//
// ⇒ 因此布局是（这条布局把上面三条风险一次性消掉）：
//   ┌ defs.js    —— **全部** 顶层 const/let/var（保持原文件顺序）
//   │              ＋ 它们在**初始化时调用**的那几个函数（`settingSpecMax` 等）
//   │              ★ 它**只 import 函数**（函数提升 ⇒ 环安全）
//   ├ part1..partN —— **只放函数**，按文件顺序贪心装箱（允许环）
//   └ index.js   —— 文件头（含 node 内建 import）＋ import ＋ `apply()` ＋ 四个再导出
//
// ★ 为什么这样最稳：唯一会 TDZ 的组合是"跨模块 const 读 const"。
//   把全部 const 收在一个模块里 ⇒ 跨模块就**只剩"读函数"**这一种 ⇒ 实验 A 已证明安全。
//
// 用法：node tools/_probe-d216-split.mjs --out <目标目录> [--target=195000]
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
// ★★★ 引用分析用**词法器**，不用正则（正则处理不了转义引号，实测漏掉 13 处引用 ⇒ 运行时 ReferenceError）。
//   详见 `tools/_d216-lexer.mjs` 顶部的留档。
import { codeOnly, refsIn } from "./_d216-lexer.mjs";

const ROOT = process.cwd();
const LIB = path.join(ROOT, "lib", "index.js");
const src = fs.readFileSync(LIB, "utf8");
const lines = src.split("\n");
const B = (a, b) => Buffer.byteLength(lines.slice(a - 1, b).join("\n"), "utf8");

const argv = process.argv.slice(2);
const OUT = (argv.find((a) => a.startsWith("--out=")) ?? "--out=").split("=")[1];
const TARGET = Number((argv.find((a) => a.startsWith("--target=")) ?? "--target=190000").split("=")[1]);
if (!OUT) {
  console.error("用法：node tools/_probe-d216-split.mjs --out <目标目录> [--target=190000]");
  process.exit(2);
}
const HARD_MAX = 262144;

// ── ① 顶层声明（第 0 列 + 模式；判据见 `_probe-d216-graph.mjs` 的说明）──────
const declRe = /^(export\s+)?(async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
const starts = [];
for (let i = 0; i < lines.length; i += 1) {
  const m = declRe.exec(lines[i]);
  if (m !== null) starts.push({ line: i + 1, kind: m[3], name: m[4], already: m[1] !== undefined });
}
const decls = [];
for (let k = 0; k < starts.length; k += 1) {
  const s = starts[k];
  const next = k + 1 < starts.length ? starts[k + 1].line : lines.length + 1;
  let end = next - 1;
  while (end > s.line && lines[end - 1].trim() === "") end -= 1;
  decls.push({ ...s, end, text: lines.slice(s.line - 1, end).join("\n"), bytes: B(s.line, end) });
}

/**
 * ★★★ 剥注释/字符串 —— **用词法器，不用正则**（这是本拆分最深的一个坑，留档）。
 *
 * 我在这条路上**连栽三次**，根因是同一个：**用正则做词法分析本身就不对**。
 *   · 坑 1：模板整体换成 `T` ⇒ `${stampSec(now)}` 里的真调用一起没了 ⇒ 漏 import。
 *   · 坑 2：`...X` 被 lookbehind `(?<![\w$.])` 当成属性访问 ⇒ 漏 `DEFAULT_LOG_LEVELS`。
 *   · 坑 3（最隐蔽）：**转义引号** `"...\\\"journal\\\"..." +` 让正则的引号配对错位
 *     ⇒ 吃掉下一行 ⇒ 漏 `CHECKPOINT_TOOL` ⇒ 校验器报"✅"而运行时 `ReferenceError`。
 * ⇒ 正则**没有状态记忆**，处理不了转义/嵌套。改用逐字符状态机（`_d216-lexer.mjs`）。
 */
const strip = (t) => codeOnly(t);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameSet = new Set(decls.map((d) => d.name));

/**
 * ★★★ 判据方向（很要紧）：**import 漏报 = 致命（运行时报 ReferenceError）；
 *   多报 = 无害（多 import 一个真实存在的顶层名，不报错）。**
 * ⇒ 所以一律**宁可多报**，并且用词法器（`refsIn`，它已处理 `...` 与转义）。
 */
function refsOf(text, self) {
  return refsIn(text, nameSet, self);
}
for (const d of decls) d.refs = refsOf(d.text, d.name);

// ── ② 急切 const：初始化表达式**在模块求值时**就调用别的顶层函数 ─────────────
//   判据：非 function/class；`= ` 之后的**首个表达式**不是 `{`/`[`（成员不求值）；
//   并在**剥掉注释与字符串**后找 `name(`。
//   ★ 第一版判据的错（留档）：只看"body 里出现过 name(" ⇒ 把 `{ renderX, renderY }`
//     这种**简写成员**也算成急切 ⇒ 误报 49 个声明要挪。
for (const d of decls) {
  d.eager = [];
  if (d.kind === "function" || d.kind === "class") continue;
  const t = strip(d.text);
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  let init = t.slice(eq + 1).trim();
  if (/^[{[]/.test(init)) continue; // 对象/数组字面量 ⇒ 成员不立即求值
  init = init.split("\n")[0];
  for (const r of d.refs) if (new RegExp(`(?<![\\w$.])${esc(r)}\\s*\\(`).test(init)) d.eager.push(r);
}

// ── ③ 可变顶层 let/var 的**写入者**（含 `+=` / `++` —— 第一版漏了这两种，是假阴性）──
const mutables = decls.filter((d) => d.kind === "let" || d.kind === "var");
for (const M of mutables) {
  M.writers = [];
  for (const d of decls) {
    if (d.name === M.name) continue;
    const t = strip(d.text);
    const w = new RegExp(`(?<![\\w$.])${esc(M.name)}\\s*(=(?!=)|\\+=|-=|\\*=|/=|%=|\\+\\+|--)`);
    if (w.test(t)) M.writers.push(d.name);
  }
}

// ── ④ 归组 ─────────────────────────────────────────────────────────────────
const inDefs = new Set();
for (const d of decls) if (d.kind === "const" || d.kind === "let" || d.kind === "var" || d.kind === "class") inDefs.add(d.name);
// 急切 const 调用的函数 ⇒ 也进 defs（否则 defs 要在求值时 import 一个"还没求值完"的模块，
//   虽然函数提升使它实际安全，但**收进同模块最省心、也最好读**）
for (const d of decls) if (d.eager.length) for (const n of d.eager) inDefs.add(n);
// 可变 let 的写入者 ⇒ 必须同模块（ESM 禁止跨模块赋值）
for (const M of mutables) for (const w of M.writers) inDefs.add(w);

const defsDecls = decls.filter((d) => inDefs.has(d.name)).sort((a, b) => a.line - b.line);
const fnDecls = decls.filter((d) => !inDefs.has(d.name)).sort((a, b) => a.line - b.line);

// ── ⑤ defs 若超限 ⇒ 按文件顺序再切（后一个 import 前一个 ⇒ 反向读，安全）────
function packByOrder(list, budget) {
  const bins = [];
  let cur = [];
  let curBytes = 0;
  for (const d of list) {
    if (cur.length > 0 && curBytes + d.bytes > budget) {
      bins.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(d);
    curBytes += d.bytes;
  }
  if (cur.length) bins.push(cur);
  return bins;
}
const defsBins = packByOrder(defsDecls, TARGET);
const defsNames = defsBins.map((bin, i) => (defsBins.length === 1 ? "defs.js" : `defs${i + 1}.js`));
const fnBins = packByOrder(fnDecls, TARGET);
const fnNames = fnBins.map((_, i) => `part${i + 1}.js`);

// name → 模块名
const modOf = new Map();
defsBins.forEach((bin, i) => bin.forEach((d) => modOf.set(d.name, defsNames[i])));
fnBins.forEach((bin, i) => bin.forEach((d) => modOf.set(d.name, fnNames[i])));
modOf.set("apply", "index.js");

// ── ⑥ 代码生成 ─────────────────────────────────────────────────────────────
const NODE_IMPORTS = [
  [/fs\./, 'import fs from "node:fs";'],
  [/os\./, 'import os from "node:os";'],
  [/path\./, 'import path from "node:path";'],
  [/spawnSync\s*\(/, 'import { spawnSync } from "node:child_process";'],
  // ★ `node:crypto` 两条规则会各命中一次 ⇒ 同一模块里出现两行 `import { randomUUID }`
  //   ⇒ `SyntaxError: Identifier 'randomUUID' has already been declared`（我当场踩到）。
  //   ⇒ 合并成**一条**带全名的 import；下面的 `dedupeNodeImports` 再兜一层。
  [/\b(createHash|randomUUID)\s*\(/, 'import { createHash, randomUUID } from "node:crypto";'],
  [/fileURLToPath\s*\(/, 'import { fileURLToPath } from "node:url";'],
];

/**
 * ★★★ 同源 import 去重（第 1 版漏了 ⇒ 生成的代码直接语法错）。
 * 病：`node:crypto` 有两条规则（`createHash` / `randomUUID`），只用到其中一个时，
 *   两条规则**各自**生成一行 `import { … } from "node:crypto"` ⇒ 同名标识符重复声明。
 * ⇒ 正解不是"只保留一条规则"（那会漏 `randomUUID`），而是**按模块聚合、合并同名来源**。
 */
function dedupeNodeImports(list) {
  const seen = new Set();
  const out = [];
  for (const line of list) {
    // 抽出 `from "xxx"` 作为去重键（同名来源只留一条）
    const m = /from\s+"([^"]+)"/.exec(line);
    const key = m === null ? line : m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/** 给一条声明加 `export`（已经导出的不动；用独立 `export { X };` 导出的也不动）。 */
function withExport(d, keepExportStmt) {
  const stmt = new RegExp(`^export\\s*\\{\\s*${esc(d.name)}\\s*\\}\\s*;?\\s*$`, "m");
  if (stmt.test(d.text)) return { text: d.text, skipped: true };
  if (d.already) return { text: d.text, skipped: true };
  // 只改**声明那一行**（保留其缩进/async 等前缀）
  const first = d.text.split("\n")[0];
  const replaced = first.replace(/^(export\s+)?/, "export ");
  return { text: [replaced, ...d.text.split("\n").slice(1)].join("\n"), skipped: false };
}

/** 生一个模块文件的内容。 */
function emit(modName, ownDecls, { header = "", extraExports = [] } = {}) {
  const ownNames = new Set(ownDecls.map((d) => d.name));
  // 该模块引用到的、属于**别的**模块的名字
  const needed = new Set();
  for (const d of ownDecls) for (const r of d.refs) if (!ownNames.has(r) && modOf.has(r)) needed.add(r);
  // 按模块归拢 import
  const byMod = new Map();
  for (const n of needed) {
    const m = modOf.get(n);
    if (m === modName) continue;
    if (!byMod.has(m)) byMod.set(m, []);
    byMod.get(m).push(n);
  }
  const bodyText = ownDecls.map((d) => withExport(d).text).join("\n\n");
  // node 内建：按**本模块自己用到的**生成
  const probe = strip(bodyText);
  const nodeImports = dedupeNodeImports(NODE_IMPORTS.filter(([re]) => re.test(probe)).map(([, t]) => t));
  const missingNode = NODE_IMPORTS.filter(([re]) => re.test(probe)).length;
  const localImports = [...byMod.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([m, names]) => `import { ${[...new Set(names)].sort().join(", ")} } from "./${m}";`);
  return {
    text: [header, ...nodeImports, ...localImports, ...extraExports, "", bodyText, ""]
      .filter((x) => x !== "")
      .join("\n"),
    nodeImports: nodeImports.length,
    missingNode,
    localImports: localImports.length,
    needed: needed.size,
  };
}

// index.js 的文件头 = 原 L1..第一条声明前（就是那段大注释 + node 内建 import）
const headerEnd = decls[0].line - 1;
const header = lines.slice(0, headerEnd).join("\n");
/**
 * ★★★ 文件头**自带** node 内建 import（原文件的 L79-87）⇒ 若 header 里已经有某一行，
 *   生成时**绝不能再加**（否则 `Identifier 'createHash' has already been declared` —— 我当场踩到）。
 *   ★ 判据：按 `from "xxx"` 的来源去重，**header 里已有的优先**。
 */
const headerImportKeys = new Set(
  [...header.matchAll(/^import\s+.*?from\s+"([^"]+)"/gm)].map((m) => m[1])
);
// apply 那条声明
const applyDecl = decls.find((d) => d.name === "apply");
// index 还需要的：apply 引用到的名字 + 四个对外名字
const idxDecls = [];
{
  const fakeRefs = refsOf(applyDecl.text, "apply");
  const ownNames = new Set(["apply"]);
  const needed = fakeRefs.filter((r) => !ownNames.has(r) && modOf.has(r));
  const byMod = new Map();
  for (const n of needed) {
    const m = modOf.get(n);
    if (!byMod.has(m)) byMod.set(m, []);
    byMod.get(m).push(n);
  }
  idxDecls.push(...[...byMod.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([m, names]) => ({ import: m, names })));
}

const files = new Map();
// defs 各箱
defsBins.forEach((bin, i) => {
  const r = emit(defsNames[i], bin);
  files.set(defsNames[i], r);
});
// 函数各箱
fnBins.forEach((bin, i) => {
  const r = emit(fnNames[i], bin);
  files.set(fnNames[i], r);
});
// index.js
{
  const imports = idxDecls.map((x) => `import { ${[...new Set(x.names)].sort().join(", ")} } from "./${x.import}";`);
  const nodeImports = dedupeNodeImports(
    NODE_IMPORTS.filter(([re]) => re.test(strip(applyDecl.text)))
      .map(([, t]) => t)
      // ★ 文件头里已有的来源，这里**一条都不再生成**（否则重复声明 ⇒ 语法错）
      .filter((t) => {
        const m = /from\s+"([^"]+)"/.exec(t);
        return m === null || !headerImportKeys.has(m[1]);
      })
  );
  const reexport = `export { name, inject, Config, __test } from "./${defsNames[0]}";`;
  const text = [header, ...nodeImports, ...imports, "", reexport, "", applyDecl.text, ""].join("\n");
  files.set("index.js", { text, nodeImports: nodeImports.length, localImports: imports.length, needed: 0 });
}

// ── ⑦ 写盘 + 体检 ──────────────────────────────────────────────────────────
const outLib = path.join(OUT, "lib");
fs.mkdirSync(outLib, { recursive: true });
const report = [];
let over = 0;
for (const [name, info] of files) {
  const bytes = Buffer.byteLength(info.text, "utf8");
  fs.writeFileSync(path.join(outLib, name), info.text, "utf8");
  report.push({ name, bytes, decls: (name === "index.js" ? 1 : (defsBins.find((_, i) => defsNames[i] === name) ?? fnBins[fnNames.indexOf(name)]).length), imports: info.localImports, node: info.nodeImports });
  if (bytes > HARD_MAX) over += 1;
}
report.sort((a, b) => b.bytes - a.bytes);
console.log(`输出目录：${outLib}\n`);
console.log("模块                    字节     声明  本地import  node");
for (const r of report) {
  const flag = r.bytes > HARD_MAX ? "  ⛔ 超硬上限" : r.bytes > TARGET ? "  ⚠ 超目标(未超硬限)" : "";
  console.log(`  ${r.name.padEnd(20)} ${String(r.bytes).padStart(7)}  ${String(r.decls).padStart(4)}  ${String(r.imports).padStart(6)}  ${String(r.node).padStart(4)}${flag}`);
}
const total = report.reduce((a, r) => a + r.bytes, 0);
console.log(`\n合计 ${total} B · 原文件 ${Buffer.byteLength(src, "utf8")} B（拆分增重 ${total - Buffer.byteLength(src, "utf8")} B）`);
console.log(`模块数 ${report.length} · 超硬上限 ${over} 个`);
console.log(`\n归组统计：defs ${defsDecls.length} 条 / 函数 ${fnDecls.length} 条 · defs 箱 ${defsBins.length} · 函数箱 ${fnBins.length}`);
if (over > 0) {
  console.log("⛔ 有模块超硬上限 —— 必须调小 --target 重跑。");
  process.exitCode = 1;
}
