/**
 * ★★★ 定性定量：**「压缩不及预期」的根因是不是「启发式 token 与真实 token 不同尺度」？**
 *
 * 已知（读内核源码坐实，不是猜）：
 *   · 选段目标 = `Σnodes − removePoints% × window`（本插件 `lib/index.js` L9513-9516）
 *   · `nodes[i].tokens` 在无图像/无文件时 **≡ `heuristicTokens`**，而
 *     `heuristicTokens` 由 `estimate.js` 的 **`CHARS_PER_TOKEN = 4`** 算出（**启发式**）
 *   · 而 `window`（1,000,000）是**真实模型**的上下文窗口
 *   · 内核自报的 `shadowedTokenCount` = `Σ selectedNodes.heuristicTokens`（`compaction-basic` L577）
 *   · 水位 `measure().totalTokens` **锚在真实请求的 usage 上**（`token-meter` L642-684）
 *
 * ⇒ 若这两把尺子不等价，那么"按窗口 10% 去压"实际压掉的**真实**量就不是窗口的 10%。
 *
 * 本探针用**两个互相独立**的真实量交叉验证：
 *   ① `assistant/message.usage`（provider 报的 input+cacheRead）—— 真实请求有多长
 *   ② `compaction/summary.shadowedTokenCount`（内核自报的启发式量）
 * 并解出「被压段的真实代价」= 真实缩小 + 摘要本身（摘要要补回去）。
 *
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
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(11, 19);
const W = 1000000;
const CHARS_PER_TOKEN = 4; // ★ 内核 estimate.js L9

const routes = evs.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => ({ time: e.time, p: Number(e.data.usage.inputTokens || 0) + Number(e.data.usage.cacheReadTokens || 0) }))
  .sort((a, b) => a.time - b.time);
const startsById = new Map();
for (const e of evs) if (e.type === "compaction/start") startsById.set(e.data?.compactionId, e.data);
const sums = evs.filter((e) => e.type === "compaction/summary")
  .map((e) => {
    const chars = Array.isArray(e.data?.summary) ? e.data.summary.reduce((s, b) => s + String(b?.text ?? "").length, 0) : 0;
    return {
      time: e.time, id: e.data?.compactionId,
      heur: Number(e.data?.shadowedTokenCount ?? 0),
      nodes: Array.isArray(e.data?.shadowedSeqs) ? e.data.shadowedSeqs.length : 0,
      chars,
      sumOut: Number(e.data?.usage?.outputTokens ?? 0),
    };
  }).sort((a, b) => a.time - b.time);

console.log("═══ 每次压缩：「意图」vs「内核启发式」vs「provider 真实」═══\n");
console.log("  时刻     归属   意图删除     启发式shadowed  摘要字符  摘要real≈  真实缩小   真实删除量   real/heur  真实点数");
console.log("  " + "-".repeat(118));
const rows = [];
for (const s of sums) {
  const st = startsById.get(s.id) ?? {};
  const before = [...routes].reverse().find((r) => r.time <= s.time);
  const after = routes.find((r) => r.time > s.time);
  if (before === undefined || after === undefined) continue;
  const realShrink = before.p - after.p;
  // 摘要本身的真实代价：先用字符数估（/CHARS_PER_TOKEN），仅作下界；同时给 outputTokens 参考
  const sumRealEst = Math.ceil(s.chars / CHARS_PER_TOKEN);
  const spanReal = realShrink + sumRealEst;     // 被压段的真实代价（摘要补回来了）
  const ratio = spanReal / (s.heur || 1);
  const points = realShrink / W * 100;
  rows.push({ s, st, before, after, realShrink, spanReal, ratio, points });
  console.log(
    `  ${hm(s.time)}  ${String(st.turn === null ? "全量" : "t" + st.turn).padStart(4)}  ` +
    `${String(100000).padStart(8)}  ${String(s.heur).padStart(14)}  ${String(s.chars).padStart(8)}  ` +
    `${String(sumRealEst).padStart(9)}  ${String(realShrink).padStart(9)}  ${String(spanReal).padStart(10)}  ` +
    `${ratio.toFixed(2).padStart(9)}  ${points.toFixed(1).padStart(8)}`
  );
}

console.log("\n═══ 只看「修复后（03:25 之后）的自动增量」 ═══");
const FIX = new Date("2026-10-11T03:25:00+08:00").getTime();
const post = rows.filter((r) => r.s.time >= FIX && r.st.turn !== null);
for (const r of post) {
  console.log(`  ${hm(r.s.time)}  t${r.st.turn}：意图 100,000（窗口 10%）→ 启发式 shadowed ${r.s.heur}`);
  console.log(`      真实缩小 ${r.realShrink} = ${r.points.toFixed(1)} 点（意图 10.0 点）⇒ 达成率 ${(r.points / 10 * 100).toFixed(0)}%`);
  console.log(`      被压段真实代价 ≈ ${r.spanReal} ⇒ real/heuristic = ${r.ratio.toFixed(2)}`);
}
if (post.length >= 2) {
  const avgRatio = post.reduce((s, r) => s + r.ratio, 0) / post.length;
  const avgPts = post.reduce((s, r) => s + r.points, 0) / post.length;
  console.log(`\n  ★ 平均 real/heuristic = ${avgRatio.toFixed(2)}   平均真实点数 = ${avgPts.toFixed(1)}`);
  console.log(`  ★ 结论：选段确实是"窗口 10% 的**启发式**量"（≈100K heuristic），`);
  console.log(`     但真实只压掉 ${(avgPts).toFixed(1)} 点 ⇒ 两把尺子差 ${(10 / avgPts).toFixed(2)} 倍。`);
}
