import fs from "node:fs"; import crypto from "node:crypto";
const P = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账\\10.项目台账-ledger-memory\\LEDGER.md";
const A = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账\\10.项目台账-ledger-memory\\_ledger-archive\\2026-10\\week3\\2026-10-21-台账§-外发任务单两阶段（正文在D299与外发交付说明）.md";
const lines = fs.readFileSync(P,"utf8").split("\n");
// 18:5x(288) + 19:3x(315) 连续 = 288..341
const a0=288, a1=341;
const entries = lines.slice(a0-1, a1).join("\n");
const newActive = [...lines.slice(0,a0-1), ...lines.slice(a1)].join("\n");
fs.writeFileSync("D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账\\tools\\_tmp-entries-b11.txt", entries, "utf8");
fs.writeFileSync("D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账\\tools\\_tmp-newactive-b11.md", newActive, "utf8");
if(fs.existsSync(A)){ console.log("⚠ 归档已存在"); process.exit(1); }
fs.writeFileSync(A, "# 归档：外发任务单（两阶段，2026-10-21）\n\n> 正文与交付说明在 `decisions/D299.md` 与 `docs/外发交付-扩展记忆面板-20261021/`。\n> 本文件为**逐字搬运**，未改写。\n\n" + entries + "\n", "utf8");
console.log("entries 行数:", entries.split("\n").length, " newActive 行数:", newActive.split("\n").length);
console.log("首行:", JSON.stringify(lines[a0-1].slice(0,50)));
console.log("末行:", JSON.stringify(lines[a1-1].slice(0,50)));
console.log("下一行(342):", JSON.stringify(lines[a1].slice(0,50)));
// 守卫：newActive 是原文有序子序列
const nw = newActive.split("\n"); let j=0;
for(const l of nw){ while(j<lines.length && lines[j]!==l) j++; if(j>=lines.length){ console.log("✗ 守卫失败:", l.slice(0,50)); process.exit(1); } j++; }
console.log("✓ newActive 是原文有序子序列");
console.log("✓ 归档逐字包含切片:", fs.readFileSync(A,"utf8").includes(entries));
