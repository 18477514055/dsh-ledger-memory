/**
 * 只读：**真 token 数到底挂在哪种事件上？**（先证明尺子对，再报数）
 *
 * ★ 上一版探针在 `request/header` 里找 `data.usage` ⇒ **82 条里 0 条有**。
 *   台账写着「真 token 数在 `data.usage.totalTokens`」，但**没写它挂在哪个 type 上**。
 *   ⇒ 这就是「取不到值，先怀疑取法」（纪律 3）。
 *
 * 本探针不做统计，只做一件事：**把带 usage / totalTokens 的事件类型全列出来**。
 *
 * 跑法：node tools/_probe-usage-locate.mjs
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
for (const l of texts.join("").split("\n")) {
  if (l.trim() === "") continue;
  try { events.push(JSON.parse(l)); } catch {}
}
console.log(`事件 ${events.length} 条\n`);

// ── 哪些 type 带 usage / totalTokens ──
const byType = new Map();
function walk(obj, pathStr, depth, hit) {
  if (depth > 6 || obj === null || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    const p = pathStr === "" ? k : `${pathStr}.${k}`;
    if (k === "usage" || k === "totalTokens" || k === "cacheRead") hit.push(p);
    if (typeof v === "object") walk(v, p, depth + 1, hit);
  }
}
for (const e of events) {
  const hit = [];
  walk(e, "", 0, hit);
  if (hit.length === 0) continue;
  const t = e?.type ?? "?";
  if (!byType.has(t)) byType.set(t, { count: 0, paths: new Set(), sample: undefined });
  const rec = byType.get(t);
  rec.count += 1;
  for (const h of hit) rec.paths.add(h);
  if (rec.sample === undefined) rec.sample = e;
}
console.log("═══ 带 usage/totalTokens/cacheRead 的事件类型 ═══\n");
if (byType.size === 0) {
  console.log("  ❌ 一条都没有 ⇒ 这个会话文件里根本没有 usage 数据。");
  console.log("     ★ 可能原因：日志只存了 surface 事件，usage 在别处（或未落这一层）。");
} else {
  for (const [t, rec] of [...byType.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(rec.count).padStart(5)} × ${t}`);
    console.log(`         路径: ${[...rec.paths].slice(0, 6).join(" | ")}`);
  }
  // 打印最常见那类的原样样本（截断）
  const top = [...byType.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  console.log(`\n═══ 「${top[0]}」的原样样本（前 700 字符）═══`);
  console.log(JSON.stringify(top[1].sample).slice(0, 700));
}
