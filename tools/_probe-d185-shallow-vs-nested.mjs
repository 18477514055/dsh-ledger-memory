/**
 * ★★★★★ 只读取证（D185 之三）：**"折得浅"与"被反复折"是不是同一件事？**
 *
 * 线索（D185 之二，最深那个会话的逐次表）：深度 ≥ 2 的那些压缩，
 * `shadowedTokenCount` **都是 9 万 / 6 万 / 2 万 量级**；
 * 而 40~60 万那种**深压，深度全部 = 1**（从不被再折）。
 *
 * ★ 若这条成立，它就是用户那个决策问题的**直接答案**：
 *   "低水位 ⇒ 每次折得浅 ⇒ 折下来的正是**最容易被再折**的那一类"
 *   ⇒ 想靠"压得早"省成本，代价是**主动去生产深度 ≥2 的摘要**。
 *
 * ★ 判据：把**全部会话的全部压缩**汇到一起，按 `shadowedTokenCount` 分桶，
 *   统计每个桶里深度 ≥ 2 的比例。**不看单会话**（那才有统计力）。
 *
 * 只读。跑法：node tools/_probe-d185-shallow-vs-nested.mjs
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

/** 全部会话的每一次压缩：{tok, depth} */
const all = [];
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
      lo: Number.isFinite(a) && Number.isFinite(b) && a <= b ? a : undefined,
      hi: Number.isFinite(a) && Number.isFinite(b) && a <= b ? b : undefined,
      tok: Number(e.data?.shadowedTokenCount ?? 0),
    });
  }
  if (items.length === 0) continue;
  items.sort((x, y) => x.seq - y.seq);
  const placed = [];
  for (const s of items) {
    const lo = s.lo ?? 0;
    const hi = s.hi ?? s.seq - 1;
    const inner = placed.filter((q) => q.seq >= lo && q.seq <= hi);
    const depth = inner.length > 0 ? 1 + Math.max(...inner.map((q) => q.depth)) : 1;
    placed.push({ seq: s.seq, depth });
    all.push({ tok: s.tok, depth, validRange: s.lo !== undefined });
  }
}

bar(`① 全库共 ${all.length} 次压缩 —— 按「这次折掉多少 token」分桶，看深度 ≥2 的比例`);
const buckets = [
  [0, 50000, "≤5 万"],
  [50000, 100000, "5~10 万"],
  [100000, 200000, "10~20 万"],
  [200000, 350000, "20~35 万"],
  [350000, 500000, "35~50 万"],
  [500000, Infinity, "≥50 万（深压）"],
];
console.log("   折掉量级        次数   其中深度≥2   占比");
for (const [lo, hi, label] of buckets) {
  const inB = all.filter((x) => x.tok >= lo && x.tok < hi);
  const deep = inB.filter((x) => x.depth >= 2).length;
  const pct = inB.length ? ((100 * deep) / inB.length).toFixed(1) + "%" : "—";
  console.log(`   ${label.padEnd(14)}  ${String(inB.length).padStart(5)}  ${String(deep).padStart(10)}   ${pct}`);
}

bar("② ★★★ 关键对照：深度 ≥2 的那些，平均折掉多少 token？");
const deepOnes = all.filter((x) => x.depth >= 2);
const shallowOnes = all.filter((x) => x.depth === 1);
const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, x) => s + x.tok, 0) / arr.length) : 0);
const med = (arr) => {
  if (!arr.length) return 0;
  const v = arr.map((x) => x.tok).sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};
console.log(`  深度 ≥2 （被反复折过）：${String(deepOnes.length).padStart(4)} 次 · 平均 ${avg(deepOnes).toLocaleString()} token · 中位 ${med(deepOnes).toLocaleString()}`);
console.log(`  深度 =1 （一次到位）：${String(shallowOnes.length).padStart(4)} 次 · 平均 ${avg(shallowOnes).toLocaleString()} token · 中位 ${med(shallowOnes).toLocaleString()}`);
const ratio = med(shallowOnes) / Math.max(1, med(deepOnes));
console.log(`\n  ⇒ 深度 1 的压缩，**中位折掉量是深度 ≥2 的 ${ratio.toFixed(1)} 倍**`);
console.log(
  "  ★ 读法：\n" +
    "   · 若差距很大 ⇒ 「折得浅」与「被反复折」**是同一件事** ——\n" +
    "     即：低水位不但没省，反而**专门生产深度 ≥2 的摘要**（每折浅、每折都被再折）；\n" +
    "   · 若差距不大 ⇒ 深度与折多少无关，得另找机制（那要改结论）。"
);
