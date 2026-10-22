/**
 * 只读：**为什么回合内压缩不再触发？** 查那一拍到底卡在 gate 的哪个分支。
 *
 * ★ 关键判据（`midTurnCompactGate` 的六个分支）：
 *     off / unmeasurable / no-line / below-line / pressing / already-done /
 *     failed-this-turn / awaiting-owed / **owed-first（gapsOk 不成立）** / ready
 *
 * ★ 我们能从日志里看到的线索：
 *   ① 水位什么时候越过 70% —— 用 `request/header` 里的 usage 逐条量
 *   ② 越线之后，那一回合里**有没有** `ledger_write` / `ledger_triage` 的调用
 *      → 有 ⇒ gapsOk 应该成立；没有 ⇒ 卡在 `owed-first`
 *   ③ 越线之后，**有没有** steer / 注入（`TURN_END_*` 之类的文本）
 *
 * ★ 注意：`state.turnCompact` 是**内存态**，日志里看不到；
 *   所以「相位移位」这一类只能靠间接证据（有写入却没有压缩）来推断，
 *   探针必须如实写明这一点，不许假装看到了。
 *
 * 跑法：node tools/_probe-midturn-why.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

const SESS_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");
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
const FILE = process.env.DSH_SESSION_FILE ?? findNewest(SESS_ROOT);
if (FILE === undefined) {
  console.log("SKIP");
  process.exit(0);
}
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
  } catch {
    continue;
  }
  const s = out.toString("utf8");
  const first = s.split("\n").find((l) => l.trim() !== "");
  if (first === undefined) continue;
  try {
    JSON.parse(first);
  } catch {
    continue;
  }
  texts.push(s);
}
const events = [];
for (const l of texts.join("").split("\n")) {
  if (l.trim() === "") continue;
  try {
    events.push(JSON.parse(l));
  } catch {}
}

// ── ① 逐条 request/header 取 usage，画水位曲线（只看最近 400 条请求）──
const reqs = events.filter((e) => e?.type === "request/header");
console.log(`request/header 共 ${reqs.length} 条\n`);
// ★ 台账记过：真 token 数在 data.usage.totalTokens，且 totalTokens ≡ input + cacheRead + output
const pts = [];
for (const r of reqs) {
  const u = r?.data?.usage;
  const t = u?.totalTokens;
  if (typeof t === "number") pts.push({ seq: r.seq, tok: t });
}
console.log(`═══ ① 水位曲线（有 usage 的 ${pts.length} 次请求，取最后 60 个）═══\n`);
const tail = pts.slice(-60);
let inTurnSeen = 0;
for (const p of tail) {
  const ratio = p.tok / 1000000;
  const bar = "█".repeat(Math.max(0, Math.round(ratio * 40)));
  const mark = ratio >= 0.7 ? "  ← 已过 70% 线" : "";
  console.log(`  seq=${String(p.seq).padStart(6)} ${(ratio * 100).toFixed(1).padStart(5)}% ${bar}${mark}`);
  if (ratio >= 0.7) inTurnSeen += 1;
}
console.log(`\n  最后 60 次请求里，${inTurnSeen} 次水位 ≥70%。`);

// ── ② 最近这些「越线」的时刻，那一回合有没有写台账 / 分流 ──
console.log(`\n═══ ② 越线之后有没有 ledger_write / ledger_triage ═══\n`);
//   取最近 3 次「回合间压缩」的 seq，看它们**之前**最近一次 write/triage 在哪
const starts = events.filter((e) => e?.type === "compaction/start");
const between = starts.filter((s) => s?.data?.turn === null).slice(-3);
function lastToolBefore(seq, toolName) {
  let hit;
  for (const e of events) {
    if (e.seq >= seq) break;
    if (e?.type !== "tool/call") continue;
    if (e?.data?.name === toolName) hit = e.seq;
  }
  return hit;
}
for (const b of between) {
  const w = lastToolBefore(b.seq, "ledger_write");
  const t = lastToolBefore(b.seq, "ledger_triage");
  console.log(`  压缩 at seq=${b.seq}（回合间）`);
  console.log(`    之前最近一次 ledger_write  = ${w ?? "**从未**"}  ${w === undefined ? "" : `（相距 ${b.seq - w} 个 seq）`}`);
  console.log(`    之前最近一次 ledger_triage = ${t ?? "**从未**"}  ${t === undefined ? "" : `（相距 ${b.seq - t} 个 seq）`}`);
}

// ── ③ 统计：ledger_write / ledger_triage 的总调用数 ──
console.log(`\n═══ ③ 工具调用统计 ═══\n`);
const toolCounts = new Map();
for (const e of events) {
  if (e?.type !== "tool/call") continue;
  const n = e?.data?.name;
  if (typeof n === "string") toolCounts.set(n, (toolCounts.get(n) ?? 0) + 1);
}
for (const name of ["ledger_write", "ledger_triage", "ledger_recall", "ledger_checkpoint"]) {
  console.log(`  ${name.padEnd(20)} ${toolCounts.get(name) ?? 0} 次`);
}

// ── ④ 回合内压缩那 8 次，都发生在什么 turn / 距离现在多远 ──
console.log(`\n═══ ④ 回合内压缩的 8 次分布 ═══\n`);
const inTurns = starts.filter((s) => typeof s?.data?.turn === "number");
const maxTurn = Math.max(...events.filter((e) => typeof e?.data?.turn === "number").map((e) => e.data.turn), 0);
for (const s of inTurns) {
  console.log(`  seq=${String(s.seq).padStart(6)}  turn=${s.data.turn}  （距今 ${maxTurn - s.data.turn} 个 turn）`);
}
console.log(`\n  当前最大 turn = ${maxTurn}`);
console.log(`  ⇒ 最后一次回合内压缩尝试在 turn ${Math.max(...inTurns.map((s) => s.data.turn))}，之后 **${maxTurn - Math.max(...inTurns.map((s) => s.data.turn))} 个 turn 都没有再发生**。`);
