// 复现 selftest 的 strip()，查为什么 authorizeRequest 消失了。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const p2 = fs.readFileSync(path.join(ROOT, "lib", "part2.js"), "utf8");

const strip = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/`(?:[^`\\]|\\.)*`/g, "");

const code = strip(p2);
console.log("原文长度:", p2.length, "stripped:", code.length, "删掉:", p2.length - code.length);
for (const name of ["authorizeRequest", "assertAuthorized", "writeFileAtomic", "isUnderReal"]) {
  const re = new RegExp(`export\\s+function\\s+${name}\\s*\\(`);
  console.log(`  ${name}: 原文=${re.test(p2)} stripped=${re.test(code)}`);
}

// 找出 stripped 后从哪开始"缺内容"：定位最后一个还被保留的 export function
const kept = [...code.matchAll(/export\s+function\s+(\w+)/g)].map((m) => m[1]);
console.log("\nstripped 里还剩的 export function 数:", kept.length);
console.log("原文里 export function 数:", [...p2.matchAll(/export\s+function\s+(\w+)/g)].length);
const origNames = [...p2.matchAll(/export\s+function\s+(\w+)/g)].map((m) => m[1]);
const lost = origNames.filter((n) => !kept.includes(n));
console.log("\n被 strip 吞掉的函数名（前 20 个）:", lost.slice(0, 20).join(", "));
console.log("总共吞掉:", lost.length);
