/**
 * 只读：用**正确的字段**回答「回合内压缩到底跑通过没有」。
 *
 * ★ 上一版探针找 `data.source` —— **找错了地方**（`compaction/start` 里没有 source 字段）。
 *   事件真实形状（原样）：
 *     {"type":"compaction/start","seq":2213,"time":…,"data":{"compactionId":"…","turn":null}}
 *   ⇒ **判据是 `turn`**：
 *       · `turn: null` ⇒ 发生在**回合之间**（回合末 / 空闲 / 官方自动）
 *       · `turn: N`    ⇒ 发生在**某个回合内部**（= 我们的 midturn 压缩）
 *   ★ 这是「取不到值先怀疑取法」的第 N 次同型（台账纪律 3）。
 *
 * 另外再查：**每次压缩时，压前水位是多少** —— 用户说"停到 70 多点"，
 * 如果压前水位长期是 70~78%，说明我们自己的触发在工作；如果是 80%+，那是官方兜底。
 *
 * 跑法：node tools/_probe-midturn-evidence2.mjs
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

const starts = events.filter((e) => e?.type === "compaction/start");
const ends = new Map();
for (const e of events) if (e?.type === "compaction/end") ends.set(e?.data?.compactionId, e);
const sums = new Map();
for (const e of events) if (e?.type === "compaction/summary") sums.set(e?.data?.compactionId, e);

// ── 按 turn 是否为 null 分组 ──
let inTurn = 0;
let betweenTurns = 0;
const rows = [];
for (const s of starts) {
  const d = s?.data ?? {};
  const turn = d.turn;
  const isInTurn = typeof turn === "number" && Number.isFinite(turn);
  if (isInTurn) inTurn += 1;
  else betweenTurns += 1;
  const sum = sums.get(d.compactionId);
  const u = sum?.data?.usage ?? {};
  const tok = typeof u.totalTokens === "number" ? u.totalTokens : undefined;
  // end 事件里可能有成功/失败
  const end = ends.get(d.compactionId);
  const outcome = end?.data?.reason ?? end?.data?.error ?? end?.data?.status ?? (end === undefined ? "(无 end)" : "ok?");
  rows.push({
    seq: s.seq,
    turn: isInTurn ? turn : null,
    tok,
    ratio: tok === undefined ? undefined : tok / 1000000,
    outcome,
  });
}

console.log(`═══ ① 按 turn 判「回合内 vs 回合外」═══\n`);
console.log(`  compaction/start 共 ${starts.length} 次`);
console.log(`    ★ 回合内（turn 是数字）: ${inTurn} 次`);
console.log(`      回合间（turn 为 null）: ${betweenTurns} 次`);

console.log(`\n═══ ② 逐次明细（最近 20 次）═══\n`);
console.log(`  seq      发生时   turn    压前水位   end 结果`);
for (const r of rows.slice(-20)) {
  const when = r.turn === null ? "**回合间**" : "回合内";
  const ratio = r.ratio === undefined ? "     ?" : `${(r.ratio * 100).toFixed(1)}%`.padStart(6);
  const t = r.turn === null ? "  null" : String(r.turn).padStart(5);
  console.log(`  ${String(r.seq).padStart(7)}  ${when.padEnd(8)} ${t}  ${ratio}   ${String(r.outcome).slice(0, 40)}`);
}

// ── ③ 结论式统计 ──
console.log(`\n═══ ③ 结论 ═══\n`);
if (inTurn === 0) {
  console.log(`  ❌ **回合内压缩一次都没有发生过** —— ${starts.length} 次全是回合间（turn=null）。`);
} else {
  const first = rows.find((r) => r.turn !== null);
  console.log(`  ✅ 回合内压缩发生过 **${inTurn}** 次。`);
  console.log(`     首次在 seq=${first?.seq}（turn=${first?.turn}）。`);
  console.log(`     最近 ${rows.slice(-20).filter((r) => r.turn !== null).length} / 20 次里是回合内。`);
}
if (betweenTurns > 0) {
  console.log(`  ⚠️ 另有 **${betweenTurns}** 次发生在回合之间（回合末 / 空闲 / 官方）。`);
}
