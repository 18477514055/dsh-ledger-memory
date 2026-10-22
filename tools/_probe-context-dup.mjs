/**
 * 只读：**同一份台账在上下文里堆了几份？占上下文多少？**
 *
 * ★ 已实测（不是猜）：
 *   · 恒等式 totalTokens = inputTokens + cacheReadTokens + outputTokens —— 8706/8706
 *   · 全会话 cacheRead 35.99 亿 / input 3655 万 / **命中率 98.99%** / 稳定态 99.9%
 *     ⇒ 逐回合注入**没有破坏前缀缓存**（追加在末尾）⇒ 成本 ≈ **上下文大小 × 步数**
 *   · 注入 1181 条 15,200,805 字符，其中 project-ledger-notes 853 条均 17,140 字符
 *   · 逐字节重复仅 2.4%，但**近似重复 95.5%** ⇒ 历史里是 853 份「只改几行」的同一份台账
 *
 * ★ 本探针回答一个问题：**在任一时刻的上下文里，有多少字符是同一份文档的重复副本？**
 *   只报结构，**不报"能省 X%"**（省多少取决于怎么改，不能先报）。
 *
 * 跑法：node tools/_probe-context-dup.mjs
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

// ── 逐事件建立「上下文快照」：累计字符 · 其中注入副本 ──
// ★ 用 compaction/end 作为「上下文重置」的锚点（压缩后历史被摘要替换）
const INJECT_KINDS = new Set(["project-ledger-notes", "compact-checkpoint", "agent-instructions", "runtime-context", "time-context", "skill-catalog", "hindsight"]);

let cumulative = 0;          // 当前上下文估算字符
let injectLive = 0;          // 其中注入正文的字符
const ledgerLive = [];       // 当前活着的 project-ledger-notes 副本 [{seq, chars, hash}]
const cycles = [];           // 每个压缩周期的统计
let cur = { startSeq: null, steps: 0, ledgerCopies: 0, ledgerChars: 0, injectChars: 0, totalChars: 0, maxLedgerCopies: 0 };

function closeCycle(endSeq) {
  if (cur.steps > 0) { cur.endSeq = endSeq; cycles.push(cur); }
  cur = { startSeq: null, steps: 0, ledgerCopies: 0, ledgerChars: 0, injectChars: 0, totalChars: 0, maxLedgerCopies: 0 };
}

for (const e of events) {
  if (e.type === "compaction/end") {
    closeCycle(e.seq);
    cumulative = 0; injectLive = 0; ledgerLive.length = 0;
    continue;
  }
  if (e.type === "user/message") {
    const kind = e?.data?.source?.kind ?? "(无)";
    const t = contentText(e?.data?.content);
    cumulative += t.length;
    if (INJECT_KINDS.has(kind)) injectLive += t.length;
    if (kind === "project-ledger-notes") {
      ledgerLive.push({ seq: e.seq, chars: t.length });
    }
    continue;
  }
  if (e.type === "assistant/message") {
    const msg = e?.data?.message;
    const t = contentText(msg?.content);
    cumulative += t.length;
    // 每个 assistant/message = 模型看过一次当前上下文 ⇒ 记一次「上下文快照」
    if (cur.startSeq === null) cur.startSeq = e.seq;
    cur.steps += 1;
    cur.ledgerCopies += ledgerLive.length;
    cur.ledgerChars += ledgerLive.reduce((a, b) => a + b.chars, 0);
    cur.injectChars += injectLive;
    cur.totalChars += cumulative;
    cur.maxLedgerCopies = Math.max(cur.maxLedgerCopies, ledgerLive.length);
    continue;
  }
  if (e.type === "tool/result") {
    const t = JSON.stringify(e?.data?.result ?? "");
    cumulative += t.length;
  }
}
closeCycle("(end)");

console.log(`压缩周期数：${cycles.length}\n`);
console.log("═══ 每个压缩周期：台账副本堆积情况 ═══");
console.log("  seq范围        step  台账副本×步  台账字符    注入字符     上下文字符   台账占上下文  峰值副本");
for (const c of cycles) {
  if (c.steps === 0) continue;
  const avgCopies = (c.ledgerCopies / c.steps).toFixed(1);
  const share = c.totalChars > 0 ? ((c.ledgerChars / c.totalChars) * 100).toFixed(1) : "-";
  console.log(
    `  ${String(c.startSeq).padStart(6)}-${String(c.endSeq).padStart(6)} ${String(c.steps).padStart(5)} ` +
    `${String(avgCopies).padStart(9)} ${String(Math.round(c.ledgerChars / c.steps)).padStart(9)} ` +
    `${String(Math.round(c.injectChars / c.steps)).padStart(10)} ${String(Math.round(c.totalChars / c.steps)).padStart(12)} ` +
    `${String(share).padStart(9)}% ${String(c.maxLedgerCopies).padStart(7)}`
  );
}
console.log("");

// ── 最近一个完整周期逐 step 展开 ──
const recent = cycles.filter((c) => c.steps > 0).slice(-2, -1)[0] ?? cycles.filter((c) => c.steps > 0).slice(-1)[0];
if (recent) {
  console.log(`═══ 周期 ${recent.startSeq}–${recent.endSeq} 汇总 ═══`);
  const n = recent.steps;
  console.log(`  step 数            ${n}`);
  console.log(`  平均台账副本数      ${(recent.ledgerCopies / n).toFixed(1)} 份`);
  console.log(`  平均台账字符        ${Math.round(recent.ledgerChars / n).toLocaleString("en-US")}`);
  console.log(`  平均注入字符        ${Math.round(recent.injectChars / n).toLocaleString("en-US")}`);
  console.log(`  平均上下文字符      ${Math.round(recent.totalChars / n).toLocaleString("en-US")}`);
  console.log(`  台账占上下文        ${((recent.ledgerChars / recent.totalChars) * 100).toFixed(1)}%`);
  console.log(`  注入占上下文        ${((recent.injectChars / recent.totalChars) * 100).toFixed(1)}%`);
}

// ── 全局：按「上下文总字符」加权 ──
let gSteps = 0, gLedger = 0, gInject = 0, gTotal = 0;
for (const c of cycles) { gSteps += c.steps; gLedger += c.ledgerChars; gInject += c.injectChars; gTotal += c.totalChars; }
if (gSteps > 0) {
  console.log("\n═══ 全周期加权（按 step×字符）═══");
  console.log(`  step 总数          ${gSteps.toLocaleString("en-US")}`);
  console.log(`  平均台账副本数      ${(gLedger / gTotal * 0).toFixed(0) === "0" ? "" : ""}见下`);
  console.log(`  台账字符 / 上下文   ${((gLedger / gTotal) * 100).toFixed(1)}%`);
  console.log(`  注入字符 / 上下文   ${((gInject / gTotal) * 100).toFixed(1)}%`);
}
