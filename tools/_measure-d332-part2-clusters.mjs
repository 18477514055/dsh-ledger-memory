/**
 * _measure-d332-part2-clusters.mjs —— 给 `part2.js` 找「可安全拆出去」的候选簇
 *
 * ★ 依据（D323/D328 攒下的量尺口径）：
 *   挑"**字节大 / 回导入少 / 顶层求值风险 0**"的块。
 *   - 字节大：拆出去才有意义（小于 8 KB 不值得动一次手术）
 *   - 回导入少：`part2` 自己还用到它的次数（用到越多，拆完要 import 的越多，耦合越深）
 *   - 顶层求值风险 0：**函数声明**最安全；`const X = ...()` 这类顶层执行的有风险
 *
 * ★★★ 最重要的一条（D328 血的教训）：**搬实现可以，改调用面不行**。
 *   ⇒ 拆完必须在 `part2.js` 里留 `import { … } from "./新模块.js"` + `export { … } from "./新模块.js"`，
 *     这样 `index.js` 等所有调用方**一个字都不用改**。
 */
import fs from "node:fs";
import path from "node:path";

const P2 = path.resolve("lib/part2.js");
const text = fs.readFileSync(P2, "utf8");
const lines = text.split(/\r?\n/);
const totalBytes = Buffer.byteLength(text, "utf8");

console.log(`part2.js = ${totalBytes} B / ${lines.length} 行`);

// ── 1. 抓所有顶层声明（行首不缩进的 export / function / const / let） ──────────
const decls = [];
for (let i = 0; i < lines.length; i += 1) {
  const l = lines[i];
  // 顶层（行首无空白）声明
  const m =
    /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(l) ||
    /^export\s+const\s+([A-Za-z0-9_$]+)/.exec(l) ||
    /^export\s+let\s+([A-Za-z0-9_$]+)/.exec(l) ||
    /^function\s+([A-Za-z0-9_$]+)/.exec(l) ||
    /^const\s+([A-Za-z0-9_$]+)\s*=/.exec(l) ||
    /^let\s+([A-Za-z0-9_$]+)\s*=/.exec(l);
  if (!m) continue;
  const kind = /function/.test(l) ? "function" : /^export\s+const/.test(l) ? "const" : /^export\s+let/.test(l) ? "let" : /^const/.test(l) ? "const" : "let";
  const exported = l.startsWith("export");
  decls.push({ name: m[1], start: i, kind, exported, head: l.slice(0, 100) });
}

// ── 2. 算每个声明的字节数（到自己名字再次出现的顶层声明前） ─────────────────
for (let k = 0; k < decls.length; k += 1) {
  const d = decls[k];
  const end = k + 1 < decls.length ? decls[k + 1].start : lines.length;
  d.endLine = end;
  d.bytes = Buffer.byteLength(lines.slice(d.start, end).join("\n"), "utf8");
  d.lineCount = end - d.start;
}

console.log(`\n顶层声明 ${decls.length} 个`);

// ── 3. 分簇：按声明之间是否有"大片空白/注释分隔"不切；改用**滑动窗口**：  ──
//      找连续 N 个声明、总字节大、且这些名字在**其余代码里很少被引用**
const nameList = decls.map((d) => d.name);

/** 某名字在整份文件里出现的次数（排除它自己的声明行）。 */
function refCount(name) {
  const re = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`, "g");
  const all = (text.match(re) ?? []).length;
  return all - 1; // 减去声明那一处
}

for (const d of decls) d.refs = refCount(d.name);

// 排序：只列 exported 且 bytes >= 6000 的
const big = decls.filter((d) => d.exported && d.bytes >= 6000).sort((a, b) => b.bytes - a.bytes);
console.log(`\n═══ 单个导出声明 ≥ 6 KB 的（按字节降序）═══`);
for (const d of big) {
  console.log(
    `  ${d.name.padEnd(30)} ${String(d.bytes).padStart(8)} B  ${String(d.lineCount).padStart(5)} 行  refs=${String(d.refs).padStart(4)}  kind=${d.kind}`
  );
}

// ── 4. 找"名字前缀成簇"的一批（例如 define*Tool / *Of / render*） ─────────────
console.log(`\n═══ 按名字前缀分组（只列总字节 ≥ 6000 的组）═══`);
const groups = new Map();
for (const d of decls) {
  if (!d.exported) continue;
  let g = "其他";
  if (/^define/.test(d.name)) g = "define*（工具定义）";
  else if (/^render/.test(d.name)) g = "render*（注入渲染）";
  else if (/Of$/.test(d.name)) g = "*Of（判据/取值）";
  else if (/^offer/.test(d.name)) g = "offer*（回合末选择）";
  else if (/^create|^derive|^inspect|^projectRoot/.test(d.name)) g = "create/derive/inspect/projectRoot";
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(d);
}
const gRows = [...groups.entries()]
  .map(([g, ds]) => ({ g, n: ds.length, bytes: ds.reduce((s, d) => s + d.bytes, 0), refs: ds.reduce((s, d) => s + d.refs, 0), names: ds.map((d) => d.name) }))
  .sort((a, b) => b.bytes - a.bytes);
for (const r of gRows) {
  if (r.bytes < 6000) continue;
  console.log(`  ${r.g.padEnd(34)} ${String(r.bytes).padStart(8)} B  ${String(r.n).padStart(3)} 个  总refs=${r.refs}`);
  console.log(`       ${r.names.join(", ").slice(0, 200)}`);
}

// ── 5. 候选：define*Tool 全族（它们只在 index.js 里被调用，part2 内部不互调） ──
console.log(`\n═══ 候选 A：define* 工具定义族 —— 逐个查它在 part2 内部被引用几次 ═══`);
const defineFamily = decls.filter((d) => d.exported && /^define/.test(d.name));
let sum = 0;
for (const d of defineFamily) {
  sum += d.bytes;
  console.log(`  ${d.name.padEnd(32)} ${String(d.bytes).padStart(7)} B  refs(含 index.js? 不算) = ${d.refs}`);
}
console.log(`  ⇒ 族合计 ${sum} B`);

console.log("\nPROBE-COMPLETE");
