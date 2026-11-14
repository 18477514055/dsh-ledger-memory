import fs from "node:fs";

const line = fs.readFileSync("lib/part1.js", "utf8").split("\n")[7];
console.log("行首:", JSON.stringify(line.slice(0, 60)));
console.log("行尾:", JSON.stringify(line.slice(-70)));
console.log("长度:", line.length);

// 复刻 fix-imports.mjs 里那条单行正则
const m = /^import\s+(.+?)\s+from\s+"([^"]+)";?\s*$/.exec(line);
console.log("单行正则:", m ? "YES from=" + m[2] : "NO");

// 多行正则（脚本里 `^import\s*\{` 分支）
const m2 = /^import\s*\{/.test(line);
console.log("是否走多行分支:", m2);

// 关键：protocolGapOf 在不在这行里
console.log("含 protocolGapOf:", line.includes("protocolGapOf"));
