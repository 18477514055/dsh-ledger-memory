/**
 * 只读：那 187 条"一条标志都没匹配上"的注入到底是什么？
 *
 * ★ 为什么必须查：`_probe-inject-decompose.mjs` 报了这个数。
 *   把"识别失败"当成"没有"正是本项目反复踩的坑（D84 尺子错第 25 次同族）
 *   ⇒ 不许跳过，必须原样看清楚。
 *
 * 跑法：node tools/_probe-inject-unmatched.mjs
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

const MARKER_HEAD = "## 当前项目台账（";
const ours = [];
for (const l of texts.join("").split("\n")) {
  if (l.trim() === "") continue;
  let o;
  try {
    o = JSON.parse(l);
  } catch {
    continue;
  }
  if ((o?.type ?? o?.event?.type) !== "user/message") continue;
  const d = o?.data ?? o?.event?.data;
  if (d?.source?.kind !== "project-ledger-notes") continue;
  const text = (Array.isArray(d?.content) ? d.content : []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
  if (text === "") continue;
  ours.push({ seq: o?.seq ?? o?.event?.seq, text });
}

const unmatched = ours.filter((r) => !r.text.includes(MARKER_HEAD));
console.log(`我们的注入 ${ours.length} 条，其中**没有台账头的** ${unmatched.length} 条\n`);

// 按长度分桶，看规模
const buckets = new Map();
for (const r of unmatched) {
  const b = r.text.length < 200 ? "<200" : r.text.length < 600 ? "200-600" : r.text.length < 2000 ? "600-2000" : ">=2000";
  buckets.set(b, (buckets.get(b) ?? 0) + 1);
}
console.log("按长度分桶：");
for (const [k, n] of [...buckets.entries()]) console.log(`  ${k.padEnd(10)} ${n} 条`);

// 按开头 40 字聚簇 —— 同类提示语会聚在一起
const byHead = new Map();
for (const r of unmatched) {
  const head = r.text.replace(/\s+/g, " ").slice(0, 46);
  if (!byHead.has(head)) byHead.set(head, []);
  byHead.get(head).push(r);
}
console.log(`\n按开头聚成 ${byHead.size} 簇（按条数降序，最多列 15 簇）：\n`);
for (const [head, list] of [...byHead.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 15)) {
  console.log(`  [${String(list.length).padStart(4)} 条 · 平均 ${Math.round(list.reduce((s, r) => s + r.text.length, 0) / list.length)} 字]`);
  console.log(`    ${head}`);
}
