/**
 * ★★★ 复核 4355 的两条推翻结论，用我自己的代码独立验一遍。
 *
 * 要验的：
 *   ① 8 次「有 start 无 summary」的压缩，`compaction/end.data.error` 里到底有没有原因？
 *   ② 那 4 次「压了等于没压」，换成「主工作请求」口径后，是否其实都减少了？
 *
 * ★ 关键：这次必须读 end.data.error —— 我上一轮的探针只搜事件名 error/fail，漏了数据字段。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const starts = []; let i = buf.indexOf(MAGIC);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  starts.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < starts.length; k += 1) {
    try { const d = zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1])); if (d.length) out.push(d); } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};
const fmt = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });

const SESS = path.join(os.homedir(), ".dsh", "sessions",
  "--D-Deepseek~5DE5~4F5C~533A-20-DSH~63D2~4EF6-04-~5176~4F59~63D2~4EF6-10.~9879~76EE~53F0~8D26--",
  "session-a5dd1f8f-8f7a-4590-9ede-34f72354dad8", "session.v4.jsonl.zstd");
const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
// 冻结窗口：4355 用的 seq <= 78044
const W = 78044;
const ev = evs.filter((e) => typeof e.seq === "number" && e.seq <= W);
console.log(`事件总数 ${evs.length}，seq<=${W} 的 ${ev.length} 条\n`);

// ── ① 8 次无 summary：读 end.data.error
console.log("═══ ① 「有 start 无 summary」的每一次：end 里有没有 error ═══");
const starts = ev.filter((e) => e.type === "compaction/start");
const sums = ev.filter((e) => e.type === "compaction/summary");
const ends = ev.filter((e) => e.type === "compaction/end");
const sumIds = new Set(sums.map((e) => e.data?.compactionId));
const endBy = new Map();
for (const e of ends) if (e.data?.compactionId) endBy.set(e.data.compactionId, e);

let withErr = 0, noEnd = 0, other = 0;
for (const s of starts) {
  const id = s.data?.compactionId;
  if (sumIds.has(id)) continue;               // 有摘要的跳过
  const end = endBy.get(id);
  if (!end) {
    noEnd += 1;
    console.log(`  ★ seq=${s.seq} ${fmt(s.time)} 没有 end —— 原因未知`);
    continue;
  }
  const err = end.data?.error;
  if (err) {
    withErr += 1;
    const txt = typeof err === "string" ? err : JSON.stringify(err);
    console.log(`  seq=${s.seq}→end ${end.seq}  错误=${txt.slice(0, 130)}`);
  } else {
    other += 1;
    console.log(`  seq=${s.seq}→end ${end.seq}  ★ end 存在但无 error 字段：keys=${Object.keys(end.data ?? {}).join(",")}`);
  }
}
console.log(`\n  合计：有 start 无 summary = ${starts.length - sums.length} 次`);
console.log(`    · end 里带 error  = ${withErr}`);
console.log(`    · 完全没有 end    = ${noEnd}`);
console.log(`    · end 存在但无 error = ${other}`);

// ── ② 换口径重算那 4 次「压了等于没压」
console.log("\n═══ ② 「4 次压了等于没压」换口径复核 ═══");
console.log("  口径：压前 = 该次 summary 之前最近的**主工作** assistant/message 的 input+cacheRead");
console.log("        压后 = summary 之后**新 step** 的第一条 assistant/message 的 input+cacheRead\n");

const asst = ev.filter((e) => e.type === "assistant/message" && e.data?.usage);
const stepStarts = ev.filter((e) => e.type === "step/start");

// 挑那 4 次：按 4355 报告的 seq
const targets = [13499, 29393, 31585, 32583];
for (const sseq of targets) {
  const s = sums.find((e) => e.seq === sseq);
  if (!s) { console.log(`  seq=${sseq} 找不到 summary`); continue; }
  const before = asst.filter((a) => a.seq < s.seq).slice(-1)[0];
  // 压后：找 summary 之后第一个 step/start，再找它之后第一条 assistant
  const ns = stepStarts.find((x) => x.seq > s.seq);
  const after = ns ? asst.find((a) => a.seq > ns.seq) : asst.find((a) => a.seq > s.seq);
  const u = (m) => (m ? (m.data.usage.inputTokens ?? 0) + (m.data.usage.cacheReadTokens ?? 0) : null);
  const b = u(before), a = u(after);
  const pct = b && a ? (((b - a) / b) * 100).toFixed(2) : "?";
  console.log(`  summary seq=${sseq}`);
  console.log(`    压前 主请求 seq=${before?.seq} 输入=${b}`);
  console.log(`    压后 新step=${ns?.seq} → assistant seq=${after?.seq} 输入=${a}`);
  console.log(`    ⇒ 减少 ${pct}%`);
}
