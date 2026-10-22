/**
 * 只读：**`[midturn]` 诊断到底有没有被调用过？**
 *
 * ★ 上一版探针犯的错（已记）：
 *   我在会话日志里搜 "midturn" 得到 365 条命中，**全是 `auto:midturn`（压缩来源票）**，
 *   然后差点把它当成"诊断输出过"。**同类不同源**（纪律 15）—— 差点又栽一次。
 *   ⇒ 本版判据改成**精确字符串 `[midturn] act=`**（带方括号与 act=），`auto:midturn` 不可能命中它。
 *
 * ★ 已知事实（从内核源码核过，`@deepseek-ai/cordis/src/logger.ts`）：
 *   `logger.warn` 是**结构化消息**，走 `exporter.export(message)` —— **不是写文件**。
 *   所以"磁盘上找不到"**不能**证明"没被调用"。本探针只回答能确定的那部分。
 *
 * 跑法：node tools/_probe-midturn-called.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");

function findNewest(root) {
  const cands = [];
  (function walk(d, depth) {
    if (depth > 4) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/\.jsonl\.zstd$/.test(e.name)) cands.push({ p, m: fs.statSync(p).mtimeMs });
      }
    } catch {}
  })(root, 0);
  cands.sort((a, b) => b.m - a.m);
  return cands[0]?.p;
}
const FILE = process.env.DSH_SESSION_FILE ?? findNewest(path.join(HOME, "sessions"));
if (FILE === undefined) { console.log("SKIP"); process.exit(0); }

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const raw = fs.readFileSync(FILE);
const cand = [0];
for (let i = 1; ; ) {
  const p = raw.indexOf(MAGIC, i);
  if (p < 0) break;
  cand.push(p);
  i = p + 4;
}
const texts = [];
for (let k = 0; k < cand.length; k += 1) {
  let out;
  try {
    out = zlib.zstdDecompressSync(raw.subarray(cand[k], k + 1 < cand.length ? cand[k + 1] : raw.length));
  } catch { continue; }
  const s = out.toString("utf8");
  const first = s.split("\n").find((l) => l.trim() !== "");
  if (first === undefined) continue;
  try { JSON.parse(first); } catch { continue; }
  texts.push(s);
}
const events = [];
for (const s of texts) {
  for (const l of s.split("\n")) {
    if (l.trim() === "") continue;
    try { events.push(JSON.parse(l)); } catch {}
  }
}
const lastSeq = events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
console.log(`会话 ${path.basename(path.dirname(FILE))} · ${events.length} 条 · seq 到 ${lastSeq}\n`);

// ── ① 精确判据：[midturn] act=  ──
const PRECISE = "[midturn] act=";
let precise = 0;
const samples = [];
for (const e of events) {
  const s = JSON.stringify(e);
  if (s.includes(PRECISE)) {
    precise += 1;
    if (samples.length < 3) samples.push({ type: e.type, seq: e.seq, s });
  }
}
console.log(`═══ ① 精确判据 "${PRECISE}" ═══`);
console.log(`  命中 ${precise} 条`);
for (const x of samples) {
  const i = x.s.indexOf(PRECISE);
  console.log(`  type=${x.type} seq=${x.seq}`);
  console.log(`    ${x.s.slice(Math.max(0, i - 40), i + 300)}`);
}
console.log("");

// ── ② 对照：auto:midturn 有多少（证明"同类不同源"确实存在）──
let autoHits = 0;
for (const e of events) if (JSON.stringify(e).includes("auto:midturn")) autoHits += 1;
console.log(`═══ ② 对照 "auto:midturn"（压缩来源票，不是诊断）═══`);
console.log(`  ${autoHits} 条 —— ★ **这不是诊断输出**，别混算（上一版差点栽在这）`);
console.log("");

// ── ③ 回合内压缩现状（这才是诊断要解释的东西）──
const comps = events.filter((e) => e.type === "compaction/start");
const inTurnTurns = [];
let between = 0;
for (const c of comps) {
  const t = c?.data?.turn;
  if (t === null || t === undefined) between += 1;
  else inTurnTurns.push(t);
}
const turnStarts = events.filter((e) => e.type === "turn/start");
const maxTurn = turnStarts.reduce((m, e) => {
  const t = e?.data?.turn;
  return typeof t === "number" ? Math.max(m, t) : m;
}, 0);

console.log(`═══ ③ compaction/start 共 ${comps.length} 次 ═══`);
console.log(`  回合内 ${inTurnTurns.length} 次（turn: ${inTurnTurns.join(" / ") || "无"}）`);
console.log(`  回合间 ${between} 次`);
console.log(`  当前最大 turn：${maxTurn}`);
if (inTurnTurns.length > 0) {
  const last = Math.max(...inTurnTurns);
  console.log(`  最后一次回合内压缩：turn ${last} ⇒ 之后 **${maxTurn - last} 个 turn 没再发生**`);
}
console.log("");

// ── ④ 最近 5 次压缩事件的时间与 turn ──
console.log(`═══ ④ 最近 5 次 compaction/start ═══`);
for (const c of comps.slice(-5)) {
  const t = c?.data?.turn;
  const ts = typeof c.time === "number" ? new Date(c.time).toISOString() : "?";
  console.log(`  seq=${c.seq} turn=${t === null || t === undefined ? "回合间" : t} time=${ts}`);
}
console.log("");
console.log("★★ 判读规则：");
console.log("  · ① 命中 0 条 ≠ 诊断没生效 —— logger 是结构化消息，走 Exporter，不一定落文件");
console.log("  · 但若 ① 命中 >0，那就是**确定的证据**：诊断确实跑了，且内容就在这里");
