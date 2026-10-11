/**
 * ★★★ 只读评估：**「改成『原文完整存档 + 移出上下文』」这条路 —— 可行吗？能省多少？**
 *
 * 用户的想法（2026-10-11）：把压缩过程变成"把原文完整存档，然后移出上下文"，
 * 上下文里保留的更少，但**准确度不变**。
 *
 * 本探针不实现任何东西，只回答五个可证伪的问题：
 *   ⓪ 重启后 D73/D74 是否生效？
 *   ① 能否**逐字取回**被压掉的原文？（准确度的前提）
 *   ② **保留段**在上下文里占多少？把它也存档、上下文只留指针，能省多少？
 *   ③ 模型**真的会去读存档**吗？
 *   ④ 这个想法**能不能通过内核的公开 API 做到**？（可行性硬约束）
 *
 * ★★ 我第一版犯了个尺子错，记在这里：我**假设"所有事件都在 surface 上"**，
 *   据此重建 surface ⇒ 自检 **27/27 全失败**（`shadowedSeqs` 要替换的那段
 *   在当前 surface 里**不连续**）。真实情况是：**只有带 `surfaceOp` 的事件才在 surface 上**
 *   （`step/start`、`compaction/*`、`request/header` 等都不在）。
 *   ⇒ 本版**不再重建 surface**，改用**真实水位**算保留段 —— 少一层假设，少一处出错。
 *
 * ★ 只读；只按 `j.type` / `e.seq` 精确匹配。
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
const bySeq = new Map();
for (const e of evs) if (Number.isFinite(e.seq)) bySeq.set(e.seq, e);
const startsById = new Map();
for (const e of evs) if (e.type === "compaction/start") startsById.set(e.data?.compactionId, e.data);
const routes = evs.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => ({
    time: e.time,
    prompt: Number(e.data.usage.inputTokens || 0) + Number(e.data.usage.cacheReadTokens || 0),
  })).sort((a, b) => a.time - b.time);
const sums = evs.filter((e) => e.type === "compaction/summary")
  .map((e) => ({ time: e.time, id: e.data?.compactionId, heur: Number(e.data?.shadowedTokenCount ?? 0), seqs: e.data?.shadowedSeqs ?? [] }))
  .sort((a, b) => a.time - b.time);
for (const s of sums) s.turn = startsById.get(s.id)?.turn;

console.log("═".repeat(78));
console.log("⓪ 重启后 D73/D74 是否生效（顺手验，我该确认）");
console.log("═".repeat(78));
const inj = evs.filter((e) => e.type === "user/message").map((e) => {
  const c = e.data?.content;
  return { time: e.time, text: typeof c === "string" ? c : (Array.isArray(c) ? c.map((x) => x?.text ?? "").join("") : "") };
});
const nw = inj.filter((x) => /这是打算，不是结果/.test(x.text));
const ow = inj.filter((x) => /压掉约 \d+ 点（保留段约/.test(x.text));
console.log(`  D73 新文案出现 **${nw.length}** 次（最近 ${nw.length ? hm(nw[nw.length - 1].time) : "—"}）`);
console.log(`  旧文案出现 ${ow.length} 次（最近 ${ow.length ? hm(ow[ow.length - 1].time) : "—"}）`);
console.log(`  ⇒ ${nw.length > 0 && (ow.length === 0 || nw[nw.length - 1].time > ow[ow.length - 1].time)
  ? "★ **D73 已生效**（新文案是最新的那条）" : "★ 看不到新文案（重启后可能还没触发过增量压缩）"}`);
try {
  const p = path.join(os.homedir(), ".dsh", "plugin-data", "dsh-ledger-memory", "capsules.json");
  const st = fs.statSync(p);
  console.log(`  D74 capsules.json 末写 **${new Date(st.mtimeMs).toLocaleString("sv-SE")}**` +
    `（重启后仍在写 ⇒ 去抖落盘在工作；★ 但"条数"要等新原话来了才涨）`);
} catch (e) { console.log(`  D74 读不到：${String(e?.message ?? e)}`); }

console.log("\n" + "═".repeat(78));
console.log("① 能否**逐字取回**被压掉的原文？（「准确度不变」的前提）");
console.log("═".repeat(78));
const fullOne = sums.filter((x) => x.turn === null).slice(-1)[0];
console.log(`  抽样：最后一次全量压缩 ${hm(fullOne.time)}，被压 ${fullOne.seqs.length} 个节点 / ` +
  `内核自报 ${fullOne.heur.toLocaleString()} 启发式 token`);
for (const s of fullOne.seqs.slice(1, 3).concat(fullOne.seqs.slice(-2))) {
  const ev = bySeq.get(s);
  const c = ev?.data?.content ?? ev?.data?.message?.content;
  const txt = (typeof c === "string" ? c : JSON.stringify(c ?? "")).replace(/\s+/g, " ").slice(0, 78);
  console.log(`     seq ${String(s).padStart(6)} ${String(ev?.type).padEnd(18)} | ${txt}`);
}
console.log("  ⇒ ★★ 这些是**逐字原文，不是摘要**，而且它们**本来就在磁盘上**：");
console.log("     · 官方会话日志 `session.v4.jsonl.zstd`（内核自己写的，永远保留）");
console.log("     · `compaction/summary.shadowedSeqs` 精确记着**被压掉的是哪个 seq 区间**");
console.log("     ⇒ **「完整存档」这件事本机早已具备** —— 不需要新存一遍。");
console.log("     真正缺的是：**让模型知道「哪一段被移走了、去哪儿逐字取回」**（= 指针 + 检索纪律）。");

console.log("\n" + "═".repeat(78));
console.log("② 上下文里还留着多少「逐字原文」？只留指针能省多少？");
console.log("═".repeat(78));
console.log("  ★ 算法（**不重建 surface，少一层假设**）：");
console.log("     「地板」= 刚做完**全量**压缩后的水位（那时上下文最小）；");
console.log("     它 ≈ 工具头 + system + 一小截保留尾巴。");
console.log("     ⇒ **保留段 ≈ 增量压缩后的水位 − 地板**。\n");
const floors = [];
for (const s of sums.filter((x) => x.turn === null)) {
  const after = routes.find((r) => r.time > s.time);
  if (after !== undefined) floors.push(after.prompt / W * 100);
}
const floor = floors.reduce((a, b) => a + b, 0) / floors.length;
console.log(`  「地板」实测（每次全量压缩之后的第一条真实请求）：` +
  floors.map((f) => f.toFixed(1) + "%").join(" / ") + ` ⇒ 均值 **${floor.toFixed(1)}%**`);
const FIX = new Date("2026-10-11T03:25:00+08:00").getTime();
console.log("\n  时刻     归属  压缩后水位  ★保留段(点)  = 水位 − 地板");
console.log("  " + "-".repeat(58));
const retainedPts = [];
for (const s of sums.filter((x) => x.turn !== null && x.time >= FIX)) {
  const after = routes.find((r) => r.time > s.time);
  if (after === undefined) continue;
  const lvl = after.prompt / W * 100;
  const ret = lvl - floor;
  retainedPts.push(ret);
  console.log(`  ${hm(s.time)}  t${String(s.turn).padStart(2)}  ${lvl.toFixed(1).padStart(9)}%  ${ret.toFixed(1).padStart(12)} 点`);
}
const avgRet = retainedPts.reduce((a, b) => a + b, 0) / (retainedPts.length || 1);
console.log(`\n  ★ 增量压缩后「保留段」平均 ≈ **${avgRet.toFixed(1)} 点**（= 窗口的 ${avgRet.toFixed(1)}%）`);
console.log(`  ★ 「地板」≈ **${floor.toFixed(1)} 点** —— 而它基本就是**工具头**（本机 406 个工具 ≈ 116K）；`);
console.log(`     即：**上下文里有一块是不可压缩的**（每次请求都必须带上工具定义）。`);
console.log("\n  ★★★ 把保留段也存档之后，棘轮会怎样？**这里我第一版算错了，重算**：");
console.log("     每轮的水位 = 压前 + 触发(20) − 压掉的量；而『压掉的量』会包含**整条保留段**：");
const dropWithArchive = avgRet + 4.4;   // 保留段 + 本轮真实压掉的
console.log(`       现在：压掉 ≈ ${(4.4).toFixed(1)} 点 ⇒ 每轮**净涨 20 − 4.4 = +15.6 点** ⇒ 一路爬到 70%`);
console.log(`       存档：压掉 ≈ 保留段 ${avgRet.toFixed(1)} + 本轮 ${(4.4).toFixed(1)} = **${dropWithArchive.toFixed(1)} 点**`);
console.log(`             ⇒ 每轮**净涨 20 − ${dropWithArchive.toFixed(1)} = ${(20 - dropWithArchive).toFixed(1)} 点**（**负数！**）`);
console.log("     ⇒ ★★★ 也就是说：**水位不再往上爬，而是在「地板 ↔ 地板+20」之间来回摆**");
console.log(`        （${floor.toFixed(1)}% ↔ ${(floor + 20).toFixed(1)}%），**永远碰不到 70% 那道墙**。`);
console.log("     ⇒ 这比「省一点上下文」强得多：它等于**把棘轮整个取消掉**。");
console.log("        （用户原先设计的 20→30→…→70 阶梯，前提是**每轮只压掉一小段**。）");
console.log("     ⚠️ 但这**全部取决于「准确度是否真的不变」** —— 那是未证的（见 ③ 与 ④）。");
console.log("     ⚠️ 另一个副作用：每轮要压掉的段从 ~10 点涨到 ~43 点 ⇒");
console.log("        **每次压缩要总结的内容多 4 倍**（内核那次 LLM 调用更贵、更慢）。");

console.log("\n" + "═".repeat(78));
console.log("③ 模型**真的会去读存档**吗？");
console.log("═".repeat(78));
const reads = evs.filter((e) => e.type === "tool/call" &&
  /^(read|grep|glob|pwsh|Get-Content|Select-String)$/i.test(String(e.data?.name ?? "")));
const toArchive = reads.filter((e) => /LEDGER\.md|DECISIONS\.md|_ledger-log|capsules|_ledger-archive|_stash/.test(String(e.data?.arguments ?? "")));
const ends = sums.map((s) => s.time).sort((a, b) => a - b);
let within10 = 0;
for (const h of toArchive) {
  const prev = [...ends].reverse().find((t) => t <= h.time);
  if (prev !== undefined && h.time - prev <= 10 * 60 * 1000) within10 += 1;
}
console.log(`  本会话 read/grep/glob/pwsh 类调用 **${reads.length}** 次；` +
  `其中指向台账/归档/胶囊的 **${toArchive.length}** 次（${(toArchive.length / reads.length * 100).toFixed(1)}%）`);
console.log(`  其中发生在**某次压缩后 10 分钟内**的：**${within10}** 次`);
console.log("  ⇒ ★★ 这两个数**都不能证明「准确度不变」** —— 它们只说「会回读」，");
console.log("     而「回读得够不够及时、够不够准」必须做**对照实验**（存档组 vs 不存档组做同一件事）。**未做。**");

console.log("\n" + "═".repeat(78));
console.log("④ ★★★ 可行性硬约束：这个想法**能不能用内核的公开 API 做到**？");
console.log("═".repeat(78));
console.log("  内核设计（读源码坐实，见 D62/D70 的引用）：");
console.log("    · 唯一的公开改动手段是 `compaction.compactRegion(start, end, agent)`；");
console.log("    · 它把选中的**连续段替换成【一个摘要节点】**（`commitCompactionBody` → `user/message`");
console.log("      + `surfaceOp: {op:'replace'}`），而那个摘要是**内核调 LLM 生成的**");
console.log("      （`summarizeCompaction` → `dependencies.summarize(...)`）；");
console.log("    · 且内核**强制**：摘要素小于被替换段（`framedSummaryTokenCount >= shadowedRouteTokenCount` 就抛错）。");
console.log("\n  ⇒ ★ 结论分三条：");
console.log("    (a) **「移除 + 完全不留摘要」做不到** —— 公开 API 只给 `compactRegion`，");
console.log("        它必然产生一个摘要节点。要「只留指针」，得改内核（不在本插件权限内）。");
console.log("    (b) **「上下文保留更少」现在就能做** —— 保留多少本来就由**我们选的范围**决定");
console.log("        （`retainTokens`）。把它调小 = 少留逐字、多移走。**不需要新机制。**");
console.log("    (c) **「准确度不变」的支点不是存档、是指针+检索纪律** —— 存档早就在了");
console.log("        （官方会话日志 + 胶囊），缺的是**让模型知道去哪逐字取回**。");
console.log("\n  ⇒ ★ 所以你这个想法可以**拆成两半**，各自独立评估：");
console.log("     半 1（省上下文）：调小保留段 —— 今天就能做，代价是**最近的内容不再逐字在场**；");
console.log("     半 2（保准确）：**指针 + 按需回读** —— 这才是新的、也是真正值钱的部分。");
