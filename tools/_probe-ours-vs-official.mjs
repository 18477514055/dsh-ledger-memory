/**
 * ★★★ 只读：回答"我们 vs 官方"的分工边界 —— 三条测量。
 *
 * 用户 2026-10-11 18:5x 的硬判据（逐字）：
 *   *"在保证工作准确度、实现度和可延续性的绝对前提下，在所有的情况下都保证
 *    远超出官方设置上下文上限的所有东西都可以按需回溯、按需调取、
 *    保证准确度的基础上，去提高我们模型的下限。"*
 *
 * ⇒ 拆成可测的四条：
 *   ① **覆盖度**：被压掉的段，有多少能被**我们自己的**载体覆盖（台账/胶囊/索引）？
 *   ② **退化曲线**：官方摘要**逐次是不是真的在变薄**？（源码说会，实测要验）
 *   ③ **可回读率**：`ledger_recall` 上线后，模型真去调的比例（今天才上线 ⇒ 只能设判据）
 *   ④ **上限之外的量**：究竟有多少东西**超出了官方上下文上限**而必须靠外部载体？
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
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);
const K = (c) => (c / 4 / 1000).toFixed(1);
const bySeq = new Map();
for (const e of evs) bySeq.set(e.seq, e);
const summ = (c) => (Array.isArray(c?.data?.summary) ? c.data.summary.reduce((n, x) => n + (typeof x?.text === "string" ? x.text.length : 0), 0) : 0);

console.log("═".repeat(88));
console.log("② ★★★ 退化曲线：官方摘要是**逐次变薄**吗？（源码说会，这里实测）");
console.log("═".repeat(88));
const cs = evs.filter((e) => e.type === "compaction/summary");
console.log("  次序  时刻        被压节点  被压 tok(启发式)  摘要字符  摘要tok  压缩比  摘要/被压");
console.log("  " + "-".repeat(84));
const rows = [];
for (let i = 0; i < cs.length; i += 1) {
  const c = cs[i];
  const sc = summ(c);
  const st = Number(c.data?.shadowedTokenCount || 0);
  const nodes = Array.isArray(c.data?.shadowedSeqs) ? c.data.shadowedSeqs.length : 0;
  rows.push({ i: i + 1, at: c.time, seq: c.seq, sc, st, nodes });
  console.log(`  ${String(i + 1).padStart(3)}  ${hm(c.time)}  ${String(nodes).padStart(8)}  ${String(st).padStart(15)}  ${String(sc).padStart(8)}  ${String(Math.round(sc / 4)).padStart(7)}  ${(st / Math.max(1, sc / 4)).toFixed(0).padStart(6)}:1  ${(sc / 4 / Math.max(1, st) * 100).toFixed(2).padStart(7)}%`);
}
// 前半 vs 后半（只看"摘要字符数"随次序的走向）
const half = Math.floor(rows.length / 2);
const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const firstHalf = avg(rows.slice(0, half).map((r) => r.sc));
const secondHalf = avg(rows.slice(half).map((r) => r.sc));
console.log("");
console.log(`  前半均值 ${Math.round(firstHalf)} 字符 · 后半均值 ${Math.round(secondHalf)} 字符`);
console.log(`  ⇒ ${secondHalf > firstHalf ? "★ **后半更长** ⇒ **实测没有变薄**" : "★ **后半更短** ⇒ 变薄了"}`);
// 线性趋势
const n = rows.length;
const mx = (n - 1) / 2;
const my = avg(rows.map((r) => r.sc));
let num = 0, den = 0;
for (let i = 0; i < n; i += 1) { num += (i - mx) * (rows[i].sc - my); den += (i - mx) ** 2; }
const slope = num / den;
console.log(`  线性趋势斜率 = ${slope.toFixed(0)} 字符/次`);
console.log(`  ⇒ ${slope > 0 ? "★ 趋势是**变厚**（每次约 +" + Math.round(slope) + " 字符）" : "★ 趋势是**变薄**（每次约 " + Math.round(slope) + " 字符）"}`);
console.log("");
console.log("  ★ 关键对照：**摘要在长大，但被压的历史也在长大**。看最后一列「摘要/被压」：");
const ratios = rows.map((r) => r.sc / 4 / Math.max(1, r.st));
console.log(`     最早 ${(ratios[0] * 100).toFixed(1)}% → 最近 ${(ratios[ratios.length - 1] * 100).toFixed(2)}%`);
console.log(`     含义：**每 100 tok 被压掉的历史，只留下 ${(ratios[ratios.length - 1] * 100).toFixed(2)} tok 的摘要**`);

console.log("\n" + "═".repeat(88));
console.log("④ ★★★ 上限之外到底有多少东西？（用户要的「全部可回溯」的**总量**）");
console.log("═".repeat(88));
let shadowNodes = 0, shadowTok = 0, shadowChars = 0, reasonChars = 0, reasonN = 0;
for (const c of cs) {
  for (const sq of c.data?.shadowedSeqs ?? []) {
    const e = bySeq.get(sq);
    if (e === undefined) continue;
    shadowNodes += 1;
    const cc = e.data?.message?.content ?? e.data?.content;
    if (Array.isArray(cc)) {
      for (const b of cc) {
        const len = typeof b.text === "string" ? b.text.length : JSON.stringify(b).length;
        shadowChars += len;
        if (b.type === "reasoning") { reasonChars += len; reasonN += 1; }
      }
    } else if (typeof cc === "string") shadowChars += cc.length;
  }
  shadowTok += Number(c.data?.shadowedTokenCount || 0);
}
// 当前 surface（模型真正看得见的）
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
const WINDOW = 1000000;
console.log(`  被压掉的节点 = ${shadowNodes.toLocaleString()} 个`);
console.log(`  被压掉的**逐字原文** = ${shadowChars.toLocaleString()} 字符 ≈ ${K(shadowChars)}K tok ≈ **${(shadowChars / 4 / WINDOW).toFixed(2)} 个窗口**`);
console.log(`  其中 reasoning = ${reasonN.toLocaleString()} 块 / ${reasonChars.toLocaleString()} 字符 ≈ ${K(reasonChars)}K tok`);
console.log(`  内核自报被压 token（启发式）= ${shadowTok.toLocaleString()}`);
console.log("");
console.log(`  当前模型可见的 surface = ${nodes.length} 个节点`);
const visChars = (() => {
  let n = 0;
  for (const sq of nodes) {
    const e = bySeq.get(sq);
    if (e === undefined) continue;
    const cc = e.data?.message?.content ?? e.data?.content;
    if (Array.isArray(cc)) for (const b of cc) n += (typeof b.text === "string" ? b.text.length : JSON.stringify(b).length);
    else if (typeof cc === "string") n += cc.length;
  }
  return n;
})();
console.log(`  可见的逐字正文 ≈ ${K(visChars)}K tok`);
console.log("");
console.log(`  ★★★ 结论：**上限之外 = ${K(shadowChars)}K tok ≈ ${(shadowChars / 4 / WINDOW).toFixed(2)} 个百万窗口**`);
console.log(`     ⇒ 这就是用户说的"远超出官方上限的所有东西"。它**必须全部可回溯**。`);
console.log(`     ⇒ 当前可回读通道：\`ledger_recall\`（按 seq 从 session.log 读）—— **能覆盖 100%**（原文都在日志里）。`);

console.log("\n" + "═".repeat(88));
console.log("① 覆盖度：被压的段，有多少能被**我们自己的载体**覆盖？");
console.log("═".repeat(88));
const ROOT = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const carriers = [
  ["LEDGER.md（当前活跃台账）", path.join(ROOT, "LEDGER.md")],
  ["DECISIONS.md（长期决策）", path.join(ROOT, "DECISIONS.md")],
];
for (const [name, p] of carriers) {
  try {
    const st = fs.statSync(p);
    console.log(`  ${name.padEnd(28)} ${String(st.size).padStart(9)} 字符 ≈ ${K(st.size).padStart(7)}K tok`);
  } catch { console.log(`  ${name.padEnd(28)} 读不到`); }
}
const archiveDir = path.join(ROOT, "_ledger-archive");
const walkSize = (d) => {
  let n = 0, files = 0;
  const go = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const q = path.join(dir, e.name);
      if (e.isDirectory()) go(q);
      else { try { n += fs.statSync(q).size; files += 1; } catch {} }
    }
  };
  go(d);
  return { n, files };
};
const arc = walkSize(archiveDir);
console.log(`  ${"_ledger-archive/（归档，只追加）".padEnd(28)} ${String(arc.n).padStart(9)} 字符 ≈ ${K(arc.n).padStart(7)}K tok（${arc.files} 个文件）`);
const logDir = path.join(ROOT, "_ledger-log");
const lg = walkSize(logDir);
console.log(`  ${"_ledger-log/（活动日志 L0-L4）".padEnd(28)} ${String(lg.n).padStart(9)} 字符 ≈ ${K(lg.n).padStart(7)}K tok（${lg.files} 个文件）`);
const caps = path.join(os.homedir(), ".dsh", "plugin-data", "dsh-ledger-memory", "capsules.json");
try {
  const c = fs.statSync(caps);
  console.log(`  ${"capsules.json（逐字胶囊）".padEnd(28)} ${String(c.size).padStart(9)} 字符 ≈ ${K(c.size).padStart(7)}K tok`);
} catch { console.log(`  ${"capsules.json".padEnd(28)} 读不到`); }
console.log("");
const ours = arc.n + lg.n + (() => { try { return fs.statSync(caps).size; } catch { return 0; } })();
console.log(`  ⇒ 我们自己的载体合计 ≈ ${K(ours)}K tok`);
console.log(`  ⇒ 被压掉的原文 ≈ ${K(shadowChars)}K tok`);
console.log(`  ⇒ ★ **覆盖率对比：外部载体 ${K(ours)}K tok ÷ 被压原文 ${K(shadowChars)}K tok = ${(ours / shadowChars * 100).toFixed(1)}%**`);
console.log("");
console.log("  ★ 但**不要把覆盖率等同于「能否回溯」** —— 两者是**不同的路径**：");
console.log("     · 外部载体（台账/日志/胶囊）= **结构化的、我们控制的**，但它**只记我们选择记的**；");
console.log("     · `ledger_recall` = **逐字原文**，覆盖 **100%**，但**要模型主动去调**。");
console.log("     ⇒ ★ **两者互补，缺一不可**（这正是用户说的「按需回溯」+「保证准确度」）。");

console.log("\n" + "═".repeat(88));
console.log("③ 可回读率：`ledger_recall` 上线（今天）后的调用情况");
console.log("═".repeat(88));
const toolCalls = evs.filter((e) => e.type === "tool/call");
const recallCalls = toolCalls.filter((e) => {
  let a = e.data?.arguments;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = {}; } }
  return e.data?.name === "ledger_recall" || /ledger_recall/.test(String(e.data?.name ?? ""));
});
console.log(`  全会话 tool/call = ${toolCalls.length.toLocaleString()}`);
console.log(`  其中 ledger_recall = ${recallCalls.length}`);
console.log(`  本会话 tool 名里含 ledger 的：`);
const byName = new Map();
for (const e of toolCalls) {
  const nm = e.data?.name ?? "?";
  if (/^ledger_/.test(nm)) byName.set(nm, (byName.get(nm) ?? 0) + 1);
}
for (const [k, v] of [...byName].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(5)}×  ${k}`);
console.log("");
console.log(recallCalls.length === 0
  ? "  ★ **尚无调用** —— `ledger_recall` 刚上线（约 18:36 生效），本会话还没触发过压缩后的回读需求。\n     这不是缺陷（索引为空时不推行）。**但要设判据**：下次压缩后若模型需要旧细节却不去调，那就是失败。"
  : `  ★ 已调用 ${recallCalls.length} 次 ⇒ 通道被用起来了。`);
console.log("");
console.log("  ★ 建议的判据（写进自检或人工复核）：");
console.log("     ① **可用性**：压缩后注入里必须出现 seq 区间（已有情形 45 守着）；");
console.log("     ② **可读性**：`ledger_recall({from,to})` 必须返回非空（已有情形 45 守着）；");
console.log("     ③ **被使用**：★ 尚无自动判据 —— 依赖「模型会不会主动调」，这是行为问题，不是代码问题。");
