/**
 * 只读：**我们的注入里，有多少是逐字重复上一回合的？**
 *
 * ★ 为什么测这个：用户问「你真的觉得它能压缩吗？」
 *   而我上一轮说「95.1% 是问题」—— 那个说法站不住：
 *   **注入不是开销，它就是机制**（D46：恢复必须是推，不能等模型来查）。
 *   准确性与延续性正是拿这个换来的。
 *
 * ⇒ 所以不该靠我表态，该**测**：
 *   · 若每次注入与上一次**大量逐字相同** ⇒ 那部分是包袱（它不带来新信息）
 *   · 若几乎每次都不同 ⇒ 用户是对的，压不动，别再提
 *
 * ★ 判据：**按行做逐字比对**（不做语义相似度 —— 那是另一把尺子，且不可证伪）。
 *   一行算「重复」= 它在**紧邻的上一条注入**里**逐字出现过**。
 *   ⚠️ 这是**下界**：行被移动/重排也算重复，因为对模型而言"这行它上回合见过"。
 *
 * 跑法：node tools/_probe-inject-repeat.mjs
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

// ── 收我们的注入（按 seq 顺序）──
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
console.log(`我们的注入 ${ours.length} 条，合计 ${ours.reduce((s, r) => s + r.text.length, 0)} 字符\n`);

// ── 逐条与**紧邻的上一条**比：有多少行是逐字重复的 ──
let totalChars = 0;
let repeatChars = 0;
let totalLines = 0;
let repeatLines = 0;
const perPair = [];

for (let i = 0; i < ours.length; i += 1) {
  const cur = ours[i];
  const prev = i === 0 ? undefined : ours[i - 1];
  const prevLines = prev === undefined ? new Set() : new Set(prev.text.split("\n").map((s) => s.replace(/\s+$/, "")));
  const curLines = cur.text.split("\n").map((s) => s.replace(/\s+$/, ""));
  let rChars = 0;
  let rLines = 0;
  for (const line of curLines) {
    if (line === "") continue;
    if (prevLines.has(line)) {
      rChars += line.length + 1;
      rLines += 1;
    }
  }
  totalChars += cur.text.length;
  totalLines += curLines.filter((x) => x !== "").length;
  repeatChars += rChars;
  repeatLines += rLines;
  if (i > 0) perPair.push({ i, seq: cur.seq, chars: cur.text.length, repeat: rChars, ratio: cur.text.length === 0 ? 0 : rChars / cur.text.length });
}

console.log("═══ 与「紧邻的上一条注入」逐字比对 ═══\n");
console.log(`  总字符        ${totalChars}`);
console.log(`  其中逐字重复  ${repeatChars}  (${((repeatChars / totalChars) * 100).toFixed(1)}%)`);
console.log(`  总行数        ${totalLines}`);
console.log(`  其中逐字重复  ${repeatLines}  (${((repeatLines / totalLines) * 100).toFixed(1)}%)`);

// ── 分布：重复率在各个区间各有多少条 ──
const buckets = new Map([
  ["0–20%", 0],
  ["20–40%", 0],
  ["40–60%", 0],
  ["60–80%", 0],
  ["80–100%", 0],
]);
for (const p of perPair) {
  const b = p.ratio < 0.2 ? "0–20%" : p.ratio < 0.4 ? "20–40%" : p.ratio < 0.6 ? "40–60%" : p.ratio < 0.8 ? "60–80%" : "80–100%";
  buckets.set(b, buckets.get(b) + 1);
}
console.log("\n═══ 逐条重复率分布 ═══\n");
for (const [k, n] of buckets) console.log(`  ${k.padEnd(9)} ${String(n).padStart(4)} 条  ${"█".repeat(Math.round((n / Math.max(1, perPair.length)) * 40))}`);

// ── 只看最近 100 条（时间窗：避免历史淹没现状，纪律 1）──
const recent = perPair.slice(-100);
if (recent.length > 0) {
  const rc = recent.reduce((s, p) => s + p.chars, 0);
  const rr = recent.reduce((s, p) => s + p.repeat, 0);
  console.log(`\n═══ 只看最近 ${recent.length} 条（近况，不被历史淹没）═══`);
  console.log(`  字符 ${rc}，其中逐字重复 ${rr} ⇒ **${((rr / rc) * 100).toFixed(1)}%**`);
}

// ── 挑一条中位的，原样看它"变了什么" ──
if (perPair.length > 10) {
  const sorted = perPair.slice().sort((a, b) => a.ratio - b.ratio);
  const mid = sorted[Math.floor(sorted.length / 2)];
  const cur = ours.find((r) => r.seq === mid.seq);
  const idx = ours.findIndex((r) => r.seq === mid.seq);
  const prev = ours[idx - 1];
  if (cur !== undefined && prev !== undefined) {
    const prevSet = new Set(prev.text.split("\n").map((s) => s.replace(/\s+$/, "")));
    const fresh = cur.text.split("\n").filter((l) => l !== "" && !prevSet.has(l.replace(/\s+$/, "")));
    console.log(`\n═══ 抽样：中位重复率那条（seq=${cur.seq}，重复 ${(mid.ratio * 100).toFixed(1)}%）═══`);
    console.log(`  ★ 这一回合**新出现**的行共 ${fresh.length} 行；前 12 行：`);
    for (const l of fresh.slice(0, 12)) console.log(`    ${l.slice(0, 110)}`);
  }
}
