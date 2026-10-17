/**
 * ★★★★★ 只读审计（D198 附）：**目标卡上到底有没有"时间"这个字段？**
 *
 * ★ 为什么必须单独查这一条（它是 D198 那个问题的**根**）：
 *   `goalWeightBasis` 的注释逐字写着用户的第 ③ 条要求 ——
 *     *"**已完成的，权重随相对时间逐渐下降**"*，
 *   并声称 *"具体排序仍交给 `fuseWeight` 的相对位置秩融合（见 `goalWeightBasis`）"*。
 *
 *   ★★ 但 `goalWeightBasis(card)` **只吃一个 `card`** ⇒ 若 `card` 里**根本没有时间字段**，
 *     那它就**不可能**知道"这张卡是多久以前完成的"（不由时间决定 ⇒ ③ 无法实现）
 *     —— 这是**结构性**结论，不需要跑起来看。
 *   ★ 而且 `fuseWeight`（带"时间"那一维的那个）**只用于台账区块**，**没有任何地方把它接到目标卡上**。
 *
 * ★ 判据：**一个函数若声称"随相对时间下降"，它的输入里就必须有时间**。
 *   输入里没有 ⇒ 那行注释就是**承诺了一个做不到的事**（与 L9 同型：
 *   注释描述了一个不存在的接线，而它读起来完全可信）。
 *
 * 只读：只读源码 + 真解析器，不写任何东西。
 * 跑法：node tools/_probe-d198-goal-time-field.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
let gaps = 0;
const say = (ok, label, detail) => {
  if (!ok) gaps++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
};

const src = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");

// ── ① 真解析器吐出来的卡，有哪几个字段？ ────────────────────────────────
bar("① 真解析器吐出来的卡**有哪几个字段**？（用被测对象自己，不用我以为的）");
const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const cards = mod.__test.parseGoalCards(fs.readFileSync(path.join(ROOT, "GOALS.md"), "utf8"));
{
  const sample = cards[0];
  say(sample !== undefined, "解析出了卡", `共 ${cards.length} 张`);
  if (sample !== undefined) {
    const keys = Object.keys(sample).sort();
    console.log(`  卡的字段（真解析器给的）：${keys.join(", ")}`);
    const timeish = keys.filter((k) => /at$|time|date|stamp|updated|doneAt/i.test(k));
    say(
      timeish.length > 0,
      "★ 断言：卡里**有**时间类字段",
      timeish.length > 0 ? `有：${timeish.join(", ")}` : "**一个都没有** ⇒ 卡不知道自己是什么时候完成/变更的"
    );
  }
}

// ── ② 写卡时有没有把时间写进去？ ★ 必须**真跑一次写卡**（不许在源码里正则找日期）──────
//
// ★★ 尺子修正（我第一版在这里报了**假绿**，必须留档）：
//   第一版在 `renderGoalCard` 的源码里搜 `/\d{4}|Date|时间/` ⇒ 命中，于是报「✅ 写了时间戳」。
//   而真相是：它**一个字的时间都没写** —— 命中的是我自己写在那个函数**上方**的注释里
//   那个 `2026-10-13`（注释紧邻函数体，落在 900 字符窗口内）。
//   ★ 这是 L14 的同一个病：**"附近有没有那个词" ≠ "它有没有做那件事"**。
//   ⇒ 正解：**调真函数、把它吐出来的文本拿去测**（被测对象自己产生的那部分，纪律 2）。
bar("② 写卡（`renderGoalCard`）时，有没有把**时间**写进文件？（★ 真跑一次，不查源码注释）");
{
  const out = mod.__test.renderGoalCard({
    id: "gX", status: "done", parent: "-", title: "示例卡", kr: ["KR 一"], lessons: ["教训一"],
  });
  console.log("  ── 真函数吐出来的整段（逐字）──");
  for (const l of out.split("\n")) if (l !== "") console.log(`    ${l}`);
  const hasTime = /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}/.test(out);
  say(
    !hasTime,
    "★ 断言：`renderGoalCard` 写出来的文本**不含时间戳**",
    hasTime ? "※ 有（结论需复核）" : "**确认不含**（上面那五行就是它写的全部内容）"
  );
  // ★ 反向参照：证明这把尺子**能看见时间** —— 否则"没找到"与"尺子坏了"无法区分（L12）
  const withTime = out + "\n- 更新于: 2026-10-14 10:00\n";
  say(
    /\d{4}-\d{2}-\d{2}/.test(withTime),
    "★★ 反向参照：**同一把尺子在「有时间的文本」上会命中**（证明上面那个「没有」是真的没有）"
  );
  const card = { id: "gX", status: "done", parent: "-", title: "例", kr: [], lessons: [] };
  const w = mod.__test.goalWeightBasis(card);
  console.log(`\n  真算一次 done 卡的权重：score=${w.score}  why=${JSON.stringify(w.why)}`);
  say(
    w.score === 45,
    "★ `done` 卡的分**恒为 45**（与完成时间无关 —— 因为它拿不到时间）",
    `实测 ${w.score}`
  );
}

// ── ③ 权重函数吃得进时间吗？ ─────────────────────────────────────────────
bar("③ `goalWeightBasis` **吃得进时间**吗？（用户第 ③ 条要求「随相对时间下降」）");
{
  const at = src.indexOf("function goalWeightBasis");
  const seg = src.slice(at, at + 1400);
  const sig = seg.split("\n").find((l) => l.includes("function goalWeightBasis")) ?? "";
  console.log(`  函数签名：${sig.trim()}`);
  // ★ 结构性判据：函数体里有没有用到任何"时间"
  const usesTime = /Date\.|\.at\b|now\(\)|mtime|time|stamp|date/i.test(seg);
  say(
    !usesTime,
    "★ 断言：该函数**用不到时间** ⇒「随相对时间下降」**实现不了**",
    usesTime ? "※ 用到时间了（结论需复核）" : "函数体里没有任何时间来源 —— 与①、② 因果一致"
  );
  // 它给出的 done 分是不是**常数**
  const doneLine = seg.split("\n").find((l) => l.includes('"done"')) ?? "";
  console.log(`  done 那一档：${doneLine.trim()}`);
  const constantDone = /=\s*45\s*;/.test(doneLine);
  say(constantDone, "★ `done` 是**固定 45**，不随完成时间变化", constantDone ? "是常数" : "※ 需复核");
}

// ── ④ 那个带"时间"维的函数，**接到目标卡上了吗**？ ────────────────────────
bar("④ 带「时间」维的 `fuseWeight`，**有没有接到目标卡上**？（注释声称「仍交给它」）");
{
  const fuseDef = src.indexOf("function fuseWeight");
  const callSites = [...src.matchAll(/fuseWeight\(/g)].map((m) => m.index);
  console.log(`  fuseWeight 定义 1 处（偏移 ${fuseDef}）· 调用点 ${callSites.length} 处`);
  // 每个调用点的上下文，看它吃的是不是"区块"
  for (const i of callSites) {
    if (i === fuseDef) continue;
    const ctx = src.slice(Math.max(0, i - 220), i + 60).split("\n").slice(-6).join("\n");
    console.log(`  ── 调用点附近 ──\n${ctx}`);
  }
  const goalsNearFuse = callSites.some((i) => {
    const ctx = src.slice(Math.max(0, i - 4000), i + 4000);
    return /goalWeightBasis|renderGoalTree|parseGoalCards/.test(ctx);
  });
  say(
    !goalsNearFuse,
    "★ 断言：`fuseWeight` 与目标卡**没有任何交集**",
    goalsNearFuse ? "※ 有交集（结论需复核）" : "⇒ 注释里那句「仍交给 fuseWeight 的相对位置秩融合」**没有对应代码**"
  );
  // 时间维只喂区块
  const timeDim = src.split("\n").find((l) => l.includes('name: "时间"')) ?? "";
  console.log(`  时间维那条：${timeDim.trim()}`);
  const feedsBlockChange = /lastChangedAt/.test(timeDim);
  say(feedsBlockChange, "（对照）时间维喂的是**台账区块的变更时间**", feedsBlockChange ? "是" : "※ 需复核");
}

bar(`结  论：共 ${gaps} 处「目标卡没有时间」相关的缺口`);
console.log("  ★ 一个根因串起全部：");
console.log("     **目标卡里根本没有时间字段**（写卡不写、解析不出）");
console.log("     ⇒ ① 权重不可能「随相对时间下降」（函数连时间都拿不到）");
console.log("     ⇒ ② 注入里不可能显示「它多久没动」（没东西可显示）");
console.log("  ★ 而注释把 ① 说成「已交给 fuseWeight」—— 那个函数**只服务台账区块**，与目标卡无交集。");
console.log("  ★ 与 L9 同型：**注释承诺了一个不存在的接线，且读起来完全可信。**");
