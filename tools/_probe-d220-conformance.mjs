// D220 附 · 用**真正的合规检查**跑一次本项目（它会不会因为 `decisions: "DECISIONS.md"`
// 指向一个不存在的文件而误报？）—— 代码注释里写着「情形 21b 实测撞到」，所以要真问一次。
//
// 用法：node tools/_probe-d220-conformance.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const lib = path.join(ROOT, "lib");
// Windows 上绝对路径不能直接给 import() —— 必须转成 file:// URL
const u = (f) => pathToFileURL(path.join(lib, f)).href;

// 只把 DSH_HOME 指到临时目录（避免任何落盘副作用）—— 这是本项目的既有做法
process.env.DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.TEMP ?? ".", "d220-probe-home");

const m2 = await import(u("part2.js"));
console.log("part2.js 导出的相关函数：");
for (const n of Object.keys(m2).filter((k) => /inspect|conform/i.test(k))) console.log("  " + n);

const info = typeof m2.inspect === "function" ? m2.inspect(ROOT) : undefined;
if (info) {
  console.log("\n=== inspect() 给出的 *Rel 与 *Dir ===");
  for (const k of ["decisionsRel", "decisionsDir", "lessonsRel", "lessonsDir", "goalsRel", "goalsDir"]) {
    console.log(`  ${k.padEnd(13)} = ${JSON.stringify(info[k])}`);
  }
  console.log(`  ${"decisionsSource".padEnd(13)} = ${JSON.stringify(info.decisionsSource)}`);
}

for (const f of ["part3.js", "part4.js", "part1.js"]) {
  const mm = await import(u(f));
  const fn = Object.keys(mm).find((k) => /^conformanceOf$|^detectMigration$/.test(k));
  if (!fn) continue;
  console.log(`\n=== ${f} 的 ${fn}() ===`);
  try {
    const r = mm[fn](info ?? ROOT);
    const s = JSON.stringify(r, null, 1);
    console.log("  " + s.split("\n").slice(0, 40).join("\n  "));
  } catch (e) {
    console.log("  调用失败：" + e.message);
  }
}
