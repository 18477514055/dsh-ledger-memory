/**
 * ★★★★★★ 只读取证（D190 前提之二）：**`turn/end` 到底在不在 `surface` 上？**
 *
 * 为什么必须查清（前一个探针已经给了**危险信号**）：
 *   我的 `selectLastTurnRange` 靠**在 `session.surface.nodes` 里找 `turn/end`** 来定位回合边界。
 *   若 `turn/end` **根本不在 surface 上** ⇒ 它**永远返回 null** ⇒
 *   `/ledger light` 会永远回"找不到可压的上一个回合" ⇒ **功能等于没做**。
 *
 * ★★★ 而这正是**纪律 8** 的现场：三个既有断言已经红了，
 *   我**绝不能**先去改夹具把它们弄绿 —— 必须先证明前提在**真机**上成立。
 *
 * ★ 判据（直接、可判定，不猜）：
 *   从官方日志里取**同一场会话**的两个东西：
 *     ① `turn/end` 事件的 `seq` 集合；
 *     ② `compaction/summary.shadowedSeqs` 或 `shadowedRange` —— 那是**当时 surface 的真子集**
 *        （内核亲自写的，不是我们推的）。
 *   看 ① 与 ② 有没有交集。★ 有 ⇒ `turn/end` 在 surface 上；**没有** ⇒ 不在（我的选法作废）。
 *
 * 只读。跑法：node tools/_probe-d190-turn-on-surface.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const s = [];
  let i = buf.indexOf(MAGIC);
  while (i !== -1) {
    s.push(i);
    i = buf.indexOf(MAGIC, i + 4);
  }
  s.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < s.length; k += 1) {
    try {
      const d = zlib.zstdDecompressSync(buf.subarray(s[k], s[k + 1]));
      if (d.length) out.push(d);
    } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

const ROOT = path.join(os.homedir(), ".dsh", "sessions");
const files = [];
const walk = (dir, depth) => {
  if (depth > 4) return;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === "session.v4.jsonl.zstd") files.push(p);
  }
}
walk(ROOT, 0);

let checked = 0;
let withOverlap = 0;
let inAnyRange = 0;
let totalTurnEnds = 0;
const details = [];
for (const p of files) {
  let txt;
  try {
    txt = decodeAll(fs.readFileSync(p));
  } catch {
    continue;
  }
  const turnEndSeqs = new Set();
  const surfaces = []; // {seqs:Set, lo, hi}
  for (const line of txt.split("\n")) {
    if (line === "" || !line.includes("turn/end") && !line.includes("compaction/summary")) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "turn/end") turnEndSeqs.add(Number(e.seq));
    if (e.type === "compaction/summary") {
      const seqs = e.data?.shadowedSeqs;
      const r = e.data?.shadowedRange;
      const lo = Number(r?.start);
      const hi = Number(r?.end);
      if (Array.isArray(seqs) && seqs.length > 0) surfaces.push({ seqs: new Set(seqs.map(Number)), lo, hi });
      else if (Number.isFinite(lo) && Number.isFinite(hi)) surfaces.push({ seqs: null, lo, hi });
    }
  }
  if (turnEndSeqs.size === 0 || surfaces.length === 0) continue;
  checked += 1;
  totalTurnEnds += turnEndSeqs.size;

  let hit = false;      // 有交集（在 shadowedSeqs 里）
  let inRng = false;    // 落在 shadowedRange 区间里
  for (const s of surfaces) {
    for (const q of turnEndSeqs) {
      if (s.seqs !== null) {
        if (s.seqs.has(q)) hit = true;
      } else if (Number.isFinite(s.lo) && Number.isFinite(s.hi) && q >= s.lo && q <= s.hi) {
        inRng = true;
      }
    }
  }
  if (hit) withOverlap += 1;
  if (inRng) inAnyRange += 1;
  if (details.length < 10) {
    details.push({
      p,
      nEnd: turnEndSeqs.size,
      nSurf: surfaces.length,
      hit,
      inRng,
      sampleEnd: [...turnEndSeqs].slice(0, 6),
      sampleSurf: surfaces[0].seqs !== null ? [...surfaces[0].seqs].slice(0, 6) : `range ${surfaces[0].lo}–${surfaces[0].hi}`,
    });
  }
}

bar(`① 可判定的会话：${checked} 个（既有 turn/end、又有 compression/summary 的快照）`);
console.log(`  ★ 其中 **turn/end 出现在 shadowedSeqs（= surface 真子集）里**的：${withOverlap} 个`);
console.log(`  ★ 或落在 shadowedRange 区间里的：${inAnyRange} 个`);
console.log(`  （全库 turn/end 事件总数：${totalTurnEnds}）`);

bar("② 样本明细（看 seq 有没有交集）");
for (const d of details) {
  console.log(`\n  ${d.p.replace(ROOT, "…").slice(-54)}`);
  console.log(`    turn/end 共 ${d.nEnd} 个，样例 seq = [${d.sampleEnd.join(", ")}]`);
  console.log(`    surface 样例      = ${Array.isArray(d.sampleSurf) ? `[${d.sampleSurf.join(", ")}]` : d.sampleSurf}`);
  console.log(`    ⇒ 在 surface 里命中：${d.hit ? "★ 是" : "否"}　落在 range 里：${d.inRng ? "★ 是" : "否"}`);
}

bar("③ ★★★ 结论（这决定 D190 的选法能不能用）");
if (withOverlap > 0) {
  console.log(
    `  ✅ 有 ${withOverlap} 个会话的 \`turn/end\` **确实出现在 surface 上** ⇒ 回合边界**可用**。\n` +
      `     ★ 但占比只有 ${((100 * withOverlap) / Math.max(1, checked)).toFixed(1)}% ⇒ 要看清"其余那些"是什么情况。`
  );
} else {
  console.log(
    "  ❌ **没有一个**会话的 `turn/end` 出现在 surface 上 ⇒\n" +
      "     ★★ 我 D190 的选法（在 surface 里找 turn/end）**是错的** ⇒ 必须改用别的依据\n" +
      "     （例如：按 `shadowedRange`/`compaction/summary` 的实际形态，或用「最近 N 个节点」）。\n" +
      "     ★ 而这**恰好解释了那三个断言为什么红** —— 不是夹具坏了，是**我的实现依赖了不存在的东西**。"
  );
}
