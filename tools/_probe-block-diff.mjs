/**
 * 只读：**按区块量"每回合到底哪几块变了"**（不再用"首差异百分比"那种会被一个早出现的小数字带偏的尺子）。
 *
 * ★ 为什么换尺子（这一轮第三次自我更正，必须写清楚）：
 *   前两版用「首差异出现在正文的百分之几处」分桶：
 *     · 不剥题头 ⇒ 73% 落在"前 20%"
 *     · 剥掉题头 ⇒ 37.8% 落在"前 20%"，但 46.6% 落在"50~90%"
 *   两次都**定不下结论**，因为"首差异位置"是**一个点**：
 *   台账顶部只要有一个数字变了（如 `D282`→`D284`），首差异就锁在第 8 行，
 *   而**后面改了二十块它也不管**。⇒ **这个尺子测不出"改了多大范围"。**
 *
 * ★ 正解：**按标题切块，逐块比对**。这样回答的是"这一次到底动了哪几块、多大比例"，
 *   那才是方案该看的东西。
 *
 * 跑法：node tools/_probe-block-diff.mjs
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
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c === "string" ? c : c?.type === "text" ? (c.text ?? "") : "")).join("");
}

// ── 取正文并切成区块（按 `## ` / `### ` 标题）──
const bodies = [];
for (const e of events) {
  if (e.type !== "user/message") continue;
  if (e?.data?.source?.kind !== "project-ledger-notes") continue;
  const t = contentText(e?.data?.content);
  const i = t.indexOf("<<<LEDGER");
  if (i < 0) continue;
  bodies.push({ seq: e.seq, body: t.slice(i) });
}
console.log(`台账正文 ${bodies.length} 条\n`);

function blocksOf(body) {
  const lines = body.split("\n");
  const out = [];
  let cur = { title: "(题头)", lines: [] };
  for (const l of lines) {
    if (/^#{2,3}\s/.test(l)) {
      out.push(cur);
      cur = { title: l.replace(/^#{2,3}\s*/, "").slice(0, 40), lines: [] };
    } else {
      cur.lines.push(l);
    }
  }
  out.push(cur);
  const m = new Map();
  for (const b of out) {
    // 同名区块后出现的覆盖前面的（台账里标题唯一）
    m.set(b.title, b.lines.join("\n"));
  }
  return m;
}

// ── 逐对比较：哪几块变了、变了多少字符 ──
const pairs = [];
for (let i = 1; i < bodies.length; i += 1) {
  const A = blocksOf(bodies[i - 1].body);
  const B = blocksOf(bodies[i].body);
  const titles = new Set([...A.keys(), ...B.keys()]);
  const changed = [];
  let totalChars = 0, changedChars = 0;
  for (const t of titles) {
    const a = A.get(t) ?? "";
    const b = B.get(t) ?? "";
    totalChars += Math.max(a.length, b.length);
    if (a !== b) {
      changed.push({ title: t, aLen: a.length, bLen: b.length, delta: Math.abs(a.length - b.length) });
      changedChars += Math.max(a.length, b.length);
    }
  }
  pairs.push({
    from: bodies[i - 1].seq, to: bodies[i].seq,
    nBlocks: titles.size, nChanged: changed.length,
    totalChars, changedChars,
    share: totalChars > 0 ? changedChars / totalChars : 0,
    changed,
  });
}

console.log("═══ 每次注入之间：改了几个区块 / 占多少字符 ═══");
const shares = pairs.map((p) => p.share).sort((a, b) => a - b);
const nac = pairs.map((p) => p.nChanged).sort((a, b) => a - b);
const q = (arr, r) => arr[Math.floor(arr.length * r)] ?? 0;
console.log(`  对数 ${pairs.length}`);
console.log(`  改动的区块数：中位 ${q(nac, 0.5)} · 均值 ${(nac.reduce((a, b) => a + b, 0) / nac.length).toFixed(1)} · 最大 ${nac[nac.length - 1]}`);
console.log(`  改动字符占比：中位 ${(q(shares, 0.5) * 100).toFixed(1)}% · 均值 ${((shares.reduce((a, b) => a + b, 0) / shares.length) * 100).toFixed(1)}% · 最大 ${(shares[shares.length - 1] * 100).toFixed(1)}%`);
console.log("");

const dist = new Map();
for (const s of shares) {
  const k = s < 0.05 ? "<5%（几乎没变）" : s < 0.15 ? "5~15%" : s < 0.3 ? "15~30%" : s < 0.6 ? "30~60%" : ">60%（大半重写）";
  dist.set(k, (dist.get(k) ?? 0) + 1);
}
console.log("═══ 改动字符占比分布 ═══");
for (const k of ["<5%（几乎没变）", "5~15%", "15~30%", "30~60%", ">60%（大半重写）"]) {
  const n = dist.get(k) ?? 0;
  console.log(`  ${String(n).padStart(4)} 对（${((n / shares.length) * 100).toFixed(1).padStart(5)}%）· ${k}`);
}
console.log("");

// ── 最常变的区块 Top 10 ──
const byTitle = new Map();
for (const p of pairs) {
  for (const c of p.changed) {
    if (!byTitle.has(c.title)) byTitle.set(c.title, { n: 0, chars: 0 });
    const r = byTitle.get(c.title);
    r.n += 1;
    r.chars += Math.max(c.aLen, c.bLen);
  }
}
console.log("═══ 最常被改动的区块 Top 12 ═══");
console.log("  次数   涉及字符   区块标题");
for (const [t, r] of [...byTitle.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
  console.log(`  ${String(r.n).padStart(4)} ${String(Math.round(r.chars / r.n)).padStart(10)}   ${t}`);
}
console.log("");

// ── 「只动了一个小区块」的对数：这些是最可能省掉的 ──
const tiny = pairs.filter((p) => p.share < 0.05);
console.log(`═══ 改动 <5% 的对：${tiny.length} 对（${((tiny.length / pairs.length) * 100).toFixed(1)}%）═══`);
for (const p of tiny.slice(0, 8)) {
  console.log(`  seq ${p.from}→${p.to} · 改动 ${(p.chars ?? 0)} · ${(p.share * 100).toFixed(2)}% · 块: ${p.changed.map((c) => c.title.slice(0, 18)).join(" / ")}`);
}
console.log("");
console.log("  ★ 判据：若这类占比高 ⇒ \"只推变化\"确实有空间；");
console.log("    若这类很少、而 >60% 的多 ⇒ 台账每次都近乎重写，\"只推变化\"省不了多少。");
