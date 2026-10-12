/**
 * ★ 只读交叉核对：自检里那条"自发现会改写源码的探针"的判据，**独立复算一遍**。
 *
 * ★ 为什么要独立复算（纪律 9/11）：自检自己报"扫到 25 个"，
 *   但那 25 个是**同一份判据**算出来的 —— 若判据本身写错（例如正则过宽/过窄），
 *   自检会"自洽地错"。⇒ 用**独立的实现**再数一次，两个数字对得上才可信。
 */
import fs from "node:fs";
import path from "node:path";

const T = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账\\tools";
const names = fs.readdirSync(T);
let all = 0;
const hits = [];
for (const nm of names) {
  if (!nm.endsWith(".mjs") || nm === "selftest.mjs") continue;
  all++;
  const s = fs.readFileSync(path.join(T, nm), "utf8");
  const c1 = /writeFileSync\s*\(\s*LIB\b/.test(s);
  const c2 = /writeFileSync\s*\(\s*path\.join\([^)]*"lib"[^)]*\)/.test(s);
  const c3 = /["'`]lib[\\/]index\.js["'`]/.test(s);
  if (c1 || c2 || c3) hits.push({ nm, c1, c2, c3 });
}
console.log(`tools 下 .mjs 共 ${all} 个（不含 selftest）；判为"会改写源码" ${hits.length} 个\n`);
for (const h of hits) {
  console.log(`  ${h.nm.padEnd(42)} ${h.c1 ? "writeFileSync(LIB," : ""}${h.c2 ? "path.join-lib " : ""}${h.c3 ? "'lib/index.js'" : ""}`);
}
