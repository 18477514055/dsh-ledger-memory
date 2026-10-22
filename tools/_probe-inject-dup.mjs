/**
 * 只读：**注入在历史里重复了多少？**（成本结构的真正所在）
 *
 * ★ 前三把尺子都错在同一个病：**按字段名猜形状，没有先 dump 一条看**。
 *   ① 在 `request/header` 找 usage ⇒ 0/82（实际在 `assistant/message.data.usage`）
 *   ② 把 `inputTokens` 写成 `input` ⇒ 恒等式 0/3077（实际字段名带 Tokens 后缀）
 *   ③ 在 `data.source.kind` 找 user 注入 ⇒ 0 条（实际注入的正文在 `data.content`，且 type 是 `user/message`）
 *   ⇒ 本探针**先按实测形状取**：`e.type==="user/message"` + `e.data.source.kind` + `e.data.content[]`。
 *
 * ★ 已实测确定的成本模型：
 *   恒等式 `totalTokens = inputTokens + cacheReadTokens + outputTokens` **8706/8706 成立**
 *   全会话 cacheRead 35.99 亿 · input 3655 万 · **命中率 98.99%** · 稳定态每步命中 99.9%
 *   ⇒ 逐回合注入**没有**破坏前缀缓存（它是追加在末尾的新消息）
 *   ⇒ **成本 ≈ 上下文大小 × 步数**。所以真问题是：历史里留了几份重复副本。
 *
 * 只做统计，**不报"能省 X%"**。
 *
 * 跑法：node tools/_probe-inject-dup.mjs
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

// ── 取 user/message，按 source.kind 分类 ──
const users = [];
for (const e of events) {
  if (e.type !== "user/message") continue;
  const kind = e?.data?.source?.kind ?? "(无 kind)";
  const t = contentText(e?.data?.content);
  users.push({ seq: e.seq, turn: e.data.turn, kind, chars: t.length, text: t });
}
console.log(`user/message 共 ${users.length} 条\n`);

const byKind = new Map();
for (const x of users) {
  if (!byKind.has(x.kind)) byKind.set(x.kind, { n: 0, chars: 0 });
  const r = byKind.get(x.kind);
  r.n += 1; r.chars += x.chars;
}
console.log("═══ 按 source.kind ═══");
for (const [k, r] of [...byKind.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
  console.log(`  ${String(r.n).padStart(5)} 条 · ${String(r.chars).padStart(11)} 字符 · 均 ${String(Math.round(r.chars / r.n)).padStart(6)} · ${k}`);
}
console.log("");

// ── 注入 = kind 属于插件注入的那几种 ──
const INJECT_KINDS = new Set(["project-ledger-notes", "compact-checkpoint", "agent-instructions", "runtime-context", "time-context"]);
const injects = users.filter((x) => INJECT_KINDS.has(x.kind));
const totalInjectChars = injects.reduce((a, b) => a + b.chars, 0);
console.log(`═══ 注入 ${injects.length} 条 · ${totalInjectChars.toLocaleString("en-US")} 字符 · seq ${injects[0]?.seq} … ${injects[injects.length - 1]?.seq} ═══\n`);

if (injects.length === 0) { console.log("没有命中任何已知注入 kind，退出"); process.exit(0); }

// ── 逐字节完全重复 ──
const byHash = new Map();
for (const x of injects) {
  const h = crypto.createHash("sha256").update(x.text).digest("hex").slice(0, 16);
  if (!byHash.has(h)) byHash.set(h, []);
  byHash.get(h).push(x);
}
let dupChars = 0, uniqChars = 0;
const dupGroups = [];
for (const [, list] of byHash.entries()) {
  if (list.length > 1) {
    const repeated = (list.length - 1) * list[0].chars;
    dupChars += repeated;
    dupGroups.push({ n: list.length, chars: list[0].chars, kind: list[0].kind, repeated });
  } else uniqChars += list[0].chars;
}
dupGroups.sort((a, b) => b.repeated - a.repeated);
console.log("═══ 逐字节完全相同的注入 ═══");
console.log(`  唯一 ${byHash.size} 份 · 其中 ${dupGroups.length} 份有重复`);
console.log(`  不重复 ${uniqChars.toLocaleString("en-US")} 字符 · 纯重复 ${dupChars.toLocaleString("en-US")} 字符（占 ${((dupChars / totalInjectChars) * 100).toFixed(1)}%）`);
for (const g of dupGroups.slice(0, 10)) {
  console.log(`    ${String(g.n).padStart(4)} 份 × ${String(g.chars).padStart(7)} 字符 = 重复 ${String(g.repeated).padStart(10)} · ${g.kind}`);
}
console.log("");

// ── 近似重复：归一化后比前 800 字符 ──
function norm(t) {
  return t.slice(0, 800).replace(/\s+/g, " ").replace(/\d+/g, "#").trim();
}
const byNorm = new Map();
for (const x of injects) {
  const h = crypto.createHash("sha256").update(norm(x.text)).digest("hex").slice(0, 16);
  if (!byNorm.has(h)) byNorm.set(h, []);
  byNorm.get(h).push(x);
}
let nearDup = 0;
const nearGroups = [];
for (const [, list] of byNorm.entries()) {
  if (list.length > 1) {
    const avg = Math.round(list.reduce((a, b) => a + b.chars, 0) / list.length);
    const repeated = (list.length - 1) * avg;
    nearDup += repeated;
    nearGroups.push({ n: list.length, avg, kind: list[0].kind, repeated });
  }
}
nearGroups.sort((a, b) => b.repeated - a.repeated);
console.log("═══ 近似重复（前 800 字符归一化：空白折叠 + 数字替换为 #）═══");
console.log(`  ${nearGroups.length} 组 · 重复量约 ${nearDup.toLocaleString("en-US")} 字符（占 ${((nearDup / totalInjectChars) * 100).toFixed(1)}%）`);
for (const g of nearGroups.slice(0, 10)) {
  console.log(`    ${String(g.n).padStart(4)} 份 × 约 ${String(g.avg).padStart(7)} = 约 ${String(g.repeated).padStart(10)} · ${g.kind}`);
}
console.log("");

// ── 每回合注入 ──
const perTurn = new Map();
for (const x of injects) {
  const t = x.turn ?? "?";
  if (!perTurn.has(t)) perTurn.set(t, { n: 0, chars: 0 });
  const r = perTurn.get(t);
  r.n += 1; r.chars += x.chars;
}
const vals = [...perTurn.values()];
console.log("═══ 每回合注入 ═══");
console.log(`  覆盖 ${perTurn.size} 个 turn`);
console.log(`  平均 ${(vals.reduce((a, b) => a + b.n, 0) / vals.length).toFixed(1)} 条 / ${Math.round(vals.reduce((a, b) => a + b.chars, 0) / vals.length).toLocaleString("en-US")} 字符`);
const sorted = vals.map((v) => v.chars).sort((a, b) => a - b);
console.log(`  中位 ${sorted[Math.floor(sorted.length / 2)].toLocaleString("en-US")} · 最大 ${sorted[sorted.length - 1].toLocaleString("en-US")}`);
