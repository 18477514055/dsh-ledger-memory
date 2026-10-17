/**
 * 只读探针（D214 之二）：钉死「排队时刻」与「回合中途有没有给过水位提醒」。
 *
 * ★ 要回答：
 *   ① 插件那句「**本插件即将执行一次高保真压缩**」出现在哪几个时刻？
 *      （那一刻 = 它在 `state.hfCompactAfterTurn` 里排了队）
 *   ② 那句「**上下文刚被压缩**」出现在哪几个时刻？
 *      （用于判断用户看到的"第三条已压缩记录"到底是新压缩还是**同一件事被重复说**）
 *   ③ 回合中途有没有出现过**水位提醒**（"水位已到 N%"）？
 *      ⇒ 这决定责任归属：**收到却不动**（模型侧）vs **压根没收到**（插件侧没在回合中途告知）。
 *
 * ★ 判据一律取自会话事件流里**插件自己写进去的注入文本**（`source.kind = project-ledger-notes`），
 *   不猜、不从别处推。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const sessHint = process.argv[2] ?? "a5dd1f8f";
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
console.log(`会话：${path.basename(path.dirname(target.p))}`);
console.log(`事件 ${events.length} 条\n`);

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
function textOf(e) {
  const d = e?.data ?? {};
  const m = d.message ?? d;
  const c = m?.content ?? d.content;
  let s = "";
  if (Array.isArray(c)) for (const x of c) if (x?.type === "text") s += x.text ?? "";
  else if (typeof c === "string") s = c;
  return s;
}
const hhmmss = (ms) => new Date(ms).toTimeString().slice(0, 8);

// 文本全部拉平，逐条注入
const rows = [];
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined) continue;
  const n = String(e?.name ?? e?.event ?? e?.type ?? "");
  if (n !== "user/message") continue;
  const m = e?.data?.message ?? e?.data ?? {};
  const kind = m?.source?.kind ?? "(用户原话)";
  const s = textOf(e);
  if (s === "") continue;
  rows.push({ t, kind, s });
}
rows.sort((a, b) => a.t - b.t);

/** 搜一个模式，打印命中处的时间 + 模式附近的一小段。 */
function hunt(label, re, ctxLen = 120) {
  console.log(`=== ${label} ===`);
  let n = 0;
  for (const r of rows) {
    const m = re.exec(r.s);
    if (m === null) continue;
    n++;
    const a = Math.max(0, m.index - 30);
    const snippet = r.s.slice(a, m.index + ctxLen).replace(/\n/g, " ");
    console.log(`  ${hhmmss(r.t)}  kind=${String(r.kind).padEnd(22)} …${snippet}`);
  }
  console.log(`  —— 命中 ${n} 条\n`);
  return n;
}

hunt("① 排队宣告（「即将执行一次高保真压缩」）", /即将执行一次高保真压缩/g, 220);
hunt("② 压缩后说明（「上下文刚被压缩」）", /上下文刚被压缩/g, 120);
hunt("③ 水位提醒（「水位已到 / 已到 N%」）", /水位已到|已到 \d+%|水位 \d+%/g, 150);
hunt("④ 插件自造注入（「本步原本没有别的注入」）", /本步原本没有别的注入/g, 120);

// ── ⑤ 把那些「很长」的注入按时间排出来（长 = 夹带了台账全文或胶囊） ──────
console.log("=== ⑤ 注入体量时间线（只列 >5000 字符的，判断什么时候发生了重注）===");
for (const r of rows) {
  if (r.s.length <= 5000) continue;
  const head = r.s.slice(0, 70).replace(/\n/g, " ");
  console.log(`  ${hhmmss(r.t)}  len=${String(r.s.length).padStart(6)}  kind=${String(r.kind).padEnd(22)} ${head}`);
}
