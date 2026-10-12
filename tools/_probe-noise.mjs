/**
 * ★★★ 只读：把「不顺畅/不无感」量化 —— 到底哪一条注入最吵。
 *
 * 动机（用户 2026-10-11 原话）：
 *   *"那个 billion context 可以让模型一边工作一边压缩，完全不用等对话结束，
 *     而且是模型主动调用的，我们可以做到吗？我们现在好像没那么顺畅和无感。"*
 *
 * ★ 已确认的宏观事实（`_probe-inject-role.mjs`）：本会话 309 条台账注入 / 118 条真原话，
 *   字符上 **213 倍**。但那只是"总量" ⇒ 本探针要回答**分布**：
 *   哪一类注入占了大头？其中多少是**我们自己写台账**招来的（= 可去掉的冗余）？
 *
 * ★ 判据纪律：只看 `data.source.kind`（不用关键词判"是不是注入"）；
 *   分类用**结构性标记**（各段的标题），并在结论里注明标记之间**可重叠**。
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
const textOf = (d) => {
  const c = d?.content ?? d?.message?.content;
  if (Array.isArray(c)) return c.map((x) => x?.text ?? "").join("");
  return typeof c === "string" ? c : "";
};
const INJ_KIND = "project-ledger-notes";
const injects = evs.filter((e) => e.type === "user/message" && e.data?.source?.kind === INJ_KIND);
const totalChars = injects.reduce((s, e) => s + textOf(e.data).length, 0);

console.log("═".repeat(94));
console.log("① 总量");
console.log("═".repeat(94));
console.log(`  台账注入 **${injects.length}** 条 · 共 **${totalChars.toLocaleString()}** 字符`);
console.log(`  平均每条 **${Math.round(totalChars / injects.length)}** 字符 ≈ ${Math.round(totalChars / injects.length / 4)} tok`);

// ── ② 按结构性标记分类（★ 标记之间可重叠，故同时报"独占"数）───────────────
console.log("\n" + "═".repeat(94));
console.log("② 分类（按各段标题；★ 标记**可重叠**，所以下面还有一次「互斥归类」）");
console.log("═".repeat(94));
const MARKS = [
  ["台账全文注入（headOf 行）", /belong to THIS conversation's working directory/],
  ["水位提醒（30/50/70）", /上下文水位已到/],
  ["压缩前预告", /本插件即将执行一次高保真压缩/],
  ["增量压缩回执", /本插件刚做了一次增量压缩/],
  ["想压但没落盘", /本插件想增量压缩/],
  ["退回回合末执行", /退回回合末执行/],
  ["被压段索引", /被压掉的历史/],
  ["改动回执（请转告用户）", /## 项目台账：本轮已被改动/],
];
for (const [label, re] of MARKS) {
  const hit = injects.filter((e) => re.test(textOf(e.data)));
  const chars = hit.reduce((s, e) => s + textOf(e.data).length, 0);
  console.log(`  ${String(hit.length).padStart(5)} 条 · ${String(chars).padStart(9)} 字符  ${label}`);
}

// ── ③ 互斥归类：每条注入只算进**第一个**命中的类别（避免重复计数）──────────
console.log("\n" + "═".repeat(94));
console.log("③ 互斥归类（每条只算一次；先命中的类别优先）");
console.log("═".repeat(94));
const ORDER = [
  ["只有台账全文（无附件段）", /belong to THIS conversation's working directory/],
  ["水位提醒", /上下文水位已到/],
  ["压缩前预告", /本插件即将执行一次高保真压缩/],
  ["增量压缩回执", /本插件刚做了一次增量压缩/],
  ["想压但没落盘", /本插件想增量压缩/],
  ["退回回合末执行", /退回回合末执行/],
  ["改动回执", /## 项目台账：本轮已被改动/],
  ["被压段索引", /被压掉的历史/],
];
const bucket = new Map();
for (const e of injects) {
  const t = textOf(e.data);
  // ★ 先判"是不是纯台账全文"，再看附件段（附件段是**追加**在后面的）
  const hasHead = /belong to THIS conversation's working directory/.test(t);
  const attachment = ORDER.slice(1).find(([, re]) => re.test(t));
  const key = attachment !== undefined ? attachment[0] : (hasHead ? "只有台账全文（无附件段）" : "（其它）");
  if (!bucket.has(key)) bucket.set(key, { n: 0, chars: 0 });
  const b = bucket.get(key);
  b.n += 1;
  b.chars += t.length;
}
for (const [k, v] of [...bucket.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
  const pct = ((v.chars / totalChars) * 100).toFixed(1);
  console.log(`  ${String(v.n).padStart(5)} 条 · ${String(v.chars).padStart(9)} 字符 (${pct.padStart(5)}%)  ${k}`);
}

// ── ④ ★★★ 关键：有多少注入是**我们自己刚写过台账**招来的（= 可去掉的冗余）──
console.log("\n" + "═".repeat(94));
console.log("④ ★★★ 哪些注入是**我们自己写台账**招来的（自招冗余）");
console.log("═".repeat(94));
const WRITE_TOOLS = /^(ledger_write|ledger_archive|ledger_triage|ledger_log_write|ledger_note|ledger_init|ledger_handoff)$/;
let selfCaused = 0, selfCausedChars = 0;
let otherCaused = 0;
for (let i = 0; i < evs.length; i += 1) {
  const e = evs[i];
  if (!(e.type === "user/message" && e.data?.source?.kind === INJ_KIND)) continue;
  // 往上找最近 12 条事件里有没有"我们自己的写入工具调用"
  let caused = false;
  for (let k = i - 1; k >= 0 && k > i - 12; k -= 1) {
    const p = evs[k];
    if (p.type === "tool/call") {
      const name = String(p.data?.name ?? "");
      if (WRITE_TOOLS.test(name)) { caused = true; }
      break; // 只看最近一次 tool/call
    }
    if (p.type === "user/message" && p.data?.source?.kind === INJ_KIND) break; // 上一条注入就停
  }
  if (caused) { selfCaused += 1; selfCausedChars += textOf(e.data).length; } else { otherCaused += 1; }
}
console.log(`  ★ 紧跟在我们自己的写入工具之后的注入：**${selfCaused}** 条 · **${selfCausedChars.toLocaleString()}** 字符`);
console.log(`  ⇒ 占全部注入字符的 **${((selfCausedChars / totalChars) * 100).toFixed(1)}%**`);
console.log(`  其余（不是自招）：**${otherCaused}** 条`);
console.log("");
console.log("  ★ 读法：**自招的那部分**是「我刚写完、模型已经知道我写了什么」的重注 ——");
console.log("    它是**可去掉的冗余**（模型不需要被告知它自己刚做的事）。");
console.log("    而跨会话改动、压缩后重注、水位提醒**不能**去掉（那些是它不知道的）。");

// ── ⑤ 最近 10 条的体积（看现在每条多重）────────────────────────────────
console.log("\n" + "═".repeat(94));
console.log("⑤ 最近 10 条注入的体积");
console.log("═".repeat(94));
for (const e of injects.slice(-10)) {
  const t = textOf(e.data);
  const kind = /## 项目台账：本轮已被改动/.test(t) ? "改动回执"
    : /上下文水位已到/.test(t) ? "水位提醒"
    : /belong to THIS/.test(t) ? "台账全文"
    : "其它";
  console.log(`  ${hm(e.time)}  ${String(t.length).padStart(8)} 字符 ≈${String(Math.round(t.length / 4)).padStart(6)} tok  ${kind}`);
}
