// 验锚点规则：两个已知必须受保护的行 + 抽样检查误保护率
import fs from "node:fs";
import { loadCheckerText, isAnchorLine } from "./anchor-rule.mjs";

const rootDir = process.cwd();
const checkerText = loadCheckerText(rootDir);

const cases = [
  { file: "_tmp-d368-backup/part4.js", key: "完整预检区", mustProtect: true },
  { file: "_tmp-d368-backup/part4.js", key: "预检区结束", mustProtect: true },
];

let allOk = true;
for (const c of cases) {
  const lines = fs.readFileSync(c.file, "utf8").split("\n");
  const li = lines.findIndex((l) => l.includes(c.key));
  if (li < 0) { console.log("❌ 找不到", c.key); allOk = false; continue; }
  const hit = isAnchorLine(lines[li], checkerText);
  const ok = hit === c.mustProtect;
  if (!ok) allOk = false;
  console.log(`${ok ? "✅" : "❌"} 「${c.key}」⇒ isAnchor=${hit}（期望 ${c.mustProtect}）`);
  if (!ok) console.log("    行:", JSON.stringify(lines[li].trim().slice(0, 90)));
}

// 误保护率：普通说明性注释不该被判成锚点
const sampleFiles = ["_tmp-d368-backup/part4.js", "_tmp-d368-backup/index.js", "_tmp-d368-backup/part3.js"];
let total = 0;
let anchored = 0;
for (const f of sampleFiles) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  for (const l of lines) {
    const t = l.trim();
    if (!t.startsWith("//")) continue;
    if (t.length < 16) continue;
    total += 1;
    if (isAnchorLine(l, checkerText)) anchored += 1;
  }
}
console.log(`\n抽样 ${total} 条注释行，判为锚点 ${anchored} 条（${((anchored / total) * 100).toFixed(1)}%）`);
console.log(allOk ? "ANCHOR-RULE-OK" : "ANCHOR-RULE-FAILED");
