/**
 * ★ 只读：复核一个反常 —— 注入里的索引行写着 `seq 36764–35270`，**起点大于终点**。
 *
 * 判据（唯一能定案的东西）：读 `compaction/summary` 事件里的**原始** `shadowedRange`
 * 与 `shadowedSeqs`，看它们到底是什么形状。
 *
 * ★ 不许猜：如果原始数据就是倒的，那是内核语义与我的假设不符；
 *   如果原始数据是正的，那是我的渲染/记录有 bug。**两者修法完全不同。**
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
const SID = "session-fada6e5f-52f2-4a4f-b52a-3c2483db117e";
const SESS = path.join(os.homedir(), ".dsh", "sessions", "--D-Deepseek~5DE5~4F5C~533A--", SID, "session.v4.jsonl.zstd");
const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
evs.sort((a, b) => a.seq - b.seq);
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);

console.log("═".repeat(94));
console.log("① 全部 `compaction/summary` 事件里的**原始** shadowedRange / shadowedSeqs");
console.log("═".repeat(94));
const sums = evs.filter((e) => e.type === "compaction/summary");
console.log(`  共 ${sums.length} 条`);
for (const e of sums) {
  const d = e.data ?? {};
  const r = d.shadowedRange;
  const sq = d.shadowedSeqs;
  console.log(`\n  ── summary seq=${e.seq}  ${hm(e.time)} ──`);
  console.log(`     shadowedRange = ${JSON.stringify(r)}`);
  if (Array.isArray(sq) && sq.length > 0) {
    const asc = sq.every((v, i) => i === 0 || sq[i - 1] < v);
    console.log(`     shadowedSeqs  = ${sq.length} 个 · 首 ${sq[0]} · 尾 ${sq[sq.length - 1]} · **递增=${asc}**`);
    if (!asc) {
      // 找出第一处逆序，帮助判断是"整体倒序"还是"局部乱"
      const bad = sq.findIndex((v, i) => i > 0 && sq[i - 1] >= v);
      console.log(`       ★ 首处逆序在 index=${bad}：…${sq.slice(Math.max(0, bad - 2), bad + 3).join(", ")}…`);
    }
  } else {
    console.log(`     shadowedSeqs  = ${JSON.stringify(sq)}`);
  }
  if (typeof r?.start === "number" && typeof r?.end === "number") {
    console.log(`     ⇒ start=${r.start} end=${r.end}  **start<=end = ${r.start <= r.end}**`);
  }
  console.log(`     data 的键：${Object.keys(d).join(", ")}`);
}

console.log("\n" + "═".repeat(94));
console.log("② 与 `compaction/start` / `compaction/end` 配对看（谁先谁后）");
console.log("═".repeat(94));
for (const e of evs.filter((x) => x.type.startsWith("compaction/"))) {
  const r = e.data?.shadowedRange;
  console.log(`  seq=${String(e.seq).padStart(6)}  ${hm(e.time)}  ${e.type.padEnd(22)}` +
    (r === undefined ? "" : `  range=${JSON.stringify(r)}`));
}
