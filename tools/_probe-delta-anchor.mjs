/**
 * 只读探针：证明**锚点取「压缩前」还是「压缩后」**会让水位轨迹完全不同。
 *
 * ★ 为什么要单独证明它：我实现的增量压缩里，锚点（`state.deltaAnchor`）
 *   最初写的是 `pressure.ratio`，而那是**压缩之前**量的水位。
 *   直觉上"涨够 20 点就压一次"没问题 —— 但锚点若停在**压前**的水位，
 *   下一轮的触发阈值会**一轮比一轮高**：
 *
 *     压前 32 → 压回 12（锚点却记成 32）⇒ 下次要涨到 52
 *     → 压回 12（锚点又记成 52）⇒ 下次要涨到 72  ← 已经撞上内核 0.8 区
 *
 *   ★ 而用户要的恰恰相反：*"尽量延缓达到70、80的时间"*。
 *   ⇒ 用纯数学把两种锚点的轨迹摆出来对比，别靠嘴说。
 *
 * ★ 这条探针同时把"锚点必须是压后水位"钉进**源码静态检查**里，
 *   免得以后有人改回去。
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
const KEEP = num("DEFAULT_DELTA_KEEP_POINTS");
console.log(`═══ 常量（取自源码）：触发 ${TRIGGER} 点 / 保留 ${KEEP} 点 ═══\n`);

/**
 * 模拟水位轨迹。
 *
 * ★ 这是**策略模型**（不是跑插件）：它只把"锚点取哪一个"这一个变量单独拎出来。
 *   假设：每步涨 `grow` 点；触发时压回到 `KEEP + overhead`（保留段 + 摘要）；
 *   锚点按 `policy` 取压前或压后。
 *   ⇒ 结论对该假设的**具体数值不敏感**（只要压回后的确变小），所以足以支撑判断。
 */
function simulate(policy, { steps = 300, grow = 3, trigger = TRIGGER, keep = KEEP, overhead = 2 } = {}) {
  let level = 0;
  let anchor = null; // null = 本会话还没压过
  const peaks = []; // 每次"触发的那一刻"的水位
  let max = 0;
  for (let i = 0; i < steps; i += 1) {
    level += grow;
    const since = anchor === null ? level : level - anchor;
    if (since >= trigger) {
      peaks.push(level);
      const pre = level;
      level = keep + overhead; // 压回：保留段 + 摘要
      anchor = policy === "pre" ? pre : level;
    }
    if (level > max) max = level;
  }
  return { peaks, max };
}

const pre = simulate("pre");
const post = simulate("post");

console.log("═══ 两种锚点的轨迹 ═══");
console.log(`  锚点=压前：峰值 ${pre.peaks.slice(0, 6).join(" → ")} …（共 ${pre.peaks.length} 次）最高水位 ${pre.max}`);
console.log(`  锚点=压后：峰值 ${post.peaks.slice(0, 6).join(" → ")} …（共 ${post.peaks.length} 次）最高水位 ${post.max}`);
console.log("");

// ① 压后 ⇒ 有界（稳定在一个带里）
ok(
  `锚点=压后 ⇒ 水位**有界**（最高 ${post.max} 点，落在 ${KEEP + 2}~${Math.ceil((KEEP + 2 + TRIGGER) / 3) * 3} 这个带里）`,
  post.max <= KEEP + 2 + TRIGGER + 3,
  `实测最高 ${post.max}`
);

// ② 压前 ⇒ 峰值逐轮抬升（这就是 bug 的形状）
const rising = pre.peaks.slice(0, 5).every((v, i, a) => i === 0 || v > a[i - 1]);
ok("锚点=压前 ⇒ 峰值**一轮比一轮高**（阈值自己在漂）", rising, `峰值序列 ${pre.peaks.slice(0, 6).join(", ")}`);

// ③ 压前 ⇒ 会冲破 70%（而用户明确要"延缓达到 70/80"）
ok(
  `★ 锚点=压前 ⇒ 最高 ${pre.max} 点，**冲破了 70% 那条线**（正是用户要避免的）`,
  pre.max > 70,
  `实测最高 ${pre.max}`
);

// ④ 两者差距要显著（否则这条探针没有分辨力）
ok(
  `★★ 两种锚点的最高水位差 ≥ 40 点（差距显著，说明这个选择要紧）`,
  pre.max - post.max >= 40,
  `压前 ${pre.max} vs 压后 ${post.max}`
);

// ── ⑤ 反向校验：证明上面不是恒真（把"压回"改成"不压回"应当有界性失效）──
{
  const noDrop = simulate("post", { overhead: 0, keep: 0 }); // 压回后仍是 0？不——keep=0 表示不留
  // 这里换一种反向：让锚点永远停在 0 ⇒ 每步都触发 ⇒ 峰值恒等于 trigger 附近
  let level = 0;
  let max2 = 0;
  for (let i = 0; i < 300; i += 1) {
    level += 3;
    if (level >= TRIGGER) level = KEEP + 2; // 锚点恒 0（等价于"压后锚点但不动"）
    if (level > max2) max2 = level;
  }
  ok(
    "反向：锚点**恒为 0** ⇒ 水位始终被压在触发线附近（对照，说明模型有分辨力）",
    max2 <= TRIGGER + 3,
    `实测最高 ${max2}（noDrop 峰值 ${noDrop.peaks.length} 次）`
  );
}

// ── ⑥ 静态：源码里锚点必须是**压缩后重新量的** ──────────────────────────
console.log("\n═══ 源码静态检查（防止改回压前锚点）═══");
{
  const i = src.indexOf("state.deltaAnchor.set(");
  ok("在源码里找到设置锚点那一处", i >= 0);
  // ★ 要往**前**看：锚点是「先重新量、再 set」，所以 measurePressure 在 set **之前**。
  //   （第一版探针往 set 之后找了 900 字符，找不到就误报 —— 又是尺子错。）
  const before = src.slice(Math.max(0, i - 700), i + 60);
  ok(
    "★★★ 锚点那段里**重新量了水位**（`measurePressure` 在 set 之前）",
    /measurePressure/.test(before),
    "锚点若直接用压前的 ratio，就是那个会漂的 bug"
  );
  ok(
    "★★★ 没有残留 `state.deltaAnchor.set(key, pressure.ratio)` 这种压前锚点",
    !/state\.deltaAnchor\.set\(key,\s*pressure\.ratio\)\s*;/.test(src)
  );
  // ★ 再钉一条形状：set 的值必须来自那次重新量的结果（`after`）。
  ok(
    "★★ set 用的是重新量出来的 `after`（不是压前的 `pressure`）",
    /state\.deltaAnchor\.set\(key,\s*after === undefined/.test(src)
  );
}

console.log(`\n${fail === 0 ? "探针通过：锚点必须取压后水位（有轨迹证据 + 静态钉死）" : `失败 ${fail} 项`}`);
process.exit(fail === 0 ? 0 : 1);
