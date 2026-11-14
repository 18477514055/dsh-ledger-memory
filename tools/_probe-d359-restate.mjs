// _probe-d359-restate.mjs —— 直接检验用户的观察：压缩后模型有没有**重说一遍已经说过/做过的事**
//
// ★ 为什么必须做这个：前面几个探针量的都是**工具调用**，结果全是 ~0
//   （同一目标同内容重做 0 次、同一命令逐字重跑 0 次）。
//   但用户说的是"重复一次此前已经做过的工作" —— 那更可能发生在**正文叙述**里，
//   而不是工具调用里。工具调用数不出来 ⇒ 不代表现象不存在，只代表**尺子没照到**。
//
// 判据（写死）：
//   · 每次压缩，取「压缩前最后 3 条 assistant 正文」与「压缩后第 1 条 assistant 正文」
//   · 按**句子**切（中英文句号/换行），只看长度 ≥ 20 字符的句子
//   · 用「8 字符 shingle 集合」算重叠：shingle 是 8 个连续字符，抗轻微改写
//   · 重复率 = 压后首条里被压前 3 条覆盖过的 shingle 占比
import fs from "node:fs";
import zlib from "node:zlib";

const REAL =
  "C:\\Users\\24239\\.dsh\\sessions\\--D-Deepseek~5DE5~4F5C~533A-20-DSH~63D2~4EF6-04-~5176~4F59~63D2~4EF6-10.~9879~76EE~53F0~8D26--\\session-a5dd1f8f-8f7a-4590-9ede-34f72354dad8\\session.v4.jsonl.zstd";

function readAllEvents(file) {
  const buf = fs.readFileSync(file);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(s, e)).toString("utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* skip */ }
    }
  }
  return out;
}

/** 取一条 assistant/message 的纯文本 */
function textOfAssistant(ev) {
  const c = ev.data?.message?.content ?? ev.data?.content;
  if (!Array.isArray(c)) return "";
  return c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
}

/** 8 字符 shingle 集合（去空白，抗轻微改写） */
function shingles(s) {
  const t = String(s).replace(/\s+/g, "");
  const out = new Set();
  for (let i = 0; i + 8 <= t.length; i++) out.add(t.slice(i, i + 8));
  return out;
}

const events = readAllEvents(REAL);

// 按 seq 排好的 assistant 正文流
const assists = [];
for (const ev of events) {
  if (ev.type !== "assistant/message") continue;
  const text = textOfAssistant(ev);
  if (text.trim() === "") continue;
  assists.push({ seq: ev.seq, text });
}
assists.sort((a, b) => a.seq - b.seq);
console.log(`assistant 正文条数 = ${assists.length}`);

const startsM = new Map();
const endsM = new Map();
for (const ev of events) {
  if (ev.type === "compaction/start") startsM.set(ev.data?.compactionId, { seq: ev.seq, turn: ev.data?.turn });
  if (ev.type === "compaction/end") endsM.set(ev.data?.compactionId, { seq: ev.seq, error: ev.data?.error });
}
const comps = [];
for (const [id, s] of startsM) {
  const e = endsM.get(id);
  if (!e || e.error !== undefined) continue;
  comps.push({ turn: s.turn, startSeq: s.seq, endSeq: e.seq });
}
comps.sort((a, b) => a.startSeq - b.startSeq);

const rows = [];
for (const c of comps) {
  const pre = assists.filter((x) => x.seq < c.startSeq).slice(-3);
  const post = assists.filter((x) => x.seq > c.endSeq)[0];
  if (pre.length === 0 || post === undefined) continue;
  const preSh = new Set();
  for (const p of pre) for (const s of shingles(p.text)) preSh.add(s);
  const postSh = shingles(post.text);
  if (postSh.size === 0) continue;
  let hit = 0;
  for (const s of postSh) if (preSh.has(s)) hit++;
  rows.push({
    turn: c.turn,
    preChars: pre.reduce((a, p) => a + p.text.length, 0),
    postChars: post.text.length,
    rate: (100 * hit) / postSh.size,
  });
}

const avg = (a) => (a.length === 0 ? 0 : a.reduce((x, y) => x + y, 0) / a.length);
const rates = rows.map((r) => r.rate).sort((a, b) => a - b);
console.log(`\n可比压缩次数 = ${rows.length}`);
console.log(`压后首条正文的「与压前 3 条重复」比例：`);
console.log(`  均值 ${avg(rates).toFixed(1)}%   中位 ${rates[Math.floor(rates.length / 2)]?.toFixed(1)}%   P90 ${rates[Math.floor(rates.length * 0.9)]?.toFixed(1)}%   最大 ${rates[rates.length - 1]?.toFixed(1)}%`);
const hi = rows.filter((r) => r.rate >= 30);
console.log(`  ≥30% 的压缩次数：${hi.length} / ${rows.length}`);
console.log("\n== 逐次（重复率 / 压前字符 / 压后字符）==");
for (const r of rows) {
  const flag = r.rate >= 30 ? "  ← 高" : "";
  console.log(`  turn=${String(r.turn).padStart(4)}  ${r.rate.toFixed(1).padStart(5)}%   ${String(r.preChars).padStart(6)} → ${String(r.postChars).padStart(5)}${flag}`);
}
