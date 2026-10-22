// 定位 part2.js 里导致 strip() 失控的那一处（未配对的 /* 或反引号）。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const p2 = fs.readFileSync(path.join(ROOT, "lib", "part2.js"), "utf8");

// 逐个扫：先看 /* 与 */ 的数量是否配对
const open = (p2.match(/\/\*/g) ?? []).length;
const close = (p2.match(/\*\//g) ?? []).length;
console.log(`/* = ${open}  */ = ${close}  ${open === close ? "配对" : "**不配对**"}`);

// 再看反引号数量（模板字符串也会吞）
const ticks = (p2.match(/`/g) ?? []).length;
console.log(`反引号 = ${ticks}  ${ticks % 2 === 0 ? "偶数（可能配对）" : "**奇数（有未闭合）**"}`);

// 用「逐行累计深度」定位失控点：模拟 strip 的块注释扫描
const lines = p2.split("\n");
let inBlock = false;
let blockStart = -1;
const report = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  let j = 0;
  while (j < l.length) {
    if (!inBlock && l[j] === "/" && l[j + 1] === "*") {
      inBlock = true;
      blockStart = i + 1;
      j += 2;
      continue;
    }
    if (inBlock && l[j] === "*" && l[j + 1] === "/") {
      inBlock = false;
      const span = i + 1 - blockStart + 1;
      if (span > 40) report.push({ start: blockStart, end: i + 1, span });
      j += 2;
      continue;
    }
    j += 1;
  }
}
console.log(`\n扫描结束时 inBlock = ${inBlock}（true 表示有未闭合块注释，从第 ${blockStart} 行开始）`);
if (report.length) {
  console.log("\n超过 40 行的块注释（可疑）：");
  for (const r of report) console.log(`  L${r.start} → L${r.end}（${r.span} 行）`);
}
