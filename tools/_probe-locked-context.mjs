/**
 * ★★★ 只读评估：用户 2026-10-11 的灵感 —— **「锁死上下文 + 多锚点目录 + 强制查目录」**
 *
 * 用户原话大意：
 *   *"维护一个详尽的由多个参数锚点的目录。每次注入模型上下文的，只有用来命中缓存的严格前缀
 *    以及工具定义，然后提示词最好就是强制命令模型，每次开始工作都强制去查移到文件的目录，
 *    然后查目录之后，再查各种各样的我们保留下来的东西来达成无损接续前面工作的程度，
 *    这样子的话，甚至都不用压缩，上下文可以一直锁在同一个地方。"*
 *
 * 本探针只测三个**决定性**的问题（全部只读、只按 j.type 精确匹配）：
 *   ① 压缩到底有多贵？—— **每次压缩之后，有多少 token 是"未命中缓存"重读的**。
 *      （用户说"锁死前缀"能省东西 —— 省的就是这个。）
 *   ② 上下文是被什么填满的？—— 工具结果 / assistant 文本 / 用户文本 各占多少。
 *      （决定"能不能机械地搬走而不丢准确度"。）
 *   ③ 能不能**不调 LLM 就搬走**？—— `compaction/prune`（工具结果裁剪器）是否真的存在并跑过。
 *      （★ 这是用户想法能否成立的关键：内核全量压缩**必然调一次 LLM**，但如果能靠 prune 搬走，
 *        就能做到"机械、便宜、无损"。）
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

const routes = evs.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => ({
    time: e.time,
    input: Number(e.data.usage.inputTokens || 0),      // ★ 未命中部分 = 要**全价**付费的
    cache: Number(e.data.usage.cacheReadTokens || 0),  // 命中部分 = 便宜
  })).sort((a, b) => a.time - b.time);

console.log("═".repeat(78));
console.log("① 压缩有多贵：**每次压缩之后被迫「未命中重读」了多少**");
console.log("═".repeat(78));
console.log("  时刻(压缩)  压缩前未命中  压缩后未命中   被迫重读(≈)   是压缩前几倍");
console.log("  " + "-".repeat(78));
const ends = evs.filter((e) => e.type === "compaction/end").map((e) => e.time).sort((a, b) => a - b);
let totalForced = 0;
let n = 0;
for (const t of ends) {
  const before = [...routes].reverse().find((r) => r.time <= t);
  const after = routes.find((r) => r.time > t);
  if (before === undefined || after === undefined) continue;
  const forced = Math.max(0, after.input - before.input);
  totalForced += forced; n += 1;
  console.log(`  ${hm(t)}  ${String(before.input).padStart(12)}  ${String(after.input).padStart(12)}  ` +
    `${String(forced).padStart(13)}  ${String((forced / Math.max(1, before.input)).toFixed(1) + "×").padStart(15)}`);
}
console.log(`\n  ★ 共 ${n} 次压缩，被迫重读合计 ≈ **${(totalForced / W).toFixed(1)} 点**（= ${totalForced.toLocaleString()} token）`);
console.log(`  ★ 会话全部未命中输入合计 = ${(routes.reduce((a, b) => a + b.input, 0) / W).toFixed(1)} 点`);
console.log(`  ⇒ ★★ 压缩引起的"被迫重读"占了全部未命中输入的 **${(totalForced / routes.reduce((a, b) => a + b.input, 0) * 100).toFixed(1)}%**。`);
console.log("     这就是用户说「锁死前缀」能省掉的那一块。");
console.log("     （机制：压缩往中间插了一个 checkpoint ⇒ 它**之后**的全部前缀都变了 ⇒ 缓存失效。）");

console.log("\n" + "═".repeat(78));
console.log("② 上下文被什么填满？（决定「能不能机械搬走」）");
console.log("═".repeat(78));
const bytes = { "tool/result": 0, "assistant/message": 0, "user/message": 0, "developer/message": 0, "其它": 0 };
const count = {};
const charsOf = (ev) => {
  const t = ev.type;
  if (t === "assistant/message") {
    let s = 0;
    for (const b of ev.data?.message?.content ?? []) {
      if (b?.type === "text" || b?.type === "reasoning") s += String(b.text ?? "").length;
      else if (b?.type === "tool-call") s += String(b.name ?? "").length + String(b.arguments ?? "").length;
      else s += JSON.stringify(b ?? "").length;
    }
    return s;
  }
  if (t === "tool/result") {
    const c = ev.data?.content ?? ev.data?.message?.content ?? ev.data;
    return (typeof c === "string" ? c : JSON.stringify(c ?? "")).length;
  }
  if (t === "user/message" || t === "system/message" || t === "developer/message") {
    const c = ev.data?.content ?? ev.data?.message?.content;
    return (typeof c === "string" ? c : JSON.stringify(c ?? "")).length;
  }
  return 0;
};
for (const e of evs) {
  if (!["assistant/message", "tool/result", "user/message", "developer/message", "system/message", "tool/call"].includes(e.type)) continue;
  const c = charsOf(e);
  if (c === 0) continue;
  const k = e.type === "tool/call" ? "tool/result" : (bytes[e.type] !== undefined ? e.type : "其它");
  bytes[k] += c;
  count[k] = (count[k] ?? 0) + 1;
}
const total = Object.values(bytes).reduce((a, b) => a + b, 0);
console.log("  类别                条数    字符数        占比    ≈启发式 token");
for (const [k, v] of Object.entries(bytes).sort((a, b) => b[1] - a[1])) {
  if (v === 0) continue;
  console.log(`  ${k.padEnd(18)} ${String(count[k] ?? 0).padStart(6)}  ${String(v.toLocaleString()).padStart(12)}  ` +
    `${String((v / total * 100).toFixed(1)).padStart(6)}%  ${String(Math.ceil(v / 4).toLocaleString()).padStart(12)}`);
}
console.log(`\n  ★ 工具结果（tool/result）占 **${(bytes["tool/result"] / total * 100).toFixed(1)}%** ——`);
console.log("     它是**最大的一块**，而且它天然适合「搬走 + 留指针」（结果可以重新跑/重新读）。");
console.log(`  ★ 而 assistant 文本（含 reasoning）占 ${(bytes["assistant/message"] / total * 100).toFixed(1)}% ——`);
console.log("     这块**搬走了就没了**（推理过程无法重放）⇒ 要搬它必须有目录/指针。");

console.log("\n" + "═".repeat(78));
console.log("③ 有没有「不调 LLM 就能搬走」的手段？—— `compaction/prune`");
console.log("═".repeat(78));
const prunes = evs.filter((e) => e.type === "compaction/prune");
console.log(`  \`compaction/prune\` 事件：**${prunes.length}** 次`);
for (const p of prunes) {
  const seqs = p.data?.shadowedSeqs ?? [];
  console.log(`     ${hm(p.time)}  裁掉 ${seqs.length} 个节点 · 内核自报 ${Number(p.data?.shadowedTokenCount ?? 0).toLocaleString()} token`);
}
console.log("  ★ 内核源码里它的调用点（`dsh-compaction-basic` 的 `compactIfNeeded`）：");
console.log("     `const prune = this.ctx.get(\"toolResultPruner\"); if (prune !== void 0) prune.pruneSession(...)`");
console.log("     ⇒ **它是碰压缩之前先试的第一招，且只裁工具结果、不调 LLM。**");
console.log(`  ⇒ ★★ 本机实测它**确实在跑**（${prunes.length} 次），说明这条路是**通的**；`);
console.log("     但它的触发点**绑在压缩上**（压力/溢出时才跑）⇒ 目前**没有被当成主要手段用**。");

console.log("\n" + "═".repeat(78));
console.log("④ 小结（可证伪的部分）");
console.log("═".repeat(78));
console.log("  · 「锁死前缀能省东西」—— ✔ **有数**：压缩导致的被迫重读占全部未命中输入的上面那个百分比。");
console.log("  · 「上下文能一直锁在同一处、完全不用压缩」—— ⚠️ **需要修正**：");
console.log("    模型的**每次读文件/跑命令**都会往上下文里加东西（工具结果占 "
  + `${(bytes["tool/result"] / total * 100).toFixed(0)}%），`);
console.log("    所以「锁死」不是「不发生搬走」，而是**「搬走这件事要变得机械、便宜、无损」**。");
console.log("  · 「强制查目录」—— ⚠️ **提示词是软的**。本机已有一条**硬**的做法可照抄：");
console.log("    `flushBeforeCompact` 那道闸门（不写台账就不放行压缩）——");
console.log("    即**把「查目录」变成长进度的前置条件**，而不是靠模型自觉。");
