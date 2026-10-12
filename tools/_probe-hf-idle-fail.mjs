/**
 * 只读探针：查「全量压缩在 idle 那一步到底发生了什么」。
 *
 * ★ 要回答的问题（用户 2026-10-12 01:15 报的新证据）：
 *   用户手动点压缩后，收到的第一句是
 *     `manual compaction requires an idle agent with no waking queued work`
 *   紧接着第二句是「上下文已压缩」。
 *   ⇒ ① 内核那句 busy 到底是谁触发的？② 同一步里"压缩成功"的是**另一条路**吗？
 *
 * ★ 判据必须来自被测系统自己产生的那部分（纪律 2）：
 *   · 内核压没压 ⇒ 会话事件流里的 `compaction/*`
 *   · 插件排队了没 ⇒ 事件流里的注入文本（`source.kind` 为插件注入）
 *   · idle 那一刻发生什么 ⇒ `agent/status` = idle 的时间点
 * ★ 不猜：全部逐条打印时间 + 事件名 + 关键字段。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");

/** 多帧 zstd：按魔数切帧后逐帧解（只解第一帧会丢掉 99% 的内容）。 */
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

/** 找最近被改动的会话日志。 */
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
if (target === undefined) {
  console.log("FAILED: 找不到任何 session.v4.jsonl.zstd");
  process.exit(1);
}
console.log(`会话日志：${target.p}`);
console.log(`最后改动：${new Date(target.m).toISOString()}`);
console.log("");

const text = decodeFrames(fs.readFileSync(target.p));
const lines = text.split("\n").filter((l) => l.trim() !== "");
console.log(`解出 ${(text.length / 1024).toFixed(1)} KB / ${lines.length} 条事件`);
console.log("");

const ts = (e) => {
  const t = e.time ?? e.timestamp ?? e.at;
  if (typeof t === "number") return new Date(t);
  if (typeof t === "string") return new Date(t);
  return undefined;
};
const fmt = (d) => (d === undefined ? "???" : d.toISOString().slice(11, 23));

let comp = 0;
let hfInject = 0;
let idles = 0;
console.log("=== 压缩相关事件（compaction/*）===");
for (const l of lines) {
  let e;
  try {
    e = JSON.parse(l);
  } catch {
    continue;
  }
  const name = e?.name ?? e?.event ?? e?.type;
  if (typeof name === "string" && /compaction/i.test(name)) {
    comp++;
    const src = e?.data?.source ?? e?.data?.sourceCommandId ?? e?.data?.owner;
    console.log(
      `  ${fmt(ts(e))}  ${name}  source=${JSON.stringify(src)}  ` +
        `start=${e?.data?.start ?? e?.data?.from ?? "-"}  end=${e?.data?.end ?? e?.data?.to ?? "-"}`
    );
  }
}
console.log(`  共 ${comp} 条`);
console.log("");

console.log("=== agent/status = idle（等 idle 压缩的时机就是这些）===");
for (const l of lines) {
  let e;
  try {
    e = JSON.parse(l);
  } catch {
    continue;
  }
  const name = e?.name ?? e?.event ?? e?.type;
  const st = e?.data?.status ?? e?.status;
  if (name === "agent/status" && st === "idle") {
    idles++;
    if (idles > 40) continue;
    console.log(`  ${fmt(ts(e))}  idle`);
  }
}
console.log(`  共 ${idles} 条`);
console.log("");

console.log("=== 插件关于「高保真压缩」的注入（排队宣告）===");
for (const l of lines) {
  let e;
  try {
    e = JSON.parse(l);
  } catch {
    continue;
  }
  const kind = e?.data?.source?.kind ?? e?.source?.kind;
  const content = e?.data?.content ?? e?.content;
  let s = "";
  if (Array.isArray(content)) for (const c of content) if (c?.type === "text") s += c.text ?? "";
  else if (typeof content === "string") s = content;
  if (!/高保真压缩/.test(s)) continue;
  if (/项目台账|台账正文|变更登记/.test(s) && s.length > 4000) continue; // 排除台账全文
  hfInject++;
  const m = s.match(/高保真压缩[^）]*（水位[^）]*）/);
  console.log(`  ${fmt(ts(e))}  kind=${kind ?? "(无)"}  ${m === null ? s.slice(0, 90).replace(/\n/g, " ") : m[0]}`);
}
console.log(`  共 ${hfInject} 条（已排除夹带台账全文的那些）`);
