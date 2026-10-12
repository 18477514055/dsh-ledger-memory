/**
 * 只读探针 ⑨：窗口内**每一步有没有注入**，以及水位。
 *
 * ★ 要回答（用户 2026-10-12 的核心问题）：
 *   水位第一次 ≥75% 是 01:06:42，可"排队宣言"直到 01:11:05 才出现 —— **迟了 4 分 23 秒**。
 *   为什么？待验假设：**排队那段被 `text !== undefined` 挡住**（=本步恰好有注入才排队）。
 *   ⇒ 判据：把「水位 ≥ 75%」的每一步与「那一步有没有注入」并排看。
 *
 * ★ 尺子（纪律 2）：注入的判定只看 `data.source.kind` 是否存在（台账正文里被我抄过那句话，
 *   靠关键词判会恒真 —— 见 D96）。水位取内核自己的 `assistant/message.usage.totalTokens`。
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
const hhmmss = (ms) => new Date(ms).toTimeString().slice(0, 8);
const WINDOW = 1_000_000;

// 窗口：锚定在 turn 111 的回合开始，往前 2 分钟、往后到 turn 112 开始。
// ★ 上一版的错：用 `秒<30` 找 01:03 那一刻，而 turn/start 落在 01:03:58 ⇒ 一条都没匹配到，
//   于是静默退化成"最后 12 分钟"（纪律 3：取不到值先怀疑取法，别让它悄悄退化）。
const maxT = Math.max(...events.map((e) => timeOf(e) ?? 0));
let t111;
for (const e of events) {
  if (nameOf(e) === "turn/start" && e?.data?.turn === 111) t111 = timeOf(e);
}
if (t111 === undefined) {
  console.log("FAILED: 找不到 turn=111 的 turn/start —— 不猜窗口（宁可报失败）");
  process.exit(1);
}
const from = t111 - 2 * 60 * 1000;
const to = t111 + 12 * 60 * 1000;
console.log(`窗口 ${hhmmss(from)} – ${hhmmss(to)}（锚定 turn 111 开始于 ${hhmmss(t111)}）\n`);

let curWater;
const rows = [];
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < from || t > to) continue;
  const n = nameOf(e);
  const d = e?.data ?? {};

  if (n === "assistant/message") {
    const tot = d?.usage?.totalTokens;
    if (tot !== undefined) curWater = (tot / WINDOW) * 100;
    continue;
  }
  if (n === "user/message") {
    const kind = d?.source?.kind;
    let s = "";
    const content = d?.content;
    if (Array.isArray(content)) for (const c of content) if (c?.type === "text") s += c.text ?? "";
    else if (typeof content === "string") s = content;
    const isInject = kind !== undefined;
    // 该步的注入：把它归到"紧接着的那个 step"上（注入是 pre-step 生成、随本步请求发出）
    rows.push({
      t,
      kind: isInject ? `注入[${kind}]` : "用户原话",
      water: curWater,
      note: s.slice(0, 70).replace(/\n/g, " "),
    });
    continue;
  }
  if (n === "compaction/start") {
    rows.push({ t, kind: "★★ 压缩开始", water: curWater, note: `turn=${d.turn ?? "-"}` });
    continue;
  }
  if (n === "compaction/end") {
    rows.push({ t, kind: "■■ 压缩结束", water: curWater, note: "" });
    continue;
  }
  if (n === "turn/end" || n === "turn/start") {
    rows.push({ t, kind: n === "turn/end" ? "⏸ idle" : "▶ 回合开始", water: curWater, note: `turn=${d.turn ?? "-"}` });
  }
}

console.log("时间       水位%   事件                                   说明");
for (const r of rows) {
  const w = r.water === undefined ? "  ? " : r.water.toFixed(1).padStart(5);
  console.log(`  ${hhmmss(r.t)}  ${w}%   ${r.kind.padEnd(28)} ${r.note}`);
}

// 统计：本回合里"水位≥75%但没有任何注入"的步数
console.log("\n=== 关键统计：本回合（turn 111）里，水位 ≥75% 的时刻 ===");
let above = 0;
let aboveNoInject = 0;
for (const r of rows) {
  if (r.water === undefined || r.water < 75) continue;
  if (!String(r.kind).startsWith("注入")) continue;
  above++;
  if (r.kind === "用户原话") aboveNoInject++;
}
console.log(`  带水位读数的注入/原话事件中水位≥75% 的：${above} 条（其中"用户原话" ${aboveNoInject} 条）`);
