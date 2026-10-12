/**
 * 只读探针 ⑤：把**水位曲线**打出来（这是回答"全量为什么轮不上"的关键硬数字）。
 *
 * ★ 两把尺子，必须分开用（纪律 15：先把不同源的分开再统计）：
 *   ① 内核真实用量：`assistant/message` → `data.usage.totalTokens`（1M 窗口 ⇒ ÷10000 得百分比）
 *   ② 插件自己的水位报告：插件注入里的「水位 xx%」（与闸门同一把尺子，**同源可比**）
 *
 * ★ 要看的形态：
 *   · 每次 compaction/start 之前的水位、之后的水位 ⇒ 增量到底降了多少点
 *   · 全量 start 之前那一步，水位是几点 ⇒ 它是不是被增量"吃得"只剩刚好过线
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

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

const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");
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
const events = [];
for (const l of decodeFrames(fs.readFileSync(target.p)).split("\n")) {
  if (l.trim() === "") continue;
  try {
    events.push(JSON.parse(l));
  } catch {
    /* 跳过 */
  }
}
const timeOf = (e) => {
  for (const k of ["time", "timestamp", "at", "ts"]) {
    const v = e?.[k];
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return undefined;
};
const nameOf = (e) => String(e?.name ?? e?.event ?? e?.type ?? "(无)");
const hhmmss = (ms) => new Date(ms).toTimeString().slice(0, 8);

const maxT = Math.max(...events.map((e) => timeOf(e) ?? 0));
const from = maxT - 45 * 60 * 1000;
console.log(`窗口 ${hhmmss(from)} – ${hhmmss(maxT)}（本地）`);

// assistant/message 的 usage 结构先看清楚
const sampleAm = events.find((e) => nameOf(e) === "assistant/message");
console.log("\n=== assistant/message.data.usage 结构 ===");
console.log("  " + JSON.stringify(sampleAm?.data?.usage ?? null));

const WINDOW = 1_000_000;
const pctOf = (tot) => (tot === undefined ? undefined : (tot / WINDOW) * 100);

console.log("\n=== 水位曲线（内核口径：assistant/message.usage.totalTokens）===");
console.log("  时间      turn/step   水位%   事件");
let lastPct;
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < from) continue;
  const n = nameOf(e);

  if (n === "assistant/message") {
    const u = e?.data?.usage ?? {};
    const tot = u.totalTokens;
    const p = pctOf(tot);
    if (p !== undefined) lastPct = p;
    continue;
  }

  if (n === "compaction/start") {
    const turn = e?.data?.turn;
    console.log(
      `  ${hhmmss(t)}  turn=${String(turn).padEnd(5)}  压前≈${lastPct === undefined ? "?" : lastPct.toFixed(1)}%   ▶ 压缩开始`
    );
    continue;
  }
  if (n === "compaction/summary") {
    const u = e?.data?.usage ?? {};
    console.log(
      `  ${hhmmss(t)}  ${" ".repeat(12)}  shadowed=${e?.data?.shadowedTokenCount ?? "-"}  摘要自身用量=${u.totalTokens ?? "-"}`
    );
    continue;
  }
  if (n === "compaction/end") {
    console.log(`  ${hhmmss(t)}  ${" ".repeat(12)}  ■ 压缩结束`);
    continue;
  }
  if (n === "turn/end") {
    console.log(`  ${hhmmss(t)}  ${" ".repeat(12)}  —— turn/end（这一瞬是 idle）turn=${e?.data?.turn ?? "-"}`);
    continue;
  }

  // 插件注入里的水位报告（与闸门同源）
  if (n === "user/message") {
    const m = e?.data?.message ?? {};
    const kind = m?.source?.kind;
    let s = "";
    if (Array.isArray(m.content)) for (const c of m.content) if (c?.type === "text") s += c.text ?? "";
    const mm = s.match(/水位[^0-9]{0,6}(\d{1,3}(?:\.\d)?)\s*%/);
    if (kind !== undefined && mm !== null) {
      console.log(`  ${hhmmss(t)}  ${" ".repeat(12)}  插件报水位 ${mm[1]}%  [${kind}]`);
    }
  }
}
