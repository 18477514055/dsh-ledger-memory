/**
 * ★ 纪律第 3 条：「取不到值，先怀疑取法」。
 * _probe-thirdmode-usage.mjs 里 reasoningTokens 读出 0.00 ⇒ 先看 usage 到底有哪些字段。
 * 同时把「上下文构成」按 **surface 事件类型** 重新算一遍（不靠猜测字段名）。
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
const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
const W = 1000000;

console.log("═".repeat(78));
console.log("① usage 到底有哪些字段（取第一个带 usage 的 assistant/message）");
console.log("═".repeat(78));
const withUsage = evs.filter((e) => e.type === "assistant/message" && e.data?.usage);
console.log(`  带 usage 的 assistant/message = ${withUsage.length}`);
const sample = withUsage[withUsage.length - 1];
console.log("  最后一条的 usage 全字段：");
for (const [k, v] of Object.entries(sample.data.usage)) {
  console.log(`    ${k.padEnd(28)} = ${typeof v === "number" ? v.toLocaleString() : JSON.stringify(v).slice(0, 60)}`);
}
const keyHist = new Map();
for (const e of withUsage) for (const k of Object.keys(e.data.usage)) keyHist.set(k, (keyHist.get(k) || 0) + 1);
console.log("\n  字段出现次数（总轮数 = " + withUsage.length + "）：");
for (const [k, c] of [...keyHist].sort((a, b) => b[1] - a[1])) console.log(`    ${String(c).padStart(6)}  ${k}`);
const nonZero = {};
for (const k of keyHist.keys()) {
  const s = withUsage.reduce((a, e) => a + Number(e.data.usage[k] || 0), 0);
  nonZero[k] = s;
}
console.log("\n  各字段会话合计：");
for (const [k, s] of Object.entries(nonZero).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(28)} = ${(s / W).toFixed(3)} 点`);
}

console.log("\n" + "═".repeat(78));
console.log("② 上下文构成：按 **surface 事件类型** 直接称重（chars/4，与内核 estimate 同口径）");
console.log("═".repeat(78));
// surface 节点 = 带 surfaceOp 的那些（含 replace 副本）
const surface = evs.filter((e) => e.surfaceOp !== undefined);
console.log(`  带 surfaceOp 的事件 = ${surface.length}`);
const byType = new Map();
for (const e of surface) {
  const c = JSON.stringify(e.data ?? {}).length;
  const k = e.type;
  if (!byType.has(k)) byType.set(k, { n: 0, chars: 0 });
  const r = byType.get(k); r.n += 1; r.chars += c;
}
let totChars = 0;
for (const [, r] of byType) totChars += r.chars;
for (const [k, r] of [...byType].sort((a, b) => b[1].chars - a[1].chars)) {
  console.log(`  ${k.padEnd(20)} ${String(r.n).padStart(5)} 个  ${String(r.chars).padStart(10)} chars  = ${(100 * r.chars / totChars).toFixed(1)}%  ≈ ${(r.chars / 4 / 1000).toFixed(0)}K tok`);
}
console.log(`  ---- 合计 ${String(totChars).padStart(10)} chars ≈ ${(totChars / 4 / 1000).toFixed(0)}K tok`);

console.log("\n" + "═".repeat(78));
console.log("③ ★ 关键：assistant 里到底有没有「推理过程」留存？");
console.log("═".repeat(78));
const aMsg = surface.filter((e) => e.type === "assistant/message");
let nReason = 0, cReason = 0, cText = 0, cToolCall = 0;
for (const e of aMsg) {
  for (const b of e.data?.message?.content ?? []) {
    const c = JSON.stringify(b).length;
    if (b.type === "reasoning") { nReason += 1; cReason += c; }
    else if (b.type === "text") cText += c;
    else if (b.type === "tool-call") cToolCall += c;
  }
}
console.log(`  assistant surface 节点 = ${aMsg.length}`);
console.log(`  reasoning 块 = ${nReason} 个 / ${cReason} chars ≈ ${(cReason / 4 / 1000).toFixed(0)}K tok`);
console.log(`  text 块                    ${cText} chars ≈ ${(cText / 4 / 1000).toFixed(0)}K tok`);
console.log(`  tool-call 块               ${cToolCall} chars ≈ ${(cToolCall / 4 / 1000).toFixed(0)}K tok`);
if (nReason === 0) console.log("  ★ reasoning 块 = 0 ⇒ 「assistant 占 63.7% 主因是推理」这个说法**取不到证据**，必须重测！");

console.log("\n" + "═".repeat(78));
console.log("④ ★★★ 决定性：一次「重建」要按全价读多少？—— 工具结果的重读量");
console.log("═".repeat(78));
const tr = surface.filter((e) => e.type === "tool/result");
let trChars = 0, trBig = 0, nBig = 0;
for (const e of tr) {
  const c = JSON.stringify(e.data?.message ?? {}).length;
  trChars += c;
  if (c > 8192) { trBig += c; nBig += 1; }   // 内核阈值 thresholdChars = 8192
}
console.log(`  tool/result surface 节点 = ${tr.length}`);
console.log(`  总 chars = ${trChars.toLocaleString()} ≈ ${(trChars / 4 / 1000).toFixed(0)}K tok`);
console.log(`  其中 >8192 chars（够得着 prune 阈值）= ${nBig} 个 / ${trBig.toLocaleString()} chars ≈ ${(trBig / 4 / 1000).toFixed(0)}K tok`);
console.log(`  ⇒ prune 可裁掉的上限 ≈ ${((trBig - nBig * 8192) / 4 / 1000).toFixed(0)}K tok`);
