// 修正版：验证面板 CSS 的三处改动是否真的落到位。
// ★ 上一版探针有两个自身缺陷（记下来，免得下次再犯）：
//   ① `.pl-settings__tab--on` 现在是**逗号并列选择器**（`.a, .a:hover {…}`），
//      上一版用 `indexOf(sel + " {")` 找，找不到 ⇒ 假红。
//   ② 判"有没有硬编码白字"时扫的是**整段规则体**，把注释里的 `#ffffff` 也算进去了 ⇒ 假红。
//   ⇒ 这两条都是「尺子错」，不是被测对象的问题（本项目纪律第 6/7 条）。
import fs from "node:fs";

const src = fs.readFileSync("lib/client.js", "utf8");
const BT = String.fromCharCode(96);
const s = src.indexOf("const CSS = " + BT);
const e = src.indexOf(BT + ";", s);
const raw = src.slice(s, e);

// 剥掉 CSS 里的 /* … */ 注释 —— 判"实际生效的声明"必须只看非注释部分。
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

/** 抽出包含某个选择器的那条规则（选择器可并列）。返回**剥注释后**的规则体。 */
function ruleOf(sel) {
  // 朴素扫描：按 `}` 切块，每块里再按 `{` 分成「选择器 + 声明」。
  // （上一版用动态 RegExp 拼，括号没配对 ⇒ 语法错。这里改用纯字符串切分，不会有正则元字符问题。）
  const blocks = css.split("}");
  for (const blk of blocks) {
    const k = blk.indexOf("{");
    if (k < 0) continue;
    const selectors = blk.slice(0, k);
    const decls = blk.slice(k + 1);
    const hit = selectors
      .split(",")
      .map((x) => x.trim())
      .some((x) => x === sel || x.startsWith(sel + ":"));
    if (hit) return selectors.trim() + " {" + decls + "}";
  }
  return "";
}

const checks = [
  ["① .pl-settings 不再 height:100%", !/height:\s*100%/.test(ruleOf(".pl-settings"))],
  ["① .pl-settings 不再 max-height:100%", !/max-height:\s*100%/.test(ruleOf(".pl-settings"))],
  ["② .pl-settings__scroll 不再自己 overflow-y:auto", !/overflow-y:\s*auto/.test(ruleOf(".pl-settings__scroll"))],
  ["② .pl-settings__scroll 不再自己 flex:1 1 auto", !/flex:\s*1\s+1\s+auto/.test(ruleOf(".pl-settings__scroll"))],
  ["③ 选中标签不再 brand-primary 实心", !/background:\s*var\(--dsw-alias-brand-primary\)/.test(ruleOf(".pl-settings__tab--on"))],
  ["③ 选中标签用 currentColor 混色（浅色底、稍微深一点）", /color-mix\(in srgb,\s*currentColor/.test(ruleOf(".pl-settings__tab--on"))],
  ["③ 选中标签无硬编码白字", !/#ffffff?\b/i.test(ruleOf(".pl-settings__tab--on"))],
  ["④ 主按钮不再 brand-primary 实心", !/background:\s*var\(--dsw-alias-brand-primary\)/.test(ruleOf(".pl-settings__btn"))],
  ["④ 主按钮无硬编码白字", !/#ffffff?\b/i.test(ruleOf(".pl-settings__btn"))],
  ["④ 主按钮改用 currentColor 混色", /color-mix\(in srgb,\s*currentColor/.test(ruleOf(".pl-settings__btn"))],
];

let bad = 0;
for (const [n, pass] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${n}`);
  if (!pass) bad++;
}

console.log("\n── 剥注释后的关键规则（人工复核用）──");
for (const sel of [".pl-settings", ".pl-settings__scroll", ".pl-settings__tab--on", ".pl-settings__btn"]) {
  const r = ruleOf(sel).replace(/\n\s*\n/g, "\n").trim();
  console.log(`\n【${sel}】\n${r === "" ? "(没找到)" : r}`);
}

console.log(`\n${bad === 0 ? "✅ 三项改动全部到位" : `❌ ${bad} 项不符合`}`);
