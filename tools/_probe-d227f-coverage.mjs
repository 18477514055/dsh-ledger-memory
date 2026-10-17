// D227⑥ · 覆盖度核查（只读）：每个工具/子命令，**自检里真的调用过吗**？
// ★ 这是回答用户「很大一部分甚至不能实现正常的功能」的**最硬的角度**：
//   「声称有实现」≠「真的跑通过」。自检里调过 = 至少被真实执行过一次（且断言过结果）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const self = fs.readFileSync(path.join(ROOT, "tools", "selftest.mjs"), "utf8");

const TOOLS = ["ledger_status","ledger_init","ledger_read","ledger_write","ledger_archive","ledger_log",
  "ledger_recall","ledger_log_write","ledger_note","ledger_handoff","ledger_triage","ledger_lock",
  "ledger_conform","ledger_migrate","ledger_index","ledger_propose_principle","ledger_principles_access",
  "ledger_goals","ledger_lessons","ledger_compact","ledger_checkpoint"];

console.log("工具".padEnd(26) + "自检里出现次数（= 至少被真实调过）");
console.log("-".repeat(66));
const zero = [];
for (const t of TOOLS) {
  const c = (self.match(new RegExp(`\\b${t}\\b`, "g")) ?? []).length;
  if (c === 0) zero.push(t);
  console.log(t.padEnd(26) + (c === 0 ? "❌ 0 —— 自检从没碰过它" : `${c} 次`));
}
console.log(`\n★ 自检**从未碰过**的工具（${zero.length}）：${zero.join(" · ") || "（无）"}`);

console.log("\n\n子命令".padEnd(20) + "自检里出现次数");
console.log("-".repeat(66));
for (const s of ["status","show","init","update","archive","compact","light","log","principles","mode","lock","handoff"]) {
  const c = (self.match(new RegExp(`"${s}"`, "g")) ?? []).length;
  console.log(`/ledger ${s}`.padEnd(20) + `${c} 次`);
}

console.log("\n\n卡片选项组".padEnd(26) + "自检里出现次数");
console.log("-".repeat(66));
for (const g of ["CHECKPOINT_OPTIONS","FIRST_TURN_OPTIONS","CONFORM_OPTIONS","offerTurnEndChoice","offerConformChoice","offerProjectChoice","pickLedgerSub"]) {
  const c = (self.match(new RegExp(`\\b${g}\\b`, "g")) ?? []).length;
  console.log(g.padEnd(26) + (c === 0 ? "❌ 0 —— 从没被自检走过" : `${c} 次`));
}

// 弹卡后的"选项被选中"路径：自检有没有真的模拟过用户点选
console.log("\n\n【模拟用户点选的证据】");
const picks = (self.match(/selected:\s*\[/g) ?? []).length;
console.log(`  自检里造「用户点了某一项」的夹具：${picks} 处`);
const askMocks = (self.match(/userQuestions/g) ?? []).length;
console.log(`  自检里出现 userQuestions 的位置：${askMocks} 处`);
