/**
 * ★★★ 只读：用**真实路由 token**（provider 报的 `usage`）判「一次压缩到底压掉了多少」。
 *
 * 为什么必须换这个尺子：
 *   前面我一直用 `meter.measure().totalTokens`（启发式估算）与
 *   `assistant/message` 的 `usage.totalTokens` 混着比，两个都不是"这次压掉了多少"。
 *   而内核源码（`dsh-token-meter/lib/index.js` L642-684）写得很清楚：
 *
 *       totalTokens = max(0, baseline.tokens + surfaceDeltaTokens)
 *       baseline    = 上次真实请求的 usage（或估算）
 *       surfaceDeltaTokens = 当前 surfaceTokens − 锚点 surfaceTokens
 *
 *   ⇒ 水位**锚在"上次真实请求"上**，压缩只改变"增量"那一半。
 *   ⇒ 要判压缩的实际效果，最直接的是看**压缩后第一次真实请求的 inputTokens**
 *     （provider 自己报的），与压缩前最后一次比。那是"真实的上下文有多长"。
 *
 * 同时把内核自己记的 `shadowedTokenCount`（= 被压节点的 ΣheuristicTokens）并排摆出来，
 * 看它与"真实请求缩小量"是否吻合 —— 这才是判「压缩多有效」的正确比法。
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

const sessArg = process.argv.find((a) => a.startsWith("--sess="));
const SESS = path.join(os.homedir(), ".dsh", "sessions", "--D-Deepseek~5DE5~4F5C~533A--",
  sessArg ? sessArg.slice(7) : "session-fada6e5f-52f2-4a4f-b52a-3c2483db117e", "session.v4.jsonl.zstd");
const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(11, 19);
const sinceIdx = process.argv.indexOf("--since");
const since = sinceIdx > 0 ? new Date(`2026-10-11T${process.argv[sinceIdx + 1]}:00+08:00`).getTime() : 0;

// 真实路由用量（provider 报的），按时间排序
const routes = evs
  .filter((e) => e.type === "assistant/message" && e.data?.usage !== undefined)
  .map((e) => {
    const u = e.data.usage;
    return {
      time: e.time,
      input: Number(u.inputTokens ?? 0),
      output: Number(u.outputTokens ?? 0),
      cacheRead: Number(u.cacheReadTokens ?? 0),
      total: Number(u.totalTokens ?? 0),
      // "这次请求把多长的上下文送进了模型" = input + cacheRead（两者都是 prompt 的一部分）
      prompt: Number(u.inputTokens ?? 0) + Number(u.cacheReadTokens ?? 0),
    };
  })
  .sort((a, b) => a.time - b.time);

// 每次压缩的摘要文本长度（用于估算"换成了多大的摘要"）
const summaries = evs
  .filter((e) => e.type === "compaction/summary")
  .map((e) => ({
    time: e.time,
    id: e.data?.compactionId,
    turn: undefined,
    shadowed: Number(e.data?.shadowedTokenCount ?? 0),
    nodes: Array.isArray(e.data?.shadowedSeqs) ? e.data.shadowedSeqs.length : 0,
    range: e.data?.shadowedRange,
    summaryChars: Array.isArray(e.data?.summary)
      ? e.data.summary.reduce((s, b) => s + String(b?.text ?? "").length, 0)
      : 0,
    outTokens: Number(e.data?.usage?.outputTokens ?? 0),
  }))
  .sort((a, b) => a.time - b.time);

// start 事件给 turn（判"是不是我们发的增量"）
const startsById = new Map();
for (const e of evs) {
  if (e.type === "compaction/start") startsById.set(e.data?.compactionId, e.data);
}

console.log("═══ 每次压缩：真实路由 token 的缩小量 vs 内核自报的 shadowedTokenCount ═══");
console.log("  时刻      turn  压前请求prompt  压后请求prompt  真实缩小   点(1M)   内核自报shadowed  摘要字符  摘要估算tok  自报-真实");
console.log("  " + "-".repeat(126));
for (const s of summaries.filter((x) => x.time >= since)) {
  const st = startsById.get(s.id) ?? {};
  const before = [...routes].reverse().find((r) => r.time <= s.time);
  const after = routes.find((r) => r.time > s.time);
  if (before === undefined || after === undefined) continue;
   const real = before.prompt - after.prompt; // 真实缩小
  const summaryEst = Math.ceil(s.summaryChars / 3.2); // 粗估：中文约 3.2 字符/token
  console.log(
    `  ${hm(s.time)}  ${String(st.turn === null ? "全量" : st.turn).padStart(4)}  ` +
    `${String(before.prompt).padStart(14)}  ${String(after.prompt).padStart(14)}  ` +
    `${String(real).padStart(8)}  ${String((real / 10000).toFixed(1)).padStart(6)}  ` +
    `${String(s.shadowed).padStart(15)}  ${String(s.summaryChars).padStart(8)}  ${String(summaryEst).padStart(10)}  ` +
    `${String(s.shadowed - real).padStart(9)}`
  );
}

console.log("\n  ★ 判据：若「真实缩小」≈「内核自报 shadowed」−「摘要大小」⇒ 压缩本身按设计工作。");
console.log("  ★ 若「真实缩小」远小于「内核自报」⇒ 少掉的那部分**没进请求**（另有所指）或**被别的东西补回**。");

// 每次压缩前后的路由明细（含 cacheRead，排查"缓存命中"造成的假象）
console.log("\n═══ 压缩前后的真实请求明细（input / cacheRead / output / total）═══");
for (const s of summaries.filter((x) => x.time >= since)) {
  const st = startsById.get(s.id) ?? {};
  const i = routes.findIndex((r) => r.time > s.time);
  if (i <= 0) continue;
  console.log(`\n  ── ${hm(s.time)}  turn=${st.turn === null ? "全量" : st.turn}  shadowed=${s.shadowed}  范围=${JSON.stringify(s.range)} ──`);
  for (let k = Math.max(0, i - 3); k <= Math.min(routes.length - 1, i + 2); k += 1) {
    const r = routes[k];
    const mark = k < i ? "压前" : k === i ? "★压后首个" : "     ";
    console.log(`     ${mark} ${hm(r.time)}  input=${String(r.input).padStart(8)}  cacheRead=${String(r.cacheRead).padStart(7)}  output=${String(r.output).padStart(6)}  total=${String(r.total).padStart(8)}  prompt=${String(r.prompt).padStart(8)}`);
  }
}
