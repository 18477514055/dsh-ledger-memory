/**
 * 只读探针 ④：把窗口内的**水位（token 用量）**逐条打出来。
 *
 * ★ 要回答（用户 2026-10-12）：
 *   「是不是应该限制到了 70% 以上的时候，增量压缩不再发生？」
 *   ⇒ 先得知道：水位到底在什么时刻越过了 75%，全量又在什么时刻才真的跑；
 *     以及那一步**增量有没有同时发生**（增量是否"抢走"了全量的水位带）。
 *
 * ★ 尺子（纪律 2）：水位取自**内核自己发的 `request/header`**（真实 token 数在
 *   `data.usage.totalTokens`，台账里已验 `totalTokens ≡ input + cacheRead + output`）。
 *   拿不到就写"未知"，不猜。
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
const hhmmss = (ms) => new Date(ms).toTimeString().slice(0, 8);
/** ★ 事件名在 `type`（不是 `name`）—— 实测：只看 `name` 会全落到 undefined。 */
const nameOf = (e) => String(e?.name ?? e?.event ?? e?.type ?? "(无)");

const maxT = Math.max(...events.map((e) => timeOf(e) ?? 0));
const from = maxT - 40 * 60 * 1000;
console.log(`窗口 ${hhmmss(from)} – ${hhmmss(maxT)}`);

// 先看 request/header 的结构（第一条约 4KB，只打顶层键）
const first = events.find((e) => nameOf(e) === "request/header");
console.log("\n=== request/header 的 data 顶层键 ===");
console.log("  " + Object.keys(first?.data ?? {}).join(", "));
const hd = first?.data?.header ?? {};
console.log("  header 顶层键: " + Object.keys(hd).slice(0, 30).join(", "));
console.log("  data.reason = " + JSON.stringify(first?.data?.reason));

// 找 usage 的位置
const usageCand = {
  "data.usage": first?.data?.usage,
  "data.header.usage": hd?.usage,
  "data.header.tokens": hd?.tokens,
  "data.tokens": first?.data?.tokens,
};
console.log("\n=== usage 候选位置（看哪个非空）===");
for (const [k, v] of Object.entries(usageCand)) {
  console.log(`  ${k} = ${v === undefined ? "undefined" : JSON.stringify(v).slice(0, 160)}`);
}

// 全量找任何带 totalTokens 的事件（学出真正的位置）
console.log("\n=== 含 totalTokens 的事件名（窗口内）===");
const seen = new Map();
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < from) continue;
  const s = JSON.stringify(e.data ?? {});
  if (!s.includes("totalTokens")) continue;
  const n = nameOf(e);
  seen.set(n, (seen.get(n) ?? 0) + 1);
}
for (const [n, c] of seen) console.log(`  ${n}: ${c}`);

// 逐条打水位
console.log("\n=== 水位时间线（request/header + assistant/message.usage）===");
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < from) continue;
  const n = nameOf(e);

  if (n === "request/header") {
    const u = e?.data?.usage ?? e?.data?.header?.usage;
    const tot = u?.totalTokens ?? u?.total;
    const pct = tot === undefined ? undefined : ((tot / 1_000_000) * 100).toFixed(1);
    console.log(
      `  ${hhmmss(t)}  request/header  totalTokens=${tot ?? "?"}  ${pct ?? "?"}%  reason=${JSON.stringify(e?.data?.reason).slice(0, 60)}`
    );
  } else if (n === "compaction/start" || n === "compaction/summary") {
    const u = e?.data?.usage;
    const tot = u?.totalTokens ?? u?.total;
    console.log(
      `  ${hhmmss(t)}  ${n.padEnd(18)}  shadowed=${e?.data?.shadowedTokenCount ?? "-"}  summaryUsage=${tot ?? "-"}`
    );
  } else if (n === "user/message") {
    const m = e?.data?.message ?? {};
    const kind = m?.source?.kind ?? "(用户原话)";
    let s = "";
    if (Array.isArray(m.content)) for (const c of m.content) if (c?.type === "text") s += c.text ?? "";
    if (/水位|压缩|76%|70%/.test(s) && s.length < 3000) {
      console.log(`  ${hhmmss(t)}  inject[${kind}]  ${s.slice(0, 150).replace(/\n/g, " ")}`);
    }
  } else if (n === "tool/call") {
    const nm = e?.data?.name;
    if (nm === "ledger_compact") {
      console.log(`  ${hhmmss(t)}  tool/call ledger_compact  ${JSON.stringify(e?.data?.arguments ?? {}).slice(0, 120)}`);
    }
  }
}
