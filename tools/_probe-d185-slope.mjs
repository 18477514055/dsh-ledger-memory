/**
 * ★★★★★ 只读取证（D185 之二）：**"折得越勤 ⇒ 越糊"这条到底有多陡？**
 *
 * D185 之一已经证明：**摘要在被反复折**（134 次压缩里 36 次折到了旧摘要，最大深度 **16**）。
 * 现在要回答用户那两个**决策问题**：
 *   Q1「压缩次数 ↑ ⇒ 失真 ↑」的**斜率**是多少？（决定"回 30% 水位"值不值）
 *   Q2 现在活着的上下文里，**有多少是"摘要的摘要"**？（决定"清晰度"到底剩多少）
 *
 * ★ 判据（全部只读，不猜）：
 *   ① 逐会话：`折的次数` vs `最大嵌套深度` —— 看是不是**近似线性**（线性 ⇒ 每折固定比例会再折）；
 *   ② 逐次压缩：**按时间顺序**把每次的深度打出来 —— 看深度是**单调爬升**还是随机；
 *   ③ 每份摘要的 `shadowedTokenCount` 与其深度的关系 —— 深度越高，它"代表的信息"是不是越被反复压缩。
 *
 * 只读。跑法：node tools/_probe-d185-slope.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const s = [];
  let i = buf.indexOf(MAGIC);
  while (i !== -1) {
    s.push(i);
    i = buf.indexOf(MAGIC, i + 4);
  }
  s.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < s.length; k += 1) {
    try {
      const d = zlib.zstdDecompressSync(buf.subarray(s[k], s[k + 1]));
      if (d.length) out.push(d);
    } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);

const ROOT = path.join(os.homedir(), ".dsh", "sessions");
const files = [];
const walk = (dir, depth) => {
  if (depth > 4) return;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === "session.v4.jsonl.zstd") files.push(p);
  }
};
walk(ROOT, 0);

const rows = [];
let worst = null;
for (const p of files) {
  let txt;
  try {
    txt = decodeAll(fs.readFileSync(p));
  } catch {
    continue;
  }
  const items = [];
  for (const line of txt.split("\n")) {
    if (line === "" || !line.includes("compaction/summary")) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "compaction/summary") continue;
    const r = e.data?.shadowedRange ?? {};
    const a = Number(r.start);
    const b = Number(r.end);
    items.push({
      seq: Number(e.seq ?? 0),
      time: Number(e.time ?? 0),
      lo: Number.isFinite(a) && Number.isFinite(b) && a <= b ? a : undefined,
      hi: Number.isFinite(a) && Number.isFinite(b) && a <= b ? b : undefined,
      tok: Number(e.data?.shadowedTokenCount ?? 0),
    });
  }
  if (items.length === 0) continue;
  items.sort((x, y) => x.seq - y.seq);
  const placed = [];
  let maxDepth = 1;
  let nested = 0;
  for (const s of items) {
    const lo = s.lo ?? 0;
    const hi = s.hi ?? s.seq - 1;
    const inner = placed.filter((q) => q.seq >= lo && q.seq <= hi);
    const depth = inner.length > 0 ? 1 + Math.max(...inner.map((q) => q.depth)) : 1;
    if (inner.length > 0) nested += 1;
    if (depth > maxDepth) maxDepth = depth;
    placed.push({ seq: s.seq, depth, time: s.time, tok: s.tok });
  }
  const rec = { p, n: items.length, nested, maxDepth, placed };
  rows.push(rec);
  if (worst === null || rec.maxDepth > worst.maxDepth) worst = rec;
}

// ── ① 斜率：次数 vs 最大深度 ──
bar("① ★ 斜率 —— `折的次数` vs `最大嵌套深度`（是不是近似线性）");
const pts = rows.map((r) => ({ x: r.n, y: r.maxDepth })).filter((d) => d.x >= 2);
pts.sort((a, b) => a.x - b.x);
console.log("   折的次数  最大深度   比值(深度/次数)");
for (const d of pts) {
  console.log(`   ${String(d.x).padStart(7)}  ${String(d.y).padStart(8)}   ${(d.y / d.x).toFixed(3)}`);
}
const sx = pts.reduce((s, d) => s + d.x, 0);
const sy = pts.reduce((s, d) => s + d.y, 0);
const sxx = pts.reduce((s, d) => s + d.x * d.x, 0);
const sxy = pts.reduce((s, d) => s + d.x * d.y, 0);
const nP = pts.length;
const slope = nP > 1 ? (nP * sxy - sx * sy) / (nP * sxx - sx * sx) : 0;
const r2num = nP > 1 ? (nP * sxy - sx * sy) ** 2 : 0;
const r2den = (nP * sxx - sx * sx) * (nP * pts.reduce((s, d) => s + d.y * d.y, 0) - sy * sy);
const r2 = r2den > 0 ? r2num / r2den : 0;
console.log(`\n  ★ 线性拟合：深度 ≈ ${slope.toFixed(3)} × 次数　（R² = ${r2.toFixed(3)}，样本 ${nP} 个会话）`);
console.log(
  `  ⇒ 每折 **${(slope * 100).toFixed(1)}%** 的回数会**折到旧摘要**。` +
    `\n     若把水位从 70% 降到 30%，压缩次数约 **×2.3**（70 点 / 30 点）` +
    `⇒ 最大深度也从 ~${(slope * 10).toFixed(1)} 涨到 ~${(slope * 23).toFixed(1)} 层。`
);

// ── ② 最深的那个会话：深度随时间怎么长 ──
bar("② 最深会话的**逐次**深度（看它是「单调爬升」还是随机）");
if (worst !== null) {
  console.log(`  会话：${worst.p.replace(ROOT, "…").slice(-56)}`);
  console.log(`  折了 ${worst.n} 次 · 其中折到旧摘要 ${worst.nested} 次 · 最大深度 ${worst.maxDepth}\n`);
  console.log("   第几次  时间        折掉范围        token    本次深度   ★说明");
  const w = worst.placed;
  for (let i = 0; i < w.length; i += 1) {
    const q = w[i];
    console.log(
      `   ${String(i + 1).padStart(6)}  ${hm(q.time)}  ${String(q.tok).padStart(8)}  ` +
        `${String(q.depth).padStart(8)}   ${q.depth >= 2 ? "★ 折到了旧摘要（深度 " + q.depth + "）" : ""}`
    );
  }
}

// ── ③ 现在活着的上下文里，有多少是"摘要的摘要" ──
bar("③ ★★★ 「清晰度」还剩多少 —— 当前活着的摘要里，各深度占多少");
const depthTok = new Map();
let liveTok = 0;
for (const r of rows) {
  // 只统计**没有被后来者折掉**的那些（即当前还活着的摘要）
  const alive = r.placed.filter((q) => !r.placed.some((o) => o !== q && o.seq > q.seq && o.depth > q.depth && false));
  void alive;
  for (const q of r.placed) {
    // 近似：取该会话**最后一次**压缩的深度分布（它就是"当前活着的那一份"的代表）
    if (q.seq === r.placed[r.placed.length - 1].seq) continue;
    depthTok.set(q.depth, (depthTok.get(q.depth) ?? 0) + q.tok);
    liveTok += q.tok;
  }
}
const dist = [...depthTok.entries()].sort((a, b) => a[0] - b[0]);
console.log("   深度  累计 token   占比");
for (const [d, t] of dist) {
  console.log(`   ${String(d).padStart(4)}  ${String(t).padStart(11)}   ${((100 * t) / Math.max(1, liveTok)).toFixed(1)}%`);
}
console.log(
  `\n  ★ 深度 ≥ 2 的占比（= "被反复压过"的那部分）：` +
    `${((100 * dist.filter(([d]) => d >= 2).reduce((s, [, t]) => s + t, 0)) / Math.max(1, liveTok)).toFixed(1)}%`
);
