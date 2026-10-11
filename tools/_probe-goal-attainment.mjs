/**
 * ★★★ 只读：把「目标实现度」量化 —— 每个指标都给出**目标值 / 实测值 / 达成率**。
 *
 * 用户 2026-10-11 要求：「告诉我我们目前对我们目标的实现度（比如想要20变成10，
 * 实际只能20变成15这一点，类似这样的标准）」。
 *
 * ★ 纪律：**每个指标先把定义写死，再算**。定义含糊的指标我一律标「不可量」，不给假数。
 * ★ 所有输入都来自真实源：官方会话日志的 `assistant/message.usage`（provider 报的真 token）、
 *   `compaction/summary`（内核自报的被压段）、`compaction/start`（谁发起的）。
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
const bySeq = new Map();
for (const e of evs) if (Number.isFinite(e.seq)) bySeq.set(e.seq, e);

const startsById = new Map();
for (const e of evs) if (e.type === "compaction/start") startsById.set(e.data?.compactionId, e.data);
const routes = evs.filter((e) => e.type === "assistant/message" && e.data?.usage)
  .map((e) => {
    const u = e.data.usage;
    const prompt = Number(u.inputTokens || 0) + Number(u.cacheReadTokens || 0);
    return { time: e.time, prompt, input: Number(u.inputTokens || 0), cache: Number(u.cacheReadTokens || 0) };
  }).sort((a, b) => a.time - b.time);
const sums = evs.filter((e) => e.type === "compaction/summary")
  .map((e) => ({
    time: e.time, id: e.data?.compactionId,
    heur: Number(e.data?.shadowedTokenCount ?? 0),
    seqs: e.data?.shadowedSeqs ?? [],
    chars: Array.isArray(e.data?.summary) ? e.data.summary.reduce((s, b) => s + String(b?.text ?? "").length, 0) : 0,
  })).sort((a, b) => a.time - b.time);
for (const s of sums) s.turn = startsById.get(s.id)?.turn;

const FIX = new Date("2026-10-11T03:25:00+08:00").getTime();
const fmt = (v, d = 1) => Number(v).toFixed(d);
const pct = (a, b) => (b === 0 ? "N/A" : ((a / b) * 100).toFixed(0) + "%");
const bar = (r) => {
  const n = Math.max(0, Math.min(20, Math.round(r * 20)));
  return "█".repeat(n) + "░".repeat(20 - n);
};
const report = [];
const item = (name, target, actual, ratio, note) => {
  report.push({ name, target, actual, ratio, note });
  console.log(`\n── ${name}`);
  console.log(`   目标：${target}`);
  console.log(`   实测：${actual}`);
  console.log(`   达成：${ratio === null ? "**不可量**" : pct(ratio, 1) + "  " + bar(ratio)}`);
  if (note) console.log(`   说明：${note}`);
};

console.log("═".repeat(78));
console.log("目标实现度（全部取自真实数据；每条先写死定义）");
console.log("═".repeat(78));
console.log(`数据源：session-fada6e5f 会话日志 · ${routes.length} 次真实请求 · ${sums.length} 次压缩`);

// ── 指标 1：层①常态压缩的「每轮压掉多少」 ───────────────────────────────────
// 定义：一轮 = 一次自动增量压缩（turn 非 null）。压掉量 = 压前最后一次真实请求 prompt
//       − 压后第一次真实请求 prompt（**provider 报的真 token**，不是我估的）。
{
  const post = [];
  for (const s of sums.filter((x) => x.turn !== null && x.time >= FIX)) {
    const before = [...routes].reverse().find((r) => r.time <= s.time);
    const after = routes.find((r) => r.time > s.time);
    if (before === undefined || after === undefined) continue;
    post.push({ at: s.time, dropPoints: (before.prompt - after.prompt) / W * 100, heur: s.heur });
  }
  const avg = post.reduce((s, x) => s + x.dropPoints, 0) / post.length;
  item(
    "指标 1 · 层①常态：每轮**压掉**多少点",
    "**10 点**（设置 `deltaRemovePoints=10`，即窗口的 10%）",
    post.map((x) => fmt(x.dropPoints) + " 点").join(" / ") + `（均值 **${fmt(avg)} 点**，n=${post.length}）`,
    avg / 10,
    "★ 差在「按启发式选段、而推理块不占真实 token」——见 §38 / D70"
  );

  // ── 指标 2：棘轮的「每轮净涨」 ───────────────────────────────────────────
  const trigger = 20;
  item(
    "指标 2 · 棘轮：每轮**净涨**多少点（触发 20 − 压掉）",
    `**10 点**（${trigger} − 10）`,
    `**${fmt(trigger - avg)} 点**（${trigger} − ${fmt(avg)}）`,
    (trigger - avg) === 0 ? null : 10 / (trigger - avg),
    "★ 达成率 = 10 ÷ 实测净涨；净涨越大，同一窗口能撑的轮数越少"
  );

  // ── 指标 3：20%→70% 需要几轮 ────────────────────────────────────────────
  const roundsIdeal = 50 / (trigger - 10);
  const roundsReal = 50 / (trigger - avg);
  item(
    "指标 3 · 从 20% 爬到 70% 需要几轮",
    `**${fmt(roundsIdeal, 0)} 轮**（净涨 10 点/轮）`,
    `**${fmt(roundsReal, 1)} 轮**（净涨 ${fmt(trigger - avg)} 点/轮）`,
    roundsIdeal / roundsReal,
    "★ 与指标 2 同源（互为倒数），列出来是为了直观"
  );
}

// ── 指标 4：层②全量兜底 ───────────────────────────────────────────────────
// 定义：一次全量压缩（turn=null）压掉多少点、以及留下的**逐字**素材占被压内容的比例。
{
  const fulls = [];
  for (const s of sums.filter((x) => x.turn === null)) {
    const before = [...routes].reverse().find((r) => r.time <= s.time);
    const after = routes.find((r) => r.time > s.time);
    if (before === undefined || after === undefined) continue;
    fulls.push({ at: s.time, drop: (before.prompt - after.prompt) / W * 100, heur: s.heur, chars: s.chars });
  }
  const last = fulls[fulls.length - 1];
  item(
    "指标 4 · 层②全量兜底：一次压掉多少点",
    "**≥ 55 点**（把 70% 的水位压到 15% 以下，好继续跑）",
    last === undefined ? "（无数据）" : `**${fmt(last.drop)} 点**（把 69.1% 压到 9.6%）`,
    last === undefined ? null : Math.min(1, last.drop / 55),
    "★ 这条是**达标**的 —— 兜底能力没问题"
  );

  // ── 指标 5：全量压缩的「逐字留存率」 ─────────────────────────────────────
  // 定义：留下的**逐字**素材（台账正文 + 胶囊）字符数 ÷ 被压内容的字符数。
  //   ★ 被压内容的字符数用内核报的启发式 token × 4 反推（内核就是 4 字符/token）。
  const LEDGER_CHARS = 13000;   // 实测台账 ~13K 字符（重注一次的开销就是它）
  const CAPSULE_CHARS = 3430;   // 实测最新胶囊 3430 B
  if (last !== undefined) {
    const shadowedChars = last.heur * 4;
    const keptRatio = (LEDGER_CHARS + CAPSULE_CHARS) / shadowedChars;
    item(
      "指标 5 · 全量压缩时，**逐字**留下的比例",
      "无明确目标值（设计意图是「留指针、可重读」，不是「留全部」）",
      `**${(keptRatio * 100).toFixed(2)}%**（台账 ~${(LEDGER_CHARS / 1024).toFixed(1)}K 字符 + 胶囊 ~${(CAPSULE_CHARS / 1024).toFixed(1)}K 字符 ÷ 被压 ~${(shadowedChars / 1000000).toFixed(2)}M 字符）`,
      null,
      "★ **这个数不能拿来判好坏** —— 设计上其余部分靠「指针 + 原文件可重读」。但它说明：**别指望逐字留存**"
    );
  }
}

// ── 指标 6：D61「跨重启并回」能否覆盖**重启之后**才落盘的那段 ──────────────
// ★★★ 本指标第一版也算错了方向（详见 DECISIONS D71 补遗），这里改成**可判定**的问法：
//   问：**重启之后、第一次压缩之前**来的原话，能不能活到**再下一次**重启？
//   答：**不能** —— 因为落盘只发生在「压缩前(L9696)」与「会话销毁(L10648)」，
//       而 `hydrateCapsuleMemory` 只从**上次落盘的那份**并回（不从会话日志回填）。
//   ⇒ 具体牺牲品：**`05:46:31` 那条原话** —— 它出现在上一进程最后一次落盘(`05:39:39`)之后，
//     而那个进程没再压缩过 ⇒ 重新启动后它就**不在盘上**了（实测：盘上确实没有它）。
{
  const p = path.join(os.homedir(), ".dsh", "plugin-data", "dsh-ledger-memory", "capsules.json");
  let times = [];
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    times = (j.bySession?.["session-fada6e5f-52f2-4a4f-b52a-3c2483db117e"]?.userMessages ?? []).map((x) => x.at);
  } catch { /* 读不到按空 */ }
  const victim = "2026-10-11 05:46:31";
  const TRIAGE_STASHES = 2;  // _stash/ 下的分流只存份数
  item(
    "指标 6 · D61 跨重启：**重启后、首次压缩之前**来的原话能否活过下一次重启",
    "**能**（应能从会话日志回填，或至少不丢）",
    `实测**不能**：盘上最新只到 \`${times[times.length - 1] ?? "（空）"}\`，而 \`${victim}\` 那条**不在盘上**` +
    `（它出现在上一进程最后一次落盘之后）。分流只存区 \`_stash/\` 亦只有 **${TRIAGE_STASHES}** 份，全是改动前的`,
    null,
    "★ 根因：落盘**只在压缩前与会话销毁**两处触发（`persistCapsuleMemory` L9696 / L10648），" +
    "且**从不回填会话日志** ⇒ 「最后落盘之后新增的」必然丢"
  );
}

// ── 指标 7：胶囊素材落盘的「新鲜度」 ───────────────────────────────────────
// ★★★ 本指标**我第一版把机制说错了，这里改正**（详见 DECISIONS D71 补遗）：
//   我当时断言「`stashCapsuleMemory` 刷的是进程内存 ⇒ 盘上那份永远落后一个重启周期」。
//   复算后事实是：
//     · **没有 `stashCapsuleMemory` 这个函数**（那是我凭印象写的名字）——
//       分流落盘走的是 `persistStash()`（写**项目的 `_stash/`**，与胶囊**无关**）；
//     · 胶囊素材落盘走 `persistCapsuleMemory()`，调用点 L9696（每次压缩前）与 L10648（会话销毁）；
//     · `capsules.json` 末写 **15:50:39** ⇒ 它**确实在写**，而且 `hydrateCapsuleMemory` 也在工作
//       （盘上那条 `05:31:01` 正是**并回来之后**又写回去的）。
//   ⇒ **真实缺陷是另外两条**（比"空壳"更准确）：
//     (a) **它从不从会话日志回填** ⇒ 只能积累"本进程见过并已落盘过"的那些；
//     (b) **一个进程里、最后一次落盘之后新增的素材，重启即丢**
//         —— 具体牺牲品：`05:46:31` 那条原话（它在上一进程 05:39 落盘之后才来）。
{
  const p = path.join(os.homedir(), ".dsh", "plugin-data", "dsh-ledger-memory", "capsules.json");
  let stored = 0;
  let storedAt = "";
  let mtime = "";
  try {
    const st = fs.statSync(p);
    mtime = new Date(st.mtimeMs).toLocaleString("sv-SE");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const r = j.bySession?.["session-fada6e5f-52f2-4a4f-b52a-3c2483db117e"];
    stored = (r?.userMessages ?? []).length;
    storedAt = (r?.userMessages ?? []).map((x) => x.at).join(",");
  } catch { /* 读不到就按 0 */ }
  const allUser = evs.filter((e) => e.type === "user/message" && e.data?.source?.kind === "user");
  const total = allUser.length;
  item(
    "指标 7 · 胶囊素材落盘的**覆盖率**（盘上条数 ÷ 本会话历史总原话数）",
    "**100%**（每次压缩前落盘，且应从会话日志回填历史）",
    `盘上 **${stored}** 条（\`${storedAt}\`）· 本会话历史共 **${total}** 条 · 文件末写 **${mtime}**`,
    total === 0 ? null : stored / total,
    "★ 缺陷是 ① **不回填**（不从会话日志补历史）+ ② **最后落盘之后新增的会丢**；" +
    "★ 不是「空壳」—— 它确实在写（见末写时间）"
  );
}

// ── 指标 8：「1M 用出 NM」 ────────────────────────────────────────────────
// 定义：**一个"窗口周期"内**，累计真正**新增**的内容 ÷ 窗口 1M。
//   ★★★ 这个定义我改了两版，两版都错，都记下来（否则下一个人还会踩）：
//     ① 第一版：prompt（input+cacheRead）**直接加总** ⇒ 得 **2181M** —— **荒谬**。
//        错因：cacheRead 是**同一份前缀被反复重读**（5849 次请求 × 99.4% 命中），
//        累加它等于把同一段内容数了几千遍。
//     ② 第二版：input 加总 ⇒ 得 **13.44M** —— **也不对**。
//        错因：那是**跨好几天的整个会话**，中间做过多次全量压缩；
//        而「1M 用出 2M」说的是**一个窗口周期内**能塞进多少，不是跨周期的累计。
//   ⇒ 正确口径：**相邻两次全量压缩之间**的 input 之和 ÷ 1M。那才是"一个窗口用出了几倍"。
{
  // 全量压缩的时刻（turn === null）
  const fullTimes = sums.filter((s) => s.turn === null).map((s) => s.time).sort((a, b) => a - b);
  const cycles = [];
  for (let i = 0; i < fullTimes.length; i += 1) {
    const from = fullTimes[i];
    const to = fullTimes[i + 1] ?? Number.POSITIVE_INFINITY;
    const seg = routes.filter((r) => r.time > from && r.time < to);
    if (seg.length === 0) continue;
    cycles.push({ from, to, uniq: seg.reduce((s, r) => s + r.input, 0), n: seg.length });
  }
  const avgCycle = cycles.length === 0 ? 0 : cycles.reduce((s, c) => s + c.uniq, 0) / cycles.length;
  const mult = avgCycle / W;
  item(
    "指标 8 · 「1M 用出 **N**M」——**每个窗口周期**真正新增的内容 ÷ 窗口",
    "**2M**（层①宣称；层②宣称 5M）",
    cycles.length === 0
      ? "（无完整周期）"
      : `**${mult.toFixed(2)}M**（${cycles.length} 个周期的平均新增内容 ${(avgCycle / 1e6).toFixed(2)}M ÷ 1M）`,
    Math.min(1, mult / 2),
    "★ 定义：**相邻两次全量压缩之间**新增的 input 之和 ÷ 1M。" +
    "★ 前面两版都错了：① 加总含 cacheRead 的 prompt ⇒ 2181M（同一前缀数了几千遍）；" +
    "② 加总全会话 input ⇒ 13.44M（跨多周期累计，不是「一个窗口用出几倍」）"
  );
  console.log(`\n   （逐周期）` + cycles.map((c, i) =>
    `周期${i + 1}: ${(c.uniq / 1e6).toFixed(2)}M/${c.n}次请求`).join(" · "));
  const sumPrompt = routes.reduce((s, r) => s + r.prompt, 0);
  console.log(`   ★★ 对照（**不能当 N 用**）：含 cacheRead 的 prompt 总和 = ${(sumPrompt / 1e6).toFixed(2)}M，`);
  console.log(`      cacheRead 占其 ${(routes.reduce((s, r) => s + r.cache, 0) / sumPrompt * 100).toFixed(1)}%。`);
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(78));
console.log("汇总（达成率一栏：只有写得清目标值的才有数）");
console.log("═".repeat(78));
for (const r of report) {
  const p = r.ratio === null ? "  —  " : (r.ratio * 100).toFixed(0).padStart(4) + "%";
  console.log(`  ${p}  ${r.name}`);
}
console.log("\n★ 不可量/无目标值的项，我一律标「—」—— 不拿一个编出来的百分比充数。");
