import fs from "node:fs";
const P="lib/client.js";
let s=fs.readFileSync(P,"utf8");
// 列宽按「滑块 + 8 + 数字框 + 4 + 单位(2.6em@13px≈34)」重算
s=s.replace("--pl-ctl-w: 178px;", "--pl-ctl-w: 192px;");
s=s.replace("{ --pl-num-w: 64px; }\n  .pl-settings__row:not(.pl-settings__row--stack) { --pl-ctl-w: 158px; }",
            "{ --pl-num-w: 64px; }\n  .pl-settings__row:not(.pl-settings__row--stack) { --pl-ctl-w: 176px; }");
s=s.replace("{ --pl-num-w: 56px; }\n  .pl-settings__row:not(.pl-settings__row--stack) { --pl-ctl-w: 140px; }",
            "{ --pl-num-w: 56px; }\n  .pl-settings__row:not(.pl-settings__row--stack) { --pl-ctl-w: 160px; }");
fs.writeFileSync(P,s,"utf8");
console.log("列宽:", s.match(/--pl-ctl-w: \d+px/g));
