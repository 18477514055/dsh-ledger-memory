/**
 * _measure-f07c.mjs —— 精确列出候选大块的**回导入清单**，为抽离做准备。
 *
 * ★ 判据：能不能安全抽离，看两件事 ——
 *   ① 回 import 多少个名字；
 *   ② 那些名字里**有没有在被抽块里「顶层求值」**（顶层求值才会踩 TDZ / 加载顺序）。
 *      ★ 如果全都只在函数体里用（调用时才求值），那这个环就是良性的。
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

const targets = {
  conformanceOf: [1787, 2191],
  "parseLessonEntries+renderLessonEntry": [618, 716],
  "sendJson+readBody+handleFor": [2192, 2263],
  "settings route layer": [2192, 2804],
  "inspect": [3916, 4383],
};

const decls = new Set();
for (const l of lines) {
  let m;
  if ((m = /^(?:export )?(?:async )?function (\w+)/.exec(l))) decls.add(m[1]);
  else if ((m = /^(?:export )?const (\w+)\s*=/.exec(l))) decls.add(m[1]);
}
const importedByKind = new Map();  // name -> module
for (const l of lines) {
  const m = /^import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/.exec(l);
  if (m) {
    for (const n of m[1].split(",")) {
      const t = n.trim().split(/\s+as\s+/).pop().trim();
      if (t) importedByKind.set(t, m[2]);
    }
  }
}
const GLOBALS = new Set(
  "process console JSON Math Date String Number Boolean Object Array Promise RegExp Error Map Set Symbol BigInt Buffer globalThis this super return function async await true false null undefined NaN Infinity typeof instanceof in of new delete void".split(" ")
);

for (const [label, [from, to]] of Object.entries(targets)) {
  const block = lines.slice(from - 1, to).join("\n");
  const bytes = Buffer.byteLength(block);

  // 块内顶层（缩进 0）出现的标识符 = 可能被"顶层求值"
  const topIds = new Set();
  for (const l of lines.slice(from - 1, to)) {
    if (/^\S/.test(l) || /^ {0,4}\}/.test(l)) {
      for (const m of l.matchAll(/[A-Za-z_$][\w$]*/g)) topIds.add(m[0]);
    }
  }
  const bodyOnly = new Set();
  for (const m of block.matchAll(/[A-Za-z_$][\w$]*/g)) bodyOnly.add(m[0]);

  // 块内自己声明的（顶层 function/const）
  const own = new Set();
  for (const m of block.matchAll(/^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+)\s*=/gm)) own.add(m[1] ?? m[2]);

  const needLocal = [];
  const needImport = [];
  for (const id of bodyOnly) {
    if (GLOBALS.has(id) || own.has(id)) continue;
    if (decls.has(id)) needLocal.push(id);
    else if (importedByKind.has(id)) needImport.push(id);
  }

  console.log(`\n══ ${label}  [${from}-${to}]  ${bytes} B ══`);
  console.log(`   抽走后 part2 余 ${CAP - (cur - bytes)} B`);
  console.log(`   需从 part2 回 import（${needLocal.length}）：${needLocal.sort().join(", ") || "(无)"}`);
  console.log(`   需保留的原 import（${needImport.length}）：${needImport.sort().join(", ") || "(无)"}`);
  const danger = needLocal.filter((n) => topIds.has(n));
  console.log(`   顶层求值风险（${danger.length}）：${danger.sort().join(", ") || "(无 —— 全都是函数体内调用，环是良性的)"}`);
}
