/**
 * ★★★ 只读：核实**刚刚发生的那次增量**（19:25:26），并检查一个**新发现的系统性问题**。
 *
 * 用户问题链：增量压缩到底有没有起效？
 * 本轮答案：**刚刚真的跑了一次** —— 这是最直接的一次观测。
 *
 * ★ 要查三件事：
 *   ① 这次增量的实绩（真实 usage 口径），与 D86 的历史四次对齐；
 *   ② ★ 它压的是**多大规模的段**、**推理密度**如何（解释为什么兑现率与历史不同）；
 *   ③ ★★★ **新问题**：压后水位 69% ⇒ 锚点=69% ⇒ 下次触发线 = 69+20 = **89%**，
 *      而内核在 **80%** 硬压 ⇒ **增量可能永远追不上**。
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
const bySeq = new Map();
for (const e of evs) bySeq.set(e.seq, e);

// ── 全部压缩事件（按时间） ──────────────────────────────────────────────
const starts = evs.filter((e) => e.type === "compaction/start");
const summons = evs.filter((e) => e.type === "compaction/summary");
const ends = evs.filter((e) => e.type === "compaction/end");

console.log("═".repeat(92));
console.log("① 最后一次压缩（19:25:26）的原始事件");
console.log("═".repeat(92));
const lastEnd = ends[ends.length - 1];
const lastSum = summons[summons.length - 1];
console.log(`  compaction/start   ${hm(starts[starts.length - 1].time)}  ${JSON.stringify(starts[starts.length - 1].data).slice(0, 90)}`);
console.log(`  compaction/summary ${hm(lastSum.time)}  shadowed=${lastSum.data?.shadowedSeqs?.length} 节点 · tok=${lastSum.data?.shadowedTokenCount} · range=${JSON.stringify(lastSum.data?.shadowedRange)}`);
console.log(`  compaction/end     ${hm(lastEnd.time)}`);

// ── 真实水位轨迹（±5 分钟） ─────────────────────────────────────────────
const routes = evs.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => ({ seq: e.seq, at: e.time, total: Number(e.data.usage.totalTokens || 0) }))
  .sort((a, b) => a.at - b.at);
const T = lastEnd.time;
console.log("\n" + "═".repeat(92));
console.log("② 那一刻的真实水位（±4 分钟）");
console.log("═".repeat(92));
for (const r of routes) {
  if (Math.abs(r.at - T) > 4 * 60000) continue;
  const rel = r.at < T ? `压前 ${((T - r.at) / 1000).toFixed(0)}s` : `压后 ${((r.at - T) / 1000).toFixed(0)}s`;
  console.log(`  ${hm(r.at)}  ${String(r.seq).padStart(6)}  ${(r.total / WIN * 100).toFixed(1).padStart(6)}%   ${rel}`);
}

// ── 实绩 ────────────────────────────────────────────────────────────────
const before = [...routes].reverse().find((r) => r.at <= T);
const after = routes.find((r) => r.at > T);
const bPct = before.total / WIN * 100, aPct = after.total / WIN * 100;
console.log("\n" + "═".repeat(92));
console.log("③ ★★★ 这次增量的实绩（与 D86 的历史四次对照）");
console.log("═".repeat(92));
console.log(`  压前 ${bPct.toFixed(1)}%  →  压后 ${aPct.toFixed(1)}%  ⇒ **实绩 ${(bPct - aPct).toFixed(1)} 点**（目标 10）`);
console.log(`  兑现率 = **${((bPct - aPct) / 10 * 100).toFixed(0)}%**`);
console.log("");
console.log("  历史对照（D86 实测）：");
console.log("     10-10 19:21:07   21.4 点 / 499 节点  兑现 214%");
console.log("     10-11 03:51:50    4.2 点 /  83 节点  兑现  42%");
console.log("     10-11 05:06:39    3.9 点 /  50 节点  兑现  39%");
console.log("     10-11 05:39:39    5.1 点 /  83 节点  兑现  51%");
console.log(`     ★ 10-11 19:25:26  ${(bPct - aPct).toFixed(1)} 点 / ${lastSum.data?.shadowedSeqs?.length} 节点  兑现 ${((bPct - aPct) / 10 * 100).toFixed(0)}%  ← 本次`);

// ── ★★★ 新问题：锚点 + 20 会不会超过内核硬压线 ────────────────────────
console.log("\n" + "═".repeat(92));
console.log("④ ★★★ 新发现的系统性问题：**压后水位 69% ⇒ 锚点 69% ⇒ 下次触发线 89%**");
console.log("═".repeat(92));
// 读盘上的锚点
let anchor;
try {
  const p = path.join(os.homedir(), ".dsh", "plugin-data", "dsh-ledger-memory", "anchors.json");
  anchor = JSON.parse(fs.readFileSync(p, "utf8")).bySession?.["session-fada6e5f-52f2-4a4f-b52a-3c2483db117e"];
  console.log(`  盘上锚点 = **${anchor}**（${(anchor * 100).toFixed(1)}%）  mtime=${fs.statSync(p).mtime.toLocaleString("sv-SE")}`);
} catch (e) { console.log(`  读不到锚点：${e.message}`); }
if (Number.isFinite(anchor)) {
  const trigger = anchor + 0.20;
  console.log(`  增量触发线 = 锚点 + 触发点(20) = **${(trigger * 100).toFixed(1)}%**`);
  console.log(`  内核硬压线 = **80%**`);
  console.log("");
  console.log(`  ⇒ ${trigger * 100 >= 80 ? "★★★ **触发线 ≥ 内核硬压线** ⇒ 增量根本追不上：" : "触发线 < 80%，仍有机会："}`);
  if (trigger * 100 >= 80) {
    console.log(`     · 要排增量，水位必须先到 ${(trigger * 100).toFixed(1)}%；`);
    console.log(`     · 但水位到 80% 时**内核自己就硬压了**（我们在 70% 也会全量）；`);
    console.log(`     · ⇒ **增量会永远等不到它的触发点** —— 这是"饿死"的**另一种形态**（比 D86 那个更隐蔽）。`);
  }
  console.log("");
  console.log("  ★ 为什么压后还剩 69%：");
  console.log(`     压前 ${bPct.toFixed(1)}%，只压掉 ${(bPct - aPct).toFixed(1)} 点 ⇒ 压后 ${aPct.toFixed(1)}%。`);
  console.log(`     而锚点**必须取压后水位**（那是正确语义）⇒ 锚点就被抬到 ${(anchor * 100).toFixed(1)}%。`);
  console.log("     ⇒ ★ 根因不是锚点取错了，而是**这次只压掉 8.8 点，太少了**：");
  console.log("       压不掉足够多 ⇒ 压后水位仍然很高 ⇒ 下次触发线跟着抬高 ⇒ 恶性循环。");
}
