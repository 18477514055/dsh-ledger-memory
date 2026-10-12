/**
 * 只读探针 ②：把最后一段时间的**原始事件**打出来，找那句 busy 报错到底出在哪。
 *
 * ★ 上一版的两个错（纪律 3：取不到值先怀疑取法）：
 *   ① `agent/status` 命中 **0** 条 ⇒ 事件名不是这个；
 *   ② `source=undefined` 的一大片，说明来源字段不在我猜的位置。
 *   ⇒ 这次不猜字段名，**把每条事件的全部键都打出来**。
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
console.log(`事件总数 ${events.length}`);

/** 取时间（数字毫秒 or ISO）。 */
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
const local = (ms) => (ms === undefined ? "???" : new Date(ms).toLocaleString("sv-SE"));

// ── ① 全库搜那句 busy 报错 ────────────────────────────────────────────────
console.log("\n=== ① 搜「idle agent with no waking queued work」 ===");
let busy = 0;
for (const e of events) {
  const s = JSON.stringify(e);
  if (s.includes("waking queued work") || s.includes("requires an idle agent")) {
    busy++;
    if (busy <= 6) console.log(`  ${local(timeOf(e))}  ${JSON.stringify(e).slice(0, 400)}`);
  }
}
console.log(`  命中 ${busy} 条`);

// ── ② 事件名分布（全库 + 最近 60 分钟） ──────────────────────────────────
const maxT = Math.max(...events.map((e) => timeOf(e) ?? 0));
const cutoff = maxT - 60 * 60 * 1000;
console.log(`\n=== ② 最近 60 分钟（${local(cutoff)} 之后）的事件名分布 ===`);
const byName = new Map();
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < cutoff) continue;
  const n = e?.name ?? e?.event ?? e?.type ?? "(无 name)";
  byName.set(n, (byName.get(n) ?? 0) + 1);
}
for (const [n, c] of [...byName].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(6)}  ${n}`);

// ── ③ 最近 60 分钟里，与压缩 / 状态 / 注入有关的事件逐条打印 ─────────────
console.log(`\n=== ③ 最近 60 分钟：压缩/状态/注入 事件的**全部字段** ===`);
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < cutoff) continue;
  const n = String(e?.name ?? e?.event ?? e?.type ?? "");
  const interesting = /compaction|status|idle|error|warn/i.test(n);
  if (!interesting) continue;
  const data = e?.data ?? {};
  const brief = {
    name: n,
    keys: Object.keys(data).slice(0, 18),
    sourceCommandId: data.sourceCommandId,
    source: data.source,
    status: data.status,
    owner: data.owner,
    start: data.start ?? data.from,
    end: data.end ?? data.to,
    reason: data.reason ?? data.message,
  };
  console.log(`  ${local(t)}  ${JSON.stringify(brief)}`);
}
