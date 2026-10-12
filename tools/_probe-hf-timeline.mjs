/**
 * 只读探针 ③：把 01:05–01:20 的**时间线**逐条打出来，回答三个问题。
 *
 * ★ 用户 2026-10-12 01:15 的两条现场证据：
 *   ① 手动点压缩报 `manual compaction requires an idle agent with no waking queued work`
 *   ② 紧接着又报「上下文已压缩」
 *   ⇒ 到底是谁报的 ①、谁报的 ②？
 *
 * ★ 上一版的两个错法（已记，纪律 3）：
 *   · `agent/status` 命中 0 ⇒ 事件名猜错了；真名要从**事件名分布**里读。
 *   · `source` 字段不在我猜的位置 ⇒ 改成打**全部键名**。
 *
 * ★ 这一版只读**会话日志**（被测系统自己产生的），不猜任何字段：
 *   用「事件名 → 字段名」两遍法。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");

function decodeFrames(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  let idx = buf.indexOf(MAGIC, 0);
  while (idx !== -1) {
    starts.push(idx);
    idx = buf.indexOf(MAGIC, idx + 1);
  }
  let out = "";
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      const d = zlib.zstdDecompressSync(buf.subarray(starts[k], end));
      if (d.length) out += d.toString("utf8");
    } catch {
      /* 尾帧可能不完整 */
    }
  }
  return out;
}

function newestSession() {
  let best;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === "session.v4.jsonl.zstd") {
        const m = fs.statSync(p).mtimeMs;
        if (best === undefined || m > best.m) best = { p, m };
      }
    }
  };
  walk(SESSIONS, 0);
  return best;
}

const target = newestSession();
const raw = decodeFrames(fs.readFileSync(target.p));
const events = [];
for (const l of raw.split("\n")) {
  if (l.trim() === "") continue;
  try {
    events.push(JSON.parse(l));
  } catch {
    /* 跳过 */
  }
}

function timeOf(e) {
  for (const k of ["time", "timestamp", "at", "ts"]) {
    const v = e?.[k];
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return undefined;
}
const hhmmss = (ms) => new Date(ms).toTimeString().slice(0, 8);

// 时间窗：最后 25 分钟（覆盖 01:05–01:20 那一带）
const maxT = Math.max(...events.map((e) => timeOf(e) ?? 0));
const from = maxT - 25 * 60 * 1000;
console.log(`窗口：${hhmmss(from)} – ${hhmmss(maxT)}（本地）  共扫 ${events.length} 条事件`);

// ── 先学：每种事件名 → 它 data 里的键 ────────────────────────────────────
console.log("\n=== 事件名 → data 键（只列窗口内的）===");
const names = new Map();
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < from) continue;
  const n = String(e?.name ?? e?.event ?? e?.type ?? "(无)");
  if (!names.has(n)) names.set(n, new Map());
  const m = names.get(n);
  for (const k of Object.keys(e?.data ?? e)) m.set(k, (m.get(k) ?? 0) + 1);
}
for (const [n, m] of names) {
  console.log(`  ${n}: ${[...m.keys()].join(", ").slice(0, 160)}`);
}

// ── 时间线：只打"与压缩/注入/工具"有关的 ────────────────────────────────
console.log("\n=== 时间线 ===");
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < from) continue;
  const n = String(e?.name ?? e?.event ?? e?.type ?? "");
  const d = e?.data ?? {};

  if (n === "compaction/start" || n === "compaction/summary" || n === "compaction/end") {
    const extra = {};
    for (const k of ["compactionId", "owner", "stability", "sourceCommandId", "shadowedTokenCount", "turn"]) {
      if (d[k] !== undefined) extra[k] = d[k];
    }
    // shadowedRange / shadowedSeqs 摘要
    if (d.shadowedRange !== undefined) extra.shadowedRange = JSON.stringify(d.shadowedRange).slice(0, 90);
    if (Array.isArray(d.shadowedSeqs)) {
      extra.seqs = `${d.shadowedSeqs.length} 个, ${Math.min(...d.shadowedSeqs)}..${Math.max(...d.shadowedSeqs)}`;
    }
    console.log(`  ${hhmmss(t)}  ${n.padEnd(20)} ${JSON.stringify(extra)}`);
    continue;
  }

  if (n === "user/message") {
    const m = d.message ?? {};
    const kind = m?.source?.kind ?? "(用户原话)";
    let s = "";
    if (Array.isArray(m.content)) for (const c of m.content) if (c?.type === "text") s += c.text ?? "";
    console.log(`  ${hhmmss(t)}  user/message[kind=${kind}]  ${s.slice(0, 110).replace(/\n/g, " ")}`);
    continue;
  }

  if (n === "tool/call") {
    const nm = d.name ?? d.toolName ?? d?.message?.name;
    if (nm === "ledger_write" || nm === "ledger_compact" || nm === "ledger_checkpoint" || nm === "ledger_log_write") {
      const args = JSON.stringify(d.args ?? d.arguments ?? d.input ?? {}).slice(0, 150);
      console.log(`  ${hhmmss(t)}  tool/call ${nm}  ${args}`);
    }
    continue;
  }

  if (n === "tool/result") {
    const nm = d?.message?.name ?? d.name ?? "";
    if (nm === "ledger_compact" || nm === "ledger_write") {
      let s = "";
      const c = d?.message?.content;
      if (Array.isArray(c)) for (const x of c) if (x?.type === "text") s += x.text ?? "";
      console.log(`  ${hhmmss(t)}  tool/result ${nm}  ${s.slice(0, 300).replace(/\n/g, " ")}`);
    }
    continue;
  }

  if (n === "command/run" || n === "command/done") {
    console.log(`  ${hhmmss(t)}  ${n}  ${JSON.stringify(d).slice(0, 200)}`);
    continue;
  }

  if (n === "turn/start" || n === "turn/end") {
    console.log(`  ${hhmmss(t)}  ${n}  turn=${d.turn ?? "-"}`);
    continue;
  }
}
