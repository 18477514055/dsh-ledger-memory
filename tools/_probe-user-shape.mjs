/**
 * 只读：**user 消息的真实结构**（source.kind 到底挂在哪一层？）
 *
 * ★ 上一版 `_probe-inject-dup.mjs` 读 `data.source.kind` ⇒ **0 条**。
 *   台账写着「区分注入与用户原话要看 data.source.kind」，但**没写它在第几层**。
 *   纪律 3：**取不到值，先怀疑取法。**
 *   纪律 2：**判据的输入必须是被测系统自己产生的那部分。**
 *
 * 本探针只 dump 结构，不做任何统计。
 *
 * 跑法：node tools/_probe-user-shape.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

const SESS_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");
function findNewest(root) {
  const cands = [];
  (function walk(d, depth) {
    if (depth > 4) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/\.jsonl\.zstd$/.test(e.name)) cands.push({ p, m: fs.statSync(p).mtimeMs });
      }
    } catch {}
  })(root, 0);
  cands.sort((a, b) => b.m - a.m);
  return cands[0]?.p;
}
const FILE = process.env.DSH_SESSION_FILE ?? findNewest(SESS_ROOT);
if (FILE === undefined) { console.log("SKIP"); process.exit(0); }

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const raw = fs.readFileSync(FILE);
const cand = [0];
for (let i = 1; ; ) {
  const p = raw.indexOf(MAGIC, i);
  if (p < 0) break;
  cand.push(p);
  i = p + 4;
}
const texts = [];
for (let k = 0; k < cand.length; k += 1) {
  let out;
  try {
    out = zlib.zstdDecompressSync(raw.subarray(cand[k], k + 1 < cand.length ? cand[k + 1] : raw.length));
  } catch { continue; }
  const s = out.toString("utf8");
  const first = s.split("\n").find((l) => l.trim() !== "");
  if (first === undefined) continue;
  try { JSON.parse(first); } catch { continue; }
  texts.push(s);
}
const events = [];
for (const s of texts) {
  for (const l of s.split("\n")) {
    if (l.trim() === "") continue;
    try { events.push(JSON.parse(l)); } catch {}
  }
}
console.log(`事件 ${events.length} 条\n`);

// ── 1. 事件类型分布 ──
const byType = new Map();
for (const e of events) byType.set(e.type ?? "?", (byType.get(e.type ?? "?") ?? 0) + 1);
console.log("═══ 事件类型 Top 20 ═══");
for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(n).padStart(6)} × ${t}`);
}
console.log("");

// ── 2. 所有出现 message.role==="user" 的路径 ──
const paths = new Map();
function walk(obj, p, depth) {
  if (depth > 7 || obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) { obj.forEach((v, i) => walk(v, `${p}[${i}]`, depth + 1)); return; }
  for (const [k, v] of Object.entries(obj)) {
    const np = p === "" ? k : `${p}.${k}`;
    if (k === "role" && v === "user") {
      const parent = np.slice(0, np.lastIndexOf("."));
      paths.set(parent, (paths.get(parent) ?? 0) + 1);
    }
    if (typeof v === "object") walk(v, np, depth + 1);
  }
}
for (const e of events) walk(e, "", 0);
console.log("═══ role===\"user\" 出现的父路径 ═══");
for (const [p, n] of [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(n).padStart(6)} × ${p}`);
}
console.log("");

// ── 3. 每种「source 类字段」出现在哪 ──
const srcPaths = new Map();
function walk2(obj, p, depth) {
  if (depth > 7 || obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) { obj.forEach((v, i) => walk2(v, `${p}[${i}]`, depth + 1)); return; }
  for (const [k, v] of Object.entries(obj)) {
    const np = p === "" ? k : `${p}.${k}`;
    if (k === "source" || k === "kind" || k === "form") {
      srcPaths.set(`${np} = ${JSON.stringify(v)?.slice(0, 60)}`, 1);
    }
    if (typeof v === "object") walk2(v, np, depth + 1);
  }
}
for (const e of events) walk2(e, "", 0);
console.log(`═══ source / kind / form 的全部出现位置（去重后 ${srcPaths.size} 种）═══`);
for (const p of [...srcPaths.keys()].slice(0, 40)) console.log(`  ${p}`);
console.log("");

// ── 4. 找一条「看起来像注入」的事件，原样 dump 结构 ──
const candidates = events.filter((e) => {
  const s = JSON.stringify(e);
  return s.includes("project-ledger-notes") || s.includes("compact-checkpoint") || s.includes("agent-instructions");
});
console.log(`═══ 含注入 kind 字面量的事件：${candidates.length} 条 ═══`);
if (candidates.length > 0) {
  const sample = candidates[0];
  console.log(`  type=${sample.type} seq=${sample.seq}`);
  const shallow = JSON.parse(JSON.stringify(sample));
  if (shallow?.data?.message?.content) {
    const c = shallow.data.message.content;
    if (Array.isArray(c)) {
      shallow.data.message.content = c.map((x) => (x?.type === "text" ? { type: "text", text: (x.text ?? "").slice(0, 120) + "…" } : x));
    } else if (typeof c === "string") {
      shallow.data.message.content = c.slice(0, 120) + "…";
    }
  }
  console.log(JSON.stringify(shallow, null, 2).slice(0, 2000));
}
