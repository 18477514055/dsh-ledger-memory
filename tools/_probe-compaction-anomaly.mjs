/**
 * ★★★ 只读：两个未解事实
 *   ① 那 4 次「压了等于没压」（压后水位 ≥ 压前的 50%）到底发生什么
 *   ② 今天（10-24 02:0x）那两次失败，在会话事件流里留没留痕
 *   ③ 每回合**注入体量**有多大 —— 这决定「压后水位」的地板在哪
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

// ── ① 注入体量：按 source.kind 分开统计（★ 别混在一起数）
console.log("═══ ① 注入体量：user/message 按 data.source.kind 分桶 ═══");
const byKind = new Map();
for (const e of evs) {
  if (e.type !== "user/message") continue;
  const kind = e.data?.source?.kind ?? "(无 kind)";
  const content = e.data?.content;
  const len = Array.isArray(content)
    ? content.reduce((a, c) => a + (typeof c?.text === "string" ? c.text.length : 0), 0)
    : 0;
  if (!byKind.has(kind)) byKind.set(kind, { n: 0, chars: 0, max: 0 });
  const b = byKind.get(kind); b.n += 1; b.chars += len; b.max = Math.max(b.max, len);
}
const rows = [...byKind.entries()].sort((a, b) => b[1].chars - a[1].chars);
let totalChars = 0;
for (const [k, v] of rows) {
  totalChars += v.chars;
  console.log(`  ${k.padEnd(28)} 条数=${String(v.n).padStart(5)}  总字符=${String(v.chars).padStart(10)}  单条最大=${String(v.max).padStart(7)}  均值=${String(Math.round(v.chars / v.n)).padStart(6)}`);
}
console.log(`  合计字符 = ${totalChars}（≈ ${Math.round(totalChars / 3.2)} tok，按中英混排约 3.2 字符/token）`);

// ── ② 最近 20 个回合，每回合的注入总量（判断"固定开销"多大）
console.log("\n═══ ② 最近 12 个回合：每回合注入字符合计（kind=project-ledger-notes 等）═══");
const turns = evs.filter((e) => e.type === "turn/start");
console.log(`  turn/start 总数 = ${turns.length}`);
const last20 = turns.slice(-12);
for (const t of last20) {
  const next = turns[turns.indexOf(t) + 1];
  const win = evs.filter((e) => e.type === "user/message" && e.time >= t.time && (!next || e.time < next.time));
  const chars = win.reduce((a, e) => {
    const c = e.data?.content;
    return a + (Array.isArray(c) ? c.reduce((x, y) => x + (typeof y?.text === "string" ? y.text.length : 0), 0) : 0);
  }, 0);
  const kinds = [...new Set(win.map((e) => e.data?.source?.kind ?? "?"))];
  console.log(`  ${fmt(t.time)}  注入 ${String(chars).padStart(7)} 字符  条数=${win.length}  kinds=${kinds.join("|").slice(0, 70)}`);
}

// ── ③ 那 4 次「压了等于没压」
console.log("\n═══ ③ 「压了等于没压」的 4 次：细节 ═══");
const sums = evs.filter((e) => e.type === "compaction/summary");
const msgs = evs.filter((e) => e.type === "assistant/message" && e.data?.usage);
const endsBy = new Map();
for (const e of evs) if (e.type === "compaction/end") endsBy.set(e.data?.compactionId, e);

for (const s of sums) {
  const d = s.data ?? {};
  const u = d.usage ?? {};
  const seen = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0);
  const after = msgs.find((m) => m.time > s.time);
  const au = after?.data?.usage ?? {};
  const afterTotal = (au.inputTokens ?? 0) + (au.cacheReadTokens ?? 0) + (au.outputTokens ?? 0);
  if (!afterTotal || afterTotal < seen * 0.5) continue;
  const end = endsBy.get(d.compactionId);
  const turn = end?.data?.turn;
  console.log(`\n  ★ ${fmt(s.time)}`);
  console.log(`     压前(看进去)=${seen}  压掉=${d.shadowedTokenCount}  压后=${afterTotal}`);
  console.log(`     compactionId=${d.compactionId}  turn=${JSON.stringify(turn)}  shadowedRange=${JSON.stringify(d.shadowedRange)}`);
  console.log(`     model=${d.model} maxTokens=${d.maxTokens} outputTokens=${u.outputTokens}`);
  const txt = Array.isArray(d.summary) ? d.summary.map((x) => x?.text ?? "").join("") : "";
  console.log(`     summaryChars=${txt.length}  （压掉 ${d.shadowedTokenCount} / 产出 ${txt.length} 字符）`);
  // 这次压缩之后紧跟了几次压缩？（连续压 = 前一次没压够）
  const nextSum = sums.find((x) => x.time > s.time);
  if (nextSum) console.log(`     下一次压缩在 ${fmt(nextSum.time)}（间隔 ${((nextSum.time - s.time) / 60000).toFixed(1)} 分钟）`);
}

// ── ④ 今天最近的压缩链路（02:0x 前后）
console.log("\n═══ ④ 最近 3 次压缩的完整链路（start→summary→end）═══");
const starts2 = evs.filter((e) => e.type === "compaction/start").slice(-3);
for (const st of starts2) {
  const id = st.data?.compactionId;
  const chain = evs.filter((e) => e.data?.compactionId === id).map((e) => `${e.type}@${fmt(e.time)}`);
  console.log(`  id=${id}`);
  for (const c of chain) console.log(`     ${c}`);
}
