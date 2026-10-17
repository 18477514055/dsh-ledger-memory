/**
 * ★★★★★ 只读取证（D185）：**压缩失真，到底随什么累积？**
 *
 * 用户本轮原话（逐字）：
 *   *"无论是我最开始提的想法，还是 birlion 的参考，本质都是一个问题，
 *     压缩的单元越小，压缩的次数越多，失真率就越高。"*
 *
 * ★ 这条规律我**倾向于同意**，但要先量出来，并且分清"**次数**"与"**深度**"——
 *   两者在数学上不是一回事：
 *     · **次数**：一共折了几回（折 100 回，但每回折掉的东西**永久离开**）⇒ 每份内容只被折 **1 次**；
 *     · **深度**：某份内容**在上下文里活着时**被折了几回 ⇒ 可能被折 **10 次**。
 *   ⇒ 若失真 ∝ **深度** ⇒ "低水位⇒折得勤"**未必**更糟（折得勤但每次浅，且旧内容被换出）；
 *     若失真 ∝ **次数** ⇒ 用户说对了，压缩体系确实救不回来。
 *
 * ★★★ 核心判据：**后一次压缩折掉的范围内，有没有包含前一次的"摘要节点"** ——
 *   有 ⇒ 摘要在被反复折（深度 ≥ 2）⇒ 失真累积**机制上成立**；
 *   没有 ⇒ 每次折的都是原始历史 ⇒ 该规律不成立（那要改结论）。
 *
 * ⚠️ ★ 上一版这里**我自己把探针写崩了**（`FATAL ERROR: heap out of memory`）：
 *   它把 **200 个会话日志的全部事件**都留在内存里（`allEvs.push({p, evs})`）。
 *   ⇒ 纪律 6：**夹具故障绝不能当成被测对象的问题** —— 改成**逐个会话处理、只留必要字段**。
 *
 * 只读：不写盘、不改 state、官方 sessions 只解压读。
 * 跑法：node tools/_probe-d185-compaction-depth.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** 解出**全部 zstd 帧**（单帧解压只拿到第一段 —— 本机已验）。 */
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
console.log(`扫到 ${files.length} 个会话日志（**逐个处理，不再全量驻留内存**）`);

/**
 * 逐个会话提取**只需要的字段**，处理完立即释放。
 * @returns {{summaries:Array, ends:number, times:number[], sample:object|undefined}}
 */
function scanOne(p) {
  let txt;
  try {
    txt = decodeAll(fs.readFileSync(p));
  } catch {
    return null;
  }
  const summaries = [];
  let ends = 0;
  let tMin = Infinity;
  let tMax = -Infinity;
  let sample;
  for (const line of txt.split("\n")) {
    if (line === "") continue;
    // ★ 先用字符串粗筛，避免把每个事件都 JSON.parse（200 份日志里绝大多数不是我们要的）
    if (!line.includes("compaction/")) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Number(e.time ?? 0);
    if (t > 0) {
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
    if (e.type === "compaction/end") ends += 1;
    if (e.type === "compaction/summary") {
      if (sample === undefined) sample = e;
      const r = e.data?.shadowedRange ?? e.data?.shadowed;
      const a = Number(r?.start ?? r?.from ?? (Array.isArray(r) ? r[0] : NaN));
      const b = Number(r?.end ?? r?.to ?? (Array.isArray(r) ? r[1] : NaN));
      summaries.push({
        seq: Number(e.seq ?? 0),
        lo: Number.isFinite(a) && Number.isFinite(b) && a <= b ? a : undefined,
        hi: Number.isFinite(a) && Number.isFinite(b) && a <= b ? b : undefined,
      });
    }
  }
  if (summaries.length === 0) return null;
  return {
    summaries,
    ends,
    times: tMin === Infinity ? [] : [tMin, tMax],
    sample,
  };
}

// ── ① 尺子先验：`compaction/summary` 的真实形状（顺便验证取法）──
bar("① 尺子先验 —— `compaction/summary` 的真实载荷（一条原样打印）");
let sampleShown = false;
const rows = [];
let totBytes = 0;
for (const p of files) {
  let r = null;
  try {
    r = scanOne(p);
  } catch {
    continue;
  }
  if (r === null) continue;
  totBytes += 0;
  if (!sampleShown && r.sample !== undefined) {
    const d = r.sample.data ?? {};
    console.log(`  顶层字段：${Object.keys(r.sample).join(", ")}`);
    console.log(`  data 字段：${Object.keys(d).join(", ")}`);
    for (const k of Object.keys(d)) {
      const v = d[k];
      const t = typeof v;
      const brief =
        t === "string"
          ? `"${v.slice(0, 80).replace(/\n/g, "\\n")}…"(${v.length} 字符)`
          : t === "object" && v !== null
            ? JSON.stringify(v).slice(0, 200)
            : String(v);
      console.log(`    · ${k} : ${t} = ${brief}`);
    }
    sampleShown = true;
  }

  // ── 深度：某次压缩折掉的范围里，有没有**更早的摘要节点** ──
  const placed = [];
  let nested = 0;
  let rangeValid = 0;
  let maxDepth = 1;
  for (const s of r.summaries) {
    const lo = s.lo ?? 0;
    const hi = s.hi ?? s.seq - 1;
    if (s.lo !== undefined) rangeValid += 1;
    const inner = placed.filter((q) => q.seq >= lo && q.seq <= hi);
    const depth = inner.length > 0 ? 1 + Math.max(...inner.map((q) => q.depth)) : 1;
    if (inner.length > 0) nested += 1;
    if (depth > maxDepth) maxDepth = depth;
    placed.push({ seq: s.seq, depth });
  }
  const durH = r.times.length > 1 ? (r.times[1] - r.times[0]) / 3600000 : 0;
  rows.push({
    p,
    nSum: r.summaries.length,
    nEnd: r.ends,
    nested,
    rangeValid,
    maxDepth,
    durH,
    first: r.times.length ? hm(r.times[0]) : "?",
  });
}

// ── ② 逐会话表 ──
bar("② 逐会话：折了几回 · 其中折到旧摘要的（⇒ 深度 ≥ 2）· 最大嵌套深度");
rows.sort((a, b) => b.nSum - a.nSum);
console.log("   折的次数  折到旧摘要  范围可解析  最大深度  跨度(h)  会话");
for (const r of rows.slice(0, 18)) {
  console.log(
    `   ${String(r.nSum).padStart(7)}  ${String(r.nested).padStart(10)}  ` +
      `${String(r.rangeValid).padStart(10)}  ${String(r.maxDepth).padStart(8)}  ` +
      `${r.durH.toFixed(1).padStart(7)}  ${r.p.replace(ROOT, "…").slice(-52)}`
  );
}

// ── ③ 汇总 ──
bar("③ ★★★ 汇总 —— 用户那条规律成不成立");
const tot = rows.reduce((s, r) => s + r.nSum, 0);
const totNest = rows.reduce((s, r) => s + r.nested, 0);
const deepest = rows.reduce((m, r) => Math.max(m, r.maxDepth), 1);
const anyNested = rows.filter((r) => r.nested > 0);
console.log(`  含压缩的会话：${rows.length} 个 · 累计折了 ${tot} 次（单会话最多 ${rows[0]?.nSum ?? 0} 次）`);
console.log(
  `  ★ 其中**折到了旧摘要**（⇒ 深度 ≥ 2）的：${totNest} 次` +
    `（占 ${(100 * totNest / Math.max(1, tot)).toFixed(1)}%）· 出现在 ${anyNested.length} 个会话里`
);
console.log(`  ★ 全库最大嵌套深度：${deepest}`);
console.log(
  "\n  ★ 读法：\n" +
    "   · `折到旧摘要` > 0 ⇒ **摘要在被反复折** ⇒ 用户那条规律**机制上成立**（且已量化）；\n" +
    "   · = 0 ⇒ 每次折的都是原始历史、摘要本身从不被再折 ⇒ 该规律不成立（那要改结论）。"
);
