/**
 * ★★★ 只读：补用户批准的两个缺口（D83 §六）。
 *
 *  ③ **"被使用"判据**：`ledger_recall` 到底会不会被调？
 *     ★ 诚实前提：**目前 0 次**（它 18:36 才生效、且索引为空时不推行）。
 *       所以我**不能**用"历史调用数"来回答 —— 那是**空样本**。
 *       能做的是**把判据做成可观测的**（下次压缩后自动可查），并**如实报"尚无样本"**。
 *
 *  ② **"必须记住的有没有漏"**：拿**客观可比对**的东西做对照：
 *     ★ 选**用户原话**（L4 有逐字留档）与**决策编号**（D<n>）这两类**硬事实**，
 *       看被压掉的历史里有多少**能从我们的载体里找回来**。
 *     ⚠️ 判据必须写死：**"找回来"= 载体文本里出现该原话的关键子串**。
 *       这是**下界**（找不到 ≠ 一定漏，可能只是措辞不同），必须如实标注。
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

console.log("═".repeat(88));
console.log("③ 「被使用」判据：`ledger_recall` 有没有被调过？（★ 先报样本量，再报结论）");
console.log("═".repeat(88));
const toolCalls = evs.filter((e) => e.type === "tool/call");
const recallCalls = toolCalls.filter((e) => String(e.data?.name ?? "") === "ledger_recall");
// 压缩事件（用于"压缩后有没有调"的时间窗判据）
const compEnds = evs.filter((e) => e.type === "compaction/end").map((e) => e.time).sort((a, b) => a - b);
const recallToolLiveAt = (() => {
  // 工具上线时刻 ≈ 本会话最后一次重启之后第一个 request/header 含 ledger_recall 的时间
  const hdrs = evs.filter((e) => Array.isArray(e.data?.header?.tools));
  for (const h of hdrs) {
    if (h.data.header.tools.some((t) => t.name === "ledger_recall")) return h.time;
  }
  return undefined;
})();

console.log(`  样本量：全会话 tool/call = ${toolCalls.length.toLocaleString()} 次`);
console.log(`  ledger_recall 上线时刻 ≈ ${recallToolLiveAt === undefined ? "未探测到" : hm(recallToolLiveAt)}`);
console.log(`  ★ 上线之后的压缩次数 = ${compEnds.filter((t) => recallToolLiveAt !== undefined && t > recallToolLiveAt).length}`);
console.log(`  ★ ledger_recall 调用次数 = ${recallCalls.length}`);
console.log("");
if (recallCalls.length === 0) {
  console.log("  ★★ **结论：尚无样本 —— 不能判「好」或「坏」**（纪律：空样本桶就是报警，不许下结论）。");
  console.log("     为什么没样本（两条都是**正常**的）：");
  console.log("       ① 它刚上线（压缩后才产生索引）；");
  console.log("       ② **索引为空时不推行** ⇒ 若上线后还没压过，注入里根本没有 seq 区间可给。");
  console.log("     ⇒ 这正是**该建判据、而不是该下结论**的情形。");
}
console.log("");
console.log("  ★ 判据化（把这个「会不会被用」变成**可定期复核**的整数）：");
console.log("     P1 · 每次压缩后，注入里必须出现 ledger_recall 与 seq 区间（情形 45 已守）；");
console.log("     P2 · 每次压缩后，若模型遇到「需要旧细节」的情形，应在 N 步内出现 ledger_recall 调用；");
console.log("     P3 · ★ **可机械统计的那个数**：ledger_recall 调用次数 ÷ 压缩次数（上线后）。");
console.log(`          当前值 = ${recallCalls.length} ÷ ${compEnds.filter((t) => recallToolLiveAt !== undefined && t > recallToolLiveAt).length} = **无法计算（分母为 0）**`);

console.log("\n" + "═".repeat(88));
console.log("② 「必须记住的有没有漏」：用**硬事实**做对照（判据写死，如实标下界）");
console.log("═".repeat(88));
// 我们的载体全文（合并）
const ROOT = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const readAll = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const walkText = (d) => {
  let s = "";
  const go = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const q = path.join(dir, e.name);
      if (e.isDirectory()) go(q);
      else if (/\.(md|txt|json)$/.test(e.name)) s += readAll(q) + "\n";
    }
  };
  go(d);
  return s;
};
const carriers = {
  "LEDGER.md": readAll(path.join(ROOT, "LEDGER.md")),
  "DECISIONS.md": readAll(path.join(ROOT, "DECISIONS.md")),
  "_ledger-log/": walkText(path.join(ROOT, "_ledger-log")),
  "_ledger-archive/": walkText(path.join(ROOT, "_ledger-archive")),
  "capsules.json": readAll(path.join(os.homedir(), ".dsh", "plugin-data", "dsh-ledger-memory", "capsules.json")),
};
for (const [k, v] of Object.entries(carriers)) console.log(`  载体 ${k.padEnd(20)} ${String(v.length).padStart(9)} 字符`);
const ALL = Object.values(carriers).join("\n");

// ★ 硬事实 A：用户原话（取被压段里的 user/message）
const bySeq = new Map();
for (const e of evs) bySeq.set(e.seq, e);
const cs = evs.filter((e) => e.type === "compaction/summary");
let userMsgsShadowed = 0, userMsgsFound = 0;
const missing = [];
for (const c of cs) {
  for (const sq of c.data?.shadowedSeqs ?? []) {
    const e = bySeq.get(sq);
    if (e?.type !== "user/message") continue;
    const cc = e.data?.content;
    const txt = Array.isArray(cc) ? cc.filter((b) => b.type === "text").map((b) => b.text ?? "").join("") : "";
    if (txt.length < 12) continue;            // 太短的（注入类）不算
    if (/^Current runtime context|^The following project-ledger facts|^<goal_round>/.test(txt)) continue;
    userMsgsShadowed += 1;
    // 判据：取**前 20 个字符**做子串匹配（下界 —— 措辞不同就匹配不到）
    const probe = txt.replace(/\s+/g, "").slice(0, 20);
    if (probe.length >= 8 && ALL.replace(/\s+/g, "").includes(probe)) userMsgsFound += 1;
    else missing.push({ seq: sq, at: e.time, head: txt.slice(0, 50) });
  }
}
console.log("");
console.log("  ── 硬事实 A：**被压掉的用户原话** ─────────────────────────────");
console.log(`     被压掉的用户原话（>12 字符、非注入） = **${userMsgsShadowed}** 条`);
console.log(`     能在我们载体里找回（前 20 字符子串命中） = **${userMsgsFound}** 条`);
console.log(`     ⇒ **载体找回率（下界） = ${userMsgsShadowed === 0 ? "无样本" : (100 * userMsgsFound / userMsgsShadowed).toFixed(1) + "%"}**`);
console.log(`     ⚠️ 这是**下界**：找不到 ≠ 一定漏（可能只是措辞/去空白的差异）`);
if (missing.length > 0) {
  console.log(`     ★ 未命中的 ${missing.length} 条（前 6 条，可人工核）：`);
  for (const m of missing.slice(0, 6)) console.log(`        seq${m.seq} ${hm(m.at)}  ${m.head.replace(/\n/g, " ")}…`);
}

// ★ 硬事实 B：决策编号（DECISIONS 里的 D<n>，在台账/归档里被引用过没有）
const dNums = [...new Set([...readAll(path.join(ROOT, "DECISIONS.md")).matchAll(/^## (D\d+)\b/gm)].map((m) => m[1]))];
const other = carriers["LEDGER.md"] + carriers["_ledger-log/"] + carriers["_ledger-archive/"];
const dMissing = dNums.filter((d) => !new RegExp(`\\b${d}\\b`).test(other));
console.log("");
console.log("  ── 硬事实 B：**决策编号**（DECISIONS 里定义了，台账/日志/归档引用了没有）──");
console.log(`     DECISIONS 里定义 = **${dNums.length}** 个（${dNums[0]} … ${dNums[dNums.length - 1]}）`);
console.log(`     在载体别处**被引用** = **${dNums.length - dMissing.length}** 个`);
console.log(`     ⇒ **引用必达率 = ${(100 * (dNums.length - dMissing.length) / dNums.length).toFixed(1)}%**`);
if (dMissing.length > 0) {
  console.log(`     ★ 断链 ${dMissing.length} 个：${dMissing.join(" · ")}`);
  console.log(`        ⚠️ 注意：**「没被引用」不等于「丢了」** —— 它仍在 DECISIONS 里（永久保留）。`);
  console.log(`        这个数测的是**可发现性**（别的载体能不能把人引到它），不是**存在性**。`);
}

console.log("\n" + "═".repeat(88));
console.log("★ 本轮测出的两条判据（如实分列「已测 / 未测」）");
console.log("═".repeat(88));
console.log("  ✅ 已测：**用户原话的载体找回率**（下界）—— 见上");
console.log("  ✅ 已测：**决策编号的引用必达率** —— 见上");
console.log("  ⚠️ 未测：`ledger_recall` 的**实际使用率**（样本为 0，只能等下一次压缩）");
console.log("  ⚠️ 未测：**细节级**事实（文件:行号 / 报错原文 / 数值）的载体覆盖 —— 那是真正的难点");
