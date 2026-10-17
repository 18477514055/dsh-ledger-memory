// D227② · 对账（只读）：① 每个工具/子命令在活动日志里出现过没有；② 找功能重复。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const lib = (f) => fs.readFileSync(path.join(ROOT, "lib", f), "utf8");

const TOOLS = ["ledger_status","ledger_init","ledger_read","ledger_write","ledger_archive","ledger_log",
  "ledger_recall","ledger_log_write","ledger_note","ledger_handoff","ledger_triage","ledger_lock",
  "ledger_conform","ledger_migrate","ledger_index","ledger_propose_principle","ledger_principles_access",
  "ledger_goals","ledger_lessons","ledger_compact","ledger_checkpoint"];
const SUBS = ["status","show","init","update","archive","compact","light","log","principles","mode","lock","handoff"];

// 读所有日志
const logDir = path.join(ROOT, "_ledger-log");
let logText = "";
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else logText += fs.readFileSync(p, "utf8");
  }
};
walk(logDir);

console.log("【工具 · 活动日志出现次数】（0 = 从未在任何日志里被记录过）");
const zero = [];
for (const t of TOOLS) {
  const c = (logText.match(new RegExp(`\\b${t}\\b`, "g")) ?? []).length;
  // 子命令形式也算（/ledger <sub>）
  if (c === 0) zero.push(t);
  console.log(`  ${String(c).padStart(4)}  ${t}`);
}
console.log(`\n  ★ 日志里 0 次的工具（共 ${zero.length}）：${zero.join(" · ") || "（无）"}`);

console.log("\n【子命令 · 活动日志出现次数】");
for (const s of SUBS) {
  const c = (logText.match(new RegExp(`/ledger ${s}\\b`, "g")) ?? []).length;
  console.log(`  ${String(c).padStart(4)}  /ledger ${s}`);
}

// 找功能重复：工具名与子命令名的对应
console.log("\n【工具 ↔ 子命令：名字/职责重叠】");
const pairs = [
  ["ledger_status", "status"], ["ledger_read", "show"], ["ledger_init", "init"],
  ["ledger_write", "update"], ["ledger_archive", "archive"], ["ledger_compact", "compact"],
  ["ledger_log", "log"], ["ledger_lock", "lock"], ["ledger_handoff", "handoff"],
];
for (const [t, s] of pairs) console.log(`  ${t.padEnd(24)} ↔  /ledger ${s}`);

// 描述文本（看它到底声称做什么）
console.log("\n【各工具 description 首句】（判断它到底解决什么问题）");
{
  const idx = lib("index.js");
  for (const t of TOOLS) {
    // 在 lib/ 里找 name: "<tool>" 附近的 description
    let d = "";
    for (const f of fs.readdirSync(path.join(ROOT, "lib")).filter((x) => x.endsWith(".js"))) {
      const src = lib(f);
      const re = new RegExp(`name:\\s*(?:"${t}"|[A-Z_]+)[\\s\\S]{0,900}?description:\\s*\\n?\\s*"([^"]{10,200})`);
      const m = src.match(re);
      if (m !== null) { d = m[1]; break; }
    }
    console.log(`  ${t.padEnd(24)} ${d === "" ? "(没抓到，需人工看)" : d.slice(0, 96)}`);
  }
}
