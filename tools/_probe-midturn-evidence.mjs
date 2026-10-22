/**
 * 只读：**回合内压缩（auto:midturn）到底发生过没有？**
 *
 * 用户报的现象：模型推进到 ~70% 就停，然后触发**回合末**压缩，需要手动敲「继续」。
 * 而设计意图（D244 用户原话）是：干到 70%+ → 补义务 → **回合内**压缩 → 压完继续干。
 *
 * ★ 这个探针只回答三件事，**不做推断**：
 *   ① 日志里有没有 `auto:midturn` 这个来源的压缩？（有 = 机制跑通过；没有 = 从没跑通）
 *   ② 所有 `compaction/start` 的来源分布是什么？（回合内 vs 回合末 vs 官方）
 *   ③ 压缩前后的水位与 seq 是什么？（看它到底发生在"回合中"还是"回合末"）
 *
 * ★ 判据：**来源看 `compaction/start` 事件里的 source 字段**，不靠关键词猜。
 *   如果 source 字段根本不存在，就原样打印事件形状（不许自己编一个字段名）。
 *
 * 跑法：node tools/_probe-midturn-evidence.mjs
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
if (FILE === undefined) {
  console.log("SKIP 没有会话文件");
  process.exit(0);
}

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
  } catch {
    continue;
  }
  const s = out.toString("utf8");
  const first = s.split("\n").find((l) => l.trim() !== "");
  if (first === undefined) continue;
  try {
    JSON.parse(first);
  } catch {
    continue;
  }
  texts.push(s);
}

const events = [];
for (const l of texts.join("").split("\n")) {
  if (l.trim() === "") continue;
  try {
    events.push(JSON.parse(l));
  } catch {}
}
console.log(`事件 ${events.length} 条\n`);

// ── ① 所有 compaction 相关事件的类型分布 ──
const types = new Map();
for (const e of events) {
  const t = e?.type;
  if (typeof t === "string" && t.includes("compaction")) types.set(t, (types.get(t) ?? 0) + 1);
}
console.log("═══ ① compaction 相关事件类型分布 ═══");
for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${t}`);
if (types.size === 0) console.log("  （一条都没有）");

// ── ② compaction/start 的 source 分布（这是判"谁压的"的唯一硬证据）──
const starts = events.filter((e) => e?.type === "compaction/start");
console.log(`\n═══ ② compaction/start 共 ${starts.length} 次 ═══`);
if (starts.length > 0) {
  // ★ 先原样看一次事件形状，确认字段名（不许猜）
  console.log("  首条事件形状（原样）：");
  console.log(`    ${JSON.stringify(starts[0]).slice(0, 600)}`);
  console.log("");
  const bySrc = new Map();
  for (const s of starts) {
    // ★ 来源可能在 data.source 或 data.source.kind 或 data.plugin 等位置 —— 逐个试，取第一个命中的
    const d = s?.data ?? {};
    const cands = [
      d.source?.kind,
      d.source?.plugin,
      typeof d.source === "string" ? d.source : undefined,
      d.plugin,
      d.kind,
      d.reason,
      d.trigger,
      d.by,
    ].filter((x) => typeof x === "string" && x !== "");
    const key = cands.length > 0 ? cands[0] : "(找不到来源字段)";
    bySrc.set(key, (bySrc.get(key) ?? 0) + 1);
  }
  for (const [k, n] of [...bySrc.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  }
}

// ── ③ 每次压缩的前后水位（看它发生在"回合中"还是"回合末"）──
console.log(`\n═══ ③ 每次压缩的水位（summary 事件上的 usage）═══`);
const sums = events.filter((e) => e?.type === "compaction/summary");
console.log(`  compaction/summary 共 ${sums.length} 次`);
for (const s of sums.slice(-15)) {
  const d = s?.data ?? {};
  const src = d.source?.kind ?? d.source?.plugin ?? d.plugin ?? d.trigger ?? d.reason ?? "?";
  const u = d.usage ?? d.after ?? {};
  const tot = u.totalTokens ?? u.input;
  const ratio = typeof tot === "number" ? `${(tot / 1000000 * 100).toFixed(1)}%` : "?";
  const range = d.shadowedRange;
  const seqs = Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs.length : "?";
  console.log(`  seq=${String(s.seq).padStart(6)}  来源=${String(src).padEnd(18)} 水位=${ratio.padStart(6)}  吞掉=${seqs} 个节点  range=${range ? `${range.start}→${range.end}` : "?"}`);
}

// ── ④ ★ 直接找 auto:midturn 这个词（我们写的来源标记）──
const rawJoined = texts.join("");
const midturnHits = rawJoined.split("\n").filter((l) => l.includes("auto:midturn"));
console.log(`\n═══ ④ 全日志里含 "auto:midturn" 的行：${midturnHits.length} 条 ═══`);
if (midturnHits.length > 0) {
  for (const l of midturnHits.slice(0, 10)) {
    try {
      const o = JSON.parse(l);
      console.log(`  seq=${o?.seq} type=${o?.type}  ${JSON.stringify(o?.data).slice(0, 200)}`);
    } catch {
      console.log(`  ${l.slice(0, 200)}`);
    }
  }
} else {
  console.log("  ★ 一条都没有 ⇒ 回合内压缩的**成功记账**从未落盘过。");
}
