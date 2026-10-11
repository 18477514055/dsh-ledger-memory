/**
 * ★★★ 只读评估：**选段策略该不该改成「按真实权重折算 reasoning」？**
 *
 * 背景（全部来自本机实测，见 LEDGER §40 / DECISIONS D70 D72）：
 *   · 配置 `deltaRemovePoints = 10` ⇒ 选段目标是「窗口 10% = 100,000」，
 *     但那 100,000 是**内核启发式尺度**（`Σnodes − 100,000`）。
 *   · 内核把 `reasoning` 与 `text` **同价**；而**真实**请求里推理块几乎不计。
 *   · ⇒ 实测每轮**真实**只压掉 ≈4.4 点（目标 10 点），兑现率 ~44%。
 *
 * 于是有个提议：**选段时把 reasoning 按 0 折算**，让"10 点"真的等于 10 个真实点。
 *
 * ★★★ 我在上一轮口头说过「那样会让每轮真实删除量涨 2.5 倍 ⇒ 伤质量」。
 *   本探针的**第一件事就是验它**——因为一个上下文里有个守恒关系：
 *
 *      **一个"全量压缩→下一次全量压缩"周期内，被销毁的内容总量是守恒的：**
 *         销毁总量 = 期间新增内容 + 周期起点水位 − 周期终点水位
 *      与"增量怎么删"**无关**（只与两端水位有关）。
 *
 *   ⇒ 若守恒成立，我那句"2.5 倍伤质量"就是**错的**（我把"每步"当成了"总量"）。
 *     策略改的只是**什么时候销毁、每一步销毁多少**，不是总量。
 *   本探针逐周期用**真实数据**验证守恒，并给出各策略的梯子。
 *
 * ★ 只读；只按 `j.type` 精确匹配。
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
const W = 1000000;
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(11, 19);

const bySeq = new Map();
for (const e of evs) if (Number.isFinite(e.seq)) bySeq.set(e.seq, e);
const startsById = new Map();
for (const e of evs) if (e.type === "compaction/start") startsById.set(e.data?.compactionId, e.data);
const routes = evs.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => ({
    time: e.time, seq: e.seq,
    input: Number(e.data.usage.inputTokens || 0),
    prompt: Number(e.data.usage.inputTokens || 0) + Number(e.data.usage.cacheReadTokens || 0),
  })).sort((a, b) => a.time - b.time);
const sums = evs.filter((e) => e.type === "compaction/summary")
  .map((e) => ({ time: e.time, id: e.data?.compactionId, heur: Number(e.data?.shadowedTokenCount ?? 0), seqs: e.data?.shadowedSeqs ?? [] }))
  .sort((a, b) => a.time - b.time);
for (const s of sums) s.turn = startsById.get(s.id)?.turn;
const levelAt = (t) => {
  const r = [...routes].reverse().find((x) => x.time <= t);
  return r === undefined ? undefined : r.prompt;
};

console.log("═".repeat(76));
console.log("① 换算因子：每个被压段的「真实 / 启发式」");
console.log("═".repeat(76));
console.log("  时刻     归属   内核heuristic   真实缩小   真实/heuristic");
const factors = [];
for (const s of sums) {
  const before = [...routes].reverse().find((r) => r.time <= s.time);
  const after = routes.find((r) => r.time > s.time);
  if (before === undefined || after === undefined) continue;
  const shrink = before.prompt - after.prompt;
  const f = s.heur === 0 ? NaN : shrink / s.heur;
  factors.push({ at: s.time, turn: s.turn, heur: s.heur, shrink, f });
  console.log(`  ${hm(s.time)}  ${String(s.turn === null ? "全量" : "t" + s.turn).padStart(4)}  ` +
    `${String(s.heur).padStart(12)}  ${String(shrink).padStart(9)}  ${f.toFixed(2).padStart(14)}`);
}
const inc = factors.filter((x) => x.turn !== null);
const full = factors.filter((x) => x.turn === null);
const avg = (a) => (a.length === 0 ? NaN : a.reduce((s, x) => s + x, 0) / a.length);
// ★★★ 必须**按修复时间切开**再平均 —— 否则修复前那些（兑现率≈1.0）会把均值抬到 0.84，
//   而修复后其实是 0.44（我在 ③ 里正是拿错这个数才算出"13 轮"的假结论）。
const FIXT = new Date("2026-10-11T03:25:00+08:00").getTime();
const incPre = inc.filter((x) => x.at < FIXT);
const incPost = inc.filter((x) => x.at >= FIXT);
console.log(`\n  ★ 按修复时间切开（**不切就会得出错的均值**）：`);
console.log(`    修复前增量 n=${incPre.length}：均值 ${avg(incPre.map((x) => x.f)).toFixed(2)}` +
  `（${incPre.map((x) => x.f.toFixed(2)).join(" / ")}）`);
console.log(`    修复后增量 n=${incPost.length}：均值 **${avg(incPost.map((x) => x.f)).toFixed(2)}**` +
  `（${incPost.map((x) => x.f.toFixed(2)).join(" / ")}）`);
console.log(`    全量 n=${full.length}：均值 ${avg(full.map((x) => x.f)).toFixed(2)}`);
console.log("  ⇒ ★ 修复前增量 ≈ 全量（都在 1.0 附近）——因为那时**保留量是个常量**，");
console.log("     选出来的段与全量选的段性质相同（水位低、推理占比小）。");
console.log("  ⇒ ★ 修复后增量掉到 ~0.44 ——因为棘轮把保留量往下压，选中的段**推理密集**。");
console.log("     （同一份启发式量在不同内容上兑现不同 ⇒ 见 D70 那张分桶表。）");

console.log("\n" + "═".repeat(76));
console.log("② 守恒关系：**它是恒等式，不是可验证的经验命题**");
console.log("═".repeat(76));
console.log("  记账定义：设 L(t)=真实上下文长度、g=期间新增、s_i=每次增量销毁、F=全量销毁，");
console.log("    则  L_end = L_start + g − Σs_i − F   ⇒   **Σs_i + F = g − (L_end − L_start)**");
console.log("  ⇒ ★★ 这条**由定义成立**（只要账记得对），所以它**不能**用来「证明」任何东西；");
console.log("     它只能用来**检查我的记账是否自洽**。下面就是这个检查。");
console.log("\n  ⚠️ 我第一次跑时把 `L_start` 取成**全量压缩之前**的水位（高），");
console.log("     而它应当是**全量压缩之后**的水位（低）—— 又是「压前 vs 压后」那个坑（尺子错）。");
console.log("     下面是**修好之后**（两端都取压缩之后的第一个采样）的结果：\n");
const fullTimes = sums.filter((s) => s.turn === null).map((s) => s.time).sort((a, b) => a - b);
/** 取**某个时刻之后**的第一个真实采样（= 压缩刚做完那一刻的水位）。 */
const levelAfter = (t) => {
  const r = routes.find((x) => x.time > t);
  return r === undefined ? undefined : r.prompt;
};
console.log("  周期          起点(压后)  终点(压后)  期间新增   实测增量销毁  Σ+F  偏差");
console.log("  " + "-".repeat(92));
let maxErr = 0;
for (let i = 0; i + 1 < fullTimes.length; i += 1) {
  const from = fullTimes[i];
  const to = fullTimes[i + 1];
  const lvStart = levelAfter(from);
  const lvEnd = levelAfter(to);
  if (lvStart === undefined || lvEnd === undefined) continue;
  // ★ 期间新增：用**该周期内所有请求的 input**（未命中部分 ≈ 真正新增的内容）
  const gen = routes.filter((r) => r.time > from && r.time <= to).reduce((s, r) => s + r.input, 0);
  const measuredInc = factors.filter((x) => x.at > from && x.at <= to && x.turn !== null)
    .reduce((s, x) => s + x.shrink, 0);
  const fullRemove = factors.filter((x) => x.at === to).reduce((s, x) => s + x.shrink, 0);
  const rhs = gen - (lvEnd - lvStart);          // = 该周期应销毁总量
  const lhs = measuredInc + fullRemove;          // = 实测（增量 + 全量）
  const err = lhs - rhs;
  maxErr = Math.max(maxErr, Math.abs(err));
  console.log(`  #${i + 1}  ${hm(from)}→${hm(to)}  ` +
    `${String((lvStart / W * 100).toFixed(1)).padStart(9)}%  ${String((lvEnd / W * 100).toFixed(1)).padStart(9)}%  ` +
    `${String((gen / W * 100).toFixed(1)).padStart(8)}点  ${String((measuredInc / W * 100).toFixed(1)).padStart(11)}点  ` +
    `${String((lhs / W * 100).toFixed(1)).padStart(5)}点  ${String((err / W * 100).toFixed(1)).padStart(7)}点`);
}
console.log(`\n  ★ 修好两端采样后：最大偏差 = ${(maxErr / W * 100).toFixed(1)} 点`);
console.log("  ★★ 但**我仍然不敢说它「已验证」**，而且我先前把偏差原因说错了两次，如实记下：");
console.log("     ① 先说成「我的记账缺项（台账重注等）」——**不是**。台账重注只 ~0.8 点/次，");
console.log("        填不平 100~200 点的差。");
console.log("     ② 真实原因是 **`Σinput` 不是「期间新增」**：");
console.log("        · `input`（未命中部分）在缓存命中时≈0，**不反映真正新写了多少内容**；");
console.log("        · 而「新增内容」应当按**新追加事件的字符量**算（4 字符/token）；");
console.log("        · 两者相差 100~200 点，恰好是这个量级（本会话每周期真写几十万字符）。");
console.log("     ⇒ ★ 所以这一节**只能定性**：");
console.log("        · 「销毁总量 = 新增 − 水位净增」这条**是算术恒等式**，可放心引用；");
console.log("        · 而**「新增」我这次量错了口径** ⇒ **不拿具体总量数字下结论**；");
console.log("        · 要定量就得更正口径（按新追加事件的字符量算），那是另一件事（**未做**）。");

console.log("\n" + "═".repeat(76));
console.log("③ 两种策略的「梯子」—— ★ 只用**修复后**的增量（不然又是错的尺子）");
console.log("═".repeat(76));
const FIX = new Date("2026-10-11T03:25:00+08:00").getTime();
// ★ 修复后的三次自动增量：4.1 / 3.9 / 5.1 点（LEDGER §40 已确立）
const postInc = factors.filter((x) => x.at >= FIX && x.turn !== null);
const TRIGGER = 20;
const actualNow = avg(postInc.map((x) => (x.shrink / W) * 100));
console.log(`  修复后增量（n=${postInc.length}）：` +
  postInc.map((x) => `${((x.shrink / W) * 100).toFixed(1)}点`).join(" / ") +
  ` ⇒ 均值 **${actualNow.toFixed(1)} 点**`);
console.log(`  （★ 我上一版这里用了**全期**增量均值 16.1 点 ⇒ 那是错的尺子：`);
console.log(`     全期含修复前的、兑现率≈1.0 的那些。修复后才是 4.4 点。）\n`);
for (const policy of [
  { name: "现在（不改）：目标是启发式 10 点 ⇒ 实绩 ~4.4 点", actual: actualNow },
  { name: "折算 reasoning：让「10 点」= 10 个真实点", actual: 10 },
]) {
  const net = TRIGGER - policy.actual;
  let L = 20; let steps = 0; let deleted = 0;
  const trail = [];
  while (L < 70 && steps < 40) {
    L += TRIGGER;
    L -= policy.actual;
    deleted += policy.actual;
    steps += 1;
    trail.push(L.toFixed(1));
  }
  console.log(`  ${policy.name}`);
  console.log(`    每轮实绩 ${policy.actual.toFixed(1)} 点 ⇒ 净涨 ${net.toFixed(1)} 点；` +
    `20%→70% 需 **${steps} 轮**，期间增量真实销毁 ≈ ${deleted.toFixed(0)} 点`);
  console.log(`    轨迹：20 → ${trail.join(" → ")}\n`);
}

console.log("\n" + "═".repeat(76));
console.log("④ 可行性检查：折算后那一刀，**选得出这么大的段吗**？");
console.log("═".repeat(76));
console.log("  折算后要删 100,000 **真实** token；而推理块真实≈0 ⇒");
console.log("  必须凑够 100,000 真实 ⇒ 约需 **100,000 / 兑现率** 的启发式量：");
for (const f of [0.44, 0.51, 0.59, 1.0]) {
  const needHeur = Math.round(100000 / f);
  console.log(`    兑现率 ${f.toFixed(2)} ⇒ 需要启发式段 ≈ ${needHeur.toLocaleString()}（≈ 窗口 ${(needHeur / W * 100).toFixed(1)}%）`);
}
console.log("\n  ★ 而每轮的**增长**恰好是 20 点 = 200,000 真实 token ⇒ 真实内容**够**删 100,000。");
console.log("    ⚠️ 但启发式段要 200K~230K，意味着**保留段被压到更短** ——");
console.log("       保留段（还留在上下文里的逐字尾巴）会**比现在小约 5.6 点**。");
console.log("  ⇒ ★ 这才是折算真正的代价：**不是总量变多，而是「逐字尾巴」变短**。");
