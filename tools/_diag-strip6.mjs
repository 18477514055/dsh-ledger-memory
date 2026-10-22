// 二分定位：从第 1 行开始逐段喂，找出"第一个让 isUnderReal 消失"的**最小前缀行号**。
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
const lines = p2.split("\n");
const target = "export function isUnderReal";
const declLine = lines.findIndex((l) => l.includes(target));

// 从声明行开始**向下**喂：喂到 N 行时，声明还在不在？
// 这样能直接看出"是哪一行之后开始崩的"。
let firstBad = -1;
for (let n = declLine + 1; n <= lines.length; n += 1) {
  const out = strip(lines.slice(0, n).join("\n"));
  if (!out.includes(target)) {
    firstBad = n;
    break;
  }
}
console.log(`声明在 L${declLine + 1}；喂到第 ${firstBad} 行时它开始消失`);
if (firstBad > 0) {
  for (let k = Math.max(0, firstBad - 6); k < firstBad; k++) {
    console.log(`  ${k + 1}: ${JSON.stringify(lines[k].slice(0, 150))}`);
  }
}
