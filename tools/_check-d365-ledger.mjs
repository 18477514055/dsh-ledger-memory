import fs from "node:fs";
const s = fs.readFileSync("10.项目台账-ledger-memory/LEDGER.md", "utf8");
const checks = {
  // ★ 367 = 恢复后的 366 + 新增的 1 行 D365 索引行（两条定点补齐各 +1/−1、+1）
  "行数 367": s.split("\n").length === 367,
  "上限内（< 400）": s.split("\n").length < 400,
  "发布版本 1.6.2": s.includes("发布（现行 · **1.6.2**）"),
  "版本线含 1.6.2": s.includes("**1.6.1** → **1.6.2**"),
  "D365 索引行": s.includes("| **D365** |"),
  "表头 D1–D365": s.includes("D1–**D365**"),
  "下一份 020": s.includes("下一份是 `020`"),
  "D363 已归档（不应在）": !s.includes("D363 调研：用户手写"),
  "D364 正文仍在": s.includes("D364 用户拍板后落地"),
  "变更登记在": s.includes("## 变更登记"),
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "OK  " : "FAIL"}  ${k}`);
const allOk = Object.values(checks).every(Boolean);
console.log(allOk ? "\nLEDGER-STATE-OK" : "\nLEDGER-STATE-BAD");
process.exit(allOk ? 0 : 1);
