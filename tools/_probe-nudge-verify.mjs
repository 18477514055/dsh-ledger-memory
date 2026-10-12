/**
 * ★★★ 复核：那条"轻推"命中，是**真轻推**，还是**我自己台账正文被注入**导致的假阳性？
 *
 * ★ 为什么必须查（纪律：**必须验证命中不是我自己的文字被引述回来** —— 本项目栽过 4 次）：
 *   `建议你按需压一次` 这串字，我写在了**三个地方**：
 *     ① `lib/index.js` 的轻推代码里（真源）
 *     ② `DECISIONS.md` 的 D115/D116 条目里
 *     ③ `LEDGER.md` 里（很可能）
 *   ★ 而 ②③ 都属于「项目文档」，而**台账正文会被注入进上下文**！
 *   ⇒ 只要台账里含这串字，**任何一次台账注入都会命中** ⇒ 假阳性。
 *
 * ★ 判据（怎么区分）：
 *   · **真轻推**：带那段**独有结构** —— `轻推线 NN 点`（代码里拼的动态数）
 *     + `若你一直不压，涨到 NN 点时插件会兜底`。
 *   · **台账引述**：带 `<<<LEDGER` / `项目台账事实 belong to` / `现行 · 1.1.1` 之类
 *     文档结构，且**没有**"轻推线 NN 点"那两句。
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

const RESTART = new Date(2026, 9, 12, 9, 55, 14).getTime();
const PHRASE = "建议你按需压一次";
// ★ 真轻推的**独有结构**（代码里拼出来的，台账引述不会有）
const NUDGE_STRUCT = /轻推线\s*\d+\s*点/;
const NUDGE_FALLBACK = /涨到\s*\d+\s*点时插件会兜底/;

console.log("=== 逐条检查含该短语的注入（重启后）===\n");
let genuine = 0;
let quoted = 0;
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < RESTART) continue;
  if (nameOf(e) !== "user/message") continue;
  if (e?.data?.source?.kind === undefined) continue;
  let txt = "";
  const c = e?.data?.content;
  if (Array.isArray(c)) for (const x of c) if (x?.type === "text") txt += x.text ?? "";
  if (!txt.includes(PHRASE)) continue;
  const isGenuine = NUDGE_STRUCT.test(txt) && NUDGE_FALLBACK.test(txt);
  const isLedger = /<<<LEDGER|belong to THIS conversation|变更登记（插件自动维护）/.test(txt);
  console.log(`● ${stamp(t)} · kind=${e?.data?.source?.kind} · 长度=${txt.length}`);
  console.log(`   有「轻推线 N 点」+「兜底」结构 = ${isGenuine ? "★ 是（真轻推）" : "否"}`);
  console.log(`   像台账/文档注入          = ${isLedger ? "★ 是（引述）" : "否"}`);
  if (isGenuine && !isLedger) {
    genuine++;
    // 打印轻推那一段（前后各取一点）
    const i = txt.indexOf(PHRASE);
    console.log(`   —— 原文：${JSON.stringify(txt.slice(Math.max(0, i - 80), i + 320))}`);
  } else {
    quoted++;
    const i = txt.indexOf(PHRASE);
    console.log(`   —— 命中处上下文：${JSON.stringify(txt.slice(Math.max(0, i - 100), i + 120))}`);
  }
  console.log("");
}
console.log("═".repeat(70));
console.log(`★ 真轻推 ${genuine} 条 · 引述（假阳性）${quoted} 条`);
console.log(
  genuine > 0
    ? "⇒ ★ 轻推**真的发射过**（有独有结构为证）"
    : "⇒ ★★ 之前那个『轻推 1 次』是**假阳性**（那是我自己的台账被注入回来）—— ★ 轻推其实没发"
);
