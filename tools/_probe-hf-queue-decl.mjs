/**
 * 只读探针 ⑥：找**全量排队**那一刻，以及它与增量、与 idle 的先后关系。
 *
 * ★ 排队那一刻，插件会在注入末尾追加一句（见 lib/index.js:11471）：
 *     **本插件即将执行一次高保真压缩**（水位 X% ≥ 70%）
 *   ⇒ 这就是"排队宣言"。**它是我自己写的代码产生的文本**（不是台账正文里的引用）。
 *
 * ★ 判据（纪律 2：只吃"被测对象自己产生的那部分"）：
 *   必须**锚定在注入消息的开头构造**上，不能全库 `includes` ——
 *   因为台账正文里也被我抄过这句话，那会造成恒真（已栽过，见 D96）。
 *   ⇒ 判据：`source.kind === "project-ledger-notes"` 且文本**不以回执/台账正文为主**，
 *     且句中出现「即将执行一次高保真压缩（水位」这一**精确形状**。
 *
 * ★ 同时打出：每次 compaction/start 的胶囊来源（读 capsules/ 目录里同名的 md 头）。
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
console.log(`会话：${target.p}\n`);
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
const day = (ms) => new Date(ms).toLocaleDateString("sv-SE");
const stamp = (ms) => `${day(ms)} ${hhmmss(ms)}`;

// ── ① 全量排队宣言（精确形状 + 只在注入消息里找）────────────────────────
const DECL = /即将执行一次高保真压缩/;
console.log("=== ① 全量排队宣言（注入里出现「即将执行一次高保真压缩」）===");
let n1 = 0;
for (const e of events) {
  if (nameOf(e) !== "user/message") continue;
  // ★ 尺子修正：`user/message` 的字段在 **data 层**（data.content / data.source / data.role / data.id），
  //   不在 `data.message` 里 —— 写错这一处会让 kind 恒为 undefined ⇒ 整段被跳过（假 0 命中）。
  const kind = e?.data?.source?.kind;
  if (kind === undefined) continue; // 只看注入
  let s = "";
  const content = e?.data?.content;
  if (Array.isArray(content)) for (const c of content) if (c?.type === "text") s += c.text ?? "";
  else if (typeof content === "string") s = content;
  if (!DECL.test(s)) continue;
  n1++;
  const mm = s.match(/即将执行一次高保真压缩[^\n]{0,60}/);
  console.log(`  ${stamp(timeOf(e))}  [${kind}]  ${(mm === null ? s.slice(0, 80) : mm[0]).replace(/\n/g, " ")}`);
}
console.log(`  共 ${n1} 条`);

// ── ② 压缩事件（含"压前水位"= 上一条 assistant/message 的 totalTokens）──
console.log("\n=== ② 每次压缩的开头/结尾 + 压前水位 ===");
let lastTot;
for (const e of events) {
  const n = nameOf(e);
  if (n === "assistant/message") {
    const tot = e?.data?.usage?.totalTokens;
    if (tot !== undefined) lastTot = tot;
    continue;
  }
  if (n === "compaction/start") {
    const pct = lastTot === undefined ? "?" : ((lastTot / 1_000_000) * 100).toFixed(1);
    console.log(`  ${stamp(timeOf(e))}  ▶ start  压前≈${pct}%  turn=${e?.data?.turn ?? "-"}`);
    continue;
  }
  if (n === "compaction/end") {
    console.log(`  ${stamp(timeOf(e))}  ■ end          turn=${e?.data?.turn ?? "-"}`);
    continue;
  }
  if (n === "turn/end") {
    console.log(`  ${stamp(timeOf(e))}  ⏸ turn/end（idle 时机）turn=${e?.data?.turn ?? "-"}`);
  }
}

// ── ③ 胶囊来源（磁盘上那份，只有来源 + 时间）────────────────────────────
console.log("\n=== ③ 胶囊来源（_ledger-log/.../capsules/）===");
const capsDir = path.join(
  "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账",
  "_ledger-log", "2026-10", "week2", "capsules"
);
try {
  const files = fs.readdirSync(capsDir).sort();
  for (const f of files.slice(-14)) {
    const s = fs.readFileSync(path.join(capsDir, f), "utf8");
    const m = s.match(/来源\*\*：([^\n]+)/);
    console.log(`  ${f}   →  ${m === null ? "?" : m[1].trim()}`);
  }
} catch (err) {
  console.log(`  读不到 capsules：${String(err.message ?? err)}`);
}
