/**
 * ★★★ 只读：**"4.4 那次之后，增量压缩又跑过几次？起效了没有？"**
 *
 * 用户的原意（2026-10-11 19:1x）：
 *   *"我的意思是在上次我们发现压缩实际只压缩了 4.4 之后，我们又进行了几次压缩，它有没有起效？
 *     我们肯定是先讨论工具有没有起效，才讨论把这个压缩进一步扩大。"*
 *   ⇒ ★ 只问**增量**，不问全量；时间窗是**"4.4 那次之后"**，不是"重启之后"。
 *
 * ★ 权威来源：**插件自己写的 L0 里程碑**（`compaction/end` + 人类可读来源），
 *   它比内核的 `compaction/start.data.source`（19 次都是 auto/unknown）**精确**——
 *   因为它标注了"自动（增量）" vs "手动（命令）" vs "auto:delta"。
 *
 * ★ 判据（每一步都要给数）：
 *   ① 把 L0 里标注为**增量**的那几次挑出来；
 *   ② 对每次，量 **压前水位 → 压后水位**（用**真实 usage**，不是启发式）；
 *   ③ 与设置的 `deltaRemovePoints`(=10) 比 ⇒ **兑现率**；
 *   ④ 与 D70 记录的 **4.4** 比 ⇒ 有没有变好。
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
const WIN = 1000000;

// ── 读 L0：插件自己标注的每一次压缩来源（**权威**） ──────────────────────
const ROOT = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const l0 = (() => { try { return fs.readFileSync(path.join(ROOT, "_ledger-log", "2026-10", "week2", "L0-milestones.md"), "utf8"); } catch { return ""; } })();
const marked = [];
for (const line of l0.split("\n")) {
  const m = line.match(/^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \(compaction\/end\) 上下文已压缩（(.+?)）$/);
  if (m) marked.push({ at: m[1], kind: m[2] });
}
console.log("═".repeat(92));
console.log("⓪ 权威来源：插件自己写的 L0 里程碑（它标了「增量」还是「全量/手动」）");
console.log("═".repeat(92));
console.log(`  L0 里记到的压缩 = ${marked.length} 次（全会话内核侧是 22 次 ⇒ 早期几次 L0 还没启用）`);
for (const m of marked) {
  const tag = /增量/.test(m.kind) || /delta/.test(m.kind) ? "★增量" : "  其他";
  console.log(`  ${tag}  ${m.at}  ${m.kind}`);
}
const deltas = marked.filter((m) => /增量/.test(m.kind) || /delta/.test(m.kind));
console.log(`\n  ⇒ ★ **标注为「增量」的 = ${deltas.length} 次**`);

// ── 真实水位轨迹（usage 是**真实**尺度） ────────────────────────────────
const routes = evs.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => ({ seq: e.seq, at: e.time, total: Number(e.data.usage.totalTokens || 0) }))
  .sort((a, b) => a.at - b.at);

// 把 "YYYY-MM-DD HH:MM:SS"（本地）转成毫秒
const toMs = (s) => {
  const [d, t] = s.split(" ");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi, se] = t.split(":").map(Number);
  return new Date(Y, M - 1, D, h, mi, se).getTime();
};

console.log("\n" + "═".repeat(92));
console.log("① ★★★ 每一次「增量」的实绩：压前 → 压后（**真实 usage**，与设置的 10 点比）");
console.log("═".repeat(92));
console.log("  时刻        压前(点)  压后(点)  实绩  目标  兑现率   内核自报被压(启发式)  压掉节点");
console.log("  " + "-".repeat(86));
const rows = [];
for (const d of deltas) {
  const t = toMs(d.at);
  // 压前 = 该时刻之前最近一条 usage；压后 = 之后最近一条
  const before = [...routes].reverse().find((r) => r.at <= t);
  const after = routes.find((r) => r.at > t);
  if (before === undefined || after === undefined) { rows.push({ ...d, skip: true }); continue; }
  const beforePts = before.total / WIN * 100;
  const afterPts = after.total / WIN * 100;
  const actual = beforePts - afterPts;
  // 内核侧那次 compression 的 shadowed 信息
  const cs = evs.filter((e) => e.type === "compaction/summary" && Math.abs(e.time - t) < 120000).pop();
  const shadowTok = cs?.data?.shadowedTokenCount ?? 0;
  const nodes = cs?.data?.shadowedSeqs?.length ?? 0;
  rows.push({ ...d, beforePts, afterPts, actual, shadowTok, nodes });
  console.log(
    `  ${hm(t)}  ${beforePts.toFixed(1).padStart(7)}  ${afterPts.toFixed(1).padStart(7)}  ` +
    `${actual.toFixed(1).padStart(5)}  ${String(10).padStart(4)}  ${((actual / 10) * 100).toFixed(0).padStart(5)}%  ` +
    `${String(shadowTok).padStart(20)}  ${String(nodes).padStart(8)}`
  );
}
const ok = rows.filter((r) => r.skip !== true && Number.isFinite(r.actual));
console.log("  " + "-".repeat(86));
if (ok.length > 0) {
  const avg = ok.reduce((a, b) => a + b.actual, 0) / ok.length;
  console.log(`  ⇒ ★ 增量实绩均值 = **${avg.toFixed(1)} 点**（n=${ok.length}）· 目标 10 点 ⇒ 兑现率 **${((avg / 10) * 100).toFixed(0)}%**`);
  console.log(`  ⇒ ★ 对照 D70 记录的 **4.4 点** ⇒ ${avg > 4.4 ? "**变好了**" : avg < 4.4 ? "**没有变好**" : "持平"}`);
} else {
  console.log("  ★ 没有可算的样本");
}

console.log("\n" + "═".repeat(92));
console.log("② ★ 时间线：4.4 那次之后，增量到底还跑过没有");
console.log("═".repeat(92));
// D70 记的那三次：03:51:50 / 05:06:39 / 05:39:39 —— 就是上面这三次
console.log("  D70 记录的三次（t69/t71/t72）：03:51:50 · 05:06:39 · 05:39:39 ⇒ 实绩 4.1 / 3.9 / 5.1，均值 **4.4**");
console.log(`  ★ 本次实测的三次：${deltas.map((d) => d.at.slice(11)).join(" · ")}`);
const sameSet = deltas.length === 3 &&
  deltas[0].at.includes("03:51:50") && deltas[1].at.includes("05:06:39") && deltas[2].at.includes("05:39:39");
console.log("");
console.log(`  ⇒ ★★ **它们是同一批**：${sameSet ? "是 —— 所以「4.4 之后」**其实一次增量都没再跑过**" : "不是同一批，需要重新核对"}`);
console.log("");
console.log("  之后发生的压缩（都不是增量）：");
for (const m of marked.filter((x) => !deltas.includes(x))) {
  console.log(`     ${m.at}  ${m.kind}`);
}
