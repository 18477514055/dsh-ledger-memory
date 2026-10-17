// D227④ · 累赘分析（只读）：必填参数 + 描述首句 + 是否与别的工具重叠。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const files = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js"));
const TOOLS = ["ledger_status","ledger_init","ledger_read","ledger_write","ledger_archive","ledger_log",
  "ledger_recall","ledger_log_write","ledger_note","ledger_handoff","ledger_triage","ledger_lock",
  "ledger_conform","ledger_migrate","ledger_index","ledger_propose_principle","ledger_principles_access",
  "ledger_goals","ledger_lessons","ledger_compact","ledger_checkpoint"];

// 按 `name: "<tool>"` / `name: CONST` 切段（每段到下一个 name: 为止）
const segOf = {};
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
  const marks = [...src.matchAll(/\bname:\s*("([a-z_]+)"|([A-Z_]+))/g)];
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    const nm = marks[i][2] ?? marks[i][3];
    if (nm !== undefined && segOf[nm] === undefined) segOf[nm] = { file: f, text: src.slice(start, end) };
  }
}
// 常量名 → 真名
segOf["ledger_principles_access"] = segOf["PRINCIPLE_GRANT_TOOL"] ?? { file: "?", text: "" };
segOf["ledger_checkpoint"] = segOf["CHECKPOINT_TOOL"] ?? { file: "?", text: "" };

console.log("工具".padEnd(26) + "文件".padEnd(10) + "必填参数");
console.log("-".repeat(76));
for (const t of TOOLS) {
  const s = segOf[t];
  if (s === undefined) { console.log(t.padEnd(26) + "⚠️ 未定位"); continue; }
  const req = s.text.match(/required:\s*\[([^\]]*)\]/);
  const reqTxt = req === null ? "(无 required 段)" : req[1].replace(/\s+/g, " ").trim();
  console.log(t.padEnd(26) + s.file.padEnd(10) + `[${reqTxt}]`);
}

console.log("\n\n【疑似职责重叠 / 可合并的候选】");
const notes = [
  ["ledger_status vs ledger_conform vs ledger_migrate",
   "三者都回答「这个项目的台账现在是什么状态 / 合不合规 / 要不要迁移」。",
   "★ conform 在活动日志里出现 **0 次**（21 个工具里唯一 0 次的）。"],
  ["/ledger status  vs  ledger_status", "同一件事的命令面与工具面。"],
  ["/ledger show    vs  ledger_read({target:'active'})", "同上。"],
  ["/ledger log     vs  ledger_log", "同上（命令面 0 次被用过）。"],
  ["/ledger handoff vs  ledger_handoff", "同上（命令面 0 次）。"],
  ["/ledger archive vs  ledger_archive", "同上（命令面 0 次）。"],
  ["/ledger init    vs  ledger_init", "同上（命令面 0 次）。"],
  ["/ledger mode", "设置项 mode 已在面板里；且命令自己就说「选什么都没区别」。"],
  ["ledger_compact vs /ledger compact vs ledger_checkpoint 的「记录+压缩」项",
   "三条路都能触发压缩，语义重叠。"],
  ["第一轮卡片（FIRST_TURN_OPTIONS 4 项）vs 回合末卡片（CHECKPOINT_OPTIONS 4 项）",
   "两张卡都有「不记 / 只记 / 记+压缩 / 记+交接」形状的选项，用户难分辨。"],
];
for (const [a, b, c] of notes) {
  console.log(`\n  ▸ ${a}`);
  console.log(`      ${b}`);
  console.log(`      ${c}`);
}
