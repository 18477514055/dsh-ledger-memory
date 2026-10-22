// 最小复现：只喂 L1905..1925 那一段，看 strip 怎么处理那块注释。
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

// 从 L1905 喂到 L1925
const seg = lines.slice(1904, 1925).join("\n");
console.log("=== 输入 ===");
seg.split("\n").forEach((l, i) => console.log(`  ${1905 + i}: ${JSON.stringify(l)}`));
console.log("\n=== 输出 ===");
const out = strip(seg);
out.split("\n").forEach((l, i) => console.log(`  ${i + 1}: ${JSON.stringify(l)}`));
console.log(`\n输出里含 findDeFactoLedger: ${out.includes("findDeFactoLedger")}`);

// 再试：只喂到 L1919（注释结束），看注释是否正确剥掉
const seg2 = lines.slice(1912, 1919).join("\n");
console.log("\n=== 只喂 L1913..1919（纯注释块）===");
console.log(JSON.stringify(strip(seg2)));
