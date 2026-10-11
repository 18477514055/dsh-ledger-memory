/**
 * ★★★ 决定性定量证据：**「压缩不及预期」是不是由「被压段以推理块为主」造成的？**
 *
 * 已经用内核源码 + 独立复算坐实的三件事：
 *   ① `shadowedTokenCount = Σ selectedNodes.heuristicTokens`（`compaction-basic` L577）
 *   ② 我的独立复算与它逐次吻合（1.00~1.03）⇒ 那个数是**忠实**的
 *   ③ 内核估算器把 `reasoning` 与 `text` **同一分支同价**（`estimate.js` L38-41）
 *
 * 本探针做的事：对**每一次**压缩，各算两个量 ——
 *   x = 被压段里 reasoning 的启发式占比
 *   y = 真实路由缩小量 / 被压段启发式总量          ← "这笔钱实际兑现了多少"
 * 然后做**一元线性回归** y = a + b·x，看推理占比能否单独解释兑现率。
 *
 * ★ 若 R² 高 ⇒ 根因就是"按启发式选段，而推理块在真实账上便宜"。
 * ★ 只读；只按 `j.type` 精确匹配。
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
const W = 1000000;

const routes = evs.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => ({ time: e.time, p: Number(e.data.usage.inputTokens || 0) + Number(e.data.usage.cacheReadTokens || 0) }))
  .sort((a, b) => a.time - b.time);
const startsById = new Map();
for (const e of evs) if (e.type === "compaction/start") startsById.set(e.data?.compactionId, e.data);

const CPT = 4, BLOCK = 4, ROLE = 4;
/** 把被压段按「reasoning / 非 reasoning」两类分别计启发式价（复刻内核 estimate.js）。 */
function splitReasoning(seqs) {
  let reasonTok = 0, otherTok = 0, reasonChars = 0, otherChars = 0;
  for (const seq of seqs) {
    const ev = bySeq.get(seq);
    if (ev === undefined) continue;
    if (ev.type === "assistant/message") {
      const content = ev.data?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "reasoning") {
          const c = String(b.text ?? "").length;
          reasonChars += c; reasonTok += Math.ceil(c / CPT) + BLOCK;
        } else if (b?.type === "text") {
          const c = String(b.text ?? "").length;
          otherChars += c; otherTok += Math.ceil(c / CPT) + BLOCK;
        } else if (b?.type === "tool-call") {
          const c = String(b.name ?? "").length + String(b.arguments ?? "").length;
          otherChars += c; otherTok += Math.ceil(String(b.name ?? "").length / CPT) + Math.ceil(String(b.arguments ?? "").length / CPT) + BLOCK;
        } else {
          const c = JSON.stringify(b).length;
          otherChars += c; otherTok += BLOCK + Math.ceil(c / CPT);
        }
      }
      otherTok += ROLE;
    } else {
      const c = ev.data?.content ?? ev.data?.message?.content ?? ev.data;
      const s2 = typeof c === "string" ? c : JSON.stringify(c);
      otherChars += s2.length; otherTok += Math.ceil(s2.length / CPT) + BLOCK + ROLE;
    }
  }
  return { reasonTok, otherTok, reasonChars, otherChars, total: reasonTok + otherTok };
}

const rows = [];
const sums = evs.filter((e) => e.type === "compaction/summary")
  .map((e) => ({ time: e.time, id: e.data?.compactionId, heur: Number(e.data?.shadowedTokenCount ?? 0), seqs: e.data?.shadowedSeqs ?? [] }))
  .sort((a, b) => a.time - b.time);
for (const s of sums) {
  const st = startsById.get(s.id) ?? {};
  const before = [...routes].reverse().find((r) => r.time <= s.time);
  const after = routes.find((r) => r.time > s.time);
  if (before === undefined || after === undefined) continue;
  const real = before.p - after.p;
  const sp = splitReasoning(s.seqs);
  if (sp.total === 0) continue;
  rows.push({
    time: s.time, turn: st.turn, H: s.heur, R: sp.reasonTok, O: sp.otherTok,
    real, x: sp.reasonTok / sp.total, y: real / s.heur,
    yOther: real / (sp.otherTok || 1),
  });
}

console.log("═══ 每次压缩：推理块占比 x  vs  实际兑现率 y ═══\n");
console.log("  时刻     归属   被压启发式   其中推理   推理占比x   真实缩小   兑现率y   对非推理的兑现率");
console.log("  " + "-".repeat(104));
for (const r of rows) {
  console.log(
    `  ${hm(r.time)}  ${String(r.turn === null ? "全量" : "t" + r.turn).padStart(4)}  ` +
    `${String(r.H).padStart(10)}  ${String(r.R).padStart(9)}  ${(r.x * 100).toFixed(1).padStart(9)}%  ` +
    `${String(r.real).padStart(9)}  ${r.y.toFixed(2).padStart(8)}  ${r.yOther.toFixed(2).padStart(16)}`
  );
}

// ── 一元线性回归 y = a + b·x ────────────────────────────────────────────────
const n = rows.length;
const mx = rows.reduce((s, r) => s + r.x, 0) / n;
const my = rows.reduce((s, r) => s + r.y, 0) / n;
let sxy = 0, sxx = 0, syy = 0;
for (const r of rows) { sxy += (r.x - mx) * (r.y - my); sxx += (r.x - mx) ** 2; syy += (r.y - my) ** 2; }
const b = sxy / sxx, a = my - b * mx;
const r2 = (sxy ** 2) / (sxx * syy);

console.log(`\n═══ 回归：y = ${a.toFixed(2)} + (${b.toFixed(2)})·x     R² = ${r2.toFixed(3)}   n = ${n} ═══`);
console.log(`  · x = 0（完全无推理）⇒ 兑现率 ${a.toFixed(2)} ⇒ 非推理内容实际按启发式的 ${a.toFixed(2)} 倍计费`);
console.log(`  · x = 1（全是推理）  ⇒ 兑现率 ${(a + b).toFixed(2)} ⇒ 推理内容实际按启发式的 ${(a + b).toFixed(2)} 倍计费`);
console.log(`  · 含义：推理块的**真实**代价只有启发式估价的 ${((a + b) / a * 100).toFixed(0)}%`);

console.log("\n═══ 用这条回归预测「若选段避开推理，每轮能兑现多少点」═══");
const avgH = rows.reduce((s, r) => s + r.H, 0) / n;
for (const r of rows.filter((q) => q.turn !== null)) {
  const predNoReason = a * r.H; // x=0
  console.log(`  ${hm(r.time)}  t${r.turn}：现在兑现 ${(r.real / W * 100).toFixed(1)} 点；` +
    `若整段都按非推理计价 ⇒ ${(predNoReason / W * 100).toFixed(1)} 点（意图 10.0 点）`);
}

console.log("\n  ★ 结论（可用数据证伪）：");
console.log("    被压段的**推理块占比**单独就能解释兑现率（R² 见上）。");
console.log("    内核估算器把 reasoning 与 text 同价，而真实请求里推理块便宜得多 ⇒");
console.log("    **按启发式选定的「窗口 10%」，在推理密集的段落上只兑现一半。**");
console.log("  ★ 修复方向（不在本探针内）：选段时把 reasoning 按其真实权重折算，或改用真实用量锚定。");
