/**
 * ★★★ 关键辨伪：那 9 次「回合内压缩」，**到底是我们的代码做的，还是官方做的？**
 *
 * 判据：`part5.js` 会在压缩前 `pushHfSource(state, key, source)` 记一张"来源票"，
 *       值域含 `auto:midturn` / `auto:delta` / `manual` / `command`。
 *       若某次回合内压缩对应的是官方（`dsh-compaction-basic` 的 pre-step），
 *       我们就**没有**为它 pushHfSource ⇒ 两者能分开。
 *
 * ★ 可测代理指标（会话日志里唯一能看到的痕迹）：
 *   我们自己的 midturn 路径会先跑义务、再压 ⇒ 压缩 start 之前**必有** `ledger_write` + `ledger_triage`
 *   的 tool/call；而官方 pre-step 压缩**不会有**这个前置。
 *   另外：官方 pre-step 压缩的 turn 会等于当前 step 所属 turn；
 *   我们想确认的是「有没有一条独立的、不依赖 ours 的回合内压缩」。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const starts = []; let i = buf.indexOf(MAGIC);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  starts.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < starts.length; k += 1) {
    try { const d = zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1])); if (d.length) out.push(d); } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};
const fmt = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });

const SESS = path.join(os.homedir(), ".dsh", "sessions",
  "--D-Deepseek~5DE5~4F5C~533A-20-DSH~63D2~4EF6-04-~5176~4F59~63D2~4EF6-10.~9879~76EE~53F0~8D26--",
  "session-a5dd1f8f-8f7a-4590-9ede-34f72354dad8", "session.v4.jsonl.zstd");
const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}

const starts = evs.filter((e) => e.type === "compaction/start");
const inTurn = starts.filter((e) => typeof e.data?.turn === "number");

console.log("═══ 9 次回合内压缩：压前 60 秒内有没有 ledger_write / ledger_triage ═══");
console.log("（有 ⇒ 高度可能是我们的 auto:midturn 路径；没有 ⇒ 多半是官方 pre-step）\n");

for (const s of inTurn) {
  const win = evs.filter((e) => e.time >= s.time - 60000 && e.time < s.time && e.type === "tool/call");
  const names = win.map((e) => e.data?.name).filter(Boolean);
  const hasWrite = names.includes("ledger_write") || names.includes("ledger_archive");
  const hasTriage = names.includes("ledger_triage");
  const ledgerCalls = names.filter((n) => n.startsWith("ledger_"));
  const nonLedger = names.filter((n) => !n.startsWith("ledger_"));
  console.log(`${fmt(s.time)}  turn=${s.data.turn}`);
  console.log(`   前 60s tool/call = ${names.length} 次；ledger_write/archive=${hasWrite}  ledger_triage=${hasTriage}`);
  console.log(`   ledger_* 调用: ${ledgerCalls.join(", ") || "无"}`);
  console.log(`   非 ledger 调用: ${nonLedger.slice(-6).join(", ") || "无"}`);
  console.log(`   ⇒ 归因: ${hasWrite && hasTriage ? "★ 很像我们的 auto:midturn（先义务后压）" : "更可能是官方 pre-step（无义务前置）"}`);
  console.log("");
}

// ── 反向：回合末压缩里，有没有也带义务前置的？
console.log("═══ 对照：回合末压缩（turn=null）里有义务前置的比例 ═══");
const turnEnd = starts.filter((e) => e.data?.turn === null);
let we = 0;
for (const s of turnEnd) {
  const win = evs.filter((e) => e.time >= s.time - 60000 && e.time < s.time && e.type === "tool/call");
  const n = win.map((e) => e.data?.name).filter(Boolean);
  if (n.includes("ledger_write") && n.includes("ledger_triage")) we += 1;
}
console.log(`  回合末压缩 ${turnEnd.length} 次，其中压前 60s 有 write+triage 的 = ${we}`);

// ── 诊断日志写的 turn 全是 0 —— 说明 deps.turn 传的是 0，不是真 turn
console.log("\n═══ 诊断日志 turn 字段核查 ═══");
const logf = path.join("D:/Deepseek工作区/20-DSH插件/04-其余插件/10.项目台账/10.项目台账-ledger-memory/.dsh-ledger-midturn.log");
if (fs.existsSync(logf)) {
  const rows = fs.readFileSync(logf, "utf8").split(/\r?\n/).filter(Boolean);
  const turnVals = new Set(rows.map((l) => (l.match(/turn=(\S+)/) || [])[1]).filter(Boolean));
  console.log(`  日志里出现过的 turn 值: ${[...turnVals].join(", ")}  （全 0 ⇒ deps.turn 没拿到真值）`);
}
