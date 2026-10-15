/**
 * ★★★ 只读核查：**压缩到底发生了几次？分别是谁发起的？**
 *
 * 用户的怀疑：「我们的压缩只生效了一次」。
 *
 * ★ 三条独立证据源（互相对照，避免单一尺子）：
 *   ① **官方会话日志**里 `compaction/start` / `compaction/end` 事件（内核自己写的）
 *   ② **L0 活动日志**里的中文标签（插件自己写的：自动（增量）/ 手动 / 自动（70% 水位））
 *   ③ `anchors.json`（插件的棘轮锚点）
 *
 * ★ 纪律：只解析 `j.type` **精确匹配**，绝不 `line.includes(...)`（否则我自己的正文会污染判据）。
 * ★ 纪律：**带时间窗**列出来，不做"全部历史一起数"。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const starts = []; let i = buf.indexOf(MAGIC);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  starts.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < starts.length; k += 1) {
    try { const d = zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1])); if (d.length) out.push(d); } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};

// ★★ 2026-10-15（D216）：原来硬编码本机绝对路径 ⇒ 改成**从本文件位置推**（跨机器都对、且不泄露本机路径）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGDIR = path.join(ROOT, "_ledger-log/2026-10/week2");
const fmt = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });

// ── ① 会话日志里的压缩事件（严格按 j.type）────────────────────────────────
const SESS = path.join(os.homedir(), ".dsh", "sessions", "--D-Deepseek~5DE5~4F5C~533A--",
  "session-fada6e5f-52f2-4a4f-b52a-3c2483db117e", "session.v4.jsonl.zstd");
const text = decodeAll(fs.readFileSync(SESS));
const evs = [];
for (const line of text.split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
const starts = evs.filter((e) => e.type === "compaction/start");
const ends = evs.filter((e) => e.type === "compaction/end");
console.log("═══ ① 官方会话日志（内核自己写的）═══");
console.log(`  compaction/start = ${starts.length} 条 · compaction/end = ${ends.length} 条`);
console.log(`  最早 start: ${fmt(starts[0]?.time ?? 0)}   最晚 end: ${fmt(ends[ends.length - 1]?.time ?? 0)}`);

// 本次内核启动（05:30:22）之后的有多少
const RESTART = new Date("2026-10-11T05:30:22+08:00").getTime();
const sinceStart = starts.filter((e) => e.time >= RESTART);
console.log(`  ★ 本次内核启动(05:30:22)之后：start ${sinceStart.length} 条`);
for (const e of sinceStart) {
  const d = e.data ?? {};
  console.log(`      ${fmt(e.time)}  turn=${JSON.stringify(d.turn)}  sourceCommandId=${JSON.stringify(d.sourceCommandId)}  keys=${Object.keys(d).join(",")}`);
}

// 全部 start，按时间列出（含 turn 判归属）
console.log("\n  全部 compaction/start（时间 / turn / sourceCommandId）：");
for (const e of starts) {
  const d = e.data ?? {};
  const who = d.sourceCommandId !== undefined ? "★ 手动（带 sourceCommandId）"
    : d.turn === null ? "回合末（turn=null）"
    : `回合内（turn=${d.turn}）`;
  console.log(`      ${fmt(e.time)}  ${who}`);
}

// ── ② L0 活动日志里的中文标签（插件自己写的，最权威的"归属"）─────────────
console.log("\n═══ ② L0 活动日志（插件自己写的中文标签）═══");
const l0 = path.join(LOGDIR, "L0-milestones.md");
if (fs.existsSync(l0)) {
  const lines = fs.readFileSync(l0, "utf8").split(/\r?\n/);
  const hits = lines.filter((l) => l.includes("compaction/end") || l.includes("压缩"));
  console.log(`  含「压缩」或 compaction/end 的行 ${hits.length} 条：`);
  for (const l of hits) console.log(`      ${l.trim().slice(0, 130)}`);
} else {
  console.log("  (L0 文件不存在)");
}

// ── ③ anchors.json（棘轮锚点）─────────────────────────────────────────────
console.log("\n═══ ③ anchors.json（棘轮锚点）═══");
const ap = path.join(os.homedir(), ".dsh", "plugin-data", "dsh-ledger-memory", "anchors.json");
if (fs.existsSync(ap)) {
  const st = fs.statSync(ap);
  console.log(`  末写 ${fmt(st.mtimeMs)}`);
  console.log(`  ${fs.readFileSync(ap, "utf8").trim()}`);
} else {
  console.log("  (不存在)");
}

// ── ④ 本次会话"用户消息"的时间线（看压缩之间的间隔）───────────────────────
console.log("\n═══ ④ 小结 ═══");
console.log(`  会话日志 begin; 本次启动后 compression/start = ${sinceStart.length}`);
