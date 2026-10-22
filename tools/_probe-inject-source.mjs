/**
 * 只读：把官方会话日志里**我们自己的注入消息**的 `source` 原样挖出来。
 *
 * 目的（B 方案取证）：确认活内核**实际落盘**的 source 形状，
 * 而不是看我们源码里写了什么（"写了" ≠ "落盘了"）。
 *
 * 判据（台账 D84 同族）：区分注入与用户原话要看 `data.source.kind`，别靠关键词。
 * 这里把**全部出现过的 source.kind** 数一遍，并单独把我们的那一种原样打印。
 *
 * 跑法：node tools/_probe-inject-source.mjs [会话文件]
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

const SESS_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");
const FILE = process.env.DSH_SESSION_FILE ?? findNewest(SESS_ROOT) ?? process.argv[2];
if (FILE === undefined) {
  console.log("  SKIP  没有会话文件（用 DSH_SESSION_FILE 指定）");
  process.exit(0);
}

function findNewest(root) {
  const cands = [];
  (function walk(d, depth) {
    if (depth > 4) return;
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.jsonl\.zstd$/.test(e.name)) cands.push({ p, m: fs.statSync(p).mtimeMs });
    }
  })(root, 0);
  cands.sort((a, b) => b.m - a.m);
  return cands[0]?.p;
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const raw = fs.readFileSync(FILE);
console.log(`会话文件 ${(raw.length / 1024 / 1024).toFixed(1)} MB`);

// 按帧切（魔数只是候选；能解成合法 JSON 才算真帧）
const cand = [0];
for (let i = 1; ; ) {
  const p = raw.indexOf(MAGIC, i);
  if (p < 0) break;
  cand.push(p);
  i = p + 4;
}
const texts = [];
for (let k = 0; k < cand.length; k += 1) {
  const slice = raw.subarray(cand[k], k + 1 < cand.length ? cand[k + 1] : raw.length);
  let out;
  try {
    out = zlib.zstdDecompressSync(slice);
  } catch {
    continue;
  }
  const s = out.toString("utf8");
  const first = s.split("\n").find((l) => l.trim() !== "");
  if (first === undefined) continue;
  try {
    JSON.parse(first);
  } catch {
    continue;
  }
  texts.push(s);
}
const lines = texts.join("").split("\n").filter((l) => l.trim() !== "");
console.log(`JSONL 行数 ${lines.length}\n`);

// ── 统计所有 source.kind ──
const kindCount = new Map();
const samples = new Map(); // kind → 原样 source 对象（第一条 + 最后一条）
let userMsgs = 0;
for (const l of lines) {
  let o;
  try {
    o = JSON.parse(l);
  } catch {
    continue;
  }
  const t = o?.type ?? o?.event?.type;
  if (t !== "user/message") continue;
  userMsgs += 1;
  const d = o?.data ?? o?.event?.data;
  const src = d?.source;
  const kind = src?.kind ?? "(无 source)";
  kindCount.set(kind, (kindCount.get(kind) ?? 0) + 1);
  if (!samples.has(kind)) samples.set(kind, { first: src, seq: o?.seq ?? o?.event?.seq });
  samples.get(kind).last = src;
}

console.log(`user/message 事件 ${userMsgs} 条，source.kind 分布：\n`);
const sorted = [...kindCount.entries()].sort((a, b) => b[1] - a[1]);
for (const [k, n] of sorted) console.log(`  ${String(n).padStart(6)}  ${k}`);

// ── 把「我们的」那一种原样打印 ──
const OURS = "project-ledger-notes";
if (samples.has(OURS)) {
  console.log(`\n═══ 我们（${OURS}）的 source 原样 ═══`);
  console.log(`首条（seq=${samples.get(OURS).seq}）：`);
  console.log(JSON.stringify(samples.get(OURS).first, null, 2));
  console.log(`\n末条：`);
  console.log(JSON.stringify(samples.get(OURS).last, null, 2));
} else {
  console.log(`\n⚠ 日志里**没有** ${OURS} —— 说明活内核跑的版本还没带这个 kind，或本会话没注入过。`);
}

// ── 顺带看官方自己怎么写的（对照） ──
console.log(`\n═══ 官方几种 kind 的 source 原样（对照） ═══`);
for (const k of ["agent-instructions", "runtime-context", "compact-checkpoint", "skill-invocation", "time-context"]) {
  const s = samples.get(k);
  if (s === undefined) continue;
  console.log(`\n${k}：`);
  console.log(JSON.stringify(s.first, null, 2));
}
