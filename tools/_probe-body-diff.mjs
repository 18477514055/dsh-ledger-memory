/**
 * 只读：**剥掉注入题头后，真正的台账正文改在哪里？**
 *
 * ★ 为什么必须做这一步（纪律 7：结论与自己已验证的事实冲突时，先怀疑尺子）：
 *   上一版 `_probe-inject-classify.mjs` 报「73% 的改动落在正文前 20%」。
 *   但我**同时**在日志里看到题头换过好几代：
 *     `The following project-ledger facts belong to ...`
 *     → `当前项目台账（\`LEDGER.md\`）`
 *     → `## 当前项目台账（\`LEDGER.md\`）—— 区块级注入`
 *   **题头就在开头**。若它变了，"首差异在开头"就大量是**外壳变化**，不是台账内容变化。
 *   ⇒ 这会直接决定方案对不对：若差异在题头，那跟"台账改动位置"毫无关系。
 *
 * ★ 做法：只取 `<<<LEDGER-BLOCKS` / `<<<LEDGER` **之后**的部分当正文；
 *   两边都裁到正文再比。裁不出来（找不到标记）的条目**单独报出来**，不许悄悄算进统计。
 *
 * 跑法：node tools/_probe-body-diff.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";

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
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c === "string" ? c : c?.type === "text" ? (c.text ?? "") : "")).join("");
}

// ── 取台账注入 ──
const all = [];
for (const e of events) {
  if (e.type !== "user/message") continue;
  if (e?.data?.source?.kind !== "project-ledger-notes") continue;
  all.push({ seq: e.seq, text: contentText(e?.data?.content) });
}

// ── 切出正文：只认「台账正文」那一类 ──
const MARKERS = ["<<<LEDGER-BLOCKS", "<<<LEDGER"];
function bodyOf(t) {
  for (const m of MARKERS) {
    const i = t.indexOf(m);
    if (i >= 0) return { body: t.slice(i), marker: m };
  }
  return null;
}

const bodies = [];
let noMarker = 0;
for (const x of all) {
  const r = bodyOf(x.text);
  if (r === null) { noMarker += 1; continue; }
  bodies.push({ seq: x.seq, body: r.body, marker: r.marker, headChars: x.text.length - r.body.length });
}
console.log(`台账注入 ${all.length} 条 · 能切出正文 ${bodies.length} 条 · 切不出（无 <<<LEDGER 标记）${noMarker} 条`);
console.log(`★ 切不出的那些**不参与**下面的统计（它们多是回执/通知/旧格式，不是台账正文）\n`);

// ── 题头收敛情况 ──
const headHashes = new Map();
for (const x of bodies) {
  const h = crypto.createHash("sha256").update(x.body.slice(0, 60)).digest("hex").slice(0, 8);
  headHashes.set(h, (headHashes.get(h) ?? 0) + 1);
}
console.log(`═══ 正文开头 60 字符有多少种（= 题头有几种代次）═══`);
console.log(`  ${headHashes.size} 种`);
for (const [, n] of [...headHashes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`    ${String(n).padStart(4)} 次`);
}
console.log("");

// ── 相邻两次"正文"的首差异位置 ──
const diffs = [];
let sameBody = 0, markerChanged = 0;
for (let i = 1; i < bodies.length; i += 1) {
  const a = bodies[i - 1], b = bodies[i];
  if (a.marker !== b.marker) markerChanged += 1;   // 标记不同 ⇒ 长度基准不可比
  if (a.body === b.body) { sameBody += 1; continue; }
  let p = 0;
  const minLen = Math.min(a.body.length, b.body.length);
  while (p < minLen && a.body[p] === b.body[p]) p += 1;
  diffs.push({ from: a.seq, to: b.seq, at: p, ratio: p / Math.max(1, a.body.length), aLen: a.body.length, bLen: b.body.length });
}

console.log("═══ 剥掉题头后：相邻两次正文的首差异位置 ═══");
console.log(`  正文完全相同：${sameBody} 对 · 有变化：${diffs.length} 对 · 标记代次变化 ${markerChanged} 次`);
const buckets = new Map();
for (const d of diffs) {
  const b = d.ratio >= 0.9 ? "改在 90% 之后（只动尾部）"
    : d.ratio >= 0.5 ? "改在 50~90%"
    : d.ratio >= 0.2 ? "改在 20~50%"
    : "改在 20% 之前（动到开头）";
  buckets.set(b, (buckets.get(b) ?? 0) + 1);
}
for (const [k, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
  const pct = ((n / diffs.length) * 100).toFixed(1);
  console.log(`  ${String(n).padStart(4)} 对（${pct.padStart(5)}%）· ${k}`);
}
console.log("");

// ── 抽 5 个"改在开头"的样本，把差异现场打出来，人工判是不是题头 ──
console.log("═══ 「改在 20% 之前」的 5 个样本（看差异到底在哪）═══");
const headOnes = diffs.filter((d) => d.ratio < 0.2).slice(0, 5);
for (const d of headOnes) {
  const a = bodies.find((x) => x.seq === d.from);
  const b = bodies.find((x) => x.seq === d.to);
  console.log(`\n  ── seq ${d.from} → ${d.to} · 首差异在 ${d.at} / ${a.body.length} 字符 ──`);
  console.log(`     前: ${JSON.stringify(a.body.slice(d.at, d.at + 90))}`);
  console.log(`     后: ${JSON.stringify(b.body.slice(d.at, d.at + 90))}`);
}

// ── 关键对照：差异位置 vs 台账文件真实内容的哪一行 ──
console.log("\n═══ 差异位置落在台账的哪一部分（按正文行号）═══");
const LEDGER = path.join(import.meta.dirname, "..", "LEDGER.md");
const ledgerLines = fs.readFileSync(LEDGER, "utf8").split("\n");
let cum = 0;
const lineStarts = [];
for (let i = 0; i < ledgerLines.length; i += 1) { lineStarts.push({ line: i + 1, at: cum, text: ledgerLines[i] }); cum += ledgerLines[i].length + 1; }
function lineAt(pos) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid].at <= pos) lo = mid; else hi = mid - 1; }
  return lineStarts[lo];
}
for (const d of headOnes) {
  const L = lineAt(d.at);
  console.log(`  seq ${d.from}→${d.to} @${d.at} ⇒ 约 LEDGER.md 第 ${L.line} 行：${L.text.slice(0, 50)}`);
}
