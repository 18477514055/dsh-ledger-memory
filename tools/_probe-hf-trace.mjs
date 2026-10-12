/**
 * ★★★ 只读：核实「全量自动压缩到底跑过没有」。
 *
 * 起因（用户 2026-10-11 第 2 点，逐字）：
 *   *"我在设置面板中实际设置的是0.75自动执行一次全量压缩，但是全量压缩从来没有自动进行过，
 *     刚才甚至已经到了78%，79的样子，已经接近危险边缘了，全量压缩还是没有发生，说明这个自动化也有bug。"*
 *
 * ★ 本轮已发现的**矛盾证据**（这就是为什么要写这个探针）：
 *   · 胶囊目录里有 **3 份**新胶囊：19:24:59 自动（增量）/ **19:27:38 自动（70% 水位）** / 19:27:57 手动（命令）
 *   · 而 L0 里只落了 **2 条** `compaction/end`：19:25:26 自动（增量）/ 19:28:11 手动（命令）
 *   ⇒ **有一份胶囊没有配对的内核 compaction/end**。
 *
 * ★ 要回答的四个问题：
 *   ① 内核这一段时间到底发了几次 start / summary / end？
 *   ② `state.hfSource` 是**单槽**（Map<sid,source>）—— 并发压缩会不会**互相覆盖**，
 *      导致 auto:70% 那次被记成"手动（命令）"？（那就是"记录存在 ≠ 记录准确"）
 *   ③ 那次 auto:70% 的全量**真的压掉东西了吗**（压前/压后水位）？
 *   ④ 为什么从没见到 auto:70% 的 compaction/end —— 是没跑，还是跑了没配对，还是被覆盖？
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
const ROOT = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";

const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
evs.sort((a, b) => a.seq - b.seq);
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);
const WIN = 1000000;

console.log("═".repeat(94));
console.log("① 全部压缩事件（start / summary / end 三连，看它们配不配对）");
console.log("═".repeat(94));
const kinds = ["compaction/start", "compaction/summary", "compaction/end"];
const comp = evs.filter((e) => kinds.includes(e.type));
console.log(`  合计：${comp.length} 条  ` + kinds.map((k) => `${k.split("/")[1]}=${comp.filter((e) => e.type === k).length}`).join("  "));
console.log(`  ★ 若 start ≠ end ⇒ 有一次压缩**开始了却没结束**（或结束事件没落盘）。`);
console.log("");
console.log("  时间          类型                 关键字段");
for (const e of comp) {
  if (e.time < Date.parse("2026-10-11T19:00:00+08:00")) continue;
  const d = e.data ?? {};
  const bits = [];
  if (d.source !== undefined) bits.push(`source=${d.source}`);
  if (d.shadowedSeqs) bits.push(`nodes=${d.shadowedSeqs.length}`);
  if (d.shadowedTokenCount !== undefined) bits.push(`tok=${d.shadowedTokenCount}`);
  if (d.shadowedRange) bits.push(`range=${JSON.stringify(d.shadowedRange)}`);
  if (d.totalTokens !== undefined) bits.push(`totalTok=${d.totalTokens}`);
  if (d.summarySeq !== undefined) bits.push(`summarySeq=${d.summarySeq}`);
  console.log(`  ${hm(e.time)}  ${e.type.padEnd(20)} ${bits.join("  ")}`);
}

console.log("\n" + "═".repeat(94));
console.log("② 19:20~19:35 的真实水位轨迹（看那次 auto:70% 到底压掉多少）");
console.log("═".repeat(94));
const routes = evs.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => ({ seq: e.seq, at: e.time, total: Number(e.data.usage.totalTokens || 0) }))
  .sort((a, b) => a.at - b.at);
const lo = Date.parse("2026-10-11T19:20:00+08:00"), hi = Date.parse("2026-10-11T19:35:00+08:00");
for (const r of routes) {
  if (r.at < lo || r.at > hi) continue;
  console.log(`  ${hm(r.at)}  seq=${String(r.seq).padStart(6)}  ${(r.total / WIN * 100).toFixed(1).padStart(6)}%`);
}

console.log("\n" + "═".repeat(94));
console.log("③ 胶囊目录 vs L0 的对账（3 份胶囊 / 2 条 end ⇒ 谁没配对？）");
console.log("═".repeat(94));
const capDir = path.join(ROOT, "_ledger-log", "2026-10", "week2", "capsules");
const caps = fs.readdirSync(capDir).filter((f) => f.endsWith(".md")).sort();
for (const f of caps) {
  const head = fs.readFileSync(path.join(capDir, f), "utf8").split("\n").slice(0, 5).join(" ");
  const src = /来源\*\*：([^ |>]+)/.exec(head)?.[1] ?? "?";
  const stamp = /逐字胶囊 · ([\d-]+ [\d:]+)/.exec(head)?.[1] ?? "?";
  console.log(`  ${stamp}  来源=${src.padEnd(16)}  ${f}`);
}

console.log("\n" + "═".repeat(94));
console.log("④ ★ 结论所需的判断");
console.log("═".repeat(94));
const nStart = comp.filter((e) => e.type === "compaction/start" && e.time >= lo).length;
const nEnd = comp.filter((e) => e.type === "compaction/end" && e.time >= lo).length;
const nCap = caps.filter((f) => f >= "2026-10-11-1920").length;
console.log(`  19:24 之后：start=${nStart}  end=${nEnd}  胶囊=${nCap}`);
console.log(`  ⇒ ${nCap > nEnd ? "★★★ 胶囊多于 end ⇒ **有压缩开跑了却没留下配对记录**（或两次压缩重叠）" : "胶囊与 end 数量一致"}`);
console.log("");
console.log("  ★ 单槽 hfSource 的并发覆盖风险（lib/index.js L10359 写 / L11178-11182 读并删）：");
console.log("     写入是 `state.hfSource.set(key, source)`，读出后 delete。");
console.log("     若两次 runHighFidelityCompact **重叠**（await compactNow 各要几十秒），");
console.log("     后写的那次会覆盖前一次的 source ⇒ **compaction/end 被标成别人的来源**。");
console.log("     ⇒ 症状正是：**auto:70% 真跑了，L0 里却看不到它**（记成手动/被吞）。");

console.log("\n" + "═".repeat(94));
console.log("⑤ 出自动 70% 的那些 pre-step —— 看 hfCompactAfterTurn 有没有真被排上");
console.log("═".repeat(94));
const pre = evs.filter((e) => e.type === "turn/start" || e.type === "turn/end" || e.type === "request/header");
for (const e of pre) {
  if (e.time < Date.parse("2026-10-11T19:23:00+08:00") || e.time > Date.parse("2026-10-11T19:32:00+08:00")) continue;
  console.log(`  ${hm(e.time)}  ${e.type}`);
}
