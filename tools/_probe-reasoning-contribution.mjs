/**
 * ★★★ 判定性收口：**推理块到底贡献多少真实 token？**（带截距 + 与启发式并列的两个模型）
 *
 * 上一版两变量**无截距**拟合 R² 为负 ⇒ 那个拟合**不可信**，按纪律不能拿它当结论。
 *   失败原因（可诊断）：① 无截距 + 误差在自变量；② 两个回归元的方差量级差很大（异方差）。
 * 本版改用**两个可解释、可比较**的模型，并全部**带截距**：
 *   模型 A（启发式同价）：Δprompt = a + c·(推理字符 + 非推理字符)/4      ← 内核假设
 *   模型 B（推理不贡献）：Δprompt = a + c·(非推理字符)/4                ← 备择假设
 * 用 Δprompt 对**内核启发式口径**做归一，比较两者谁的残差小。
 * 再直接算：`推理块的真实贡献率 = 1 − 模型B的c/模型A的c`。
 *
 * ★ 只读。★ 若两个模型都拟合不好，就如实报"解不出"，不硬给数。
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

/** 窗口内：推理启发式 / 非推理启发式（都用内核口径 4 字符/token + 结构开销）。 */
function heurBetween(lo, hi) {
  let reason = 0, other = 0;
  for (const [seq, ev] of bySeq) {
    if (seq <= lo || seq > hi) continue;
    if (ev.type === "assistant/message") {
      const content = ev.data?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "reasoning") reason += Math.ceil(String(b.text ?? "").length / 4) + 4;
        else if (b?.type === "text") other += Math.ceil(String(b.text ?? "").length / 4) + 4;
        else if (b?.type === "tool-call") other += Math.ceil(String(b.name ?? "").length / 4) + Math.ceil(String(b.arguments ?? "").length / 4) + 4;
        else other += 4 + Math.ceil(JSON.stringify(b).length / 4);
      }
      other += 4;
    } else {
      const c = ev.data?.content ?? ev.data?.message?.content ?? ev.data;
      const s2 = typeof c === "string" ? c : JSON.stringify(c);
      other += Math.ceil(s2.length / 4) + 8;
    }
  }
  return { reason, other };
}

const routes = evs.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => ({ time: e.time, seq: e.seq, p: Number(e.data.usage.inputTokens || 0) + Number(e.data.usage.cacheReadTokens || 0) }))
  .sort((a, b) => a.time - b.time);
const compSeqs = evs.filter((e) => e.type === "compaction/end").map((e) => e.seq).sort((a, b) => a - b);

const S = [];
for (let i = 1; i < routes.length; i += 1) {
  const a = routes[i - 1], b = routes[i];
  if (b.seq - a.seq < 4) continue;
  if (compSeqs.some((s) => s > a.seq && s <= b.seq)) continue;   // 排除压缩窗口
  const h = heurBetween(a.seq, b.seq);
  const d = b.p - a.p;
  if (d <= 0 || h.reason <= 0 || h.other <= 0) continue;
  S.push({ d, r: h.reason, o: h.other });
}

/** 带截距一元最小二乘：y = a + c·x。返回 {a,c,r2}。 */
function ols(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i += 1) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const c = sxy / sxx, a = my - c * mx;
  let sse = 0;
  for (let i = 0; i < n; i += 1) sse += (ys[i] - (a + c * xs[i])) ** 2;
  return { a, c, r2: 1 - sse / syy, rmse: Math.sqrt(sse / n), n };
}

const ys = S.map((s) => s.d);
const A = ols(S.map((s) => (s.r + s.o) / 4), ys);
const B = ols(S.map((s) => s.o / 4), ys);

console.log(`样本（不含压缩的纯增长窗口）：${S.length}\n`);
console.log("═══ 模型 A：内核假设 —— 推理与非推理**同价**（都用 4 字符/token）═══");
console.log(`  Δprompt = ${A.a.toFixed(0)} + ${A.c.toFixed(3)}·(全部字符/4)    R²=${A.r2.toFixed(3)}  RMSE=${A.rmse.toFixed(0)}`);
console.log("\n═══ 模型 B：备择假设 —— **推理不进入真实请求** ═══");
console.log(`  Δprompt = ${B.a.toFixed(0)} + ${B.c.toFixed(3)}·(非推理字符/4)   R²=${B.r2.toFixed(3)}  RMSE=${B.rmse.toFixed(0)}`);
console.log(`\n  ★ 谁拟合更好：A RMSE=${A.rmse.toFixed(0)} vs B RMSE=${B.rmse.toFixed(0)} ⇒ ` +
  (B.rmse < A.rmse ? "**B 更好（推理不贡献）**" : A.rmse < B.rmse ? "**A 更好（同价）**" : "**打平**"));
console.log(`  ★ 由 B 解出：非推理内容的真实 token ≈ 启发式 × ${B.c.toFixed(2)}`);
console.log(`  ★ 推理块的真实贡献率 = ${(1 - B.c / A.c).toFixed(2)}（0 = 完全不贡献，1 = 与启发式同价）`);

// 分层：按推理占比分组看平均兑现率（不依赖任何回归形式）
console.log("\n═══ 分层验证（不依赖回归形式）：按推理占比分桶的平均兑现率 ═══");
const buckets = [[0, .1], [.1, .2], [.2, .3], [.3, .4], [.4, .5], [.5, .6], [.6, .7], [.7, .8], [.8, .9], [.9, 1.01]];
console.log("  推理占比区间    窗口数   平均 推理启发式/总   平均兑现率");
for (const [lo, hi] of buckets) {
  const g = S.filter((s) => { const sh = s.r / (s.r + s.o); return sh >= lo && sh < hi; });
  if (g.length === 0) continue;
  const avgShare = g.reduce((s, x) => s + x.r / (x.r + x.o), 0) / g.length;
  const avgRatio = g.reduce((s, x) => s + x.d / ((x.r + x.o) / 4), 0) / g.length;
  console.log(`  ${(lo * 100).toFixed(0).padStart(3)}~${(hi * 100).toFixed(0).padStart(3)}%  ` +
    `${String(g.length).padStart(9)}  ${(avgShare * 100).toFixed(1).padStart(15)}%  ${avgRatio.toFixed(3).padStart(11)}`);
}
console.log("\n  ★ 若「平均兑现率 ≈ 1 − 平均推理占比」逐桶成立 ⇒ 推理块的真实贡献≈0，机制坐实。");
