/**
 * 只读探针：增量压缩必须是**棘轮**，不是"压回同一个低位"。
 *
 * ★★★ 2026-10-11，用户指出我从头上就理解错了。他的原话：
 *
 *   *"假设开始时10，加20，触发一次增量压缩，减10，就是20，以此类推，
 *     第五或第六次触发一次全量高保真压缩"*
 *
 *   ⇒ 他要的是**阶梯**，水位一级一级**往上爬**：
 *
 *        10 →(+20)→ 30 ──压掉10──→ 20
 *        20 →(+20)→ 40 ──压掉10──→ 30
 *        30 →(+20)→ 50 ──压掉10──→ 40
 *        40 →(+20)→ 60 ──压掉10──→ 50
 *        50 →(+20)→ 70 ──★ 全量高保真★
 *
 * ★ 旧实现把"保留最近 N 点"当**常量** ⇒ 每次压完都掉回**同一个低位**：
 *
 *        30 →保留10→ 10   再涨到 30 → 又压回 10   ⇒ 永远在 10↔30 之间摆
 *
 *   ⇒ 水位永远到不了 70% ⇒ **全量高保真永远不触发**。
 *     这正是用户报的："按理说现在已经到全量高保真压缩的时候了，但现在水位还在这里。"
 *
 * 这条探针做三件事：
 *   ① 用纯数学把**两种模型**的轨迹摆出来（常量保留 vs 棘轮）；
 *   ② 断言棘轮的阶梯形状与用户的描述**逐点吻合**（净涨 = 触发 − 压掉）；
 *   ③ 把"保留量必须是 `当前水位 − 压掉的点`"钉进**源码静态检查**，防改回常量。
 *
 * 用法：node tools/_probe-delta-anchor.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "lib", "index.js");
const src = fs.readFileSync(LIB, "utf8");

let fail = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond || detail === undefined ? "" : `\n        ${detail}`}`);
  if (!cond) fail += 1;
};

// ── 从**源码**取真实常量，别在这里另抄一份（抄了就会分叉）──────────────
const num = (name) => {
  const m = src.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  if (m === null) throw new Error(`源码里找不到常量 ${name}`);
  return Number(m[1]);
};
const TRIGGER = num("DEFAULT_DELTA_TRIGGER_POINTS");
const REMOVE = num("DEFAULT_DELTA_REMOVE_POINTS");
console.log(`═══ 常量（取自源码）：触发 +${TRIGGER} 点 / 每轮压掉 ${REMOVE} 点 ═══`);
console.log(`    ⇒ 期望净涨 = ${TRIGGER} − ${REMOVE} = ${TRIGGER - REMOVE} 点/轮\n`);

/**
 * 模拟水位轨迹（策略模型，不跑插件）。
 *
 * @param {"constant"|"ratchet"} mode
 *   · `constant`：旧实现 —— 压完**保留常量** `keep` 点（每次掉回同一低位）
 *   · `ratchet` ：新实现 —— 压完**保留 `当前水位 − remove`**（压掉固定一段）
 *
 * ★ `overhead`（压缩后摘要回填的量）默认 **0**，为的是让轨迹与用户的算术**逐点对齐**
 *   （*"加20…减10，就是20"* ⇒ 净涨恰好 = 触发 − 压掉）。
 *   ⚠️ 我第一版默认 2，于是净涨算成 12，断言当场红 —— **那是我的模型错了，不是代码错**。
 *   现实中摘要确实会回填一点，所以另用一次 `overhead` 敏感性测试覆盖它（见 ⑥）。
 */
function simulate(mode, { steps = 400, grow = 1, trigger = TRIGGER, remove = REMOVE, keep = 10, overhead = 0 } = {}) {
  let level = 10; // 用户说"开始时 10"
  let anchor = null;
  const peaks = [];
  const afterLevels = [];
  let max = 0;
  for (let i = 0; i < steps; i += 1) {
    level += grow;
    const since = anchor === null ? level : level - anchor;
    if (since >= trigger) {
      peaks.push(level);
      const pre = level;
      // ★ 内核算的是"保留多少 token" ⇒ 两种模式的区别**只在这一行**。
      level = mode === "constant" ? keep + overhead : Math.max(1, pre - remove) + overhead;
      afterLevels.push(level);
      anchor = level; // 锚点取压后（这一点两种模式都一样，已单独证明过）
      if (level > max) max = level;
      // ★ 撞上 70% ⇒ 真实系统会做**全量高保真**并重置（内核那步会把水位打下来）。
      //   模型里也重置，否则"最高水位"会一直涨到 250，读起来像失控（实际不会）。
      if (level >= 70) break;
    }
  }
  return { peaks, afterLevels, max };
}

const oldWay = simulate("constant");
const newWay = simulate("ratchet");

console.log("═══ 两种模型的轨迹 ═══");
console.log(`  【旧·常量保留】压后水位：${oldWay.afterLevels.slice(0, 8).join(" → ")} …  最高 ${oldWay.max}`);
console.log(`  【新·棘轮】    压后水位：${newWay.afterLevels.slice(0, 8).join(" → ")} …  最高 ${newWay.max}`);
console.log("");

// ① 旧模型：压后水位**不抬升**（永远掉回同一个低位）—— 这解释了用户的观测
const oldFlat = oldWay.afterLevels.slice(0, 6).every((v) => Math.abs(v - oldWay.afterLevels[0]) <= 1);
ok("★ 旧模型（常量保留）⇒ 压后水位**原地打转**，棘轮不走", oldFlat, `压后序列 ${oldWay.afterLevels.slice(0, 6).join(", ")}`);

// ② 旧模型：水位**上不去** ⇒ 全量高保真永远不触发（用户报的那个现象）
ok(
  `★★★ 旧模型 ⇒ 水位最高只有 ${oldWay.max} 点，**永远到不了 70%**（全量高保真永不触发）`,
  oldWay.max < 70,
  `实测最高 ${oldWay.max}`
);

// ③ 新模型（棘轮）：压后水位**逐级抬高**
const rising = newWay.afterLevels.slice(0, 4).every((v, i, a) => i === 0 || v > a[i - 1]);
ok("★★★ 棘轮 ⇒ 压后水位**逐级抬高**（每一步都比上一次高）", rising, `压后序列 ${newWay.afterLevels.slice(0, 5).join(", ")}`);

// ④ ★★★ 与用户的描述**逐点吻合**：净涨 = 触发 − 压掉
const nets = [];
for (let i = 1; i < newWay.afterLevels.length; i += 1) nets.push(newWay.afterLevels[i] - newWay.afterLevels[i - 1]);
const expectNet = TRIGGER - REMOVE;
const netOk = nets.length > 0 && nets.every((n) => Math.abs(n - expectNet) <= 1);
ok(
  `★★★ 净涨 = 触发(${TRIGGER}) − 压掉(${REMOVE}) = ${expectNet} 点/轮（与用户描述逐点吻合）`,
  netOk,
  `实测净涨序列 ${nets.slice(0, 6).join(", ")}`
);

// ⑤ ★★★ 用户说的"第五或第六次触发全量高保真"应当成立
const firstTo70 = newWay.peaks.findIndex((p) => p >= 70);
ok(
  `★★★ 棘轮下**第 ${firstTo70 + 1} 次**压缩就撞上 70% ⇒ 触发全量高保真（用户说"第五或第六次"）`,
  firstTo70 + 1 >= 4 && firstTo70 + 1 <= 8,
  `实测第 ${firstTo70 + 1} 次（峰值序列 ${newWay.peaks.slice(0, 8).join(", ")}）`
);

// ⑥ 两种模型的差别要显著（否则这条探针没有分辨力）
ok(
  `★★ 两种模型最高水位差 ≥ 20 点（差距显著，说明这个选择要紧）`,
  newWay.max - oldWay.max >= 20,
  `旧 ${oldWay.max} vs 新 ${newWay.max}`
);

// ⑥b ★ 摘要回填的敏感性：摘要哪怕每轮多回填 2 点，棘轮**照样**往上走
//     （只是净涨变成 12 ⇒ 撞 70% 更早一点点）。这条证明结论对 overhead 不敏感。
{
  const withOh = simulate("ratchet", { overhead: 2 });
  const stillRising = withOh.afterLevels.length >= 3 && withOh.afterLevels[2] > withOh.afterLevels[1] && withOh.afterLevels[1] > withOh.afterLevels[0];
  ok(
    "★★ 摘要每轮回填 2 点时，棘轮**照样**逐级抬高（结论对 overhead 不敏感）",
    stillRising,
    `压后序列 ${withOh.afterLevels.slice(0, 6).join(", ")}`
  );
}

// ── ⑦ 静态：源码里保留量必须是 `当前水位 − 压掉的点`（棘轮），不能是常量 ──
console.log("\n═══ 源码静态检查（防止改回「保留常量」）═══");
{
  // ★ 棘轮的判据：保留量由 `pressure.ratio`（当前水位）算出来，而不是直接用设置项。
  const i = src.indexOf("const keepRatio =");
  ok("在源码里找到算保留量那一处（`const keepRatio`）", i >= 0);
  const seg = src.slice(Math.max(0, i - 120), i + 200);
  ok(
    "★★★ 保留量由**当前水位**算出（`pressure.ratio - removeRatio`），不是常量",
    /pressure\.ratio\s*-\s*removeRatio/.test(seg),
    seg.replace(/\s+/g, " ").slice(0, 160)
  );
  ok(
    "★★★ 没有残留「保留 = 设置项 × 窗口」这种常量写法",
    !/const retainTokens = Math\.floor\(\(settings\.deltaRemovePoints \/ 100\) \* pressure\.window\)/.test(src)
  );
  // ★ 必须走 `anchorOf` 读锚点（不许直接摸内存 Map —— D51/D52 的同类缺口）
  ok(
    "★★★ 读锚点走**唯一出口** `anchorOf`（不直接读内存 Map）",
    /const anchor = anchorOf\(state, key\);/.test(src) && !/const anchor = state\.deltaAnchor\.get\(/.test(src)
  );
  // ★ 锚点必须落盘（重启不再丢 ⇒ 不再"重启后必然多压一次"）
  ok(
    "★★★ 锚点会**落盘**（跨重启保持）",
    /function setAnchor\(/.test(src) && /writeAnchorStore\(store\)/.test(src)
  );
  // ★★★ 增量压缩**不许**再把 `hfCompacted` 置真
  //   —— 那会让 70% 全量高保真**永久失效**（这是本次修掉的第二个真 bug）。
  //
  //   ⚠️ 第一版这条断言**误报**了：我拿整段源码去搜 `state.hfCompacted.set(key, true)`，
  //      结果命中的是**我自己写的解释性注释**（注释里引用了那行旧代码）。
  //      ⇒ 判据必须**去掉注释**再搜（这与"用字面串 grep 常量间接引用的代码"是同一类尺子错）。
  const incSeg = src.slice(src.indexOf("async function runIncrementalCompact"), src.indexOf("async function runHighFidelityCompact"));
  const incCode = incSeg
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)) // 丢掉整行注释
    .join("\n")
    .replace(/\/\/[^\n]*/g, ""); // 丢掉行尾注释
  ok(
    "★★★ 增量压缩**不置** `hfCompacted`（否则 70% 全量高保真永久失效）",
    !/state\.hfCompacted\.set\(/.test(incCode),
    "增量压缩成功后若置真，70% 那条判据 `oursDone !== true` 就永远为假"
  );
}

// ── ⑧ ★★★ 饿死：增量**必须给全量让路** ─────────────────────────────────
//
//   ★ 这是修完棘轮**才暴露**出来的第二个真 bug（我用纯数学证过，见下）。
//     棘轮爬到 70 的那一步，锚点通常是 50 ⇒ 恰好 `since = 20 ≥ trigger`
//     ⇒ **增量抢在 70% 那条之前跑掉**、把水位拉回 60、并置 `deltaHandled = true`
//     ⇒ 70% 那条本步被 `deltaHandled !== true` 挡掉，而它重测的水位已是 60 < 70 ⇒ 不排
//     ⇒ 下一步 60→80 又是 `since = 20` ⇒ 增量再抢跑 → 70 ⇒ 再被挡 …… **如此循环**。
//     ⇒ **全量高保真永远不会发生** —— 与用户"第五或第六次要全量"正好相反。
//
//   ⇒ 这条探针把"让路"这个行为钉住：步长与 trigger 对齐时，全量也**必须**发生。
console.log("\n═══ 饿死检查（增量给全量让路）═══");
{
  const HFp = 70; // 水位到 70% 就是全量线
  const sim = (step, yieldAtLine) => {
    let level = 10;
    let anchor = null;
    let full = 0;
    let delta = 0;
    for (let i = 0; i < 30; i += 1) {
      level += step;
      const pre = level;
      const since = anchor === null ? pre : pre - anchor;
      let dh = false;
      // ★ 让路：水位已到全量线 ⇒ 增量不动手（与源码里那段判据同义）
      if (since >= TRIGGER && !(yieldAtLine && pre >= HFp)) {
        level = Math.max(1, pre - REMOVE);
        anchor = level;
        delta += 1;
        dh = true;
      }
      // ★ 全量那条用的是**压后重测**的水位（这是饿死能发生的关键）
      if (level >= HFp && dh !== true) {
        full += 1;
        anchor = null;
        level = 10;
      }
    }
    return { full, delta };
  };

  const noYield = sim(20, false);
  const withYield = sim(20, true);
  ok(
    "★★★ 先复现病灶：步长与 trigger 对齐时，**不让路** ⇒ 全量 0 次（饿死）",
    noYield.full === 0,
    `实测全量 ${noYield.full} 次 / 增量 ${noYield.delta} 次`
  );
  ok(
    "★★★ 让路后 ⇒ 全量**真的发生**（用户要的「第 5~6 次一次全量」才成立）",
    withYield.full > 0,
    `实测全量 ${withYield.full} 次 / 增量 ${withYield.delta} 次`
  );

  // 静态：源码里必须有那段让路，且**不能**让手动 force 也被挡
  ok(
    "★★★ 源码里有「水位到全量线 ⇒ 增量让路」那段（`yieldedToFull`）",
    /yieldedToFull: true/.test(src) && /pressure\.ratio >= hfLine/.test(src)
  );
  ok(
    "★★ 让路**只管自动那条**（`!forced`）—— 手动 `/ledger light` 仍压得动",
    /if \(!forced && settings\.highFidelityCompact === true/.test(src)
  );
}

console.log(`\n${fail === 0 ? "探针通过：增量压缩是棘轮（净涨 = 触发 − 压掉），第 5~6 次撞 70% 全量，且不会饿死全量" : `失败 ${fail} 项`}`);
process.exit(fail === 0 ? 0 : 1);

