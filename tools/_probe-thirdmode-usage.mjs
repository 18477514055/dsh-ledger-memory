/**
 * ★★★ 只读：模式③「每轮独立对话」的**经济学与容量学**。
 *
 * 用户的目标（逐字）：*"如果能做到无损接续的话，相当于无限拓展这个上下文窗口了。"*
 * ⇒ 他买的**不是省钱，是窗口容量**（= 本插件总纲「模型下限」）。
 * 所以本探针要回答的是：
 *   ① 现在每轮到底花了多少？—— **命中 / 未命中 / 输出** 各自的真实量级。
 *   ② 「常驻」与「分页」差多少？—— 现模式下常驻的 R 是**命中价**（便宜），
 *      模式③把它清零，但要把「重建」的读**按全价**买回来。
 *      ⇒ **决定成败的不是"能省多少"，而是"重建一次要读多少、以及它是不是重复读同一段"。**
 *   ③ 有没有**局部性**（反复读同一份内容）？—— 有局部性，分页才便宜；没有，就是抖动。
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
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(11, 19);

console.log("═".repeat(78));
console.log("⓪ 事件类型直方图（先确认名字，再谈数）");
console.log("═".repeat(78));
const hist = new Map();
for (const e of evs) hist.set(e.type, (hist.get(e.type) || 0) + 1);
for (const [t, c] of [...hist].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(7)}  ${t}`);

const routes = evs.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => {
    const u = e.data.usage;
    return {
      time: e.time,
      miss: Number(u.inputTokens || 0),
      cache: Number(u.cacheReadTokens || 0),
      out: Number(u.outputTokens || 0),
      reason: Number(u.reasoningTokens || 0),
    };
  }).sort((a, b) => a.time - b.time);

const T = (k) => routes.reduce((a, b) => a + b[k], 0);
console.log("\n" + "═".repeat(78));
console.log("① 本会话真实用量（单位：点 = 百万 token）");
console.log("═".repeat(78));
console.log(`  轮数（assistant/message 带 usage） = ${routes.length}`);
console.log(`  未命中输入（全价）  = ${(T("miss") / W).toFixed(2)} 点`);
console.log(`  命中读取（≈1/10 价）= ${(T("cache") / W).toFixed(2)} 点`);
console.log(`  输出                = ${(T("out") / W).toFixed(2)} 点`);
console.log(`  其中 reasoning      = ${(T("reason") / W).toFixed(2)} 点`);
const denom = T("miss") + T("cache");
console.log(`  ⇒ 命中率 = ${(100 * T("cache") / Math.max(1, denom)).toFixed(1)}%（按 token 计）`);

console.log("\n  ★ 「同价折算」：若命中价 = 1/10、未命中价 = 1、输出价 = 1（量级，不是账单）");
const equiv = T("miss") / W + (T("cache") / W) * 0.1 + T("out") / W;
console.log(`    现在 = ${equiv.toFixed(2)} 等价点`);
console.log(`    ⇒ 其中「常驻命中」只占 ${((T("cache") / W) * 0.1 / Math.max(0.01, equiv) * 100).toFixed(1)}%`);
console.log(`    ⇒ **模式③能省的，至多就是这一块**（把常驻清零）。`);

console.log("\n" + "═".repeat(78));
console.log("② 每轮未命中输入：不是稳定的，看它的分布");
console.log("═".repeat(78));
const misses = routes.map((r) => r.miss).sort((a, b) => a - b);
const q = (p) => misses[Math.min(misses.length - 1, Math.floor(p * misses.length))];
console.log(`  min=${misses[0]}  p25=${q(0.25)}  中位=${q(0.5)}  p75=${q(0.75)}  p90=${q(0.9)}  max=${misses[misses.length - 1]}`);
console.log("  ★ 中位与 max 差得越多，说明「少数几轮吃掉大部分钱」⇒ 那些轮通常就是压缩后那一轮。");

console.log("\n" + "═".repeat(78));
console.log("③ 局部性（分页便宜/抖动的判据）：工具调用在读什么？");
console.log("═".repeat(78));
const toolTypes = [...hist.keys()].filter((t) => /^tool\//.test(t));
console.log(`  tool/* 事件类型：${toolTypes.join(" · ") || "（无）"}`);
const sample = evs.find((e) => /^tool\//.test(e.type));
if (sample) {
  const s = JSON.stringify(sample);
  console.log(`  样例（前 600 字符，只看形状）:\n  ${s.slice(0, 600)}`);
} else {
  console.log("  ★ 没有 tool/* 事件 ⇒ 本探针取不到「读了什么」⇒ 无法判定局部性（要报「无法判定」）。");
}

// 事件里凡出现 path/arguments 的都试一遍，看能不能拼出「读了哪个文件」
const readLike = evs.filter((e) => {
  const s = JSON.stringify(e);
  return /tool/.test(e.type) && /"(path|file_path|filename)"/.test(s);
});
console.log(`\n  含路径字段的 tool 事件 = ${readLike.length}`);
if (readLike.length > 0) {
  const cnt = new Map();
  for (const e of readLike) {
    const m = JSON.stringify(e).match(/"(?:path|file_path|filename)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) { const p = m[1]; cnt.set(p, (cnt.get(p) || 0) + 1); }
  }
  const top = [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(`  不同路径 = ${cnt.size}`);
  console.log(`  ★ 重复读同一路径的总次数占比 = ${
    (100 * [...cnt.values()].reduce((a, b) => a + b, 0) && 0) || 0}%`); // 占位，下面重算
  const tot = [...cnt.values()].reduce((a, b) => a + b, 0);
  const rep = tot - cnt.size;
  console.log(`  总读次 = ${tot}，其中重复（同一路径 >1 次）= ${rep} ⇒ **重复率 ${(100 * rep / Math.max(1, tot)).toFixed(1)}%**`);
  console.log("  读得最多的 15 个路径：");
  for (const [p, c] of top) console.log(`    ${String(c).padStart(4)}×  ${p}`);
}

console.log("\n" + "═".repeat(78));
console.log("④ 压缩统计（用户说「甚至都不用压缩」—— 先看现在压了多少次）");
console.log("═".repeat(78));
for (const t of ["compaction/start", "compaction/end", "compaction/prune", "compaction/summary"]) {
  console.log(`  ${t.padEnd(24)} = ${hist.get(t) || 0}`);
}
const ends = evs.filter((e) => e.type === "compaction/end").map((e) => e.time).sort((a, b) => a - b);
if (ends.length > 0) {
  console.log(`  压缩时刻：${ends.map(hm).join(" · ")}`);
  const span = (ends[ends.length - 1] - ends[0]) / 60000;
  console.log(`  ⇒ 平均每 ${(span / Math.max(1, ends.length - 1)).toFixed(1)} 分钟压一次`);
}
