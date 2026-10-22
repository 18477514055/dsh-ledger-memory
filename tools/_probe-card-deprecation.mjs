/**
 * 只读：**「已作废」的卡，现在到底有没有被当成"不该占上下文"？**
 *
 * 背景（C 方案的切入点）：
 *   `mechanicalWeight`（lib/part1.js:2801）里有一条「已处理/已过期 ⇒ 封顶低分」，
 *   判据是 **heading 里的自我声明**：`已完成|已处理|已过期|不要重做|别再重做`。
 *   —— ★ 注意它认的是 **heading（卡片第一行）**，不是正文。
 *
 *   D274–D278 这 5 张团团队方向的卡，第一行写的是 `# D274 · 已作废 —— …`
 *   ⇒ heading 里确实有"已作废"三个字。
 *   **但判据的词表里没有"已作废"** ⇒ 我怀疑它们**根本没被降权**。
 *
 * ★ 这个探针要回答三件事：
 *   ① 哪些卡的 heading 真的含"作废/废弃/撤销/被取代"？
 *   ② 这些卡在 `renderCardIndex` 里拿到的 score 是多少（与"已完成"的卡对比）？
 *   ③ ★★★ **反向**：正文里提到"作废"但标题没提的卡，**绝不能**被误伤 ——
 *      这正是不许把判据做成"认关键词"的地方（D136 的教训）。
 *
 * 只读：不写盘、不改 state。
 * 跑法：node tools/_probe-card-deprecation.mjs
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const T = mod.__test;

const DIR = "decisions";
const blocks = T.listCards(ROOT, DIR).map((c) => {
  const text = T.readCard(ROOT, DIR, c.key) ?? "";
  const heading = (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").replace(/^#+\s*/, "").trim();
  return { key: c.key, heading, text };
});
console.log(`卡片 ${blocks.length} 张\n`);

// ── ① heading 里含"作废/废弃/撤销/被取代"的卡 ──
const DEPRECATED_RE = /已作废|已废弃|已撤销|已被取代|被否/;
const byHeading = blocks.filter((b) => DEPRECATED_RE.test(b.heading));
console.log(`═══ ① heading 里声明作废的卡：${byHeading.length} 张 ═══`);
for (const b of byHeading) console.log(`  ${b.key.padEnd(7)} ${b.heading.slice(0, 60)}`);

// ── ② 正文里提到、但 heading 没提的（**必须不被误伤**）──
const bodyOnly = blocks.filter((b) => !DEPRECATED_RE.test(b.heading) && DEPRECATED_RE.test(b.text));
console.log(`\n═══ ② 正文提到作废、但 heading 没声明：${bodyOnly.length} 张（这些**不许**被降权）═══`);
for (const b of bodyOnly.slice(0, 20)) console.log(`  ${b.key.padEnd(7)} ${b.heading.slice(0, 56)}`);

// ── ③ 真跑 mechanicalWeight，看现在的判定 ──
console.log(`\n═══ ③ 现在的 weight 判定（判据只看 heading）═══`);
const DONE_RE = /已完成|已处理|已过期|不要重做|别再重做/;
let missDeprecated = [];
let hitDone = [];
for (const b of blocks) {
  const w = T.mechanicalWeight({ key: b.key, heading: b.heading, text: b.text, lines: 0, chars: b.text.length }, undefined, Date.now());
  if (DEPRECATED_RE.test(b.heading)) {
    if (w.done !== true) missDeprecated.push({ key: b.key, heading: b.heading, score: w.score, why: w.why });
  }
  if (DONE_RE.test(b.heading)) hitDone.push({ key: b.key, heading: b.heading, score: w.score, done: w.done });
}

console.log(`  ★ heading 声明作废、但 **没有被判成 done** 的卡：${missDeprecated.length} 张`);
for (const m of missDeprecated) {
  console.log(`    ${m.key.padEnd(7)} score=${m.score}  done=${m.why.includes("已完成") ? "?" : "(无标记)"}  ← ${m.heading.slice(0, 50)}`);
}
console.log(`  （对照）heading 含"已完成/已处理/已过期"的卡：${hitDone.length} 张`);
for (const h of hitDone) console.log(`    ${h.key.padEnd(7)} score=${h.score} done=${h.done}  ← ${h.heading.slice(0, 50)}`);

// ── ④ 结论 ──
console.log(`\n═══ ④ 结论 ═══`);
if (missDeprecated.length > 0) {
  console.log(`  ❌ **${missDeprecated.length} 张已作废的卡没有被降权** —— 它们会和有效卡一样参与排序。`);
  console.log(`     ⇒ 缺口在 \`mechanicalWeight\` 的 done 词表：只认「已完成/已处理/已过期/不要重做/别再重做」，`);
  console.log(`        **不认「已作废」**。这不是"要新加一套 valid_at 字段"，而是**已有的通道漏了一个同义词**。`);
} else {
  console.log(`  ✅ 所有 heading 声明作废的卡都已被判成 done（这条通道是通的）。`);
}
console.log(`\n  ★ 关键设计判断：判据必须只吃 **heading（卡片自己的标题）**，`);
console.log(`    绝不能扫正文 —— 正文里的"上一版数字作废"是**卡内局部结论**，`);
console.log(`    把它当成整卡失效就会误伤 ${bodyOnly.length} 张有效卡（D136「判据不许认关键词」的同型陷阱）。`);
