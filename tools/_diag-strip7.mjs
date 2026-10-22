// 逐行比对：原文的每一行，剥后是否还"以某种形式"存在。
// 找出**第一个**连续消失的行 —— 那里就是扫描跑偏的起点。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const selfSrc = fs.readFileSync(path.join(ROOT, "tools", "selftest.mjs"), "utf8");
function grab(name) {
  const i = selfSrc.indexOf(`function ${name}(`);
  let j = selfSrc.indexOf("{", i);
  let depth = 0;
  for (; j < selfSrc.length; j++) {
    if (selfSrc[j] === "{") depth++;
    else if (selfSrc[j] === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  return selfSrc.slice(i, j);
}
const strip = new Function(
  `${grab("needsValueAfter")}\n${grab("stripCommentsAndLiterals")}\nreturn stripCommentsAndLiterals;`
)();

const p2 = fs.readFileSync(path.join(ROOT, "lib", "part2.js"), "utf8");
const out = strip(p2);
const outLines = out.split("\n");
console.log(`原文行数 ${p2.split("\n").length} → 剥后行数 ${outLines.length}`);

// 用"output 的字符流"做指针，对齐原文：拿一个原文里的唯一 token，看它在 out 里出没出现。
// 更实用：找 out 里**最后一个还含 `export function` 的位置**，然后看它对应原文哪里。
const idxs = [...out.matchAll(/export\s+function\s+(\w+)/g)].map((m) => ({ name: m[1], at: m.index }));
console.log(`\n剥后保留的 export function 共 ${idxs.length} 个；最后一个 = ${idxs.at(-1)?.name}`);
const origNames = [...p2.matchAll(/export\s+function\s+(\w+)/g)].map((m) => m[1]);
const kept = new Set(idxs.map((x) => x.name));
const lost = origNames.filter((n) => !kept.has(n));
console.log(`丢失 ${lost.length} 个，第一个丢失的是: ${lost[0]}`);

// 第一个丢失者在原文里的行号
if (lost[0]) {
  const ln = p2.split("\n").findIndex((l) => l.includes("export function " + lost[0])) + 1;
  console.log(`\n第一个丢失的 ${lost[0]} 在原文 L${ln}`);
  const lines = p2.split("\n");
  for (let k = Math.max(0, ln - 15); k < ln + 1; k++) {
    console.log(`  ${k + 1}: ${JSON.stringify(lines[k].slice(0, 120))}`);
  }
}
