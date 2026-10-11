/**
 * ★★★ 独立复算被压段：内核报的 `shadowedTokenCount` 是否**忠实反映被压节点的内容量**？
 *
 * 动机：出现了尺度差解释不了的现象 ——
 *   · **全量**压缩：启发式/真实 ≈ 1.05
 *   · **修复后稀疏增量**：启发式/真实 ≈ 2.1
 *   ⇒ 同一会话同一内容，比值差 2 倍 ⇒ 必须回到**具体节点**上看。
 *
 * 做法：用内核同一个估算器（`estimate.js`：`CHARS_PER_TOKEN=4`、每块 `+4`、每消息 `+4`）
 *   逐个复算 `shadowedSeqs` 里每个节点，得到 `Σ复算`，与内核报的 `shadowedTokenCount` 比。
 *   若两者吻合 ⇒ 内核报的数**忠实**，"多出来的那 2×"就得由**真实 tokenizer** 解释；
 *   若不吻合 ⇒ 内核报的数本身有别的含义。
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
const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
const bySeq = new Map();
for (const e of evs) if (Number.isFinite(e.seq)) bySeq.set(e.seq, e);
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(11, 19);

const CPT = 4, BLOCK = 4, ROLE = 4;
/** 复刻内核 estimate.js 对一条"由事件派生出来的消息"的计价。 */
function recomputeHeuristic(event) {
  if (event === undefined) return { tokens: 0, chars: 0, note: "事件不存在" };
  const t = event.type;
  if (t === "assistant/message") {
    const content = event.data?.message?.content ?? [];
    if (!Array.isArray(content)) return { tokens: 0, chars: 0, note: "无 content" };
    let tokens = 0, chars = 0;
    for (const b of content) {
      if (b?.type === "text" || b?.type === "reasoning") {
        chars += String(b.text ?? "").length;
        tokens += Math.ceil(String(b.text ?? "").length / CPT) + BLOCK;
      } else if (b?.type === "tool-call") {
        chars += String(b.name ?? "").length + String(b.arguments ?? "").length;
        tokens += Math.ceil(String(b.name ?? "").length / CPT) + Math.ceil(String(b.arguments ?? "").length / CPT) + BLOCK;
      } else { tokens += BLOCK + Math.ceil(JSON.stringify(b).length / CPT); }
    }
    return { tokens: tokens + ROLE, chars, note: `${content.length} 块` };
  }
  if (t === "tool/result") {
    const c = event.data?.content ?? event.data?.message?.content ?? event.data;
    const s = typeof c === "string" ? c : JSON.stringify(c);
    return { tokens: Math.ceil(s.length / CPT) + BLOCK + ROLE, chars: s.length, note: "tool/result" };
  }
  // 其它（user/message、developer/message、system/message…）
  const d = event.data ?? {};
  const c = d.content ?? d.message?.content ?? d;
  const s = typeof c === "string" ? c : JSON.stringify(c);
  return { tokens: Math.ceil(s.length / CPT) + BLOCK + ROLE, chars: s.length, note: t };
}

const sums = evs.filter((e) => e.type === "compaction/summary")
  .map((e) => ({ time: e.time, turn: undefined, heur: Number(e.data?.shadowedTokenCount ?? 0), seqs: e.data?.shadowedSeqs ?? [] }))
  .sort((a, b) => a.time - b.time);
const startsById = new Map();
for (const e of evs) if (e.type === "compaction/start") startsById.set(e.data?.compactionId, e.data);
const ids = evs.filter((e) => e.type === "compaction/summary").map((e) => e.data?.compactionId);
sums.forEach((s, i) => { s.turn = startsById.get(ids[i])?.turn; });

console.log("═══ 内核报的 shadowedTokenCount vs 用内核同一估算器独立复算 ═══\n");
console.log("  时刻     归属   内核报出   我的复算   差(复算−报出)  复算/报出  被压字符   字符/复算tok");
console.log("  " + "-".repeat(100));
for (const s of sums) {
  let tok = 0, chars = 0, miss = 0;
  const perType = new Map();
  for (const seq of s.seqs) {
    const ev = bySeq.get(seq);
    const r = recomputeHeuristic(ev);
    if (ev === undefined) miss += 1;
    tok += r.tokens; chars += r.chars;
    const k = ev?.type ?? "(缺失)";
    perType.set(k, (perType.get(k) ?? 0) + 1);
  }
  const types = [...perType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(" ");
  console.log(
    `  ${hm(s.time)}  ${String(s.turn === null ? "全量" : "t" + s.turn).padStart(4)}  ` +
    `${String(s.heur).padStart(8)}  ${String(tok).padStart(9)}  ${String(tok - s.heur).padStart(13)}  ` +
    `${(tok / (s.heur || 1)).toFixed(2).padStart(8)}  ${String(chars).padStart(9)}  ${(chars / (tok || 1)).toFixed(2).padStart(11)}`
  );
  if (process.argv.includes("--verbose")) console.log(`       组成：${types}${miss > 0 ? `  缺失 ${miss}` : ""}`);
}

console.log("\n═══ 修复后三次增量：被压段按事件类型拆开 ═══");
const FIX = new Date("2026-10-11T03:25:00+08:00").getTime();
for (const s of sums.filter((x) => x.time >= FIX && x.turn !== null)) {
  const acc = new Map();
  let chars = 0;
  for (const seq of s.seqs) {
    const ev = bySeq.get(seq);
    const r = recomputeHeuristic(ev);
    const k = ev?.type ?? "(缺失)";
    const a = acc.get(k) ?? { n: 0, tok: 0, chars: 0 };
    a.n += 1; a.tok += r.tokens; a.chars += r.chars; chars += r.chars;
    acc.set(k, a);
  }
  console.log(`\n  ${hm(s.time)}  t${s.turn}  内核报出 ${s.heur}  共 ${s.seqs.length} 节点 / ${chars} 字符`);
  for (const [k, a] of [...acc.entries()].sort((x, y) => y[1].tok - x[1].tok)) {
    console.log(`     ${k.padEnd(20)} ${String(a.n).padStart(4)} 个  复算 ${String(a.tok).padStart(7)} tok  ${String(a.chars).padStart(8)} 字符`);
  }
}
