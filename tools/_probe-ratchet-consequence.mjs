/**
 * ★★★ 最后一步：把「每轮净降不足」换算成**实际后果** ——
 * 棘轮每轮回合后水位**净涨多少**？与设计意图差多少？
 *
 * 设计意图（代码 L9469 注释）：
 *   触发线 20 点、每轮压掉 10 点 ⇒ **每轮净涨 10 点** ⇒ 20%→70% 需约 5 轮
 * 实测：每轮净涨 ≈17 点 ⇒ 20%→70% 需约 3 轮 ⇒ **爬升比设计快约 1.7 倍**
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
const text = decodeAll(fs.readFileSync(SESS));
const evs = [];
for (const line of text.split("\n")) { if (line === "") continue; try { evs.push(JSON.parse(line)); } catch {} }
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(11, 19);
const W = 1000000;

const levels = evs.filter((e) => e.type === "assistant/message" && Number.isFinite(e.data?.usage?.totalTokens))
  .map((e) => ({ time: e.time, t: e.data.usage.totalTokens })).sort((a, b) => a.time - b.time);

// 每次增量压缩的"压后"水位
const FIX = new Date("2026-10-11T03:40:00+08:00").getTime();
const comps = evs.filter((e) => e.type === "compaction/end" && e.time >= FIX).map((e) => e.time).sort((a, b) => a - b);

const after = [];
for (const c of comps) {
  const a = levels.find((l) => l.time > c);
  if (a) after.push({ at: c, level: a.t });
}
console.log("═══ 每次增量压缩后的水位（爬升轨迹）═══");
for (const x of after) console.log(`  ${hm(x.at)}  压后 ${(x.level / W * 100).toFixed(1)}%`);

console.log("\n═══ 每轮「净涨」= 这轮的压后 → 下轮的压前 ═══");
let sumNet = 0, n = 0;
for (let i = 1; i < after.length; i += 1) {
  const prevAfter = after[i - 1].level;
  const beforeNext = [...levels].reverse().find((l) => l.time <= after[i].at)?.t ?? 0;
  const net = beforeNext - prevAfter;
  sumNet += net; n += 1;
  console.log(`  第 ${i} 轮：${(prevAfter / W * 100).toFixed(1)}% → ${(beforeNext / W * 100).toFixed(1)}%  = 净涨 ${(net / W * 100).toFixed(1)} 点`);
}
if (n > 0) {
  console.log(`\n  ★ 实测每轮净涨 ≈ ${(sumNet / n / W * 100).toFixed(1)} 点`);
  console.log(`  ★ 设计意图每轮净涨 = 触发 20 − 压掉 10 = **10 点**`);
  console.log(`  ⇒ 实际爬升速度是设计的 **${((sumNet / n / W * 100) / 10).toFixed(2)} 倍**`);
  console.log(`  ⇒ 20%→70% 按设计需 5 轮，实际约 **${Math.ceil(50 / (sumNet / n / W * 100))} 轮**`);
}

// ── 全会话整体：压缩总量 vs 会话总量 ─────────────────────────────────────
console.log("\n═══ 全会话总账（10-08 起）═══");
const all = evs.filter((e) => e.type === "compaction/end").map((e) => e.time).sort((a, b) => a - b);
const first = levels[0], last = levels[levels.length - 1];
console.log(`  压缩 ${all.length} 次`);
console.log(`  水位 ${(first.t / W * 100).toFixed(1)}% → ${(last.t / W * 100).toFixed(1)}%（跨 ${((last.time - first.time) / 3600000).toFixed(1)} 小时）`);
console.log(`  会话累计增长（估算）≈ ${((last.t - first.t) / W * 100).toFixed(0)} 点 + 被压掉的量`);
