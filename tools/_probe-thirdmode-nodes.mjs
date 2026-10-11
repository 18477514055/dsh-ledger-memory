/**
 * ★ 逐节点列出「当前窗口」——不再相信任何聚合口径，先把 48 个节点本身看清楚。
 * 目的：找出为什么重建值与模型自报的 totalTokens 会差 7.7%。
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
for (const e of evs) bySeq.set(e.seq, e);

const nodes = [];
for (const e of evs) {
  const op = e.surfaceOp;
  if (op === undefined) continue;
  if (op === "append") { nodes.push(e.seq); continue; }
  const si = nodes.indexOf(op.startSeq);
  const ei = nodes.indexOf(op.endSeq);
  if (si === -1 || ei === -1 || si > ei) continue;
  nodes.splice(si, ei - si + 1, e.seq);
}
const cur = nodes.map((s) => bySeq.get(s)).filter(Boolean);

// 只称「会进入 LLM 消息」的部分：能派生出 message 的那个字段
const sentChars = (e) => {
  const d = e.data ?? {};
  const m = d.message ?? d;                 // user/message 的正文在 data.content，不在 data.message
  const c = m.content;
  if (Array.isArray(c)) {
    let s = 0;
    for (const b of c) {
      if (b.type === "text") s += (b.text ?? "").length;
      else if (b.type === "reasoning") s += (b.text ?? b.thinking ?? JSON.stringify(b)).length;
      else s += JSON.stringify(b).length;
    }
    return s;
  }
  if (typeof c === "string") return c.length;
  return 0;
};
const kind = (e) => {
  if (e.type === "assistant/message") {
    const t = new Map();
    for (const b of e.data?.message?.content ?? []) t.set(b.type, (t.get(b.type) || 0) + JSON.stringify(b).length);
    return [...t].map(([k, v]) => `${k}:${v}`).join(" ");
  }
  const src = e.data?.source?.kind ?? e.data?.message?.source?.kind ?? "";
  return src;
};

console.log("═".repeat(110));
console.log("当前窗口 · 逐节点（48 个）");
console.log("═".repeat(110));
console.log("  seq    类型                 正文字符  细分 / source");
console.log("  " + "-".repeat(106));
let body = 0;
for (const e of cur) {
  const c = sentChars(e);
  body += c;
  console.log(`  ${String(e.seq).padStart(5)}  ${e.type.padEnd(20)} ${String(c).padStart(8)}  ${kind(e).slice(0, 60)}`);
}
console.log(`  ⇒ 正文合计 = ${body.toLocaleString()} chars`);

const hdrs = evs.filter((e) => e.type === "request/header");
// ★ 当前 header 应该是最后一个（快照 = 该请求实际发的头）
const h = hdrs[hdrs.length - 1];
const toolChars = h?.data?.header?.tools ? JSON.stringify(h.data.header.tools).length : 0;
console.log(`\n  工具头 = ${toolChars.toLocaleString()} chars（${h?.data?.header?.tools?.length} 个工具）`);
console.log(`  合计 = ${(body + toolChars).toLocaleString()} chars`);

const withUsage = evs.filter((e) => e.type === "assistant/message" && e.data?.usage);
const last = withUsage[withUsage.length - 1];
const used = Number(last.data.usage.totalTokens || 0);
console.log(`\n  ★ 模型最后一次请求自报 totalTokens = ${used.toLocaleString()}`);
console.log(`  ★ 若 chars→tok 按 /4：预期 ${Math.round((body + toolChars) / 4).toLocaleString()}  （误差 ${(100 * Math.abs((body + toolChars) / 4 - used) / used).toFixed(2)}%）`);
console.log(`  ★ 若按正文/4 + 工具头/?：`);
for (const r of [4, 4.2, 4.5, 5, 5.5, 6]) {
  const v = body / 4 + toolChars / r;
  console.log(`      工具头 /${r} ⇒ ${Math.round(v).toLocaleString()}  （误差 ${(100 * Math.abs(v - used) / used).toFixed(2)}%）`);
}
// 反解：正文按 /4 之后，工具头该用什么系数才刚好等于 used
const need = used - body / 4;
console.log(`\n  ⇒ 反解：正文按 /4 得 ${Math.round(body / 4).toLocaleString()}，缺口 ${Math.round(need).toLocaleString()}`);
if (need > 0) console.log(`     ⇒ 工具头等效系数 = ${(toolChars / need).toFixed(2)} chars/tok（/4 口径下应接近 4）`);
else console.log(`     ⇒ 正文已经超了，说明正文字符里有**不发给模型的元数据**，须再剥离`);
