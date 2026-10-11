/**
 * ★★★ 只读：把 `compaction/*` 事件的**完整载荷**原样打出来（不做任何解释）。
 *
 * 为什么要这一步：前面几个探针都只取了 `data.shadowedTokenCount` 一个字段就下结论
 * ⇒ **尺子错第 18 次**就是这么来的（拿一个语义不明的字段当"本次折叠量"）。
 * 正确顺序是：**先把载荷完整看一遍，确认每个字段的语义，再选判据。**
 *
 * ★ 纪律：只按 `j.type` 精确匹配；JSON 里的字符串**原样**打印，不截断关键字段。
 *
 * 用法：
 *   node tools/_probe-compaction-payload.mjs            # 只看压缩事件
 *   node tools/_probe-compaction-payload.mjs --level    # 附水位时间线
 *   node tools/_probe-compaction-payload.mjs --since 05:00
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
const text = decodeAll(fs.readFileSync(SESS));
const evs = [];
for (const line of text.split("\n")) { if (line === "") continue; try { evs.push(JSON.parse(line)); } catch {} }

const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(11, 19);
const W = 1000000;

const sinceIdx = process.argv.indexOf("--since");
const since = sinceIdx > 0
  ? new Date(`2026-10-11T${process.argv[sinceIdx + 1]}:00+08:00`).getTime()
  : 0;

// ── 各类 compaction 事件的所有字段名（先看全貌，别只挑一个）────────────────
console.log("═══ compaction 系列事件的类型与字段总览 ═══");
const byType = new Map();
for (const e of evs) {
  if (!String(e.type ?? "").startsWith("compaction/")) continue;
  if (!byType.has(e.type)) byType.set(e.type, { n: 0, keys: new Set(), first: e.time, last: e.time });
  const r = byType.get(e.type);
  r.n += 1; r.last = e.time;
  for (const k of Object.keys(e.data ?? {})) r.keys.add(k);
}
for (const [t, r] of byType) {
  console.log(`  ${t.padEnd(24)} ${String(r.n).padStart(3)} 次  ${hm(r.first)} → ${hm(r.last)}`);
  console.log(`      字段: ${[...r.keys].join(", ") || "(无 data)"}`);
}

// ── 完整载荷（时间倒序，最近的在上面）───────────────────────────────────────
console.log("\n═══ compaction/* 完整载荷（★ 原样，不解释）═══");
const comp = evs.filter((e) => String(e.type ?? "").startsWith("compaction/") && e.time >= since);
for (const e of comp) {
  console.log(`\n──── ${hm(e.time)}  ${e.type} ────`);
  console.log(JSON.stringify(e.data, null, 2));
}

// ── 水位时间线（可选）───────────────────────────────────────────────────────
if (process.argv.includes("--level")) {
  console.log("\n═══ 水位时间线（assistant/message.usage.totalTokens）═══");
  const lv = evs.filter((e) => e.type === "assistant/message" && Number.isFinite(e.data?.usage?.totalTokens))
    .filter((e) => e.time >= since)
    .map((e) => ({ time: e.time, t: e.data.usage.totalTokens })).sort((a, b) => a.time - b.time);
  let prev = undefined;
  for (const l of lv) {
    const d = prev === undefined ? "" : `  Δ${(((l.t - prev) / W) * 100 >= 0 ? "+" : "") + (((l.t - prev) / W) * 100).toFixed(2)}点`;
    console.log(`  ${hm(l.time)}  ${(l.t / W * 100).toFixed(2).padStart(6)}%  ${String(l.t).padStart(8)}${d}`);
    prev = l.t;
  }
}
