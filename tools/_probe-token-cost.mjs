/**
 * 只读：**我们的注入到底花了多少 token，以及有没有在破坏 prompt 缓存。**
 *
 * ★ 为什么要量缓存而不是只量字符：
 *   台账里记着 `totalTokens ≡ input + cacheRead + output`。
 *   ⇒ `cacheRead` 是**命中的缓存量**（便宜），`input` 是**没命中的新输入**（贵）。
 *   如果我们的注入每回合都在变 ⇒ 从变化点往后**全部缓存失效** ⇒
 *   代价不是"多了几个字"，是"整段上下文按全价重算"。
 *
 * ★ 判据（全部来自真实 `request/header.data.usage`，不估算）：
 *   ① 每次请求的 cacheRead / input 比例
 *   ② 我们的注入是否出现在「缓存断点之前」（越靠前，改动代价越大）
 *   ③ 注入内容的变化频率（与缓存命中率对照）
 *
 * 跑法：node tools/_probe-token-cost.mjs
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
const events = [];
for (const l of texts.join("").split("\n")) {
  if (l.trim() === "") continue;
  try {
    events.push(JSON.parse(l));
  } catch {}
}

// ── ① usage 字段的真实形状 ──
const reqs = events.filter((e) => e?.type === "request/header");
console.log(`═══ ① usage 的真实形状（request/header 共 ${reqs.length} 条）═══\n`);
const withUsage = reqs.filter((r) => r?.data?.usage !== undefined);
console.log(`  带 usage 的：${withUsage.length} 条`);
if (withUsage.length > 0) {
  console.log(`  首条 usage（原样）：${JSON.stringify(withUsage[0].data.usage)}`);
}
const usage = withUsage.map((r) => ({ seq: r.seq, ...r.data.usage }));

// ── ② 缓存命中率（最近 40 次）──
console.log(`\n═══ ② 缓存命中率（最近 40 次请求）═══\n`);
console.log(`  seq      input    cacheRead   output   total    缓存占比`);
const tail = usage.slice(-40);
let sumIn = 0, sumCache = 0, sumTotal = 0;
for (const u of tail) {
  const i = u.input ?? 0;
  const c = u.cacheRead ?? 0;
  const o = u.output ?? 0;
  const t = u.totalTokens ?? i + c + o;
  sumIn += i; sumCache += c; sumTotal += t;
  const share = t > 0 ? ((c / t) * 100).toFixed(1) : "?";
  console.log(
    `  ${String(u.seq).padStart(6)} ${String(i).padStart(8)} ${String(c).padStart(10)} ${String(o).padStart(8)} ${String(t).padStart(8)}  ${share.padStart(6)}%`
  );
}
if (tail.length > 0) {
  console.log(`\n  合计：input=${sumIn} cacheRead=${sumCache} total=${sumTotal}`);
  console.log(`  ★ 缓存命中占比 = ${((sumCache / sumTotal) * 100).toFixed(1)}%`);
  console.log(`  ★ 未命中的（按全价算）= ${sumIn} tok，占总 ${((sumIn / sumTotal) * 100).toFixed(1)}%`);
}

// ── ③ 单次请求的 token 构成（最后一条，看大头在哪）──
const last = usage[usage.length - 1];
if (last !== undefined) {
  console.log(`\n═══ ③ 最后一次请求的构成（seq=${last.seq}）═══`);
  console.log(`     input=${last.input} cacheRead=${last.cacheRead} output=${last.output} total=${last.totalTokens}`);
}

// ── ④ 我们的注入在会话里的位置（越靠后影响越小，但要看清）──
console.log(`\n═══ ④ 我们的注入条数与总字符（重算一遍，作为对照基线）═══\n`);
let n = 0, chars = 0;
const ourSeqs = [];
for (const e of events) {
  if (e?.type !== "user/message") continue;
  if (e?.data?.source?.kind !== "project-ledger-notes") continue;
  const t = (Array.isArray(e.data.content) ? e.data.content : []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
  if (t === "") continue;
  n += 1; chars += t.length; ourSeqs.push(e.seq);
}
console.log(`  注入 ${n} 条 · ${chars} 字符 · 平均 ${Math.round(chars / n)}`);
console.log(`  首条 seq=${ourSeqs[0]} 末条 seq=${ourSeqs[ourSeqs.length - 1]}`);

// ── ⑤ 粗略换算：字符 → token（中文按 ~1.5 字符/token 估，英文 ~4 字符/token）──
//   ★ 明确标注这是**估算**，只用于看数量级，不能当实测值。
console.log(`\n═══ ⑤ 量级参考（★ 估算，不是实测）═══`);
console.log(`  若按「中文约 1.5 字符/token」粗估：注入合计 ≈ ${Math.round(chars / 1.5)} tok`);
if (tail.length > 0) {
  const avgTotal = Math.round(sumTotal / tail.length);
  console.log(`  最近 ${tail.length} 次请求的平均 totalTokens = ${avgTotal}`);
  console.log(`  ⇒ 注入 ≈ 平均单次请求的 ${((chars / 1.5 / avgTotal) * 100).toFixed(0)}%（若每次全量重推）`);
}
