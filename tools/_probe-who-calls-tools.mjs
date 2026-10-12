/**
 * ★★★ 只读探针：**模型到底会不会主动调这些工具**？—— 决定"能不能交给模型"的实证。
 *
 * ★ 为什么这条是决定性的：用户想"由模型主动在它认为合适的地方调用工具压缩"。
 *   而"保证底线"恰恰取决于**模型不调的时候谁兜**。
 *   ⇒ 先量：本机历史上，模型**自发**调过 `ledger_compact` / `ledger_triage` / `ledger_checkpoint` 几次？
 *   ★ 判据（纪律 2/15）：只数 `tool/call` 事件，按工具名分组；
 *     且把"插件在提醒里要求它调的"与"它自己想到要调的"分开是做不到的（日志里看不出动机）
 *     ⇒ 所以只报**绝对次数**，并明确标注这一局限。
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

// 统计所有 tool/call 的工具名
const counts = new Map();
const firstLast = new Map();
for (const e of events) {
  if (nameOf(e) !== "tool/call") continue;
  const d = e?.data ?? {};
  // 工具名可能在 data.name / data.toolName / data.tool?.name —— 都试，取第一个非空
  const nm =
    (typeof d.name === "string" && d.name) ||
    (typeof d.toolName === "string" && d.toolName) ||
    (typeof d.tool?.name === "string" && d.tool.name) ||
    "(无名)";
  counts.set(nm, (counts.get(nm) ?? 0) + 1);
  const t = timeOf(e);
  if (t !== undefined) {
    const fl = firstLast.get(nm) ?? { first: t, last: t };
    fl.last = t;
    firstLast.set(nm, fl);
  }
}

console.log(`本会话 tool/call 事件共 ${[...counts.values()].reduce((a, b) => a + b, 0)} 次\n`);
console.log("=== 台账插件自己的工具被调用了几次（关键）===");
const OURS = ["ledger_compact", "ledger_triage", "ledger_checkpoint", "ledger_recall", "ledger_write", "ledger_log_write"];
for (const o of OURS) {
  const c = counts.get(o) ?? 0;
  const fl = firstLast.get(o);
  console.log(
    `  ${o.padEnd(20)} ${String(c).padStart(4)} 次` + (fl === undefined ? "" : `   首次 ${stamp(fl.first)} · 末次 ${stamp(fl.last)}`)
  );
}
console.log("\n=== 全部工具调用排行（前 22）===");
for (const [nm, c] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)) {
  console.log(`  ${String(c).padStart(4)}  ${nm}`);
}
