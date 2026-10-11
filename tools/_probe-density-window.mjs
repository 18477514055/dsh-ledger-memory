/**
 * ★★★ 用「**纯增长窗口**」解出真实 token 密度 —— 撇开压缩的混淆。
 *
 * ⚠️⚠️ **本探针的两变量部分不可信，已被 `_probe-reasoning-contribution.mjs` 取代。**
 *   保留它是为了**留痕**（我在这里犯过一次尺子错）：
 *     · ② 段的无截距两变量拟合 **R² = −0.101**（负值）⇒ 拟合无效，它给出的
 *       「推理 10.5 字符/token、非推理 40.7 字符/token」**不能当结论用**。
 *     · 原因：无截距 + 误差在自变量（Δprompt 本身有噪声）+ 异方差。
 *     · ① 段的一元回归（带截距，R²=0.448）**仍然有效**，且形态干净：
 *       `兑现率 ≈ 1.01 − 0.98 × 推理占比`。
 *   ⇒ 结论一律以 `_probe-reasoning-contribution.mjs` 的**分层表**为准（不依赖回归形式）。
 *
 * 为什么要换实验：上一版两变量回归**数学写错**（α、β 写成同一个式子）且**共线性退化**，
 *   结果 R² 为负 —— 那是**尺子错**，不是结论。按纪律：先修尺子，再报结论。
 *
 * 本版做法（无压缩参与，因此没有"删掉多少"的混淆）：
 *   取两次相邻的真实路由采样（`assistant/message.usage`），窗口内**没有压缩**。
 *   窗口内新追加的 surface 内容（按 seq 落在两次采样之间）按
 *     「推理块字符 / 非推理块字符」分别累计。
 *   于是  Δprompt ≈ α·推理字符 + β·非推理字符
 *   解出的 α、β 单位是 **token/字符** ⇒ 倒数即"几字符一个真实 token"。
 *
 * ★ 附带**共线性诊断**：报两个回归元的相关系数。若 |r| 很高，
 *   两变量不可分辨 ⇒ 必须**如实说"解不出"**，而不是给出一个看起来精确的假数。
 * ★ 只读。
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
const bySeq = new Map();
for (const e of evs) if (Number.isFinite(e.seq)) bySeq.set(e.seq, e);

/** 一段 seq 区间内：推理字符 / 非推理字符 / 内核启发式 token。 */
function splitCharsBetween(lo, hi) {
  let reasonChars = 0, otherChars = 0, heur = 0;
  for (const [seq, ev] of bySeq) {
    if (seq <= lo || seq > hi) continue;
    if (ev.type === "assistant/message") {
      const content = ev.data?.message?.content;
      if (!Array.isArray(content)) continue;
      let tok = 0;
      for (const b of content) {
        if (b?.type === "reasoning") { const c = String(b.text ?? "").length; reasonChars += c; tok += Math.ceil(c / 4) + 4; }
        else if (b?.type === "text") { const c = String(b.text ?? "").length; otherChars += c; tok += Math.ceil(c / 4) + 4; }
        else if (b?.type === "tool-call") { const c = String(b.name ?? "").length + String(b.arguments ?? "").length; otherChars += c; tok += Math.ceil(String(b.name ?? "").length / 4) + Math.ceil(String(b.arguments ?? "").length / 4) + 4; }
        else { const c = JSON.stringify(b).length; otherChars += c; tok += 4 + Math.ceil(c / 4); }
      }
      heur += tok + 4;
    } else {
      const c = ev.data?.content ?? ev.data?.message?.content ?? ev.data;
      const s2 = typeof c === "string" ? c : JSON.stringify(c);
      otherChars += s2.length; heur += Math.ceil(s2.length / 4) + 4 + 4;
    }
  }
  return { reasonChars, otherChars, heur };
}

// 真实路由采样
const routes = evs.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => ({ time: e.time, seq: e.seq, p: Number(e.data.usage.inputTokens || 0) + Number(e.data.usage.cacheReadTokens || 0) }))
  .sort((a, b) => a.time - b.time);
// 压缩事件所在 seq（窗口里若有压缩，跳过该窗口）
const compSeqs = evs.filter((e) => e.type === "compaction/end").map((e) => e.seq).sort((a, b) => a - b);

const samples = [];
for (let i = 1; i < routes.length; i += 1) {
  const a = routes[i - 1], b = routes[i];
  if (b.seq - a.seq < 4) continue;
  // 跳过含压缩的窗口（那是"删除"，不是"增长"）
  if (compSeqs.some((s) => s > a.seq && s <= b.seq)) continue;
  const sp = splitCharsBetween(a.seq, b.seq);
  const totalChars = sp.reasonChars + sp.otherChars;
  if (totalChars === 0) continue;
  samples.push({ a, b, d: b.p - a.p, ...sp, share: sp.reasonChars / totalChars });
}

// 剔除明显离群（Δprompt 为负得多，说明有缓存/裁剪等其它机制参与）
const keep = samples.filter((s) => s.d > 0 && s.reasonChars > 0 && s.otherChars > 0);
console.log(`样本：总 ${samples.length} · 保留（Δprompt>0 且两类都有）${keep.length}\n`);

// ── 一元：Δprompt / 启发式 = f(推理占比) ───────────────────────────────────
{
  const n = keep.length;
  const mx = keep.reduce((s, x) => s + x.share, 0) / n;
  const my = keep.reduce((s, x) => s + x.d / x.heur, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const x of keep) { const yy = x.d / x.heur; sxy += (x.share - mx) * (yy - my); sxx += (x.share - mx) ** 2; syy += (yy - my) ** 2; }
  const b1 = sxy / sxx, a1 = my - b1 * mx, r2 = (sxy ** 2) / (sxx * syy);
  console.log("═══ ① 一元回归：真实/启发式 = a + b·推理占比 ═══");
  console.log(`  真实兑现率 = ${a1.toFixed(2)} + (${b1.toFixed(2)})·推理占比    R² = ${r2.toFixed(3)}   n = ${n}`);
  console.log(`  ⇒ 推理占比 0% → ${a1.toFixed(2)}；30% → ${(a1 + b1 * .3).toFixed(2)}；60% → ${(a1 + b1 * .6).toFixed(2)}；100% → ${(a1 + b1).toFixed(2)}`);
}

// ── 两变量无截距最小二乘（★ 正确公式）＋ 共线性诊断 ────────────────────────
{
  let Srr = 0, Soo = 0, Sro = 0, Sry = 0, Soy = 0;
  for (const s of keep) {
    Srr += s.reasonChars * s.reasonChars; Soo += s.otherChars * s.otherChars;
    Sro += s.reasonChars * s.otherChars; Sry += s.reasonChars * s.d; Soy += s.otherChars * s.d;
  }
  const det = Srr * Soo - Sro * Sro;
  const alpha = (Sry * Soo - Soy * Sro) / det;
  const beta = (Soy * Srr - Sry * Sro) / det;
  // 两回归元相关系数
  const n = keep.length;
  const mr = keep.reduce((s, x) => s + x.reasonChars, 0) / n;
  const mo = keep.reduce((s, x) => s + x.otherChars, 0) / n;
  let sr = 0, so = 0, sro = 0;
  for (const x of keep) { sr += (x.reasonChars - mr) ** 2; so += (x.otherChars - mo) ** 2; sro += (x.reasonChars - mr) * (x.otherChars - mo); }
  const corr = sro / Math.sqrt(sr * so);

  let sse = 0, sst = 0;
  const myd = keep.reduce((s, x) => s + x.d, 0) / n;
  for (const x of keep) { const pred = alpha * x.reasonChars + beta * x.otherChars; sse += (x.d - pred) ** 2; sst += (x.d - myd) ** 2; }

  console.log("\n═══ ② 两变量无截距最小二乘（修正公式）═══");
  console.log(`  Δprompt = α·推理字符 + β·非推理字符`);
  console.log(`    α = ${alpha.toFixed(6)} token/字符 ⇒ **${(1 / alpha).toFixed(2)} 字符/真实token**`);
  console.log(`    β = ${beta.toFixed(6)} token/字符 ⇒ **${(1 / beta).toFixed(2)} 字符/真实token**`);
  console.log(`  （内核启发式：两者都是 4.00 字符/token）`);
  console.log(`  R² = ${(1 - sse / sst).toFixed(3)}`);
  console.log(`\n  ★★ 共线性诊断：corr(推理字符, 非推理字符) = ${corr.toFixed(3)}`);
  if (Math.abs(corr) > 0.9) {
    console.log(`     |r| > 0.9 ⇒ **两个回归元几乎不可分辨** ⇒`);
    console.log(`     上面那对 α/β **不能当作可靠结论**，只能说"推理占比越高、兑现率越低"。`);
  } else {
    console.log(`     |r| ≤ 0.9 ⇒ 两变量可分辨，α 与 β 可信。`);
  }
}

console.log("\n═══ ③ 直观看几个窗口（按推理占比排序）═══");
console.log("  时间窗                 Δprompt   启发式   兑现率   推理占比   推理字符   非推理字符");
console.log("  " + "-".repeat(96));
for (const s of [...keep].sort((x, y) => y.share - x.share).slice(0, 8)) {
  console.log(
    `  ${hm(s.a.time)}→${hm(s.b.time)}  ${String(s.d).padStart(9)}  ${String(s.heur).padStart(8)}  ` +
    `${(s.d / s.heur).toFixed(2).padStart(7)}  ${(s.share * 100).toFixed(1).padStart(7)}%  ` +
    `${String(s.reasonChars).padStart(10)}  ${String(s.otherChars).padStart(11)}`
  );
}
console.log("\n  ★ 判据：若推理占比高的窗口兑现率明显低 ⇒ 机制成立（相关 + 机制两侧一致）。");
