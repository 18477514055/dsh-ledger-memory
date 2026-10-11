/**
 * ★★★ 只读评估：把「模型的思考过程（reasoning）+ 工具调用」也存盘，
 * 上下文里只留一个**按需查询的指针**。
 *
 * 用户 2026-10-11 原话（逐字）：
 *   *"感觉可以先考虑把模型的整个思考过程看看到底该怎样才能也存盘。这样的话，
 *    下文只需要知道一个指针就足够了，这个指针可以指引下面那个模型，
 *    按需查询上面那个模型的思考过程与工具调用。"*
 *
 * 本探针只回答四个问题（全部只读）：
 *   ① reasoning **到底在不在盘上**？（官方会话日志是否逐字留着）
 *   ② 它有多大？（决定"存盘"的规模）
 *   ③ ★ 指针能不能做到很小？（D79 的回读预算判据 ≈31K tok）
 *   ④ 已经被压缩掉的那部分，reasoning 还在不在？
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
const K = (c) => (c / 4 / 1000).toFixed(1);
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);
const blocks = (e) => {
  const c = e.data?.message?.content;
  return Array.isArray(c) ? c : [];
};

console.log("═".repeat(80));
console.log("① reasoning 到底在不在盘上？（先看形状，再贴样本）");
console.log("═".repeat(80));
const aMsgs = evs.filter((e) => e.type === "assistant/message");
console.log(`  assistant/message 事件总数 = ${aMsgs.length}`);
const kinds = new Map();
let firstReason = null;
for (const e of aMsgs) {
  for (const b of blocks(e)) {
    kinds.set(b.type, (kinds.get(b.type) || 0) + 1);
    if (b.type === "reasoning" && firstReason === null) firstReason = { e, b };
  }
}
console.log(`  内容块类型：${[...kinds].map(([k, v]) => `${k}×${v}`).join(" · ")}`);
if (firstReason !== null) {
  const b = firstReason.b;
  console.log(`\n  ★ 最早的 reasoning 块出现在 seq=${firstReason.e.seq}（${hm(firstReason.e.time)}）`);
  console.log(`  块字段 = ${Object.keys(b).join(" · ")}`);
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === "string") console.log(`    ${k.padEnd(12)} string, ${v.length} 字符`);
    else console.log(`    ${k.padEnd(12)} ${typeof v}`);
  }
  const txt = typeof b.text === "string" ? b.text : (typeof b.thinking === "string" ? b.thinking : "");
  console.log(`\n  ★ 正文前 400 字符（证明是**真文本**，不是占位符）：`);
  console.log("  " + "-".repeat(74));
  console.log(txt.slice(0, 400).split("\n").map((l) => "  " + l).join("\n"));
  console.log("  " + "-".repeat(74));
  console.log(`  ⇒ ★ **reasoning 逐字在盘上**，长度 ${txt.length} 字符。`);
} else {
  console.log("\n  ★★ 盘上没有 reasoning 块 ⇒ 用户的想法**需要新建采集通道**，不能靠官方日志。");
}

console.log("\n" + "═".repeat(80));
console.log("② 规模：全会话的 reasoning / 工具调用各有多大");
console.log("═".repeat(80));
let rC = 0, rN = 0, tC = 0, tcC = 0, trC = 0;
for (const e of aMsgs) {
  for (const b of blocks(e)) {
    const n = typeof b.text === "string" ? b.text.length : JSON.stringify(b).length;
    if (b.type === "reasoning") { rC += n; rN += 1; }
    else if (b.type === "text") tC += n;
    else if (b.type === "tool-call") tcC += n;
  }
}
for (const e of evs.filter((x) => x.type === "tool/result")) trC += JSON.stringify(e.data?.message ?? {}).length;
console.log(`  reasoning   ${String(rN).padStart(6)} 块  ${String(rC).padStart(10)} 字符 ≈ ${K(rC).padStart(6)}K tok`);
console.log(`  text        ${" ".repeat(6)} 块  ${String(tC).padStart(10)} 字符 ≈ ${K(tC).padStart(6)}K tok`);
console.log(`  tool-call   ${" ".repeat(6)} 块  ${String(tcC).padStart(10)} 字符 ≈ ${K(tcC).padStart(6)}K tok`);
console.log(`  tool/result ${" ".repeat(6)}    ${String(trC).padStart(10)} 字符 ≈ ${K(trC).padStart(6)}K tok`);
console.log(`  ---- 若全部外置：${K(rC + tC + tcC + trC)}K tok 的**盘上体量**`);
console.log(`  ⇒ 上下文里只需要留「指针」，这 ${K(rC).padStart(6)}K tok 的推理不必常驻。`);

console.log("\n" + "═".repeat(80));
console.log("③ ★★★ 指针能不能做到很小？（判据：D79 的回读预算 ≈31K tok）");
console.log("═".repeat(80));
// 按 turn 切桶
const turns = [];
let cur = null;
for (const e of evs) {
  if (e.type === "turn/start") { cur = { start: e, items: [] }; turns.push(cur); }
  else if (cur !== null) cur.items.push(e);
}
console.log(`  turn/start 事件 = ${turns.length}（= 指针的天然粒度：一次用户交互）`);

// 每个 turn 里：用户原话 / reasoning / 工具调用 / 工具结果
const rows = [];
for (let i = 0; i < turns.length; i += 1) {
  const t = turns[i];
  const nextStart = i + 1 < turns.length ? turns[i + 1].start.seq : Number.MAX_SAFE_INTEGER;
  const inRange = (e) => e.seq >= t.start.seq && e.seq < nextStart;
  let userC = 0, r = 0, tc = 0, s = 0, tr = 0;
  for (const e of evs) {
    if (!inRange(e)) continue;
    if (e.type === "user/message") {
      const c = e.data?.content;
      userC += Array.isArray(c) ? c.reduce((a, b) => a + (b.text ?? "").length, 0) : 0;
    } else if (e.type === "assistant/message") {
      for (const b of blocks(e)) {
        const n = typeof b.text === "string" ? b.text.length : JSON.stringify(b).length;
        if (b.type === "reasoning") r += n;
        else if (b.type === "tool-call") tc += n;
        else if (b.type === "text") s += n;
      }
    } else if (e.type === "tool/result") {
      tr += JSON.stringify(e.data?.message ?? {}).length;
    }
  }
  const firstUser = evs.filter((e) => inRange(e) && e.type === "user/message")[0];
  const prompt = (() => {
    const c = firstUser?.data?.content;
    if (!Array.isArray(c)) return "";
    const tx = c.find((b) => b.type === "text");
    return (tx?.text ?? "").replace(/\s+/g, " ").slice(0, 40);
  })();
  rows.push({ i: i + 1, t: t.start.time, seq: t.start.seq, last: nextStart - 1, userC, r, tc, s, tr, prompt });
}
let idxChars = 0;
const lines = rows.map((x) => {
  const line = `#${x.i} ${hm(x.t)} seq${x.seq}-${x.last} 推理${Math.round(x.r / 4)} 工具${Math.round((x.tc + x.tr) / 4)} | ${x.prompt}`;
  idxChars += line.length;
  return line;
});
console.log(`\n  指针（每 turn 一行）样例：`);
for (const l of lines.slice(0, 6)) console.log(`    ${l}`);
console.log("    ...");
for (const l of lines.slice(-3)) console.log(`    ${l}`);
console.log(`\n  ⇒ 全会话 ${rows.length} 行指针 = ${idxChars.toLocaleString()} 字符 ≈ **${K(idxChars)}K tok**`);
console.log(`  ⇒ ★ 判据 ${31}K tok：${idxChars / 4 / 1000 < 31 ? "★ 通过 —— 整张指针表都塞得下" : "✗ 太大，需要再分级"}`);

// 对照：如果按 assistant/message 一行（错误做法）
console.log(`\n  ★ 对照：若按 assistant/message 逐条建索引（${aMsgs.length} 行）`);
const badIdx = aMsgs.reduce((a, e) => a + 46, 0);
console.log(`      ≈ ${badIdx.toLocaleString()} 字符 ≈ ${K(badIdx)}K tok`);
console.log(`      ⇒ 按 turn 建索引比按消息建索引省 ${(badIdx / idxChars).toFixed(1)} 倍 —— **粒度选择就是全部**。`);

console.log("\n" + "═".repeat(80));
console.log("④ 已被压缩掉的部分：reasoning 还在不在？");
console.log("═".repeat(80));
const compacted = evs.filter((e) => e.type === "compaction/summary");
let shadowReason = 0, shadowN = 0, shadowSeqsTotal = 0;
const bySeq = new Map();
for (const e of evs) bySeq.set(e.seq, e);
for (const c of compacted) {
  for (const sq of c.data?.shadowedSeqs ?? []) {
    shadowSeqsTotal += 1;
    const e = bySeq.get(sq);
    if (e?.type === "assistant/message") {
      for (const b of blocks(e)) {
        if (b.type === "reasoning") { shadowN += 1; shadowReason += (typeof b.text === "string" ? b.text.length : 0); }
      }
    }
  }
}
console.log(`  22 次压缩累计 shadowed 节点 = ${shadowSeqsTotal}`);
console.log(`  其中 assistant/message 里被下架的 reasoning = ${shadowN} 块 / ${shadowReason.toLocaleString()} 字符 ≈ ${K(shadowReason)}K tok`);
console.log(`  ⇒ ★ 这些**全部仍在只追加日志里**（上面就是从日志里读出来的）`);
console.log(`  ⇒ 也就是说：**"存盘"这一步已经天然完成，缺的是「指针 + 按需查询」**。`);

console.log("\n" + "═".repeat(80));
console.log("⑤ 现成的查询面：shadowedSeqs 已经把「哪一段去哪了」钉死了");
console.log("═".repeat(80));
console.log("  每次压缩都写了 `compaction/summary.shadowedSeqs` + `shadowedRange`");
console.log(`  ⇒ 共 ${compacted.length} 次，可直接用来做**反查索引**：`);
console.log("     指针(seq) → 日志里的逐字原文 → 按需读出");
const s0 = compacted[compacted.length - 1];
console.log(`\n  最近一次：range=${JSON.stringify(s0?.data?.shadowedRange)}，节点 ${s0?.data?.shadowedSeqs?.length} 个`);
console.log(`  该次的摘要正文长度 = ${String(s0?.data?.summary?.length ?? 0)} 字符（**官方给的是摘要，不是原文**）`);

console.log("\n" + "═".repeat(80));
console.log("⑥ 我们插件自己的胶囊盘：现在存了什么");
console.log("═".repeat(80));
const cap = path.join(os.homedir(), ".dsh", "plugin-data", "dsh-ledger-memory", "capsules.json");
try {
  const j = JSON.parse(fs.readFileSync(cap, "utf8"));
  const keys = Object.keys(j);
  console.log(`  capsules.json 顶层键 = ${keys.length}`);
  for (const k of keys.slice(0, 3)) {
    const v = j[k];
    console.log(`    ${k.slice(0, 8)}… ⇒ 字段 ${Object.keys(v ?? {}).join(" · ")}`);
    for (const [f, val] of Object.entries(v ?? {})) {
      if (Array.isArray(val)) console.log(`        ${f.padEnd(16)} 数组 ${val.length} 项`);
      else console.log(`        ${f.padEnd(16)} ${typeof val}`);
    }
  }
} catch (err) {
  console.log(`  读不到：${err.message}`);
}
