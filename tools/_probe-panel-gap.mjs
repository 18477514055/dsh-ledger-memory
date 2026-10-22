// 验证「stack 行里 .pl-settings__main 的 flex-basis 变成高度 ⇒ 撑出空白」这条判断。
//
// ★ 判断本身靠 CSS 规范：flex-basis 的方向跟随父级 flex-direction。
//   这里做两件事：① 检查样式是否已修；② 检查**横向行不受影响**（不能把 240px 全局改掉）。
import fs from "node:fs";

const src = fs.readFileSync("lib/client.js", "utf8");
const BT = String.fromCharCode(96);
const s = src.indexOf("const CSS = " + BT);
const e = src.indexOf(BT + ";", s);
const css = src.slice(s, e).replace(/\/\*[\s\S]*?\*\//g, ""); // 剥注释

function ruleOf(sel) {
  const blocks = css.split("}");
  for (const blk of blocks) {
    const k = blk.indexOf("{");
    if (k < 0) continue;
    const selectors = blk.slice(0, k);
    const decls = blk.slice(k + 1);
    const hit = selectors.split(",").map((x) => x.trim()).some((x) => x === sel || x.startsWith(sel + ":"));
    if (hit) return { sel: selectors.trim(), decls: decls.trim() };
  }
  return null;
}

const main = ruleOf(".pl-settings__main");
const stackMain = ruleOf(".pl-settings__row--stack > .pl-settings__main");

console.log("【.pl-settings__main】");
console.log("  " + (main ? main.decls : "(没找到)"));
console.log("\n【stack 行里的 main】");
console.log("  " + (stackMain ? stackMain.decls : "(★ 没找到覆盖规则 —— 空白没修)"));
console.log();

const checks = [
  ["横向行仍保留 240px 基准（宽度用途，不能删）", main !== null && /240px/.test(main.decls)],
  ["stack 行里有覆盖规则", stackMain !== null],
  ["★ stack 行里 basis 归零（不再当高度用）", stackMain !== null && /flex:\s*0\s+1\s+auto/.test(stackMain.decls)],
  ["★ stack 行里没有残留 240px", stackMain !== null && !/240px/.test(stackMain.decls)],
];

let bad = 0;
for (const [n, ok] of checks) {
  console.log(`${ok ? "✅" : "❌"} ${n}`);
  if (!ok) bad++;
}
console.log(`\n${bad === 0 ? "✅ 修法成立：横向行不受影响，stack 行不再被撑高" : `❌ ${bad} 项不符`}`);
