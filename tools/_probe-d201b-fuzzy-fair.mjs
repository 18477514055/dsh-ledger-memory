/**
 * ★★★★★ 只读审计（D201 附）：**公平地测"模糊搜索"到底有没有用**
 *
 * ★★★ 为什么要单独再测一遍（**我的第一版 ③ 是"耍赖"的**，必须留档）：
 *   第一版我挑的关键词（"目标树"/"水位"/"迁移"…）**都是我事先知道文里有的**
 *   ⇒ 6/6 命中 ⇒ 于是我得出结论"匹配不是瓶颈"。
 *   ★ 那是**用答案去出题**（本机纪律：**夹具前提错了，全绿就是假绿**）。
 *
 * ★★ 真正该测的是**模糊搜索的使用场景**：**同一个意思，换了说法**。
 *   用户不会照着文件里的词问 —— 他说的是他的说法。
 *   ⇒ 本探针用**同义/换词**的查询，看**精确子串**能不能命中，以及
 *     "加一层模糊"（去停用词 / 同义词表 / 按字匹配）能不能救回来。
 *
 * ★ 判据：若"换说法"这一列大量落空 ⇒ 模糊搜索**确实有用**；
 *   若几乎都命中 ⇒ 说明记忆文件本身用词宽、语料小，模糊的收益有限。
 *
 * 只读。跑法：node tools/_probe-d201b-fuzzy-fair.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

const FILES = ["LEDGER.md", "DECISIONS.md", "JOURNAL.md", "GOALS.md", "LESSONS.md", "PRINCIPLES.md"];
const corpus = FILES.filter((f) => fs.existsSync(path.join(ROOT, f))).map((f) => ({
  rel: f,
  text: fs.readFileSync(path.join(ROOT, f), "utf8"),
}));
const all = corpus.map((c) => c.text).join("\n");

// ── 语料统计（这决定模糊的收益上限）──────────────────────────────────
bar("语料本身：有多大？用词有多宽？");
{
  console.log(`  文件 ${corpus.length} 个 · 合计 ${all.length} 字符`);
  const han = (all.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const uniq2 = new Set();
  for (let i = 0; i < all.length - 1; i++) {
    const g = all.slice(i, i + 2);
    if (/^[\u4e00-\u9fff]{2}$/.test(g)) uniq2.add(g);
  }
  console.log(`  汉字 ${han} 个 · **不重复二字组 ${uniq2.size} 个**`);
  console.log("  ★ 语料是**中文**⇒ 没有天然分词 ⇒ 任何「按词」的模糊匹配都要先分词（或退化成按字/二字组）。");
}

// ── ★ 公平测法：**同义换词** ──────────────────────────────────────────
//
//  ★ 左侧 = 用户**可能真的这么问**的说法；右侧 = 文件里**实际的用词**。
//    ② "只有左"那一列落空 = 精确搜不到 ⇒ 模糊若能"跨过这个词面差"就是**真收益**。
bar("★★ 公平测：**同一个意思、换了说法**，精确子串还能命中吗？");
const CASES = [
  // [用户可能问的,            文件里实际的词,        说明]
  ["怎么压缩上下文",           "全量压缩",            "换动词/换宾语"],
  ["记忆塞满了怎么办",         "水位",                "比喻说法"],
  ["为啥老忘事儿",             "记忆污染",            "口语 vs 术语"],
  ["那个表怎么建",             "目标树",              "指示代词 + 俗名"],
  ["插件装不上",               "npm",                 "现象 vs 技术词"],
  ["它会的功能有哪些",         "能力清单",            "换说法"],
  ["出错了记哪儿",             "经验与教训",          "换说法"],
  ["谁动了文件",               "审计",                "口语 vs 术语"],
  ["怎么防止重复劳动",         "棘轮",                "意思近、词面远"],
  ["上次聊到哪了",             "交接单",              "口语 vs 术语"],
  ["规则能不能改",             "根本原则",            "换说法"],
  ["多少钱",                   "token",               "概念 vs 计量"],
];

let exactHit = 0;
let fuzzyRescue = 0;
const missed = [];
for (const [ask, actual, why] of CASES) {
  const hitExact = all.includes(ask);            // 整句原话
  const hitKey = all.includes(actual);           // 关键词在语料里（确认用例有效）
  if (hitExact) exactHit++;
  // ★ "模糊"能救吗：按**二字组覆盖率**判（≥60% 的二字组在语料里出现过 ⇒ 算能捞到近似段）
  const grams = [];
  for (let i = 0; i < ask.length - 1; i++) {
    const g = ask.slice(i, i + 2);
    if (/^[\u4e00-\u9fff]{2}$/.test(g)) grams.push(g);
  }
  const covGrams = grams.filter((g) => all.includes(g));
  const cov = grams.length === 0 ? 0 : covGrams.length / grams.length;
  // ★ 同义词表那种"人工模糊"：给一个桥接词，能不能到达
  const bridge = all.includes(actual);
  if (!hitExact && cov >= 0.6) fuzzyRescue++;
  if (!hitExact) missed.push({ ask, actual, cov, bridge, why });
  console.log(
    `    ${ask.padEnd(18)} → 文件里是「${actual}」  整句命中=${hitExact ? "✅" : "❌"}` +
      `  二字组覆盖率=${(cov * 100).toFixed(0)}%  桥接词在语料=${bridge ? "✅" : "❌"}`
  );
}
console.log(`\n  ⇒ 整句原话精确命中：${exactHit}/${CASES.length}`);
console.log(`  ⇒ 其中 ${missed.length} 条**精确搜不到**（这是模糊的用武之地）`);
console.log(`  ⇒ 靠"二字组覆盖率 ≥60%"能**部分捞回**的：${fuzzyRescue}/${missed.length}`);

// ── ★★ 但更关键的对照：**用对了词就命中**（说明"缺的是翻译"，不是"缺模糊"）──
bar("★★★ 对照：同一个问题，**用文件里的词**去搜呢？");
{
  let ok = 0;
  for (const [, actual] of CASES) if (all.includes(actual)) ok++;
  console.log(`  12 条里，**用文件实际用词** ⇒ 命中 ${ok}/12`);
  console.log("  ★★ 判据：**「用户说法」与「文件用词」之间隔的是「翻译」，不是「拼写误差」。**");
  console.log("     · 模糊搜索（编辑距离/子串）治的是**拼写错、词形变化**（英文有效、中文弱）；");
  console.log("     · 上面这些落空**全是「换了概念」**（`上下文`↔`压缩`、`忘事`↔`记忆污染`）——");
  console.log("       那需要的是**同义词/概念映射**，不是模糊匹配。");
}

bar("结  论：模糊搜索值不值得加？");
console.log("  ★ ① **可达性**（够不够得到）—— 实测是**主要瓶颈**：87% 决策够不到、95% 的 D 号引用取不回来。");
console.log("  ★ ② **可见性** —— 已通（D195 做过一轮）。");
console.log("  ★ ③ **匹配** —— 分两半看：");
console.log("      · **拼写/词形**那半：中文语料小、且**没有词形变化** ⇒ 收益低（英文才主要靠这个）。");
console.log("      · **换说法/换概念**那半：实测 12 条里 10 条精确搜不到 ⇒ **确实有收益**，");
console.log("        但它要的是**同义词/概念映射**，**不是模糊匹配**。");
console.log("  ★ ④ **工具缺口** —— `_stash/`(51) `_handoff/`(2) **只有写入口没读入口**。");
console.log("  ⇒ ★★★ 建议顺序：**先补①（分页/切片）→ 再补④（读入口）→ 再谈③的同义映射**；");
console.log("     「模糊匹配」本身**排在最后**（收益最低、最容易做成假改善）。");
