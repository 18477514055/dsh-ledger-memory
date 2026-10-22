/**
 * 只读：把 `assistant/message.data.usage` 的**两种形态分开**，再谈任何比例。
 *
 * ★ 上一版探针犯的错（尺子错第 N 次）：
 *   我看到「第一条 usage 四字段齐全」，就假设 3077 条**全都是计费记录**。
 *   实测：末尾 40 条只有 `totalTokens` 在涨，其余三字段全 0（turn 76 / step 51..90）。
 *   ⇒ **同一路径下混着两种东西**：「一次调用的计费」与「当前上下文体量」。
 *   纪律 15：**统计某一类东西前，必须先把它与同类但不同源的分开。**
 *
 * 本探针只做分类与核验，**不报任何"省了多少"**。
 *
 * 跑法：node tools/_probe-usage-split.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

const SESS_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");
function findNewest(root) {
  const cands = [];
  (function walk(d, depth) {
    if (depth > 4) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/\.jsonl\.zstd$/.test(e.name)) cands.push({ p, m: fs.statSync(p).mtimeMs });
      }
    } catch {}
  })(root, 0);
  cands.sort((a, b) => b.m - a.m);
  return cands[0]?.p;
}
const FILE = process.env.DSH_SESSION_FILE ?? findNewest(SESS_ROOT);
if (FILE === undefined) { console.log("SKIP"); process.exit(0); }

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const raw = fs.readFileSync(FILE);
const cand = [0];
for (let i = 1; ; ) {
  const p = raw.indexOf(MAGIC, i);
  if (p < 0) break;
  cand.push(p);
  i = p + 4;
}
const texts = [];
for (let k = 0; k < cand.length; k += 1) {
  let out;
  try {
    out = zlib.zstdDecompressSync(raw.subarray(cand[k], k + 1 < cand.length ? cand[k + 1] : raw.length));
  } catch { continue; }
  const s = out.toString("utf8");
  const first = s.split("\n").find((l) => l.trim() !== "");
  if (first === undefined) continue;
  try { JSON.parse(first); } catch { continue; }
  texts.push(s);
}
// ★ 帧边界补换行：否则上一帧末行与下一帧首行会被粘成一行、双双 JSON.parse 失败
const events = [];
for (const s of texts) {
  for (const l of s.split("\n")) {
    if (l.trim() === "") continue;
    try { events.push(JSON.parse(l)); } catch {}
  }
}

const msgs = events.filter((e) => e.type === "assistant/message" && e?.data?.usage);
console.log(`assistant/message 带 usage：${msgs.length} 条`);
console.log(`seq 范围 ${msgs[0]?.seq} … ${msgs[msgs.length - 1]?.seq}\n`);

// ── 1. 按「字段组合」分组 ──
const combos = new Map();
for (const m of msgs) {
  const k = Object.keys(m.data.usage).sort().join("+");
  combos.set(k, (combos.get(k) ?? 0) + 1);
}
console.log("═══ 字段组合分布 ═══");
for (const [k, n] of [...combos.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)} × [${k || "(空)"}]`);
}
console.log("");

// ── 2. 只取「四个字段都在」的那种 = 计费记录 ──
const bill = msgs.filter((m) => {
  const u = m.data.usage;
  return "inputTokens" in u && "outputTokens" in u && "cacheReadTokens" in u && "totalTokens" in u;
});
console.log(`═══ 四字段齐全（计费记录）：${bill.length} 条 ═══`);
let ok = 0, bad = 0, badSample = null;
for (const m of bill) {
  const u = m.data.usage;
  const n = u.inputTokens + u.cacheReadTokens + u.outputTokens;
  if (u.totalTokens === n) ok += 1;
  else { bad += 1; if (badSample === null) badSample = { seq: m.seq, turn: m.data.turn, step: m.data.step, usage: u }; }
}
console.log(`  恒等式成立 ${ok} · 不成立 ${bad}`);
if (badSample !== null) console.log(`  反例: ${JSON.stringify(badSample)}`);
console.log("");

// ── 3. 计费记录的时序走势（最后 30 条）──
const tail = bill.slice(-30);
console.log("═══ 计费记录最后 30 条 ═══");
console.log("   seq turn step     input  cacheRead    output     total   命中%");
let prevCr = null;
for (const m of tail) {
  const u = m.data.usage;
  const denom = u.inputTokens + u.cacheReadTokens;
  const rate = denom > 0 ? ((u.cacheReadTokens / denom) * 100).toFixed(1) : "-";
  console.log(
    `  ${String(m.seq).padStart(5)} ${String(m.data.turn ?? "?").padStart(4)} ${String(m.data.step ?? "?").padStart(4)}` +
    ` ${String(u.inputTokens).padStart(9)} ${String(u.cacheReadTokens).padStart(10)} ${String(u.outputTokens).padStart(9)}` +
    ` ${String(u.totalTokens).padStart(9)} ${String(rate).padStart(6)}`
  );
  prevCr = u.cacheReadTokens;
}
console.log("");

// ── 4. 计费记录累计 ──
let sumIn = 0, sumCr = 0, sumOut = 0;
for (const m of bill) {
  const u = m.data.usage;
  sumIn += u.inputTokens; sumCr += u.cacheReadTokens; sumOut += u.outputTokens;
}
console.log("═══ 计费记录累计 ═══");
console.log(`  input     ${sumIn.toLocaleString("en-US")}`);
console.log(`  cacheRead ${sumCr.toLocaleString("en-US")}`);
console.log(`  output    ${sumOut.toLocaleString("en-US")}`);
console.log(`  命中率    ${((sumCr / (sumIn + sumCr)) * 100).toFixed(2)}%`);
console.log("");

// ── 5. 「只有 totalTokens」的那一类：它到底是什么 ──
const ctxOnly = msgs.filter((m) => {
  const u = m.data.usage;
  return !("inputTokens" in u) && !("cacheReadTokens" in u) && !("outputTokens" in u);
});
if (ctxOnly.length > 0) {
  console.log(`═══ 只有 totalTokens 的那一类：${ctxOnly.length} 条 ═══`);
  const t0 = ctxOnly[0], t1 = ctxOnly[ctxOnly.length - 1];
  console.log(`  首条 seq=${t0.seq} turn=${t0.data.turn} step=${t0.data.step} totalTokens=${t0.data.usage.totalTokens}`);
  console.log(`  末条 seq=${t1.seq} turn=${t1.data.turn} step=${t1.data.step} totalTokens=${t1.data.usage.totalTokens}`);
  // 是否单调递增（同一回合内）
  let nonMono = 0;
  for (let i = 1; i < ctxOnly.length; i += 1) {
    if (ctxOnly[i].data.usage.totalTokens < ctxOnly[i - 1].data.usage.totalTokens) nonMono += 1;
  }
  console.log(`  非单调递增次数：${nonMono} / ${ctxOnly.length - 1}`);
  // 它跟 turn 的关系
  const turns = new Set(ctxOnly.map((m) => m.data.turn));
  console.log(`  覆盖 turn 数：${turns.size}`);
}
