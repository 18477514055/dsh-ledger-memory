import fs from "node:fs";
const src = fs.readFileSync("lib/client.js","utf8");
const lines = src.split("\n");
let inCss = false;
for (let i=0;i<lines.length;i++){
  if (lines[i].includes("const CSS = `")) { inCss = true; console.log(`CSS 起始行 ${i+1}`); continue; }
  if (inCss) {
    // 找到结束反引号
    if (/^\s*`;?\s*$/.test(lines[i])) { console.log(`CSS 结束行 ${i+1}`); break; }
    if (lines[i].includes("`")) console.log(`  ⚠ 行 ${i+1} 含反引号: ${lines[i].trim().slice(0,90)}`);
  }
}
