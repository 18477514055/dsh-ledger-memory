/**
 * _measure-f07.mjs —— 为 F-07 抽离**先量尺**，不先动手。
 *
 * ★ 这条纪律是本项目踩出来的：「搬家必须逐字复制，不能重写」。
 *   所以先精确切出候选块，量出字节，并列出它**用到了哪些外部名字** ——
 *   那份名单就是新模块的 import 清单，少一个就是运行时 ReferenceError。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "lib", "part2.js");
const text = fs.readFileSync(SRC, "utf8");
const lines = text.split("\n");

const CAP = 262144;
console.log(`part2.js = ${Buffer.byteLength(text)} B / ${CAP} B（余 ${CAP - Buffer.byteLength(text)} B）\n`);

// 候选块：从某个 `export function` 起，到下一个 `export function` 之前
function blockOf(startLine, endLine) {
  return lines.slice(startLine - 1, endLine).join("\n");
}

const candidates = [
  { name: "installSettingsRoutes + saveSettings", from: 2473, to: 2804 },
  { name: "仅 saveSettings", from: 2702, to: 2804 },
  { name: "capsule 三件套", from: 3210, to: 3467 },
];

// 从模块里收集"顶层声明的名字"，用来判断块内引用了哪些外部符号
const declared = new Set();
for (const l of lines) {
  let m;
  if ((m = /^export function (\w+)/.exec(l))) declared.add(m[1]);
  else if ((m = /^function (\w+)/.exec(l))) declared.add(m[1]);
  else if ((m = /^export const (\w+)/.exec(l))) declared.add(m[1]);
  else if ((m = /^const (\w+)\s*=/.exec(l))) declared.add(m[1]);
}

const imported = new Set();
for (const l of lines) {
  if (/^import\s/.test(l)) {
    const braces = l.match(/\{([^}]*)\}/);
    if (braces) {
      for (const n of braces[1].split(",")) {
        const t = n.trim().split(/\s+as\s+/).pop().trim();
        if (t) imported.add(t);
      }
    }
  }
}

const KEYWORDS = new Set(
  ("break case catch class const continue debugger default delete do else export extends finally for function if " +
    "import in instanceof let new return super switch this throw try typeof var void while with yield await async " +
    "of true false null undefined NaN Infinity"
  ).split(/\s+/),
);

for (const c of candidates) {
  const block = blockOf(c.from, c.to);
  const bytes = Buffer.byteLength(block);
  // 块内出现的标识符
  const ids = new Set();
  for (const m of block.matchAll(/[A-Za-z_$][\w$]*/g)) ids.add(m[0]);
  const need = [];
  for (const id of ids) {
    if (KEYWORDS.has(id)) continue;
    if (declared.has(id)) {
      // 是本模块另一个顶层函数/常量 —— 抽走之后这里就没了，要么一起搬要么 import
      const definedInside = new RegExp(`(?:export )?(?:async )?function ${id}\\b|^(?:export )?const ${id}\\s*=`, "m").test(block);
      if (!definedInside) need.push(id);
      continue;
    }
    if (imported.has(id)) {
      need.push(id);
      continue;
    }
    // 既不是本模块声明也不是 import ⇒ 可能是 node 内建/全局/属性名，忽略
  }
  console.log(`── ${c.name}  [${c.from}-${c.to}]`);
  console.log(`   字节：${bytes} B（抽走 ⇉ part2 余 ${CAP - (Buffer.byteLength(text) - bytes)} B）`);
  console.log(`   需从原处 import 的本模块符号（${need.length}）：${need.sort().join(", ") || "(无)"}`);
  console.log();
}
