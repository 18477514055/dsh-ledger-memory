/**
 * 只读：**数清** selftest 里有多少处 `ledger_init` 调用会受"默认三代"影响。
 * ★ 规矩：改默认值 = 动夹具语义。必须先数清、分类，再一次改完（不是改一处跑一次）。
 * ★ 分类判据：该调用附近是否出现 `memoryRoot` / `layout` / 断言是否检查项目根下的文件。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const F = path.join(ROOT, "tools", "selftest.mjs");
const lines = fs.readFileSync(F, "utf8").split("\n");

const hits = [];
for (let i = 0; i < lines.length; i += 1) {
  if (!/registeredTools\.get\("ledger_init"\)\.execute|initTool\.execute|defineInitTool/.test(lines[i])) continue;
  // 抓这次调用的参数块（往下 40 行）
  const block = lines.slice(i, Math.min(i + 40, lines.length)).join("\n");
  const hasMemoryRoot = /memoryRoot\s*:/.test(block);
  const hasLayout = /layout\s*:/.test(block);
  hits.push({ line: i + 1, hasMemoryRoot, hasLayout, head: lines[i].trim().slice(0, 80) });
}

console.log(`selftest 里 init 调用点数 = ${hits.length}\n`);
for (const h of hits) {
  console.log(`  :${h.line}  memoryRoot=${h.hasMemoryRoot}  layout=${h.hasLayout}`);
  console.log(`      ${h.head}`);
}
console.log(`\n需要加 layout:"flat"（未传 memoryRoot 且未传 layout）的 = ${hits.filter((h) => !h.hasMemoryRoot && !h.hasLayout).length}`);

// 也数一遍探针目录里的
const tdir = path.join(ROOT, "tools");
const probes = fs.readdirSync(tdir).filter((f) => f.endsWith(".mjs") && f !== "selftest.mjs");
let probeCalls = 0;
const probeList = [];
for (const f of probes) {
  const src = fs.readFileSync(path.join(tdir, f), "utf8");
  const n = (src.match(/registeredTools\.get\("ledger_init"\)\.execute|initTool\.execute/g) ?? []).length;
  if (n > 0) { probeCalls += n; probeList.push(`${f}(${n})`); }
}
console.log(`\n探针里的 init 调用 = ${probeCalls} 处：${probeList.join(", ")}`);
