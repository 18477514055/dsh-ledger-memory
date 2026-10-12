/**
 * ★★★ 取证：**10:08–10:14 那一分钟到底发生了什么** —— 为什么跑的是增量而不是全量？
 *
 * ★ 用户的问题（逐字）：*"为什么是增量压缩？这个点不是全量吗"*
 *   ★ 他看到的是：插件先宣告「水位已到 75%（≥ 全量线 75%）…自己起了一次」
 *     然后宣告「即将执行一次高保真压缩（水位 75% ≥ 75%）」——
 *     **但最后真跑的是「增量压缩」（75.1% → 69.4%）**。
 *   ⇒ 这正是"**宣告了全量、却跑了增量**"。
 *
 * ★ 要查的（按时间顺序，一条不漏）：
 *   ① 全量宣言（注入里含「即将执行一次高保真压缩」）
 *   ② `compaction/start` / `summary` / `end`（**内核事件，谁跑的一目了然**）
 *   ③ 增量与全量各自的**胶囊来源**（`自动（增量）` / `自动（70% 水位）`）
 *   ④ 期间的 `agent/status`（idle 有没有来 —— 全量要等 idle）
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
const stamp = (ms) => new Date(ms).toLocaleString("sv-SE").slice(5, 19);

// 窗口：10:08:00 – 10:14:00
const LO = new Date(2026, 9, 12, 10, 8, 0).getTime();
const HI = new Date(2026, 9, 12, 10, 14, 0).getTime();

// 胶囊来源（认"这一跑是哪条路"）
const CAPS = path.join(
  "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账",
  "_ledger-log", "2026-10", "week2", "capsules"
);
const caps = fs.readdirSync(CAPS).filter((f) => f.endsWith(".md")).map((f) => {
  const s = fs.readFileSync(path.join(CAPS, f), "utf8");
  const m = s.match(/来源\*\*[:：]\s*([^\n]+)/);
  const t = f.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
  const when = t === null ? undefined : new Date(+t[1], +t[2] - 1, +t[3], +t[4], +t[5], +t[6]).getTime();
  return { f, src: m === null ? "?" : m[1].trim(), when };
});
const srcOf = (t) => {
  const near = caps
    .filter((x) => x.when !== undefined && Math.abs(x.when - t) <= 8000)
    .sort((a, b) => Math.abs(a.when - t) - Math.abs(b.when - t))[0];
  return near === undefined ? "?" : near.src;
};

console.log(`=== 10:08:00 – 10:14:00 全事件（按时间）===\n`);
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < LO || t > HI) continue;
  const n = nameOf(e);
  const d = e?.data ?? {};

  if (n === "compaction/start") {
    console.log(`${stamp(t)}  ▶ compaction/start     turn=${d.turn ?? "-"}  来源=${srcOf(t)}`);
    continue;
  }
  if (n === "compaction/summary") {
    const seqs = d.shadowedSeqs;
    const rng = Array.isArray(seqs) && seqs.length > 0 ? `${Math.min(...seqs)}..${Math.max(...seqs)}` : "-";
    console.log(`${stamp(t)}  ■ compaction/summary   被压 ${d.shadowedTokenCount ?? "?"} tok  seq ${rng}`);
    continue;
  }
  if (n === "compaction/end") {
    console.log(`${stamp(t)}  ⏹ compaction/end`);
    continue;
  }
  if (n === "agent/status") {
    console.log(`${stamp(t)}  ○ agent/status = ${d.status ?? "?"}`);
    continue;
  }
  if (n === "assistant/message") {
    const tot = d?.usage?.totalTokens;
    console.log(`${stamp(t)}    assistant  total=${tot ?? "?"}  turn=${d.turn ?? "-"}/${d.step ?? "-"}`);
    continue;
  }
  if (n === "user/message") {
    let txt = "";
    const c = d?.content;
    if (Array.isArray(c)) for (const x of c) if (x?.type === "text") txt += x.text ?? "";
    const kind = d?.source?.kind ?? "（用户真原话）";
    // 只打印含关键措辞的，或用户原话开头
    const marks = [];
    if (/即将执行一次高保真压缩/.test(txt)) marks.push("★全量宣言");
    if (/本插件注意到水位已到/.test(txt)) marks.push("★水位探针");
    if (/刚做了一次增量压缩/.test(txt)) marks.push("★增量回执");
    if (/上下文水位已到/.test(txt)) marks.push("水位提醒");
    if (/已经到了全量线|让路/.test(txt)) marks.push("让路");
    if (marks.length > 0 || kind === "（用户真原话）") {
      console.log(
        `${stamp(t)}  ✉ 注入[${kind}]  ${marks.join(" ")}  长=${txt.length}` +
          (kind === "（用户真原话）" ? `  内容=${JSON.stringify(txt.slice(0, 70))}` : "")
      );
    }
    continue;
  }
}
