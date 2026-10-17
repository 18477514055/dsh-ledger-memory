/**
 * ★★★★★ 只读审计（D202）：**"全部卡片化"到底意味着什么？**
 *
 * 用户原话（逐字）：*"所以这就是我的想法，也是我一开始提出来的，所有的台账类别全部变成文件夹，
 * 然后各种内容变成卡片类和区块化。一个卡片或者两个卡片组成一个文字。"*
 *
 * ★★ 先确认一件事：**这不是新方向** —— 它就是 D133（用户 2026-10-12 定的"记忆区块"），
 *   而且 D136 已经**把机制实现出来**（`splitBlocks` / `weightBlocks` / `renderBlockInjection`），
 *   **默认关、从未真跑过**。⇒ 本探针不重新论证"要不要"，而是量清"**做下去的真实代价与收益**"。
 *
 * ★ 三个必须量的数（都是决策输入，不是感想）：
 *   ① **会变成多少个文件**（用户项目里塞 243 个文件 vs 6 个，量级完全不同）；
 *   ② **热/冷比**（哪些卡片真的被引用过 —— 热的那批才是"该常驻"的候选人）；
 *   ③ **卡片化相对"D201 的 entry 切片"多给什么**（若答案是"几乎一样"，就不该付 41 倍文件数）。
 *
 * 只读。跑法：node tools/_probe-d202-cards-cost.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const read = (f) => (fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), "utf8") : "");

// ── ① 文件数：全量卡片化会产生多少个文件？ ──────────────────────────────
bar("① 全部卡片化 = 多少个文件？（用户项目里会看到的东西）");
const dec = read("DECISIONS.md");
const les = read("LESSONS.md");
const goals = read("GOALS.md");
const jrn = read("JOURNAL.md");

const decCards = [...dec.matchAll(/^##\s*D(\d+)/gm)].map((m) => `D${m[1]}`);
const lesCards = [...les.matchAll(/^##\s*(经验|教训)\s+([LE]\d+)/gm)].map((m) => m[2]);
const goalCards = [...goals.matchAll(/^##\s*目标\s+([A-Za-z0-9._-]+)/gm)].map((m) => m[1]);
const jrnDays = [...new Set([...jrn.matchAll(/^##\s*(\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]))];

const countDir = (d) => {
  const p = path.join(ROOT, d);
  if (!fs.existsSync(p)) return 0;
  let n = 0;
  const walk = (x) => {
    for (const e of fs.readdirSync(x, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(x, e.name));
      else n++;
    }
  };
  walk(p);
  return n;
};

const plan = [
  ["decisions/", decCards.length, "一卡一文件（D<n>.md）"],
  ["lessons/", lesCards.length, "一卡一文件（L<n>.md / E<n>.md）"],
  ["goals/", goalCards.length, "一卡一文件（g<n>.md）"],
  ["journal/", jrnDays.length, "一天一文件（现 543 行合在一份里）"],
  ["_ledger-archive/", countDir("_ledger-archive"), "已是文件夹（现状）"],
  ["_stash/", countDir("_stash"), "已是文件夹（现状）"],
  ["_handoff/", countDir("_handoff"), "已是文件夹（现状）"],
  ["（内存文件）", 4, "LEDGER / PRINCIPLES / 清单 / 索引 —— 仍需是单文件"],
];
let total = 0;
for (const [name, n, why] of plan) {
  total += n;
  console.log(`  ${name.padEnd(18)} ${String(n).padStart(4)} 个文件   ${why}`);
}
console.log(`  ${"合计".padEnd(18)} ${String(total).padStart(4)} 个文件`);
console.log(`  ★ 现状是 **6 个**记忆文件 + 3 个目录 ⇒ 卡片化后约 **${total}** 个（×${Math.round(total / 6)}）`);

// ── ② 热/冷比：哪些卡片**真的被引用过**？ ────────────────────────────────
//
//  ★ 这是"该常驻"与"该归档"的**唯一客观依据**（不是我们觉得哪条重要）。
bar("② 热/冷比：203 张决策卡里，**有多少真的被引用过**？（引用 = 召回需求的真实信号）");
{
  // 引用面 = 除 DECISIONS 自己以外的全部记忆 + 台账正文
  const refSurface = [read("LEDGER.md"), les, goals, read("PRINCIPLES.md"), read("JOURNAL.md")].join("\n");
  const cited = new Set([...refSurface.matchAll(/\bD(\d{1,3})\b/g)].map((m) => `D${m[1]}`));
  const hot = decCards.filter((c) => cited.has(c));
  const cold = decCards.filter((c) => !cited.has(c));
  console.log(`  被引用过（热）：${hot.length} 张`);
  console.log(`  从未被引用（冷）：${cold.length} 张  ← 占 ${((cold.length / decCards.length) * 100).toFixed(0)}%`);
  // ★★★ 这里我**第一次算错了，必须留档**：我用 `new RegExp("^##\\s*D46\\s*·[\\s\\S]*?(?=\\n##\\s*D|$)", "m")`
  //   而 **`$` 带 `m` 标志只匹配「行尾」**（不是字符串尾）⇒ 懒惰量词在**第一行末**就停了
  //   ⇒ 每张"冷卡"都只算到约 50 字符 ⇒ 报出"冷卡只占 1%"这种**荒谬的数**（中位卡明明 2238 字符）。
  //   ★ 正解：**先把整份文件按卡片切开**（用行区间，不用正则），再按 key 取大小。
  //   ★ 判据：**凡"用正则量一整段内容"，先检查 `$`/`^` 的 flag 语义** —— `m` 会把它们变成"行锚"。
  const spans = [];
  {
    const lines = dec.split(/\r?\n/);
    let cur = null;
    lines.forEach((l, i) => {
      const m = /^##\s*D(\d+)/.exec(l);
      if (m !== null) {
        if (cur !== null) { cur.end = i; spans.push(cur); }
        cur = { key: `D${m[1]}`, start: i };
      }
    });
    if (cur !== null) { cur.end = lines.length; spans.push(cur); }
    for (const s of spans) s.chars = lines.slice(s.start, s.end).join("\n").length;
  }
  const sizeOf = new Map(spans.map((s) => [s.key, s.chars]));
  const coldBytes = cold.reduce((a, k) => a + (sizeOf.get(k) ?? 0), 0);
  const hotBytes = hot.reduce((a, k) => a + (sizeOf.get(k) ?? 0), 0);
  console.log(`  热卡体量：约 ${hotBytes} 字符（${((hotBytes / dec.length) * 100).toFixed(0)}% 的 DECISIONS.md）`);
  console.log(`  冷卡体量：约 ${coldBytes} 字符（${((coldBytes / dec.length) * 100).toFixed(0)}% 的 DECISIONS.md）`);
  console.log("  ★★ 判据：**热的那批才值得「常驻/优先」**；冷的那批只需要「**查得到**」（不必更便宜）");
}

// ── ③ 卡片化 vs「D201 的 entry 切片」：**它多给了什么** ─────────────────
//
//  ★★★ 这是本轮最该问的问题：D201 已把"取回能力"修好（44/44），
//    那么"一卡一文件"是否还带来**额外**收益？逐条对照。
bar("③ 卡片化相对「`entry` 按条目切片」（D201 已做）**多给什么**？");
{
  const rows = [
    ["取得到某一条（命中率）", "✅ 44/44（实测）", "✅ 同样 44/44", "打平 —— entry 已解决"],
    ["要不要先读整份文件", "要（474K 读进内存再切）", "不用（直接开那个小文件）", "★ 卡片化略优（但这是**本地 I/O**，模型看不到）"],
    ["地址稳不稳", "依赖 `## D195 · …` 这个**格式**", "**文件名就是地址**（不解析）", "★★ 卡片化真优 —— 格式写歪就退化（见 D197 那条「协议」）"],
    ["索引（有哪些卡）", "`toc`（每次现算标题行）", "目录列表（天然就是索引）", "打平"],
    ["改/删一张卡", "在大文件里做正则替换", "只动那一个小文件", "★ 卡片化更稳（但 DECISIONS 是**只追加** ⇒ 现状几乎不改）"],
    ["文件数（用户可见）", "6 个", `**${total} 个**`, "❌ 卡片化代价很大"],
    ["git diff 粒度", "整份文件", "一张卡一个 diff", "★ 卡片化略优"],
    ["用户自己手工编辑", "翻一个大文件", "**找一个文件**", "★★ 卡片化真优"],
  ];
  for (const [k, a, b, verdict] of rows) {
    console.log(`  · ${k}`);
    console.log(`      entry 切片：${a}`);
    console.log(`      一卡一文件：${b}`);
    console.log(`      ⇒ ${verdict}`);
  }
}

// ── ④ ★ 已有先例：这个项目**自己已经在用文件夹**了 ────────────────────
bar("④ 已有先例：本项目的 `_stash/` `_ledger-archive/` **本来就是文件夹**");
{
  console.log(`  _stash/           ${countDir("_stash")} 个文件 —— 分流里"以后可能要查"的东西`);
  console.log(`  _ledger-archive/  ${countDir("_ledger-archive")} 个文件 —— 历史（只追加）`);
  console.log("  ★★ 也就是说：**「文件夹 + 一单元一文件」这个形态，本项目已经在用了**");
  console.log("    （用在**冷/历史**那一层）；而**热的那层**（LEDGER / DECISIONS …）仍是单文件。");
  console.log("  ⇒ ★★★ 这个分层**不是巧合**，它是 D46 铁律的必然结果：");
  console.log("     「**恢复必须是推给模型的，不能是等模型来查**」⇒ 必须常驻的那批**不能**变成文件；");
  console.log("     而「可能要查」的那批**就该**是文件（便宜、可列举、可 grep）。");
}

bar("结  论：卡片化该怎么落？");
console.log("  ★ ① 方向**早就定了**（D133，用户 2026-10-12）⇒ 这不是新提案，是**没做完的那一半**。");
console.log("  ★ ② **机制也早就有了**（D136：`splitBlocks`/`weightBlocks`/`renderBlockInjection`）—— **默认关、从未真跑**。");
console.log(`  ★ ③ 全量卡片化 = **${total} 个文件**；而**热卡只有 ${decCards.length - (decCards.length - new Set([...read("LEDGER.md").matchAll(/\bD(\d{1,3})\b/g)].map(m=>"D"+m[1])).size)} 张级别**。`);
console.log("  ★★★ ④ 关键判据：**卡片化真正独有、entry 给不了的只有两条** ——");
console.log("      · **地址不依赖格式**（文件名即地址）—— 这一条值钱（D197 那条「协议」就是它的替代品）；");
console.log("      · **用户能一个文件一个文件地翻/改** —— 这一条对**人**值钱。");
console.log("     其余（取得到、索引、diff）**entry 已经做到了**。");
console.log("  ⇒ 建议**分层落地**，而不是把 6 个文件炸成 " + total + " 个：");
console.log("     · **必常驻**（LEDGER 正文 / 原则 / 清单 / 索引）⇒ **保持单文件**（D46 铁律）；");
console.log("     · **热但不必常驻**（被引用过的那些卡）⇒ 单文件 + `entry`（已做）或卡片化；");
console.log("     · **冷/历史**（从未被引用的那批）⇒ **卡片化**（本来就不该占单文件的开销）。");
