import fs from "node:fs";
const src = fs.readFileSync("lib/client.js","utf8");
// 找包含 .pl-settings__tabs 的那个模板字符串
const i = src.indexOf(".pl-settings__tabs {");
let start = src.lastIndexOf("`", i);
let end = src.indexOf("`", i);
console.log("CSS 起点:", start, " 终点:", end, " 长度:", end-start);
const css = src.slice(start+1, end);
fs.writeFileSync("%TEMP%/pl-css.css".replace("%TEMP%", process.env.TEMP), css, "utf8");
console.log("已导出 CSS 长度:", css.length);
// 列出所有涉及 range / input 的规则，自查冲突
const rules = css.split("}").map(r=>r.trim()).filter(r=>/range|__num|__switch/.test(r));
for(const r of rules) console.log("  · "+r.replace(/\s+/g," ").slice(0,160));
