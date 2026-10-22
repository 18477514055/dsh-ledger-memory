/**
 * 只读探针：**上游 400（code 11115）当时到底是多少 token —— 结构化地量**。
 *
 * ★★★ 上一版这个探针是**尺子错**（已记）：我用 `JSON.stringify(e).includes("11115")`
 *   去搜，结果 622 条命中里**全是"我自己写的探针源码"**（tool/call 的 arguments 里有这串数字）
 *   ⇒ 测的是我自己，不是被测对象。**判据只吃结构位，不扫正文**（纪律 2/25 同型）。
 *
 * ⇒ 本版三条硬规矩：
 *   ① **只从结构字段取**：`assistant/attempt → data.stream[].chunk.reason.failure.message`
 *      与 `llm/retry → failure.message`。**不 stringify 整个事件**。
 *   ② 每次失败都配上**它之前最后一次成功的 usage.totalTokens** —— 这才是"报错那一刻的真实水量"。
 *   ③ 同时报 `request/header.data.header.config`（里面可能有真正的 maxTokens / contextWindow），
 *      以及 `startsSeries`（它若变化，说明上游把这次请求当成**新一条序列**）。
 *
 * 跑法：
 *   node tools/_probe-11115-truth.mjs
 *   node tools/_probe-11115-truth.mjs --file "<session.v4.jsonl.zstd>"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const argFile = (() => {
  const i = process.argv.indexOf("--file");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();
const SESS_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");

function findNewest(root) {
  const cands = [];
  (function walk(d, depth) {
    if (depth > 4) return;
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.jsonl\.zstd$/.test(e.name)) {
        try {
          cands.push({ p, m: fs.statSync(p).mtimeMs });
        } catch {
          /* 忽略 */
        }
      }
    }
  })(root, 0);
  cands.sort((a, b) => b.m - a.m);
  return cands[0]?.p;
}

const FILE = argFile ?? findNewest(SESS_ROOT);
if (FILE === undefined || !fs.existsSync(FILE)) {
  console.log("SKIP：找不到会话日志");
  process.exit(0);
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const raw = fs.readFileSync(FILE);
const starts = [0];
for (let i = 1; ; ) {
  const p = raw.indexOf(MAGIC, i);
  if (p < 0) break;
  if (p !== 0) starts.push(p);
  i = p + 4;
}
const events = [];
for (let k = 0; k < starts.length; k += 1) {
  const end = k + 1 < starts.length ? starts[k + 1] : raw.length;
  let out;
  try {
    out = zlib.zstdDecompressSync(raw.subarray(starts[k], end));
  } catch {
    continue;
  }
  for (const line of out.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 跳过坏行 */
    }
  }
}
console.log(`会话日志：${path.basename(path.dirname(path.dirname(FILE)))}`);
console.log(`事件：${events.length}\n`);

// ── 1. 从**结构位**抽失败（不 stringify 整个事件）──────────────────────
//
// ★ 两种承载点（本机实测过的形状）：
//   · `assistant/attempt` → `data.stream[i]` 且 `chunk.type === "finish"`
//       且 `chunk.reason.kind === "error"` ⇒ `chunk.reason.failure.message`
//   · `llm/retry` → 顶层 `failure.message`
const failures = [];
for (const e of events) {
  if (e.type === "assistant/attempt") {
    const stream = e?.data?.stream;
    if (!Array.isArray(stream)) continue;
    for (const part of stream) {
      const ch = part?.chunk;
      if (ch?.type !== "finish") continue;
      const f = ch?.reason?.failure;
      if (f === undefined || f === null) continue;
      failures.push({
        at: e.time,
        turn: e?.data?.turn,
        step: e?.data?.step,
        via: "assistant/attempt",
        message: String(f.message ?? ""),
        code: f.code,
        type: f.type,
      });
    }
  } else if (e.type === "llm/retry") {
    const f = e?.failure;
    if (f === undefined || f === null) continue;
    failures.push({
      at: e.time,
      turn: e?.turn,
      step: e?.step,
      via: "llm/retry",
      message: String(f.message ?? ""),
      code: f.code,
      type: f.type,
    });
  }
}

/** 只按**结构字段**判定：410 那条 11115 的 message 里带 "code":11115 或 "11115"。 */
function isOverLimit(f) {
  const m = f.message;
  return m.includes("11115") || m.includes("超过了模型上限") || m.includes("context_length");
}
const over = failures.filter(isOverLimit);
console.log(`═══ 1. 失败总数 ${failures.length} 条；其中"超模型上限"类 ${over.length} 条 ═══`);
const kinds = new Map();
for (const f of failures) {
  const k = String(f.code ?? "?") + " / " + String(f.type ?? "?");
  kinds.set(k, (kinds.get(k) ?? 0) + 1);
}
for (const [k, n] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)} 次   code/type = ${k}`);
}
console.log("");

// ── 2. 每一次"超限"当时的水量 ─────────────────────────────────────────
const usageAt = [];
for (let i = 0; i < events.length; i += 1) {
  const e = events[i];
  const u = e?.data?.usage;
  if (e.type === "assistant/message" && u !== undefined) usageAt.push({ i, at: e.time, u });
}
/** 找 `at` 之前最近的一条 usage。 */
function usageBefore(i) {
  let lo = 0;
  let hi = usageAt.length - 1;
  let hit;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (usageAt[mid].i < i) {
      hit = usageAt[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return hit;
}
const idxOf = new Map(events.map((e, i) => [e, i]));

console.log(`═══ 2. 每次"超模型上限"之前的真实水量（官方 usage 口径）═══`);
console.log(`   #   时间            轮/步        上次 total   input  cacheRead   output   距上一次多久`);
for (const [n, f] of over.entries()) {
  const i = idxOf.get(events.find((e) => e.time === f.at)) ?? -1;
  const prev = usageBefore(i);
  const u = prev?.u;
  const gap = prev === undefined ? "?" : `${Math.round((f.at - prev.at) / 1000)}s`;
  console.log(
    `  ${String(n + 1).padStart(3)} ${new Date(f.at).toLocaleString("zh-CN").padEnd(18)} ` +
      `${String(f.turn ?? "?").padStart(4)}/${String(f.step ?? "?").padStart(3)}  ` +
      `${String(u?.totalTokens ?? "?").padStart(10)} ${String(u?.inputTokens ?? 0).padStart(7)} ` +
      `${String(u?.cacheReadTokens ?? 0).padStart(10)} ${String(u?.outputTokens ?? 0).padStart(8)}  ${gap}`
  );
}
console.log("");

// ── 3. request/header 的 config：真窗口在这里吗？──────────────────────
const reqs = events.filter((e) => e.type === "request/header");
console.log(`═══ 3. request/header：${reqs.length} 条 ═══`);
const lastReq = reqs.at(-1);
if (lastReq !== undefined) {
  const cfg = lastReq?.data?.header?.config;
  console.log(`  data.header.config = ${JSON.stringify(cfg)?.slice(0, 1200)}`);
  console.log(`  data.startsSeries = ${JSON.stringify(lastReq?.data?.startsSeries)?.slice(0, 400)}`);
  console.log(`  data.reason = ${JSON.stringify(lastReq?.data?.reason)?.slice(0, 400)}`);
  const tools = lastReq?.data?.header?.tools;
  if (Array.isArray(tools)) {
    const chars = JSON.stringify(tools).length;
    console.log(`  tools：${tools.length} 个 · ${chars.toLocaleString("en-US")} 字符 ≈ ${Math.round(chars / 4).toLocaleString("en-US")} tok`);
  }
}
console.log("");

// ── 4. tools 数量随时间是否在涨（每请求都带 ⇒ 会挤占窗口）──────────────
if (reqs.length >= 2) {
  console.log(`═══ 4. tools 数量走势（首 / 中 / 末）═══`);
  for (const k of [0, Math.floor(reqs.length / 2), reqs.length - 1]) {
    const r = reqs[k];
    const t = r?.data?.header?.tools;
    const n = Array.isArray(t) ? t.length : -1;
    const c = Array.isArray(t) ? JSON.stringify(t).length : 0;
    console.log(`  #${String(k).padStart(3)}  ${new Date(r.time).toLocaleString("zh-CN")}  tools=${String(n).padStart(4)}  ${String(c).padStart(8)} 字符`);
  }
  console.log("");
}

// ── 5. 压缩事件与超限的先后关系（是不是"该压没压"）────────────────────
const comps = events.filter((e) => e.type === "compaction/start" || e.type === "compaction/end");
console.log(`═══ 5. 压缩相关事件：${comps.length} 条（start/end）═══`);
const compStarts = comps.filter((e) => e.type === "compaction/start");
for (const c of compStarts.slice(-6)) {
  console.log(
    `  start ${new Date(c.time).toLocaleString("zh-CN")}  turn=${JSON.stringify(c?.data?.turn)} ` +
      `reason=${JSON.stringify(c?.data?.reason ?? c?.data?.source ?? "?")}`
  );
}
console.log("");

// ── 6. 每次超限之前，最近一次压缩距今多远 ─────────────────────────────
console.log(`═══ 6. 每次超限 ⇐ 距最近一次压缩 ───`);
for (const [n, f] of over.entries()) {
  const before = compStarts.filter((c) => c.time <= f.at);
  const lastC = before.at(-1);
  const dist = lastC === undefined ? "从未压过" : `${Math.round((f.at - lastC.time) / 60000)} 分钟前`;
  console.log(`  #${String(n + 1).padStart(2)}  ${new Date(f.at).toLocaleString("zh-CN")}   ${dist}`);
}
console.log("");
console.log("完成。本探针只用量尺，不给结论。");
