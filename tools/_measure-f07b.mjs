/**
 * _measure-f07b.mjs —— 第二轮量尺：专找**纯函数簇**（依赖少、无副作用、最易安全抽离）。
 *
 * ★ 判据来自本项目 D307/D318/D319：抽离的**代价**主要由「要回 import 多少个符号」决定，
 *   而不是由「有多大」决定。回 import 越多 ⇒ 依赖环越重 ⇒ 越容易在加载顺序上出事。
 *   ⇒ 优先挑「字节大 / 依赖少」的比值最高的那一块。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "lib", "part2.js");
const text = fs.readFileSync(SRC, "utf8");
const lines = text.split("\n");
const CAP = 262144;
const cur = Buffer.byteLength(text);

// 找出所有顶层声明的起止行
const decls = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+)\s*=/.exec(lines[i]);
  if (m) {
    const name = m[1] ?? m[2];
    // 结束：到下一个顶层声明之前（或文件末）
    let j = i + 1;
    let depth = 0;
    while (j < lines.length) {
      if (/^(?:export )?(?:async )?function \w+|^(?:export )?const \w+\s*=/.test(lines[j])) break;
      j++;
    }
    decls.push({ name, from: i + 1, to: j });
  }
}

const textOf = (d) => lines.slice(d.from - 1, d.to).join("\n");
const localNames = new Set(decls.map((d) => d.name));

const imported = new Set();
for (const l of lines) {
  if (/^import\s/.test(l)) {
    const b = l.match(/\{([^}]*)\}/);
    if (b) for (const n of b[1].split(",")) {
      const t = n.trim().split(/\s+as\s+/).pop().trim();
      if (t) imported.add(t);
    }
  }
}
const GLOBALS = new Set(("process console JSON Math Date String Number Boolean Object Array Promise RegExp Error Map Set Symbol BigInt Buffer globalThis require module exports import meta this super return function async await true false null undefined NaN Infinity typeof instanceof in of new delete void").split(/\s+/));

function needsOf(d) {
  const block = textOf(d);
  const ids = new Set();
  for (const m of block.matchAll(/[A-Za-z_$][\w$]*/g)) ids.add(m[0]);
  const local = new Set([d.name]);
  for (const m of block.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  for (const m of block.matchAll(/\(([^)]*)\)\s*=>/g)) for (const p of m[1].split(",")) {
    const t = p.trim().split(/[=\s]/)[0];
    if (t) local.add(t);
  }
  const needLocal = [];
  const needImported = [];
  for (const id of ids) {
    if (GLOBALS.has(id) || local.has(id)) continue;
    if (localNames.has(id)) needLocal.push(id);
    else if (imported.has(id)) needImported.push(id);
  }
  return { bytes: Buffer.byteLength(block), needLocal: [...new Set(needLocal)], needImported: [...new Set(needImported)], block };
}

const rows = decls.map((d) => ({ d, ...needsOf(d) }));
rows.sort((a, b) => b.bytes - a.bytes);

console.log("── 按字节排名的顶层声明（前 25）──");
console.log("  字节   需回导   名称");
for (const r of rows.slice(0, 25)) {
  console.log(
    `${String(r.bytes).padStart(6)}  ${String(r.needLocal.length + r.needImported.length).padStart(4)}    ${r.d.name}  [${r.d.from}-${r.d.to}]`
  );
}

console.log("\n── **零依赖**（needLocal=0 且 needImported=0）的块 —— 抽离零风险 ──");
let zeroTotal = 0;
for (const r of rows.filter((x) => x.needLocal.length === 0 && x.needImported.length === 0)) {
  zeroTotal += r.bytes;
  console.log(`  ${String(r.bytes).padStart(6)} B  ${r.d.name}  [${r.d.from}-${r.d.to}]`);
}
console.log(`  合计 ${zeroTotal} B ⇒ part2 将余 ${CAP - (cur - zeroTotal)} B`);

// 连续区间：把相邻的零依赖块合并（搬走时连注释一起走，字节更多）
console.log("\n── 可合并的连续零依赖区间（按行相邻合并）──");
const zeroSet = new Set(rows.filter((x) => x.needLocal.length === 0 && x.needImported.length === 0).map((r) => r.d.name));
const zeroDecls = decls.filter((d) => zeroSet.has(d.name));
let group = null;
const groups = [];
for (const d of zeroDecls) {
  if (group === null) group = { from: d.from, to: d.to, names: [d.name] };
  else if (d.from <= group.to + 2) {
    group.to = d.to;
    group.names.push(d.name);
  } else {
    groups.push(group);
    group = { from: d.from, to: d.to, names: [d.name] };
  }
}
if (group) groups.push(group);
for (const g of groups) {
  const bytes = Buffer.byteLength(lines.slice(g.from - 1, g.to).join("\n"));
  console.log(`  ${String(bytes).padStart(6)} B  [${g.from}-${g.to}]  ${g.names.join(", ")}`);
}
