/**
 * ★★★ 只读：**重启之后，增量压缩到底有没有起效？**
 *
 * 两条独立证据（必须都对上，才算"起效"）：
 *   ① **内核侧**：`session/event` 里有没有 `compaction/start`+`compaction/end`（尤其 **不是** 80% 那次全量）。
 *      ★ 判据：压前水位、压后水位、压掉了多少 → 与设置的 `deltaRemovePoints` 比。
 *   ② **插件侧**：`ledger_status` 的 `compactionCounts`（那是插件自己的**可查计数器**）。
 *
 * ★ 时间窗（纪律第 1 条：指标必须有时间窗）：只看**最近一次重启之后**的事件。
 *   重启时刻的判据：`request/header` 里**第一次**出现 `ledger_recall` 的时刻（= 新代码加载点），
 *   或进程启动后第一条事件。
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
const W = 1000000;

console.log("═".repeat(88));
console.log("⓪ 先定「重启时刻」——只看重启之后的事件（纪律第 1 条：指标必须有时间窗）");
console.log("═".repeat(88));
// 重启判据：**时序上最后一个**「工具表里第一次出现 ledger_recall」的 header
const hdrs = evs.filter((e) => Array.isArray(e.data?.header?.tools));
let liveAt;
for (const h of hdrs) {
  if (h.data.header.tools.some((t) => t.name === "ledger_recall")) liveAt = h.time;  // 取最后一个
}
console.log(`  最后一次「工具表含 ledger_recall」的 header = ${liveAt === undefined ? "未探测到" : hm(liveAt)}`);
console.log(`  （这就是新代码加载点；此后的事件才算「本次重启之后」）`);

// 更准的重启界：seq 回退到该 header 之后的第一条 turn/start
const lastSeq = evs.filter((e) => e.type === "request/header" &&
  Array.isArray(e.data?.header?.tools) &&
  e.data.header.tools.some((t) => t.name === "ledger_recall")).map((e) => e.seq).pop();
console.log(`  对应 seq = ${lastSeq}`);
const after = evs.filter((e) => e.seq > lastSeq);
console.log(`  其后的事件数 = ${after.length}`);

console.log("\n" + "═".repeat(88));
console.log("① 内核侧：重启之后的**压缩事件**");
console.log("═".repeat(88));
for (const t of ["compaction/start", "compaction/summary", "compaction/end", "compaction/prune"]) {
  const xs = after.filter((e) => e.type === t);
  console.log(`  ${t.padEnd(22)} = ${xs.length}`);
}
const ends = after.filter((e) => e.type === "compaction/end");
if (ends.length === 0) {
  console.log("\n  ⇒ ★ **重启之后还没有任何一次压缩**。");
} else {
  for (const e of ends) console.log(`     ${hm(e.time)}  ${JSON.stringify(e.data ?? {}).slice(0, 120)}`);
}

console.log("\n" + "═".repeat(88));
console.log("② 水位轨迹：重启之后，水位涨到哪里了？（判断「该不该压」）");
console.log("═".repeat(88));
// 用真实 usage 反推窗口占用（这是**真实**尺度，不是启发式）
const routes = after.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => ({
    at: e.time,
    total: Number(e.data.usage.totalTokens || 0),
    miss: Number(e.data.usage.inputTokens || 0),
    cache: Number(e.data.usage.cacheReadTokens || 0),
  }));
if (routes.length === 0) {
  console.log("  ★ 重启之后还没有带 usage 的请求 ⇒ 无法判断水位");
} else {
  const first = routes[0], last = routes[routes.length - 1];
  const max = routes.reduce((a, b) => (b.total > a.total ? b : a));
  const WINDOW = 1000000;
  console.log(`  请求数 = ${routes.length}`);
  console.log(`  第一条：total=${first.total.toLocaleString()}（${(first.total / WINDOW * 100).toFixed(1)}%）  ${hm(first.at)}`);
  console.log(`  最高  ：total=${max.total.toLocaleString()}（${(max.total / WINDOW * 100).toFixed(1)}%）  ${hm(max.at)}`);
  console.log(`  最近  ：total=${last.total.toLocaleString()}（${(last.total / WINDOW * 100).toFixed(1)}%）  ${hm(last.at)}`);
  console.log("");
  console.log(`  ★ 触发线：增量 = 锚点 + \`deltaTriggerPoints\`（默认 20 点）；全量 = 70%`);
  console.log(`  ⇒ 当前 ${(last.total / WINDOW * 100).toFixed(1)}% ${last.total / WINDOW >= 0.7 ? "**已越过 70% ⇒ 应当全量**" : "未到 70%"}`);
}

console.log("\n" + "═".repeat(88));
console.log("③ ★★★ 插件侧计数器（`ledger_status` 的 compactionCounts）—— 需另外调用核对");
console.log("═".repeat(88));
console.log("  ⚠️ 那是**内存计数**，本探针读不到 ⇒ 由 `ledger_status` 工具回答（已在同一轮调用）。");
console.log("  ★ 两个来源要对得上：内核侧的 compaction/end 次数 == 插件侧 total。");

console.log("\n" + "═".repeat(88));
console.log("④ 全会话对照：增量 vs 全量（看清「本次重启之前」的分布）");
console.log("═".repeat(88));
const allEnds = evs.filter((e) => e.type === "compaction/end");
console.log(`  全会话压缩次数 = ${allEnds.length}`);
const allStarts = evs.filter((e) => e.type === "compaction/start");
const bySrc = new Map();
for (const e of allStarts) {
  const s = String(e.data?.source ?? e.data?.sourceCommandId ?? "auto/unknown");
  bySrc.set(s, (bySrc.get(s) ?? 0) + 1);
}
console.log(`  compaction/start 的来源分布：`);
for (const [k, v] of [...bySrc].sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(4)}×  ${k.slice(0, 60)}`);
console.log("");
console.log(`  ★ 最后 5 次压缩的时刻（含本次重启前后的分界）：`);
for (const e of allEnds.slice(-5)) console.log(`     ${hm(e.time)}  seq=${e.seq}`);
