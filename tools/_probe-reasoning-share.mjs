/**
 * ★★★ 判定性测试：被压段里 `assistant/message` 的**推理块（reasoning）**占比多少？
 *
 * 缘起：独立复算证明内核报的 `shadowedTokenCount` **忠实**（复算/报出 = 1.00~1.03），
 *   字符密度恒定 ≈3.9 字符/启发式token。但**真实**路由只缩小三分之一：
 *     · 全量压缩：2.13M 字符 → 真实缩小 595K  ⇒ 3.6 字符/真实token（与启发式一致）
 *     · 增量压缩：0.38M 字符 → 真实缩小  39K  ⇒ 9.7 字符/真实token（**差 2.7 倍**）
 *   同一估算器、同样字符 ⇒ 只能由**内容构成**解释。
 *
 * 假设：内核估算器把 `text` 与 `reasoning` **一视同仁**（`estimate.js` L38-41 同一分支），
 *   而真实请求里**推理块可能不进 prompt**（或被 provider 计费口径不同地对待）。
 *   若被压段以推理为主 ⇒ 选段"按启发式够了"，但真实省下来的远少于此。
 *
 * 做法：把 `shadowedSeqs` 里每个 `assistant/message` 的 content **按块类型**拆开计价。
 *   ★ 只读。
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
const bySeq = new Map();
for (const e of evs) if (Number.isFinite(e.seq)) bySeq.set(e.seq, e);
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(11, 19);

const startsById = new Map();
for (const e of evs) if (e.type === "compaction/start") startsById.set(e.data?.compactionId, e.data);
const sums = evs.filter((e) => e.type === "compaction/summary")
  .map((e) => ({ time: e.time, id: e.data?.compactionId, heur: Number(e.data?.shadowedTokenCount ?? 0), seqs: e.data?.shadowedSeqs ?? [] }))
  .sort((a, b) => a.time - b.time);
for (const s of sums) s.turn = startsById.get(s.id)?.turn;

const CPT = 4, BLOCK = 4, ROLE = 4;
const estBlock = (b) => {
  if (b?.type === "text" || b?.type === "reasoning") return { tok: Math.ceil(String(b.text ?? "").length / CPT) + BLOCK, chars: String(b.text ?? "").length, kind: b.type };
  if (b?.type === "tool-call") return { tok: Math.ceil(String(b.name ?? "").length / CPT) + Math.ceil(String(b.arguments ?? "").length / CPT) + BLOCK, chars: String(b.name ?? "").length + String(b.arguments ?? "").length, kind: "tool-call" };
  return { tok: BLOCK + Math.ceil(JSON.stringify(b).length / CPT), chars: JSON.stringify(b).length, kind: String(b?.type ?? "?") };
};

console.log("═══ 被压段里各**块类型**的启发式占比（推理块是重点）═══\n");
console.log("  时刻     归属    总启发式   reasoning   text      tool-call  其它    推理占比");
console.log("  " + "-".repeat(92));
for (const s of sums) {
  const acc = new Map();
  let totalTok = 0;
  for (const seq of s.seqs) {
    const ev = bySeq.get(seq);
    if (ev === undefined) continue;
    if (ev.type === "assistant/message") {
      const content = ev.data?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) { const r = estBlock(b); acc.set(r.kind, (acc.get(r.kind) ?? 0) + r.tok); totalTok += r.tok; }
    } else {
      const c = ev.data?.content ?? ev.data?.message?.content ?? ev.data;
      const s2 = typeof c === "string" ? c : JSON.stringify(c);
      const tok = Math.ceil(s2.length / CPT) + BLOCK + ROLE;
      acc.set(ev.type, (acc.get(ev.type) ?? 0) + tok); totalTok += tok;
    }
  }
  const g = (k) => acc.get(k) ?? 0;
  const reason = g("reasoning");
  console.log(
    `  ${hm(s.time)}  ${String(s.turn === null ? "全量" : "t" + s.turn).padStart(4)}  ` +
    `${String(totalTok).padStart(9)}  ${String(reason).padStart(9)}  ${String(g("text")).padStart(8)}  ` +
    `${String(g("tool-call")).padStart(9)}  ${String(totalTok - reason - g("text") - g("tool-call")).padStart(6)}  ` +
    `${(reason / (totalTok || 1) * 100).toFixed(1).padStart(7)}%`
  );
}

console.log("\n═══ 修复后三次自动增量（推理块明细）═══");
const FIX = new Date("2026-10-11T03:25:00+08:00").getTime();
for (const s of sums.filter((x) => x.time >= FIX && x.turn !== null)) {
  let reason = 0, text = 0, tc = 0, other = 0, asstCount = 0;
  for (const seq of s.seqs) {
    const ev = bySeq.get(seq);
    if (ev?.type !== "assistant/message") continue;
    const content = ev.data?.message?.content;
    if (!Array.isArray(content)) continue;
    asstCount += 1;
    for (const b of content) {
      const r = estBlock(b);
      if (r.kind === "reasoning") reason += r.tok;
      else if (r.kind === "text") text += r.tok;
      else if (r.kind === "tool-call") tc += r.tok;
      else other += r.tok;
    }
  }
  const tot = reason + text + tc + other;
  console.log(`\n  ${hm(s.time)}  t${s.turn}  assistant 消息 ${asstCount} 条 · 合计 ${tot} 启发式 token`);
  console.log(`     reasoning  ${String(reason).padStart(7)}  ${(reason / tot * 100).toFixed(1)}%`);
  console.log(`     text       ${String(text).padStart(7)}  ${(text / tot * 100).toFixed(1)}%`);
  console.log(`     tool-call  ${String(tc).padStart(7)}  ${(tc / tot * 100).toFixed(1)}%`);
  console.log(`     其它       ${String(other).padStart(7)}  ${(other / tot * 100).toFixed(1)}%`);
}
console.log("\n  ★ 若 reasoning 占比很高 ⇒ 选段把大量**推理块**当成了待压内容，");
console.log("     而它们在真实请求里未必占同样多 ⇒ 「意图 10 点、实得 4.4 点」。");
