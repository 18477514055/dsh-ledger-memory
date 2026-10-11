/**
 * ★★★ 离线复算 `selectIncrementalRange`：**它选出来的段，启发式量到底是多少？**
 *
 * 背景（全部读内核源码坐实）：
 *   · 内核 `compaction-basic` L577：`shadowedTokenCount = Σ selectedNodes.heuristicTokens`
 *   · 内核 `token-meter` L540-547：无图像/无文件时 `node.tokens ≡ node.heuristicTokens`
 *   · 本插件 L1635 `selectIncrementalRange`：从尾向前累加 `priced[i].tokens` 到 `>= retainTokens`
 *   · 本插件 L9513：`retainTokens = max(1, Σnodes − removePoints% × window)`
 *
 * ★ 可离线精确复算的关键：`compaction/summary.shadowedTokenCount` **就是**被压段的 ΣheuristicTokens。
 *   所以"选出来的段有多大"不需推断 —— 内核已经报出来了。
 *
 * 本探针做三件事：
 *   ① 核对 `Σnodes − 100000` 这个**意图值**；
 *   ② 用内核已报的 `shadowedTokenCount` 直接读出**实际选出的启发式量**；
 *   ③ 用内核估算器（CHARS_PER_TOKEN=4）独立复算同一次压缩**摘要**有多大，
 *      从而解出"这次压缩真实省了多少"，并指出**意图 = 启发式 ≠ 真实**。
 *
 * ★ 只读。
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
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(11, 19);

const starts = evs.filter((e) => e.type === "compaction/start")
  .map((e) => ({ time: e.time, id: e.data?.compactionId, turn: e.data?.turn, cmd: e.data?.sourceCommandId }))
  .sort((a, b) => a.time - b.time);
const sums = evs.filter((e) => e.type === "compaction/summary")
  .map((e) => {
    const chars = Array.isArray(e.data?.summary) ? e.data.summary.reduce((s, b) => s + String(b?.text ?? "").length, 0) : 0;
    return {
      time: e.time, id: e.data?.compactionId,
      heur: Number(e.data?.shadowedTokenCount ?? 0),
      n: Array.isArray(e.data?.shadowedSeqs) ? e.data.shadowedSeqs.length : 0,
      chars,
      range: e.data?.shadowedRange,
    };
  }).sort((a, b) => a.time - b.time);
const byId = new Map(sums.map((s) => [s.id, s]));

console.log("═══ 每次压缩：「意图值」与「内核报出的实际被压启发式量」═══\n");
console.log("  时刻     归属   意图值(Σnodes−100K)  内核报出被压  差(报出−意图)  节点数  范围跨度(seq)");
console.log("  " + "-".repeat(104));
const FIX = new Date("2026-10-11T03:25:00+08:00").getTime();
for (const st of starts) {
  const s = byId.get(st.id);
  if (s === undefined) continue;
  const ideal = 100000; // removePoints% × window = 10% × 1,000,000
  const span = s.range === undefined ? "?" : `${s.range.start}→${s.range.end}`;
  console.log(
    `  ${hm(st.time)}  ${String(st.turn === null ? "全量" : "t" + st.turn).padStart(4)}  ` +
    `${String(ideal).padStart(18)}  ${String(s.heur).padStart(12)}  ${String(s.heur - ideal).padStart(14)}  ` +
    `${String(s.n).padStart(6)}  ${span.padStart(16)}`
  );
}

console.log("\n═══ 修复后三次自动增量（逐项）═══");
for (const st of starts.filter((x) => x.time >= FIX && x.turn !== null)) {
  const s = byId.get(st.id);
  console.log(`\n  ${hm(st.time)}  t${st.turn}`);
  console.log(`    · 意图：Σnodes − 0.10×window = 100,000（**启发式**）`);
  console.log(`    · 内核实际选中并压掉：${s.heur} 启发式 token（${s.n} 个节点）`);
  console.log(`    · 摘要长度：${s.chars} 字符 ⇒ 内核估算 ≈ ${Math.ceil(s.chars / 4)} 启发式 token`);
  console.log(`    · 在**启发式**账面上这次应净省 ≈ ${s.heur - Math.ceil(s.chars / 4)}`);
  console.log(`    · 但真实路由只缩小 ${s.heur === 0 ? "?" : ""}见 _probe-scale-mismatch（≈4.4 点）`);
}

console.log("\n═══ 对照：修复前那 12 次（同一套代码路径，只差 retainTokens 的算法）═══");
for (const st of starts.filter((x) => x.time < FIX && x.turn !== null)) {
  const s = byId.get(st.id);
  console.log(`  ${hm(st.time)}  t${String(st.turn).padStart(2)}  shadowed=${String(s.heur).padStart(7)}  节点=${String(s.n).padStart(3)}  范围=${s.range?.start}→${s.range?.end}`);
}
console.log("\n  ★ 修复前用**常量** retainTokens≈100,000（旧口径 0.10×window，与 surface 无关）——");
console.log("     但它是在**同一个启发式 surface** 上累加的，所以选出来的量同样 ≈100K 启发式。");
console.log("  ★ 那为什么修复前 real/heuristic≈1.0、修复后只有 0.51？");
console.log("     ⇒ 因为**修复前水位低**（surface 小、摘要相对小），修复后水位高（摘要相对更大）。");
console.log("     这张表只回答「选了多少」，不回答「为什么真实省得少」——后者见下。");
