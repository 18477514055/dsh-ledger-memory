/**
 * 只读：量化「给我们自己的注入加 sections/changes 会让会话日志涨多少」。
 *
 * 背景：`runtime-context` / `time-context` 用 `form:"snapshot"` + `source.sections`，
 * 实测 **261/261 条 content 与 sections 两边都有** ⇒ sections 是**并行副本**，
 * 只给 UI 用，模型读的仍是 content。
 * ⇒ 我们要不要也加 sections，取决于"重复一份正文"的代价有多大。
 *
 * 跑法：node tools/_probe-inject-size.mjs
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
if (FILE === undefined) {
  console.log("SKIP");
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

const stats = new Map(); // kind → { n, chars[] }
for (const l of lines) {
  let o;
  try {
    o = JSON.parse(l);
  } catch {
    continue;
  }
  if ((o?.type ?? o?.event?.type) !== "user/message") continue;
  const d = o?.data ?? o?.event?.data;
  const kind = d?.source?.kind ?? "(无)";
  const content = Array.isArray(d?.content) ? d.content : [];
  const n = content.reduce((s, c) => s + (typeof c?.text === "string" ? c.text.length : 0), 0);
  if (!stats.has(kind)) stats.set(kind, { n: 0, total: 0, max: 0, min: Infinity });
  const s = stats.get(kind);
  s.n += 1;
  s.total += n;
  s.max = Math.max(s.max, n);
  s.min = Math.min(s.min, n);
}

console.log("═══ 各类注入的正文体量（字符）═══\n");
console.log("  kind                        条数      总计      平均      最大");
const rows = [...stats.entries()].sort((a, b) => b[1].total - a[1].total);
let grand = 0;
for (const [k, s] of rows) {
  grand += s.total;
  console.log(
    `  ${k.padEnd(26)} ${String(s.n).padStart(5)}  ${String(s.total).padStart(9)}  ${String(Math.round(s.total / s.n)).padStart(8)}  ${String(s.max).padStart(9)}`
  );
}
console.log(`  ${"合计".padEnd(26)} ${"".padStart(5)}  ${String(grand).padStart(9)}`);

const ours = stats.get("project-ledger-notes");
if (ours !== undefined) {
  console.log(`\n═══ 若给我们加 source.sections（= 正文再存一份） ═══`);
  console.log(`  我们共注入 ${ours.n} 条 · 正文合计 ${ours.total} 字符（≈ ${(ours.total / 1024).toFixed(0)} KB）`);
  console.log(`  ⇒ sections 再存一份 = 会话日志多 ${ours.total} 字符（≈ ${(ours.total / 1024).toFixed(0)} KB，未压缩前）`);
  console.log(`  ⇒ 相对全库注入总量 ${grand} 字符，占 ${((ours.total / grand) * 100).toFixed(1)}% 的**增量**`);
  console.log(`  ★ 注意：这是**每回合**都在涨的，${ours.n} 条已发生；若继续用，代价线性增长。`);
}
console.log(`\n  （对照）runtime-context/time-context 已经在重复存，它们合计 ${
  (stats.get("runtime-context")?.total ?? 0) + (stats.get("time-context")?.total ?? 0)
} 字符的 sections 副本。`);
