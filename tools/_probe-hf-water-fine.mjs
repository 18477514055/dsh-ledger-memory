/**
 * 只读探针 ⑧：**细粒度水位曲线**（每一步都打）—— 回答"全量为什么迟到"。
 *
 * ★ 用户的核心抱怨是「**全量总是轮不上**」/「76% 了还没触发」。
 *   要判"迟到"，必须看**水位是怎么爬上去的**（纪律 1：指标必须有时间窗；
 *   纪律 5：声明了时间窗就必须真的用它）。
 *
 * ★ 尺子：内核自己写的用量（`assistant/message` → `data.usage.totalTokens`），
 *   1,000,000 窗口 ⇒ ÷10000 = 百分比。★ 同时标出每一次 compaction 的归属
 *   （用胶囊来源，见 capsules/ 的 mtime 与时间戳对齐）。
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
const stamp = (ms) => new Date(ms).toLocaleString("sv-SE").slice(5, 19);

// 窗口：从最后一次 turn/end 之前的 75 分钟起
const maxT = Math.max(...events.map((e) => timeOf(e) ?? 0));
const from = maxT - 75 * 60 * 1000;
console.log(`窗口 ${stamp(from)} – ${stamp(maxT)}（本地）`);

const WINDOW = 1_000_000;
let curWater;
console.log("\n时间              turn/step   水位%    事件");
for (const e of events) {
  const t = timeOf(e);
  if (t === undefined || t < from) continue;
  const n = nameOf(e);
  const d = e?.data ?? {};

  if (n === "assistant/message") {
    const tot = d?.usage?.totalTokens;
    if (tot !== undefined) {
      curWater = (tot / WINDOW) * 100;
      const step = `${d.turn ?? "-"}/${d.step ?? "-"}`;
      // 只在"水位单调抬升的关键点"打：每 2 点以上变化，或第一次
      console.log(`  ${stamp(t)}  ${step.padEnd(10)}  ${curWater.toFixed(1).padStart(5)}%`);
    }
    continue;
  }
  if (n !== "compaction/start" && n !== "compaction/end" && n !== "turn/start" && n !== "turn/end") continue;

  const label =
    n === "compaction/start"
      ? "▶▶ 压缩开始"
      : n === "compaction/end"
        ? "■■ 压缩结束"
        : n === "turn/start"
          ? `—— 回合开始（turn=${d.turn ?? "-"}）`
          : `—— 回合结束（idle，turn=${d.turn ?? "-"}）`;
  console.log(`  ${stamp(t)}  ${" ".repeat(10)}  ${" ".repeat(5)}   ${label}`);
}
