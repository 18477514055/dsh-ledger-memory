/** _measure-f07-e.mjs —— part3 的抽离候选量尺（与 part2 同一套方法）。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "lib", "part3.js");
const text = fs.readFileSync(SRC, "utf8");
const lines = text.split("\n");
const CAP = 262144;
const cur = Buffer.byteLength(text);

const decls = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+)\s*=/.exec(lines[i]);
  if (m) {
    const name = m[1] ?? m[2];
    let j = i + 1;
    while (j < lines.length && !/^(?:export )?(?:async )?function \w+|^(?:export )?const \w+\s*=/.test(lines[j])) j++;
    decls.push({ name, from: i + 1, to: j });
  }
}
const localNames = new Set(decls.map((d) => d.name));

const imported = new Set();
for (const l of lines) {
  const m = /^import\s*\{([^}]*)\}\s*from/.exec(l);
  if (m) for (const x of m[1].split(",")) {
    const t = x.trim().split(/\s+as\s+/).pop().trim();
    if (t) imported.add(t);
  }
}
const GLOBALS = new Set(
  ("process console JSON Math Date String Number Boolean Object Array Promise RegExp Error Map Set Symbol BigInt " +
    "Buffer globalThis this super return function async await true false null undefined NaN Infinity typeof " +
    "instanceof in of new delete void").split(/\s+/)
);

function needs(d) {
  const block = lines.slice(d.from - 1, d.to).join("\n");
  const own = new Set([d.name]);
  for (const m of block.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) own.add(m[1]);
  for (const m of block.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const p of m[1].split(",")) {
      const t = p.trim().split(/[=:\s]/)[0];
      if (t) own.add(t);
    }
  }
  const needLocal = [];
  const needImport = [];
  for (const m of block.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const id = m[0];
    if (GLOBALS.has(id) || own.has(id)) continue;
    if (localNames.has(id) && !needLocal.includes(id)) needLocal.push(id);
    else if (imported.has(id) && !needImport.includes(id)) needImport.push(id);
  }
  return { bytes: Buffer.byteLength(block), needLocal, needImport };
}

const rows = decls.map((d) => ({ d, ...needs(d) }));
rows.sort((a, b) => b.bytes - a.bytes);

console.log(`part3.js = ${cur} B / ${CAP} B（余 ${CAP - cur} B）\n`);
console.log("  字节   需回导   名称  [行号]");
for (const r of rows.slice(0, 20)) {
  console.log(
    `${String(r.bytes).padStart(6)}  ${String(r.needLocal.length).padStart(4)}    ${r.d.name}  [${r.d.from}-${r.d.to}]  ${r.needLocal.slice(0, 6).join(",")}`
  );
}

console.log("\n── 零本地依赖（needLocal=0）的块 ──");
for (const r of rows.filter((x) => x.needLocal.length === 0)) {
  console.log(`  ${String(r.bytes).padStart(6)} B  ${r.d.name}  [${r.d.from}-${r.d.to}]`);
}
