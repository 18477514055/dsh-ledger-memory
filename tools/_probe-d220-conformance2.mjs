// D220 附2 · 直接调 conformanceOf(info)，看它会不会因为
// `decisions: "DECISIONS.md"`（文件已不在盘上）而**误报不合适**。
//
// 用法：node tools/_probe-d220-conformance2.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const lib = path.join(ROOT, "lib");
const u = (f) => pathToFileURL(path.join(lib, f)).href;

process.env.DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.TEMP ?? ".", "d220-probe-home");

const m2 = await import(u("part2.js"));
const info = m2.inspect(ROOT);
const r = m2.conformanceOf(info);

console.log("=== conformanceOf(info) ===");
console.log(JSON.stringify(r, null, 1));
console.log("\n=== 逐条读 ===");
console.log(`  ok       = ${r.ok}`);
for (const k of ["reasons", "fixable", "missing"]) {
  if (Array.isArray(r[k])) {
    console.log(`  ${k}（${r[k].length} 条）：`);
    for (const x of r[k]) console.log(`    · ${typeof x === "string" ? x : JSON.stringify(x)}`);
  }
}
