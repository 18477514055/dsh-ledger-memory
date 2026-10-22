/**
 * 只读：三个问题一次问清（B 方案取证第二轮）。
 *
 * ① `form:"snapshot"` 的官方消息，**是不是也带 content**（即 sections 是不是重复内容）？
 *    ⇒ 若重复，我们就不能照抄 snapshot，否则会话日志跟着翻倍。
 * ② 本机已经装着的**第三方记忆插件** `hindsight` 是怎么标 source 的？（76 条注入）
 * ③ 我们的 `{kind, form:"instructions"}` 在 UI 侧到底渲染成什么（读源码判定，不靠猜）。
 *
 * 跑法：node tools/_probe-inject-source2.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

const SESS_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");
const FILE = process.env.DSH_SESSION_FILE ?? findNewest(SESS_ROOT);
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
if (FILE === undefined) {
  console.log("SKIP 没有会话文件");
  process.exit(0);
}

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

/** 取一条 user/message 的 { source, contentChars, textChars } */
const rows = [];
for (const l of lines) {
  let o;
  try {
    o = JSON.parse(l);
  } catch {
    continue;
  }
  const t = o?.type ?? o?.event?.type;
  if (t !== "user/message") continue;
  const d = o?.data ?? o?.event?.data;
  const src = d?.source ?? {};
  const content = Array.isArray(d?.content) ? d.content : [];
  const textChars = content.reduce((s, c) => s + (typeof c?.text === "string" ? c.text.length : 0), 0);
  const sectChars = Array.isArray(src?.sections)
    ? src.sections.reduce((s, x) => s + (typeof x?.text === "string" ? x.text.length : 0), 0)
    : 0;
  rows.push({ seq: o?.seq ?? o?.event?.seq, kind: src?.kind, form: src?.form, hasSections: Array.isArray(src?.sections), textChars, sectChars, src });
}

// ── ① snapshot form 到底重复不重复 ──
console.log("═══ ① 带 sections 的消息：content 与 sections 是否重复 ═══");
const withSect = rows.filter((r) => r.hasSections);
console.log(`带 sections 的 user/message ${withSect.length} 条`);
if (withSect.length > 0) {
  const s = withSect.slice(0, 5);
  for (const r of s) {
    console.log(`  seq=${r.seq} kind=${r.kind} form=${r.form}  content=${r.textChars} 字  sections=${r.sectChars} 字  ⇒ ${r.textChars === 0 ? "**不重复**（正文只在 sections）" : "**重复**（两边都有）"}`);
  }
  const same = withSect.filter((r) => r.textChars > 0).length;
  console.log(`  ⇒ ${withSect.length} 条里 ${same} 条 content 非空`);
}

// ── ② hindsight 怎么标 ──
console.log("\n═══ ② 第三方记忆插件 hindsight 的 source 原样 ═══");
const hs = rows.filter((r) => r.kind === "hindsight");
console.log(`hindsight 注入 ${hs.length} 条`);
if (hs.length > 0) {
  console.log("首条 source：");
  console.log(JSON.stringify(hs[0].src, null, 2).slice(0, 1200));
  console.log(`\n正文长度分布：${hs.slice(0, 8).map((r) => r.textChars).join(" / ")} 字`);
}

// ── ③ 我们 vs 官方的 form 分布 ──
console.log("\n═══ ③ 各 kind 的 form 取值 ═══");
const agg = new Map();
for (const r of rows) {
  const key = `${r.kind ?? "(无)"} → form=${r.form ?? "(无)"}`;
  agg.set(key, (agg.get(key) ?? 0) + 1);
}
for (const [k, n] of [...agg.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${k}`);
}
