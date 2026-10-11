/**
 * ★ 只读：`prune` 到底有多少杠杆？
 * 我先前把「prune 当主要手段」列成第一优先项 —— 本探针就是去证伪它。
 * 判据：内核 pruner 只看 `tool/result` 且只裁 `> thresholdChars(8192)` 的。
 *   ⇒ 窗口里够得着阈值的 tool/result 有多少？能省多少？
 *   ⇒ 若窗口里一个都够不着，那「主要手段」这个说法就是错的。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const s = []; let i = buf.indexOf(MAGIC);
  while (i !== -1) { s.push(i); i = buf.indexOf(MAGIC, i + 4); }
  s.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < s.length; k += 1) {
    try { const d = zlib.zstdDecompressSync(buf.subarray(s[k], s[k + 1])); if (d.length) out.push(d); } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};
const SESS = path.join(os.homedir(), ".dsh", "sessions", "--D-Deepseek~5DE5~4F5C~533A--",
  "session-fada6e5f-52f2-4a4f-b52a-3c2483db117e", "session.v4.jsonl.zstd");
const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
const bySeq = new Map();
for (const e of evs) bySeq.set(e.seq, e);
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(11, 19);

const THRESHOLD = 8192;
// 内核 pruner 的 output 上限 = headChars + marker + tailChars；配置约束要求 <= threshold
const MARKER = "\n\n[... tool result middle pruned ...]\n\n";

// tool/result 的「那部分」= message.content
const trLen = (e) => {
  const c = e.data?.message?.content;
  if (Array.isArray(c)) {
    let s = 0;
    for (const b of c) s += typeof b.text === "string" ? b.text.length : JSON.stringify(b).length;
    return s;
  }
  if (typeof c === "string") return c.length;
  return 0;
};

// ★ 重建「某个时刻」的窗口：只折叠 seq < 该时刻 的事件
const windowAt = (t) => {
  const nodes = [];
  for (const e of evs) {
    if (e.time > t) break;
    const op = e.surfaceOp;
    if (op === undefined) continue;
    if (op === "append") { nodes.push(e.seq); continue; }
    const si = nodes.indexOf(op.startSeq);
    const ei = nodes.indexOf(op.endSeq);
    if (si === -1 || ei === -1 || si > ei) continue;
    nodes.splice(si, ei - si + 1, e.seq);
  }
  return nodes.map((s) => bySeq.get(s)).filter(Boolean);
};

console.log("═".repeat(84));
console.log("① 全会话 tool/result 尺寸分布（判据：内核只看 > 8192）");
console.log("═".repeat(84));
const allTR = evs.filter((e) => e.type === "tool/result" && e.surfaceOp !== undefined);
const lens = allTR.map(trLen).sort((a, b) => a - b);
const big = allTR.filter((e) => trLen(e) > THRESHOLD);
const sumAll = lens.reduce((a, b) => a + b, 0);
let sumBigReal = 0;
for (const e of big) sumBigReal += trLen(e);
console.log(`  tool/result surface 节点 = ${allTR.length}`);
console.log(`  其中 > ${THRESHOLD} chars = **${big.length} 个（${(100 * big.length / allTR.length).toFixed(1)}%）**`);
console.log(`  chars 合计 ${sumAll.toLocaleString()}（≈${(sumAll / 4 / 1000).toFixed(0)}K tok）`);
console.log(`  其中大块占 ${sumBigReal.toLocaleString()}（≈${(sumBigReal / 4 / 1000).toFixed(0)}K tok）= **${(100 * sumBigReal / sumAll).toFixed(1)}%**`);
const q = (p) => lens[Math.min(lens.length - 1, Math.floor(p * lens.length))];
console.log(`  尺寸分位：p50=${q(0.5)}  p75=${q(0.75)}  p90=${q(0.9)}  p99=${q(0.99)}  max=${lens[lens.length - 1]}`);
console.log(`  ⇒ ★ prune 的杠杆是**高度集中在少数大块**上：${big.length} 个节点扛着 ${(100 * sumBigReal / sumAll).toFixed(0)}% 的体积。`);

console.log("\n" + "═".repeat(84));
console.log("② ★★★ 每个压缩点**之前**的窗口：prune 当时能省多少？（这才是真判据）");
console.log("═".repeat(84));
const ends = evs.filter((e) => e.type === "compaction/end").map((e) => e.time).sort((a, b) => a - b);
console.log("  时刻(压前)  窗口节点  tool/result 可裁节点  可裁 chars  省下 tok  占窗口");
console.log("  " + "-".repeat(80));
let totWin = 0, totSave = 0;
for (const t of ends) {
  const win = windowAt(t);
  const trs = win.filter((e) => e.type === "tool/result");
  const hit = trs.filter((e) => trLen(e) > THRESHOLD);
  let save = 0;
  for (const e of hit) save += trLen(e) - (THRESHOLD); // 保守：裁到刚好等于阈值（实际会裁到 head+marker+tail）
  // 窗口总 chars（正文 + 工具头）
  let body = 0;
  for (const e of win) {
    const c = e.data?.message?.content ?? e.data?.content;
    body += Array.isArray(c) ? JSON.stringify(c).length : (typeof c === "string" ? c.length : 0);
  }
  const winTok = body / 4 + 259294 / 4.57;
  totWin += winTok; totSave += save / 4;
  console.log(`  ${hm(t)}  ${String(win.length).padStart(8)}  ${String(trs.length).padStart(11)}  ${String(hit.length).padStart(11)}  ${String(save).padStart(10)}  ${String(Math.round(save / 4)).padStart(8)}  ${(100 * (save / 4) / Math.max(1, winTok)).toFixed(2).padStart(6)}%`);
}
console.log(`\n  ⇒ 22 次压缩前，prune 合计可省 ≈ ${Math.round(totSave).toLocaleString()} tok`);
console.log(`  ⇒ 平均每次压缩前省 ≈ ${Math.round(totSave / ends.length).toLocaleString()} tok，占当时窗口 ${(100 * totSave / totWin).toFixed(2)}%`);
console.log(`  ⇒ ★ **每次压缩触发时，内核本来就会先试 prune**（compactIfNeeded 里第一步）。`);
console.log(`     上面这一列就是它实际能拿到的量 —— 若很小，说明 prune 不是主力。`);

console.log("\n" + "═".repeat(84));
console.log("③ 现在（最新窗口）：prune 能动几个？");
console.log("═".repeat(84));
const now = windowAt(Number.MAX_SAFE_INTEGER);
const nowTR = now.filter((e) => e.type === "tool/result");
const nowHit = nowTR.filter((e) => trLen(e) > THRESHOLD);
console.log(`  当前窗口节点 = ${now.length}，tool/result = ${nowTR.length}`);
console.log(`  其中 > ${THRESHOLD} = **${nowHit.length} 个**`);
console.log(`  最大的几个 tool/result：${nowTR.map(trLen).sort((a, b) => b - a).slice(0, 8).join(" · ")}`);
if (nowHit.length === 0) console.log(`  ⇒ ★★★ **当前窗口里 prune 一个也裁不到** —— 我先前把它列为「第一优先」是错的。`);
