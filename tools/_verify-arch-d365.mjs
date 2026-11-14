// 严谨校验三件事（D362 事故后的规矩：newActive 必须逐字来自磁盘产物）
import fs from "node:fs";

const orig = fs.readFileSync("10.项目台账-ledger-memory/LEDGER.md", "utf8").split("\n");
const neo = fs.readFileSync("_arch-d365-newactive.md", "utf8").split("\n");
const entries = fs.readFileSync("_arch-d365-entries.md", "utf8");

// ① 新台账每一行都必须在原文里、且顺序与原文一致（子序列检验）
let j = 0;
const missing = [];
for (const line of neo) {
  let found = -1;
  for (let k = j; k < orig.length; k += 1) {
    if (orig[k] === line) {
      found = k;
      break;
    }
  }
  if (found < 0) missing.push(line);
  else j = found + 1;
}
console.log(`① 新台账是原文的子序列？ ${missing.length === 0}（缺 ${missing.length} 行）`);
if (missing.length > 0) missing.slice(0, 5).forEach((l) => console.log("   缺:", JSON.stringify(l.slice(0, 70))));

// ② 行数守恒：原 = 新 + 被删
const deleted = orig.length - neo.length;
console.log(`② 原 ${orig.length} · 新 ${neo.length} · 减 ${deleted} 行`);

// ③ 被删的每一行都必须出现在 entries 里（逐字）
const delLines = [];
{
  let a = 0;
  for (const line of orig) {
    if (a < neo.length && neo[a] === line) {
      a += 1;
    } else {
      delLines.push(line);
    }
  }
}
console.log(`③ 逐行比对得出被删 ${delLines.length} 行（应等于 ${deleted}）`);
const notInEntries = delLines.filter((l) => l.trim() !== "" && !entries.includes(l));
console.log(`③ 被删的行里，未在 entries 中找到的：${notInEntries.length} 行`);
notInEntries.slice(0, 5).forEach((l) => console.log("   !", JSON.stringify(l.slice(0, 70))));

// ④ 结论
const pass = missing.length === 0 && delLines.length === deleted && notInEntries.length === 0;
console.log(`\n${pass ? "PREP-OK" : "PREP-FAIL"}  —— ${pass ? "可以安全归档" : "不要调 ledger_archive"}`);
