// 复刻 selftest 里的 strip，并**逐行**报告"它在哪一行开始跑偏"。
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

// 逐行喂：如果某一行之后"累计剥出的代码"里，本行应有的关键 token 消失了，就报告
const targets = ["isUnderReal", "writeFileAtomic", "nearestExistingAncestor"];
for (const t of targets) {
  const lineNo = lines.findIndex((l) => l.includes("export function " + t)) + 1;
  console.log(`\n=== ${t} 声明在 L${lineNo} ===`);
  // 只喂到该行，看它还在不在
  const upto = lines.slice(0, lineNo).join("\n");
  const outUpto = strip(upto);
  const inOut = outUpto.includes("export function " + t);
  console.log(`  只喂到 L${lineNo} 时它还在: ${inOut}`);
  if (!inOut) {
    // 二分：从 1 到 lineNo，找到最早让它消失的行
    let lo = 1, hi = lineNo;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const s = strip(lines.slice(0, mid).join("\n"));
      if (s.includes("export function " + t)) lo = mid + 1;
      else hi = mid;
    }
    console.log(`  ⇒ 让它消失的行 ≈ L${lo}`);
    for (let k = Math.max(0, lo - 4); k < Math.min(lines.length, lo + 1); k++) {
      console.log(`     ${k + 1}: ${lines[k].slice(0, 140)}`);
    }
  }
}
