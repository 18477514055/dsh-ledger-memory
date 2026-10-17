// D227⑦ · 卡片覆盖度（正确口径）：自检里**模拟过的卡片 id 与选项文本**各是哪些。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const self = fs.readFileSync(path.join(ROOT, "tools", "selftest.mjs"), "utf8");
const defs = fs.readFileSync(path.join(ROOT, "lib", "defs.js"), "utf8");
const p3 = fs.readFileSync(path.join(ROOT, "lib", "part3.js"), "utf8");
const p5 = fs.readFileSync(path.join(ROOT, "lib", "part5.js"), "utf8");
const all = [defs, p3, p5].join("\n");

// ① 代码里定义了哪些卡片（按 id）
const codeIds = [...new Set([...all.matchAll(/id:\s*"(ledger-[a-z-]+)"/g)].map((m) => m[1]))];
// ② 自检里模拟了哪些卡片（按 id）
const selfIds = [...new Set([...self.matchAll(/id:\s*"(ledger-[a-z-]+)"/g)].map((m) => m[1]))];

console.log("【代码里定义的卡片 id】", codeIds.join(" · "));
console.log("【自检里模拟过的卡片 id】", selfIds.join(" · "));
const never = codeIds.filter((x) => !selfIds.includes(x));
console.log(`\n★ 定义了但**自检从没模拟过**的卡片：${never.length === 0 ? "（无）" : never.join(" · ")}`);

// ③ 按"选项文本"看覆盖（常量名在自检里不会出现，选项文本才会）
console.log("\n【各卡片：选项文本在自检里出现过没有】");
for (const g of ["CHECKPOINT_OPTIONS", "FIRST_TURN_OPTIONS", "CONFORM_OPTIONS"]) {
  const m = defs.match(new RegExp(`export const ${g} = \\[([\\s\\S]*?)\\n\\];`));
  const labels = m === null ? [] : [...m[1].matchAll(/label:\s*"([^"]+)"/g)].map((x) => x[1]);
  console.log(`\n  ${g}：`);
  for (const l of labels) {
    const n = (self.match(new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    console.log(`    ${n > 0 ? "✅" : "❌"}  ${l}${n > 0 ? `（自检 ${n} 次）` : "（自检里从没出现过！）"}`);
  }
}
// ④ 授权卡片（选项在 part2，不是常量）
console.log("\n  ledger_principles_access 的选项：");
for (const l of ["授权（本次可改）", "不授权"]) {
  const n = (self.match(new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
  console.log(`    ${n > 0 ? "✅" : "❌"}  ${l}${n > 0 ? `（自检 ${n} 次）` : "（自检里从没出现过！）"}`);
}
// ⑤ /ledger 裸敲选择卡
console.log("\n  裸敲 /ledger 的子命令选择卡：");
for (const l of ["显示活跃台账", "初始化台账", "归档旧条目", "手动全量压缩（高保真）"]) {
  const n = (self.match(new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
  console.log(`    ${n > 0 ? "✅" : "❌"}  ${l}${n > 0 ? `（自检 ${n} 次）` : "（自检里从没出现过！）"}`);
}
