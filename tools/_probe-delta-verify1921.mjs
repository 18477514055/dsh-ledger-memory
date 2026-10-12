/**
 * ★★★ 只读：核实 **19:21:07 那次「21.4 点」** —— 它比另外三次大一倍，可疑。
 * 按纪律第 7 条：**结论与自己已手工验证过的事实冲突时，先怀疑尺子**。
 *
 * 三种可能：
 *   A. 它真是"增量"且真压了 21 点（那为什么别的只有 4~5？）
 *   B. 它其实是别的原因掉的（例如同时发生了**全量**，或水位本来就虚高）
 *   C. 我的"压前/压后"取样取错了（压前取了太早的一条）
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
evs.sort((a, b) => a.seq - b.seq);
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);
const WIN = 1000000;

const TARGET = new Date(2026, 9, 10, 19, 21, 7).getTime();  // 10-10 19:21:07 本地
const routes = evs.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => ({ seq: e.seq, at: e.time, total: Number(e.data.usage.totalTokens || 0) }))
  .sort((a, b) => a.at - b.at);

console.log("═".repeat(88));
console.log("① 19:21:07 前后 **逐条** 水位（±8 分钟）—— 看它到底是怎么掉的");
console.log("═".repeat(88));
const lo = TARGET - 8 * 60000, hi = TARGET + 8 * 60000;
console.log("  时刻        seq     total(点)   相对目标时刻");
console.log("  " + "-".repeat(60));
for (const r of routes) {
  if (r.at < lo || r.at > hi) continue;
  const rel = r.at < TARGET ? `压前 ${((TARGET - r.at) / 1000).toFixed(0)}s` : `压后 ${((r.at - TARGET) / 1000).toFixed(0)}s`;
  console.log(`  ${hm(r.at)}  ${String(r.seq).padStart(6)}  ${(r.total / WIN * 100).toFixed(1).padStart(9)}   ${rel}`);
}

console.log("\n" + "═".repeat(88));
console.log("② 那一刻前后，**所有**压缩事件（不只增量）");
console.log("═".repeat(88));
for (const e of evs) {
  if (!/^compaction\//.test(e.type)) continue;
  if (Math.abs(e.time - TARGET) > 10 * 60000) continue;
  const summary = e.type === "compaction/summary"
    ? `shadowed=${e.data?.shadowedSeqs?.length} tok=${e.data?.shadowedTokenCount} range=${JSON.stringify(e.data?.shadowedRange)}`
    : JSON.stringify(e.data ?? {}).slice(0, 100);
  console.log(`  ${hm(e.time)}  ${e.type.padEnd(20)}  ${summary}`);
}

console.log("\n" + "═".repeat(88));
console.log("③ 关键：那次的 `shadowedRange` 与**后续**压缩有没有重叠（即被压两次）");
console.log("═".repeat(88));
const all = evs.filter((e) => e.type === "compaction/summary");
for (const c of all) {
  const r = c.data?.shadowedRange;
  if (r === undefined) continue;
  const near = Math.abs(c.time - TARGET) < 10 * 60000;
  console.log(`  ${near ? "★" : " "} ${hm(c.time)}  range=${r.start}-${r.end}  tok=${c.data?.shadowedTokenCount}  nodes=${c.data?.shadowedSeqs?.length}`);
}
console.log("");
console.log("  ★ 若那次 range 与**紧邻的下一次**有重叠 ⇒ 水位掉得多是「重叠压」，不是「增量更有效」。");

console.log("\n" + "═".repeat(88));
console.log("④ 判据：**「压前」到底该取哪一条**（这是本次最可能的尺子错）");
console.log("═".repeat(88));
const beforeAll = routes.filter((r) => r.at <= TARGET);
const afterAll = routes.filter((r) => r.at > TARGET);
const b1 = beforeAll[beforeAll.length - 1];
const b2 = beforeAll[beforeAll.length - 2];
const a1 = afterAll[0];
console.log(`  压前最后一条  ：${hm(b1.at)}  ${(b1.total / WIN * 100).toFixed(1)} 点`);
console.log(`  压前倒数第二条：${hm(b2.at)}  ${(b2.total / WIN * 100).toFixed(1)} 点`);
console.log(`  压后第一条    ：${hm(a1.at)}  ${(a1.total / WIN * 100).toFixed(1)} 点`);
console.log("");
console.log(`  ⇒ 用「最后一条」算实绩 = ${((b1.total - a1.total) / WIN * 100).toFixed(1)} 点`);
console.log(`  ⇒ 用「倒数第二条」算实绩 = ${((b2.total - a1.total) / WIN * 100).toFixed(1)} 点`);
console.log("");
console.log("  ★ 判据：压缩的**真正「压前」**应该是**紧邻压缩之前的那一次请求** ——");
console.log("    但若中间夹着**其它把水位抬高的事件**（用户粘大段、注入台账），");
console.log("    这条线会虚高 ⇒ 实绩被算大。下面查那 8 分钟里有没有这种事件。");
const injects = evs.filter((e) => e.type === "user/message" && e.time > lo && e.time < TARGET);
console.log(`\n  压前 8 分钟内 user/message = ${injects.length} 条：`);
for (const e of injects.slice(-8)) {
  const c = e.data?.content;
  const t = Array.isArray(c) ? c.map((b) => b.text ?? "").join("") : "";
  const kind = e.data?.source?.kind ?? "?";
  console.log(`     ${hm(e.time)}  [${kind}] ${t.length} 字符  ${t.slice(0, 50).replace(/\n/g, " ")}`);
}
