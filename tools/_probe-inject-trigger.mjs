/**
 * 只读：**每回合注入 5.6 次，但内容真变了几次？**
 *
 * ★ 动机（已实测）：
 *   · 上下文里台账副本平均 **16.3 份**，占上下文 **90.0%**（34 个压缩周期全覆盖）
 *   · `project-ledger-notes` 注入 **853 条**，853 ÷ 153 turn = **每回合 5.6 次**
 *   · 逐字节重复只有 **2.4%**，但前 800 字符归一化后**近似重复 95.5%**
 *   ⇒ 关键问题：**那 5.6 次里，有几次是"内容其实没变、只是重推了一遍"？**
 *     若答案是"大部分没变"，那么"同一份内容重复注入"就是可省的那部分；
 *     若答案是"每次都真变了"，那就不能省，得从别处下手。
 *
 * ★ 本探针只量，不改任何东西，也不预设结论。
 *
 * 跑法：node tools/_probe-inject-trigger.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";

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

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c === "string" ? c : c?.type === "text" ? (c.text ?? "") : "")).join("");
}

// 收集台账注入 + 每步的 step 号（用来判断"注入发生在第几步"）
const ledger = [];
for (const e of events) {
  if (e.type !== "user/message") continue;
  if (e?.data?.source?.kind !== "project-ledger-notes") continue;
  const t = contentText(e?.data?.content);
  ledger.push({ seq: e.seq, turn: e.data.turn, chars: t.length, text: t, hash: crypto.createHash("sha256").update(t).digest("hex").slice(0, 12) });
}
console.log(`台账注入 ${ledger.length} 条\n`);

// ── 1. 每回合：注入次数 vs 不同内容数 ──
const perTurn = new Map();
for (const x of ledger) {
  const k = x.turn ?? "?";
  if (!perTurn.has(k)) perTurn.set(k, []);
  perTurn.get(k).push(x);
}

let sumN = 0, sumDistinct = 0, turnsWithMulti = 0, wastedPushes = 0, wastedChars = 0;
const rows = [];
for (const [turn, list] of perTurn.entries()) {
  const distinct = new Set(list.map((x) => x.hash)).size;
  sumN += list.length;
  sumDistinct += distinct;
  if (list.length > 1) turnsWithMulti += 1;
  wastedPushes += list.length - distinct;
  // 「浪费」的字符：把重复内容的整份字符算进去（保守：按平均长度）
  const avg = list.reduce((a, b) => a + b.chars, 0) / list.length;
  wastedChars += (list.length - distinct) * avg;
  rows.push({ turn, n: list.length, distinct, avg: Math.round(avg) });
}
rows.sort((a, b) => b.n - a.n);

console.log("═══ 每回合：注入次数 vs 不同内容数（前 20 个回合）═══");
console.log("  turn   注入  不同  均字符   说明");
for (const r of rows.slice(0, 20)) {
  const tag = r.n === r.distinct ? "每次都变" : `重复 ${r.n - r.distinct} 次`;
  console.log(`  ${String(r.turn).padStart(4)} ${String(r.n).padStart(5)} ${String(r.distinct).padStart(5)} ${String(r.avg).padStart(7)}   ${tag}`);
}
console.log("");

console.log("═══ 汇总 ═══");
console.log(`  覆盖 ${perTurn.size} 个 turn`);
console.log(`  注入总数 ${sumN} · 其中不同内容 ${sumDistinct}（${((sumDistinct / sumN) * 100).toFixed(1)}%）`);
console.log(`  重复推送 ${sumN - sumDistinct} 次（${(((sumN - sumDistinct) / sumN) * 100).toFixed(1)}%）`);
console.log(`  多注入的 turn 数 ${turnsWithMulti} / ${perTurn.size}`);
console.log(`  重复推送的字符量约 ${Math.round(wastedChars).toLocaleString("en-US")}`);
console.log("");

// ── 2. 同一回合内，相邻两次注入差在哪 ──
console.log("═══ 同一回合内相邻两次注入的差异（取注入次数最多的 3 个回合）═══");
for (const r of rows.slice(0, 3)) {
  const list = perTurn.get(r.turn);
  console.log(`\n  ── turn ${r.turn}（${list.length} 次）──`);
  for (let i = 1; i < list.length; i += 1) {
    const a = list[i - 1], b = list[i];
    if (a.hash === b.hash) { console.log(`    seq ${a.seq}→${b.seq}: 完全相同`); continue; }
    // 找第一个不同的位置
    let p = 0;
    const minLen = Math.min(a.text.length, b.text.length);
    while (p < minLen && a.text[p] === b.text[p]) p += 1;
    const changedSpan = Math.abs(a.text.length - b.text.length);
    console.log(`    seq ${a.seq}→${b.seq}: 长度 ${a.chars}→${b.chars} · 首个差异在字符 ${p}（占 ${((p / a.chars) * 100).toFixed(1)}%）· 长度差 ${changedSpan}`);
    // 差异附近的内容（各取 80 字符）
    console.log(`       前: ${JSON.stringify(a.text.slice(p, p + 70))}`);
    console.log(`       后: ${JSON.stringify(b.text.slice(p, p + 70))}`);
  }
}
console.log("");

// ── 3. 注入落在每回合的第几步（看是不是每步都注）──
// 用 step/start 的序号近似：统计同一 turn 内，注入之前有多少个 step/start
const stepSeqByTurn = new Map();
for (const e of events) {
  if (e.type !== "step/start") continue;
  const t = e.data?.turn;
  if (!stepSeqByTurn.has(t)) stepSeqByTurn.set(t, []);
  stepSeqByTurn.get(t).push(e.seq);
}
console.log("═══ 注入发生在该回合的第几个 step（前 3 个回合）═══");
let shown = 0;
for (const [turn, list] of perTurn.entries()) {
  if (list.length < 3) continue;
  const steps = stepSeqByTurn.get(turn) ?? [];
  if (steps.length === 0) continue;
  const positions = list.map((x) => steps.filter((s) => s < x.seq).length);
  console.log(`  turn ${turn}: 共 ${steps.length} step · 注入落在 step ${positions.join(" / ")}`);
  shown += 1;
  if (shown >= 3) break;
}
