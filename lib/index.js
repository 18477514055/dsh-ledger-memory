/**
 * dsh-ledger-memory —— 「项目台账自动管理」宿主半边（Host half，node 侧）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个插件做什么（**只做流程，不做模板**）
 * ═══════════════════════════════════════════════════════════════════════════
 * 需求原话：*"台账的具体文件名、结构、字段由 AI 在初始化时根据项目类型自行决定，
 * 插件只负责检测、注入、更新、归档、Git 配合这些『流程性』工作。"*
 * ⇒ 本插件**不预设任何模板**。它管的是：
 *
 *   ① 检测   —— 当前工作区是不是"全新项目"（无 .git、无台账文件）
 *   ② 提示   —— 是全新项目 ⇒ 提醒 AI 去问用户要不要初始化
 *   ③ 注入   —— 有台账 ⇒ 把**活跃台账**内容注进会话上下文（变了才注，防缓存抖动）
 *   ④ 落地   —— 给 AI 八个工具，让它按自己设计的结构读写台账
 *   ⑤ 归档   —— 活跃台账超阈值 ⇒ 把 AI 点名的旧条目移进 archiveDir/YYYY-MM/weekN
 *   ⑥ Git    —— git init + 合并式 .gitignore + `git add -- <明确路径>`（绝不 add -A）
 *   ⑦ 命令   —— /ledger（裸敲弹选择卡片）| show | update | archive | init | log | status
 *   ⑧ 日志   —— 可选的活动日志（L0 里程碑 / L1 回合摘要 / L2 文件流水 / L3 工具流水），
 *                **永不注入上下文**，按周分桶且与归档共用期间键，需要时用 ledger_log 回溯
 *   ⑨ 问题记录 —— 给"不是项目、只是一次性问题/调研"的那一类（本机 112 个会话里 104 个
 *                的 cwd 就是容器根）。落到工作区既有的记录通道，**不是台账**、没有归档。
 *   ⑩ 重构   —— 检测**已存在**项目的台账是否合规；不合规时弹卡片问要不要改，
 *                修复**只做加法**（补清单字段、补缺失的空文件/空目录），绝不改写已有内容
 *   ⑪ 回合末 —— agent/turn-stopping 自动给出四选一（不阻塞回合）
 *   ⑫ 第一轮 —— 会话第一轮结束时先弹「建项目 or 不建」（也是一次性、只问一次）
 *   ⑬ 压缩后 —— compaction/end ⇒ 台账强制重注并提示
 *   ⑭ 回执   —— AI 写完台账后，**下一次弹卡片时告知用户**改了什么、哪个会话改的
 *                （工具返回值只发给 AI，用户看不到 —— 见 D22）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 结构由 AI 定，那插件**怎么知道读哪个文件**？（本插件的核心设计点）
 * ═══════════════════════════════════════════════════════════════════════════
 * 用一个**指针清单** `.dsh-ledger.json`（放在项目根，纳入 Git 追踪）：
 *
 *     { "active": "LEDGER.md", "decisions": "DECISIONS.md",
 *       "archiveDir": "_ledger-archive", "maxActiveLines": 150, ... }
 *
 * 发现顺序：
 *   1. 项目根有 `.dsh-ledger.json` ⇒ 按它指的文件名走（**AI 自定名的唯一通路**）
 *   2. 没有 ⇒ 用**保守的候选名**猜（LEDGER.md / 台账.md / 项目台账.md / STATUS.md …）
 *      —— 只认"名字里带 ledger/台账/status"的，避免把 TODO.md 这类通用文件误认成台账
 *   3. 都没有 ⇒ 判定"未初始化"，走 ② 的提示路径
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★ 安全与稳定约束（**改动前必读**，每条都有出处或事故）
 * ═══════════════════════════════════════════════════════════════════════════
 * ① **不许 `import "@deepseek-ai/*"`**。插件本体在工作区，profile 里是 Junction，
 *    Node 按**真实路径**解析（内核没开 --preserve-symlinks）⇒ `ERR_MODULE_NOT_FOUND`
 *    ⇒ **内核起不来**。已实测：`6.会话工作区用途\lib\index.js:1013-1022`。
 *    ⇒ 内核能力全走**服务调用**，消息体自己手搓。
 *
 * ② **`inject` 里没声明的服务，访问属性即抛错**（不是"取到 undefined"）：
 *      Error: cannot get property "tools" without inject
 *    apply() 抛错 ⇒ **整个 profile 组合失败、内核起不来**（2026-09-23 真事故，
 *    出处见 `6.会话工作区用途\lib\index.js:62-88`）。
 *    ⇒ 必需服务写进 `inject`；可选服务用官方的 `ctx.inject([...], cb)` 模式
 *      （cb 不执行也不抛错），其余一律 `ctx.get(name)` + try/catch。
 *
 * ③ **注入的消息必须带非空 string `id`**。缺 id 时**当场不报错、重载历史时才校验**：
 *      dsh-session\lib\index.js:934
 *        throw new Error(`${subject} lacks an identified message`);
 *    一条坏事件 ⇒ **整个会话历史读不出来**（真实事故：60/60 条注入事件全缺 id，
 *    那个会话报废）。⇒ 用 `node:crypto` 的 randomUUID()（零解析风险），并加兜底自检。
 *
 * ④ **永不 `git add -A`**（全局红线 §九.6）⇒ 只 `git add -- <明确路径>`。
 *
 * ⑤ **不碰 `$DSH_HOME\sessions\` / `storages\`**（全局红线 §九.2）。
 *    本插件的会话态**只在内存**（Map），进程退出即消失，不落盘。
 *
 * ⑥ 所有写入**必须落在项目根之内**（isUnder 判定），拒绝 `..` 穿越。
 *
 * ⑦ **日志采集是同步跑在 `Session.append()` 路径上的**（`session/event` 在 append
 *    内部同步触发）⇒ 采集里抛错会**连累官方写会话日志**。所以采集全程吞错，
 *    并且已用"坏事件"用例覆盖（`data: null`、非法 JSON 参数、`message: null`、空 cwd）。
 *    另：落盘走**去抖**（`LOG_FLUSH_DEBOUNCE_MS`），且 `git add` 只在回合末/卸载做 ——
 *    否则一场几百次调用的会话会白拉几百个 git 进程。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

/** 插件 id。★ 必须与 package.json 的 name、cordis.patch.yml 里的 id 三处一致。 */
export const name = "dsh-ledger-memory";

/** 必需服务：五个工具与守卫都挂在 tools 上。见文件头 ②。 */
export const inject = ["tools"];

// ═══════════════════════════════════════════════════════════════════════════
// ★ 设置（官方设置面板：设置导航里独立一页）
// ═══════════════════════════════════════════════════════════════════════════
//
// 用户 2026-10-09：*"考虑把我们的插件变得可以调节设置，设置面板像插件市场一样
// 注册进官方的设置中。"* ⇒ 选了「设置导航里单独一页」，并要暴露下面七项。
//
// ★★ 两条实现约束（都是从内核源码读出来的，不是猜的）：
//
//   ① **`Config` 必须是 StandardSchemaV1**。
//      `@deepseek-ai/cordis/src/registry.ts:107`：`Config?: StandardSchemaV1<any, T>`，
//      而内核只用它一个东西（`cordis/lib/index.js:960`）：
//          const result = runtime.Config["~standard"].validate(config);
//      同步、返回 `{value}` 或 `{issues}`，不许返回 Promise（`:961` 会抛
//      *"Async config validation is not supported"*）。
//      ⇒ 所以 `Config` **手写**成普通对象即可，**不需要 import 任何东西**。
//      ⚠️ 这不是将就：本插件的目录是 **Junction 目标**，Node 解析**真实路径** ——
//         实测从 `lib/` 往上 `require.resolve("@deepseek-ai/schemastery")`
//         得到 `MODULE_NOT_FOUND`。**import 反而会炸**（那正是本文件开头
//         「绝不 import @deepseek-ai/*」那条红线的由来）。
//
//   ② **改设置必须走 `configEditor.edit()`**，不许自己改 profile 的 patch 文件。
//      那是官方家目录里的东西（红线§九.1）。`configEditor` 是 **host** 服务：
//          entries() / configuration() / edit(entry, change)
//      ⇒ 客户端半边拿不到它（它**没有** `@Remote` 标注），所以宿主半边要自己
//        开一条 HTTP 路由转发（见 `installSettingsRoutes`）。
//
// ★ 一项设置两个出口会不会分叉？**不会 —— 只有一个真源**：
//   写成 Loader entry 的 `config`（官方配置系统），面板读它、写它也写它。
//   面板**不自建**存储。（这是本文件 D25「一个事实只能有一个判定出口」的延续。）
//   ⚠️ 例外见下面 `maxActiveLines` / `logLevels` 的口径说明。

/**
 * 设置的默认值 —— **与今天的硬编码行为逐条一致**。
 *
 * ★★ 为什么这一条是硬要求：`cfg.X !== false` 这种写法**不带配置时必须是今天的行为**。
 *   任何一项默认值写错，都等于**静默改变了所有现有项目**的行为 ——
 *   而那是最难被发现的一类回归。自检情形 27 有专门的断言守着它。
 *
 * ★★ 为什么是**函数**而不是常量对象（这一条踩过 TDZ）：
 *   这段设置代码放在文件前部（可读性），而它引用的 `DEFAULT_LOG_LEVELS` /
 *   `PRESSURE_TIERS` / `HIGH_FIDELITY_COMPACT_RATIO` / `DEFAULT_MAX_ACTIVE_LINES`
 *   定义在后面。写成常量对象 ⇒ 模块初始化时**当场**求值 ⇒
 *   `ReferenceError: Cannot access 'DEFAULT_LOG_LEVELS' before initialization`
 *   （实测撞到，`import` 直接失败 ⇒ 内核起不来）。
 *   写成函数 ⇒ 只在真正用到时才求值，那时模块早已初始化完毕。
 *   ⚠️ 也**不要**为此把常量抄一份字面量进来 —— 那就成了"两处各写一份"，
 *      正是本文件反复警告的那种会分叉的写法。
 */
function settingDefaults() {
  return {
    mode: MODE_STEADY, // 默认「正常推进」= 与今天的行为逐条一致
    turnEndOffer: false, // 回合末四选一卡片（2026-10-09 用户决定默认关）
    highFidelityCompact: true, // 水位到点跑我们自己的高保真压缩
    // 触发水位：**复用那个常量**，不抄字面量（早于内核的 0.8）
    highFidelityCompactRatio: HIGH_FIDELITY_COMPACT_RATIO,
    autoCompact: true, // 允许插件代调 compactNow
    // ★★ 压缩前**强制**台账 + L1 落盘（用户 2026-10-09 反复强调的那一条）
    requireFlushBeforeCompact: true,
    // ★★★★ 2026-10-12（D136 步 3）：**区块级注入**。默认**关**。
    blockInjection: false,
    // ★★★★★ 2026-10-13（D155，用户拍板）：**全量压缩为主力 ⇒ 增量默认关**。
    //
    //   用户原话：*"模型将把全量压缩当成主力，不用在回复中直接压缩，而是在回复完成后，
    //   如检测到这个水位高于30%（这个可以调）则进行一次全量压缩。"*
    //
    //   ★ 为什么关掉增量（三条实测，见 D148/D153/D154）：
    //     ① 增量**折点在靠前处**（保留 60~80%）⇒ 折点之后约 60 万 tok **全部作废重算**；
    //        全量折到 ~10% ⇒ 身后几乎无物 ⇒ 单次全价重算 22,069 vs 增量 364,872（**16 倍**）；
    //     ② 增量的落点**逐轮抬高**（本会话实测 62→68→74→75%），是"棘轮"；
    //        全量每次都落到 9.8~11.2% ⇒ **只有全量能维持低水位**；
    //     ③ 每点代价：折得浅 **886,569** vs 折得深 **15,510**（**57 倍**）。
    //   ★ 保留旧路的理由：`/ledger light`（人的明确授权，D40）与
    //     `ledger_compact({mode:"light"})`（模型主动要压）**仍然可用** ——
    //     只是**不再由插件自动触发**。想回退只需把这个开关打开。
    incrementalCompact: false,
    deltaTriggerPoints: DEFAULT_DELTA_TRIGGER_POINTS,
    deltaRemovePoints: DEFAULT_DELTA_REMOVE_POINTS,
    logLevels: { ...DEFAULT_LOG_LEVELS },
    maxActiveLines: DEFAULT_MAX_ACTIVE_LINES,
    changeRegisterMax: CHANGE_REGISTER_MAX,
    pressureTiers: [...PRESSURE_TIERS],
    // ═══════════════════════════════════════════════════════════════════════
    // ★★★★ 2026-10-12（D138）：**新增可调项** —— 全部**复用既有常量**做默认值。
    //   ★★ 一律不抄字面量：抄了就是"两处各一份"，改一处忘另一处 ⇒ 静默分叉
    //      （本文件反复警告的那种写法；`clampNumber` 的存在就是为了收掉这类分叉）。
    //   ★ 默认值**必须与今天的行为逐条一致**（情形 27 的断言守着这一条）——
    //     任何一项写错 = 静默改变所有现有项目的行为。
    // ═══════════════════════════════════════════════════════════════════════
    triageKeepMax: TRIAGE_KEEP_MAX,
    // ★★★★★ 2026-10-13（D158）：**跨多次分流累积**的 keep 总量上限。
    //   ★ 用户当场指出："全量压缩把现有的**所有**分流情况全部进行压缩"——
    //     原来 keep 是单槽覆盖（只活最后一次），每回合分流时几乎全被丢掉。
    triageKeepTotalMax: TRIAGE_KEEP_TOTAL_MAX,
    // ★★★ 2026-10-12（D141）：**压之前的体量门槛**（点）—— 见 `MIN_COMPRESS_POINTS`。
    //   ★ 默认 **1**：语义是"至少要够压掉 1 点，否则不值得付那次重注"。
    //     ★ 它**恰好**能滤掉 D139 实测那 7 次空转（产出都 < 1 点）。
    minCompressPoints: MIN_COMPRESS_POINTS,
    triageOwedMaxAgeMs: TRIAGE_OWED_MAX_AGE_MS,
    capsuleMaxChars: CAPSULE_MAX_CHARS,
    recallMaxChars: RECALL_MAX_CHARS,
    weightMustInject: WEIGHT_MUST_INJECT,
    weightPrincipleScore: WEIGHT_PRINCIPLE_SCORE,
    weightDoneCap: WEIGHT_DONE_CAP,
    shadowedIndexMax: SHADOWED_INDEX_MAX,
    maxReadChars: MAX_READ_CHARS,
    maxArchiveList: MAX_ARCHIVE_LIST,
    nudgeMinRatio: NUDGE_MIN_RATIO,
    logDefaultLimit: LOG_DEFAULT_LIMIT,
    logBriefChars: LOG_BRIEF_CHARS,
    userMsgMaxChars: USER_MSG_MAX_CHARS,
    capsuleUserMsgMax: CAPSULE_USER_MSG_MAX,
    capsuleUserMsgChars: CAPSULE_USER_MSG_CHARS,
    capsuleErrorMax: CAPSULE_ERROR_MAX,
    capsuleErrorChars: CAPSULE_ERROR_CHARS,
    capsuleArtifactMax: CAPSULE_ARTIFACT_MAX,
    capsuleStoreSessions: CAPSULE_STORE_SESSIONS,
    blockHistoryMax: BLOCK_HISTORY_MAX,
  };
}

/**
 * ★★★★ 2026-10-12（D138）：统一的**数值取值出口** —— 面板改了就真生效。
 *
 * ★ 为什么必须有它：面板上每一项的值都来自 `currentSettings()`，而**行为侧**以前
 *   直接读常量（`CAPSULE_MAX_CHARS` 之类）⇒ 面板改了，行为不变。
 *   那是"空承诺"里最坏的一种（本机纪律：**写了就得做到**）。
 *   ⇒ 所有可调项**一律经这里取**，取不到才退回常量（`fallback`）。
 *
 * ★ 传 `fallback` 而不是直接返回 `undefined`：调用点都是"要一个数去用"，
 *   让它们各自处理 undefined 会散落成十几处 `?? 常量`（那又是分叉）。
 */
function numOf(key, fallback) {
  const v = currentSettings()[key];
  return Number.isFinite(v) ? v : fallback;
}

/**
 * 设置的元数据 —— **面板与校验共用这一份**。
 *
 * ★ 为什么元数据要放在宿主而不是客户端：客户端半边是**经典脚本**、
 *   只能 `require` 平台共享表里那 9 个词，**读不到宿主的内存**。
 *   ⇒ 面板通过 HTTP 把这份元数据取过去渲染，两边就不会各写一份而分叉。
 *
 * `kind` 决定面板画什么控件；`group` 决定它归到哪一组（见 SETTING_GROUPS）。
 *
 * ★★★ 文案规矩（2026-10-12 D124，用户原话：*"它的文本现在是 markdown，而不是纯文本，
 *   看着不太舒服"*）：
 *   · `label` / `hint` **一律是纯文本** —— 面板把它当**纯文本渲染**，不解析 markdown；
 *   · 所以**不许**出现 `**` `*` `` ` `` `#` `[..](..)` 这类标记：
 *     它们会**原样显示**成"没写完的语法"；
 *   · 强调靠**短句 + 分组 + 样式**（面板侧给 `.pl-settings__hint--warn` 等类），
 *     不靠标点；需要引用具体标识符时才用「」或直接写 key。
 *   · ★ 自检有一条断言守着这件事（见情形 50），写回 `**` 会**当场变红**。
 *
 * ★ `scopeNote`：这项是否"项目清单优先"（`.dsh-ledger.json` 里的值盖过这里）。
 *   面板据此画一个小标记 —— 以前只有散文里提，UI 上看不出来，容易被误当成全局设置。
 */
const SETTING_SPECS = [
  // ═══════════════════════════════════════════════════════════════════════════
  // ★★★★★ 2026-10-12（D138，用户：「重置整个设置面板，把能修改的东西都放进去」）
  //
  //   ★★ 三条**新增的硬纪律**（下面每一项都必须满足，自检守着）：
  //     ① **每一项都必须真有消费者** —— 面板上出现一个不起作用的开关
  //        是"空承诺"里最坏的一种（本机纪律：**写了就得做到**）。
  //     ② **`min`/`max`/`step`/`unit` 只写一次**（写在 spec 里），
  //        `normalizeSettings` **从 spec 读** —— 绝不两处各抄一份（会分叉）。
  //     ③ **文案纯文本**（面板不解析 markdown；`**` 会原样显示）。
  //
  //   ★ 取值一律经 `numOf(key)` 走 `currentSettings()`，**不直接读常量** ——
  //     否则面板改了、行为没变（那正是"空承诺"）。
  // ═══════════════════════════════════════════════════════════════════════════

  // ── 组 1：压缩 —— 怎么压（原来 4 项，现在 7 项）─────────────────────────
  {
    key: "mode",
    kind: "choice",
    group: "how",
    scopeNote: "project-first",
    label: "压缩方式",
    options: () => [
      {
        value: MODE_SURGICAL,
        label: "分流后压缩（唯一方式）",
        hint:
          "压缩前先把这一段分成三个桶：留在上下文、落进项目按需查、丢掉。" +
          "留在上下文的那一份会在压缩后逐字注回 —— 这是「指针」能给全的前提。",
      },
    ],
    hint:
      "两种方式已合并：分流现在是每次压缩的标准步骤（它决定哪些能压、哪些怎么压）。" +
      "这一项保留只为兼容旧项目清单，选什么都没区别。",
  },
  {
    key: "highFidelityCompact",
    kind: "boolean",
    group: "how",
    label: "高保真压缩",
    hint:
      "水位到点时，由本插件先在压缩前抓一份逐字胶囊，压完再把台账与胶囊注回上下文。" +
      "关掉就完全交给内核处理，压掉的内容不再有逐字副本。",
  },
  {
    key: "requireFlushBeforeCompact",
    kind: "boolean",
    group: "how",
    emphasis: true,
    label: "压缩前必须先记台账",
    hint:
      "压缩会丢掉逐字历史，所以压之前先确认这一轮的进展已经写进台账、并且有一条日志。" +
      "没写就先不压，等写完再压。这是本插件的核心安全规则。",
  },
  {
    key: "triageKeepMax",
    kind: "number",
    group: "how",
    unit: "条",
    label: "分流单最多留几条",
    hint:
      "压缩前你自己挑的那份「下一轮必须知道」的清单，上限就是这个数。" +
      "超出按你给的顺序截断，并如实报出截掉几条。留得太多等于没压。",
    min: 3,
    max: 50,
    step: 1,
  },
  {
    key: "triageOwedMaxAgeMs",
    kind: "number",
    group: "how",
    unit: "分钟",
    label: "分流义务的有效期",
    hint:
      "我们要求过一次分流、而它一直没做，超过这么久就不再拦压缩（避免把你卡死）。" +
      "单位是分钟。调大＝更坚持要先分流；调小＝更容易放行。",
    min: 1,
    max: 240,
    step: 1,
    scale: 60000,
  },
  {
    key: "capsuleMaxChars",
    kind: "number",
    group: "how",
    unit: "字符",
    label: "逐字胶囊长度上限",
    hint:
      "压缩后注回的那份逐字素材最多带多少字符，超出会截断并注明原文长度。" +
      "调大＝保住更多原话（占上下文也更多）。",
    min: 2000,
    max: 60000,
    step: 1000,
  },
  {
    key: "recallMaxChars",
    kind: "number",
    group: "how",
    unit: "字符",
    label: "读回原文的单次上限",
    hint:
      "用 ledger_recall 把被压掉的逐字原文读回来时，一次最多返回多少字符。" +
      "超出会停在事件边界并提示分段读。",
    min: 2000,
    max: 200000,
    step: 1000,
  },

  // ── 组 2：压缩 —— 什么时候压（原来 4 项，现在 6 项）─────────────────────
  {
    key: "incrementalCompact",
    kind: "boolean",
    group: "when",
    label: "增量（分段）压缩",
    hint:
      "★ 默认关：主力改成「回合末一次全量、压到约 10%」。增量只压最旧一段（保留 60~80%），" +
      "实测它的折点在靠前处 ⇒ 身后约 60 万 token 要按全价重算（单次 36.5 万 vs 全量 2.2 万），" +
      "而且落点逐轮抬高。★ 打开后它会在回合内自动压 —— 只有你真的想要「边干边小压」时才开。" +
      "★ 不管这个开关如何，手动 /ledger light 与模型主动调 mode=light 都仍然可用。",
  },
  {
    key: "autoCompact",
    kind: "boolean",
    group: "when",
    label: "允许插件自动压缩",
    hint:
      "关掉后插件不再自己动手压缩（下面那些水位、涨幅设置都不再触发）。" +
      "手动的 /ledger compact 仍然可用。",
  },
  {
    key: "deltaTriggerPoints",
    kind: "number",
    group: "when",
    unit: "点",
    label: "轻推：涨多少点提醒一次",
    hint:
      "水位比上次压缩时涨了这么多，插件就提醒你一句「可以顺手压一下」。" +
      "这只是提醒，不会替你压。",
    min: 5,
    max: 50,
    step: 1,
  },
  {
    key: "deltaRemovePoints",
    kind: "number",
    group: "when",
    unit: "点",
    label: "单次最多压掉多少点",
    hint:
      "每次压缩压掉「上次压缩至今增量」的一半，这一项是它的上限。" +
      "调小＝每次压得更保守（水位回落慢）；调大＝允许一次压得更狠。" +
      "正常节奏（每涨 4~5 点折一次）下它不会生效 —— 只有攒了很久才压时才会碰到。",
    min: 5,
    max: 80,
    step: 1,
  },
  {
    key: "minCompressPoints",
    kind: "number",
    group: "when",
    unit: "点",
    label: "压之前的最小体量门槛",
    hint:
      "要压的那段至少得够压掉这么多点，否则这次压缩不值得做 —— " +
      "因为压完必须重注台账与胶囊，代价可能比省下的还大。调大＝攒得更久才压（更省但水位回落慢）。" +
      "★ 手动 /ledger light 不受这条约束。",
    min: 0,
    max: 10,
    step: 0.5,
  },
  {
    key: "triageKeepTotalMax",
    kind: "number",
    group: "when",
    unit: "条",
    label: "分流单累积上限",
    hint:
      "★ 跨多次分流累积的总条数上限（单次上限见上一项）。" +
      "压缩前会把这段时间里所有分流的 keep 桶一起逐字注回，超了按最旧的先丢并如实报数。" +
      "调大＝保住的判断更多（但重注更占上下文）；调小＝更省，但更早的判断会丢。",
    min: 5,
    max: 200,
    step: 1,
  },
  {
    key: "highFidelityCompactRatio",
    kind: "number",
    group: "when",
    label: "全量压缩触发水位",
    hint:
      "★ 主力压缩线：水位一过这条就在回合末做一次全量压缩（一次折到约 10%）。" +
      "始终早于内核自己的 0.8。调小＝压得更早、水位长期更低、单次代价更便宜" +
      "（实测：把水位压在 30% 左右时总成本约为压在 70% 时的一半）。",
    // ★★★ 2026-10-13（D155）：下限由 0.5 放宽到 **0.15** —— 用户要长期维持 30%，
    //   而 0.30 是默认值；留出更低的空间供他调（例如想更激进地压到 20%）。
    //   ★ 上限仍是 **0.79**：到 0.8 就与内核同刻，失去"提前"的意义。
    min: 0.15,
    max: 0.79,
    step: 0.01,
  },
  {
    key: "nudgeMinRatio",
    kind: "number",
    group: "when",
    label: "轻推的最低水位",
    hint:
      "水位低于这个比例时，插件一句话都不说（不打扰）。" +
      "★ 它只是「可以建议了」的下限，不是「该压了」的线 —— 该不该压由你做决定。",
    min: 0.1,
    max: 0.9,
    step: 0.01,
  },

  // ── 组 3：注入 —— 模型看到什么（新增组）────────────────────────────────
  {
    key: "blockInjection",
    kind: "boolean",
    group: "inject",
    scopeNote: "project-first",
    emphasis: true,
    label: "区块级注入（必注正文 + 目录）",
    hint:
      "台账按标题切成「记忆区块」，只把该读的块连正文注入，其余块只给" +
      "标题 + 行数 + 内容哈希（= 它们的相对位置，可随时按需读全文）。" +
      "三条安全绳：① 压缩后必定重注全部必注块；② 内容变了的块必定连正文注入；" +
      "③ 任何读取或解析失败一律退回整份注入。关掉即完全退回旧行为。",
  },
  {
    key: "weightMustInject",
    kind: "number",
    group: "inject",
    unit: "分",
    label: "必注分阈值",
    hint:
      "区块权重算到多少分以上就「连正文注入」，其余只进目录。0 到 100 之间的绝对分数，不是百分比。" +
      "调低＝注更多正文（更安全、更占上下文）；调高＝更省但可能少给。",
    min: 0,
    max: 100,
    step: 1,
  },
  {
    key: "weightPrincipleScore",
    kind: "number",
    group: "inject",
    unit: "分",
    label: "原则与底线的保底分",
    hint:
      "标题是原则、底线、铁律、硬规矩、总纲的区块，分数不低于这个值 —— " +
      "它们结构性上不会过期，所以无论如何都该看得见。",
    min: 50,
    max: 100,
    step: 1,
  },
  {
    key: "weightDoneCap",
    kind: "number",
    group: "inject",
    unit: "分",
    label: "已完成条目的封顶分",
    hint:
      "标题声明已完成、已处理、已过期的区块，分数不超过这个值（是封顶，不是扣分）—— " +
      "它们的正文在决策记录里，随时能读，不该常驻上下文。",
    min: 0,
    max: 80,
    step: 1,
  },
  {
    key: "shadowedIndexMax",
    kind: "number",
    group: "inject",
    unit: "段",
    label: "被压段索引最多列几段",
    hint:
      "压缩后推行给模型的「原文去哪拿」清单最多列几段。它很小、而且每步都在，所以别设太大。",
    min: 1,
    max: 200,
    step: 1,
  },
  {
    key: "maxReadChars",
    kind: "number",
    group: "inject",
    unit: "字符",
    label: "单次注入台账的字符上限",
    hint:
      "台账超过这个长度就截断注入，并注明全文多少字符。调大＝一次给全（占上下文更多）；" +
      "调小＝更容易触发截断。",
    min: 5000,
    max: 500000,
    step: 5000,
  },

  // ── 组 4：台账与日志（原来 4 项，现在 8 项）─────────────────────────────
  {
    key: "maxActiveLines",
    kind: "number",
    group: "ledger",
    scopeNote: "project-first",
    unit: "行",
    label: "活跃台账行数上限",
    hint: "超过就要求先归档最旧的条目再写。这是新项目登记的默认值。",
    min: 50,
    max: 2000,
    step: 10,
  },
  {
    key: "changeRegisterMax",
    kind: "number",
    group: "ledger",
    scopeNote: "project-first",
    unit: "条",
    label: "变更登记保留条数",
    hint: "台账末尾那张「变更登记」表保留最近几行，超出即截断。它算在上面那个行数上限里。",
    min: 3,
    max: 100,
    step: 1,
  },
  {
    key: "maxArchiveList",
    kind: "number",
    group: "ledger",
    unit: "条",
    label: "归档列表最多列几份",
    hint: "列归档目录时最多列几条，避免归档很多之后把列表撑爆。",
    min: 10,
    max: 2000,
    step: 10,
  },
  {
    key: "turnEndOffer",
    kind: "boolean",
    group: "ledger",
    label: "回合末弹四选一卡片",
    hint: "开启后每回合结束会问一次「记台账 / 压缩 / 写交接单」。默认关闭。",
  },
  {
    key: "logLevels",
    kind: "levels",
    group: "ledger",
    scopeNote: "project-first",
    label: "活动日志各档",
    hint: "按周分桶写入，永不注入上下文，只在回溯时读取。",
  },
  {
    key: "logDefaultLimit",
    kind: "number",
    group: "ledger",
    unit: "条",
    label: "查日志默认返回几条",
    hint: "用 ledger_log 回溯时，不指定条数就返回这么多。调大＝一次看得更多。",
    min: 10,
    max: 2000,
    step: 10,
  },
  {
    key: "logBriefChars",
    kind: "number",
    group: "ledger",
    unit: "字符",
    label: "日志摘要每行截断长度",
    hint: "文件流水那类日志，每行只留开头这么多字符。调大＝更详细。",
    min: 20,
    max: 500,
    step: 10,
  },
  {
    key: "userMsgMaxChars",
    kind: "number",
    group: "ledger",
    unit: "字符",
    label: "L4 单条用户原话上限",
    hint: "活动日志里保存用户原话时，单条最多留多少字符，超出截断。",
    min: 1000,
    max: 200000,
    step: 1000,
  },

  // ── 组 5：胶囊细节（新增组，高级）──────────────────────────────────────
  {
    key: "capsuleUserMsgMax",
    kind: "number",
    group: "capsule",
    unit: "条",
    label: "胶囊：收几条用户原话",
    hint: "压缩前抓的逐字胶囊里，最多收录最近多少条用户原话。",
    min: 1,
    max: 200,
    step: 1,
  },
  {
    key: "capsuleUserMsgChars",
    kind: "number",
    group: "capsule",
    unit: "字符",
    label: "胶囊：单条原话截断长度",
    hint: "胶囊里每条用户原话最多留多少字符。",
    min: 100,
    max: 10000,
    step: 100,
  },
  {
    key: "capsuleErrorMax",
    kind: "number",
    group: "capsule",
    unit: "条",
    label: "胶囊：收几条报错",
    hint: "压缩前抓的逐字胶囊里，最多收录多少条报错原文。报错字符串差一个字符就查不出来，所以留着有用。",
    min: 1,
    max: 200,
    step: 1,
  },
  {
    key: "capsuleErrorChars",
    kind: "number",
    group: "capsule",
    unit: "字符",
    label: "胶囊：单条报错截断长度",
    hint: "胶囊里每条报错最多留多少字符。",
    min: 50,
    max: 5000,
    step: 50,
  },
  {
    key: "capsuleArtifactMax",
    kind: "number",
    group: "capsule",
    unit: "个",
    label: "胶囊：收几个器物",
    hint: "压缩前抓的逐字胶囊里，最多收录多少个「碰过的文件」。",
    min: 1,
    max: 500,
    step: 1,
  },
  {
    key: "capsuleStoreSessions",
    kind: "number",
    group: "capsule",
    unit: "场",
    label: "胶囊落盘保留几场会话",
    hint: "磁盘上的胶囊素材（capsules.json）最多保留最近几场会话的记录，超出丢最旧的。",
    min: 1,
    max: 500,
    step: 1,
  },
  {
    key: "blockHistoryMax",
    kind: "number",
    group: "capsule",
    unit: "块",
    label: "区块变更史最多留几块",
    hint: "用于计算区块权重的那份变更史最多保留多少块，超出丢最旧的。",
    min: 10,
    max: 20000,
    step: 10,
  },
  {
    key: "pressureTiers",
    kind: "tiers",
    group: "when",
    label: "水位提醒档位",
    hint:
      "默认 0.3 / 0.5 / 0.7，跨过每一档注入一次提醒（每档只发一次）。" +
      "这只是提醒：它不要求你先落盘，也不拦任何东西。",
  },
];

/**
 * 设置分组（面板按这个顺序与标题渲染）。
 *
 * ★ D138 重排：原来的 4 组 → **5 组**，且把"注入"独立成组
 *   （它以前挤在「台账与日志」里，而那是**模型看到什么**的事，与台账尺寸无关）。
 */
const SETTING_GROUPS = [
  { key: "how", label: "压缩：怎么压", hint: "压缩前后的分工与关键尺寸。" },
  { key: "when", label: "压缩：什么时候压", hint: "按什么节奏触发，以及何时开口提醒。" },
  { key: "inject", label: "注入：模型看到什么", hint: "台账以什么形态进入上下文。" },
  { key: "ledger", label: "台账与日志", hint: "台账本身的尺寸与记录规则。" },
  { key: "capsule", label: "胶囊细节（高级）", hint: "压缩前抓的那份逐字素材，收多少、留多久。" },
];

/** 设置键集合（校验用：拒绝不认识的键，免得打错字静默失效）。 */
const SETTING_KEYS = new Set(SETTING_SPECS.map((s) => s.key));

/**
 * ★★★★ 2026-10-12（D138）：**从 spec 取数值边界** —— `min`/`max`/`step`/`unit` 的**唯一真源**。
 *
 * ★ 为什么必须这样（这是本轮最重要的结构性修复）：
 *   改造前 `normalizeSettings` 里**手抄了一份**边界——
 *   `const lo = k === "changeRegisterMax" ? 3 : 50;`
 *   ⇒ ★ 于是同一件事有**两个出口**：面板显示 `spec.min/max`、校验用**手抄的那份**。
 *     改一处忘另一处 ⇒ 面板上说"能填 3~100"、实际存进去被夹到别的区间，
 *     而且**没有任何断言会红**（本机纪律：**一个事实只能有一个判定出口**，D25）。
 *   ⇒ 现在边界**只写在 spec 里**，校验函数来这里读 ⇒ 分叉在结构上不可能发生。
 *
 * ★ 取不到（key 不在 spec 里）⇒ 返回 `undefined` ⇒ 调用方**丢弃该项**（不是静默放行）。
 */
function specOf(key) {
  return SETTING_SPECS.find((s) => s.key === key);
}

/**
 * ★★★★ 2026-10-12（D138）：**可调数值项** ⇒ 统一的区间夹取。
 *
 * ★★ 语义（**只有这一处**，别处不许再乘除）：
 *   · `min`/`max`/`step` **一律是面板单位**（用户填的那个单位，如"分钟""点""字符"）；
 *   · `scale` 把面板单位换算成**内部基本单位**（如分钟 → 毫秒）；
 *   · ⇒ 先**按面板单位**夹取，再 `× scale` 存内部值。
 *     反过来的写法（先乘再夹）会让 `max: 240`（分钟）被当成 240 毫秒 ⇒ 静默截成一个荒谬的值
 *     —— 我第一版就是这么写的，自检 `面板填 30 ⇒ 内部 1800000` 当场抓到（实际存成了 240）。
 */
function clampNumber(key, v) {
  const spec = specOf(key);
  if (spec === undefined || !Number.isFinite(v)) return { ok: false };
  const scale = Number.isFinite(spec.scale) && spec.scale > 0 ? spec.scale : 1;
  const lo = Number.isFinite(spec.min) ? spec.min : -Infinity;
  const hi = Number.isFinite(spec.max) ? spec.max : Infinity;
  // ★ 整数化判据：步长是整数（含未声明）⇒ 取整；步长带小数（如 0.01）⇒ 保留小数
  const stepIsInt = !Number.isFinite(spec.step) || Number.isInteger(spec.step);
  const n0 = stepIsInt ? Math.round(Number(v)) : Number(v);
  const n = Math.min(hi, Math.max(lo, n0)); // ← 面板单位下夹取
  const dec = !stepIsInt && Number.isFinite(spec.step) ? `${spec.step}`.split(".")[1]?.length ?? 0 : 0;
  const rounded = dec > 0 ? Number(n.toFixed(dec)) : n;
  return {
    ok: true,
    value: rounded * scale, // ← 再换算成内部基本单位
    clamped: rounded !== n0 ? `${key}（${v} → ${rounded}）` : undefined,
  };
}

/**
 * 校验并归一化一份设置（**纯函数**，不碰 ctx，便于推理与自检）。
 *
 * @param {object} raw 用户给的原始设置
 * @returns {{ok: true, value: object, dropped: string[], clamped: string[]}}
 *          或 `{ok: false, reason: string}`
 *
 * ★ 为什么**不抛**而是返回结果：这个函数在**配置校验**（内核启动路径）里被调用，
 *   那里抛错会让插件起不来；也在这里被 HTTP 路由调用，那里抛错应该是 400 而不是 500。
 *   两个调用点都只想要"哪里不对"，不想要异常。
 */
function normalizeSettings(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, value: settingDefaults(), dropped: [], clamped: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "设置必须是一个对象。" };
  }
  const value = settingDefaults();
  const dropped = [];
  const clamped = [];

  for (const [k, v] of Object.entries(raw)) {
    if (!SETTING_KEYS.has(k)) {
      // ★ 不认识的键**丢弃并如实报告**，不静默接受：打错一个字就静默失效，
      //   是配置类功能最常见也最难查的失败模式。
      dropped.push(k);
      continue;
    }
    if (v === undefined) continue; // 显式 undefined = 没设，保持默认

    if (k === "logLevels") {
      value.logLevels = parseLevels(v, settingDefaults().logLevels);
      continue;
    }
    if (k === "mode") {
      // ★ 只接受登记过的模式名。打错一个字就**丢弃并如实报告**，
      //   而不是静默退到默认 —— 否则用户以为切到了"反复追究"，实际还在"正常推进"。
      if (typeof v !== "string" || !MODES.includes(v)) {
        dropped.push(k);
        continue;
      }
      value.mode = v;
      continue;
    }
    if (k === "pressureTiers") {
      if (!Array.isArray(v)) {
        dropped.push(k);
        continue;
      }
      const tiers = [
        ...new Set(
          v.filter((t) => Number.isFinite(t) && t > 0 && t < 1).map((t) => Number(t.toFixed(4)))
        ),
      ].sort((a, b) => a - b);
      if (tiers.length === 0) {
        dropped.push(k); // 空数组会被当成"一项都不提醒"，多半是误操作 ⇒ 保持默认
        continue;
      }
      value.pressureTiers = tiers;
      continue;
    }
    // ★★★★★ 2026-10-12（D138）：**所有数值项走同一条路** —— 边界**从 spec 读**。
    //
    //   ★ 改造前这里是四段各自手抄边界的 if（`highFidelityCompactRatio` 一份、
    //     `maxActiveLines/changeRegisterMax` 一份、`delta*` 一份）。
    //     ⇒ 面板显示 `spec.min/max`、校验用**手抄的那份** —— 两个出口，
    //       改一处忘另一处就是静默分叉，而且**没有断言会红**。
    //   ⇒ 现在：`clampNumber` 去 `specOf(key)` 取边界 ⇒ 结构上不可能分叉。
    //   ★ 特殊约束（不是简单夹取）仍单独处理，但**放在通用分支之前**：
    //     · `highFidelityCompactRatio` 上限压在 0.79（到 0.8 就与内核同刻，失去"提前"的意义）
    //       —— 这一条**已经写进 spec 的 `max: 0.79`** ⇒ 通用分支天然满足，无需特判。
    if (specOf(k)?.kind === "number") {
      const r = clampNumber(k, v, value);
      if (r.ok !== true) {
        dropped.push(k);
        continue;
      }
      if (r.clamped !== undefined) clamped.push(r.clamped);
      value[k] = r.value;
      continue;
    }
    // 剩下的是 boolean
    if (typeof v !== "boolean") {
      dropped.push(k);
      continue;
    }
    value[k] = v;
  }

  return { ok: true, value, dropped, clamped };
}

/**
 * 手写的 StandardSchemaV1 校验器（**零 import**，见文件头 ①）。
 *
 * 内核只调这两样：`"~standard".validate(config)` 与读 `vendor`/`version`。
 * 返回 `{value}`（成功，**已归一化**）或 `{issues}`（失败，每项带 `message`）。
 *
 * ★ 为什么把归一化放进校验器：这样**内核存下来的就是干净的设置** ——
 *   面板、行为判断、落盘三处看到的是同一份，不会出现"存的是 0.9、行为按 0.79 算"。
 */
const Config = {
  "~standard": {
    version: 1,
    vendor: "dsh-ledger-memory",
    validate(input) {
      const r = normalizeSettings(input);
      if (r.ok !== true) {
        return { issues: [{ message: r.reason }] };
      }
      return { value: r.value };
    },
  },
};
export { Config };

/**
 * ★ 自检专用钩子（`tools/selftest.mjs` 情形 45 用）。
 *
 * ★ 为什么需要它：`renderShadowedIndex` / `readSessionRange` 是**纯函数**
 *   （只读、无副作用），但它们拿不到 `state` —— 而自检要验的是"索引渲染出来长什么样"。
 *   直接读 `renderInjection` 的整段文本也可以，但那会把台账正文一起混进来，
 *   断言就只能用 `includes` 去猜，**判别力差**。
 *
 * ★ 安全边界（必须守住）：这里**只暴露两个纯函数**，
 *   **不**暴露 `state`、**不**暴露任何会写盘的入口 —— 它就是给自检用的观察窗。
 */
const __test = {
  renderShadowedIndex, readSessionRange, recordShadowedIndex, renderCapsule,
  // ★ 2026-10-11（D87）：自检要断言"**全量压缩后锚点被更新**"——
  //   `anchorOf` 是唯一取锚点出口（内存优先），`setAnchor` 是唯一写出口。
  //   ⚠️ 只暴露这两个**纯读写锚点**的函数，不暴露 state / 不暴露写盘入口。
  anchorOf, setAnchor,
  // ★ 2026-10-12（D61）：自检要断言"**重启后内存为空时也把盘上那份建出来**"。
  //   ★ 为什么必须直接暴露它：那条路只在 `captureCapsuleBeforeCompact` 里被调，
  //     而**走 `/ledger compact` 命令的夹具根本不经过它** ⇒ 断了个空断言
  //     （实测：摘掉修复后仍然全绿 —— **反向验证当场把这个弱点抓了出来**）。
  //   ⚠️ 只暴露这一个函数：它**只读盘 + 写内存**，不写盘、不改 state。
  hydrateCapsuleMemory,
  // ★★★ 2026-10-12（D114）：自检要断言"**AI 主动压必须过落盘闸门，而人按的豁免**"。
  //   ★ 为什么必须开这个口子：那两条路的区别**只体现在 `deltaForce` 的 `source` 上**，
  //     而 `deltaForce` 是插件内部 state —— 自检**够不着**（本文件反复确认过：
  //     `run.ctx.state` 会被严格模式代理挡掉）。★ 而"人按的"那条路**没有别的触发方式**
  //     （`/ledger light` 命令的 handler 会 steer 唤醒，夹具里跑不完整）。
  //   ⚠️ 只做一件事：往 `deltaForce` 里塞一张旗子（**与真实调用点写的是同一个形状**）。
  //     它**不**改行为、**不**绕过任何判据 —— 判据怎么判仍由被测代码决定。
  //   ★ 这条 hook 的存在本身也是个提醒：**"谁发起的"是一等语义**，不是实现细节。
  setDeltaForce: (key, source) => {
    if (latestStateForTest === undefined) return false;
    latestStateForTest.deltaForce.set(String(key), { at: Date.now(), source: String(source) });
    return true;
  },
  // ★★★ 2026-10-12（D132）：自检要**两个方向**都断言"内容感知指纹"：
  //   ① 内容没变（只推 mtime）⇒ 必须相等；② 内容真改了 ⇒ 必须不等（守"不影响准确性"）。
  //   ★ 为什么必须开这个口子：它是**纯函数**（读一个绝对路径 + 算哈希），
  //     走整个注入链路去测它既慢又会掺进别的变量（指纹去重/压缩编排都会干扰）。
  //   ⚠️ 它只读盘、不写、不改任何 state —— 判据怎么写仍由被测代码决定。
  fingerprintOf,
  // ★★★ 2026-10-12（D133）：自检要断言"记忆区块"的第一层（分块 / 块哈希 / 差异）。
  //   ★ 它们都是**纯函数** ⇒ 直接调最干净（走注入链路会掺进压缩编排等无关变量）。
  //   ⚠️ 三个都**只算不写**、不碰 state。
  splitBlocks,
  diffBlocks,
  fnv1a,
  // ★★★ 2026-10-12（D135）：区块权重——"通用标准"那部分也要能被断言
  //   ★ 尤其要能验：**"模型只答是/否、插件算分"**是否真的把尺度握在插件手里。
  mechanicalWeight,
  weightFromAnswers,
  renderToc,
  // ★★★ 2026-10-12（D136）：**权重可变 + 合并** —— 用户新加的三条约束要靠它们断言：
  //   ① 原则/底线 ⇒ 毫无疑问高分；② 已处理/已过期 ⇒ 低分；③ **时间是打分标准之一**。
  // ★★★ 2026-10-12（D136）：**相对维度秩融合**（用户：*"区块的定位主要是相对位置"*）。
  //   ★ 用户新加的三条约束靠它们断言：① 原则/底线 ⇒ 毫无疑问高分；② 已处理/已过期 ⇒ 低分；
  //     ③ **时间是打分标准之一**（且是**相对顺序**，不是绝对时长）。
  fuseWeight,
  ranksOf,
  starValueOf,
  weightBlocks,
  // ★★★ 2026-10-12（D136）：**块变更史**（"权重可变"的磁盘支点）+ 两个纯函数打分器。
  //   ★ 为什么必须开这几个口子：它们都是**纯函数/纯读写**，走整条注入链路去测
  //     既慢又会掺进压缩编排等无关变量（本项目一贯做法）。
  //   ⚠️ `recordBlockHistory` 会**写** `$DSH_HOME\plugin-data\`（与 anchors.json 同处），
  //      但**不碰用户工作区**、不改插件 state —— 与既有口径一致。
  recordBlockHistory,
  blockHistoryFor,
  // ★★★★ 2026-10-12（D136 接线）：自检要断言"模型判分**真的存进去了**"。
  //   ★ 为什么必须开这个口子（**反向验证当场逼出来的**，记下来）：
  //     `weightsScored` 只是"循环里数了几条合法行"，它**看不见 bucket 有没有被存**。
  //     实测：把 `state.blockWeights.set(...)` 整行摘掉 ⇒ **自检一条都不红**（空断言）。
  //   ⚠️ 与 `setDeltaForce` 同一条纪律：**只读、不改行为、不写盘** ——
  //     把当前会话收下的判分**复制**出来；判据怎么判仍由被测代码决定。
  blockWeightsForTest: (sid) => {
    if (latestStateForTest === undefined) return undefined;
    const rec = latestStateForTest.blockWeights?.get(String(sid));
    if (rec === undefined) return undefined;
    return {
      at: rec.at,
      root: rec.root,
      byHash: [...(rec.byHash ?? new Map()).entries()].map(([h, v]) => [h, { ...v }]),
    };
  },
  // ★★★ 2026-10-13（D159）：自检要断言**「内存比盘上少时，盘上那份不许变少」**。
  //   ★ 为什么必须开这个口子：`persistCapsuleMemory` 是**写盘函数**，而自检要的是
  //     "写完再读回来比一比" —— 走真实压缩链路去造"重启后内存只有 2 条"这个状态
  //     需要伪造内核重启，夹具做不到（D61 那次就是这么断成空断言的）。
  //   ⚠️ 它**只读一个模块级计数器**，不写盘、不改任何 state。
  //   ★★ 与 `mustInjectThreshold` 同一个坑：这里**必须是取值函数** ——
  //     `capsuleSkipStats` 定义在文件更后面，直接写对象字面量会
  //     `ReferenceError: Cannot access 'capsuleSkipStats' before initialization`
  //     ⇒ **整个 import 失败、自检起不来**（本文件已栽过两次，见 L987 的注释）。
  capsuleStoreStats: () => ({ ...capsuleSkipStats }),
  /** 直接读回某个 sid 在盘上的素材（只读；供"写完比一比"用）。 */
  capsuleStoreOf: (sid) => {
    try {
      const rec = readCapsuleStore().bySession[String(sid)];
      if (rec === undefined) return undefined;
      return {
        userMessages: (rec.userMessages ?? []).map((x) => ({ ...x })),
        errors: (rec.errors ?? []).map((x) => ({ ...x })),
        artifacts: { ...(rec.artifacts ?? {}) },
      };
    } catch {
      return undefined;
    }
  },
  /** ★★★ D159 的**修复本体**（纯函数）—— 自检要能单独摘掉它看红。 */
  mergeCapsuleMatter,
  // ★★★★ 2026-10-13（D162）：自检**必须拿到真形状**的容器。
  //   ★ 为什么非开这个口子：情形 42d 原来传的是**裸 `new Map()`**，而 `Map` **自带 `set`**
  //     ⇒ 它测的是一个"有 `set` 的容器"，**不是生产那个没有 `set` 的对象** ⇒ 假绿（D162）。
  //   ★ 判据要与被测对象自己产生的那部分一致（纪律 2）⇒ 夹具必须用**生产同一个构造函数**。
  //   ★ 同 `capsuleStoreStats` 那个坑：这里**必须是取值函数**（`createCapsuleMemory` 定义在更后面）。
  createCapsuleMemoryForTest: () => createCapsuleMemory(),
  /** 写一次胶囊素材（供自检造"内存少、盘上多"的真实状态）。 */
  persistCapsuleMemoryForTest: persistCapsuleMemory,
  /** ★★★ D160 的**唯一取索引出口**（内存优先、盘上兜底）。 */
  shadowedIndexOf,
  /** ★★★★★ D163：来源标签的**唯一出口**（索引行与 L0 里程碑共用它）。 */
  hfSourceShort,
  /** ★★★★★ D165：胶囊目录的**唯一出口**（落盘 / 兜底指针 / 注入指针共用它）。 */
  capsuleDirRel,
  /** ★★★★★ D165：兜底指针 —— 自检要断言它与唯一出口**逐字节一致**（不许各算一套）。 */
  capsulePathFor,
  /** ★★★★★ D167：`compaction/end` 成没成的**唯一出口** —— 自检要断言"失败不算压缩过"。 */
  compactionEndSucceeded,
  /**
   * ★★★★★ 2026-10-13（D167）：**「压缩后该不该重注」的判据**，供自检**行为**断言。
   *
   * ★ 为什么必须开这个口子（**两层断言纪律**，D136）：情形 65 原来对 `compactVsInject`
   *   **只做静态断言**（拿源码文本正则匹配"有没有读 `session?.log`"）——
   *   那证明的是"**接线**"，证明不了"**判据给出的答案对不对**"。
   *   ⇒ 本次 D167 的缺陷（失败压缩被当成成功）**恰好能穿过**那些静态断言：
   *     函数体里照样有 `session?.log`、照样按 seq 比较 ⇒ **65①/65② 全绿**，
   *     而它在真机上给出了**错的答案**（谎报"该重注"）。
   *   ⇒ 补行为断言：直接喂**真机那次失败事件的形状**，看它答什么。
   * ⚠️ 它只读 `agent.session.log`、不写任何 state（纯判据）。
   */
  compactVsInject,
  /** ★★★★★ D166：内核那句误导标签的**翻译出口** —— 自检要断言真因被摊开。 */
  compactionFailureAdvice,
  /** ★★★ D163：水位线的**唯一出口**（自检要断言索引里的百分比取自设置）。 */
  autoFullPct,
  /** 读回落盘的被压段索引（只读；用来断言"重启后仍拿得到"）。 */
  shadowedStoreForTest: (sid) => {
    try {
      const list = readShadowedStore().bySession[String(sid)];
      return Array.isArray(list) ? list.map((x) => ({ ...x })) : undefined;
    } catch {
      return undefined;
    }
  },
  doneCap: () => WEIGHT_DONE_CAP,
  principleScore: () => WEIGHT_PRINCIPLE_SCORE,
  rrfK: () => RRF_K,
  // ★★★ 这里**必须是取值函数**，不能直接写 `WEIGHT_MUST_INJECT`：
  //   `__test` 是本文件的**顶层 const**，模块初始化时当场求值；
  //   而那个常量定义在**更后面** ⇒ 直接引用会
  //   `ReferenceError: Cannot access 'WEIGHT_MUST_INJECT' before initialization`
  //   （实测当场撞到，整个 import 失败 ⇒ 自检起不来）。
  //   ★ 这与 `SETTING_SPECS` 里 `MODE_STEADY` 那个坑**完全同型**（本文件已记过一次）。
  mustInjectThreshold: () => numOf("weightMustInject", WEIGHT_MUST_INJECT),
  // ★★★ 2026-10-12（D136 步 3）：自检要断言**默认值**（尤其 `blockInjection` 默认必须关）。
  //   ★ 为什么必须直接读它：默认关是"未经实测对照就不改模型看到的东西"这条纪律的
  //     最外圈守卫；若没有断言，某次重构把默认翻成 true 就是**静默改注入行为**。
  settingDefaultsForTest: () => ({ ...settingDefaults() }),
  // ★★★★ 2026-10-12（D138）：设置面板的自检口 —— **面板不许说谎**要靠它们证。
  //   ★ `settingSpecsForTest` 出站前**展开 options**（与 `deriveSettingsView` 同口径），
  //     否则自检看到的是函数而不是数组，与真实面板不是同一份数据。
  settingSpecsForTest: () => SETTING_SPECS.map((s) => ({
    ...s,
    ...(typeof s.options === "function" ? { options: s.options() } : {}),
  })),
  settingGroupsForTest: () => SETTING_GROUPS.map((g) => ({ ...g })),
  normalizeSettingsForTest: (raw) => normalizeSettings(raw),
  numOfForTest: (key, fb) => numOf(key, fb),
  // ★★★★★ 2026-10-12（D141）：空转闸门的**估算器**要能被直接断言。
  //   ★ 为什么必须开这个口子（**自检当场逼出来的**）：61① 第一版"看起来通过了"，
  //     实际是被**分流闸门**拦的 —— 而我要验的是"**体量闸门**"。
  //     两个闸门都让 `regionCalls` 为 0 ⇒ **光看压缩次数分不出是谁拦的**
  //     （本项目纪律：**判据必须能吃"被测对象自己的那部分"**）。
  //   ⇒ 直接断言估算值本身，才能把"体量不够"与"别的闸门"分开。
  estimateCompressibleForTest: (ctx, agent, pressure, since, settings) =>
    estimateCompressibleTokens(ctx, agent, pressure, since, settings ?? currentSettings()),
  minCompressPointsForTest: () => numOf("minCompressPoints", MIN_COMPRESS_POINTS),
  // ★★★★★ 2026-10-12（D141）：**闸门的那一步判断**直接可断言。
  //   ★ 为什么必须开（**反向验证当场逼出来的**）：情形 61 第一版只断言"估算器在区分体量"，
  //     于是四种坏法（删闸门 / 量不到判成太小 / 手动豁免失效 / 设置没接上）**全不见红**
  //     ⇒ 那些断言根本没在管闸门。
  compGateForTest: (compressible, minPoints, window, forced) =>
    compGateDecision(compressible, minPoints, window, forced),
};
export { __test };

/**
 * 把 `cfg` 里的设置读出来（**归一化后**）。
 *
 * ★ 为什么不直接读 `cfg.X`：`normalizeSettings` 还负责丢未知键、夹紧越界值。
 *   行为判断一律经这里，就不会出现"内核存了 0.9，代码按 0.9 跑"这种越界。
 * ★ 内核已经用 `Config` 校验过一遍（所以正常路径下这里不会改什么），
 *   但**测试与直接调用**可能绕过内核，所以这里再兜一次 —— 便宜且必要。
 */
function settingsOf(cfg) {
  const r = normalizeSettings(cfg);
  return r.ok === true ? r.value : settingDefaults();
}

/**
 * ★ 当前生效的设置（**进程级单例**）。
 *
 * ★★ 为什么这里用模块级可变状态，而别处一律避免：
 *   `maxActiveLines` 与 `logLevels` 是**按项目**的东西（真源在 `.dsh-ledger.json`），
 *   插件级设置只是"**新项目的默认值**"。而它们被用在一批**纯函数**里
 *   （`inspect()` / `levelOn()` —— 它们没有 `ctx`，只有 `projectRoot`），
 *   调用点多达二十余处。把设置一路穿透传下去，会让"读一个行数上限"这件事
 *   牵扯十几个签名 —— 收益不抵风险。
 *   ⇒ 而"进程级"在这里是**真话**而不是将就：一个 profile 只装一份本插件，
 *     `Config` 也只有一份。所以"当前设置"确实是进程级事实。
 *
 * ★ 仍然**显式**：只有 `apply()` 会写它（`setActiveSettings`），
 *   读一律经 `currentSettings()`，而它**永远**能给出完整的一份（不会 undefined）。
 *   ⇒ 在 `apply()` 之前调用任何纯函数，拿到的是`settingDefaults()`，与旧行为一致。
 *
 * ★ 自检的隔离性靠这条保证：**每个情形块都会调一次 `mod.apply(...)`**，
 *   而 `apply()` 第一件事就是按自己的 `config` 重置它 —— 于是情形之间不会串。
 */
let activeSettings = null;

/** 由 `apply()` 调用：把本进程的设置换成这一份。 */
function setActiveSettings(next) {
  activeSettings = next;
}

/** 读当前设置（**永远完整**，未初始化时给默认值）。 */
function currentSettings() {
  return activeSettings ?? settingDefaults();
}

/**
 * ★★★ 2026-10-10（用户拍板）：sid → **本会话锁定的项目根**。
 *
 * **用户原话**：*"因为总的工作区是有需要读的东西的，所以有时候会把对话建在总的
 * 工作区下面，这种时候的话，这个项目的锁定就应该考虑到可以让用户和AI说之后AI调用，
 * 或者说把项目注册到对应的文件夹上，以后各种工具的使用都在那个文件夹上。"*
 *
 * 以及他对我提出的"要不要落个注册表文件"的**否决**：
 * *"让模型拥有把插件锁定在对应或者说本次项目新建的文件夹中。而不是去动工作区的东西。
 * 不应该有这个权利。最开始的提示卡片就可以有这样的选择。"*
 *
 * ⇒ 三条硬约束（都是他给的）：
 *   ① **只在内存里** —— 绝不往工作区（或任何地方）写"注册表"。
 *      模型没有"往用户工作区里登记东西"这个权利。这与他早先那条
 *      「没登记就不往项目里写任何东西」是同一条纪律的延伸。
 *   ② **只在这场对话内** —— 用 sid 做键，会话一换就没了。这是有意的：
 *      对话建在总工作区是**这一次**的事，不该变成磁盘上的持久事实。
 *   ③ **首轮卡片就给这个选择** —— 见 `FIRST_TURN_OPTIONS`。
 *
 * ★ 为什么用**模块级 Map** 而不是放进 `state`：
 *   `projectRootOf(agent)` 只有 `agent` 一个入参，而它被 **9 处**调用，
 *   其中 `rootFromExec` 那条链**根本拿不到 state**。把锁放进 state 就得改 9 个签名。
 *   而"一个 profile 只装一份本插件"⇒ 模块级在这里是**真话**（与 `activeSettings`
 *   同样的理由，见它上面的注释）。
 * ★ 键是 sid ⇒ 天然满足约束②；`Map` 只在内存 ⇒ 天然满足约束①。
 */
const sessionProjectLock = new Map();

/**
 * ★★★ 2026-10-10（用户追加要求）：**把锁持久化**。
 *
 * **用户原话**：*"这个锁能不能长久保留，比如说我们在这个对话锁到项目台账文件夹后，
 *   不管重启多少次，之后都默认在那个文件夹使用工具"*
 * **★ 以及他对生效范围的关键澄清（我第一版理解错了，这是他纠正的）**：
 *   *"注意是每个对话自己选锁定的目录并保持"*
 * 以及清理方式：*"一直留着，手动解除"*
 *
 * ⇒ 三条合起来是：**锁按「每一场对话」各记各的，并且跨重启保持住。**
 *   ★ 我第一版做成了"按 cwd 记"（那个目录以后的对话都默认落到它）——
 *     **那是错的**：用户要的是"**这场**对话锁定在哪儿"，不是"这个目录默认在哪儿"。
 *     两者后果不同：前者换一场对话就是干净的默认；后者会让**新对话也悄悄改道**。
 * ⇒ 所以键是 **sid**（会话编号），不是 cwd。
 *
 * ★★ 这修正了 D50 的约束②（原来是他自己选的"只在这场对话内接管"）。
 *   约束①（**不碰工作区**）**依然成立且必须成立** —— 所以落盘位置只能选**插件自己的家**：
 *   `$DSH_HOME\plugin-data\dsh-ledger-memory\locks.json`。
 *   ★ 这不是我发明的：`$DSH_HOME\plugin-data\<包名>\*.json` 是本机**现成的惯例**
 *     （实测已有 `dsh-int-liblibai\credentials.json`、`dsh-int-model-search\favorites.json`）。
 *     它**在工作区之外** ⇒ 满足"不要去动工作区的东西"。
 *
 * ★★ 按 sid 记的**前提**必须先成立，否则"保持"是假的：**sid 跨重启要稳定**。
 *   实测（2026-10-10，只读会话文件的元数据，不读内容）：
 *     本会话 `session-fada6e5f-52f2-4a4f-b52a-3c2483db117e`，
 *     **首建 10-06 05:48:47 → 末写 10-10 18:12:01** ⇒ 跨 4 天、跨今天多次重启
 *     **一直是同一个 uuid 在追加**（也是台账里 `[fada]` 那个标签的来源）。
 *   ⇒ 前提成立：按 sid 落盘**真的能跨重启记住**。
 *
 * ★ 内存里仍保留 `sessionProjectLock`：它是**本会话的覆盖层**（中途改锁立刻生效，
 *   不必等回读），落盘那份是跨重启的底座。
 */
const LOCK_STORE_DIRNAME = "plugin-data";
const LOCK_STORE_PKG = "dsh-ledger-memory";
const LOCK_STORE_FILE = "locks.json";

/**
 * 锁记录文件路径。
 *
 * ★ 取值优先级：`DSH_HOME` 环境变量 → `~/.dsh`（本机默认家）。
 *   ★ 为什么不硬编码 `C:\Users\24239\.dsh`：那是本机私事，进不了发布包
 *     （本项目有"代码里 0 处本机硬编码路径"的发布门槛）。
 *   ★ 也**不**去读 `$DSH_HOME\sessions\`、`storages\`（红线）—— 这里只写自己的
 *     `plugin-data\<包名>\` 一个目录，与别家插件同一套规矩。
 */
function lockStorePath() {
  const home = process.env.DSH_HOME;
  const base = typeof home === "string" && home !== "" ? home : path.join(os.homedir(), ".dsh");
  return path.join(base, LOCK_STORE_DIRNAME, LOCK_STORE_PKG, LOCK_STORE_FILE);
}

/** 锁记录的形态版本（将来改结构时用来识别旧文件）。 */
const LOCK_STORE_VERSION = 1;

/**
 * 读锁记录（**全程吞错** ⇒ 读不到就当没有，绝不因为一个坏 JSON 让插件起不来）。
 *
 * 返回 `{ version, bySession: { sid: { root, cwd, at } } }`。
 */
function readLockStore() {
  const empty = { version: LOCK_STORE_VERSION, bySession: {} };
  const raw = readTextSafe(lockStorePath());
  if (raw === undefined) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return empty;
    const by = parsed.bySession;
    if (by === null || typeof by !== "object") return empty;
    // ★ 逐条校验：只收"sid→{root}"的条目，坏条目**丢掉而不是整份作废**
    //   （与 `parseLevels` 同一条纪律：一个坏字段不该毁掉整份配置）。
    const clean = {};
    for (const [sid, rec] of Object.entries(by)) {
      if (typeof sid !== "string" || sid === "") continue;
      if (rec === null || typeof rec !== "object") continue;
      if (typeof rec.root !== "string" || rec.root === "") continue;
      clean[sid] = {
        root: rec.root,
        cwd: typeof rec.cwd === "string" ? rec.cwd : undefined,
        at: typeof rec.at === "string" ? rec.at : undefined,
      };
    }
    return { version: LOCK_STORE_VERSION, bySession: clean };
  } catch {
    return empty;
  }
}

/**
 * 写锁记录（**吞错**：写不进去只影响"记不住"，绝不影响本次锁定生效）。
 *
 * ★ 用 `临时文件 + rename`（原子替换）：直接覆写时若进程被杀，
 *   会留下一份截断的 JSON ⇒ 下次读不出来 ⇒ **所有锁一起丢**。
 */
function writeLockStore(store) {
  const file = lockStorePath();
  try {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, path: file, reason: String((e && e.message) || e) };
  }
}

/**
 * ★★★ 增量压缩的**锚点也必须落盘**（2026-10-11，与项目锁同一处存）。
 *
 * 为什么：`state.deltaAnchor` 是**进程内 Map** ⇒ **内核每次重启就清空**，
 * 而判据是
 *
 *     const since = anchor === undefined ? pressure.ratio : pressure.ratio - anchor;
 *
 * ⇒ 锚点一空，`since` **退化成整个水位**（例如 41%）⇒ 20 点的闸门形同虚设
 *   ⇒ **重启后的第一次压缩必然触发**，而且插件会报"涨了 41 点"（恰好等于当时水位）。
 *
 * ★ 这是实测出来的，不是推测（2026-10-10，会话 fada6e5f 的官方日志）：
 *
 *     压缩时刻     压前水位   报"涨了 N 点"     判定
 *     12:03:07      50.2%        26            ✅ 真增量
 *     15:39:08      50.1%        28            ✅ 真增量
 *     16:12:23      35.4%        35            ★ N == 水位（锚点空）
 *     17:48:47      37.8%        38            ★ N == 水位（锚点为 1 分钟前重启清空）
 *     18:04:12      33.6%        34            ★ N == 水位
 *     18:33:41      41.2%        41            ★ N == 水位（内核 18:30:56 刚重启）
 *
 * ⇒ 与项目锁**同一个病灶**（进程内状态被重启清空），所以**用同一处存**：
 *   `$DSH_HOME\plugin-data\dsh-ledger-memory\anchors.json`。
 *   ★ 仍然**不碰用户的工作区**（那条红线不变）。
 */
const ANCHOR_STORE_FILE = "anchors.json";

/** 锚点记录文件路径（与锁同一个目录）。 */
function anchorStorePath() {
  return path.join(path.dirname(lockStorePath()), ANCHOR_STORE_FILE);
}

/** 读锚点记录：`{ version, bySession: { sid: ratio } }`（坏条目丢掉，不整份作废）。 */
function readAnchorStore() {
  const empty = { version: 1, bySession: {} };
  const raw = readTextSafe(anchorStorePath());
  if (raw === undefined) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return empty;
    const by = parsed.bySession;
    if (by === null || typeof by !== "object") return empty;
    const clean = {};
    for (const [sid, v] of Object.entries(by)) {
      if (typeof sid !== "string" || sid === "") continue;
      if (!Number.isFinite(v) || v < 0 || v > 1) continue;
      clean[sid] = v;
    }
    return { version: 1, bySession: clean };
  } catch {
    return empty;
  }
}

/** 写锚点记录（吞错 + 临时文件改名；写不进去只影响"记不住"）。 */
function writeAnchorStore(store) {
  const file = anchorStorePath();
  try {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/**
 * 取这一场对话的压缩锚点（内存优先，其次落盘的那份）。
 * ★ **唯一的取锚点出口** —— 与项目锁同一条纪律：不许别处再直接读 Map
 *   （D51/D52 都是"写了新判定却漏了旧调用点"出的缺口）。
 */
function anchorOf(state, key) {
  const mem = state?.deltaAnchor?.get(key);
  if (Number.isFinite(mem)) return mem;
  const disk = readAnchorStore().bySession[key];
  return Number.isFinite(disk) ? disk : undefined;
}

/** 记下这一场对话的锚点（内存 + 落盘各一份）。 */
function setAnchor(state, key, ratio) {
  if (!Number.isFinite(ratio)) return;
  const v = Math.max(0, Math.min(1, ratio));
  state?.deltaAnchor?.set(key, v);
  const store = readAnchorStore();
  store.bySession[key] = v;
  writeAnchorStore(store);
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★ 2026-10-12（D136）**区块变更史** —— 「权重可变」在磁盘上的支点
//
//   ★ 用户要求（逐字）：*"权重应该是可变的，正在处理的东西与所有底线与原则毫无疑问
//     是高分，已处理的、已过期的低分，**时间是打分标准之一**"*。
//
//   ★★★ 为什么必须有它（实测撞到，不是推断）：
//     `mechanicalWeight` 的时间分与"长期稳定分"都要问"这块上次什么时候变的"，
//     而没有变更史时它只能拿到 `undefined` ⇒ **时间分恒 0** ⇒ 25 块全落到同一档，
//     "可变"当场变成一句空话。★ 我上一版就是这么白测的（自己造了整齐的假历史 ⇒
//     算出 92.9% 必注，那个数**是假的**，已作废）。
//
//   ★ 存法**照抄已验证的 `anchors.json`**（同一目录、同一套"临时文件 + 改名"、
//     同一个吞错习惯）—— 本项目纪律：**别另发明一套持久化**。
//   ★ 仍然**不碰用户的工作区**：落在 `$DSH_HOME\plugin-data\`（那条红线不变）。
// ═══════════════════════════════════════════════════════════════════════════

const BLOCK_HISTORY_FILE = "blocks.json";

/** 每块变更史的条目上限（防止台账反复大改把这份文件撑爆）。 */
const BLOCK_HISTORY_MAX = 2000;

/** 不在当前台账里、且**超过这个年纪**的块条目 ⇒ 清理。 */
const BLOCK_HISTORY_TTL_MS = 90 * 86400e3;

/** 区块变更史文件路径（与锁/锚点同一个目录）。 */
function blockHistoryPath() {
  return path.join(path.dirname(lockStorePath()), BLOCK_HISTORY_FILE);
}

/** 读区块变更史：`{ version, byRoot: { root: { writes, lastWriteAt, present, blocks } } }`。 */
function readBlockHistory() {
  const empty = { version: 1, byRoot: {} };
  const raw = readTextSafe(blockHistoryPath());
  if (raw === undefined) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return empty;
    const by = parsed.byRoot;
    if (by === null || typeof by !== "object") return empty;
    return { version: 1, byRoot: by };
  } catch {
    return empty;
  }
}

/** 写区块变更史（吞错 + 临时文件改名；写不进去只影响"记不住"）。 */
function writeBlockHistory(store) {
  const file = blockHistoryPath();
  try {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store) + "\n", "utf8");
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/**
 * 记一次"活跃台账被写好之后"的块变更史（★ 只在**写成功且已落盘**时调用）。
 *
 * ★ 判据严格按"内容"：块内容变了 ⇒ **哈希也变** ⇒ 那是一个**新条目**，
 *   旧条目就此停止累加。⇒ "跨 N 次写入从未变"= `w ≥ N && last === first`，
 *   **不需要额外维护"变过没有"这个布尔**（少一个能写歪的状态）。
 *
 * @param {string} root 项目根
 * @param {string} text 落盘后的**活跃台账全文**
 * @param {number} nowMs 现在
 */
function recordBlockHistory(root, text, nowMs) {
  if (typeof text !== "string" || root === undefined) return undefined;
  let blocks;
  try {
    blocks = splitBlocks(text);
  } catch {
    return undefined; // 记不住历史不影响台账本身
  }
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const store = readBlockHistory();
  const h = store.byRoot[root] ?? { writes: 0, lastWriteAt: 0, present: [], blocks: {} };
  const presentBefore = new Set(Array.isArray(h.present) ? h.present : []);
  const cur = {};
  h.writes = Number(h.writes ?? 0) + 1;
  h.lastWriteAt = now;
  for (const b of blocks) {
    const old = h.blocks[b.hash];
    if (old === undefined) {
      cur[b.hash] = { w: 1, first: now, last: now };
    } else if (presentBefore.has(b.hash)) {
      // ★ 上一轮也在、这一轮还是它 ⇒ **没变过** ⇒ `last` 不动（这正是"从未变"的来源）
      cur[b.hash] = { w: Number(old.w ?? 0) + 1, first: Number(old.first ?? now), last: Number(old.last ?? now) };
    } else {
      // 中间消失过又回来了 ⇒ 算"变过"（保守：宁可认为它变过）
      cur[b.hash] = { w: Number(old.w ?? 0) + 1, first: Number(old.first ?? now), last: now };
    }
  }
  // 清理：只留"当前还在"的 + 没过期的（否则反复大改会把文件撑爆）
  for (const [hash, e] of Object.entries(h.blocks ?? {})) {
    if (cur[hash] !== undefined) continue;
    if (now - Number(e?.last ?? 0) <= BLOCK_HISTORY_TTL_MS) cur[hash] = e;
  }
  // 上限保护：超过就丢最旧的
  const keys = Object.keys(cur);
  const bhMax = numOf("blockHistoryMax", BLOCK_HISTORY_MAX);
  if (keys.length > bhMax) {
    keys.sort((a, b) => Number(cur[a].last ?? 0) - Number(cur[b].last ?? 0));
    for (const k of keys.slice(0, keys.length - bhMax)) delete cur[k];
  }
  h.blocks = cur;
  h.present = blocks.map((b) => b.hash);
  store.byRoot[root] = h;
  writeBlockHistory(store);
  return { writes: h.writes, blocks: Object.keys(cur).length };
}

/**
 * 取某项目的**块哈希 ⇒ 变更史**（`mechanicalWeight` 直接吃这个形状）。
 *
 * @returns {Map<string,{writes:number,changed:boolean,newest:boolean,lastChangedAt:number}>}
 */
function blockHistoryFor(root, nowMs) {
  const store = readBlockHistory();
  const h = store.byRoot?.[root];
  const out = new Map();
  if (h === undefined || typeof h !== "object") return out;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const lastWriteAt = Number(h.lastWriteAt ?? 0);
  for (const [hash, e] of Object.entries(h.blocks ?? {})) {
    const w = Number(e?.w ?? 0);
    const first = Number(e?.first ?? 0);
    const last = Number(e?.last ?? 0);
    out.set(hash, {
      writes: w,
      // ★ "从来没变过" = 这段内容**一次都没被改写**（哈希没换过）
      changed: !(last === first),
      // ★ "最近一次写入新增" = 它是**刚刚那一次**才出现的
      newest: first === lastWriteAt && lastWriteAt > 0,
      lastChangedAt: last,
      firstSeenAt: first,
    });
  }
  void now;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 胶囊素材落盘（D61 修复）—— 「重启后首次压缩的胶囊质量最差」的解药
//   与 `anchorStore` **同一个套路、同一个目录**（实证有效的先例，别另发明一套）。
// ═══════════════════════════════════════════════════════════════════════════

/** 胶囊素材记录文件路径（与锁/锚点同一个目录）。 */
function capsuleStorePath() {
  return path.join(path.dirname(lockStorePath()), CAPSULE_STORE_FILE);
}

/**
 * ★★★ 2026-10-13（D159 §四）：全量压缩来源的**渲染文案**（按当前设置算，**不写死 70%**）。
 *
 * ★ 真机缺陷：三处渲染把 `"auto:70%"` 直接写成「自动（70% 水位）」，
 *   而实际生效线是 **30%** ⇒ 胶囊与只存单的**文件头都写着假的 70%**。
 *   ★ 这是**纪律 11「记录存在 ≠ 记录准确」的同型复发**：标签写下来了，
 *     **写的是错的**。取证时它会把读者（包括我自己）带到错方向上 ——
 *     本次就是为了这个标签，先怀疑了半天"是不是 profile 覆盖"，查完才发现
 *     真因是内核跑旧代码。
 *
 * ★ 保守做法：把内部键 `"auto:70%"` **原样保留**（它是对外契约的一部分 ——
 *   L0 日志、旧记录、`pushHfSource`/`popHfSource` 都在用它），
 *   只改**渲染出来的那句话**。
 * ★ 设置读不到（`numOf` 退回常量 0.3）时也照样能渲染 —— 不留 `undefined` 进文案。
 */
function autoFullLabel() {
  return `自动（${autoFullPct()}% 水位）`;
}

/** 同上，只存单那份的措辞（保留"压缩前"三个字，与本来的口径一致）。 */
function autoFullLabelBefore() {
  return `自动（${autoFullPct()}% 水位压缩前）`;
}

/**
 * ★★★ 2026-10-13（D161）：水位线的**数字**也收成一个出口。
 *
 * ★ 为什么再抽一层（而不是又写一遍 `Math.round(numOf(...) * 100)`）：
 *   D159 修的就是"三处渲染各自写死同一个值"，我加第一版 D161 时**又内联了一遍**
 *   —— 那就是**同型复发的第三次**。同一条水位被三处各自算 ⇒ 改设置时必漏一处。
 *   ⇒ 口径只留**这一个函数**，三处渲染都从它取（照本项目"唯一出口"的老规矩）。
 */
function autoFullPct() {
  return Math.round(numOf("highFidelityCompactRatio", HIGH_FIDELITY_COMPACT_RATIO) * 100);
}

/**
 * ★★★★★ 2026-10-13（D163）：压缩来源的**短标签** —— 唯一出口（索引行 / L0 里程碑共用）。
 *
 * ★ 真机缺陷（**D159 的同型第四次**）：被压段索引行原来直接插值 `${x.source}`，
 *   而它是**内部键**（`auto:70%`）⇒ 模型眼前看到的是「70%」，而实际生效线是 **30%**
 *   （`highFidelityCompactRatio: 0.3`）。
 *   ★ 现场：本回合注入里那行 `- seq 55675–56462（330 个节点，10-13 03:26，auto:70%）`
 *     —— 同一份注入的文件头却正确写着「自动（30% 水位）」（胶囊头部）。**同一拍，两个数字。**
 *   ★★ **为什么 D159 那次没抓到它**：那三处是**字面量**（`"自动（70% 水位）"`），
 *     这里是**变量插值** ⇒ 拿 `"auto:70%"` 去 grep **源码**，命中不了这一处
 *     （只命中 pushHfSource / 比较 / 注释）。
 *     ⇒ 这是纪律 11「记录存在 ≠ 记录准确」的又一次：标签写下来了，写的是**内部键**。
 *   ★ 为什么用**短**形式（`自动 30%`）而不是 `autoFullLabel()`（`自动（30% 水位）`）：
 *     索引行本身嵌在一层括号里 ⇒ 再套一层中文括号会读成两截
 *     （`（330 个节点，10-13 03:26，自动（30% 水位））`）。索引要「小到可常驻」（D46）。
 *   ⚠️ 胶囊**文件头**仍用长形式（`autoFullLabel()`）：那处不在括号里、也没有长度压力，
 *     且它**已经验过是对的**（真机文件头 03:26 那份写的就是「自动（30% 水位）」）。
 *     两处的**百分比同源**（都取 `autoFullPct()`）⇒ 数字不会分叉。
 */
function hfSourceShort(src) {
  if (src === "auto:70%" || src === "auto" || src === "auto:full") return `自动 ${autoFullPct()}%`;
  if (src === "auto:delta") return "自动（增量）";
  if (src === "official") return "内核（官方）";
  if (src === "manual") return "手动（工具）";
  if (src === "command") return "手动（命令）";
  if (src === "card" || src === "user") return "手动（卡片）";
  if (typeof src === "string" && src !== "" && src !== "?") return src;
  return "未知来源";
}

/**
 * ★★★★★ 2026-10-13（D167）：`compaction/end` 到底**成没成**？—— **唯一出口**。
 *
 * ★ 真机缺陷（2026-10-13 13:18，用户报"手动点压缩不太行了"）：
 *   `compactVsInject()` 原来**只认 `compaction/end` 存在**，不看它**有没有 `error`**。
 *   ⇒ **失败的压缩也被当成"压缩发生了"** ⇒ 触发一次**假的**「上下文刚被压缩」重注。
 *   ★ 真机为证：13:18:15 那次 `compaction/end` 带
 *     `error: "Stream ended without finish_reason"`（provider 断流，**摘要从未生成**，
 *     该时段**没有 `compaction/summary` 事件**）；紧接着的注入却写着
 *     「## 上下文刚被压缩」「本插件在 30% 时主动执行了一次压缩」
 *     ⇒ **模型被告知了没发生的事**，并据此以为历史已被压掉。
 *
 * ★★ 为什么这比"漏报"更严重（这条要记住）：
 *   漏报 ⇒ 模型只是少拿一次重注，**它知道自己手上有什么**；
 *   谎报 ⇒ 模型以为"旧的都进摘要了"⇒ **它会放心地不再回查** ⇒
 *   直接打穿四底线里的**准确性**与**主动回查**。
 *   ★ 与 D151 那三个"静默出口"同族：**状态被判错时，宁可不报，也不许报反。**
 *
 * ★ 判据吃**结构化字段**（`data.error`），不吃文案：内核在失败时才 append `error`
 *   （`session.append("compaction/end", { ...lifecycle, error: errorChain(error) })`），
 *   成功那条**根本没有这个键** ⇒ 一次判断就够，且不怕内核改措辞。
 *
 * @param {object} event 会话事件
 * @returns {boolean} 只有"是 compaction/end 且没有 error"才为真
 */
function compactionEndSucceeded(event) {
  return event?.type === "compaction/end" && event?.data?.error === undefined;
}

/**
 * ★★★★★ 2026-10-13（D161）：**「压缩之后还没重注过吗」——从会话日志算，不靠内存标记**。
 *
 * ★ 为什么非要从日志算（真机实测，不是推理）：
 *   本会话 `compaction/end` = seq 55682（02:43:46）、`session/end-seed` = 02:44:37、
 *   新进程首条 `request/header` = 02:45:47 ⇒ 压缩**跨了重启**。
 *   新进程里那条注入（seq 55689）**四个分支标语一个都不含** ⇒ 走的是**普通注入**。
 *   ★ 根因：`state.reinject` 是纯内存 Map ⇒ 标记随旧进程消失。
 *   ⇒ 这正是刚刚为 `shadowedIndex` 立的那条判据的**同型复发**：
 *     **「只要一样东西是「压缩后唯一的路标」，它就不许只活在内存里」**。
 *
 * ★ 为什么判据吃**日志**而不是再落一个盘：
 *   ① 日志是内核**只追加的真源**、跨重启仍在 ⇒ 推出来的结论天然跨重启有效；
 *   ② ★ **自消费**：重注一旦写进日志，`lastInjectSeq > lastCompactSeq` ⇒ 下次不再触发，
 *      不需要额外的"删除时机"（本项目栽过的正是"漏了删除时机"这类接线，见 D158）；
 *   ③ 零新增持久化 ⇒ 不多一个会与真源分叉的文件。
 *
 * ★★ 为什么**绝不做文本匹配**：台账正文里**自己就含**「上下文刚被压缩」这几个字
 *   （那条注入尾部的契约里就有）⇒ 拿文本当判据必然**假阳性**。
 *   ★ 纪律 2：**判据的输入必须是被测对象自己产生的那部分**。
 *
 * @param {object} agent
 * @returns {boolean|undefined} `true`=压缩后还没重注；`undefined`=**无法判定**（调用方必须**回落**旧判据，绝不猜）
 */
function compactVsInject(agent) {
  try {
    const log = agent?.session?.log;
    if (!Array.isArray(log)) return undefined;
    let lastCompactSeq;
    let lastInjectSeq;
    for (const e of log) {
      const seq = e?.seq;
      if (!Number.isFinite(seq)) continue;
      // ★★★★★ 2026-10-13（D167）：**失败的压缩不算"压缩过"**。
      //   ★ 原来只判类型 ⇒ 13:18:15 那次 `error:"Stream ended without finish_reason"`
      //     的失败也给算成"压缩发生了" ⇒ 触发假重注（见 `compactionEndSucceeded` 的注释）。
      //   ★ 判据走唯一出口，与 L14894 那处**同一份**（两处各写一套必然分叉）。
      if (compactionEndSucceeded(e)) {
        if (lastCompactSeq === undefined || seq > lastCompactSeq) lastCompactSeq = seq;
      } else if (e?.type === "user/message" && e?.data?.source?.kind === INJECT_KIND) {
        if (lastInjectSeq === undefined || seq > lastInjectSeq) lastInjectSeq = seq;
      }
    }
    // 没有压缩记录 ⇒ 不是"压缩后"（交给内存判据，两者是**或**的关系）。
    if (lastCompactSeq === undefined) return false;
    // 压缩过、但从来没有注入过 ⇒ 必须重注。
    if (lastInjectSeq === undefined) return true;
    return lastCompactSeq > lastInjectSeq;
  } catch {
    // ★ 读不到就**说读不到**（`undefined`）—— 由调用方回落到内存判据。
    //   绝不在这里猜 `false`：那会把"读失败"静默变成"不用重注"。
    return undefined;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★ 2026-10-13（D160）**被压段索引**也要能跨重启 —— 补上"指针"的持久化
//
//   ★ 真机缺陷（D159 §三 实测）：`state.shadowedIndex` 是**纯内存 Map**，
//     注释里原本还写着"只存内存即可"（理由是"它描述本会话的日志 seq 区间"）。
//     ⇒ 那次压缩**恰好跨了重启**（`session/end-seed` 在压缩之后）⇒ 索引随旧进程消失
//     ⇒ 压缩后重注里**只剩台账全文 + 内核摘要**，**一句"原文去哪读"都没有**。
//
//   ★ 为什么这直接伤底线：台账 §七 写死的判据是
//     **"我们的每一份摘要都必须带指针"**（这是与 billion 最本质的差别）。
//     没有指针 ⇒ 模型压完只剩摘要 ⇒ 只能凭记忆复述 ⇒
//     **四底线里的"可回溯性"与"主动回查"当场同时失效**。
//
//   ★ 为什么原来那句"只存内存即可"是错的（值得记）：
//     它把"**数据的语义**是会话内的"与"**数据的生命周期**该有多长"混成了一件事。
//     seq 区间确实只在会话内有意义，但**模型需要它的时刻**恰恰在"重启后接续"——
//     而那正是本插件存在的理由（用户原话：*"延续性"*）。
//     ⇒ ★ 这是一条可复用的判据：**只要一样东西是"压缩后唯一的路标"，它就不许只活在内存里。**
//
//   ★ 存法**照抄已验证的 `anchors.json`**（同一目录、同一套"临时文件 + 改名"、
//     同一套"坏条目丢掉不整份作废"）—— 本项目纪律：**别另发明一套持久化**。
//   ★ 仍然**不碰用户的工作区**：落在 `$DSH_HOME\plugin-data\`（那条红线不变）。
// ═══════════════════════════════════════════════════════════════════════════

const SHADOWED_INDEX_FILE = "shadowed.json";
/** 落盘时最多保留几场会话的索引（与胶囊素材同一量级）。 */
const SHADOWED_STORE_SESSIONS = 60;

/** 被压段索引的落盘路径（与锁/锚点/胶囊同一个目录）。 */
function shadowedStorePath() {
  return path.join(path.dirname(lockStorePath()), SHADOWED_INDEX_FILE);
}

/**
 * 读被压段索引：`{ version, bySession: { sid: [rec, …] } }`。
 *
 * ★ 逐条校验、**坏条目丢掉、不整份作废**（照 `readAnchorStore` / `readCapsuleStore`）。
 *   一条坏的索引不该让整份历史失去指针。
 */
function readShadowedStore() {
  const empty = { version: 1, bySession: {} };
  const raw = readTextSafe(shadowedStorePath());
  if (raw === undefined) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return empty;
    const by = parsed.bySession;
    if (by === null || typeof by !== "object") return empty;
    const clean = {};
    for (const [sid, list] of Object.entries(by)) {
      if (typeof sid !== "string" || sid === "") continue;
      if (!Array.isArray(list)) continue;
      const rows = list.filter(
        (x) =>
          x !== null &&
          typeof x === "object" &&
          Number.isFinite(x.summarySeq) &&
          Number.isFinite(x.start) &&
          Number.isFinite(x.end),
      );
      if (rows.length === 0) continue;
      clean[sid] = rows;
    }
    return { version: 1, bySession: clean };
  } catch {
    return empty;
  }
}

/** 写被压段索引（吞错 + 临时文件改名；写不进去只影响"重启后还记得路标"）。 */
function writeShadowedStore(store) {
  const file = shadowedStorePath();
  try {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/** 把某场会话的索引整份写到盘上（有界：只留最近 N 场会话）。 */
function persistShadowedIndex(sid, list) {
  if (typeof sid !== "string" || sid === "" || !Array.isArray(list)) return;
  try {
    const store = readShadowedStore();
    store.bySession[sid] = list;
    const keys = Object.keys(store.bySession);
    if (keys.length > SHADOWED_STORE_SESSIONS) {
      for (const k of keys.slice(0, keys.length - SHADOWED_STORE_SESSIONS)) delete store.bySession[k];
    }
    writeShadowedStore(store);
  } catch {
    /* 落盘失败绝不影响压缩本身（与胶囊同一条硬约束） */
  }
}

/**
 * ★ 取某场会话的被压段索引：**内存优先，其次落盘那份**（照 `anchorOf` 的唯一出口纪律）。
 *
 * ★ 为什么必须"内存优先"：内存那份是本进程刚记的、最新；
 *   而落盘那份可能是**上一次进程**留下的 —— 重启后内存空，正是它救命的地方。
 * ★ 为什么必须"内存非空就不看盘"：同一次压缩可能在两条路径各记一遍，
 *   合并两份会让**同一条索引出现两次**（`summarySeq` 去重只在写入时做）。
 *   ⇒ 口径：**内存有就用内存**（它是超集）；内存空才回落到盘上。
 */
function shadowedIndexOf(state, sid) {
  const key = String(sid);
  const mem = state?.shadowedIndex?.get(key);
  if (Array.isArray(mem) && mem.length > 0) return mem;
  const disk = readShadowedStore().bySession[key];
  return Array.isArray(disk) && disk.length > 0 ? disk : undefined;
}

/**
 * ★★★ 从**当前会话的只追加日志**里，按 seq 区间把逐字原文读出来（只读）。
 *
 * 出处与依据（2026-10-11，逐字读过内核源码）：
 *   · `dsh-session/lib/index.js` L516 `this.log = log`、L1363 `eventAt(seq) { return this.log[seq] }`
 *     ⇒ **被下架的原文就在 `session.log` 里**，插件手上直接有。
 *   · 所以**不必**去读官方 `$DSH_HOME/sessions/*.jsonl.zstd`
 *     —— 那既不碰红线，也不涉及 cwd 编码（两件麻烦事都避开了）。
 *
 * ★ 为什么这是"无损接续"的关键一环（承 DECISIONS D46 / D79）：
 *   内核的全量压缩把一段历史换成**一个摘要节点**（有损）；
 *   原文仍在日志里，但**模型不知道去哪找**。
 *   本函数 + `session/shadowed` 索引 = 让模型能**按需把逐字原文（含 reasoning）读回来**。
 *
 * @param {object} session 当前会话（`agent.session`）
 * @param {number} from 起始 seq（含）
 * @param {number} to 结束 seq（含）
 * @param {object} [opts] `{ maxChars, reasoning }` —— 字符闸门与是否含推理块
 * @returns {{ok:boolean, events?:Array, chars?:number, reason?:string}}
 */
function readSessionRange(session, from, to, opts) {
  const a = Math.max(0, Number(from) || 0);
  const b = Math.max(a, Number(to) || 0);
  const maxChars = Math.max(200, Number(opts?.maxChars) || 24000);
  const withReasoning = opts?.reasoning !== false;
  if (typeof session?.eventAt !== "function") {
    return { ok: false, reason: "这个执行里没有可读的会话（session.eventAt 不存在）" };
  }
  const out = [];
  let chars = 0;
  let truncated = false;
  for (let seq = a; seq <= b; seq += 1) {
    let e;
    try {
      e = session.eventAt(seq);
    } catch {
      e = undefined;
    }
    if (e === undefined || e === null) continue;
    const blocks = e.data?.message?.content ?? e.data?.content;
    // ★ 只回**会产生消息**的那部分字段；其余（usage / source / 附件元数据）不回，
    //   否则会把上下文塞满与被压内容无关的技术字段。
    let text = "";
    if (Array.isArray(blocks)) {
      const parts = [];
      for (const blk of blocks) {
        if (blk === null || typeof blk !== "object") continue;
        if (blk.type === "reasoning") {
          if (!withReasoning) continue;
          parts.push(`[推理] ${blk.text ?? ""}`);
        } else if (blk.type === "text") {
          parts.push(blk.text ?? "");
        } else if (blk.type === "tool-call") {
          // 工具调用：给名字 + 参数（这是"上面那个模型做了什么"的核心）
          parts.push(`[调用 ${blk.name ?? "?"}] ${typeof blk.arguments === "string" ? blk.arguments : JSON.stringify(blk.arguments ?? {})}`);
        } else if (blk.type === "image" || blk.type === "file") {
          parts.push(`[${blk.type}]`);
        } else {
          parts.push(`[${String(blk.type ?? "?")}]`);
        }
      }
      text = parts.join("\n");
    } else if (typeof blocks === "string") {
      text = blocks;
    }
    if (text === "") continue;
    const hit = text.length;
    if (chars + hit > maxChars) {
      // ★ 超闸门就**在事件边界截断**并如实标注 —— 绝不许悄悄截半个事件（那会失真）。
      truncated = true;
      break;
    }
    chars += hit;
    out.push({ seq, type: e.type, time: e.time, text });
  }
  return {
    ok: true,
    events: out,
    chars,
    from: a,
    to: b,
    truncated,
    reasoning: withReasoning,
  };
}

/**
 * ★★★ 把一次压缩**下架了什么**记成一条可回读的索引（承 D79「指针推行」）。
 *
 * 数据来源：内核 `compaction/summary` 事件上的 `shadowedRange` / `shadowedSeqs`
 * —— **内核本来就写了**，我们只做一行索引 ⇒ **零新增采集**。
 *
 * ★ 为什么要推行（而不是等模型来查）：D46 明确——
 *   **"恢复必须是「推」给模型的，不能是「等模型来查」的。"**
 *   索引只有**一行/一次压缩**（本机 22 次压缩 ⇒ 22 行），小到可以常驻。
 *
 * @param {object} state 插件状态（用 `shadowedIndex` 存）
 * @param {string} sid 会话 id
 * @param {object} agent
 * @param {string} [source] 谁压的（auto:delta / auto:full / manual）
 * @param {{capRel?:string}} [extra] ★ 阶段 1：逐字原件的去处（胶囊的相对路径）
 * @returns {object|undefined} 记录下来的那一条
 */
function recordShadowedIndex(state, sid, agent, source, extra) {
  try {
    const session = agent?.session;
    if (session === undefined) return undefined;
    // 找**最近一次** compaction/summary（就是刚跑完的那一次）。
    const log = session.log;
    if (!Array.isArray(log) || log.length === 0) return undefined;
    let found;
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const e = log[i];
      if (e?.type === "compaction/summary") { found = e; break; }
    }
    if (found === undefined) return undefined;
    const range = found.data?.shadowedRange;
    const seqs = found.data?.shadowedSeqs;
    if (range === undefined || !Array.isArray(seqs)) return undefined;
    // ★★★ 2026-10-12（D100 §五 的待复核项，已定案）：**`shadowedRange` 不是连续区间**。
    //
    //   实测（`tools/_probe-shadowed-range.mjs`，本会话 26 次压缩）：**6 次的 `start > end`**（23%）。
    //   形状（seq=37021 那次）：
    //     `shadowedRange = {start: 36764, end: 35270}`    ← 倒的
    //     `shadowedSeqs  = 36764, 35018, 35021, …`        ← 首项是**上一次的摘要节点**
    //   ⇒ 语义是"**这次吞掉了哪些 surface 节点**"，其中**包含上一次的摘要**（36764）
    //     再加上更旧的一批（35018…）⇒ 所以 `start` 可以是"较新的那个"。
    //
    //   ★ 我原来的渲染把它写成 `seq 36764–35270` —— **一个倒着的区间**，
    //     模型照着调 `ledger_recall({from:36764, to:35270})` 只会拿到空的。
    //   ⇒ 改成**从 `shadowedSeqs` 取真实 min/max**（那个列表才是权威，`range` 只是边界）。
    //     ★ min–max 是**超集**（可能含未被压的节点）—— 宁可多读、不可漏读。
    const nums = seqs.filter((n) => Number.isFinite(n));
    const lo = nums.length > 0 ? Math.min(...nums) : range.start;
    const hi = nums.length > 0 ? Math.max(...nums) : range.end;
    const rec = {
      at: found.time ?? Date.now(),
      summarySeq: found.seq,
      // ★★★ 用**真实 min/max**（见上面那段：`range` 可能是倒的）。
      //   `nodes` 与 `shadowedTokens` 仍按原始数据报，不改口径。
      start: lo,
      end: hi,
      // ★ 把内核原始边界也留着（**只作诊断**，不参与渲染）——
      //   将来要查"内核的 range 到底什么语义"时，不必再去翻会话日志。
      rawStart: range.start,
      rawEnd: range.end,
      nodes: seqs.length,
      shadowedTokens: found.data?.shadowedTokenCount,
      summaryChars: Array.isArray(found.data?.summary)
        ? found.data.summary.reduce((n, x) => n + (typeof x?.text === "string" ? x.text.length : 0), 0)
        : 0,
      source: source ?? "?",
      // ★★★ 阶段 1 第 2 件：逐字原件的去处（项目相对路径，可直接复制去读）。
      //   ★ 存**路径**而不是内容 —— 索引要小到可常驻，内容留在盘上按需取。
      ...(typeof extra?.capRel === "string" && extra.capRel !== ""
        ? { capRel: extra.capRel }
        : {}),
    };
    const key = String(sid);
    // ★★★ 2026-10-13（D160）：起点必须**内存 + 落盘并起来**，不能只看内存。
    //   ★ 为什么：重启后内存是空的，而"上一次进程压掉的那几段"仍需要被推行
    //     （否则模型压完只剩摘要、没有任何路标 —— 那正是 D159 §三 实测到的失效）。
    //   ★ 为什么用**落盘在前、内存在后**：数组按时间正序渲染，盘上那份更旧。
    //   ★ 去重仍按 `summarySeq`（幂等：同一次压缩重复记不会重复追加）。
    const fromDisk = readShadowedStore().bySession[key];
    const base = Array.isArray(fromDisk) ? [...fromDisk] : [];
    const list = Array.isArray(state.shadowedIndex.get(key))
      ? [...base, ...state.shadowedIndex.get(key)].filter(
          (x, i, arr) => arr.findIndex((y) => y.summarySeq === x.summarySeq) === i,
        )
      : base;
    // 同一次压缩只记一条（按 summarySeq 去重）——重复调用不会重复追加。
    if (!list.some((x) => x.summarySeq === rec.summarySeq)) {
      list.push(rec);
      // 有界：只留最近 N 次（索引要"小到可常驻"，不能无限长）。
      const idxMax = numOf("shadowedIndexMax", SHADOWED_INDEX_MAX);
      if (list.length > idxMax) list.length = idxMax;
      state.shadowedIndex.set(key, list);
      // ★★★ 2026-10-13（D160）：**真记上了才落盘** —— 重启后这份索引是唯一路标。
      //   ★ 吞错（`persistShadowedIndex` 自己 catch）：写盘失败绝不许挡住压缩。
      persistShadowedIndex(key, list);
    }
    return rec;
  } catch {
    return undefined;
  }
}

/**
 * ★★★★★ 2026-10-13（D165）：胶囊目录的**项目相对路径 —— 唯一出口**。
 *
 * ★ 为什么必须收成一个（真机缺陷，D164 的**同型残留**）：
 *   收口前有**三处各自算同一个目录**，且算出的串**互不相同**：
 *     · 真落盘 `persistCapsule`： `` `${dir}/${period}/capsules` ``  ⇒ `_ledger-log/2026-10/week2/capsules`
 *     · 兜底指针 `capsulePathFor`： `path.join(dir, stamp.dir, "capsules")` ⇒ `_ledger-log\2026-10\week2\capsules`
 *     · 注入里的"历次胶囊"指针： `path.join(projectRoot, logRel, capPeriod, "capsules")`
 *   ★★ 更要命的是 `capsulePathFor` 里写的是**字面量 `"capsules"`**，而不是常量
 *     `CAPSULE_DIR_NAME` ⇒ **常量一改名，落盘与指针当场分叉**，而那种分叉正是 D164
 *     抓到的那个（指针指向一个不存在的地方 ⇒ 模型照抄读不到 ⇒ 伤准确性与可回溯）。
 *   ⇒ ★ 判据口径：「**同一个目录不许算两遍**」。算两遍必然在**某一次改动**上分叉。
 *
 * ★ 一律用**正斜杠**（不用 `path.join`）：
 *   这串会被写进 markdown 给人和模型**复制粘贴**。Windows 的反斜杠在部分渲染器里
 *   是转义符（`\_` 会被吃掉），而项目相对路径在 Windows 上正斜杠同样可解析。
 *   ★ 与 `persistCapsule` 返回的 `rel`（`.../capsules/<文件>.md`）口径一致 ⇒
 *     正常路径（`persistRel`）与兜底路径渲染出来的**是同一种写法**。
 *
 * @param {object} info `inspect(root)` 的结果
 * @param {Date} now 用哪一刻算期间桶（落盘与指针必须用**同一个**时刻口径）
 * @returns {string|undefined} 取不到 `logDir` 时返回 `undefined`（**如实留空，绝不编路径**）
 */
function capsuleDirRel(info, now) {
  const dir = logDirOf(info);
  if (dir === undefined) return undefined;
  const { dir: period } = archiveStamp(now, info?.manifest?.archiveWeekMode);
  return `${dir}/${period}/${CAPSULE_DIR_NAME}`;
}

/**
 * ★★★ 2026-10-12（阶段 1 第 2 件）：**按 seq 查「逐字原件在哪」**。
 *
 * ★ 缺口（这是结构性缺口，不是实现细节）：
 *   索引行原来只说「seq 4000–4100 ⇒ 摘要 seq 4200」。可**那一区间里**：
 *   · 会话日志里是**原始事件流**（要从里面挑出人说的话，得自己过滤）；
 *   · 而**胶囊文件**（`_ledger-log/<期间>/capsules/<时间>-<会话>.md`）是
 *     插件在压缩**前**存好的**成品**：用户原话逐字 / 报错原文 / 器物索引，全都分好类了。
 *   ⇒ ★ **同一份历史有两个去处，而索引只指了难找的那一个。**
 *
 * ★ 为什么会这样（顺序问题，值得记）：
 *   `captureCapsuleBeforeCompact()`（存胶囊）**先**跑，
 *   `recordShadowedIndex()`（记索引）**后**跑 ——
 *   记录时**路径就在手里，却被丢掉了**。
 *   ⇒ 这一条与 D51/D52 是同一族病：**信息有了、没接到一起**。
 *
 * ★ 落地：记索引时**把胶囊的约定路径算出来一并存进去**（`capRel`），
 *   渲染时直接给出可复制粘贴的**项目相对路径**。
 *   ★ 算路径而**不去读那个文件**：索引要能"离线"渲染（它会被推行很多次），
 *     每次都读盘既慢又可能因为文件被移走而抛。
 */
function capsulePathFor(info, atMs) {
  try {
    // ★★★★★ 2026-10-13（D164 / D165）：目录**必须与真实落盘走同一个取法**。
    //
    //   ★ 真机缺陷（只有**逐字核对目录**才会发现，比"没有指针"更糟）：
    //     这里原来写 `info.archiveRel ?? "_ledger-archive"`，而 `persistCapsule` 真落盘到
    //     `logDirOf(info)` = **`_ledger-log`**。两者**本来就是不同的目录**
    //     （`.dsh-ledger.json` 里 `archiveDir` 与 `logDir` 是两个键）。
    //   ★ 实测取证：本项目 60+ 份胶囊**全在 `_ledger-log/2026-10/week2/capsules`**；
    //     而 `_ledger-archive/…/capsules` **一个都没有、目录根本不存在**。
    //   ★ 为什么这条尤其危险：兜底**恰好只在 `persistRel` 拿不到时**生效
    //     （写盘失败 / 没启用日志 / 在容器根）—— 那些情况下本来就取不到真路径，
    //     而这里**又指向一个不存在的地方**。模型照抄那个路径去读 ⇒ **什么都读不到**，
    //     而台账上写着"逐字原件在这" ⇒ 直接伤 **准确性** 与 **可回溯** 两条底线。
    //   ★★★★★ D165 补正：上一版（D164）只把 `archiveRel` 换成 `logDirOf`，
    //     **值对了、结构没变** —— 目录名仍是**字面量 `"capsules"`**，与真落盘用的
    //     常量 `CAPSULE_DIR_NAME` 各写一遍。⇒ 常量一改名，落盘与指针**当场分叉**，
    //     又回到 D164 那个缺陷（只是这次要靠改常量才触发）。
    //   ⇒ 现在整串交给**唯一出口** `capsuleDirRel()`；这里不再自己拼任何一段。
    //   ★ 判别力：改回 `info.archiveRel` ⇒ 情形 66④ 当场红；
    //     把 `capsuleDirRel` 里的常量换成字面量 ⇒ 情形 66⑥ 当场红。
    return capsuleDirRel(info, new Date(atMs));
  } catch {
    return undefined;
  }
}

/**
 * 把索引渲染成**注入用的几行**（推行给模型看）。
 * ★ 唯一的硬约束：它要**小**（本机 22 次压缩 ⇒ 每行约 60 字符 ⇒ 约 1.3K 字符）。
 */
function renderShadowedIndex(state, sid) {
  // ★★★ 2026-10-13（D160）：**内存优先、落盘兜底** —— 原来只读内存，
  //   而重启后内存是空的 ⇒ 压缩后重注里**一句路标都没有**（真机实测：D159 §三）。
  //   ★ 走 `shadowedIndexOf`（唯一出口）而不是这里直接读两个来源：
  //     取法只有一处，将来改口径不会漏（D51/D52 都是"写了新判定却漏了旧调用点"）。
  const list = shadowedIndexOf(state, sid);
  if (!Array.isArray(list) || list.length === 0) return "";
  const hm = (ms) => {
    try {
      return new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 16);
    } catch {
      return "?";
    }
  };
  const rows = list.map((x) => {
    // ★★★ 阶段 1 第 2 件：把「逐字原件在哪」一起给出来（原来只给 seq）。
    //   两个去处**并列**，让读者自己挑省事的那个：
    //     · `ledger_recall` —— 从会话日志读，**要自己过滤**；
    //     · 胶囊文件        —— 插件压前存好的**成品**（原话/报错/器物索引已分好类）。
    const viaCapsule =
      typeof x.capRel === "string"
        ? `｜逐字原件：\`${x.capRel}\` 里 ${hm(x.at)} 那份`
        : "";
    return (
      `- seq ${x.start}–${x.end}（${x.nodes} 个节点，${hm(x.at)}，${hfSourceShort(x.source)}）` +
      ` ⇒ 摘要 seq ${x.summarySeq}，约 ${Math.round((x.shadowedTokens ?? 0))} tok 被换下` +
      viaCapsule
    );
  });
  return (
    "\n\n### ★ 被压掉的历史：**可以按需读回原文**（不只是摘要）\n\n" +
    "下面每一段都被压缩换成了摘要，但**逐字原文（含推理过程）仍在会话日志里**。\n" +
    // ★★★★★ 2026-10-13（D157，用户四底线里的"模型主动回查"）：
    //   用户原话：*"绝对绝对绝对要遵守我们的底线，准确性、可回溯性、延续性，
    //   还有模型主动回查，都要有"*。
    //   ★ 原来这里只写"**需要哪一段，就调**"——那是**被动的**（等它觉得自己需要）。
    //     而 D102 实测：`ledger_recall` 在工具表里，但**被调用 0 次**。
    //   ⇒ 按 D46 那条铁律（**恢复必须是"推"给模型的**），这里要把**触发时机**也推给它，
    //     而不只是推"你能这么做"。所以补上**明确的动作 + 明确的判据 + 明确的调用形状**。
    //   ★ 仍然**不加硬闸门**（D102 的三条理由：闸门写错 ⇒ 压缩彻底不发生）。
    //     这里只加强指令 —— 它不改变模型读到的**主内容**，只把"什么时候该回查"说清楚。
    "★ **动作**：`ledger_recall({from, to})` —— 传上面任意一行的 `seq` 区间（含推理过程）。\n" +
    "★★ **什么时候必须回查**（不用等「想起来」）：\n" +
    "  · 你要引用一个**具体细节**（数字 / 路径 / 报错原文 / 某句话是谁说的）而它**不在当前上下文里**；\n" +
    "  · 你要说「**我之前验证过 / 我查过**」——**先说清是在哪一次、哪一段查的**，说不清就先回查；\n" +
    "  · 你发现自己在**猜**（「大概是…」、「应该是…」），而上面有指针 ⇒ **改成去读**。\n" +
    "★ **判据**：**需要某个确切内容时，先看有没有指针，而不是凭记忆复述。**\n" +
    "★ 若你要的是**用户原话 / 报错原文 / 碰过哪些文件**，那一份在**胶囊文件**里已经分好类了，" +
    "  比从日志里捞省事得多（路径见每行末尾的「逐字原件」）。\n\n" +
    rows.join("\n") +
    "\n"
  );
}

/**
 * 读胶囊素材：`{ version, bySession: { sid: {userMessages, errors, artifacts} } }`。
 * ★ 逐条校验，**坏条目丢掉、不整份作废**（照 `readAnchorStore` 的既有做法）——
 *   这个文件可能被人手改坏、也可能被半截写入；一条坏的不该让全部历史失效。
 */
function readCapsuleStore() {
  const empty = { version: 1, bySession: {} };
  const raw = readTextSafe(capsuleStorePath());
  if (raw === undefined) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return empty;
    const by = parsed.bySession;
    if (by === null || typeof by !== "object") return empty;
    const clean = {};
    for (const [sid, v] of Object.entries(by)) {
      if (typeof sid !== "string" || sid === "") continue;
      if (v === null || typeof v !== "object") continue;
      const um = Array.isArray(v.userMessages) ? v.userMessages.filter(
        (x) => x !== null && typeof x === "object" && typeof x.text === "string" && x.text !== ""
      ) : [];
      const er = Array.isArray(v.errors) ? v.errors.filter(
        (x) => x !== null && typeof x === "object" && typeof x.text === "string" && x.text !== ""
      ) : [];
      const ar = v.artifacts !== null && typeof v.artifacts === "object" && !Array.isArray(v.artifacts)
        ? Object.entries(v.artifacts).filter(
            ([p, o]) => typeof p === "string" && p !== "" && o !== null && typeof o === "object"
          )
        : [];
      if (um.length === 0 && er.length === 0 && ar.length === 0) continue;
      clean[sid] = {
        userMessages: um.slice(0, CAPSULE_STORE_MAX),
        errors: er.slice(0, numOf("capsuleErrorMax", CAPSULE_ERROR_MAX)),
        // Map 序列化成对象；读回来仍是对象，装配 Map 由调用方做。
        artifacts: Object.fromEntries(ar),
      };
    }
    return { version: 1, bySession: clean };
  } catch {
    return empty;
  }
}

/** 写胶囊素材（吞错 + 临时文件改名；写不进去只影响"重启后还记得多少"）。 */
function writeCapsuleStore(store) {
  const file = capsuleStorePath();
  try {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/**
 * ★★★ 2026-10-13（D159）：**胶囊素材的并集合并** —— 抽成纯函数（可断言、可反向验证）。
 *
 * ★ 为什么必须是纯函数：它是**这次修复的本体**，而自检要能"摘掉它看变红"。
 *   夹在 `persistCapsuleMemory` 里的话，测它就得走整条写盘链路（真实文件 + 沙箱），
 *   而且**摘掉它**会连带把落盘也一起摘掉 ⇒ 反向验证分不清是哪一个在起作用
 *   （本项目已栽过：D136「函数对 ≠ 接线对」，所以纯函数与接线**要分开断言**）。
 *
 * ★ 语义（三桶都**只增不减** —— 这是"胶囊是只增性质的历史"那条判据的落地）：
 *   ① 用户原话：内存在前（更新）、盘上在后（更旧）—— 沿用 `hydrateCapsuleMemory` 的
 *      "新→旧"数组方向约定；按 `at\u0000text` 去重。
 *   ② 报错原文：同 ①。
 *   ③ 器物索引：按**路径**并集；同一路径冲突时取 `at` 更晚的那次（比不出来就保留盘上那条）。
 *
 * ★ 硬约束：**输出长度 ≥ 盘上那份长度**（对三个桶都成立）。
 *   那正是"盘上那份不许变少"这句话的形式化 —— 断言直接钉它。
 *
 * @param {{userMessages?:Array, errors?:Array, artifacts?:Map|object}} [prev] 盘上那份
 * @param {{userMessages?:Array, errors?:Array, artifacts?:Map|object}} [mem] 内存这份
 * @param {{userMax?:number, errorMax?:number}} [caps]
 * @returns {{userMessages:Array, errors:Array, artifacts:object}}
 */
function mergeCapsuleMatter(prev, mem, caps) {
  const keyOf = (x) => `${x?.at ?? ""}\u0000${x?.text ?? ""}`;
  const norm = (list) =>
    (Array.isArray(list) ? list : []).filter(
      (x) => x !== null && typeof x === "object" && typeof x.text === "string" && x.text !== "",
    );
  // ★ 复用同一段逻辑装配两个桶 —— 两桶的规则**必须**一致，
  //   各写一遍就会分叉（D59 的老坑：两套判据必然分叉）。
  const unionOf = (first, second) => {
    const seen = new Set();
    const out = [];
    for (const x of [...norm(first), ...norm(second)]) {
      const k = keyOf(x);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  };
  const userRaw = unionOf(mem?.userMessages, prev?.userMessages);
  const errRaw = unionOf(mem?.errors, prev?.errors);
  const userMax = Number.isFinite(caps?.userMax) ? caps.userMax : CAPSULE_STORE_MAX;
  const errorMax = Number.isFinite(caps?.errorMax)
    ? caps.errorMax
    : numOf("capsuleErrorMax", CAPSULE_ERROR_MAX);

  // 器物索引：先盘上、再内存（同路径取更晚那次）
  const prevArt = prev?.artifacts instanceof Map ? Object.fromEntries(prev.artifacts) : prev?.artifacts ?? {};
  const memArt = mem?.artifacts instanceof Map ? Object.fromEntries(mem.artifacts) : mem?.artifacts ?? {};
  const mergedArt = { ...prevArt };
  for (const [p, o] of Object.entries(memArt)) {
    if (typeof p !== "string" || p === "" || o === null || typeof o !== "object") continue;
    const old = mergedArt[p];
    if (old === undefined || String(o.at ?? "") >= String(old.at ?? "")) mergedArt[p] = o;
  }
  // ★ 截断放在**并集之后**：上限是"文件多大"，不是"这次收了几条"。
  return {
    userMessages: userRaw.slice(0, userMax),
    errors: errRaw.slice(0, errorMax),
    artifacts: mergedArt,
  };
}

/**
 * 把某场会话的**内存素材**与**盘上那份**并起来写回去（★ **并集**，不是替换）。
 *
 * ★ 只在**压缩前**调用，不在每个事件上调 —— `session/event` 是同步跑在
 *   `Session.append()` 路径上的，每次事件都写盘会拖慢官方落盘（那是我明确要避免的）。
 *   ⇒ 「压缩前 + 内核 dispose 时」两个时点已经足够：胶囊只在压缩那一刻被需要。
 *
 * ★★★ 2026-10-13（D159，真机缺陷）：**这里原来是"替换"，把盘上更全的那份覆盖掉了**。
 *
 *   实测（不是推理）：
 *     · `fada` 被压区间里真用户原话 **13** 条、胶囊文件只收 **2** 条；
 *     · `d0a8` 应 **27** 条、只收 **2** 条；
 *     · 跨 12 场按日志大小普查：**10 场盘上是 0 条**；
 *     · `capsules.json` 47 场会话、用户原话**合计只剩 63 条**（上限 40/场 ⇒ 容量 1880），
 *       而 **39 场恰好剩 1 条** —— 那个"1"就是"**重启以来收到的那一条**"的指纹。
 *
 *   ★ 机制：`createCapsuleMemory` 的 `bySid` 是**进程内 Map**（重启即空）；
 *     重启后第一条用户原话就会触发去抖落盘，此时内存里**只有这一条** ⇒
 *     `store.bySession[sid] = {userMessages:[这1条]}` ⇒ **把盘上原来那 40 条整份替换掉**。
 *   ★★ 这**恰好抵消了 D61 的修复**：D61 让压缩前从盘上补历史（`hydrateCapsuleMemory`），
 *     可盘上那份**已经被这里自己覆盖成 1 条**了 ⇒ 补回来的还是 1 条。
 *     ⇒ 两个修复合起来仍然丢历史，因为**一个在补、一个在漏**。
 *
 *   ★ 为什么原来那套"空快照不许覆盖"（情形 44b）没挡住：
 *     它的判据是**三桶全空**才跳过。而重启后内存里**有 1~2 条** ⇒ **不是全空**
 *     ⇒ 判据放行 ⇒ 照旧覆盖。**它只防住了"零"，没防住"比盘上少"。**
 *
 *   ★ 为什么修法是"合并"而不是"少了就跳过"：
 *     只跳过的话，**新攒的那几条也写不进去**（重启后新收到的原话还是丢）。
 *     ⇒ 正确语义是**并集**：盘上那份 + 内存这份，按 `at + text` 去重。
 *   ★ 去重键与 `hydrateCapsuleMemory` 用的是**同一个**（`at\u0000text`）——
 *     两边判据必须一致，否则同一批素材会被判成"新的"而反复追加（D59 的老坑）。
 *
 * ★ 全程吞错：落盘失败只影响"重启后还记得多少"，绝不许影响别的任何事
 *   （这一条是原样保留的硬约束 —— 它同步跑在官方 append 路径上）。
 */
function persistCapsuleMemory(sid, mem) {
  if (typeof sid !== "string" || sid === "") return;
  if (mem === undefined) return;
  try {
    const store = readCapsuleStore();
    const prev = store.bySession[sid];

    // ★★★ 合并逻辑在**纯函数**里（`mergeCapsuleMatter`）—— 这里只管读/写/记账。
    //   ★ 为什么分开：那个函数是"这次修复的本体"，自检要能**单独摘掉它看红**；
    //     夹在这里的话摘掉它连落盘也一起摘了，反向验证分不清是谁在起作用（D136 的教训）。
    const merged = mergeCapsuleMatter(prev, mem, {
      userMax: CAPSULE_STORE_MAX,
      errorMax: numOf("capsuleErrorMax", CAPSULE_ERROR_MAX),
    });
    const { userMessages, errors, artifacts } = merged;

    // ── 空快照 + 盘上有货 ⇒ 仍然不覆盖（情形 44b 那条保护**保留**）──────
    //   ★ 合并之后"空"只可能是"盘上也是空"⇒ 这条判据现在几乎不会再触发，
    //     但它是**最后一道**：留着不花代价，且万一上面哪天被改错，它还能兜一层。
    const incomingEmpty =
      userMessages.length === 0 && errors.length === 0 && Object.keys(artifacts).length === 0;
    if (incomingEmpty) {
      const prevNonEmpty =
        prev !== undefined &&
        ((prev.userMessages?.length ?? 0) > 0 ||
          (prev.errors?.length ?? 0) > 0 ||
          Object.keys(prev.artifacts ?? {}).length > 0);
      if (prevNonEmpty) {
        // ★ 如实记账：这**不是**静默出口（D151 的病），要能被查出来。
        //   ★ 为什么用模块级计数器而不是 `state`：本函数跑在 `Session.append()` 路径上，
        //     调用点（`createCapsulePersister` / dispose）**手里都没有 state**；
        //     为了一个计数去改它们的签名 = 把一条同步热路径搅进更多依赖。
        //     这个计数只为"可查"，不为驱动任何行为 ⇒ 模块级足够（与 `latestStateForTest` 同一条口径）。
        capsuleSkipStats.skipped += 1;
        return;
      }
    }
    // ★ 真写了才记 —— 记录的是"确实发生过一次并集落盘"，不是"调用过一次"。
    capsuleSkipStats.writes += 1;
    // ★ 并集**真的补到了旧素材**时才记（这是 D159 修复是否起作用的**唯一硬指标**）。
    const prevUserCount = prev?.userMessages?.length ?? 0;
    if ((mem.userMessages?.length ?? 0) < prevUserCount) capsuleSkipStats.mergedOld += 1;
    store.bySession[sid] = { userMessages, errors, artifacts };
    // 有界：只留最近 N 个会话（Map/对象保持插入序，删最旧的）。
    const keys = Object.keys(store.bySession);
    const keepN = numOf("capsuleStoreSessions", CAPSULE_STORE_SESSIONS);
    if (keys.length > keepN) {
      for (const k of keys.slice(0, keys.length - keepN)) delete store.bySession[k];
    }
    writeCapsuleStore(store);
  } catch {
    /* 落盘失败绝不影响压缩本身 */
  }
}

/**
 * 从盘上取回某场会话的素材，并**注入内存**（重启后第一次压缩就能用全历史）。
 *
 * ★ 合并策略：**盘上的在前、内存的在后**（按时间正序要用的顺序存的是"新→旧"，
 *   所以这里把盘上那份当成更旧的历史接在后面）。
 *   ★ 去重按**文本+时间**：同一批事件可能在重启前已落盘、又被重新喂过。
 * △ 只做一次（内存里已有则不重复合并）—— 由调用方用 `hydrated` 标记控制。
 *
 * ★★★ 2026-10-12 修 **D61 窗口期**（台账里挂最久的一条）：
 *   原来这里是 `const live = capsule.get(sid); if (live === undefined) return 0;` ——
 *   **内存里没有记录就直接放弃**，而**盘上那份可能正是最全的历史**。
 *
 *   实测后果（D61 记的就是这个）：**重启后**，若这个 sid 还没收到任何新事件
 *   （`consume` 没被跑过 ⇒ 内存记录不存在），第一次压缩的胶囊
 *   **只用得上"重启以来"的那几条** —— 实测只有 **1 条**。
 *   而盘上明明存着压缩前抓好的完整原话/报错/器物索引。
 *
 *   ⇒ 修：`live === undefined` 时**把盘上那份建出来**（而不是返回 0）。
 *   ★ 为什么以前"看起来没坏"：绝大多数情况下来到这一步时，
 *     `consume` 已经被新事件跑过（内存记录存在）⇒ 走的是下面那条合并路。
 *     只有"重启后**直接**压缩、中间没有新事件"这个窗口才踩到 —— 而它**很短**，
 *     所以是"偶发且难查"的那类缺陷（D61 就是这么来的）。
 */
function hydrateCapsuleMemory(capsule, sid) {
  if (capsule === undefined || typeof sid !== "string" || sid === "") return 0;
  try {
    const saved = readCapsuleStore().bySession[sid];
    if (saved === undefined) return 0;
    let live = capsule.get(sid);
    // ★★★ D61：内存里没有 ⇒ **用盘上那份建一条**（原来这里直接 `return 0`）。
    //   ★ 建的是**空骨架 + 盘上内容**，与 `consume` 建立的形状保持一致
    //     （`userMessages` / `errors` 是数组、`artifacts` 是 Map），
    //     否则下游按 Map 调 `.has()` 会抛。
    if (live === undefined) {
      live = { userMessages: [], errors: [], artifacts: new Map() };
      for (const x of saved.userMessages ?? []) {
        if (live.userMessages.length < numOf("capsuleUserMsgMax", CAPSULE_USER_MSG_MAX)) live.userMessages.push(x);
      }
      for (const x of saved.errors ?? []) {
        if (live.errors.length < numOf("capsuleErrorMax", CAPSULE_ERROR_MAX)) live.errors.push(x);
      }
      for (const [p, o] of Object.entries(saved.artifacts ?? {})) live.artifacts.set(p, o);
      capsule.set(sid, live);
      // ★ 返回值语义：**补进来多少条素材**（供调用方如实报"hydrated N"）。
      return live.userMessages.length + live.errors.length;
    }

    const keyOf = (x) => `${x.at ?? ""}\u0000${x.text}`;
    const have = new Set(live.userMessages.map(keyOf));
    const older = saved.userMessages.filter((x) => !have.has(keyOf(x)));
    if (older.length > 0) {
      // 内存里是"新→旧"；盘上那批更旧 ⇒ 接在尾部，再截到上限。
      live.userMessages = live.userMessages.concat(older).slice(0, numOf("capsuleUserMsgMax", CAPSULE_USER_MSG_MAX));
    }

    const haveErr = new Set(live.errors.map(keyOf));
    const olderErr = saved.errors.filter((x) => !haveErr.has(keyOf(x)));
    if (olderErr.length > 0) {
      live.errors = live.errors.concat(olderErr).slice(0, numOf("capsuleErrorMax", CAPSULE_ERROR_MAX));
    }

    // 器物索引：内存里有该路径就以内存为准（更新），否则把盘上的补进来。
    for (const [p, o] of Object.entries(saved.artifacts ?? {})) {
      if (!live.artifacts.has(p)) live.artifacts.set(p, o);
    }
    return older.length + olderErr.length;
  } catch {
    return 0;
  }
}

/**
 * 查**这一场对话**应当落在哪个项目上（跨重启的那份）。
 *
 * @param {string|undefined} sid 会话编号
 * @returns {string|undefined}
 */
function persistentLockFor(sid) {
  if (typeof sid !== "string" || sid === "") return undefined;
  const rec = readLockStore().bySession[sid];
  if (rec === undefined) return undefined;
  // ★ 记录的目标必须**仍然存在**：目录被删/搬走后锁自动失效
  //   （否则每条工具调用都在一个不存在的根上失败，而用户不知道为什么）。
  try {
    if (!fs.statSync(rec.root).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return rec.root;
}

/**
 * 这一场对话**当前生效**的锁（内存优先，其次落盘）—— **唯一的取锁出口**。
 *
 * ★★★ 为什么必须只有一个出口：本次（2026-10-10）我先写了落盘，却忘了
 *   `resolveProjectRoot` 里**还直接读着内存 Map** ⇒ "重启后仍然锁定"整条失效。
 *   这**正是 D51 那个缺口的同一类错误**（写了个新判定，却漏了一处旧调用点）。
 *   ⇒ 所以：凡是要问"这场对话锁在哪"，都得经过这里，**不许再直接摸 Map 或落盘函数**。
 *
 * ★ 存在性校验也放在这里（不只是落盘那份）：内存那份同样可能指向一个已被删的目录
 *   （用户锁完又把目录删了）。两处各校验一次必然分叉 ⇒ 合到这里做一次。
 *
 * @param {string|undefined} sid 会话编号
 * @returns {string|undefined} 绝对路径；没有锁 / 目标已不存在 ⇒ undefined
 */
function activeLockFor(sid) {
  if (typeof sid !== "string" || sid === "") return undefined;
  const candidate = sessionProjectLock.get(sid) ?? persistentLockFor(sid);
  if (candidate === undefined) return undefined;
  // ★ 目标必须**仍然存在**：目录被删/搬走后锁自动失效，
  //   否则每条工具调用都会在一个不存在的根上失败，而用户不知道为什么。
  try {
    if (!fs.statSync(candidate).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return candidate;
}

/** 取某场会话锁定的项目根（内存覆盖层优先，其次跨重启的持久层）。 */
function lockedRootOf(agent) {
  return activeLockFor(agent?.session?.header?.id);
}

/**
 * 锁定 / 解锁 / 查询（`ledger_lock` 与 `/ledger lock` 共用这一处，避免两处口径分叉）。
 *
 * ★ 现在会**同时**写内存（立刻生效）与落盘（跨重启记得住）。落盘失败**不挡锁定**，
 *   但会把原因如实带回 —— 否则用户会以为"记住了"，而下次重启又没了。
 */
function setProjectLock(agent, root) {
  const h = agent?.session?.header;
  const sid = h?.id;
  const cwd = h?.cwd;
  if (typeof sid !== "string" || sid === "") {
    return { ok: false, reason: "拿不到会话编号，锁不了。" };
  }
  if (root === undefined || root === null) {
    const hadMem = sessionProjectLock.delete(sid);
    // ★ 解除时**连持久记录一起删**（否则"我明明解除了，重启又回来了"）。
    const store = readLockStore();
    const hadDisk = store.bySession[sid]?.root;
    if (hadDisk !== undefined) {
      delete store.bySession[sid];
      writeLockStore(store);
    }
    return {
      ok: true,
      locked: false,
      wasLocked: hadMem || hadDisk !== undefined,
      wasLockedRoot: hadDisk ?? null,
    };
  }
  const abs = path.resolve(String(root));
  let isDir = false;
  try {
    isDir = fs.statSync(abs).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      ok: false,
      reason:
        `\`${abs}\` 不是一个存在的目录，锁不了。` +
        "★ 锁的目标**必须已经存在** —— 本插件不替你创建它（也不该由它来决定项目在哪）。",
    };
  }
  sessionProjectLock.set(sid, abs);
  // ── 落盘：按 **sid** 记（每场对话各记各的；理由见 `sessionProjectLock` 上面的注释）──
  const store = readLockStore();
  store.bySession[sid] = {
    root: abs,
    cwd: typeof cwd === "string" ? path.resolve(cwd) : undefined,
    at: new Date().toISOString(),
  };
  const disk = writeLockStore(store);
  return {
    ok: true,
    locked: true,
    root: abs,
    persisted: disk.ok === true,
    storePath: disk.path,
    persistReason: disk.reason,
  };
}


/** 指针清单文件名（项目根，相对路径）。 */
const MANIFEST_REL = ".dsh-ledger.json";

/** 注入消息的 source.kind。自定义 kind ⇒ 官方 pre-step 的清理逻辑认不出它、动不了它。 */
const INJECT_KIND = "project-ledger-notes";

// ══════════════════════════════════════════════════════════════════════════════
// ★★★ 两个模式（2026-10-10，用户拍板）
//
// 用户原话：*"我们把它定义为这个插件的两个模式。因为其实两个模式各有各的优劣性。
//   正常向前推进的任务就执行现在的这个模式，如果需要反复追究的话，就执行第二种模式。"*
//
// 机制上的真实差别（**只有一个**，其余全同）：
//
//   · `steady`（正常推进）：压缩时**按位置**切 —— 保留"当前水位 − 每轮要压掉的点"
//     （棘轮：见 `runIncrementalCompact` 里那段长注释），更早的一刀切掉。
//     **不做内容判断**，省一次模型输出。
//     代价：位置 ≠ 重要性，最旧那一段里可能正好有这个任务**最早的约束**。
//
//   · `surgical`（反复追究）：压缩**前**先让 AI 对这 20 点做一次**分流**（三个桶）：
//       留（keep）  → 下一轮一定要知道的，压缩后**逐字重注入**
//       落（stash） → 以后可能要查的，写进项目的 `_stash/`，**不占上下文**
//       丢（drop）  → 已被取代的，只进日志
//     代价：每次多一段模型输出；分错了会把垃圾留在上下文里。
//
// ★ 为什么这是"在 A 之上加一层"而不是另起一套：**内核的摘要提示词写死在
//   `dsh-compaction-basic` 里**（实测它的可配置项只有 thresholdRatio / retainRatio /
//   retainTokens / summarization* / maxTokens / modelPolicies —— **没有摘要模板**）。
//   所以"压缩时保什么内容"我们改不了；能做的是**压缩后把该留的注回去**
//   （胶囊已经在走这条路）。⇒ 两模式共用同一套压缩，差别只在压缩前后多做什么。
//
// ★★★ 2026-10-12（D129，用户拍板）：**两种模式合并**。
//
//   用户原话：*"还有就是这一次的改造，改造完之后还有必要保留两种模式吗？"*
//   ⇒ 他选的是"**合并成一种：分流成为标准步骤**"。
//
//   ★ 为什么合并（这是规格⑪倒逼出来的，不是随手简化）：
//     他要求"**摘要/注入里必须包含分流之后不能删的东西**" ——
//     而**那件东西只有分流能给**（`keep` 桶 = "下一轮不知道就会做错"的逐字清单）。
//     ⇒ 留着 `steady`（不分流）＝ 允许模型走一条**拿不出那件东西**的路
//       ⇒ 与规格⑪直接冲突。
//
//   ★ 代价（如实记）：每次压缩前多一段模型输出（分流判断）。用户已知情并接受。
//   ⚠️ 常量与清单里的 `mode` 字段**保留**（向后兼容：老项目清单里可能写着 steady），
//     但**两条路现在行为一致**（都要求分流）⇒ 见 `modeOf`。
const MODE_STEADY = "steady";
const MODE_SURGICAL = "surgical";
const MODES = [MODE_STEADY, MODE_SURGICAL];

/** 分流单的桶名（用户说的"划分"）。 */
const TRIAGE_KEEP = "keep";
const TRIAGE_STASH = "stash";
const TRIAGE_DROP = "drop";

/** `_stash/` 只存桶的目录名（在项目根下）。 */
const STASH_DIR = "_stash";


/** 活跃台账行数阈值默认值。 */
const DEFAULT_MAX_ACTIVE_LINES = 300;

/**
 * 为什么从 150 提到 300（2026-10-08 实测后改）
 *
 * 量了本项目自己的台账（130 行 / 4,163 字符 / 中文 1,591 个）：
 *
 *     150 行 → 约 2,684 token → 占 1M 窗口 0.27%
 *     300 行 → 约 5,367 token → 占 1M 窗口 0.54%
 *     500 行 → 约 8,946 token → 占 1M 窗口 0.89%
 *     1000 行 → 约 17,891 token → 占 1M 窗口 1.79%
 *
 * ⇒ **token 从来不是真约束**（翻倍也只是 0.27% → 0.54%）。150 行的真实代价是
 *   **归档太频繁**：一次归档要 AI 决策挑条目 + 一次写入，而收益只是省下 0.27% 的窗口。
 *   300 行把它减半，仍然不到窗口的 0.6%。
 *
 * ★ 真正的上限不是 token 而是**注意力**：台账越长，AI 越抓不住重点。
 *   所以别再无脑往上调 —— 超过 500 行开始，"台灯越厚越没人看"这个成本才占主导。
 *   这是可配置的（清单里的 `maxActiveLines`），项目可按自己情况调。
 */

/** 单次读取返回的最大字符数（防止把巨型归档整个灌进上下文）。 */
const MAX_READ_CHARS = 60000;

/** 归档时单条最多列多少目录项。 */
const MAX_ARCHIVE_LIST = 200;

/**
 * 会话编号（用户提议）：每个会话给一个**短编号**，写台账时标在条目前面。
 *
 * ★ 用户原话：「每个对话在写台账的时候，在每个条目前面加一个自己的编号。」
 *
 * ★ 它解决什么：**归属**。多条会话先后往同一份台账里写时，一眼能看出
 *   "这条是哪个会话写的" —— 复盘时能顺着编号找回那个会话。
 *   编号取 `session.header.id` 的**前 4 位**（会话 id 形如
 *   `session-31798360-22b7-…`，前缀都一样，所以取中段才有区分度）。
 *
 * ★★ 它**不解决**什么（我实测验证过，别指望它防丢）：
 *   编号只改变**写进去的内容**，不改变"整份覆盖"这个**动作**。
 *   所以 B 若基于自己开头读到的旧副本整份 replace，A 的条目**照样消失**，
 *   哪怕每行都带编号。防丢必须靠**版本锁**（见 `ledger_write` 的 `ifRevision`）。
 *   两者互补，不是替代。
 */
function tagOfId(id) {
  if (typeof id !== "string" || id === "") return undefined;
  // `session-<uuid>` ⇒ 去掉 `session-` 前缀，取第一段 hex 的前 4 位。
  const core = id.replace(/^session-/, "");
  const seg = core.split("-")[0] ?? core;
  const tag = seg.slice(0, 4).toLowerCase();
  return /^[0-9a-z]{4}$/.test(tag) ? tag : undefined;
}

function sessionTag(agent) {
  return tagOfId(agent?.session?.header?.id);
}

/** 渲染"这条是谁写的"前缀；没有编号可用时给空串（不硬造）。 */
function tagPrefix(tag) {
  return tag === undefined ? "" : `[${tag}] `;
}

/**
 * 取出文本里的**条目行**（`- xxx` / `* xxx` / `1. xxx`），忽略标题与空行。
 *
 * ★ 为什么只认条目行：多会话保护要判断"哪些内容会被这次覆盖弄丢"。
 *   标题（`## 已完成`）在 AI 重排结构时会正常地"消失"，把它当成丢失内容会
 *   制造大量假告警；而**条目**才是真正的进展，也正是用户说的"条目"。
 */
function entryLines(text) {
  if (typeof text !== "string") return [];
  return text.split("\n").filter((l) => /^\s*(?:[-*+]|\d+\.)\s+\S/.test(l));
}

/** 自动保留区的标题。它出现在活跃台账里，是可见、可归档的普通内容。 */
const PRESERVE_HEADING = "## 其他会话的进展（自动保留，未合并）";

// ═══════════════════════════════════════════════════════════════════════════
// 变更登记：让"什么时候改的"**不必查日志**就能看见（用户需求 ①）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 用户原话：*"他现在这里有改动的话，必须查日志才能看得出来，我觉得可以考虑多登记一点，
//   比如说某个执行是什么时间点进行的，然后什么时间点进行追加的。"*
//
// ★ 问题说得很准：台账里**只有内容、没有时间**。想知道"这条是什么时候写的"必须去翻
//   `L0-ledger-changes.md` —— 那是**查日志 = 考古**，而用户要的是"**看得见**"。
//
// ★ 做法：让插件在活跃台账末尾维护一张**变更登记表**（机器自动写，AI 不用管）：
//     - 每次写台账 / 归档追加一行：时间 + 操作 + 会话编号 + 行数变化 + 修订号；
//     - **有界**（只留最近 N 条，默认 12）—— 否则台账会被它自己撑爆，
//       而那正是"日志"该承担的事（完整历史始终在 `L0-ledger-changes.md`）。
//
// ★ 为什么不做成"给每条条目加时间戳"：条目是 AI 写的、会被整份 replace，
//   插件无法可靠地为每一行认定"它是什么时候出现的"（AI 可以把 5 条合并成 1 条）。
//   而"**这份文件被改过几次、每次是什么时候**"是插件**确知**的事实 —— 如实登记它。

/** 变更登记区的标题。插件每次写入都会**重建**它（先剥掉旧的，再追加新的）。 */
const CHANGE_REGISTER_HEADING = "## 变更登记（插件自动维护）";

/** 登记表最多保留多少行。有界是硬要求：台账不能被它自己撑爆。 */
const CHANGE_REGISTER_MAX = 12;

/** 登记行前缀（用于从既有文本里识别出这一区）。 */
const CHANGE_REGISTER_LINE_RE = /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \((?:write|append|replace|archive)[^)]*\)/;

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★ 2026-10-12（D133）**记忆区块**的第一层：分块 + 内容哈希
// ═══════════════════════════════════════════════════════════════════════════
//
// ★★★ 先与上面那段既有的结论划清界线（**不能装看不见**）：
//   第 1534–1536 行写着——*"插件**无法可靠地为每一行认定『它是什么时候出现的』**
//   （AI 可以把 5 条合并成 1 条）"* ⇒ ★ **那条是对的，本函数不去碰它**：
//   我们**不给条目记来源、不记时间**，只记**"这段内容是什么"**（纯内容哈希）。
//   ⇒ 区别很关键：**"它什么时候来的"需要插件观测写入过程（做不到）；
//     "它现在是什么"只需读当前文件（做得到，且永远为真）。**
//
// ★ 为什么分块用 **markdown 标题**（而不做语义 schema）：
//   台账结构是**模型自己设计的**（既有铁律）⇒ 插件**不许**规定"必须有哪些小节"。
//   而 `#`/`##`/`###` 是**任何结构都有的通用骨头** ⇒ 拿它当块边界，
//   **既能定位、又不侵入用户的结构选择**。
//
// ★ 用途（D133 §十二 / D134 步 5）：压缩后注全量、两次压缩之间**只注变了的块**。
//   ★ 安全性来自一条不变式：**上下文只在压缩时变少** ⇒
//   "前面注过块 X" 蕴含 "块 X 现在还在上下文里" ⇒ 重复注它是**纯冗余**。

/** 一个块的标题行（含 `#` 前缀），或 `undefined`（前言块没有标题）。 */
const BLOCK_HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * 把一段文本按 markdown 标题切成**块**，每块带内容哈希。
 *
 * ★ 这是**纯函数**：同输入必同输出，不读盘、不碰 state ⇒ 可断言、可反向验证。
 * ★ 边界处理（每条都有理由）：
 *   · **没有标题** ⇒ 整段是**一个**块（`heading: undefined`）—— 绝不能返回空；
 *   · 标题**之前**的内容（前言）⇒ 自成一个块（否则那段会凭空消失）；
 *   · 代码块里的 `#`（如 ``` 内）⇒ ★ **必须跳过**，否则会把代码里的注释当标题切碎。
 *
 * @param {string} text 全文
 * @returns {Array<{heading: string|undefined, hash: string, lines: number, text: string}>}
 */
function splitBlocks(text) {
  if (typeof text !== "string" || text === "") return [];
  const lines = text.split("\n");
  const blocks = [];
  let cur = { heading: undefined, buf: [] };
  let inFence = false; // 代码围栏内不认标题（见上）
  const flush = () => {
    if (cur.buf.length === 0) return;
    // ★★★ 必须**规范化尾空白**再算哈希（自检 55⑩ 当场抓到）：
    //   同一个块出现在**文件末尾**时，`split` 会多带一个空行 ⇒ 若原样哈希，
    //   "内容一字未改、只是块换了位置"会被判成"变了" ⇒ **每次全注**（正是要治的病）。
    //   ★ 尾部空行**不是内容**，是文件排版 ⇒ 归一化它不会丢任何信息。
    const body = cur.buf.join("\n").replace(/\s+$/, "");
    // ★ 空白块不产出（末尾空行、连续空行都不该变成"块"）
    if (body.trim() === "") { cur = { heading: undefined, buf: [] }; return; }
    blocks.push({
      heading: cur.heading,
      hash: fnv1a(body),
      lines: body.split("\n").length,
      text: body,
    });
    cur = { heading: undefined, buf: [] };
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : line.match(BLOCK_HEADING_RE);
    if (m !== null) {
      flush(); // 收掉上一块
      cur = { heading: line, buf: [line] };
    } else {
      cur.buf.push(line);
    }
  }
  flush();
  return blocks;
}

/**
 * FNV-1a 32 位哈希（零依赖）。
 *
 * ★ 为什么不用 `crypto`：本插件**零依赖**（既有铁律），
 *   而这里要的只是"内容变了没"的**廉价判据**，不是密码学强度。
 * ★ 与 `fingerprintOf` 里的实现同源 —— 但**不能共用**：
 *   那个是对**整份**文本，这个是**逐块**；共用会把两处语义绑死（本文件反复栽过这种）。
 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * ★★★★ 2026-10-12（D135）**区块权重 — 通用标准 v2**
 *
 * ★ 用户要求：*"要给一个通用标准来让**不同模型**来计算权重"*。
 * ⇒ 所以：**不问量表分（1~10）** —— 不同模型对"7 分"的理解必然不同（手松手紧、训练分布）
 *   ⇒ 同一台账会得到不同的注入结果 ⇒ **不可复现**。
 * ⇒ 改成：**模型只答是/否，分数由本函数按固定公式算** ⇒ **尺度握在插件手里**。
 *
 * ★★★ 实测留档（D135 §五，**v1 是怎么失败的**）：
 *   我第一版用**关键词**判"约束块"（`不许|禁止|必须|绝不能|铁律|红线`）——
 *   套到真实台账（25 块）⇒ **必注 62.5% 字符，只省 29.5%**。
 *   ★ 根因：这台机器的台账**天然到处是 `★`/`绝不`/`必须`**（那是**写作风格**），
 *     关键词判据把**风格**当成了**重要性** ⇒ 又一次"尺子错：测的是文风不是块的性质"。
 *   ⇒ 所以 Q1 必须要求模型做**因果判断**（"不遵守**就会做错**吗"），而不是**认关键词**。
 *
 * ★★ 本函数只做**第 0 步（机械可算、模型改不了的那部分）** ——
 *   一致性**从插件来**，不从模型来：
 *     · 标题是「变更登记」⇒ **强制 0**（实测：它每轮必变，是元数据不是项目知识）
 *     · 跨 ≥3 次写入**从未被改**       ⇒ **+20**（实测：变动频率与重要性**负相关**，见 D135 §七）
 *     · 是**最近一次写入新增**的       ⇒ **+15**（"当前在做的事"）
 *   ★ 用户/模型侧的 Q1~Q4（+35/+25/+20/+10）另算，见 `weightFromAnswers`。
 *
 * @param {object} block `splitBlocks` 出来的块
 * @param {object} hist  该块的**变更史**：`{ writes, changed, newest }`
 *                        —— 由调用方从"历次台账快照"统计（现在还没有，缺省按"未知"处理）
 * @returns {{score:number, why:string[]}} `why` 用于**如实标注**（便于排查，不猜）
 */
function mechanicalWeight(block, hist, nowMs) {
  const h = block?.heading ?? "";
  const why = [];
  // ① 元数据：一票归零（它不是项目知识）
  //   ★★ 必须带 `zeroed: true` —— 否则模型答一个 q1 就能把 +35 加回来，
  //      "强制 0"当场失效（这是 D136 的断言 57② 在守的东西）。
  if (/^##\s*变更登记/.test(h)) {
    return { score: 0, why: ["元数据（插件自维护，每轮必变）⇒ 归零"], zeroed: true };
  }
  // ② ★★★ 原则类 ⇒ **毫无疑问高分**（用户 2026-10-12 原话：
  //    *"正在处理的东西与所有底线与原则毫无疑问是高分"*）。
  //    理由：它们**结构性**地不会过期（不随水位/进度失效）⇒ 判据不必问模型。
  //    ⚠️ 这里只是**认标题里的自我声明**（"总纲/原则/底线/铁律/硬规矩"），
  //       不是 v1 那次的"认强调词"（那次认的是 ★/绝不/必须 ⇒ 测成了文风）。
  if (/\u539f\u5219|\u5e95\u7ebf|\u94c1\u5f8b|\u786c\u89c4\u77e9|\u603b\u7eb2/.test(h)) {
    return {
      score: Math.max(numOf("weightMustInject", WEIGHT_MUST_INJECT), numOf("weightPrincipleScore", WEIGHT_PRINCIPLE_SCORE)),
      why: [`标题是原则/底线类 ⇒ 强制 ≥${WEIGHT_MUST_INJECT}（用户：毫无疑问高分）`],
      forced: "principle",
    };
  }
  // ③ ★★★ 已处理 / 已过期 ⇒ **低分**（用户：*"已处理的、已过期的低分"*）
  //    ★ 判据同样是**它自己的标签**（"已完成 / 别再重做 / 已处理 / 已过期"）——
  //      不是猜内容。★ 实测必要性：两个模型都给「✅ 已完成（别再重做）」打了 65/10，
  //      而它按定义**不该占上下文**（正文在 DECISIONS，随时能读）。
  //    ★★★ 2026-10-12（D136，改成**相对秩融合**后）：这里不再"扣分"，
  //      而是交给 `fuseWeight` **封顶**（`WEIGHT_DONE_CAP`）——
  //      因为融合分是**归一化相对分**，负分扣不干净（封顶才守得住）。
  const done = /\u5df2\u5b8c\u6210|\u5df2\u5904\u7406|\u5df2\u8fc7\u671f|\u4e0d\u8981\u91cd\u505a|\u522b\u518d\u91cd\u505a/.test(h);
  let s = 0;
  // ④ ★★★★ **时间分不在这里给**（用户逐字更正：*"注意时间不是绝对时间，而是**相对时间顺序**"*；
  //    后又补：*"区块的定位主要是**相对位置**"*）。
  //    ⇒ 时间只是 `fuseWeight` 里的**一维秩**，与"模型判分/稳定度/星值"并行融合。
  // ⑤ ★★★★ 原「跨 ≥3 次写入从未变 ⇒ +20」**已删除**（实测它让 23/25 块一起 +20 ⇒ 无区分力）。
  //    ⇒ "久未变"改为 `fuseWeight` 里的一维**相对秩**：与**别人多久未变**比较才有意义。
  // ⑥ 最近一次写入新增 ⇒ 当前在做的事（★ 这是**结构事实**，不是相对量 ⇒ 留在这里）
  if (hist !== undefined && hist.newest === true) {
    s += 15;
    why.push("最近一次写入新增 ⇒ +15（当前）");
  }
  return {
    score: s,
    why,
    ...(done ? { done: true } : {}),
    // ★★★ 把时间戳带出去 —— 融合那一维要靠它排相对序。
    //   ⚠️ 我第一版忘了这一步 ⇒ 时间列恒 0（"权重可变"当场变成空话），
    //      是 `_acc047-variable.mjs` 的实测把它抓出来的。
    ...(Number.isFinite(hist?.lastChangedAt) ? { lastChangedAt: hist.lastChangedAt } : {}),
    ...(Number.isFinite(hist?.firstSeenAt) ? { firstSeenAt: hist.firstSeenAt } : {}),
    ...(Number.isFinite(hist?.writes) ? { writes: hist.writes } : {}),
    ...(hist?.changed === true ? { everChanged: true } : {}),
  };
}

/**
 * ①~④ 四个**是/否**答案 ⇒ 分数（D135 §六 的表）。
 *
 * ★★★ 三个设计要点（都为了"不同模型可对齐"）：
 *   ① **只收布尔**：`true / false / undefined`；★ `undefined`（模型没答）**不加分**，
 *      并在 `unanswered` 里如实回报 ⇒ 调用方据此**退化成"全注"**（底线规则③）。
 *   ② **分值是常量表**，不由模型给 ⇒ 换模型不变量。
 *   ③ `why` 逐项记下哪条得分 ⇒ 出问题时**能查**，不用猜。
 *
 * @param {{q1?:boolean,q2?:boolean,q3?:boolean,q4?:boolean}} a
 */
function weightFromAnswers(a) {
  const Q = [
    ["q1", 35, "含「不遵守就会做错」的约束"],
    ["q2", 25, "描述现在/下一步要做的"],
    ["q3", 20, "别处推不出来"],
    ["q4", 10, "换个会话仍成立"],
  ];
  let s = 0;
  const why = [];
  const unanswered = [];
  for (const [k, v, label] of Q) {
    if (a?.[k] === true) { s += v; why.push(`${label} ⇒ +${v}`); }
    else if (a?.[k] === undefined) unanswered.push(k);
  }
  return { score: s, why, unanswered };
}

/** 原则/底线类的**保底分**（用户：*"所有底线与原则毫无疑问是高分"*）。 */
const WEIGHT_PRINCIPLE_SCORE = 95;

/** 标题声明"已完成/已处理/已过期"的**封顶分**（用户：*"已处理的、已过期的低分"*）。
 *  ★ 用**封顶**而不是扣分：融合分是**归一化相对分**，负分扣不干净 ⇒ 封顶才守得住
 *    "已完成的不该占上下文"（实测：两个模型都给「✅ 已完成（别再重做）」打了高分）。 */
const WEIGHT_DONE_CAP = 20;

/**
 * ★★★★★ 2026-10-12（D136）**相对维度秩融合** —— 本设计的内核。
 *
 * ★ 用户逐字（本轮最重要的一句）：*"区块的定位主要是**相对位置**，所以除了时间，
 *   很多方面也可以借助相对概念"*。
 *
 * ★★★ 为什么必须从"绝对分求和"改成"相对秩融合"（**不是风格问题，是实测问题**）：
 *   · 我第一版是 `机械分 + 模型分` 的**绝对分求和** ⇒ 实测必注 **69.5%**，
 *     因为「跨 ≥3 次写入从未变 ⇒ +20」几乎**每块都成立**（一台机器上大多数块本来就很少变）
 *     ⇒ 全体 +20 ⇒ **什么也没挑出来**。绝对判据在"大家都满足"时**毫无区分力**。
 *   · 相对判据天然免疫这一点：**不管大家多接近，它总能排出一个序**。
 *
 * ★★★ 研究依据（`docs/AI记忆与上下文压缩调研/`，本轮重读后的三条）：
 *   ① **位置偏置是真实且巨大的**：D 卷实测"关键文档从第 1 位挪到第 10 位，EM 75.7→54.1
 *      （**−21.6 点**）"，而 LongLLMLingua *"买到的**主要是位置**，不是长度"*；
 *      消融 `w/ Document Reordering` 一行是**五个 76.2** ⇒ **纯重排就能抹平位置方差**。
 *   ② **多信号秩融合是成熟做法**：A 卷 —— 四信号（Semantic/BM25/Entity/**Temporal**）
 *      并行打分再 **rank fusion**、**RRF**；A 卷另列 reranker 可用
 *      `RRF / MMR / node-distance / episode-mentions`。
 *   ③ ★ **不切文件，只切排序与注入资格**（C 卷逐字："Project scope changes ranking and
 *      automatic injection **without partitioning the files**"）—— 正是本设计要的形态。
 *
 * ★★ 用法：每个维度先各自折成**相对位置**（`1 - 秩/(n-1)` ∈ [0,1]，0 秩 = 1.0），
 *   再按维度权重求**加权平均** ⇒ 乘 100 得 0~100 分。
 *
 * ★★★ 为什么**不用 RRF 的 `w/(K+秩)`**（我第一版用了，**实测当场否掉**）：
 *   K=60 是给**长列表**融合设计的；我们只有 25 块 ⇒ 秩 0~24 代入后最大最小
 *   只差 **1.4 倍**（`1/60` vs `1/84`）⇒ 全体挤在 95~100 分 ⇒
 *   过 50 分阈值的多达 **22/25（82.2%）**，比改之前**更差**。
 *   ⇒ 百分位归一没有这个病：秩 0 = 1.0、秩 24 = 0.0，**差异拉满**，
 *     而且"50 分"天然等价于"跨维度平均位置在**中位以上**"，与用户那句
 *     "50 分注入"的直觉一致。
 */
const RRF_K = 60;

/**
 * 把一组带原始值的候选折成**秩**（0 = 最好，越小越好），**并列取平均名次**。
 *
 * ★★★ 为什么必须"取平均"（我第一版用 dense rank，**实测当场否掉**）：
 *   本项目里**并列极多**（24 块共享同一个"最旧"时间戳、18 块同为零星）。
 *   `dense rank` 会让那 24 块**全部**拿到第 2 名 ⇒ 位置 0.958 ⇒ **人人接近满分**
 *   ⇒ 必注 82.2%。★ 那是**统计上的错**：并列者应当**均分**它们占据的名次区间
 *   （标准做法 fractional ranking）。
 *   取平均后同一群并列者得到 12.5 名（位置 ≈ 0.48），**不偏不倚**。
 *
 * @param {Array<{key:string, value:number}>} entries
 * @param {(a:number,b:number)=>number} better 比较器：**负数表示 a 更好**（与 `Array.sort` 同向）
 * @returns {Map<string, number>} key ⇒ 秩（可以是小数 = 并列平均）
 */
function ranksOf(entries, better) {
  const rows = (entries ?? []).filter((e) => e !== undefined && Number.isFinite(e.value));
  rows.sort((a, b) => better(a.value, b.value));
  const out = new Map();
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].value === rows[i].value) j += 1;
    // ★ 并列区间 [i, j] ⇒ 名次取区间中点（等价于平均名次）
    const mid = (i + j) / 2;
    for (let k = i; k <= j; k += 1) if (!out.has(rows[k].key)) out.set(rows[k].key, mid);
    i = j + 1;
  }
  return out;
}

/** 数一块正文里的 `★` 星值（★=1 / ★★=2 / ★★★=3 / ★★★★=4；先长后短避免重复计）。 */
function starValueOf(text) {
  let t = String(text ?? "");
  const take = (re) => { const m = t.match(re); const n = m === null ? 0 : m.length; t = t.replace(re, ""); return n; };
  const four = take(/\u2605{4}/g);
  const three = take(/\u2605{3}/g);
  const two = take(/\u2605{2}/g);
  const one = take(/\u2605/g);
  return one + 2 * two + 3 * three + 4 * four;
}

/**
 * ★★★★ 多**相对**维度 ⇒ 融合分（0~100）。**注入顺序就是按这个分降序**。
 *
 * ★ 维度全是**相对量**（秩），没有一个用绝对阈值 ⇒ 满足用户那句"定位主要是相对位置"。
 * ★ 每维权重不同：模型判分是"内容语义"，给最高；时间/稳定/星值是结构信号，各占一份。
 * ★ 新增维度只需在这里加一行（用户 18:16：*"参数越多，相对位置越精确"*）——
 *   多一维就多一条独立的相对标尺，融合位置更准，且**单维出错不会定生死**（RRF 的抗性）。
 *
 * @param {Array} blocks `splitBlocks` 的输出
 * @param {Map<string,object>} histByHash 块哈希 ⇒ 变更史（含 `writes`/`lastChangedAt`）
 * @param {object|Map} modelAnswers idx 或哈希 ⇒ `{q1..q4}`
 * @param {(b:object)=>boolean} isPrinciple 原则/底线类判据（由调用方给，便于复用 `mechanicalWeight`）
 */
function fuseWeight(blocks, histByHash, modelAnswers, isPrinciple) {
  const list = blocks ?? [];
  const pick = (src, key) => {
    if (src === undefined || src === null) return undefined;
    return typeof src.get === "function" ? src.get(key) : src[key];
  };
  const rows = list.map((b, i) => {
    const h = pick(histByHash, b.hash);
    const ans = pick(modelAnswers, i) ?? pick(modelAnswers, b.hash);
    return {
      b,
      i,
      hist: h,
      model: weightFromAnswers(ans),
      unanswered: (weightFromAnswers(ans).unanswered ?? []).length,
      stars: starValueOf(b.text),
      writes: Number.isFinite(h?.writes) ? h.writes : undefined,
      lastChangedAt: Number.isFinite(h?.lastChangedAt) ? h.lastChangedAt : undefined,
    };
  });

  // ── 各维度折成**相对位置**（1 = 最好，0 = 最差）──
  //   ★ 必须除以 `n-1` 才能铺满 [0,1]；★ 只有 1 块时全给 1（无从比较 ⇒ 不偏不倚）。
  const span = rows.length > 1 ? rows.length - 1 : 1;
  const posOf = (d) => {
    const m = new Map();
    for (const r of rows) {
      const rk = d.ranks.get(r.b.hash);
      m.set(r.b.hash, rk === undefined ? undefined : 1 - rk / span);
    }
    return m;
  };
  const dims = [
    // ① 模型判分：语义"该不该读正文"—— 分最高者位置 1.0
    { name: "模型", weight: 3.0, ranks: ranksOf(rows.map((r) => ({ key: r.b.hash, value: r.model.score })), (a, b) => b - a) },
    // ② 时间：越新位置越大（★ 相对顺序，不是绝对时长）
    { name: "时间", weight: 1.5, ranks: ranksOf(rows.map((r) => ({ key: r.b.hash, value: r.lastChangedAt })), (a, b) => b - a) },
    // ③ 稳定：写入次数越多而从未变 ⇒ 越"长期有效"（★ 这里的"多"是相对量）
    { name: "稳定", weight: 0.8, ranks: ranksOf(rows.map((r) => ({ key: r.b.hash, value: r.hist?.changed === false ? r.writes : undefined })), (a, b) => b - a) },
    // ④ 星值：★ **用户自己的强调**（他说过"星星是权重分的初步体现"）作为**一维**参与
    { name: "星", weight: 1.0, ranks: ranksOf(rows.map((r) => ({ key: r.b.hash, value: r.stars })), (a, b) => b - a) },
  ].map((d) => ({ ...d, pos: posOf(d) }));
  const totalW = dims.reduce((s, d) => s + d.weight, 0);

  // ── 加权平均 ⇒ 0~100 ──
  const fused = rows.map((r) => {
    let sum = 0;
    let w = 0;
    const why = [];
    for (const d of dims) {
      const p = d.pos.get(r.b.hash);
      if (p === undefined) continue;
      sum += d.weight * p;
      w += d.weight;
      why.push(`${d.name}第${(d.ranks.get(r.b.hash) ?? 0) + 1}`);
    }
    // ★ 某维缺值（如没有变更史）⇒ 只对它**已有**的维度求平均，不按 0 计
    //   （否则"历史缺失"会被当成"最差"，那是凭空扣分）。
    const score0 = w > 0 ? Math.round((sum / w) * 100) : 0;
    return { ...r, rrf: score0, why };
  });

  // ── 硬规则覆盖 ──
  return fused.map((x) => {
    const score0 = x.rrf;
    const b = { ...x.b, idx: x.i };
    const mech = mechanicalWeight(b, x.hist, Date.now());
    const why = [...x.why, ...(mech.why ?? [])];
    let score = score0;
    let capped = "fusion";
    const principled = mech.forced === "principle";
    if (mech.zeroed === true) {
      // ① 元数据恒 0 —— 融合分不许把它抬起来
      score = 0; capped = "zero"; why.push("元数据 ⇒ 恒 0（融合分不参与）");
    } else if (principled) {
      // ② 原则/底线 ⇒ 恒 ≥ 保底（用户："毫无疑问是高分"）
      score = Math.max(score, numOf("weightPrincipleScore", WEIGHT_PRINCIPLE_SCORE)); capped = "principle";
      why.push(`原则/底线 ⇒ 保底 ${WEIGHT_PRINCIPLE_SCORE}`);
    } else if (mech.done === true) {
      // ③ 已处理/已过期 ⇒ **封顶低分**（★ 是"封顶"不是"扣分"：
      //    相对分随台账组成浮动，扣分扣不干净 ⇒ 封顶才守得住"已处理的不该占上下文"）
      score = Math.min(score, numOf("weightDoneCap", WEIGHT_DONE_CAP)); capped = "done";
      why.push(`已处理/已完成 ⇒ 封顶 ${WEIGHT_DONE_CAP}`);
    }
    return {
      ...b,
      weight: { score, fused: score0, why, capped, stars: x.stars, unanswered: x.unanswered,
                ...(Number.isFinite(x.lastChangedAt) ? { lastChangedAt: x.lastChangedAt } : {}) },
    };
  });
}

/** 逐块算权重（唯一口径：`fuseWeight` 的别名，注入侧与自检共用）。 */
function weightBlocks(blocks, modelAnswers, histByHash, nowMs) {
  void nowMs; // ★ 融合用的是**相对**序，不需要"现在"这个绝对量（用户已更正）
  return fuseWeight(blocks, histByHash, modelAnswers);
}

/** 必注阈值（用户 2026-10-12 拍板：*"我建议是改成 50 分注入"*）。
 *  ★ 归一化后"50 分"= **接近榜首的一半** ⇒ 它随台账组成自动收放，不必调参。 */
const WEIGHT_MUST_INJECT = 50;




/**
 * 渲染**目录**（"非必要区块的相对位置"—— 用户 18:48 的提法）。
 *
 * ★ 只给**位置与身份**，不给正文：标题（截断）+ 行数 + 内容哈希前缀。
 * ★ 截断到 40 字符的理由（实测）：这台机器的标题常常是半句话，
 *   不截断时目录要 **1,413 字符**，截断后约 **1,225** —— 而目录是**每块都要付**的固定成本。
 * ★ 为什么必须带哈希：模型据此知道"这块我有没有见过"（配合 D133 的差异）。
 */
function renderToc(blocks, opts) {
  const max = Number.isFinite(opts?.headingMaxChars) ? opts.headingMaxChars : 40;
  const rows = (blocks ?? []).map((b) => {
    const raw = (b.heading ?? "（前言）").replace(/^#+\s*/, "").replace(/\s+/g, " ");
    const t = raw.length > max ? `${raw.slice(0, max)}…` : raw;
    return `- ${t} · ${b.lines} 行 · #${b.hash.slice(0, 8)}`;
  });
  if (rows.length === 0) return "";
  return (
    "\n### 台账目录（**只有位置** —— 正文见下面「必注」部分或按需 `ledger_read`）\n\n" +
    rows.join("\n") +
    "\n"
  );
}

/**
 * 比较两批块，给出**变了哪些**。
 *
 * ★ 判据是**内容哈希**，不是位置：块被移动了不算"变了"（内容还在，模型不必重读）。
 * ★ 输出两个集合，调用方据此决定注入什么：
 *   · `changed`：**新出现或内容变了**的块（这些必须注）
 *   · `removed`：上次有、这次没了（要告诉模型"它没了"，否则它会以为还在）
 *
 * @param {Array} prev 上次的块
 * @param {Array} next 这次的块
 */
function diffBlocks(prev, next) {
  const prevHashes = new Set((prev ?? []).map((b) => b.hash));
  const nextHashes = new Set((next ?? []).map((b) => b.hash));
  return {
    // ★ 去重：同一个哈希出现两次（AI 复制了两份）只算一次
    changed: [...new Map((next ?? []).filter((b) => !prevHashes.has(b.hash)).map((b) => [b.hash, b])).values()],
    removed: [...new Map((prev ?? []).filter((b) => !nextHashes.has(b.hash)).map((b) => [b.hash, b])).values()],
  };
}

/**
 * 从一段台账文本里**剥掉**变更登记区，返回 `{ body, entries }`。
 *
 * ★ 必须"先剥再建"而不是"往后追加"：AI 整份 replace 时可能把它删了、写歪了、
 *   或者复制了两份。每次由插件**重建**才能保证它始终是一份、始终最新。
 */
function splitChangeRegister(text) {
  if (typeof text !== "string" || text === "") return { body: "", entries: [] };
  const idx = text.indexOf(CHANGE_REGISTER_HEADING);
  if (idx < 0) return { body: text, entries: [] };
  const body = text.slice(0, idx).replace(/\s+$/, "");
  const tail = text.slice(idx + CHANGE_REGISTER_HEADING.length);
  const entries = tail
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => CHANGE_REGISTER_LINE_RE.test(l));
  return { body, entries };
}

/** 渲染变更登记区（含标题）。`entries` 新的在前。 */
function renderChangeRegister(entries, max) {
  if (entries.length === 0) return "";
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : CHANGE_REGISTER_MAX;
  return (
    `\n\n${CHANGE_REGISTER_HEADING}\n\n` +
    `> 这张表由插件**自动**维护：每次写台账 / 归档追加一行，只留最近 ${cap} 条` +
    "（条数可在设置里调，项目清单里的 `changeRegisterMax` 优先）。\n" +
    `> 完整历史在活动日志的 \`L0-ledger-changes.md\`（用 \`ledger_log({view:"audit"})\` 查）。\n\n` +
    entries.join("\n") +
    "\n"
  );
}

/**
 * 这个项目的变更登记保留条数 —— **项目清单优先**，与 `maxActiveLines` 同一条口径。
 *
 * ★ 与行数上限同源的理由：登记表**算在**活跃台账的行数里。所以"留几行登记"
 *   其实是该项目台账预算的一部分，属于**按项目**的事实，不该由全局设置回头改掉。
 */
function changeRegisterMaxOf(info) {
  const n = Number(info?.manifest?.changeRegisterMax);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return currentSettings().changeRegisterMax;
}

/**
 * 这个项目用哪个压缩模式 —— **项目清单优先**（与 `maxActiveLines` / `changeRegisterMax`
 * 同一条口径，见 D25「一个事实只能有一个判定出口」）。
 *
 * ★ 为什么模式属于**项目**而不是全局：用户说的是*"正常向前推进的**任务**…需要反复追究的"*
 *   —— 同一个仓库里，"把这个特性做完"和"查清这个 bug 为什么只在周二复现"就是两种活。
 *   做成全局开关，就没法"平时推进、查问题时转追究"。
 *
 * ★ 清单里的值**只认登记过的模式名**：写错了就退回默认，并**不静默**——
 *   `ledger_status` 会如实报"清单里的 mode 不认识"。
 *
 * @param {object} info `inspect()` 的结果
 * @returns {"steady"|"surgical"} 生效模式
 */
function modeOf(info) {
  const m = info?.manifest?.mode;
  if (typeof m === "string" && MODES.includes(m)) return m;
  const setting = currentSettings().mode;
  return MODES.includes(setting) ? setting : MODE_STEADY;
}

/**
 * ★★★ 2026-10-12（D129，用户拍板）：**分流现在是无条件的标准步骤**。
 *
 * ★ 为什么不再看 `modeOf`：用户选了"**合并成一种：分流成为标准步骤**"。
 *   理由（规格⑪倒逼）：他要求"摘要/注入里**必须包含分流之后不能删的东西**"，
 *   而那件东西**只有分流能给**（`keep` 桶）。⇒ 留一条"不分流"的路
 *   ＝ 允许模型拿不出那件东西 ⇒ 与规格⑪冲突。
 *
 * ★ 为什么保留 `modeOf` 而不直接删掉：**向后兼容** ——
 *   老项目清单（`.dsh-ledger.json`）里可能写着 `mode:"steady"`，
 *   读它不该报错；`ledger_status` 仍如实显示。只是**两条路的行为现在一致**。
 */
const TRIAGE_ALWAYS = true;

/** 现在是否要求分流（D129：恒真，见 `TRIAGE_ALWAYS`）。 */
function triageRequired() {
  return TRIAGE_ALWAYS;
}

/** 清单里的 mode 是不是写错了（供 `ledger_status` 如实报告，不静默）。 */
function modeManifestSuspect(info) {
  const m = info?.manifest?.mode;
  return m !== undefined && !(typeof m === "string" && MODES.includes(m));
}

/**
 * 一段台账文本**去掉变更登记区之后**的行数。
 *
 * ★ 为什么不能直接用 `countLines`：第二次写入时，磁盘上的旧文件**已经含**上一次
 *   的登记区，而新内容通常不含（AI 整份 replace 时不会抄它）。两边的参照系不同，
 *   相减就会每次都算出恒定的负值（登记区自己那十几行），"这次改了多少行"彻底失真。
 *   ⇒ 比的是**正文对正文**，登记区是插件的附注，不参与这次改动的计量。
 */
function bodyLineCount(text) {
  if (typeof text !== "string" || text === "") return 0;
  return countLines(splitChangeRegister(text).body);
}

/**
 * 往台账文本里**合并**一条新的变更登记，返回新文本。
 *
 * ★★ 为什么还要 `priorText`：登记表是**插件维护的历史**，但每次写入的 `text`
 *   都**不含**它 —— AI 整份 replace 时不会抄这段附注，而 `append` 路径又会
 *   主动把登记区剥掉（不让新内容落在它后面）。若只从 `text` 里取旧条目，
 *   每次都会算出"这是第一条" ⇒ 登记表**永远只有一行**，需求 ① 等于没做。
 *   ⇒ 旧条目必须从**磁盘上那份**（`priorText`）里捞回来。
 *   实测撞到：连写 20 次只剩 1 行（自测 25c 当场打红）。
 *
 * @param {string} text 本次要写的内容（含旧登记区时会先被剥掉）
 * @param {string} line 新增的登记行
 * @param {string} [priorText] 磁盘上那份旧台账，用来把旧登记行接回来
 * @param {number} [max] 保留条数（不传则用 `CHANGE_REGISTER_MAX`）
 */
function withChangeRegister(text, line, priorText, max) {
  const own = splitChangeRegister(text);
  const seen = new Set(own.entries);
  const kept = [...own.entries];
  if (typeof priorText === "string" && priorText !== "") {
    for (const e of splitChangeRegister(priorText).entries) {
      if (!seen.has(e)) {
        seen.add(e);
        kept.push(e);
      }
    }
  }
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : CHANGE_REGISTER_MAX;
  const next = [line, ...kept].slice(0, cap);
  return own.body + renderChangeRegister(next, cap);
}

/**
 * 造一条登记行。
 *
 * ★ 时间用**本地时间到秒**（与日志同一格式 `stampSec`），这样台账里的时间戳
 *   可以直接和日志里的行对上 —— 两处若各用各的格式，回溯时就得先做换算。
 * ★ 带上会话编号与修订号：前者回答"谁改的"，后者回答"改到第几版了"。
 */
function changeRegisterLine(now, rec) {
  const op = rec.mode === "archive" ? "archive" : rec.mode === "append" ? "append" : "replace";
  const who = rec.tag === undefined ? "(无编号)" : rec.tag;
  return (
    `- ${stampSec(now)} (${op}) [${who}] ` +
    (rec.delta === undefined ? "" : `${rec.delta >= 0 ? "+" : ""}${rec.delta} 行 → `) +
    `${rec.lines} 行` +
    (rec.revision === undefined ? "" : ` · revision→${rec.revision}`)
  );
}

/**
 * 算出「这次 replace 会弄丢的条目」= 现在有、新内容里没有的条目行。
 *
 * ★ 用**去掉行首空格与编号前缀后的正文**比对：AI 重写时可能把 `- [a1b2] xxx`
 *   改写成别的缩进/符号，但那还是同一条，不该被当成新条目。
 *   只比正文能大幅减少假阳性。
 */
function lostEntries(currentText, nextText) {
  const norm = (l) =>
    l
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
  // ★ 先剥掉**插件自己维护的变更登记区**再比。
  //   它整片都是 `- ` 开头的行，形状与"条目"完全一样 ⇒ 不剥的话，旧文件里那十几条
  //   登记会统统被算成"这次重写弄丢的条目"，于是每次写入都虚报 preservedEntries，
  //   还把一堆时间戳复制进"其他会话的进展"保留区（2026-10-09 自测当场打红 3 条）。
  //   ⇒ 它是插件写的附注，**不是** AI 写的进展，永远不该进这条比对。
  const have = new Set(entryLines(splitChangeRegister(nextText).body).map(norm));
  const out = [];
  for (const l of entryLines(splitChangeRegister(currentText).body)) {
    const k = norm(l);
    if (k !== "" && !have.has(k)) out.push(l);
  }
  return out;
}

/**
 * 台账"修订号"：每次写入递增，写进清单（`.dsh-ledger.json`）。
 *
 * ★ 为什么需要它（实测的静默丢失）：
 *   两个会话做同一个项目，各自在开头读了一份台账；A 先写、B 后写。
 *   B 用的是**它自己看过的旧副本**整份 replace ⇒ **A 的进展彻底消失，两边都不报错**。
 *   注意这**全程没有并发**，只是两次顺序写。
 *   ⇒ 靠"读前比对"防不住（B 读的时候 A 还没写），必须靠**写入时带上
 *     "我以为的版本号"**，不一致就拒绝。
 */
function manifestRevision(manifest) {
  return Number.isFinite(manifest?.revision) && manifest.revision >= 0
    ? Math.floor(manifest.revision)
    : 0;
}

/** 把清单里的 revision +1 并写回。返回新值。失败时返回 undefined（调用方别据此声称成功）。 */
function bumpRevision(root) {
  try {
    const prev = readManifest(root);
    if (prev === undefined) return undefined;
    const next = { ...prev, revision: manifestRevision(prev) + 1, updatedAt: stamp(new Date()) };
    fs.writeFileSync(path.join(root, MANIFEST_REL), JSON.stringify(next, null, 2) + "\n", "utf8");
    return next.revision;
  } catch {
    return undefined;
  }
}

/**
 * 把「压缩模式」写进**项目清单**（`.dsh-ledger.json`）。
 *
 * ★ 为什么**不**改 `revision`：revision 是**台账内容**的并发保护（见 `bumpRevision`
 *   的注释 —— 它防的是"两个会话各写各的、后者覆盖前者"）。模式是**配置**不是内容，
 *   动它不该让别人的 `ledger_write(ifRevision)` 失败。
 *   混在一起的代价是：用户敲一次 `/ledger mode`，另一个会话的台账写入就被拒了。
 *
 * @returns {{ok:boolean, reason?:string}}
 */
function writeManifestMode(root, info, mode) {
  try {
    if (!MODES.includes(mode)) return { ok: false, reason: `不认识的模式：${String(mode)}` };
    const prev = info?.manifest ?? readManifest(root);
    if (prev === undefined) return { ok: false, reason: "读不到清单" };
    const next = { ...prev, mode, updatedAt: stamp(new Date()) };
    const abs = path.join(root, MANIFEST_REL);
    if (!isUnder(root, abs)) return { ok: false, reason: "清单路径逃出项目根" };
    fs.writeFileSync(abs, JSON.stringify(next, null, 2) + "\n", "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/**
 * 「看起来像台账」的保守候选名。
 * ★ 刻意保守：只认名字里带 ledger / 台账 / status / progress 的。
 *   绝不把 TODO.md / README.md / PROJECT.md 这类通用文件当成台账 ——
 *   误认的后果是"把用户的普通文档当台账覆盖"，比漏认严重得多。
 */
const CANDIDATE_RE =
  /^(ledger|ledger\.[a-z-]+|台账|任务台账|项目台账|项目状态|project[_-]?ledger|project[_-]?status|status|progress|进度)\.(md|markdown|txt)$/i;

/** 台账默认建议的 .gitignore 条目（只在用户/配置要求时用）。 */
const DEFAULT_IGNORE_LINES = [];

/**
 * 回合末四选一的工具名。
 *
 * ★ 为什么是一个**工具**而不是插件自己偷偷弹卡片：
 *   卡片要送给用户，必须拿到 `userQuestions` 服务、并且有一个**活的 root agent**；
 *   而"这一刻该不该弹"只有 AI 知道（用户需求 ②：AI 觉得有必要时也可以给）。
 *   所以插件把"问什么、选完干什么、压缩交给谁"做成一个工具，由 AI 决定调用时机。
 */
const CHECKPOINT_TOOL = "ledger_checkpoint";

/**
 * 上下文水位档位：到线就提醒 AI 做一次**台账 + 日志更新**（用户需求 ⑳）。
 *
 * ★ 用户原话：*"ai 会在上下文水位百分之三十/五十/七十或任何 ai 觉得有必要更新的
 *   时候各进行一次台账、日志更新，上下文水位达到七十的时候尽量停止工作并提醒手动
 *   压缩（官方自动压缩百分之八十就会发生）"*。
 *
 * ★ 为什么是**三档而不是一档**：原来只有 80% 一道线，而它在官方自动压缩线**之上**——
 *   等它响的时候，上下文已经被压掉了，写台账要用的素材正好没了。
 *   30/50/70 的意义是**在丢之前分批落袋**：每一档都把当前进展固化一次，
 *   所以即使 80% 处被自动压缩，损失也只是"最后一段"而不是"整段"。
 *
 * ★ 为什么 70% 就要求停手：官方在 80% 自动压缩（`floor(窗口 × 0.8)`）。
 *   70→80 之间只剩 10%，而"写台账 + 写交接单"本身要读文件、要思考，
 *   很容易在那 10% 里被压掉 —— 那就是**边写边被清**。
 *   所以 70% 这一档的指令是「收尾、停手、让用户手动压缩」。
 */
const PRESSURE_TIERS = [0.3, 0.5, 0.7];

/**
 * 到这一档就要**停手并让用户决定**（而不是"顺手固化"）。
 *
 * ★ 单独抽一个常量而不是在文案里写 `0.7`：这个数同时被三处用到
 *   （AI 的提醒文案、给用户看的卡片提示、`PRESSURE_TIERS` 的最高档），
 *   写死三遍迟早会有一处忘了改 —— 本机已经栽过"两处各写一份常量"的坑。
 */
const PRESSURE_STOP_RATIO = 0.7;

// ═══════════════════════════════════════════════════════════════════════════
// 高保真压缩（★ 需求 ㉑：70% 时跑我们自己的高保真压缩）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★★ 先说清楚**能做什么、不能做什么**（我把内核 `dsh-compaction-basic/lib/index.js`
//   从 app.asar 里解出来读过了，不是猜的）：
//
//   能：
//     ① 在 **70%**（内核的 `thresholdRatio` 默认 **0.8**）**提前触发** `compaction.compactNow`；
//     ② 压缩**完成后**，把一份**逐字**的"高保真胶囊"重新注入 —— 即官方与社区都认的
//        **rehydration**；
//     ③ 在内核 80% 压缩发生时，**确定性副本已经存在**（台账 + 胶囊都在上下文里）。
//
//   不能（诚实地说）：
//     ④ **拦不住**内核 80% 那次压缩 —— 它是 `BasicCompactionEngine._registerAutomaticCompaction`
//        里自己挂的 `agent/pre-step` 处理器，插件无法取消它；
//     ⑤ **替换不了**它的摘要器。`summarize()` 确实是"唯一的子类定制钩子"
//        （内核原话：*"`summarize()` is the sole subclass customization hook"*），
//        但那是给**另一个 bundle** 去 `extends CompactionEngine` 用的，
//        插件在运行期去改 `ctx.get("compaction").summarize` 属于猴补丁 —— 会踩到
//        `regionDependencies()` 每次现取 `this.summarize` 的实现细节，且一旦内核改版就静默坏掉。
//
//   ⇒ 所以本功能的定位**不是**"更好的摘要"，而是调研结论里唯一被反复验证的那一招：
//     **摘要 + 一份机器可读、逐字、可重读的副本，并在压缩后重读它。**
//     摘要是"大致记得"，磁盘与逐字副本是**确定性**的。
//
// ★★★ 2026-10-09 修掉一个**致命 bug**：`ctx.get("compaction")` 在本 profile 下
//   **永远是 `undefined`** ⇒ 上面①②③**一件都没做成过**，`ledger_compact` 也一样。
//
//   实测证据（三条互相印证）：
//     · `ledger_compact` 当场返回 *"本机没有 compaction 服务"*；
//     · patch 层逐字：host 平面那份被 `dsh-web-app/cordis.patch.yml` 那一节
//       **`disabled: true`** 关掉，它实际挂在 **preset 的 group** 里，且带
//       `isolate: { compaction: true, toolResultPruner: true }`
//       （`dsh-web-app/presets/standard.patch.yml`，本次已从 app.asar 解出来逐字核对）；
//     · 实时 Loader 目录里 `include:compaction-basic` 与 `include:tool-result-pruner`
//       **正好是那两条 `inactive`** —— 与 isolate 组点名的那两个服务完全对上。
//
//   根因：`isolate` 的语义是 `LocalRealm`（后缀 `#entryId`）⇒ **服务被隔离在该 preset
//   子树的作用域内**。★ 关键（我第一版修错了，这里更正）：**`agent.ctx` 也不在那个
//   realm 里** —— agent 的 ctx 在子树之外，从它 `get` 同样拿不到。
//
//   ★★ 正确修法（**内核自己的做法**，不是我想的）：
//     `agentPresets.serviceFor(agent, "compaction")`
//     —— 实现在 `dsh-agent-preset-registry/lib/types/mount.js` 的 `serviceForAgent()`：
//        它先 `standingMountFor(agent.ctx)` 找到**该 agent 保留的那次 preset revision**
//        （经 agent 作用域的 scope parent），再在 `store` 的 symbol 槽里找
//        **`withinFiber(impl.fiber, mount.fiber)`** 的那个实现 ⇒ 正是"隔离在子树里"的那个。
//        （`serviceForAgent` 的注释逐字：*"One agent's instance of a service its preset
//        mounted… resolve outside that realm, so they locate its revision through the
//        Agent's scope parent."*）
//     ★ 这不是我推的用法：内核**真实代码**就这么写 ——
//       `dsh-api-session-controller/lib/index.js`：
//       `const skillRegistry = presets?.serviceFor(live, "skills") ?? this.ctx.get("skills");`
//       —— 连"取不到再退回 `ctx.get`"的兜底形状都一样。
//
//   ★ 顺序：① `agentPresets.serviceFor`（isolate 部署的正解）→ ② 外层 `ctx.get`
//     （compaction 挂在 host 平面的部署仍走这条）→ ③ `agent.ctx.get`（第三兜底，
//     对非 isolate 的 agent 级挂载有效）。三条都留着，各对应一种真实部署。

/**
 * 取 `compaction` 服务。
 *
 * ★ 为什么必须这么取：见上面 2026-10-09 那条 —— 本 profile 里 compaction 挂在
 *   preset 的 `isolate` 组里，**外层 `ctx` 与 `agent.ctx` 都拿不到**，
 *   必须经内核官方的 `agentPresets.serviceFor(agent, name)`（它按 agent 保留的
 *   preset revision 去子树里找）。
 *
 * @param {object} ctx 插件的 ctx（取 `agentPresets` + 兜底用）
 * @param {object} [agent] 目标会话的 agent
 * @returns {object|undefined} compaction 服务
 */
function compactionServiceFor(ctx, agent) {
  const ok = (v) => v !== undefined && v !== null && typeof v.compactNow === "function";

  // ① ★ 内核官方取法：preset `isolate` 组内的服务只能这么拿。
  //    两个 ctx 都试（`agentPresets` 挂在 host 平面，但 agent 作用域里也可能看得到）。
  for (const scope of [ctx, agent?.ctx]) {
    try {
      const presets = scope?.get?.("agentPresets");
      const viaPresets = presets?.serviceFor?.(agent, "compaction");
      if (ok(viaPresets)) return viaPresets;
    } catch {
      /* 这一条路不通就换下一条 */
    }
  }

  // ② 外层 ctx（compaction 挂在 host 平面的部署走这条）。
  try {
    const viaCtx = ctx?.get?.("compaction");
    if (ok(viaCtx)) return viaCtx;
  } catch {
    /* 拿不到就是拿不到 */
  }

  // ③ agent 自己的作用域（非 isolate 的 agent 级挂载）。
  try {
    const viaAgent = agent?.ctx?.get?.("compaction");
    if (ok(viaAgent)) return viaAgent;
  } catch {
    /* 同上 */
  }

  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// 增量（分段）压缩：只压掉最旧的一段，保留最近的一整块
// ═══════════════════════════════════════════════════════════════════════════
//
// ★★ 用户需求（2026-10-09 原话，逐字）：
//   · *"不是完全压缩，然后把整个上下文保持在10%几的水位上面，而是允许模型进行**轻度压缩**，
//     并且**强制在压缩之前进行台账和日志更新**。"*
//   · *"AI每输出20%的时候，调用一次工具压缩到12%，类似这种比例。"*
//   · *"首先模型输出了20%的工作量…把必须留在上下文中的留在上下文，然后可以不留在上下文、
//     但是要能随时查到的放进台账。然后没有必要留的，可以移到专门的地方或者是归档，
//     同时所有的操作全部在日志里留存。到这一点之后他才执行压缩，把这20%的输出压到只剩10~12%。
//     以此类推，可以极大的拓展一兆的上下文窗口。"*
//   · *"要求模型在每次进行任务的时候，注意给自己的任务划分节点…允许超出一点或者是提前一点。
//     还要注意一点，就是**这不能消耗太多模型的tokens**。"*
//   · *"这里的20%是指**上下文上限的20%**…这个也是可以调整的。"*
//   · 目标：*"尽量延缓达到70、80的时间，也就是说把一兆上下文变成两兆。"*
//
// ★★★ 为什么必须用 `compactRegion` 而不是 `compactNow`（读内核实现得出的，非猜）：
//   `compactNow` 里写死了 `selectCompactableRange(session, measure, 0)` ——
//   **retainTokens 传 0** ⇒ "最近要保留多少"为 0 ⇒ 几乎把**全部可压历史**压掉
//   （`dsh-compaction-basic/lib/index.js:992`）。那正是"压缩幅度太大"的确切原因。
//   而 `selectCompactableRange(session, measurement, retainTokens)` 的第三个参数就是
//   **"最近保留多少 token 不动"** ⇒ **传一个大值，它就只压最旧的那一小段**。
//   ⇒ 增量压缩不必自己算范围：**把 retain 调大**，再调 `compactRegion` 即可。
//
// ★★ 为什么 `compactRegion` 必须在**回合内**调用（这也是"分段"能成立的关键）：
//   它的实现是 `compactSurfaceRegion(…, { owner: "current-turn", … })`
//   （`:971-976`），而 `owner: "current-turn"` 要求**有打开的回合**，否则抛
//   *"compactRegion: no open turn"*（`:460`）。
//   ★ 内核自己的自动压缩就挂在 `agent/pre-step`（`:839`）—— 那时回合是开着的。
//   ⇒ 我们也在 pre-step 里调，正好与内核同一条路。
//   （对比：`compactNow` 走 `owner: null`，所以它反而**要求 idle**。）
//
// ★ 与"写台账当节点信号"的配合（零 token 开销，满足用户"不能消耗太多 token"）：
//   模型写台账时本就在做"什么留上下文、什么进台账"的判断 ⇒ 那就是在声明"我到节点了"。
//   插件不问"你在节点吗"，只看「**台账写了吗**」+「**水位涨够 N 点了吗**」。

/**
 * 增量压缩的默认触发：水位相对上次压缩**上涨**多少点就**轻推**一次（用户说的 20%）。
 *
 * ★★★ 2026-10-12（D115，用户要求）：**它不再是"必压线"，而是"轻推线"**。
 *   用户原话：*"能不能不再强制输出 20 压缩 10，而是由模型主动去在它认为合适的地方
 *   调用工具压缩……但要保证我们的底线"*；兜底口径他定的是
 *   *"设定计数器，输出一定数值（默认百分之四十）仍未调用过压缩时，进行机械规则
 *   （但一定一定先记台账！！！）"*。
 *   ⇒ 三档（★ 第 ③ 档已由 **D129** 删除，见下）：
 *     ① **模型按需压**（**唯一主路径**，D114 打开开关、D129 定案）
 *     ② **轻推**一句（★ D117 起**不再按涨幅**：见 `NUDGE_MIN_RATIO` 的注释）
 *     ③ ~~涨够兜底线 ⇒ 机械压~~ ⇒ **D129 已删**：用户拍板"把所有压缩全部给模型"。
 *        那条职责交给**全量兜底**（`HIGH_FIDELITY_COMPACT_RATIO`）接管。
 */
const DEFAULT_DELTA_TRIGGER_POINTS = 20;

/**
 * ★★★ 2026-10-12（D117，用户判断）：**轻推的"可推区间"下限** —— 水位到此才值得开口。
 *
 * ★★★ 用户原话（逐字）：*"我认为，涨 ≥20 点但 <40 点时，应看到一句『建议你按需压一次』，
 *   这句话本身有点毛病 —— **即使模型只输出了 10 点，也有可能到了某个节点需要归纳一下**，
 *   应该像 billion 一样，**让压缩成为常态**。"*
 *
 * ★★ 他说得对，而且有**活证据**（2026-10-12 10:0x 实测）：
 *   锚点 60.6%（04:02 那次压后）→ 当前 72% ⇒ **涨幅仅 11.4 点 < 轻推线 20**
 *   ⇒ **重启后 6 小时里轻推 0 次、压缩 0 次**；而那 6 小时里**必然有过该归纳的节点**。
 *   ⇒ ★ 病根：我们把"该不该压"**绑在了"涨了多少"**上，而"到节点"与涨幅**毫无因果**
 *     —— 与 D89-2b / D93 / D107 **同一个病（第 5 次同型）**。
 *
 * ★ 取值 0.45 的依据：**照抄 billion-context 的 `nudge.minContextLimitPct: 0.45`**
 *   （读它真源码得出，见 `_probe-bc-config.mjs`）。★ 它的作用与我们在 D117 要做的事**同一件**：
 *   **过了这条线才"值得开口"，在那之下不打扰**。
 *   ★ 注意它**不是**"该压了"的线 —— 它是"**可以建议了**"的最低下限；
 *     而**"到底该不该压"由节点判据（落盘闸门）决定**（见 D117 的三条件）。
 */
const NUDGE_MIN_RATIO = 0.45;

// ★★★ 2026-10-12（D129）：`DEFAULT_DELTA_FALLBACK_POINTS`（原 40 点的机械兜底线）
//   **已删除** —— 用户拍板"把所有压缩全部给模型"，插件不再替它压增量。
//   ★ 那条线原来承担的职责（"别让水位撞进内核 80%"）现在由**全量兜底**接住
//     （`HIGH_FIDELITY_COMPACT_RATIO`，默认 0.7 / 用户设 0.75），且那条带逐字胶囊。
//   ⚠️ 保留这段说明是为了让后人知道"这里曾有一个 40 点的常量、它去哪了"。

/**
 * ★★★ 2026-10-11（D88）：**兜底线**——增量触发线的**上限**，防止棘轮把触发线推出内核硬压线之外。
 *
 * **病**（实测算术，见 D88）：触发线 = `锚点(压后水位) + 20`。
 *   而"压后水位"取决于**这一轮真压掉了多少** —— 实测兑现率只有 **~50%**
 *   （目标 10 点，实绩 4.9 点）：压掉得少 ⇒ 压后水位仍高 ⇒ **锚点高** ⇒ **下次触发线更高**。
 *   盘上实测：锚点 = **69.0%** ⇒ 触发线 = **89.0%**，而**内核硬压线是 80%**
 *   ⇒ ★ **增量永远等不到自己的触发点**（水位到 80% 时内核自己就压了）。
 *   ⇒ "压得越少 → 锚点越高 → 触发线越高" = **恶性棘轮**。
 *
 * ★★ **正解来自外部实现**（`billion-context` 的 `acp-kernel`，原始 TS 见
 *   `_probe-bc-config.mjs`）：它的两条线**都不参考上次压缩的结果** ——
 *   ① 绝对线 `usage >= maxContextLimitPct(0.75)`；② 增长门
 *   `resolveAdaptiveGrowth = min(cap, max(floor, limit×ratio))`（1M 窗口上 = **50,000 token 常量**）。
 *   ⇒ 因为**不看上次结果**，所以**不会棘轮**。
 *
 * ★ 我们的落地方式（最小的等价改动）：`触发线 = min(锚点 + 触发点, 兜底线)`。
 *   即"涨够 20 点"照旧是常态，但**兜底线一到就压**，不再等那个够不着的点。
 *   ★ 兜底线取 `min(全量线, 内核线) − 5 点`：必须**同时**早于
 *     ① 内核硬压线（否则内核抢先）② 我们自己的全量线（否则判据①b"让路"抢先）。
 */
const DELTA_TRIGGER_CAP_MARGIN_POINTS = 5;

/**
 * ★★★ 2026-10-11（D88）：兜底线一旦生效，**必须**再配一个"至少涨了这么多点"的小门。
 *
 * ★ 为什么非配不可（否则兜底会变成**连环重压**）：
 *   刚压完时水位**仍在兜底线之上**（因为只压掉 ~5 点）⇒ 若只看绝对水位，
 *   下一步立刻又满足 ⇒ **压完就压、无限循环**（把上下文反复重写成残渣）。
 *   ⇒ 所以兜底那条**必须**要求"确实又涨了一点"，才承认"有新东西可压"。
 *
 * ★ 这与外部实现的 `resolveMinPressureBenefit` 是**同一个门**（`acp-kernel/src/compress.ts` L1626-1640）：
 *   *"Minimum reclaimable tokens for a pressure-band nudge to be worth injecting.
 *     A sub-threshold rewrite … resets the nudge baselines on success, re-arming the
 *     still-hot band next turn — **a zero-yield loop (#198)**."*
 *   ⇒ ★ **它的注释描述的正是我们会踩的那个坑**（零产出的循环）。
 */
const DELTA_TRIGGER_MIN_GROWTH_POINTS = 2;

/**
 * ★★ 内核的自动压缩线（`dsh-compaction-basic` 的 `thresholdRatio` 默认值）。
 *
 * ★ 出处：`dsh-compaction-basic/lib/index.js` —— `const DEFAULT_THRESHOLD_RATIO = .8;`
 *   （★ 这条是**读内核源码**得到的，不是猜的；见 `_调研-bundle-patch机制.md`）。
 * ★ 用途：兜底线**绝不能越过它** —— 越过就等于"把压缩权让给内核"（而内核那次抓不到逐字胶囊）。
 */
const KERNEL_HARD_COMPACT_RATIO = 0.8;

/**
 * 增量压缩**单次最多压掉**多少点（上限）。
 *
 * ★★★ 2026-10-12（D129）**语义变更**（用户拍板）：
 *   基准是 **"每次压掉上次压缩至今增量的一半"**（`since/2`），这一项是它的**上限**。
 *   ⇒ `remove = min(since/2, 本项)`。
 *
 * ★★ 取 **30** 的理由（**这是算出来的，不是拍的**）：
 *   · `since = 当前水位 − 锚点 ≤ 100 点`（水位最多 100%、锚点 ≥ 0）
 *     ⇒ "一半"最大 **50 点** ⇒ 上限必须小于 50 **才可能生效**。
 *   · 用户本轮把节奏降到 **每涨 4~5 点折一次** ⇒ 正常情况下一半只有 **2~3 点**
 *     ⇒ 上限**平时完全不碰**，只在"攒了很久才压"（since ≥ 60）时兜住。
 *   · ★ 默认 50 是**错的**（我一度这么设）：那时上限**恒不生效**（一半最大才 50）
 *     ⇒ 面板上会留一个**永远不起作用的旋钮**（本机纪律：写了就得做到）。
 *
 * ★ 它防的是什么（**先说清楚它防不了什么**）：防的是"一次压太狠"。
 *   ★ 但**保留量在数学上天然安全**：`retain = ratio − since/2 = (ratio + anchor)/2`
 *     ⇒ 永远保留在当前水位与锚点的中点 ⇒ 不可能压到残渣。
 *     所以这一项是**保守化旋钮**（想更稳就调小），不是"防断裂"的必需品。
 *
 * ★ 为什么**不能**沿用旧名 `deltaKeepPoints`（"保留最近 N 点"）：
 *   那个名字说的是"保留量是个常量"，而棘轮要求"保留量逐轮变大" ——
 *   **两者数学上不相容**（保留恒定 ⇒ 净涨恒为 0，水位永远原地打转）。
 *   ★ 用户从未在配置里设过旧键（实测 `cordis.patch.yml` 里没有），所以改名**无迁移负担**。
 */
const DEFAULT_DELTA_REMOVE_POINTS = 30;

/**
 * 一条 surface 事件让"未回应的工具调用数"变化多少 —— **复刻内核**
 * `dsh-compaction/lib/types/tool-pairing.js` 的 `eventDelta`。
 *
 * ★ 为什么要复刻：本插件是 **Junction 目标** ⇒ `import "@deepseek-ai/*"` 会
 *   `MODULE_NOT_FOUND`（内核都起不来），所以只能自己实现。
 *   ★★ 而"复刻得对不对"**不能靠看代码觉得像** —— 有专门探针
 *   `tools/_probe-toolpairing-parity.mjs`：把内核那份**求值出来**，
 *   与这份**逐 seq 对比**，含悬空调用/并行调用/空 surface 等 7 种形态，
 *   并且反向验证"故意写错增量会被判为不等"。**先证明尺子对，再报结论。**
 *
 * @param {object} event surface 事件
 * @returns {number} 增量（assistant 里每有一个 tool-call 就 +1；tool/result 就 -1）
 */
function toolCallDeltaOf(event) {
  switch (event?.type) {
    case "assistant/message": {
      const content = event?.data?.message?.content;
      return Array.isArray(content) ? content.filter((b) => b?.type === "tool-call").length : 0;
    }
    case "tool/result":
      return -1;
    default:
      return 0;
  }
}

/**
 * 算出每个"切点"是否平衡 —— 复刻内核的 `balanceCache`（同一个 fold）。
 *
 * 平衡的定义（内核原话）：*"no unanswered tool call crosses the cut"*
 * —— 切点两边不能把一个"工具调用 / 它的结果"劈开。
 *
 * @param {object} session 会话（要 `surface.nodes` 与 `eventAt`）
 * @param {readonly number[]} nodes surface 节点序列
 * @returns {boolean[]} 长度 `nodes.length + 1`：`flags[i]` = 第 i 个节点**之前**那个切点
 *          是否平衡，`flags[nodes.length]` = 最后一个节点**之后**那个切点。
 * @throws 找不到事件、或 tool/result 没有前置调用（surface 损坏）时 —— 与内核一致，
 *         宁可抛也不要给出一个错的切点。
 */
function balanceFlagsOf(session, nodes) {
  const flags = [true]; // 空 surface 的那个前导切点恒平衡（内核 `cutBalanced: [true]`）
  let inProgress = 0;
  for (const seq of nodes) {
    const event = session?.eventAt?.(seq);
    if (event === undefined || event.seq !== seq) {
      throw new Error(`tool-pairing balance: surface seq ${seq} has no matching session event (corrupt surface)`);
    }
    inProgress += toolCallDeltaOf(event);
    if (inProgress < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`);
    }
    flags.push(inProgress === 0);
  }
  return flags;
}

/**
 * 选一段**只压掉最旧部分**的范围 —— 复刻内核 `selectCompactableRange` 的语义，
 * 但 retain 由我们给（内核 `compactNow` 给的是 0，那才是"全压"）。
 *
 * ★ 为什么自己选而不是调内核的私有 `selectCompactableRange`：它不是 Service 方法，
 *   拿不到（`compactRegion` 才是公开的）。而它的算法很短且已逐字读过，可以复刻。
 *
 * @param {object} session 会话
 * @param {object} measurement `tokenMeter.measure(session)` 的结果（含 `nodes`）
 * @param {number} retainTokens 最近保留多少 token 不动
 * @returns {{start:number, end:number}|null} 要压的闭区间；没有可压的就 `null`
 */
/**
 * ★★★★★ 2026-10-12（D141）：**压之前先看"这一段够不够大"** —— 空转闸门。
 *
 * ★★★ 为什么必须加它（**实测**，D139）：今天 38 次压缩里 **7 次（18%）压掉 < 1 点**、
 *   昨天 **0 次**；而每次压缩的**直接代价**是"压完重注台账 + 胶囊"
 *   = 实测 **16,484 字符 ≈ 10,303 tok** ⇒ 那 7 次**白付约 7.2 万 tok**，换回 0 点水位。
 *
 * ★★★ 根因（读码确认）：触发判据看的是 **"涨了多少"**（`deltaTriggerPoints`），
 *   而**能压掉多少取决于"最旧那一段有多大"** —— 这两件事**没有因果关系**。
 *   `byNeed`（模型主动压）那条路更是**只看 `since > 0`** ⇒ 涨 1 点也能触发 ⇒ 必然空转。
 *
 * ★★★ 外部佐证 + 解法来源（读 `ranxianglei/billion-context` **v0.1.195** 源码，D140）：
 *   它有 `compress.minCompressRange = 5000`（**字符**），不够就**整批拒绝**，
 *   报错原文是 *"Combine more messages into your range(s) to meet the threshold."*
 *   ⇒ ★ 即"**攒够再压**"，而且它**连提醒都用同一把尺子**（不够线不推给模型）。
 *   ★ 我们把闸门表达成**点数**（本项目既有单位口径）：
 *     `minTokens = minCompressPoints / 100 × window`
 *   ⇒ 取 **1 点**的语义是：**"要压的那段至少得够压掉 1 点，否则不值得付那次重注"**。
 *     ★ 为什么用 1 而不是更大：1 点已经是"刚好回本"的下限，且**恰好**能滤掉实测那 7 次
 *       （它们产出都 < 1 点）。调大 = 更保守（攒得更久才压）。
 */
const MIN_COMPRESS_POINTS = 1;

/**
 * ★★★★★ 2026-10-12（D141）：估算"**现在真去压，能压掉多少 token**"（零副作用，只读）。
 *
 * ★ 为什么要单独一个函数：它被**两处**用（真压前的闸门、轻推前的判断），
 *   而两处必须用**同一个判据** —— 否则就会出现"推了却被闸门拒"的白打扰
 *   （本项目纪律：**一个事实只能有一个判定出口**，D25）。
 *
 * @returns {number|undefined} 可压 token 数；`undefined` = 量不到（⇒ 调用方**别拦**，放行）
 *   ★ 量不到就放行而不是拦下：闸门的目的是**省钱**，不是**阻止压缩**。
 *     拿不到数就拦，会让"测不到"变成"永远不压"（那是 D59 那种事故的形态）。
 */
function estimateCompressibleTokens(ctx, agent, pressure, since, settings) {
  try {
    const meter = ctx.get("tokenMeter");
    if (meter === undefined || typeof meter.measure !== "function") return undefined;
    const measurement = meter.measure(agent.session);
    const nodeSum = Array.isArray(measurement?.nodes)
      ? measurement.nodes.reduce((s, n) => s + Number(n?.tokens ?? 0), 0)
      : 0;
    if (nodeSum <= 0) return undefined;
    // ★ 与真压那条**逐字同一套算式**（`removeCap` / `removePoints` / `retainTokens`）。
    const removeCap = Math.max(1, settings.deltaRemovePoints);
    const removePoints = Math.max(1, Math.min(Math.round((since * 100) / 2), removeCap));
    const retainTokens = Math.max(1, Math.floor(nodeSum - (removePoints / 100) * pressure.window));
    const range = selectIncrementalRange(agent.session, measurement, retainTokens);
    if (range === null) return 0;
    let sum = 0;
    for (const n of measurement.nodes) {
      const seq = Number(n?.seq);
      if (!Number.isFinite(seq)) continue;
      if (seq >= range.start && seq <= range.end) sum += Number(n?.tokens ?? 0);
    }
    return sum;
  } catch {
    return undefined; // ★ 估算炸了 ⇒ 当成"量不到" ⇒ 放行（绝不因为估算失败而阻止压缩）
  }
}

/**
 * ★★★★★ 2026-10-12（D141）：**闸门的那一步判断** —— 抽成**纯函数**，为了能被直接断言。
 *
 * ★★★ 为什么必须抽出来（**反向验证当场逼出来的教训**）：
 *   第一版把判断写在 `runIncrementalCompact` 深处，情形 61 只能断言**估算器**的值。
 *   于是我拿五种坏法去验，结果：
 *     · "把闸门整个删掉" ⇒ **不红**
 *     · "量不到判成太小" ⇒ **不红**
 *     · "手动豁免失效"   ⇒ **不红**
 *     · "设置项没接上"   ⇒ **不红**
 *   ⇒ ★ **四条坏法全绿** = 那些断言根本没在管闸门 ⇒ **"闸门真的有没有拦"无人看守**。
 *   ★ 这与 D136 那次"函数对 ≠ 接线对"是**同一个病的两个方向**：
 *     那次是"有函数没接线"，这次是"接了线但判据测不到"。
 *   ⇒ 正解：**把判断本身变成纯函数**，用输入输出直接钉住（`gateDecisionForTest`）。
 *
 * @param {number|undefined} compressible 可压 token 数；`undefined` = 量不到
 * @param {number} minPoints 门槛（点）
 * @param {number} window 上下文窗口（token）
 * @param {boolean} forced 人手动（`/ledger light`）⇒ 豁免
 * @returns {{pass: boolean, why: string}} `pass=true` ⇒ 允许压
 */
function compGateDecision(compressible, minPoints, window, forced) {
  // ★ 手动豁免：那是人的明确授权，不该被"划不划算"挡住（D40/D114 的既有取舍）。
  if (forced === true) return { pass: true, why: "manual" };
  // ★★ 量不到 ⇒ **放行**（不是拦）：闸门目的是省钱，不是阻止压缩。
  //   拿不到数就拦 ⇒ "测不到"会变成"永远不压" —— 那正是 D59 事故的形态。
  if (compressible === undefined) return { pass: true, why: "unmeasurable" };
  const minTokens = (Math.max(0, minPoints) / 100) * window;
  if (compressible < minTokens) return { pass: false, why: "tooSmall" };
  return { pass: true, why: "bigEnough" };
}

function selectIncrementalRange(session, measurement, retainTokens) {
  const priced = measurement?.nodes;
  if (!Array.isArray(priced) || priced.length === 0) return null;
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes) || nodes.length !== priced.length) return null;
  // 内核会校验 token-meter 的 surface 与当前 surface 一致；不一致就别猜。
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i] !== priced[i]?.seq) return null;
  }

  // 首个节点若是 system/message ⇒ 它永不进压缩范围（内核 `systemHead` 的语义）。
  const head = session.eventAt(nodes[0]);
  const firstIdx = head?.type === "system/message" ? 1 : 0;

  // 从后往前累计，直到攒够 retainTokens ⇒ 那就是"要保住"的起点。
  let accumulated = 0;
  let keepFromIdx = priced.length;
  for (let i = priced.length - 1; i >= 0; i -= 1) {
    accumulated += Number(priced[i]?.tokens ?? 0);
    keepFromIdx = i;
    if (accumulated >= retainTokens) break;
  }
  if (keepFromIdx <= firstIdx) return null;

  // ★ 边界必须平衡：往前挪到最近一个平衡切点（与内核完全一样的收尾动作）。
  const flags = balanceFlagsOf(session, nodes);
  while (keepFromIdx > firstIdx) {
    if (flags[keepFromIdx] === true) break;
    keepFromIdx -= 1;
  }
  if (keepFromIdx <= firstIdx) return null;

  return { start: nodes[firstIdx], end: nodes[keepFromIdx - 1] };
}

/**
 * 报告 `compaction` 服务是**经哪条路**取到的 —— 只用于诊断输出，不参与逻辑。
 *
 * ★ 与 `compactionServiceFor` 的探测顺序保持一致（它先取到的那条就是这里报的），
 *   所以两处若哪天不同步，`ledger_status` 会指错路；自检里有断言钉住两者一致。
 *
 * @param {object} ctx 插件的 ctx
 * @param {object} [agent] 目标会话的 agent
 * @returns {"agentPresets.serviceFor"|"ctx.get"|"agent.ctx.get"|null}
 */
function compactionReachVia(ctx, agent) {
  const ok = (v) => v !== undefined && v !== null && typeof v.compactNow === "function";
  for (const scope of [ctx, agent?.ctx]) {
    try {
      if (ok(scope?.get?.("agentPresets")?.serviceFor?.(agent, "compaction"))) {
        return "agentPresets.serviceFor";
      }
    } catch {
      /* 换下一条 */
    }
  }
  try {
    if (ok(ctx?.get?.("compaction"))) return "ctx.get";
  } catch {
    /* 换下一条 */
  }
  try {
    if (ok(agent?.ctx?.get?.("compaction"))) return "agent.ctx.get";
  } catch {
    /* 都没有 */
  }
  return null;
}

//
// ★ 为什么逐字段落这么要紧（社区实测数字）：压缩后
//   **器物追踪（哪些文件被改过）是跨厂商最弱项（2.19–2.45 / 5）**，
//   而**约束与决策的衰减是 8.3×**（软性约束 +50 pts vs 硬性安全规范 +6），
//   Anthropic 自己的 cookbook 实测"附录里的具体数字 0/3 保留"。
//   ⇒ 这两类东西**绝不能交给摘要**，必须逐字。

/**
 * ★★★★★ 全量压缩的触发水位 —— **2026-10-13（D155）用户拍板：0.7 → 0.30**。
 *
 * ★★★ 为什么从 0.7 大改成 0.30（三条实测依据，见 DECISIONS D154）：
 *   ① **成本 ∝ 平均水位**：实测水位中位 **40.1%**、≥50% 占 **35.9%**；
 *      反事实模拟把水位压在 30% ⇒ 总成本 ≈ 现在的 **51%**（省一半）。
 *   ② ★ **"长期 30%" 本机已证明可达**：33 个会话里 **23 个**水位中位 <30%，
 *      其中多个 **100% 的请求都 <30%**、且一次没到过 60%；
 *      而水位最高的两个恰好是**最长的两个会话** ⇒ 水位高与"用得多"无关，与"活得久"有关。
 *   ③ **只有全量能把地板砸下去**：本会话 20 次压缩里，增量的落点是 62→68→74→75%，
 *      而 5 次全量全部落到 **9.8~11.2%** ⇒ 地板由全量决定。
 *
 * ★★ 为什么"早压"在旧口径下是损失、在新口径下反而正确（这是本轮最大的认知更正）：
 *   旧口径只算了「重注台账+胶囊 ≈ 10,303 tok」，**没算缓存重算**。
 *   补上后（D148/D153）：**单次总代价几乎与折多深无关**（52~80 万 tok 的常数），
 *   而**收益 ∝ 折多深** ⇒ 每点代价：折得浅 **886,569** vs 折得深 **15,510**（差 **57 倍**）。
 *   ⇒ 于是"水位低就压"不再吃亏，反而把每次改写都摊在**更便宜的深度**上。
 *
 * ★ 与内核 0.8 的关系：0.30 距内核硬压线还有 50 个点，
 *   且全量一次折到 ~10% ⇒ 正常情况**永远轮不到内核那一次**（那一次抓不到逐字胶囊）。
 */
const HIGH_FIDELITY_COMPACT_RATIO = 0.3;

/** 胶囊里逐字保留的用户消息条数上限（**取最近的**，因为约束与纠正通常在后半段）。
 *  ★★ 2026-10-11（D84 缺陷修复）：**它不再是"淘汰即丢"** ——
 *    被挤出去的原话会**升级归档**到 `_ledger-archive/` 下、名为 `USER_MSG_ARCHIVE_FILE`
 *    的那个文件（见 `archiveEvictedUserMessage`）。
 *    ⚠️ **别在注释里手写那个文件名** —— 我原来在这里写的是 `用户原话-完整.md`，
 *       而常量实际是 `用户原话-完整存档.md` ⇒ **注释与代码对不上**（2026-10-12 核对时才发现）。
 *       这种"注释里的名字漂了"会让后人按注释去找一个不存在的文件。
 *   实测缺陷：191 条被压真原话里，
 *    逐字能在载体找回的只有 **24.1%**，而**最早 3 条（含用户原始任务陈述）是 0/3**
 *    —— 根因就是这一行"只留最近 40 条"。
 */
const CAPSULE_USER_MSG_MAX = 40;
/** 胶囊里单条用户消息的字符上限（粘一整个文件进来的那种才截）。 */
const CAPSULE_USER_MSG_CHARS = 1200;
/** 胶囊里逐字保留的失败信息条数上限。 */
const CAPSULE_ERROR_MAX = 20;
const CAPSULE_ERROR_CHARS = 300;
/** 器物索引最多列多少个文件（按最后一次操作时间倒序）。 */
const CAPSULE_ARTIFACT_MAX = 60;
/** 胶囊整体字符上限 —— 它**要进上下文**，所以必须有闸门（约 4k token）。 */
const CAPSULE_MAX_CHARS = 16000;

/**
 * ★★★ 「被压段索引」最多留几条（承 DECISIONS D79「指针推行」）。
 * ★ 为什么必须有上限：这份索引**要常驻上下文**（D46：恢复必须"推"给模型），
 *   所以它必须"小到可常驻"。本机 22 次压缩 ⇒ 22 行约 1.3K 字符，远在回读预算（≈31K tok）内。
 *   上限取 60 ⇒ 即使压得再密，索引也只在 4K 字符量级。
 */
const SHADOWED_INDEX_MAX = 60;

/** `ledger_recall` 单次**最多**回读多少字符（≈ 6K token）—— 回读预算的闸门。 */
const RECALL_MAX_CHARS = 24000;

/**
 * ★★★ 被挤出胶囊的用户原话，升级归档到哪个文件名（承 D84 修复）。
 * ★ 放在 `_ledger-archive/<YYYY-MM>/weekN/` 下 —— 与归档、日志共用同一期间键。
 * ★ 名字刻意**不含日期**：它是**同一条只追加的流**（历次淘汰都往同一个文件追加），
 *   而所在目录已经带了期间信息；若文件名再嵌日期，反而会**按天碎成很多份**，
 *   "找一句原话"就得先猜是哪天。
 */
const USER_MSG_ARCHIVE_FILE = "用户原话-完整存档.md";

/**
 * ★★★ 胶囊素材的**落盘文件**（D61 修复，2026-10-11）。
 *
 * ★ 为什么必须有它：`createCapsuleMemory()` 的 `bySid` 是**进程内 Map** ⇒
 *   **内核一重启就清空**，于是"重启后首次压缩"的胶囊**只含重启以来的原话**。
 *   ★ 而重启是常态（改代码 / 升级 / 崩溃恢复都要重启），
 *     用户最需要"别忘"的时刻**恰恰是重启后接续** —— 这正是本插件的核心价值。
 *
 * ★ 实测坐实（不是推理；口径 = **内核进程启动**边界的真话条数）：
 *   · 03:33:14 胶囊：收 0 条；而 03:32:35（进程起）→03:33:14 真话 0 条 ⇒ 吻合
 *   · 03:51:28 胶囊：收 **1** 条（`03:35:01`）；该边界内真话**恰好 1 条** ⇒ **精确吻合**
 *   ★ 我第一版用 `session/end-seed` 当"重启"代理 ⇒ 0/4 全不吻合 —— **那是我的尺子错**
 *     （`end-seed` 是会话收尾，不是进程重启）。换成进程启动边界后精确吻合。
 *
 * ★ 存法**照抄已验证的 `anchors.json`**（同一处目录、同一套"临时文件+改名"、
 *   同一套"坏条目丢掉不整份作废"）——它已经跨多次重启实战验证过。
 *   仍然**不碰用户的工作区**（那两处红线不变）。
 */
const CAPSULE_STORE_FILE = "capsules.json";

/**
 * ★★★ 2026-10-13（D159）：胶囊落盘的**可查计数** —— 修掉"静默出口"的同型病。
 *
 * ★ 为什么要它：D151 的教训是「**只生产、不渲染的标记 = 静默出口**」。
 *   D159 那条覆盖缺陷之所以能藏那么久，正是因为它**不留痕**：
 *   盘上从 40 条变成 1 条，没有任何地方记着"这里发生过一次覆盖"。
 *   ⇒ 现在三个数都要能被查：
 *     · `writes`    —— 真发生过并集落盘多少次
 *     · `skipped`   —— 因"空快照 + 盘上有货"跳过多少次（应极少；多了说明上游在漏）
 *     · `mergedOld` —— ★ **并集真补到了旧素材**多少次（= D159 修复起作用的唯一硬指标）
 *       （判据：内存那份比盘上那份**少** ⇒ 若还是"替换"语义，这一条就是一次真实丢失）
 */
const capsuleSkipStats = { writes: 0, skipped: 0, mergedOld: 0 };

/** 落盘时每个 sid 最多留几条（与内存上限一致，别让文件无限长）。 */
const CAPSULE_STORE_MAX = CAPSULE_USER_MSG_MAX;
/** 落盘文件最多记几个会话（本机 139 会话的历史尺度下够用；超出丢最旧的）。 */
const CAPSULE_STORE_SESSIONS = 60;

/**
 * "这是容器工作区，不是项目"的**标志文件**。
 *
 * 这些文件的共同点：它们只在**有人刻意经营过**的目录里出现，用来指挥 AI 或编辑器，
 * 而不是项目自身的产物。一个刚 `mkdir` 出来的新项目不会有 `AGENTS.md`。
 */
const CONTAINER_MARKERS = ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".windsurfrules"];

/** 找"容器工作区"证据时向下扫几层；以及每层最多看几个子目录（防止在巨型目录上卡住）。 */
const CONTAINER_SCAN_DEPTH = 2;
const CONTAINER_SCAN_FANOUT = 300;

/**
 * 标志文件要**配上至少这么多子目录**才算容器证据。
 *
 * ★ 为什么不是"有 AGENTS.md 就算容器"：单个新项目完全可能自己带一份 `AGENTS.md`
 *   （那正是规范化项目的做法）。只凭标志文件判容器，会让这种项目**永远收不到**
 *   需求 ① 的初始化提示 —— 把一个"新增功能"变成"新增静默"。
 *   配上"目录里已经有多个子项目"这一条，两边都保住：真容器判得出，单项目不误伤。
 */
const CONTAINER_MIN_SUBDIRS = 2;

/** 跳过这些目录名：它们不是子项目，且 node_modules 一进去就是几千个包。 */
const NOT_A_SUBPROJECT_RE = /^(node_modules|\.git|\.svn|\.hg|dist|build|out|target|vendor)$/i;

/** 数一下本层有几个"像子项目"的子目录。读不了就当 0（宁可不判容器）。 */
function countChildDirs(projectRoot) {
  let entries;
  try {
    entries = fs.readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (NOT_A_SUBPROJECT_RE.test(e.name)) continue;
    n += 1;
  }
  return n;
}

/**
 * 容器判定的缓存：`projectRoot → { at, marker, nestedRepo }`。
 *
 * ★ 必须有：`inspect()` 在**每一步**都被调用（pre-step 注入要用），而容器扫描最坏是
 *   300 × 2 层 statSync。不缓存的话，一个 100 子目录的工作区每轮对话都要白扫几千次磁盘。
 *   会话期间工作区布局几乎不变，60 秒 TTL 足够，也让"刚建了子仓库"最多迟一分钟才反映。
 */
const CONTAINER_CACHE_TTL_MS = 60_000;
const containerCache = new Map();

// ═══════════════════════════════════════════════════════════════════════════
// 活动日志（★ 机器自动采集，**绝不注入上下文**，只在回溯时按需读切片）
// ═══════════════════════════════════════════════════════════════════════════
//
// 四档粒度（体积是在本机一场真实会话上量出来的：
// `sessions\--D-Deepseek~5DE5~4F5C~533A--\session-fada6e5f-…`，52.6 小时）：
//
//   L0 里程碑      9 条 · 1.4 KB   全自动   交付/压缩/命令/工作区变更/回合边界
//   L1 回合摘要    3 条 · 0.6 KB   **AI 写** 唯一带「为什么」的一档
//   L2 文件流水   31 文件 · 2.0 KB 全自动   按路径去重、带增改标记与次数
//   L3 工具流水  482 行 · 30.8 KB 全自动（默认关）一次调用一行 + 失败标记
//
// ★ 为什么 L3 默认关：482 行 / 52 小时，且随会话线性增长；长期项目会失控。
//   实测它值钱的地方是那 6/490 的**失败标记**，适合按需打开排查。
//
// ★ 数据来源是官方自己的落盘事件 `session/event`，**同步**触发
//   （`dsh-session\lib\index.js`：`append()` 内 `this.log.push(event)` 之后紧接
//    `invokeContainedSessionObservers(…, "session/event", …)`）。该文件开头写明：
//   *"Persistence is a plugin concern (subscribe to `session/event`, drain on
//   `session/flush`)."* ⇒ 采集**不花一个 token**、也不靠 AI 记得去写。
//
// ★ 失败判据用**结构化字段** `message.isError`，不是正则。
//   实测该字段 490 条结果里 6 true / 484 false / **0 缺失**。
//   （早先用关键词正则估出"108/481 失败"，那是**错的尺子** —— 它匹配到了 `read`
//   返回的文件正文里的 error 字样。留此一句，免得后人再走一遍。）

/** 清单里没有 logDir 时用的默认日志目录（与归档目录同级，同为「机器产物」）。 */
const DEFAULT_LOG_DIR = "_ledger-log";

/**
 * 默认档位。★ L3 默认关，理由见上；★ L4 默认**开**，理由见下。
 *
 * L4 = **用户消息存档**（用户需求：*"新增一个记录，负责自动记住用户发的所有消息
 * （不自动注入上下文，但有问题时可以查），要记得为记录带上来源的会话编号和发送时间，
 * 多会话项目很有用"*）。
 *
 * ★ 为什么默认开：它是**自动**承诺（"负责自动记住"），若默认关就等于没做。
 *   它零模型调用（和 L0/L2/L3 一样跑在 session/event 上），不花一分钱 token。
 *
 * ★ 为什么不并进 L0/L1：它们是**机器/agent 的行为**时间线；
 *   用户消息是**人类说的话**，是另一条轴。混在一起会让"谁说的"与"做了什么"
 *   互相挤占 limit，而且两者的读取意图完全不同（回溯行为 vs 回溯原话）。
 */
const DEFAULT_LOG_LEVELS = { L0: true, L1: true, L2: true, L3: false, L4: true };

/**
 * L4 一行的**硬上限**（字符，含时间戳与编号）。
 *
 * ★ 这是**安全阀**，不是"故意截断"：本机实测 769 条真实用户消息里
 *   p50=51 / p90=291 / p99=5422 / **max=6949** 字符。上限设在 20000 意味着
 *   正常消息**一条都不会被截**，只有"用户粘了一整个文件进来"那种才会被切，
 *   并留下明确标记 —— 那总比让单行无限膨胀、把 grep 与 limit 一起拖垮好。
 */
const USER_MSG_MAX_CHARS = 20000;

/** L4 只在 `source.kind` 正好是这个值时采集 —— 实测这就是「人类本人发的」。 */
const USER_MSG_SOURCE_KIND = "user";

/**
 * 默认**读取**档位：L0–L3。
 *
 * ★ 刻意不含 L4：用户消息量大（实测 769 条 vs 工具调用几百条），
 *   若默认混进 timeline，一次"最近发生了什么"的查询会被原话刷屏。
 *   要看它得显式说：`ledger_log({view:"users"})` 或 `levels:["L4"]`。
 */
const DEFAULT_READ_LEVELS = ["L0", "L1", "L2", "L3"];

/** L3 每行参数截断长度。实测 50 字符 ≈ 64 B/行；截到 90 只多 3 B 但噪音更大。 */
const LOG_BRIEF_CHARS = 50;

/** 回溯读取的条数上限与默认值。 */
const LOG_DEFAULT_LIMIT = 200;
const LOG_MAX_LIMIT = 2000;

/** 日志目录里允许出现的文件名（既是写入白名单，也是读目录时的过滤器）。 */
const LOG_LEVEL_FILES = {
  L0: "L0-milestones.md",
  L1: "L1-turns.md",
  L2: "L2-files.md",
  L3: "L3-tools.md",
  L4: "L4-user-messages.md",
};

/**
 * ★★★ 逐字胶囊的子目录名（相对 `logDir`/当期期间键）。
 *
 * 为什么把胶囊**落盘**（2026-10-10，D45）：
 * ① **可回溯**：胶囊原先只活在内存 `Map` 里 —— 进程一重启就没了，
 *    被压缩消费（`.delete`）后也没了。而它恰恰是最该留存的东西。
 * ② **器物索引是全家桶里最弱的一维**：Factory 用 36,611 条生产消息实测，
 *    "哪些文件被改过"这条三家都只有 **2.19–2.45 / 5**，且社区点名它是
 *    "统一薄弱、且最影响编码 agent 实际成败"的那一维。→ 不落盘等于每次都从零重建。
 * ③ **抗"压缩链"失真**：胶囊本来就是**带外**生成的（来自我们自己的累积 Map，
 *    不经过摘要器），落盘之后**下一次压缩读的是原件**，而不是上次摘要的摘要。
 *
 * ★ 为什么一个胶囊一个文件、而不是追加进一个日志文件：
 *   · 日志的硬不变量是「**一行 = 一条**」（解析/grep/limit 全建立在它上面），
 *     而胶囊天然是**多行块**；硬塞进去会破坏那个不变量（L1 踩过这个坑）。
 *   · 一文件一份 ⇒ **文件名即时间线**（可 ls 出来）、**内容可 diff**、**永不覆写**（证据）。
 *   · 量很小：实测 139 个会话一共只有 36 次压缩。
 */
const CAPSULE_DIR_NAME = "capsules";

/** 胶囊文件名用的时间戳：`YYYY-MM-DD-HHmmss`（可排序、无空格、跨平台安全）。 */
function capsuleFileStamp(now) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * 把一份逐字胶囊**落盘**（永不覆写）。
 *
 * ★ 只在项目**启用了活动日志**时写 —— 与"日志是可选、没登记就不往项目里写任何东西"
 *   这条既有承诺保持一致（不能因为加了个功能就偷偷往人家项目里塞文件）。
 *   没启用时**如实返回原因**，不假装写成功。
 *
 * @param {string} root 项目根
 * @param {object} info `inspect(root)` 的结果
 * @param {string} sid 会话 id（写进题头，便于回溯"这是哪场会话的"）
 * @param {string} snap 胶囊正文（`renderCapsule` 的产物）
 * @param {{source?:string, at?:Date}} [opts] 来源（手动/自动），用于题头
 * @returns {{ok:boolean, rel?:string, reason?:string}}
 */
function persistCapsule(root, info, sid, snap, opts) {
  if (typeof snap !== "string" || snap.trim() === "") {
    return { ok: false, reason: "胶囊是空的（没有素材可存）" };
  }
  const now = opts?.at instanceof Date ? opts.at : new Date();
  // ★★★★★ 2026-10-13（D165）：**目录不再在这里算** —— 交给唯一出口 `capsuleDirRel()`。
  //   ★ 收口前这里是**第一处**算法（`${dir}/${period}/${CAPSULE_DIR_NAME}`），
  //     而兜底指针是**第二处**（`path.join(dir, stamp.dir, "capsules")`）——
  //     两处算同一个目录却得到**不同的字符串**（正斜杠 vs 反斜杠），
  //     且第二处用的是**字面量**而不是这里的常量。⇒ 同一个目录**不许算两遍**。
  //   ★ 「有没有启用日志」这个判断也收了进去（取不到 `logDirOf` 就返回 `undefined`）
  //     —— 原来这里和 `capsulePathFor` **各判一次**，同一条判据两个副本。
  const relDir = capsuleDirRel(info, now);
  if (relDir === undefined) {
    return { ok: false, reason: "这个项目没启用活动日志 ⇒ 按约定不往项目里写文件" };
  }
  const absDir = path.resolve(root, relDir);
  // ★ 逃逸检查：与其它写盘路径同一道闸门。
  if (!isUnder(root, absDir)) {
    return { ok: false, reason: "胶囊目录路径逃出项目根" };
  }
  const src =
    opts?.source === "command" ? "手动（命令）"
    : opts?.source === "card" ? "手动（卡片）"
    : opts?.source === "manual" ? "手动（工具）"
    : opts?.source === "auto:70%" ? autoFullLabel()
    : opts?.source === "auto:delta" ? "自动（增量）"
    : typeof opts?.source === "string" && opts.source !== "" ? String(opts.source)
    : "未知来源";
  const tag = tagOfId(sid);
  const rel = `${relDir}/${capsuleFileStamp(now)}-${tag}.md`;
  const abs = path.resolve(root, rel);
  if (!isUnder(root, abs)) return { ok: false, reason: "胶囊文件路径逃出项目根" };
  const body =
    `# 逐字胶囊 · ${stampSec(now)} · [${tag}]\n\n` +
    `> **来源**：${src}\n` +
    `> **会话**：\`${sid}\`\n` +
    "> **这是什么**：压缩**前那一瞬**的逐字素材（你的原话 / 报错原文 / 器物索引 / 去哪重读）。\n" +
    "> 它**不参与归档、永不注入上下文**；新会话要恢复现场时，直接读它 ——\n" +
    "> 它比摘要可靠，因为它是**原件**而不是对原件的复述。\n\n" +
    snap +
    "\n";
  try {
    ensureDir(absDir);
    // ★ `wx` = 已存在就失败 ⇒ **永不覆写**（记录是证据）。同名几乎不可能（秒级时间戳），
    //   真撞上就换个后缀，也绝不覆盖。
    try {
      fs.writeFileSync(abs, body, { encoding: "utf8", flag: "wx" });
      return { ok: true, rel };
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      const rel2 = `${relDir}/${capsuleFileStamp(now)}-${tag}-2.md`;
      fs.writeFileSync(path.resolve(root, rel2), body, { encoding: "utf8", flag: "wx" });
      return { ok: true, rel: rel2 };
    }
  } catch (e) {
    return { ok: false, reason: `写胶囊失败：${String(e?.message ?? e)}` };
  }
}

/**
 * 把「分流单」里 `落（stash）` 那一桶写进项目的只存区（`_stash/`）。
 *
 * ★ 用户原话（2026-10-10）：*"有必要查到的就放进项目中…没有必要保留的就归档"*
 *   以及他对"落"的定位：**以后可能要查、但不该占上下文**。
 *
 * ★ 为什么不复用活动日志：日志的硬不变量是「**一行 = 一条**」（解析 / grep / limit
 *   全建立在它上面），而一条分流项天然是**多行**（判断 + 理由 + 出处）。硬塞进去
 *   会破坏那个不变量 —— 胶囊当年就踩过这个坑，所以它也是一个独立文件。
 *
 * ★ 为什么一个会话一个文件、而不是一条一个文件：
 *   分流本来就**按次**发生（每次压缩一次），一次会话可能分流几十条。一条一文件
 *   会把 `_stash/` 撑成几千个小文件；一天一文件又不好按会话回溯。
 *   一张单子一个文件 = **可 diff、可按会话查、条数可控**。
 *
 * ★ 为什么**不需要**启用活动日志（与胶囊不同）：
 *   胶囊是"日志的衍生物"，而 `_stash/` 是**用户明确要的中间层**（他拍板选的
 *   "项目里的新文件区"）。但**仍然**只在有台账的项目里写 —— 与"没登记就不往
 *   项目里写任何东西"那条承诺一致。
 *
 * @param {string} root 项目根
 * @param {object} info `inspect(root)` 的结果
 * @param {string} sid 会话 id
 * @param {Array<{what:string, why?:string, where?:string}>} items 要"落"的条目
 * @param {{source?:string, at?:Date, kept?:number, dropped?:number}} [opts]
 * @returns {{ok:boolean, rel?:string, count?:number, reason?:string}}
 */
function persistStash(root, info, sid, items, opts) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, count: 0, reason: "没有要「落」的条目" };
  }
  // ★ 与胶囊同一条承诺：**没有台账就不往项目里写任何东西**。
  if (info?.activeRel === undefined) {
    return { ok: false, count: 0, reason: "这个项目还没有台账 ⇒ 按约定不往项目里写文件" };
  }
  const now = opts?.at instanceof Date ? opts.at : new Date();
  const { dir: period } = archiveStamp(now, info?.manifest?.archiveWeekMode);
  const relDir = `${STASH_DIR}/${period}`;
  const absDir = path.resolve(root, relDir);
  if (!isUnder(root, absDir)) return { ok: false, count: 0, reason: "只存目录路径逃出项目根" };

  const tag = tagOfId(sid);
  const rel = `${relDir}/${capsuleFileStamp(now)}-${tag}.md`;
  const abs = path.resolve(root, rel);
  if (!isUnder(root, abs)) return { ok: false, count: 0, reason: "只存文件路径逃出项目根" };

  const src =
    opts?.source === "auto:delta" ? "自动（增量压缩前）"
    : opts?.source === "auto:70%" ? autoFullLabelBefore()
    : opts?.source === "manual" ? "手动（工具）"
    : typeof opts?.source === "string" && opts.source !== "" ? String(opts.source)
    : "未知来源";

  const rows = items
    .map((it) => {
      const what = String(it?.what ?? "").trim();
      if (what === "") return "";
      const why = String(it?.why ?? "").trim();
      const where = String(it?.where ?? "").trim();
      return (
        `- **${what}**\n` +
        (why === "" ? "" : `  - 为什么留着：${why}\n`) +
        (where === "" ? "" : `  - 去哪查：${where}\n`)
      );
    })
    .filter((x) => x !== "")
    .join("");
  if (rows === "") return { ok: false, count: 0, reason: "条目全是空的" };

  const body =
    `# 只存单 · ${stampSec(now)} · [${tag}]\n\n` +
    `> **来源**：${src}\n` +
    `> **会话**：\`${sid}\`\n` +
    `> **这是什么**：压缩时被判为「**以后可能要查、但不该占上下文**」的东西。\n` +
    "> 它**不参与归档、永不注入上下文** —— 需要时自己 grep 这个目录。\n" +
    (Number.isFinite(opts?.kept) || Number.isFinite(opts?.dropped)
      ? `> **同一次分流的其余去向**：留在上下文 ${opts?.kept ?? 0} 条 · 丢掉 ${opts?.dropped ?? 0} 条。\n`
      : "") +
    "\n" +
    rows;

  try {
    ensureDir(absDir);
    // ★ `wx` = 永不覆写（记录是证据），与胶囊同一道保证。
    try {
      fs.writeFileSync(abs, body, { encoding: "utf8", flag: "wx" });
      return { ok: true, rel, count: items.length };
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      const rel2 = `${relDir}/${capsuleFileStamp(now)}-${tag}-2.md`;
      fs.writeFileSync(path.resolve(root, rel2), body, { encoding: "utf8", flag: "wx" });
      return { ok: true, rel: rel2, count: items.length };
    }
  } catch (e) {
    return { ok: false, count: 0, reason: `写只存单失败：${String(e?.message ?? e)}` };
  }
}


/**
 * 采集缓冲的落盘延迟（毫秒）。
 *
 * ★ 为什么必须去抖而不是每次事件都写：一场会话实测 490 次工具调用 + 401 个 step，
 *   逐条 `appendFile` 既是无谓的 IO，也会让日志文件被切成极碎的写入。
 *   ★ 为什么**不能**只靠回合结束兜底：回合跑了 40 分钟才结束，而 `agent/disposed`
 *   与回合末都不是必然会到的（进程可能被杀）。延迟 1.2 秒落盘 = 至多丢 1.2 秒。
 */
const LOG_FLUSH_DEBOUNCE_MS = 1200;

/**
 * L3 不记的工具。
 *
 * ★ 两类，理由不同：
 *   - `read`/`edit`/`write`：它们的 L3 行只是 L2 行的重复（同一个文件路径），
 *     记两遍不会多出信息；
 *   - 本插件自己的工具：`ledger_log` 若把自己的读取也记进日志，
 *     就会形成"查日志 → 日志变长 → 下次查更多"的自激。
 */
const L3_EXCLUDE = new Set([
  "read",
  "edit",
  "write",
  "ledger_status",
  "ledger_read",
  "ledger_write",
  "ledger_log",
  "ledger_log_write",
  "ledger_checkpoint",
]);

/**
 * 会**改动文件**的工具 → 参数名。用于 L2。
 *
 * ★ 为什么按工具名列白名单，而不是"参数里带路径就算"：实测后者会误判 ——
 *   `grep.pattern` 与 `pwsh.command` 都出现过像路径的值，而 `grep`/`glob` 的
 *   `path` 是**搜索根**、不是被改动的文件。误判的后果是日志里出现
 *   "M 了一个其实没动的文件"，比漏记更难查。
 */
const L2_TOUCHED_SPEC = {
  write: ["file_path"],
  edit: ["file_path"],
  decompress: ["toFile"],
  import_image: ["output"],
  create_sprite: ["filename"],
  save_sprite_as: ["new_filename"],
  export_png: ["output"],
  export_spritesheet: ["output"],
};

/** 会**读取文件**的工具 → 参数名（单列一档，回溯时才看得出"看过但没改"）。 */
const L2_READ_SPEC = { read: ["file_path"] };

/** 日志档位名 → 是否合法。 */
const LOG_LEVEL_NAMES = ["L0", "L1", "L2", "L3", "L4"];

/**
 * 台账改动审计行的两种 kind。
 *
 * ★ 为什么要分开而不是都叫 `ledger-write`（2026-10-09 修）：
 *   归档是**成批删条目**，它回答的是"这几条哪去了"；写入回答的是"谁改的"。
 *   两者追溯的含义不同，混成一个 kind 就分不出"台账少了两条"是有人精简、
 *   还是有人归档了。
 * ★ 审计视图**两个都收**（`AUDIT_KINDS`）—— 分开标只是让它更精确，
 *   绝不能让归档从审计里消失（那是唯一会成批删东西的操作）。
 */
const AUDIT_KIND_WRITE = "ledger-write";
const AUDIT_KIND_ARCHIVE = "ledger-archive";
const AUDIT_KINDS = [AUDIT_KIND_WRITE, AUDIT_KIND_ARCHIVE];

/** L0 关注的事件类型 → 写进日志的一句话。`kind` 供回溯时按类型过滤。 */
const L0_KINDS = {
  "deliverables/presented": (d) =>
    `交付 ${Array.isArray(d?.files) ? d.files.length : 0} 个文件`,
  // ★ 压缩来源（需求 ②③）：四条入口都压同一种压缩，**但它们是四条不同的路**。
  //   不记来源的话，"这次是自动 70% 压的，还是我手动敲的"事后查不出来 ——
  //   而事后查询正是日志存在的理由。来源由插件在 `state.hfSource` 里**当场**记下
  //   （`session/event` 里拿不到它，因为 `compaction/end` 是内核发的，它不知道谁发起）。
  "compaction/end": (d, extra) => {
    const src = extra?.hfSource;
    // ★★★★★ 2026-10-13（D163）：**映射表收成一个出口**（`hfSourceShort`）。
    //   ★ 为什么必须收：这里原来是**第二张**「内部键 → 中文标签」的映射表，
    //     而索引行那边是**第一张**（直接插值 ⇒ 漏了翻译）。两张表 = 必然分叉
    //     —— D159 修的就是"三处各自写死同一个值"，这里是同一个病的另一面。
    //   ⚠️ 保留 `undefined ⇒ ""` 这条**既有契约**（26a 钉着它）：
    //     没有来源时退化成「上下文已压缩」，不造词、也不写「未知来源」。
    const label = src === undefined ? "" : hfSourceShort(src);
    return label === "" ? "上下文已压缩" : `上下文已压缩（${label}）`;
  },
  "workspace/changes": () => "工作区有变更",
  // ★ `turn/end` 的 `reason` 是**对象**不是字符串：实测 615 条里全是
  //   `{kind:"completed"|"error"|"aborted"|"interrupted"|"max-tokens"}`。
  //   旧代码写 `typeof d.reason === "string"`，那个分支**永远不成立** ⇒
  //   日志一直在丢这个信息（而且丢得看不出来，因为括号只是没出现）。
  "turn/end": (d) => {
    const kind = d?.reason?.kind;
    return `回合结束${typeof kind === "string" && kind !== "" ? `（${kind}）` : ""}`;
  },
  // ★★★ 2026-10-10 修（**实测才发现的**）：`command/done` 的载荷是
  //   `{ commandId, kind, text?, sourceEventSeq? }` —— **没有 `name`**！
  //   （见内核 `dsh-api-session-controller` 的 `SessionEventMap` 声明；
  //     命令名在**另一条**事件 `command/run` 上。）
  //   ⇒ 旧代码 `d?.name` 恒为 undefined ⇒ 日志里**每一条都写成 `命令 /?`**。
  //   ★ 这个 bug 抓法：去一个真实项目的日志里看，10 条 command/done
  //     全是 `命令 /? → success|error` —— 记录**存在**但**没有信息量**。
  //   ★ 修法：`command/run` 时把 `commandId → name` 存进 `commandNames`，
  //     `command/done` 里用 `commandId` 反查。查不到就如实写"（未知名）"，
  //     不假装知道。第三个参数 `ctxExtra` 由 `consume` 传进来。
  "command/done": (d, extra) => {
    const id = typeof d?.commandId === "string" ? d.commandId : "";
    const nm = id === "" ? undefined : extra?.commandNames?.get(id);
    const label = typeof nm === "string" && nm !== "" ? `/${nm}` : "（未知名）";
    const kind = typeof d?.kind === "string" ? d.kind : "完成";
    return `命令 ${label} → ${kind}`;
  },
  "session/end-seed": () => "会话建立",
};

// ═══════════════════════════════════════════════════════════════════════════
// 问题记录（★ "不是项目、但需要记"的那一类）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么需要它：本机实测 **112 个会话里 104 个的 cwd 就是容器根**
//   （如一个汇总工作区）—— 也就是说绝大多数会话根本不是"某个项目"，
//   而是"修一个问题 / 调研一件事 / 排查一次故障"。旧版本的做法是判出容器后
//   **只说"别在这里初始化"就没有下文了**，等于把 93% 的会话直接扔下。
//
// ★ 为什么"问题"不该用台账：台账的四条硬约束（活跃台账 / 独立决策记录 /
//   归档目录 / ≤150 行）全部是为**要持续维护的当前状态**设计的。而一个问题有**终点**。
//   硬塞进去会同时坏掉两边 —— 台账被一次性内容稀释，问题本身也不需要
//   "当前目标 / 下一步 / 归档"这些字段。
//
// ★ 与台账的分工（判据只有一条：**有没有累积状态**）：
//
//     有累积状态（会一直改、要接上、要回顾）  ⇒ 台账（ledger）
//     一次性、有终点、只需要"下次别踩"      ⇒ 问题记录（note）
//
// ★ 记在哪：默认跟着**工作区已有的那条通道**走 —— `60-对话记录与交接\对话总结\`
//   命名 `YYYY-MM-DD-主题.md`（本机已有 27 份在用，规矩写在工作区 AGENTS.md §4）。
//   新功能顺着它，而不是另起一个散落的地方。
//   `notesDir` 登记在清单里，所以也可以改成任何别的目录。

/** 问题记录的默认目录（相对**容器根/工作区根**）。 */
const DEFAULT_NOTES_DIR = "60-对话记录与交接/对话总结";

/** 问题记录目录的保守候选名（没登记 notesDir 时按这些名字找）。 */
const NOTE_DIR_CANDIDATES = [
  "60-对话记录与交接/对话总结",
  "60-对话记录与交接",
  "对话总结",
  "_问题记录",
  "_notes",
];

/** 一条问题记录的默认分类。分类只影响用哪个二级标签，不影响能不能写。 */
const NOTE_KINDS = ["问题", "调研", "故障", "决定", "其他"];

/**
 * ★★★ 交接单的**约定目录**（相对项目根）。
 *
 * 为什么要有约定（2026-10-10，用户定的方向：*"专注于记忆的重构"*）：
 *   原来回合末卡片的文案是"建议放在项目里的 docs/ 或交接单目录" ——
 *   **位置是模糊的**，于是：
 *   · 同一个项目里，两次交接可能落在两个不同的地方；
 *   · 新会话**不知道去哪找**，`renderCapsule` 里那行"上一次交接单"因此
 *     只能做成**参数**（`opts.handoffRel`）—— 而**没有任何地方传它** ⇒
 *     那是一行**死代码**，从来没显示过。
 *   ★ 教训：**做成参数，就会有人忘记传。** 所以现在放进 `inspect()` 统一解析。
 */
const DEFAULT_HANDOFF_DIR = "_handoff";

/**
 * 交接单目录的候选名（登记优先，其次按这些名字找**已存在**的目录）。
 *
 * ★ 顺序有意义：`_handoff` 是我们自己的约定；后面几个是"别人已经在用的名字"，
 *   找到了就顺着它，不另起一个散落的地方（与 `NOTE_DIR_CANDIDATES` 同一套思路）。
 */
const HANDOFF_DIR_CANDIDATES = ["_handoff", "handoff", "交接单", "交接", "docs/交接单"];

/** 交接单文件名：`YYYY-MM-DD-HHmm-主题.md`（日期在前 ⇒ 目录里天然按时间排序）。 */
function handoffFileName(now, title) {
  const p = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}`;
  const safe = String(title ?? "")
    .replace(NOTE_BAD_CHARS_RE, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${date}-${time}-${safe === "" ? "交接" : safe}.md`;
}

/**
 * 找出交接单目录里**最新的一份**（按文件名排序 —— 文件名日期在前，所以字典序 = 时间序）。
 *
 * ★ 为什么按**文件名**而不是 mtime：文件名是我们自己生成的、带日期时间；
 *   而 mtime 会被"复制 / 恢复备份 / 改个错字"这类动作搅乱。用文件名更稳。
 * ★ 只认 `.md`，且跳过明显的模板/草稿（`_` 开头）。
 * @returns {string|undefined} 相对项目根的路径；没有就 undefined
 */
function latestHandoffIn(projectRoot, handoffAbs) {
  let entries;
  try {
    entries = fs.readdirSync(handoffAbs, { withFileTypes: true });
  } catch {
    return undefined; // 目录还不存在 = 还没写过交接单，正常
  }
  const names = entries
    .filter((e) => e.isFile() && /\.md$/i.test(e.name) && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort(); // 字典序 = 时间序（文件名 `YYYY-MM-DD-…` 在前）
  if (names.length === 0) return undefined;
  return toGitRel(projectRoot, path.join(handoffAbs, names[names.length - 1]));
}



/** 一条问题记录的文件名里不允许出现的字符（Windows + 跨平台保险）。写成 `-`。 */
const NOTE_BAD_CHARS_RE = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * 生成问题记录的文件名：`YYYY-MM-DD-主题.md`。
 *
 * ★ 日期在**前**：这样目录里天然按时间排序，与既有 27 份的命名完全一致。
 *   若把主题放前面，同一件事跨几天就会散落到不同位置。
 */
function noteFileName(now, title) {
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const slug = String(title ?? "")
    .replace(NOTE_BAD_CHARS_RE, "-")
    .replace(/[\s\u3000]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return `${date}-${slug === "" ? "未命名" : slug}.md`;
}

/**
 * 渲染一份新问题记录的正文。
 *
 * ★ 刻意**不是**台账那套结构（当前目标 / 下一步 / 归档）：
 *   问题的结构是"现象 → 根因 → 结论 → 下次注意"。少了"根因"这一节，
 *   这份记录就退化成一份日记，下周再遇到同样的问题还是得从头查一遍。
 */
function renderNote({ title, kind, problem, cause, conclusion, actions, files, related }, stampText) {
  const section = (head, body) =>
    body === undefined || String(body).trim() === "" ? `## ${head}\n\n（未填）\n` : `## ${head}\n\n${String(body).trim()}\n`;
  return (
    `# ${title}\n\n` +
    `> 类型：${kind} ｜ 记录于 ${stampText}\n` +
    `> 这是一份**问题记录**，不是项目台账 —— 它有终点，所以没有"下一步 / 归档"。\n\n` +
    section("现象 / 要解决什么", problem) +
    "\n" +
    section("根因", cause) +
    "\n" +
    section("结论", conclusion) +
    "\n" +
    section("做过什么", actions) +
    "\n" +
    section("涉及的文件", files) +
    "\n" +
    section("相关记录", related)
  );
}

/**
 * 找容器根（工作区根）。
 *
 * ★ 为什么往上找：问题记录要落在**工作区**的 60-对话记录与交接\ 里，而会话 cwd
 *   可能是工作区的任意子目录。只有从 cwd 往上找到"带 AGENTS.md 且有多个子目录"
 *   的那一层，才能保证同一个工作区里的会话都写进同一处 ——
 *   否则在子目录开会话就会在子目录里另起一份散落的记录。
 *
 * ★ 必须有上限与"不许越过有 .git 的目录"：一个项目内部的小记不该跑到项目外面去。
 */
function findWorkspaceRoot(start, maxUp) {
  const limit = Number.isFinite(maxUp) && maxUp > 0 ? Math.floor(maxUp) : 3;
  let dir = path.resolve(start);
  let best;
  for (let i = 0; i <= limit; i += 1) {
    // 撞到 Git 仓库就停：那是项目自己的边界，不该再往上找。
    try {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
    } catch {
      /* 读不了就当没有 */
    }
    if (findContainerMarker(dir) !== undefined && countChildDirs(dir) >= CONTAINER_MIN_SUBDIRS) {
      best = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════════════════
// 台账合规性检测（用户提议：给已有项目做台账重构）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 需求原话：「允许对已经存在的项目进行台账重构……检测到这个工作区的台账
//   不是我们计划中这样的话就弹一个选择，是否进行这样的改造」。
//
// ★★ 设计前先做了实地勘察（2026-10-08，扫整个容器工作区），
//    结论**推翻了我原本打算用的判据**，记在这里免得后人重犯：
//
//    · 「像台账但没登记」的项目实际是 **0 个**。用宽松启发式（名字或内容里出现
//      目标/已完成/下一步）能匹配到 24 份，但绝大多数是误报 ——
//      README、CHANGELOG、交接单、调研报告、备份。
//    · 唯一真正像台账的那份（上传器 `进度台账-2026-10-01-….md`，249 行）
//      开头写着「✅ 已完成…保留下来当这一轮的工作底稿」—— **那是历史档案**，
//      改造它反而是破坏。
//    · 而**真正"不符合计划"的样本就是已登记的那两个项目**：都缺 `revision`；
//      本项目自己的台账还**超过了自己声明的行数上限**
//      （157 行 / 清单写 150 —— 改默认值 300 时没同步更新清单）。
//
//   ⇒ 所以**不做**"猜哪个文件是台账、然后改它"（猜错的代价是破坏用户文档）。
//     做的是**合规检测 + 把该修的列清楚 + 弹卡片问要不要修**。
//     修复本身**只做加法**：补清单字段、补缺失的空文件/空目录，
//     **绝不改写、绝不删除用户已有的任何内容**。

/** 合规判定结果。 */
const CONFORMANCE = {
  OK: "ok",
  UPGRADEABLE: "upgradeable",
  NONCONFORMING: "nonconforming",
  NONE: "none",
};

/**
 * 判一个项目的台账**是否符合本插件的计划**。
 *
 * @returns {{verdict:string, reasons:string[], fixable:string[], needsAI:string[],
 *            deFacto?:{name:string,lines:number}}}
 *   - `fixable`：**能自动修**的（只做加法：补清单字段、补空文件/空目录）
 *   - `needsAI`：**要 AI 判断**的（超阈值要挑条目归档、结构要重新设计）
 */
function conformanceOf(info) {
  const reasons = [];
  const fixable = [];
  const needsAI = [];
  /**
   * 仅供参考的提示：**不影响判定**。
   *
   * ★ 为什么单列一个数组（2026-10-08 自查发现的两处同类错误）：
   *   判据是 `reasons.length === 0` ⇒ 往 `reasons` 里塞的任何东西都会**让卡片弹出来**。
   *   于是我把两个「本来没人需要拍板」的东西错塞了进去：
   *     · `revision` 缺失 —— 它**会自愈**（`bumpRevision` 是 `manifestRevision(prev)+1`，
   *       而 `manifestRevision(undefined)` 返回 0 ⇒ 下次写入自动补成 1）。
   *       为一个自己会好的字段弹卡片让人决定，是**把可自动处理的事变成人的工作量**。
   *     · 未启用活动日志 —— 它在设计上就是**可选**的（清单没登记就不采集）。
   *   两处都是同一类错：**把"可选/自愈"当成"不符合"**。
   *   用户上次的原话（否决"版本不一致就拒绝"）说的就是这个道理。
   */
  const notes = [];

  // ── 没有登记任何台账 ───────────────────────────────────────────────────
  if (info.activeRel === undefined) {
    // ★ 容器工作区不是"新项目"，**不能**建议在这里 ledger_init（闸门会拒，
    //   而且在那里 git init 会把所有子项目卷进一个错误的父仓库）。
    //   实测（2026-10-08）第一版把容器根也报成 `none` + 建议 ledger_init —— 那是错的引导。
    const isContainer =
      info.isGitRepo !== true &&
      (info.containerMarker !== undefined || info.nestedRepo !== undefined);
    if (isContainer) {
      return {
        verdict: CONFORMANCE.NONE,
        reasons: [
          "这是**容器工作区**（装着多个项目），不是一个项目本身" +
            (info.containerMarker !== undefined ? `：有标志文件 \`${info.containerMarker}\`` : "") +
            (info.nestedRepo !== undefined ? `：子目录里有仓库 \`${info.nestedRepo}\`` : ""),
        ],
        fixable: [],
        needsAI: [
          "**不要**在这里建台账。若用户想给台账，先问清是哪个**子项目**，" +
            "再在那个子目录里初始化（或给 `ledger_init` 传 `root` 点名它）",
        ],
        notes,
      };
    }
    // 保守地找"事实上的台账"：**只在项目根**、名字必须像台账。
    // ★ 刻意不做内容启发式：Gelheim 的 README 里就有「已完成 / 下一步」结构，
    //   按内容判会把**面向人的 README** 认成台账并去"改造"它 —— 那是破坏。
    const deFacto = info.isGitRepo ? findDeFactoLedger(info.projectRoot) : undefined;
    return {
      verdict: CONFORMANCE.NONE,
      reasons: ["这个项目还没有登记台账结构"],
      fixable: [],
      needsAI: ["要由 AI 设计一套结构（用 ledger_init）"],
      notes,
      ...(deFacto === undefined ? {} : { deFacto }),
    };
  }

  // ── 已登记：逐条对硬约束 ───────────────────────────────────────────────
  //
  // ★★ 这里必须区分「**登记过的**」与「**猜到的**」（`inspect` 给了
  //    `decisionsSource` / `archiveSource` = "manifest" | "guess" | "none"）。
  //    只看 `xxxRel !== undefined` 会漏判：清单里根本没写 `decisions`，
  //    但目录里恰好有个 `DECISIONS.md` ⇒ `guessDecisions` 把它猜出来了，
  //    `xxxRel` 于是非空 ⇒ 被判成"合规"。**实测撞到**（情形 21 的 fixture 就这样）。
  //
  //    为什么"猜到"也算不合规：猜测是**本次会话碰巧成立**的推断，
  //    换个机器/换次状态就可能猜不到，于是"关键决策记录"这条硬约束**无声失效**
  //    （而且它会散架在别人手里，不是现在）。登记的才可靠。
  if (!info.activeExists) {
    reasons.push(`活跃台账 \`${info.activeRel}\` 读不到`);
    needsAI.push("活跃台账文件缺失，需要重建内容");
  }
  // ★ 两种不合格都要抓：**没登记**（只猜到）与**登记了但文件不在**。
  //   只判 source 会漏掉后者：清单写着 `decisions: "DECISIONS.md"`、文件却不存在时，
  //   `source` 是 "manifest" 看着没问题，而硬约束要求的"独立决策记录"**实际不存在**。
  //   （情形 21b 实测撞到。）
  {
    const abs =
      info.decisionsRel === undefined ? undefined : path.resolve(info.projectRoot, info.decisionsRel);
    const exists = abs !== undefined && isUnder(info.projectRoot, abs) && fs.existsSync(abs);
    if (info.decisionsSource !== "manifest" || !exists) {
      reasons.push(
        info.decisionsRel === undefined
          ? "**没有**独立的关键决策记录（四条硬约束之一）"
          : !exists
            ? `清单登记了关键决策记录 \`${info.decisionsRel}\`，但**该文件不存在**（硬约束之一）`
            : `关键决策记录 \`${info.decisionsRel}\` **没有登记在清单里**，只是按名字猜到的（硬约束之一）`
      );
      fixable.push(
        info.decisionsRel === undefined
          ? "创建一个空的决策记录文件（不覆盖任何已有内容）"
          : exists
            ? `把 \`${info.decisionsRel}\` **登记进清单**（文件已存在，一个字都不动）`
            : `创建一个空的决策记录 \`${info.decisionsRel}\``
      );
    }
  }
  {
    const abs =
      info.archiveRel === undefined ? undefined : path.resolve(info.projectRoot, info.archiveRel);
    const exists = abs !== undefined && isUnder(info.projectRoot, abs) && fs.existsSync(abs);
    if (info.archiveSource !== "manifest" || !exists) {
      reasons.push(
        info.archiveRel === undefined
          ? "**没有**归档目录（四条硬约束之一）"
          : !exists
            ? `清单登记了归档目录 \`${info.archiveRel}\`，但**该目录不存在**（硬约束之一）`
            : `归档目录 \`${info.archiveRel}\` **没有登记在清单里**，只是按名字猜到的（硬约束之一）`
      );
      fixable.push(
        info.archiveRel === undefined
          ? "创建归档目录（只追加不删除）"
          : exists
            ? `把 \`${info.archiveRel}\` **登记进清单**（目录已存在，不动它）`
            : `创建归档目录 \`${info.archiveRel}\``
      );
    }
  }
  if (info.overThreshold) {
    reasons.push(
      `活跃台账 ${info.activeLines} 行，**超过自己声明的上限** ${info.maxActiveLines} 行`
    );
    needsAI.push(
      `台账超限 ${info.activeLines - info.maxActiveLines} 行，需要 AI 挑最旧的已完成条目 ` +
        "用 ledger_archive 移进归档（插件不替它决定删什么）"
    );
  }

  // ── 以下都**只提示、不影响判定** ───────────────────────────────────────
  if (info.manifest?.revision === undefined) {
    // 会自愈，所以不进 reasons；但既然要修别的，顺手补上也无害。
    notes.push("清单缺 `revision` 字段（多会话写入保护靠它判新旧）—— **下次写台账会自动补上**，不必特意处理");
    fixable.push("给清单补 `revision: 0`（纯加字段；就算不补，下次写入也会自动补）");
  }
  if (info.logRel === undefined) {
    notes.push("未启用活动日志（**可选**功能，缺它不算不符合计划）");
  }

  if (reasons.length === 0) {
    return { verdict: CONFORMANCE.OK, reasons, fixable, needsAI, notes };
  }
  const verdict = needsAI.length > 0 ? CONFORMANCE.NONCONFORMING : CONFORMANCE.UPGRADEABLE;
  return { verdict, reasons, fixable, needsAI, notes };
}

/**
 * 在项目**根目录**找一份"事实上的台账"（保守命名）。
 *
 * ★ 只在根目录找，不下钻：子目录里的 `进度台账-….md` 往往是**某一轮的工作底稿**
 *   （实测那份 249 行的就是，而且开头标明已完成）—— 那种是历史档案，不该被接管。
 * ★ 排除 README / AGENTS / CHANGELOG / 交接单：它们各有用途，不是台账。
 */
function findDeFactoLedger(projectRoot) {
  const EXCLUDE = /^(readme|agents|claude|changelog|changes|license|handoff|交接|说明|index)\./i;
  let entries;
  try {
    entries = fs.readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/\.(md|markdown|txt)$/i.test(e.name)) continue;
    if (EXCLUDE.test(e.name)) continue;
    // 名字里要明确带"台账 / ledger / 进度 / 状态"这类词。
    if (!/(台账|ledger|进度|状态|status|progress)/i.test(e.name)) continue;
    let lines = 0;
    try {
      lines = countLines(readTextSafe(path.join(projectRoot, e.name)) ?? "");
    } catch {
      /* 读不到就当 0 行 */
    }
    return { name: e.name, lines };
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// 纯函数区（不碰 ctx、不碰服务）
// ═══════════════════════════════════════════════════════════════════════════

/** 把任意值渲染成一条 text ContentBlock。 */
function textOut(value) {
  return [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ];
}

/** 统一的中文错误信息。 */
function fail(message) {
  return new Error(String(message));
}

/**
 * 目标是否在 root 之内（含 root 自身）。
 *
 * ★ 这条是本插件**唯一**的路径安全闸门：所有读写都先过它。
 *   用 path.relative 判定而不是字符串前缀 —— 前缀判定会被
 *   `D:\proj-evil` 冒充 `D:\proj` 骗过去（session-workspaces 已踩过同类坑）。
 */
function isUnder(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  const rel = path.relative(r, t);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 数行数（末尾换行不算多一行）。 */
function countLines(text) {
  if (typeof text !== "string" || text === "") return 0;
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
}

/** 读文本；不存在或读不了 ⇒ undefined（**永不抛**）。 */
function readTextSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** 确保目录存在。 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 转成 Git 友好的相对路径（相对项目根，正斜杠）。 */
function toGitRel(projectRoot, abs) {
  return path.relative(projectRoot, abs).split(path.sep).join("/");
}

/** 当期归档子目录：`YYYY-MM/weekN`。 */
function archiveStamp(now, weekMode) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const mm = String(m).padStart(2, "0");
  // ★ weekMode 决定 weekN 的算法。默认 "month"（week-of-month，1..5）——
  //   路径里已经有 YYYY-MM 了，再放"年内第几周"会让两段信息冗余；
  //   放"月中第几周"才是与 YYYY-MM 互补的那个读法。
  const week =
    weekMode === "year"
      ? Math.ceil(
          ((now - new Date(y, 0, 1)) / 86400000 + new Date(y, 0, 1).getDay() + 1) / 7
        )
      : Math.floor((d - 1) / 7) + 1;
  return { dir: `${y}-${mm}/week${week}`, label: `${y}-${mm} week${week}` };
}

/** 时间戳（本地，精确到分）。 */
function stamp(now) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

/** 时间戳（本地，精确到秒）—— 日志用：同一分钟内可能有很多条。 */
function stampSec(now) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${stamp(now)}:${pad(now.getSeconds())}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 设置面板的后端（HTTP 小工具 + 读写）
// ═══════════════════════════════════════════════════════════════════════════
//
// 形状抄自本工作区已验证的两处：另一个插件的 `lib/index.js` 与
// `7.模型路由/lib/index.js`（都是 `webServer.register` + `sendJson` + `readBody`）。
// ★ 这里**不复用**它们的文件（那是别的插件，跨插件 import 会把两个插件的生命周期绑死），
//   但形状保持一致 —— 本机排障时一眼就认得。

/** 设置路由的前缀。带包名，绝不可能撞上别人的路由。 */
const SETTINGS_PREFIX = `/${name}-settings`;

/** 发一个 JSON 响应。响应头与那个插件同款（`no-store` + `nosniff`）。 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      // 面板与宿主同源，但显式写清，免得将来被别处引用时跨站读到设置。
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  } catch {
    /* 响应已发出 / 连接已断：再抛也无人可报。 */
  }
}

/** 读请求体（带上限，防一个畸形请求把内存吃光）。 */
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`请求体过大（上限 ${limit} 字节）`));
        try {
          req.destroy();
        } catch {
          /* 已经断了。 */
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * 把 handler 包一层：同步抛与异步 reject 都变 500 JSON，**并且透传返回值**。
 *
 * ★ 为什么透传返回值：HTTP 服务器不关心返回值，但**自检要** ——
 *   不透传的话 `await handler(req, res)` 立刻返回（此时响应还没写），
 *   自检只能靠轮询猜"写完了没"。那种测试是脆的（那个插件的注释里记着这条）。
 */
function handleFor(handler) {
  return (req, res) => {
    try {
      const r = handler(req, res);
      if (r && typeof r.catch === "function") {
        return r.catch((e) => sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }));
      }
      return r;
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      return undefined;
    }
  };
}

/**
 * 算出面板要显示的**当前状态**。
 *
 * @returns {{settings: object, specs: Array, writable: boolean, why?: string, source?: string}}
 *
 * ★ 为什么要 `writable` + `why`：没有 `configEditor` 时面板**只能看不能改**。
 *   那时候必须**明说原因**，而不是画一堆点了没反应的控件 ——
 *   后者会让用户以为是面板坏了（本机在别处踩过"看起来装了但什么也没有"）。
 */
function deriveSettingsView(ctx) {
  const editor = typeof ctx?.get === "function" ? ctx.get("configEditor") : undefined;
  const out = {
    settings: currentSettings(),
    // ★ `options` 是**取值函数**（见 SETTING_SPECS 上的 TDZ 注释）：出站给客户端前
    //   必须**展开成数组**，否则 `{...s}` 会带一个函数过去 —— `JSON.stringify`
    //   直接把它丢掉，面板上那个选择器就成了空的，而且**不报错**。
    specs: SETTING_SPECS.map((s) => ({
      ...s,
      ...(typeof s.options === "function" ? { options: s.options() } : {}),
    })),
    // ★ D124：分组也一起出站（面板按它画分组标题与说明）。
    //   ★ 客户端**不认任何 key**、只按 `spec.group` 归组 ⇒ 以后加组只改这里。
    groups: SETTING_GROUPS.map((g) => ({ ...g })),
    defaults: settingDefaults(),
    writable: false,
  };
  if (editor === undefined) {
    out.why = "本机没有 configEditor 服务，面板只能查看、不能保存。";
    return out;
  }
  try {
    const hit = findSettingsEntry(editor);
    if (hit === undefined) {
      out.why = "没有在组合里找到本插件的配置行，面板只能查看、不能保存。";
      return out;
    }
    out.writable = true;
    // ★ 回报**生效值**（而非内存里的那份）：这样"面板显示什么"与
    //   "内核实际在用哪份配置"是同一件事，不会出现面板说改了、内核没改。
    out.settings = settingsOf(hit.entry?.options?.config ?? hit.current ?? {});
    out.source = "loader-entry";
  } catch (e) {
    out.why = `读取配置行失败：${String((e && e.message) || e)}`;
  }
  return out;
}

/**
 * 在 `configEditor.entries()` 里找**本插件**那一行。
 *
 * ★ 匹配判据用**包名**（`entry.options.name === name`），不用 id：
 *   id 是 patch 里写的短名（本插件是 `dsh-ledger-memory`），
 *   而 profile 的 patch 层允许别人用别的 id 引入同一个包 ——
 *   按包名找才不会漏（`configEditor` 的注释也明说"nested Includes have independent
 *   configuration ownership"，所以**取第一个匹配**而不是"唯一一个"）。
 */
function findSettingsEntry(editor) {
  const list = typeof editor?.entries === "function" ? editor.entries() : [];
  if (!Array.isArray(list)) return undefined;
  for (const entry of list) {
    if (entry?.options?.name === name) return { entry, current: entry.options.config };
  }
  return undefined;
}

/**
 * 安装设置路由，返回 `{registered, failures}`（**不抛**）。
 *
 * 两条路由：
 *   `GET  <prefix>/config.json` ⇒ 当前设置 + 元数据（面板渲染用）
 *   `POST <prefix>/config.json` ⇒ 落盘（走 `configEditor.edit()`）
 *
 * @param {object} scope 注入了 `webServer` 的那个 ctx
 * @param {() => object} view 取当前视图（测试可注入假的）
 */
function installSettingsRoutes(scope, view) {
  const registered = [];
  const failures = [];
  const reg = (p, handler) => {
    try {
      const dispose = scope.webServer.register({
        kind: "exact",
        path: SETTINGS_PREFIX + p,
        handler: handleFor(handler),
      });
      registered.push(SETTINGS_PREFIX + p);
      return typeof dispose === "function" ? dispose : () => {};
    } catch (e) {
      // ★ 注册失败**必须留痕**：静默吞掉的症状是"面板一片空白还不报错"，
      //   那正是本工作区反复强调要避免的失败模式。
      failures.push(`注册路由 ${p} 失败：${String((e && e.message) || e)}`);
      return () => {};
    }
  };

  reg("/config.json", (req, res) => {
    if (req?.method === "POST") return saveSettings(scope, req, res);
    const v = view();
    sendJson(res, 200, { ok: true, ...v });
  });

  return { registered, failures };
}

/**
 * 保存设置：解析请求体 → 校验 → 走 `configEditor.edit()` 落盘 → 回报生效值。
 *
 * ★★ 为什么必须经 `configEditor.edit()`（而不是自己写 profile 的 patch 文件）：
 *   ① 那是**官方家目录**里的东西（红线§九.1），插件不许直接改；
 *   ② `edit()` 会走**正常的 Loader 协调流程**（校验 + 热重载），
 *      自己写文件绕过了它 ⇒ 内存配置与磁盘文件不一致，直到重启才暴露。
 */
function saveSettings(scope, req, res) {
  return (async () => {
    let patch;
    try {
      const raw = await readBody(req);
      const parsed = raw === "" ? {} : JSON.parse(raw);
      patch = parsed?.settings ?? parsed;
    } catch (e) {
      sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${String((e && e.message) || e)}` });
      return;
    }
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      sendJson(res, 400, { ok: false, error: "settings 必须是一个对象。" });
      return;
    }

    const editor = typeof scope?.get === "function" ? scope.get("configEditor") : undefined;
    if (editor === undefined) {
      sendJson(res, 503, { ok: false, error: "本机没有 configEditor 服务，无法保存（插件功能不受影响）。" });
      return;
    }
    let hit;
    try {
      hit = findSettingsEntry(editor);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: `读取配置行失败：${String((e && e.message) || e)}` });
      return;
    }
    if (hit === undefined) {
      sendJson(res, 404, { ok: false, error: "没有找到本插件的配置行，无法保存。" });
      return;
    }

    // ★ 校验**在写盘之前**：非法值一律 400，绝不落盘。
    //   （内核之后还会用 `Config` 校验一遍，那是第二道闸；这里先给出**可读的**错误。）
    const check = normalizeSettings({ ...currentSettings(), ...patch });
    if (check.ok !== true) {
      sendJson(res, 400, { ok: false, error: check.reason });
      return;
    }

    try {
      await editor.edit(hit.entry, (current, inherited) => {
        // ★★ 只合并 `current`（本行**自己**的显式值）+ 本次补丁，**绝不并入 `inherited`**。
        //
        // ★ 这一条是读完内核 `dsh-config-editor/lib/index.js` 之后改的
        //   （原来写的是 `{ ...inherited, ...current }` —— 那是个**真 bug**）：
        //   `inherited` 是**上层**（家级 patch / bundle 层）给的值。把它并进来写下去，
        //   等于把上层的值**钉死在 profile 这一层**。
        //   内核 README 逐字警告过这件事：
        //     *"完整配置覆盖保留普通字段，但会在 profile 层**固定其当前原始值**"*
        //   ⇒ 后果：① 平白在 profile 里抄一份别人的值；
        //           ② 从此**上层再改也改不动它**（profile 层覆盖了上层）——
        //              而那正是"一个事实两个出口"的经典坏味道。
        //   ★ `inherited` 仍然有用，但用途是**计算当前生效值**（见上面 `check`），
        //     不是**写回**。
        //
        // ★ 为什么还要合并 `current`：本行可能已经有别的键（例如别人往这一行加过字段），
        //   整份替换会抹掉它们。只并 `current` 就够 —— 那才是"本层已有的东西"。
        const base = { ...(current ?? {}) };
        return { ...base, ...patch };
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: `保存失败：${String((e && e.message) || e)}` });
      return;
    }

    // ★ 立刻把内存里的设置换成新的：不等下一次 `apply`。
    //   不然会出现"面板说保存成功、行为还是旧的"这段窗口。
    setActiveSettings(check.value);
    sendJson(res, 200, {
      ok: true,
      saved: patch,
      settings: check.value,
      ...(check.dropped.length === 0 ? {} : { dropped: check.dropped }),
      ...(check.clamped.length === 0 ? {} : { clamped: check.clamped }),
    });
  })();
}

// ── 活动日志的纯函数（都不碰 ctx，便于单独推理与自检）────────────────────

/**
 * `parseLevels` 的**兜底档位**：清单里没登记时用什么。
 *
 * ★★ 与"行数上限"是同一个口径（见 `inspect` 里那段注释）：
 *   ① **项目清单里有 `logLevels`** ⇒ 以它为准；
 *   ② 没有 ⇒ 用**插件级设置**里的档位（用户可在设置面板调）。
 *   ⇒ 于是"设置面板的日志开关"= **新项目的默认档位**，而不是"远程覆盖掉项目自己的选择"。
 *     后者会让一个项目已经开始（或没开始）采集的档位随全局设置漂移，
 *     而日志是**只追加的证据**：档位突变会让"某个时间段为什么没有 L2"变得无法解释。
 */
function defaultLogLevels() {
  return currentSettings().logLevels;
}

/**
 * 归一化档位设置。接受 `{L0:true,...}` / 数组 / undefined。
 * ★ 返回的**始终是四项齐全**的对象：开关判断点因此不必到处写 `?.` 兜底。
 */
function parseLevels(raw, fallback) {
  const base = { ...(fallback ?? defaultLogLevels()) };
  if (raw === undefined || raw === null) return base;
  if (Array.isArray(raw)) {
    for (const k of LOG_LEVEL_NAMES) base[k] = raw.includes(k);
    return base;
  }
  if (typeof raw === "object") {
    for (const k of LOG_LEVEL_NAMES) {
      if (typeof raw[k] === "boolean") base[k] = raw[k];
    }
  }
  return base;
}

/** 这一档现在开着吗（清单缺省 = 插件级设置的默认档位）。 */
function levelOn(info, level) {
  const levels = parseLevels(info?.manifest?.logLevels, defaultLogLevels());
  return levels[level] === true;
}

/** 日志根目录（相对路径）：清单里没登记就不采集（**绝不擅自往项目里塞目录**）。 */
function logDirOf(info) {
  const d = info?.manifest?.logDir;
  return typeof d === "string" && d !== "" ? d : undefined;
}

/**
 * 一条日志落到哪个文件（相对项目根的路径）。
 *
 * ★ 按周分桶、与 `ledger_archive` **共用同一个期间键**（`archiveStamp`）——
 *   这样"2026-10 第 2 周发生了什么"能一次同时读到该周的归档台账条目与日志。
 *   两条时间线的分桶若各算各的，回溯时就必然对不上。
 */
function logFileRel(info, level, now) {
  const dir = logDirOf(info);
  if (dir === undefined) return undefined;
  const { dir: period } = archiveStamp(now, info?.manifest?.archiveWeekMode);
  return `${dir}/${period}/${LOG_LEVEL_FILES[level]}`;
}

/**
 * 日志行格式：`- 2026-10-08 10:23:41 (kind) 正文`
 *
 * ★ 刻意是**面向人的 markdown**、不是 JSONL：日志要能被 `read`/`grep` 直接看，
 *   而 grep 恰好就是回溯时最常用的手段。二进制/JSONL 会让 grep 结果不可读。
 *   代价是解析要按格式约定来 —— 因此解析器是**容错**的：认不出的行照样返回，
 *   只是没有结构化字段（宁可回一堆原文，也不要"读不到"）。
 */
const LOG_ENTRY_RE = /^-\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(?:\(([^)]*)\)\s*)?(.*)$/;

/** 把一条日志原文解析成结构化条目。认不出就只给 raw。 */
function parseLogLine(level, raw) {
  const m = LOG_ENTRY_RE.exec(raw);
  if (m === null) return { level, raw, at: undefined, kind: undefined, text: raw };
  return { level, raw, at: m[1], kind: m[2] === undefined || m[2] === "" ? undefined : m[2], text: m[3] };
}

/**
 * 把一个 `user/message` 事件的 content 拍平成**一行**给人看的正文。
 *
 * ★ 为什么换行要转义成字面 `\n`：日志的硬不变量是「**一行 = 一条**」
 *   （解析、grep、limit、nextCursor 全建立在它上面）。用户消息**经常是多行的**
 *   （实测 769 条里 72 条含换行、8 条换行超过 50 个），原样写进去会把一条消息
 *   炸成几十行 —— 正是 L1 当初踩过的那个坑（见 `writeLog` 的注释）。
 *   转义而不是丢弃：换行是内容的一部分，`\n` 可读、可 grep、可还原。
 *
 * ★ 为什么非 text 的 part 也要记：实测 769 条里出现过 1 个 `image` part
 *   （带 attachmentId / 尺寸 / 字节数）。只记文字会让"用户发过一张图"这件事
 *   **彻底消失**，而那往往是那一轮的起点。图本身不落盘（尊重红线：不复制附件），
 *   只留一行可追溯的标记。
 */
function renderUserMessageBody(content) {
  const parts = Array.isArray(content) ? content : [];
  const out = [];
  for (const c of parts) {
    const t = c?.type;
    if (t === "text") {
      if (typeof c.text === "string" && c.text !== "") out.push(c.text);
      continue;
    }
    if (t === "image") {
      const a = c.attachment ?? {};
      const dim = Number.isFinite(a.width) && Number.isFinite(a.height) ? `${a.width}x${a.height}` : "?";
      const kb = Number.isFinite(a.bytes) ? `${Math.round(a.bytes / 1024)}KB` : "?";
      out.push(`[图片 ${typeof a.name === "string" ? a.name : "未命名"} ${dim} ${kb}]`);
      continue;
    }
    // 未知 part：留个名字，别把"这里还有东西"这件事吞掉。
    if (typeof t === "string" && t !== "") out.push(`[${t}]`);
  }
  return out
    .join(" ")  // 多个 part 之间用空格，避免把两句话粘成一个词
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "\\n")
    .trim();
}

/**
 * ★★★ 把被胶囊「挤出去」的用户原话**升级归档**（D84 缺陷修复，2026-10-11）。
 *
 * 病因（实测，不是推断）：`capsule.userMessages` 只留**最近 40 条**，
 *   `if (r.userMessages.length > CAPSULE_USER_MSG_MAX) r.userMessages.length = CAPSULE_USER_MSG_MAX;`
 *   —— **超出部分直接丢弃**，不落任何地方。
 *   实测后果：被压掉的 **191** 条真用户原话里，逐字能在载体找回的只有 **24.1%**；
 *   **最早 3 条（含用户最初的完整任务陈述）是 0/3** —— 而那恰是"必须记住"的那一类。
 *
 * ★ 为什么落在 `_ledger-archive/`：它本来就是**只追加、不删除**的目录
 *   （用户认可的语义），天然适合"一旦记住就永不丢"的东西。
 *   ⇒ **不动胶囊的"最近 40 条"轻量语义**，两者各司其职。
 *
 * ★ 为什么按**期间分桶**（`archiveStamp`）：与归档/日志共用同一个期间键，
 *   这样"某一周用户说了什么"三处能对得上（`ledger_log` 也是这么分桶的）。
 *
 * ★ 为什么要**去重标记**：`consume` 会对同一条消息反复经过（例如 hydrate 后再喂），
 *   所以文件里带一个 `<!-- id:… -->` 之类的锚；本函数只做追加，**不读回比对**
 *   （读回比对会让每次淘汰都读一遍整个文件 —— 那是纯浪费，而重复一条原话
 *    远比丢一条原话安全）。
 *
 * @param {string} root 项目根（拿不到就放弃归档，但**绝不抛**）
 * @param {object} info 项目信息（要有 `archiveRel`）
 * @param {{at:string, text:string}} msg 被淘汰的那一条
 * @param {string} [sid] 会话 id（写进去便于溯源）
 */
function archiveEvictedUserMessage(root, info, msg, sid) {
  try {
    if (typeof root !== "string" || root === "") return false;
    const rel = info?.archiveRel;
    if (typeof rel !== "string" || rel === "") return false;
    const text = typeof msg?.text === "string" ? msg.text : "";
    if (text === "") return false;
    const now = new Date();
    const period = archiveStamp(now, info?.manifest?.archiveWeekMode).dir;
    const dir = path.join(root, rel, period);
    const file = path.join(dir, USER_MSG_ARCHIVE_FILE);
    ensureDir(dir);
    const head =
      fs.existsSync(file)
        ? ""
        : `# 用户原话 · 完整存档（**只追加，永不删除**）\n\n` +
          `> ★ 这里放的是**从胶囊里被挤出去的**用户原话（胶囊只留最近 ` +
          `${CAPSULE_USER_MSG_MAX} 条）。\n` +
          `> **胶囊负责"最近的、要进上下文的"；本文件负责"一旦记住就永不丢"。**\n` +
          `> 查法：\`ledger_log({view:"users"})\` 看 **L4**（那是**全量**、含没被挤出去的）；\n` +
          `> 本文件是被挤出去那部分的**兜底副本**，两者互补。\n\n`;
    const line =
      `- ${msg.at ?? stamp(now)} (user${sid === undefined ? "" : `:${String(sid).slice(0, 8)}`}) ` +
      `${text.replace(/\n/g, "\\n")}\n`;
    fs.appendFileSync(file, head + line, "utf8");
    return true;
  } catch {
    // ★ 归档失败**绝不影响**压缩/胶囊主流程（与全文件的吞错纪律一致）。
    return false;
  }
}

/**
 * 渲染一条 L4 用户消息行。
 *
 * 形状与其它档位一致（`LOG_ENTRY_RE` 认得出）：`- <时间> (<kind>) <正文>`，
 * 其中 kind 是 **`user:<会话编号>`** —— 会话编号放进**结构字段**而不是正文，
 * 这样"这条是谁发的"可以按 kind 精确过滤，不必对正文做正则。
 *
 * ★ 时间用**事件自己的 `time`**（用户明确要"发送时间"），不是落盘时刻：
 *   L4 走的是去抖落盘（`LOG_FLUSH_DEBOUNCE_MS`），一轮里攒的多条会在同一个瞬间
 *   一起写下去。若用落盘时刻，那一批消息会**共享同一个时间戳**，顺序与间隔全丢。
 *   实测 `ev.time` 在 769 条上**没有一条不是数字**，所以这个来源可靠；
 *   真遇到坏值就退回当前时刻（宁可时间不准，也不要丢这一条）。
 */
function renderUserMessageLine(content, tag, when) {
  const at = stampSec(when);
  const kind = tag === undefined ? "user" : `user:${tag}`;
  let body = renderUserMessageBody(content);
  let cut = "";
  const umMax = numOf("userMsgMaxChars", USER_MSG_MAX_CHARS);
  if (body.length > umMax) {
    // ★ 截断必须**看得见**：留下原长，否则读者会以为用户就发了这么多。
    cut = ` …（已截断，原文 ${body.length} 字符）`;
    body = body.slice(0, umMax);
  }
  return `- ${at} (${kind}) ${body}${cut}`;
}

/**
 * 从一条 `session/event` 里认出"这是用户本人发的消息"，并取出发送时间。
 *
 * ★ 判据只用 `data.source.kind === "user"`，**不是**"role 是 user"：
 *   本机实测——本插件自己注入的台账、`agent-instructions`、`runtime-context`、
 *   `time-context`、`skill-catalog`、子代理通知等**全都以 `role: "user"` 落盘**，
 *   全局 source.kind 计数是 user 769 / time-context 1396 / agent-instructions 274 …
 *   ⇒ 用 role 判会把系统的每一条注入都记成"用户说的话"，
 *   记出来的东西恰恰**不是**用户说的。
 */
function userMessageOf(event) {
  if (event?.type !== "user/message") return undefined;
  const d = event.data;
  if (d === undefined || d === null || d.source?.kind !== USER_MSG_SOURCE_KIND) return undefined;
  if (d.role !== "user") return undefined;
  const when = Number.isFinite(event.time) ? new Date(event.time) : new Date();
  return { content: d.content, when, id: typeof d.id === "string" ? d.id : undefined };
}

/**
 * L3 的"一行摘要"取自哪里。
 *
 * ★ 实测发现一个白赚的信息：`pwsh` 调用带一个 `description` 字段，是 AI 写的
 *   一句人话（如 "Check environment and plugin directories"）。有它就优先用，
 *   比截 `command` 前 50 字符可读得多 —— 等于 L3 在 shell 这一类上天然带意图。
 */
function briefOf(toolName, rawArgs, cap) {
  let o;
  try {
    o = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
  } catch {
    o = undefined;
  }
  const cand =
    o === undefined || o === null || typeof o !== "object"
      ? String(rawArgs ?? "")
      : (o.description ??
        o.file_path ??
        o.path ??
        o.command ??
        o.pattern ??
        o.query ??
        o.name ??
        o.target ??
        Object.values(o)[0] ??
        "");
  const s = (typeof cand === "string" ? cand : JSON.stringify(cand)).replace(/\s+/g, " ").trim();
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

/**
 * 从一次工具调用的参数里取出"被动过的文件"。
 *
 * 返回 `{touched:[{path,op}], read:[{path,op}]}`；不认识的工具一律返回空 ——
 * 见 `L2_TOUCHED_SPEC` 的注释（按工具名列白名单，不做路径形状猜测）。
 */
function fileOpsOf(toolName, rawArgs) {
  let o;
  try {
    o = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
  } catch {
    return { touched: [], read: [] };
  }
  if (o === null || typeof o !== "object") return { touched: [], read: [] };
  const pick = (spec, op) => {
    const keys = spec[toolName];
    if (keys === undefined) return [];
    const out = [];
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim() !== "") out.push({ path: v, op });
    }
    return out;
  };
  return { touched: pick(L2_TOUCHED_SPEC, "M"), read: pick(L2_READ_SPEC, "R") };
}

/** 取工具结果的失败判据（**结构化字段**，不是正则）。 */
function isErrorResult(event) {
  return event?.data?.message?.isError === true;
}

// ── 高保真胶囊：会话记忆（★ 与日志无关，**永远在收**）────────────────────
//
// ★★ 为什么要与 L4/日志**分开**：日志是**可选的**（没登记 `logDir` 就不采集），
//   而高保真压缩是**每个会话都需要**的兜底。若胶囊素材来自日志，
//   那"没启用日志的项目"就完全没有高保真能力 —— 而它们恰恰是最多的
//   （实测 104/112 个会话在容器根，那里没有清单、没有日志）。
//
// ★ 只存**逐字**的东西，不存摘要：摘要就是我们要防的那个损失。
//   内存占用有硬闸门（各 `*_MAX`），且只在内存（红线：不落盘）。

/**
 * 从一条工具结果里抽出**失败原文**（逐字，不摘要）。
 *
 * ★ 为什么必须逐字：调研里"错误信息原文"被明确列为**逐字保留**项 ——
 *   报错字符串是那种"少一个字符就查不出来"的东西，而摘要把数字与标识符
 *   磨平（Anthropic 实测附录数字 0/3 保留）。
 */
function errorTextOf(event) {
  const msg = event?.data?.message;
  if (msg === undefined || msg === null) return undefined;
  const parts = Array.isArray(msg.content) ? msg.content : [];
  const texts = [];
  for (const c of parts) {
    if (c?.type === "text" && typeof c.text === "string" && c.text.trim() !== "") {
      texts.push(c.text.trim());
    }
  }
  if (texts.length === 0) {
    // 没有文本内容时给个可追溯的兜底（至少留下"哪一步炸了"）。
    const name = typeof msg.name === "string" ? msg.name : undefined;
    return name === undefined ? undefined : `（工具 ${name} 返回了错误，正文非文本）`;
  }
  const joined = texts.join("\n").replace(/\s+/g, " ").trim();
  const errChars = numOf("capsuleErrorChars", CAPSULE_ERROR_CHARS);
  return joined.length > errChars ? joined.slice(0, errChars) + "…" : joined;
}

/**
 * 造一个"会话记忆"：逐字记住用户说过的话、失败原文、被动过的文件。
 *
 * ★ 全部有界：用户消息只留最近 `CAPSULE_USER_MSG_MAX` 条、失败留最近
 *   `CAPSULE_ERROR_MAX` 条、器物索引按路径去重（只留最后一次动作）。
 *   若不设界，一个长会话会把内存和胶囊一起撑爆 —— 而压缩的**目的**是省上下文。
 */
function createCapsuleMemory() {
  /** 每条会话的逐字素材。key = sid。 */
  const bySid = new Map();

  function rec(sid) {
    let r = bySid.get(sid);
    if (r === undefined) {
      r = {
        /** 逐字用户消息（新→旧，落盘时再反转）。 */
        userMessages: [],
        /** 逐字失败原文（新→旧）。 */
        errors: [],
        /** 器物索引：绝对路径 → { op, at, tool }（后写覆盖，天然去重）。 */
        artifacts: new Map(),
        /** 已记过的用户消息 id，防同一事件被喂两次。 */
        seenMsgIds: new Set(),
      };
      bySid.set(sid, r);
    }
    return r;
  }

  /**
   * 消费一条会话事件，把逐字素材记下来。
   *
   * ★ 判据与 L4 **完全一致**（`source.kind === "user"`）：两处若各写一套，
   *   迟早会出现"日志里有、胶囊里没有"这种对不上的情况。
   *
   * ★★★ 2026-10-11（B3' 修复）：**返回"这一条有没有真的记下新东西"**。
   *   给调用方用来决定**要不要启动去抖落盘** —— 不返回就没法区分
   *   "记了新素材（该落盘）"与"只是路过一条无关事件（不必落盘）"。
   *   ⚠️ 不能让调用方自己判断事件类型：判据在这里（`userMessageOf` / `fileOpsOf` /
   *     `isErrorResult`）已经是一套逻辑，在外面再写一套 = 两套判据必然分叉（D59 的老坑）。
   *
   * @returns {boolean} 真的记下了新素材时为 true
   */
  function consume(sid, event) {
    const type = event?.type;
    if (typeof type !== "string") return false;
    // ★★★ 2026-10-11（情形 44b 抓到的真 bug）：**先判"这条事件值不值得记"，再建记录**。
    //
    //   旧写法一进来就 `rec(sid)` —— 那个函数会**无条件建一条空记录**。
    //   后果有两层：
    //     ① `_bySid` 里塞满空记录 ⇒ 去抖落盘会把它们全写一遍（浪费）；
    //     ② ★★ 更严重：一条空记录被落盘就会**把盘上原有的好素材抹掉**
    //        （复现：销毁 → 一条无关事件 → 再销毁 ⇒ 盘上变 `[]`）。
    //   ⇒ 先算出"这条事件是不是用户原话 / 工具调用 / 失败原文"，
    //     三类都不是就直接返回，**一个对象都不建**。
    const isUserMsg = userMessageOf(event) !== undefined;
    const isToolCall = type === "tool/call";
    const isErr = type === "tool/result" && isErrorResult(event);
    if (!isUserMsg && !isToolCall && !isErr) return false;

    const r = rec(sid);
    let changed = false;

    // ── 用户消息（逐字）─────────────────────────────────────────────────
    const um = userMessageOf(event);
    if (um !== undefined) {
      if (um.id === undefined || !r.seenMsgIds.has(um.id)) {
        if (um.id !== undefined) r.seenMsgIds.add(um.id);
        const body = renderUserMessageBody(um.content);
        if (body !== "") {
          // ★ D138：单条原话的截断长度可调（面板改了必须真生效）。
          const umChars = numOf("capsuleUserMsgChars", CAPSULE_USER_MSG_CHARS);
          r.userMessages.unshift({
            at: stampSec(um.when),
            text: body.length > umChars ? body.slice(0, umChars) + "…" : body,
          });
          // ★★★ 2026-10-11（D84 缺陷修复）：**被挤出去的不许丢** ——
          //   旧代码是 `r.userMessages.length = CAPSULE_USER_MSG_MAX`，**超出部分直接蒸发**。
          //   实测后果：被压 191 条真原话只找回 24.1%，最早 3 条（含用户原始任务陈述）0/3。
          //   ⇒ 现在把被挤出去的那些**收集起来**交给调用方去升级归档
          //     （`consume` 手里没有 root，归档要 root —— 所以只能交出去）。
          //   ★ 为什么在 `consume` 里收集、而不在调用方重算：
          //     划分"哪一条被挤出"的知识**只在这里**（就是这一行的 `.length = MAX` 语义），
          //     在别处再算一遍 = 两套判据必然分叉（D59 的老坑）。
          if (r.userMessages.length > CAPSULE_USER_MSG_MAX) {
            const evicted = r.userMessages.slice(CAPSULE_USER_MSG_MAX);
            r.userMessages.length = CAPSULE_USER_MSG_MAX;
            if (!Array.isArray(r.evictedUserMessages)) r.evictedUserMessages = [];
            r.evictedUserMessages.push(...evicted);
          }
          changed = true;
        }
      }
    }

    // ── 工具调用 ⇒ 器物索引 ─────────────────────────────────────────────
    if (type === "tool/call") {
      const d = event.data ?? {};
      const toolName = typeof d.name === "string" ? d.name : "?";
      const { touched, read } = fileOpsOf(toolName, d.arguments);
      const at = stampSec(new Date());
      for (const { path: p, op } of touched) {
        r.artifacts.set(p, { op: "改", at, tool: toolName });
        changed = true;
      }
      for (const { path: p, op } of read) {
        // ★ 读**不覆盖**已有的"改"：一个文件既被读过也被改过，索引要显示"改"
        //   （调研里"哪些文件被改过"是最弱项，别让一次后来的 read 把它降级）。
        if (!r.artifacts.has(p)) {
          r.artifacts.set(p, { op: "读", at, tool: toolName });
          changed = true;
        }
        void op;
      }
      if (r.artifacts.size > 400) {
        // 兜底：超出就丢最旧的（Map 保持插入序）。
        const first = r.artifacts.keys().next();
        if (!first.done) r.artifacts.delete(first.value);
      }
    }

    // ── 失败原文（逐字）─────────────────────────────────────────────────
    if (type === "tool/result" && isErrorResult(event)) {
      const text = errorTextOf(event);
      if (text !== undefined) {
        r.errors.unshift({ at: stampSec(new Date()), text });
        const errMax = numOf("capsuleErrorMax", CAPSULE_ERROR_MAX);
    if (r.errors.length > errMax) r.errors.length = errMax;
        changed = true;
      }
    }
    return changed;
  }

  function get(sid) {
    return bySid.get(sid);
  }
  function forget(sid) {
    bySid.delete(sid);
  }
  /**
   * ★★★ 2026-10-11（D84 修复）：把**所有会话**攒下的"被胶囊挤出去的原话"取走并清空。
   *
   * ★ 为什么是"取走"（drain）而不是"看一眼"：归档是调用方的责任，
   *   取走才能保证**同一条不会被归档两次**（取走后内存里就没了）。
   *   ⚠️ 若调用方忘了取，这些条目会**一直留在内存里**长到重启 ——
   *     所以调用点在 `session/event` 里**紧跟着** `consume`，每条事件都会取。
   *
   * @returns {Array<{at:string,text:string}>} 被挤出去的原话（旧的在前）
   */
  function drainEvicted() {
    const out = [];
    for (const r of bySid.values()) {
      if (Array.isArray(r.evictedUserMessages) && r.evictedUserMessages.length > 0) {
        out.push(...r.evictedUserMessages);
        r.evictedUserMessages.length = 0;
      }
    }
    return out;
  }

  /**
   * ★★★★ 2026-10-13（D162）：**补上 `set`** —— 调用方本来就假定了一个"可读可写"的容器。
   *
   * ★ 这是一个**真机缺陷 + 自检假绿**的修复（病历见 DECISIONS D162）：
   *   `hydrateCapsuleMemory`（D61 的解药）在 L2227 调 `capsule.set(sid, live)`，
   *   而本函数的返回里**从来没有 `set`** ⇒ 抛 `TypeError` ⇒ 被外层 catch 吞掉 ⇒ **返回 0，什么都没补**。
   *   ⇒ D61 那个修复**在生产路径上从未生效过**。
   *
   * ★★ 为什么一直没被发现（**这才是本条最值得记的地方**）：
   *   自检情形 42d 的夹具传的是**裸 `new Map()`** —— 而 `Map` **自带 `set`** ⇒ 它**绿了**。
   *   生产的形状（本函数）恰好**没有** `set` ⇒ 生产**一直是坏**的。
   *   ⇒ ★ **纪律 8：夹具前提错了，全绿就是假绿**；
   *     且**反向验证也抓不到**（摘掉 L2227 那行确实会红 ⇒ 反向验证通过）——
   *     因为它只能证明"摘掉会红"，证明不了"**装上去真的对**"。
   *
   * ★ 修法选"补 `set`"而不是"改调用方"：`get`/`set` 是对称的容器接口，
   *   补上它是最小且最正的改动；改调用方则要它自己知道"内存里没有就造一条"的细节，
   *   而那件事**只该由这个容器负责**。
   */
  function set(sid, mem) {
    bySid.set(sid, mem);
  }

  return { consume, get, set, forget, drainEvicted, _bySid: bySid };
}

/**
 * ★★★ 胶囊素材的**去抖落盘器**（B3' 修复，2026-10-11）。
 *
 * ★ 为什么要它（**只读测试员 004 发现、我复算确认**的缺陷）：
 *   原来 `persistCapsuleMemory` **只在两个时点**被调用 —— 压缩前、会话销毁。
 *   于是「**最后一次落盘之后新增的素材**」在重启时**必然丢**。
 *   实测牺牲品：用户 `05:46:31` 那条原话（它在上一进程末次落盘 `05:39:39` 之后）。
 *   盘上覆盖率只有 **1/93**。
 *
 * ★ 为什么**不能**在 `session/event` 里直接写盘：
 *   那个回调是**同步跑在官方 `Session.append()` 路径上**的
 *   （内核原话：*"Persistence is a plugin concern (subscribe to `session/event`…)"*）。
 *   在那里同步写一个 JSON 会**拖慢官方落盘** —— 那正是我明确要避免的事
 *   （`persistCapsuleMemory` 的旧注释也这么写）。
 *
 * ★ 所以：**攒 + 去抖**（与活动日志采集器同一套路，`LOG_FLUSH_DEBOUNCE_MS`）。
 *   `arm()` 只置一个定时器（重复调用是幂等的），到点才**写一次盘**。
 *   ★ 定时器 `unref()`：绝不能把进程钉住不退。
 *   ★ 全程吞错：落盘失败只影响"重启后还记得多少"，绝不许影响别的任何事。
 *
 * @param {() => (string|undefined)} sidOf 取当前会话 id（取不到就跳过一次）
 */
function createCapsulePersister(capsule, sidOf) {
  let timer;
  /** 到点把**所有**已知会话的素材各写一份（不只为当前那个）。 */
  function flushNow() {
    try {
      // ★ 用 `_bySid` 遍历：这样"会话切走之后上一次的尾巴也能落盘"。
      const by = capsule?._bySid;
      if (!(by instanceof Map)) return;
      for (const [sid, mem] of by.entries()) persistCapsuleMemory(String(sid), mem);
    } catch {
      /* 落盘失败绝不影响任何事 */
    }
  }
  return {
    /** 有**新素材**时调用；重复调用只会保持一个定时器（幂等）。 */
    arm() {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        flushNow();
      }, LOG_FLUSH_DEBOUNCE_MS);
      if (typeof timer.unref === "function") timer.unref();
    },
    /** 立刻刷一次（会话销毁等真正收尾的时刻用）。 */
    flushNow,
    /** 收尾：清掉挂着的定时器（避免退出后还跑）。 */
    dispose() {
      if (timer !== undefined) {
        try {
          clearTimeout(timer);
        } catch {
          /* 清不掉就算了 */
        }
        timer = undefined;
      }
    },
    _hasTimer: () => timer !== undefined,
  };
}

/**
 * 把会话记忆渲染成**高保真胶囊**（要重新注入上下文的那段正文）。
 *
 * ★ 结构刻意对着调研里"逐字 vs 摘要"那张表来排：
 *   逐字段落放前面（它们最怕被磨平），摘要性内容根本不生成 ——
 *   因为**内核的摘要器已经负责"叙述"了**，本胶囊只补它必丢的那几类。
 *
 * ★ 为什么还要列"已落盘的文件"：压缩后的 agent 需要知道**去哪里重读**。
 *   "文件在磁盘上，重读是确定性的"是社区公认最有力的一招，
 *   而它的前提是 agent **知道那个路径**。
 */
function renderCapsule(info, mem, opts) {
  if (mem === undefined) return undefined;
  const { projectRoot } = info;
  const committed = [];

  // ── ① 逐字：用户说过的话（**最近 N 条**，按时间正序）──────────────────
  //
  // ★★★ 2026-10-11（用户要求 + D84 缺陷）：
  //   用户原话是*"胶囊要告诉模型在哪里找完整的用户原话"*。
  //   ⇒ 标题里**必须说清"这只是最近的 N 条"**，并给出**完整原话的两个去处**。
  //   ★ 为什么非说不可：实测**最早的原话最容易掉出载体**
  //     （被压 191 条真原话逐字只找回 24.1%，最早 3 条含用户原始任务陈述是 **0/3**）。
  //     若标题不写"最近 N 条"，模型会**以为这就是全部** ⇒ 然后去猜早期需求。
  let userBlock = "";
  if (mem.userMessages.length > 0) {
    const rows = [...mem.userMessages].reverse();
    userBlock =
      `\n### 用户原话（**逐字**，按时间正序 —— 含他的约束与纠正）\n\n` +
      `> ⚠️ **这里只有最近的 ${CAPSULE_USER_MSG_MAX} 条**，不是全部。\n` +
      `> 要找**更早的完整原话**，按顺序试这两处：\n` +
      `> ① \`ledger_log({view:"users"})\` —— 活动日志的 **L4 全量**（按会话分组，带时间）；\n` +
      `> ② 项目里的 \`${path.join(
        info.archiveRel ?? "_ledger-archive",
        archiveStamp(new Date(), info?.manifest?.archiveWeekMode).dir,
        USER_MSG_ARCHIVE_FILE
      )}\` —— **从胶囊挤出去的那部分的兜底副本**（只追加，永不删）。\n\n` +
      rows.map((m) => `- \`${m.at}\` ${m.text}`).join("\n") +
      "\n";
  }

  // ── ② 逐字：失败与报错原文 ───────────────────────────────────────────
  let errBlock = "";
  if (mem.errors.length > 0) {
    const rows = [...mem.errors].reverse();
    errBlock =
      "\n### 失败与报错原文（**逐字** —— 别凭记忆复述，字符串差一个字符就查不出来）\n\n" +
      rows.map((e) => `- \`${e.at}\` ${e.text}`).join("\n") +
      "\n";
  }

  // ── ③ 器物索引：哪些文件被动过（结构化，不摘要）──────────────────────
  let artBlock = "";
  if (mem.artifacts.size > 0) {
    const rows = [...mem.artifacts.entries()]
      .sort((a, b) => (a[1].at < b[1].at ? 1 : a[1].at > b[1].at ? -1 : 0))
      .slice(0, numOf("capsuleArtifactMax", CAPSULE_ARTIFACT_MAX));
    const changed = rows.filter(([, v]) => v.op === "改");
    artBlock =
      "\n### 器物索引（本会话碰过的文件；**按路径去重**，不是摘要）\n\n" +
      (changed.length > 0
        ? `**被改动过 ${changed.length} 个**：\n` +
          changed.map(([p, v]) => `- \`${p}\`（${v.op}，最后 \`${v.at}\`，${v.tool}）`).join("\n") +
          "\n"
        : "") +
      (rows.length > changed.length
        ? `只读过 ${rows.length - changed.length} 个（略）。\n`
        : "");
  }

  // ── ④ 已落盘的确定性副本：告诉它**去哪重读** ─────────────────────────
  const copies = [];
  if (info.activeRel !== undefined) {
    copies.push(`- 活跃台账：\`${path.join(projectRoot, info.activeRel)}\`（当前状态，**先读这个**）`);
  }
  if (info.decisionsRel !== undefined) {
    copies.push(`- 关键决策：\`${path.join(projectRoot, info.decisionsRel)}\`（永久保留，不参与归档）`);
  }
  if (info.archiveRel !== undefined) {
    copies.push(`- 归档目录：\`${path.join(projectRoot, info.archiveRel)}\`（旧条目，只追加）`);
  }
  if (info.logRel !== undefined) {
    copies.push(
      `- 活动日志：\`${path.join(projectRoot, info.logRel)}\`（**含 L4 用户消息全量**，` +
        "用 `ledger_log({view:\"users\"})` 按需查，不要整篇读进来）"
    );
    // ★ D45：历次压缩的**胶囊原件**在这儿。它与"注进来的这一份"不是一回事 ——
    //   注进来的是**这一次**的，目录里是**历次**的（可回溯、可 diff、跨压缩链不失真）。
    //
    // ★★★ 2026-10-11 修：这一段原来给的是 `<logDir>/capsules`，
    //   而**真实落盘位置是按期间分桶的** `<logDir>/<YYYY-MM>/weekN/capsules`
    //   （见 `persistCapsule`：`${dir}/${period}/${CAPSULE_DIR_NAME}`）。
    //   ⇒ 那个指针**指错一层**，照着它 ls 会**一个胶囊都找不到** ——
    //     而"可随时回溯检查"正是用户这次点名的三条保证之一，指错等于没保证。
    //   ⇒ 现在把**本期**的真实目录写出来（`archiveStamp` 与落盘用的是同一个函数，
    //     所以两者不可能再分叉）；并补一句"按期间分桶"的说明，让它知道往上一层能看历期。
    const capPeriod = archiveStamp(new Date(), info?.manifest?.archiveWeekMode).dir;
    // ★★★★★ 2026-10-13（D165）：指针里的目录也走**唯一出口**。
    //   ★ 收口前这里是**第三处**算法（`path.join(projectRoot, info.logRel, capPeriod, CAPSULE_DIR_NAME)`），
    //     与真落盘、与兜底各算一套 ⇒ 三处必然在**某一次改动**上分叉（D164 就是这么来的）。
    //   ★ 用 `info` 而不是 `info.logRel` 现拼：`capsuleDirRel` 自己的取法是 `logDirOf(info)`
    //     （与落盘、与兜底同一处），三者的**取目录判据**从此只有一份。
    const capDirRel = capsuleDirRel(info, new Date());
    if (capDirRel !== undefined) {
      copies.push(
        `- 历次逐字胶囊（**原件**）：\`${path.join(projectRoot, capDirRel)}\`` +
          `（每次压缩存一份，永不覆写；★ 按期间分桶，往上一层 \`${path.join(projectRoot, info.logRel)}\` 能看到历期）`
      );
    }
  }
  // ★★★ 交接单（2026-10-10，第③层）：这是**新会话"接着上次干"的唯一入口**。
  //
  //   ★ 原来这里读的是 `opts?.handoffRel` —— 一个**没有任何地方传**的参数 ⇒
  //     这行**死代码**从来没显示过。现在从 `info` 读（`inspect()` 统一解析），
  //     忘不掉了。
  //   ★ 而且不只给目录，还给**最新那一份的完整路径** —— "去哪读哪一份"
  //     是恢复现场时唯一真正有用的信息，把挑选的活推回给模型等于没做。
  if (info.handoffLatestRel !== undefined) {
    copies.push(
      `- ★ **上一次交接单**：\`${path.join(projectRoot, info.handoffLatestRel)}\`（**接手先读这一份**）`
    );
    if (info.handoffRel !== undefined) {
      copies.push(`- 交接单目录：\`${path.join(projectRoot, info.handoffRel)}\`（历次交接都在这里）`);
    }
  } else if (info.handoffRel !== undefined) {
    copies.push(
      `- 交接单目录：\`${path.join(projectRoot, info.handoffRel)}\`（**目前还没有** —— 收尾时用 \`ledger_handoff\` 写一份，新会话就能接上）`
    );
  }
  if (opts?.handoffRel !== undefined) {
    copies.push(`- 上一次交接单：\`${opts.handoffRel}\``);
  }
  const copyBlock =
    copies.length === 0
      ? ""
      : "\n### 可确定性重读的副本（磁盘上的真源 —— 比摘要可靠）\n\n" + copies.join("\n") + "\n";

  void committed;

  const body =
    userBlock +
    errBlock +
    artBlock +
    copyBlock;

  if (body.trim() === "") return undefined;
  const capMax = numOf("capsuleMaxChars", CAPSULE_MAX_CHARS);
  if (body.length > capMax) {
    return (
      body.slice(0, capMax) +
      `\n\n…（胶囊过长已截断，原文 ${body.length} 字符。完整原话见活动日志的 L4 / 官方会话日志）\n`
    );
  }
  return body;
}

/**
 * 渲染"压缩后重注"的正文（**高保真版**）。
 *
 * ★ 与旧版的区别：旧版只说"台账已重新注入"（那是一份**项目状态**），
 *   新版再带上**胶囊**（这一场会话自己的逐字素材）。
 *   两者是不同层次的东西：台账是"项目现在什么样"，胶囊是"我们刚才说了/改了什么"。
 *   官方摘要器覆盖的是后者，而它恰恰是实测最弱的一环。
 */
function renderAfterCompaction(info, capsule, meta, biOpts) {
  const head = headOf(info);
  const why =
    meta?.ours === true
      ? `本插件在上下文水位到 **${autoFullPct()}%** 时主动执行了一次压缩（比内核默认的 80% 早），` +
        "为的是在丢失之前把状态落袋。"
      : "本会话的较早历史已被压缩。";
  // ★ 「反复追究」模式：压缩**前** AI 自己分出来的 keep 桶，这里逐字注回。
  //   它与机械胶囊**并列**而不是取代 —— 两者失败模式不同（见 `state.triageKeep` 注释）。
  const keep = Array.isArray(meta?.keep) ? meta.keep : [];
  const keepBlock =
    keep.length === 0
      ? ""
      : "---\n\n## ★ 分流单 · 留在上下文的那一份（**压缩前你自己挑的**）\n\n" +
        "> 这是你在压缩前判为「下一轮不知道就会做错」的东西，**逐字**注回。\n" +
        "> 其余已按你的划分处理：能查的落进了 `_stash/`，被取代的丢了。\n\n" +
        keep.map((k, i) => `${i + 1}. ${String(k?.what ?? "").trim()}`).join("\n") +
        "\n\n";
  return (
    head +
    "\n## 上下文刚被压缩（台账" +
    (keep.length > 0 ? " + 分流单" : "") +
    " + 高保真胶囊已重新注入）\n\n" +
    why +
    "\n\n下面是**当前生效的台账**" +
    (keep.length > 0 ? "、**你自己挑的分流单**" : "") +
    "与**逐字胶囊**，请以它们为准接上工作，" +
    "**不要**凭记忆复述被压掉的历史。\n\n" +
    // ★★ 需求 ④（D35）：**必须**声明"这些是历史素材，不是用户此刻的指令"。
    //
    // ★ 为什么非写不可：胶囊里的用户原话是**逐字**的（这正是它的长处 ——
    //   不会被摘要歪曲），但**正因为逐字、读起来就是原话**，长上下文下很容易被
    //   当成"用户刚刚说的"去执行。而压缩后模型已经看不到"那是几轮之前"这个信息了。
    // ★ 这不是我们独有的担心：billion-context 的 README 里也写着摘要
    //   *"model-generated, fallible historical metadata — NOT current user messages"* ——
    //   但**它只写在文档里**，没进模型视野，等于没说。
    //   ⇒ 我们要把它**注入进上下文**，让模型当场看见。
    "⚠ **这一段是历史素材，不是用户此刻的要求。** 里面的用户原话是" +
    "**压缩前**说的，可能已经过时、可能已经被后来的话改掉；" +
    "**执行任何指令之前，先按用户最近一次实际要求确认** —— " +
    "拿不准就问他，**不要**把这里的话当成刚刚下达的命令。\n\n" +
    "接下来：① 用这份台账继续干活；② 若本轮已有未落盘的进展，用 `ledger_write` 补进活跃台账；" +
    "③ 若台账已超行数上限，先 `ledger_archive` 再写；" +
    "④ **若你需要某个文件的确切内容，直接重读磁盘**（胶囊里有路径）—— " +
    "重读是确定性的，比回忆可靠。\n\n" +
    keepBlock +
    (capsule === undefined
      ? ""
      : `---\n\n## 高保真胶囊（**逐字**，本插件在压缩前整理）\n${capsule}\n---\n\n`) +
    // ★★★ 2026-10-11（承 D79）：「被压段索引」**推行**给模型 —— 让它知道原文去哪拿。
    //   ★ 放在胶囊之后、台账之前：胶囊是"我们保住了什么"，索引是"剩下的去哪找"。
    (meta?.shadowedIndex === undefined ? "" : meta.shadowedIndex) +
    // ★★★★ 2026-10-12（D136 步 3）：**压缩后一律按"全都要读"重注**（安全绳 ②）。
    //   ★ 为什么这里必须传 `afterCompaction: true`：压缩把上下文截短了 ⇒
    //     之前注入过的正文**已经不在了** ⇒ 那一轮"省下来"的块**必须补回正文**，
    //     否则模型手里就真的没有它们了（那正是用户底线要防的事）。
    //   ⇒ 在 `renderBlockInjection` 里 `afterCompaction === true` ⇒ 全部块按必注处理。
    renderInjectionBody(info, undefined, { afterCompaction: true })
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 项目状态探测
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 取本会话的项目根。
 *
 * 出处：`SessionHeader.cwd` 是官方的会话工作目录
 * （`6.会话工作区用途\lib\index.js:454-460` 用的同一条；
 *   上下文查看器 `7.上下文查看器\lib\index.js:998` 也是 `s.header?.cwd`）。
 */
/**
 * 本会话的**项目根**。
 *
 * ★★★ 2026-10-10（用户拍板）加了「项目锁」：用户说的
 *   *"把对话建在总的工作区下面…或者说把项目注册到对应的文件夹上，
 *     以后各种工具的使用都在那个文件夹上"*。
 *   ⇒ 锁生效时，**所有**工具都落在那个文件夹上（这条函数是 9 处调用的唯一出口，
 *     所以在这里改一处就够 —— 这也是它值得保持"唯一出口"的理由）。
 *
 * ★★ 优先级：**cwd 自己有台账 > 锁 > cwd**（用户选的"只在这场对话内接管"）。
 *   为什么不无条件以锁为准：用户说得很明确 ——
 *   锁是给"cwd 没有台账（典型：建在总工作区）"这种情况用的**接管**手段；
 *   若当前目录本来就是一个有台账的项目，那它自己就是答案，锁不该压过它。
 *   ⇒ 这条判据让"锁"**只会扩大能用的情况，不会改变已有情况**（与 D49 默认 steady
 *     同一条思路：新能力不许悄悄改掉旧行为）。
 *
 * ★ 代价（如实记下）：这里多了一次 `readManifest`（只读一个小 JSON）。
 *   它只在**真的锁了**的时候才走，没锁的会话行为与以前**逐字节相同**。
 *
 * @param {object} agent
 * @returns {string|undefined} 绝对路径；拿不到 cwd 且没锁 ⇒ undefined
 */
function projectRootOf(agent) {
  const h = agent?.session?.header;
  return resolveProjectRoot(h?.id, h?.cwd);
}

/**
 * ★★★ 2026-10-10（用户报的真缺口）：**采集器那条路的同一个判定**。
 *
 * **为什么需要它**：`ctx.on("session/event", (session, event) => …)` 拿到的是
 *   **`session`**，不是 `agent` —— 所以它压根够不到 `projectRootOf(agent)`，
 *   旧代码就自己写了 `const cwd = session?.header?.cwd` **直接取原始 cwd**。
 *   ⇒ 后果：**项目锁对活动日志（含 L4 用户消息存档）完全无效**。
 *   实测（本机，2026-10-10 用户让我把会话锁到插件目录之后）：
 *     · `ledger_status` 报的是**锁定目录**（工具那条路走了锁）；
 *     · 但 `ledger_log({view:"users"})` **一条 L4 都没有** ——
 *       因为采集器拿的是容器根，那里没启用日志 ⇒ `logDirOf` undefined ⇒ 直接 return。
 *   ⇒ 锁着子项目，**用户在总工作区说的话一句都不进 L4**（而那正是 L4 最该记的东西）。
 *
 * ★ 修法不是"在采集器里再抄一遍判定"，而是**抽成 `resolveProjectRoot` 一个出口**：
 *   两处各写一套判据 = 迟早分叉（本文件反复强调这条）。
 * ★ 这就是本项目「一个事实只能有一个判定出口」（D25）的又一次应用 ——
 *   而且这次是**我自己先违反了它**才出的缺口：`projectRootOf` 被当成唯一出口写在注释里，
 *   却漏了这条不经过 `agent` 的路。
 *
 * @param {object} session 官方 `session/event` 的第一个入参
 * @returns {string|undefined}
 */
function projectRootOfSession(session) {
  const h = session?.header ?? session;
  return resolveProjectRoot(h?.id ?? session?.id, h?.cwd);
}

/**
 * 判定项目根 —— **唯一的出口**（`projectRootOf` 与 `projectRootOfSession` 都走这里）。
 *
 * ★★★ 2026-10-10（用户拍板）加了「项目锁」：用户说的
 *   *"把对话建在总的工作区下面…或者说把项目注册到对应的文件夹上，
 *     以后各种工具的使用都在那个文件夹上"*。
 *
 * ★★ 优先级：**cwd 自己有台账 > 锁 > cwd**（用户选的"只在这场对话内接管"）。
 *   为什么不无条件以锁为准：用户说得很明确 ——
 *   锁是给"cwd 没有台账（典型：建在总工作区）"这种情况用的**接管**手段；
 *   若当前目录本来就是一个有台账的项目，那它自己就是答案，锁不该压过它。
 *   ⇒ 这条判据让"锁"**只会扩大能用的情况，不会改变已有情况**（与 D49 默认 steady
 *     同一条思路：新能力不许悄悄改掉旧行为）。
 *
 * ★ 代价（如实记下）：这里多了一次 `readManifest`（只读一个小 JSON）。
 *   它只在**真的锁了**的时候才走，没锁的会话行为与以前**逐字节相同**。
 *
 * @param {string|undefined} sid 会话 id（锁是按会话记的）
 * @param {string|undefined} cwd 会话工作目录
 * @returns {string|undefined} 绝对路径；拿不到 cwd 且没锁 ⇒ undefined
 */
function resolveProjectRoot(sid, cwd) {
  const here = typeof cwd === "string" && cwd !== "" ? path.resolve(cwd) : undefined;
  const locked = activeLockFor(sid);
  if (locked === undefined) return here; // 没锁 ⇒ 与以前完全一致
  // 锁了：当前目录**自己有台账**就以它为准（锁只接管"没有台账"的情况）。
  if (here !== undefined && readManifest(here) !== undefined) return here;
  return locked;
}

/** 读指针清单（不存在 ⇒ undefined）。 */
function readManifest(projectRoot) {
  const file = path.join(projectRoot, MANIFEST_REL);
  const raw = readTextSafe(file);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return undefined;
    if (typeof parsed.active !== "string" || parsed.active === "") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 没有清单时，用保守候选名在项目根找活跃台账。 */
function guessActive(projectRoot) {
  let entries;
  try {
    entries = fs.readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (CANDIDATE_RE.test(e.name)) return e.name;
  }
  return undefined;
}

/** 没有清单时，猜关键决策文件（活跃台账同名前缀的 DECISIONS/DECISIONS.md 之类）。 */
function guessDecisions(projectRoot) {
  let entries;
  try {
    entries = fs.readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (/^(decisions?|adr|关键决策|决策记录|决策)\.(md|markdown|txt)$/i.test(e.name)) return e.name;
  }
  return undefined;
}

/** 没有清单时，猜归档目录。 */
function guessArchiveDir(projectRoot) {
  const names = ["_ledger-archive", "_archive", "ledger-archive", "台账归档", "archive"];
  for (const n of names) {
    try {
      if (fs.statSync(path.join(projectRoot, n)).isDirectory()) return n;
    } catch {
      /* 不存在就下一个 */
    }
  }
  return undefined;
}

/**
 * 没有清单时，猜日志目录。
 *
 * ★ 与归档目录同样**只认保守命名**：绝不把 `logs/` 这类通用目录认成台账日志 ——
 *   误认的后果是往用户自己的日志目录里写采集流水。
 */
function guessLogDir(projectRoot) {
  const names = ["_ledger-log", "_ledger-logs", "ledger-log", "台账日志", "_log"];
  for (const n of names) {
    try {
      if (fs.statSync(path.join(projectRoot, n)).isDirectory()) return n;
    } catch {
      /* 不存在就下一个 */
    }
  }
  return undefined;
}

/**
 * 汇总一个项目根的全部台账事实（**只读**）。
 * 工具与注入都从这里取数，避免两处各探一遍而分叉。
 */
function inspect(projectRoot) {
  const manifest = readManifest(projectRoot);
  const isGitRepo = (() => {
    try {
      return fs.existsSync(path.join(projectRoot, ".git"));
    } catch {
      return false;
    }
  })();
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const hasGitignore = fs.existsSync(gitignorePath);

  let activeRel = manifest?.active;
  let source = "manifest";
  if (typeof activeRel !== "string" || activeRel === "") {
    activeRel = guessActive(projectRoot);
    source = activeRel === undefined ? "none" : "guess";
  }

  let decisionsRel = manifest?.decisions;
  let decisionsSource = "manifest";
  if (typeof decisionsRel !== "string" || decisionsRel === "") {
    decisionsRel = guessDecisions(projectRoot);
    decisionsSource = decisionsRel === undefined ? "none" : "guess";
  }

  let archiveRel = manifest?.archiveDir;
  let archiveSource = "manifest";
  if (typeof archiveRel !== "string" || archiveRel === "") {
    archiveRel = guessArchiveDir(projectRoot);
    archiveSource = archiveRel === undefined ? "none" : "guess";
  }

  // ── 活动日志目录（★ 与归档目录不同：**默认不建**）──────────────────────
  //
  // ★ 归档目录是从"登记了台账"这件事必然推出来的（需求硬约束里就有它）；
  //   而日志是**可选**的。所以：清单里明确登记了才启用；没登记就**不启用**，
  //   **绝不因为"看到同名目录"就往下写** —— `guessLogDir` 的注释写着
  //   "绝不把 `logs/` 这类通用目录认成台账日志"，而它的候选里就有 `_log`，
  //   一旦把它当"已启用"，一个恰好有 `_log` 目录的项目就会开始收到采集流水。
  //
  // ★★ 这里修过一个**自相矛盾**（2026-10-09 实测撞到，两个出口给了两个答案）：
  //   旧版把 `guessLogDir()` 的结果写进 `logRel`，于是
  //     `ledger_status` 报「日志目录 = `_ledger-log`」
  //   而 `ledger_log` / `ledger_log_write` / 采集器却都过 `logDirOf(info)`
  //   （只读清单）⇒ 一律回「还没有启用活动日志」。
  //   同一个问题两个答案，用户按 status 去查必然扑空。
  //   ⇒ 现在 `logRel` **只**来自清单（与 `logDirOf` 单一来源）；
  //     猜到的目录另放 `logGuess`，用途只有一个：**告诉用户"有这个目录，登记一下就启用"**。
  const logRel = manifest?.logDir;
  let logAbs;
  if (typeof logRel === "string" && logRel !== "") {
    const candidate = path.resolve(projectRoot, logRel);
    if (isUnder(projectRoot, candidate)) logAbs = candidate;
  }
  // 猜到的同名目录：**只报告，不启用**。清单里已经登记了就不必猜。
  const logGuess =
    typeof logRel === "string" && logRel !== "" ? undefined : guessLogDir(projectRoot);
  const logSource =
    typeof logRel === "string" && logRel !== ""
      ? "manifest"
      : logGuess === undefined
        ? "none"
        : "found-not-enabled";

  // ★★ 行数上限的口径（一个事实只有一个出口，D25）：
  //   ① **项目清单里有** ⇒ 那才是**这个项目**的上限，插件级设置**不参与**；
  //   ② 清单里没有 ⇒ 用**插件级设置的默认值**（用户可在设置面板调）。
  //   ⇒ 顺序不能反：设置面板是"新项目登记时写什么默认值"的旋钮，
  //      不是"远程覆盖每个项目"的旋钮 —— 后者会让一个项目的行为随全局设置漂移。
  const maxActiveLines =
    Number.isFinite(manifest?.maxActiveLines) && manifest.maxActiveLines > 0
      ? Math.floor(manifest.maxActiveLines)
      : currentSettings().maxActiveLines;

  // ── 问题记录目录（★ 可选，且**默认跟着工作区已有通道走**）─────────────────
  //
  // 只在这个根**不是 Git 仓库**（即不是某个具体项目）时才解析：
  // 真项目里没有"问题记录"这回事（它该用台账），给了反而会诱导 AI 把项目内容
  // 写进一个不属于项目的外部目录。
  //
  // ★★ 记录要落到**工作区根**，不是会话 cwd —— 会话可能开在工作区的任意子目录里，
  //   若按 cwd 拼路径，同一个工作区的记录会散落到各个子目录各一份
  //   （实测撞到：从 `proj-a` 开会话，记录就写进了 `proj-a\60-对话记录与交接\…`）。
  //   所以先往上找工作区根（`findWorkspaceRoot`），找到就用它当基准。
  //   往上找会**在有 .git 的地方停**，所以项目内部的小记不会跑到项目外面去。
  const notesBase = findWorkspaceRoot(projectRoot) ?? projectRoot;
  let notesRel;
  let notesAbs;
  let notesSource = "none";
  if (!isGitRepo) {
    // 只在"基准 == cwd"时才读 cwd 自己的清单；否则以工作区根的布局为准。
    const baseManifest = notesBase === projectRoot ? manifest : readManifest(notesBase) ?? {};
    const declared =
      typeof baseManifest?.notesDir === "string" && baseManifest.notesDir !== ""
        ? baseManifest.notesDir
        : undefined;
    if (declared !== undefined) {
      const cand = path.resolve(notesBase, declared);
      if (isUnder(notesBase, cand)) {
        notesRel = toGitRel(notesBase, cand);
        notesAbs = cand;
        notesSource = "manifest";
      }
    } else {
      // 没登记 ⇒ 只认**已经存在**的候选目录，绝不擅自新建。
      for (const c of NOTE_DIR_CANDIDATES) {
        try {
          if (fs.statSync(path.join(notesBase, c)).isDirectory()) {
            notesRel = c;
            notesAbs = path.join(notesBase, c);
            notesSource = "guess";
            break;
          }
        } catch {
          /* 不存在就下一个 */
        }
      }
    }
    if (notesRel === undefined) {
      // 连候选目录都没有 ⇒ 用默认名（写的时候才建目录）。
      notesRel = DEFAULT_NOTES_DIR;
      notesAbs = path.resolve(notesBase, DEFAULT_NOTES_DIR);
      notesSource = "default";
    }
  }

  let activeAbs;
  if (typeof activeRel === "string" && activeRel !== "") {
    const candidate = path.resolve(projectRoot, activeRel);
    if (isUnder(projectRoot, candidate)) activeAbs = candidate;
  }

  const activeText = activeAbs !== undefined ? readTextSafe(activeAbs) : undefined;
  const activeLines = activeText === undefined ? 0 : countLines(activeText);

  // ★ 容器工作区判定：只在"本层没有 .git"时才有意义（有 .git 就是项目本身）。
  const container = isGitRepo ? { marker: undefined, nestedRepo: undefined } : containerFacts(projectRoot);

  // ── 交接单目录（★ 放进 inspect 而不是做成参数：参数会被忘记传）──────────
  //
  // ★★ 为什么必须在这里统一解析（2026-10-10）：原来 `renderCapsule` 的
  //   `opts.handoffRel` 是个参数，而**全文件没有任何地方传它** ⇒
  //   那行"上一次交接单"是**死代码**，从来没显示过。
  //   根因不是"忘了写一行"，而是"**做成了参数**"—— 参数就会被忘。
  //   ⇒ 放进 info，凡是用到 info 的地方自动就有了。
  //
  // ★★ 判据是「**这是一个项目，不是容器**」—— 而**不是** `isGitRepo`。
  //   ⚠️ 我第一版写成 `if (isGitRepo)`，结果自检里那些"建了台账但没 git init"
  //      的项目**全部解析不出交接单目录**（实测：`ok:false`）。
  //      项目可以是"有台账但还没 git init"，那也是项目。
  //   容器根**不解析** —— 否则会把"某个子项目的交接单"写成工作区级的，
  //   正是容器里最该避免的事（猜错 = 把 A 的交接单写给 B）。
  const isContainer = container.marker !== undefined || container.nestedRepo !== undefined;
  let handoffRel;
  let handoffAbs;
  let handoffLatestRel;
  if (!isContainer) {
    const manifestHandoff =
      typeof manifest?.handoffDir === "string" && manifest.handoffDir !== "" ? manifest.handoffDir : undefined;
    if (manifestHandoff !== undefined) {
      const cand = path.resolve(projectRoot, manifestHandoff);
      if (isUnder(projectRoot, cand)) {
        handoffRel = toGitRel(projectRoot, cand);
        handoffAbs = cand;
      }
    } else {
      // 没登记 ⇒ 只认**已经存在**的候选目录，绝不擅自新建。
      for (const c of HANDOFF_DIR_CANDIDATES) {
        try {
          if (fs.statSync(path.resolve(projectRoot, c)).isDirectory()) {
            handoffRel = c;
            handoffAbs = path.resolve(projectRoot, c);
            break;
          }
        } catch {
          /* 不存在就下一个 */
        }
      }
      if (handoffRel === undefined) {
        // 连候选都没有 ⇒ 用我们的约定名（**写的时候才建目录**）。
        handoffRel = DEFAULT_HANDOFF_DIR;
        handoffAbs = path.resolve(projectRoot, DEFAULT_HANDOFF_DIR);
      }
    }
    // ★ 顺带找出**最新的一份**：这才是"新会话该去读哪一份"的答案。
    //   只列目录不说哪份最新，等于把挑选的活推回给模型。
    if (handoffAbs !== undefined) {
      handoffLatestRel = latestHandoffIn(projectRoot, handoffAbs);
    }
  }

  return {
    projectRoot,
    manifest,
    manifestPath: path.join(projectRoot, MANIFEST_REL),
    isGitRepo,
    hasGitignore,
    containerMarker: container.marker,
    nestedRepo: container.nestedRepo,
    isContainer,
    source,
    decisionsSource,
    archiveSource,
    logSource,
    logGuess,
    activeRel: typeof activeRel === "string" ? activeRel : undefined,
    decisionsRel: typeof decisionsRel === "string" ? decisionsRel : undefined,
    archiveRel: typeof archiveRel === "string" ? archiveRel : undefined,
    logRel: typeof logRel === "string" ? logRel : undefined,
    notesRel,
    notesAbs,
    notesSource,
    handoffRel,
    handoffAbs,
    handoffLatestRel,
    activeAbs,
    logAbs,
    activeExists: activeText !== undefined,
    activeLines,
    maxActiveLines,
    overThreshold: activeLines > maxActiveLines,
    logLevels: parseLevels(manifest?.logLevels, defaultLogLevels()),
  };
}

/**
 * 向下找"子项目"的 `.git`，最多 `CONTAINER_SCAN_DEPTH` 层、每层最多 `CONTAINER_SCAN_FANOUT` 个目录。
 *
 * ★ 为什么需要这个：本插件只把 `session.header.cwd` 当"项目根"。但本机这种
 *   **总工作区/容器目录**（如一个汇总工作区，根下没有 `.git`，却在
 *   它的二层子目录里各有独立 Git 仓库）会被
 *   `isFreshProject` 误判成"全新项目"，每开一次会话就劝用户 `git init` —— 而
 *   这里**恰恰最不该**初始化：它是个装着许多仓库的容器，不是仓库。
 *
 * 只看目录、不做任何 IO 之外的判断；出错一律当"没找到"（宁可不提示，也不误提示）。
 *
 * @returns {string|undefined} 找到的第一个子仓库的**相对路径**（正斜杠），没找到则 undefined
 */
function findNestedGitRepo(projectRoot) {
  let frontier = [projectRoot];
  for (let depth = 1; depth <= CONTAINER_SCAN_DEPTH; depth += 1) {
    const next = [];
    for (const dir of frontier) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      let seen = 0;
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        // 跳过明显不是项目的目录，省得把 node_modules 里上千个包全扫一遍。
        if (NOT_A_SUBPROJECT_RE.test(e.name)) continue;
        if (seen++ >= CONTAINER_SCAN_FANOUT) break;
        const child = path.join(dir, e.name);
        try {
          if (fs.existsSync(path.join(child, ".git"))) {
            const rel = path.relative(projectRoot, child);
            return rel.split(path.sep).join("/");
          }
        } catch {
          /* 读不了就跳过 */
        }
        next.push(child);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return undefined;
}

/** 本层有没有"容器工作区标志文件"（AGENTS.md 之类）。 */
function findContainerMarker(projectRoot) {
  for (const m of CONTAINER_MARKERS) {
    try {
      if (fs.statSync(path.join(projectRoot, m)).isFile()) return m;
    } catch {
      /* 不存在就下一个 */
    }
  }
  return undefined;
}

/**
 * 带 TTL 缓存的容器事实。见 `CONTAINER_CACHE_TTL_MS` 的说明。
 * 只在"本层没有 `.git`"时才会被调用 —— 有 `.git` 的目录本身就是项目，不必扫。
 */
function containerFacts(projectRoot) {
  const key = path.resolve(projectRoot);
  const hit = containerCache.get(key);
  const now = Date.now();
  if (hit !== undefined && now - hit.at < CONTAINER_CACHE_TTL_MS) {
    return { marker: hit.marker, nestedRepo: hit.nestedRepo };
  }

  // 先看有没有嵌套仓库 —— 这条**单独就成立**：一个目录只要装着别的 Git 仓库，
  // 它自己就不再是"新项目"，无论有没有标志文件、有多少子目录。
  const nestedRepo = findNestedGitRepo(key);

  // 再看标志文件，且必须配上"已经有多个子项目"才算容器（见 CONTAINER_MIN_SUBDIRS）。
  const childDirs = countChildDirs(key);
  const marker =
    childDirs >= CONTAINER_MIN_SUBDIRS ? findContainerMarker(key) : undefined;

  const value = { at: now, marker, nestedRepo };
  containerCache.set(key, value);
  // 缓存别无限长：一个长跑的内核会看到很多工作区。
  if (containerCache.size > 64) {
    const oldest = [...containerCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest !== undefined) containerCache.delete(oldest[0]);
  }
  return { marker, nestedRepo };
}

/**
 * "这个工作区是不是一个全新项目"的判据。
 * 需求 ①：没有 Git 仓库、没有 LEDGER.md。本插件口径放宽到"没有台账"。
 *
 * ★ 但"没有 Git 仓库"必须区分**两种完全不同的情况**：
 *   - 真的是新项目（空目录 / 几个散装文件）⇒ **该提示**初始化；
 *   - 是**容器工作区**（自己不是仓库，但子目录里装着仓库 / 有 AGENTS.md 这类
 *     刻意经营的标志）⇒ **不该提示**。往容器里 `git init` 会把所有子项目的
 *     历史卷进一个错误的父仓库，是最糟的误操作之一。
 *
 * 所以容器特征命中时一律判"不是全新项目"，宁可不提示。
 */
function isFreshProject(info) {
  if (info.isGitRepo || info.activeRel !== undefined) return false;
  if (info.containerMarker !== undefined) return false;
  if (info.nestedRepo !== undefined) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Git
// ═══════════════════════════════════════════════════════════════════════════

/** 跑一条 git 子命令。**永不抛**，返回 {ok, stdout, stderr, code}。 */
function git(projectRoot, args) {
  try {
    // ★ 用 args 数组、不走 shell ⇒ 路径里的空格/中文/引号都不会变成命令注入。
    const r = spawnSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    });
    const code = r.status === null ? -1 : r.status;
    return {
      ok: code === 0,
      code,
      stdout: String(r.stdout ?? "").trim(),
      stderr: String(r.stderr ?? "").trim(),
      error: r.error ? String(r.error.message ?? r.error) : undefined,
    };
  } catch (e) {
    return { ok: false, code: -1, stdout: "", stderr: "", error: String((e && e.message) || e) };
  }
}

/** git 是否可用（拿不到就如实说，不假装）。 */
function gitAvailable() {
  const r = git(process.cwd(), ["--version"]);
  return r.ok ? r.stdout : undefined;
}

/**
 * 合并式写 .gitignore：**不覆盖**已有内容，只补齐缺的行。
 * 返回 {changed, added, path}。
 */
function mergeGitignore(projectRoot, lines) {
  const file = path.join(projectRoot, ".gitignore");
  const existing = readTextSafe(file);
  const had = existing === undefined ? "" : existing;
  const present = new Set(
    had
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((l) => l.trim())
  );
  const missing = lines.filter((l) => l !== "" && !present.has(l));
  if (existing !== undefined && missing.length === 0) {
    return { changed: false, added: [], path: file, created: false };
  }
  let next = had;
  if (next !== "" && !next.endsWith("\n")) next += "\n";
  if (missing.length > 0) {
    if (next !== "") next += "\n";
    next += "# 由 dsh-ledger-memory 追加\n";
    for (const l of missing) next += l + "\n";
  } else if (next === "") {
    next = "# 由 dsh-ledger-memory 创建\n";
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, next, "utf8");
  return { changed: true, added: missing, path: file, created: existing === undefined };
}

/**
 * `git add -- <明确路径>`。
 * ★ 红线：**永不 `git add -A`** —— 只把我们点到名的台账文件加进去。
 */
function gitAdd(projectRoot, relPaths) {
  const unique = [...new Set(relPaths.filter((p) => typeof p === "string" && p !== ""))];
  if (unique.length === 0) return { ok: false, reason: "no paths" };
  return git(projectRoot, ["add", "--", ...unique]);
}

// ═══════════════════════════════════════════════════════════════════════════
// 注入文本（给模型看的"下一步指引"）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 把当前项目的台账事实渲染成一段注入文本。
 *
 * ★ 三种情形（fresh / 已初始化 / 待办命令），每次**只出一段**。
 * ★ 写法刻意模仿官方的指令优先级措辞：这些是**提示**，不许覆盖用户直接指令。
 *
 * @param {boolean} afterCompaction 压缩刚跑完 ⇒ 走情形 Z（**高保真重注**）。
 */
function renderInjection(info, pending, afterCompaction, shadowedIndex, biOpts) {
  const head = headOf(info);

  // ── 情形 Z：上下文刚被压缩 ⇒ 台账 + **高保真胶囊**一起重注（需求 ③㉑）────
  //
  // ★ 为什么必须无条件重注、不能走去重：压缩前后**台账文件一个字都没变**，
  //   指纹（路径|行数|mtime）因此完全相同，正好会被"没变就不重注"的逻辑挡掉 ——
  //   而那恰恰就是"压完之后 AI 手里没有台账"这个 bug 的成因。
  //
  // ★ `capsule` 由调用方在**压缩之前**抓好（压缩一跑，会话记忆的去重集合
  //   与当时的上下文都变了）。这里只负责渲染。
  // ★ 注意判据是**真值**而不是 `=== true`：调用方现在会传一个对象
  //   （`{capsule, ours}`）把胶囊一起带进来。写成 `=== true` 会让
  //   "压缩后重注"整条路**静默退化成普通注入** —— 实测就是这样漏的。
  if (afterCompaction !== undefined && afterCompaction !== false) {
    const capsule = typeof afterCompaction === "object" ? afterCompaction.capsule : undefined;
    const meta = typeof afterCompaction === "object" ? afterCompaction : undefined;
    return renderAfterCompaction(info, capsule, meta, biOpts);
  }
  // ★★★ 2026-10-11（承 D79）：**常规注入也要推行「被压段索引」**。
  //   ★ 为什么不能只推一次：压缩后那条注入会随水位提醒/后续回合被覆盖掉，
  //     此后模型就再也看不到"原文去哪拿"了 —— 那又变回 D46 明确否掉的
  //     「等模型来查」。索引极小（一次压缩一行），**常驻**才是正确形态。
  //   ★ 去重仍靠上层的"指纹 + 文本"两道：索引变了 ⇒ 文本变了 ⇒ 自然会重注。
  const idxBlock = shadowedIndex === undefined ? "" : shadowedIndex;
  return renderInjectionBody(info, pending, biOpts) + idxBlock;
}

/** 所有注入共用的题头：声明这些事实属于哪个工作目录、且不覆盖更上位的指令。 */
function headOf(info) {
  return (
    "The following project-ledger facts belong to THIS conversation's working directory " +
    `(\`${info.projectRoot}\`). Use them as guidance; they do not override system, developer, ` +
    "or direct user instructions.\n"
  );
}

/**
 * ★★★ 2026-10-11：**短版注入** —— 用于"这次变化是**我们自己刚写出来的**"那一类。
 *
 * ★ 病（已量化，`tools/_probe-noise.mjs`）：台账注入最近**每条 ≈19,000~21,000 字符 ≈5,000 tok** ——
 *   因为台账已 **343 行**，而**每次改动都重注整份**。
 *   分类：「只有台账全文」占 **54.9%**，其中**紧跟在我们自己写入之后**的占 **24.2%**。
 *   那部分是**纯冗余** —— 模型刚写完那一刻，正文就在它自己的 `tool-call` 里。
 *
 * ★★ 为什么必须"出一段短的"、**不能只留空**（第一版就栽在这，记下来）：
 *   本函数的末尾有一道 `if (text === undefined) return decision;`，
 *   而**增量/全量压缩的编排都在它之后** ⇒ 不留 `text` 就**连压缩一起挡掉了**
 *   （实测：`regionCalls` 恒 0，五个用例变红）。
 *
 * ★ 短版里**保留什么**：① 题头（让模型知道这些事实的归属，与长版一致）
 *   ② **被压段索引**（那是"原文去哪拿"，模型**真的不知道**，不能省）
 *   ③ 一句"本轮变化是你自己写的，正文已略去"（否则模型会以为台账内容消失了）。
 */
function renderCompactInjection(info, shadowedIndex) {
  return (
    headOf(info) +
    "★ 本轮台账的变化**是你自己刚写下的**（正文已略去 —— 内容就在你刚才那次 `ledger_write` 的" +
    "工具调用里，不必重复占上下文）。要复核请用 `ledger_read`。\n" +
    (shadowedIndex === undefined ? "" : shadowedIndex)
  );
}

/**
 * 到水位线时的提醒（需求 ② 与 ⑳）。
 *
 * ★ 措辞刻意是"由你判断"，不是"现在就压缩"：用户说的是
 *   「当 AI 认为有必要的时候……也可以给这个选择题，但是**不要打断工作**」。
 *   插件只负责把"到线了"这个事实告诉 AI，问不问、什么时候问，是 AI 的判断。
 *
 * ★ 三档的**后果不同**，所以文案不同（用户需求 ⑳ 逐档指定了动作）：
 *   - 30% / 50%：**照常干活**，只是顺手把台账与日志固化一次。
 *     ★ 刻意说"不要为此停顿" —— 否则每到一个水位就打断一次，
 *     正好违反用户另一句"不要打断工作"。
 *   - 70%：**固化一次，然后由插件自己压缩，压缩完继续干**。
 *     ★★ 2026-10-09 用户改的口径（原话）：
 *       *"因为我们拦不住官方内核的自动压缩，所以说我们尽量在 70% 左右就把我们的压缩做好"*
 *       *"AI 执行完我们插件的功能之后，要继续工作，工作是不能被影响的"*
 *     ⇒ 所以这一档**不再是"停手收尾"**（那是旧设计），而是：
 *       ① 把状态固化（写台账 + L1）；
 *       ② **插件自己**在回合末 idle 时执行高保真压缩（`compactNow`）；
 *       ③ AI **不要停** —— 继续手上的活，压缩对它无感（旧历史换成摘要 + 逐字胶囊）。
 *     理由：70→80 只剩 10%，我们**必须**在那之前自己压一次，
 *     否则就只能被动挨官方的 80% 那一下。
 *
 * @param {number} tier 触发的那个水位（0.3 / 0.5 / 0.7）
 */
function renderPressureNotice(info, pressure, tier) {
  const pct = Math.round(pressure.ratio * 100);
  const line = Math.round(tier * 100);
  // ★★★ 2026-10-12（D129，用户拍板）：**分流**是标准步骤（两种模式已合并）。
  //   见 `triageRequired` 的注释。
  const surgical = triageRequired();
  const head =
    headOf(info) +
    `\n## 上下文水位已到 ${line}%（现 ${pct}%）\n\n` +
    `实测：已用 ${pressure.total} tokens / 官方上限 ${pressure.window} tokens。` +
    "官方会在 **80%** 处自动压缩，那时已读进上下文的东西会丢。\n\n";

  // 分流那一步的文案（两种模式共用同一段，避免两处各写一份而分叉）。
  // ★★★ 2026-10-12（D129）：**语气从「义务」改回「该怎么分」** ——
  //   用户本轮删掉了水位档的义务（防卡），所以这里不再声称"不做就压不成"。
  //   ★ 保留的是**方法本身**（三个桶怎么分）—— 那部分仍然有用，
  //     而且现在由"压缩前的标准动作"来触发它（见 `triageRequired`）。
  const triageStep =
    "3. ★★ **做一次分流**（`ledger_triage`）—— 把这一段产出**当场分成三个桶**：\n" +
    "   - `keep` **留在上下文**：下一轮不知道就会做错的东西（当前任务状态、" +
    "还没验证的假设、**用户定过的约束**）。压缩后它会被**逐字注回**。\n" +
    "   - `stash` **落进项目**：以后可能要查、但不该占上下文的（判断与理由、" +
    "走不通的路、关键文件位置）。写进 `_stash/`，**永不注入**，需要时自己 grep。\n" +
    "   - `drop` **丢掉**：已被取代 / 已完成且不再影响判断的。\n" +
    "   ⚠️ **留得太多等于没压** —— `keep` 只放「不知道就会做错」的，" +
    `最多 ${numOf("triageKeepMax", TRIAGE_KEEP_MAX)} 条（超了按你给的顺序截断，并会如实告诉你截掉几条）。\n` +
    "   ★ 这一步决定**「哪些能压、哪些怎么压」** —— 也是压缩后「指针」能给全的前提。\n";

  if (tier >= 0.7) {
    // ★★★ 2026-10-12（D129，用户拍板）：**这一档也从「义务」改回「建议」。**
    //
    //   用户原话：*"然后去除三个节点的义务。以防模型被卡。"*
    //   ★ 历史（D115 那次是**反方向**改的）：当时用户要求"增强强制性……这不是建议，
    //     而是命令" —— 那时**闸门真的会拦**，所以"义务"是**如实**描述后果。
    //   ★★ 现在**闸门不再因水位拦压缩**了（义务已删）⇒ 再写"你不做压缩就不发生"
    //     就是**假话**（本机纪律：**写了就得做到**，否则是空承诺）。
    //   ⇒ 保留"给出动作"（那部分仍然有效，正是 D125 的诉求），去掉"义务/后果"那部分。
    return (
      head +
      "### ★ 到 70% 了：建议做三步（顺序不能换）\n\n" +
      "到这里，插件**建议**你把这一段的进展固化下来、并折一次上下文。" +
      "**这不是义务，也不会拦你** —— 完全由你判断时机。\n\n" +
      (surgical
        ? "**标准动作是三步**（第③步做完继续干活）：\n"
        : "**动作是两步**（第②步做完继续干活）：\n") +
      "1. 把本轮进展写进活跃台账（`ledger_write`，带 `ifRevision` 与你的会话编号）；\n" +
      (info.logRel !== undefined
        ? "2. 写一条活动日志 L1 摘要（`ledger_log_write`，title 必填）；\n"
        : "") +
      (surgical ? triageStep : "") +
      `\n★★★ **然后是关键的一步：请你自己调一次压缩** —— \`ledger_compact\`（\`mode:"light"\`）：\n` +
      "   - 它在**回合内**执行，**不影响你手头的工作**，不必等回合结束；\n" +
      "   - ★ **前提是这一步已经落盘**（压缩前强制先记台账 —— 那是唯一的硬闸门）；\n" +
      "   - 不调也不会丢东西，但水位会继续涨：涨到官方 **80%** 时由**内核**硬压，" +
      "那一次**抓不到逐字胶囊**（用户原话 / 报错原文 / 器物索引全丢）。\n" +
      "   ★ 即：**动作是「写台账 → 分流 → 调 ledger_compact」** —— " +
      "第三步才是真正腾出空间的那一步。\n\n" +
      "★★ **做完就继续手上的工作，不要停、也不要为此提问。**" +
      "若水位涨到全量线（本插件会在那一档兜底压一次），那是**安全网**，不是你的替代品。\n" +
      "压缩对你**基本无感**：旧历史会被换成摘要，同时插件会把你这一段用过的" +
      "**逐字胶囊**（用户原话 / 报错原文 / 器物索引 / 可重读路径）" +
      (surgical ? "与**你自己挑的分流单**" : "") +
      "重新注回来 —— " +
      "所以压完之后你仍然知道我们刚才在做什么、改过哪些文件。\n\n" +
      "★ 若你**确实**想在这个水位把选择权交给用户（例如本轮要做的事一时说不完，" +
      `值得写交接单），那才调用 \`${CHECKPOINT_TOOL}\`；否则**不必打扰他**。\n\n` +
      "（本条每个会话每个水位只发一次；压缩之后水位会掉回去，届时会重新武装。）"
    );
  }

  return (
    head +
    // ★★★ 2026-10-12（D129，用户拍板）：**这一档不再是"义务"，也不再拦任何东西**。
    //
    //   用户原话：*"然后去除三个节点的义务。以防模型被卡。"*
    //   病是实的（本机前科 D59）：落了义务 ⇒ `flushBeforeCompact` 不许压 ⇒
    //   而它**可能永远不去写那一笔** ⇒ 闸门一直拦 ⇒ 一路撞进内核 80%（抓不到胶囊）。
    //
    //   ⇒ 现在的语义：**提醒就是提醒**。写不写由它判断，**不写也不拦压缩**；
    //     唯一的硬闸门仍然是"**压缩前**必须先落盘"（那是压缩那一刻的事，不是水位的事）。
    //   ★ 我删代码时**漏改了这段文案**（还写着"不写，压缩就不会发生"）——
    //     是新加的断言 **53b** 把它当场抓出来的（在此之前那条断言从未被执行过）。
    //     ⇒ 那等于**继续骗模型**：它照样以为不写就压不了。
    "### ★ 水位提醒（不是义务，也不拦任何东西）\n\n" +
    `水位到 ${line}%，建议顺手把这一段的进展固化下来（一两行，很便宜）。\n\n` +
    `现在是第 ${line}% 水位，**建议各做一次**台账与日志更新：\n` +
    "1. 把这一段的进展写进活跃台账（`ledger_write`，带 `ifRevision` 与你的会话编号）；\n" +
    (info.logRel !== undefined
      ? "2. 写一条活动日志 L1 摘要（`ledger_log_write`，title 必填）。\n"
      : "") +
    // ★ 分流**只在 70% 那一档要**（它比写台账贵：要 AI 判断）。
    //   30/50% 只做"低成本固化"，不打扰它做分类 —— 否则每档都要它多产出一段。
    "\n★ **写完就继续干活，不要为此停顿。**" +
    "★ 写不写**不影响你能不能压缩** —— 只有**压缩前**才强制要求先落盘。\n" +
    // ★★★ 2026-10-12（D125）：**必须在这一档也给出「动作」，不能只给「概念」。**
    //   病（用户看截图抓到的）：模型知道自己"要写台账加压缩"，却**从不调压缩工具**
    //   —— 因为所有通道都只提醒它"该压缩了"这个**概念**，
    //   而 70% 档那句"插件会自动执行"又**明确把它排除在动作之外**。
    "★ 若这一段你已经用完（探索做完 / 大段输出已消费 / 结论已写进台账），" +
    "**可以顺手调一次** `ledger_compact`（`mode:\"light\"`）把它折起来：" +
    "它在**回合内**执行、**不影响你手头的工作**；压掉的内容留了逐字副本，" +
    "以后能用 `ledger_recall` 读回来。★ **不必等水位，也不必等回合结束。**\n" +
    (surgical
      ? "★ 压缩前的标准动作是三步（顺序不能换）：`ledger_write` → " +
        "`ledger_triage`（分流：留 / 落 / 丢）→ `ledger_compact`。\n"
      : "") +
    "★ 任何时候你**自己觉得有必要**（做完一个阶段、要换方向、改动很大），" +
    `都可以随时调用 \`${CHECKPOINT_TOOL}\` —— 不必等水位。\n\n` +
    "（本条每个会话每个水位只发一次；压缩之后水位会掉回去，届时会重新武装。）"
  );
}

/** 组装注入正文。`pending` 有值 ⇒ 是 /ledger 命令的兑现指令。 */
function renderInjectionBody(info, pending, biOpts) {
  const head = headOf(info);

  // ── 情形 A：用户刚敲了 /ledger <cmd>，这条要优先兑现 ────────────────────
  if (pending !== undefined) {
    const body = {
      init:
        "## 项目台账：用户请求初始化\n\n" +
        "用户刚执行了 `/ledger init`。请按顺序做：\n" +
        "1. 先判断这个项目**是什么类型**（游戏模组 / 插件 / 工具箱 / 文档库 / 其他），" +
        "然后**自己设计**一套适合它的台账结构 —— 文件名、分几个文件、有哪些字段，都由你定。\n" +
        "2. 结构必须满足四条硬约束：\n" +
        "   - 一个**当前活跃台账**（记录：项目目标 / 已完成 / 进行中 / 下一步 / 关键锚点）；\n" +
        "   - 一个**独立的关键决策记录**（架构·接口·协议等长期决策，不随日常更新被覆盖、不参与归档）；\n" +
        "   - 一个**归档目录**（只追加不删除）；\n" +
        "   - 活跃台账保持精简（建议 ≤ " +
        info.maxActiveLines +
        " 行）。\n" +
        "3. 用 `ledger_init` 把设计登记下来（它会顺带 `git init` 和合并式写 `.gitignore`），" +
        "把你写的初始内容一并通过 `initialActive` / `initialDecisions` 传进去。\n" +
        "   —— 同时**建议**传 `logDir`（如 `_ledger-log`）启用活动日志：它按周分桶、" +
        "与归档共用同一个 `YYYY-MM/weekN` 期间键，且**永不注入上下文**，只在回溯时用 " +
        "`ledger_log` 读切片。若不传，日志就不启用（不会往项目里偷偷建目录）。\n" +
        "4. 做完向用户简报一句：文件名、结构、以及台账已纳入 Git 追踪。",
      update:
        "## 项目台账：用户请求更新\n\n" +
        "用户刚执行了 `/ledger update`。请把**本次会话的进展**写回活跃台账：\n" +
        "- 完成了什么、当前卡在哪里、下一步要做什么；\n" +
        "- 格式按**你自己设计的那套结构**来，但必须精简；\n" +
        "- 用 `ledger_write`（`target: \"active\"`，`mode: \"replace\"` 或 `\"append\"`）落盘；\n" +
        "- 若超出 " +
        info.maxActiveLines +
        " 行，先用 `ledger_archive` 把最旧的已完成条目移进归档，再写。" +
        (info.activeRel === undefined
          ? "\n\n⚠ 本工作区**还没有台账**。要先 `/ledger init`。"
          : ""),
      archive:
        "## 项目台账：用户请求归档\n\n" +
        "用户刚执行了 `/ledger archive`。请：\n" +
        "1. 用 `ledger_read`（`target: \"active\"`）读当前活跃台账；\n" +
        "2. **由你决定**归档哪些条目（原则：最旧的、已完成的、不再影响后续判断的）；\n" +
        "3. 用 `ledger_archive` 一次提交两样东西：`entries`（要归档的原文）和 " +
        "`newActive`（移除这些条目后的活跃台账全文）——\n" +
        "   插件负责按 `YYYY-MM/weekN` 建目录、只追加、并把新的活跃台账写回；\n" +
        "   ★ **同时带上 `ifRevision`**（就是你刚读到的那个版本号）—— 多会话同项目时，\n" +
        "     若它已经变了，插件会**一个字节都不写**并要求你重读，这样就不会把别的会话\n" +
        "     刚写进去的条目当废料归档掉。这条调用是**可以安全重发**的：失败不留痕，\n" +
        "     同一批 `entries` 重发也不会被追加两次；\n" +
        "4. 归档**只追加不删除**，别去改已有的归档文件。" +
        (info.activeRel === undefined ? "\n\n⚠ 本工作区还没有台账。" : ""),
      // ★ 第③层：交接单。**必须给出四段结构**，否则模型会写一篇散文，
      //   而"下一步 + 确切文件路径"才是接手时真正要用的东西。
      handoff:
        "## 项目台账：用户请求写交接单\n\n" +
        "用户刚执行了 `/ledger handoff`。请用 `ledger_handoff` 写一份**给下一场会话看**的交接单：\n" +
        "- `did`：这一场**做了什么**（具体到改动，不要写「推进了工作」这种空话）；\n" +
        "- `state`：**当前状态** —— 什么能跑、什么不能、什么是半截的。★ 这一段最省下一场的时间；\n" +
        "- `next`：**下一步**（具体可执行）；\n" +
        "- `files`：**关键文件的确切路径**（不是描述 —— 下一场会去打开它们）；\n" +
        "- `blocked`：卡点，或需要人来拍板的事（没有就留空）。\n\n" +
        "★ **不要自己找地方写** —— 那个工具会落到项目的约定位置，" +
        "而且**下一场会话开在这个项目时，插件会自动在注入里告诉它「先读这一份」**。\n" +
        "★ 若这一轮还有未落盘的进展，先用 `ledger_write` 写进活跃台账，再写交接单。",
    };
    return head + "\n" + (body[pending.command] ?? body.update);
  }

  // ── 情形 B：全新项目 ⇒ 主动提示用户（需求 ①）─────────────────────────────
  if (isFreshProject(info)) {
    return (
      head +
      "\n## 项目台账：这是一个未纳入台账的工作区\n\n" +
      "本工作区**既没有 Git 仓库、也没有任何台账文件**，看起来是一个全新项目。\n\n" +
      "**请主动问用户一句**（用 `ask_user_question`，别自己直接动手）：\n" +
      "> 这个目录看起来是新项目。要不要我给它初始化 Git + 一套项目台账？\n\n" +
      "用户同意后（或他直接说 `/ledger init`）：\n" +
      "1. 判断项目类型，**自己设计**台账结构（活跃台账 + 关键决策记录 + 归档目录，四条硬约束见 `/ledger init` 的说明）；\n" +
      "2. 用 `ledger_init` 登记结构，它会顺带 `git init` 与合并式写 `.gitignore`。\n\n" +
      "用户说不用，就别再提了 —— 同一会话里不要反复追问。"
    );
  }

  // ── 情形 C0：容器工作区（自己不是仓库，但装着子项目）⇒ 不劝初始化 ──────────
  //
  // ★ 需求 ① 说的是"检测到**全新项目**时提示"。容器工作区**不是**新项目：
  //   往这里 `git init` 会把所有子项目卷进一个错误的父仓库。
  //   所以这里只留一句"我知道这是容器"，不追问、不劝 init。
  //
  // ★★ 但只说"别初始化"是不够的 —— 本机实测 **112 个会话里 104 个**的 cwd 就是
  //   容器根，也就是说绝大多数会话根本不是"某个项目"，而是"修一个问题 / 调研一件事"。
  //   旧版本在这里就**没有下文了**，等于把 93% 的会话扔下。
  //   所以现在要接着给出路：**问题记录**（`ledger_note`）—— 它顺着工作区已有的
  //   `60-对话记录与交接\对话总结\` 通道走，不新建任何东西，也不碰 Git。
  if (!info.isGitRepo && info.activeRel === undefined) {
    const why =
      info.containerMarker !== undefined
        ? `本目录有工作区标志文件 \`${info.containerMarker}\``
        : info.nestedRepo !== undefined
          ? `本目录的子目录里有 Git 仓库（如 \`${info.nestedRepo}\`）`
          : undefined;
    if (why !== undefined) {
      return (
        head +
        "\n## 项目台账：这是容器工作区，不要在这里初始化\n\n" +
        `${why}，所以这是一个**装着多个项目的总工作区**，而不是一个全新项目。\n\n` +
        "**不要**在此目录 `git init`，也**不要**在此建台账 —— 那会把下面所有子项目" +
        "卷进一个错误的父仓库。\n\n" +
        "### 那该记哪儿？（★ 按有没有「累积状态」分）\n\n" +
        "**① 这次是在做某个子项目**（有持续维护的当前状态、以后要接着干）⇒\n" +
        "在那个子目录里初始化台账。本插件的项目根取会话工作目录，所以换个工作目录" +
        "打开那个项目，`/ledger init` 才会落在正确的地方；\n" +
        "也可以不换目录，直接给台账工具传 `root` 点名子项目（例如 " +
        "`ledger_write({ root: \"20-DSH插件/…\", target: \"active\", content: \"…\" })`）。\n\n" +
        "**② 这次只是在解决一个问题 / 做一次调研 / 排查一次故障**（一次性、有终点）⇒\n" +
        "**不要建台账**，用 `ledger_note` 写一份**问题记录**：\n" +
        "- 它会落到工作区已有的记录通道 `" +
        info.notesRel +
        "`（既有的那 27 份就在那儿，命名 `YYYY-MM-DD-主题.md`）；\n" +
        "- 内容是「现象 → **根因** → 结论 → 做过什么」，**没有**「当前目标 / 下一步 / 归档」——" +
        "因为一个问题有终点，那些字段对它没有意义；\n" +
        "- 已存在的同名记录**永不覆盖**（记录是证据）。\n\n" +
        "判据就一句话：**会一直改、以后要接上 ⇒ 台账；查完就结束 ⇒ 问题记录。**\n\n" +
        "### 另外：用户消息存档（L4）在这个目录**没在工作**\n\n" +
        "本插件有一档「**自动记住用户说过的每一句话**」的记录（L4，带会话编号与发送时间，" +
        "**不注入上下文**，可以按需查），但它挂在**项目的活动日志**上 —— " +
        "而本目录没有登记过日志，所以**这里的对话一句都没被记下来**。\n\n" +
        "★ 这件事**只在本次会话问一次**（就是现在），之后无论答案如何都不要再提：\n" +
        "- 用户想要 ⇒ **必须**用 `allowContainer: true` + `gitInit: false` 打开，" +
        "例如 `ledger_init({ allowContainer: true, gitInit: false, logDir: \"_ledger-log\", … })` ——" +
        "**绝不能**在这个容器里 `git init`（那会把所有子项目卷进错误的父仓库）；" +
        "也可以只在**某个子项目**里开，那就把 `root` 指到那个子项目；\n" +
        "- 用户不想要 ⇒ 就此打住，**别再问第二遍**。\n\n" +
        "★ 除上面这一问之外：若用户没提台账的事，就**什么也别说**，正常干活 —— " +
        "需要留记录时直接用 `ledger_note`。"
      );
    }
  }

  // ── 情形 C：已有台账 ⇒ 把活跃台账注进来（需求 ③）──────────────────────
  if (info.activeExists && info.activeAbs !== undefined) {
    const raw = readTextSafe(info.activeAbs) ?? "";
    // ★ D138：读上限可调（面板改了必须真生效 ⇒ 经 `numOf` 取，不直读常量）。
    const readMax = numOf("maxReadChars", MAX_READ_CHARS);
    const text =
      raw.length > readMax
        ? raw.slice(0, readMax) + `\n\n…（台账过长，已截断；全文 ${raw.length} 字符）`
        : raw;

    const tail =
      "\n\n---\n**台账约定**（本插件只做流程，结构由你之前设计时定）：\n" +
      `- 活跃台账：\`${info.activeRel}\`（当前 ${info.activeLines} 行，上限 ${info.maxActiveLines} 行）\n` +
      (info.decisionsRel !== undefined ? `- 关键决策：\`${info.decisionsRel}\`（**不参与归档、永久保留**）\n` : "") +
      (info.archiveRel !== undefined ? `- 归档目录：\`${info.archiveRel}\`（只追加不删除）\n` : "") +
      (info.logRel !== undefined
        ? `- 活动日志：\`${info.logRel}\`（按周分桶，**永不注入上下文**；` +
          `回溯用 \`ledger_log\`，写摘要用 \`ledger_log_write\`）\n`
        : "") +
      "\n★★ **台账与 L1 是你的义务，不是可选项**（这是本插件存在的全部理由）：\n" +
      "会话告一段落时，把「完成了什么 / 卡在哪 / 下一步」用 `ledger_write` 写回活跃台账。\n" +
      // ★★★ 第③层：交接单（2026-10-10）
      //
      // ★ 为什么必须放在**这条尾巴**里，而不是只放在胶囊里：
      //   胶囊是**压缩之后**才注入的（`renderAfterCompaction`）；而**新会话的第一轮**
      //   走的是这里。交接单的全部意义就是"新会话接着上次干" ——
      //   放在胶囊里等于"先压缩一次才告诉你上次干到哪"，顺序反了。
      // ★★ 而且必须给**文件名**而不是只给目录：只给目录 = 把"挑哪一份"的活推回给模型，
      //   而它恰恰没有"哪份最新"的信息。这就是 D34 那条结论：
      //   **恢复必须是「推」给模型的，不能是「等模型来查」的。**
      (info.handoffLatestRel !== undefined
        ? "\n★ **接手这个项目时，先读上一次的交接单**：" +
          `\`${path.join(info.projectRoot, info.handoffLatestRel)}\`\n` +
          "  那是上一场会话**特意为你写的**（做了什么 / 当前状态 / 下一步 / 关键文件路径）。" +
          `  如果这一轮要收尾或换方向，用 \`ledger_handoff\` 再写一份给下一场。\n`
        : info.handoffRel !== undefined
          ? "\n★ 这个项目**还没有交接单**。若这一轮做完了一个阶段、或你要换方向，" +
            "用 `ledger_handoff` 写一份（它会落到 " +
            `\`${info.handoffRel}/\`）—— ` + "下一场会话接手时会**自动被引导去读它**。\n"
          : "") +
      // ★ 多会话同项目（用户提议）：把"谁写的"标出来，并带上版本号让插件能判新旧。
      "- **多会话同项目**：本项目当前修订号是 `revision: " +
      manifestRevision(info.manifest) +
      "`。写台账时请带上 `ifRevision: " +
      manifestRevision(info.manifest) +
      "`；条目行首请加**本会话编号**（见下），这样别的会话一眼看得出是谁写的。\n" +
      "  若你手上的内容已经过期，插件**不会拒绝你**，而会把对方那些你没见过的条目自动留在" +
      "「其他会话的进展（自动保留）」小节里 —— 你**不需要重写**，但下次维护时要把它并进正文并删掉该小节。\n" +
      "  想知道谁改过这份台账、或某个条目哪去了，查 `ledger_log`（`view:\"audit\"`）。\n" +
      (info.logRel !== undefined
        ? "**另有**一档只有你能填：活动日志的 L1 回合摘要（`ledger_log_write`）。" +
          "L0 里程碑 / L2 文件流水 / L3 工具流水都是机器自动采集的（不花你的 token），" +
          "但它们只记「发生了什么」，**没有「为什么」** —— 那个只能由你写。" +
          "所以**每次准备回答 `" +
          CHECKPOINT_TOOL +
          "` 之前，先花一行写一条 L1**（同样是义务：L0/L2/L3 只记「发生了什么」，" +
          "「为什么」没有任何机器能替你补）。\n"
        : "") +
      (info.overThreshold
        ? `\n⚠ **活跃台账已超 ${info.maxActiveLines} 行**（现 ${info.activeLines} 行）。` +
          "请用 `ledger_archive` 把最旧的已完成条目移进归档，再用 `ledger_write` 写精简版。\n"
        : "") +
      (info.decisionsRel !== undefined
        ? "\n用户在会话中定了**架构 / 接口 / 协议**这类长期决策时，" +
          `用 \`ledger_write({target:"decisions", mode:"append"})\` 记一条 —— 它不会随日常更新被覆盖。\n`
        : "") +
      // ═══════════════════════════════════════════════════════════════════════
      // ★★★ 2026-10-12（D129，用户拍板）：**压缩策略合同**（规格 ①⑤⑨）
      // ═══════════════════════════════════════════════════════════════════════
      //
      //  用户原话：*"把所有的压缩全部给模型，包括全量压缩和轻量压缩，前提是所有的
      //  约束行为都必须先写台账……全量压缩，最迟最迟发生在 75%（可调），即使模型
      //  没有主动压缩。像 billion 那样，模型会大量调用压缩……但是，我们要做的不一样的
      //  点是，**模型必须更积极的去看外置记忆**。"*
      //
      //  ★ 为什么要把这一整段"一次性讲清楚"（合同式告知），而不是零散地提：
      //    D114 以前那套文案是**两个通道一起**告诉模型"压缩不关你的事"
      //    ⇒ 实测 7870 次工具调用里 `ledger_compact` **只被调 2 次**。
      //    ⇒ 现在**权力全部交还给它**，那就必须同时把**边界**讲明白：
      //      它得知道线在哪、兜底何时接管、以及"压掉的东西去哪拿"。
      //
      //  ★ 三条腿（缺一不可）：
      //    ① **职责**：压缩是你的活（不是插件替你干）
      //    ② **边界**：75% 是兜底线，由插件接管 —— 所以要在那之前自己压
      //    ③ **指针**：压掉的原文去哪取（这是与 billion 最本质的差别，见规格⑪）
      "\n★★★ **压缩策略（这是你与插件之间的合同）**\n" +
      "- 压缩**全部由你决定**：轻量（`mode:\"light\"`，回合内压最旧一段）与全量\n" +
      "  （`mode:\"full\"`，回合末执行）都由你按需调用 `ledger_compact`。\n" +
      "- ★ **每涨 4~5 点，按这个顺序做三步**（这是标准动作，不是三个可选项）：\n" +
      "  ① **`ledger_write`**（+ `ledger_log_write`）—— 把这一段进展落盘；\n" +
      "  ② **`ledger_triage`** —— 当场把这一段分成三个桶（`keep` 留上下文 / " +
      "`stash` 落进项目 `_stash/` / `drop` 丢掉）；\n" +
      "  ③ **`ledger_compact`（`mode:\"light\"`）** —— 轻量压缩，回合内执行、不影响工作。\n" +
      "  ★ **顺序不能换**：①②是压缩的前置条件（闸门会拦），③做完会重新注入台账与胶囊。\n" +
      "  ★ 为什么必须先分流：**它决定「哪些能压、哪些怎么压」** —— " +
      "`keep` 桶里那些「下一轮不知道就会做错」的东西，压缩后会被**逐字注回**。\n" +
      "- **节奏建议**：大约每涨 **4~5 点**折一次 —— 一次压掉「上次压缩以来增量的一半」。\n" +
      "  ★ 不必更碎（那只是白打冷缓存），也不要攒很久（那会让分流难做、细节丢得快）。\n" +
      `- **兜底线**：水位到 **${Math.round(currentSettings().highFidelityCompactRatio * 100)}%**` +
      "（可调，始终早于内核的 80%）时，**插件会替你压一次全量**，即使你没动。\n" +
      "  ⇒ 所以你应当**主动在那之前**压 —— 兜底只在你没来得及调时接管。\n" +
      "- ★ **每次压缩前必须先落盘**（`ledger_write` + `ledger_log_write`）：\n" +
      "  压缩会把旧历史换成摘要，**没落盘的那段进展就是唯一副本**。没落盘 ⇒ 会被闸门拦下。\n" +
      // ★ 规格⑪（指针）：与 billion 最本质的差别 —— 它只说「能恢复」，我们给**地址**。
      "- ★★ **压掉的东西去哪拿**（不必凭摘要猜）：\n" +
      "  · 每一段被压掉的历史，注入里都会给出 `ledger_recall({from,to})` 的 **seq 区间**；\n" +
      "  · 同一段还有一份**逐字胶囊**（用户原话 / 报错原文 / 器物索引）—— 路径就在索引里；\n" +
      "  · 分流时 `stash` 桶落进项目的 `_stash/`，按需 grep。\n" +
      // ★ 规格⑨（与 billion 的分工）：必须更积极看外置记忆。
      "- ★★ **（这一条是与 billion 最本质的差别）**：它的摘要**不指向原文**，只说「能恢复」；\n" +
      "  **我们的每一份摘要都必须带指针** —— 压完之后你要**更积极地去查外置记忆**：\n" +
      "  台账（项目现状）、`_stash/`（按需查的细节）、`ledger_recall`（逐字原文）。\n" +
      "  ★ 判据：**需要某个确切内容时，先去看有没有指针，而不是凭记忆复述。**\n" +
      "★ 压缩**不影响你手头的工作**：回合内的轻量压缩不必等回合结束；\n" +
      "  压完之后台账与逐字胶囊会**重新注入**，你照常继续。\n" +
      `★ 只有在**这一轮确实说不完、值得写交接单**这类情况下，才调用 \`${CHECKPOINT_TOOL}\` ` +
      "把四选一交给用户（不记录 / 只记台账 / 记台账+压缩 / 记台账+写交接单）。" +
      "正做到一半、打断代价大时别问，做完再问。\n";

    // ★★★★★ 2026-10-12（D136 步 3）**区块级注入** —— 只在开关打开时走这条路。
    //
    //   ★★★ 这里的**每一条失败路径都必须退化成"整份注入"**（安全绳 ③）。
    //     ⇒ 判据写成"**只有明确算出该省的块才省**"，其余一律给正文。
    //     ⇒ `used !== true` ⇒ 一个字节都不省，逐字回到旧行为。
    //
    //   ★★ 为什么这个开关**默认关**：它是本项目唯一会改变"模型实际看到什么"的改动，
    //     而用户的底线是"不要影响模型的准确性" ⇒ 没有实测对照之前，
    //     默认必须是与今天**逐字一致**的行为。
    // ★★★★★ 2026-10-12（D136 步 3）**区块级注入** —— 只在开关打开时走这条路。
    //
    //   ★★★ 这里的**每一条失败路径都必须退化成"整份注入"**（安全绳 ③）。
    //     ⇒ 判据写成"**只有明确算出该省的块才省**"，其余一律给正文。
    //     ⇒ `used !== true` ⇒ 一个字节都不省，逐字回到旧行为。
    //
    //   ★★ 为什么这个开关**默认关**：它是本项目唯一会改变"模型实际看到什么"的改动，
    //     而用户的底线是"不要影响模型的准确性" ⇒ 没有实测对照之前，
    //     默认必须是与今天**逐字一致**的行为。
    //
    //   ★★★ 取值必须**清单优先**（`scopeNote: "project-first"` 是承诺，不是装饰）：
    //     ⚠️ 第一版只读 `currentSettings()` ⇒ 它只反映**插件级**配置 ⇒
    //        **在项目清单里写 `blockInjection: true` 根本不生效**（自检 59③ 当场抓到：
    //        开关"打开"了却照样注入整份）。这与 `mode` / `maxActiveLines` / `logLevels`
    //        的既有口径**完全一致** —— 那几项都是"清单盖过插件级"。
    const biCfg = blockInjectionEnabled(info);
    if (biCfg) {
      const bi = renderBlockInjection(info, {
        afterCompaction: biOpts?.afterCompaction === true,
        modelAnswers: biOpts?.modelAnswers,
        histByHash: biOpts?.histByHash,
        prevBlocks: biOpts?.prevBlocks,
      });
      if (bi.used === true && typeof bi.text === "string" && bi.text !== "") {
        // ★★★★ 安全绳 ① 的前提：**记下"这一次注入的是哪些块"**，下一次才知道"哪些变了"。
        //   ★ 为什么必须记在**真正注入成功**之后：若记在"算过就算"，
        //     那么某一步没注入（去重跳过）却更新了快照 ⇒ 下一步会把
        //     "上次没注入的块"当成"已经给过正文了" ⇒ **漏注**（正是底线要防的）。
        if (biOpts?.remember === true) {
          try {
            blockSnapshots.set(info.projectRoot, splitBlocks(readTextSafe(info.activeAbs) ?? ""));
          } catch {
            /* 记不下快照 ⇒ 下次按"没有上一次"处理 ⇒ 安全绳①失效但**偏保守**（会多注） */
          }
        }
        return bi.text + tail;
      }
      // ★ 没走通 ⇒ **照旧整份注入**（绝不因为想省字符而少给内容）。
      //   这里只**如实记下原因**，便于事后查"为什么这一步没省" —— 不抛、不降级内容。
      //   （`state` 不在本函数作用域内 ⇒ 用模块级的观测槽，见 `blockInjectFallback`。）
      blockInjectFallback.set(String(info.projectRoot), bi.stats?.why ?? "unknown");
    }

    return (
      head +
      `\n## 当前项目台账（\`${info.activeRel}\`）\n\n<<<LEDGER\n${text}\nLEDGER>>>\n` +
      tail
    );
  }

  // ── 情形 D：有目录结构但活跃台账还没建起来 ────────────────────────────────
  return (
    head +
    "\n## 项目台账：结构登记了，但活跃台账文件还不存在\n\n" +
    `清单 \`${MANIFEST_REL}\` 指向 \`${info.activeRel}\`，但该文件读不到。\n` +
    "请用 `ledger_write`（`target: \"active\"`, `mode: \"replace\"`）把它建起来，" +
    "内容按你自己设计的那套结构写。\n"
  );
}

/**
 * ★★★★★ 2026-10-12（D136 步 3）**区块级注入** —— 用户 18:48 那个提法的实现。
 *
 *   ★ 用户原话：*"我感觉注入的可以是**所有必要的**加上**非必要的区块相对位置**"*。
 *   ★ 用户的定位原则：*"区块的定位主要是**相对位置**"*（⇒ 时间只是其中**一维**）。
 *
 * ★★★ 形态：**必注块给正文 + 全部块给目录（相对位置）**。
 *   · 必注块 = `weightBlocks` 算出来 ≥ `WEIGHT_MUST_INJECT` 的那些；
 *   · 目录 = 每块一行（标题 + 行数 + 内容哈希）⇒ 模型知道"还有哪些块在哪"。
 *
 * ★★★★★ **三条安全绳**（缺一条就会碰到用户的底线 —— "不要影响模型的准确性"）：
 *   ① **内容变了的块一律连正文注入**（不管它权重多低）。理由：那块内容模型**没见过**，
 *      而"没见过"是准确性风险里最硬的一种。★ 靠 `diffBlocks(上次, 这次)` 判。
 *   ② **压缩后**（`afterCompaction`）**不省** —— 压缩把上下文截短了，
 *      原来注入过的正文**已经不在了** ⇒ 必须按"这次照样要读的块"重注一遍。
 *   ③ ★★★ **任何不确定 ⇒ 退回整份注入**。判据**只认"确定"**：
 *      · 没有块（切不出来）⇒ 整份；· 读盘失败 ⇒ 整份；· 权重全缺 ⇒ 整份；
 *      · 模型没给判分（`unanswered > 0`）⇒ **那一块按"必注"处理**（宁可多注）。
 *      ⇒ 一句话：**只有"明确算出来不该读"的块才降级成目录行**，其余一律给正文。
 *
 * ★★ 为什么不做成"只注变更段"（那是上一轮被**用户底线否决**的方案）：
 *   那个方案会让模型手里**没有全文**；而本方案里"没给正文的块"也**给了它标题与哈希**，
 *   并且**它的内容一个字都没删**（仍在 `LEDGER.md`，`ledger_read` 随时拿得到）。
 *
 * @param {object} info `inspect(root)` 的结果
 * @param {object} opts `{ afterCompaction, modelAnswers, histByHash, prevBlocks }`
 * @returns {{text:string, used:boolean, stats:object}} `used=false` ⇒ 调用方应退回整份
 */
/**
 * ★★★ 区块级注入**退回整份**的原因（每个项目根一条，只留最近一次）。
 *
 * ★ 为什么要有它：用户底线是"不影响准确性" ⇒ **退回整份永远是对的**。
 *   但"一直在退回"是个**观测信号** —— 没有它，事后只能看到"没省字符"，
 *   查不出是哪一条安全绳在生效（本项目纪律：**「配了就该跑」不是证据，要有可查计数器**）。
 * ★ 只读、不写盘、不参与任何判据 ⇒ 纯粹是给排查用的。
 */
const blockInjectFallback = new Map();

/**
 * ★★★★ 每个项目根 ⇒ **上一次真正注入出去的块**（安全绳 ① 的"上一次"）。
 *
 * ★ 为什么必须有它：`diffBlocks(上次, 这次)` 才能算出"**哪些块变了**"，
 *   而"变了的块必须连正文注入"是三条安全绳里最关键的一条（模型没见过那块内容）。
 * ★ 为什么只记在**注入成功之后**（见调用点）：若"算过就算"，
 *   那么被去重跳过的那一步会更新快照 ⇒ 下一步把"上次没给的块"当成"给过了" ⇒ **漏注**。
 * ★ 为什么不落盘：它描述的是"**这个会话的上下文里现在有什么**"，
 *   而上下文是**会话级**的、重启即清空 ⇒ 落盘反而会让新会话误以为"给过了"。
 */
const blockSnapshots = new Map();

/**
 * ★★★★ 2026-10-12（D136 步 3）：**区块级注入是否开启**（清单优先，与 `mode` 同口径）。
 *
 * ★ 为什么要单独一个函数（而不是就地写 `currentSettings().blockInjection`）：
 *   那样**只认插件级配置**，而这一项的 `scopeNote` 是 `project-first`
 *   ⇒ 「一个项目单独试这个注入方式、别的不动」是它的**主要用法**。
 *   ⚠️ 这是我第一版真栽的坑（自检 59③ 当场抓到）：项目清单里写 `true` 完全不生效。
 *
 * ★ 判据取"清单里**显式写了**就以它为准"，否则退回插件级设置：
 *   · 清单里 `true`  ⇒ 开（哪怕插件级默认是关）
 *   · 清单里 `false` ⇒ 关（哪怕插件级被全局打开了）
 *   · 清单里没写     ⇒ 用插件级（默认 false ⇒ **与今天逐字一致**）
 */
function blockInjectionEnabled(info) {
  const fromManifest = info?.manifest?.blockInjection;
  if (fromManifest === true || fromManifest === false) return fromManifest;
  return currentSettings().blockInjection === true;
}

function renderBlockInjection(info, opts) {
  const fallback = (why) => ({ text: "", used: false, stats: { why } });
  if (info?.activeAbs === undefined) return fallback("没有活跃台账路径");
  let raw;
  try {
    raw = readTextSafe(info.activeAbs);
  } catch {
    return fallback("读盘抛错");
  }
  if (typeof raw !== "string" || raw === "") return fallback("台账读不到或为空");

  // ★ 台账过长时**不省**：那一段本来就带"已截断"警告，再切块会把语义搅乱。
  if (raw.length > numOf("maxReadChars", MAX_READ_CHARS)) return fallback("台账超过单次读取上限");

  let blocks;
  try {
    blocks = splitBlocks(raw);
  } catch {
    return fallback("切块抛错");
  }
  if (!Array.isArray(blocks) || blocks.length === 0) return fallback("切不出块");

  const afterCompaction = opts?.afterCompaction === true;

  // ── 算权重（★ 判据只来自确定性输入；模型没答的块按"必注"兜底）──
  const weighted = weightBlocks(blocks, opts?.modelAnswers, opts?.histByHash, Date.now());

  // ── 安全绳 ①：内容变了的块 ⇒ 必注 ──
  const prevHashes = new Set((opts?.prevBlocks ?? []).map((b) => b.hash));
  let changedSet = new Set();
  if (opts?.prevBlocks !== undefined) {
    try {
      changedSet = new Set(diffBlocks(opts.prevBlocks, blocks).changed.map((b) => b.hash));
    } catch {
      changedSet = new Set();
    }
  }

  const must = [];
  const tocOnly = [];
  let unansweredFloored = 0;
  for (const b of weighted) {
    const w = b.weight ?? {};
    const isMust =
      // ★ 安全绳 ②：压缩后一律重注（不靠权重判）
      afterCompaction === true ||
      // ★ 硬规则：元数据恒 0 ⇒ 永远只进目录（它就是"变更登记"那种）
      w.capped === "zero"
        ? false
        : // ★ 三条"必注"的充分条件
          w.score >= numOf("weightMustInject", WEIGHT_MUST_INJECT) ||
          // ★ 安全绳 ①：内容变过 ⇒ 必注
          changedSet.has(b.hash) ||
          // ★★★ 安全绳 ③：**模型没给判分** ⇒ 这一块按必注兜底（宁可多注）
          (Number.isFinite(w.unanswered) && w.unanswered > 0) ||
          // ★ 没有变更史 ⇒ 时间/稳定两维本就没参与，但星与模型判分仍可判；
          //   若连模型判分都没有（weightBlocks 用 undefined 算出 0 分）⇒ 兜底必注
          (opts?.modelAnswers === undefined && w.score === 0);
    if (w.unanswered > 0) unansweredFloored += 1;
    (isMust ? must : tocOnly).push(b);
  }

  // ── 组装 ──
  const head = headOf(info);
  const mustText = must.map((b) => b.text).join("\n\n");
  const toc = renderToc(blocks, { headingMaxChars: 40 });
  const stats = {
    blocks: blocks.length,
    must: must.length,
    tocOnly: tocOnly.length,
    fullChars: raw.length,
    injectedChars: mustText.length + toc.length,
    afterCompaction,
    changed: changedSet.size,
    unansweredFloored,
  };
  const body =
    head +
    `\n## 当前项目台账（\`${info.activeRel}\`）—— 区块级注入\n\n` +
    "★ 本台账按标题切成了 **" +
    blocks.length +
    " 个记忆区块**。下面给你两样东西：\n" +
    "① **该读的块连正文**（" +
    must.length +
    " 块）；② **全部块的目录**（标题 + 行数 + 内容哈希）。\n" +
    "★ 目录里那些**没给正文**的块，内容仍在磁盘上 —— 需要时用 `ledger_read` 拿全文，\n" +
    "  或直接读该文件。**不要以为它们不存在**。\n\n" +
    "<<<LEDGER-BLOCKS\n" +
    mustText +
    "\nLEDGER-BLOCKS>>>\n" +
    toc +
    "\n";
  return { text: body, used: true, stats };
}



/**
 * 造一个采集器：把 `session/event` 流攒成日志行，去抖后**追加**落盘。
 *
 * ★ 三条设计约束，每条都有代价：
 *   ① **只在内存攒、延迟落盘**（`LOG_FLUSH_DEBOUNCE_MS`）：`session/event` 是
 *      **同步**触发的，在里面做磁盘 IO 会拖慢每一次 `append`。
 *   ② **只追加，绝不改写**（与台账的归档同规矩）：日志是证据，不是可编辑的文档。
 *   ③ **任何失败都吞掉**：采集炸了绝不许影响用户对话，更不许把事件监听器搞坏。
 *
 * 落盘的触发点：延迟到点、回合结束、会话销毁、进程 dispose —— 四条路都试，
 * 因为前三条都可能不到（进程可能被杀）。
 */
function createLogCollector(ctx) {
  /** L3 要等 tool/result 才知道成败 ⇒ 先攒着。key = callId。 */
  const pendingCalls = new Map();
  /**
   * `commandId → 命令名`。
   *
   * ★★★ 为什么必须有这个（2026-10-10 实测发现）：`command/done` 的载荷是
   *   `{ commandId, kind, text?, sourceEventSeq? }` —— **没有 name**；
   *   命令名只在**另一条**事件 `command/run`（`{ commandId, name, args?, source }`）上。
   *   ⇒ 旧代码直接读 `d.name`，恒 undefined ⇒ **每条都记成 `命令 /?`**。
   * ★ 用 Map 而不是让 `L0_KINDS` 自己持有：格式化函数应当是**纯的**，
   *   状态留在采集器里（与 `pendingCalls` 同一个理由）。
   * ★ 有界：只保留最近 64 个 —— 一个会话不会同时在跑那么多命令，
   *   而无限增长等于慢性泄漏（这个采集器是**长期活着**的）。
   */
  const commandNames = new Map();
  /** 键（项目根 + 会话 id）→ { root, info, buffers:Map<fileRel,string[]> } */
  const buffers = new Map();
  /** 定时器句柄；有攒着的东西才存在。 */
  let timer;

  /** 记下命令名（有界，见 `commandNames` 的注释）。 */
  function rememberCommand(id, name) {
    if (typeof id !== "string" || id === "" || typeof name !== "string" || name === "") return;
    commandNames.set(id, name);
    if (commandNames.size > 64) {
      // 删最旧的那个（Map 保持插入序）。
      const oldest = commandNames.keys().next().value;
      if (oldest !== undefined) commandNames.delete(oldest);
    }
  }

  /** 该会话的缓冲桶（惰性建）。 */
  function bucketFor(root, sid) {
    const key = `${root}\u0000${sid}`;
    let b = buffers.get(key);
    if (b === undefined) {
      b = { root, sid, lines: new Map() };
      buffers.set(key, b);
    }
    return b;
  }

  function push(b, fileRel, line) {
    if (fileRel === undefined || line === undefined || line === "") return;
    let arr = b.lines.get(fileRel);
    if (arr === undefined) {
      arr = [];
      b.lines.set(fileRel, arr);
    }
    arr.push(line);
  }

  function arm() {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      // 去抖落盘**不 stage**（理由见 flushAll 的 stage 说明）。
      flushAll(false);
    }, LOG_FLUSH_DEBOUNCE_MS);
    // ★ 别让这个定时器把进程钉住不退（node 的定时器默认会）。
    if (typeof timer.unref === "function") timer.unref();
  }

  /**
   * 把攒下的行真正追加到磁盘。全程吞错。
   *
   * @param {boolean} stage 是否顺带 `git add`。
   *   ★ 去抖那条路**不 stage**：默认 1.2 秒就可能冲一次，而每次 stage 都要
   *   spawn 一个 git 进程（几十毫秒）并重写 git index —— 一场 490 次调用的会话
   *   会白白拉起几百个 git。所以只在**回合末 / 卸载**这种真正收尾的时刻 stage。
   */
  function flushAll(stage) {
    for (const [key, b] of [...buffers.entries()]) {
      try {
        const written = [];
        for (const [fileRel, lines] of b.lines.entries()) {
          if (lines.length === 0) continue;
          const abs = path.resolve(b.root, fileRel);
          if (!isUnder(b.root, abs)) continue; // 逃出项目根 ⇒ 丢弃（防御式）
          ensureDir(path.dirname(abs));
          // ★ 纯追加：`flag: "a"`。绝不先读后写，那样会在并发下把别人的行覆盖掉。
          fs.appendFileSync(abs, lines.join("\n") + "\n", "utf8");
          written.push(fileRel);
        }
        b.lines.clear();
        // 日志与台账同一套 Git 规矩：只 add 明确路径（绝不 -A）。
        if (stage === true && written.length > 0) {
          const info = inspect(b.root);
          if (info.manifest?.autoGitAdd !== false && fs.existsSync(path.join(b.root, ".git"))) {
            gitAdd(b.root, written);
          }
        }
      } catch (e) {
        try {
          ctx.logger?.warn?.(`${name}: 日志落盘失败已忽略：${String((e && e.message) || e)}`);
        } catch {
          /* 连 logger 都没有就算了 */
        }
        // 落盘失败就丢掉这批，避免无限堆积（日志不值得为它撑爆内存）。
        b.lines.clear();
      }
      void key;
    }
  }

  /** 把当前攒着的全部落盘（回合末 / 销毁时调用）。这里才 stage。 */
  function flushNow() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    flushAll(true);
  }

  /**
   * 消费一条会话事件。
   *
   * @param {string} root 项目根（调用方已解析好）
   * @param {string} sid  会话 id
   * @param {object} event 官方落盘事件
   * @param {object} [extra] 采集器需要但**事件里没有**的东西（目前只有 `hfSource`）
   */
  function consume(root, sid, event, extra) {
    const info = inspect(root);
    if (logDirOf(info) === undefined) return; // 这个项目没启用日志
    const type = event?.type;
    if (typeof type !== "string") return;
    const now = new Date();
    const b = bucketFor(root, sid);

    // ── 命令名缓存：`command/run` 带 name，`command/done` 只有 commandId ──
    //   ★ 顺序上 run 一定在 done 之前，所以在 done 之前收下就够了。
    if (type === "command/run") {
      rememberCommand(event.data?.commandId, event.data?.name);
    }

    // ── L0 里程碑 ─────────────────────────────────────────────────────────
    const l0 = L0_KINDS[type];
    if (l0 !== undefined && levelOn(info, "L0")) {
      push(
        b,
        logFileRel(info, "L0", now),
        `- ${stampSec(now)} (${type}) ${l0(event.data, { ...extra, commandNames })}`
      );
    }

    // ── L4 用户消息存档（用户需求：自动记住用户发的所有消息）─────────────
    //
    // ★ 为什么在这里（`session/event`）而不是别处：这是**唯一**一条
    //   "用户说了什么"必然经过的路，而且是官方自己落盘用的那条（见文件头 ⑦）。
    //   所以它不花 token、不靠 AI 记得、也不会漏 —— 用户要的正是"**自动**记住"。
    //
    // ★ 为什么**不注入上下文**：用户明确要求了。注入的话每轮都要把历史消息
    //   再抄一遍进 prompt，那是纯亏（钱与本就不宽裕的窗口）。它只在
    //   `ledger_log`（view "users"）里按需读切片 —— 与 L0–L3 同一套规矩。
    if (type === "user/message" && levelOn(info, "L4")) {
      const um = userMessageOf(event);
      if (um !== undefined) {
        push(
          b,
          logFileRel(info, "L4", um.when),
          renderUserMessageLine(um.content, tagOfId(sid), um.when)
        );
      }
    }

    // ── L3：tool/call 先攒着（成败要等 tool/result）───────────────────────
    if (type === "tool/call") {
      const d = event.data ?? {};
      const callId = d.callId ?? d.toolCallId;
      const toolName = typeof d.name === "string" ? d.name : "?";
      if (typeof callId === "string" && callId !== "" && !L3_EXCLUDE.has(toolName)) {
        pendingCalls.set(callId, {
          at: stampSec(now),
          turn: d.turn,
          step: d.step,
          toolName,
          args: d.arguments,
          // ★ 记下会话：`forget(sid)` 要靠它清理。漏了这一步，会话销毁后
          //   这些待配对项会永远留在内存里（因为只有 tool/result 才会删）。
          sid: String(sid),
        });
        // 上限兜底：配对不上 result 的调用（进程被杀、工具崩了）不该无限堆积。
        if (pendingCalls.size > 5000) {
          const first = pendingCalls.keys().next();
          if (first.done !== true) pendingCalls.delete(first.value);
        }
      }
      // ── L2：文件流水 ───────────────────────────────────────────────────
      if (levelOn(info, "L2")) {
        const { touched, read } = fileOpsOf(toolName, d.arguments);
        for (const { path: p, op } of touched) {
          push(b, logFileRel(info, "L2", now), `- ${stampSec(now)} (${op}) ${p}  [${toolName}]`);
        }
        for (const { path: p, op } of read) {
          push(b, logFileRel(info, "L2", now), `- ${stampSec(now)} (${op}) ${p}  [${toolName}]`);
        }
      }
      arm();
      return;
    }

    // ── L3：tool/result 补上成败，这时才写行 ──────────────────────────────
    if (type === "tool/result") {
      const d = event.data ?? {};
      const callId = d.callId ?? d.toolCallId ?? d.message?.toolCallId;
      const pending = typeof callId === "string" ? pendingCalls.get(callId) : undefined;
      if (pending !== undefined) {
        pendingCalls.delete(callId);
        if (levelOn(info, "L3")) {
          const bad = isErrorResult(event) ? " [失败]" : "";
          const brief = briefOf(pending.toolName, pending.args, numOf("logBriefChars", LOG_BRIEF_CHARS));
          push(
            b,
            logFileRel(info, "L3", now),
            `- ${pending.at} (tool) t${pending.turn ?? "?"}/s${pending.step ?? "?"} ` +
              `${pending.toolName}${bad}${brief === "" ? "" : ` — ${brief}`}`
          );
        }
        arm();
      }
      return;
    }

    // 其余事件对日志没有直接贡献；L1 由 AI 通过 ledger_log_write 写。
    if (b.lines.size > 0) arm();
  }

  /** 会话销毁：清掉该会话的待办与缓冲（先把能落的落了）。 */
  function forget(sid) {
    for (const [callId, p] of [...pendingCalls.entries()]) {
      // 只有 callId 里带得出会话的才删得掉；拿不准就留着让它自然被上限清掉。
      if (p.sid === sid) pendingCalls.delete(callId);
    }
    for (const [key, b] of [...buffers.entries()]) {
      if (b.sid === sid) {
        // 会话结束也是收尾时刻 ⇒ 这次 stage。
        flushAll(true);
        buffers.delete(key);
      }
    }
  }

  return { consume, flushNow, forget, _buffers: buffers, _pending: pendingCalls };
}

// ═══════════════════════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 所有写入/读取类工具共用的参数：**显式指定项目根**。
 *
 * ★ 为什么必须有它：本插件的项目根取 `session.header.cwd`（`projectRootOf`）。但用户
 *   经常**从容器工作区开着会话**（如一个汇总工作区），真实项目在它的子目录里。
 *   没有这个参数，那种会话里**任何**台账工具都只能指向容器根 —— 而容器根恰恰是
 *   禁止初始化的那个目录，于是整个插件对它最主要的那些项目**全都不可用**
 *   （2026-10-08 实测撞上：回合末卡片让 AI 写台账，AI 却无处可写）。
 *
 * ★ 它**不绕过**容器闸门：`ledger_init` 仍会对"传进来的这个根是不是容器"再判一次。
 *   显式指定根只回答"哪个目录"，不回答"该不该在这里初始化"。
 */
const ROOT_PARAM = {
  type: "string",
  description:
    "Optional project root, for when this session's working directory is a CONTAINER workspace " +
    "and the project you mean is a subdirectory of it. Relative paths resolve against the session " +
    "cwd; the path must be an existing directory. This selects WHICH directory, and does not " +
    "bypass the container guard.",
};

/**
 * 从 exec 取本会话的项目根；取不到就抛（调用方在工具里已 try/catch）。
 *
 * `args.root` 优先于会话 cwd（见 ROOT_PARAM 的说明）。显式给的根必须真实存在且是目录 ——
 * 否则打错一个字母就会静默地把台账写到别处、或让 `ledger_init` 在错误的目录里 `git init`。
 */
function rootFromExec(exec, args) {
  const raw = typeof args?.root === "string" ? args.root.trim() : "";
  if (raw !== "") {
    const base = projectRootOf(exec?.agent);
    const abs = path.resolve(base ?? process.cwd(), raw);
    let isDir = false;
    try {
      isDir = fs.statSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw fail(
        `project-ledger: 传进来的 root 不是一个存在的目录：\`${raw}\`（解析为 \`${abs}\`）。` +
          "显式指定项目根时它必须已经存在 —— 本插件不会替你创建它。"
      );
    }
    return abs;
  }

  const root = projectRootOf(exec?.agent);
  if (root === undefined) {
    throw fail(
      "project-ledger: 这个执行没有可用的会话工作目录（agent.session.header.cwd），" +
        "无法定位项目根。若本会话是从容器工作区开的，请用 root 参数点名子项目目录。"
    );
  }
  return root;
}

/** 通用输出 schema：只强约束 ok，其余敞开放（成功/软失败形状不同）。 */
const OK_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["ok"],
  additionalProperties: true,
};

function renderResult(_args, value) {
  return textOut(value);
}

/**
 * 记下"这一轮改过台账"（用户问："AI 自己就把台账做了，那我怎么知道？"）。
 *
 * ★ 为什么需要它：工具返回值是发**给 AI** 的（`renderResult` → `textOut`），
 *   **用户看不到**。所以 AI 默默改了台账，用户事后无从得知 ——
 *   除非他知道去查审计日志，那不算"知道"，那是考古。
 *
 * ★ 为什么是**攒着**而不是每步报：写台账的那一步**就是** AI 在干活的那一步，
 *   当场插一条"你改了台账"对它毫无信息量。攒着，等**下一次注入**时捎带给它
 *   （`takeTouched` 取下即清 ⇒ 只报一次）。
 *   ⇒ 送达通道见 `renderTouchedForAi`（2026-10-09 从卡片改走注入）。
 */
function noteLedgerTouched(state, exec, r) {
  // ★★ 台账写成功 ⇒ 顺手记为"这一轮已落袋"（压缩前的闸门要用，见 noteFlushed）。
  //   放在这里而不是各个调用点：`noteLedgerTouched` 已经**恰好**在两个
  //   "台账写成功"的地方被调用（write / archive），记一处就不可能漏。
  noteFlushed(state, exec);
  try {
    const sid = exec?.agent?.session?.header?.id;
    if (typeof sid !== "string" || sid === "") return;
    const key = String(sid);
    let rec = state.ledgerTouched.get(key);
    if (rec === undefined) {
      rec = { files: new Set(), count: 0, first: Date.now() };
      state.ledgerTouched.set(key, rec);
    }
    rec.count += 1;
    rec.files.add(r.relative ?? r.path ?? "(未知文件)");
    rec.last = { lines: r.lines, tag: r.sessionTag, mode: r.mode, target: r.target };
  } catch {
    /* 记回执失败绝不影响写入本身 */
  }
}

/**
 * 记下"这一轮的进展**已经落袋**了"（台账或 L1 日志写成功）。
 *
 * ★★ 为什么需要它（用户 2026-10-09 反复强调的那一条）：
 *   *"每次压缩之前强制进行台账更新和日志更新"* —— **强制**，不是劝告。
 *   压在 70% 的语义是"在细节丢掉之前先把状态落袋"；若这一轮的进展还没写进台账，
 *   那一压就是把**唯一副本**压掉了。
 *   ⇒ 所以压缩前必须先问"落袋了吗"，没落就**不压**（见 `flushBeforeCompact`）。
 *
 * ★ 只记**时间戳**、不记内容：判据是"**这一轮**落袋了吗"，
 *   靠与"本轮开始时刻"比大小来区分，不需要知道写了什么。
 * ★ 台账与 L1 都算落袋：用户说的是"台账**和**日志"，但**任一**落袋就已经
 *   保住了这一轮的进展（台账记状态、L1 记为什么）。两个都不认反而会把
 *   "只写了台账"的正常情况误判成没落盘。
 */
function noteFlushed(state, exec) {
  try {
    const sid = exec?.agent?.session?.header?.id;
    if (typeof sid !== "string" || sid === "") return;
    state.flushedAt.set(String(sid), Date.now());
  } catch {
    /* 记落袋时刻失败绝不影响写入本身 */
  }
}

/**
 * 分流义务：我们要求过它分流吗？它分了吗？
 *
 * ★ 为什么**必须与"落盘"分开记**（这条结论仍然成立，只是对象变了）：
 *   若与落盘共用一个标记，"只写了台账、没分流"就会**静默**通过闸门 ⇒
 *   压缩照跑、`keep` 桶是空的 ⇒ **分流白做，且没人知道**。
 *   ⇒ 两条义务各自记，闸门两条都查（**做成参数/共用一个标记，就会有人漏**）。
 *
 * ★★★ 2026-10-12（D131）：上面原来还举例说"`noteFlushed` 会清掉 `flushOwedAt`" ——
 *   那个例子**已经不存在了**（`flushOwedAt` 与"承诺判据"整段已按用户要求清掉，
 *   见 `flushBeforeCompact` 里的注记）。★ 道理没变，**只是不再拿那个已删的东西当反例**。
 *
 * @returns {{owed:boolean}} `owed` = 要求过但还没做
 */
function triageOwed(state, sid) {
  const key = String(sid);
  const owedAt = state.triageOwedAt?.get?.(key);
  if (owedAt === undefined) return { owed: false };
  const doneAt = state.triageAt?.get?.(key);
  if (doneAt !== undefined && doneAt > owedAt) {
    // 它照做了（`ledger_triage` 里已经清掉，这里是双保险）。
    state.triageOwedAt.delete(key);
    return { owed: false };
  }
  return { owed: true, owedAt };
}

/**
 * 「压缩前强制落盘」的那道闸门。
 *
 * @param {object} state 插件状态
 * @param {string} sid 会话 id
 * @param {object|undefined} info 项目信息（用来判断"这个会话到底用不用台账"）
 * @returns {{ok: true}} 或 `{ok: false, reason: string, ...}`
 *
 * ★★ 判据（用户 2026-10-09 的原话：
 *    *"每次压缩之前强制进行台账更新和日志更新"* —— **每一次**，所以判据是
 *    「**上一个压缩周期之后，落过盘吗**」，而不是"最近 N 分钟落过吗"）：
 *
 *   ① 关掉这项设置 ⇒ 放行；
 *   ② 这个项目**没有台账**（`activeRel` 为空）⇒ 放行。
 *      ⚠️ 关键：多数会话根本不碰台账（实测 104/112 个会话在容器根、没有清单）。
 *         对它们"强制落盘"是**不可能执行的指令** —— 硬拦只会让压缩永远不发生。
 *         ⇒ 闸门只对"**这个项目有台账**"的会话生效。**这是"不制造死锁"的关键一条。**
 *   ③ 有台账、且**本周期内落过盘** ⇒ 放行；
 *   ④ 有台账、但本周期内**还没落过** ⇒ 拦下，告诉 AI 先写，并把压缩意图**退回队列**。
 *
 * ★★ 为什么用"周期"而不是时间：时间判据（"最近 10 分钟"）会在两种情况下出错 ——
 *   一轮跑很久（10 分钟没写完，但确实什么都没落盘 ⇒ 该拦）／
 *   很短的时间里有多次压缩（时间没到但已经跨了一个压缩周期 ⇒ 该拦没拦）。
 *   周期判据与用户要的语义**一一对应**：**一次压缩，一次落盘。**
 *
 * ★ 死锁防护：AI 万一看不懂 / 不照做，拦下后意图会退回队列、下一次 idle 再试。
 *   连续拦 `FLUSH_BLOCK_GIVEUP` 次后**放行并如实标注**（`forcedThrough: true`）——
 *   宁可压掉一次、也不能让压缩永远不发生（那会让上下文一直涨到内核 80% 硬压）。
 */
const FLUSH_BLOCK_GIVEUP = 3;

/**
 * ★★ 走到这个水位，闸门**不再拦**（用户 2026-10-09："到水位的时候主动按压缩不能进行，
 *   比较危险"）。理由是个**方向性**的问题：
 *   内核在 0.8 会自己压一次，而那一次**我们抓不到逐字胶囊**。所以我们拦下自己的
 *   （安全、有胶囊的）压缩，等于把机会**让给**内核那次不安全的压缩 —— 方向反了。
 *   ⇒ 水位进到这一档，宁愿承认"这一轮还没落盘"也要先压，并在返回值里如实标注。
 */
const FLUSH_GATE_BYPASS_RATIO = 0.75;

/**
 * ★★★ 2026-10-11 新增：**分流义务的时限兜底**（修 D59 坐实的真缺陷）。
 *
 * 起因（真事故，不是假想）：本项目 `surgical` 模式下，`triageOwedAt` **只有
 * `ledger_triage` 能清**（`noteFlushed` 只清"落盘"那一侧，够不着分流义务）。
 * 而 AI 一次都没调 ⇒ 闸门连续拦了**近 4 小时**、**零次压缩**
 * （`19:48:44` 重启 → `23:47`，三条独立证据：胶囊数停在 1、`anchors.json` 不存在、
 * `compaction/start` 为零）。用户先发现的：*"你有没有发现我们直到现在都没有进行
 * 任何一次增量压缩，已经快70%了。"*
 *
 * ★ 为什么**原有那两道兜底没能救**：
 *   ① `FLUSH_BLOCK_GIVEUP = 3`（连续拦 3 次就放行）—— 它依赖"**重试真的发生**"。
 *      而被拦下后意图退回队列、要等下一次 idle 才重试；中间只要有一轮很长、
 *      或重试路径没被走到，计数就**永远攒不到 3** ⇒ 兜底形同不存在。
 *   ② `FLUSH_GATE_BYPASS_RATIO = 0.75`（水位兜底）—— 它是**另一条更早的 return**，
 *      只在 ≥75% 生效。事故发生时水位在 **70% 上下**，够不着 ⇒ 从旁边绕过去了。
 *
 * ★ 所以这一条的设计原则是 **不依赖任何"别的东西会发生"**：
 *   只看**墙上时间** —— 从我们开口要求分流那一刻算起，超过这个时限就放行，
 *   并把"未分流即放行"如实标注（`forcedThrough: true` + `triageOverdue: true`），
 *   **绝不假装它分过流**。
 *
 * ★ 取 **20 分钟**的理由：足够 AI 认真做完一轮分流（那是一段判断+一次工具调用），
 *   又远小于"一路涨到 80% 被内核硬压"所需的时间 ⇒ 方向永远倒向**先保住压缩**。
 *   ★ 与 `FLUSH_GATE_BYPASS_RATIO` 是同一条纪律：**宁可放行，也不让压缩永不发生。**
 */
const TRIAGE_OWED_MAX_AGE_MS = 20 * 60 * 1000;

// ★★★ 2026-10-12（D131）：`FULL_COMPACT_FLUSH_MAX_AGE_MS` 已删 ——
//   它只服务"全量落盘超时兜底"，而那条依赖 `flushOwedAt`（从不被写 ⇒ 永不触发）。

/**
 * ★★★ 2026-10-12（D119）：**全量的"紧急旁路"水位** —— 到了这里**不再等落盘**。
 *
 * ★ 为什么必须有它（这是我加 D119 时**自己发现的一个新风险**，必须说清）：
 *   用户要求"全量也要先记台账"，我据此让全量**必须过闸门**。
 *   ★ 但原来那条 0.75 旁路存在的理由**仍然成立**（见它的注释）：
 *     *"内核在 0.8 会自己压一次，而那一次我们抓不到逐字胶囊 ⇒
 *       拦下我们自己的（安全的）压缩 = 把机会让给内核那次不安全的。"*
 *   ⇒ 若全量在 80% 还在等落盘 ⇒ **内核先压** ⇒ ★ **逐字胶囊全丢**（正是用户最在意的）。
 *   ★ 而那条 20 分钟超时兜底**救不了这个场景** —— 内核不会等 20 分钟。
 *
 * ★ 取 **0.78**（= 内核线 0.80 − 2 点）：
 *   · 在 `[0.75, 0.78)` 这个带里，全量**仍等落盘** ⇒ 用户的"先记台账"要求**照旧生效**；
 *   · 一过 0.78 ⇒ 立刻放行 ⇒ 保住"**在被内核硬压之前先自己压一次**"这条底线。
 *   ⇒ ★ 这正是本文件反复用的那个模式：**每一条"要等"都必须配一条"等到什么时候就不等了"**。
 */
const FULL_COMPACT_URGENT_RATIO = 0.78;

/**
 * ★★★ 2026-10-12（D119）：**增量让路的时限兜底**。
 *
 * ★ 为什么需要它（D59 的形态换了个入口）：
 *   D119 之后，水位 ≥ 全量线时增量**无条件让路**（不再看队列）——
 *   这是为了修"**增量抢吃掉全量的机会**"那个真事故。
 *   ★ 但有个新风险：若全量**一直在失败**（busy 连撞 / 闸门不放 / 服务不可用），
 *     增量就会**无限期让路** ⇒ **谁也不压** ⇒ 一路撞进内核 80%（抓不到逐字胶囊）。
 *   ⇒ 所以补一条**只看墙上时间**的兜底：让路超过这个时限 ⇒ **放行增量**。
 *
 * ★ 取 **15 分钟**的理由：正常的"到线 → 排队 → 等 idle → 压完"是**分钟级**的
 *   （D105 实测那几次：几十秒到 ~9 分钟）；15 分钟足够它走完，
 *   而远小于"涨到 80% 被内核硬压"。⇒ 方向仍倒向**先保住压缩**。
 */
const DELTA_YIELD_MAX_AGE_MS = 15 * 60 * 1000;


/**
 * 这些来源的压缩是**人手动发起的** ⇒ 不被落盘闸门拦。
 *
 * ★ 区分"人按的"与"AI 自己排的"是要紧的：
 *   闸门的目的是"逼 AI 在压之前把状态落袋"，那是**对 AI 工作流**的约束；
 *   而人按下 `/ledger compact` 是一个**明确授权**，不该被插件的自律规则挡回去
 *   （尤其当 AI 正卡在循环里、用户想靠压缩脱困的时候）。
 * ★ `manual`（AI 调 `ledger_compact` 工具）**不在**这里 —— 那仍是 AI 的自动流程。
 *   ⚠️ **2026-10-12（D114）核实**：这句注释**原来是假的** ——
 *     AI 调 `ledger_compact({mode:"light"})` 立的是 `deltaForce` 旗子，
 *     而消费处写 `force: forcedLight` ⇒ 它与 `/ledger light` **共用旗子、同样 `force: true`**
 *     ⇒ **实际绕过了本闸门**（注释说"不在名单里"，代码却把它当手动放行了 —— D89 同型病）。
 *   ⇒ 已修：旗子带上 `source`，`"command"`（人按键）才豁免；`"tool"`（AI 调用）
 *     **照旧过闸门**（用户明确要求"一定先更新台账日志再压缩"）。
 */
const MANUAL_COMPACT_SOURCES = new Set(["command"]);

/**
 * @param {object} [opts] 旁路判据
 * @param {boolean} [opts.manual] 是否人手动发起（见 `MANUAL_COMPACT_SOURCES`）
 * @param {number} [opts.ratio] 当前水位（0~1），用于 `FLUSH_GATE_BYPASS_RATIO` 那条旁路
 * @param {"delta"|"full"} [opts.mode] 这一趟是**增量**还是**全量**（见 `opts.ratio` 旁路的 D119 改动）
 */
function flushBeforeCompact(state, sid, info, opts) {
  const s = currentSettings();
  if (s.requireFlushBeforeCompact !== true) return { ok: true, why: "设置已关闭" };

  // ★★ 旁路 ①：人手动按的 ⇒ 直接放行（他按下就是授权）。
  if (opts?.manual === true) return { ok: true, why: "手动触发（用户已授权）" };

  // ★★★ 2026-10-12（D119，用户原话：**"但是全量也要先记台账日志！！！"**）：
  //
  //   **病**（真机取证，10:11 那次）：用户设的全量线是 **0.75**，
  //   而这条旁路的阈值**也是 0.75** ⇒ ★ **两者撞在一起** ⇒
  //   **全量压缩恰好总是走这条旁路**、落盘闸门对它**形同虚设**。
  //   ★ 证据：10:11:33 那次压缩压前水位 **75.1%** ⇒ ≥0.75 ⇒ 旁路生效、**没要求落盘**。
  //
  //   ★ 为什么**全量**最不该走旁路（比增量更不该）：
  //     全量压得**最狠**（实测能压 60+ 点）⇒ 它一旦压下去，
  //     **没落盘的那段进展就是唯一副本**（这正是用户反复强调这条铁律的原因）。
  //   ⇒ **修法：这条旁路只留给增量**；全量**必须**过闸门。
  //
  //   ★★★ 但**必须配超时兜底**，否则会掉进 D59 那个"近 4 小时零压缩"：
  //     全量被拦住 → 等 AI 落盘 → 若它一直不落 ⇒ **永远不压** ⇒ 一路撞进内核 80%（抓不到胶囊）。
  //     ⇒ 超时口径**照抄已有的 `TRIAGE_OWED_MAX_AGE_MS` 设计**（只看墙上时间、不依赖别的东西）。
  const isFull = opts?.mode === "full";
  if (!isFull && typeof opts?.ratio === "number" && opts.ratio >= FLUSH_GATE_BYPASS_RATIO) {
    return {
      ok: true,
      why:
        `水位 ${Math.round(opts.ratio * 100)}% 已达 ${Math.round(FLUSH_GATE_BYPASS_RATIO * 100)}%，` +
        "再拦只会让**内核**先压（那一次抓不到逐字胶囊）",
      forcedThrough: true,
    };
  }
  if (isFull) {
    // ★★★ 紧急旁路（`FULL_COMPACT_URGENT_RATIO`）：水位逼近内核硬压线 ⇒ **不再等落盘**。
    //   ★ 理由见那个常量的注释：内核 0.8 自己会压一次，**那一次抓不到逐字胶囊**；
    //     在 78% 还等落盘 = 把机会让给内核 ⇒ 用户最在意的"逐字可回读"就没了。
    if (typeof opts?.ratio === "number" && opts.ratio >= FULL_COMPACT_URGENT_RATIO) {
      return {
        ok: true,
        why:
          `水位 ${Math.round(opts.ratio * 100)}% 已逼近内核硬压线（${Math.round(KERNEL_HARD_COMPACT_RATIO * 100)}%），` +
          "再等落盘会让**内核**先压（那一次抓不到逐字胶囊）⇒ 本次放行，如实标注：**这一轮没有先落盘**",
        forcedThrough: true,
        fullUrgent: true,
      };
    }
    // ★★★ 2026-10-12（D131）：这里原来有一条"全量落盘超时兜底"（依赖 `flushOwedAt`）。
    //   而 `flushOwedAt` **从不被写** ⇒ 那条兜底**永不触发** ⇒ 已随死代码一起清掉。
    //   ★ 全量现在由**周期判据**约束（`flushedAt > lastCompactAt`）+ 下面那条
    //     `FULL_COMPACT_URGENT_RATIO` 紧急旁路接住 —— 两者都是活的。
  }

  const key = String(sid);
  // ② 这个项目没有台账 ⇒ 没有"落盘"这回事，放行（否则压缩永不发生）。
  if (info === undefined || info.activeRel === undefined) {
    return { ok: true, why: "这个项目没有台账，无需落盘" };
  }

  // ★★★★ 2026-10-12（D131，用户拍板"第一点清掉"）：**"承诺判据"整段已删**。
  //
  //   它原来是这样的：水位提醒时立一个 `flushOwedAt`（"我们刚开口要求你落盘"），
  //   然后闸门在这里判"**我们要求之后你写了吗**" —— 不写就不许压。
  //
  //   ★ 为什么现在删（**三条，每条都有据**）：
  //     ① **D129 按用户要求删掉了唯一写入点**（"去除三个节点的义务，以防模型被卡"）
  //        ⇒ `flushOwedAt` **从不被写** ⇒ 这段 `if (owedAt !== undefined)` **永不进入**。
  //     ② 它是**用户亲自报过的那个矛盾**的来源：同一条注入里既叫他写台账、又告诉他刚压完。
  //        D126 用 `flushOwedStep`+`stepSeq` 把它收窄对了，但那条路的基础已经没了。
  //     ③ ★ 更要紧的是**它做错了事**：它判的是"**我们开口之后**它写了吗"——
  //        而那是**模型无法观测的顺序**（它不知道插件是什么时候开口的）。
  //        ⇒ 真正该问的是"**本周期有没有写过**"（客观、它自己知道）——
  //          那正是下面那条**周期判据**（`flushedAt > lastCompactAt`），它**保留**。
  //
  //   ★ 用户的铁律**没有被削弱**：「每次压缩前必须先落账」现在由周期判据守着 ——
  //     "自上次压缩以来一次都没写" ⇒ 照样拦（见下面 `flushedAt > lastCompactAt` 那段）。
  //   ★ 连带清掉的：`flushOwedAt` / `flushOwedStep` / `stepSeq` 三个 Map、
  //     `FULL_COMPACT_FLUSH_MAX_AGE_MS` 常量、以及 pre-step 里的步号推进。

  const flushedAt = state.flushedAt.get(key) ?? 0;
  const lastCompactAt = state.lastCompactCycleAt.get(key) ?? 0; // 0 = 本会话还没压过
  if (flushedAt > lastCompactAt) {
    // 本周期真落过盘 ⇒ 之前的"被拦"计数清零（它只描述"连续没落盘"）。
    state.flushBlocked.delete(key);
    // ★★ 但**分流**是另一条义务：落盘不等于分过流。
    //   在「反复追究」模式下，若我们要求过分流而它没做，**仍然不许压** ——
    //   否则 keep 桶是空的，压缩照跑，模式**静默退化**成正常推进。
    // ★★★ 2026-10-12（D129）：**分流只拦"轻量压缩"那条，绝不拦全量兜底**。
    //
    //   ★ 为什么必须这样切（否则就撞回 D59 那个坑）：分流义务是**模型主动要压时**立下的
    //     （见 `runIncrementalCompact` 判据②）。若它不理会，这个"欠分流"标记会一直挂着 ——
    //     而**全量兜底（75%）也走这道闸门** ⇒ 全量被同一个标记拦住 ⇒
    //     **一路撞进内核 80%（那一次抓不到逐字胶囊）**。
    //   ⇒ 与用户本轮的要求正面冲突：*"全量压缩，最迟最迟发生在 75%，即使模型没有主动压缩。"*
    //
    //   ★ 判据用 `opts.mode !== "full"`：全量那条约调用点**已经**传了 `mode:"full"`
    //     （见 `runHighFidelityCompact`），所以这里天然分得清，不需要新增参数。
    //   ★ 轻量那条仍有 **20 分钟时限兜底**（见 `TRIAGE_OWED_MAX_AGE_MS`）⇒ 也不会被永久卡住。
    if (triageRequired() && opts?.mode !== "full" && triageOwed(state, sid).owed === true) {
      // ★★★ 兜底 ⓪（2026-10-11，修 D59 的真缺陷）：**超时即放行**。
      //   位置要紧：必须**在次数兜底之前** —— 次数兜底依赖"重试真的发生"，
      //   而真事故里它恰恰没发生（近 4 小时、计数攒不到 3）。时间兜底不依赖任何东西。
      const tOwed = triageOwed(state, sid).owedAt;
      const overdue =
        typeof tOwed === "number" && Date.now() - tOwed >= numOf("triageOwedMaxAgeMs", TRIAGE_OWED_MAX_AGE_MS);
      if (overdue) {
        state.triageOwedAt.delete(key);
        state.triageBlocked.delete(key);
        return {
          ok: true,
          why:
            `要求分流已超过 ${Math.round(numOf("triageOwedMaxAgeMs", TRIAGE_OWED_MAX_AGE_MS) / 60000)} 分钟仍未做，` +
            "本次放行（避免压缩永不发生）—— 如实标注：**这一轮没有分流单**",
          forcedThrough: true,
          triageOverdue: true,
        };
      }
      const trec = state.triageBlocked.get(key) ?? { count: 0 };
      trec.count += 1;
      state.triageBlocked.set(key, trec);
      if (trec.count < FLUSH_BLOCK_GIVEUP) {
        return {
          ok: false,
          missing: ["分流单"],
          reason:
            "本项目在**反复追究**模式：压缩前要先做一次分流，而**这一轮还没做**。" +
            "用 `ledger_triage` 把这一段分成三个桶（`keep` 留上下文 / `stash` 落进项目 / " +
            "`drop` 丢掉），之后压缩会自动继续。" +
            "★ 这是**义务不是建议**：不做，压缩就**一直不会发生** —— " +
            `超过 ${Math.round(numOf("triageOwedMaxAgeMs", TRIAGE_OWED_MAX_AGE_MS) / 60000)} 分钟插件才会带着` +
            "「这一轮没有分流单」的标注强行放行（那会丢掉 keep 桶的逐字注回）。",
          hint: "ledger_triage",
          blockedCount: trec.count,
          owedTriage: true,
          owedTriageAgeMs: typeof tOwed === "number" ? Date.now() - tOwed : undefined,
        };
      }
      // 死锁防护：等不到就放行，但如实标注（不假装分过流）。
      state.triageOwedAt.delete(key);
      state.triageBlocked.delete(key);
      return {
        ok: true,
        why: `已连续 ${trec.count} 次要求分流仍未做，本次放行（避免压缩永不发生）`,
        forcedThrough: true,
      };
    }
    return { ok: true, why: "本周期内已落盘" };
  }

  // ★ 死锁防护：连续拦够次数就放行（并如实标注，不假装合规）。
  //   ★ 计数在这里自增（与上面承诺判据同一处口径）⇒ 增量与全量两条路都受保护。
  const rec = state.flushBlocked.get(key) ?? { count: 0 };
  rec.count += 1;
  rec.reason = "自上次压缩以来未落盘";
  state.flushBlocked.set(key, rec);
  if (rec.count >= FLUSH_BLOCK_GIVEUP) {
    state.flushBlocked.delete(key);
    return {
      ok: true,
      why: `已连续拦下 ${rec.count} 次仍未落盘，本次放行（避免压缩永不发生）`,
      forcedThrough: true,
    };
  }

  return {
    ok: false,
    missing: ["台账", "L1 日志"],
    reason:
      "**压缩前必须先落盘**：这一轮（自上次压缩以来）还没有把进展写进台账或 L1 日志。" +
      "压缩会丢掉逐字历史，所以先用 `ledger_write` 记下当前状态、并用 `ledger_log_write` " +
      "写一条 L1 摘要，之后压缩会自动继续（意图已退回队列，下一次空闲时重试）。",
    hint: "ledger_write",
    blockedCount: rec.count,
  };
}

/**
 * 取回并清空本会话攒下的"台账已改动"回执（弹卡片时调用）。
 */
function takeTouched(state, sid) {
  const key = String(sid);
  const rec = state.ledgerTouched.get(key);
  if (rec === undefined) return undefined;
  state.ledgerTouched.delete(key);
  return rec;
}

/**
 * 把回执渲染成**给用户看**的一句话（挂在卡片问题上）。
 *
 * ★ 括号里用**与台账条目相同的会话编号**（`[abcd]` 那个），不用原始 session id ——
 *   这样用户看到卡片后能**直接在台账里对号入座**："哦，这行是那个会话写的"。
 *   用原始 id（`session-s22a`）对不上条目行首的 4 位编号，等于给了个查不到的东西。
 *   实测撞到过：卡片说「会话 s22a」、条目写 `[abcd]`，两者对不上。
 */
function describeTouched(rec) {
  if (rec === undefined) return undefined;
  const files = [...rec.files];
  const names =
    files.length <= 2 ? files.join("、") : `${files.slice(0, 2).join("、")} 等 ${files.length} 个文件`;
  const tag = rec.last?.tag;
  const who = tag === undefined ? "" : `（条目行首标着 \`[${tag}]\`）`;
  return (
    `⚠ 本轮台账**已被改动** ${rec.count} 次${who}：${names}` +
    (rec.last?.lines === undefined ? "" : `，现 ${rec.last.lines} 行`) +
    "。若你不希望它写，可以撤销（台账是普通文件）或改用它下面的选项。"
  );
}

/**
 * 把回执渲染成**给 AI 看**的一段指令（需求 ⑲ 的第二条通道）。
 *
 * ★★ 为什么必须有它（2026-10-09，用户去掉每轮选择题之后）：
 *   回执原本**只**挂在回合末那张卡片上。卡片一关，回执就**永远送不出去**了 ——
 *   而用户当初问的正是「**AI 自己就把台账做了，那我怎么知道？**」。
 *   ⇒ 去掉卡片不能顺手把"你怎么知道"也去掉，所以换一条通道：
 *     注入给 AI，让它**在自己的回复里用一句话告诉用户**。
 *
 * ★ 为什么这条通道是合适的（而不是又加一张卡）：
 *   - 它**不打断工作**：不弹卡、不等答复、AI 接着干它的活（用户明确要求）；
 *   - AI 本来就要回用户一句话，搭在这句话上成本几乎为零；
 *   - 用户要的"知道"是**知会**，不是**让他做选择** —— 后者才是被去掉的那个东西。
 *
 * ★ 诚实边界：这条通道依赖 AI 照办（它可能不说）。所以**主动**那条路
 *   （`/ledger status` 列最近改动）必须一直留着 —— 两条路互补。
 */
function renderTouchedForAi(rec) {
  if (rec === undefined) return undefined;
  const files = [...rec.files];
  const names =
    files.length <= 2 ? files.join("、") : `${files.slice(0, 2).join("、")} 等 ${files.length} 个文件`;
  const tag = rec.last?.tag;
  const who = tag === undefined ? "" : `（条目行首标着 \`[${tag}]\`）`;
  return (
    // ★★★ 2026-10-11（对标 billion-context issue #1634，**环境就是 DSH `desktop` lane**）：
    //   那条 `p1` bug 的病是 —— **内部簿记以 `role:"user"` 注入 ⇒
    //   模型回答压缩元数据而不应答用户**，且污染**自我强化**。
    //   ⇒ 本条注入是**祈使句**（"请在你这次的回复里…"），是同一族里最危险的形态。
    //   ★ 实测（`tools/_probe-inject-role.mjs`，本会话 4408 个 assistant 文本回合）：
    //     **只有 2 个**回合以"回答台账回执"开头 ⇒ ★ **那个病症我们没有**。
    //     原因很可能就是下面这行**开头框定**（其余 78.6% 的注入早有同款框定）。
    //   ⇒ 补上它，把"占 20.4%、且带祈使句"的那一类也框起来（**零成本、不动载体**）。
    //   ⚠️ **不动 `role:"user"`**：那是内核自己的惯例（`time-context` / `agent-instructions` /
    //     `runtime-context` / `hindsight` **全都这么发**），改它属于逆着内核走；
    //     而我们另有 `source.kind` 这个**结构化**标记（#1634 缺的正是它）。
    "[插件注入 · 不是用户发言] 以下是**本插件**的台账回执，供你照办；" +
    "它**不是**你的对话对象说的话。\n\n" +
    "## 项目台账：本轮已被改动（请转告用户）\n\n" +
    `本插件记录到：**本轮台账被改动 ${rec.count} 次**${who}：${names}` +
    (rec.last?.lines === undefined ? "" : `，现 ${rec.last.lines} 行`) +
    "。\n\n" +
    "**请在你这次的回复里用一句话告诉用户这件事**（改了哪个文件、行首编号是哪个），" +
    "这样他不必自己去查就知道台账被动过。\n" +
    "★ 这**不是**让你停下来提问：**继续手上的工作**，只是顺带说一句。\n" +
    "★ 若用户不希望改，台账是普通文件，可以撤销；也可以让他用 `/ledger status` 查完整改动记录。"
  );
}

/**
 * 读最近几条"台账改动"审计（给 `/ledger status` 用，让用户能主动问）。
 * 只读、永不抛。
 */
function recentLedgerChanges(info, limit) {
  if (info.logAbs === undefined) return [];
  const files = logFileList(info).filter((f) => /L0-ledger-changes\.md$/.test(f.rel));
  const out = [];
  for (const f of files) {
    const raw = readTextSafe(f.abs);
    if (raw === undefined) continue;
    for (const line of raw.split("\n")) {
      if (line.startsWith("- ")) out.push(line);
    }
  }
  return out.slice(-(Number.isFinite(limit) && limit > 0 ? limit : 5));
}

/**
 * 回合末四选一的选项文案。
 *
 * ★ 选项数量与含义来自用户原话（m00630）：
 *   「第一不记录台账，第二只记录台账，第三记录台账并且执行压缩，第四是记录台账并且写交接单」
 */
const CHECKPOINT_OPTIONS = [
  { label: "不记录台账", description: "本轮不写台账，继续下一步。" },
  { label: "只记录台账", description: "把本轮进展写进活跃台账。" },
  { label: "记录台账 + 执行压缩", description: "先写台账，随后自动压缩上下文。" },
  { label: "记录台账 + 写交接单", description: "写台账，并额外产出一份交接文档。" },
];

/** 选项标签 → 内部动作。标签是给用户看的，这里只做一次翻译。 */
function choiceOfLabel(label) {
  const s = typeof label === "string" ? label : "";
  if (s.includes("压缩")) return "record+compact";
  if (s.includes("交接")) return "record+handoff";
  if (s.includes("不记录")) return "skip";
  if (s.includes("记录")) return "record";
  return "unknown";
}

/**
 * 量一下本会话的上下文占用（需求 ②⑳ 的分档判据）。
 *
 * ★ 两个数都走**官方**来源，插件自己不算：
 *   - 上限：`agent.session.requestContext().contextWindow`（官方在 `request/context` 事件里落的；
 *     见 `dsh-agent-loop\lib\index.js:1252-1259`）；
 *   - 已用：`tokenMeter.measure(session).totalTokens`（官方计量服务）。
 * 任一取不到就返回 undefined —— **宁可不提醒，也不报一个假占用**。
 */
function measurePressure(ctx, agent) {
  try {
    const meter = ctx.get("tokenMeter");
    if (meter === undefined || typeof meter.measure !== "function") return undefined;
    const session = agent?.session;
    if (session === undefined) return undefined;
    const win = session.requestContext?.()?.contextWindow;
    if (!Number.isFinite(win) || win <= 0) return undefined;
    const total = meter.measure(session)?.totalTokens;
    if (!Number.isFinite(total)) return undefined;
    return { total, window: win, ratio: total / win };
  } catch {
    return undefined;
  }
}

/**
 * 台账提示语：活跃台账在哪（没有就说明**这台机器上该怎么写**）。
 *
 * ★★ 这里踩过一次真实的坑（2026-10-08，用户第二次收到错卡片）：
 *   旧版在 `activeRel === undefined` 时一律说「本工作区**还没有台账**，请先
 *   `ledger_init` 建一套」。但在**容器工作区**里这句话是**做不到的** ——
 *   容器闸门会拒绝 `ledger_init`（在此 `git init` 会把所有子项目卷进错误的父仓库）。
 *   于是卡片给了一条**无法执行的指令**：AI 照着走只会撞在闸门上。
 *
 * ★ 为什么 `info` 常常是容器：这条文案由回合末自动路径调用，而它拿的
 *   `root = projectRootOf(agent)` 就是**会话工作目录**。用户平常就在容器根开会话
 *   （实测 112 个会话里 104 个如此），所以"没台账 + 是容器"是**最常见的组合**，
 *   不是边角情况。
 *
 * ⇒ 所以分三种情形说清楚，并给出**在这个目录上真能执行**的动作。
 */
function checkpointLedgerNote(info) {
  if (info.activeRel !== undefined) return `活跃台账是 \`${info.activeRel}\``;

  // root 都定位不到（拿不到 session.header.cwd）⇒ 连"建一套"都无处可建，实话实说。
  const projectRoot = typeof info.projectRoot === "string" ? info.projectRoot : undefined;
  if (projectRoot === undefined) {
    return (
      "本会话**定位不到工作目录**，所以无法写入台账。请把本轮进展直接讲给用户，" +
      "或问他希望记到哪个目录"
    );
  }

  const isContainer =
    info.isGitRepo !== true && (info.containerMarker !== undefined || info.nestedRepo !== undefined);
  if (isContainer) {
    // 容器里不能说"在这儿建一套"（会被闸门拒），要说"去哪儿建 / 或者写问题记录"。
    return (
      `本会话工作目录是**容器工作区**（\`${projectRoot}\`），这里**不能**建台账` +
      "（会把所有子项目卷进一个错误的父仓库）。所以本轮进展要落到**子项目**里：" +
      "给 `ledger_write` 传 `root` 点名那个子项目（例如 " +
      "`ledger_write({ root: \"<子项目相对路径>\", target: \"active\", content: \"…\" })`）——" +
      "**若你还不知道是哪个子项目，先问用户**。" +
      "若这一轮其实只是一次性问题/调研（没有累积状态），改用 `ledger_note` 写一份问题记录，**不要**建台账"
    );
  }
  return "本工作区**还没有台账**，请先按你自己的设计用 `ledger_init` 建一套";
}

/**
 * 选择 → 下一步该做什么。
 *
 * ★ 工具路径（需求 ②，AI 主动问）与**回合末自动路径**（需求 ①，插件代问）
 *   共用这一份文案：同一个选项无论从哪个入口进来，后果必须一模一样，
 *   否则"用户以为选了压缩、实际只有工具那条路会压"这类偏差会很难查。
 */
function checkpointNext(choice, info, received) {
  const ledgerNote = checkpointLedgerNote(info);
  // 日志一旦启用，四个选项就都要顺带写一条 L1 —— 它是唯一带「为什么」的一档。
  const logNote =
    info.logRel !== undefined
      ? " 然后写一条活动日志 L1 摘要（`ledger_log_write`，title 必填）—— L0/L2/L3 是机器自动采集的，只有这一档需要你写。"
      : "";
  // ★ 多会话同项目（用户提议）：写台账时带版本号 + 条目标会话编号。
  //   只在"确实有台账可写"时给这段，否则会与"还没有台账"的提示自相矛盾。
  const multiNote =
    info.activeRel === undefined
      ? ""
      : ` 写的时候带上 \`ifRevision: ${manifestRevision(info.manifest)}\`，并在新条目行首加上**你这次的会话编号**` +
        "（插件会在返回值里告诉你编号是什么，见 `sessionTag`）—— 这样多会话同时做这个项目时，" +
        "别的一眼看得出哪条是谁写的，你也不会把对方没见过的条目覆盖掉。";
  return {
    skip: "用户选了「不记录台账」。不要写台账，直接继续下一步工作。",
    record: `用户选了「只记录台账」。用 \`ledger_write\`（target:"active"）把本轮进展写进去（${ledgerNote}）。${multiNote}${logNote} 然后继续。`,
    "record+compact": `用户选了「记录台账 + 执行压缩」。先用 \`ledger_write\` 把本轮进展写进活跃台账（${ledgerNote}）。${multiNote}${logNote} **必须先写台账再结束本轮**，因为压缩会清掉本轮上下文。★ **写完台账之后，请你立刻自己调一次 \`ledger_compact\`**（\`mode:"light"\` 在回合内就能跑，不必等回合结束；你刚落盘，闸门必过）。插件在你结束本轮后还会兜底补一次（安全网），但那**不该是你的替代品** —— 你是这一档动作的执行者。`,
    "record+handoff": `用户选了「记录台账 + 写交接单」。先用 \`ledger_write\` 写活跃台账（${ledgerNote}）。${multiNote}${logNote} 然后**必须**用 \`ledger_handoff\` 写交接单（**不要自己找地方写** —— 那个工具会落到项目的约定位置，新会话才知道去哪读）。写清：做了什么、当前状态、下一步、**关键文件的确切路径**、有没有卡点。`,
    unknown: `用户的选择没有对上四个选项（收到：${received ?? ""}）。请按最稳妥的方式继续：把本轮进展写进台账。`,
  }[choice];
}

/** 组一张四选一的卡片。两条路径共用，保证选项与 id 逐字一致。 */
function checkpointQuestions(questionText) {
  return [
    {
      id: "ledger-turn-end",
      question: questionText,
      header: "项目台账",
      options: CHECKPOINT_OPTIONS,
    },
  ];
}

/**
 * 会话第一轮结束时的「要不要建项目」卡片（用户提议，2026-10-08）。
 *
 * ★ 为什么需要它：需求 ① 原本只做到"注入一句话，**让 AI 去问**用户"。
 *   但 AI 可能问、也可能不问（它还要顾别的），于是"新项目要不要建台账"这件事
 *   实际上经常没被问出口。用户的原话：
 *   「第一个回答结束后，先弹出选择，建项目或不建，第二个才是常规的是否写台账。」
 *   ⇒ 把第一问从"靠 AI 记得问"改成"**插件自己弹**"，与回合末四选一同一套机制。
 *
 * ★ 时机判据：`agent/turn-stopping` 的 payload 里 `turn === 1`。
 *   （官方确实带这个字段：`await this.dispatch.serial("agent/turn-stopping", { turn, signal })`。）
 *
 * ★ 为什么**不需要**再检查"这一轮是否成功结束"（我一开始多写了一套，后来删了）：
 *   看 `dsh-agent-loop` 里那个 catch —— 出错时它 `throw error`，**直接跳过** turn-stopping
 *   到 `finally` 里的 `turn/end`：
 *     ```
 *     } catch (error) { ...; throw error; }
 *     finally { this.session.append("step/end", {...}); }
 *     if (turnEnds && this.inbox.nextStep.length === 0) { await this.dispatch.serial("agent/turn-stopping", ...) }
 *     ```
 *   ⇒ **能收到 `turn-stopping` 本身就意味着这一轮没硬失败**。
 *   再叠一层 reason 判断只是把一个不可能发生的情况写进代码里。
 *   （顺带记一个实测事实：`turn/end` 的 `reason` 是**对象** `{kind:"completed"|"error"|
 *   "aborted"|"interrupted"|"max-tokens"}`，615 条无一例外。）
 *
 * ★ 为什么只问一次：问过就把会话记进 `projectAsked`，此后不再问（哪怕用户选了"建"、
 *   我们给了指示、那一轮又结束）。要不就会变成每轮都问"要不要建项目"。
 */
const FIRST_TURN_OPTIONS = [
  {
    label: "建项目（初始化台账）",
    description: "给这个目录建 Git + 一套台账；适合会长期做、以后要接上的活。",
  },
  {
    label: "不建，只写问题记录",
    description: "一次性的事（排查/调研）。用 ledger_note 记一份有终点的记录。",
  },
  { label: "暂时不用记", description: "这次什么都不留，直接继续。" },
  {
    // ★★★ 2026-10-10 用户拍板加的这一项。他的原话：
    //   *"因为总的工作区是有需要读的东西的，所以有时候会把对话建在总的工作区下面…
    //     把项目注册到对应的文件夹上，以后各种工具的使用都在那个文件夹上。"*
    //   以及 *"最开始的提示卡片就可以有这样的选择。"*
    // ★ 为什么这一项必须出现在**第一张**卡片上，而不是等 AI 想起来问：
    //   有 104/112 场会话的 cwd 就是容器根（实测）。也就是说"对话建在总工作区"
    //   是**常态而非边角**，而那种情况下每一条工具调用都需要知道"到底在说哪个项目"。
    label: "锁定到某个子项目",
    description:
      "这个目录是总工作区（装着多个项目）时用：指定一个子文件夹，本场对话的工具都落在那里。" +
      "★ 锁定会**记住**（重启、关掉再开都还在），每场对话各记各的；要取消说一声即可。",
  },
];

/**
 * 「这个已有项目的台账不符合计划」卡片（用户提议：允许重构已存在的项目）。
 *
 * ★ 只在**已登记但判定不合规**时弹，所以选项与上面那张不同：
 *   已有台账的项目不该被问"要不要建项目"，该被问"要不要把台账改合规"。
 */
const CONFORM_OPTIONS = [
  {
    label: "修复台账（只补缺的）",
    description: "补清单字段、补缺失的空文件/空目录。不覆盖、不删除任何已有内容。",
  },
  {
    label: "先给我看要改什么",
    description: "只做检测与预览，先报清单，不动任何文件。",
  },
  { label: "不用改", description: "保持现状，本次不再提这件事。" },
];

/** 选项标签 → 内部动作。 */
function conformChoiceOf(label) {
  const s = typeof label === "string" ? label : "";
  if (s.includes("修复")) return "repair";
  if (s.includes("先给我看")) return "preview";
  if (s.includes("不用改")) return "skip";
  return "unknown";
}

/** 「建项目 or 不建」的选项标签 → 内部动作。 */
function firstTurnChoiceOf(label) {
  const s = typeof label === "string" ? label : "";
  // ★ 顺序要紧：`锁定` 那条的说明里**含**"建"字吗？不含 —— 但"建项目"那条含。
  //   所以先判"锁定"（更具体），再判"建项目"。反过来的话"锁定到某个子项目"
  //   不会误中，但将来若有人把标签写成"建/锁到子项目"就会串。
  //   ⇒ 判据一律**先具体后笼统**（与 `conformChoiceOf` 同一条纪律）。
  if (s.includes("锁定")) return "lock";
  if (s.includes("建项目")) return "project";
  if (s.includes("问题记录")) return "note";
  if (s.includes("不用记")) return "none";
  return "unknown";
}

/**
 * 「建项目 or 不建」的文案。
 *
 * ★ 容器工作区**不能**说"在这儿建一套" —— `ledger_init` 会被容器闸门拒绝
 *   （在那里 `git init` 会把所有子项目卷进一个错误的父仓库）。
 *   实测 112 个会话里 104 个的 cwd 就是容器根，所以这是**最常见**的情形，不是边角。
 *   这条与 `checkpointLedgerNote` 是同一类判断，两处必须一致（D14 的教训）。
 */
function firstTurnNext(choice, info, received) {
  // ★★★ 2026-10-12（用户要求的小优化）：「暂时不用记」⇒ **返回 undefined，一个字都不注入**。
  //
  //   ★ 用户原话：*"暂时不用记这一条选项，完全不用返回给模型。他既然都不用记了，
  //     那么就不用知道我们插件的存在，这只是一个普通的过程。现在的情况是，
  //     即使我选第三个模型也要白白花一点 tokens"*
  //
  //   ★ 为什么这条**不只是省 token**，而是**语义一致性**问题：
  //     `skipAutoOffer` 与"什么都不写"说的是同一件事 —— **本次不留任何痕迹**。
  //     而原实现仍然 steer 一句"什么都不要写，继续下一步工作"，那是**自相矛盾**的：
  //       · 对模型而言：它本来在正常干活，突然收到一条"什么都不要写" ⇒
  //         等于**告知了插件的存在**，而这次恰恰是"不需要它知道"的那一次；
  //       · 对用户而言：他选了"不用记"，却因此**多付了一次注入的 token**
  //         （而且还打烂了 prompt 缓存 —— 本文件反复强调过这个代价）。
  //
  //   ★ 实现上必须让**调用方**知道"这次不注入"，所以用 `undefined` 当信号
  //     （不能返回空串 —— 那样仍会 steer 一条空文本的消息，token 省了但消息还在）。
  //   ★★ 注意：**只**对 `none` 这么处理。其余三个选项（建项目 / 问题记录 / 锁定）
  //     都**必须**注入 —— 没有那句话，AI 根本不知道该去调哪个工具。
  if (choice === "none") {
    return undefined;
  }
  if (choice === "note") {
    return (
      "用户选了「不建项目，只写问题记录」。请用 `ledger_note` 把这次做的事记成一份**问题记录**" +
      `（${info.notesRel !== undefined ? `目录：\`${info.notesRel}\`` : "工作区的记录目录"}）。` +
      "它落在工作区既有的记录通道里，**不要**建台账、**不要** `git init`。"
    );
  }
  if (choice === "project") {
    const isContainer =
      info.isGitRepo !== true && (info.containerMarker !== undefined || info.nestedRepo !== undefined);
    if (isContainer) {
      return (
        `用户选了「建项目」，但本会话工作目录是**容器工作区**（\`${info.projectRoot}\`），` +
        "这里**不能**建台账。请**先问用户是哪个子项目**，然后在那个子目录里初始化：" +
        "要么让用户把会话工作目录切过去，要么给 `ledger_init` 传 `root` 点名它。" +
        "**不要**在当前目录 `git init`。" +
        "\n★ 也可以顺手用 `ledger_lock` 把本场对话锁到那个子项目上 —— 之后所有工具都落在那里，" +
        "不必每次再传 `root`。"
      );
    }
    return (
      "用户选了「建项目（初始化台账）」。请先在 `ledger_init` 里判断这个目录**是什么类型的项目**，" +
      "然后**自己设计**一套台账结构（活跃台账 / 独立决策记录 / 归档目录 / 行数上限），" +
      "用 `ledger_init` 登记（它会顺带 `git init` 与合并式 `.gitignore`），" +
      "并建议一并传 `logDir` 启用活动日志。做完向用户简报一句文件名与结构。"
    );
  }
  // ★★★ 2026-10-10 用户拍板加的这一条（首轮卡片第四项）。
  if (choice === "lock") {
    return (
      "用户选了「锁定到某个子项目」。**先问清是哪个子文件夹**（不要自己猜 —— " +
      `当前目录 \`${info.projectRoot}\` 是容器工作区，底下可能有几十个项目，猜错就是把台账写进别人的项目）。` +
      "拿到目录后调 `ledger_lock`（传 `root`）把本场对话锁过去。\n" +
      "★ 锁**会记住**（存在 DSH 自己的 `plugin-data` 里，**不在用户的工作区里**，" +
      "所以他的项目目录不会多出任何东西）—— 重启、关掉再开都还在，**每场对话各记各的**。\n" +
      "★ 锁好之后：那个目录若还没有台账，问用户要不要 `ledger_init` 建一套；" +
      "此后本会话的所有工具调用都会落在那个目录上，**不需要再传 `root`**。"
    );
  }
  return `用户的选择没有对上三个选项（收到：${received ?? ""}）。请按最稳妥的方式继续：**先问用户**这个目录要不要建项目台账。`;
}

/**
 * 「已有项目的台账不符合计划」卡片（用户提议）。
 *
 * ★ 与 `offerProjectChoice` 的区别：那张问"要不要**建**"，这张问"要不要**改**"。
 *   前者面向全新项目，后者面向**已经在用台账、但不符合本插件预期**的项目。
 *
 * ★ 不 await、只弹出去（同 `offerTurnEndChoice`）—— 等答复会把回合边界挂住。
 *
 * @returns {boolean} 是否接管了这次回合末提问（调用方据此决定要不要跳过常规四选一）。
 */
function offerConformChoice(ctx, state, agent, info) {
  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid === "") return false;
  const key = String(sid);
  if (state.conformAsked.has(key)) return false;

  const conf = conformanceOf(info);
  // 只处理"已登记但不够好"的：没有台账的走建项目那张，合规的什么都不用说。
  if (conf.verdict !== CONFORMANCE.UPGRADEABLE && conf.verdict !== CONFORMANCE.NONCONFORMING) {
    return false;
  }

  const uq = ctx.get("userQuestions");
  if (uq === undefined || typeof uq.ask !== "function") return false;
  if (!isLiveRootAgent(ctx, agent)) return false;

  state.conformAsked.add(key);
  const entry = { at: Date.now() };
  state.autoOfferPending.set(key, entry);

  // 卡片上把"哪里不符合"直接列出来，用户才知道自己在决定什么。
  const detail = conf.reasons.slice(0, 4).join("；");
  void (async () => {
    try {
      const result = await uq.ask({
        questions: [
          {
            id: "ledger-conform",
            question:
              `这个项目的台账**不符合本插件的计划**：${detail}。要不要现在改成符合的？`,
            header: "项目台账",
            options: CONFORM_OPTIONS,
          },
        ],
        agent,
      });
      const answers = Array.isArray(result?.answers) ? result.answers : [];
      const first = answers[0] ?? {};
      const selected = Array.isArray(first.selected) ? first.selected : [];
      const custom = typeof first.custom === "string" ? first.custom.trim() : "";
      const choice = conformChoiceOf(selected[0]);

      state.skipAutoOffer.add(key);
      const received = `${JSON.stringify(selected)}${custom === "" ? "" : `，自定义：${custom}`}`;
      agent.steer({
        id: randomUUID(),
        content: [
          { type: "text", text: `${TURN_END_PREFIX}${conformNext(choice, info, conf, received)}` },
        ],
        source: { kind: INJECT_KIND, form: "instructions" },
        role: "user",
      });
    } catch {
      // 卡片被丢弃 / 没有应答者 / 会话已结束 ⇒ 什么都不做。
    } finally {
      if (state.autoOfferPending.get(key) === entry) state.autoOfferPending.delete(key);
    }
  })();

  return true;
}

/**
 * 「台账合规」选择 → 下一步。
 *
 * ★ 分两档交付：`ledger_conform` 能自动修的（补字段、补空文件）与**必须 AI 判断**的
 *   （超阈值挑条目归档、完全没台账要设计结构）。**别让 AI 去删条目** ——
 *   哪些条目过时是判断，插件只负责把事实摆清楚。
 */
function conformNext(choice, info, conf, received) {
  const fixList =
    conf.fixable.length > 0 ? conf.fixable.map((f) => `- ${f}`).join("\n") : "（没有可自动修的项）";
  const aiList = conf.needsAI.length > 0 ? conf.needsAI.map((f) => `- ${f}`).join("\n") : "（没有）";
  if (choice === "skip") {
    return "用户选了「不用改」。**不要再动这个项目的台账结构**，继续下一步工作。";
  }
  if (choice === "preview") {
    return (
      "用户选了「先给我看要改什么」。请调用 `ledger_conform`（**不要传 `apply`**，默认就是预览），" +
      "把它报出来的 `actions` / `skipped` 原样讲给用户听，并说明哪些**只能由你判断**：" +
      `\n${aiList}\n**先别改**，等用户确认后再传 \`apply: true\`。`
    );
  }
  if (choice === "repair") {
    return (
      "用户选了「修复台账（只补缺的）」。请：\n" +
      "1. 先调 `ledger_conform`（不传 `apply`）看一遍将要做什么；\n" +
      `2. 这些是**只做加法**的修复，可以直接执行 —— 传 \`apply: true\`：\n${fixList}\n` +
      "   （它只补清单字段、只建**空的**决策记录/归档目录，**绝不改写或删除任何已有内容**。）\n" +
      `3. 这些**要你来判断**，\`ledger_conform\` 不会替你动：\n${aiList}\n` +
      "   超阈值那种请用 `ledger_archive` 挑**最旧的已完成条目**移进归档（别删还有用的）；\n" +
      "4. 做完用一句话告诉用户改了什么、没改什么。"
    );
  }
  return (
    `用户的选择没有对上三个选项（收到：${received ?? ""}）。` +
    "请按最稳妥的方式继续：先跑 `ledger_conform` 预览给用户看，**不要**直接改。"
  );
}

/**
 * 会话第一轮结束 ⇒ 弹「建项目 or 不建」。
 *
 * ★ 与 `offerTurnEndChoice` 一样**不 await**：`agent/turn-stopping` 是 loop
 *   在关回合边界前 await 的，在这里等用户点选会把回合一直挂着。
 *
 * ★ 用户选完用 `agent.steer` 唤醒 AI 去执行；**先立 `skipAutoOffer`**，
 *   否则 steer 那一轮结束时会紧接着又弹一张"是否写台账"，变成连问两轮 ——
 *   那恰恰是用户想避免的（他要的是**先问建不建，再问写不写**）。
 *
 * @returns {boolean} 是否**真的接管了**这一次回合末提问。
 *   ★ 调用方必须看这个返回值决定要不要跳过常规四选一 ——
 *   否则"已经有台账"这种本来就该走常规路径的情况会被吞掉，用户一张卡都收不到
 *   （2026-10-08 演练时实测撞到：已有台账 + turn=1 ⇒ 卡片一张都没有）。
 */
function offerProjectChoice(ctx, state, agent, info) {
  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid === "") return false;
  const key = String(sid);
  if (state.projectAsked.has(key)) return false;

  const uq = ctx.get("userQuestions");
  if (uq === undefined || typeof uq.ask !== "function") return false;
  if (!isLiveRootAgent(ctx, agent)) return false;

  // 已经建过台账就没必要问"要不要建项目"了 —— 交给常规四选一。
  if (info.activeRel !== undefined) return false;

  state.projectAsked.add(key);
  const entry = { at: Date.now() };
  state.autoOfferPending.set(key, entry);

  void (async () => {
    try {
      const result = await uq.ask({
        questions: [
          {
            id: "ledger-first-turn",
            question:
              "这是本次会话的第一轮。这个目录要不要建成一个项目（Git + 台账）？",
            header: "项目台账",
            options: FIRST_TURN_OPTIONS,
          },
        ],
        agent,
      });
      const answers = Array.isArray(result?.answers) ? result.answers : [];
      const first = answers[0] ?? {};
      const selected = Array.isArray(first.selected) ? first.selected : [];
      const custom = typeof first.custom === "string" ? first.custom.trim() : "";
      const choice = firstTurnChoiceOf(selected[0]);

      // ★ 这也是一次"问过用户了" ⇒ 那一轮结束时不要再自动弹四选一。
      //   ★★ 注意这一句**要留在 steer 之前**：哪怕选了「暂时不用记」（下面不注入），
      //     也已经"问过"了 ⇒ 那一轮不该再叠一张四选一卡（否则用户会连着看到两张）。
      state.skipAutoOffer.add(key);
      const received = `${JSON.stringify(selected)}${custom === "" ? "" : `，自定义：${custom}`}`;
      // ★★★ 2026-10-12：`firstTurnNext` 返回 `undefined` ⇒ **本步不注入任何东西**。
      //   目前只有「暂时不用记」走这条路（它的语义就是"这次不留痕迹、也别让模型
      //   知道插件存在"）⇒ 连 steer 都不发，省掉一次注入的 token 与一次缓存失效。
      const text = firstTurnNext(choice, info, received);
      if (text !== undefined) {
        agent.steer({
          id: randomUUID(),
          content: [{ type: "text", text: `${TURN_END_PREFIX}${text}` }],
          source: { kind: INJECT_KIND, form: "instructions" },
          role: "user",
        });
      }
    } catch {
      // 卡片被丢弃 / 没有应答者 / 会话已结束 ⇒ 什么都不做。
    } finally {
      if (state.autoOfferPending.get(key) === entry) state.autoOfferPending.delete(key);
    }
  })();

  // ★ 已经接管了这一次提问（卡片正在送出）。
  return true;
}

/**
 * 回合末自动卡片：已经挂着一张、且没挂多久，就不重复打扰。
 *
 * ★ 为什么需要"陈旧"这条路：卡片被关掉（hide）时那条 waterfall 并不结算，
 *   若只看"还挂着没有"，一次被无视的卡片会让本会话此后再也收不到回合末选择。
 *   给一个上限，等于"你不理我就先安静一阵，之后还会再问"。
 */
const AUTO_OFFER_STALE_MS = 30 * 60 * 1000;

/**
 * 这条 steer 消息是插件发的，**不是用户打的字**。
 *
 * ★ 前缀不只是给人看的：官方 `hasDirectHumanInput` 的注释写明
 *   "An omitted `Agent.followup()` / `steer()` source resolves to `user`, so non-human
 *   producers must supply their own source rather than inheriting this authority."
 *   ⇒ 必须显式给 `source`（我们用自己的 INJECT_KIND），否则这条消息会被当成
 *   用户本人的授权，去影响那些"只在有人类输入时才成立"的判断。
 */
const TURN_END_PREFIX = "[项目台账·回合末选择] ";

/** 这个 agent 是不是活着的 root（子 agent 的回合末不该弹卡片）。 */
function isLiveRootAgent(ctx, agent) {
  try {
    const agents = ctx.get("agents");
    if (agents === undefined || typeof agents.roots !== "function") return true;
    return agents.roots().includes(agent);
  } catch {
    return true;
  }
}

/**
 * 把水位渲染成**给用户看**的一句话（挂在回合末卡片上）。
 *
 * ★ 为什么用户这一侧也要说：水位提醒是注入给 **AI** 的（`renderPressureNotice`），
 *   而 AI 完全可以不理会、或者不把这件事转述给用户。用户需求 ⑳ 要的是
 *   「**尽量停止工作并提醒手动压缩**」—— "提醒"的对象是**用户**。
 *   所以 70% 这一档再走一次卡片，让用户自己看见并决定。
 *
 * ★ 只在 ≥70% 时说：30%/50% 那两档动作是"顺手固化、照常干活"，
 *   没有任何需要用户决策的东西 —— 报给他只会变成噪音。
 */
function describePressureForUser(pressure) {
  if (pressure === undefined) return undefined;
  if (pressure.ratio < PRESSURE_STOP_RATIO) return undefined;
  const pct = Math.round(pressure.ratio * 100);
  return (
    `⚠ 上下文水位已到 **${pct}%**（官方会在 80% 处自动压缩，那时本轮的上下文会被清掉）。` +
    "建议选「记录台账 + 执行压缩」先落袋，或先停手做一次交接。"
  );
}

/**
 * 回合末自动弹四选一（需求 ①）。
 *
 * ★ 为什么**不 await**：`agent/turn-stopping` 是 loop 在关闭回合边界前 `await` 的
 *   （`dsh-agent-loop\lib\index.js:999`）。在这里等用户点选，等于把回合一直挂着 ——
 *   用户走开十分钟，会话就十分钟显示"运行中"，新消息也只能排队。用户对需求 ② 的原话是
 *   "不要打断工作"，需求 ① 同样不该用一张卡片把回合卡住。
 *   所以这里**立刻返回**，卡片留在输入框旁边，用户选中后我们再用 `agent.steer`
 *   把 AI 唤醒去做那件事 —— 这也正是 steer 的语义（`followup`/`steer`/`inject`
 *   分别排 next-turn / next-step，见 `dsh-agent-loop\lib\index.js:806-810`）。
 *
 * ★ 为什么不会无限循环：steer 出去以后会被标记 `skipAutoOffer`，
 *   下一轮结束时先把这个标记消费掉、不再追问；否则"选完 → 干活 → 又被问"会一直转。
 */
function offerTurnEndChoice(ctx, state, agent) {
  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid === "") return;
  const key = String(sid);

  if (state.skipAutoOffer.has(key)) {
    state.skipAutoOffer.delete(key);
    return;
  }

  const held = state.autoOfferPending.get(key);
  if (held !== undefined && Date.now() - held.at < AUTO_OFFER_STALE_MS) return;

  const uq = ctx.get("userQuestions");
  if (uq === undefined || typeof uq.ask !== "function") return;
  if (!isLiveRootAgent(ctx, agent)) return;

  const entry = { at: Date.now() };
  state.autoOfferPending.set(key, entry);

  // ★ 把"本会话改过台账"的回执挂到卡片问题上 —— 这是用户**唯一必然看到**的地方。
  //
  //   为什么挂这里：他选了「只记录台账」之后那一轮的卡片是被抑制的，
  //   所以回执必须留到下一次真正弹卡片时带上；否则"AI 自己把台账做了"
  //   这件事就永远只存在于工具返回值里（那个只有 AI 看得到）。
  const touched = takeTouched(state, key);
  const touchedNote = describeTouched(touched);
  // ★ 70% 那一档也告诉**用户**（不只注入给 AI）—— 需求 ⑳ 的"提醒手动压缩"是对人说的。
  const pressureNote = describePressureForUser(measurePressure(ctx, agent));
  const baseQuestion = "本轮已结束，接下来怎么处理？";
  const notes = [pressureNote, touchedNote].filter((n) => n !== undefined);

  void (async () => {
    try {
      const result = await uq.ask({
        questions: checkpointQuestions(
          notes.length === 0 ? baseQuestion : `${notes.join("\n\n")}\n\n${baseQuestion}`
        ),
        agent,
      });
      const answers = Array.isArray(result?.answers) ? result.answers : [];
      const first = answers[0] ?? {};
      const selected = Array.isArray(first.selected) ? first.selected : [];
      const custom = typeof first.custom === "string" ? first.custom.trim() : "";
      const choice = choiceOfLabel(selected[0]);
      // 「不记录台账」= 什么都不做。也**不要** steer：没有下一步要干，
      // steer 只会白起一轮、白花一次上下文。
      if (choice === "skip") return;

      const root = projectRootOf(agent);
      // ★ 这里必须是 `inspect(root)` 的结果：`checkpointLedgerNote` 要靠
      //   `containerMarker` / `nestedRepo` 判断"这台机器上能不能在此建台账"。
      //   旧版在定位不到 root 时只给 `{ activeRel: undefined }`，那会让文案退化成
      //   "请先建一套"—— 而当时恰恰可能是在禁止建台账的容器里（实测踩到）。
      const info = root === undefined ? { activeRel: undefined } : inspect(root);
      if (choice === "record+compact") {
        state.compactAfterTurn.set(key, { at: Date.now(), callId: null });
      }
      const received = `${JSON.stringify(selected)}${
        custom === "" ? "" : `，自定义：${custom}`
      }`;
      // ★ 先立标记再 steer：steer 之后那一轮的 turn-stopping 会立刻消费它。
      state.skipAutoOffer.add(key);
      agent.steer({
        id: randomUUID(),
        content: [{ type: "text", text: `${TURN_END_PREFIX}${checkpointNext(choice, info, received)}` }],
        source: { kind: INJECT_KIND, form: "instructions" },
        role: "user",
      });
    } catch {
      // 卡片被关掉 / 没有应答者 / 会话已经结束 —— 都当"这次没选"，什么都不做。
      // 尤其不能在这里抛：这是游离的 Promise，抛出去就是 unhandledRejection。
    } finally {
      if (state.autoOfferPending.get(key) === entry) state.autoOfferPending.delete(key);
    }
  })();
}

/**
 * 回合末四选一（需求 ①②）。
 *
 * ★ 为什么**还有**一个工具（自动路径已经覆盖了需求 ①）：
 *   需求 ② 是"AI 认为有必要时也可以给"—— 那个时机只有 AI 知道
 *   ① "这一刻该不该问"只有 AI 知道（需求 ② 明确说"AI 认为有必要时"）；
 *   ② 走到 `userQuestions` 的请求必须归属一个**活的 root agent**，
 *      而 pre-step / turn-stopping 里拿到 agent 没问题，但"什么时候问"仍要 AI 判断。
 *   ③ 官方 `dsh-tool-ask-user` 本身就是这么做的（`inject = ["tools","userQuestions"]`），
 *      所以这是一条**官方路径**，不是自创。
 */
/**
 * ⑪ ledger_compact —— **手动**执行一次「我们的」高保真压缩（需求 ②）。
 *
 * ★ 为什么需要（用户 2026-10-09 原话）：
 *   *"考虑把我们的这个压缩加进主动中，让我们可以手动进行压缩，
 *     而且执行的是我们的压缩。"*
 *
 * ★ 为什么不能复用 `/compact`（官方的）：那条只调内核的 `compactNow` ——
 *   压完**没有逐字胶囊**，用户原话 / 报错原文 / 器物索引全都会随摘要一起丢掉。
 *   本工具走的是 `runHighFidelityCompact`：**先抓胶囊、再压、然后强制重注**。
 *
 * ★ 为什么要等 idle：`compactNow` 要求 agent 处于 idle
 *   （内核 `ManualCompactionError("busy", …)`）。而工具是**在回合中**被调用的，
 *   所以这里**只排队、不立刻压** —— 等本回合结束、`agent/status` 转 idle 时执行。
 *   ⇒ 从调用者视角：调完就返回"已排队"，**工作不受影响**（用户明确要求）。
 */
function defineCompactTool(ctx, state, capsule) {
  return {
    name: "ledger_compact",
    // ★★★ 2026-10-12（D114）：这段描述**原来是"别常用"**（`do NOT compact routinely`），
    //   与注入里那句"压缩由插件在后台自己完成"**两个通道一起**告诉模型"不用你管"。
    //   ⇒ 实测后果：7870 次工具调用里它**只被调 2 次**（同期 9 次压缩全是机械触发的）。
    //   ★ 现在改成**按需即用**，并把 billion-context 实证过的三条给它：
    //     ① "按需，不按百分比"（它的原话是 Compress by need, not by percentage）；
    //     ② **判据**：什么时候算"一段用完了"（它敢动手是因为知道该压什么）；
    //     ③ 说清代价与保障（压完有逐字胶囊可回读 ⇒ 它**不怕压错**）。
    //   ★ 但**不说"随便压"**：仍要说清"到节点才压" —— 否则每次梳理一小段就压，
    //     会把 prompt 缓存反复打冷（billion 自己 96% 的 nudge 都为此自我压制）。
    description:
      "Compact this conversation's history so you can keep working with a long context. " +
      "Compress BY NEED, not by percentage: when a stretch of old history has served its " +
      "purpose (an exploration finished, a long output already consumed, conclusions " +
      "written into the ledger), call this to fold it away — do not wait for a watermark.\n" +
      "TWO modes — pick by need:\n" +
      "• mode=\"light\" (★ PREFERRED while working): compress only the OLDEST segment, keeping " +
      "the recent head intact. It runs IN-TURN via `compactRegion` — no need to wait for the " +
      "turn to end, so your work continues uninterrupted. Use when the context is getting long.\n" +
      "• mode=\"full\" (default when omitted): a HIGH-FIDELITY whole-conversation compaction that " +
      "must wait for the agent to be idle (end of turn). It first captures a VERBATIM capsule " +
      "(the user's own words, error strings, the artifact index of changed files, and the paths " +
      "to re-read) and re-injects it afterwards. Heavier, but keeps far more detail than the " +
      "kernel's own /compact.\n" +
      "Do NOT call it on every step: folding one tiny slice repeatedly keeps re-writing the " +
      "prompt prefix and cools the prompt cache. Fold when a stretch is genuinely spent.\n" +
      "Either way this plugin keeps a VERBATIM record: anything compacted can be read back " +
      "verbatim later with `ledger_recall`, so nothing is permanently lost.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        mode: {
          type: "string",
          enum: ["light", "full"],
          description:
            "\"light\" = compress the oldest segment in-turn (preferred while working); " +
            "\"full\" = high-fidelity whole-conversation compaction at end of turn.",
        },
      },
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const agent = exec?.agent;
      const sid = agent?.session?.header?.id;
      if (typeof sid !== "string" || sid === "") {
        return { ok: false, reason: "拿不到本会话的 id，无法排队压缩。" };
      }
      const root = rootFromExec(exec, args);
      const info = inspect(root);
      const key = String(sid);
      // ★ 模式：`light`（回合内、只压最旧一段，**模型工作时的首选**）/ 其它一律 `full`。
      const wantLight = args?.mode === "light";

      // ★★ 必须经 `compactionServiceFor` —— 见它的注释：
      //   本 profile 下 compaction 挂在 preset 的 `isolate` 组里，
      //   **`ctx.get` 与 `agent.ctx.get` 都拿不到**，只能经内核官方的
      //   `agentPresets.serviceFor(agent, "compaction")`。
      //   取不到就会让本工具**永远报"没有 compaction 服务"**，
      //   而用户看到的是"功能配好了却不工作"。
      const compaction = compactionServiceFor(ctx, agent);
      if (compaction === undefined) {
        return { ok: false, reason: "本机没有 compaction 服务，无法压缩（台账本身不受影响）。" };
      }

      // 先量一下水位（只为回报给调用者；不是压缩的前提）。
      const pressure = measurePressure(ctx, agent);

      // ★ 只在压缩**之前**抓一次快照，供压缩后重注用（执行器里还会再抓一次，无害）。
      let capsuleChars = 0;
      try {
        const snap = renderCapsule(info, capsule?.get(key));
        if (snap !== undefined) {
          state.capsuleSnapshot.set(key, snap);
          capsuleChars = snap.length;
        }
      } catch {
        /* 抓不到就不抓，别挡住压缩 */
      }

      // ★★★ 2026-10-11（用户：*"那个 billion context 可以让模型一边工作一边压缩，
      //   完全不用等对话结束，而且是模型主动调用的，我们可以做到吗？"*）：
      //   **能，而且内核本来就给了这条路** —— 只是我们没把它暴露给模型。
      //
      //   ★ 内核两条路的守卫条件（`dsh-compaction-basic/lib/index.js:456-463` 逐字读过）：
      //     · `compactNow`     → `owner: null`         ⇒ **要求 idle**（必须等回合结束）
      //     · `compactRegion`  → `owner: "current-turn"` ⇒ ★ **要求回合开着**
      //   ⇒ `compactRegion` **天生就是"边干边压"**。我们执行 `/ledger light` 用的正是它。
      //
      //   ★ 为什么这里走 `deltaForce` + `steer`、而不是直接 `await compactRegion`：
      //     工具回调跑在**一步之内**，而 `compactRegion` 要求"回合开着"这个状态
      //     由**下一轮 pre-step** 才走得稳（与 `/ledger light` 同一条已验证的路）。
      //     ⇒ 立旗子 + 唤醒一轮，那一轮的 pre-step 立刻 `runIncrementalCompact(force)`。
      //   ★ `force: true` 的语义（与 `/ledger light` 完全一致，D40）：
      //     **不看涨幅、不看落盘闸门** —— 这是"模型明确要求"的授权，等同人的授权。
      if (wantLight) {
        if (compaction === undefined || typeof compaction.compactRegion !== "function") {
          return {
            ok: false,
            reason:
              "本机没有可用的 `compaction` 服务（或它不支持 `compactRegion`），无法做轻量压缩。" +
              "可改用 `mode:\"full\"`（走另一个方法）。",
          };
        }
        // ★★★ 2026-10-12（D114）：**这里要把"谁发起的"区分开**，否则会绕开落盘闸门。
        //
        //   原来这条与 `/ledger light` **共用同一个 `deltaForce` 旗子**，而消费处写的是
        //   `force: forcedLight` ⇒ 两条都 `force: true` ⇒ 都**不看落盘闸门**。
        //   ★ 而 `:5658` 的注释**自称**"`manual`（AI 调工具）不在手动名单里 ⇒ 仍走自动流程"
        //     —— **注释写的是意图，代码做的是另一回事**（D89 那个"两处各写一份"的同型病）。
        //
        //   ⇒ 现在旗子里带上 `source: "tool"`，消费处据此决定**是否豁免闸门**：
        //     · 人按 `/ledger light`（`source: "command"`）⇒ 豁免（他按下就是授权，D40）；
        //     · AI 调本工具（`source: "tool"`）⇒ ★ **必须过闸门**（先记台账再压）。
        //   ★ 理由：用户 2026-10-12 明确要求「**一定一定要先更新台账日志再压缩**」——
        //     AI 主动压**越是常态，这条越要紧**（它可能在还没落盘时就压掉唯一那份进展）。
        state.deltaForce.set(key, { at: Date.now(), source: "tool" });
        let steered = false;
        if (typeof agent.steer === "function") {
          try {
            agent.steer({
              id: randomUUID(),
              // ★ 内容刻意**短**：这一轮的唯一目的就是把 pre-step 触发起来，
              //   真正该进上下文的东西（台账 + 索引 + 回执）由 pre-step 自己注入。
              content: [
                {
                  type: "text",
                  text: "[ledger] light compaction requested in-turn — continue working.",
                },
              ],
              // ★★★ 2026-10-12（D120，**真机事故修复**）：`source` 必须给，否则**整个会话
              //   历史从此加载不出来**。
              //
              //   事故（本机实测，非推测）：这一条 `steer` 原来只有 `id` + `content`
              //   —— 那是 D114 新增本调用时**漏掉的**。内核把它作为
              //   `agent/inbox/spliced` 写进会话日志，而**重载历史时**内核会校验
              //   每一个消息槽位的生产者身份（`app.asar` 里 `mapEventMessages` 的
              //   5 个槽位之一就是 `data.inserted[]`）：
              //
              //     function source(message) {
              //       const value = message["source"];
              //       if (!isObject(value) || typeof value["kind"] !== "string"
              //           || value["kind"].length === 0 || value["kind"] === "plugin")
              //         throw new SessionFormatError("format v4 message requires a producer-owned source kind");
              //     }
              //
              //   ⇒ 报错 `stored session "…" is corrupt: … requires a producer-owned
              //     source kind` ⇒ 那个对话**打不开历史**（实时对话不校验，只有重载才校验
              //     —— 所以它在写下的那一刻毫无症状，**下一次打开才炸**）。
              //
              //   ★★ 为什么这个坑这么贵：**一条坏事件就能让整个会话加载失败**，
              //     而且**坏在历史里、不是坏在当下** —— 现场早就过去了，只留下一条打不开的日志。
              //   ★★ 同型的病本机**栽过两次**：2026-09-24 是"手搓消息漏了 `id`"，
              //     这次是"手搓消息漏了 `source`"。⇒ **凡手搓消息对象，必须与内核的
              //     admission 判据逐条对齐**（`id` 非空 string + `source.kind` 非空且 ≠ "plugin"）。
              //   ★ 本文件其余 6 处 `agent.steer()` **全都带这一行**，只有这里漏了。
              source: { kind: INJECT_KIND, form: "instructions" },
              role: "user",
            });
            steered = true;
          } catch {
            /* 唤醒失败 ⇒ 旗子还立着，下一次 pre-step 自然消费；如实回报即可 */
          }
        }
        return {
          ok: true,
          mode: "light",
          queued: false,
          steered,
          note:
            "已请求一次**轻量（分段）压缩**：只压最旧一段、保留最近一大块，" +
            "在**回合内**执行 —— **你不必等回合结束，继续手上的工作**。" +
            (steered ? "" : "（唤醒未成功，旗子已立：下一次 pre-step 会自动消费。）") +
            // ★★★ 2026-10-12（D114）：**在这里把顺序讲明**，因为这是 AI 主动压的入口。
            //   用户要求：*"一定要让模型先更新台账日志再压缩"*。
            //   ★ 讲法要"是顺序、不是障碍" —— 并说清**为什么**（没落盘的那段是唯一副本），
            //     否则模型会把它读成"插件又在挡我"。
            " ★★ **前提：压之前要先落盘** —— 若你这一步的进展还没写进台账，" +
            "压缩会被闸门拦下（它会当场告诉你，**不是失败**）：" +
            "先 `ledger_write` + `ledger_log_write`，**再调一次**本工具即可。" +
            "★ 为什么：压掉的旧历史会变成摘要，**没落盘的那段进展就是唯一副本**。" +
            " ★ 被压掉的内容仍可逐字读回（`ledger_recall`）。",
          ...(pressure === undefined ? {} : { contextRatio: Math.round(pressure.ratio * 1000) / 1000 }),
        };
      }

      // 排队：回合末 idle 时由 agent/status 处理器执行。
      state.hfCompactAfterTurn.set(key, { at: Date.now(), source: "manual" });

      return {
        ok: true,
        queued: true,
        note:
          "已排队：本回合结束（agent 空闲）后插件会执行一次**高保真**压缩 —— " +
          "它会先抓逐字胶囊（用户原话 / 报错原文 / 器物索引 / 可重读路径），" +
          "压缩后把这些连同台账一起重新注入。**你不需要等，继续手上的工作。**",
        // ★ 逐字胶囊的规模：让调用者知道"保住了多少东西"，而不是只报一个 ok。
        capsuleChars,
        ...(pressure === undefined
          ? {}
          : { contextRatio: Math.round(pressure.ratio * 1000) / 1000 }),
        ...(info.logRel === undefined ? {} : { logDir: info.logRel }),
      };
    },
  };
}

function defineCheckpointTool(ctx, state) {
  return {
    name: CHECKPOINT_TOOL,
    description:
      "Ask the user, in one card beside the chat input, what to do with this turn's work: " +
      "skip recording, record the ledger only, record + compact the context, or record + write " +
      "a handoff document. Use it when a turn has finished something worth keeping, when the " +
      "context passes 30%/50%/70% of the model's window (the plugin also reminds you at each of " +
      "those levels; at 70% the plugin compacts on its own and you keep working), or whenever " +
      "you judge it necessary. Prefer calling it at a natural stopping point rather than " +
      "mid-task. Returns the user's choice; then do what it says.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Optional custom wording for the card's question.",
        },
        summary: {
          type: "string",
          description:
            "Optional one-line summary of what this turn accomplished, shown in the card so the " +
            "user knows what they are deciding about.",
        },
        nonBlocking: {
          type: "boolean",
          description:
            "Set true to leave the card answerable and keep working instead of waiting. Default " +
            "false: the turn waits for the answer, which is the durable path.",
        },
        timeoutSeconds: {
          type: "number",
          description: "With nonBlocking, how long to wait before returning a pending result.",
        },
      },
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec);
      const agent = exec?.agent;
      if (agent === undefined) {
        throw fail(`${CHECKPOINT_TOOL}: 这个执行没有活着的 agent，无法把卡片送给用户。`);
      }

      const uq = ctx.get("userQuestions");
      if (uq === undefined || typeof uq.ask !== "function") {
        // 软失败：让 AI 自己决定怎么办，而不是把整轮对话打断。
        return {
          ok: false,
          reason:
            "本机没有可用的 userQuestions 服务（没有会渲染选项卡片的客户端）。" +
            "请改用你的 ask_user_question 工具问同样的问题，或直接按最稳妥的方式继续" +
            "（先写台账，不压缩）。",
          options: CHECKPOINT_OPTIONS.map((o) => o.label),
        };
      }

      const summary = typeof args?.summary === "string" ? args.summary.trim() : "";
      const questionText =
        typeof args?.question === "string" && args.question.trim() !== ""
          ? args.question.trim()
          : "本轮已告一段落，接下来怎么处理？";
      const questions = [
        {
          id: "ledger-turn-end",
          question: summary === "" ? questionText : `${questionText}\n\n（本轮：${summary}）`,
          header: "项目台账",
          options: CHECKPOINT_OPTIONS,
        },
      ];

      const callId = typeof exec?.callId === "string" && exec.callId !== "" ? exec.callId : undefined;
      const nonBlocking = args?.nonBlocking === true;
      const timeoutMs =
        Number.isFinite(args?.timeoutSeconds) && args.timeoutSeconds > 0
          ? Math.min(Math.floor(args.timeoutSeconds * 1000), 2147483000)
          : 120000;

      let result;
      try {
        if (nonBlocking) {
          if (callId === undefined) {
            throw fail(`${CHECKPOINT_TOOL}: 非阻塞提问需要一个 callId，这次执行没有。`);
          }
          result = await uq.askTimed({ questions, agent }, callId, timeoutMs);
        } else {
          result = await uq.ask({
            questions,
            agent,
            ...(callId === undefined ? {} : { wait: { callId } }),
          });
        }
      } catch (e) {
        // 卡片送不出去（无应答者 / agent 不是活 root / 被取消）⇒ 软失败，绝不打断对话。
        return {
          ok: false,
          reason: `没能把选择卡片送给用户：${String((e && e.message) || e)}`,
          options: CHECKPOINT_OPTIONS.map((o) => o.label),
        };
      }

      if (result !== null && typeof result === "object" && result.pending === true) {
        // ★ 非阻塞提问的卡片已经挂在输入框旁边了 ⇒ 记下来，回合末别再问一遍。
        //   不加这一步会出现"AI 问了一张、回合末又自动弹一张"，而客户端同一时刻
        //   只渲染一张卡片（`ui-user-questions\README.md:119`），第二张要等第一张
        //   结算才冒出来 —— 用户会看到一张卡片变成另一张，很像卡住了。
        const pendingSid = String(agent?.session?.header?.id ?? "");
        if (pendingSid !== "") {
          state.autoOfferPending.set(pendingSid, { at: Date.now() });
        }
        return {
          ok: true,
          pending: true,
          callId: result.callId ?? callId ?? null,
          options: CHECKPOINT_OPTIONS.map((o) => o.label),
          note:
            "卡片已经留在输入框旁边，用户随时可以点。**这不是许可**：继续做不依赖这个选择的独立工作，" +
            "不要因为没等到答复就停下来，也不要把没答复当成用户已经同意。",
        };
      }

      const answers = Array.isArray(result?.answers) ? result.answers : [];
      const first = answers[0] ?? {};
      const selected = Array.isArray(first.selected) ? first.selected : [];
      const custom = typeof first.custom === "string" ? first.custom.trim() : "";
      const choice = choiceOfLabel(selected[0]);

      const sid = String(agent?.session?.header?.id ?? "");
      if (choice === "record+compact" && sid !== "") {
        state.compactAfterTurn.set(sid, { at: Date.now(), callId: callId ?? null });
      }
      // ★ AI 本轮已经问过了 ⇒ 回合末不再自动问一遍（需求 ① 与 ② 撞在同一次停顿上时，
      //   只问一次）。这就是 autoOfferPending / skipAutoOffer 存在的意义。
      if (sid !== "" && choice !== "unknown") state.skipAutoOffer.add(sid);

      // 到这里才需要探测台账 —— 前面几条软失败路径不必付这次磁盘扫描。
      const info = inspect(root);
      const next = checkpointNext(
        choice,
        info,
        `${JSON.stringify(selected)}${custom === "" ? "" : `，自定义：${custom}`}`
      );

      return {
        ok: true,
        choice,
        selected,
        custom: custom === "" ? null : custom,
        next,
      };
    },
  };
}

/** ① ledger_status —— 只读探测。 */
// ★ 2026-10-11：签名加上 `state` —— 为了报出"本会话压缩了几次"（D59 的可查计数器）。
//   与 `defineCompactTool(ctx, state, capsule)` / `defineCheckpointTool(ctx, state)` 同一形状。
function defineStatusTool(ctx, state) {
  return {
    name: "ledger_status",
    description:
      "Report this project's ledger state: whether a ledger exists, which files it uses " +
      "(and whether that came from the manifest or a guess), whether a Git repository and " +
      ".gitignore exist, the active ledger's line count and whether it is over threshold. " +
      "Read-only, free, and never writes anything. Call this before assuming anything about " +
      "the ledger, and call it first if you are unsure whether this project has one.",
    parameters: { type: "object", properties: { root: ROOT_PARAM }, additionalProperties: false },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec, args);
      const info = inspect(root);
      return {
        ok: true,
        projectRoot: root,
        initialized: info.activeRel !== undefined,
        freshProject: isFreshProject(info),
        isGitRepo: info.isGitRepo,
        containerWorkspace:
          info.containerMarker !== undefined || info.nestedRepo !== undefined
            ? {
                marker: info.containerMarker ?? null,
                nestedRepo: info.nestedRepo ?? null,
              }
            : null,
        hasGitignore: info.hasGitignore,
        manifestPath: info.manifestPath,
        hasManifest: info.manifest !== undefined,
        active: info.activeRel ?? null,
        decisions: info.decisionsRel ?? null,
        archiveDir: info.archiveRel ?? null,
        logDir: info.logRel ?? null,
        logLevels: info.logLevels,
        logFiles: info.logRel !== undefined ? logFileList(info).length : 0,
        // ★ 猜到了同名目录但**没启用**（清单里没登记）⇒ 明确说出来 + 怎么启用。
        //   不说的话用户会以为日志在工作（目录都在那儿了），而实际上一条都没记。
        logDirFoundButNotEnabled: info.logGuess ?? null,
        // ★ 不是项目时（容器/工作区）额外报出"问题记录该写哪"。
        notesDir: info.notesRel ?? null,
        discoveredBy: {
          active: info.source,
          decisions: info.decisionsSource,
          archiveDir: info.archiveSource,
          logDir: info.logSource,
          notesDir: info.notesSource,
        },
        activeExists: info.activeExists,
        activeLines: info.activeLines,
        maxActiveLines: info.maxActiveLines,
        overThreshold: info.overThreshold,
        // ★★★ 2026-10-11（D59 教训）：**本会话压缩了几次** —— 可查的计数器。
        //   ★ 为什么两个 `status` 出口都要报（这条是自检抓出来的）：
        //     `/ledger status`（聊天命令）与 `ledger_status`（工具）是**两段不同的代码**，
        //     我第一版只改了前者 ⇒ 自检里用工具查的那条当场变红。
        //     这本身就是 D59 的同型错误：**一处改动、两个出口，改了一个就漏一个。**
        //   ★ 用户要能**自己查**（那次是他自己发现的）⇒ 工具这侧也必须带。
        compactionCounts: (() => {
          const sid = exec?.agent?.session?.header?.id;
          if (typeof sid !== "string") return null;
          return compactCountsOf(state, sid) ?? { total: 0, delta: 0, full: 0 };
        })(),
        // ★★★ 两个模式（2026-10-10）：**生效值**与**它是从哪来的**分开报。
        //   只报生效值不够 —— 用户改了清单却发现"没变"，必须能一眼看出是清单没读到、
        //   还是清单里那个值不认识（后者要**说出来**，不许静默退默认）。
        mode: modeOf(info),
        modeSource: (() => {
          const m = info.manifest?.mode;
          if (typeof m === "string" && MODES.includes(m)) return "manifest";
          const s = currentSettings().mode;
          if (typeof m === "string") return "manifest-unknown";
          return MODES.includes(s) ? "setting" : "default";
        })(),
        modeManifestValue: info.manifest?.mode ?? null,
        modeManifestSuspect: modeManifestSuspect(info),
        modeHint: modeManifestSuspect(info)
          ? `清单里的 \`mode\` = ${JSON.stringify(info.manifest?.mode)} **不认识** ⇒ ` +
            `当前按「正常推进」跑。认得的只有：${MODES.join(" / ")}。`
          : null,
        modeLabel: modeOf(info) === MODE_SURGICAL ? "反复追究" : "正常推进",
        git: gitAvailable() ?? null,
        // ★★ 把"压缩服务够不够得着"**报出来**。
        //
        //   为什么必须有这一项：本 profile 里 compaction 挂在 preset 的 `isolate` 组里，
        //   够不着时的表现是**软失败**（不报错、只是永远不压）—— 于是"配好了"与
        //   "根本没工作"从外面看一模一样，这个坑已经埋了两次（裸 ctx.get 一次、
        //   我第一版错修 `agent.ctx.get` 又一次）。⇒ 让它**可观测**，
        //   以后一眼就能看出是哪条路通的。
        compaction: (() => {
          const svc = compactionServiceFor(ctx, exec?.agent);
          if (svc === undefined) {
            return {
              reachable: false,
              via: null,
              hint:
                "取不到 compaction 服务 ⇒ 自动高保真压缩与 /ledger compact 都不会真正执行。" +
                "本 profile 下它挂在 preset 的 isolate 组里，只能经 agentPresets.serviceFor 取到。",
            };
          }
          const via = compactionReachVia(ctx, exec?.agent);
          return { reachable: true, via, hint: null };
        })(),
      };
    },
  };
}

/**
 * 只做加法的"合规修复"。
 *
 * ★★ 安全红线（这是本功能唯一有破坏性的地方，所以规则定死）：
 *    **只补缺失的东西，绝不改写、绝不删除任何已有内容**。
 *    具体：补清单字段、补缺失的**空**决策记录/归档目录。
 *    台账正文一个字都不碰 —— 超阈值那种"要挑条目删"的事**留给 AI**，
 *    因为插件不知道哪些条目已经过时（那是判断，不是流程）。
 *
 * @param {boolean} apply false 时只算不写（dry-run，用于弹卡片前的预览）
 */
function repairConformance(root, opts) {
  const apply = opts?.apply === true;
  const info = inspect(root);
  const conf = conformanceOf(info);
  const actions = [];
  const skipped = [];

  if (apply && conf.verdict === CONFORMANCE.NONE) {
    // 没登记结构的项目，修复=建一套 —— 那是**设计**，得 AI 来做，不是补字段。
    return {
      ok: false,
      reason:
        "这个项目还没有台账结构。补字段式的修复对它没有意义 —— 需要 AI 用 `ledger_init` " +
        "按项目类型**设计**一套，所以请走那条路。",
      conformance: conf,
      hint: "ledger_init",
    };
  }
  if (conf.verdict === CONFORMANCE.OK) {
    return { ok: true, changed: false, conformance: conf, actions: [], note: "本来就合规，无需改动。" };
  }

  const manifestPath = path.join(root, MANIFEST_REL);
  const prev = readManifest(root) ?? {};
  const nextManifest = { ...prev };
  let manifestTouched = false;

  // ① 补 revision（老清单没有它 ⇒ 多会话保护认不出新旧）
  //
  // ★ 只在**清单本来就在**时补：没有清单的项目连结构都没登记，
  //   补一个"孤儿 revision"毫无意义（而且那属于要给 AI 设计结构的情况）。
  if (info.manifest !== undefined && prev.revision === undefined) {
    nextManifest.revision = 0;
    manifestTouched = true;
    actions.push("清单补 `revision: 0`");
  }

  // ② 决策记录：分两种 —— 猜到的（**登记进清单**即可）与完全没有的（建空文件）
  if (info.decisionsRel === undefined) {
    // 连候选名都没猜到 ⇒ 该叫什么是**结构设计**，得 AI 决定，插件不乱起名。
    skipped.push("连候选名都没找到决策记录：它该叫什么需要 AI 决定（结构问题），本次不动");
  } else {
    const abs = path.resolve(root, info.decisionsRel);
    if (!isUnder(root, abs)) {
      skipped.push(`决策记录路径逃出项目根，跳过：${info.decisionsRel}`);
    } else if (fs.existsSync(abs)) {
      // ★ 文件已在（只是清单没登记）⇒ **只登记，一个字都不动**。
      if (info.decisionsSource !== "manifest") {
        nextManifest.decisions = info.decisionsRel;
        manifestTouched = true;
        actions.push(`把已存在的决策记录 \`${info.decisionsRel}\` 登记进清单（不改文件内容）`);
      }
    } else if (apply) {
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, `# 关键决策记录\n\n> 长期决策记在这里，**不参与归档、永久保留**。\n`, "utf8");
      nextManifest.decisions = info.decisionsRel;
      manifestTouched = true;
      actions.push(`新建空的决策记录 \`${info.decisionsRel}\` 并登记进清单`);
    } else {
      actions.push(`将新建空的决策记录 \`${info.decisionsRel}\` 并登记进清单`);
    }
  }

  // ③ 归档目录：同上
  if (info.archiveRel === undefined) {
    skipped.push("连候选名都没找到归档目录：它该叫什么需要 AI 决定（结构问题），本次不动");
  } else {
    const abs = path.resolve(root, info.archiveRel);
    if (!isUnder(root, abs)) {
      skipped.push(`归档目录路径逃出项目根，跳过：${info.archiveRel}`);
    } else if (fs.existsSync(abs)) {
      if (info.archiveSource !== "manifest") {
        nextManifest.archiveDir = info.archiveRel;
        manifestTouched = true;
        actions.push(`把已存在的归档目录 \`${info.archiveRel}\` 登记进清单（不动目录）`);
      }
    } else if (apply) {
      ensureDir(abs);
      nextManifest.archiveDir = info.archiveRel;
      manifestTouched = true;
      actions.push(`新建归档目录 \`${info.archiveRel}\` 并登记进清单`);
    } else {
      actions.push(`将新建归档目录 \`${info.archiveRel}\` 并登记进清单`);
    }
  }

  // ④ 超阈值：**不动**，交给 AI（挑条目是判断）
  if (conf.needsAI.length > 0) {
    for (const n of conf.needsAI) skipped.push(`留给 AI：${n}`);
  }

  let wroteManifest = false;
  if (apply && manifestTouched) {
    const text = JSON.stringify(nextManifest, null, 2) + "\n";
    ensureDir(path.dirname(manifestPath));
    fs.writeFileSync(manifestPath, text, "utf8");
    wroteManifest = true;
  }

  return {
    ok: true,
    applied: apply,
    changed: apply ? actions.length > 0 : false,
    // dry-run 时 `actions` 是"将会做什么"，便于先给用户看再决定。
    actions,
    skipped,
    wroteManifest,
    conformance: conf,
    ...(apply
      ? {}
      : { note: "这是**预览**（没有写任何东西）。要真正执行请传 `apply: true`。" }),
  };
}

/** ② ledger_init —— 登记 AI 设计的结构 + Git 初始化。 */
function defineInitTool() {
  return {
    name: "ledger_init",
    description:
      "Register the ledger structure YOU designed for this project, and optionally initialize " +
      "Git. This does not impose any template: you choose the file names, how many files there " +
      "are, and what fields they hold. It writes the pointer manifest, runs `git init` when " +
      "asked, merges (never overwrites) .gitignore, and can write your initial file contents. " +
      "The structure must satisfy: one active ledger, one separate long-lived decisions record, " +
      "and one append-only archive directory.",
    parameters: {
      type: "object",
      properties: {
        active: {
          type: "string",
          description: "Relative path of the ACTIVE ledger file you designed, e.g. \"LEDGER.md\".",
        },
        decisions: {
          type: "string",
          description: "Relative path of the long-lived decisions record, e.g. \"DECISIONS.md\".",
        },
        archiveDir: {
          type: "string",
          description:
            "Relative path of the append-only archive directory, e.g. \"_ledger-archive\".",
        },
        maxActiveLines: {
          type: "number",
          description: "Active-ledger line budget before archiving is required. Default 150.",
        },
        initialActive: {
          type: "string",
          description:
            "Optional initial content for the active ledger. Written only if it does not already exist.",
        },
        initialDecisions: {
          type: "string",
          description:
            "Optional initial content for the decisions record. Written only if it does not already exist.",
        },
        gitInit: {
          type: "boolean",
          description: "Run `git init` if the project is not already a repository. Default true.",
        },
        gitignore: {
          type: "boolean",
          description: "Create/merge .gitignore. Default true.",
        },
        gitignoreLines: {
          type: "array",
          items: { type: "string" },
          description: "Extra lines to ensure are present in .gitignore.",
        },
        autoGitAdd: {
          type: "boolean",
          description:
            "Stage ledger files with `git add -- <paths>` after each ledger write. Default true.",
        },
        archiveWeekMode: {
          type: "string",
          enum: ["month", "year"],
          description:
            "Whether the weekN segment of YYYY-MM/weekN means week-of-month (default) or week-of-year.",
        },
        allowContainer: {
          type: "boolean",
          description:
            "Set true to initialize a ledger in a CONTAINER workspace (a directory that is not " +
            "itself a repo but holds sub-projects, e.g. one with AGENTS.md or nested .git dirs). " +
            "Refused by default, because `git init` there would swallow every sub-project into one " +
            "wrong parent repo. Prefer switching the session's working directory to the sub-project.",
        },
        root: ROOT_PARAM,
        logDir: {
          type: "string",
          description:
            "Optional relative path for the ACTIVITY LOG directory, e.g. \"_ledger-log\". Omit to " +
            "leave the log disabled (nothing is ever written into the project uninvited). Once set, " +
            "the log is collected automatically from the official session event stream — milestones, " +
            "file flow, and optionally tool flow — bucketed weekly under the SAME period key as the " +
            "archive, so one query spans both. It is never injected into context.",
        },
        logLevels: {
          type: "object",
          description:
            "Which log levels to collect. L0 milestones, L1 turn summaries (written by you via " +
            "ledger_log_write), L2 file flow, L3 tool flow. Default {L0:true,L1:true,L2:true,L3:false}: " +
            "L3 is off because it grows linearly with tool calls (~31 KB per 490 calls measured).",
          properties: {
            L0: { type: "boolean" },
            L1: { type: "boolean" },
            L2: { type: "boolean" },
            L3: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      required: ["active", "decisions", "archiveDir"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec, args);

      const active = typeof args?.active === "string" ? args.active.trim() : "";
      const decisions = typeof args?.decisions === "string" ? args.decisions.trim() : "";
      const archiveDir = typeof args?.archiveDir === "string" ? args.archiveDir.trim() : "";
      const logDir = typeof args?.logDir === "string" ? args.logDir.trim() : "";
      for (const [label, value] of [
        ["active", active],
        ["decisions", decisions],
        ["archiveDir", archiveDir],
      ]) {
        if (value === "") throw fail(`ledger_init: '${label}' 必须是非空字符串`);
        if (path.isAbsolute(value)) throw fail(`ledger_init: '${label}' 必须是相对路径：${value}`);
        const abs = path.resolve(root, value);
        if (!isUnder(root, abs)) throw fail(`ledger_init: '${label}' 逃出了项目根：${value}`);
      }
      if (active === decisions) {
        throw fail("ledger_init: 活跃台账与决策记录必须是两个不同的文件（需求硬约束）。");
      }
      // logDir 是**可选**的：给了才校验。
      if (logDir !== "") {
        if (path.isAbsolute(logDir)) throw fail(`ledger_init: 'logDir' 必须是相对路径：${logDir}`);
        const logAbsCheck = path.resolve(root, logDir);
        if (!isUnder(root, logAbsCheck)) throw fail(`ledger_init: 'logDir' 逃出了项目根：${logDir}`);
        // 日志目录不能与归档目录互相包含：两者都按 YYYY-MM/weekN 分桶，
        // 嵌套会让"读某一周"同时命中两种东西，回溯结果无法解释。
        const archAbs = path.resolve(root, archiveDir);
        if (isUnder(archAbs, logAbsCheck) || isUnder(logAbsCheck, archAbs)) {
          throw fail("ledger_init: 日志目录与归档目录不能互相包含（两者都按周分桶，嵌套会混淆）。");
        }
      }

      // 三者互不重叠：归档目录不能是某个文件的路径，文件也不能塞进归档目录里。
      const activeAbs = path.resolve(root, active);
      const decisionsAbs = path.resolve(root, decisions);
      const archiveAbs = path.resolve(root, archiveDir);
      if (isUnder(archiveAbs, activeAbs) || isUnder(archiveAbs, decisionsAbs)) {
        throw fail("ledger_init: 活跃台账/决策记录不能位于归档目录之内（归档只追加，会互相干扰）。");
      }

      // ★ 这是 `ledger_init` **登记新项目**时的默认上限 ⇒ 正是插件级设置该管的地方
      //   （设置面板改的就是"新项目登记成多少"）。已有项目走清单，不受影响。
      const maxActiveLines =
        Number.isFinite(args?.maxActiveLines) && args.maxActiveLines > 0
          ? Math.floor(args.maxActiveLines)
          : currentSettings().maxActiveLines;

      const notes = [];

      // ── ★ 容器工作区闸门 ─────────────────────────────────────────────────
      //
      // 这里**不是**新项目，而是装着许多项目的总工作区（自己没 .git，子目录里有）。
      // 在此 `git init` 会把全部子项目卷进一个错误的父仓库 —— 那是最难收拾的误操作，
      // 所以宁可拒绝，并明确告诉调用者正确的做法。
      // （`allowContainer: true` 是给"我确实知道自己在干什么"的显式逃生口。）
      if (args?.allowContainer !== true) {
        const probe = inspect(root);
        const containerWhy =
          probe.containerMarker !== undefined
            ? `本目录有工作区标志文件 \`${probe.containerMarker}\``
            : probe.nestedRepo !== undefined
              ? `本目录的子目录里有 Git 仓库（如 \`${probe.nestedRepo}\`）`
              : undefined;
        if (containerWhy !== undefined && !probe.isGitRepo) {
          throw fail(
            `ledger_init: 拒绝在容器工作区里初始化 —— ${containerWhy}。\n` +
              "这个目录是装着多个项目的总工作区，不是一个新项目；在此 `git init` 会把" +
              "下面所有子项目卷进一个错误的父仓库。\n" +
              "正确做法：把会话工作目录切到你要管理的那个**子项目**里，再在那里 `/ledger init`。\n" +
              "若你确实要在这个容器里建台账（例如给整个工作区做一份总台账），" +
              "请显式传 `allowContainer: true`，并考虑传 `gitInit: false`。"
          );
        }
      }

      // ── Git init ─────────────────────────────────────────────────────────
      let gitInitDone = false;
      if (args?.gitInit !== false) {
        if (fs.existsSync(path.join(root, ".git"))) {
          notes.push("已经是 Git 仓库，跳过 git init。");
        } else {
          const r = git(root, ["init"]);
          if (r.ok) {
            gitInitDone = true;
            notes.push("已执行 git init。");
          } else {
            notes.push(`git init 失败（不影响台账本身）：${r.stderr || r.error || "未知原因"}`);
          }
        }
      }

      // ── .gitignore（合并式，绝不覆盖）────────────────────────────────────
      let ignoreResult;
      if (args?.gitignore !== false) {
        const extra = Array.isArray(args?.gitignoreLines)
          ? args.gitignoreLines.filter((l) => typeof l === "string")
          : [];
        ignoreResult = mergeGitignore(root, [...DEFAULT_IGNORE_LINES, ...extra]);
      }

      // ── 初始内容（只在文件不存在时写，绝不覆盖用户的活文件）──────────────
      const written = [];
      if (typeof args?.initialActive === "string" && args.initialActive !== "") {
        if (fs.existsSync(activeAbs)) {
          notes.push(`活跃台账 ${active} 已存在，未覆盖。`);
        } else {
          ensureDir(path.dirname(activeAbs));
          fs.writeFileSync(activeAbs, args.initialActive, "utf8");
          written.push(active);
        }
      }
      if (typeof args?.initialDecisions === "string" && args.initialDecisions !== "") {
        if (fs.existsSync(decisionsAbs)) {
          notes.push(`决策记录 ${decisions} 已存在，未覆盖。`);
        } else {
          ensureDir(path.dirname(decisionsAbs));
          fs.writeFileSync(decisionsAbs, args.initialDecisions, "utf8");
          written.push(decisions);
        }
      }
      ensureDir(archiveAbs);
      // ★ 日志目录只在**明确要了**的时候才建 —— 没传 logDir 就不往项目里塞任何东西。
      if (logDir !== "") ensureDir(path.resolve(root, logDir));

      // ── 指针清单 ─────────────────────────────────────────────────────────
      const prev = readManifest(root) ?? {};
      const now = new Date();
      // ★★★ A3 修复（2026-10-11，审计 002/003 坐实后先写会红用例再改）：
      //   **先铺开旧清单**，再覆盖这次明确要写的字段。
      //   原实现是**从零构造一个固定字段对象** ⇒ `mode`（压缩模式！）、`handoffDir`、
      //   `notesDir` 以及**任何未知扩展字段**都被静默丢弃。
      //   那不是"重新登记"，那是"把别人的配置抹掉" —— 用户重跑一次 `ledger_init`
      //   就会丢掉压缩模式，而且**没有任何提示**。
      const hadPrevManifest = Object.keys(prev).length > 0;
      const manifest = {
        ...prev,
        version: 1,
        active,
        decisions,
        archiveDir,
        maxActiveLines,
        // ★ 变更登记条数：与 maxActiveLines 同类（**按项目**）。
        //   ★ 这次没显式传就用**插件级设置**的值 ⇒ 设置面板那一项就是
        //     "新项目登记成几条"；已登记的项目保留自己清单里的值（不清零、不覆盖）。
        changeRegisterMax:
          Number.isFinite(args?.changeRegisterMax) && args.changeRegisterMax > 0
            ? Math.floor(args.changeRegisterMax)
            : (Number.isFinite(prev.changeRegisterMax) && prev.changeRegisterMax > 0
                ? Math.floor(prev.changeRegisterMax)
                : currentSettings().changeRegisterMax),
        autoGitAdd: args?.autoGitAdd !== false,
        archiveWeekMode: args?.archiveWeekMode === "year" ? "year" : "month",
        createdAt: typeof prev.createdAt === "string" ? prev.createdAt : stamp(now),
        updatedAt: stamp(now),
      };
      // 日志是可选的：只在登记了目录时写这两个字段。
      // ★ 没显式传 `logLevels` 时用**插件级设置的档位** ⇒ 设置面板的 L0–L4 开关
      //   就是"新项目登记成什么档位"。已登记的项目保留自己清单里的值。
      if (logDir !== "") {
        manifest.logDir = logDir;
        manifest.logLevels = parseLevels(args?.logLevels, defaultLogLevels());
      } else if (typeof prev.logDir === "string" && prev.logDir !== "") {
        // ★ 这次没传 logDir，但上次登记过 ⇒ **保留**，别把它悄悄关掉。
        manifest.logDir = prev.logDir;
        manifest.logLevels = parseLevels(args?.logLevels ?? prev.logLevels, defaultLogLevels());
      }
      // ★ 修订号：首次登记立 0；**重复登记必须递增**。
      //   A3 的原实现无条件 `= manifestRevision(prev)` ⇒ 重复 init 后版本号**原地不动**，
      //   而 init 可能改掉 active 指向（内容语义变了）⇒ 别的会话手里那个旧号
      //   看起来仍"最新"，它整份 replace 时就不会触发自动保留 ⇒ 丢条目。
      //   修订号的语义是"台账内容变过一次就 +1"（见 `bumpRevision`），init 满足该条件。
      manifest.revision = hadPrevManifest ? manifestRevision(prev) + 1 : 0;
      fs.writeFileSync(path.join(root, MANIFEST_REL), JSON.stringify(manifest, null, 2) + "\n", "utf8");

      // ── 纳入 Git 追踪（只 add 明确路径，绝不 -A）──────────────────────────
      let staged;
      if (manifest.autoGitAdd && fs.existsSync(path.join(root, ".git"))) {
        const r = gitAdd(root, [
          MANIFEST_REL,
          active,
          decisions,
          ...(ignoreResult?.created ? [".gitignore"] : []),
        ]);
        staged = r.ok ? true : r.stderr || r.error || "git add 失败";
      }

      return {
        ok: true,
        projectRoot: root,
        structure: { active, decisions, archiveDir, maxActiveLines },
        manifestPath: path.join(root, MANIFEST_REL),
        gitInit: gitInitDone,
        gitignore: ignoreResult,
        wroteInitial: written,
        ...(staged === undefined ? {} : { staged }),
        notes,
      };
    },
  };
}

/**
 * ⑩ ledger_conform —— 检测已有项目的台账**是否符合本插件的计划**，并可只做加法地修。
 *
 * ★ 用户需求：「允许对已经存在的项目进行台账重构……检测到这个工作区的台账不是我们
 *   计划中这样的话就弹一个选择，是否进行这样的改造」。
 *
 * ★ 为什么拆成"检测 / 预览 / 执行"三步而不是一步改完：
 *   改动别人的项目必须**先给用户看清要动什么**。所以默认 `apply: false`（纯预览），
 *   要真改得显式传 `apply: true`。
 */
function defineConformTool() {
  return {
    name: "ledger_conform",
    description:
      "Check whether an EXISTING project's ledger matches what this plugin expects, and repair " +
      "the parts that can be repaired safely. \"Safe\" means ADDITIVE ONLY: it adds missing " +
      "manifest fields and creates missing EMPTY files/dirs — it never rewrites or deletes " +
      "existing content. Things that need judgement (the ledger being over its line budget, or a " +
      "project with no ledger at all) are reported for you to do with ledger_archive / " +
      "ledger_init. Defaults to a DRY RUN: pass apply:true to actually write. Use this when the " +
      "user has a pre-existing project and you are unsure whether its ledger fits.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        apply: {
          type: "boolean",
          description:
            "Default false = dry run, reporting what WOULD change and writing nothing. Set true " +
            "to perform the additive repairs.",
        },
      },
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      return repairConformance(rootFromExec(exec, args), { apply: args?.apply === true });
    },
  };
}

/** ③ ledger_read —— 读活跃台账 / 决策记录 / 归档。 */
function defineReadTool() {
  return {
    name: "ledger_read",
    description:
      "Read a project ledger file. target \"active\" reads the active ledger, \"decisions\" the " +
      "long-lived decisions record, \"manifest\" the pointer manifest, and \"archive\" lists the " +
      "archive directory (or reads one archive file when archiveFile is given). Read-only.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        target: {
          type: "string",
          enum: ["active", "decisions", "manifest", "archive"],
          description: "Which part of the ledger to read.",
        },
        archiveFile: {
          type: "string",
          description:
            "With target \"archive\": relative path of one archive file to read instead of listing.",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec, args);
      const info = inspect(root);
      const target = String(args?.target ?? "active");

      if (target === "manifest") {
        const raw = readTextSafe(info.manifestPath);
        return { ok: true, target, path: info.manifestPath, found: raw !== undefined, text: raw ?? null };
      }
      if (target === "archive") {
        if (info.archiveRel === undefined) {
          return { ok: true, target, found: false, reason: "no archive directory registered" };
        }
        const dir = path.resolve(root, info.archiveRel);
        if (!isUnder(root, dir)) throw fail("ledger_read: 归档目录逃出了项目根");

        // ★ D138：两个可调上限（读长 + 列表条数）—— 面板改了必须真生效。
        const arcMax = numOf("maxReadChars", MAX_READ_CHARS);
        const arcListMax = numOf("maxArchiveList", MAX_ARCHIVE_LIST);

        const rel = typeof args?.archiveFile === "string" ? args.archiveFile.trim() : "";
        if (rel !== "") {
          const file = path.resolve(root, rel);
          if (!isUnder(root, file)) throw fail(`ledger_read: 归档文件逃出了项目根：${rel}`);
          const raw = readTextSafe(file);
          if (raw === undefined) return { ok: true, target, found: false, path: file };
          return {
            ok: true,
            target,
            found: true,
            path: file,
            lines: countLines(raw),
            text: raw.length > arcMax ? raw.slice(0, arcMax) : raw,
            truncated: raw.length > arcMax,
          };
        }

        const files = [];
        const walk = (d, depth) => {
          if (files.length >= arcListMax || depth > 4) return;
          let entries;
          try {
            entries = fs.readdirSync(d, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            if (files.length >= arcListMax) return;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p, depth + 1);
            else {
              let bytes = 0;
              try {
                bytes = fs.statSync(p).size;
              } catch {
                /* 拿不到就是 0 */
              }
              files.push({ path: toGitRel(root, p), bytes });
            }
          }
        };
        walk(dir, 0);
        return { ok: true, target, found: true, archiveDir: info.archiveRel, count: files.length, files };
      }

      const relPath = target === "decisions" ? info.decisionsRel : info.activeRel;
      if (relPath === undefined) {
        return { ok: true, target, found: false, reason: "no such ledger file is registered" };
      }
      const abs = path.resolve(root, relPath);
      if (!isUnder(root, abs)) throw fail("ledger_read: 目标逃出了项目根");
      const fileMax = numOf("maxReadChars", MAX_READ_CHARS);
      const raw = readTextSafe(abs);
      if (raw === undefined) return { ok: true, target, found: false, path: abs };
      return {
        ok: true,
        target,
        found: true,
        path: abs,
        relative: relPath,
        lines: countLines(raw),
        chars: raw.length,
        text: raw.length > fileMax ? raw.slice(0, fileMax) : raw,
        truncated: raw.length > fileMax,
        // ★ 多会话用：把当前修订号一起给出去，写台账时当 `ifRevision` 传回来，
        //   插件就能判断"你手里这份是不是最新的"，从而决定要不要替你保住别人的条目。
        revision: manifestRevision(info.manifest),
      };
    },
  };
}

/** ④ ledger_write —— 写活跃台账 / 决策记录。 */
function defineWriteTool(state) {
  return {
    name: "ledger_write",
    description:
      "Write the active ledger or the decisions record. target \"active\" replaces or appends the " +
      "active ledger (refused when it would exceed the line budget unless force is true — archive " +
      "old entries first). target \"decisions\" appends a long-lived decision and is never " +
      "archived. The content format is entirely yours: this plugin stores what you write. " +
      "Staged with `git add -- <path>` when autoGitAdd is on.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        target: {
          type: "string",
          enum: ["active", "decisions"],
          description: "Which ledger file to write.",
        },
        content: { type: "string", description: "The content to write." },
        mode: {
          type: "string",
          enum: ["replace", "append"],
          description: "Replace the whole file, or append (separated by a blank line). Default replace.",
        },
        force: {
          type: "boolean",
          description:
            "Write the active ledger even when it exceeds the line budget. Use only when the " +
            "overflow is deliberate.",
        },
        createIfMissing: {
          type: "boolean",
          description: "Create the file when it does not exist. Default true.",
        },
        ifRevision: {
          type: "number",
          description:
            "The ledger revision you are writing FROM (get it from `ledger_read` or " +
            "`ledger_status`). ★ On a project worked on by SEVERAL sessions, pass this: if the " +
            "ledger moved on since you read it, entries you never saw are AUTOMATICALLY preserved " +
            "in an \"其他会话的进展\" section instead of being silently overwritten — your write " +
            "still succeeds, no retry needed. If you are deliberately condensing/trimming the " +
            "ledger, pass the current revision (or omit this) so your deletions are respected.",
        },
      },
      required: ["target", "content"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const r = writeLedger(rootFromExec(exec, args), args, exec);
      // ★ 记回执：工具返回值只发给 AI，用户看不到"台账被改过"。
      //   攒起来，等下一次真正弹卡片时带给用户（见 noteLedgerTouched 的说明）。
      if (r.ok === true) noteLedgerTouched(state, exec, r);
      return r;
    },
  };
}

/**
 * ledger_write 的实现（工具与 /ledger 命令共用，避免两处分叉）。
 *
 * @param {object} exec 可选：有则用来取**会话编号**，把"这条是哪个会话写的"标进内容，
 *   并往活动日志记一条"谁改过台账"的审计行（用户提议：改动台账时说明是哪个对话改的）。
 */
function writeLedger(root, args, exec) {
  const info = inspect(root);
  const target = String(args?.target ?? "active");
  // ★★★ 2026-10-11 修 A1（审计员 001/002 指出，**自检盲区**）：
  //   **决策记录默认 append**，只有显式 `mode:"replace"` 才允许整份覆盖。
  //   ★ 病灶：原来一律 `args?.mode === "append" ? "append" : "replace"` ——
  //     于是常规调用 `ledger_write({target:"decisions", content})`（**不传 mode**）
  //     会**静默抹掉全部历史决策**，而工具描述却称它
  //     "appends a long-lived decision and is **never** archived" ⇒ 实现与承诺**直接冲突**。
  //     ★ 这是本项目**唯一**的长期记忆（D30–D60 全在里面），一次默认调用就能清空。
  //   ★ 修法（选了"按 target 定默认"，不是"全局改默认"）：
  //     · `target:"decisions"` ⇒ 默认 **append**（它的语义就是只追加）；
  //     · `target:"active"`    ⇒ 保持默认 **replace**（AI 有意精简台账是正常操作，
  //       而且它有 `ifRevision` 的多会话保留兜底，见 L6771）。
  //     ⇒ 这样既堵住"静默清空决策"，又不改变活跃台账的既有语义（零迁移负担）。
  //   ★ 仍留**显式出口**：`mode:"replace"` 照样能整份重写决策记录（有意为之的操作）。
  //     自检 39 组同时钉住这两面：默认必须保住旧的、显式 replace 必须能覆盖。
  const explicitMode = args?.mode === "append" ? "append" : args?.mode === "replace" ? "replace" : undefined;
  const mode = explicitMode ?? (target === "decisions" ? "append" : "replace");
  const content = typeof args?.content === "string" ? args.content : "";
  const createIfMissing = args?.createIfMissing !== false;
  const tag = sessionTag(exec?.agent);

  const relPath = target === "decisions" ? info.decisionsRel : info.activeRel;
  if (relPath === undefined) {
    return {
      ok: false,
      reason:
        "这个项目还没有登记台账结构。请先调用 ledger_init（或让用户执行 /ledger init）。",
      hint: "ledger_init",
    };
  }

  const abs = path.resolve(root, relPath);
  if (!isUnder(root, abs)) throw fail("ledger_write: 目标逃出了项目根");

  const existing = readTextSafe(abs);
  if (existing === undefined && !createIfMissing) {
    return { ok: false, reason: `文件不存在且 createIfMissing 为假：${relPath}` };
  }

  let next;
  if (mode === "append") {
    // ★★ `append` 必须**追加到正文末尾**，不能追加到文件末尾 ────────────────
    //   插件自己维护的「变更登记」区就在文件末尾，而 `withChangeRegister` 会
    //   从标题处把后面整段切掉重建 ⇒ 若把新内容接在文件最末，它会被**静默丢掉**：
    //   写入报 ok、行数也对，但那几行内容凭空消失（2026-10-09 自测 20e 打红才发现）。
    //   ⇒ 先剥掉登记区，往正文上追加，登记区最后由 `withChangeRegister` 重建。
    const base = splitChangeRegister(existing ?? "").body;
    if (base === "") next = content;
    else next = (base.endsWith("\n") ? base : base + "\n") + (content === "" ? "" : "\n" + content);
  } else {
    next = content;
  }

  // ── ★★ 多会话同项目：**不挡，但也不丢** ──────────────────────────────────
  //
  // 实测的丢法（2026-10-08，**全程无并发**）：两个会话各自在开头读了一份台账，
  // A 先写、B 后写；B 用的是它自己看过的**旧副本**整份 replace ⇒
  // **A 的进展彻底消失，两边都不报错**。
  //
  // ★ 为什么**不做**"版本不一致就拒绝"：用户指出得对 ——
  //   那样 AI 每次撞上都得重读、重新合并、再写，还可能再撞一次，
  //   把"并发问题"变成了"AI 的工作量"。挡住的写还要人来善后，代价更高。
  //
  // ★ 改成：**插件自己判断会丢什么，替双方保住**。
  //   ① 找出"现在文件里有、而这次新内容里没有"的条目；
  //   ② 但**只保那些"你不可能见过"的**（见下面的 ifRevision 判据）；
  //   ③ 附加到保留区（带原编号，看得出是谁写的），并如实报告。
  //   这样 A 的条目还在、B 的写入也成功，**两边都不需要重试**。
  //
  // ★★ 关键：**不能见条目就保**。否则"AI 有意精简台账"（把 5 条合并成 1 条、
  //    删掉过时条目）会被插件当成"丢了 4 条"再塞回去 —— 那是**跟用户对着干**，
  //    而且实测立刻把 `行数统计` 这类正常用例打红。
  //
  //    所以判据是**写的人有没有声明"我基于哪个版本"**：
  //      · 传了 `ifRevision` 且**等于**当前 revision ⇒ 它看过最新内容，**它有权删**，不保；
  //      · 传了且**不等于** ⇒ 它基于别的版本写的，确实没见过这些条目 ⇒ **保**；
  //      · **没传** ⇒ 未声明，默认**不保**（保持原语义：你写什么就是什么 ——
  //        AI 有意的精简不该被插件推翻）。
  //
  //    ⇒ 多会话场景由**注入文案**引导 AI 带上 `ifRevision`（它每次会话都读到当前版本号），
  //      这样既保住"没见过的条目"，又不干扰"有意的精简"。
  let preserved = [];
  const declaredRev = args?.ifRevision;
  const currentRev = manifestRevision(info.manifest);
  const declaredStale = Number.isFinite(declaredRev) && Math.floor(declaredRev) !== currentRev;
  if (target === "active" && mode === "replace" && existing !== undefined && existing !== next && declaredStale) {
    const lost = lostEntries(existing, next);
    if (lost.length > 0) {
      preserved = lost;
      // 保留区若已存在，把它原有内容一并带上（别二次丢失）。
      const existingBlock = existing.includes(PRESERVE_HEADING)
        ? existing.slice(existing.indexOf(PRESERVE_HEADING))
        : "";
      const block =
        `\n\n${PRESERVE_HEADING}\n\n` +
        `> 下面是**别的会话**写进台账、而这次重写没包含的条目。插件自动留在这里，` +
        `合并进正文后可以整段删掉。行首的 \`[xxxx]\` 是写入者的会话编号。\n\n` +
        preserved.join("\n") +
        "\n";
      next = next.replace(/\s+$/, "") + "\n" + (existingBlock === "" ? "" : `\n${existingBlock}\n`) + block;
    }
  }

  // ── ★ 需求 ①：把"这次是什么时候改的"写进台账**本身** ──────────────────
  //
  // ★ 顺序要点：必须**在行数闸门之前**合并登记区 —— 登记表本身占行数，
  //   闸门必须看到**最终**结果（这与"自动保留区"的处理同理）。
  // ★ 只对**活跃台账**做：决策记录是 append-only 的长期档案，给它塞一张
  //   "变更登记"会污染它"只追加"的语义。
  // ★ `delta` / `lines` 记的是**正文**行数（不含登记区自身）：登记区是插件加的
  //   附注，把它算进"这次改动了多少行"会让每次写入都恒定 +14 行，读数就没意义了。
  //   闸门用的 `finalLines` 才是含登记区的最终值。
  const beforeLines = bodyLineCount(existing ?? "");
  const bodyLines = countLines(next);
  if (target === "active") {
    const line = changeRegisterLine(new Date(), {
      mode,
      tag,
      delta: bodyLines - beforeLines,
      lines: bodyLines,
      revision: manifestRevision(info.manifest) + 1,
    });
    next = withChangeRegister(next, line, existing, changeRegisterMaxOf(info));
  }

  // 活跃台账的行数闸门（需求 ⑤：超阈值必须先归档）。
  // ★ 放在"自动保留"与"变更登记"之后算：两者都会让行数变多，
  //   闸门必须看到最终结果。
  const finalLines = countLines(next);
  if (target === "active" && finalLines > info.maxActiveLines && args?.force !== true) {
    return {
      ok: false,
      reason:
        `活跃台账将变成 ${finalLines} 行，超过上限 ${info.maxActiveLines} 行。` +
        "请先用 ledger_archive 把最旧的已完成条目移进归档，再写精简版；" +
        "确实要超就传 force: true。",
      lines: finalLines,
      maxActiveLines: info.maxActiveLines,
      ...(preserved.length === 0 ? {} : { preservedEntries: preserved.length }),
      hint: "ledger_archive",
    };
  }

  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, next, "utf8");

  // ★★★★ 2026-10-12（D136）**记区块变更史** —— 「权重可变」的唯一驱动源。
  //
  //   ★ 为什么必须在这里（写成功之后、落盘之后）：
  //     `mechanicalWeight` 的时间维与稳定维都要问"这块多久没变"，
  //     那是**块与块的相对序**（用户：*"定位主要是相对位置"*），
  //     只能由**历次落盘**累积出来 ⇒ 不在这里记，它就永远是缺值
  //     （★ 我上一版正是如此：函数写好了但**没有调用点** ⇒ 时间维恒缺 ⇒ "可变"是空话）。
  //
  //   ★ 为什么**吞错**：变更史是**权重**的输入，不是台账的真相。
  //     记不住 ⇒ 退化成"该块没有历史 ⇒ 那两维跳过"，**不影响准确性**（底线规则③）。
  //     反过来，若为了记它而让一次成功的写入报失败，那才是真事故。
  if (target === "active") {
    try {
      recordBlockHistory(root, next, Date.now());
    } catch {
      /* 变更史记不住不影响台账本身 */
    }
  }

  // 修订号 +1：下一次别的会话若还拿着旧版本号，就会被上面的闸门拦下。
  const newRevision = bumpRevision(root);
  const lines2 = finalLines;

  // ── 审计：往活动日志记一条"谁改过台账"（用户提议）──────────────────────
  //
  // ★ 为什么记在**活动日志**而不是台账里：台账是"当前状态"，会被替换、会被归档；
  //   而"谁在什么时候改过它"是**历史**，只该进只追加的日志。
  //   这也正是"台账丢了条目还能追回来"的依据 —— 见 `ledger_log` 的 audit 视图。
  let auditLine;
  if (info.logRel !== undefined) {
    try {
      auditLine = appendAudit(root, info, {
        tag,
        target,
        mode,
        relPath,
        lines: lines2,
        revision: newRevision,
        sessionId: exec?.agent?.session?.header?.id,
      });
    } catch {
      // 审计失败绝不影响台账写入本身。
      auditLine = undefined;
    }
  }

  let staged;
  if (info.manifest?.autoGitAdd !== false && fs.existsSync(path.join(root, ".git"))) {
    const r = gitAdd(root, [relPath]);
    staged = r.ok ? true : r.stderr || r.error || "git add 失败";
  }

  return {
    ok: true,
    target,
    mode,
    path: abs,
    relative: relPath,
    // ★ `lines` 是**落盘后的真实行数**（含插件加的变更登记区）—— 调用者拿它跟
    //   `maxActiveLines` 比才有意义，闸门也是照这个数判的。
    //   另给 `bodyLines`（不含登记区），这样"这次正文有多长"不被附注干扰。
    lines: finalLines,
    // ★ `changedBy` 是**正文**的增减（登记区不参与计量），见 `bodyLineCount` 的注释。
    changedBy: target === "active" ? bodyLines - beforeLines : bodyLines,
    chars: next.length,
    // ★ 会话编号：告诉调用者"这条被标成了谁的"。
    ...(tag === undefined ? {} : { sessionTag: tag }),
    ...(newRevision === undefined ? {} : { revision: newRevision }),
    // ★ 如实报告"替谁保住了什么"。AI 看到这个就知道：不用重读重写，
    //   但**下次合并时应该把保留区并进正文**（否则它会被再保一次、越堆越长）。
    ...(preserved.length === 0
      ? {}
      : {
          preservedEntries: preserved.length,
          preservedNote:
            `本次重写没包含 ${preserved.length} 条**别的会话**写的条目，插件已自动保留在 ` +
            `「${PRESERVE_HEADING}」小节里（带它们的会话编号）。**你不需要重写** —— ` +
            "但下次维护这份台账时，请把保留区的内容合并进正文，并删掉那个小节。",
        }),
    overThreshold: target === "active" && finalLines > info.maxActiveLines,
    // ★ `staged` **只在真的 stage 过时才出现**。不能直接写 `staged`（值可能是 undefined）——
    //   内核校验工具返回值必须是 **lossless JSON**，`undefined` 会让整个调用被判失败，
    //   而写入其实已经落盘（2026-10-08 实测撞到，写日志那条路先报了这个错）。
    ...(staged === undefined ? {} : { staged }),
  };
}

/** ⑤ ledger_archive —— 把旧条目移进归档（只追加、不删除）。 */
function defineArchiveTool(state) {
  return {
    name: "ledger_archive",
    description:
      "Move entries out of the active ledger into the append-only archive, under " +
      "`<archiveDir>/YYYY-MM/weekN`. YOU choose which entries to archive and supply both the " +
      "text being archived and the trimmed active ledger. Existing archive files are never " +
      "rewritten: the entries are appended to the current period's file, so history is kept. " +
      "★ Pass `ifRevision` (the revision you read) to guard against another session writing " +
      "meanwhile — if it no longer matches, nothing is written and you are asked to re-read. " +
      "Nothing at all is written when the call fails for any reason, so it is safe to retry; " +
      "re-sending the same `entries` is recognised and will not duplicate them.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        entries: { type: "string", description: "The exact text to append to the archive." },
        newActive: {
          type: "string",
          description:
            "The full new content of the active ledger, with the archived entries removed.",
        },
        label: {
          type: "string",
          description: "Optional short label for this archive batch, written as a heading.",
        },
        ifRevision: {
          type: "number",
          description:
            "The revision you read the active ledger at (from ledger_read/ledger_status). " +
            "If it no longer matches the manifest's revision, the call is refused and " +
            "NOTHING is written.",
        },
        force: {
          type: "boolean",
          description:
            "Only to override the maxActiveLines gate after confirming the result is intended.",
        },
      },
      required: ["entries", "newActive"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const r = archiveLedger(rootFromExec(exec, args), args, exec);
      // ★ 归档同样改了台账文件（活跃台账被精简）⇒ 也要回执。
      if (r.ok === true) noteLedgerTouched(state, exec, r);
      return r;
    },
  };
}

/** ledger_archive 的实现（工具与命令共用）。 */
function archiveLedger(root, args, exec) {
  const info = inspect(root);
  if (info.activeRel === undefined || info.archiveRel === undefined) {
    return { ok: false, reason: "这个项目还没有登记台账结构，先 ledger_init。", hint: "ledger_init" };
  }
  const entries = typeof args?.entries === "string" ? args.entries : "";
  const newActive = typeof args?.newActive === "string" ? args.newActive : "";
  if (entries.trim() === "") {
    return { ok: false, reason: "entries 为空 —— 没有东西要归档。" };
  }

  const archiveAbs = path.resolve(root, info.archiveRel);
  const activeAbs = path.resolve(root, info.activeRel);
  if (!isUnder(root, archiveAbs)) throw fail("ledger_archive: 归档目录逃出了项目根");
  if (!isUnder(root, activeAbs)) throw fail("ledger_archive: 活跃台账逃出了项目根");

  const now = new Date();
  const { dir, label: periodLabel } = archiveStamp(now, info.manifest?.archiveWeekMode);
  const periodDir = path.join(archiveAbs, dir);

  const stem = path.basename(info.activeRel, path.extname(info.activeRel)) || "ledger";
  const archiveFile = path.join(periodDir, `${stem}-archive.md`);

  // ══ ★★★ A2 修复（2026-10-11，审计 002/003 坐实后先写会红用例再改）════════
  //   原实现**先写归档、后判行数超限** ⇒ 那条失败路径**已经把归档写下去了**。
  //   而归档是**只追加**的：调用方见失败就重发 ⇒ 同一批被追加两次，
  //   **永久污染**归档（它是"历史"，越改越不像原件）。
  //   ⇒ 现在的顺序：**先把所有会失败的事判完，一个字节都不写**；再落盘。
  //     这就是"原子性"在这里的实际含义。

  // ── ① `ifRevision` 陈旧保护（A2 的另一半）────────────────────────────────
  //   ★ 与 `ledger_write` 的取舍**故意不同**：write 那条路是"**保留**没见过的条目"
  //     （D17「不挡，但也不丢」）；归档这条路**只能拒绝**。
  //     理由：归档的 `newActive` 是**有意精简**的结果，"旧台账里有、新台账里没有的条目"
  //     既可能是**正要归档**的、也可能是**别的会话新加的** —— 两者在文本上**无法区分**。
  //     猜错了就是把别人刚写的东西当废料丢进归档。⇒ 宁可拒绝，让它重读一次。
  const declaredRev = args?.ifRevision;
  const currentRev = manifestRevision(info.manifest);
  if (Number.isFinite(declaredRev) && Math.floor(declaredRev) !== currentRev) {
    return {
      ok: false,
      reason:
        `ifRevision 是 ${Math.floor(declaredRev)}，而当前是 ${currentRev} —— ` +
        "你手上的活跃台账**不是最新版**，直接归档会丢掉别的会话刚写的条目。" +
        "请先 `ledger_read` 重取最新内容，再重新归档。",
      currentRevision: currentRev,
      stale: true,
    };
  }

  // ── ② 先算"最终活跃台账"并过闸门 —— **此时一个字节都还没写** ─────────────
  const tag = sessionTag(exec?.agent);
  const priorActive = readTextSafe(activeAbs) ?? "";
  const beforeLines = bodyLineCount(priorActive);
  const bodyLines = countLines(newActive);
  const registered = withChangeRegister(
    newActive,
    changeRegisterLine(now, {
      mode: "archive",
      tag,
      delta: bodyLines - beforeLines,
      lines: bodyLines,
      revision: currentRev + 1,
    }),
    priorActive,
    changeRegisterMaxOf(info),
  );
  const lines = countLines(registered);
  if (lines > info.maxActiveLines && args?.force !== true) {
    return {
      ok: false,
      reason:
        `newActive 仍有 ${lines} 行（上限 ${info.maxActiveLines}）—— **归档没有写入、` +
        "活跃台账也没有改动**，一个字节都没动。请多归档一些旧条目，或确认后传 force: true。",
      archiveFile: toGitRel(root, archiveFile),
      lines,
      maxActiveLines: info.maxActiveLines,
      nothingWritten: true,
    };
  }

  // ── ③ ★★★ 内容不变量：**从活跃台账移走的每一行，都必须出现在 `entries` 里** ──
  //
  //   ★ 这条是**用一次真实事故换来的**（2026-10-11，见 DECISIONS D63）：
  //     我拿真台账做破坏性试验，`ifRevision` 那道门当时还不存在于运行中的内核，
  //     于是一次调用把 **266 行压成 1 行** —— 而 `entries` 只交了 1 行。
  //     ⇒ 265 行**既不在新台账、也没进归档**，凭空蒸发。
  //   ★ 为什么 `ifRevision` 拦不住它：那道门只判"版本是否过期"，
  //     **不判"你这次要删多少"**。就算版本号对得上，也可以一次删光。
  //   ★ 为什么这条判据是对的：`ledger_archive` 的语义是**移走**（移进只追加的归档），
  //     **不是删除**。所以"旧有新无"的每一行**必须**在 `entries` 里找到 ——
  //     否则它既不在台账、又不在归档，就是**无痕丢失**，而这是本项目最不能出的错。
  //   ★ 与 `ledger_write` 的区别：write 是"整份重写"，丢行可以是**有意的精简**；
  //     archive 是"移走"，**没有"有意丢行"这种用法** ⇒ 这里可以硬拒。
  const priorBody = splitChangeRegister(priorActive).body;
  const lost = lostEntries(priorBody, newActive).filter((l) => !entries.includes(l.trim()));
  if (lost.length > 0 && args?.force !== true) {
    return {
      ok: false,
      reason:
        `有 ${lost.length} 行会**既不在新台账、也不在 entries 里** ⇒ 等于凭空丢失。` +
        "`ledger_archive` 是**移走**（移进只追加的归档），不是删除：" +
        "每一行从活跃台账移除的内容都必须原样出现在 `entries` 里。" +
        "确认你确实要丢弃它们，才传 force: true。**本次没有写任何文件。**",
      lostLines: lost.length,
      lostSample: lost.slice(0, 5).map((l) => l.slice(0, 80)),
      nothingWritten: true,
    };
  }

  // ── ④ 重发识别（幂等）：同一批 entries 只写一次 ──────────────────────────

  //   ★ 判据是**内容指纹**，不是时间、不是序号 ⇒ "客户端没收到回执就重发"
  //     与"隔一天又归档同样的文本"两种情况都能正确识别。
  //   ★ 指纹写进归档文件的 HTML 注释里（渲染不可见，读源码时才看到）。
  const bodySha = createHash("sha256")
    .update(entries.replace(/\s+$/, ""), "utf8")
    .digest("hex")
    .slice(0, 12);
  const batchMark = `<!-- batch:${bodySha} -->`;
  const prevArchive = readTextSafe(archiveFile) ?? "";
  const alreadyArchived = prevArchive.includes(batchMark);

  ensureDir(periodDir);
  if (!alreadyArchived) {
    // ★ 只追加：读旧内容 + 本批，接在后面。**从不重写整段历史。**
    // ★ 但落盘走"临时文件 + 改名" —— 追加也是一次整文件重写，
    //   中途崩了同样会把归档截断（改名是原子的，同 `writeAnchorStore`）。
    const heading =
      `\n\n## ${stamp(now)} 归档` +
      `${typeof args?.label === "string" && args.label !== "" ? `（${args.label}）` : ""} ` +
      `${batchMark}\n\n`;
    const prefix = prevArchive === "" ? `# 台账归档 · ${periodLabel}\n` : "";
    const tmp = `${archiveFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, prevArchive + prefix + heading + entries.replace(/\s+$/, "") + "\n", "utf8");
    fs.renameSync(tmp, archiveFile);
  }
  fs.writeFileSync(activeAbs, registered, "utf8");

  // ★★★★ 2026-10-12（D136）：归档同样**改写了活跃台账** ⇒ 变更史必须照样记。
  //   ★ 为什么不能漏：归档会**成批移走块** ⇒ 若不记，"被移走的块"会一直留在
  //     变更史里被当成"从未变过"（它们的 `last` 永远不动）⇒ 相对序被幽灵块污染。
  //   ★ 仍是吞错（理由同 `writeLedger` 里那段）。
  try {
    recordBlockHistory(root, registered, Date.now());
  } catch {
    /* 变更史记不住不影响归档本身 */
  }

  // ── ★★ 归档**改了**活跃台账，所以它必须与 `ledger_write` 同等对待 ────────
  //
  // ★ 两个都是实测发现的漏（2026-10-09，探针撞到）：
  //   ① **不涨 revision**：`ifRevision` 的语义是"我基于哪个版本写的"，而归档
  //      **删掉了条目**却不改版本号 ⇒ 另一个会话拿着归档前的旧号仍被判成"当前版本"，
  //      于是它那份（没见过归档的）旧副本整份 replace 时**不会**触发自动保留。
  //      ⇒ 多会话保护在"归档"这条路上是**漏的**，而归档恰恰是最容易丢东西的操作。
  //   ② **不写审计**：`L0-ledger-changes.md` 是"谁改过台账、条目哪去了"的唯一证据，
  //      而 `ledger_archive` 是唯一会**成批删条目**的动作。
  //      漏了它，"台账里少了几条，是谁弄的"就永远查不出来 —— 正是审计存在的理由。
  const newRevision = bumpRevision(root);
  if (info.logRel !== undefined) {
    try {
      appendAudit(root, info, {
        tag,
        target: "active",
        mode: "archive",
        relPath: info.activeRel,
        lines,
        revision: newRevision,
        sessionId: exec?.agent?.session?.header?.id,
      });
    } catch {
      // 审计失败绝不影响归档本身。
    }
  }

  let staged;
  if (info.manifest?.autoGitAdd !== false && fs.existsSync(path.join(root, ".git"))) {
    const r = gitAdd(root, [toGitRel(root, archiveFile), info.activeRel]);
    staged = r.ok ? true : r.stderr || r.error || "git add 失败";
  }

  return {
    ok: true,
    archivedTo: toGitRel(root, archiveFile),
    period: periodLabel,
    activeLines: lines,
    activeWriteTo: info.activeRel,
    appended: prevArchive !== "",
    ...(tag === undefined ? {} : { sessionTag: tag }),
    ...(newRevision === undefined ? {} : { revision: newRevision }),
    ...(staged === undefined ? {} : { staged }),
  };
}

/**
 * 往活动日志追加一条**台账改动审计**（用户提议：改动哪处台账，就说哪个对话改动过它）。
 *
 * ★ 为什么需要它：多会话同项目时，台账会被 A、B 两个会话先后整份覆盖。
 *   即使加了版本锁挡住一部分，仍然需要回答两个问题：
 *     ① "这处是谁改的？" —— 靠这里记下的会话编号；
 *     ② "对方丢掉的进展去哪了？" —— 台账里没了，但**日志里还在**。
 *   ⇒ 这就是用户说的「另外一个对话找不到的时候就去查日志」。
 *
 * ★ 为什么单独一个文件（`L0-ledger-changes.md`）而不是混进 L0 里程碑：
 *   里程碑是"项目发生了什么"，这个是"**台账文件被谁动过**"。
 *   回溯丢条目时只关心后者，混在一起会被工具流水淹没。
 */
function appendAudit(root, info, rec) {
  const now = new Date();
  const fileRel = logFileRel(info, "L0", now).replace(/L0-.*\.md$/, "L0-ledger-changes.md");
  const abs = path.resolve(root, fileRel);
  if (!isUnder(root, abs)) return undefined;
  const who = rec.tag === undefined ? "(无编号)" : rec.tag;
  // ★ kind 如实区分"写"与"归档"：归档是**成批删条目**，与一次写入的追溯含义不同
  //   （"这几条哪去了" vs "谁改的"）。`ledger_log` 的 audit 视图**两个都收**，
  //   所以分开标不会让它漏掉归档 —— 见那里的 `AUDIT_KINDS`。
  const kind = rec.mode === "archive" ? AUDIT_KIND_ARCHIVE : AUDIT_KIND_WRITE;
  const line =
    `- ${stampSec(now)} (${kind}) [${who}] ${rec.target} ${rec.mode} → \`${rec.relPath}\` ` +
    `${rec.lines} 行` +
    (rec.revision === undefined ? "" : ` · revision→${rec.revision}`) +
    (typeof rec.sessionId === "string" && rec.sessionId !== "" ? ` · \`${rec.sessionId}\`` : "");
  ensureDir(path.dirname(abs));
  fs.appendFileSync(abs, line + "\n", "utf8");
  void info;
  return { path: abs, relative: fileRel };
}

// ═══════════════════════════════════════════════════════════════════════════
// 活动日志：读（回溯）与写（AI 的 L1）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 列出日志目录下所有日志文件。
 *
 * ★ 只认 `L[0-3]-*.md` 这个命名 —— 日志目录是**我们的**目录，但仍然只读自己认识的
 *   文件，免得用户往里放的东西被当成日志解析。
 */
function logFileList(info) {
  if (info.logAbs === undefined) return [];
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      const m = /^(L[0-4])-.*\.md$/.exec(e.name);
      if (m === null) continue;
      let bytes = 0;
      try {
        bytes = fs.statSync(abs).size;
      } catch {
        /* 拿不到就是 0 */
      }
      const rel = toGitRel(info.projectRoot, abs);
      // 期间键取自路径里的 `YYYY-MM` 段（与 archiveStamp 同款）。
      const period = /(\d{4}-\d{2})/.exec(rel)?.[1];
      out.push({ level: m[1], abs, rel, period, bytes });
    }
  };
  walk(info.logAbs, 0);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** 把用户给的时间串补成可与日志行时间戳直接比大小的 `YYYY-MM-DD HH:MM:SS`。 */
function normTime(raw, isEnd) {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (s === "") return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isEnd ? `${s} 23:59:59` : `${s} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return `${s}:${isEnd ? "59" : "00"}`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return isEnd ? `${s}-31 23:59:59` : `${s}-01 00:00:00`;
  return undefined;
}

/** 汇总 L2 文件流水：路径 → 操作集 / 次数 / 首末时间。 */
function aggregateFiles(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e.level !== "L2") continue;
    // L2 行：`(M) 路径  [工具名]`
    const text = e.text.replace(/\s+\[[^\]]*\]\s*$/, "").trim();
    const op = e.kind ?? "?";
    let rec = map.get(text);
    if (rec === undefined) {
      rec = { path: text, ops: new Set(), count: 0, first: e.at, last: e.at };
      map.set(text, rec);
    }
    rec.ops.add(op);
    rec.count += 1;
    if (e.at !== undefined) rec.last = e.at;
    if (rec.first === undefined) rec.first = e.at;
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count)
    .map((r) => ({ path: r.path, ops: [...r.ops].sort().join(""), count: r.count, first: r.first, last: r.last }));
}

/**
 * 回溯读日志。
 *
 * ★ 为什么默认返回**窗口内最早**的 N 条而不是最近的 N 条：这样它可续读 ——
 *   返回的 `nextCursor` 直接当 `since` 传回来就是下一页。返回"最近 N 条"看着更贴心，
 *   但一旦超出 limit，中间那段就永远拿不到了（既没有游标、也没有提示从哪继续）。
 */
function logRead(root, args) {  const info = inspect(root);
  if (logDirOf(info) === undefined) {
    // ★ 目录在那儿但没登记（清单里没有 logDir）⇒ 说清楚"为什么没记"以及怎么打开。
    //   不说的话用户会看着 `_ledger-log` 目录以为日志在工作，实际上一条都没记
    //   （2026-10-09 实测撞到：`ledger_status` 报出目录、`ledger_log` 却回"未启用"）。
    const guess = info.logGuess;
    return {
      ok: false,
      reason:
        guess === undefined
          ? "这个项目还没有启用活动日志。用 `ledger_init` 传 `logDir` 登记（例如 `_ledger-log`），" +
            "或先写一次台账再重试。"
          : `项目里有 \`${guess}\` 目录，但它**没有登记进清单**，所以日志并没在采集 —— ` +
            "本插件不擅自往项目里写任何东西。要启用它，让 AI 把清单的 `logDir` 设成 " +
            `\`${guess}\`（用 \`ledger_init\` 或 \`ledger_conform\`）。`,
      ...(guess === undefined ? {} : { logDirFoundButNotEnabled: guess }),
      hint: "ledger_init",
    };
  }

  // ★ audit 视图要固定读 L0（审计行就写在 L0 那个文件里）。若调用者同时给了
  //   `levels:["L1"]`，审计行会被过滤掉 ⇒ 视图空着，看着像"没人改过台账"。
  //   所以 audit 视图**强制**把 L0 打开。
  //
  // ★ `users` 视图反过来：它**只**要 L4。用户要的是"查我说过什么"，
  //   把 L0–L3 一起端上来等于让他从流水里捞原话。
  //
  // ★ 默认档位是 `DEFAULT_READ_LEVELS`（**不含 L4**）：用户消息量最大
  //   （实测 769 条），默认混进 timeline 会把别的档位挤出去。要看必须显式要。
  const view0 = typeof args?.view === "string" ? args.view : "timeline";
  const levels =
    Array.isArray(args?.levels) && args.levels.length > 0
      ? new Set(args.levels.filter((l) => LOG_LEVEL_NAMES.includes(l)))
      : view0 === "users"
        ? new Set(["L4"])
        : new Set(DEFAULT_READ_LEVELS);
  // audit 的审计行写在 L0 那个文件里 ⇒ 必须保证 L0 在（原样保留：**无条件**补，
  // 因为调用者显式给 `levels:["L1"]` 时审计行会被滤光，视图空着会被读成"没人改过台账"）。
  if (view0 === "audit") levels.add("L0");
  // users 视图同理补 L4，否则这个视图在显式档位下必然空着。
  if (view0 === "users") levels.add("L4");

  const since = normTime(args?.since, false);
  const until = normTime(args?.until, true);
  const sincePeriod = since?.slice(0, 7);
  const untilPeriod = until?.slice(0, 7);
  const needle = typeof args?.grep === "string" && args.grep !== "" ? args.grep.toLowerCase() : undefined;

  const files = logFileList(info).filter((f) => {
    if (!levels.has(f.level)) return false;
    if (f.period !== undefined) {
      if (sincePeriod !== undefined && f.period < sincePeriod) return false;
      if (untilPeriod !== undefined && f.period > untilPeriod) return false;
    }
    return true;
  });

  const entries = [];
  let scannedLines = 0;
  let unreadable = 0;
  for (const f of files) {
    const raw = readTextSafe(f.abs);
    if (raw === undefined) {
      unreadable += 1;
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "" || line.startsWith("#")) continue;
      const e = parseLogLine(f.level, line);
      if (e.at !== undefined) {
        if (since !== undefined && e.at < since) continue;
        if (until !== undefined && e.at > until) continue;
      }
      if (needle !== undefined && !line.toLowerCase().includes(needle)) continue;
      scannedLines += 1;
      entries.push(e);
    }
  }

  const view = typeof args?.view === "string" ? args.view : "timeline";
  const limit =
    Number.isFinite(args?.limit) && args.limit > 0
      ? Math.min(Math.floor(args.limit), LOG_MAX_LIMIT)
      : numOf("logDefaultLimit", LOG_DEFAULT_LIMIT);

  // raw 视图：原样给行，最省事也最保真。
  if (view === "raw") {
    const slice = entries.slice(0, limit);
    return {
      ok: true,
      view,
      logDir: info.logRel,
      files: files.map((f) => f.rel),
      matched: entries.length,
      returned: slice.length,
      truncated: entries.length > slice.length,
      nextCursor: slice.length > 0 ? slice.at(-1).at ?? null : null,
      lines: slice.map((e) => e.raw),
    };
  }

  if (view === "files") {
    const agg = aggregateFiles(entries);
    return {
      ok: true,
      view,
      logDir: info.logRel,
      files: files.map((f) => f.rel),
      matched: entries.length,
      returned: agg.length,
      truncated: false,
      // ★ 文件视图天然是"按路径去重"的，所以条数远小于流水行数 —— 这正是它的用处。
      touched: agg.filter((a) => /[AM]/.test(a.ops)),
      readOnly: agg.filter((a) => a.ops === "R"),
    };
  }

  // ── audit 视图：台账被**哪个会话**改过（用户提议）────────────────────────
  //
  // ★ 这是"多会话同项目"的追溯入口：条目不见了 → 先来这里看谁改过、
  //   再顺着会话编号去查那个会话自己的记录。
  if (view === "audit") {
    // ★ 两种 kind 都收（见 `AUDIT_KINDS`）：归档也是改台账，而且是**成批删条目**那次。
    //   只收 `ledger-write` 会让"这几条哪去了"查不到 —— 那正是审计存在的理由。
    const rows = entries.filter((e) => AUDIT_KINDS.includes(e.kind));
    const slice = rows.slice(0, limit);
    // 按会话编号汇总，一眼看出有几个会话在动这份台账。
    const byTag = new Map();
    for (const r of rows) {
      const m = /\[([^\]]+)\]/.exec(r.text);
      const tag = m === null ? "(无编号)" : m[1];
      byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
    }
    return {
      ok: true,
      view,
      logDir: info.logRel,
      matched: rows.length,
      returned: slice.length,
      truncated: rows.length > slice.length,
      nextCursor: slice.length > 0 ? slice.at(-1).at ?? null : null,
      // ★ 谁在动这份台账（会话编号 → 次数）。多于一个 ⇒ 就是多会话同项目。
      bySession: [...byTag.entries()].map(([tag, count]) => ({ tag, count })),
      changes: slice.map((e) => ({ at: e.at, text: e.text })),
      ...(rows.length === 0
        ? { note: "还没有台账改动审计记录（第一次有会话写台账后就会出现）。" }
        : {}),
    };
  }

  // ── users 视图：用户**本人说过的话**（需求 ⑳）─────────────────────────
  //
  // ★ 与 timeline 的区别不只是"只看 L4"：这里**按会话编号汇总**，
  //   因为用户给这个记录的理由是「**多会话项目很有用**」——
  //   他要知道的是"这个项目里，哪几个会话分别说过什么"。
  //   timeline 给的是流水，回答不了"有几个会话在参与"。
  if (view === "users") {
    entries.sort((a, b) => {
      const x = a.at ?? "";
      const y = b.at ?? "";
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const slice = entries.slice(0, limit);
    const skipped = entries.length - slice.length;
    const byTag = new Map();
    for (const e of entries) {
      // kind 形状是 `user:<编号>`（见 renderUserMessageLine）。
      const m = /^user(?::([0-9a-z]+))?$/.exec(e.kind ?? "");
      const tag = m?.[1] ?? "(无编号)";
      byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
    }
    return {
      ok: true,
      view,
      logDir: info.logRel,
      files: files.map((f) => f.rel),
      filesUnreadable: unreadable,
      matched: entries.length,
      returned: slice.length,
      truncated: skipped > 0,
      nextCursor: slice.length > 0 ? slice.at(-1).at ?? null : null,
      bySession: [...byTag.entries()].map(([tag, count]) => ({ tag, count })),
      messages: slice.map((e) => ({ at: e.at ?? null, kind: e.kind ?? null, text: e.text })),
      ...(entries.length === 0
        ? {
            note:
              "还没有用户消息记录。若 L4 是关着的（清单 `logLevels.L4:false`），打开它才会开始记；" +
              "另外它**只记本插件启用之后**的消息 —— 之前的会话没有回溯补写（那些原话在官方会话日志里）。",
          }
        : {}),
    };
  }

  if (view === "failures") {
    const fails = entries.filter((e) => e.level === "L3" && e.text.includes("[失败]"));
    const slice = fails.slice(0, limit);
    // ★ 失败详情要回到**原始会话日志**去查 —— 本插件只记"哪一步炸了"，
    //   不存报错全文（存了就是一个会无限膨胀的副本，而官方日志里本来就有）。
    const hint =
      fails.length > 0
        ? "失败详情不在本日志里：本插件只记「哪一步失败」。要看当时的报错全文，" +
          "去读官方会话日志 `$DSH_HOME/sessions/<编码后的 cwd>/<session-id>/session.v4.jsonl.zstd`" +
          "（多帧 zstd；cwd 的编码规则见 README）。"
        : undefined;
    return {
      ok: true,
      view,
      logDir: info.logRel,
      matched: fails.length,
      returned: slice.length,
      truncated: fails.length > slice.length,
      nextCursor: slice.length > 0 ? slice.at(-1).at ?? null : null,
      failures: slice.map((e) => ({ at: e.at, text: e.text })),
      ...(hint === undefined ? {} : { hint }),
    };
  }

  // timeline（默认）
  entries.sort((a, b) => {
    const x = a.at ?? "";
    const y = b.at ?? "";
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const slice = entries.slice(0, limit);
  // 上限之外的条数要说出来：不然"日志只有这么点"会被当成事实。
  const skipped = entries.length - slice.length;
  return {
    ok: true,
    view: "timeline",
    logDir: info.logRel,
    files: files.map((f) => f.rel),
    filesUnreadable: unreadable,
    scannedLines,
    matched: entries.length,
    returned: slice.length,
    truncated: skipped > 0,
    nextCursor: slice.length > 0 ? slice.at(-1).at ?? null : null,
    entries: slice.map((e) => ({ at: e.at ?? null, level: e.level, kind: e.kind ?? null, text: e.text })),
  };
}

/**
 * ⑨ ledger_note —— 写一份**问题记录**（不是项目台账）。
 *
 * ★ 这个工具存在的理由（本机实测数据）：112 个会话里 **104 个**的 cwd 就是容器根
 *   一个汇总工作区 —— 绝大多数会话不是"某个项目"，而是"修一个问题 / 调研一件事"。
 *   旧版本判出容器后**只说"别在这里初始化"就没有下文**，等于把 93% 的会话扔下。
 *
 * ★ 为什么单独一个工具而不是让 AI 直接 write：
 *   ① 文件名要统一成 `YYYY-MM-DD-主题.md`（工作区已有 27 份按这个规矩，写在 AGENTS.md §4）；
 *   ② 要落在**工作区根**的既有通道里，而会话 cwd 可能在子目录（`findWorkspaceRoot` 负责往上找）；
 *   ③ 要**永不覆盖**已存在的记录 —— 那些是证据，不是可编辑文档。
 *
 * 判据（写给 AI 看的那条）：**有累积状态 ⇒ 台账；一次性、有终点 ⇒ 问题记录。**
 */
function defineNoteTool() {
  return {
    name: "ledger_note",
    description:
      "Write a PROBLEM/INVESTIGATION note — for work that is NOT a project. Use this instead of " +
      "ledger_init when the session is about solving a problem, investigating something, or " +
      "diagnosing a fault: such work has an endpoint, so it has no \"current goal / next step / " +
      "archive\" to maintain. The note goes to the workspace's existing notes channel " +
      "(e.g. `60-对话记录与交接/对话总结/`) as `YYYY-MM-DD-title.md`, and an existing file is " +
      "NEVER overwritten. If the work DOES have accumulating state that you will need to pick up " +
      "later, use ledger_init instead — that is the whole distinction.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short topic; the file becomes `YYYY-MM-DD-<title>.md`. Required.",
        },
        kind: {
          type: "string",
          enum: NOTE_KINDS,
          description: "What kind of note this is. Default 问题.",
        },
        problem: { type: "string", description: "The symptom / what needed solving." },
        cause: {
          type: "string",
          description:
            "Root cause. ★ Filling this in is the point of the tool: without it the note is a " +
            "diary and the same problem has to be re-diagnosed next time.",
        },
        conclusion: { type: "string", description: "The outcome / answer." },
        actions: { type: "string", description: "What was actually done (commands, changes)." },
        files: { type: "string", description: "Files involved, free text." },
        related: { type: "string", description: "Other notes, ledgers or links." },
        root: ROOT_PARAM,
      },
      required: ["title"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec, args);
      const info = inspect(root);

      // ★ 真项目里没有"问题记录"这回事 —— 那该用台账。给出来只会诱导 AI
      //   把项目内容写进一个不属于项目的外部目录。
      if (info.isGitRepo) {
        return {
          ok: false,
          reason:
            `\`${root}\` 是一个 Git 项目，不是工作区。项目里的进展请用 \`ledger_write\` 写进台账；` +
            "`ledger_note` 只用于**不是项目**的一次性问题/调研。",
          hint: "ledger_write",
        };
      }
      if (info.notesAbs === undefined || info.notesRel === undefined) {
        return { ok: false, reason: "解析不出问题记录目录（容器判定异常）。" };
      }

      const title = typeof args?.title === "string" ? args.title.trim() : "";
      if (title === "") return { ok: false, reason: "title 不能为空 —— 文件名要用它。" };

      const now = new Date();
      const fileName = noteFileName(now, title);
      const abs = path.join(info.notesAbs, fileName);
      // 防御：文件名由我们拼，但仍然确认一次没有逃出目录。
      if (!isUnder(info.notesAbs, abs)) throw fail("ledger_note: 目标逃出了记录目录");

      if (fs.existsSync(abs)) {
        // ★ 不覆盖、不追加：同一天的同一主题再写会撞名，明确告诉调用者换个标题。
        return {
          ok: false,
          reason:
            `今天已经有一份同名记录：\`${toGitRel(root, abs)}\`。记录是证据，**不会被覆盖**。` +
            "请换一个更具体的 title（例如加上子主题），或直接去读那一份。",
          path: abs,
          existing: true,
        };
      }

      const kind = NOTE_KINDS.includes(args?.kind) ? args.kind : "问题";
      const body = renderNote({ title, kind, ...args }, stampSec(now));
      try {
        ensureDir(info.notesAbs);
        // flag "wx"：文件已存在就抛（上面已查过，这里再兜一次并发）。
        fs.writeFileSync(abs, body, { encoding: "utf8", flag: "wx" });
      } catch (e) {
        return { ok: false, reason: `写入问题记录失败：${String((e && e.message) || e)}`, path: abs };
      }

      return {
        ok: true,
        kind,
        path: abs,
        relative: toGitRel(root, abs),
        notesDir: info.notesRel,
        bytes: Buffer.byteLength(body, "utf8"),
        // ★ 顺带把"这不算台账"说清楚，免得 AI 之后又去 ledger_init 一遍。
        note:
          "这是一份**问题记录**，没有活跃台账、没有归档、不需要后续维护。" +
          "若这件事其实是长期项目，请改用 ledger_init。",
      };
    },
  };
}

/**
 * ⑩ ledger_handoff —— 写一份**交接单**（第③层「让新对话无缝衔接」的关键零件）。
 *
 * ★ 为什么必须是一个工具、而不是"让 AI 自己找个地方写"（2026-10-10）：
 *   原来回合末卡片只说 *"建议放在项目里的 docs/ 或交接单目录"* —— **位置模糊**，
 *   于是同行会出现：① 同一个项目两次交接落在两个地方；② 新会话**不知道去哪找**。
 *   而 `renderCapsule` 里那行"上一次交接单"因此只能做成参数
 *   （`opts.handoffRel`）—— 而**没有任何地方传它** ⇒ 那是一行**死代码**。
 *
 * ⇒ 现在有了**约定位置**（`inspect()` 解析 `handoffRel` / `handoffLatestRel`），
 *   于是"新会话该读哪一份"成了一个**可回答的问题**，而不是靠运气。
 *
 * ★ 与其它写盘工具同一套规矩：**永不覆盖**（撞名换名）、**路径逃逸检查**、
 *   文件名日期在前（目录里天然按时间排序）。
 */
function defineHandoffTool() {
  return {
    name: "ledger_handoff",
    description:
      "Write a HANDOFF document so a NEW conversation can pick this work up. Use it at the end of " +
      "a session (or when changing direction) — the document goes to the project's agreed handoff " +
      "directory, and its path is what a later session is told to read first. Include: what was " +
      "done, current state, what is next, and the exact file paths that matter. An existing file " +
      "is NEVER overwritten.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short topic; the file becomes `YYYY-MM-DD-HHmm-<title>.md`. Required.",
        },
        did: { type: "string", description: "What was actually done this session." },
        state: {
          type: "string",
          description:
            "Current state — what works, what does not, what is half-done. ★ This is the field " +
            "that saves the next session the most time.",
        },
        next: { type: "string", description: "What the next step is, concretely." },
        files: {
          type: "string",
          description:
            "The exact paths that matter (changed or must be read). ★ Paths, not descriptions — " +
            "the next session will open them.",
        },
        blocked: { type: "string", description: "Anything blocking, or that must be decided by the human." },
        root: ROOT_PARAM,
      },
      required: ["title"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec, args);
      const info = inspect(root);
      if (info.handoffAbs === undefined || info.handoffRel === undefined) {
        return {
          ok: false,
          reason:
            "解析不出交接单目录。交接单是**项目**级的东西 —— " +
            "若当前目录是容器工作区，请用 `root` 点名某个具体项目。",
        };
      }
      const title = typeof args?.title === "string" ? args.title.trim() : "";
      if (title === "") return { ok: false, reason: "title 不能为空 —— 文件名要用它。" };

      const now = new Date();
      let fileName = handoffFileName(now, title);
      let abs = path.join(info.handoffAbs, fileName);
      if (!isUnder(info.handoffAbs, abs)) throw fail("ledger_handoff: 目标逃出了交接单目录");

      // ★ 永不覆盖。撞名（同一分钟同一主题）就加后缀 —— 与原文件并存。
      let n = 2;
      while (fs.existsSync(abs) && n < 10) {
        fileName = handoffFileName(now, `${title}-${n}`);
        abs = path.join(info.handoffAbs, fileName);
        n += 1;
      }

      const at = stampSec(now);
      const sid = String(exec?.agent?.session?.header?.id ?? "");
      const sec = (label, v) =>
        typeof v === "string" && v.trim() !== "" ? `\n## ${label}\n\n${v.trim()}\n` : "";
      const body =
        `# 交接单 · ${title}\n\n` +
        `> 写于 ${at}${sid === "" ? "" : ` · 会话 \`${tagOfId(sid)}\``}\n` +
        "> **给下一个会话看的**。接手时先读这一份，再去读台账与决策记录。\n" +
        sec("这次做了什么", args?.did) +
        sec("当前状态（什么能跑、什么不能、什么是半截的）", args?.state) +
        sec("下一步", args?.next) +
        sec("关键文件路径", args?.files) +
        sec("卡点 / 需要人拍板", args?.blocked) +
        "\n---\n\n" +
        "## 去哪重读（真源，比本文件可靠）\n\n" +
        (info.activeRel === undefined
          ? ""
          : `- 活跃台账：\`${path.join(root, info.activeRel)}\`\n`) +
        (info.decisionsRel === undefined
          ? ""
          : `- 关键决策：\`${path.join(root, info.decisionsRel)}\`\n`) +
        (info.logRel === undefined
          ? ""
          : `- 活动日志：\`${path.join(root, info.logRel)}\`（用 \`ledger_log\` 按需查）\n`) +
        (info.archiveRel === undefined
          ? ""
          : `- 归档：\`${path.join(root, info.archiveRel)}\`\n`);
      try {
        ensureDir(info.handoffAbs);
        fs.writeFileSync(abs, body, { encoding: "utf8", flag: "wx" });
      } catch (e) {
        return { ok: false, reason: `写入交接单失败：${String((e && e.message) || e)}`, path: abs };
      }
      return {
        ok: true,
        path: abs,
        relative: toGitRel(root, abs),
        handoffDir: info.handoffRel,
        bytes: Buffer.byteLength(body, "utf8"),
        previous: info.handoffLatestRel ?? null,
        note:
          "已写入约定位置。**下一次会话开在这个项目时，插件会自动在注入里告诉它" +
          "「先读这一份」** —— 你不需要再做别的。",
      };
    },
  };
}

/**
 * ⑦之三 `ledger_lock` —— 把**本场会话**锁到某个项目目录上。
 *
 * **用户原话（2026-10-10）**：
 *   *"因为总的工作区是有需要读的东西的，所以有时候会把对话建在总的工作区下面，
 *     这种时候的话，这个项目的锁定就应该考虑到可以让用户和AI说之后AI调用，
 *     或者说把项目注册到对应的文件夹上，以后各种工具的使用都在那个文件夹上。"*
 *
 * 以及他**否决**"落一份注册表文件"时的原话：
 *   *"让模型拥有把插件锁定在对应或者说本次项目新建的文件夹中。而不是去动工作区的东西。
 *     不应该有这个权利。最开始的提示卡片就可以有这样的选择。"*
 *
 * ⇒ 三条约束（他给的，逐条对应到实现）：
 *   ① **不碰工作区**：锁**不在用户的工作区里留任何东西**（不建注册表、不建标记）。
 *      ★ 但它**会落盘** —— 落在 **DSH 自己的家**：
 *        `$DSH_HOME\plugin-data\dsh-ledger-memory\locks.json`
 *        （本机现成惯例，别家插件也在 `plugin-data\<包名>\` 放自己的东西）。
 *      ⇒ 这条修正了原先"一个字节都不落盘"，因为用户后来要求**跨重启保持**
 *        （*"不管重启多少次，之后都默认在那个文件夹使用工具"*）。
 *   ② **每场对话各记各的**：键是 **sid**。
 *      ★ 用户原话（他纠正过我一次）：*"注意是每个对话自己选锁定的目录并保持"*
 *        —— 所以**不是**"这个目录以后都默认"，而是"**这场**对话锁定在哪儿、并记住它"。
 *   ③ **首轮卡片也要给**：见 `FIRST_TURN_OPTIONS` 的第四项。
 *
 * ★ 为什么做成**工具**而不是让插件自己猜项目：
 *   "哪个子目录是这个会话要干的活"是**人的意图**，插件无从推断（总工作区里有几十个
 *   子项目，猜错就是把台账写到别人项目里）。让 AI 明确调用、并在调用前问用户，
 *   与 `ledger_note` / `ledger_handoff` 是同一套分工：**判断归 AI，流程归插件**。
 */
function defineLockTool() {
  return {
    name: "ledger_lock",
    description:
      "Pin THIS conversation to one project directory, so every later tool call resolves against " +
      "it instead of the session's cwd. Use it when the conversation was started in a container " +
      "workspace (a folder holding several sub-projects) and the user wants the ledger work to land " +
      "on one specific sub-project. The lock PERSISTS across restarts (stored in DSH's own " +
      "plugin-data, never inside the user's workspace or the target directory), so it survives " +
      "closing and reopening; it is remembered per conversation, and each conversation keeps its " +
      "own. Pass no `root` (or `release: true`) to release it. Precedence: if the cwd itself " +
      "already has a ledger, that wins and the lock only takes over directories that have none.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        release: {
          type: "boolean",
          description: "Set true to release the lock instead of setting one. Same as omitting `root`.",
        },
      },
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const agent = exec?.agent;
      const release = args?.release === true || (typeof args?.root !== "string" || args.root.trim() === "");
      const cur = lockedRootOf(agent);

      if (release) {
        const r = setProjectLock(agent, undefined);
        return {
          ok: true,
          locked: false,
          wasLocked: cur ?? null,
          wasLockedRoot: r.wasLockedRoot ?? null,
          note:
            cur === undefined
              ? "本来就没有锁 —— 什么都没变（工具调用一律按会话工作目录解析）。"
              : `已解锁（原锁定：\`${cur}\`）。此后按会话工作目录解析。`,
          // ★ 解除时**持久记录也一起删了** —— 否则用户会遇到"我明明解除了，重启又回来"。
          persisted: false,
          storePath: lockStorePath(),
        };
      }

      const raw = String(args.root).trim();
      const base = projectRootOf(agent);
      const abs = path.resolve(base ?? process.cwd(), raw);
      const r = setProjectLock(agent, abs);
      if (r.ok !== true) {
        return { ok: false, reason: r.reason };
      }
      const info = inspect(abs);
      return {
        ok: true,
        locked: true,
        root: abs,
        // ★ 如实告诉它这个目录**是什么**：有台账 / 是容器 / 是空目录。
        //   锁到一个没有台账的目录**不是错误**（下一步就 `ledger_init` 建），
        //   但锁到一个**容器工作区**通常是搞错了（那是"装着项目的地方"，不是项目）。
        hasLedger: info.activeRel !== undefined,
        active: info.activeRel ?? null,
        isGitRepo: info.isGitRepo,
        containerWorkspace:
          info.isGitRepo !== true && (info.containerMarker !== undefined || info.nestedRepo !== undefined)
            ? info.containerMarker ?? info.nestedRepo ?? "?"
            : null,
        note:
          info.activeRel !== undefined
            ? `已锁定到 \`${abs}\`（这个目录有台账：\`${info.activeRel}\`）。此后本会话的工具都落在这里。`
            : `已锁定到 \`${abs}\`（它还没有台账 —— 要让这个项目有台账，接着调 \`ledger_init\`）。` +
              "此后本会话的工具都落在这里。",
        // ★★★ 必须如实说清"写在哪、写没写成"，否则用户无从判断该不该信这个锁。
        persisted: r.persisted === true,
        persistReason: r.persistReason ?? null,
        // ★ 落在**插件自己的家**，不在用户工作区 —— 这一点必须讲明白，
        //   因为用户先前明确的红线是"不要去动工作区的东西"。
        storePath: r.storePath ?? lockStorePath(),
        scope: "本场对话（已记住；重启/关掉再开都还在）",
        hint:
          "★ 锁定记在 **DSH 自己的 `plugin-data`** 里（**不在你的工作区里**：不建注册表、" +
          "不在目标目录留标记、目标目录一个字节都不多）。每场对话各记各的，互不影响。" +
          "要取消就再调一次（不传 root）或 `/ledger lock off`。",
      };
    },
  };
}

/**
 * ⑦之二 `ledger_triage` —— 「反复追究」模式下的**分流单**（用户说的"划分"）。
 *
 * ★ 用户原话（2026-10-10）：*"对这 20 输出的工作量进行划分…最终只有 10%"*
 *   以及 *"没必要保留的是有必要查到的就放进项目中，然后没有必要保留的就归档"*
 *
 * 三个桶（**必须由 AI 判断**，不是机械规则 —— 规则抓不到"假设 / 走不通的路"）：
 *
 *   keep  留在上下文：**下一轮一定要知道**的。压缩后**逐字重注入**。
 *   stash 落进项目：以后可能查，但**不该占上下文**。写进 `_stash/`，按需 grep。
 *   drop  丢掉：已被取代 / 已完成且不再影响判断。
 *
 * ★ 为什么 `keep` 必须有硬上限：不限的话，"什么都重要"会把上下文撑回去，
 *   等于没压。超上限就**按顺序截断**（AI 给的顺序即优先级），
 *   并**如实报出被截掉几条** —— 否则分流不可验证。
 */
const TRIAGE_KEEP_MAX = 12;

/**
 * ★★★★★ 2026-10-13（D158）：**累积**的 keep 上限（跨多次分流的总量）。
 *
 * ★ 为什么要第二个上限：`TRIAGE_KEEP_MAX`（12）限的是**单次**分流；
 *   而 D158 之后 keep 桶会**跨多次分流累积**到下一次压缩 ⇒ 需要一条**总量**天花板，
 *   否则"每回合分一点"会把上下文重新撑回去（等于没压）。
 * ★ 为什么取 40：单次 12、典型 2~3 次分流就到这里；超了丢**最旧的**（新近判断更可能有效），
 *   并**如实报出丢了几条**（沉默丢弃 = 下一个 D89）。
 */
const TRIAGE_KEEP_TOTAL_MAX = 40;

function defineTriageTool(state) {
  return {
    name: "ledger_triage",
    description:
      "Split the work done so far into three buckets before a compaction runs. Use it in the " +
      "'surgical' (反复追究) mode, or whenever you are about to lose detail you may need later. " +
      "`keep` = must be known next turn; it is re-injected VERBATIM after the compaction. " +
      "`stash` = may be needed later but should not occupy context; written into the project's " +
      "_stash/ directory and never injected. `drop` = superseded. Being honest here is the whole " +
      "point: if you put everything in `keep`, nothing is compressed.",
    parameters: {
      type: "object",
      properties: {
        keep: {
          type: "array",
          description:
            "Things that MUST be known next turn — current task state, unverified assumptions, " +
            "constraints the user set. Re-injected verbatim after compaction. Keep it SHORT. " +
            `At most ${numOf("triageKeepMax", TRIAGE_KEEP_MAX)} items; extras are truncated (in your order) and reported.`,
          items: {
            type: "object",
            properties: {
              what: { type: "string", description: "The thing itself, one line." },
            },
            required: ["what"],
            additionalProperties: false,
          },
        },
        stash: {
          type: "array",
          description:
            "Worth keeping but NOT worth context — decisions and their reasons, dead ends you " +
            "already ruled out, key file locations. Written to the project's _stash/ for later grep.",
          items: {
            type: "object",
            properties: {
              what: { type: "string", description: "What it is, one line." },
              why: { type: "string", description: "Why it may be worth finding again." },
              where: {
                type: "string",
                description: "Where to look — an exact path or command. ★ Paths, not descriptions.",
              },
            },
            required: ["what"],
            additionalProperties: false,
          },
        },
        drop: {
          type: "array",
          description:
            "Superseded or finished-and-irrelevant. Listed so the split is auditable; nothing is written.",
          items: {
            type: "object",
            properties: { what: { type: "string" } },
            required: ["what"],
            additionalProperties: false,
          },
        },
        // ★★★★ 2026-10-12（D136）：**区块权重**（模型侧的唯一输入）。
        //
        //   ★ 用户要求：*"要给一个通用标准来让不同模型来计算权重"* ⇒
        //     模型**只答是/否**，分数由本插件按常量表算（见 `weightFromAnswers`）。
        //     ★ 所以这里**没有"分数"字段** —— 有的话模型一定会塞，而那就不可复现了
        //     （实测：把实现改成"直接收模型给的 score"⇒ 自检一条都不红，
        //       那说明该主张当时没有断言在守 ⇒ 情形 56②b 就是补它的）。
        //
        //   ★ 为什么搭在 `ledger_triage` 上而不是新开一个工具：
        //     步骤已经够多（用户抱怨过"义务太多被卡"）；而分流本来就是"你在看台账"的时刻，
        //     顺手回答四个是/否，比要求它额外记得调一个新工具**便宜得多**。
        //   ★ 缺省**完全可不传**：不传 ⇒ 该维跳过 ⇒ 退化成"只看星与结构"（不伤准确性）。
        weights: {
          type: "array",
          description:
            "Optional. Per-block yes/no scoring for the ledger's memory blocks — used to decide " +
            "which blocks get injected in full (the rest only appear in the table of contents). " +
            "Answer ONLY true/false; the score is computed by this plugin (same answers ⇒ same " +
            "score, on any model). Omit entirely if you are not scoring — it degrades gracefully.",
          items: {
            type: "object",
            properties: {
              hash: {
                type: "string",
                description:
                  "The block's content-hash prefix, exactly as shown in the ledger table of contents " +
                  "(`#xxxxxxxx`). ★ Use the hash, not the title — titles change, content hashes do not.",
              },
              q1: {
                type: "boolean",
                description:
                  "Does this block contain a constraint that, if NOT followed, causes an ERROR? " +
                  "★ Judge the consequence, not the wording — 「必须/绝不/★」 are this project's house " +
                  "style and appear everywhere; only answer true when disobeying actually breaks things.",
              },
              q2: { type: "boolean", description: "Does it describe what is being done NOW / next?" },
              q3: {
                type: "boolean",
                description: "Is it impossible to derive from elsewhere (other blocks, source, common sense)?",
              },
              q4: { type: "boolean", description: "Would it still hold and still matter in a brand-new session?" },
            },
            required: ["hash"],
            additionalProperties: false,
          },
        },
        root: ROOT_PARAM,
      },
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec, args);
      const info = inspect(root);
      if (info.activeRel === undefined) {
        return {
          ok: false,
          reason:
            "这个项目还没有台账 ⇒ 按约定不往项目里写文件。先 `/ledger init`，" +
            "或者用 `root` 点名一个已经有台账的项目。",
        };
      }
      const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && typeof x === "object") : []);
      const keepAll = arr(args?.keep);
      const stash = arr(args?.stash);
      const drop = arr(args?.drop);

      const keepMax = numOf("triageKeepMax", TRIAGE_KEEP_MAX);
      const keep = keepAll.slice(0, keepMax).map((x) => ({
        what: String(x?.what ?? "").trim(),
      })).filter((x) => x.what !== "");
      const overflow = Math.max(0, keepAll.length - keepMax);

      if (keep.length === 0 && stash.length === 0 && drop.length === 0) {
        return { ok: false, reason: "三个桶都是空的 —— 没有内容可分。" };
      }

      const sid = String(exec?.agent?.session?.header?.id ?? "");
      const at = stampSec(new Date());

      // ★★★★★ 2026-10-13（D158，**用户当场指出的设计缺陷**）：**累积**，不再覆盖。
      //
      //   用户原话（逐字）：*"就是我们的全量压缩事务是根据最后一次分流结果来压缩的，这可不行。
      //   以后就是全量压缩把现有的所有分流情况全部进行压缩"*
      //
      //   ★ 病（读码确认，确实是我写的）：原来这里是 `state.triageKeep.set(sid, {at, items: keep})`
      //     —— **单槽覆盖**，而消费点（压缩后重注）是 `get` + `delete`。
      //     ⇒ 两次分流之间若发生过 ≥2 次 `ledger_triage`，**只有最后一份能活到压缩那一刻**，
      //       前面几份**静默蒸发**（既没进 keep 注回、也没人知道）。
      //   ★★ 而 D157 刚把"每回合强制分流"定成规则 ⇒ 这个缺陷**立刻从"偶发"变成"必然"**：
      //     每回合分一次、压缩却可能几十回合才发生一次 ⇒ **几乎全部分流单都会被丢掉**。
      //   ★ 这正是本项目那条纪律的同型复发：**单槽 Map 在重叠路径上必错**（纪律第 13 条）。
      //     与 D89 那次"压缩来源用单槽、被并发覆盖"是**同一个病**，只是换了个字段。
      //
      //   ★ 修法：**累积**（append），并在**压缩那一刻**一次性交给重注、然后清空。
      //     · 去重：同一条 `what` 只留第一次（模型可能反复说同一件事）；
      //     · 上限：`TRIAGE_KEEP_TOTAL_MAX`，超了**从最旧的开始丢**并**如实计数**
      //       （沉默丢弃 = 下一个 D89）。
      const key0 = String(sid);
      if (keep.length > 0 && sid !== "") {
        const prev = state.triageKeep.get(key0);
        const merged = Array.isArray(prev?.items) ? [...prev.items] : [];
        const seen = new Set(merged.map((x) => String(x?.what ?? "").trim()));
        let added = 0;
        for (const k of keep) {
          const w = String(k?.what ?? "").trim();
          if (w === "" || seen.has(w)) continue;
          seen.add(w);
          merged.push({ what: w, at });
          added += 1;
        }
        // ★ 上限：超了丢**最旧的**（新近的判断更可能仍然有效）。
        const totalMax = numOf("triageKeepTotalMax", TRIAGE_KEEP_TOTAL_MAX);
        const droppedOld = Math.max(0, merged.length - totalMax);
        const kept = droppedOld > 0 ? merged.slice(droppedOld) : merged;
        state.triageKeep.set(key0, { at, items: kept, added, droppedOld, sessions: (prev?.sessions ?? 0) + 1 });
      }
      // ★★ 记下"这次分流做过了" ⇒ 闸门那条**分流义务**随之兑现（见 `triageOwed`）。
      //   ⚠️ 即使 keep 是空的也要记：只 stash / 只 drop 也是一次**合法的分流**，
      //      否则闸门会一直等它做一件它已经做过的事（活锁）。
      if (sid !== "") {
        const key = String(sid);
        state.triageAt.set(key, Date.now());
        state.triageOwedAt?.delete?.(key);
        state.triageBlocked?.delete?.(key);
      }

      // ★★★★ 2026-10-12（D136）：**收下模型的分块四问**（权重那一维的输入）。
      //
      //   ★★ 只认**布尔**，只认**哈希** —— 两道门都在这里把死：
      //     · 模型塞一个 `score: 999` ⇒ **没有这个字段可塞**（schema 里就没有），
      //       而且这里**只读 q1~q4** ⇒ 塞了也不生效；
      //     · 塞字符串"是"/数字 ⇒ `=== true` 判否 ⇒ 不计分。
      //   ⇒ 于是"分数由插件算"这条主张在**生产链路**上也成立，不只是自检里成立。
      //   ★ 存到 state（按会话 + 项目根），注入时取用；★ 不落盘 ⇒ 不污染工作区。
      const weightRows = Array.isArray(args?.weights) ? args.weights : [];
      let weightAccepted = 0;
      if (weightRows.length > 0 && sid !== "") {
        const bucket = new Map();
        for (const raw of weightRows) {
          if (raw === null || typeof raw !== "object") continue;
          const hash = String(raw.hash ?? "").trim().toLowerCase().replace(/^#/, "");
          if (hash === "") continue;
          const row = {};
          for (const k of ["q1", "q2", "q3", "q4"]) {
            if (raw[k] === true) row[k] = true;
            else if (raw[k] === false) row[k] = false;
            // ★ undefined / 字符串 / 数字 一律**不写入** ⇒ `weightFromAnswers` 视为没答
          }
          if (Object.keys(row).length === 0) continue;
          bucket.set(hash, row);
          weightAccepted += 1;
        }
        if (bucket.size > 0) state.blockWeights.set(String(sid), { at: Date.now(), root, byHash: bucket });
      }

      // ★ stash 桶落盘（只在有台账的项目里写）。
      let stashResult = { ok: false, count: 0 };
      if (stash.length > 0) {
        stashResult = persistStash(root, info, sid, stash, {
          source: "manual",
          kept: keep.length,
          dropped: drop.length,
        });
      }

      return {
        ok: true,
        kept: keep.length,
        stashed: stashResult.ok === true ? stashResult.count : 0,
        dropped: drop.length,
        stashPath: stashResult.rel ?? null,
        overflow,
        mode: modeOf(info),
        // ★★ 如实回报收下了几块的权重答案（没传就是 0 ⇒ 那一维跳过，不是错误）。
        weightsScored: weightAccepted,
        note:
          `分流完成：留 ${keep.length} 条（压缩后逐字重注） · ` +
          `落 ${stashResult.ok === true ? stashResult.count : 0} 条` +
          (stashResult.ok === true ? `到 \`${stashResult.rel}\`` : `（未落盘：${stashResult.reason}）`) +
          ` · 丢 ${drop.length} 条。` +
          (weightAccepted > 0
            ? `\n★ 已收下 **${weightAccepted} 块**的是/否判分 ⇒ 它们参与"该注入哪几块"的排序`
            : "\n★ 本次**未判分**（`weights` 没传）⇒ 该维度跳过，排序退化成只看星与结构。不影响准确性。") +
          (overflow > 0
            ? `\n★ keep 超上限 ${keepMax}，**已截掉 ${overflow} 条**（按你给的顺序保留前 ${keepMax} 条）。`
            : "") +
          "\n★ 提醒：**留得太多等于没压。** keep 只放「下一轮不知道就会做错」的东西。",
      };
    },
  };
}

/**
 * ⑦ ledger_log —— 回溯读活动日志（**不注入上下文**，只在需要时读切片）。
 */
/**
 * ★★★ `ledger_recall` —— 把被压缩换掉的历史**按需读回逐字原文**（含推理过程）。
 *
 * 它补的是本项目最核心的那个缺口（承 DECISIONS D46 / D76–D80）：
 *   压缩把一段对话换成摘要（有损），而**原文其实还在**会话日志里
 *   （内核 `dsh-session` 的只追加日志；`session.eventAt(seq)` 可以直接取）
 *   —— 只是**模型不知道去哪找**。
 *   ⇒ 本工具 + 压缩后注入的「被压段索引」= 可回溯、可重建。
 *
 * ★ 只读：绝不写任何东西（这一条比什么都重要 —— 回读不该有副作用）。
 */
function defineRecallTool(state) {
  return {
    name: "ledger_recall",
    description:
      "Read back the VERBATIM original text of a span that compaction replaced with a summary " +
      "(including the model's reasoning blocks and tool calls). The append-only session log still " +
      "holds the originals; this tool makes them retrievable. Use the seq ranges printed in the " +
      "'被压掉的历史' index after a compaction — do not guess from the summary. Read-only. " +
      "Output is capped (see maxChars); page through with from/to when truncated.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "number", description: "Start seq (inclusive), as printed in the index." },
        to: { type: "number", description: "End seq (inclusive). Keep spans modest; page if needed." },
        reasoning: {
          type: "boolean",
          description:
            "Include reasoning blocks (default true). Set false to read only the visible text and " +
            "tool calls — smaller and usually enough when you only need what was decided.",
        },
        maxChars: {
          type: "number",
          description: `Character cap (default and max ${numOf("recallMaxChars", RECALL_MAX_CHARS)}). The read stops at an event boundary and says so.`,
        },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const session = exec?.agent?.session;
      // ★ D138：面板可调 ⇒ 每次执行时取（不是启动时定死）。
      const recallCap = numOf("recallMaxChars", RECALL_MAX_CHARS);
      const r = readSessionRange(session, args?.from, args?.to, {
        maxChars: Math.min(recallCap, Number(args?.maxChars) || recallCap),
        reasoning: args?.reasoning !== false,
      });
      if (r.ok !== true) return { ok: false, reason: r.reason };
      return {
        ok: true,
        from: r.from,
        to: r.to,
        returned: r.events.length,
        chars: r.chars,
        truncated: r.truncated === true,
        reasoning: r.reasoning,
        // ★ 如实说明"这不是全部"：截断了就明确告诉模型下一段从哪起。
        ...(r.truncated === true
          ? {
              hint:
                "到字符闸门就停了（**只返回了前一段**）。要接着读，用上一次最后一条的 seq + 1 当 from。",
              nextFrom: r.events.length > 0 ? r.events[r.events.length - 1].seq + 1 : r.from,
            }
          : {}),
        events: r.events.map((e) => ({ seq: e.seq, type: e.type, text: e.text })),
      };
    },
  };
}

function defineLogTool() {
  return {
    name: "ledger_log",
    description:
      "Read back the project's activity log. The log is NEVER injected into context — call this " +
      "only when you actually need history. Buckets are weekly (YYYY-MM/weekN) and share the " +
      "archive's period key, so one query spans the archived ledger entries and the log of the " +
      "same week. Levels: L0 milestones, L1 turn summaries (written by you), L2 file flow, " +
      "L3 tool flow. views: \"timeline\" (default, chronological), \"files\" (deduped per path), " +
      "\"failures\" (only failed tool calls), \"raw\". Read-only.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        levels: {
          type: "array",
          items: { type: "string", enum: LOG_LEVEL_NAMES },
          description: "Restrict to these levels. Default: all four.",
        },
        since: {
          type: "string",
          description:
            "Only entries at or after this local time. \"YYYY-MM-DD\" or \"YYYY-MM-DD HH:MM[:SS]\". " +
            "Pass the previous call's nextCursor to page forward.",
        },
        until: {
          type: "string",
          description: "Only entries at or before this local time. Same formats as since.",
        },
        grep: { type: "string", description: "Case-insensitive substring filter on the raw line." },
        view: {
          type: "string",
          enum: ["timeline", "files", "failures", "users", "audit", "raw"],
          description:
            "How to shape the result. Default timeline. 'users' returns only the archived USER " +
            "messages (L4) grouped by session tag — use it to answer 'what did the user say about " +
            "X'. L4 is excluded from the default level set, so ask for it explicitly.",
        },
        limit: {
          type: "number",
          description: `Max entries to return (1-${LOG_MAX_LIMIT}, default ${numOf("logDefaultLimit", LOG_DEFAULT_LIMIT)}).`,
        },
      },
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      return logRead(rootFromExec(exec, args), args);
    },
  };
}

/**
 * L1 每条字段的截断长度，以及整行上限。
 *
 * ★ 为什么必须截：L1 是**一行一条**（见 `writeLog` 的注释），没有这个上限，
 *   一次啰嗦的摘要能写出几千字符的单行，把 timeline 视图整段挤爆。
 */
const LOG_L1_FIELD_CHARS = 240;
const LOG_L1_LINE_CHARS = 1200;

/**
 * ⑧ ledger_log_write —— AI 写 L1 回合摘要。
 *
 * ★ 为什么单独一个工具而不是复用 `ledger_write`：活跃台账是**会被 replace 覆盖、
 *   会参与归档**的东西；而日志是**只追加、永不改写**的。两者的写语义相反，
 *   共用一个工具迟早会有人拿 replace 去写日志。
 *
 * ★★ 为什么是**一行**而不是漂亮的 `### 标题` + 多行 bullet：
 *   日志的**整体不变量是「一行 = 一条」**（解析、grep、limit、nextCursor 全建立在
 *   它上面）。多行块会同时坏掉三件事，而且是我实测撞上的：
 *     ① 读者把 `#` 开头的行当注释跳过 ⇒ **带时间戳与标题的那一行被整条丢掉**，
 *        L1 因此完全读不出来；
 *     ② 每条 bullet 各自被解析成"没有时间戳的条目"，一次摘要就往 timeline 里
 *        灌 5 条噪音；
 *     ③ `limit` / `nextCursor` 于是按 bullet 而不是按回合计数。
 *   所以宁可牺牲排版：一条 L1 = 一行。
 */
function writeLog(root, args) {
  const info = inspect(root);
  if (logDirOf(info) === undefined) {
    return {
      ok: false,
      reason: "这个项目还没有启用活动日志。请先 `ledger_init` 并传 `logDir`（例如 `_ledger-log`）。",
      ...(info.logGuess === undefined ? {} : { logDirFoundButNotEnabled: info.logGuess }),
      hint: "ledger_init",
    };
  }
  const title = typeof args?.title === "string" ? args.title.trim() : "";
  if (title === "") return { ok: false, reason: "title 不能为空 —— 一条摘要至少要有句话说明这轮干了什么。" };

  const now = new Date();
  const cut = (v) => {
    const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
    return s.length > LOG_L1_FIELD_CHARS ? s.slice(0, LOG_L1_FIELD_CHARS) + "…" : s;
  };
  const parts = [
    ["要什么", cut(args?.goal)],
    ["做了什么", cut(args?.did)],
    ["改了", cut(args?.files)],
    ["卡点", cut(args?.issues)],
    ["下一步", cut(args?.next)],
  ]
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}：${v}`);

  let line = `- ${stampSec(now)} (L1) ${cut(title)}`;
  if (parts.length > 0) line += ` ｜ ${parts.join(" ｜ ")}`;
  if (line.length > LOG_L1_LINE_CHARS) line = line.slice(0, LOG_L1_LINE_CHARS) + "…";

  const fileRel = logFileRel(info, "L1", now);
  const abs = path.resolve(root, fileRel);
  if (!isUnder(root, abs)) throw fail("ledger_log_write: 目标逃出了项目根");

  let created = false;
  try {
    created = !fs.existsSync(abs);
    ensureDir(path.dirname(abs));
    if (created) fs.appendFileSync(abs, `# L1 回合摘要 · ${info.logRel}\n`, "utf8");
    // ★ 只追加，永不 replace。
    fs.appendFileSync(abs, line + "\n", "utf8");
  } catch (e) {
    return { ok: false, reason: `写入日志失败：${String((e && e.message) || e)}`, path: abs };
  }

  let staged;
  if (info.manifest?.autoGitAdd !== false && fs.existsSync(path.join(root, ".git"))) {
    const r = gitAdd(root, [fileRel]);
    staged = r.ok ? true : r.stderr || r.error || "git add 失败";
  }

  return {
    ok: true,
    level: "L1",
    path: abs,
    relative: fileRel,
    created,
    chars: Buffer.byteLength(line, "utf8"),
    ...(staged === undefined ? {} : { staged }),
  };
}

/** ⑧ ledger_log_write 的工具外壳。 */
function defineLogWriteTool(state) {
  return {
    name: "ledger_log_write",
    description:
      "Append one L1 turn summary to the project's activity log — the ONLY log level a machine " +
      "cannot fill in, because it carries intent (why, what was blocked, what is next) rather " +
      "than what merely happened. L0/L2/L3 are collected automatically and need no call. " +
      "Append-only: it never rewrites what is already in the log. Call it at a natural stopping " +
      "point, typically right before answering the ledger_checkpoint card.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        title: {
          type: "string",
          description: "One short line naming what this turn was about. Required.",
        },
        goal: { type: "string", description: "What the user asked for." },
        did: { type: "string", description: "What was actually done." },
        files: { type: "string", description: "Key files added/changed (free text)." },
        issues: { type: "string", description: "What is blocked, uncertain, or half-done." },
        next: { type: "string", description: "What the next step is." },
      },
      required: ["title"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const r = writeLog(rootFromExec(exec, args), args);
      // ★★ L1 写成功也算"这一轮已落袋"（压缩前那道闸门认台账与 L1 任一）。
      if (r.ok === true) noteFlushed(state, exec);
      return r;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// /ledger 命令
// ═══════════════════════════════════════════════════════════════════════════

/** 命令返回给用户的那句话（AI 的正式回答走注入那条路）。 */
function commandText(summary, detail) {
  return detail === undefined ? summary : `${summary}\n\n${detail}`;
}

/**
 * 处理 /ledger <sub>。
 *
 * ★ 分工是刻意的：`show` / `status` 是**纯读**，当场就能给用户看结果；
 *   `init` / `update` / `archive` 需要 AI 判断内容 ⇒ 这里只**置一个待办标记**，
 *   由下一次 `agent/pre-step` 注入一条明确指令给 AI。
 *   这么分的原因：命令处理器里没法可靠地"替 AI 做判断"，
 *   而且任何会话内容的写入都不该由命令悄悄完成（写坏历史是本机的真实事故）。
 */
/**
 * `/ledger` 的子命令表。
 *
 * ★ 这张表同时驱动三件事：**帮助文本**、**命令补全提示**、以及**裸 `/ledger` 弹出的选择卡片**。
 *   三者共用一份数据，才不会出现"卡片里有 log、帮助里没有"这种分叉。
 */
const LEDGER_SUBCOMMANDS = [
  { sub: "status", label: "看状态（只读）", description: "有没有台账、用的哪个文件、几行、Git、日志开关。" },
  { sub: "show", label: "显示活跃台账", description: "把当前活跃台账全文打出来。" },
  { sub: "init", label: "初始化台账", description: "由 AI 为这个项目设计一套结构，并 git init。" },
  { sub: "update", label: "把进展写回台账", description: "让 AI 把本次会话的进展写进活跃台账。" },
  { sub: "archive", label: "归档旧条目", description: "让 AI 把最旧的已完成条目移进归档目录。" },
  {
    sub: "compact",
    label: "手动全量压缩（高保真）",
    description:
      "立刻做一次**全量**压缩：保留指向所需东西的指针（你的原话/报错原文/改过哪些文件/去哪重读），压完注回来。",
  },
  {
    sub: "light",
    label: "手动轻量压缩（增量）",
    description:
      "立刻做一次**轻量**压缩：**只压最旧一段、保留最近一大块**。水位小幅回落，新近细节完整保留。",
  },
  { sub: "log", label: "看活动日志状态", description: "四档粒度开没开、有多少文件。不注入上下文。" },
  {
    sub: "mode",
    label: "切换压缩模式（正常推进 / 反复追究）",
    description:
      "在「**正常推进**」（按位置压最旧一段，省一次模型输出）与「**反复追究**」" +
      "（压缩前由 AI 分流：留上下文 / 落进项目 `_stash/` / 丢掉）之间切换。" +
      "★ 写进**这个项目**的 `.dsh-ledger.json`，只影响本项目；不带参数则只报当前模式。",
  },
  {
    sub: "lock",
    label: "把本场对话锁到某个项目目录",
    description:
      "对话建在**总工作区**（装着多个项目）时用：`/ledger lock 子项目路径` ⇒ " +
      "此后本会话所有工具都落在那个目录上，不必每次传 `root`。" +
      "★ 锁定**会记住**（重启/关掉再开都还在），**每场对话各记各的**；" +
      "记录放在 DSH 自己的 `plugin-data` 里，**不在你的工作区里**。" +
      "`/ledger lock` 看状态 · `/ledger lock off` 解锁。",
  },
  {
    sub: "handoff",
    label: "写交接单（给下一场会话）",
    description:
      "让 AI 用 `ledger_handoff` 写一份交接单，落到项目约定位置；**下一场会话开在这里时会被自动引导去读它**。",
  },
];

/**
 * `/ledger` 的命令提示文字与描述 —— **从 `LEDGER_SUBCOMMANDS` 生成**。
 *
 * ★★★ 为什么要生成而不是手写（2026-10-09 用户报的缺陷）：
 *   这两处原来是**手抄**的字符串，抄的时候漏了 `compact`：
 *     `"…（status / show / init / update / archive / log）"`  ← 没有 compact
 *     `hint: "[回车=选择卡片 | status | show | init / update / archive / log]"`
 *   ⇒ 用户敲 `/ledger` 时**看不到压缩那条**，而卡片里其实有 ——
 *   两处口径分叉，且分叉的方向恰好是"用户以为没有这个功能"。
 *   ★ 现在单一来源：加/删子命令只改上面那张表，提示与描述自动跟上。
 *   （自检里有断言钉住"提示里必须带上每一个子命令"。）
 */
function ledgerInputHint() {
  return `[回车=选择卡片 | ${LEDGER_SUBCOMMANDS.map((s) => s.sub).join(" | ")}]`;
}
function ledgerCommandDescription() {
  return `项目台账：直接敲 /ledger 会弹可点的选择卡片（${LEDGER_SUBCOMMANDS.map((s) => s.sub).join(" / ")}）。`;
}

/** 裸 `/ledger` 选择卡片的等待上限。理由见 `pickLedgerSub`。 */
const LEDGER_PICK_TIMEOUT_MS = 120_000;

/** `/ledger` 的帮助文本（`/ledger help` 直接打印，卡片超时也回退到它）。 */
function ledgerHelpText(note) {
  return (
    "**/ledger** —— 项目台账\n\n" +
    (note === undefined ? "" : `${note}\n\n`) +
    LEDGER_SUBCOMMANDS.map((s) => `- \`/ledger ${s.sub}\`　${s.description}`).join("\n") +
    "\n\n> 直接敲 `/ledger`（不带参数）会弹一张**可点的选择卡片**；" +
    "命令行本身只支持手打子命令，这是平台限制（命令的 input 只能是提示文字）。"
  );
}

/**
 * 裸 `/ledger` ⇒ 弹一张可点的卡片让用户选功能。
 *
 * ★ 为什么要卡片：平台**不允许**命令自带二级选项菜单 —— `dsh-commands` 校验命令定义时
 *   只接受 `input.hint`（字符串）与可选 `attachments`：
 *     `if (!("hint" in rawInput) || typeof rawInput.hint !== "string") throw ...`
 *   所以命令这一层没法渲染"子命令下拉"，全靠用户手打。官方 `/goal` 也只能把
 *   `[<objective>|clear|edit <objective>|pause|resume]` 当**提示文字**写出来。
 *
 * ★ 但 handler 是**被 await 的**，而且 `dsh-commands` 里**没有任何超时**
 *   （该文件内 timeout/TIMEOUT/setTimeout 命中 0 次），所以命令里弹卡片等用户点是合法的。
 *
 * ★ 必须自己给超时：卡片被**关掉（dismiss）时那条 waterfall 不结算**，
 *   不给 signal 的话 `/ledger` 会永远挂着。给 `AbortSignal.timeout` 之后，
 *   超时/丢弃都会走到 `catch` ⇒ 回退成打印帮助文本。
 */
async function pickLedgerSub(ctx, invocation) {
  const uq = ctx.get("userQuestions");
  if (uq === undefined || typeof uq.ask !== "function") return undefined;
  const agent = invocation?.agent;
  try {
    const result = await uq.ask({
      questions: [
        {
          id: "ledger-subcommand",
          question: "要对这个项目做哪件事？",
          header: "项目台账",
          options: LEDGER_SUBCOMMANDS.map((s) => ({ label: s.label, description: s.description })),
        },
      ],
      ...(agent === undefined ? {} : { agent }),
      signal: AbortSignal.timeout(LEDGER_PICK_TIMEOUT_MS),
    });
    const first = Array.isArray(result?.answers) ? result.answers[0] : undefined;
    const selected = Array.isArray(first?.selected) ? first.selected[0] : undefined;
    const hit = LEDGER_SUBCOMMANDS.find((s) => s.label === selected);
    if (hit !== undefined) return hit.sub;
    // 用户没点选项、而是自己打了字（打 `log` 也能用）。
    const custom = typeof first?.custom === "string" ? first.custom.trim().toLowerCase() : "";
    if (custom !== "") {
      const word = custom.split(/\s+/)[0];
      const byWord = LEDGER_SUBCOMMANDS.find((s) => s.sub === word);
      if (byWord !== undefined) return byWord.sub;
    }
    return undefined;
  } catch {
    // 超时 / 无应答者 / agent 不是活 root / 卡片被丢弃 ⇒ 一律回退到帮助文本。
    return undefined;
  }
}

/**
 * ★★★ 手动 `/ledger compact`：**能立刻压就立刻压**（2026-10-09 用户要求）。
 *
 * 用户原话：*"为什么这些指令都不是马上执行呢？感觉和官方的压缩不一样，
 * 这容易导致有时候到水位的时候主动按压缩不能进行，比较危险。"*
 *
 * ★ 查清了"为什么等不到"（读内核 `dsh-agent-loop` 真源码，非猜）：
 *   `agent/status` **只在状态真的变化时才发**（`:790-798`
 *   `if (status !== previousStatus) this.dispatch.emit("agent/status", …)`）。
 *   ⇒ 用户**在空闲时**敲命令 → 排队 → 等一个永远不会再发的 `idle` 事件
 *   → **压缩永远不发生**。这正是他说的"按了不能进行"。
 *
 * ★ 官方 `/compact` 的做法就是直接 await（`dsh-command-compact`：
 *   `await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)`）。
 *   我们原来非要多等一个回合，没有理由 —— 命令 handler 本来就被 await、平台不设超时
 *   （`dsh-commands` 里 timeout 命中 0 次），所以当场压完是合法的。
 *
 * @returns {Promise<object>} 命令结果（`{kind, text}`）
 */
async function runManualCompactNow(ctx, invocation, state, capsule, root) {
  const agent = invocation?.agent;
  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid === "") {
    return { kind: "error", text: "拿不到本会话的 id，无法压缩。" };
  }
  const key = String(sid);

  // ① 先看能不能当场压。**没有服务**要如实说，不能假装排队成功。
  const compaction = compactionServiceFor(ctx, agent);
  if (compaction === undefined) {
    return {
      kind: "error",
      text: "本机没有 `compaction` 服务，无法压缩。（台账功能不受影响。）",
    };
  }

  // ② 抓胶囊（压缩一跑，会话记忆的去重集合就变了 ⇒ 必须**压前**抓）。
  let capsuleChars = 0;
  try {
    const info = inspect(root);
    const snap = renderCapsule(info, capsule?.get?.(key));
    if (snap !== undefined) {
      state.capsuleSnapshot.set(key, snap);
      capsuleChars = snap.length;
    }
  } catch {
    /* 抓不到就不抓，别挡住压缩 */
  }

  // ③ ★ 当场压。`runHighFidelityCompact` 会走同一道闸门 —— 而它认得
  //    `source: "command"`（人手动发起）⇒ 即便没落盘也**放行**（见 `MANUAL_COMPACT_SOURCES`）。
  const r = await runHighFidelityCompact(ctx, state, agent, capsule, "command");

  if (r.ok === true && r.compressed === true) {
    return {
      kind: "success",
      text:
        "**已压缩**（立刻执行，未等回合结束）\n\n" +
        "- 触发：`/ledger compact`（手动）\n" +
        (capsuleChars === 0 ? "" : `- 逐字胶囊：**${capsuleChars} 字符**（下一次注入时随台账一起注回）\n`) +
        // ★ D45：把"存到哪了"直接给出来 —— 可回溯的前提是**知道去哪找**。
        (r.capsuleRel !== undefined
          ? `- ★ 胶囊已**存盘**：\`${r.capsuleRel}\`（原件，可 diff；重启后仍在，压缩链再压也不动它）\n`
          : r.capsulePersistReason !== undefined
            ? `- ⚠ 胶囊**没存盘**：${r.capsulePersistReason}\n`
            : "") +
        (r.flushGate === undefined ? "" : `- 落盘闸门：${r.flushGate}\n`) +
        "\n★ 这是**我们的**压缩，不是内核的 `/compact`：它会先保住" +
        "**你说过的原话、报错原文、改过哪些文件、去哪重读**，压完再注回来。",
    };
  }

  // ④ 压不成 —— 分情况**如实**回报，并按需退回队列。
  //
  //   ★ 这里的关键：**只有"忙"才值得排队**。其余情形（没有可压的历史 /
  //     没有 compaction 服务）排了也白排 —— 那会变成"说已排队，然后永远不发生"。
  //
  // ★★★ 2026-10-12 修（真机事故，用户 01:13 亲自撞上）：**判据原来只认文本，漏了 2/3。**
  //   内核的 `busy` 有**三条**原文（`dsh-compaction-basic`）：
  //     ① `manual compaction: the session already has an open turn`（`:457`）← 旧正则认得
  //     ② `…compaction already in progress; the session compaction lock is already active`（`:538`）← 漏
  //     ③ `manual compaction requires an idle agent with no waking queued work`（`:1009`）← 漏
  //   ⇒ 用户撞的是 ③ ⇒ 插件判成"失败" ⇒ 回「**压缩没有发生**」，
  //     而那一刻**自动全量正在跑**（被压 428,652 tok）⇒ 把"正在做"说成了"没发生"。
  //   ★ 现在**优先判结构化 `code`**（三条 busy 全是 `"busy"`，一次就够、且不怕内核改文案）；
  //     文本正则**保留为兜底** —— 夹具 / 老内核 / 别的实现可能只给 message。
  //     （两个判据都给会"双保险"，但**注释必须写明主次**，否则后人不知道该信哪个。）
  const reason = String(r.reason ?? "未知原因");
  const codeBusy = r.errorCode === "busy";
  const textBusy = /busy|open turn|已有活跃|not idle|already has active work|idle agent|waking queued|compaction lock/i.test(
    reason
  );
  const busy = codeBusy || textBusy;

  if (busy) {
    state.hfCompactAfterTurn.set(key, { at: Date.now(), source: "command" });
    return {
      kind: "success",
      text:
        "**已排队：高保真压缩**\n\n" +
        "- 触发：`/ledger compact`（手动）\n" +
        "- ★ 现在**压不了**（`compaction` 要求 agent 空闲且没有打开的回合）：" +
        `${reason}\n` +
        "- 已退回队列：本回合结束后（agent 空闲时）自动执行，**你不需要再按一次**。",
    };
  }

  return {
    kind: "error",
    text:
      `压缩没有发生：${reason}` +
      (r.hint === undefined ? "" : `\n\n建议：\`${r.hint}\``) +
      // ★★★★★ 2026-10-13（D166）：把内核那句固定文案的**真因**摊开。
      //   ★ 见 `compactionFailureAdvice` 的注释（真机：provider 断流被内核一律写成
      //     "could not produce a smaller summary"，我们原样转述 ⇒ 用户分不清
      //     「重试就行」与「按了也白按」）。
      //   ★ 按**独立块**渲染（不用行内代码块）：它可能多行、且自身带 markdown。
      (r.causeNote === undefined ? "" : `\n\n${r.causeNote}`),
  };
}

/**
 * 手动**轻量**压缩（`/ledger light`）。
 *
 * ★★★ 为什么不能像 `compact` 那样"当场直接压"：
 *   `compactNow`（全量那条）走的是 `agent.runMaintenance(…)` + **`owner: null`**，
 *   所以它**要求 idle**；而增量用的 **`compactRegion` 把 `owner` 硬编成 `"current-turn"`**
 *   （`compaction-basic:971-976`）⇒ 它**要求有打开的回合**，idle 时调用会抛
 *   *"compactRegion: no open turn"*（`:460`）。
 *   ★ 我又确认过 `dsh-compaction-basic` 的 export **只有引擎类**
 *     （`export { BasicCompactionEngine, … }`），**没有**可单独调用的低层函数 ——
 *     所以"在 idle 里手工选一段范围压掉"这条路**走不通**。
 *
 * ⇒ 正解是**复用那条已经被证明能跑的 in-turn 路径**：
 *   ① 在这里立一个「下一次 pre-step 强制压」的旗子；
 *   ② `agent.steer()` 唤醒一轮（与 `init/update/archive` 同一个唤醒口，已验证）；
 *   ③ 那一轮的 `agent/pre-step` 看到旗子 ⇒ `runIncrementalCompact(force)` 压掉最旧一段。
 *
 * ★ 用户价值：他按一下就能**立刻**做一次轻量压缩，不必等水位涨到 20 点。
 */
async function runManualLightCompactNow(ctx, invocation, state, root) {
  const agent = invocation?.agent;
  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid === "") {
    return { kind: "error", text: "拿不到本会话的 id，无法压缩。" };
  }
  const key = String(sid);

  // ① 先如实检查服务在不在（不在就别假装成功了）。
  const compaction = compactionServiceFor(ctx, agent);
  if (compaction === undefined || typeof compaction.compactRegion !== "function") {
    return {
      kind: "error",
      text:
        "本机没有可用的 `compaction` 服务（或它不支持 `compactRegion`），无法做轻量压缩。\n\n" +
        "（台账功能不受影响。全量压缩 `/ledger compact` 走的是另一个方法，可以另试。）",
    };
  }

  // ② 立旗子：下一次 pre-step 强制压（不看涨幅、不看落盘闸门）。
  state.deltaForce.set(key, { at: Date.now(), source: "command" });

  // ③ 唤醒一轮，让 pre-step 真的跑到（idle 时不唤醒就什么都不会发生 —— 这正是 D40 那个坑）。
  let steered = false;
  if (typeof agent.steer === "function") {
    try {
      agent.steer({
        id: randomUUID(),
        // ★ 内容刻意**短**：这轮的目的只是"把 pre-step 触发起来"，
        //   真正该进上下文的东西（台账 + 逐字胶囊）由 pre-step 自己注入。
        content: [
          {
            type: "text",
            text:
              "（插件指令，不是用户的话）用户刚敲了 `/ledger light`，要求立刻做一次**轻量压缩**。" +
              "插件会在本轮的 pre-step 里完成它，**你不需要做任何事**；" +
              "如果本轮结束时你看到压缩提示，照常继续手上的工作即可。",
          },
        ],
        source: { kind: INJECT_KIND, form: "instructions" },
        role: "user",
      });
      steered = true;
    } catch {
      steered = false;
    }
  }

  return {
    kind: "success",
    text:
      "**已请求：轻量（增量）压缩**\n\n" +
      "- 触发：`/ledger light`（手动）\n" +
      "- 做法：**只压最旧一段、保留最近一大块**（不碰新近细节）\n" +
      (steered
        ? "★ **立刻执行**：已把这一步推进 AI 的下一步，插件会在它的 `pre-step` 里压掉。\n"
        : "⚠ 没能唤醒 AI（它当前不便被唤醒）⇒ 这条请求会在它的下一步生效。\n") +
      "\n★ 与 `/ledger compact` 的区别：`compact` 是**全量**（压到很小、保留指针），" +
      "`light` 是**轻量**（只压最旧一段，水位小幅回落）。",
  };
}

/**
 * 真正执行一个子命令。**卡片选中的与手打的走的是同一条路** ——
 * 同一个子命令无论从哪个入口进来，后果必须一模一样。
 */
async function runLedgerSub(ctx, invocation, state, sub, capsule, argument) {
  const root = projectRootOf(invocation?.agent);
  if (root === undefined) {
    return { kind: "error", text: "找不到本会话的工作目录，无法定位项目。" };
  }

  // ── 手动高保真压缩（需求 ②）────────────────────────────────────────────
  //
  // ★ 这条**不看台账有没有建**：压缩是会话级的事，与项目里有没有台账无关。
  //   （若强行要求台账存在，用户在一个还没建台账的目录里就压不了 —— 没道理。）
  // ★★ 2026-10-09：改成**立刻执行**（原来只排队，用户实测"按了不进行"）。
  //   见 `runManualCompactNow` 的注释：空闲时排队等的是**永远不会再发**的 idle 事件。
  if (sub === "compact") {
    return await runManualCompactNow(ctx, invocation, state, capsule, root);
  }

  // ── 手动**轻量**（增量）压缩 ──────────────────────────────────────────
  //   ★ 它**不能**像 `compact` 那样在这里直接压 —— 增量用的 `compactRegion`
  //     硬编了 `owner:"current-turn"`、要求回合开着，而命令是在 idle 跑的。
  //     详见 `runManualLightCompactNow` 的注释。
  if (sub === "light") {
    return await runManualLightCompactNow(ctx, invocation, state, root);
  }

  // ── `/ledger mode [steady|surgical]` —— 切换本项目压缩模式（2026-10-10）──
  //
  // ★ 为什么**写进项目清单**而不是全局设置：模式是**项目**的性质（见 `modeOf`）。
  //   写全局会把别的项目一起改掉 —— 而那正是用户明确排除的（他选的是"项目级"）。
  // ★ 为什么**必须**有这条命令：设置面板那一项的 hint 里写了"也可以用 `/ledger mode`
  //   随时切换"。写了就得有，否则是空承诺（本文件反复强调的那条纪律）。
  if (sub === "mode") {
    const info = inspect(root);
    const want = typeof argument === "string" ? argument.trim().toLowerCase() : "";
    const cur = modeOf(info);
    const label = (m) => (m === MODE_SURGICAL ? "反复追究" : "正常推进");

    if (info.activeRel === undefined) {
      return {
        kind: "error",
        text:
          "这个项目还没有台账，写不了模式（模式登记在 `.dsh-ledger.json` 里）。\n\n" +
          "先 `/ledger init`，或直接给工具传 `root` 点名一个有台账的项目。",
      };
    }
    // 不带参数 = 只报当前模式（只读，不改任何东西）。
    if (want === "") {
      const suspect = modeManifestSuspect(info);
      return {
        kind: "success",
        text:
          `**压缩模式：${label(cur)}**（\`${cur}\`）\n\n` +
          (suspect
            ? `⚠ 清单里的 \`mode\` 是 \`${JSON.stringify(info.manifest?.mode)}\`，**不认识** ⇒ ` +
              `当前按默认的「${label(MODE_STEADY)}」在跑。\n\n`
            : "") +
          "· `正常推进`（steady）：压缩时**按位置**只压最旧一段、保留最近一段。" +
          "省一次模型输出，适合一路向前干活。\n" +
          "· `反复追究`（surgical）：压缩**前**先让 AI 分三个桶 —— " +
          "`keep` 留上下文（压缩后逐字注回）/ `stash` 落进项目 `_stash/`（不占上下文，按需查）/ " +
          "`drop` 丢掉。适合要反复回看约束与假设的活。\n\n" +
          `切换：\`/ledger mode steady\` 或 \`/ledger mode surgical\`。` +
          (info.manifest?.mode === undefined
            ? "\n\n（当前项目清单里**没有**登记 mode ⇒ 走的是设置面板里的默认值。）"
            : `\n\n（当前项目清单里登记的 mode = \`${info.manifest.mode}\`。）`),
      };
    }
    if (!MODES.includes(want)) {
      return {
        kind: "error",
        text:
          `认不出模式 \`${want}\`。只有两个：\`steady\`（正常推进）、\`surgical\`（反复追究）。\n\n` +
          "★ 这里**故意不改**任何东西 —— 打错一个字就静默退到默认，" +
          "会让用户以为切过去了（配置类功能最难查的失败模式）。",
      };
    }
    const r = writeManifestMode(root, info, want);
    if (r.ok !== true) {
      return { kind: "error", text: `写清单失败：${r.reason}` };
    }
    return {
      kind: "success",
      text:
        `已把**这个项目**的压缩模式切到「**${label(want)}**」（\`${want}\`）。\n\n` +
        `登记位置：\`${path.join(root, MANIFEST_REL)}\`\n\n` +
        (want === MODE_SURGICAL
          ? "★ 下一档水位提醒（70%）起，压缩前会要求你做一次 `ledger_triage` 分流，" +
            "压完把 `keep` 桶**逐字注回**。\n"
          : "★ 已回到常态：压缩只按位置压最旧一段，不再要求分流。\n") +
        "★ 这项**只影响本项目** —— 别的项目各按自己清单里的模式走。",
    };
  }

  // ── `/ledger lock [子项目路径]` —— 把本场对话锁到一个项目目录（2026-10-10）──
  //
  // ★ 用户原话：*"可以让用户和AI说之后AI调用，或者说把项目注册到对应的文件夹上，
  //   以后各种工具的使用都在那个文件夹上。"* + *"最开始的提示卡片就可以有这样的选择。"*
  // ★ 与 `ledger_lock` 工具**共用** `setProjectLock` / `lockedRootOf` ——
  //   命令与工具走同一条路（本文件反复强调：两个入口必须后果一模一样）。
  // ★ 不带参数 = 报当前锁定状态（若已锁则解锁？不 —— 那太危险）。
  //   这里是**只读报告**；要解锁得明确说 `/ledger lock off` 或 `none`。
  if (sub === "lock") {
    const want = typeof argument === "string" ? argument.trim() : "";
    const cur = lockedRootOf(invocation?.agent);
    const show = (extra) =>
      ({
        kind: "success",
        text:
          extra +
          `\n**当前锁定**：${cur === undefined ? "（无 —— 按会话工作目录解析）" : `\`${cur}\``}\n\n` +
          "用法：\n" +
          "· `/ledger lock <路径>` —— 锁到那个目录（相对路径按当前工作目录解析）\n" +
          "· `/ledger lock off` —— 解锁，回到按会话工作目录解析\n\n" +
          "★ 锁定**会记住**：重启、关掉再开都还在；**每场对话各记各的**，互不影响。\n" +
          `★ 记录放在 **DSH 自己的家**（\`plugin-data\\dsh-ledger-memory\\locks.json\`），` +
          "**不在你的工作区里** —— 你的项目目录不会因此多出任何文件。\n" +
          "★ 要彻底取消，`/ledger lock off` 一次即可（内存与记录一起删）。",
      });

    if (want === "") return show("**锁定状态（只读）**：这条命令不带参数时什么都不改。\n");
    if (["off", "none", "clear", "unlock", "-"].includes(want.toLowerCase())) {
      const r = setProjectLock(invocation?.agent, undefined);
      return show(
        r.wasLocked === true
          ? `已**解锁**${r.wasLockedRoot ? `（原锁定：\`${r.wasLockedRoot}\`）` : ""}，记录也一并删了。`
          : "本来就**没有锁** —— 什么都没变。"
      );
    }

    const base = projectRootOf(invocation?.agent);
    const abs = path.resolve(base ?? process.cwd(), want);
    const r = setProjectLock(invocation?.agent, abs);
    if (r.ok !== true) return { kind: "error", text: r.reason };
    const info = inspect(abs);
    return show(
      `已锁定到 \`${abs}\`${r.persisted === true ? "，**已经记住了**（重启也还在）" : "（⚠️ 记录没写成，只在本次生效）"}。\n\n` +
        (info.activeRel !== undefined
          ? `这个目录有台账：\`${info.activeRel}\`。`
          : "⚠️ 这个目录**还没有台账** —— 要让它有，接着让 AI 调 `ledger_init`。") +
        "\n"
    );
  }

  if (sub === "log") {
    const info = inspect(root);
    if (info.logRel === undefined) {
      const guess = info.logGuess;
      return {
        kind: "success",
        text:
          "**活动日志：未启用**\n\n" +
          (guess === undefined
            ? ""
            : `⚠ 项目里**有** \`${guess}\` 目录，但它没有登记进清单 ⇒ **日志并没有在采集**。` +
              `要让 AI 把清单的 \`logDir\` 设成 \`${guess}\`，登记之后才开始记。\n\n`) +
          "日志是**可选**的，没登记就不会往项目里写任何东西。要启用，让 AI 在 `ledger_init` 时传\n" +
          "`logDir`（例如 `_ledger-log`）；已经初始化过的项目也可以直接用工具改清单。\n\n" +
          "启用后：**L0 里程碑 / L2 文件流水 / L3 工具流水 / L4 用户消息存档**由插件**自动采集**\n" +
          "（不调用模型、不花 token），L1 回合摘要由 AI 写。五档都**永不注入上下文**，只在回溯时读切片。",
      };
    }
    const files = logFileList(info);
    const byLevel = new Map();
    let bytes = 0;
    for (const f of files) {
      byLevel.set(f.level, (byLevel.get(f.level) ?? 0) + 1);
      bytes += f.bytes;
    }
    const levels = info.logLevels;
    const onOff = LOG_LEVEL_NAMES.map((l) => `${l}${levels[l] ? "开" : "**关**"}`).join(" / ");
    return {
      kind: "success",
      text:
        "**活动日志**\n\n" +
        `- 目录：\`${info.logRel}\`\n` +
        `- 档位：${onOff}\n` +
        `- 文件：${files.length} 个（${LOG_LEVEL_NAMES.map((l) => `${l} ${byLevel.get(l) ?? 0}`).join(" · ")}），合计 ${(bytes / 1024).toFixed(1)} KB\n` +
        `- 每 ${info.manifest?.archiveWeekMode === "year" ? "年内周" : "月中周"} 一个子目录，与归档同期间键\n\n` +
        "档位含义：\n" +
        "- **L0** 里程碑 · **L2** 文件流水 · **L3** 工具流水 · **L4 用户消息存档** —— 全部**机器自动采集**（不调用模型、不花 token）；\n" +
        "- **L1** 回合摘要 —— 只有这档由 AI 写（`ledger_log_write`），因为只有它带「为什么」。\n\n" +
        "回溯交给 AI：`ledger_log`（可带 since / until / levels / grep，视图 timeline · files · failures · " +
        "**users** · raw）。\n" +
        "★ 看「用户说过什么」用 **`view:\"users\"`** —— L4 刻意**不在**默认档位里（量最大），要显式要。\n" +
        "★ 它**不注入上下文** —— 日志再大也不会挤占你的窗口。",
    };
  }

  if (sub === "status") {
    const info = inspect(root);
    // ★ 用户问的是「AI 自己把台账做了，我怎么知道」——
    //   `status` 是**他主动问**的地方，所以把最近的台账改动一并报出来。
    //   （被动告知走回合末卡片上的回执，见 `describeTouched`。）
    const recent = recentLedgerChanges(info, 5);
    // ★★★ 2026-10-11（D59 的教训）：把**本会话压缩了几次**报出来。
    //   用户那次是自己发现"一次压缩都没发生"的 —— 他本来不该需要自己发现。
    //   所以这个计数器必须出现在**他随手能查**的地方（`/ledger status`）。
    //   ★ 报的是**当前会话**：计数器按 sid 存，换会话就重新数（与闸门同口径）。
    const sid = invocation?.agent?.session?.header?.id;
    const cc = typeof sid === "string" ? compactCountsOf(state, sid) : undefined;
    const ccLine =
      cc === undefined
        ? "- **本会话压缩次数**：**0**（还没有压缩过）\n"
        : `- **本会话压缩次数**：**${cc.total}**（增量 ${cc.delta} · 全量 ${cc.full}）` +
          (cc.lastAt === undefined
            ? ""
            : `· 最近一次 ${new Date(cc.lastAt).toLocaleString("zh-CN")}` +
              (cc.lastSource === undefined ? "" : `（${cc.lastSource}）`)) +
          "\n";
    return {
      kind: "success",
      text:
        "**项目台账状态**\n\n" +
        `- 项目根：\`${root}\`\n` +
        `- 活跃台账：${info.activeRel !== undefined ? `\`${info.activeRel}\`` : "**无**"}` +
        (info.activeRel !== undefined ? `（${info.activeLines} / ${info.maxActiveLines} 行）` : "") +
        "\n" +
        ccLine +
        `- 关键决策：${info.decisionsRel !== undefined ? `\`${info.decisionsRel}\`` : "**无**"}\n` +
        `- 归档目录：${info.archiveRel !== undefined ? `\`${info.archiveRel}\`` : "**无**"}\n` +
        `- 活动日志：${
          info.logRel !== undefined
            ? `\`${info.logRel}\`（${LOG_LEVEL_NAMES.filter((l) => info.logLevels[l])
                .map((l) => l)
                .join("+") || "全关"}）`
            : "未启用"
        }\n` +
        `- Git 仓库：${info.isGitRepo ? "有" : "**没有**"}\n` +
        `- .gitignore：${info.hasGitignore ? "有" : "没有"}\n` +
        (info.overThreshold ? `\n⚠ 活跃台账已超过 ${info.maxActiveLines} 行，建议归档。\n` : "") +
        (recent.length === 0
          ? "\n**最近改动**：还没有记录（没启用日志，或还没人写过台账）。\n"
          : "\n**最近改动**（谁在什么时候动过这份台账）：\n" +
            recent.map((l) => `${l}\n`).join("") +
            "\n> 完整记录：让 AI 调 `ledger_log`（`view:\"audit\"`）。\n"),
    };
  }

  if (sub === "show") {
    const info = inspect(root);
    if (info.activeRel === undefined) {
      return {
        kind: "success",
        text: `这个工作区还没有台账。执行 \`/ledger init\` 让 AI 为它设计一套。`,
      };
    }
    if (!info.activeExists || info.activeAbs === undefined) {
      return { kind: "error", text: `台账文件 \`${info.activeRel}\` 读不到。` };
    }
    const rawText = readTextSafe(info.activeAbs) ?? "";
    const noteMax = numOf("maxReadChars", MAX_READ_CHARS);
    const body =
      rawText.length > noteMax
        ? rawText.slice(0, noteMax) + "\n\n…（过长，已截断）"
        : rawText;
    return {
      kind: "success",
      text:
        `**${info.activeRel}**（${info.activeLines} 行，上限 ${info.maxActiveLines}）\n\n` +
        "```markdown\n" +
        body +
        "\n```",
    };
  }

  if (sub === "init" || sub === "update" || sub === "archive" || sub === "handoff") {
    const agent = invocation?.agent;
    const sid = String(agent?.session?.header?.id ?? "");
    const pending = { command: sub, at: Date.now(), root };
    const what = {
      init: "为这个项目设计并初始化一套台账（含 Git）",
      update: "把本次会话的进展写回活跃台账",
      archive: "把最旧的已完成条目移进归档",
      handoff: "写一份交接单，给下一场会话接手用",
    }[sub];

    // ★★ 2026-10-09：**立刻唤醒一轮**让 AI 马上做，而不是干等用户再说一句话。
    //
    //   原来只 `state.pending.set(...)`，靠下一次 `agent/pre-step` 注入 ——
    //   而 pre-step 只在**有回合在跑**时才有。用户空闲时敲 `/ledger update`
    //   之后什么都不发生（要等他再随便说一句），这正是他说的
    //   *"这些指令都不是马上执行"*。
    //
    //   `agent.steer()` 是内核的正式唤醒口（`dsh-agent-loop:809-811`
    //   `steer → send(input, "next-step", true) → wakeDriver()`），而
    //   `wakeDriver` 在 idle 时会把 phase 置成 `running` 并 kick
    //   （`:854-868`）⇒ **真的起一轮**。回合末那张卡片本来就是这么做的
    //   （见 `offerTurnEndChoice` 里的 `agent.steer(...)`），所以这条路是验证过的。
    //
    //   ★ 失败就退回老的 `pending` 通道 —— 两条路都留着，任一可用即可。
    let steered = false;
    if (agent !== undefined && typeof agent.steer === "function") {
      try {
        agent.steer({
          id: randomUUID(),
          content: [{ type: "text", text: renderInjectionBody(inspect(root), pending) }],
          source: { kind: INJECT_KIND, form: "instructions" },
          role: "user",
        });
        steered = true;
      } catch {
        steered = false; // steer 不可用（例如会话正在收尾）⇒ 退回注入通道
      }
    }
    if (!steered && sid !== "") state.pending.set(sid, pending);

    return {
      kind: "success",
      text:
        `已请求 AI：**${what}**。\n\n` +
        (steered
          ? "★ **立刻就开始了**（已把这条指令直接推进 AI 的下一步，不需要你再说话）。"
          : "（AI 当前不便被唤醒 ⇒ 这条指令会在它的下一步注入；直接说句话或让它继续即可。）"),
    };
  }

  return {
    kind: "error",
    text:
      `未知子命令 \`${sub}\`。可用：` +
      LEDGER_SUBCOMMANDS.map((s) => s.sub).join(" / ") +
      "。直接敲 `/ledger` 可以点选。",
  };
}

/**
 * `/ledger` 的入口：解析子命令，裸敲时弹卡片。
 *
 * ★ 为什么是 async：裸 `/ledger` 要走 `pickLedgerSub`（等用户点选）。
 *   命令 handler 是被 await 的，且平台对它没有超时，所以这样是安全的。
 */
async function handleLedgerCommand(ctx, invocation, state, capsule) {
  const raw = String(invocation?.rawInput ?? "").trim();
  const sub = (raw.split(/\s+/)[0] ?? "").toLowerCase();
  // ★ 第二个及之后的词 = 参数（目前只有 `mode <steady|surgical>` 用）。
  //   ★ 平台**没有** `invocation.argument` 这个东西 —— 命令拿到的是整串 `rawInput`
  //     （见上面 `raw.split(/\s+/)[0]` 的原本写法）。所以要自己切出来，
  //     不能想当然地读一个不存在的字段（读了就是永远 `""`）。
  const rest = raw.split(/\s+/).slice(1).join(" ");

  // 显式帮助：不弹卡片，直接印文字（脚本化/观察时不该被一张卡片挡住）。
  if (sub === "help") return { kind: "success", text: ledgerHelpText() };

  // 裸 `/ledger` ⇒ 弹卡片点选。用户点了就等于手打了那个子命令。
  if (sub === "") {
    const picked = await pickLedgerSub(ctx, invocation);
    if (picked === undefined) {
      return { kind: "success", text: ledgerHelpText("（没有选择，以下是用法）") };
    }
    return await runLedgerSub(ctx, invocation, state, picked, capsule, "");
  }

  return await runLedgerSub(ctx, invocation, state, sub, capsule, rest);
}

// ═══════════════════════════════════════════════════════════════════════════
// apply()
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 挂上"下一次 pre-step 强制重注台账"的标记（压缩后）。
 *
 * ★ 键里带项目根：一个会话里换过工作目录时不至于认错台账。
 *   同时按 `session.header.id` 与 `session.id` 各挂一份 —— 官方实现里这两个**是同一个值**
 *   （`dsh-session\lib\index.js:1268`：`get id() { return this.header.id; }`），
 *   所以两份其实重合；留两份只是为了让"事件里拿到的是哪个字段"不影响结果。
 */
function armReinject(state, sid, agent) {
  const headerId = agent?.session?.header?.id;
  const sessionId = agent?.session?.id;
  const root = projectRootOf(agent);
  const ids = new Set([String(sid), String(headerId ?? ""), String(sessionId ?? "")]);
  for (const id of ids) {
    if (id === "" || id === "undefined") continue;
    let set = state.reinject.get(id);
    if (set === undefined) {
      set = new Set();
      state.reinject.set(id, set);
    }
    set.add(`compacted:${root ?? "*"}`);
  }
}

/**
 * 最近一次 `newState()` 的结果（**仅供自检**）。
 *
 * ★ 为什么必须是模块级：`deltaForce` 是插件内部 state，而自检的严格代理
 *   会拒绝 `run.ctx.state`（实测 `cannot get property "state" without inject`）。
 *
 * ★★★ 2026-10-12（D114）：**声明必须放在 `newState` 之前**。
 *   我第一版把它写在 `newState` **下面** ⇒ `newState` 里那句赋值落在
 *   `let` 的**暂时性死区（TDZ）**里 ⇒ 跑起来直接抛 `Cannot access
 *   'latestStateForTest' before initialization`。
 *   ★ 而当时的表现**不是报错、是"只有第一个用例生效"**：
 *     22c-4 的核心断言（AI 未落盘 ⇒ 不许压）通过、后面两条失败 ——
 *     **一个 TDZ 故障伪装成了"行为不对"**。⇒ 又一次"取不到值先怀疑取法"（纪律 3）。
 */
let latestStateForTest;

/** 每个会话的进程内状态。★ 只在内存（红线：不碰 $DSH_HOME 的 sessions/storages）。 */
function newState() {
  const st = {
    /** sid → 已注入文本集（用于去重，避免每步重复注入同一段）。 */
    injected: new Map(),
    /** sid → 待兑现的 /ledger 命令。 */
    pending: new Map(),
    /** sid → 上次注入时的活跃台账"指纹"（路径+长度+行数），变了才重注。 */
    fingerprint: new Map(),
    /**
     * sid → 用户在回合末四选一里选了"执行压缩"，等着本轮结束（agent 空闲）时兑现。
     *
     * ★ 为什么必须延后：`compaction.compactNow` 要求 agent 处于 idle
     *   （`compaction-basic:985-1010`，非 idle 直接抛 `busy`）。而工具是在**回合中**跑的，
     *   所以只能记下意图，等 `agent/status` 变成 idle 再动手。
     */
    compactAfterTurn: new Map(),
    /** sid → 刚压缩完，下一次 pre-step 要强制重注台账（压缩会把旧注入压掉）。 */
    reinject: new Map(),
    /**
     * sid → 已经提醒过的**水位档位**集合（0.3 / 0.5 / 0.7）。
     *
     * ★ 从"一个布尔"改成一集合（需求 ⑳ 的三档）：布尔表达不了"30% 发过了、
     *   50% 还没"。掉回某档之下就把那一档移出集合 ⇒ 重新武装，
     *   于是压缩之后能再提醒一轮（用户要的就是"每次到了一定水位就固化一次"）。
     */
    pressureNotified: new Map(),
    /**
     * sid → 回合末那张四选一卡片是否还挂着（以及挂上的时刻）。
     *
     * ★ 只记内存：卡片本身由客户端持有，这里只用来防"同一次停顿问两遍"。
     *   带时刻是为了让**被无视的卡片**不至于永久堵住后续的回合末提问
     *   （用户没点就关掉时那条 waterfall 不结算，只看"挂着没有"会一直为真）。
     */
    autoOfferPending: new Map(),
    /**
     * sid → 下一次回合末**不要**自动提问。
     *
     * ★ 这是自动路径的防环阀：用户选完 ⇒ 我们用 `agent.steer` 把 AI 唤醒去执行
     *   （写台账 / 写交接单），那一轮跑完又会到 turn-stopping。若不加这个标记，
     *   就变成"选完 → 干活 → 又被问"的无限套娃。
     */
    skipAutoOffer: new Set(),
    /**
     * sid → 已经问过「要不要把这个目录建成项目」。
     *
     * ★ 只问一次：这是会话级的**一次性**提问（第一轮结束）。
     *   不加这个的话，用户选了「建项目」之后那一轮又会结束 ⇒ 又问一次"要不要建项目"。
     */
    projectAsked: new Set(),
    /**
     * sid → 已经问过「这个项目的台账要不要改成合规的」。
     *
     * ★ 与 `projectAsked` 分开记：两个问题面向不同项目形态
     *   （前者=没有台账的项目，后者=有台账但不符合计划的），
     *   混在一起会让"问过建项目"把"要不要改台账"也一起吞掉。
     */
    conformAsked: new Set(),
    /**
     * sid → 本会话"改过台账"的回执（待告知用户）。
     *
     * ★ 为什么需要：工具返回值是发**给 AI** 的，**用户看不到**。
     *   于是 AI 默默改了台账、用户无从得知 —— 他问的正是
     *   「如果在完成一个任务之后，AI自己就把台账给做了，那我怎么知道？」
     *
     * ★★ 送达通道（2026-10-09 改过）：**走 `agent/pre-step` 注入**给 AI，
     *   由 AI 在自己这次的回复里捎带一句（`renderTouchedForAi`）。
     *   - 原本**只**挂在回合末卡片上。用户去掉每轮选择题之后，卡片默认关
     *     ⇒ 回执就**永远送不出去**了（自检情形 22 当场全线转红才发现）。
     *   - 注入这条通道**不打断工作**（用户明确要求"工作不能被影响"）：
     *     不弹卡、不等答复，只借 AI 的一句回复捎带。
     *   - 取下即清（`takeTouched`），所以**只告知一次**，不会每步都念。
     */
    ledgerTouched: new Map(),
    /**
     * sid → 本会话**最近一次真正落盘的时刻**（台账 / L1 日志）。
     *
     * ★★ 为什么需要它（用户 2026-10-09 反复强调的那一条）：
     *   *"每次压缩之前强制进行台账更新和日志更新"* —— 注意是**强制**，不是劝告。
     *   压在 70% 那一档的语义是"在细节丢掉之前先把状态落袋"；
     *   可如果这一轮的进展**还没写进台账**，那一压就是把唯一副本压掉了。
     *   ⇒ 所以压缩必须先问一句"落袋了吗"，没落就**不压**。
     *
     * ★ 为什么记"时刻"而不是"有没有写过"：
     *   要的是"**这一轮**的进展落袋了吗"，不是"这个会话写过台账吗"。
     *   拿时间戳与"本轮开始时刻"比较，就能区分这两件事。
     */
    flushedAt: new Map(),
    // ★★★ 2026-10-12（D131，用户拍板"清掉"）：这里原来有两个 Map ——
    //   `flushOwedAt`（"我们要求过它落盘、正等它写"）与 `flushOwedStep`（那一拍是第几拍）。
    //   ★ 它们连同"承诺判据"整段一起删了，**因为唯一给 `flushOwedAt` 赋值的地方
    //     在 D129 按用户要求删掉了**（"去除三个节点的义务，以防模型被卡"）
    //     ⇒ 两个 Map **从不被写** ⇒ 用它们的判据永不进入 ⇒ 是死代码。
    //   ★ 真正守着"先记台账再压缩"的是**周期判据**（`flushedAt` vs `lastCompactCycleAt`），
    //     它不依赖"我们开过口"，问的是客观事实"本周期写过吗"。
    /**
     * sid → 被"压缩前强制落盘"拦下的次数 + 当时的理由。
     *
     * ★ 为什么单独记：被拦下是**正常流程**（AI 会先写、下一次再压），
     *   但**连续被拦很多次**就说明 AI 一直没照做 —— 那时该告诉用户，
     *   而不是无限期地静默不压。
     */
    flushBlocked: new Map(),
    /**
     * sid → **本会话上一次压缩发生在何时**（用于"一次压缩，一次落盘"的周期判据）。
     *
     * ★ 为什么需要它：闸门的判据是"**自上次压缩以来**落过盘吗" ——
     *   所以既要记"何时落盘"（`flushedAt`），也要记"何时压缩"（本项）。
     *   两者比大小即可判断周期，不需要知道"本轮"的边界（那个在 pre-step 里拿不到）。
     */
    lastCompactCycleAt: new Map(),
    /**
     * sid → **等 idle 时跑我们自己的高保真压缩**的意图（需求 ㉑）。
     *
     * ★ 为什么必须延后：`compaction.compactNow` 要求 agent 处于 idle
     *   （内核 `ManualCompactionError("busy", …)`），而 pre-step 里 agent 必然 running。
     *   与 `compactAfterTurn`（用户在卡片上选的那条路）**分开存**：
     *   两者的来源与"要不要告诉用户"都不同，混一个 Map 会说不清是谁排的队。
     */
    hfCompactAfterTurn: new Map(),
    /**
     * sid → 本会话**已经由我们压过一次**（高保真那条路）。
     *
     * ★ 只压一次的理由：压缩本身要一次 LLM 调用并重写历史；反复压会把
     *   "摘要的摘要"退化的风险放大（Codex 为此重写过核心代码，官方警告
     *   *"multiple compactions can cause the model to be less accurate"*）。
     *   掉回线下**不**重新武装这一条 —— 与水位提醒（每档可重发）刻意不同。
     */
    hfCompacted: new Map(),
    /**
     * ★★★ sid → **被压段索引**（承 DECISIONS D79：把"哪一段被压去哪了"推行给模型）。
     * 每条 = `{at, summarySeq, start, end, nodes, shadowedTokens, summaryChars, source}`。
     * ★ 它是**可回读**的入口：模型据此调 `ledger_recall({from,to})` 取逐字原文。
     * ★ 只存内存即可 —— 它描述的是"**本会话**日志里的 seq 区间"，跨重启后
     *   seq 仍然有效，但会话结束时这份索引本来就该随会话走。
     */
    shadowedIndex: new Map(),
    /**
     * sid → **压缩前**抓好的胶囊快照（压缩后重注时优先用它）。
     *
     * ★ 为什么必须提前抓：压缩一跑，会话事件的去重集合与"当时上下文里有什么"
     *   都变了；压缩后再现取的胶囊会缺掉**刚好被压掉**的那一段 —— 而那一段
     *   正是我们要救的东西。
     */
    capsuleSnapshot: new Map(),
    /**
     * ★★★ D61 修复（2026-10-11）：哪些 sid **已经**把盘上那份素材并回内存了。
     *
     * ★ 为什么要这个标记：`hydrateCapsuleMemory` 只能做一次 —— 每轮都并会把
     *   同一批旧原话反复接上来（虽然有去重，但白费功、也让上限截断行为变怪）。
     * ★ 为什么不直接放在 `capsuleMemory` 里：它属于**插件状态**，
     *   而 `capsuleMemory` 是"纯数据容器"（自检里可被单独构造），别把生命周期混进去。
     */
    capsuleHydrated: new Set(),
    /**
     * sid → 「反复追究」模式里 **keep 桶**（压缩后逐字重注，与胶囊同一条通道）。
     *
     * ★ 为什么与胶囊**分开存**而不是并进胶囊：
     *   胶囊是**插件机械抓的**（用户原话 / 报错 / 器物索引），它保证"模型忘了我也不会忘"；
     *   keep 桶是**模型判断的**（假设 / 当前状态），它会漏。
     *   两者来源不同、失败模式不同 ⇒ 分开存，压缩后**两份都注**，
     *   一份当地板（零成本、不会漏），一份当天花板（有判断力）。见 `MODE_SURGICAL` 注释。
     *
     * ★ 用完即删：它只描述"紧接着的那一次压缩"，不是会话状态（与 `hfSource` 同一条口径）。
     */
    triageKeep: new Map(),
    /**
     * sid → **模型给的区块是/否判分**（D136 权重那一维的输入）。
     *   `{ at, root, byHash: Map<hashPrefix, {q1?,q2?,q3?,q4?}> }`
     *
     * ★ 为什么按 `root` 也存一份：同一个会话可能被 `ledger_write({root})` 点到别的项目，
     *   而块哈希是**项目的**内容地址 ⇒ 张冠李戴会把 A 项目的分用到 B 项目上。
     *   注入时**只认 root 相同的**那一份。
     *
     * ★ 为什么**只存布尔、不存分数**：分数由 `weightFromAnswers` 按常量表算，
     *   那是"换模型可复现"的前提（见情形 56②b）。
     *
     * ★ 为什么**不落盘**：它是**一次注入决策的输入**，不是项目知识；
     *   落盘反而会让"上次的分"在内容已变后继续生效（哈希对不上时自然失效，
     *   但显式不落盘更干净）。
     */
    blockWeights: new Map(),
    /**
     * sid → **我们要求过分流的时刻**（「反复追究」模式的第二道义务）。
     *
     * ★ 为什么不与 `flushOwedAt` 共用：`noteFlushed` 在写台账时就会清掉那个标记，
     *   而"写了台账"**不等于**"分过流"。共用 ⇒ "只写台账没分流"会静默通过闸门
     *   ⇒ keep 桶空着压缩照跑 ⇒ **模式退化且无人察觉**。
     */
    triageOwedAt: new Map(),
    /** sid → 上一次**真的做完分流**的时刻（与 `triageOwedAt` 比大小判是否兑现）。 */
    triageAt: new Map(),
    /** sid → 连续被"要求分流却没做"拦下的次数（死锁防护，与 `flushBlocked` 同口径）。 */
    triageBlocked: new Map(),
    /**
     * ★★★ 2026-10-11：sid → **本会话压缩了几次**（可查的计数器，见 `compactCountsOf`）。
     *   D59 的教训：我写了棘轮、自检全绿、还发了版，却从没核对过"压缩真的发生了"。
     *   ⇒ 凡是"应该会发生"的事，都要留下一个**能被读出来的整数**。
     *   `{total, delta, full, lastAt, lastSource}`。
     */
    compactCounts: new Map(),
    /**
     * sid → **这一次压缩是谁发起的**（需求 ②③：四条入口要分得清）。
     *
     * ★ 为什么必须由插件**自己记**：`compaction/end` 是内核发的事件，
     *   **它不知道谁发起的** —— 四条入口（自动 70% / 工具 / 命令 / 卡片）
     *   走的是同一个 `compactNow`，内核那一侧完全一样。
     *   ⇒ 由发起方在压之前写进这里，L0 采集时取出来，日志才分得清是哪条路。
     * ★★★ 2026-10-11 实测改正（用户第 2 点）—— 原来是**单槽** Map<sid, source>，
     *   而它**真的会并发覆盖**：19:27:38 的自动全量被 19:27:57 那次手动命令顶掉，
     *   于是 L0 把那次真跑过的全量记成「手动（命令）」，
     *   让用户（和我）都以为"自动全量从来没跑过"。
     *   ⇒ 改成**按 sid 的队列**：每次压缩**压前入队**、`compaction/end` **出队一个**。
     *     并发重叠时每一个 end 都拿得到属于自己的那个来源。
     *   ★ 为什么只能靠队列：`compaction/end` 由内核发，它**不带**任何来源信息，
     *     我们唯一能用上的关联就是**先来后到的顺序**（内核的 start/summary/end 有序且成对）。
     */
    hfSource: new Map(), // sid → string[]（队首 = 最早那次尚未结束的压缩的来源）
    /**
     * sid → 本会话增量压缩的**锚点水位**（0~1，上一次压缩发生时的 ratio）。
     *
     * ★ 判据是"**相对上涨**"而不是绝对水位（用户 #113/#119：*"AI每输出20%的时候，
     *   调用一次工具压缩到12%"*、*"这里的20%是指上下文上限的20%"*）。
     *   ⇒ 每次压完把锚点推到当前水位，下次只要再涨够 `deltaTriggerPoints` 点就再压。
     * ★ 为什么不能用绝对水位：绝对 70% 是"**一次处理整个会话积压**"（那正是
     *   "压缩幅度太大"的来源）；相对涨幅才是"**每次只处理这一小段**"。
     */
    deltaAnchor: new Map(),
    /**
     * sid → 「下一次 pre-step 强制做一次增量压缩」的旗子（`/ledger light` 立的）。
     *
     * ★ 为什么需要它：`compactRegion` 要求**回合开着**，而命令是在 idle 跑的
     *   ⇒ 命令只能"立旗子 + 唤醒一轮"，真正的压缩由那一轮的 pre-step 做。
     *   见 `runManualLightCompactNow`。
     * ★ 用完即删（`takeDeltaForce`）：它只描述"紧接着的那一次"，不是会话状态。
     */
    deltaForce: new Map(),
    /**
     * ★★★ 2026-10-12（D115）：sid → 「已经轻推过的那条涨幅线」，防止**每步都推**。
     *
     * ★ 为什么这条是**必须**的（本文件反复栽过的那个病）：
     *   轻推 = 往上下文里注入一段**新文本**。若每步都发 ⇒ **prompt 缓存每步全冷**
     *   ⇒ 省下的 token 全赔在缓存上（D97 已经栽过一次同型：每步重注整份台账）。
     * ★ 外部实现（billion-context）也栽过并写明了：它 **96% 的 nudge 自我压制**（1212/1266）。
     * ★ 记的是"推到哪条线"，不是"推过没有"：水位涨上去之后**还能再推一次**，
     *   但**同一条线只推一次** —— 涨够一个新的 `deltaTriggerPoints` 才重置。
     */
    deltaNudged: new Map(),
    /**
     * ★★★ 2026-10-12（D119）：sid → 「**增量从什么时候开始让路**」。
     * ★ 只服务一条兜底：让路超过 `DELTA_YIELD_MAX_AGE_MS` 仍让不出去 ⇒ **放行增量**
     *   （否则全量若一直在失败，就会变成"谁也不压" = D59 那个形态）。
     * ★ 水位掉回全量线之下、或全量真压过 ⇒ 立即清掉（义务解除）。
     */
    deltaYieldSince: new Map(),
    /**
     * ★★★★★ 2026-10-13（D151）：sid → **「让路」这件事已经告诉过模型了吗**。
     *
     * ★★★ 为什么必须补它（这是我自己的代码留下的洞）：
     *   `yieldedToFull` 这个标记**只被生产、从没被消费** —— 全文件唯一出现处就是
     *   生产点（`return { …, yieldedToFull: true }`）。而调用点的分支只有
     *   `ok` / `blocked` / `requeued` / `forcedLight` 四种
     *   ⇒ ★ **让路时一条注入都不发**。
     *
     * ★ 后果（真机实测，2026-10-13 23:46）：模型调 `ledger_compact{mode:"light"}`，
     *   工具回执说"已请求一次轻量压缩"（`ok:true, steered:true`），
     *   而随后那一刻水位 ≥ 全量线 ⇒ 增量**静默让路** ⇒ 水位一点没动、
     *   模型与用户都看不到任何解释 ⇒ 又去按一次。
     *   ★ 这正是 D40「说已排队、其实没发生」的**同型复发**（本项目第 4 次）。
     *
     * ★ 为什么需要"只报一次"的守卫而不是每步都报：
     *   让路会在**每一步**发生（只要水位 ≥ 全量线且全量还没跑），
     *   每步都注入 ⇒ **prompt 缓存每步全冷**（D97 那个病）。
     *   ⇒ 与 `deltaNudged` 同一条设计：**一段让路期只说一次**，
     *     水位掉回线下（或全量真跑过）时清掉、重新武装。
     */
    deltaYieldNotified: new Map(),
    /**
     * ★★★★★ 2026-10-13（D151）：sid → **「闸门说这段太小」已经告诉过模型了吗**（值 = 当时的可压 token 数）。
     *
     * ★★★ 为什么必须补它：`tooSmall` 与 `yieldedToFull` 是**同一个病** ——
     *   只被生产、没有消费者。而这条更严重：D114 的注释**明确要求**
     *   「模型主动压时若被闸门拦下，**必须当场告诉它**『先写台账，这是顺序不是障碍』」，
     *   ★ 而闸门（D141）给出的是**另一种**拦法（"这段太小"），**没人渲染它** ⇒
     *   模型看到的是"调了工具、什么都没发生" ⇒ 与 D114 想消灭的现象完全一样。
     *
     * ★ 为什么值存"当时的可压 token 数"：让路期用布尔就够（水位没掉下来就一直是同一件事），
     *   而"太小"会**随历史积累而变大** ⇒ 存数值，涨到 1.5 倍才再报一次
     *   （既不会每步刷屏，也不会在真的攒够了之后还报"太小"）。
     */
    deltaTooSmallNotified: new Map(),
    /**
     * ★★★★★ 2026-10-13（D157，用户原话）：**每一条回复结束前必须落过台账 + 分过流**。
     *
     *   用户原话（逐字）：*"但是切记，模型的每一条回复，在结束以前必须强制进行台账和分流。"*
     *
     * ★ 为什么这条不能用"闸门"实现（本机前科，必须记牢）：
     *   实测 **47% 的回合结束前没写台账**（132 个 turn 里 62 个）。
     *   若"没写就不许压"做成硬前置 ⇒ 近一半回合卡在闸门 ⇒
     *   **正是 D59 那次"拦了近 4 小时、零次压缩"的形态**。
     *   ⇒ ★ 所以「强制」的正确形态是：**在回合内提醒（推给它）+ 回合末记账 + 下一次再催**，
     *     而**不是**把压缩卡死。义务与执行分开：**义务是硬的，执行是渐进的**。
     *
     * ★ 数据来源：`session/event` 里的 `tool/call`（零 token、不花模型调用）——
     *   记"本回合有没有真的调用过 `ledger_write`/`ledger_archive` 与 `ledger_triage`"。
     */
    turnObligation: new Map(),
    /**
     * ★★★ 2026-10-13（D157）：sid → **上一个回合结束时，义务有没有兑现**。
     *   `false` ⇒ 下个回合的第一次注入里要**如实提醒它补上**（一次，不刷屏）。
     *   ★ 与 `deltaNudged` 同一条设计：**同一件事只说一次**，兑现后清掉。
     */
    turnObligationPending: new Map(),
  };
  // ★ 2026-10-12（D114）：把最近一次建的状态挂到模块级，**只给自检用**
  //   （见 `__test.setDeltaForce` 的注释：`deltaForce` 是内部 state，自检够不着）。
  //   ★ 只留**最后一份**：自检是单进程顺序跑，每个用例自己 `makeCtx` + `apply`。
  //   ⚠️ 这不是"给生产代码开后门"——它不改变任何行为，只是让"谁发起的"可被观测。
  latestStateForTest = st;
  return st;
}

/**
 * ★★★ 增量（分段）压缩 —— 用户 2026-10-09 那套方案的核心。
 *
 * 与 `runHighFidelityCompact` 的**根本区别**（读内核实现得出的，非猜）：
 *
 *   | | `compactNow`（旧） | `compactRegion` + 大 retain（新） |
 *   |---|---|---|
 *   | 保留 | `retainTokens = 0` ⇒ **几乎全压** | 最近 `keepPoints` 点**不动** ⇒ **只压最旧一段** |
 *   | 时机 | 要求 **idle**（`owner: null`） | 要求**有打开的回合**（`owner: "current-turn"`） |
 *   | 效果 | 水位大幅回落，细节大片丢失 | 水位小幅回落，新近细节完整保留 |
 *
 * ★★ 为什么"在 pre-step 里"是对的而不是巧合：内核自己的自动压缩就挂在
 *   `agent/pre-step`（`dsh-compaction-basic:839`）—— 那时回合是开着的，
 *   正好满足 `owner: "current-turn"` 的要求（`:460` 会抛
 *   *"compactRegion: no open turn"*）。所以这条路与内核同源。
 *
 * ★ "落在节点附近"由**落盘闸门**免费实现（零 token）：
 *   闸门要求"自上次压缩以来落过盘"，而模型写台账时本就在做"什么留上下文、
 *   什么进台账"的判断 ⇒ **那就是它在声明"我到节点了"**。
 *   闸门没过 ⇒ 本步跳过、下一步再来 —— 这正好是用户说的"允许提前或超出一点"。
 *
 * @returns {Promise<{ok:boolean, compacted:boolean, reason?:string}>}
 */
async function runIncrementalCompact(ctx, state, agent, capsuleMemory, projectInfo, opts) {
  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid === "") {
    return { ok: false, compacted: false, reason: "拿不到会话 id" };
  }
  const key = String(sid);
  const settings = currentSettings();
  // ★ `opts.force`：人手动敲 `/ledger light` 时**不看涨幅、不看落盘闸门**
  //   —— 闸门约束的是 AI 的工作流，不该把用户的明确授权挡回去（与 D40 的
  //   `manual` 旁路同一条理由）。自动那条永远不带 force。
  const forced = opts?.force === true;

  // ★★★ 2026-10-12（D114，用户要求「让模型按需压，但一定先更新台账日志再压缩」）：
  //
  //   `byNeed` = **"模型自己说它到节点了"**。它与 `force` 是**两个不同的东西**：
  //
  //   | | 涨幅判据 | 让路判据 | **落盘闸门** | 谁用 |
  //   |---|---|---|---|---|
  //   | 自动（默认） | 要过 | 要过 | 要过 | 插件兜底 |
  //   | `force`（人按键） | 不看 | 不看 | ★ **不看** | `/ledger light` |
  //   | `byNeed`（AI 主动） | **不看** | 要过 | ★ **照样要过** | `ledger_compact` |
  //
  //   ★ 为什么 `byNeed` **不看涨幅**：模型是"按需"压（一段用完就压），
  //     它不该被"涨够 20 点"这种数字挡住 —— 那正是用户要去掉的"强制 20 压 10"。
  //   ★ 为什么 `byNeed` **仍然要过闸门**：这正是用户的硬要求 ——
  //     *"一定要让模型先更新台账日志再压缩"*。
  //     ★ 而且闸门的语义**本来就是"你到节点了吗"**（见上面那段注释）：
  //       模型写台账时本就在做"什么留上下文、什么进台账"的判断
  //       ⇒ 闸门 = "按需"的**机器可验证版本**。两者不但不冲突，是同一件事的两种说法。
  //   ★ 为什么 `byNeed` 仍要看**让路**：水位已到全量线时该交给全量（D99 的教训）。
  const byNeed = opts?.byNeed === true;

  const compaction = compactionServiceFor(ctx, agent);
  if (compaction === undefined || typeof compaction.compactRegion !== "function") {
    return { ok: false, compacted: false, reason: "没有 compaction 服务（或它不支持 compactRegion）" };
  }
  const pressure = measurePressure(ctx, agent);
  if (pressure === undefined) return { ok: false, compacted: false, reason: "量不到水位" };

  // ── 判据①：相对上次压缩涨够了吗（用户说的"每输出 20%"）────────────────
  //
  // ★★★ 锚点必须走 `anchorOf`（内存 → 落盘兜底），**不能**直接读 `state.deltaAnchor`。
  //   理由见 `anchorOf` 上面的注释：它是进程内 Map，重启即空，
  //   而空了之后 `since` 会退化成整个水位 ⇒ 重启后必然多压一次（实测 6 次）。
  //   ⚠️ 这与 D51/D52 是**同一类错误**（写了新判定却漏了旧调用点），所以这里一次改到位。
  const anchor = anchorOf(state, key);
  const trigger = settings.deltaTriggerPoints / 100;
  const since = anchor === undefined ? pressure.ratio : pressure.ratio - anchor;
  // ★★★ 2026-10-12（D129，用户拍板）：**`fallback`（机械兜底）已删除**。
  //
  //   它原来是"涨够 40 点仍未压 ⇒ 插件替你压一次"。删它的理由（用户原话）：
  //     *"把所有的压缩全部给模型……全量压缩，最迟最迟发生在 75%（可调），
  //       即使模型没有主动压缩。"*
  //   ⇒ 那条绝对线存在的唯一目的是"别让水位撞进内核 80%"，而现在**全量兜底接住了它**。
  //
  //   ⚠️ 下面整段关于 `capLine` 的历史注释**保留**（它记着 D88/D99 两次教训），
  //     但**代码里已经没有 `capLine` / `byCap` / `byFallback`** —— 别照着它去找那些变量。

  // ★★★ 2026-10-11（D88）：**兜底** —— 触发线不许越过内核硬压线。
  //
  //   原来只有 `since >= trigger` 一条 ⇒ 锚点一高（69%），触发线就到 89%，
  //   而内核 80% 就硬压了 ⇒ **增量永远等不到**（详见 `DELTA_TRIGGER_CAP_MARGIN_POINTS` 的注释）。
  //   ⇒ 现在补一条**绝对线**：水位一到"兜底线"就压，**不再看锚点**。
  //
  //   ★★★ 2026-10-12 修一个**我自己引入的回归**（用户当场看出来的：
  //     *"理论上到这个时候，不应该是全量压缩生效吗？怎么是增量压缩先生效呢？"*）：
  //
  //     **旧写法（错）**：`capLine = min(全量线, 内核线) − 5 点`
  //       ⇒ 用户设全量线 **0.75** 时，兜底线 = **0.70** —— **低于全量线**。
  //       ⇒ 水位一进 `[0.70, 0.75)`，`byCap` 就命中，而**让路判据要 0.75 才命中**
  //         ⇒ **增量抢跑**、把水位压回 ~0.62 ⇒ 水位**永远爬不到 0.75**
  //         ⇒ ★ **全量被永久饿死**（实测：本会话"自动（增量）"9 次 vs "自动（70% 水位）"**仅 1 次**）。
  //
  //     ★ 我当初的注释写着"兜底线也必须早于我们自己的全量线（否则让路先命中 ⇒ 全量先跑 ⇒
  //       增量又被挤掉）" —— **这句话本身是反的**：
  //       **"全量在自己的线上接管"不是 bug，是设计**（全量就是那一档的安全网）。
  //       我把该让的路当成"被挤掉"，于是把兜底线压到全量线底下，让它去偷全量的水位带。
  //
  //     **新写法（对）**：`capLine = min(内核线 − 余量, 全量线)`
  //       · 上界仍是"内核线 − 余量"（**必须早于内核**，否则内核抢先、那次抓不到逐字胶囊）；
  //       · 同时**不许低于全量线** ⇒ 兜底触发的位点**恰好落在或高于全量线**，
  //         而全量线那一档**让路判据先命中** ⇒ 该全量就全量。
  //       · 三种设置都自洽：
  //         全量线 0.75 / 内核 0.80 ⇒ capLine = 0.75（= 全量线 ⇒ 让路优先，全量接管）✅
  //         全量线 0.60             ⇒ capLine = 0.60（同上，全量在其线上接管）✅
  //         全量线 0.85（> 内核）    ⇒ capLine = 0.75（**低于内核** ⇒ 增量仍在 0.80 之前抢救）✅
  //         ★ 后一种是兜底真正的用武之地：全量线高过内核线时**全量根本来不及**，
  //           兜底保证我们在被内核硬压之前先自己压一次。
  //
  //  ★★★ 2026-10-12（D129）：上面整段"兜底线 `capLine`"的讨论**已成历史** ——
  //   用户拍板把机械增量兜底**整个删掉**，所以 `capLine` / `byCap` / `byFallback`
  //   三个东西**都不再存在**。留这段注释只为解释"为什么曾经需要它、现在为什么不需要"。
  //
  //   为什么不需要了：`capLine` 存在的唯一目的是"**别让水位撞进内核 80%**"。
  //   而现在这条职责交给了**全量兜底**（`hfLine`，默认 0.75）⇒ 它接得住，
  //   且它带逐字胶囊（内核那次没有）⇒ 增量那条绝对线**没有存在必要**。
  //
  //   ★ 手动 `forced`（`/ledger light`）照旧绕开一切判据（D40）。
  //
  //   ★ 为什么敢删（这是与 billion 的分工，与 D127 同一条取舍）：
  //     `byCap` / `byFallback` 存在的理由是"怕模型不理轻推 ⇒ 永不压缩"（D59 的前科）。
  //     而现在**全量 75% 那条兜底接住了它** ⇒ 最坏情况仍有"我们自己的、带逐字胶囊的"压缩
  //     （而不是让内核 80% 那次无胶囊硬压）⇒ 那两条机械兜底**已成冗余**。
  //   ★ 为什么删掉**更好**：机械压的时机是"水位到了"，而**模型才知道"这段用完了"** ——
  //     前者会压掉它可能还要用的东西，后者不会。
  //
  //   ⚠️ 保留的判据只有：`forced`（人按 `/ledger light`）、`byNeed`（模型主动调工具）。
  //     两者的区别见上面那张表：**只有人的按键豁免闸门**。

  // ── 判据①：既不按需、也没到兜底线 ⇒ **检查要不要轻推**（本步不压）────────
  //
  // ★★★ 2026-10-12（D117，用户判断）**本轮的核心改动：轻推不再按"涨了多少"触发。**
  //
  //   | | 旧（D115） | 新（D117） |
  //   |---|---|---|
  //   | 轻推条件 | `since ≥ deltaTriggerPoints`（20 点） | ★ **① 水位 ≥ `NUDGE_MIN_RATIO`（0.45）** |
  //   | | | ★ **② 模型已声明"我到节点了"（本周期落过盘）** |
  //   | | | ★ **③ 本周期还没推过**（`deltaNudged`） |
  //
  //   ★★★ 为什么"到节点"要用**落盘闸门**去判，而不是发明新判据：
  //     本文件自己写着（`flushBeforeCompact` 上方）：
  //       *"模型写台账时本就在做『什么留上下文、什么进台账』的判断
  //        ⇒ **那就是它在声明『我到节点了』**"*。
  //     ⇒ ★ **那个判据早就有了，我只是一直没把它用在轻推上。**
  //
  //   ★★ 这个改法带来一条很好的性质：**"能推 ⇒ 一定能压"** ——
  //     轻推与压缩用**同一个节点判据** ⇒ 不会再出现"推了却被闸门拦住、白打扰一次"。
  //     ⚠️ 实现上要注意：**推的时候不能顺手把闸门消费掉**（那会让真正压缩那步失去判据）
  //     ⇒ 所以这里只**读** `flushedAt > lastCompactAt`，**不调用** `flushBeforeCompact`
  //       （它有副作用：会 `rec.count += 1`，见它自己的注释）。
  if (!forced && !byNeed) {
    if (opts?.dryRun === true) {
      // ★ 条件①：可推区间（照抄 billion 的 0.45 —— 在那之下不打扰）。
      const nudgeMin = numOf("nudgeMinRatio", NUDGE_MIN_RATIO);
  const inNudgeBand = pressure.ratio >= nudgeMin;
      // ★ 条件②：模型已声明节点（本周期落过盘）。
      //   ★ 与 `flushBeforeCompact` 的判据**同源**（`flushedAt > lastCompactAt`），但**只读**。
      const flushedAt3 = state.flushedAt.get(key) ?? 0;
      const lastCompactAt3 = state.lastCompactCycleAt.get(key) ?? 0;
      const declaredNode = flushedAt3 > lastCompactAt3;
      // ★ 条件③：本周期还没推过。
      const nudgedAt = state.deltaNudged.get(key);
      const notNudgedYet = nudgedAt === undefined || since - nudgedAt >= trigger;
      // ★★★★★ 2026-10-12（D141）条件④：**推之前也要过"够不够大"的闸门**。
      //
      //   ★★★ 为什么：轻推的语义是"**你现在可以压了**" —— 若闸门只装在真压那一步，
      //     就会出现 *"推了它、它去压、被闸门拒"* 的**白打扰**（模型付出一次工具调用）。
      //     ⇒ 而 D117 早就立过一条性质：**"能推 ⇒ 一定能压"** —— 这里把它补齐。
      //   ★ 一句话：**两个开口用同一把尺子**（判据只有一个出口，D25/D117）。
      //   ⚠️ 量不到（`undefined`）⇒ 放行（与真压那条同一口径）。
      const nudgeMinPoints = numOf("minCompressPoints", MIN_COMPRESS_POINTS);
      const nudgeCompressible = estimateCompressibleTokens(ctx, agent, pressure, since, settings);
      // ★ 与真压那条**共用同一个纯函数**（`compGateDecision`）⇒ 两个开口一把尺子。
      const bodyBigEnough =
        compGateDecision(nudgeCompressible, nudgeMinPoints, pressure.window, false).pass === true;
      // ★★★ 2026-10-12（D127，用户拍板）：**不再用"涨幅"卡轻推**。
      //   用户原话：*"不再约束，也不再隔这么多再提醒，而是让模型自由的去调用工具压缩。
      //   就类似于 billion"*
      //   ⇒ 我一度在这里加过 `since >= minGrowth` 的门，**已撤**：
      //     那个门会让"轻推"变成"攒够了才提醒"，而那正是用户要去掉的"隔这么久"。
      //   ★ 之所以敢放开（**这是本插件与 billion 的分工**）：
      //     billion 要约束压缩，是因为**它压掉的会丢**；
      //     而我们压掉的东西**有台账兜底 + 逐字胶囊 + `ledger_recall` 可回读**
      //     ⇒ 压缩在我们这里是**可逆的** ⇒ 没有"压错就亏"的顾虑。
      //     用户原话：*"那个插件的优点就是压缩做的非常好，缺点就是记忆不够完善，
      //     而我们的记忆已经足够完善了"*。
      const shouldNudge = inNudgeBand && declaredNode && notNudgedYet && bodyBigEnough;
      if (shouldNudge) {
        return {
          ok: false,
          compacted: false,
          nudge: true, // ★ 调用点据此**渲染**一句轻推（并**在那时**才落 `deltaNudged` 标记）
          dryRun: true,
          sincePoints: Number((since * 100).toFixed(1)),
          // ★ 渲染处要用它落标记（`deltaNudged` 存的是 **since 的比例值**，不是水位）。
          sinceRatio: since,
          triggerPoints: settings.deltaTriggerPoints,
          reason:
            `你刚落过盘（= 到了一个节点）、水位 ${(pressure.ratio * 100).toFixed(1)}% ≥ ` +
            `${Math.round(nudgeMin * 100)}% ⇒ 若这一段已经用完，可以顺手压一次。`,
        };
      }
    }
    return {
      ok: false,
      compacted: false,
      reason:
        `距上次压缩只涨了 ${(since * 100).toFixed(1)} 点（< 轻推线 ${settings.deltaTriggerPoints}），` +
        `水位 ${(pressure.ratio * 100).toFixed(1)}% 未到轻推区间 ${Math.round(nudgeMin * 100)}%`,
    };
  }
  // ★ `byNeed` 的前提：**确有东西可压**（`since > 0`）。
  //
  // ★★★ 2026-10-12（D127，用户明确拍板）：**这里**只**保留这一道**，
  //   不再加"最小涨幅"之类的门槛 —— 用户原话：
  //     *"我倒是觉得随时压也可以，就是比较激进的一个想法，就是不再约束，
  //       也不再隔这么多再提醒，而是让模型自由的去调用工具压缩。就类似于 billion"*
  //
  //   ⇒ 取舍：**把"该不该压"的判断权交还给模型**，插件只保留
  //     ① 「要有东西可压」这条物理底线（`since > 0`，防零收益空转）；
  //     ② 落盘闸门（先记台账再压 —— 那是用户更早定的铁律，不动）。
  //
  //   ★ 我知道的代价（写在这里，不藏）：每一次压缩都会**重写历史 ⇒ prompt 前缀失效**，
  //     所以"压得太勤"会打冷缓存。这正是本文件别处记着的 `zero-yield loop`。
  //     ⇒ 用户是在**知情**的前提下选了"自由"这一边；若哪天觉得不划算，
  //       把这条改回"最小涨幅门"即可（`tools/selftest.mjs` 里有对应用例）。
  if (!forced && byNeed && since <= 0) {
    return {
      ok: false,
      compacted: false,
      reason:
        `你要求按需压缩，但自上次压缩以来水位没有再涨（${(since * 100).toFixed(1)} 点）` +
        `—— 现在压没有可回收的空间。等有新的旧历史再压。`,
    };
  }
  // ★ 压成了（或即将压）⇒ 把轻推标记清掉：下一轮从新的起点重新计。
  state.deltaNudged.delete(key);

  // ═══════════════════════════════════════════════════════════════════════════
  // ★★★★★ 2026-10-12（D141）**空转闸门** —— "这一段够不够大"
  //
  //   ★★★ 放在这里的理由：它必须在**所有判据之后、真正动手之前**
  //     （`forced` 豁免、`byNeed` 与自动两条都已放行）⇒ 一处收口，三条路都受它保护。
  //     ★ 但**手动 `/ledger light` 豁免**（`forced`）—— 那是人的明确授权，
  //       与 D40/D114 的既有取舍一致（闸门约束的是 AI 工作流，不该挡用户的按键）。
  //
  //   ★★★ 为什么是"够不够大"而不是"涨了多少"（D139/D140 的核心结论）：
  //     触发看涨幅，但**能压掉多少取决于最旧那段多大** —— 两者无因果。
  //     `byNeed` 更是只看 `since > 0` ⇒ **涨 1 点也压** ⇒ 必然空转。
  //
  //   ★ 判据用**同一把尺子**与真压一致（`estimateCompressibleTokens` 复用那套算式），
  //     并且**同时用于轻推**（下面 `opts.dryRun` 分支）—— 消灭"推了却被闸门拒"的白打扰。
  //
  //   ⚠️ 量不到（`undefined`）⇒ **放行**，不拦（理由见 `estimateCompressibleTokens`）。
  // ═══════════════════════════════════════════════════════════════════════════
  if (!forced) {
    const minPoints = numOf("minCompressPoints", MIN_COMPRESS_POINTS);
    const minTokens = (Math.max(0, minPoints) / 100) * pressure.window;
    const compressible = estimateCompressibleTokens(ctx, agent, pressure, since, settings);
    // ★ 判断本身走**纯函数**（`compGateDecision`）—— 两个开口共用它，且它可被直接断言。
    const gate = compGateDecision(compressible, minPoints, pressure.window, forced);
    if (gate.pass === false) {
      // ★ 如实回报（**不是失败**）：上层据此**不注入、不打扰**，也不会误报"压缩发生了"。
      //   ★★ 措辞要给出**可操作**的下一步（照 billion 那句 *"Combine more messages"* 的口径）：
      //      告诉模型"再攒点/把范围扩大"，而不是让它以为坏了。
      const pc = Math.round((compressible / Math.max(1, pressure.window)) * 1000) / 10;
      return {
        ok: false,
        compacted: false,
        tooSmall: true, // ★ 专用标记：调用点据此**不重试、不报错**
        compressibleTokens: compressible,
        minTokens: Math.round(minTokens),
        reason:
          `这次可压的内容太小（约 ${compressible.toLocaleString()} tok ≈ ${pc} 点，` +
          `低于门槛 ${minPoints} 点）——压它不划算：` +
          `压完要重注台账与胶囊，代价比省下的多。` +
          `★ 等旧历史再攒一些（或让范围更大）再压，现在先继续干活。`,
      };
    }
  }

  // ── ★★★★★ 2026-10-13（D155）：**「增量让路给全量」整段已删** ─────────────
  //
  //   ★ 为什么删（用户拍板"全量为主力、增量关掉"）：这一段存在的**唯一理由**是
  //     "增量会抢在全量前面把水位压下去 ⇒ 全量永远轮不到"。
  //     而 D155 之后**增量默认关**（`incrementalCompact: false`）⇒ 没有"枪跑者"了
  //     ⇒ 让路逻辑**失去对象**。
  //
  //   ★★★ 而且它在新默认值下会**变成 bug**（这是本轮自检当场抓到的）：
  //     让路判据是 `pressure.ratio >= hfLine`，而 `hfLine` 从 0.75 变成 **0.30**
  //     ⇒ **任何 ≥30% 的水位都会让路** ⇒ 模型主动调 `mode:"light"` 与 `/ledger light`
  //     **全部被拦住**（注入里只留下一句"增量让路"，看起来像"轻量压缩坏了"）。
  //     ★ 这正是"改默认值会连带改变别的判据语义"的典型 —— 改一处必须追所有引用它的判据。
  //
  //   ★ 保留的证据链（为什么当初需要它、后来为什么不需要）见 DECISIONS：
  //     D119（真事故：增量抢吃全量机会）/ D88·D99（饿死 bug）/ D147（全量只能 idle）。
  //   ★ `/ledger light` 与 `mode:"light"` 现在**既不从自动路径触发、也不被让路拦** ——
  //     它们是"人的明确授权"与"模型主动要压"，照旧走各自的闸门（D40 / D114）。
  //
  //   ⚠️ 若将来把 `incrementalCompact` 重新打开 ⇒ 这段让路逻辑**会自动恢复**
  //     （下面条件里含 `settings.incrementalCompact === true`）——
  //     否则 D119 那个"增量抢跑 ⇒ 全量永久饿死"会立刻复发。
  //     ★ 刻意**不删代码、只用开关收口**：让"打开增量"这一个动作**同时**恢复它的配套约束，
  //       而不是留下一句"记得同时改两处"的注释（那正是本文件反复栽的"两处各写一份"）。
  if (
    !forced &&
    settings.incrementalCompact === true &&
    settings.highFidelityCompact === true &&
    settings.autoCompact === true
  ) {
    const hfLine = settings.highFidelityCompactRatio;
    const oursDone = state.hfCompacted.get(key);
    let yieldOverdue = false;
    if (pressure.ratio >= hfLine && oursDone !== true) {
      // ★ 记录"从什么时候开始让路"；一直让不出去 ⇒ 超时后放行。
      const now = Date.now();
      const since0 = state.deltaYieldSince.get(key);
      if (since0 === undefined) {
        state.deltaYieldSince.set(key, now);
      } else if (now - since0 >= DELTA_YIELD_MAX_AGE_MS) {
        yieldOverdue = true; // ★ 超时 ⇒ 不再让路（放行增量）
      }
      if (!yieldOverdue) {
        return {
          ok: false,
          compacted: false,
          reason: `水位 ${(pressure.ratio * 100).toFixed(1)}% 已到全量线 ${Math.round(hfLine * 100)}% ⇒ 增量让路，交给全量高保真`,
          yieldedToFull: true,
        };
      }
      // ★ 超时放行 ⇒ 如实标注（不假装没让过路）。
    } else {
      // ★ 水位掉回全量线之下（或全量已压过）⇒ 让路义务解除，清掉计时。
      state.deltaYieldSince.delete(key);
    }
  }

  // ── ★★★ dryRun：只做**零副作用**的判据，回答"这一步该不该动手" ──────────
  //
  // ★ 为什么需要它（D93 / 用户第 2 点的真根因）：
  //   排队那段原来挂在 `text !== undefined` 门下（调用点），意思是"本步恰好有东西要注入
  //   才顺带排队"。可**"水位到线"这件事与"台账有没有变"毫无关系**。
  //   实测（`_probe-why-late.mjs`）：19:24~19:27 水位 ≥75% 的 16 步里**只有 8 步有注入**
  //   ⇒ 另一半根本**没机会**排队 ⇒ 安全网一路拖到 78.4% 才排上。
  //
  // ★ 为什么不另写一个 `wouldIncrementalCompact()`：那会让**判据出现两份**，
  //   早晚分叉（本文件反复栽过"两处各写一份"）。做成参数 ⇒ **判据永远只有一份**。
  //
  // ★ 为什么插在**这里**（判据①/①b 之后、判据② 之前）：
  //   · 判据①（涨幅）与①b（让路）是**纯读**，零副作用 ⇒ dryRun 可以放心跑；
  //   · 判据②（落盘闸门 `flushBeforeCompact`）**有副作用**（会 `rec.count += 1`），
  //     真实调用时还要再跑一次 ⇒ `dryRun` **绝不能**碰它，否则计数会翻倍
  //     （那正是 D59「计数必须放在唯一收口处」的同型病）。
  //   ⇒ 所以 `dryRun` 的语义是「**已经过了涨幅与让路判据 ⇒ 这一步想动手**」，
  //     而不是「一定会压成」。调用方据此**自造一句注入**，让本步不再是"没机会排队"。
  if (opts?.dryRun === true) {
    return {
      ok: false,
      compacted: false,
      dryRun: true,
      wouldAct: true,
      reason: `dryRun：已过涨幅与让路判据（距上次涨了 ${(since * 100).toFixed(1)} 点）`,
    };
  }

  // ── 判据②：落盘闸门（= "到节点了吗"，零 token）────────────────────────
  //   ★ 没过就**本步跳过**（不是失败）：下一步水位更高、且 AI 可能已写完台账。
  //   ★ 手动 force 时跳过这道闸门（理由见上面 `forced` 的注释）。
  //
  // ★★★ 2026-10-12（D129，用户拍板）：**分流义务挂到这里**（原来挂在水位提醒上）。
  //
  //   用户原话：*"轻量压缩的分流义务**还是要有的**，因为这是区分哪些不能压、
  //   哪些能压、哪些怎么压。"*
  //   ⇒ 它**不是**"到了水位就要做的事"，而是"**每次轻量压缩前**要做的事"。
  //   ★ 为什么挂在这里而不是水位处：水位那处已经按他的要求**去掉了义务**（防卡），
  //     而分流的意义是**决定压什么** —— 那正好是"要压缩"这个动作的属性。
  //
  //   ★ 只在 `byNeed`（模型主动调 `ledger_compact`）时立：那是**模型的意图**，
  //     此时要它先分流（区分留/落/丢）最自然；人手动 `/ledger light`（`forced`）不立
  //     —— 与 D40 一致（用户按键就是授权，不该被插件的自律规则挡回去）。
  if (!forced && byNeed && triageRequired()) {
    const t = triageOwed(state, key);
    // 本周期已经分过流 ⇒ 不重复要求（否则每次压缩都要它再分一次，变成纯开销）。
    const lastCompactAtT = state.lastCompactCycleAt.get(key) ?? 0;
    const triageAtT = state.triageAt.get(key) ?? 0;
    if (t.owed !== true && triageAtT <= lastCompactAtT) {
      state.triageOwedAt.set(key, Date.now());
    }
  }
  if (!forced) {
    const gate = flushBeforeCompact(state, key, projectInfo, { manual: false, ratio: pressure.ratio });
    if (gate.ok !== true) {
      return { ok: false, compacted: false, reason: gate.reason, blocked: true };
    }
  }

  // ── 选范围：**棘轮** —— 每轮压掉固定一段，保留量随之抬高 ──────────────
  //
  // ★★★ 2026-10-10（用户指出我**从头就理解错了**，这条是他的原话）：
  //
  //   *"假设开始时10，加20，触发一次增量压缩，减10，就是20，以此类推，
  //     第五或第六次触发一次全量高保真压缩"*
  //
  //   ⇒ 他要的是**阶梯/棘轮**，水位一级一级**往上爬**：
  //
  //        10 →(+20)→ 30 ──压掉10──→ 20
  //        20 →(+20)→ 40 ──压掉10──→ 30
  //        30 →(+20)→ 50 ──压掉10──→ 40
  //        40 →(+20)→ 60 ──压掉10──→ 50
  //        50 →(+20)→ 70 ──★ 全量高保真★
  //
  //   ★ 而旧实现把「保留最近 N 点」当**常量**传给 `selectIncrementalRange`
  //     （那个函数从后往前攒够 retainTokens 就停）⇒ 每次压完都掉回**同一个低位**：
  //
  //        30 →保留10→ 10   再涨到 30 → 又压回 10   ⇒ **永远在 10↔30 之间摆**
  //
  //     ⇒ 观测到的"压后水位一直在 13~28% 打转、棘轮不走"，就是这个常量造成的。
  //     ⇒ 后果正是用户说的："按理说现在已经到全量高保真压缩的时候了，但现在水位还在这里。"
  //
  //   ★ 正确做法：保留量 = **当前水位 − 这轮要压掉的点数**。
  //     于是压掉的是固定的一段（默认 10 点），保留的部分**逐轮变大** ⇒ 水位棘轮上抬。
  //
  //   ★ 与两个设置项的对应关系（口径已写进它们的 hint）：
  //     · `deltaTriggerPoints`（默认 20）：涨够这么多点才**轻推**（D115 起不再是"必压"）；
  //     · `deltaRemovePoints`（默认 10）：每轮**压掉**这么多点 ⇒ 净涨 = 20 − 10 = 10。
  //     ⚠️ 旧设置项 `deltaKeepPoints` 的语义是"保留常量"，与棘轮**在数学上不相容**
  //        （保留恒定 ⇒ 净涨恒为 0）—— 这正是它的注释自相矛盾的原因
  //        （"保留 10~12"与"净增 8~10"不可能同时成立）。故改名为 `deltaRemovePoints`。
  //
  // ★★★ 2026-10-12（D116，用户原话）：**"依旧是压差不多一半"** —— 他选的是
  //   **「每次压掉**当前累计增量**的一半」**（动态），而不是固定 10 点。
  //
  //   ★ 为什么要动态（他自己给的算例就是动态的）：
  //     · D115 之后，兜底那条线的触发量变成 **40 点**（不再是 20）；
  //       若仍固定压 10，那 40 点只压掉 25% —— **"一半"这个说法在兜底那条路上就不成立了**。
  //     · 动态则：涨 20 ⇒ 压 10（= 今天的行为）；涨 40 ⇒ 压 20 ⇒ 净涨 20。
  //       ★ 棘轮仍然成立（保留量逐轮变大），只是步长随涨幅自适应。
  //
  // ★★★ 2026-10-12（D129，用户拍板）：**口径定为"真·一半"**。
  //
  //   用户原话（本轮）：*"然后模型虽然会积极的调用工具，每次调用工具依旧可以压一定额度，
  //   一半左右。"* —— 追问"一半是对什么取一半"，他答：
  //     **「上一次压缩到这一次准备压缩之间的东西」**
  //   ⇒ **`remove = 上一次压缩至今的增量 ÷ 2`**（`since/2`），而不是固定点数。
  //
  //   ★ 与 D116 的差别（这正是本轮修的）：D116 已经写了 `since/2`，
  //     但**又加了一道 `removeBase × 2` 的上限（默认 20 点）** ——
  //     ⇒ `since = 60` 时"一半"应是 30，却被压到 20 ⇒ **"一半"在增量大时就不成立了**。
  //     ⇒ 现在**上限改为 `deltaRemovePoints`（语义由"每轮压多少"改为"单次最多压多少"）**，
  //       默认 **30** ⇒ 正常情形下**就是一半**，上限只在"攒了很久才压"时兜住。
  //       ★ 为什么不取 50：`since ≤ 100` ⇒ 一半最大 50 ⇒ 取 50 时上限**恒不生效**
  //         （面板上留一个永远不起作用的旋钮 —— 本机纪律：写了就得做到）。
  //
  //   ★ 保留量为什么天然安全：`retain = ratio − since/2 = (ratio + anchor)/2`
  //     ⇒ **永远保留在"锚点与当前水位的中点"**，既不会压穿锚点、也不会只剩残渣。
  //     ★ 这正好也照顾了用户另一条硬约束（"上下文太少 ⇒ 断裂感很强"）。
  const removeCap = Math.max(1, settings.deltaRemovePoints);
  const removePoints = Math.max(1, Math.min(Math.round((since * 100) / 2), removeCap));
  const removeRatio = removePoints / 100;

  const meter = ctx.get("tokenMeter");
  if (meter === undefined || typeof meter.measure !== "function") {
    return { ok: false, compacted: false, reason: "没有 tokenMeter" };
  }
  const measurement = meter.measure(agent.session);

  // ★★★ 2026-10-11 修（用户第二次先发现的「零增量压缩」）——
  //   **保留量必须与被压缩对象同尺度算**。
  //
  //   内核 `dsh-token-meter` 的 `measure()` 返回两个**不同尺度**的量（逐字读过源码）：
  //     · `totalTokens` = `estimateToolsTokens(header)` + `surface.surfaceTokens` ← **含工具头**
  //     · `nodes`       = `surface.nodes`（每项 `{seq, tokens, heuristicTokens}`）← **只有 surface**
  //   而本插件原来：
  //     · 用 `totalTokens` 算 `ratio`（对，`measurePressure` 就该用这个）；
  //     · `retainTokens = floor((ratio − removeRatio) × window)` —— **也在 totalTokens 尺度上**；
  //     · 却把它交给 `selectIncrementalRange`，去 **nodes（只有 surface）** 上累加。
  //   ⇒ 只要 **工具头 > removePoints% × window**，就 `retainTokens > Σnodes`
  //     ⇒ 攒满全部节点仍不够 ⇒ `keepFromIdx` 退到 `firstIdx` ⇒ **返回 null**
  //     ⇒ **压缩永不发生**，而那条返回**不带 blocked/requeued** ⇒ **静默**（一条原因都不注入）。
  //
  //   ★ 本机为何必然踩到：**406 个工具**、定义 JSON ≈ **116K token** > **100K**
  //     （1M 窗口的 10% = `deltaRemovePoints` 默认 10）⇒ 稳定失败。
  //   ★★ 为何 934 项自检没抓到：旧夹具**自己写错了前提** ——
  //     30a 的注释断言"真实内核里 `totalTokens` 就是 surface 各节点之和"（原文如此），
  //     于是夹具让两者**内部自洽**，而真实环境**不自洽**。
  //
  //   ⇒ 修法：**把保留量算在 nodes 的尺度上** ——
  //     用 `Σ nodes` 当作"surface 有多大"，再按同一个 `removePoints` 比例扣。
  //     `retainTokens = max(1, Σnodes − removePoints% × window)`
  //     ★ 为什么减的是 `removePoints% × window` 而不是 `% × Σnodes`：
  //       设置项的口径是"**每轮压掉窗口的百分之几**"（用户原话"减10"，指 10 个点 = 窗口的 10%），
  //       那是**绝对量**，不能随 surface 缩放。所以保留 = Σnodes − 那个绝对量。
  //     ★ 下限：`max(1, …)` —— 不能压到 0（否则会把 system 头也搭进去）。
  const nodeSum = Array.isArray(measurement?.nodes)
    ? measurement.nodes.reduce((s, n) => s + Number(n?.tokens ?? 0), 0)
    : 0;
  const keepRatio = Math.max(0.01, pressure.ratio - removeRatio);
  const retainTokens =
    nodeSum > 0
      ? Math.max(1, Math.floor(nodeSum - removeRatio * pressure.window))
      : Math.floor(keepRatio * pressure.window); // 量不到节点时就退回旧口径（保持行为）
  let range;
  try {
    range = selectIncrementalRange(agent.session, measurement, retainTokens);
  } catch (e) {
    return { ok: false, compacted: false, reason: `选范围失败：${String(e?.message ?? e)}` };
  }
  if (range === null) {
    // ★ 压不动了（保留段已覆盖全部历史）⇒ 这是**交给全量高保真**的信号，
    //   不再是"没有可压的旧段落"那么简单。如实回报，让上层能据此判断。
    return { ok: false, compacted: false, reason: "没有可压的旧段落（保留段已覆盖全部历史）", noRange: true };
  }

  // ── 压缩前抓逐字胶囊（与高保真那条同一条规矩）+ **落盘**（D45）─────────
  //   ★ 增量压缩是**常态**那条（自动跑得最勤），所以这里的落盘最有用：
  //     它保证每一次自动压缩都留下一份**原件**，而不是只活在内存里。
  const capPersist = captureCapsuleBeforeCompact(state, key, projectInfo, capsuleMemory, "auto:delta");

  // ── 真压：`compactRegion`（owner 由内核硬编成 current-turn，所以必须在回合内）──
  //   ★★★ 2026-10-11：与全量那条**同样入队**（不再单槽覆盖）。
  //     `compactRegion` 也会发 `compaction/end`，所以票数一样要对上；
  //     下面每个失败/空转的出口都要 `popHfSourceLast` 退票。
  pushHfSource(state, key, "auto:delta");
  let result;
  try {
    result = await compaction.compactRegion(range.start, range.end, agent, AbortSignal.timeout(300_000));
  } catch (e) {
    const reason = String(e?.message ?? e);
    popHfSourceLast(state, key); // 退票：这次没有产生 compaction/end
    // ★ 回合约束没满足（例如恰好没有打开的回合）⇒ 退回"等 idle"那条老路，
    //   别让这一轮白过。这是**如实降级**，不是静默失败。
    if (/no open turn|current-turn/i.test(reason)) {
      state.hfCompactAfterTurn.set(key, { at: Date.now(), source: "auto:delta" });
      return { ok: false, compacted: false, reason: `退回 idle 路径：${reason}`, requeued: true };
    }
    return { ok: false, compacted: false, reason };
  }

  // ── 压成功 ⇒ 量**压后水位**（既当锚点，也当**实绩**）───────────────────
  //
  // ★★★ 锚点必须取**压后**水位，不能取压前（`pressure.ratio`）—— 这是个真 bug，
  //   我用 `tools/_probe-delta-anchor.mjs` 把两种锚点的轨迹摆出来证过：
  //
  //     锚点=压前：峰值 21 → 42 → 63 → **84** → 105 → 126 … 最高 **186 点**
  //     锚点=压后：峰值 21 → 33 → 33 → 33 → 33 …          最高 **30 点**
  //
  //   为什么会漂：压前是 32、压回 12，而锚点却记成 32 ⇒ 下次要涨到 52 才触发
  //   ⇒ **阈值一轮比一轮高**，一路撞进内核 0.8 区 —— 那正好违背用户
  //   *"尽量延缓达到70、80的时间"*。
  //   取压后 ⇒ 触发点稳定在 (压后 + trigger)。⚠️ **这里必须重新量一次**，
  //   因为压缩刚改过 surface，原来那个 `pressure` 已经过期了。
  //
  // ★★★ 2026-10-11（用户要求「把目标和实际完成度分开」）：
  //   同一个 `afterRatio` **顺便就是"这一轮实际压掉了多少点"** ——
  //   因为 `measurePressure` 给的是 `totalTokens/window`，与
  //   `sincePoints`、与注入里「实测：已用 N tokens」**同一把尺子**。
  //   ⇒ 于是"实绩"**不需要新测量、也不需要估**：`(压前 − 压后) × 100` 就是它。
  //   ★ 旧代码把 `removePoints`（**设置里的目标**）当成实绩报给模型，
  //     而实测只有目标的一半左右（根因见 DECISIONS D70）—— 那会误导模型的预算判断。
  //   ★ 为什么"实绩"在真实 token 口径上还会比这个数更小：
  //     内核的启发式估算把 `reasoning` 当文本一样计价，而 provider 对 thinking 的
  //     计费口径不同 ⇒ 真实请求的缩小量更少（实测约为启发式的一半）。
  //     所以下面报数时**只报同一把尺子量到的落差**，并明确标注它是什么尺子。
  let afterRatio;
  try {
    const after = measurePressure(ctx, agent);
    // ★ 兜底改成"**压前水位 − 本轮压掉的量**"（= 预期的压后水位），
    //   而**不是**旧的"保留常量"。量不到压后水位时，这个估计与真实值同阶，
    //   下一次触发点仍然落在 (预期压后 + 触发涨幅) 附近 —— 棘轮照常抬升。
    // ★ 走 `setAnchor` ⇒ **同时落盘**，重启不再丢（见 `anchorOf` 的注释）。
    afterRatio = after === undefined ? Math.max(0, pressure.ratio - removeRatio) : after.ratio;
  } catch {
    // 量不到就退到"预期压后水位"（比用压前的值安全得多）。
    afterRatio = Math.max(0, pressure.ratio - removeRatio);
  }
  setAnchor(state, key, afterRatio);
  // ★ 实绩（点）：压前水位 − 压后水位。**与目标分开报**（用户 2026-10-11 要求）。
  //   ⚠️ 量不到压后水位时 afterRatio 是"预期值"⇒ 此时实绩≈目标，**必须标注它不是实测**。
  const afterMeasured = measurePressure(ctx, agent) !== undefined;
  const actualPoints = afterMeasured ? Math.max(0, (pressure.ratio - afterRatio) * 100) : undefined;
  armReinject(state, key, agent);
  // ★★★ 2026-10-11（承 D79）：把**刚被压掉的这一段**记成可回读索引。
  //   数据来自内核已经写好的 `compaction/summary.shadowedRange/shadowedSeqs` ⇒ **零新增采集**。
  //   ★ 它必须记在**压缩之后**（那时 summary 事件才存在），且要在 `armReinject` 之后
  //     —— 因为压缩后重注会把这份索引一起推给模型。
  // ★★★ 阶段 1 第 2 件：把**逐字原件的去处**一并记进去（原来只记 seq ⇒ 读者只知道
  //   "原文在日志里"，不知道"同一份历史的成品已经有人分好类了"）。
  //   ★ 用 `capPersist.persistRel`（真落盘成功的那个相对路径）优先；
  //     拿不到就退回"按期间算出的胶囊目录"。两个都是**项目相对路径**（可直接复制）。
  recordShadowedIndex(state, key, agent, "auto:delta", {
    capRel: capPersist?.persistRel ?? capsulePathFor(projectInfo, Date.now()),
  });
  state.lastCompactCycleAt.set(key, Date.now());
  state.flushBlocked.delete(key);
  state.triageBlocked.delete(key);
  state.flushedAt.delete(key);
  // ★★★ 2026-10-11：**增量这条也要计数**（D59 的教训，且正是用户报的那一条）。
  //   用户原话：*"你有没有发现我们直到现在都没有进行任何一次**增量压缩**"* ——
  //   他指的正是这条路径。而我第一版把计数器只加在**全量**那条上
  //   ⇒ 若真去查，会得到"压缩 0 次"的**假象**（增量明明在跑）。
  //   ★ 教训与 `flushBeforeCompact` 的计数同一条纪律：
  //     **计数必须放在唯一收口处，否则一定有一条路径被漏掉。**
  //     这里增量与全量是**两个**收口 ⇒ 两处都要记（且用同一个 `compactCountsOf` 口径）。
  try {
    const cc = state.compactCounts.get(key) ?? { total: 0, delta: 0, full: 0 };
    cc.total += 1;
    cc.delta += 1;
    cc.lastAt = Date.now();
    cc.lastSource = "auto:delta";
    state.compactCounts.set(key, cc);
  } catch {
    /* 计数失败绝不影响压缩本身 */
  }

  // ★★ 这里**不再**置 `hfCompacted`。
  //
  //   旧代码在这里写了 `state.hfCompacted.set(key, true)`，注释说"免得紧接着 70% 那条
  //   又把剩下的全压一遍"。**但那是一处真 bug**（2026-10-10 用户报的
  //   "按理说现在已经到全量高保真的时候了，但水位还在这里"，根因之一就是它）：
  //
  //   · `hfCompacted` 的语义是「**本会话已经做过一次全量高保真**」，
  //     而 70% 那条的判据正是 `state.hfCompacted.get(key) !== true`（见 L9520 附近）；
  //   · 它**除了会话销毁（agent/disposed）之外从不复位**；
  //   · ⇒ 增量压缩每成功一次就把它置真 ⇒ **第一次增量之后，70% 全量高保真永久失效**。
  //     于是水位永远到不了"该全量"那一刻 —— 正是用户观测到的现象。
  //
  //   ★ 为什么"怕紧接全压"这个担心本身不成立：
  //     增量压实跑之后水位只降 `removePoints`（默认 10 点），**不会掉到 70% 以下**；
  //     而 70% 那条自带 `pressure2.ratio >= 0.70` 判据 ⇒ 压完若已低于 70%，它自然不排；
  //     若仍在 70% 以上，**那本来就该全量**（用户要的正是这个）。
  //   ⇒ 两道判据各司其职，不需要用 `hfCompacted` 去"堵"另一条。
  return {
    ok: true,
    compacted: true,
    range,
    // ★ 棘轮口径：报"这一轮打算压掉多少点"与"压后预期水位"，而不是旧名"保留 N 点"。
    //   ⚠️ `removedPoints` 是**目标**（来自设置），不是实绩 —— 调用方必须把两者分开写。
    removedPoints: removePoints,
    keptRatio: keepRatio,
    // ★★★ 2026-10-11（用户："把我的目标和实际完成度分开"）：
    //   **实绩** = 压前水位 − 压后水位（同一把尺子量到的真实落差）。
    //   ★ 为什么必须分开：实测实绩只有目标的 **~44%**（DECISIONS D70/D72）——
    //     若只报目标，模型会以为自己腾出了 10 点的空间，从而高估剩余预算。
    //   ★ `actualPoints === undefined` ⇒ 压后水位**量不到**，此时**不许报数**
    //     （宁可不报，也不报一个假实绩 —— 同 `measurePressure` 的既有原则）。
    actualPoints,
    beforePoints: Math.round(pressure.ratio * 1000) / 10,
    afterPoints: Math.round(afterRatio * 1000) / 10,
    sincePoints: Math.round(since * 100),
    shadowedTokens: result?.shadowedTokenCount,
    nodes: result?.shadowedSeqs?.length,
    // ★ 落盘结果如实带回：没启用日志时**说清楚**，不假装存了。
    capsulePersisted: capPersist.persisted,
    capsuleRel: capPersist.persistRel,
    capsulePersistReason: capPersist.persistReason,
  };
}

/**
 * ★★ 高保真压缩的**唯一执行器**（自动 70% 那条与手动那条共用）。
 *
 * 抽成一个函数的原因（2026-10-09 用户要求"手动压缩也要执行我们的压缩"时发现）：
 *   原来有**两条**几乎重复的压缩路 —— 自动那条（水位 70%）会抓胶囊，
 *   而手动那条（用户选「记录台账 + 执行压缩」）**只调 `compactNow`、不抓胶囊**。
 *   ⇒ 用户手动压一次，压完就没有逐字胶囊可重注了，**"我们的压缩"没生效**。
 *   两条路各写一遍，迟早会再分叉。所以这里只留一份。
 *
 * ★ 时序上必须**在 `compactNow` 之前**抓胶囊：压缩一跑，会话事件的去重集合
 *   与"当时上下文里有什么"都变了；压缩后再现取的胶囊会缺掉**刚好被压掉**的那一段，
 *   而那一段正是我们要救的东西。
 *
 * ★ 调用者必须在 agent **idle** 时调（`compactNow` 非 idle 会抛 `busy`）。
 *
 * @returns {Promise<{ok:boolean, compressed:boolean, reason?:string, capsuleChars?:number}>}
 */
/**
 * ★★★ 压缩**前**抓胶囊的**唯一入口**（4 条压缩路径全走它）。
 *
 * 做三件事，缺一不可：
 *   ① 生成胶囊正文（`renderCapsule`）；
 *   ② 存进 `state.capsuleSnapshot` —— 压缩后重注时要用**这一份**
 *      （压缩一跑，"当时上下文里有什么"就变了，压后再取会缺掉刚被压掉的那段）；
 *   ③ **落盘**（`persistCapsule`）—— 原先只有 ①②，于是胶囊一重启就没了、一消费就没了。
 *      落盘失败**不挡压缩**（可回溯是加分项，压缩本身是主功能），但要如实带回原因。
 *
 * @returns {{chars:number, persisted:boolean, persistRel?:string, persistReason?:string}}
 */
function captureCapsuleBeforeCompact(state, key, info, capsuleMemory, source) {
  const out = { chars: 0, persisted: false };
  if (info === undefined) return out;
  try {
    // ★★★ D61：**先把盘上那份并回来**，再渲染 —— 否则重启后的第一次压缩
    //   只看得见"重启以来"的那几条原话（正是 D61 实测到的 1 条）。
    //   ★ 放在这里（而不是启动时统一读）的理由：只有真正要压缩时才需要这份历史，
    //     启动时读会白白拖慢每一次会话开启。
    try {
      if (state.capsuleHydrated !== undefined && !state.capsuleHydrated.has(key)) {
        state.capsuleHydrated.add(key);
        const n = hydrateCapsuleMemory(capsuleMemory, key);
        if (n > 0) out.hydrated = n;
      }
    } catch {
      /* 并回来失败就按"只有内存那份"走，不许挡住压缩 */
    }

    const snap = renderCapsule(info, capsuleMemory?.get(key));
    if (snap === undefined) return out;
    state.capsuleSnapshot.set(key, snap);
    out.chars = snap.length;
    // ★ 落盘这一步单独 try：写盘失败绝不能让压缩失败。
    try {
      const pr = persistCapsule(info.projectRoot, info, key, snap, { source });
      out.persisted = pr.ok === true;
      if (pr.ok === true) out.persistRel = pr.rel;
      else out.persistReason = pr.reason;
    } catch (e) {
      out.persistReason = String(e?.message ?? e);
    }
    // ★★★ D61：把**素材本身**也刷到盘上（上面那步存的是渲染好的胶囊快照，
    //   那是"证据"；这一步存的是"原材料"，供重启后重新渲染）。
    //   ★ 放在渲染之后：万一渲染抛错，也还有机会在别的路径刷；
    //     但正常路径下它一定执行到。
    try {
      persistCapsuleMemory(key, capsuleMemory?.get(key));
    } catch {
      /* 同上：落盘失败绝不影响压缩 */
    }
  } catch {
    /* 抓不到就不抓，别挡住压缩 */
  }
  return out;
}

/**
 * ★★★ 2026-10-12：从压缩异常里取出**结构化的失败类别**。
 *
 * 内核的 `ManualCompactionError`（`dsh-compaction/lib/types/index.js`）**带一个稳定的
 * `code` 字段**，取值是 `busy | cancelled | persistence | commit | changed | summary`。
 *
 * ★ 为什么必须用它、而**不能靠解析那句话**（真机实测，2026-10-12）：
 *   内核的 `busy` 有**三条不同的原文**，散在三个地方：
 *     ① `manual compaction: the session already has an open turn`（`:457`）—— 旧正则认得
 *     ② `${stage}: compaction already in progress; the session compaction lock is already active`（`:538`）—— **旧正则漏**
 *     ③ `manual compaction requires an idle agent with no waking queued work`（`:1009`）—— **旧正则漏**
 *   ⇒ **3 条 `busy` 漏 2 条**。用户 2026-10-12 01:13 撞上的正是 ③：
 *     插件没认出它 ⇒ 落到"硬错误"分支 ⇒ 回「**压缩没有发生**」，
 *     而那一刻**自动全量正在跑**（428,652 tok 的那次）⇒ **把"已经在做了"说成了"失败了"**。
 *   ★ 而这三条 `code` **全都是 `"busy"`** —— 判 `code` 一次就对，判文本要追三条、
 *     还追不住内核下次改文案。**判据只吃稳定字段。**
 *
 * ★ 为什么这个函数必须存在（否则修复会漏一路）：`runHighFidelityCompact` 的 `catch`
 *   原来 `return { … reason: String(e.message) }` —— **把 `code` 丢在这里**，
 *   于是下游（命令入口）**再也拿不到**它，只能去猜话。修在这个收口处即可覆盖四条入口。
 */
function compactionErrorCodeOf(e) {
  const code = e?.code;
  if (typeof code === "string" && code !== "") return code;
  // 次要线索：内核给这个类挂了固定 `name`。有它但没 code 时不假装知道类别。
  return undefined;
}

/**
 * ★★★★★ 2026-10-13（D166）：**把内核那句误导标签翻译成人话** —— 唯一出口。
 *
 * ★ 真机缺陷（2026-10-13 13:18，用户原话：
 *   *"压缩没有发生：manual compaction could not produce a smaller summary。
 *     也就是我手动点压缩好像不太行了"*）：
 *   本插件 `runManualCompactNow` 原来把内核 `ManualCompactionError.message`
 *   **原样转述**成「压缩没有发生：<那句话>」。而内核那句**字面即误导** ——
 *   `dsh-compaction-basic:527` 的 `throwManualFailure()` 把**所有**
 *   `stage === "summary"` 的失败（**包括 provider 断流**）**一律**说成
 *   "could not produce a smaller summary"，听着像"**没东西可压**"。
 *   ⇒ 用户**无法区分**两种完全不同的处境：
 *     · 「provider 这次断了，**再按一次就好**」；· 「真的没东西可压，按了也白按」。
 *   ★ 处置方式天差地别 ⇒ 说错就是**误导用户**（伤"准确性"）。
 *
 * ★ 真因在哪（逐字核过内核源码，不是猜）：`throwManualFailure` 把真因塞进
 *   `ErrorOptions.cause`（`{ cause: failure.error }`）⇒ 异常链上就有。
 *   真机那次真因是 `"Stream ended without finish_reason"`
 *   （`@earendil-works/pi-ai/.../openai-completions.js:485`）＝ provider 流中断。
 *
 * ★ 判据口径：**只在"内核那句话本身没有信息量"时才加译注**；
 *   其余 `code`（`busy`/`cancelled`/`persistence`/`commit`/`changed`）原文
 *   **已经说清楚了**，一律不动 —— 不许给好句子硬加尾巴。
 *
 * @param {Error} e 内核抛出的异常
 * @returns {string|undefined} 附加说明（无话可说时返回 `undefined`，由调用方原样回）
 */
function compactionFailureAdvice(e) {
  try {
    // 只对 `summary` 这档加译注：它是唯一"原文与真因无关"的档。
    if (e?.code !== "summary") return undefined;
    const cause = e?.cause;
    const causeMsg = String(cause?.message ?? cause ?? "").trim();
    // ★ 真因取不到时**如实说取不到**，绝不替内核编一个原因（D164 同一条纪律）。
    const real = causeMsg === "" ? "内核没把真因带出来" : `真因是：${causeMsg}`;
    return (
      `★ 注意：这句是**内核的固定文案**，不等于"没东西可压"。` +
      `内核把所有"摘要阶段"的失败都记成这一句，**真因它塞在 \`cause\` 里**：${real}。\n` +
      (causeMsg === ""
        ? ""
        : "★ 若真因是 **provider 流中断 / 超时**（如 `Stream ended without finish_reason`），" +
          "那是**瞬时故障**：**过一会儿再按一次**通常就能压成；本插件已把台账与逐字胶囊保留好，不会因此丢东西。")
    );
  } catch {
    return undefined;
  }
}

async function runHighFidelityCompact(ctx, state, agent, capsuleMemory, source) {
  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid === "") {
    return { ok: false, compressed: false, reason: "拿不到会话 id" };
  }
  const key = String(sid);

  // ★★ 这一处最关键：它是**自动 70% 那条路**唯一压的地方。
  //   原来直接 `ctx.get("compaction")` ⇒ 本 profile 下恒 undefined
  //   ⇒ 这个功能**从未真正执行过**。
  //   见 `compactionServiceFor` 的注释（正解是 agentPresets.serviceFor）。
  const compaction = compactionServiceFor(ctx, agent);
  if (compaction === undefined) {
    return { ok: false, compressed: false, reason: "本机没有 compaction 服务" };
  }

  // ① 压缩**之前**抓胶囊（哪怕接下来压不成，这份快照也不会有害）。
  //
  // ★ 这里同时把 `info` 留下来给闸门用：闸门要判断"**这个项目有没有台账**" ——
  //   没有台账的会话不该被"强制落盘"拦住（那是不可能执行的指令，会变成死锁）。
  let capsuleChars = 0;
  let projectInfo;
  let capsulePersist = { persisted: false };
  try {
    const root = projectRootOf(agent);
    projectInfo = root === undefined ? undefined : inspect(root);
    // ★ 2026-10-10（D45）：改走 `captureCapsuleBeforeCompact` —— 它多了一步**落盘**，
    //   于是胶囊不再"重启就没、消费就没"。
    capsulePersist = captureCapsuleBeforeCompact(state, key, projectInfo, capsuleMemory, source);
    capsuleChars = capsulePersist.chars;
  } catch {
    /* 抓胶囊失败不该挡住压缩本身 */
  }

  // ★ 量一下当前水位：闸门有一条旁路要按它判断（≥75% 就不再拦，见
  //   `FLUSH_GATE_BYPASS_RATIO`）。量不到就是 undefined ⇒ 那条旁路不生效
  //   （此时宁可保守地按原规则走，也不假设水位很低）。
  let measuredRatio;
  try {
    measuredRatio = measurePressure(ctx, agent)?.ratio;
  } catch {
    /* 量不到就算了 */
  }

  // ② 真压。
  //
  // ★★ 压缩前那道**强制落盘**闸门（用户 2026-10-09 反复强调的那一条）：
  //   *"每次压缩之前强制进行台账更新和日志更新"* —— 关键是**强制**。
  //   压在 70% 的语义是"在细节丢掉之前先把状态落袋"；若这一轮的进展还没写进
  //   台账 / L1，那一压就是把**唯一副本**压掉。
  //   ⇒ 闸门放在**这里**（四条入口唯一的收口）⇒ 自动 / 工具 / 命令 / 卡片
  //     四条路**全都**受它约束，一处不漏。
  //   ★ 被拦下**不是失败**：把意图退回队列（`hfCompactAfterTurn` 重新挂上），
  //     等 AI 写完落盘、下一次 idle 再压。这也解释了为什么它必须放在
  //     `runHighFidelityCompact` 里而不是各入口 —— 否则"退回去"要写四遍。
  //
  // ★★ 2026-10-09 补两条**旁路**（用户："到水位的时候主动按压缩不能进行，比较危险"）：
  //   ① 人手动发起的（`/ledger compact`）**不拦** —— 闸门约束的是 AI 的工作流，
  //      不该把用户的明确授权挡回去；
  //   ② 水位 ≥ 75% **不拦** —— 此时拦下自己的安全压缩只会把机会让给内核 0.8 那次
  //      （它抓不到胶囊），方向反了。
  //   两条都在返回值里如实标注（`flushGate` / `flushForcedThrough`），不假装合规。
  const gate = flushBeforeCompact(state, key, projectInfo, {
    manual: MANUAL_COMPACT_SOURCES.has(source),
    ratio: measuredRatio,
    // ★★★ 2026-10-12（D119）：**这里是全量那条路** ⇒ 打上 `mode: "full"`，
    //   闸门据此**不让 0.75 旁路生效**（用户原话："但是全量也要先记台账日志！！！"）。
    //   ★ 理由：全量压得最狠 ⇒ 没落盘的那段进展会成为唯一副本 ⇒ 它比增量**更**需要先落盘。
    mode: "full",
  });
  if (gate.ok !== true) {
    // ★★ 计数**不在这里加**：闸门内部已经加了（`flushBeforeCompact` 里那次
    //   `rec.count += 1`）。这里若再加一次，就会变成"拦 2 次就放弃"（本意是 3 次），
    //   而且与增量那条的计数口径不一致。这里只取回它记下的数字，用于回报。
    const rec = state.flushBlocked.get(key) ?? { count: 0 };

    // ★ 把意图退回去：下一次 idle 会再试一次（届时 AI 可能已经写完了）。
    //   ⚠️ `hfCompacted` **不置真** —— 因为这次根本没压，会话该压的资格还在。
    //     （与"没有可压缩的历史"那条一致：不压就别把资格用掉。）
    state.hfCompactAfterTurn.set(key, { at: Date.now(), source: source ?? "auto", retry: true });

    return {
      ok: false,
      compressed: false,
      reason: gate.reason,
      blocked: true,
      retryQueued: true,
      blockedCount: rec.count,
      ...(gate.hint === undefined ? {} : { hint: gate.hint }),
    };
  }

  // ★ 先把"谁发起的"记下（需求 ②③）：内核的 `compaction/end` **不知道**这一点，
  //   而 L0 采集要在那条事件上写出"自动 70% / 手动（工具/命令/卡片）"。
  //   记在这里而不是各调用点，是因为**四条入口都经过这一个函数** ——
  //   记一处就不可能漏。
  //
  // ★★★ 2026-10-11 实测改正（用户第 2 点）：改成**入队**，不再是覆盖。
  //   旧写法 `state.hfSource.set(key, source)` 是**单槽**，后写覆盖先写。
  //   实测事故（这一条骗过了用户也骗过了我）：
  //     19:27:38 自动全量**真的开始跑了**（胶囊为证），19:27:57 又来了一次手动命令
  //     ⇒ 单槽被后者覆盖 ⇒ 内核发 `compaction/end` 时读到的来源是「command」
  //     ⇒ L0 把那次全量记成「手动（命令）」⇒ **看起来"自动全量从来没跑过"**。
  //   ★ 所以：**压前入队一个票，`compaction/end` 出队一个**。
  //     失败路径必须把票退掉（下面每个 return 都 pop），否则队列越积越长，
  //     后面的 end 会认领到**别人的**来源 —— 那就是同一个 bug 换个方向再犯一次。
  pushHfSource(state, key, source);
  let result;
  try {
    result = await compaction.compactNow(agent, AbortSignal.timeout(300_000));
  } catch (e) {
    popHfSourceLast(state, key); // 票退掉（退**自己**那张）：这次压缩没有产生 compaction/end
    // ★★★ 2026-10-12：**把结构化的 `code` 一起带出去** —— 原来只带 message，
    //   于是下游只能靠猜话认"忙"，而内核的 busy 有三条不同原文（已漏 2 条）。
    //   见 `compactionErrorCodeOf` 的注释（真机事故：把"正在做"说成"没发生"）。
    const code = compactionErrorCodeOf(e);
    // ★★★★★ 2026-10-13（D166）：**把内核那句固定文案翻译成人话**。
    //   ★ 真机缺陷：内核把所有"摘要阶段"的失败（含 provider 断流）一律说成
    //     "could not produce a smaller summary"（字面像"没东西可压"）
    //     ⇒ 我们原样转述 ⇒ 用户无法区分「重试就行」与「按了也白按」。
    //   ★ 修在这一处收口 ⇒ 四条入口（自动/手动命令/卡片/工具）全都覆盖，
    //     不必改四个调用点（D59：计数/记录/翻译都必须放唯一收口，否则必漏一路）。
    const advice = compactionFailureAdvice(e);
    return {
      ok: false,
      compressed: false,
      reason: String((e && e.message) || e),
      // ★ 注意**不复用 `hint`**：那是"指向某个工具名"的短字段，
      //   既被命令入口当**代码块**渲染（`建议：\`${hint}\``），又被自检按
      //   **精确值**断言（`r.hint === "ledger_write"`）⇒ 塞多行说明会同时打破两处。
      //   ⇒ 另开一个字段，由渲染端按块渲染。
      ...(advice === undefined ? {} : { causeNote: advice }),
      ...(code === undefined ? {} : { errorCode: code }),
      capsuleChars,
    };
  }

  if (result === null) {
    popHfSourceLast(state, key);
    // 没有可压的历史：**不要**把 `hfCompacted` 留着为真，否则这轮之后再也不试了。
    state.hfCompacted.delete(key);
    return { ok: false, compressed: false, reason: "没有可压缩的历史", capsuleChars };
  }

  // ③ 压成功 ⇒ 下一次 pre-step 强制重注（台账 + 胶囊）。
  armReinject(state, key, agent);
  // ★★★ 2026-10-11（D86/D87）：**全量也必须更新锚点** —— 这是"增量被饿死"的真根因。
  //
  //   实测（用户 19:1x 亲自观察并质疑）：
  //     `anchors.json` 本会话锚点 = **49.7%**，其 **mtime = 05:39:39**（最后一次**增量**）；
  //     而 15:51 与 17:33 各做过一次**全量** ⇒ **锚点仍是 05:39 那个值**。
  //   代码依据：`setAnchor(` 全仓库只出现一次，位于**增量**那条路（见上文的对应注释），
  //     全量这条路**从头到尾没碰过锚点**。
  //
  //   ⇒ 后果（这就是用户看到的"增量再也不触发"）：
  //     触发判据是 `水位 ≥ 锚点 + deltaTriggerPoints(20)` ⇒ 锚点 49.7% 时**要涨到 69.7%**；
  //     而每涨到 ~70%，**"绝对 70%"那条先满足 ⇒ 排的是全量**；全量压完又不降锚点
  //     ⇒ 锚点永远停在 49.7% ⇒ 下一轮仍要涨回 69.7% ⇒ **全量永远先到，增量被永久挤掉**。
  //   ★ 这是 D54「增量让路给全量」的**反向变体**：让路本身对，但**全量没把锚点降下来**。
  //
  //   ★ 锚点的语义是"**上次压完的水位**"，是"再涨 N 点就压"的基准 ——
  //     任何一次成功的压缩（不论增量还是全量）都必须把它带回来，否则基准就失效。
  //   ★ 为什么取**压后实测水位**（而不是"压前 − 目标"）：与增量那条**同一把尺子**，
  //     这样"距上次压缩涨了几点"在两条路径上是可比的。
  //   ⚠️ 已知反作用（如实记下）：锚点降下来之后，增量会在**更低的水位**就触发
  //     ⇒ 压得更频繁。`deltaTriggerPoints` 的取值是否仍合适，需在真机上观察后再定
  //     （见 DECISIONS D87 的待办）。
  try {
    const afterFull = measurePressure(ctx, agent);
    if (afterFull !== undefined) setAnchor(state, key, afterFull.ratio);
  } catch {
    /* 量不到就不动锚点（宁可保持旧值，也不要写一个猜的） */
  }
  // ★★★ 2026-10-11（承 D79）：高保真这条**同样**要记「被压段索引」。
  //   ★ 与增量那条是**两个收口**，两处都要记 —— 否则又犯"计数只加一条路"的老毛病
  //     （D59：计数必须放在唯一收口处，否则一定漏一条路）。
  // ★★★★★ 2026-10-13（D163）：**`capRel` 必须一起传** —— 真机缺陷：
  //   原来这里只传了 source ⇒ 全量压缩记下的索引行**没有「逐字原件」指针**，
  //   而增量那条（L13194）传了。于是模型看到的那一行只说「原文在日志里」，
  //   不知道"同一份历史的成品（胶囊）已经有人分好类了" —— 那正是 D85 要修的事，
  //   在**全量**这条路上**没修到**。
  //   ★ 现场：本回合注入里那行就缺 `｜逐字原件：…`（而同一份注入的胶囊段是完整的）。
  //   ★ 判别力：摘掉 `capRel` ⇒ 情形 66② 当场红。
  //   ★ `capsulePersist` 就在上面几行手里（`captureCapsuleBeforeCompact` 的返回值），
  //     **路径在手却没传** —— 与 D85 那条"信息有了、没接到一起"是同一族病。
  recordShadowedIndex(state, key, agent, source ?? "auto:full", {
    capRel: capsulePersist?.persistRel ?? capsulePathFor(projectInfo, Date.now()),
  });
  state.hfCompacted.set(key, true);
  // ★★ 记下"本会话刚压过一次" ⇒ 闸门从此要求**新的**一次落盘才能再压
  //   （这就是"一次压缩，一次落盘"的周期起点）。
  state.lastCompactCycleAt.set(key, Date.now());
  // ★★★ 2026-10-11：**可查的计数器**（D59 的教训）。
  //   用户那轮的原话是"你有没有发现我们直到现在都没有进行任何一次增量压缩" ——
  //   我写了棘轮、自检全绿、还发了版，却从没核对过"压缩真的发生了"。
  //   ⇒ 凡是"应该会发生"的事，都必须留下一个**能被读出来的整数**（不是推断）。
  //   ★ 这一个计数器同时救了两种事故：① 功能没跑（数字不涨）；② 跑得不对劲
  //     （比如只增不减、或 delta/total 比例失衡）。
  //   `reason` 用来分辨是"增量"还是"全量"，以及"是为什么放行的"。
  try {
    const cc = state.compactCounts.get(key) ?? { total: 0, delta: 0, full: 0 };
    cc.total += 1;
    if (source === "auto" || source === "auto:delta") cc.delta += 1;
    else cc.full += 1;
    cc.lastAt = Date.now();
    cc.lastSource = source;
    state.compactCounts.set(key, cc);
  } catch {
    /* 计数失败绝不影响压缩本身 */
  }
  // 压成功了 ⇒ 之前攒的"被拦次数"清零（那个计数只描述"连续没落盘"）。
  state.flushBlocked.delete(key);
  state.triageBlocked.delete(key);
  state.flushedAt.delete(key); // 让"落盘时刻"回到未落盘，逼出下一个周期的落盘
  return {
    ok: true,
    compressed: true,
    capsuleChars,
    source,
    // ★ 如实报告闸门是怎么放行的：真落过盘 / 因为没有台账 / 还是因为拦够了放行。
    ...(gate.why === undefined ? {} : { flushGate: gate.why }),
    ...(gate.forcedThrough === true ? { flushForcedThrough: true } : {}),
    // ★ D59 教训：把计数器一并回报，让"到底压了几次"一读就知道。
    ...(compactCountsOf(state, key) === undefined
      ? {}
      : { sessionCompactions: compactCountsOf(state, key) }),
    // ★ D45：胶囊落盘结果（没启用日志时说清原因，不假装存了）。
    capsulePersisted: capsulePersist.persisted,
    ...(capsulePersist.persistRel === undefined ? {} : { capsuleRel: capsulePersist.persistRel }),
    ...(capsulePersist.persistReason === undefined ? {} : { capsulePersistReason: capsulePersist.persistReason }),
  };
}

/**
 * ★★★ 2026-10-11：**本会话到底压缩了几次** —— 一个能被读出来的整数。
 *
 * 为什么必须存在（D59 的教训，用户先发现的）：
 *   我写了棘轮、自检 907 全绿、还发了 1.0.0，**却从没核对过"压缩真的发生了"**。
 *   用户那句 *"你有没有发现我们直到现在都没有进行任何一次增量压缩"* 点破的正是
 *   这个盲区：**"配了就该跑"不是证据**。
 *   ⇒ 凡是"应该会发生"的事，都要有一个**可查的计数器**，而不是靠推断。
 *
 * 返回 `undefined` = 本会话还没压过（**不是** `{total:0}`：两者的区别有意义，
 * 在这里与 `hfCompacted` / `anchors.json` 的口径保持一致）。
 */
function compactCountsOf(state, sid) {
  const rec = state.compactCounts?.get?.(String(sid));
  return rec === undefined ? undefined : { ...rec };
}

/**
 * ★★★ 2026-10-11：压缩来源的**入队 / 出队**（修「单槽被并发覆盖」，见 `hfSource` 的注释）。
 *
 * 为什么必须是队列而不是单值：内核的 `compaction/start` / `summary` / `end` 是**有序成对**的，
 * 而两次 `runHighFidelityCompact` **可以重叠**（各要几十秒）。
 * 单槽 ⇒ 后写覆盖先写 ⇒ 先跑的那次在 `compaction/end` 上认领到**别人的**来源。
 *
 * ★ 为什么要 `pop` 而不是 `get+delete`：`get+delete` 永远取队首，
 *   而**票数必须与 `end` 数一致**才能一一对上。所以失败路径要把票退掉。
 */
function pushHfSource(state, sid, source) {
  try {
    const q = state.hfSource.get(String(sid)) ?? [];
    q.push(source === undefined ? "auto" : source);
    state.hfSource.set(String(sid), q);
  } catch {
    /* 记来源失败绝不影响压缩本身 */
  }
}

/** 取走队首（`compaction/end` 时调用）。队空返回 `undefined`（= 不是我们发起的，例如内核 80%）。 */
function popHfSource(state, sid) {
  try {
    const q = state.hfSource.get(String(sid));
    if (q === undefined || q.length === 0) return undefined;
    const src = q.shift();
    if (q.length === 0) state.hfSource.delete(String(sid));
    return src;
  } catch {
    return undefined;
  }
}

/** 撤销**最后一次**入队（失败路径用）：`compactNow` 没跑成 ⇒ 那次不会有 `compaction/end`。 */
function popHfSourceLast(state, sid) {
  try {
    const q = state.hfSource.get(String(sid));
    if (q === undefined || q.length === 0) return;
    q.pop();
    if (q.length === 0) state.hfSource.delete(String(sid));
  } catch {
    /* 退票失败也无害 */
  }
}

/**
 * 算台账内容的稳定指纹（用于"没变就不重注"）。
 *
 * ★★★ 2026-10-12（D132）**从"便宜指纹"改成"内容感知指纹"**（用户底线内的一条纯赚改动）。
 *
 * **病**（真机实测，`_acc018-cr.mjs`，本会话最近 6 小时 37 条注入）：
 *   旧指纹是 `路径|行数|mtime` —— 而 `mtime` **只要文件被碰过就变**：
 *   · 插件自己追加一行「变更登记」⇒ mtime 变 ⇒ **整份台账（约 17K 字符）重注一遍**；
 *   · 实测：3/36 对注入 **正文字节完全相同**，却因为是新 mtime 而**又注了一遍**
 *     （合计 **58K 字符 = 零信息**）。
 *   ⇒ ★ 直接后果：**水位被无意义地推高 ⇒ 压缩更频繁 ⇒ 缓存反复打冷**。
 *
 * **修法（为什么它不伤准确性 —— 这是用户的硬底线）**：
 *   · 只在**字节完全相同**时才跳过 ⇒ 内容真变了**照旧注全文**，
 *     所以模型手里**永远有完整的台账**（不像"只注变更段"，那会让它手里没有全文）。
 *   · 判据取**正文字节**（`utf8` 内容本身），不取 mtime、不取行数。
 *   ★ 代价：每步读一次台账文件算哈希。台账 ≤ 350 行（约 17K 字符）⇒ 走内存里已有那一步即可，
 *     比"每步真注 17K"便宜得多（后者要占上下文，代价是 token，不是 CPU）。
 *   ★ 用 `activeLines` 仍留在指纹里：内容相同但行数不同不可能（同字节 ⇒ 同行数），
 *     留着只是让它可读、便于诊断 —— 不参与"是否重注"的判断。
 */
function fingerprintOf(info) {
  if (!info.activeExists || info.activeAbs === undefined) return "absent";
  let text;
  try {
    text = fs.readFileSync(info.activeAbs, "utf8");
  } catch {
    // ★ 读不到 ⇒ **返回一个每次都不等的值**（`unreadable|单调递增`）：
    //   宁可多注一次，也不能因为读盘失败就误判成"没变"而**不注**（那才是伤准确性）。
    //   ⚠️ 我第一版写的是 `Date.now()` —— 而**同一毫秒内连续两次调用会得到同一个值**
    //     ⇒ 那正是"误判没变"⇒ 漏注（伤准确性）。自检 54③ 当场抓到 ⇒ 改成单调递增计数。
    unreadableSeq += 1;
    return `${info.activeRel}|unreadable|${unreadableSeq}`;
  }
  let h = 0x811c9dc5; // FNV-1a 32 位：够用且零依赖（不需要 crypto，也不引外部包）
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${info.activeRel}|${info.activeLines}|${h.toString(16)}`;
}

/** 读盘失败时的单调递增计数（见 `fingerprintOf` 里的"每次都不等"）。 */
let unreadableSeq = 0;

export function apply(ctx, config) {
  const cfg = config !== null && typeof config === "object" ? config : {};
  const state = newState();
  const disposers = [];

  // ★★ 第一件事：把设置**归一化后**立起来（`currentSettings()` 全靠它）。
  //
  // ★ 为什么必须是最前面：`inspect()` / `levelOn()` / `parseLevels()` 都是纯函数，
  //   它们**按进程级设置**取默认值，而工具注册、事件挂载都可能立刻用到它们。
  //   放在后面就会有一个"设置还是默认值"的窗口 —— 那个窗口里的行为与用户设置不符。
  //
  // ★ 为什么也在这里**兜一层校验**：内核已用 `export const Config` 校验过一遍
  //   （正常路径下不会出错），但自检与直接调用可能绕过内核。`settingsOf` 便宜且必要。
  const settings = settingsOf(cfg);
  setActiveSettings(settings);

  // ★★ 高保真胶囊的采集器：**独立于日志采集器，而且无条件创建**。
  //
  // ★ 为什么必须在**工具注册之前**建：`ledger_compact`（手动压缩）要用它
  //   在压缩前抓快照 —— 它得先存在。原来它建在文件后半段（靠近日志采集器），
  //   那样工具注册时它还是 `undefined`（TDZ 直接报错）。
  //
  // ★ 为什么独立于日志：日志是**可选**的（没登记 `logDir` 就不采集），
  //   而高保真压缩是**每个会话都要有**的兜底 —— 实测 104/112 个会话在容器根、
  //   没有清单、没有日志。若把胶囊挂进日志采集器，它们就完全没有高保真能力。
  const capsule = (() => {
    try {
      return createCapsuleMemory();
    } catch (e) {
      try {
        ctx.logger?.warn?.(
          `${name}: 高保真胶囊初始化失败，压缩后重注将只有台账：${String((e && e.message) || e)}`
        );
      } catch {
        /* 连 logger 都没有就算了 */
      }
      return undefined;
    }
  })();

  /**
   * ★★★ B3' 修复（2026-10-11）：胶囊素材的**去抖落盘器**。
   *   ★ 为什么必须有：原来只在「压缩前 / 会话销毁」两个时点落盘
   *     ⇒ 最后一次落盘之后新增的素材，重启时**必然丢**（实测牺牲品见函数注释）。
   *   ★ 为什么不能直接写盘：`session/event` 同步跑在官方 `Session.append()` 上。
   *   ⇒ 攒 + 去抖（复用 `LOG_FLUSH_DEBOUNCE_MS`），且定时器 `unref()`。
   */
  const capsulePersister = (() => {
    try {
      if (capsule === undefined) return undefined;
      return createCapsulePersister(capsule, () => undefined);
    } catch (e) {
      try {
        ctx.logger?.warn?.(`${name}: 胶囊去抖落盘器初始化失败（只影响重启后还记得多少）：${String((e && e.message) || e)}`);
      } catch {
        /* 连 logger 都没有就算了 */
      }
      return undefined;
    }
  })();
  if (capsulePersister !== undefined) {
    disposers.push(() => {
      try {
        // ★ 收尾时**先刷一次**（把最后攒的那批写下去），再清定时器。
        capsulePersister.flushNow();
        capsulePersister.dispose();
      } catch {
        /* 收尾失败不影响卸载 */
      }
    });
  }

  // ── 工具 ────────────────────────────────────────────────────────────────
  // 每个各自 try/catch：一个注册失败不许拖垮其它，更不许让 apply 抛错
  // （apply 抛错 ⇒ 整个 profile 组合失败 ⇒ 内核起不来，见文件头 ②）。
  for (const [label, factory] of [
    ["ledger_status", () => defineStatusTool(ctx, state)],
    ["ledger_init", defineInitTool],
    ["ledger_read", defineReadTool],
    ["ledger_write", () => defineWriteTool(state)],
    ["ledger_archive", () => defineArchiveTool(state)],
    ["ledger_log", defineLogTool],
    ["ledger_recall", () => defineRecallTool(state)],
    ["ledger_log_write", () => defineLogWriteTool(state)],
    ["ledger_note", defineNoteTool],
    ["ledger_handoff", defineHandoffTool],
    ["ledger_triage", () => defineTriageTool(state)],
    ["ledger_lock", defineLockTool],
    ["ledger_conform", defineConformTool],
    ["ledger_compact", () => defineCompactTool(ctx, state, capsule)],
    [CHECKPOINT_TOOL, () => defineCheckpointTool(ctx, state)],
  ]) {
    try {
      const d = ctx.tools.register(factory());
      disposers.push(typeof d === "function" ? d : () => {});
    } catch (e) {
      ctx.logger?.warn?.(`${name}: 注册工具 ${label} 失败：${String((e && e.message) || e)}`);
    }
  }

  // ── /ledger 命令（可选服务：用官方 ctx.inject，服务不在就不执行、也不抛错）──
  if (cfg.commands !== false) {
    ctx.inject(["commands"], (scope) => {
      try {
        const d = scope.commands.register({
          name: "ledger",
          description: ledgerCommandDescription(),
          input: {
            // ★ 命令行**只能**显示这一行提示文字 —— 平台不支持命令自带的二级选择菜单
            //   （`dsh-commands` 只接受 input.hint 这个字符串）。要选择请裸敲 `/ledger`。
            // ★★ 这一行**由 `LEDGER_SUBCOMMANDS` 生成**，不再手抄 ——
            //   手抄漏掉 `compact` 就是用户报的那个缺陷（见 `ledgerInputHint` 注释）。
            hint: ledgerInputHint(),
            attachments: false,
          },
          handler: (invocation) => {
            try {
              // handler 允许返回 Promise（平台会 await 它，且没有超时）——
              // 裸 `/ledger` 正是靠这一点弹卡片等用户点选。
              return handleLedgerCommand(ctx, invocation, state, capsule);
            } catch (e) {
              return { kind: "error", text: `台账命令失败：${String((e && e.message) || e)}` };
            }
          },
        });
        disposers.push(typeof d === "function" ? d : () => {});
      } catch (e) {
        ctx.logger?.warn?.(`${name}: 注册 /ledger 命令失败：${String((e && e.message) || e)}`);
      }
    });
  }

  // ── 设置面板的 HTTP 路由（★ 客户端半边靠它读、写设置）─────────────────────
  //
  // ★★ 为什么必须由宿主开一条路，而不是客户端直接写：
  //   设置的**唯一官方写入入口**是 host 服务 `configEditor.edit()`
  //   （`cordis_inspect` 的 Service 目录：`entries()` / `configuration()` / `edit(...)`），
  //   而它**没有** `@Remote` 标注 ⇒ 客户端半边拿不到它。
  //   ⇒ 客户端只能 HTTP 打到宿主，由宿主替它调。这是**唯一**不越权的走法：
  //     自己去改 profile 的 patch 文件是红线（那是官方家目录）。
  //
  // ★ 为什么用 `webServer.register` 而不是自己起端口：本工作区已有三处先例
  //   （本工作区另外几个插件），都是 `inject: ["webServer"]`
  //   + `webServer.register`。路径必须 `kind: "exact"` 且带**自己的前缀**，别抢别人的路由。
  //
  // ★ 为什么软失败：没有 `webServer`（例如纯 CLI 宿主）时面板只是打不开，
  //   而**插件本体必须照常工作** —— 设置面板是锦上添花，不是运行前提。
  let settingsRoutes = { registered: [], failures: [] };
  try {
    ctx.inject(["webServer"], (scope) => {
      settingsRoutes = installSettingsRoutes(scope, () => deriveSettingsView(scope));
    });
  } catch (e) {
    try {
      ctx.logger?.warn?.(`${name}: 设置面板路由未注册（无 webServer）：${String((e && e.message) || e)}`);
    } catch {
      /* 连 logger 都没有就算了 */
    }
  }

  // ── 会话开始 / 每步注入（需求 ①③）────────────────────────────────────────
  //
  // ★ 入口选 `agent/pre-step` 的原因（与 6.会话工作区用途 同款，已在真机验证）：
  //   它是 waterfall，`next()` 之后拿到本步真正要发的 messages，能在**已认领消息之后**
  //   插一条自定义消息；而 systemPrompt.context 每次装配都重算 ⇒ 会写进
  //   runtime-context 快照、每步都变 ⇒ 打烂 prompt 缓存。pre-step 只在**内容变了**时插。
  if (cfg.inject !== false) {
    ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
      const decision = await next();
      try {
        const sid = agent?.session?.header?.id;
        if (typeof sid !== "string" || sid === "") return decision;

        const root = projectRootOf(agent);
        if (root === undefined) return decision;

        // ★★★ 2026-10-12（D126 收窄）：给每一拍盖一个**步号**。
        //   闸门要用它回答"这次提醒是本拍发的、还是上一拍发的"——
        //   光比 `Date.now()` 区分不了（同拍时提醒必然更晚一点点，看着与"上拍"一样）。
        // ★★★ 2026-10-12（D131）：`stepSeq`/`stepKey` 随 `flushOwedAt` 一起清掉了
        //   （它只服务 D126 那个"同拍/上拍"判据，而那整段已成死代码）。
        //   ★ 若将来又要判"某一拍"，**重新引入时务必连带把它写进清账路径**。

        const info = inspect(root);
        const pending = state.pending.get(String(sid));
        // 压缩刚跑完 ⇒ 强制重注一次（指纹会比不出来，见 renderInjection 情形 Z）。
        // ★ 两个键都认：带项目根的（从 agent 挂的）与通配的（从 session/event 挂的，
        //   那条路径拿不到 agent ⇒ 只能按会话挂）。
        const reinjectSet = state.reinject.get(String(sid));
        const armedRoot = `compacted:${info.projectRoot}`;
        const armedAny = "compacted:*";
        // ★★★★★ 2026-10-13（D161）：**两条判据取或**。
        //   · 内存标记：本进程内刚压完，最及时；
        //   · 日志推出：**跨重启**仍然有效 —— 内存标记随进程消失正是 D161 真机缺陷。
        //   ★ 取 `||` 而不是替换：两者覆盖的时段不同（内存覆盖"压完但还没走到 pre-step"，
        //     日志覆盖"压完 + 重启"），任何一种单独用都会漏掉一段时间。
        //   ★ 日志判据 `undefined`（读不到）时**不参与**，由内存判据决定 —— 绝不猜。
        const afterCompaction =
          (reinjectSet !== undefined && (reinjectSet.has(armedRoot) || reinjectSet.has(armedAny))) ||
          compactVsInject(agent) === true;

        let text;
        // ★ 增量压缩的两个开关/状态（在下面那段用它）：
        //   · `enableDelta`：增量压缩总开关 + 只读判断一次（后面要复用）。
        //   · `deltaHandled`：本步增量是否已经把这一轮"该压的"处理掉 ⇒
        //     下面那条绝对 70% 就**不再排队**，否则刚分段压完又被全压一遍。
        const _deltaCfg = currentSettings();
        const enableDelta =
          _deltaCfg.incrementalCompact === true &&
          _deltaCfg.highFidelityCompact === true &&
          _deltaCfg.autoCompact === true;
        let deltaHandled = false;
        if (pending !== undefined) {
          // 待兑现命令优先：注入完立刻撤销（只兑现一次）。
          state.pending.delete(String(sid));
          text = renderInjection(info, pending);
        } else if (afterCompaction) {
          // ★ 压缩后重注：**绕过指纹去重**，且消费掉本次标记。
          //   ★★★ 2026-10-13（D161）：**必须用 `?.`** —— 走"日志推出"那条路时
          //     `reinjectSet` 可能是 `undefined`（重启后内存空）⇒ 原写法会 **TypeError**。
          //     ★ 这就是本项目的"回退路径也要修"：新判据开了一条旧代码没设想过的路，
          //       而那一路上的清理语句是按"标记一定存在"写的。
          reinjectSet?.delete(armedRoot);
          reinjectSet?.delete(armedAny);
          // 高保真胶囊：优先用**压缩前抓好并存在 state 里的那一份**（那是本次压缩
          // 真正的输入对应物）；没有就现取（例如官方 80% 那次压缩，我们没参与）。
          const snap = state.capsuleSnapshot.get(String(sid));
          state.capsuleSnapshot.delete(String(sid));
          // ★★★★★ 2026-10-13（D161）：`snap` 取不到时（**跨重启必取不到** ——
          //   `capsuleSnapshot` 也是内存态），先把**盘上的素材**补回内存再渲染。
          //   ★ 不补会怎样：`renderCapsule(info, undefined)` 直接返回 `undefined`
          //     ⇒ 这个分支渲染出**空胶囊** ⇒ 形态上"回来了"，内容上只有台账。
          //     ★ 真机取证：那条注入（seq 55689）里一条 `_ledger-log/.../capsules/`
          //       路径都没有（连"逐字原件"行都没有），与这里对得上。
          //   ★ 复用 D61 的 `hydrateCapsuleMemory`（它已处理"内存空 ⇒ 用盘上那份建骨架"），
          //     不另写一套合并 —— 两套判据必然分叉（D59 的老坑）。
          if (snap === undefined) {
            try {
              if (capsule !== undefined) hydrateCapsuleMemory(capsule, String(sid));
            } catch {
              /* 补不回来就按"没有胶囊"走，绝不许挡住重注 —— 台账仍在 */
            }
          }
          // ★ 「反复追究」模式：AI 自己分的 keep 桶，**消费掉**（同胶囊，描述"紧接着那一次压缩"）。
          const tri = state.triageKeep.get(String(sid));
          state.triageKeep.delete(String(sid));
          // ★★★ 2026-10-11（承 D79）：**官方 80% 那次压缩我们没参与** ⇒ 那条路上
          //   `recordShadowedIndex` 没被调用过。这里就地补记一次（幂等：按 summarySeq 去重）。
          //   ★ 这是"推"而不是"等它来查"（D46）—— 若不补，官方压缩掉的段就**永远不会**出现在索引里。
          recordShadowedIndex(state, String(sid), agent, "official");
          text = renderInjection(info, undefined, {
            capsule: snap ?? renderCapsule(info, capsule?.get(String(sid))),
            ours: snap !== undefined,
            keep: tri?.items,
            shadowedIndex: renderShadowedIndex(state, String(sid)),
          });
          // ★★★★★ 2026-10-13（D161）：**重注也要记指纹**，否则下一步会**再整份注一遍**。
          //
          //   ★ 这是情形 65③ 抓出来的真缺口（不是夹具问题）：
          //     重注走的是独立分支、**绕过了**下面的指纹去重，但它**没有把新指纹写回去**。
          //     ⇒ 下一步进入 `else` 分支：`lastFp` 还是旧的（或 undefined）⇒ 判成"变了" ⇒ 又注一遍
          //       （≈ 5000 tok，且**把 prompt 缓存打穿** —— 那正是我们一直在省的东西）。
          //   ★ 为什么平时没暴露：一般压缩前都已经有过普通注入 ⇒ 指纹是旧的"内容相同"值 ⇒
          //     下一步比得中。**只有"重启后紧接着重注"这一路**（即 D161 那种场景）才踩到 ——
          //     而它恰好是这条修复自己新开出来的路。
          //   ★ 判据：把这里删掉 ⇒ 情形 65③ 当场红（期望 0、实际 1）。
          if (isFreshProject(info)) {
            // 全新项目走 `injected`（与下面 `else` 分支同一口径），避免两套判据分叉。
            const seen65 = state.injected.get(String(sid)) ?? new Set();
            seen65.add(`fresh:${root}`);
            state.injected.set(String(sid), seen65);
          } else {
            state.fingerprint.set(String(sid), fingerprintOf(info));
          }
        } else {
          // 没变化就别重复注入 —— 去重靠"指纹 + 文本"两道。
          const fp = fingerprintOf(info);
          const lastFp = state.fingerprint.get(String(sid));
          const fresh = isFreshProject(info);
          // 全新项目：每会话提一次就够（用户拒绝后不再追问）。
          const onceKey = fresh ? `fresh:${root}` : undefined;
          const seen = state.injected.get(String(sid)) ?? new Set();
          // ★ 这里**不能 return**：要掉下去走压力检查那段，否则"台账没变"的回合
          //   永远发不出水位提醒（情形 12 抓到的正是这个 bug）。
          const skip =
            (onceKey !== undefined && seen.has(onceKey)) ||
            (onceKey === undefined && lastFp === fp);
          if (!skip) {
            // ★★★ 2026-10-11（用户：*"我们现在好像没那么顺畅和无感"*）：
            //   **别把模型自己刚写的东西再注回去一遍。**
            //
            //   病（已量化，`tools/_probe-noise.mjs`）：台账注入 **320 条 / 2,560,439 字符**，
            //   而**最近每条 ≈ 19,000~21,000 字符 ≈ 5,000 tok** —— 因为台账已 **343 行**，
            //   而**每次改动都重注整份**。分类结果：
            //     · 「**只有台账全文**」占 **54.9%**
            //     · 其中**紧跟在我们自己的写入工具之后**的占全部字符 **24.2%**（110 条）
            //   ⇒ 那 110 条是**纯冗余**：模型刚写完那一刻，正文就在它自己的 tool-call 里，
            //     它**已经知道**了 —— 再注一遍 5,000 tok 只换来"更吵、更不无感"。
            //
            //   ★ 怎么判"是不是我们自己的改动"：`state.ledgerTouched` 只在
            //     **台账写成功**时被 `noteLedgerTouched` 立起来（write / archive 两处收口）。
            //     ⇒ 它有记录 = 这次变化是本会话自己写出来的。
            //   ★ 为什么**只查不取**（`has` 而不是 `takeTouched`）：回执那一段（本轮更后面）
            //     要 `takeTouched` 把它消费掉并生成一句"请转告用户" —— 那才是本步真正的注入内容。
            //     ⇒ 本步于是变成"**只有一句回执**"（几百字符），而不是"整份台账 + 回执"。
            //   ★ 跨会话改动（别的会话写的）**没有**这个记录 ⇒ 照旧注全文 ——
            //     那种变化模型**真的不知道**，不能省（D55/D56 的诉求正是"要让它知道"）。
            //   ★ 先去重再判自招（顺序要紧）：指纹**必须**照样更新，否则下一步
            //     会拿旧的 `lastFp` 再比一次，又注一遍 —— 等于修复被自己绕过。
            if (onceKey === undefined) state.fingerprint.set(String(sid), fp);
            else seen.add(onceKey);
            state.injected.set(String(sid), seen);

            const selfCaused = state.ledgerTouched.has(String(sid));
            // ★★★ 关键（我第一版这里写错过，记下来）：**不能只留空** ——
            //   本函数的**末尾**有一道 `if (text === undefined) return decision;`，
            //   而增量/全量压缩的编排**在它之后**。⇒ 若本步不产生 `text`，
            //   那一段**整段被跳过** ⇒ **压缩也跟着不发生**。
            //   ★ 实测：第一版"不注全文"⇒ `regionCalls` 恒 0（五个用例变红），
            //     根因就是这条链 —— **不是夹具的问题，是我把压缩也一起挡掉了**。
            //   ⇒ 所以正解是**注一份短版**（回执/索引即可），把 `text` 撑起来，
            //     让后面那两段照常跑。
            // ★★★★ 2026-10-12（D136 步 3）：把**区块级注入**需要的那几样交给渲染层。
            //
            //   ★ 为什么在这层组装而不是在渲染层自己去取：
            //     · `state` 只在这里可见（渲染层是纯函数，本文件一贯这么分）；
            //     · `prevBlocks`（上一次的块）必须**在本次重算之前**取，
            //       否则"变了哪些块"永远算成"全变了"（那会让安全绳①失效 ⇒ 每次全注）。
            //   ★ `modelAnswers` 只认 **root 相同**的那一份：块哈希是**项目内容**的地址，
            //     张冠李戴会把 A 项目的判分用到 B 项目上。
            //   ★ 取不到任何一样 ⇒ **不传** ⇒ 渲染层按"没判分"走兜底必注（宁可多注）。
            const biOpts = (() => {
              const sidKey = String(sid);
              const rec = state.blockWeights?.get(sidKey);
              const answers =
                rec !== undefined && rec.root === info.projectRoot ? rec.byHash : undefined;
              // ★ 快照用**模块级** Map（不是 state）：它描述"这个会话的上下文里现在有什么"，
              //   生命周期与插件进程一致即可，不需要跟着 state 重置。
              let prev = blockSnapshots.get(info.projectRoot);
              if (!Array.isArray(prev)) prev = undefined;
              return { modelAnswers: answers, prevBlocks: prev, remember: true };
            })();
            text = selfCaused
              ? renderCompactInjection(info, renderShadowedIndex(state, String(sid)))
              : renderInjection(info, undefined, undefined, renderShadowedIndex(state, String(sid)), biOpts);
          }
        }

        // ── 需求 ②⑳：上下文水位到 30/50/70% 时各提醒一次 ────────────────────
        //
        // ★ 只在**本来不注入**（没内容变化）时搭车：提醒文案里带百分比 ⇒ 数值一变
        //   文本就变 ⇒ 若每步都发，会把 prompt 缓存每步都打烂。
        //
        // ★ 每档**只发一次**（`fired` 记已发过哪些档）；压缩后水位掉回去 ⇒
        //   掉回线下的档位重新武装，下次涨上来还能再提醒。
        if (text === undefined) {
          const pressure = measurePressure(ctx, agent);
          if (pressure !== undefined) {
            const key = String(sid);
            let fired = state.pressureNotified.get(key);
            if (fired === undefined) {
              fired = new Set();
              state.pressureNotified.set(key, fired);
            }
            // ★ 档位来自设置（默认仍是 0.3/0.5/0.7，与旧行为逐字一致）。
            const tiers = currentSettings().pressureTiers;
            // ① 掉回某档之下 ⇒ 该档重新武装（压缩之后三档都会被清掉）。
            for (const t of [...fired]) {
              if (pressure.ratio < t) fired.delete(t);
            }
            // ② 取"已到线、且还没提醒过"的**最高**那一档。
            //    一次涨过两档时只发最高的一条 —— 连发两条会把这一步的注入撑成一大坨，
            //    而且低档的话（"顺手固化"）在高档的话（"停手收尾"）面前已经没意义了。
            const hit = tiers.filter((t) => pressure.ratio >= t && !fired.has(t)).at(-1);
            if (hit !== undefined) {
              // ③ 发了高档 ⇒ 比它低的档一并记为已发，否则下一步会补发一条 50%，
              //    在 75% 的水位上给出"照常干活"的旧指令。
              for (const t of tiers) if (t <= hit) fired.add(t);
              text = renderPressureNotice(info, pressure, hit);
              // ★★★ 2026-10-12（D129，用户拍板）：**不再在这里立"欠一次落盘"的义务**。
              //
              //   用户原话：*"然后去除三个节点的义务。以防模型被卡。"* —— 经澄清，
              //   他指的是**水位三档（30/50/70）提醒所带来的落盘义务**。
              //
              //   ★ 为什么这一条会把模型**卡死**（不是理论，是本机的真事故）：
              //     `flushOwedAt` 一旦立起，`flushBeforeCompact` 就**不许压缩**，
              //     直到它写出台账；而**它可能永远不去写那一笔**（它不觉得自己到了节点）。
              //     ⇒ 闸门一直拦 ⇒ 撞进内核 80% ⇒ **那一次抓不到逐字胶囊**。
              //     ★ 本机前科：D59 —— 一条义务（分流）没被履行，**拦了近 4 小时、零次压缩**。
              //
              //   ★★ 那"压缩前必先记台账"这条铁律怎么守？—— **靠周期闸门，不靠这条义务**：
              //     下面那两条（`flushedAt > lastCompactCycleAt`，即"自上次压缩以来落过盘吗"）
              //     是**不依赖"我们开口要过"**的判据 ⇒ 它同样会拦住"一步没写就压"。
              //     ⇒ 两条义务的区别：周期闸门问「**你有没有写过**」（客观、它自己知道），
              //       而欠账闸门问「**我们让你写之后你写了吗**」（它无法观测的顺序 —— D126 的教训）。
              //   ★ 所以删掉的是**后者**（会卡死的那条），**前者完整保留**。
              void hit;
            }
          }
        }

        // ── ★★★ 增量（分段）压缩：优先于下面那条绝对 70% ──────────────────
        //
        // ★ 用户 2026-10-09 的方案：*"AI每输出20%的时候，调用一次工具压缩到12%"*、
        //   *"把这20%的输出压到只剩10~12%，以此类推，极大的拓展一兆的上下文窗口"*。
        // ★ 与下面那条的**分工**：
        //   · 这条（增量）：每涨 `deltaTriggerPoints` 点就压掉最旧一段，**保留最近一大块**
        //     ⇒ 水位缓缓回落，新近细节完整。这是**常态**。
        //   · 下面那条（绝对 70%）：只在"增量没能把水位压住、一路逼近内核 0.8"时兜底
        //     ⇒ 一次性压得更狠。这是**安全网**。
        //   ★ 顺序要紧：增量成功就不该再排队压一次，否则刚分段压完又被全压一遍。
        //
        // ★★★ `deltaForce`（`/ledger light` 立的手动旗子）为什么必须在这里消费：
        //   用户按了 `/ledger light` ⇒ 命令唤醒了一轮 ⇒ 但**如果本轮没有任何别的东西要注入**，
        //   `text` 就是 undefined，而下面那个 `text !== undefined` 的条件会让这段**整段跳过**
        //   ⇒ 压缩**永远不会发生**，而用户已经被告知"立刻执行"。那就是 D40 同一个坑
        //   （"说已执行、其实没执行"）。
        //   ⇒ 所以：**先取旗子**，有旗子就**绕开 text 的门**，并且**自己造一句 text**
        //     把结果如实写进注入里（用户与 AI 都看得见）。
        //
        // ★★★ 2026-10-12（D114）：**旗子要带来源**，因为"谁按的"决定**是否豁免落盘闸门**：
        //   · `source === "command"`（人敲 `/ledger light`）⇒ 豁免（他按下就是授权，D40）；
        //   · `source === "tool"`（AI 调 `ledger_compact`）⇒ ★ **不豁免**，照旧先记台账再压。
        //   ★ 用户 2026-10-12 明确要求：*"一定要让模型先更新台账日志再压缩"*。
        let forcedLight = false;      // 人手动（豁免闸门）
        let toolRequestedLight = false; // AI 主动（**不**豁免闸门）
        try {
          const fr = state.deltaForce.get(String(sid));
          if (fr !== undefined) {
            state.deltaForce.delete(String(sid)); // 用完即删：只描述紧接着这一次
            if (fr.source === "command") forcedLight = true;
            else toolRequestedLight = true;
          }
        } catch {
          /* 取不到旗子就当没有 */
        }

        // ── ★★★ 2026-10-11 修 D89-2b：**判据不再搭"有没有注入"的车** ──────────
        //
        // 旧写法：`if ((enableDelta && text !== undefined) || forcedLight) { … }`
        //   ⇒ "本步恰好有东西要注入"才去问"该不该压"。而**水位到线与台账有没有变无关**。
        //   实测（`_probe-why-late.mjs`）：19:24~19:27 水位 ≥75% 的 **16 步里只有 8 步有注入**
        //   ⇒ 另一半**没机会排队** ⇒ 一路拖到 **78.4%** 才排上（用户看到的 78、79）。
        //
        // ★ 新写法：`text === undefined` 时**先 dryRun 问一句**（零副作用）。
        //   dryRun 说"想动手"⇒ 自己**造一句 text** 当载体，于是最后那几段文案
        //   （"想压但还没落盘" / "刚压了" / 手动回执）**自动接得上**，不必在此重复判断。
        //   ⇒ ★ 唯一新增的注入**只在真的该压时**才发生（dryRun 已保证过了涨幅与让路判据），
        //     不是每步都发 ⇒ 不额外打烂 prompt 缓存（本文件反复强调过这一点）。
        //
        // ★ `forcedLight`（`/ledger light`）不受本节影响：它照旧绕开一切判据（D40）。
        // ★★★ 2026-10-12（D114）：`toolRequestedLight`（AI 主动要压）**也要能走到** ——
        //   它不能搭 `text !== undefined` 的车（AI 调完工具后本步可能没有任何别的注入
        //   ⇒ 不 dryRun 就永远不会压，那又是 D40 那个"说已排队、其实没发生"的坑）。
        //   ★ 但**不给它 force**：它照旧要过闸门（先记台账）。
        let deltaWanted = false;
        let nudgeInfo; // ★ D115：轻推（只提示、不压）
        if (enableDelta && text === undefined && !forcedLight && !toolRequestedLight) {
          try {
            const dw = await runIncrementalCompact(ctx, state, agent, capsule, info, { dryRun: true });
            deltaWanted = dw.wouldAct === true;
            if (dw.nudge === true) nudgeInfo = dw;
          } catch {
            /* 问不到就当"不想动手"（宁可少压一次，也不要凭猜测发注入） */
          }
        }
        // ★★★ 2026-10-12（D115）**我在这里栽了一次，值得留档**：
        //   原设计是"真调用 `runIncrementalCompact` 时它返回 `nudge:true`、调用点据此注入"。
        //   ★ 但那条真调用（下面 `if` 里那次）**当时没有处理 `nudge` 的分支** ⇒
        //     它拿到 `nudge:true` 后**什么都不做就往下走**，
        //     ★ **而 `deltaNudged` 标记已经被它设置掉了** ⇒
        //     随后 dryRun 再问时 `since - nudgedAt < trigger` ⇒ **永远不再推**。
        //   ⇒ 实测症状：`[diagN] nudgedAt=无 → nudgeWanted=true`（第一次就烧掉了标记），
        //     而注入里 `轻推=false`（没人渲染它）。★ 这就是"标记被谁消费了"没对齐。
        //
        //   ★ 修法（**唯一真相**）：轻推**只由这一处**（dryRun + 下面的渲染）决定；
        //     真调用那次**不再负责**轻推 —— 见 `runIncrementalCompact` 里 `opts.dryRun` 的分支处理，
        //     真调用若命中轻推条件，**不设标记、也不返回 nudge**（免得又被无声消费）。
        if (process.env.LEDGER_DIAG_D115 === "1") {
          console.log(`[diagD115] nudgeInfo=${nudgeInfo === undefined ? "无" : JSON.stringify({ s: nudgeInfo.sincePoints })}`);
        }
        // ★★★ 2026-10-12（D115）：**轻推** —— 只注入一句建议，**不压**。
        //   ★ 为什么它必须走 `text` 这条注入通道：模型只能从**上下文**里读到"该压了"，
        //     插件没有任何别的办法跟它说话（这是 D46 那条结论的又一次应用：
        //     **恢复/提示必须是"推"给模型的**）。
        //   ★ 但**只在跨过轻推线时推一次**（`deltaNudged` 记着），
        //     否则每步一段新文本 ⇒ prompt 缓存每步全冷（D97 那个病）。
        //
        // ★★★ 实现要点（我**连错两次**，两次都值得记）：
        //   ① 轻推**绝不能**让下面那段压缩编排跑起来 —— 那段的条件里含
        //      `text !== undefined` ⇒ 只把提示填进 `text` 就会**本步真的压**（与轻推相反）。
        //      ⇒ 用独立标记 `nudgedThisStep` 把编排整段跳过。
        //   ② ★★★ **不许要求 `text === undefined`**（第一版就这么写的，当场被诊断抓住）：
        //      实测 `[diagD115] text===undefined? false · nudgeInfo=无` ——
        //      那一拍 `text` **已经被台账全文占了** ⇒ 轻推**永远不会发**。
        //      ★ 这与本文件反复栽的那个病同型（**"判据搭在'本步恰好没别的注入'上"**，
        //        D89-2b / D93 / D107 都是它）——**同一个坑，我这是第四次踩**。
        //      ⇒ 正解：轻推**追加**到已有的 `text` 上（与"回执"那段的做法一致），
        //        而不是"只在空位时发"。
        let nudgedThisStep = false;
        if (nudgeInfo !== undefined) {
          // ★★★ 2026-10-12（D117）：**文案改成"节点语气"**（用户判断的落点）。
          //   ★ 旧文案的病（用户原话）：*"『建议你按需压一次』这句话本身有点毛病 ——
          //     即使模型只输出了 10 点，也有可能到了某个节点需要归纳一下"*。
          //   ⇒ 旧的开口理由写的是**"你攒够了"**（数字），而真正该说的是
          //     **"你刚做完一段，可以顺手收一下"**（节点）——
          //     ★ 前者与"该不该归纳"无关，后者才是。
          //   ★★ 同时也**不再报"距上次涨了 N 点"当理由**（那正是被否掉的口径），
          //      改报**水位**（它才是"值与不值"的背景）。
          //   ★★★ 关键在于**降低心理门槛**：明说"便宜、可回读、压错了也不丢" ——
          //      模型不动手多半是因为"怕压掉东西"，而不是因为不知道该压。
          const nudgeLine =
            "\n\n---\n★ **你刚落过盘（到了一个节点）—— 请顺手压一下**\n\n" +
            "上下文是**稀缺资源**：一段用完的旧历史（做过的探索、已消费的大段输出、" +
            "已经写进台账的结论）继续留在上下文里，只会挤占后面的工作空间。\n" +
            "★★ **动作就是这一句：调用 `ledger_compact`（`mode:\"light\"`）。**\n" +
            "  · 它在**回合内**执行，**不影响你手头的工作**，不必等回合结束；\n" +
            "  · 你刚落过盘 ⇒ 闸门必过，**这次调用会成功**；\n" +
            "  · **压错了也不丢**：被压掉的每一段都能逐字读回（`ledger_recall`），" +
            "而且**你刚写的台账会照旧重注回来**。\n" +
            // ★★★ 2026-10-12（D129）：这句原来写「到兜底线（涨 N 点）插件会替你压」——
            //   而那条**机械兜底已删**（`fallbackPoints` 现在恒 undefined ⇒ 会渲染成
            //   "涨 undefined 点"）。⇒ 改成**如实描述剩下唯一的兜底**（全量 75%）。
            `★ 你一直不压的话，到全量兜底线（${Math.round(currentSettings().highFidelityCompactRatio * 100)}%）` +
            "插件会替你压一次全量（那是**安全网**，不是你的替代品）。" +
            "★ **两种情况都先写台账再压**（闸门会拦）。\n" +
            "★ **现在就调，或明确判断「这一段还没用完、先不压」** —— 两者都可以，" +
            "但**别只是记下「该压了」然后继续**（那等于没做）。\n";
          // ★ **追加**（不是覆盖）：这一拍可能已经有台账全文/提醒 —— 不能把它们顶掉。
          text = text === undefined ? nudgeLine.trimStart() : text + nudgeLine;
          nudgedThisStep = true;
          // ★★★ 标记**在真的渲染出去之后**才落（"决定"与"落地"对齐 —— 见上面那段注释：
          //   我原来在**决定**处就落标记，而那条路的结果没人渲染 ⇒ 标记被无声烧掉）。
          state.deltaNudged.set(String(sid), nudgeInfo.sinceRatio);
        }

        // ★ 轻推这一步：**只注入，不压**（跳过整段压缩编排）。
        if (!nudgedThisStep && ((enableDelta && text !== undefined) || deltaWanted || forcedLight || toolRequestedLight)) {
          try {
            // ★★★ 2026-10-10（用户报"先压缩再写台账"）的修法**不在这一行**：
            //   它做在 `flushOwedAt`（发提醒时立标记）+ `flushBeforeCompact`（认这个标记）
            //   里 —— 那两处**天然**覆盖"提醒与压缩在同一步"的情形，因为标记在
            //   压缩之前就设上了，而那一刻 `flushedAt` 必然更早 ⇒ 闸门必拦。
            //   ⚠️ 我原来在这里额外加过一个 `noticeJustSent` 参数，**它是死代码**：
            //     用 `tools/_tmp-redundancy-check.mjs` 实测 —— 把它摘掉，818 项**照样全绿**。
            //     ⇒ 已删。**一条测不到的路径就是下一次误判的入口**（`_probe` 也把它
            //     当"断言是摆设"报了出来，那次报警是对的）。
            const r = await runIncrementalCompact(ctx, state, agent, capsule, info, {
              force: forcedLight,
              // ★★★ 2026-10-12（D114）：AI 主动要压 ⇒ `byNeed`。
              //   ★ **只跳过"涨幅"**（那正是用户要去掉的"强制 20 压 10"），
              //     **闸门与让路照旧** —— 用户的硬要求是"一定先更新台账日志再压缩"。
              byNeed: toolRequestedLight,
            });
            if (r.ok === true) {
              // 压成了 ⇒ 本次注入说明一句，并在注入末尾带上"正在重注"的预期。
              //   ★ 手动触发时正文自己造（否则 text 仍是 undefined ⇒ 下面会 return，用户看不到回执）。
              //
              // ★★★ 2026-10-11（用户原话："把我的目标和实际完成度分开，这样子的话，
              //   既能朝我的目标努力，也不会误导模型"）：
              //   **必须分两行报**，且各自标明身份：
              //     · 目标 = 设置里 `deltaRemovePoints`（我们**打算**压掉多少点）；
              //     · 实绩 = 压前水位 − 压后水位（**同一把尺子**量到的真实落差）。
              //   ★ 旧文案把目标当成实绩写（"压掉约 10 点"），而实测只有 ~4.4 点
              //     ⇒ 模型会以为自己刚腾出了 10 点空间，从而**高估剩余预算**。
              //   ★ 两者差在哪（要如实说，否则读的人会以为插件坏了）：
              //     内核的启发式估算把 `reasoning` 块按文本同价计价，而真实请求里
              //     provider 对 thinking 的计费口径不同 ⇒ **真实 token 的落差更小**。
              //     根因与量化见 DECISIONS **D70 / D72**。
              const targetPts = r.removedPoints;
              const actualTxt =
                r.actualPoints === undefined
                  ? "**实绩：这一轮量不到压后水位**（只报了目标，没有实测 —— 别把它当已腾出的空间）"
                  : `**实绩：压前 ${r.beforePoints}% → 压后 ${r.afterPoints}%**，` +
                    `即**实际压掉 ${r.actualPoints.toFixed(1)} 点**` +
                    (r.actualPoints < targetPts - 0.5
                      ? `（★ 低于目标 ${targetPts} 点 —— 这是已知口径差，见 DECISIONS D70）`
                      : "");
              // ★★★ 2026-10-12（D129）：标题必须**如实说这次是谁发起的**。
              //   ★ 原来一律写「**本插件刚做了一次增量压缩**」—— 而 D129 之后
              //     增量**只可能由模型主动调工具发起**（机械兜底已删）
              //     ⇒ 再写"本插件做的"就是**假回执**（模型会以为自己没压、又去压一次）。
              const line =
                "\n\n---\n" +
                (forcedLight
                  ? "**本插件刚做了一次增量压缩**（你手动的 `/ledger light`）"
                  : toolRequestedLight
                    ? "**你刚调 `ledger_compact` 做了一次增量压缩**"
                    : "**本插件刚做了一次增量压缩**") +
                "（" +
                `距上次压缩涨了 ${r.sincePoints} 点 ⇒ 只压最旧一段）\n` +
                `· **目标**：压掉 ${targetPts} 点（= **上次压缩至今增量的一半**，` +
                "`deltaRemovePoints` 是它的上限；**这是打算，不是结果**）\n" +
                `· ${actualTxt}\n` +
                `· 压掉 ${r.nodes ?? "?"} 个节点（内核自报约 ${r.shadowedTokens ?? "?"} tokens，` +
                `**启发式口径**，与上面那个"点"不是同一把尺子）\n` +
                // ★★★ 2026-10-12（D127）：**压了等于没压时，必须当场说清**。
                //
                //   真机实测（14:30:26）：模型按"顺手压一下"调了一次，
                //   结果 `压掉 1 个节点`、实绩 `0.0 点` —— 而旧文案只写「已压缩 1 条历史记录」，
                //   在模型眼里**与"压了 262 条"长得一样** ⇒ 它会以为自己成功了。
                //   用户原话（这正是他要放开压缩的前提）：
                //     *"那个插件的优点就是压缩做的非常好，缺点就是记忆不够完善，
                //       而我们的记忆已经足够完善了"*
                //   ⇒ 记忆是我们兜底的地方；**但这一点也不能靠模型猜**：
                //     放开自由压缩的同时，回执必须如实说"这次几乎没压出空间"，
                //     否则它会接着压，而每次压都重写历史、打冷 prompt 缓存。
                (r.nodes !== undefined && r.nodes <= 2
                  ? `· ★ **这次几乎没有压出空间**（只压掉 ${r.nodes} 个节点，` +
                    "水位基本没动）—— 不是你调错了，是**这一段确实没什么可回收的**。" +
                    "继续干活即可，等积累出新的旧历史再压。\n"
                  : "") +
                // ★ D45：把"胶囊已落盘"说出来 —— 这样模型知道**有原件可重读**，
                //   而不是只能依赖注进来的这一份。
                (r.capsuleRel === undefined
                  ? ""
                  : `· 逐字胶囊已**存盘**：\`${r.capsuleRel}\`（原件，可 diff；压缩链再压也不受影响）\n`) +
                "**你不需要做任何事**，继续手上的工作；台账与逐字胶囊会在下一步重新注入。\n";
              text = text === undefined ? line.trimStart() : text + line;
              deltaHandled = true;
            } else if (r.blocked === true) {
              // 闸门没过（= 还没到节点）⇒ 只是**本步跳过**，不是失败：下一步再来。
              //   ★ 但要提醒 AI：它写台账就是在声明节点，写完下一次就能压。
              //
              // ★★★ 2026-10-12（D114，用户明确要求"一定一定要先更新台账日志再压缩"）：
              //   **这一条是那条铁律唯一"开口说话"的地方** —— 模型按需压时若被闸门拦下，
              //   必须当场告诉它「**先写台账，这是顺序不是障碍**」，否则它会以为工具坏了
              //   （那正是 D40「说已排队、其实没发生」的同型观感）。
              const line =
                "\n\n---\n★ **先记台账，再压缩 —— 这次没压是因为你还没落盘**：" +
                `${r.reason}\n` +
                "⇒ 用 `ledger_write`（有日志就再写一条 `ledger_log_write`）把当前状态记下来，" +
                "**这本身就是「我到节点了」的信号**；然后**再调一次** `ledger_compact` 就能压成。\n" +
                "★ 这条顺序不是障碍：压缩会把旧历史换成摘要，**没落盘的那段进展就是唯一副本** ——" +
                "先落盘，压掉的才不是你要的东西。\n";
              text = text === undefined ? line.trimStart() : text + line;
            } else if (r.requeued === true) {
              // 回合约束没满足 ⇒ 已退回 idle 那条老路，如实说一句。
              const line = `\n\n---\n本插件把增量压缩**退回回合末执行**：${r.reason}\n`;
              text = text === undefined ? line.trimStart() : text + line;
            } else if (r.yieldedToFull === true) {
              // ★★★★★ 2026-10-13（D151）：**让路必须说出来**（原来这里是静默的）。
              //
              //   ★ 为什么不报不行：模型（或人）刚要求了一次轻量压缩，工具也回了
              //     "已请求一次轻量压缩"，随后水位**一点没动**且**一句解释都没有**
              //     ⇒ 唯一合理的结论是"工具坏了" ⇒ 于是**再按一次**（本机实测就这么发生的）。
              //   ★ 这条注入**不改模型读到的主内容**（台账/胶囊照旧全量注入），
              //     只是多一句如实回执 ⇒ 不触"不要影响准确性"那条底线。
              //   ★ 为什么"只报一次"：让路会持续每一步，每步注入会把 prompt 缓存
              //     每步打冷（D97）。⇒ 与 `deltaNudged` 同一条设计。
              const yk = String(sid);
              if (state.deltaYieldNotified.get(yk) !== true) {
                state.deltaYieldNotified.set(yk, true);
                const hfPct = Math.round(currentSettings().highFidelityCompactRatio * 100);
                const line =
                  "\n\n---\n★ **这次没压：不是失败，是「让路」** —— " +
                  `${r.reason}\n` +
                  `· **为什么让路**：水位已经到全量线（${hfPct}%），此时再压一小段只会把水位` +
                  "压到线以下、让**该做的那次深压缩**永远轮不到（本机实测过：增量抢跑 ⇒ 全量被饿死）。\n" +
                  "· **那什么时候压**：深压缩要等**本回合结束**（内核的 `compactNow` 要求 agent 空闲，" +
                  "这是内核的硬约束，不是我们在拖）。\n" +
                  "· **它一次会释放得多得多**（压到 ~10%，而不是几 点）⇒ 比现在挤一点更划算。\n" +
                  "· ★ **你不需要再按一次**（再按也是同样的结果）；继续手上的工作即可。\n" +
                  "（本条每段让路期只说一次；水位掉回线下会重新武装。）\n";
                text = text === undefined ? line.trimStart() : text + line;
              }
            } else if (r.noRange === true) {
              // ★★★★★ 2026-10-13（D151）：**"保留段已覆盖全部历史"也必须说出来**。
              //
              //   ★ 这是情形 62 的自发现判据**替我找出来的第三个静默出口** ——
              //     我人工 grep 时只看到 `yieldedToFull` 与 `tooSmall` 两个，
              //     `noRange` **同样只被生产、没人渲染**。
              //   ★ 它的含义与"太小"**不同**，不能合成一条：
              //     · `tooSmall` = 这段不值得压（**现在压不划算**，再攒攒就好）；
              //     · `noRange` = 内核的 `selectCompactableRange` 返回 null，
              //       即"按当前保留量算，**已经没有可压的旧段落了**" ——
              //       这通常意味着**增量这条路到头了，该上全量**（D119 的让路条件）。
              //   ⇒ 如实说清"是到头了"，而不是让模型以为"再等等就能压"。
              const nk = String(sid);
              if (state.deltaYieldNotified.get(nk) !== true) {
                state.deltaYieldNotified.set(nk, true);
                const line =
                  "\n\n---\n★ **这次没压：增量这条路到头了**（不是失败）—— " + `${r.reason}\n` +
                  "· **含义**：按当前的保留量算，**已经没有可压的旧段落**了 —— " +
                  "剩下的都是要保住的新近内容。\n" +
                  "· **这时该做的是深压缩**（把整段旧历史一次折起来），它会释放得多得多。\n" +
                  "· **你不需要再按一次 `mode:\"light\"`**（再按结果一样）；继续手上的工作即可。\n" +
                  "（本条每段让路期只说一次；水位掉回线下会重新武装。）\n";
                text = text === undefined ? line.trimStart() : text + line;
              }
            } else if (r.tooSmall === true) {
              // ★★★★★ 2026-10-13（D151）：**"太小所以不压"必须说出来**（原来也是静默的）。
              //
              //   ★ 与 D114 的既定口径对齐：**模型主动压被拦下时，必须当场告诉它原因**，
              //     否则它会以为工具坏了、或者根本不知道自己被拦了。
              //   ★ 闸门（D141）的判据是"这一段够不够大"，它**不是**落盘闸门
              //     （那条已由 `r.blocked` 分支说话）⇒ 两条拦法**各说各的**，不能混。
              //   ★ 只报一次、且**攒够了要能再报**：`deltaTooSmallNotified` 存当时的可压 token，
              //     涨到 1.5 倍才再报（既不打冷缓存，也不会在真攒够了之后还说"太小"）。
              const tk = String(sid);
              const cur = Number(r.compressibleTokens ?? 0);
              const seen = state.deltaTooSmallNotified.get(tk);
              if (seen === undefined || cur >= seen * 1.5) {
                state.deltaTooSmallNotified.set(tk, cur);
                const line =
                  "\n\n---\n★ **这次没压：可压的那段还太小**（不是失败、更不是坏了）—— " +
                  `${r.reason}\n` +
                  "· **为什么小就不压**：压一次要把最旧那段换成摘要，**缓存要从改写点重算**" +
                  "（本机实测：一次改写的代价可达数十万 token 的全价重算）" +
                  "⇒ 为几 点水位付这个价是**倒亏**。\n" +
                  "· **怎么办**：**继续干活**，让旧历史再攒一些；攒够了下一次调用就能压成。\n" +
                  "· ★ **不要再连着按**（连着按等于白付工具往返）；到该压的时候工具会成功。\n" +
                  "（本条只在「又涨了 50% 以上」时才会再说一次。）\n";
                text = text === undefined ? line.trimStart() : text + line;
              }
            } else if (forcedLight) {
              // ★ 手动按了却没压成 ⇒ **必须如实说**，不能静默（那就是 D40 那个坑）。
              const line =
                "\n\n---\n**⚠ 你手动的 `/ledger light` 没有压成**：" +
                `${r.reason}\n（没有发生任何压缩 —— 不是"已排队"。）\n`;
              text = text === undefined ? line.trimStart() : text + line;
            }
          } catch (e) {
            // 手动那条即使编排抛错也要让用户看见（自动那条才静默）。
            if (forcedLight) {
              const line = `\n\n---\n**⚠ 你手动的 \`/ledger light\` 出错了**：${String(e?.message ?? e)}\n`;
              text = text === undefined ? line.trimStart() : text + line;
            }
          }
        }

        // ── 需求 ㉑：70% 水位 ⇒ 记完台账与日志后，跑**我们自己的高保真压缩** ──
        //
        // ★★ 这一段为什么这么做（我把内核 `dsh-compaction-basic` 从 app.asar 解出来读过）：
        //   ① 内核自己的自动压缩阈值是 `thresholdRatio` 默认 **0.8**；我们在 **0.7** 主动压，
        //      早一步 = 在细节被抹掉之前，把状态先固化。
        //   ② `compaction.compactNow` 要求 agent **idle**（非 idle 抛 `ManualCompactionError("busy")`），
        //      而 pre-step 里 agent 必然 running ⇒ 只能**记下意图**，等 `agent/status` 转 idle 再动手。
        //   ③ **必须在压缩前**把胶囊抓好并推进 `state.capsuleSnapshot`：
        //      压缩一跑，会话事件的去重集合与"当时上下文里有什么"都变了；
        //      压缩后现取的胶囊会缺掉刚好被压掉的那一段。
        //   ④ **只在真的会注入时**（text 已有内容）才动手：否则会出现"默默压缩、用户毫无察觉"。
        //      胶囊随本次注入一起进去，用户与 AI 都看得见。
        //
        // ★ 诚实边界：这一段**拦不住**内核 80% 那一次压缩（它是内核自己挂的 pre-step，
        //   插件无法取消）。它做的是把"我们这一趟"提前，并保证压缩后有逐字副本可重注。
        // ★ 触发水位与总开关都来自设置（默认 0.7 / 开，与旧行为逐字一致）。
        // ★★ `autoCompact: false` 的闸门**就放在这里**（而不是包住 agent/status 监听器）：
        //   它要拦的是"**自动**排队"这一件事，而手动三条路（工具 / 命令 / 卡片）
        //   各自在自己的入口排队，必须照常工作。理由详见下面 agent/status 的注释。
        const hfSettings = currentSettings();
        // ★★★ 2026-10-12（承 D93/D89-2b，**同一个病的第二条路**）：
        //   这里原来也挂着 `text !== undefined` —— 意思是"**本步恰好有注入**才去排队全量"。
        //   与增量那条**一模一样**：**水位到线这件事与"台账有没有变"毫无关系**。
        //   ⇒ 后果同型：水位过了全量线、但这一步没有注入 ⇒ **不排队** ⇒
        //     要等"下一次恰好有注入"才排（期间水位继续涨，可能直接撞内核 80%）。
        //
        // ★ 为什么现在才发现：D93 只修了**增量**那一条，**这一条没动** ——
        //   这正是纪律第 12 条的形态（**"修了一条路" ≠ "修了这个病"**）。
        //   修完增量之后两条门的健壮性就**不一致**了（增量能自造一句、全量不能）。
        //
        // ★ 修法对称：`text` 为空时**先探一次水位**（纯读、零副作用）——
        //   若已过全量线，就**自造一句**撑起 `text`，让下面的编排照常跑。
        //   ★ 与增量的 `dryRun` 同一思路：**只读判据先走，有副作用的不碰**。
        if (
          text === undefined &&
          hfSettings.highFidelityCompact === true &&
          hfSettings.autoCompact === true &&
          deltaHandled !== true
        ) {
          try {
            const probe = measurePressure(ctx, agent);
            const key0 = String(sid);
            // ★★★ 2026-10-12（D129）：**水位掉回全量线之下 ⇒ 重新武装兜底**。
            //
            //   原来的病（新发动机制下会立刻暴露）：`hfCompacted` 一旦置真就**本会话永不再清**
            //   ⇒ **全量兜底一辈子只响一次**。而新机制下模型会大量压缩、水位反复涨回 75%
            //   ⇒ 第二次涨上来时兜底**已经哑了** ⇒ 只能等内核 80%（那一次抓不到胶囊）。
            //   ★ 与 `pressureNotified` 的档位重新武装**同一条设计**
            //     （那边写着"压缩之后水位会掉回去，届时会重新武装"）—— 这里补齐同一性质。
            //   ★ 为什么判据是"掉回线下"而不是"时间到了"：只有掉回去才说明**上一轮全量真的生效了**；
            //     只看时间会让它在水位仍高时反复排队（连环重压）。
            if (probe !== undefined && probe.ratio < hfSettings.highFidelityCompactRatio) {
              state.hfCompacted.delete(key0);
            }
            // ★★★★★ 2026-10-13（D151）：**让路通知也要重新武装** —— 与上面 `hfCompacted`
            //   完全同一性质、同一条理由：只有水位**掉回线下**才说明那一轮深压缩真的生效了，
            //   下一个周期再让路时模型**应该再收到一次**解释。
            //   ★ 若不清：第一次让路报过之后，**本会话永远不再报** ——
            //     那正是 `hfCompacted` 原来那个"一辈子只响一次"的病灶换个字段复发。
            if (probe !== undefined && probe.ratio < hfSettings.highFidelityCompactRatio) {
              state.deltaYieldNotified.delete(key0);
            }
            if (
              probe !== undefined &&
              probe.ratio >= hfSettings.highFidelityCompactRatio &&
              state.hfCompacted.get(key0) !== true &&
              state.hfCompactAfterTurn.get(key0) === undefined
            ) {
              // ★ 自造一句**如实**的注入（不是凑数：它说的就是"水位到了、我要压了"）。
              text =
                `\n\n---\n**本插件注意到水位已到 ${Math.round(probe.ratio * 100)}%` +
                `（≥ 全量线 ${Math.round(hfSettings.highFidelityCompactRatio * 100)}%）** —— ` +
                `本步原本没有别的注入，插件为了不让安全网拖到内核 80% 那一次，` +
                `**自己起了一次**。\n`;
            }
          } catch {
            /* 探不到就当"没到线"，照旧什么都不做（宁可晚一次，也不凭猜测发注入） */
          }
        }
        if (
          text !== undefined &&
          hfSettings.highFidelityCompact === true &&
          hfSettings.autoCompact === true &&
          // ★ 增量这一步已经处理过 ⇒ 这一轮不再排队全压（见 `deltaHandled` 的注释）。
          deltaHandled !== true
        ) {
          try {
            const pressure2 = measurePressure(ctx, agent);
            const key = String(sid);
            const oursDone = state.hfCompacted.get(key);
            if (
              pressure2 !== undefined &&
              pressure2.ratio >= hfSettings.highFidelityCompactRatio &&
              oursDone !== true &&
              // ★★★ 2026-10-11 修 A4（审计员 001/002 指出，自检盲区）：
              //   **已经在队列里就别再排一次** —— 这一条替代了原来那句
              //   `hfCompacted.set(key, true)`。
              //   ★ 为什么原来那样写是**错的**：`hfCompacted` 的语义是
              //     「**本会话已经压过一次全量**」，而排队时**根本还没压**。
              //     一旦 idle 那一步 `compactNow` **抛异常/超时**，标志就永远停在 true
              //     ⇒ 后面「增量让路」(L9128) 与「70% 再触发」两条判据全都过不去
              //     ⇒ **本会话的全量兜底永久停摆**，只剩内核 80% 硬压（抓不到逐字胶囊）。
              //     这正是 D59 的同型病灶：**把"打算做"记成了"已经做完"**。
              //   ⇒ 现在：排队**不置**完成标志；「已排队」由队列本身表达
              //     （避免每个 pre-step 重复排队/重复注入提示）。
              state.hfCompactAfterTurn.get(key) === undefined
            ) {
              // ① 压缩前抓好胶囊（并推进快照，供压缩后重注用）。
              const snap = renderCapsule(info, capsule?.get(key));
              if (snap !== undefined) state.capsuleSnapshot.set(key, snap);
              // ② 记下"等 idle 时压"的意图（带来源，便于日志区分是谁排的队）。
              //   ★★ 这里**不再**置 `hfCompacted` —— 那要等**真压成功**才置
              //     （见 `runHighFidelityCompact` ③）。修 A4。
              state.hfCompactAfterTurn.set(key, { at: Date.now(), ratio: pressure2.ratio, source: "auto:70%" });
              // ③ 在本次注入末尾**告诉 AI** 这件事（它会随台账一起进上下文）。
              //   ★ 百分比与"≥ 多少"都按**设置里的水位**算，不写死 70 ——
              //     否则用户把水位调到 0.6 后，注入文案会与真实行为对不上（自相矛盾的说明比没有更糟）。
              const pct = Math.round(hfSettings.highFidelityCompactRatio * 100);
              // ★★★ 2026-10-12（D129）：**合同式告知**（规格①⑤）——
              //   不只说"我要压了"，还要说清**这条线本身**是合同的一部分：
              //   模型据此知道"到多少必须收尾、不然后果是什么"，从而**主动**在到线前压。
              text +=
                "\n\n---\n**本插件即将执行一次高保真压缩**（水位 " +
                Math.round(pressure2.ratio * 100) +
                "% ≥ " +
                pct +
                "%）：压缩会自动发生，你**不需要**做任何事；压缩完成后台账与这份" +
                "逐字胶囊会重新注入。\n" +
                "★ 这一档是**兜底**：正常的用法是**你自己在到线前**先调一次 " +
                "`ledger_compact`（把用过的旧历史折起来），兜底只在你没来得及调时接管。\n" +
                "★ 所以**现在请确保这一轮的进展已经用 `ledger_write` 落盘**，" +
                "并写一条 L1 活动日志摘要（`ledger_log_write`）。\n";
            }
          } catch {
            /* 高保真压缩的编排失败绝不影响注入本身 */
          }
        }

        // ── 需求 ⑲：台账被改动 ⇒ **通过注入**告诉 AI，让它转告用户 ──────────        //
        // ★★ 为什么挪到这里（2026-10-09，用户去掉每轮选择题之后）：
        //   回执原本只挂在回合末那张卡片上；卡片一关，它就**永远送不出去**了，
        //   而用户当初问的正是「AI 自己就把台账做了，那我怎么知道？」。
        //   ⇒ 必须换通道，否则"去掉卡片"会顺手把"你怎么知道"也去掉。
        //
        // ★★ 为什么是**追加**而不是"只在 text 为空时才发"：
        //   回执与其它注入（台账全文、水位提醒）**没有互斥关系**，而"别的注入先占了
        //   位置"会让回执被**饿死** —— 实测就是：第一次 pre-step 必然注入台账全文，
        //   于是回执永远轮不到（`takeTouched` 都没被调用）。那种"偶尔才送达"的
        //   确认等于没有确认。所以这里**无条件追加**，取完即清（只送一次）。
        {
          const rec = takeTouched(state, String(sid));
          const touchedText = renderTouchedForAi(rec);
          if (touchedText !== undefined) {
            text = text === undefined ? touchedText : `${text}\n\n---\n\n${touchedText}`;
          }
        }

        // ── ★★★★★ 2026-10-13（D157）：**逐回合义务**的提醒（用户："每条回复结束前必须…"）──
        //
        //   ★ 两种情形、两种语气，**都只追加一次**（不打冷缓存 —— 实测追加型注入只为自己付费，D150）：
        //     ① **上一条回复没兑现**（`turnObligationPending`）⇒ 如实提醒它补上；
        //     ② 本回合还没写台账 ⇒ 提醒它在结束前做掉。
        //   ★★ 刻意**不拦任何东西**（D59 前科）：这只是"推给它"，
        //     真正会不会做由模型决定；没做也**不影响压缩**（压缩只要求"本周期写过"，
        //     而闸门自带超时与次数兜底）。
        //
        //   ★★★★★ 2026-10-13（D157 修正，**自检当场抓到**）：必须**每回合只说一次**。
        //     第一版写成"只要欠着就说" ⇒ 它是**每一步**都注入（pre-step 每步都跑）
        //     ⇒ 直接打烂 prompt 缓存（本文件反复记着的 D97 那个病），
        //     而且把"注入只发一次"的一串既有断言全部弄红（10 条）。
        //   ⇒ 与 `deltaNudged` / `deltaYieldNotified` 同一条设计：
        //     **同一回合只说一次**，用一个按回合重置的标记守住。
        {
          const okey = String(sid);
          const pend = state.turnObligationPending.get(okey);
          const cur = state.turnObligation.get(okey);
          const needWrite = cur === undefined || cur.wrote !== true;
          const needTriage = cur === undefined || cur.triaged !== true;
          // ★ 本回合已提醒过 ⇒ 不再说（`turnReminded` 在 `turn/end` 时清空）。
          const reminded = cur?.reminded === true;
          if (!reminded && (pend !== undefined || needWrite || needTriage)) {
            const missingBits = [];
            if (pend !== undefined) {
              if (pend.wrote !== true) missingBits.push("台账");
              if (pend.triaged !== true) missingBits.push("分流");
            }
            const line =
              "\n\n---\n★ **本回合收尾义务（不是障碍，做完就安静）**\n" +
              (pend !== undefined
                ? `**上一条回复结束时没有完成**：${missingBits.join(" + ")} —— 请现在补上。\n`
                : "") +
              (needWrite ? "· ① `ledger_write` 记下这一段进展（有日志就再来一条 `ledger_log_write`）\n" : "") +
              (needTriage ? "· ② `ledger_triage` 分三个桶（`keep` 留上下文 / `stash` 落项目 / `drop` 丢掉）\n" : "") +
              "★ **为什么每回合都要做**：压缩会把旧历史换成摘要 ⇒ 没落盘的那段进展就是唯一副本；\n" +
              "  而没分流 ⇒ 压缩不知道该保住哪些（`keep` 桶会被逐字注回）。\n" +
              "★ 它**不拦任何东西**：做完这些下一步照常；**没做也不会卡住压缩**。\n";
            text = text === undefined ? line.trimStart() : text + line;
            // ★ 标记"本回合提醒过了"（`turnObligation` 在 turn/end 时会被换成新对象 ⇒ 自动重置）。
            if (cur !== undefined) cur.reminded = true;
            else state.turnObligation.set(okey, { wrote: false, triaged: false, reminded: true });
          }
        }
        if (text === undefined) return decision;

        // 本步已经有一条一模一样的 ⇒ 不重复插。
        const already = (decision.messages ?? []).some(
          (m) =>
            m?.source?.kind === INJECT_KIND &&
            Array.isArray(m?.content) &&
            m.content.some((c) => c?.type === "text" && c?.text === text)
        );
        if (already) return decision;

        // ★★ 必须带非空 string id（见文件头 ③，缺了会报废整个会话历史）。
        const note = {
          id: randomUUID(),
          content: [{ type: "text", text }],
          source: { kind: INJECT_KIND, form: "instructions" },
          role: "user",
        };
        if (typeof note.id !== "string" || note.id === "") {
          ctx.logger?.warn?.(`${name}: 注入消息没有 id，已跳过本次注入`);
          return decision;
        }

        // 插在"已认领消息"之后（官方 :1282-1283 用 lastClaimedIndex + 1 的同款插法）。
        const list = decision.messages ?? [];
        const lastClaimedIndex = list.findLastIndex((m) => messages.includes(m));
        const entered =
          lastClaimedIndex < 0 ? [...list, note] : list.toSpliced(lastClaimedIndex + 1, 0, note);
        return { ...decision, messages: entered };
      } catch (e) {
        // 注入失败**绝不许影响用户对话**。
        try {
          ctx.logger?.warn?.(`${name}: 注入失败已忽略：${String((e && e.message) || e)}`);
        } catch {
          /* 连 logger 都没有就算了 */
        }
        return decision;
      }
    });
  }

  // ── 需求 ②③：用户选了"执行压缩" ⇒ 等 agent 空闲时替他压缩 ────────────────
  //
  // ★ 为什么要等 idle：`compaction.compactNow` 在**非 idle** 时会抛
  //   `ManualCompactionError("busy", ...)`（`compaction-basic:1008-1010` +
  //   `dsh-agent-loop\lib\index.js:822` 的 `runMaintenance` 要求 `phase.kind === "idle"`）。
  //   而选择卡片是在**回合中**答复的，那时 agent 必然 running。
  //   `agent/status` 是 emit 事件（`api-catalog.js:3788`，`status: 'idle' | 'running'`），
  //   转为 idle 就是"回合真的结束了"，这一刻动手才合法。
  //
  // ★★ 这个监听器**不能**被 `autoCompact` 关掉（2026-10-09 想清楚的一处）：
  //   它同时服务**四条**入口 —— 自动 70% / `ledger_compact` 工具 / `/ledger compact`
  //   命令 / 回合末卡片。`autoCompact: false` 的语义是"**别自动**替我压"，
  //   而不是"连我手动敲的也别压"。
  //   ⇒ 所以闸门放在**排队那一处**（`auto:70%` 的 pre-step 分支），不放在这里。
  //     这里无条件挂着；没人排队时它就是个空转的 return，无害。
  //
  // ★ 为什么原先写成包住整个 handler：那是把"自动压缩"与"压缩执行器"当成一回事了。
  //   两者一旦分开（现在就是分开的），包住整个 handler 就会**静默废掉手动压缩** ——
  //   而现象是"敲了 /ledger compact 说已排队，然后什么都不发生"，极难查。
  {
    ctx.on("agent/status", async ({ agent, status }) => {
      try {
        if (status !== "idle") return;
        const sid = agent?.session?.header?.id;
        if (typeof sid !== "string" || sid === "") return;
        const key = String(sid);

        // ── 先看**高保真压缩**那条路（需求 ㉑）：自动 70% 或用户手动排的队 ─────
        //
        // ★ 两者现在共用 `runHighFidelityCompact`（见它的注释：原来手动那条
        //   **不抓胶囊**，等于"我们的压缩"没生效）。
        // ★ 为什么先于 `compactAfterTurn` 处理：下面会把那个键清掉，
        //   免得压完一遍紧接着又压一遍（那正是"多次压缩降低准确性"的来源）。
        const hf = state.hfCompactAfterTurn.get(key);
        if (hf !== undefined) {
          state.hfCompactAfterTurn.delete(key);
          state.compactAfterTurn.delete(key); // 合并掉那条意图，别压两遍
          const r = await runHighFidelityCompact(ctx, state, agent, capsule, hf.source ?? "auto");
          if (!r.ok) {
            ctx.logger?.warn?.(
              `${name}: 高保真压缩未执行（${hf.source ?? "auto"}）：${r.reason}`
            );
          }
          return;
        }

        const queued = state.compactAfterTurn.get(key);
        if (queued === undefined) return;
        // 先摘掉意图：压缩要跑好几秒，期间又来个 idle 事件不该压第二遍。
        state.compactAfterTurn.delete(key);
        // ★ 用户选的那条也走**同一个**执行器 ⇒ 一样会抓胶囊、一样会重注。
        const r2 = await runHighFidelityCompact(ctx, state, agent, capsule, "user");
        if (!r2.ok) {
          ctx.logger?.warn?.(`${name}: 用户选的压缩未执行：${r2.reason}`);
        }
      } catch (e) {
        // 压缩失败**绝不影响会话**（尤其别把 idle 事件监听器炸掉）。
        try {
          ctx.logger?.warn?.(`${name}: 自动压缩失败已忽略：${String((e && e.message) || e)}`);
        } catch {
          /* 连 logger 都没有就算了 */
        }
      }
    });
  }

  // ── 活动日志采集（★ 机器自动，不花 token、不靠 AI 记得写）──────────────────
  //
  // ★ 入口与压缩旁听**同一个事件**：`session/event` 是官方的落盘事件，在
  //   `Session.append()` 内**同步**触发（`dsh-session\lib\index.js`），而官方自己的
  //   持久化也是订阅它（该文件开头：*"Persistence is a plugin concern (subscribe to
  //   `session/event`, …)"*）。⇒ tool/call（含参数）、tool/result（含 `message.isError`）、
  //   交付、压缩、回合边界，插件全都看得到，不必向内核要任何额外能力。
  //
  // ★ 为什么与压缩旁听合并成一个处理器而不是挂两个：两个 `ctx.on("session/event")`
  //   都能跑，但合成一个就不必对同一条事件做两次取会话 id / 解析项目根。
  //
  // ★ 自动采集这一半是**宿主半边**（纯 node），**零模型调用** —— 不消耗任何 token。
  //   这是它和"让 AI 每步写日志"的根本区别，也是 L0/L2/L3 值得默认开的原因。
  // ★★ 高保真胶囊的采集器**独立于日志采集器**，而且是**无条件创建**的。
  //   理由（这是本轮我自己踩到的一个顺序陷阱）：日志是**可选**的
  //   （没登记 `logDir` 就不采集），而高保真压缩是**每个会话都要有**的兜底。
  //   若把胶囊采集塞进 `createLogCollector`，那"没启用日志"的项目就完全没有
  //   高保真能力 —— 而它们恰恰最多（实测 104/112 个会话在容器根，没有清单、没有日志）。
  //   所以这里是**两个采集器分开建**，各自独立降级。
  //   ★ `capsule` 本身在 apply() 开头就建好了（工具注册要用它）。

  const collector = (() => {
    try {
      return createLogCollector(ctx);
    } catch (e) {
      // 采集器建不起来 ⇒ 日志功能整体降级，但台账一切照旧（绝不许影响其它功能）。
      try {
        ctx.logger?.warn?.(`${name}: 活动日志采集器初始化失败，日志功能已停用：${String((e && e.message) || e)}`);
      } catch {
        /* 连 logger 都没有就算了 */
      }
      return undefined;
    }
  })();

  ctx.on("session/event", (session, event) => {
    // ── ⓪ ★★★★★ 2026-10-13（D157）：**逐回合义务记账**（用户：每条回复结束前必须落账+分流）
    //
    //   ★ 只做"记账"，不做"拦截" —— 拦截会把 47% 的回合卡死（见 `turnObligation` 的注释）。
    //   ★ 零 token：跑在 `session/event` 上，不看模型、不发 LLM 调用。
    //   ★ 全程吞错：这里同步跑在官方 `Session.append()` 路径上，抛错会连累官方写会话日志。
    try {
      const sid = session?.header?.id ?? session?.id;
      if (typeof sid === "string" && sid !== "") {
        const key = String(sid);
        const t = event?.type;
        let rec = state.turnObligation.get(key);
        if (rec === undefined) {
          rec = { wrote: false, triaged: false };
          state.turnObligation.set(key, rec);
        }
        if (t === "tool/call") {
          const nm = event?.data?.name;
          if (nm === "ledger_write" || nm === "ledger_archive") rec.wrote = true;
          if (nm === "ledger_triage") rec.triaged = true;
        } else if (t === "turn/end") {
          // 回合结束 ⇒ 判定并**重置**（新回合重新开始记）。
          // ★ 只把"未兑现"记下来（两者都兑现 ⇒ 不留痕迹，不打扰）。
          const ok = rec.wrote === true && rec.triaged === true;
          if (!ok) {
            state.turnObligationPending.set(key, {
              at: Date.now(),
              wrote: rec.wrote === true,
              triaged: rec.triaged === true,
            });
          } else {
            state.turnObligationPending.delete(key);
          }
          state.turnObligation.set(key, { wrote: false, triaged: false });
        }
      }
    } catch {
      /* 义务记账失败绝不影响任何事（它只是提醒，不是主流程） */
    }

    // ── ① 压缩完成 ⇒ 挂"强制重注台账"标记 ────────────────────────────────
    //
    // ★★★★★ 2026-10-13（D167）：**只有成功的压缩才重注**。
    //   ★ 原来只判类型 ⇒ 失败的 `compaction/end`（真机：provider 断流）也挂标记
    //     ⇒ 注入里写「上下文刚被压缩」而**历史根本没被压过** ⇒ 模型被谎报。
    //   ★ 与 `compactVsInject` 共用唯一出口 `compactionEndSucceeded`
    //     —— 两处若各判一套，必然在"某次内核改动"上分叉（D159/D163/D164 同族病）。
    try {
      if (compactionEndSucceeded(event)) {
        const sid = String(session?.id ?? session?.header?.id ?? "");
        if (sid !== "") armReinject(state, sid);
      }
    } catch {
      /* 旁听失败不影响任何事 */
    }

    // ── ①b 高保真胶囊：逐字攒用户原话 / 失败原文 / 器物索引 ────────────────
    //
    // ★ 放在日志采集**之前**且**不看日志闸门**：它必须无条件工作（见上面 capsule 的注释）。
    // ★ 全程吞错：这里同步跑在 `Session.append()` 路径上，抛错会连累官方写会话日志。
    try {
      if (capsule !== undefined) {
        const sid = session?.header?.id ?? session?.id;
        if (typeof sid === "string" && sid !== "") {
          // ★★★ 2026-10-11（B3'）：`consume` 现在**返回"有没有记到新素材"**。
          //   记到了才启动去抖落盘 —— 否则这条事件只是路过，不必推迟一次写盘。
          //   ★ 判据留在 `consume` 内部（`userMessageOf` / `fileOpsOf` / `isErrorResult` 都在那儿）：
          //     在外面再写一套"什么算新素材"必然分叉。
          const changed = capsule.consume(String(sid), event);
          if (changed === true) capsulePersister?.arm?.();
          // ★★★ 2026-10-11（D84 缺陷修复）：把**被胶囊挤出去**的用户原话升级归档。
          //   ★ 为什么在这里做（而不是在 `consume` 里）：归档要 `root`，
          //     而 `consume` 那条链手里只有 `session` —— 这里下面正好有 `projectRootOfSession`。
          //   ★ 失败不影响任何主流程（`archiveEvictedUserMessage` 自己吞错，且返回值不用）。
          try {
            const evicted = capsule.drainEvicted?.();
            if (Array.isArray(evicted) && evicted.length > 0) {
              const rootForArchive = projectRootOfSession(session);
              if (typeof rootForArchive === "string" && rootForArchive !== "") {
                const infoForArchive = inspect(rootForArchive);
                for (const m of evicted) archiveEvictedUserMessage(rootForArchive, infoForArchive, m, String(sid));
              }
            }
          } catch {
            /* 升级归档失败绝不能连累胶囊采集或官方落盘 */
          }
        }
      }
    } catch {
      /* 胶囊采集失败绝不影响其它任何事 */
    }

    // ── ② 活动日志采集 ───────────────────────────────────────────────────
    try {
      if (collector !== undefined) {
        const sid = session?.header?.id ?? session?.id;
        // ★★★ 必须走 `projectRootOfSession`（**不是**直接取 `session.header.cwd`）：
        //   项目锁是按会话记的，而这条链手里只有 `session`。
        //   旧代码直取 cwd ⇒ 锁对 L0–L4 **全部无效** ⇒ 实测
        //   "锁着子项目、用户的话一句都不进 L4"（2026-10-10 用户让我锁之后暴露的）。
        const root = projectRootOfSession(session);
        if (typeof root === "string" && root !== "" && typeof sid === "string" && sid !== "") {
          // ★ 压缩来源由插件自己记的（内核那条事件里没有）—— 见 `state.hfSource`。
          //   ★★★ 2026-10-11 改正：**出队**而不是取值即删。
          //     · `popHfSource` 空队返回 undefined ⇒ L0 写成「上下文已压缩」（无来源），
          //       那正是**内核 80% 硬压**该有的样子（它不经我们，我们没有票）。
          //     · 队首永远是"最早那次**还没结束**的压缩"。并发重叠时每个 end 各领一张票。
          //   ⚠️ 只有 `runHighFidelityCompact` 入队。增量（`runIncrementalCompact`）走的是
          //     `compactRegion`，它**也会**发 `compaction/end` —— 但它没有票，
          //     而且它本来就不该和全量同时跑（判据①b 的让路）。
          const hfSource = event?.type === "compaction/end" ? popHfSource(state, String(sid)) : undefined;
          collector.consume(root, sid, event, { hfSource });
        }
      }
    } catch (e) {
      // ★ 采集是**同步**跑在 append 路径上的：这里抛错会连累官方写会话日志。
      //   所以必须吞掉，并且不重复刷屏（同一种错误每步都会再来一次）。
      try {
        ctx.logger?.warn?.(`${name}: 日志采集失败已忽略：${String((e && e.message) || e)}`);
      } catch {
        /* 连 logger 都没有就算了 */
      }
    }
  });

  // ── 回合结束：日志落盘 + （可选）四选一卡片 ─────────────────────────────
  //
  // ★ 入口选 `agent/turn-stopping`：官方在**回合即将关闭**时发
  //   （`dsh-agent-loop\lib\index.js:999`：`if (turnEnds && this.inbox.nextStep.length === 0)
  //   await this.dispatch.serial("agent/turn-stopping", { turn, signal });`），
  //   条件正是"本回合不再有待办步"。官方自己也用它做回合末落盘
  //   （`dsh-workspace-changes\lib\index.js:1092`）。
  // ★ 这里**不 await 卡片**（原因见 offerTurnEndChoice 的注释）：await 会把回合一直挂着。
  //
  // ★★ 2026-10-09 用户决定：**不再每轮弹选择题**。
  //   原话：*"每条对话跳选择题就不用了，用户仍然可以手动打指令，但是不用在每条对话
  //   结束后进行选择，因为台账自动化了。"*
  //   ⇒ 台账的常态化落盘改由**水位分档**驱动（30/50/70 自动作台账+日志更新），
  //     而不再靠"每轮问一次"。所以 `turnEndOffer` 默认**关**，
  //     只在显式 `{ turnEndOffer: true }` 时才弹。
  //
  //   ★ 但**两条路必须留着**（否则用户会失去他仍在用的能力）：
  //     ① `ledger_checkpoint` 工具 —— AI 判断有必要（重大改动）时自己问；
  //     ② `/ledger` 命令 —— 用户手动打。
  //   ★ 而**日志落盘**与第一轮的"建项目/合规"两问**不受这个开关影响**：
  //     前者是机器行为（与卡片无关），后两者是**每会话一次**的引导性提问、
  //     不是"每轮选择题"。
  ctx.on("agent/turn-stopping", ({ agent, turn }) => {
    try {
      // ★ 回合结束是日志最好的落盘点：这一回合的调用链到这里是完整的，
      //   不必再等那 1.2 秒去抖（用户可能就此关掉客户端）。
      try {
        collector?.flushNow();
      } catch {
        /* 落盘失败无所谓，去抖那条路还会再试 */
      }

      // ── 第一轮结束：先问「要不要把这里建成项目」（用户提议）──────────────
      //
      // ★ 顺序是关键：这一问**必须在**常规四选一之前，而且问过就
      //   `skipAutoOffer`，所以那一轮不会再叠一张"是否写台账" ——
      //   用户要的正是"先问建不建，再问写不写"。
      //
      // ★ 必须看返回值：`offerProjectChoice` 在"**已经有台账**"等情况下会**不接管**
      //   （返回 false），那时要照常走常规四选一。若不看返回值直接 return，
      //   这些情况会变成**一张卡都不弹**（2026-10-08 演练实测撞到）。
      const sidRaw = agent?.session?.header?.id;
      const root = projectRootOf(agent);
      if (turn === 1 && typeof sidRaw === "string" && sidRaw !== "" && root !== undefined) {
        let snapshot;
        try {
          snapshot = inspect(root);
        } catch {
          snapshot = undefined;
        }
        if (snapshot !== undefined) {
          // ① 没有台账 ⇒ 问"要不要建项目"
          let tookOver = false;
          try {
            tookOver = offerProjectChoice(ctx, state, agent, snapshot);
          } catch (e) {
            try {
              ctx.logger?.warn?.(
                `${name}: 建项目选择卡片未能送出：${String((e && e.message) || e)}`
              );
            } catch {
              /* 连 logger 都没有就算了 */
            }
          }
          // ② 有台账、但**不符合本插件的计划** ⇒ 问"要不要改成合规的"
          //    （用户提议：允许对已存在的项目做台账重构）
          if (!tookOver) {
            try {
              tookOver = offerConformChoice(ctx, state, agent, snapshot);
            } catch (e) {
              try {
                ctx.logger?.warn?.(
                  `${name}: 台账合规卡片未能送出：${String((e && e.message) || e)}`
                );
              } catch {
                /* 连 logger 都没有就算了 */
              }
            }
          }
          if (tookOver) return; // 本轮只问这一张
        }
      }

      // ── 常规四选一：**默认不再每轮弹**（用户 2026-10-09 的决定）──────────
      // ★ 读的是**归一化后的设置**（`currentSettings()`），不是裸的 `cfg` ——
      //   这样"设置面板改的值"与"内核启动时校验过的值"是同一份，不会两个口径。
      const s = currentSettings();
      if (s.turnEndOffer === true) offerTurnEndChoice(ctx, state, agent);
    } catch (e) {
      // 弹卡片失败**绝不能影响回合关闭**。
      try {
        ctx.logger?.warn?.(`${name}: 回合末选择卡片未能送出：${String((e && e.message) || e)}`);
      } catch {
        /* 连 logger 都没有就算了 */
      }
    }
  });

  // ── 会话结束：清掉本会话的进程内状态 ─────────────────────────────────────
  ctx.on("agent/disposed", ({ agent }) => {
    try {
      const sid = agent?.session?.header?.id;
      if (typeof sid !== "string" || sid === "") return;
      state.injected.delete(String(sid));
      state.pending.delete(String(sid));
      state.fingerprint.delete(String(sid));
      state.compactAfterTurn.delete(String(sid));
      state.reinject.delete(String(sid));
      state.pressureNotified.delete(String(sid));
      state.autoOfferPending.delete(String(sid));
      state.skipAutoOffer.delete(String(sid));
      state.projectAsked.delete(String(sid));
      state.conformAsked.delete(String(sid));
      state.ledgerTouched.delete(String(sid));
      state.hfCompactAfterTurn.delete(String(sid));
      state.hfCompacted.delete(String(sid));
      state.capsuleSnapshot.delete(String(sid));
      state.capsuleHydrated.delete(String(sid));
      // ★★★ D61 修复（2026-10-11）：会话结束时**把素材刷到盘上**，再清内存。
      //
      //   ★ 原先这里写着「逐字素材只在内存，会话结束就丢（红线：不落盘）」——
      //     那句话把两件事混成一件了：
      //       ① 红线是「**不碰用户的工作区**」；② 「不落盘」是我自己加的额外限制。
      //     而 `anchors.json` 早就落在 `$DSH_HOME\plugin-data\`（**不是**工作区），
      //     且已跨多次重启实战验证过 —— 素材这份跟它同源同病，没理由反而不落盘。
      //   ★ 不刷这一步的后果（D61 实测）：重启前攒的那些原话**全没了**，
      //     重启后首次压缩的胶囊只含"重启以来"的一两条。
      try {
        persistCapsuleMemory(String(sid), capsule?.get(String(sid)));
      } catch {
        /* 落盘失败无所谓：内存那份本来就要丢 */
      }
      try {
        capsule?.forget(String(sid));
      } catch {
        /* 清理失败无所谓 */
      }
      // 日志：把该会话攒着还没落盘的行冲掉，再清掉它的缓冲。
      try {
        collector?.forget(String(sid));
      } catch {
        /* 清理失败无所谓 */
      }
    } catch {
      /* 清理失败无所谓 */
    }
  });

  // ── 卸载：精确注销 ───────────────────────────────────────────────────────
  ctx.on("dispose", () => {
    // 卸载前把日志冲盘 —— 否则最后那一批采集行会随进程一起消失。
    try {
      collector?.flushNow();
    } catch {
      /* 冲盘失败不阻断卸载 */
    }
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* 注销失败不阻断面 */
      }
    }
  });
}
