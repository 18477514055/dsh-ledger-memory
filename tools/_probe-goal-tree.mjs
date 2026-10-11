/**
 * ★★★ 只读评估：用户 2026-10-11 18:36 的新想法 ——
 * **把推理过程"提炼成目标"，目标下挂「走了哪些路 / 用了哪些手段 / 结果怎样」，
 *   目标再串成工作流；推理全文退居二线，模型优先读提炼物，卡住了再回原文（留索引）。**
 *
 * 用户原话（逐字）：
 *   *"关于这个模型自己的推理过程，可以每次将它提炼为一个或者多个目标，甚至是不同层次的
 *    多个目标，然后每个目标下面挂靠。为了实现这个目标，走了哪些路？用了哪些手段？
 *    得到的结果怎样？然后不同目标再串成我们的工作流。通过这种方法来对这个推理过程进行压缩，
 *    同时推理过程全文保留，只不过退居二线，模型会优先读取提炼出来的东西。
 *    实在有解决不了的问题，再去推理过程中原文去读取，这里可以留下一些索引，
 *    让他不用重读整个推理过程。"*
 *
 * ★ 要判的是**三件事**（全部只读、全部要有数）：
 *   ① 这个"目标树"要做多大？—— 用真实数据算：一 turn 一个目标？还是更多/更少？
 *   ② 它比"turn 索引"好在哪？—— 与已经实现的 `ledger_recall` 索引对比。
 *   ③ 它能不能**自动生成**？—— 这决定成本（要 LLM 还是规则）。
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
evs.sort((a, b) => a.seq - b.seq);
const K = (c) => (c / 4 / 1000).toFixed(1);
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);
const blocks = (e) => (Array.isArray(e.data?.message?.content) ? e.data.message.content : []);

console.log("═".repeat(84));
console.log("① 事实核对：一次「turn」里到底有几个「目标」？（先看真实数据，别凭空设计）");
console.log("═".repeat(84));
// 用 tool-call 的名字序列 + 用户原话，看看一个 turn 内部的"子目标"密度
const turns = [];
let cur = null;
for (const e of evs) {
  if (e.type === "turn/start") { cur = { start: e, seqs: [] }; turns.push(cur); }
  else if (cur !== null) cur.seqs.push(e);
}
console.log(`  turn/start = ${turns.length}`);
const rows = [];
for (const t of turns) {
  const nextStart = turns[turns.indexOf(t) + 1]?.start?.seq ?? Number.MAX_SAFE_INTEGER;
  let reasonChars = 0, reasonN = 0, toolN = 0, textChars = 0;
  const toolNames = [];
  const toolSeqs = [];
  for (const e of evs) {
    if (e.seq < t.start.seq || e.seq >= nextStart) continue;
    if (e.type === "assistant/message") {
      for (const b of blocks(e)) {
        if (b.type === "reasoning") { reasonChars += (b.text ?? "").length; reasonN += 1; }
        else if (b.type === "text") textChars += (b.text ?? "").length;
        else if (b.type === "tool-call") { toolN += 1; toolNames.push(b.name ?? "?"); toolSeqs.push(e.seq); }
      }
    }
  }
  // 用户原话
  const u = evs.find((e) => e.seq >= t.start.seq && e.seq < nextStart && e.type === "user/message");
  const uc = u?.data?.content;
  const utext = Array.isArray(uc) ? (uc.find((b) => b.type === "text")?.text ?? "") : "";
  rows.push({
    i: rows.length + 1, at: t.start.time, seq: t.start.seq, last: nextStart - 1,
    reasonChars, reasonN, toolN, textChars,
    prompt: utext.replace(/\s+/g, " ").slice(0, 46),
    names: [...new Set(toolNames)].slice(0, 6),
  });
}
console.log("\n  逐 turn：推理块数 / 工具调用数 / 用户原话");
console.log("  " + "-".repeat(80));
for (const r of rows.slice(-14)) {
  console.log(`  #${String(r.i).padStart(2)} ${hm(r.at)} 推理${String(r.reasonN).padStart(3)}块/${String(Math.round(r.reasonChars / 4)).padStart(5)}tok 工具${String(r.toolN).padStart(3)}次 | ${r.prompt}`);
}
const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
console.log("  " + "-".repeat(80));
console.log(`  合计：${rows.length} 个 turn · 推理 ${sum((r) => r.reasonN)} 块 / ${Math.round(sum((r) => r.reasonChars) / 4).toLocaleString()} tok`);
console.log(`        工具调用 ${sum((r) => r.toolN)} 次 · 平均每 turn ${(sum((r) => r.toolN) / rows.length).toFixed(1)} 次`);
console.log(`        平均每 turn 推理 ${Math.round(sum((r) => r.reasonChars) / 4 / rows.length).toLocaleString()} tok`);

console.log("\n" + "═".repeat(84));
console.log("② ★★★ 关键判据：目标树的**规模**与**粒度**");
console.log("═".repeat(84));
console.log("  三种可能的粒度，各自要多少条目：");
console.log(`    a) 一 turn 一个目标          ⇒ ${rows.length} 条`);
console.log(`    b) 一 turn 内每 1 个工具调用一个子目标 ⇒ ${sum((r) => r.toolN)} 条`);
console.log(`    c) 一 turn 内每 1 个推理块一个子目标   ⇒ ${sum((r) => r.reasonN)} 条`);
// 估字符：目标行 = "目标 + 手段 + 结果" 三小段，经验取每条约 90~160 字符
for (const [tag, n] of [["a", rows.length], ["b", sum((r) => r.toolN)], ["c", sum((r) => r.reasonN)]]) {
  for (const per of [90, 160]) {
    const chars = n * per;
    console.log(`      ${tag} 共 ${String(n).padStart(5)} 条 × ${per} 字符 = ${String(chars).padStart(8)} 字符 ≈ ${K(chars).padStart(6)}K tok`);
  }
}
console.log(`\n  ★ 判据（D79 回读预算 ≈31K tok / 125KB）：`);
for (const [tag, n] of [["a（一 turn 一目标）", rows.length], ["b（每工具调用）", sum((r) => r.toolN)]]) {
  const chars = n * 160;
  const tok = chars / 4 / 1000;
  console.log(`    ${tag.padEnd(20)} ≈ ${tok.toFixed(1)}K tok  ${tok < 31 ? "✅ 在预算内，可**常驻**" : "❌ 超预算，只能按需拉"}`);
}

console.log("\n" + "═".repeat(84));
console.log("③ 它比已经实现的 turn 索引好在哪？（对照着看）");
console.log("═".repeat(84));
let idxChars = 0;
for (const r of rows) {
  idxChars += `#${r.i} ${hm(r.at)} seq${r.seq}-${r.last} 推理${Math.round(r.reasonChars / 4)} 工具${r.toolN} | ${r.prompt}`.length;
}
console.log(`  已实现（情形 45）· turn 索引：${rows.length} 行 / ${idxChars.toLocaleString()} 字符 ≈ ${K(idxChars)}K tok`);
console.log(`  ⇒ 它记的是「**哪一段在哪**」（位置索引）`);
console.log(`  用户新想法 · 目标树：记的是「**为了什么、试了什么、结果如何**」（内容索引）`);
console.log(`  ★ 两者**不是替代关系**：`);
console.log(`     · turn 索引 = **去哪里找**（我已经做了，便宜到可以常驻）`);
console.log(`     · 目标树   = **值不值得找**（要判断内容，需要 LLM 或人）`);

console.log("\n" + "═".repeat(84));
console.log("④ ★★★ 能不能**自动生成**？（决定成本，也决定可不可行）");
console.log("═".repeat(84));
// 试试纯规则：从推理块里抽"目标句"（含 需要/要/应该/检查/验证/先/然后 等），看抽取率
const PAT = /(?:需要|应该|要|必须|先|然后|接着|验证|检查|确认|目标|尝试|下一步|所以|因此|改为)/;
let allReasonBlocks = 0, withGoalWord = 0, charsAll = 0, charsExtract = 0;
const sentences = [];
for (const e of evs) {
  if (e.type !== "assistant/message") continue;
  for (const b of blocks(e)) {
    if (b.type !== "reasoning") continue;
    allReasonBlocks += 1;
    const t = b.text ?? "";
    charsAll += t.length;
    const parts = t.split(/(?<=[。.!?！？\n])/).map((s) => s.trim()).filter((s) => s.length > 8);
    const hits = parts.filter((s) => PAT.test(s));
    if (hits.length > 0) {
      withGoalWord += 1;
      for (const h of hits.slice(0, 3)) { sentences.push(h); charsExtract += h.length; }
    }
  }
}
console.log(`  推理块总数 = ${allReasonBlocks}`);
console.log(`  含"目标类关键词"的块 = ${withGoalWord}（${(100 * withGoalWord / allReasonBlocks).toFixed(1)}%）`);
console.log(`  抽出的候选句 = ${sentences.length} 条 / ${charsExtract.toLocaleString()} 字符`);
console.log(`  ★ **纯规则抽取的压缩比** = ${(charsAll / Math.max(1, charsExtract)).toFixed(1)} : 1`);
console.log(`  （原始推理 ${charsAll.toLocaleString()} 字符 → 候选 ${charsExtract.toLocaleString()} 字符）`);
console.log(`\n  抽取样例（前 6 条）：`);
for (const s of sentences.slice(0, 6)) console.log(`    · ${s.slice(0, 110)}`);
console.log(`\n  ★ 结论要靠两条判据分别说：`);
console.log(`     · **抽取率**（有多少块能被规则碰到）：${(100 * withGoalWord / allReasonBlocks).toFixed(0)}%`);
console.log(`     · **忠实度**（抽出来的还是不是"目标"）：★ 本探针**测不了** —— 它需要语义判断。`);
