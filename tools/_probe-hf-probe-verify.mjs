/**
 * 只读探针 ⑪：把「本插件注意到水位已到」那 1 条**真发射**的原文打出来看。
 *
 * ★ 为什么必须看原文：上一步它报"真发射 1 条"，但那条是 `compact-checkpoint`
 *   —— 而 checkpoint 的正文**会带上我刚写的台账内容**，而台账里就抄过这句话。
 *   ⇒ 这正是 D96 那个坑（**位置对不上就恒真**）。
 *
 * ★ 干净的判据：真发射的那条，`${...}` 必须**已经被渲染成数字**，
 *   而不是留下模板字面量 `${Math.round(...)}`。
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
const stamp = (ms) => new Date(ms).toLocaleString("sv-SE").slice(5, 19);

const FINGER = "本插件注意到水位已到";
const TEMPLATE = "Math.round(probe.ratio";

console.log("=== 逐条看每次出现（含是否已渲染）===");
for (const e of events) {
  if (nameOf(e) !== "user/message") continue;
  const content = e?.data?.content;
  let text = "";
  if (Array.isArray(content)) for (const c of content) if (c?.type === "text") text += c.text ?? "";
  if (!text.includes(FINGER)) continue;
  const kind = e?.data?.source?.kind ?? "(用户原话)";
  const rendered = !text.includes(TEMPLATE);
  const i = text.indexOf(FINGER);
  console.log(`\n  ${stamp(timeOf(e))}  kind=${kind}  ${rendered ? "★已渲染(可能是真发射)" : "未渲染(=引述源码)"}`);
  console.log(`    上下文: …${text.slice(Math.max(0, i - 60), i + 110).replace(/\n/g, " ⏎ ")}…`);
}

// ★ 干净判据：真发射必须满足 ①kind 存在 ②已渲染 ③同一条里同时有「自己起了一次」
console.log("\n=== 干净判据（kind 存在 + 已渲染 + 含「自己起了一次」）===");
let real = 0;
for (const e of events) {
  if (nameOf(e) !== "user/message") continue;
  if (e?.data?.source?.kind === undefined) continue;
  const content = e?.data?.content;
  let text = "";
  if (Array.isArray(content)) for (const c of content) if (c?.type === "text") text += c.text ?? "";
  if (!text.includes(FINGER)) continue;
  if (text.includes(TEMPLATE)) continue; // 引述源码
  if (!text.includes("自己起了一次")) continue;
  real++;
  console.log(`  ★★ 真发射：${stamp(timeOf(e))} [${e?.data?.source?.kind}]`);
}
console.log(`\n  ⇒ 真发射 ${real} 条`);
console.log(
  real === 0
    ? "  ⇒ ★★★ 结论：那个「水位到线就自造注入」的探针，在本机**从未真正发射过**。"
    : "  ⇒ 结论：它确实发射过。"
);
