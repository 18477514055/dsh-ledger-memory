/**
 * ★★★ 决定性的最后一次核查：把「**压缩本身的效果**」与「**之后被加回来的部分**」分开。
 *
 * 为什么还要再查一次：我上一版拿"压缩前最后一个采样"与"压缩后第一个采样"相减
 * ⇒ 那个差里**混进了**压缩过程中/之后新产出的内容与重注 ⇒ 会**低估**压缩本身的效果。
 *
 * 更接近"压缩本身"的估计量：压缩后 **3 分钟内水位的【最低点】**（即刚刚压完那一刻）。
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
const comps = evs.filter((e) => e.type === "compaction/end")
  .map((e) => ({ time: e.time, shadowed: e.data?.shadowedTokenCount })).sort((a, b) => a.time - b.time);

const FIX = new Date("2026-10-11T03:25:00+08:00").getTime();
console.log("═══ 压缩效果的两种估计 ═══");
console.log("  时刻      压前      压后【最低点】  最低点-压前   压后【首个采样】  首个-压前");
console.log("  " + "-".repeat(84));
for (const c of comps.filter((x) => x.time >= FIX)) {
  const before = [...levels].reverse().find((l) => l.time <= c.time);
  const win = levels.filter((l) => l.time > c.time && l.time <= c.time + 180000);
  if (!before || win.length === 0) continue;
  const min = win.reduce((a, b) => (b.t < a.t ? b : a));
  const first = win[0];
  console.log(
    `  ${hm(c.time)}  ${(before.t / W * 100).toFixed(1)}%  ` +
    `${String((min.t / W * 100).toFixed(1)).padStart(8)}%  ${String(((min.t - before.t) / W * 100).toFixed(1)).padStart(10)}  ` +
    `${String((first.t / W * 100).toFixed(1)).padStart(11)}%  ${String(((first.t - before.t) / W * 100).toFixed(1)).padStart(9)}`
  );
}

// ── 最低点之后又涨回来多少（3 分钟内）─────────────────────────────────────
console.log("\n═══ 压完（最低点）之后 3 分钟内又涨回 ═══");
for (const c of comps.filter((x) => x.time >= FIX)) {
  const before = [...levels].reverse().find((l) => l.time <= c.time);
  const win = levels.filter((l) => l.time > c.time && l.time <= c.time + 180000);
  if (!before || win.length === 0) continue;
  const min = win.reduce((a, b) => (b.t < a.t ? b : a));
  const end = win[win.length - 1];
  console.log(`  ${hm(c.time)}  最低 ${(min.t / W * 100).toFixed(1)}% → 3min后 ${(end.t / W * 100).toFixed(1)}%  = 涨回 ${((end.t - min.t) / W * 100).toFixed(1)} 点`);
}
