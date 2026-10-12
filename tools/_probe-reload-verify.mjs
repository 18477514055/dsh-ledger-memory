/**
 * ★★★ 只读：验证**重启后活内核加载的是不是新代码**。
 *
 * 判据（按硬度排序，本次恰有一个**完美的文本判据**）：
 *   ① ★★★ 我这次新加了一句注入框定：`[插件注入 · 不是用户发言]`
 *      —— 它**只存在于新代码**里 ⇒ 只要重启后的注入里有它，就是新代码。
 *   ② 结构性：`ledger_recall` 在工具表里（D81 的旧证据，用来确认基线）。
 *   ③ 时间线：找出"最后一次写台账"与"重启"的先后。
 *
 * ★ 为什么要先做这个：内核只在**重启时**加载插件代码。
 *   不验证就往下走 ⇒ 我可能对着**跑旧代码**的运行时讨论新行为（那种误判本项目栽过）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const s = []; let i = buf.indexOf(MAGIC);
  while (i !== -1) { s.push(i); i = buf.indexOf(MAGIC, i + 4); }
  s.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < s.length; k += 1) {
    try { const d = zlib.zstdDecompressSync(buf.subarray(s[k], s[k + 1])); if (d.length) out.push(d); } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};
const SID = "session-fada6e5f-52f2-4a4f-b52a-3c2483db117e";
const SESS = path.join(os.homedir(), ".dsh", "sessions", "--D-Deepseek~5DE5~4F5C~533A--", SID, "session.v4.jsonl.zstd");
const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
evs.sort((a, b) => a.seq - b.seq);
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);

const textOf = (d) => {
  const c = d?.content ?? d?.message?.content;
  if (Array.isArray(c)) return c.map((x) => x?.text ?? "").join("");
  return typeof c === "string" ? c : "";
};

console.log("═".repeat(92));
console.log("① ★★★ 最后 8 条「我们的注入」（找那句只存在于新代码里的框定）");
console.log("═".repeat(92));
// ★★★ 尺子修正（第一版**错了**，这是本项目「尺子错」第 2 条的又一实例）：
//   第一版用 `t.includes("[插件注入 · 不是用户发言]")` 在**整段注入**上匹配 ——
//   可注入 = 插件的包装段 + **被追加的整份台账正文**，而**我把那句话写进了台账正文**
//   （在 DECISIONS D96 与台账里引用它）⇒ 判据**从那一刻起恒为真**，
//   于是"23:06 之后全是 ★有"看着像"新代码生效了"，其实只是**台账里有这个词**。
//   ⇒ 正确判据：新代码是把框定**放在回执的最开头**（`renderTouchedForAi` 的第一段），
//     而台账正文里的那次出现必然**在中间** ⇒ **只认位置 0**。
// ★★★ 尺子修正（第二版又错了，两次都错在同一个地方 —— 「位置」）：
//   第一版用 `includes(那句)` ⇒ 被**台账正文里的引用**污染（我自己把这句话写进了台账）⇒ 恒为真。
//   第二版改成 `startsWith`（位置 0）⇒ **仍然错**，因为整条注入的形状是：
//       ① `headOf` 那行（"The following project-ledger facts belong to …"）
//       ② 台账正文
//       ③ `\n\n---\n\n`
//       ④ **回执段** ← ★ 框定在**这一段**的开头，不在整段的第 0 位
//     ⇒ 正解：判「框定是否**紧挨着**回执标题」（新代码的确切形状），
//       而不是判它在整段的哪个位置。
const startsFramed = (t) =>
  /\[插件注入 · 不是用户发言\][^\n]*\n+\s*#{1,3}\s*项目台账：本轮已被改动/.test(t);
const ours = evs.filter((e) => e.type === "user/message" && e.data?.source?.kind === "project-ledger-notes");
console.log(`  全会话共 ${ours.length} 条`);
for (const e of ours.slice(-8)) {
  const t = textOf(e.data).replace(/\s+/g, " ");
  const framed = startsFramed(textOf(e.data));
  const receipt = /^\s*(\[插件注入[^\]]*\]\s*)?## 项目台账：本轮已被改动/.test(textOf(e.data));
  console.log(`\n  ${hm(e.time)}  seq=${String(e.seq).padStart(6)}  ★开头框定=${framed ? "★有" : "无"}  回执=${receipt ? "是" : "否"}`);
  console.log(`     ${t.slice(0, 130)}`);
}

console.log("\n" + "═".repeat(92));
console.log("② ★ 全会话里**以框定开头**的注入有几条、最早是哪条（= 新代码真正生效的时刻）");
console.log("═".repeat(92));
const framedAll = ours.filter((e) => startsFramed(textOf(e.data)));
console.log(`  以框定开头的注入 = **${framedAll.length}** 条`);
for (const e of framedAll.slice(0, 5)) {
  console.log(`    ${hm(e.time)}  seq=${e.seq}  ${textOf(e.data).replace(/\s+/g, " ").slice(0, 90)}`);
}
// 对照：仅**提及**该词（在中间）的条数 —— 用来证明第一版为什么会错
const mentioned = ours.filter((e) => textOf(e.data).includes("[插件注入 · 不是用户发言]"));
console.log(`  ★ 对照：**提到**过这句话的 = ${mentioned.length} 条（多为台账正文里的引用）`);
console.log(`     ⇒ 两者之差 ${mentioned.length - framedAll.length} 条 = **假阳性**（第一版会误判成"已生效"）`);

console.log("\n" + "═".repeat(92));
console.log("③ ★ 回执类注入的时间线（含「有没有框定」）—— 这一栏最关键");
console.log("═".repeat(92));
const receipts = ours.filter((e) => {
  const t = textOf(e.data).trim();
  return /^(\[插件注入[^\]]*\]\s*)?#[#\s]*项目台账/.test(t) || /^(\[插件注入[^\]]*\]\s*)?## 项目台账：本轮已被改动/.test(t);
});
for (const e of receipts) {
  const t = textOf(e.data);
  console.log(`  ${hm(e.time)}  seq=${String(e.seq).padStart(6)}  ★开头框定=${startsFramed(t) ? "★有" : "无"}`);
}

console.log("\n" + "═".repeat(92));
console.log("④ 时间线：最后一条事件 / 最近一条 user 消息（判断「重启点」在哪）");
console.log("═".repeat(92));
const last = evs[evs.length - 1];
console.log(`  最后一条事件：${hm(last.time)}  ${last.type}  seq=${last.seq}`);
for (const e of evs.slice(-14)) {
  const extra = e.type === "user/message" ? ` kind=${e.data?.source?.kind ?? "?"}` : "";
  console.log(`    ${hm(e.time)}  ${String(e.seq).padStart(6)}  ${e.type}${extra}`);
}
