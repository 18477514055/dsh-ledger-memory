/**
 * 只读探针（D214 之三）：把「回合边界 / idle / 落盘 / 压缩」四条线叠在同一时间轴上。
 *
 * ★ 要回答的核心问题（用户 2026-10-15 12:07 的原话）：
 *   「过 70% 时没有自动压缩，一路跑到 80% 触发官方压缩；压完之后工作了一小段时间，
 *     全量压缩又跳出来（可能是排队排在了后面），连续压了两次。」
 *
 * ★ 判据：只听**官方会话日志**里的事件真相 ——
 *   · 插件能不能压，取决于 `agent/status` 有没有变 idle（`compactNow` 非 idle 会抛 busy）
 *   · 官方压不压，取决于它自己的 pre-step（**回合中途**也会跑）
 *   ⇒ 谁赢，就看"水位越过 80%"和"第一次 idle"哪个先到。
 *
 * ★ 为什么不能用 `_probe-d214-compact-trace.mjs` 顶替：那个打的是压缩与注入，
 *   这个要的是**回合边界与 idle** —— 缺了它就无法证明"插件根本没机会先压"。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const sessHint = process.argv[2] ?? "a5dd1f8f";
const minFrom = Number(process.argv[3] ?? 11.5); // 本地小时，例如 11.5 = 11:30
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

function listSessions() {
  const out = [];
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
      else if (e.name === "session.v4.jsonl.zstd") out.push({ p, m: fs.statSync(p).mtimeMs });
    }
  };
  walk(SESSIONS, 0);
  return out.sort((a, b) => b.m - a.m);
}

const target = listSessions().find((s) => s.p.includes(sessHint));
if (target === undefined) {
  console.log("FAILED: 找不到会话日志");
  process.exit(1);
}
const events = [];
for (const l of decodeFrames(fs.readFileSync(target.p)).split("\n")) {
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
const nameOf = (e) => String(e?.name ?? e?.event ?? e?.type ?? "");
const hhmmss = (ms) => new Date(ms).toTimeString().slice(0, 8);
const textOf = (e) => {
  const d = e?.data ?? {};
  const c = (d.message ?? d).content ?? d.content;
  let s = "";
  if (Array.isArray(c)) for (const x of c) if (x?.type === "text") s += x.text ?? "";
  else if (typeof c === "string") s = c;
  return s;
};

// 全库先看有哪些与 idle / status 相关的事件名（别猜）
const idleNames = new Set();
for (const e of events) {
  const n = nameOf(e);
  if (/status|idle|turn\/(start|end)|inbox/i.test(n)) idleNames.add(n);
}
console.log(`本会话与"状态/回合"有关的事件名：${[...idleNames].sort().join(" · ")}\n`);

const times = events.map(timeOf).filter((t) => t !== undefined);
const maxT = Math.max(...times);
const from = new Date(maxT);
from.setHours(Math.floor(minFrom), Math.round((minFrom % 1) * 60), 0, 0);
const FROM = from.getTime();
console.log(`窗口：${hhmmss(FROM)} – ${hhmmss(maxT)}\n`);

// ── 四条线合成一张时间轴 ─────────────────────────────────────────────────
console.log("=== 时间轴：回合 / 水位 / 落盘 / 压缩 ===");
const GATE = new Set(["ledger_write", "ledger_log_write", "ledger_triage"]);
let lastTurn = undefined;
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < FROM) continue;
  const n = nameOf(e);
  const d = e?.data ?? {};

  if (n === "turn/start") {
    console.log(`  ${hhmmss(t)}  ▶ turn ${d.turn} 开始`);
    lastTurn = d.turn;
    continue;
  }
  if (n === "turn/end") {
    const kind = d?.reason?.kind ?? JSON.stringify(d?.reason ?? {});
    console.log(`  ${hhmmss(t)}  ⏹ turn ${d.turn ?? lastTurn} 结束（reason=${kind}）`);
    continue;
  }
  if (n === "agent/status") {
    console.log(`  ${hhmmss(t)}  ◆ agent/status = ${d.status ?? d?.message?.status}`);
    continue;
  }
  if (/idle/i.test(n) && n !== "agent/status") {
    console.log(`  ${hhmmss(t)}  ◆ ${n} ${JSON.stringify(d).slice(0, 120)}`);
    continue;
  }
  if (n === "assistant/message") {
    const u = d.usage;
    if (u === undefined) continue;
    const tot = u.totalTokens ?? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.output ?? 0);
    const pct = ((tot / 1000000) * 100).toFixed(1);
    // 只在跨档时打印，避免刷屏
    const bucket = Math.floor(tot / 50000);
    if (bucket === globalThis.__lastBucket) continue;
    globalThis.__lastBucket = bucket;
    console.log(`  ${hhmmss(t)}  ～ 水位 ${pct}%（${tot} tok）turn=${d.turn} step=${d.step}`);
    continue;
  }
  if (n === "compaction/start") {
    console.log(`  ${hhmmss(t)}  ✂ compaction/start turn=${d.turn ?? "null"}（${d.compactionId?.slice(0, 8)}）`);
    continue;
  }
  if (n === "compaction/end") {
    const err = d.error === undefined ? "成功" : `**失败**：${String(d.error).slice(0, 80)}`;
    console.log(`  ${hhmmss(t)}  ✂ compaction/end ${err}`);
    continue;
  }
  if (n === "tool/call") {
    const nm = d.name ?? d.toolName;
    if (!GATE.has(nm)) continue;
    console.log(`  ${hhmmss(t)}  ✔ 落盘 ${nm}`);
    continue;
  }
}
