/**
 * ★★★ 决定性测量：**推理块在"真实 prompt"里到底算不算钱？**
 *
 * 为什么必须先测这一条：
 *   D70 说「真实/启发式 ≈ 1 − 推理占比」⇒ 推理块真实贡献 ≈ 0。
 *   如果这是真的，那么「把推理块存档」**省不到真实 token**，只是让**启发式水位**下降。
 *   如果它不是真的（例如我把「真实」的口径取错了），结论要**整个反过来**。
 *
 * 口径（本探针写死，不许含糊）：
 *   真实 prompt 大小 = `inputTokens + cacheReadTokens`（= 该次请求实际发出去的全部输入）
 *   增长 = 相邻两次请求的 prompt 之差（且两次之间**没有压缩**）
 *   启发式增长 = 该窗口内**新追加**的 surface 事件字符数 ÷ 4（与内核 estimate.js 同口径）
 *   ★ 两者比 = 兑现率。按**推理占比**分桶。
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
evs.sort((a, b) => a.seq - b.seq);

console.log("═".repeat(84));
console.log("⓪ 先验口径：usage 三件套能不能对上（这决定「真实」怎么取）");
console.log("═".repeat(84));
const withUsage = evs.filter((e) => e.type === "assistant/message" && e.data?.usage);
let ok = 0, bad = 0, maxErr = 0;
for (const e of withUsage) {
  const u = e.data.usage;
  const sum = Number(u.inputTokens || 0) + Number(u.cacheReadTokens || 0) + Number(u.outputTokens || 0);
  const t = Number(u.totalTokens || 0);
  const err = Math.abs(sum - t);
  maxErr = Math.max(maxErr, err);
  if (err <= Math.max(2, t * 0.001)) ok += 1; else bad += 1;
}
console.log(`  totalTokens ?= input + cacheRead + output`);
console.log(`  对上 ${ok} 条 / 对不上 ${bad} 条 · 最大绝对误差 ${maxErr}`);
console.log(`  ⇒ ${bad === 0 ? "★ 恒等成立：`totalTokens` 就是三者之和（含输出）" : "⚠ 不成立，须重新想口径"}`);
const s0 = withUsage[withUsage.length - 1].data.usage;
console.log(`  最近一条：input=${s0.inputTokens} cacheRead=${s0.cacheReadTokens} output=${s0.outputTokens} total=${s0.totalTokens}`);

console.log("\n" + "═".repeat(84));
console.log("① 剥离输出后的「真实 prompt」= input + cacheRead");
console.log("═".repeat(84));
const routes = withUsage.map((e) => ({
  seq: e.seq, time: e.time,
  prompt: Number(e.data.usage.inputTokens || 0) + Number(e.data.usage.cacheReadTokens || 0),
})).sort((a, b) => a.time - b.time);
const proms = routes.map((r) => r.prompt).sort((a, b) => a - b);
const q = (p) => proms[Math.min(proms.length - 1, Math.floor(p * proms.length))];
console.log(`  条数 ${routes.length}  min=${proms[0].toLocaleString()}  中位=${q(0.5).toLocaleString()}  max=${proms[proms.length - 1].toLocaleString()}`);
console.log(`  ⇒ 真实 prompt 的**最大值** = ${proms[proms.length - 1].toLocaleString()} tok（窗口 1,000,000）`);

const compactTimes = evs.filter((e) => e.type === "compaction/end").map((e) => e.time).sort((a, b) => a - b);
const inCompaction = (t0, t1) => compactTimes.some((c) => c > t0 && c <= t1);

// 每个窗口内新追加的 surface 事件（按 seq 区间）
const surfaceAppends = [];
for (const e of evs) {
  if (e.surfaceOp === undefined) continue;
  if (e.surfaceOp !== "append") continue;
  const c = e.data?.message?.content;
  let chars = 0, rChars = 0;
  if (Array.isArray(c)) {
    for (const b of c) {
      const n = typeof b.text === "string" ? b.text.length : JSON.stringify(b).length;
      chars += n;
      if (b.type === "reasoning") rChars += n;
    }
  } else if (typeof e.data?.content === "string") chars += e.data.content.length;
  if (chars > 0) surfaceAppends.push({ seq: e.seq, time: e.time, chars, rChars, type: e.type });
}
surfaceAppends.sort((a, b) => a.seq - b.seq);

console.log("\n" + "═".repeat(84));
console.log("② ★★★ 按「推理占比」分桶：真实增长 ÷ 启发式增长");
console.log("═".repeat(84));
const buckets = [[0, 0.05], [0.05, 0.35], [0.35, 0.5], [0.5, 0.65], [0.65, 0.85], [0.85, 1.01]];
const agg = buckets.map(() => ({ n: 0, real: 0, heur: 0, rSum: 0 }));
let skipped = 0;
for (let i = 0; i + 1 < routes.length; i += 1) {
  const a = routes[i], b = routes[i + 1];
  const growth = b.prompt - a.prompt;
  if (growth <= 0) { skipped += 1; continue; }
  if (inCompaction(a.time, b.time)) { skipped += 1; continue; }
  // 该窗口内新追加的 surface 事件
  const add = surfaceAppends.filter((s) => s.seq > a.seq && s.seq <= b.seq);
  if (add.length === 0) { skipped += 1; continue; }
  const chars = add.reduce((x, s) => x + s.chars, 0);
  const rChars = add.reduce((x, s) => x + s.rChars, 0);
  const heur = chars / 4;
  if (heur < 500) { skipped += 1; continue; }   // 太小的窗口噪声大
  const share = rChars / Math.max(1, chars);
  const bi = buckets.findIndex(([lo, hi]) => share >= lo && share < hi);
  if (bi === -1) continue;
  const c = agg[bi];
  c.n += 1; c.real += growth; c.heur += heur; c.rSum += share;
}
console.log("  推理占比桶      窗口数   真实增长均值  启发式均值   兑现率   1−推理占比");
console.log("  " + "-".repeat(78));
for (let i = 0; i < buckets.length; i += 1) {
  const c = agg[i];
  if (c.n === 0) { console.log(`  ${(buckets[i][0] * 100).toFixed(0)}~${(buckets[i][1] * 100).toFixed(0)}%`.padEnd(16) + "   0  （空桶）"); continue; }
  const real = c.real / c.n, heur = c.heur / c.n, share = c.rSum / c.n;
  console.log(`  ${((buckets[i][0] * 100).toFixed(0) + "~" + (buckets[i][1] * 100).toFixed(0) + "%").padEnd(16)} ${String(c.n).padStart(6)} ${Math.round(real).toLocaleString().padStart(13)} ${Math.round(heur).toLocaleString().padStart(12)} ${(real / Math.max(1, heur)).toFixed(3).padStart(9)} ${(1 - share).toFixed(3).padStart(11)}`);
}
console.log(`  （跳过 ${skipped} 个窗口：含压缩 / 增长≤0 / 新增为0 / 太小）`);

console.log("\n" + "═".repeat(84));
console.log("③ ★ 判据：把推理块单独与外置后的**真实代价**");
console.log("═".repeat(84));
const totReal = agg.reduce((a, c) => a + c.real, 0);
const totHeur = agg.reduce((a, c) => a + c.heur, 0);
console.log(`  全部窗口合计：真实增长 ${totReal.toLocaleString()} · 启发式 ${Math.round(totHeur).toLocaleString()} ⇒ 总兑现率 ${(totReal / Math.max(1, totHeur)).toFixed(3)}`);
console.log("");
console.log(`  ★ 若「1−推理占比」在每一桶都与兑现率吻合 ⇒ 推理块的真实贡献≈0`);
console.log(`    ⇒ 那么「把推理存档」**省不到真实 token**，只降启发式水位；`);
console.log(`    ⇒ 但它仍然值钱，理由是**它不再挤占"该删谁"的预算**（详见结论）。`);
console.log(`  ★ 若吻合不了 ⇒ D70 的闭式是错的，必须回头重查。`);
