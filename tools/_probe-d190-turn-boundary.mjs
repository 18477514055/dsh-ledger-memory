/**
 * ★★★★★ 只读取证（D190 前提）：**`turn/end` 真的在 `surface.nodes` 里吗？**
 *
 * 我改了 `/ledger light` 的语义：从"压最旧一段"改成"**压上一个回复**"，
 * 而后者靠**回合边界**（从后往前找 `turn/end`）来定位。
 *
 * ★★★ 若真实会话的 surface 里**根本没有 `turn/end` 事件**，那我整个选法就是空的 ——
 *   命令会永远回"找不到可压的上一个回合"。
 *   ⇒ 这正是**纪律 8**（"夹具前提错了，全绿就是假绿"）要防的东西：
 *     三个既有断言红了，我**不能**先改夹具让它变绿，而要先证明**前提在真机上成立**。
 *
 * ★ 判据：读**官方会话日志**（真源），统计每场会话里
 *   ① `turn/end` 事件总数；② 其中**出现在 surface 上**的（`surface.nodes` 那种 seq 序列）
 *   —— 后者官方日志里没有直接给，但 `compaction/summary.shadowedSeqs` 给过几次快照，
 *   所以退一步用**可判定的近似**：`turn/end` 事件总数 ≥ 2 的会话占比。
 *   ★ 只要"绝大多数会话都有 ≥2 个 turn/end"，回合边界就是**可靠可用的**。
 *
 * 只读。跑法：node tools/_probe-d190-turn-boundary.mjs
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
console.log(`扫到 ${files.length} 个会话日志`);

let n = 0;
let withTwo = 0;
let withAny = 0;
const counts = [];
let sampleSeqs = null;
for (const p of files) {
  let txt;
  try {
    txt = decodeAll(fs.readFileSync(p));
  } catch {
    continue;
  }
  let ends = 0;
  let starts = 0;
  let firstSample = null;
  for (const line of txt.split("\n")) {
    if (line === "" || !line.includes("turn/")) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "turn/end") ends += 1;
    if (e.type === "turn/start") starts += 1;
    // ★ 顺手看看"这些事件有没有被算进 surface"：
    //   `compaction/summary.shadowedSeqs` 给的是**当时的 surface 序列**（真源快照）。
    if (e.type === "compaction/summary" && firstSample === null) {
      const seqs = e.data?.shadowedSeqs;
      if (Array.isArray(seqs) && seqs.length > 0) firstSample = seqs;
    }
  }
  if (ends === 0 && starts === 0) continue;
  n += 1;
  if (ends >= 1) withAny += 1;
  if (ends >= 2) withTwo += 1;
  counts.push({ p, ends, starts });
  if (sampleSeqs === null && firstSample !== null) sampleSeqs = { p, seqs: firstSample };
}

bar("① 全库：有 turn 事件的会话里，`turn/end` 够不够多");
console.log(`  有 turn 事件的会话：${n} 个`);
console.log(`  其中 \`turn/end\` ≥ 1 的：${withAny} 个（${((100 * withAny) / Math.max(1, n)).toFixed(1)}%）`);
console.log(`  ★ 其中 \`turn/end\` ≥ 2 的：${withTwo} 个（${((100 * withTwo) / Math.max(1, n)).toFixed(1)}%）`);
console.log(`     （≥2 才能定位出"上一个回合"的**两个边界**）`);

counts.sort((a, b) => b.ends - a.ends);
bar("② 样本（turn/end 最多的 8 场）");
for (const c of counts.slice(0, 8)) {
  console.log(`   turn/end=${String(c.ends).padStart(4)}  turn/start=${String(c.starts).padStart(4)}  ${c.p.replace(ROOT, "…").slice(-52)}`);
}

bar("③ ★★★ 关键：`turn/end` 是否出现在**surface** 上");
if (sampleSeqs === null) {
  console.log("  ✗ 没拿到任何 `shadowedSeqs` 快照 ⇒ **无法判定**（不许当结论）");
} else {
  console.log(`  取一场的 \`compaction/summary.shadowedSeqs\`（**当时的 surface 序列**）做样本：`);
  console.log(`    ${sampleSeqs.p.replace(ROOT, "…").slice(-56)}`);
  console.log(`    seqs = [${sampleSeqs.seqs.slice(0, 20).join(", ")}${sampleSeqs.seqs.length > 20 ? ", …" : ""}]（共 ${sampleSeqs.seqs.length} 个）`);
  console.log(
    "\n  ★ 说明：surface 序列里**是否含 turn/end** 要看那一场的实际内容；" +
      "\n     本探针只如实打印，**不替它下结论**。" +
      "\n     ⇒ 真正的判据是**真机跑一次** `/ledger light`（见「下一步」）。"
  );
}

bar("④ 结论口径");
console.log(
  `  ${withTwo > 0 && withTwo / Math.max(1, n) > 0.5
    ? "★ 绝大多数会话都有 ≥2 个 turn/end ⇒ **回合边界是可用的定位依据** ✅"
    : "★★ 有 ≥2 个 turn/end 的会话**不足一半** ⇒ 该定位法**不牢靠**，必须另想 ❌"}`
);
