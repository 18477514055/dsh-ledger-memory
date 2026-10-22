import fs from "node:fs";
const P="lib/client.js";
let s=fs.readFileSync(P,"utf8");
const before=s;
// 1) 基础 --pl-num-w: 104px → 72px
s=s.replace("  --pl-num-w: 104px;", "  --pl-num-w: 72px;");
// 2) 容器查询里两档同步收窄 + 同步 --pl-ctl-w
s=s.replace(".pl-settings__ctl-wrap--num { --pl-num-w: 80px; }",
            ".pl-settings__ctl-wrap--num { --pl-num-w: 64px; }\n  .pl-settings__row:not(.pl-settings__row--stack) { --pl-ctl-w: 158px; }");
s=s.replace(".pl-settings__ctl-wrap--num { --pl-num-w: 68px; }",
            ".pl-settings__ctl-wrap--num { --pl-num-w: 56px; }\n  .pl-settings__row:not(.pl-settings__row--stack) { --pl-ctl-w: 140px; }");
// 3) 兜底宽度也同步
s=s.replace("width: var(--pl-num-w, 104px);", "width: var(--pl-num-w, 72px);");
fs.writeFileSync(P,s,"utf8");
console.log("改动:", before===s? "无（未命中）":"已改");
for(const l of s.split("\n")) if(/--pl-num-w|--pl-ctl-w/.test(l) && !l.trim().startsWith("*") && !l.includes("注释")) console.log("  "+l.trim().slice(0,110));
