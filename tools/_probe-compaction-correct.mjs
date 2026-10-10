/**
 * ★★★ 决定性质疑自己的结论：那个「每轮净降仅 4.5 点」会不会是**采样距离**造成的假象？
 *
 * 已观测到的事实：本机 agent 增长极快 —— 05:39:52→05:39:58 六秒涨了 16K（1.6 点）。
 * 而我的"压前"参考点取自压缩完成前 13~87 秒 ⇒ 那段时间它可能已经涨了很多
 * ⇒ **把"压前"低估了** ⇒ 压降被**看起来变小**。
 *
 * 做法：用压缩前 60 秒的**局部斜率**外推到压缩时刻，算出"若不压缩、那一刻会是多少"，
 * 再与压缩后首个采样比。这才更接近"压缩真正压掉了多少"。
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
const sums = evs.filter((e) => e.type === "compaction/summary")
  .map((e) => ({ time: e.time, shadowed: e.data?.shadowedTokenCount })).sort((a, b) => a.time - b.time);

const FIX = new Date("2026-10-11T03:25:00+08:00").getTime();
console.log("═══ 用「局部斜率外推」校正后的压降 ═══");
console.log("  时刻     前采样距压缩  前60s斜率/token每秒  外推到压缩刻   压后首采样  校正后压降  朴素压降");
console.log("  " + "-".repeat(104));
for (const s of sums.filter((x) => x.time >= FIX)) {
  const prev = [...levels].reverse().find((l) => l.time <= s.time);
  const after = levels.find((l) => l.time > s.time);
  if (!prev || !after) continue;
  // 前 60 秒的斜率
  const win = levels.filter((l) => l.time >= prev.time - 60000 && l.time <= prev.time);
  let slope = 0;
  if (win.length >= 2) {
    const a = win[0], b = win[win.length - 1];
    if (b.time > a.time) slope = (b.t - a.t) / ((b.time - a.time) / 1000);
  }
  const dt = (s.time - prev.time) / 1000;
  const extrap = prev.t + slope * dt;
  const naive = prev.t - after.t;
  const corrected = extrap - after.t;
  console.log(
    `  ${hm(s.time)}  ${String(dt.toFixed(0)).padStart(9)}s  ${String(Math.round(slope)).padStart(18)}  ` +
    `${String(extrap).padStart(12)}  ${String(after.t).padStart(10)}  ` +
    `${String(((corrected) / W * 100).toFixed(1) + " 点").padStart(10)}  ${String(((naive) / W * 100).toFixed(1) + " 点").padStart(8)}`
  );
}
console.log("\n  ★ 若「校正后压降」接近 9~10 点 ⇒ 说明我先前报的 4.5 点是**采样距离造成的假象**。");
