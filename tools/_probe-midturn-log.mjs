/**
 * 只读：**诊断日志 `[midturn]` 到底有没有真的输出过？输出到哪了？**
 *
 * ★ 背景（台账 19:2x 那条记着）：
 *   `midTurnCompactGate` 里已加诊断（`lib/part3.js:3040` `ctx.logger.warn(...)`），
 *   格式 `[midturn] act=… why=… phase=… ratio=… line=… turn=… gapsOk=…`。
 *   **下一步是等水位过 70% 抓这行日志** —— 现在水位早就过了。
 *
 * ★ 但"我以为它会出现在某处"不是证据（纪律 3：取不到值先怀疑取法）。
 *   本探针做三件事：
 *     ① 在**会话日志**里搜 `[midturn]`（可能被转成事件）
 *     ② 在 `~/.dsh/logs`、`%TEMP%`、profile 目录里搜**文本**
 *     ③ 报告"零命中"时明确说：是**没有输出**，还是**我没找对地方**
 *
 * 跑法：node tools/_probe-midturn-log.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");

// ── ① 会话日志里搜 ──
const SESS_ROOT = path.join(HOME, "sessions");
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
if (FILE === undefined) { console.log("SKIP: 找不到会话文件"); process.exit(0); }

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
console.log(`会话：${path.basename(path.dirname(FILE))}`);
console.log(`事件 ${events.length} 条 · seq 到 ${events[events.length - 1]?.seq}\n`);

// 在原始 JSON 里找 [midturn]（不经解析，避免漏掉字符串转义）
let rawHits = 0;
for (const e of events) {
  const s = JSON.stringify(e);
  if (s.includes("midturn")) {
    rawHits += 1;
    if (rawHits <= 5) {
      console.log(`  ⚠ 命中事件 type=${e.type} seq=${e.seq}`);
      const i = s.indexOf("midturn");
      console.log(`     片段: ${s.slice(Math.max(0, i - 80), i + 260)}`);
    }
  }
}
console.log(`═══ ① 会话日志里含 "midturn" 的事件：${rawHits} 条 ═══\n`);

// ── ② 磁盘文本搜索 ──
const SEARCH_DIRS = [
  path.join(HOME, "logs"),
  path.join(HOME, "profiles"),
  os.tmpdir(),
];
const NEEDLE = "[midturn]";
let filesScanned = 0;
const hits = [];
const cutoff = Date.now() - 3 * 24 * 3600 * 1000;   // 只扫近 3 天改过的
function scan(dir, depth) {
  if (depth > 4) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) { scan(p, depth + 1); continue; }
      const st = fs.statSync(p);
      if (st.size > 40 * 1024 * 1024) continue;
      if (st.mtimeMs < cutoff) continue;
      // 只扫文本类
      if (!/\.(log|txt|json|jsonl|md|out|err)$/i.test(e.name) && !/log/i.test(e.name)) continue;
      filesScanned += 1;
      const buf = fs.readFileSync(p);
      if (buf.includes(Buffer.from(NEEDLE, "utf8"))) hits.push(p);
    } catch {}
  }
}
for (const d of SEARCH_DIRS) if (fs.existsSync(d)) scan(d, 0);

console.log(`═══ ② 磁盘文本搜索（近 3 天 · 扫了 ${filesScanned} 个文本文件）═══`);
if (hits.length === 0) {
  console.log(`  ❌ 没有找到 "${NEEDLE}"`);
  console.log(`     ★ 这不等于"诊断没生效" —— 可能只是 logger 输出去了别处（如 stdout/控制台）。`);
} else {
  console.log(`  ✓ 命中 ${hits.length} 个文件：`);
  for (const h of hits.slice(0, 10)) console.log(`     ${h}`);
}
console.log("");

// ── ③ 关键：活内核有没有加载含诊断的那一版？──
// 判据（台账里的硬办法）：读 request/header 里最近一次的 usage/上下文，看时间点是否晚于代码改动
const headers = events.filter((e) => e.type === "request/header");
const lastHeader = headers[headers.length - 1];
console.log(`═══ ③ 最近一次 request/header ═══`);
if (lastHeader === undefined) console.log("  （没有）");
else {
  console.log(`  seq=${lastHeader.seq} time=${new Date(lastHeader.time).toISOString()}`);
}
// 本进程启动时刻的近似：第一条事件
console.log(`  会话首条事件 seq=${events[0]?.seq} time=${new Date(events[0]?.time).toISOString()}`);
console.log("");

// ── ④ 同期 compaction/start 情况（回合内 vs 回合间）──
const comps = events.filter((e) => e.type === "compaction/start");
let inTurn = 0, between = 0;
const inTurnTurns = [];
for (const c of comps) {
  if (c?.data?.turn === null || c?.data?.turn === undefined) between += 1;
  else { inTurn += 1; inTurnTurns.push(c.data.turn); }
}
console.log(`═══ ④ compaction/start 共 ${comps.length} 次 ═══`);
console.log(`  回合内 ${inTurn} 次 · 回合间 ${between} 次`);
console.log(`  回合内的 turn：${inTurnTurns.join(" / ") || "（无）"}`);
const maxTurn = Math.max(...events.filter((e) => e.type === "turn/start").map((e) => e.data?.turn ?? 0), 0);
console.log(`  当前最大 turn：${maxTurn}`);
const lastInTurn = inTurnTurns.length > 0 ? Math.max(...inTurnTurns) : undefined;
if (lastInTurn !== undefined) {
  console.log(`  最后一次回合内压缩在 turn ${lastInTurn} ⇒ 之后 ${maxTurn - lastInTurn} 个 turn 没再发生`);
}
