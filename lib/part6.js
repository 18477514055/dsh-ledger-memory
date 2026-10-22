// ═══════════════════════════════════════════════════════════════════════════
// part6.js —— ★★★★★ D234「文件级多参数锚定」（2026-10-17）
// ═══════════════════════════════════════════════════════════════════════════
//
// 用户原话（逐字）：
//   *"这么看来可以像给卡片打分一样，给文件也提供类似的多参数锚定"*
//
// ★★★ 要治的病（D234 §根因，**第四类检索失败**）：
//   「取得到、但没去取」—— 模型查到一份**看起来够用**的材料就停了，
//   不再往别的记忆面看一眼。★ D46 的「推」只解决"不知道去哪找"，
//   不解决"找到了就不再找"；而「推」的副作用正是：**推过去的东西成了检索终止符**。
//
// ★★★ 与 D136 / D202 的关系（**不另造一套**）：
//   ① `fuseWeight`（part1.js:2649）服务**台账区块**（时间维喂的是块的 `lastChangedAt`）；
//   ② `renderCardIndex`（part4.js:1549）服务**卡片目录**（把卡当块喂给同一套）；
//   ③ 本文件服务**任意文件**（docs / _stash / _handoff / _ledger-archive / 根目录调研稿…）。
//   三者**共用同一把尺子**：相对位置秩融合（`ranksOf` + 线性铺满 [0,1]）。
//
// ★★★★★ 三条硬纪律（每条都对应一次真实的失败）：
//   ① **全是相对秩，没有绝对阈值** —— 绝对判据在"大家都满足"时无区分力（D136）。
//   ② **缺值不惩罚** —— 拿不到某个维度 ⇒ 只对**已有**维度求平均，不按 0 计
//      （D198 `更新于` 那条同型：把"信息缺失"当成"最差"是凭空扣分）。
//   ③ ★★★ **不许用"密度代理"冒充语义维度** —— 见下面 `一手性` 的教训留档。
//
// ★★★★★ 一次真实的尺子错（**第 26 次**，必须留档，别再犯）：
//   我本来打算用「引用密度」（`文件:行号` + URL 的出现次数 ÷ 体积）作"一手性"的机械代理。
//   **实测结果正好相反**（`_probe-d234-ruler.mjs`）：
//     · `_调研-billion-context.md`（**二手**，正是今天害我停下的那份）⇒ 密度 **2.10/KB**
//     · `02-参照物精读-billion-context.md`（**一手**，12 处 `[本地一手]`）⇒ 密度 **0.50/KB**
//   ⇒ 按密度排序会**把二手排在一手前面** —— 正好**强化** D234 这个病。
//   ★ 根因：密度测的是**写作风格**（爱不爱写路径），不是**证据等级**。
//   ⇒ 正解：一手性**只认显式标注**（`[本地一手]` / `[官方一手]` / `[未证实]`），
//     且**没有标注 = 无值**（不是"二手"）。★ 巧合但正确：今天那两份因此**恰好排对了**。
//     —— 这不是"碰巧能用"，而是"不知道就不惩罚"这条纪律的正确后果。

import fs from "node:fs";
import path from "node:path";

import { STASH_DIR, WEIGHT_MUST_INJECT } from "./defs.js";
import { fnv1a, ranksOf, starValueOf } from "./part1.js";
// ★ V3（D289）：记忆面的解析基准。`part2` 不 import `part6` ⇒ 不构成循环（已核）。
import { memoryBaseOf } from "./part2.js";

// ═══════════════════════════════════════════════════════════════════════════
// 一、维度定义（**单一出处** —— 注入文案、工具输出、自检都从这里读）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★★★ 六维（用户 2026-10-17 拍板"六维全做"）。
 *
 * ★ `weight` 是**相对重要性**，不是绝对分数；六维之和不必是 100
 *   （融合时按 `Σw` 归一，所以加维度不会把总分挤爆）。
 * ★★ `label` / `why` 会给**模型看** ⇒ 必须说人话，不能印内部键。
 * ★ `missing` 说明**这一维拿不到时怎么办** —— 一律「不惩罚」，唯独 `cited` 是"真的没人引"。
 */
export function fileAnchorDims() {
  return [
    {
      key: "firsthand",
      name: "一手性",
      weight: 3.0,
      label: "一手 / 二手",
      missing: "文件没有任何证据等级标注 ⇒ 本维**不计分**（不知道就不惩罚）",
      why:
        "文件里有没有 `[本地一手]` / `[官方一手]` 这类**显式证据标注**，" +
        "`[未证实]` 扣分。★ 只认显式标注：**密度、字数、引用条数都不算**（实测会把二手排到一手前面）。",
    },
    {
      key: "recency",
      name: "时效",
      weight: 2.0,
      label: "多新",
      missing: "既没有文件内日期、也读不到 mtime ⇒ 本维不计分",
      why:
        "文件自己写的**日期**（`调研日期` / `日期` / `更新于` …）优先，" +
        "找不到才用 **mtime**。★ 用相对秩（谁比谁新），**不是**绝对时长。",
    },
    {
      key: "cited",
      name: "被引用度",
      weight: 1.5,
      label: "被谁引过",
      missing: "★ 这一维**缺就是真的 0**（没人引 ≠ 拿不到）",
      why:
        "别的文件（决策卡 / 台账 / 交接单）提到这份文件名的次数 —— " +
        "**被决策卡点名过**的材料，通常正是该读的那一份。",
    },
    {
      key: "generation",
      name: "代际",
      weight: 2.5,
      label: "是不是老一代",
      missing: "文件里没有任何 `D<n>` 编号 ⇒ 本维不计分",
      why:
        "★ **这一维是今天这个坑的解药**：文件正文里出现的**最大 `D<n>`**，" +
        "与全库当前最大 `D` 比 —— 差得越多 ⇒ 它越可能**已被后来者推翻**。" +
        "★ 它回答的正是「这份是不是已经被历史追过去了」。",
    },
    {
      key: "size",
      name: "体量",
      weight: 0.5,
      label: "读得完吗",
      missing: "读不到大小 ⇒ 本维不计分",
      why:
        "是否落在回读预算内（D79：`R* ≈ 31K tok ≈ 125 KB`）。" +
        "★ 超预算的材料**不是「不重要」，而是「不能整份塞」** ⇒ 只降一点权重，" +
        "并建议按段读，绝不当成「没有价值」。",
    },
    {
      key: "star",
      name: "星",
      weight: 1.0,
      label: "强调程度",
      missing: "没有 ★ ⇒ 0 分（与区块口径一致）",
      why: "数与卡片/区块同一口径的 `★` 星值 —— **用户自己的强调**是他亲手标的权重。",
    },
  ];
}

/** 维度权重之和（自检与文案共用，避免两处各写一遍）。 */
export function fileAnchorTotalWeight() {
  return fileAnchorDims().reduce((s, d) => s + d.weight, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、从文件正文里抽各维的**原始值**（纯函数、只读、可单测）
// ═══════════════════════════════════════════════════════════════════════════

/** 一手 / 官方一手的标注（**只认显式标注** —— 见头部第 26 次尺子错的留档）。 */
const FIRSTHAND_RE = /\[(?:本地一手|官方一手)\]/g;
/** 明确标注「未证实」的段落 —— 它是**减分项**，不是加分项。 */
const UNVERIFIED_RE = /\[未证实\]/g;

/**
 * 从正文里读「证据等级」：`一手标注数 − 未证实数`。
 *
 * ★ 两个都是**计数**（不是布尔）：一篇里有 12 处一手标注，比只有 1 处的可信度高。
 * ★★ 没有任何标注 ⇒ 返回 `undefined`（**不是 0** —— 见纪律②「缺值不惩罚」）。
 */
export function evidenceLevelOf(text) {
  const t = String(text ?? "");
  const first = (t.match(FIRSTHAND_RE) ?? []).length;
  const unver = (t.match(UNVERIFIED_RE) ?? []).length;
  if (first === 0 && unver === 0) return undefined;
  return first - unver;
}

/**
 * 从正文**开头**读文件自称的日期（`调研日期` / `日期` / `更新于` / `最后更新`…）。
 *
 * ★ 只读**前 60 行**：文件名里的日期是给人看的，**正文头部的自述才是作者认的**。
 *   （全文扫会把"某段提到的历史日期"误当成文件的日期 —— 那是另一次尺子错。）
 * ★ 认不出 ⇒ `undefined`（**绝不猜**：猜成 1970 会让它看起来"极旧"而被多扣分，D198 同型）。
 */
export function declaredDateMs(text) {
  const head = String(text ?? "").split(/\r?\n/).slice(0, 60).join("\n");
  const re =
    /(?:调研日期|更新于|最后更新|生成日期|日期|时间)\s*[：:]\s*\**\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/;
  const m = re.exec(head);
  if (m === null) return undefined;
  const t = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    m[4] === undefined ? 0 : Number(m[4]),
    m[5] === undefined ? 0 : Number(m[5])
  ).getTime();
  return Number.isFinite(t) ? t : undefined;
}

/**
 * 文件正文里出现的**最大 `D<n>`**（决策卡编号）。
 *
 * ★★ 这是「代际」维的原料：一份 10-09 的调研稿引用的最大决策号是 D89，
 *   而全库已到 D234 ⇒ 它落后 145 代 ⇒ **它之后发生的事，它一个字都不知道**
 *   （今天那份 `_调研-billion-context.md` 正是如此：D90 后来推翻了它的结论）。
 * ★ 一个 D 号都没有 ⇒ `undefined`（不是 0）。
 */
export function maxDecisionRefOf(text) {
  let max = undefined;
  for (const m of String(text ?? "").matchAll(/\bD(\d{1,3})\b/g)) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    if (max === undefined || n > max) max = n;
  }
  return max;
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、扫描记忆面（哪些文件**算候选**）
// ═══════════════════════════════════════════════════════════════════════════

/** 单个文件读多少字节来算各维（**只读头部** —— 不让扫描本身吃掉预算）。 */
const SCAN_HEAD_BYTES = 64 * 1024;
/** 一次最多扫多少个文件（有界，防止大仓库把一次注入拖死）。 */
const SCAN_MAX_FILES = 400;
/** 目录递归深度上限。 */
const SCAN_MAX_DEPTH = 3;

/**
 * ★ 记忆面 = 「模型该知道它存在、但**不会自动注入**的那些地方」。
 *
 * ★★★ 判据：**只看"按需查"的面** —— 已经每回合注入的东西（台账正文）不需要锚定，
 *   它一直在视野里。锚定要治的是"**看不见、于是忘了去查**"。
 * ★ `rel` 由调用方给（来自 `info`），这里**不猜路径**（本文件不 import inspect）。
 *
 * ★★★★★ `kind` 是**必须的第三列**（这是第一版栽出来的）：
 *   第一版把 `decisions/`、`_ledger-archive/`、`docs/` **塞进同一把尺子混排**，
 *   实测结果是：**前 6 名全是归档片段与刚写的决策卡，而真正的一手精读排到第 158/402**。
 *   ⇒ 根因不是权重错，是**把三类性质不同的东西当成了同一类**：
 *     · `conclusion` = **权威结论**（决策卡 / 经验教训 / 目标树）—— 它是**判据**，不是候选材料；
 *     · `history`    = **历史归档**（已移出活跃台账）—— 它变了**过去**，不是"该先读什么"；
 *     · `material`   = **待读材料**（调研稿 / 审计报告 / 问题报告 / 交接单 / 分流细节）
 *       —— ★★ **D234 的病发地就在这一类里**。
 *   ★★★★★ **第二次栽（必须一起记住）**：加上 `kind` 之后前 6 名仍然有 5 个是
 *   `_stash/` 的周记碎片，一手精读还是只排到 **53/116**。
 *   ⇒ 根因同型：`_stash/` 是**按时间分桶的碎片流**（本项目 91 个），
 *     与 `docs/` 的**成篇材料**性质也不同 —— 碎片不该跟成篇材料抢榜首。
 *   ⇒ 于是 `fragment` 独立成类：它是**按需查的细节**，不是"该先读的那份"。
 *   ★ 教训（值得记）：**"同类"这件事要一层层问到底** —— 第一次分三类还不够，
 *     因为 `material` 里面还混着两种粒度。**混类的代价是排序失去意义**，
 *     而排序失去意义时，模型就会回到"停在第一份看起来像样的东西上"（= D234 原病）。
 *
 *   ★ 判据一句话：**"该读哪份材料"这个问题，只能在同类材料之间问。**
 *   （这正是台账纪律 15：「统计某一类东西前，必须先把它与同类但不同源的分开」。）
 */
export function memorySurfaces(info) {
  const out = [];
  // ★★ `rel === ""` 是**合法值**（= 项目根），不是"没配置"。
  //   ★ 第一版守卫写成 `rel !== ""` ⇒ 把根面整个挡掉了 ⇒ 根上那份 `_调研-*.md`
  //     **一份都扫不到**，而它正是今天害我停下的东西。⇒ 判据：**守卫要挡的是 `undefined`，
  //     不是空串** —— 这两件事在小数组上看起来一样，在语义上完全不同（纪律 12 同型）。
  //
  // ★★★★★ 2026-10-21（D289 · V3）：每个面多一个 **`base`** —— 它决定这个面用哪个基准解析。
  //   · `"memory"`（默认）⇒ 本插件产生的记忆，V3 下住在记忆子目录里；
  //   · `"project"` ⇒ 项目**自己的**文档（调研稿 / 项目文档 / 根目录稿），**不跟着搬**。
  //   ★ 判据一句话：**「这是本插件写的东西，还是项目本来就有的东西？」**
  //     —— 前者跟着 `memoryRoot` 走，后者永远在项目根。
  //   ★ 漏标会导致**静默扫空**（不报错），所以这个字段不是可选的装饰。
  const push = (rel, label, kind, why, base = "memory") => {
    if (typeof rel === "string") out.push({ rel, label, kind, why, base });
  };
  // ★ `material` = **成篇的材料**（D234 的病发地就在这里）。
  // ★ `notesDir` / `handoffDir`：用户已拍板"跟随项目走 ⇒ 进子目录"（含 notes）。
  push(info?.notesDir, "问题报告", "material", "排查某件事时先看这里有没有人踩过");
  // ⚠️ `docsDir` 是**项目自己的**文档目录（调研稿 / 审计报告 / 验收报告）——
  //    它不是本插件产生的记忆 ⇒ 永远留在项目根。**这是本函数里最容易标错的一个面。**
  push(info?.docsDir, "内部文档", "material", "调研稿 / 审计报告 / 验收报告 —— **这类文件不在注入里，最容易成为检索终止符**", "project");
  push(info?.handoffDir, "交接单", "material", "上一场留给下一场的「做什么/当前状态/下一步」");
  // ★★★ 项目**根**这一面（`""`）：`_调研-*.md` 这类"放在表面"的稿子都在这里。
  //   ★ 今天的失败恰恰是「只看了根上那一份」—— 所以根必须在榜上，
  //     但它**不许独占**：真正的深度材料在 `docs/` 之下（那里才是病发处）。
  //   ★ 根面当然是项目自己的内容 ⇒ `"project"`。
  push("", "根目录稿", "material", "摊在项目根上的调研稿 / 计划 —— ★ **最容易成为检索终止符的地方**", "project");
  // ★ `fragment` = **碎片/细节**（按需查，不与成篇材料争榜首）。
  push(STASH_DIR, "分流细节", "fragment", "分流时判为「以后可能要查」的碎片 —— 按需 grep，不是「该先读的那份」");  // ★ 下面三类**不参与**材料排序，但仍然要出现在「面地图」里（模型得知道它们存在）。
  push(info?.archiveDir, "归档", "history", "已移出活跃台账的历史条目");
  push(info?.decisionsDir, "决策卡", "conclusion", "定了就不该变的架构/协议决定");
  push(info?.lessonsDir, "经验与教训", "conclusion", "踩过的坑 + 花代价探查的机制");
  push(info?.goalsDir, "目标树", "conclusion", "目标与教训");
  return out;
}

/**
 * 扫描一个目录下的 `.md`（有界：深度 + 文件数）。
 *
 * ★ 只收 `.md`：记忆是给人读的文本，二进制/构建产物不该进来。
 * ★ 跳过 `INDEX.md`（派生物不是内容 —— 与 `listCards` 同一条口径）。
 * ★ 任何读盘异常都**吞掉并继续**（一个坏文件不该让整个面扫不出来）。
 */
function walkMarkdown(root, dirRel, depth, out, seen) {
  if (depth > SCAN_MAX_DEPTH || out.length >= SCAN_MAX_FILES) return;
  // ★★★ `""` = **项目根**（本函数第三次栽出来的）：根目录上那几份 `_调研-*.md`
  //   不属于任何子目录，第一版把它们整个漏掉了 —— 而**今天害我停下的
  //   `_调研-billion-context.md` 正躺在根上**。⇒ 要扫的面必须包含"根"这一面。
  //   ★ 放进"根"面时**只收文件、不递归子目录**：子目录各有各的面，重复扫会算两遍。
  //
  // ★★★★★ 2026-10-21（D289 · V3）：**两个基准，两种面**。
  //   `root` 是**前面逐层传下来的基准**（调用方已经决定用哪个：记忆面传 `memoryBase`，
  //   项目面传 `projectRoot`）—— 所以这里**只做一件事：别再自己挑基准**。
  //   ★ 为什么必须由调用方决定：`memorySurfaces` 返回的面**混着两类**
  //     （`notesDir`/`handoffDir`/`archiveDir` 是记忆；`""`/`docsDir` 是项目自己的文档材料）。
  //     在这里统一换成某个基准，必然把其中一类扫错地方，而且**扫不到不报错**。
  const isRoot = dirRel === "";
  const abs = isRoot ? path.resolve(root) : path.resolve(root, dirRel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  // ★ 目录内按名字排序 ⇒ 结果稳定（不依赖文件系统返回顺序，否则同一份库两次排序不同）
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= SCAN_MAX_FILES) return;
    const rel = isRoot ? e.name : path.posix.join(dirRel, e.name);
    if (e.isDirectory()) {
      if (isRoot) continue; // ★ 根面只看根上的文件，不递归（子目录各有各的面）
      // ★ 不钻进 node_modules / .git / 以 `.` 开头的内部目录（那是实现细节，不是记忆）
      if (/^(node_modules|\.git|\.dsh.*)$/.test(e.name)) continue;
      walkMarkdown(root, rel, depth + 1, out, seen);
      continue;
    }
    if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
    if (/^INDEX\.md$/i.test(e.name)) continue;
    // ★★★ 根面上必须**排除已经每回合注入 / 已是权威入口**的那几份：
    //   · `LEDGER.md` = **本回合就在上下文里**（它就是那份注入），排进"该读哪份"毫无意义；
    //   · `README.md` / `LICENSE` = 对外说明，不是项目记忆；
    //   · `JOURNAL.md` = 只追加流水，按时间查而不是按重要性查。
    //   ⇒ 判据：**"锚定"只该覆盖"看不见的地方"** —— 一直看得见的东西不需要被提醒去看。
    //   ★ 这一条同样是"混类"：把**已注入的**与**按需查的**放一起排，就会让榜首经常是
    //     "你现在正在读的那份"，那是最坏的一种噪声。
    if (isRoot && /^(LEDGER|README|JOURNAL|LICENSE|PRINCIPLES)\.md$/i.test(e.name)) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
}

/**
 * 把整个记忆面扫成**候选清单**（每个文件读一段头部，抽六维原料）。
 *
 * @param {string} root 项目根
 * @param {object} info `inspect(root)` 的结果（只用它给的 rel 字段）
 * @returns {Array<object>} 每个：`{ rel, surface, label, text头部, sizeBytes, mtimeMs, ...原始值 }`
 *
 * ★ 性能：读的是**头部前 64 KB**（不是全文）—— `02-参照物精读` 这类 849 KB 的大卷
 *   如果整份读进来，光扫描就会超 D79 的回读预算。★ 头部足够算六维：
 *   日期在头部、证据标注在头部、`D<n>` 在头部、大小来自 `stat`。
 */
export function scanMemorySurface(root, info) {
  const seen = new Set();
  const surfaces = memorySurfaces(info);
  const files = [];
  // ★★★★★ 2026-10-21（D289 · V3）：**每个面各自决定用哪个基准**（分类见 `memorySurfaces`）。
  //   · `base: "memory"` ⇒ 记忆面（`notesDir` / `handoffDir` / `_stash` / 归档 / 卡片目录…）
  //     ⇒ 基准 `memoryBase`（V3 下在记忆子目录里）。
  //   · `base: "project"` ⇒ 项目**自己的**文档面（项目根那批 `_调研-*.md` 与 `docs/`）
  //     ⇒ 基准 `projectRoot`（它们不是本插件产生的记忆，不跟着搬）。
  //   ★ 为什么必须分开：V3 迁移只搬"本插件管的记忆"，项目自己的文档留在原地。
  //     若两类都按记忆基准解析，`docs/` 面会**扫到一个不存在的目录** ⇒ 静默扫出 0 份
  //     ⇒ 文件锚定里那些"材料地图"条目**集体消失**，而**不报任何错**。
  const memBase = memoryBaseOf(info, root);
  const projBase = typeof info?.projectRoot === "string" ? info.projectRoot : root;
  for (const s of surfaces) {
    const before = files.length;
    const base = s.base === "project" ? projBase : memBase;
    walkMarkdown(base, s.rel, 0, files, seen);
    for (let i = before; i < files.length; i += 1) files[i] = { rel: files[i], surfaceRaw: s };
  }
  const out = [];
  for (const item of files) {
    const rel = typeof item === "string" ? item : item.rel;
    const surfaceRaw = typeof item === "string" ? undefined : item.surfaceRaw;
    // ★ 与上面同一条判据：基准跟着**面**走，不跟着函数走。
    const base = surfaceRaw?.base === "project" ? projBase : memBase;
    const abs = path.resolve(base, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    let head = "";
    try {
      const fd = fs.openSync(abs, "r");
      try {
        const buf = Buffer.alloc(Math.min(SCAN_HEAD_BYTES, st.size));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        head = buf.subarray(0, n).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* 读不到 ⇒ head 空 ⇒ 各维都拿不到 ⇒ 不惩罚 */
    }
    out.push({
      rel,
      surface: surfaceRaw?.label ?? "",
      surfaceWhy: surfaceRaw?.why ?? "",
      // ★★★ `kind` 必须一路带到融合那一步 —— 少了它，"只在同类内比较"就是一句空话。
      kind: surfaceRaw?.kind ?? "material",
      head,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      hash: fnv1a(head),
    });
  }
  return out;
}

/**
 * 数「别的文件提到了这份文件」多少次（**被引用度**）。
 *
 * ★ 用**文件名**（不含目录、去掉 `.md`）匹配，因为人写引用时常常只写文件名
 *   （实测：D90:147 写的是 `_调研-billion-context.md`，不带目录）。
 * ★ 只在**决策卡 + 台账 + 交接单**里数 —— 那是"权威引用"，
 *   在别的调研稿里互相提及不算（那会形成"互相抬高"的假信号）。
 */
export function citationCountOf(rel, corpus) {
  const base = path.basename(rel).replace(/\.md$/i, "");
  // ★ 太短的名字（< 6 字符）不参与：`README` / `D90` 这类会到处假命中。
  if (base.length < 6) return 0;
  let n = 0;
  for (const doc of corpus ?? []) {
    if (doc.rel === rel) continue; // 自己不数自己
    if (doc.text.includes(base)) n += 1;
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、六维相对秩融合（与 `fuseWeight` **同一条尺子**）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★★★★★ 六维融合 ⇒ 每个文件一个 0~100 的**相对位置分**。
 *
 * @param {Array} files `scanMemorySurface` 的输出
 * @param {object} ctx `{ maxDecision, corpus }`
 *   · `maxDecision` = 全库当前最大 D 号（代际维的分母）
 *   · `corpus` = 用于数被引用度的文档（`[{rel,text}]`）
 * @returns {Array} 每项追加 `{ anchor: { score, why, dims, missing } }`
 *
 * ★★★ 与 `fuseWeight` 完全同构的四步：
 *   ① 每维取**原始值**；② `ranksOf` 排成名次；③ 名次线性铺满 [0,1]；
 *   ④ 加权平均（**只对拿得到的维求平均**）+ 四舍五入到 100。
 * ★ 多一维就多一条**独立的相对标尺** ⇒ 融合位置更准，且**单维出错不会定生死**（RRF 的抗性）。
 */
export function anchorFiles(files, ctx) {
  const all = Array.isArray(files) ? files.slice() : [];
  if (all.length === 0) return [];

  // ★★★★★ 先按 `kind` 分组，**在各组内部各自求相对秩**（第一版的教训见 `memorySurfaces`）。
  //   ★ 为什么不是"算完分再排序时过滤"：那样归档片段的高分仍会把
  //     **材料组的相对位置**挤压（秩是组内算的，混组算等于用错分母）。
  //   ⇒ 判据：**分母必须与分子同类**（纪律 15 的正面写法）。
  const groups = new Map();
  for (const f of all) {
    const k = typeof f.kind === "string" && f.kind !== "" ? f.kind : "material";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const out = [];
  for (const [kind, list] of groups) {
    for (const scored of anchorWithinKind(list, ctx)) out.push({ ...scored, kind });
  }
  return out;
}

/**
 * ★ 在**一组同类文件内**做六维相对秩融合（`anchorFiles` 的唯一实现体）。
 *
 * ★ 单独抽出来是为了让自检能直接断言"组内才算秩"这条性质，
 *   而不必构造一个完整的项目目录。
 */
export function anchorWithinKind(list, ctx) {
  const maxD = Number.isFinite(ctx?.maxDecision) ? ctx.maxDecision : undefined;
  // ★★★ 「配了就该跑」不是证据 —— 要有可查判据（台账纪律）。
  //   `corpus` 没给 ⇒ 被引用度**一维全体算 0**，而"0"和"真的没人引"长得一模一样。
  //   ⇒ 必须**显式区分**：`hasCorpus === false` ⇒ 这一维进 `missing`（未计分），
  //     而不是悄悄按 0 参与平均（那会让所有文件在这一维上同分，等于白算还看不出来）。
  const hasCorpus = Array.isArray(ctx?.corpus) && ctx.corpus.length > 0;

  // ── ① 抽每维的原始值（`undefined` = 这一维拿不到）──
  const raw = list.map((f) => {
    const text = f.head ?? "";
    const declared = declaredDateMs(text);
    const maxRef = maxDecisionRefOf(text);
    return {
      f,
      firsthand: evidenceLevelOf(text),
      recency: declared !== undefined ? declared : Number.isFinite(f.mtimeMs) ? f.mtimeMs : undefined,
      // ★ 被引用度：**有语料才算**；没语料 ⇒ undefined（未计分，不是 0）
      cited: hasCorpus ? citationCountOf(f.rel, ctx.corpus) : undefined,
      // ★ 代际：落后多少代 ⇒ 越小越"老"。用 `maxD - maxRef`（缺席者不计分）
      generation:
        maxRef !== undefined && maxD !== undefined ? maxD - maxRef : maxRef !== undefined ? maxRef : undefined,
      size: Number.isFinite(f.sizeBytes) ? f.sizeBytes : undefined,
      star: starValueOf(text),
    };
  });

  // ── ② 各维折成相对位置（1 = 最好，0 = 最差）──
  //   ★ 必须除以 `n-1` 才能铺满 [0,1]。
  //   ★★★ 但**"只有一个文件"不能全给 1**（D260 修的就是这一条）：
  //     纯相对秩在 n=1 / 全体同值时**退化成按绝对量给分**，而且方向是反的 ——
  //     一份落后 227 代的孤本会拿 **100 分**、三份一样老的稿子白拿**并列中点 0.5**。
  //     ⇒ 判据：**这一维没有区分力时，就不能记分**（进 `missing`，与"取不到值"同等待遇）。
  //     这正是本项目自己的纪律：**绝对判据在没有参照时无区分力**（D136 同型），
  //     而"无区分力却给了分"比"没给分"更危险 —— 它看起来像有依据。
  const n = raw.length;
  const span = n > 1 ? n - 1 : 1;
  const keyOf = (i) => String(i);
  const dims = [
    // ① 一手性：标注越多越好（`[未证实]` 已在 `evidenceLevelOf` 里减掉）
    { name: "一手", weight: 3.0, get: (r) => r.firsthand, better: (a, b) => b - a },
    // ② 时效：越新越好（相对序）
    { name: "时效", weight: 2.0, get: (r) => r.recency, better: (a, b) => b - a },
    // ③ 被引用度：被点名越多越好
    { name: "被引用", weight: 1.5, get: (r) => r.cited, better: (a, b) => b - a },
    // ④ 代际：落后**越少**越好 ⇒ 升序（★ 这是唯一一维"数值小=更好"）
    { name: "代际", weight: 2.5, get: (r) => r.generation, better: (a, b) => a - b },
    // ⑤ 体量：越小越容易**整份读完**（超预算的只降一点，不是判死）
    { name: "体量", weight: 0.5, get: (r) => r.size, better: (a, b) => a - b },
    // ⑥ 星值：越多越好
    { name: "星", weight: 1.0, get: (r) => r.star, better: (a, b) => b - a },
  ].map((d) => {
    const entries = raw.map((r, i) => ({ key: keyOf(i), value: d.get(r) }));
    const ranks = ranksOf(entries, d.better);
    const pos = new Map();
    // ★★★ D260：**只有一个取值** ⇒ 这一维没有区分力 ⇒ 一个都不给分（进 missing）。
    //   判据用"**排过序之后的取值全等**"，而不是 `n === 1` ——
    //   三份一样老的稿子与单份孤本是**同一个病**，只挡 n===1 会漏掉前者（探针实测过）。
    const finiteValues = entries.map((e) => e.value).filter((v) => Number.isFinite(v));
    const noDiscrimination = finiteValues.length < 2 || finiteValues.every((v) => v === finiteValues[0]);
    if (!noDiscrimination) for (const [k, rk] of ranks) pos.set(k, 1 - rk / span);
    return { ...d, ranks, pos, noDiscrimination };
  });

  // ── ③ 加权平均（**只对拿得到的维求平均**）──
  return raw.map((r, i) => {
    let sum = 0;
    let w = 0;
    const why = [];
    const missing = [];
    // ★ D260：「取不到值」与「有值但没区分力」是**两件事**，但待遇相同（都不计分），
    //   所以分两个名单记下来 —— 不然排查时会把"这一维没数据"误读成"这一维算过了"。
    const flat = [];
    for (const d of dims) {
      const p = d.pos.get(keyOf(i));
      if (p === undefined) {
        if (d.noDiscrimination) flat.push(d.name);
        else missing.push(d.name);
        continue;
      }
      sum += d.weight * p;
      w += d.weight;
      const rk = d.ranks.get(keyOf(i));
      why.push(`${d.name}第${Math.round((rk ?? 0) + 1)}/${n}`);
    }
    // ★★★ 缺值不惩罚：**只对自己已有的维度求平均**（D198 同型纪律）。
    //   若一维都拿不到 ⇒ 0 分，且如实说"没有任何一维可用"（不假装它好或坏）。
    const score = w > 0 ? Math.round((sum / w) * 100) : 0;
    // ★★★★★ 一条**必须承认的取舍**（不是 bug，但会被人问，所以写在这里）：
    //   「缺值不计分」意味着**没有标注 ≥ 有少量标注**。
    //   例：A 文件一处 `[本地一手]`（名次靠后 ⇒ 一手维得分很低）、B 文件一处标注都没有
    //   ⇒ B 在这一维**免评**，A 反而被自己那处标注拖累。
    //   ★ 为什么仍然这么做：反过来（无标注按 0 计）会把**所有没写标注的老文件**一律判死，
    //     那正是 D198 已经否掉的那条（"不知道就不惩罚"）。
    //   ★ 但**必须让它可被发现**：所以 `missing` 里如实列出来，注入里也就带得出来
    //     （渲染时写「一手无值·未计分」）。**不许让它看起来像"它一手性好"**。
    //   ⇒ 一句话：**缺值不惩罚，但缺值必须可见**。
    return {
      ...r.f,
      anchor: {
        score,
        why,
        missing,
        // ★ D260：有值但同组内**没有区分力**的维（n=1 / 全体同值）。
        //   与 `missing` 一样不计分，但分开记 —— 两者排查时含义完全不同。
        flat,
        usedDims: w,
        // ★ 原始值留档（排查用：分数怪的时候能看见是哪个数把它抬上去的）
        raw: {
          firsthand: r.firsthand,
          recency: r.recency,
          cited: r.cited,
          generation: r.generation,
          size: r.size,
          star: r.star,
        },
      },
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、渲染（**小索引，可常驻** —— D46：索引推行，细节按需拉）
// ═══════════════════════════════════════════════════════════════════════════

/** 默认推行几条（★ 有界：D79 回读预算下，索引必须小到能每回合推）。 */
export const FILE_ANCHOR_TOP = 6;
/** 注入里每行标题截断长度。 */
const TITLE_CHARS = 48;

/**
 * ★★★★★ 渲染「文件锚定」那一段 —— **这是本机制真正的交付物**。
 *
 * ★★★ 它与"一个排序列表"的区别（**这是全部价值所在**）：
 *   它不只说"该读哪份"，它**必须说清"为什么你手上那份不是最好的一份"**。
 *   ⇒ 今天的失败不是"我没有搜索能力"（`docs/` 一个 glob 就列出来了），
 *     而是**没有任何东西告诉我"还有更权威的"**。
 *   ⇒ 所以：只要存在**同面内分差显著**的文件，就必须点名告警。
 *
 * @param {Array} anchored `anchorFiles` 的输出
 * @param {object} opts `{ top, surfaceLabel, minScore }`
 */
export function renderFileAnchor(anchored, opts) {
  const list = Array.isArray(anchored) ? anchored.slice() : [];
  if (list.length === 0) return "";
  const top = Number.isFinite(opts?.top) ? Math.max(1, opts.top) : FILE_ANCHOR_TOP;

  // ★★★ 只渲染 `material` 那一类：**"该读哪份材料"这个问题只能在同类材料之间问**
  //   （第一版把归档片段与决策卡一起排，结果榜首全是它们 —— 见 `memorySurfaces` 的留档）。
  //   ★ `conclusion` / `history` 由 `renderSurfaceMap` 报"存在多少"，不排进这份榜。
  const material = list.filter((f) => (f.kind ?? "material") === "material");
  if (material.length === 0) return "";
  // ★ 按分降序；同分按路径字典序 ⇒ **结果稳定**（否则同一份库两次注入顺序不同会打穿缓存）
  const sorted = material.sort((a, b) => (b.anchor?.score ?? 0) - (a.anchor?.score ?? 0) || a.rel.localeCompare(b.rel));

  // ★ 每行：分数 + 路径 + 为什么在这个位置（**why 不许省** —— 没有理由的排序无法被质疑）
  //   ★★ 截断策略：**保目录、截文件名**。第一版从左截（`…36-模型侧压缩合同…`）⇒
  //     模型的困惑恰恰来自"这是哪个面里的"，**目录名就是那个信息**，绝不能砍掉。
  const lineOf = (f) => {
    const a = f.anchor ?? {};
    const dir = f.rel.includes("/") ? `${f.rel.slice(0, f.rel.lastIndexOf("/"))}/` : "";
    const base = f.rel.slice(dir.length);
    const name = dir.length > TITLE_CHARS ? `…${dir.slice(-(TITLE_CHARS - 2))}${base}` : dir + (base.length > TITLE_CHARS ? `${base.slice(0, TITLE_CHARS - 1)}…` : base);
    const why = (a.why ?? []).slice(0, 4).join(" · ");
    const miss = (a.missing ?? []).length > 0 ? `（${a.missing.join("/")}无值·未计分）` : "";
    // ★ D260：同组内**没有区分力**的维也要说出来（n=1 或全体同值）。
    //   不说的后果：分数悄悄变低，没人知道为什么 —— 与 D167「谎报成功」镜像的谎言（沉默地少算）。
    const fl = (a.flat ?? []).length > 0 ? `（${a.flat.join("/")}无区分力·未计分）` : "";
    return `- **${a.score ?? 0}** \`${name}\` — ${why}${miss}${fl}`;
  };

  const shown = sorted.slice(0, top);
  const rest = sorted.length - shown.length;

  // ★★★★★ D261（用户 2026-10-18 亲口纠正）：**「有哪些」与「先看哪个」是两件事。**
  //
  //   用户原话：*"模型依旧应该去查所有的文本 —— 看不看取决于分数高低，但得让模型知道相关的有哪些文件"*
  //
  //   ★ 我原来的设计把第 `top` 名之后**折成一行「另有 N 份未被列出」** ——
  //     那等于**模型根本不知道它们存在**，分数于是变成了"可见性"而不是"顺序"。
  //     这是把一个排序问题做成了筛选问题，而**筛选是最危险的那一步**：
  //     被判掉的那份，模型连"要不要读"的机会都没有。
  //
  //   ★ 正确形态（两档，实测过体积）：
  //     · **该读的材料（material）⇒ 全列**。本项目实测 25 条 ≈ 1.7K 字符，
  //       而只列 6 条 ≈ 0.4K ⇒ **多花 1.3K 换掉"不知道有 19 份存在"，极其划算**。
  //     · 碎片 / 归档 / 结论 ⇒ **不逐条列**（合计 ≈ 2.5 万字符，全列会把真材料淹掉），
  //       由 `renderSurfaceMap` 报"各面存在多少份"。
  //   ★ 判据：**分数只决定顺序与标注，绝不决定是否可见。**
  //     （若将来某面材料多到全列超预算，就按面分档 + 明写"该面共 N 份、此处列前 K"——
  //       **永远不许出现"有 N 份你连名字都看不到"**。）
  const fullList = opts?.fullList === true;
  const listed = fullList ? sorted : shown;
  const hidden = sorted.length - listed.length;

  // ★★★ 告警：**榜首与次席分差**说明"你手上那份可能不是最好的一份"。
  //   阈值取 `WEIGHT_MUST_INJECT` 那套的相对含义：分差 ≥ 15 才算"显著不同档"。
  const gapWarn =
    sorted.length >= 2 && (sorted[0].anchor?.score ?? 0) - (sorted[1].anchor?.score ?? 0) >= 15
      ? `\n★ **榜首明显高于次席**（${sorted[0].anchor?.score ?? 0} vs ${sorted[1].anchor?.score ?? 0}）` +
        ` ⇒ 先读它；★ 但**次席也要知道存在** —— 只读榜首就可能停在它上面（D234 那个坑）。`
      : "";

  // ★★ 老一代告警：**这是今天真正能救我的那一句**。
  //   条件：存在某文件的"代际"维落后（raw.generation > 0），且它分数不低（进了前 top）
  //   ⇒ 明说"它之后还有 N 代决策，它并不知道"。
  const staleNotes = listed
    .filter((f) => Number.isFinite(f.anchor?.raw?.generation) && f.anchor.raw.generation > 0)
    .slice(0, 3)
    .map((f) => {
      const g = f.anchor.raw.generation;
      return `- \`${path.basename(f.rel)}\` 提到的最新决策比当前落后 **${g} 代** ⇒ **它之后发生了什么，它一个字都不知道**（读它之前先看更新的材料）。`;
    });

  return (
    "\n### ★ 文件锚定（哪个记忆面里有材料、该先读哪份）\n" +
    "★ 这份列表治的是**「查到一份够用的就停手」**（D234）—— 它不只告诉你**该读什么**，" +
    "也告诉你**还有哪些没读**。\n" +
    // ★★★ D261：把「分数只是顺序」这句话写进注入本身，防止模型把低分读成"不用看"。
    "★ **分数只决定顺序，不决定要不要看** —— 下面**全部**都是同类待读材料，" +
    "分数低只表示**可以稍后再读**，不表示可以不读。\n" +
    "★ 六维全是**相对位置**（一手性 3.0 · 时效 2.0 · 代际 2.5 · 被引用 1.5 · 星 1.0 · 体量 0.5），" +
    "**同一份文件在别的项目里分数会不同，那是故意的**；拿不到的维度**不计分**（不惩罚）。\n" +
    listed.map(lineOf).join("\n") +
    // ★ D261：只剩"真的没列出来"时才会走到这里，且必须说清是**哪一类**没列 ——
    //   绝不写成「另有 N 份未被列出」那种让模型以为"剩下的不重要"的说法。
    (hidden > 0
      ? `\n- ……本面共 **${sorted.length}** 份，此处只列前 **${listed.length}** 份（其余同类材料同样存在，只是没在此逐条展开）`
      : "") +
    gapWarn +
    (staleNotes.length > 0 ? `\n★ **老一代材料提醒**：\n${staleNotes.join("\n")}` : "") +
    "\n"
  );
}

/**
 * 「记忆面地图」 —— D46 说的"索引推行"的最小形态。
 *
 * ★ 与 `renderFileAnchor` 分工：那个说**具体文件**，这个说**有哪些面、各多少**。
 * ★ 为什么两样都要：只有文件列表 ⇒ 模型不知道"**还有别的面我没看**"（本次的根因正是这个）；
 *   只有面地图 ⇒ 知道有面但不知道里面有什么。
 *
 * ★★ 按 `kind` 分两节（**这个分组本身就是信息**）：
 *   · `material`  = **该去哪找材料**（D234 的病发地）；
 *   · `conclusion`/`history` = **已有的结论与历史**（查"以前定过什么"用它们，
 *     但它们**不该**跟材料一起排序 —— 那会让归档片段淹没一手材料）。
 */
export function renderSurfaceMap(counts) {
  const rows = Array.isArray(counts) ? counts.filter((c) => c.count > 0) : [];
  if (rows.length === 0) return "";
  const mat = rows.filter((c) => (c.kind ?? "material") === "material");
  const frag = rows.filter((c) => (c.kind ?? "material") === "fragment");
  const other = rows.filter((c) => (c.kind ?? "material") !== "material" && (c.kind ?? "material") !== "fragment");
  const lineOf = (c) => `- **${c.label}** \`${c.rel}\` — ${c.count} 份｜${c.why}`;
  return (
    "\n### ★ 记忆面地图（**除台账外，这些地方都不会自动进你的视野**）\n" +
    (mat.length > 0 ? `**① 找材料的去处**（问「查过没 / 有没有别的说法」时看这里）：\n${mat.map(lineOf).join("\n")}\n` : "") +
    (frag.length > 0
      ? `**② 碎片与细节**（按需查；★ **不与成篇材料争先后** —— 它们是"某个时刻的一小段"）：\n${frag.map(lineOf).join("\n")}\n`
      : "") +
    (other.length > 0
      ? `**③ 已有的结论与历史**（问「以前定过什么 / 这条从哪来」时看这里；\n` +
        `　★ 它们不参与材料排序 —— 归档是**过去**，决策是**判据**，都不是"该读的材料"）：\n` +
        other.map(lineOf).join("\n") +
        "\n"
      : "") +
    "\n★ 判据：**回答「有没有做过 / 怎么决定的」之前，先扫一遍相关的面** —— " +
    "只看一个面就下结论，正是 D234 那个坑。\n"
  );
}

export { WEIGHT_MUST_INJECT };
