/**
 * ★★★ 只读：按**用户的标准**判定压缩成败。
 *
 * 用户原话（逐字，2026-10-24）：
 *   "我说的压缩失败是指那种在工作过程中主动压缩，然后继续工作，不需要任何人工操作，
 *    但是目前的所有的压缩全部都是模型主动停止工作。然后压缩，然后我手动发送，继续工作。"
 *
 * ⇒ 成败判据（三条，缺一即"失败"）：
 *   ① 是不是**工作过程中**触发（turn 是数字 = 回合内；null = 回合末/已停下）
 *   ② 有没有**产出**（有 compaction/summary）
 *   ③ 压完之后**有没有人工干预**才继续（在 compaction/end 之后、下一条 assistant 之前，
 *      有没有出现 source.kind === "user" 的真用户消息）
 *
 * ★ 尺子纪律：
 *   · "人工干预"只认 source.kind === "user"（注入类消息不算）
 *   · 判"自己继续"看 compaction/end 之后第一个 assistant/message 之前有无真用户消息
 *   · 每一条都报分母，不单报一个比例
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
const ends = evs.filter((e) => e.type === "compaction/end");
const sums = evs.filter((e) => e.type === "compaction/summary");
const sumIds = new Set(sums.map((e) => e.data?.compactionId));
const realUser = evs.filter((e) => e.type === "user/message" && e.data?.source?.kind === "user");
const asst = evs.filter((e) => e.type === "assistant/message");

console.log("═══ 按用户标准的压缩成败判定 ═══");
console.log("（① 触发时机  ② 有无产出  ③ 之后要不要人发话）\n");
console.log("时间              ①触发                  ②产出  ③压后人要发话?  判定");
console.log("─".repeat(100));

const stat = { inTurn: 0, turnEnd: 0, withSummary: 0, noSummary: 0, needHuman: 0, autoContinue: 0, fullPass: 0 };

for (const s of starts) {
  const id = s.data?.compactionId;
  const turn = s.data?.turn;
  const inTurn = typeof turn === "number";
  const hasSum = sumIds.has(id);
  const end = ends.find((e) => e.data?.compactionId === id);
  const anchor = end ? end.time : s.time;

  // 压后：下一个 assistant 之前有无真用户消息
  const nextAsst = asst.find((e) => e.time > anchor);
  const nextUser = realUser.find((e) => e.time > anchor);
  let needHuman = null;
  if (nextAsst) needHuman = !!nextUser && nextUser.time < nextAsst.time;
  else if (nextUser) needHuman = true;

  if (inTurn) stat.inTurn += 1; else stat.turnEnd += 1;
  if (hasSum) stat.withSummary += 1; else stat.noSummary += 1;
  if (needHuman === true) stat.needHuman += 1;
  if (needHuman === false) stat.autoContinue += 1;

  const pass = inTurn && hasSum && needHuman === false;
  if (pass) stat.fullPass += 1;

  console.log(
    `${fmt(s.time)}  ${(inTurn ? `回合内(turn=${turn})` : "★回合末(已停)").padEnd(20)}  ${(hasSum ? "有" : "★无").padEnd(5)}  ${(needHuman === null ? "?" : needHuman ? "★要（人发话）" : "不要（自己继续）").padEnd(16)}  ${pass ? "通过" : "★失败"}`
  );
}

console.log("\n═══ 汇总（分母 = 47 次 compaction/start）═══");
console.log(`  ① 触发时机：回合内（工作过程中）= ${stat.inTurn} · 回合末（已停下再压）= ${stat.turnEnd}`);
console.log(`  ② 有无产出：有 summary = ${stat.withSummary} · 无 summary = ${stat.noSummary}`);
console.log(`  ③ 压后：需要人发话 = ${stat.needHuman} · 自己继续 = ${stat.autoContinue}`);
console.log(`  ★ 三条全满足（真正"工作过程中压缩 + 压完自己继续"）= ${stat.fullPass} / ${starts.length}`);

// ── 对照：如果只看"压缩有没有执行"，会得出什么结论
console.log("\n═══ 对照：换个尺子会得出完全不同的结论 ═══");
console.log(`  「压缩发生了没有」：${starts.length} 次 start，${stat.withSummary} 次有摘要 ⇒ 成功率 ${(stat.withSummary / starts.length * 100).toFixed(1)}%`);
console.log(`  「压缩有没有达到目的」：${stat.fullPass} / ${starts.length} = ${(stat.fullPass / starts.length * 100).toFixed(1)}%`);
console.log(`  ⇒ ★ 同一个系统，换个尺子从 83% 变成 ${(stat.fullPass / starts.length * 100).toFixed(0)}%。`);

// ── 空闲旁路：回合末压缩之后，用户下次发话隔了多久
console.log("\n═══ 回合末压缩之后等了多久才有人发话（间隔越长越说明是被动等）═══");
const turnEndComp = starts.filter((s) => s.data?.turn === null);
const waits = [];
for (const s of turnEndComp) {
  const u = realUser.find((e) => e.time > s.time);
  if (u) waits.push((u.time - s.time) / 60000);
}
if (waits.length) {
  const sorted = [...waits].sort((a, b) => a - b);
  console.log(`  样本 ${waits.length} 次 · 中位 ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} 分钟 · 均值 ${(waits.reduce((a, b) => a + b, 0) / waits.length).toFixed(1)} 分钟`);
  console.log(`  最短 ${sorted[0].toFixed(1)} 分钟 · 最长 ${sorted[sorted.length - 1].toFixed(1)} 分钟`);
}
