import fs from "node:fs";

function usedIdentifiers(code) {
  const noBlock = code.replace(/\/\*[\s\S]*?\*\//g, " ");
  const noLine = noBlock.replace(/^\s*\/\/.*$/gm, " ");
  const noStr = noLine
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  const set = new Set();
  for (const m of noStr.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) set.add(m[1]);
  return set;
}

const outText = fs.readFileSync("lib/part1-store.js", "utf8");
const used = usedIdentifiers(outText);
console.log("used 里含 protocolGapOf:", used.has("protocolGapOf"));

// 找源码里它出现的位置
const lines = outText.split("\n");
lines.forEach((l, i) => {
  if (l.includes("protocolGapOf")) console.log(`  ${i + 1}: ${l.trim().slice(0, 90)}`);
});

// 检查剥离后还剩没剩
const noBlock = outText.replace(/\/\*[\s\S]*?\*\//g, " ");
const noLine = noBlock.replace(/^\s*\/\/.*$/gm, " ");
console.log("剥离注释后仍含 protocolGapOf:", noLine.includes("protocolGapOf"));
const noStr = noLine.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, "``");
console.log("剥离字符串后仍含 protocolGapOf:", noStr.includes("protocolGapOf"));
