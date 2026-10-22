/**
 * 只读：D284 的**双向**验证 —— 修对了没有 + 有没有误伤。
 *
 * ★ 为什么必须双向：这次改的是"认哪些词算失效"。
 *   ① 只验"作废的被降权"是不够的 —— 万一判据太宽，把有效卡也降了，症状是**静默的**（少了几张本该读的卡）。
 *   ② 只验"没误伤"也不够 —— 那样等于没改。
 *   ⇒ 必须同时成立：**该降的都降了，不该降的一个没降。**
 *
 * 跑法：node tools/_probe-card-deprecation2.mjs
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const T = mod.__test;

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${extra === undefined ? "" : `  ← ${extra}`}`); }
}

const w = (heading) => T.mechanicalWeight({ key: "X", heading, text: "", lines: 0, chars: 0 }, undefined, Date.now());

console.log("═══ A. 该降的必须降（作废族全部命中）═══");
const SHOULD = [
  "D274 · 已作废 —— 项目成员团队方向",
  "D999 · 已废弃 —— 旧接口",
  "D999 · 已撤销 —— 上轮建议",
  "D999 · 已被取代 —— 见 D123",
  "D999 · 被否方向 —— 团队",
];
for (const h of SHOULD) ok(`「${h.slice(7, 15)}」⇒ done`, w(h).done === true, JSON.stringify(w(h)));

console.log("\n═══ B. 原有判定不许被改坏（旧词一个不能丢）═══");
const OLD = ["已完成", "已处理", "已过期", "不要重做", "别再重做"];
for (const kw of OLD) ok(`「${kw}」仍然 done`, w(`D999 · ${kw} —— 某事`).done === true);

console.log("\n═══ C. 不许误伤：只说\"某一版数字作废\"的卡必须仍是有效 ═══");
//   这些是**真实存在**的标题（D49 / D57 / D117 / D136 / D173 / D254 / D279）
const MUST_NOT = [
  "D49 · ★★★ 两个压缩模式（正常推进 / 反复追究）—— 用户拍板",
  "D57 · \"官方通道只装到 0.1.0\"的真根因：过期的 minimumReleaseAgeExclude",
  "D117 · ★★★ 【已实现】轻推不再按「攒了多少」触发",
  "D136 · 区块定位 = 相对位置（多维秩融合 + 权重可变）· 2026-10-12",
  "D173 · ★★★★★★ 接手诊断：模型收到的压缩合同与用户拍板的架构不是同一份",
  "D254 · 日志系统跟得上台账吗？（覆盖率 100%，但「查得动」已开始告急）",
  "D279 · 1.2.9：记忆协议代次检测 + 默认压缩线 0.3 → 0.7",
];
for (const h of MUST_NOT) ok(`「${h.slice(0, 42)}」不算 done`, w(h).done !== true, JSON.stringify(w(h).why));

console.log("\n═══ D. 判据只吃 heading，不吃正文（结构性断言）═══");
//   ★ 直接构造"正文里全是作废字样、标题干净"的块，必须仍判有效。
const bodyTrap = T.mechanicalWeight(
  { key: "X", heading: "D999 · 一个完全有效的决定", text: "上一版已作废。已废弃。已撤销。被否。", lines: 1, chars: 30 },
  undefined,
  Date.now()
);
ok("★ 正文里堆满『作废/废弃/撤销/被否』但标题干净 ⇒ **仍然有效**", bodyTrap.done !== true, JSON.stringify(bodyTrap.why));

console.log("\n═══ E. 真实卡片盘面（改前 5 张漏网 ⇒ 改后应 0）═══");
const DIR = "decisions";
const blocks = T.listCards(ROOT, DIR).map((c) => {
  const text = T.readCard(ROOT, DIR, c.key) ?? "";
  const heading = (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").replace(/^#+\s*/, "").trim();
  return { key: c.key, heading };
});
const DEP = /已作废|已废弃|已撤销|已被取代|被否/;
const miss = blocks.filter((b) => DEP.test(b.heading) && T.mechanicalWeight({ key: b.key, heading: b.heading, text: "", lines: 0, chars: 0 }, undefined, Date.now()).done !== true);
ok(`★ 盘面：声明作废但漏网的卡 = ${miss.length} 张（应为 0）`, miss.length === 0, miss.map((m) => m.key).join(","));
ok(`盘面里确有作废卡（否则这条断言是空的）`, blocks.some((b) => DEP.test(b.heading)), "一张都没有 ⇒ 断言没被测到");

console.log(`\n${"═".repeat(60)}`);
console.log(`PASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
