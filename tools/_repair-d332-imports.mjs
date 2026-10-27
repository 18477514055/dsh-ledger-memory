/**
 * _repair-d332-imports.mjs —— 把 `part2-tools.js` 的 import 区**重建**成正确形状
 *
 * ★ 起因：我的 `addImports` 有跨匹配 bug，把 `./part2.js` 那条长 import 的成员
 *   错误并进了 `./base.js` ⇒ `SyntaxError: './base.js' does not provide an export named 'buildGoalTree'`。
 *
 * ★ 做法：**从 part2.js 重新推导一份权威清单**，不修补坏掉的那份（修坏东西容易再坏）。
 *   推导口径：
 *     ① 四个 tool 的实现体里出现的**所有标识符**（这次不猜，直接用"part2 的符号表 ∩ 实现体")
 *        —— 说明：静态扫会误报英文散文，但**求交集**只留 part2 真有的符号，噪声几乎归零。
 *     ② 再加上 node 内置（按 `path.` / `fs.` 用法硬判）
 *   然后整段 import 区**替换**成新生成的。
 */
import fs from "node:fs";
import path from "node:path";

const NEW = path.resolve("lib/part2-tools.js");
const P2 = path.resolve("lib/part2.js");

let text = fs.readFileSync(NEW, "utf8");
const p2text = fs.readFileSync(P2, "utf8");
const p2lines = p2text.split(/\r?\n/);
const tmp = process.env.TEMP ?? ".";
fs.writeFileSync(path.join(tmp, `part2-tools-before-repair-${Date.now()}.js`), text, "utf8");

// ── 1. part2 的权威符号表：name → {from} ──────────────────────────────────
const own = new Map();      // part2 自己声明
for (let i = 0; i < p2lines.length; i += 1) {
  const m =
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(p2lines[i]) ||
    /^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=/.exec(p2lines[i]) ||
    /^(?:export\s+)?let\s+([A-Za-z0-9_$]+)\s*=/.exec(p2lines[i]);
  if (m) own.set(m[1], i + 1);
}
const imported = new Map(); // part2 转手 import 的
{
  let i = 0;
  while (i < p2lines.length) {
    if (!/^import\s/.test(p2lines[i].replace(/\/\/[^\n]*/g, ""))) { i += 1; continue; }
    let chunk = p2lines[i];
    let j = i;
    const done = (s) => /from\s+["'][^"']+["']\s*;?\s*$/.test(s.replace(/\/\/[^\n]*/g, ""));
    while (!done(chunk) && j + 1 < p2lines.length) { j += 1; chunk += "\n" + p2lines[j]; }
    const stripped = chunk.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const spec = /from\s+["']([^"']+)["']/.exec(stripped)?.[1];
    if (spec !== undefined) {
      const brace = /\{([\s\S]*?)\}/.exec(stripped);
      if (brace !== null) {
        for (const raw of brace[1].split(",")) {
          const nm = raw.trim().split(/\s+as\s+/)[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(nm)) imported.set(nm, spec);
        }
      }
    }
    i = j + 1;
  }
}
const nodeDefaults = new Map();
for (const m of p2text.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+["'](node:[^"']+)["'];/gm)) {
  nodeDefaults.set(m[1], m[2]);
}

// ── 2. 切出当前文件的 import 区与实现体 ───────────────────────────────────
const importRe = /^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm;
const ms = [...text.matchAll(importRe)];
// ★ 更稳：找第一条以 import 开头的行 → 到实现体第一行 `/**` 或 `export function` 之前
const lines = text.split(/\r?\n/);
let firstImportLine = lines.findIndex((l) => /^import\s/.test(l));
// 往回吃到它上面那行注释块的开头
let headerEnd = firstImportLine;
while (headerEnd > 0 && /^\s*(\/\/|\/\*|\*)/.test(lines[headerEnd - 1])) headerEnd -= 1;
const bodyFirstLine = lines.findIndex((l, i) => i > firstImportLine && /^export\s+function\s+define/.test(l));
if (firstImportLine < 0 || bodyFirstLine < 0) {
  console.log(`🔴 定位失败：firstImportLine=${firstImportLine} bodyFirstLine=${bodyFirstLine}`);
  process.exit(1);
}
const header = lines.slice(0, headerEnd).join("\n");
const body = lines.slice(bodyFirstLine).join("\n");
console.log(`头部 ${headerEnd} 行 · import 区 ${firstImportLine + 1}~${bodyFirstLine} · 实现体 ${bodyFirstLine + 1} 起`);

// ── 3. 求交集：实现体里出现、且 part2 确有（自己声明 or 转手 import）的符号 ──
const used = new Set();
const bodyNoStr = body
  .replace(/`(?:\\.|[^`\\])*`/g, "``")        // 模板串
  .replace(/"(?:\\.|[^"\\])*"/g, '""')          // 双引号串
  .replace(/'(?:\\.|[^'\\])*'/g, "''")          // 单引号串
  .replace(/\/\*[\s\S]*?\*\//g, "")             // 块注释
  .replace(/\/\/[^\n]*/g, "");                  // 行注释

for (const m of bodyNoStr.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
  const n = m[1];
  if (own.has(n) || imported.has(n)) used.add(n);
}
console.log(`实现体里用到、且 part2 确有：${used.size} 个`);

// node 内置（硬判）
const nodeNeeded = new Map();
for (const [n, spec] of nodeDefaults) {
  const re = new RegExp(`\\b${n}\\.(?:[a-zA-Z])`);
  if (re.test(bodyNoStr) || new RegExp(`\\b${n}\\(`).test(bodyNoStr)) nodeNeeded.set(n, spec);
}

// ── 4. 生成新 import 区 ───────────────────────────────────────────────────
const bySpec = new Map(); // spec -> Set
for (const n of used) {
  const spec = own.has(n) ? "./part2.js" : imported.get(n);
  if (spec === undefined) continue;
  if (!bySpec.has(spec)) bySpec.set(spec, new Set());
  bySpec.get(spec).add(n);
}

const out = [];
out.push(`// ── node 内置 ───────────────────────────────────────────────────────────────`);
if (nodeNeeded.size === 0) out.push(`// （无）`);
for (const [n, spec] of [...nodeNeeded.entries()].sort()) out.push(`import ${n} from "${spec}";`);
out.push(``);
out.push(`// ── 项目内模块 ─────────────────────────────────────────────────────────────────`);
out.push(`//   ★ \`./part2.js\` 是**反向**依赖：本模块用它提供的实现（inspect / renderGoalTree …）`);
out.push(`//   ★ 这构成了一个 ESM 循环（part2 ↔ part2-tools），**合法**且已实测：`);
out.push(`//     四个 tool 体内没有顶层求值，且这些依赖全是**函数声明**（提升）⇒ 调用时才解析。`);
const ORDER = ["./part2.js", "./base.js", "./defs.js", "./part1.js", "./part3.js", "./part4.js"];
const specs = [...bySpec.keys()].sort((a, b) => {
  const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a.localeCompare(b);
});
for (const spec of specs) {
  const names = [...bySpec.get(spec)].sort();
  if (names.length <= 4) out.push(`import { ${names.join(", ")} } from "${spec}";`);
  else {
    out.push(`import {`);
    for (const n of names) out.push(`  ${n},`);
    out.push(`} from "${spec}";`);
  }
}

const rebuilt = header + "\n" + out.join("\n") + "\n\n" + body;
fs.writeFileSync(NEW, rebuilt, "utf8");

console.log(`\n═══ 重建后的 import ═══`);
for (const spec of specs) console.log(`  ${spec}（${bySpec.get(spec).size} 个）：${[...bySpec.get(spec)].sort().join(", ")}`);
for (const [n, spec] of nodeNeeded) console.log(`  ${n} ← ${spec}（默认导入）`);
console.log(`\npart2-tools.js = ${Buffer.byteLength(rebuilt, "utf8")} B / ${rebuilt.split(/\r?\n/).length} 行`);
console.log("PROBE-COMPLETE");
