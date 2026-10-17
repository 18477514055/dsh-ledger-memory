/**
 * 只读探针（D214）：把「连续压缩三次」这件事的现场逐条打出来。
 *
 * ★ 用户 2026-10-15 12:1x 的原话（问题）：
 *   「刚刚我问你这个问题的时候已经过 70% 了，但是它并没有发生自动压缩，反而是一路跑到了 80%
 *    的时候触发了官方的压缩，然后压缩完之后又工作了一小段时间，然后不知道为什么全量压缩又跳出来了，
 *    可能是排队排在了后面，然后导致是连续压缩了两次，然后你回答结束以后，现在这里又展示出上下文
 *    已压缩的说明，也就是一共出现了三个上下文已压缩的记录。」
 *
 * ★ 要回答的四个问题（每条都必须有事件为证）：
 *   ① 70% 线为什么没有触发插件压缩？（是被闸门拦了？还是排队了没等到 idle？）
 *   ② 官方 80% 那次是什么时候、压了什么范围？
 *   ③ 官方之后那次插件全量压缩是什么时候、谁排的队、水位多少？
 *   ④ 第三次「上下文已压缩」是哪来的（是新的一次压缩，还是同一份摘要被重复展示 / 重复注入）？
 *
 * ★ 判据取自被测系统自己产生的那部分（纪律 2）：全部读**官方会话日志**的原始事件，
 *   不猜字段：先打「事件名 → data 键」，再按已知键取值。多帧 zstd 必须按帧切。
 *
 * ★ 为什么不能沿用 `_probe-hf-timeline.mjs`：它的窗口写死「最后 25 分钟」，
 *   而这件事横跨 11:4x–12:0x（>25 分钟）⇒ 窗口太窄会**把前两次压缩切掉**，
 *   看到「只有一次」就会得出错误结论。这个探针的窗口由参数给。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// ── 参数：分钟数（默认 90）与可选会话 id 片段 ──────────────────────────────
const minutes = Number(process.argv[2] ?? 90);
const sessHint = process.argv[3] ?? "a5dd1f8f";

const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");

/** 多帧 zstd：按魔数切帧后逐帧解（只解第一帧会丢掉绝大部分内容）。 */
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

/** 收集全部会话日志，优先选路径含 hint 的那个。 */
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
      else if (e.name === "session.v4.jsonl.zstd") {
        out.push({ p, m: fs.statSync(p).mtimeMs, size: fs.statSync(p).size });
      }
    }
  };
  walk(SESSIONS, 0);
  return out.sort((a, b) => b.m - a.m);
}

const all = listSessions();
const target = all.find((s) => s.p.includes(sessHint)) ?? all[0];
if (target === undefined) {
  console.log("FAILED: 找不到任何 session.v4.jsonl.zstd");
  process.exit(1);
}
console.log(`会话日志：${target.p}`);
console.log(`最后改动：${new Date(target.m).toLocaleString("sv-SE")}  大小 ${target.size} B`);
console.log(`(另有 ${all.length - 1} 份其它会话日志；本探针只看这一份)`);

const raw = decodeFrames(fs.readFileSync(target.p));
const events = [];
for (const l of raw.split("\n")) {
  if (l.trim() === "") continue;
  try {
    events.push(JSON.parse(l));
  } catch {
    /* 跳过坏行 */
  }
}
console.log(`解出 ${events.length} 条事件\n`);

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
function nameOf(e) {
  return String(e?.name ?? e?.event ?? e?.type ?? "");
}
function textOfContent(c) {
  let s = "";
  if (Array.isArray(c)) for (const x of c) if (x?.type === "text") s += x.text ?? "";
  else if (typeof c === "string") s = c;
  return s;
}
const hhmmss = (ms) => new Date(ms).toTimeString().slice(0, 8);

const times = events.map(timeOf).filter((t) => t !== undefined);
const maxT = Math.max(...times);
const from = maxT - minutes * 60 * 1000;
console.log(`窗口：${hhmmss(from)} – ${hhmmss(maxT)}（本地，共 ${minutes} 分钟）\n`);

// ── ① 事件名 → data 键（先学再取，别猜） ──────────────────────────────────
console.log("=== ① 窗口内「事件名 → data 键」===");
const names = new Map();
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < from) continue;
  const n = nameOf(e);
  if (!names.has(n)) names.set(n, new Set());
  const m = names.get(n);
  for (const k of Object.keys(e?.data ?? {})) m.add(k);
}
for (const [n, m] of [...names].sort()) {
  console.log(`  ${n.padEnd(26)} ${[...m].join(", ").slice(0, 150)}`);
}

// ── ② 全部压缩事件 ────────────────────────────────────────────────────────
console.log("\n=== ② 压缩事件（compaction/*）—— 一次压缩 = start+summary+end ===");
let comp = 0;
const compTimes = [];
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < from) continue;
  const n = nameOf(e);
  if (!/^compaction\//.test(n)) continue;
  comp++;
  const d = e?.data ?? {};
  if (n === "compaction/start") compTimes.push(t);
  const extra = { compactionId: d.compactionId, turn: d.turn };
  if (d.shadowedTokenCount !== undefined) extra.tokens = d.shadowedTokenCount;
  if (d.shadowedRange !== undefined) extra.range = JSON.stringify(d.shadowedRange);
  if (Array.isArray(d.shadowedSeqs) && d.shadowedSeqs.length > 0) {
    extra.seqs = `${d.shadowedSeqs.length} 个 ${Math.min(...d.shadowedSeqs)}..${Math.max(...d.shadowedSeqs)}`;
  }
  if (d.summary !== undefined) extra.summaryLen = String(d.summary).length;
  if (d.error !== undefined) extra.error = String(d.error).slice(0, 300);
  console.log(`  ${hhmmss(t)}  ${n.padEnd(20)} ${JSON.stringify(extra)}`);
}
console.log(`  —— 共 ${comp} 条 compaction 事件；start 次数 = ${compTimes.length}`);

// ── ②b 每次压缩的耗时与成败（start→end 配对） ────────────────────────────
console.log("\n=== ②b 压缩成对核对（判断哪几次真压成了）===");
{
  const byId = new Map();
  for (const e of events) {
    const t = timeOf(e);
    if (t === undefined || t < from) continue;
    const n = nameOf(e);
    if (!/^compaction\//.test(n)) continue;
    const id = e?.data?.compactionId;
    if (id === undefined) continue;
    if (!byId.has(id)) byId.set(id, {});
    const rec = byId.get(id);
    if (n === "compaction/start") rec.start = t;
    if (n === "compaction/summary") rec.summary = t;
    if (n === "compaction/end") rec.end = t;
    if (e?.data?.error !== undefined) rec.error = e.data.error;
    if (e?.data?.shadowedTokenCount !== undefined) rec.tokens = e.data.shadowedTokenCount;
  }
  for (const [id, r] of byId) {
    const dur = r.start !== undefined && r.end !== undefined ? Math.round((r.end - r.start) / 1000) : undefined;
    const verdict =
      r.error !== undefined
        ? "❌ 失败"
        : r.summary !== undefined
          ? "✅ 成功（有 summary）"
          : "⚠️ **只有 start/end，没有 summary**";
    console.log(
      `  ${hhmmss(r.start ?? r.end)}  id=${id.slice(0, 8)}  耗时=${dur ?? "?"}s  tokens=${r.tokens ?? "-"}  ${verdict}`
    );
    if (r.error !== undefined) console.log(`        error: ${String(r.error).slice(0, 400)}`);
  }
}

// ── ②c 水位曲线：每个 assistant/message 的 usage.totalTokens ─────────────
console.log("\n=== ②c 水位曲线（assistant/message 的 usage，只列窗口内每 10 分钟一档）===");
{
  const pts = [];
  for (const e of events) {
    const t = timeOf(e);
    if (t === undefined || t < from) continue;
    if (nameOf(e) !== "assistant/message") continue;
    const u = e?.data?.usage;
    if (u === undefined) continue;
    const tot = u.totalTokens ?? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.output ?? 0);
    pts.push({ t, tot, turn: e?.data?.turn, step: e?.data?.step });
  }
  const pressure = (tot) => `${((tot / 1000000) * 100).toFixed(1)}%`;
  let lastBucket = -1;
  for (const p of pts) {
    const bucket = Math.floor(p.t / (10 * 60 * 1000));
    if (bucket === lastBucket) continue;
    lastBucket = bucket;
    console.log(`  ${hhmmss(p.t)}  turn=${p.turn} step=${p.step}  ${String(p.tot).padStart(8)} tok = ${pressure(p.tot)}`);
  }
  if (pts.length > 0) {
    const last = pts[pts.length - 1];
    console.log(`  —— 最后一个采样：${hhmmss(last.t)} ${last.tot} tok = ${pressure(last.tot)}`);
  }
}

// ── ③ 注入消息（source.kind）—— 谁在什么时候往上下文里塞了什么 ────────────
console.log("\n=== ③ 注入 user/message（带 source.kind 的那些）===");
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < from) continue;
  if (nameOf(e) !== "user/message") continue;
  const m = e?.data?.message ?? e?.data ?? {};
  const kind = m?.source?.kind ?? m?.source?.type ?? "(无 kind = 用户原话)";
  const s = textOfContent(m?.content);
  const mark = /上下文已压缩|高保真压缩|已压缩/.test(s) ? "★" : " ";
  console.log(`  ${mark}${hhmmss(t)}  kind=${String(kind).padEnd(28)} len=${String(s.length).padStart(6)}  ${s.slice(0, 90).replace(/\n/g, " ")}`);
}

// ── ④ 自己在跑的工具调用（只看会影响闸门的） ──────────────────────────────
console.log("\n=== ④ 与闸门有关的工具调用 / 结果 ===");
const GATE_TOOLS = new Set(["ledger_write", "ledger_log_write", "ledger_triage", "ledger_compact", "ledger_checkpoint", "ledger_archive"]);
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < from) continue;
  const n = nameOf(e);
  const d = e?.data ?? {};
  if (n === "tool/call") {
    const nm = d.name ?? d.toolName ?? d?.message?.name;
    if (!GATE_TOOLS.has(nm)) continue;
    console.log(`  ${hhmmss(t)}  tool/call   ${nm}  ${JSON.stringify(d.arguments ?? d.args ?? {}).slice(0, 120)}`);
  } else if (n === "tool/result") {
    const nm = d?.message?.name ?? d.name;
    if (!GATE_TOOLS.has(nm)) continue;
    const s = textOfContent(d?.message?.content ?? d?.content);
    console.log(`  ${hhmmss(t)}  tool/result ${nm}  ${s.slice(0, 200).replace(/\n/g, " ")}`);
  }
}

// ── ⑤ 「上下文已压缩」这句话出现在哪些地方 ────────────────────────────────
console.log("\n=== ⑤ 全文搜「上下文已压缩 / 已压缩」（判断第三次是哪种）===");
let hits = 0;
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < from) continue;
  const s = JSON.stringify(e);
  if (!/上下文已压缩/.test(s)) continue;
  hits++;
  const n = nameOf(e);
  const d = e?.data ?? {};
  const kind = d?.message?.source?.kind ?? d?.source?.kind ?? "";
  const body = textOfContent(d?.message?.content ?? d?.content ?? d?.summary);
  console.log(`  ${hhmmss(t)}  ${n.padEnd(20)} kind=${kind}  ${(body || s).slice(0, 160).replace(/\n/g, " ")}`);
}
console.log(`  —— 命中 ${hits} 条`);
