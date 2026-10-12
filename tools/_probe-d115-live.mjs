/**
 * ★★★ 真机取证：**重启（09:55）之后**，注入里都出现了什么？
 *
 * ★ 要回答的两件事：
 *   ① D115 的**轻推**（「建议你按需压一次」）到底发出来没有；
 *   ② 期间有没有发生压缩（`compaction/start`）—— 若没有，说明水位是"涨上来但没压"。
 *
 * ★ 只取**重启之后**的事件（09:55:14 之后）—— 早于它的都是旧代码，混进来会把结论污染成"没生效"。
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
      /* 尾帧不完整 */
    }
  }
  return out;
}
const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");
let best;
const walk = (d, depth) => {
  if (depth > 3) return;
  let es;
  try {
    es = fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of es) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === "session.v4.jsonl.zstd") {
      const m = fs.statSync(p).mtimeMs;
      if (best === undefined || m > best.m) best = { p, m };
    }
  }
};
walk(SESSIONS, 0);
const events = [];
for (const l of decodeFrames(fs.readFileSync(best.p)).split("\n")) {
  if (l.trim() === "") continue;
  try {
    events.push(JSON.parse(l));
  } catch {
    /* 跳过 */
  }
}
const nameOf = (e) => String(e?.name ?? e?.event ?? e?.type ?? "(无)");
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
const stamp = (ms) => new Date(ms).toLocaleString("sv-SE").slice(5);

// 重启时刻：09:55:14 本地
const RESTART = new Date(2026, 9, 12, 9, 55, 14).getTime();
console.log(`会话日志：${best.p}`);
console.log(`只看 ${stamp(RESTART)} 之后的事件\n`);

let nInject = 0;
let nNudge = 0;
let nCompact = 0;
let nLedgerInject = 0;
const compacts = [];
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < RESTART) continue;
  const n = nameOf(e);
  if (n === "compaction/start") {
    nCompact++;
    compacts.push(t);
  }
  if (n !== "user/message") continue;
  if (e?.data?.source?.kind === undefined) continue;
  let txt = "";
  const c = e?.data?.content;
  if (Array.isArray(c)) for (const x of c) if (x?.type === "text") txt += x.text ?? "";
  nInject++;
  if (txt.includes("建议你按需压一次")) nNudge++;
  if (txt.includes("project-ledger facts") || txt.includes("本轮台账")) nLedgerInject++;
}
console.log(`注入总数        : ${nInject}`);
console.log(`  ├ 含台账类      : ${nLedgerInject}`);
console.log(`  └ ★ 含轻推      : ${nNudge}  ${nNudge > 0 ? "✅ 轻推已发出" : "★ 轻推一次都没发"}`);
console.log(`压缩次数        : ${nCompact}  ${nCompact === 0 ? "（重启后未发生压缩）" : ""}`);
for (const x of compacts) console.log(`  · ${stamp(x)}`);
