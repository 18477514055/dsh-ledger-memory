/**
 * 只读探针 ⑫：把**插件自报的水位**与**内核口径的水位**并排比 —— 量出"口径差"。
 *
 * ★ 为什么这是"全量为什么迟到"的关键：
 *   插件的 75% 闸门用的是 `measurePressure`（`ctx.get("tokenMeter").measure()`），
 *   而内核请求头里的 `usage.totalTokens` 是**另一个口径**（含工具头）。
 *   台账里有一句待验证假设：「重注加回 ≈4 点（插件报 69%、真实请求 73%）」。
 *   ⇒ 若插件口径系统性偏低，那么"水位到 75% 就排队"实际发生在**内核 77%+**，
 *     这就解释了 01:06:42（内核 75.0%）时为什么**没有**排队。
 *
 * ★ 尺子：
 *   · 插件口径 = 注入文本里「水位 NN%」（插件自己算的，与闸门同一把尺子）
 *   · 内核口径 = 该注入**之后最近一条** `assistant/message.usage.totalTokens` ÷ 1e6
 *   ★ 两者必须**同一时间窗**、且**配对**（纪律 14：比较趋势必须先控制驱动变量）。
 *
 * ★ 配对规则（要说清，否则就是编）：取「注入时间之后 60 秒内最早的一条 assistant/message」。
 *   拿不到配对就**不计入**（宁可样本少，也不要错配）。
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
const events = [];
for (const l of decodeFrames(fs.readFileSync(newestSession().p)).split("\n")) {
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
const stamp = (ms) => new Date(ms).toLocaleString("sv-SE").slice(5, 19);
const WINDOW = 1_000_000;

// 收集内核读数（时间升序）
const kernel = [];
for (const e of events) {
  if (nameOf(e) !== "assistant/message") continue;
  const tot = e?.data?.usage?.totalTokens;
  const t = timeOf(e);
  if (tot === undefined || t === undefined) continue;
  kernel.push({ t, pct: (tot / WINDOW) * 100 });
}

// 收集插件自报水位（注入文本）
const reported = [];
for (const e of events) {
  if (nameOf(e) !== "user/message") continue;
  if (e?.data?.source?.kind === undefined) continue;
  let text = "";
  const c = e?.data?.content;
  if (Array.isArray(c)) for (const x of c) if (x?.type === "text") text += x.text ?? "";
  const t = timeOf(e);
  if (t === undefined) continue;
  // 所有「水位 NN%」都要（不是只取第一条）
  const re = /水位\s*\**\s*(\d{1,3}(?:\.\d)?)\s*%/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    reported.push({ t, pct: Number(m[1]), snippet: text.slice(Math.max(0, m.index - 25), m.index + 40).replace(/\n/g, " ") });
  }
}

console.log(`内核读数 ${kernel.length} 条 · 插件自报 ${reported.length} 条\n`);

// 配对：注入之后 60 秒内最早的一条内核读数
console.log("=== 配对（插件自报 vs 内核口径）===");
console.log("  时间(插件)   插件%   最近内核%   差     出处");
let n = 0;
let sumDiff = 0;
for (const r of reported) {
  const k = kernel.find((x) => x.t >= r.t && x.t - r.t <= 60_000);
  if (k === undefined) continue;
  const diff = k.pct - r.pct;
  n++;
  sumDiff += diff;
  console.log(
    `  ${stamp(r.t)}  ${String(r.pct).padStart(5)}%  ${k.pct.toFixed(1).padStart(8)}%  ${(diff >= 0 ? "+" : "") + diff.toFixed(1).padStart(5)}  ${r.snippet.slice(0, 46)}`
  );
}
console.log(`\n  ★ 可配对样本 ${n} 条；平均口径差 = ${n === 0 ? "?" : (sumDiff / n).toFixed(2)} 点（内核 − 插件）`);
console.log("  ★ 正数 = 内核读数**高于**插件自报 ⇒ 插件的 75% 闸门实际落在内核更高处");
