import fs from "node:fs";
const P = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账\\10.项目台账-ledger-memory\\LEDGER.md";
const lines = fs.readFileSync(P,"utf8").split("\n");
console.log("总行数:", lines.length);
for(let i=0;i<lines.length;i++){ if(/^- \[[0-9a-z]{4}\] /.test(lines[i])) console.log(`  line ${i+1}: ${lines[i].slice(0,80)}`); }
