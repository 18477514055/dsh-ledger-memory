/**
 * ★★★ 只读探针：那个 `compress` 工具是谁？什么时候被调的？
 *
 * ★ 为什么必须查清：统计里 `compress` 被调 **24 次**，而它**不是**本插件的工具。
 *   若它还在（= billion-context 的遗迹或别的插件），那它就是"模型主动压缩"的**真实先例**，
 *   直接决定用户这个需求"有没有实证基础"。
 *   ★ 同时要查：本插件的 `ledger_compact` 只被调 **2 次**、`ledger_checkpoint` **0 次** ——
 *     与 `compress` 的 24 次形成鲜明对比 ⇒ 这个反差本身就是结论。
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

console.log("=== 所有 `compress` 工具调用（时间 + 参数摘要）===");
let n = 0;
for (const e of events) {
  if (nameOf(e) !== "tool/call") continue;
  const d = e?.data ?? {};
  const nm =
    (typeof d.name === "string" && d.name) ||
    (typeof d.toolName === "string" && d.toolName) ||
    (typeof d.tool?.name === "string" && d.tool.name) ||
    "(无名)";
  if (nm !== "compress") continue;
  n++;
  const t = timeOf(e);
  const args = d.arguments ?? d.args ?? d.input ?? d.parameters;
  const as = typeof args === "string" ? args : JSON.stringify(args ?? {});
  console.log(`  ${String(n).padStart(2)}. ${stamp(t)}  ${as.slice(0, 150)}`);
}

console.log(`\n=== 对照：本插件压缩类工具的全部调用 ===`);
for (const e of events) {
  if (nameOf(e) !== "tool/call") continue;
  const d = e?.data ?? {};
  const nm =
    (typeof d.name === "string" && d.name) ||
    (typeof d.toolName === "string" && d.toolName) ||
    (typeof d.tool?.name === "string" && d.tool.name) ||
    "";
  if (nm !== "ledger_compact" && nm !== "ledger_triage") continue;
  const t = timeOf(e);
  const args = d.arguments ?? d.args ?? d.input ?? d.parameters;
  const as = typeof args === "string" ? args : JSON.stringify(args ?? {});
  console.log(`  ${nm.padEnd(16)} ${stamp(t)}  ${as.slice(0, 110)}`);
}
