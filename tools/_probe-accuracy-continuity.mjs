/**
 * ★★★ 只读评估：**「准确度」与「自然延续（断裂感）」这两个约束，对策略意味着什么？**
 *
 * 用户 2026-10-11 的两点（原话大意）：
 *   ① *"准确度是个很大的问题，如果没有准确度的话，那我们这个插件的意义就不存在了。"*
 *   ② *"模型接续上下文工作……如果上下文太少，导致模型本身的自然延续、工作都做不到的话，
 *      那样的话断裂感就会很强。"*
 *
 * ⇒ 这两点都指向**同一个东西**：上下文里**逐字保留的那一段**（= 保留段）。
 *   而我在 D76 里提的「半 1：调小保留段」**正好会攻击它** —— 本节就是要证伪/证实那件事。
 *
 * 本探针回答四问（全部只读、只按 j.type 精确匹配）：
 *   ① 工具头（不可压缩的底座）到底多大？**直接量 request/header 里的 tools**，不靠估。
 *   ② 全量压缩后，上下文里**还剩多少逐字对话**？恢复材料（摘要+台账+胶囊）占多少？
 *   ③ 「保留段」随棘轮怎么长大？（= 自然延续的 substrate 有多大）
 *   ④ 「断裂感」的可测代理：**压缩后重读率** vs 基线。
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
const SESS = path.join(os.homedir(), ".dsh", "sessions", "--D-Deepseek~5DE5~4F5C~533A--",
  "session-fada6e5f-52f2-4a4f-b52a-3c2483db117e", "session.v4.jsonl.zstd");
const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
const W = 1000000;
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(11, 19);
const CPT = 4;   // 内核启发式：4 字符/token

const routes = evs.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => ({ time: e.time, prompt: Number(e.data.usage.inputTokens || 0) + Number(e.data.usage.cacheReadTokens || 0) }))
  .sort((a, b) => a.time - b.time);

// ── ① 工具头：直接量 request/header 里的 tools ──────────────────────────────
console.log("═".repeat(78));
console.log("① 工具头（每次请求都必须带的底座）—— **直接量，不靠估**");
console.log("═".repeat(78));
const headers = evs.filter((e) => e.type === "request/header").map((e) => {
  const d = e.data ?? {};
  const tools = d.tools ?? d.header?.tools;
  const n = Array.isArray(tools) ? tools.length : undefined;
  const jsonLen = tools === undefined ? undefined : JSON.stringify(tools).length;
  return { time: e.time, n, jsonLen, keys: Object.keys(d).join(",") };
});
console.log(`  request/header 事件 ${headers.length} 条；形状示例 keys = ${headers[0]?.keys ?? "（无）"}`);
const withTools = headers.filter((h) => h.n !== undefined);
if (withTools.length === 0) {
  console.log("  ⚠️ 这些事件里**没有 tools 字段** ⇒ 工具头量不到（如实报，不猜）。");
} else {
  console.log("  时刻        工具数   定义 JSON 长度   ≈启发式 token   占窗口");
  for (const h of withTools) {
    const tok = Math.ceil(h.jsonLen / CPT) + 4;
    console.log(`  ${hm(h.time)}  ${String(h.n).padStart(6)}  ${String(h.jsonLen).padStart(14)}  ` +
      `${String(tok).padStart(14)}  ${String((tok / W * 100).toFixed(1)).padStart(6)}%`);
  }
  const first = withTools[0], last = withTools[withTools.length - 1];
  console.log(`\n  ★ 工具数：首 ${first.n} → 末 ${last.n}（${last.n < first.n ? "**减少了**" : last.n > first.n ? "增加了" : "不变"}）`);
  console.log(`  ★ 工具头 ≈ **${(Math.ceil(last.jsonLen / CPT) / W * 100).toFixed(1)} 点**（这是**不可压缩**的底座）`);
  console.log("  ⇒ 它决定了「窗口里有多少是真正能给对话用的」。");
}

// ── ② 全量压缩后，还剩多少逐字对话？恢复材料占多少？───────────────────────
console.log("\n" + "═".repeat(78));
console.log("② 全量压缩之后：**上下文里还剩多少逐字对话？**");
console.log("═".repeat(78));
const bySeq = new Map();
for (const e of evs) if (Number.isFinite(e.seq)) bySeq.set(e.seq, e);
const sums = evs.filter((e) => e.type === "compaction/summary").map((e) => {
  const chars = Array.isArray(e.data?.summary) ? e.data.summary.reduce((a, b) => a + String(b?.text ?? "").length, 0) : 0;
  return { time: e.time, id: e.data?.compactionId, chars, seqs: e.data?.shadowedSeqs ?? [] };
}).sort((a, b) => a.time - b.time);
const startsById = new Map();
for (const e of evs) if (e.type === "compaction/start") startsById.set(e.data?.compactionId, e.data);
for (const s of sums) s.turn = startsById.get(s.id)?.turn;
const ledgerInj = evs.filter((e) => e.type === "user/message" && e.data?.source?.kind === "project-ledger-notes")
  .map((e) => {
    const c = e.data.content;
    return { time: e.time, chars: (typeof c === "string" ? c : JSON.stringify(c ?? "")).length };
  });
console.log("  时刻(全量)  压缩后水位   其中：工具头   恢复材料(摘要+台账+胶囊)   逐字对话还剩");
console.log("  " + "-".repeat(88));
const lastToolTok = withTools.length ? Math.ceil(withTools[withTools.length - 1].jsonLen / CPT) : undefined;
for (const s of sums.filter((x) => x.turn === null)) {
  const after = routes.find((r) => r.time > s.time);
  if (after === undefined) continue;
  const ledger = [...ledgerInj].reverse().find((l) => l.time <= after.time);
  const recov = s.chars + (ledger?.chars ?? 0) + 3430;   // 摘要 + 台账重注 + 胶囊（实测 3430 B）
  const toolTok = lastToolTok ?? 0;
  const verbatim = after.prompt - toolTok - Math.ceil(recov / CPT);
  console.log(`  ${hm(s.time)}  ${String((after.prompt / W * 100).toFixed(1)).padStart(10)}%  ` +
    `${String((toolTok / W * 100).toFixed(1)).padStart(11)}%  ` +
    `${String(`${(recov / 1000).toFixed(0)}K字符≈${(Math.ceil(recov / CPT) / W * 100).toFixed(1)}%`).padStart(24)}  ` +
    `${String((verbatim / W * 100).toFixed(1)).padStart(11)}%`);
}
console.log("\n  ★★ 关键读法：第三列是**模型真正的「上下文底座」**（每次请求都要带的工具定义）——");
console.log("     它**不可压缩**；最后一列才是**还留在上下文里的逐字对话**。");

// ── ③ 保留段随棘轮长大（= 自然延续的 substrate）────────────────────────────
console.log("\n" + "═".repeat(78));
console.log("③ 「保留段」随棘轮怎么长大？（= 自然延续的 substrate 有多大）");
console.log("═".repeat(78));
const floors = sums.filter((x) => x.turn === null)
  .map((s) => { const a = routes.find((r) => r.time > s.time); return a === undefined ? undefined : a.prompt; })
  .filter((x) => x !== undefined);
const floorTok = floors.length ? Math.min(...floors) : 0;
console.log(`  地板（历次全量压缩后的**最小**水位）= **${(floorTok / W * 100).toFixed(1)}%**`);
const FIX = new Date("2026-10-11T03:25:00+08:00").getTime();
console.log("  时刻     归属  压后水位  ★保留段(点)  其中逐字对话(去掉工具头)");
console.log("  " + "-".repeat(72));
const rets = [];
for (const s of sums.filter((x) => x.turn !== null && x.time >= FIX)) {
  const a = routes.find((r) => r.time > s.time);
  if (a === undefined) continue;
  const ret = (a.prompt - floorTok) / W * 100;
  const verb = (a.prompt - (lastToolTok ?? 0)) / W * 100;
  rets.push(ret);
  console.log(`  ${hm(s.time)}  t${String(s.turn).padStart(2)}  ${String((a.prompt / W * 100).toFixed(1)).padStart(8)}%  ` +
    `${String(ret.toFixed(1)).padStart(11)}  ${String(verb.toFixed(1)).padStart(26)}%`);
}
console.log(`\n  ★ 「保留段」= 压后水位 − 地板。实测它随棘轮**逐轮变大**：` +
  rets.map((x) => x.toFixed(1)).join(" → ") + " 点");
console.log("     也就是**系统越用、逐字保留得越多**。这正是「自然延续」赖以成立的那块。");
console.log("     ⇒ ★ 我 D76 里提的「半 1：调小保留段」会**直接砍掉它** —— 与你这两点约束冲突。");

// ── ④ 断裂感代理：定位**每次压缩的边界**，看"离开这段"与"刚压完"有没有差别 ──
//
//   ★ 我第一版是**坏的**：判据 `calls.find((e) => e.time === r.time)?.seq` 拿不到 seq
//     ⇒ 全部落进基线桶（"压缩后 0 次"）⇒ 那条输出**什么也没测**。这里改成**按 seq 定位**。
//   ★ 第二版也错：我从 `tool/call` 里筛 `compaction/end` —— 那不是 tool/call ⇒ **恒为 0**。
//     正确做法：`compaction/end` 的 seq 直接从**全部事件**里取。
console.log("\n" + "═".repeat(78));
console.log("④ 「断裂感」的可测代理：**压缩边界附近的「回头查」行为**");
console.log("═".repeat(78));
const calls = evs.filter((e) => e.type === "tool/call");
const callsWithSeq = calls.map((e) => ({ seq: e.seq, time: e.time, name: String(e.data?.name ?? "?"),
  args: String(e.data?.arguments ?? "").replace(/\s+/g, " ").trim() })).filter((x) => Number.isFinite(x.seq));
const REGEX = /^(read|grep|glob|Get-Content|Select-String|pwsh)$/i;
const readCalls = callsWithSeq.filter((x) => REGEX.test(x.name) && x.args !== "");
// ★ 判据：落在"某个压缩之后 10 次**工具调用**以内"的读类调用。
//   ★ 插件的注入与压缩发生在**回合内**，而 `compaction/end` 的 seq 在事件流里是独立的
//     （它不是 tool/call）⇒ 只在 tool/call 序列里按**时间**判断即可（够用且不会错）。
const endTimes = evs.filter((e) => e.type === "compaction/end").map((e) => e.time).sort((a, b) => a - b);
/** 该调用之前 10 次工具调用里，有没有压缩刚结束。 */
const nearEnd = (idx) => {
  for (let i = Math.max(0, idx - 10); i < idx; i += 1) {
    const t = callsWithSeq[i]?.time;
    if (t !== undefined && endTimes.some((et) => et <= t && t - et <= 20 * 60 * 1000)) return true;
  }
  return false;
};
const seen = new Set();
const buckets = { post: { n: 0, rep: 0 }, base: { n: 0, rep: 0 } };
const readIdx = [];
readCalls.forEach((r) => { readIdx.push(callsWithSeq.findIndex((x) => x.seq === r.seq)); });
readCalls.forEach((r, k) => {
  const key = `${r.name}\u0000${r.args}`;
  const isRep = seen.has(key);
  seen.add(key);
  const b = nearEnd(readIdx[k]) ? buckets.post : buckets.base;
  b.n += 1;
  if (isRep) b.rep += 1;
});
const pct = (b) => (b.n === 0 ? "N/A（桶里没有样本）" : (b.rep / b.n * 100).toFixed(1) + "%");
console.log(`  判重口径：同工具 + 同参数串（**整会话去重，前一次出现过就算重复**）`);
console.log(`  A) 压缩后 ≤10 次调用内：**${buckets.post.n}** 次样本，重复 ${buckets.post.rep} 次 ⇒ **${pct(buckets.post)}**`);
console.log(`  B) 其它时刻（基线）    ：**${buckets.base.n}** 次样本，重复 ${buckets.base.rep} 次 ⇒ **${pct(buckets.base)}**`);
if (buckets.post.n === 0) {
  console.log("  ⚠️ A 桶为空 ⇒ **这一节没能测到东西**（压缩后立刻发读类调用的情况太少）。");
  console.log("     如实报「未测到」，不拿它当证据。");
} else {
  console.log("  ★ 判别：若 A 显著高于 B，说明**压缩确实让人重做已有动作**（断裂感的迹象）。");
}
console.log("  ⚠️ 即便 A 高，这也只是**弱代理**：重读也可能是正常复核。**不能单独证明「断裂感」。**");
console.log("  ⇒ 要真证，仍须**对照实验**（存档组 vs 不存档组做同一件事）。**未做。**");
