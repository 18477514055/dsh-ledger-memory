import fs from "node:fs";
import { anchorOf, autoFullPct, blockHistoryFor, capsuleDirRel, capsulePathFor, compGateDecision, compactVsInject, compactionEndFailed, compactionEndSucceeded, currentSettings, diffBlocks, dshHome, encodeSessionDirName, estimateCompressibleTokens, fileSpecs, fnv1a, fuseWeight, hfSourceShort, hydrateCapsuleMemory, mechanicalWeight, mergeCapsuleMatter, normalizeSettings, numOf, officialSessionDisplay, officialSessionPath, persistCapsuleMemory, precedenceFromManifest, precedenceValue, ranksOf, readCapsuleStore, readSessionIndex, readSessionPicked, readSessionRange, readShadowedStore, recordBlockHistory, recordShadowedIndex, renderProtocolBlock, renderShadowedIndex, renderToc, renderUnenabledCapabilities, selectLastTurnRange, setAnchor, settingDefaults, settingsOf, shadowedIndexOf, skeletonOf, specOf, splitBlocks, starValueOf, weightBlocks, weightFromAnswers, writeCapabilityManifest } from "./part1.js";
import { createCapsuleMemory, goalAgeOf, goalStampMs, goalTimeScope, goalWeightBasis, inspect, levelOn, parseGoalCards, renderCapsule, renderGoalCard, renderGoalTree } from "./part2.js";
import { blockInjectionEnabled, commitSettingsBaseline, renderCompactInjection, renderInjectionBody, renderSettingsChangeLine, renderSettingsSnapshot, settingLabelOf, settingValueTextOf, settingsBaselineKeyOf, settingsBroadcastSeqOf, settingsChangesOf, settingsSnapshotLines, settingsValuesOf } from "./part3.js";
import { cardModeOf, isSafeCardKey, kindLocationOf, listCards, readCard, readKindRaw, renderCardIndex, renderCardToc, splitFileIntoCards, splitIntoCardParts, writeCardIndex } from "./part4.js";
import { compactionFailureAdvice, hashTextOf } from "./part5.js";
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

export const SETTING_SPECS = [
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

  // ── 组 0：谁说了算 ───────────────────────────────────────────────────────
  {
    key: "settingPrecedence",
    kind: "choice",
    group: "priority",
    emphasis: true,
    label: "配置来源的优先级",
    options: () => [
      {
        value: PRECEDENCE_PANEL,
        label: "以设置面板为准（默认）",
        hint:
          "在此面板修改的值立即对全部项目生效，包括已登记的项目。" +
          "项目清单中的同名项不再覆盖面板取值，因此无需逐项目修改。",
      },
      {
        value: PRECEDENCE_PROJECT,
        label: "以项目清单为准",
        hint:
          "每个项目以自身 .dsh-ledger.json 中的取值为准，同一仓库可并存多套配置。" +
          "代价：面板修改对已登记项目不生效，需逐项目修改。",
      },
    ],
    hint:
      "仅影响 5 项：压缩方式、区块级注入、活跃台账行数上限、变更登记保留条数、活动日志各档。" +
      "其余 33 项恒以面板为准，与本项无关。",
  },
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
          "压缩前先将该段分为三桶：留在上下文、落进项目供按需查询、丢弃。" +
          "留在上下文的部分会在压缩后逐字注回，这是「指针」得以完整的前提。",
      },
    ],
    hint:
      "两种方式已合并：分流是每次压缩的标准步骤，决定哪些内容可压缩、以何种方式压缩。" +
      "本项保留仅为兼容旧项目清单，取值不影响行为。",
  },
  {
    key: "highFidelityCompact",
    kind: "boolean",
    group: "how",
    label: "高保真压缩",
    hint:
      "水位达到阈值时，由本插件在压缩前抓取一份逐字胶囊，压缩完成后将台账与胶囊注回上下文。" +
      "关闭后完全交由内核处理，被压缩的内容不再保留逐字副本。",
  },
  {
    key: "requireFlushBeforeCompact",
    kind: "boolean",
    group: "how",
    emphasis: true,
    label: "压缩前必须先记台账",
    hint:
      "压缩会丢弃逐字历史，因此压缩前需确认本轮进展已写入台账并产生一条日志。" +
      "未完成时不执行压缩，待完成后继续。这是本插件的核心安全规则。",
  },
  {
    key: "triageKeepMax",
    kind: "number",
    group: "how",
    unit: "条",
    label: "单次分流保留上限",
    hint:
      "压缩前挑选的「下一轮必须知道」清单，条目上限即本项取值。" +
      "超出部分按给定顺序截断，并如实报告截断条数。保留过多则压缩效果被抵消。",
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
      "插件要求执行分流而长期未执行时，超过本项时限即不再拦截压缩，避免阻塞工作。" +
      "单位分钟。调大即更严格要求先分流；调小即更易放行。",
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
      "压缩后注回的逐字素材最多携带多少字符，超出部分截断并注明原文长度。" +
      "调大即保留更多原话，同时占用更多上下文。",
    min: 2000,
    max: 60000,
    step: 1000,
  },
  {
    key: "recallMaxChars",
    kind: "number",
    group: "how",
    unit: "字符",
    label: "回读原文的单次上限",
    hint:
      "使用 ledger_recall 读回被压缩的逐字原文时，单次返回的字符上限。" +
      "超出时停在事件边界并提示分段读取。",
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
      "默认关闭。主力方式为「回合末一次全量压缩，压至约 10%」。" +
      "增量仅压缩最旧一段并保留 60~80%，实测其折点位于靠前处，导致身后约 60 万 token 需按全价重算" +
      "（单次 36.5 万对全量 2.2 万），且落点逐轮抬高。开启后它会在回合内自动压缩，" +
      "仅在确需「边执行边小幅压缩」时启用。无论本开关如何，手动 /ledger light 与模型主动调用 mode=light 均仍可用。",
  },
  {
    key: "autoCompact",
    kind: "boolean",
    group: "when",
    label: "允许插件自动压缩",
    hint:
      "关闭后本插件不再自行压缩，下方水位与涨幅相关设置均不再触发。" +
      "手动 /ledger compact 仍然可用。",
  },
  {
    key: "hardMaintenanceGate",
    kind: "boolean",
    group: "when",
    label: "收尾维护硬门（不落盘则不压缩）",
    hint:
      "开启（默认）：回合结束前未完成「落盘 + 分流」则不发生压缩，闸门不再到期放行。" +
      "关闭：退回旧行为，连续拦截 3 次或超时 20 分钟后放行，宁可压缩也不让流程停摆。" +
      "本项与防卡策略为相反的取舍，关闭即恢复防卡。",
  },
  {
    key: "deltaTriggerPoints",
    kind: "number",
    group: "when",
    unit: "点",
    label: "轻推：上涨多少点提醒一次",
    hint:
      "仅在开启「增量（分段）压缩」时生效；该开关关闭时轻推不会触发。" +
      "其行为为：水位较上次压缩上涨达到本项点数即提示可执行一次压缩，仅提示，不代为执行。",
    min: 5,
    max: 50,
    step: 1,
  },
  {
    key: "deltaRemovePoints",
    kind: "number",
    group: "when",
    unit: "点",
    label: "单次可压缩的点数上限",
    hint:
      "仅在开启「增量（分段）压缩」时生效。" +
      "每次增量压缩取「上次压缩至今增量」的一半，本项为其上限。" +
      "调小即每次更保守，水位回落慢；调大即允许单次压得更深。",
    min: 5,
    max: 80,
    step: 1,
  },
  {
    key: "minCompressPoints",
    kind: "number",
    group: "when",
    unit: "点",
    label: "压缩的最小体量门槛",
    hint:
      "待压缩段落至少需可压缩本项点数，否则本次压缩不划算，" +
      "因为压缩后必须重注台账与胶囊，代价可能超过收益。调大即攒得更久才压缩，更省但水位回落慢。" +
      "手动 /ledger light 不受本项约束。",
    min: 0,
    max: 10,
    step: 0.5,
  },
  {
    key: "triageKeepTotalMax",
    kind: "number",
    group: "when",
    unit: "条",
    label: "分流累积上限",
    hint:
      "跨多次分流累积的总条目上限，单次上限见前一项。" +
      "压缩前会将此期间全部分流的保留桶一并逐字注回，超出时按最旧优先丢弃并如实报数。" +
      "调大即保留更多判断但重注占用更多上下文；调小即更省但更早的判断会丢失。",
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
      "主力压缩线：水位越过本值即在回合末执行一次全量压缩，压至约 10%，" +
      "始终早于内核自身的 0.8。调小即压缩更早、水位长期更低、单次代价更小" +
      "（实测：水位维持在 30% 左右时总成本约为 70% 时的一半）。",
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
      "水位低于本比例时插件不作任何提示，避免打扰。" +
      "本项为「可以建议」的下限，而非「应当压缩」的阈值。",
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
      "台账按标题切分为「记忆区块」，仅将应予阅读的区块连同正文注入，" +
      "其余区块只提供标题、行数与内容哈希，即它们的位置，可随时按需读取全文。" +
      "三项保障：压缩后必定重注全部必注块；内容发生变化的块必定连正文注入；" +
      "任何读取或解析失败一律退回整份注入。关闭即完全退回旧行为。",
  },
  {
    key: "fileAnchor",
    kind: "boolean",
    group: "inject",
    scopeNote: "project-first",
    emphasis: true,
    label: "文件锚定（记忆面材料地图与阅读顺序）",
    hint:
      "将台账之外的记忆面（根目录稿、内部文档、问题记录、交接单、分流碎片）按六维相对位置打分，" +
      "每回合推送一段小索引：应先读哪份、还有哪些未列出、以及手头材料已落后多少代决策。" +
      "六维为一手性 3.0、时效 2.0、代际 2.5、被引用 1.5、星 1.0、体量 0.5。" +
      "针对「查到一份可用材料即停止检索」的问题，旧材料会明确标注其身后发生了哪些变化。",
  },
  {
    key: "weightMustInject",
    kind: "number",
    group: "inject",
    unit: "分",
    label: "必注分阈值",
    hint:
      "区块权重达到本分值即连正文注入，其余仅进入目录。取值为 0 到 100 之间的绝对分数，不是百分比。" +
      "调低即注入更多正文，更安全但占用更多上下文；调高即更省但可能遗漏。",
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
      "标题为原则、底线、铁律、硬规矩、总纲的区块，分数不低于本值。" +
      "此类内容结构性上不会过期，因此始终应当可见。",
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
      "标题声明已完成、已处理、已过期的区块，分数不超过本值，此处为封顶而非扣分。" +
      "其正文位于决策记录中，可随时读取，不应常驻上下文。",
    min: 0,
    max: 80,
    step: 1,
  },
  {
    key: "shadowedIndexMax",
    kind: "number",
    group: "inject",
    unit: "段",
    label: "被压缩段索引的条目上限",
    hint:
      "压缩后推送给模型的「原文取用位置」清单最多列出多少段。该清单体积小且每步存在，不宜设得过大。",
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
      "台账超过本长度即截断注入，并注明全文实际字符数。调大即一次给全，占用更多上下文；" +
      "调小即更容易触发截断。",
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
    // ★★★★★ 2026-10-17（D226）：**这段 hint 原来是静态的，却断言了一件会变的事。**
    //   它写「这是新项目的默认值，改它不会影响已有项目」「清单里那个才管用」——
    //   在 D222 的默认（以面板为准）下，这两句**都是错话**。
    //   ★ 修法：静态 hint **不再断言作用域**（作用域随 `settingPrecedence` 变，
    //     静态文本**无法跟着走**）⇒ 把它交给**会跟着开关走的那个徽标**，
    //     这里只说"这一项的作用域有讲究 + 去哪看真的"。
    //   ★ 判据（本项目纪律）：**静态文案不许断言动态事实** —— 要么改成动态渲染，
    //     要么把断言交给动态的那一处。写死 = 迟早变错话。
    hint:
      "台账超过本长度即截断注入，并要求先归档最旧条目再写入。" +
      "本项的作用域取决于「配置来源的优先级」：以面板为准时，修改立即对全部项目生效；" +
      "以项目清单为准时，已登记项目使用各自清单中的取值。" +
      "当前实际生效值与作用域，以每回合注入的「当前设置」快照为准。",
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
    hint: "台账末尾的「变更登记」表保留最近若干行，超出即截断。其行数计入上述行数上限。",
    min: 3,
    max: 100,
    step: 1,
  },
  {
    key: "maxArchiveList",
    kind: "number",
    group: "ledger",
    unit: "条",
    label: "归档列表条目上限",
    hint: "列出归档目录时最多显示多少条，避免归档积累后列表过长。",
    min: 10,
    max: 2000,
    step: 10,
  },
  {
    key: "turnEndOffer",
    kind: "boolean",
    group: "ledger",
    label: "回合末弹出四选一卡片",
    hint: "开启后每回合结束询问一次「记台账 / 压缩 / 写交接单」。默认关闭。",
  },
  {
    key: "logLevels",
    kind: "levels",
    group: "ledger",
    scopeNote: "project-first",
    label: "活动日志各档",
    hint: "按周分桶写入，永不注入上下文，仅在回溯时读取。",
  },
  {
    key: "logDefaultLimit",
    kind: "number",
    group: "ledger",
    unit: "条",
    label: "日志查询默认条数",
    hint: "使用 ledger_log 回溯时，未指定条数则返回本数量。调大即一次查看更多。",
    min: 10,
    max: 2000,
    step: 10,
  },
  {
    key: "logBriefChars",
    kind: "number",
    group: "ledger",
    unit: "字符",
    label: "日志摘要单行截断长度",
    hint: "文件流水类日志每行仅保留开头若干字符。调大即更详细。",
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
    hint: "活动日志保存用户原话时，单条最多保留多少字符，超出截断。",
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
    label: "胶囊：用户原话条数",
    hint: "压缩前抓取的逐字胶囊中，最多收录最近多少条用户原话。",
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
    hint: "胶囊中每条用户原话最多保留多少字符。",
    min: 100,
    max: 10000,
    step: 100,
  },
  {
    key: "capsuleErrorMax",
    kind: "number",
    group: "capsule",
    unit: "条",
    label: "胶囊：报错条数",
    hint: "压缩前抓取的逐字胶囊中，最多收录多少条报错原文。报错字符串差一个字符即无法检索，保留原文有实际用途。",
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
    hint: "胶囊中每条报错最多保留多少字符。",
    min: 50,
    max: 5000,
    step: 50,
  },
  {
    key: "capsuleArtifactMax",
    kind: "number",
    group: "capsule",
    unit: "个",
    label: "胶囊：器物条数",
    hint: "压缩前抓取的逐字胶囊中，最多收录多少个「本次触及的文件」。",
    min: 1,
    max: 500,
    step: 1,
  },
  {
    key: "capsuleStoreSessions",
    kind: "number",
    group: "capsule",
    unit: "场",
    label: "胶囊落盘保留的会话数",
    hint: "磁盘上的胶囊素材（capsules.json）最多保留最近多少场会话记录，超出丢弃最旧者。",
    min: 1,
    max: 500,
    step: 1,
  },
  {
    key: "blockHistoryMax",
    kind: "number",
    group: "capsule",
    unit: "块",
    label: "区块变更史条目上限",
    hint: "用于计算区块权重的变更史最多保留多少个区块，超出丢弃最旧者。",
    min: 10,
    max: 20000,
    step: 10,
  },
  {
    key: "pressureTiers",
    kind: "tiers",
    group: "when",
    label: "水位提醒档位（70% 为固定档）",
    hint:
      "默认 0.3 / 0.5 / 0.7，跨越每一档注入一次提醒，每档仅触发一次。" +
      "可设为两档、一档，或留空不设。" +
      "无论如何设置，70% 这一档始终存在且不可关闭：它是「在官方 80% 之前自行压缩一次」的唯一余量。" +
      "本项仅为提醒，不要求先落盘，也不拦截任何操作。",
  },
  {
    key: "turnEndPull",
    kind: "number",
    group: "when",
    unit: "次",
    label: "回合末义务检查的唤醒次数（0 = 不唤醒）",
    hint:
      "这是「提醒」之外的另一种机制：提醒只在回合开头给出，模型往往看过即略过。" +
      "本项在回合即将关闭的时刻（官方 agent/turn-stopping）实际检查一遍，" +
      "发现台账或分流未完成即 steer 一次将其唤醒，要求当场补齐。" +
      "填 0 即关闭，退回纯提醒；填 1 表示只抽起一次，为推荐值；更大表示同一回合最多抽起的次数。" +
      "每回合无论如何仅抽起本项次数，抽满仍未完成即放行并记入 owed.json，不会阻塞工作。",
    min: 0,
    max: 5,
    step: 1,
  },
  {
    key: "midTurnCompact",
    kind: "boolean",
    group: "when",
    emphasis: true,
    label: "长回合中途自动压缩（回合内，无需等待回合结束）",
    hint:
      "开启后，一个较长的回合在水位接近全量线时，于该回合内部完成「先补义务、再压缩、然后继续执行」，全程无需人工介入。" +
      "未开启时，压缩只能等待回合结束（此时 agent 空闲），因此持续运行且始终不结束的回合会一直拖到官方 80% 的强制压缩。" +
      "关闭即退回旧行为：仅在回合结束时压缩。",
  },
  {
    key: "diagFile",
    kind: "boolean",
    group: "when",
    label: "把「回合内压缩」的判定过程写进项目里的一个日志文件（排查用）",
    hint:
      "开启后，每次回合内压缩的判定都会往项目根的 .dsh-ledger-midturn.log 追加一行，" +
      "记录当前判定（压 / 等 / 抽起）、相位、水位、义务是否补齐。" +
      "它是排查工具：插件内部的诊断信息原本走系统日志，但那条通道在部分环境下读不到，" +
      "所以提供这个落盘选项。默认关闭——不开的话，你的项目里不会凭空多出任何文件。" +
      "该文件只追加、不轮转、不会被本插件删除；不需要时直接删掉这个文件并关掉本项即可。",
  },
];

/**
 * 设置分组（面板按这个顺序与标题渲染）。
 *
 * ★ D138 重排：原来的 4 组 → **5 组**，且把"注入"独立成组
 *   （它以前挤在「台账与日志」里，而那是**模型看到什么**的事，与台账尺寸无关）。
 */

export const SETTING_GROUPS = [
  { key: "priority", label: "配置优先级", hint: "面板与项目清单取值冲突时的裁决规则。" },
  { key: "how", label: "压缩规则", hint: "压缩前后的分工与关键尺寸。" },
  { key: "when", label: "压缩时机", hint: "按何种节奏触发，以及何时给出提示。" },
  { key: "inject", label: "上下文注入", hint: "台账以何种形态进入上下文。" },
  { key: "ledger", label: "台账与日志", hint: "台账自身的尺寸与记录规则。" },
  { key: "capsule", label: "胶囊细节（高级）", hint: "压缩前抓取的逐字素材：采集范围与保留期限。" },
];

/** 设置键集合（校验用：拒绝不认识的键，免得打错字静默失效）。 */

export const SETTING_KEYS = new Set(SETTING_SPECS.map((s) => s.key));

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

export function settingSpecMax(key, fallback) {
  const hi = specOf(key)?.max;
  return Number.isFinite(hi) && hi > 0 ? hi : fallback;
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
  // ★ 2026-10-20（A 方案 / 三段式检索）：索引层与按名单取正文，同样是**纯只读**，
  //   与 `readSessionRange` 共用 `eventTextOf` 同一把尺子。
  //   ⚠️ 依旧不暴露 `state`、不暴露任何写盘入口 —— 这仍是给自检用的观察窗。
  readSessionIndex, readSessionPicked,
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
  // ★ 2026-10-14（D196）：自检要断言"**功能清单落在插件的家、绝不进用户项目**"。
  //   ★ 为什么必须开这个口子：那条判据要**真的调一次落盘**、再看用户项目根有没有多出文件——
  //     走注入链路**测不到落盘位置**（注入只读不写）。
  //   ⚠️ 它只做一件事：把清单算出来写到 `plugin-data\<包名>\`，
  //     **不碰用户项目、不改任何 state**（清单内容由 `capabilityKinds()` 这个纯函数决定）。
  //   ★★ 用**取值函数**而不是直接 `writeCapabilityManifest` 引用：与 `capsuleStoreStats`
  //     同一个坑 —— 该函数定义在文件**更后面**，直接写引用会 TDZ ⇒ **整个 import 失败**。
  writeCapabilityManifest: () => writeCapabilityManifest(),
  // ★ 2026-10-14（D196）：自检要断言"**未启用的能力会被推行**"、"全启用时那一段消失"。
  //   ⚠️ 纯函数（吃 info、吐字符串），只算不写。同样用取值函数避免 TDZ。
  renderUnenabledCapabilities: (info) => renderUnenabledCapabilities(info),
  // ★ 2026-10-14（D197）：自检要断言"**每种文件的骨架与协议都在，且与解析器一致**"。
  //   ⚠️ 纯函数（返回常量表），只读不写。
  fileSpecs: () => fileSpecs(),
  skeletonOf: (key) => skeletonOf(key),
  renderProtocolBlock: (info) => renderProtocolBlock(info),
  // ★ 2026-10-14（D198）：自检/探针要断言"**目标树里的卡有没有被推进过**"。
  //   ★ 为什么必须用**真解析器**而不是在探针里写个正则：正则只能证明"文件里有那几行"，
  //     而"这张卡被插件读成了什么状态"才是要断的东西 —— 两者**可能分叉**
  //     （这正是 D197 那条"骨架必须与解析器互逆"的同一理由）。
  //   ⚠️ 纯函数（吃文本、吐卡片数组），只算不写。
  parseGoalCards: (text) => parseGoalCards(text),
  // ★ 2026-10-14（D198）：探针要断言"**写出来的卡里到底有没有时间戳**"。
  //   ★ 为什么必须走**真函数**而不是在源码里正则找 `\d{4}`：我第一版就是那么干的，
  //     结果**匹配到了紧邻的注释里那个 "2026-10-13"** ⇒ 报了「✅ 写了时间戳」**假绿**。
  //     判据必须吃"**被测函数真的吐出来的那段文本**"，不是"源码附近有没有日期字符串"（L14 同型）。
  //   ⚠️ 两个都只算不写：`renderGoalCard` 只拼字符串、`goalWeightBasis` 只算分。
  renderGoalCard: (card, now) => renderGoalCard(card, now),
  goalWeightBasis: (card, scope) => goalWeightBasis(card, scope),
  // ★ 2026-10-14（D198）：自检要断言"**已完成的卡会随相对时间下沉**"与"**时间未知不惩罚**"。
  //   ★ 为什么必须开这几个口子：那两条判据要**造两个不同时间的卡**再比分数 ——
  //     走注入链路拿不到分数（注入只渲染文本）；而"未知不惩罚"那一条
  //     需要一个**没有 `更新于`** 的卡走一遍（老格式的真实形状）。
  //   ⚠️ 全部是纯函数（只算不写、不碰 state、不写盘）。
  goalStampMs: (text) => goalStampMs(text),
  goalTimeScope: (cards, nowMs) => goalTimeScope(cards, nowMs),
  goalAgeOf: (card, nowMs) => goalAgeOf(card, nowMs),
  renderGoalTree: (tree) => renderGoalTree(tree),
  // ★ 2026-10-14（D202）：卡片层 —— 自检要断言"**切片无损**""**键不合法一律拒**"。
  //   ⚠️ `isSafeCardKey` / `splitIntoCardParts` 都是**纯函数**（只算不写）。
  //   ⚠️ `splitFileIntoCards` 会**写盘**（那就是它的职责），自检只在 %TEMP% 夹具上跑它。
  isSafeCardKey: (key) => isSafeCardKey(key),
  splitIntoCardParts: (raw, kind) => splitIntoCardParts(raw, kind),
  splitFileIntoCards: (root, info, kind, opts) => splitFileIntoCards(root, info, kind, opts),
  listCards: (root, dirRel) => listCards(root, dirRel),
  readCard: (root, dirRel, key) => readCard(root, dirRel, key),
  renderCardToc: (root, dirRel, limit) => renderCardToc(root, dirRel, limit),
  // ★ 2026-10-14（D202）：**索引表**（用户："每个文件夹里有一张索引表，按多重维度分区块"）。
  //   ★ 它就是 D136 的四维秩融合（`weightBlocks`）作用在**卡片**上 —— 不另造一套打分。
  //   ⚠️ `renderCardIndex` 纯算；`writeCardIndex` 会写盘（自检只在 %TEMP% 夹具上跑）。
  renderCardIndex: (root, dirRel, opts) => renderCardIndex(root, dirRel, opts),
  writeCardIndex: (root, dirRel, label, extra) => writeCardIndex(root, dirRel, label, extra),
  // ★★★★★ 2026-10-14（D203）：**卡片模式下"读写同一个真源"** —— 自检要断言
  //   "写进去的读得回来""这一类到底住在哪只有一个答案"。
  //   ⚠️ 全是**纯读/纯定位**（`readKindRaw` 只读盘拼串，`kindLocationOf` 只算）。
  readKindRaw: (root, info, kind) => readKindRaw(root, info, kind),
  kindLocationOf: (info, kind) => kindLocationOf(info, kind),
  cardModeOf: (info, kind) => cardModeOf(info, kind),
  inspect: (root) => inspect(root),
  // ★★★★★ 2026-10-16（D222）：自检要断言"**面板改了，老项目立刻跟**"这件事 ——
  //   而它的判据住在 `levelOn` / `precedenceValue` / `precedenceFromManifest` 里。
  //   ⚠️ 三个都**只读**（读内存设置 + 读一个已解析好的 manifest 对象），不写盘、不改 state。
  //   ★ 为什么必须开这个口子：`levelOn(info, ...)` 的语义是"**这一档现在开着吗**"，
  //     而它以前**只读清单** ⇒ 想验"面板盖过清单"就必须能直接问它，
  //     否则只能靠"日志文件有没有生成"间接推 —— 那会把三档耦合在一起，失败时看不出是谁的错。
  levelOn: (info, level) => levelOn(info, level),
  precedenceValue: (info, key) => precedenceValue(info, key),
  precedenceFromManifest: (info, key) => precedenceFromManifest(info, key),
  // ★ 2026-10-15（D210）：探针要复刻**面板保存那条路**（`setActiveSettings`），
  //   而不是重跑 `apply()` —— `apply()` 会 `newState()`，把指纹记忆清空，
  //   于是"只改设置"这件事在探针里**看起来像是重注了**（夹具在骗人，纪律 8）。
  setActiveSettings: (next) => setActiveSettings(next),
  settingsOf: (cfg) => settingsOf(cfg),
  currentSettings: () => ({ ...currentSettings() }),
  // ★ 2026-10-15（D210）：变更感知的三个零件 —— 自检要**分别**验它们
  //   （尤其是「渲染**纯读**、推进**单独**」这条，它现在由两个函数分工）。
  settingsValuesOf: (info) => settingsValuesOf(info),
  settingsChangesOf: (info) => settingsChangesOf(info),
  commitSettingsBaseline: (info) => commitSettingsBaseline(info),
  // ★ 2026-10-15（D211）：广播序号（面板按钮 → 指纹 → 每对话重注）。
  bumpSettingsBroadcast: () => bumpSettingsBroadcast(),
  settingsBroadcastSeqOf: () => settingsBroadcastSeqOf(),
  settingsBaselineKeyOf: (info) => settingsBaselineKeyOf(info),
  settingLabelOf: (key) => settingLabelOf(key),
  settingValueTextOf: (key, raw) => settingValueTextOf(key, raw),
  renderSettingsChangeLine: (changes) => renderSettingsChangeLine(changes),
  // ★ 2026-10-14（D208）：设置快照（纯渲染，只读）—— 探针要断言"它真的进了注入"。
  renderSettingsSnapshot: (info) => renderSettingsSnapshot(info),
  settingsSnapshotLines: (info) => settingsSnapshotLines(info),
  // ★ D208：自检要断言"快照真的**进了注入**"（而不只是存在那个函数）——
  //   本项目已栽过两次"写了但没送达"（D195/D197）⇒ 判据必须吃**真渲染的注入文本**。
  renderInjectionBody: (info, pending, opts) => renderInjectionBody(info, pending, opts),
  renderCompactInjection: (info, shadowedIndex) => renderCompactInjection(info, shadowedIndex),
  // ★ 2026-10-14（D209）：自检要断言"快照那句"与"权威判据"**一致**（不许两处各算一份）。
  blockInjectionEnabled: (info) => blockInjectionEnabled(info),
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
  /** ★★★ D160 的**唯一取索引出口**（内存优先、盘上兜底）。 */  shadowedIndexOf,
  /**
   * ★★★★★ 2026-10-13（D182）：官方会话日志的路径推导 —— 自检要**用真目录验**它。
   *   ★ 为什么必须放出来：编码规则是**实测出来的**（我第一版推错过），
   *     而它错了的后果是"指针指不到东西"（伤可回溯）。
   *     ⇒ 情形 75 要拿**本机真实的 sessions 目录名**去对，而不是只对字符串。
   */
  encodeSessionDirName,
  officialSessionPath,
  officialSessionDisplay,
  dshHomeForTest: dshHome,
  /**
   * ★★★★★ 2026-10-14（D190）：`/ledger light` 的**范围选择器**（压"上一个回复"）。
   *   ★ 为什么必须放出来供自检：它的**第一版选法被实测证伪**过
   *     （`turn/end` 根本不在 surface 上 —— 探针 32 个会话 0 命中）。
   *     ⇒ 判据必须能吃"**它到底按什么定位**"，而不只是吃一个返回值。
   *   ⚠️ 纯函数：只读 session，不改 state、不写盘。
   */
  selectLastTurnRangeForTest: selectLastTurnRange,
  /** ★★★★★ D163：来源标签的**唯一出口**（索引行与 L0 里程碑共用它）。 */
  hfSourceShort,
  /** ★★★★★ D165：胶囊目录的**唯一出口**（落盘 / 兜底指针 / 注入指针共用它）。 */
  capsuleDirRel,
  /** ★★★★★ D165：兜底指针 —— 自检要断言它与唯一出口**逐字节一致**（不许各算一套）。 */
  capsulePathFor,
  /**
   * ★★★★★ 2026-10-13（D170）：**存储侧硬上限**（只读）——
   * 自检要断言"硬上限 ≥ 设置项 max"（否则设置调大后盘上写不下 ⇒ 打穿 D159）。
   * ★ 必须是取值函数：那两个常量定义在本文件更后面，直接放字面量会 TDZ 报错
   *   （与 `capsuleStoreStats` / `createCapsuleMemoryForTest` 同一个坑，本文件已栽过两次）。
   */
  capsuleStoreHardMaxForTest: () => ({
    userMax: CAPSULE_STORE_USER_HARD_MAX,
    errorMax: CAPSULE_STORE_ERROR_HARD_MAX,
  }),
  /** ★★★★★ D167：`compaction/end` 成没成的**唯一出口** —— 自检要断言"失败不算压缩过"。 */
  compactionEndSucceeded,
  /**
   * ★★★★★ 2026-10-15（D215）：上一条的**反面**（同一个表达式的两面）。
   *
   * ★ 为什么必须一起开：L0 日志那条判据要问的是"**是不是失败**"，
   *   而 `compactionEndSucceeded` 问的是"**是不是成功**" —— 两者必须永不矛盾。
   *   ⇒ 自检断言"两面严格互补"（情形 91⑤），从而钉住"一个事实只有一个表达式"。
   */
  compactionEndFailed,
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

export let activeSettings = null;

/** 由 `apply()` 调用：把本进程的设置换成这一份。 */

export function setActiveSettings(next) {
  activeSettings = next;
}

/** 读当前设置（**永远完整**，未初始化时给默认值）。 */

export const sessionProjectLock = new Map();

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

export const LOCK_STORE_DIRNAME = "plugin-data";

export const LOCK_STORE_PKG = "dsh-ledger-memory";

export const LOCK_STORE_FILE = "locks.json";

/**
 * ★★★★★ 2026-10-13（D182）：**DSH 的家 —— 唯一出口**。
 *
 * ★ 为什么必须收口（D170「同一个事实不许两个出处」的同型复发）：
 *   原来只有 `lockStorePath()` 自己算这个家门口（L1258），
 *   而新增的「官方会话日志在哪」（`officialSessionPath`）**也要算同一个家**。
 *   两处各写一遍 ⇒ 将来任何一处改了（如支持新环境变量、换默认家），
 *   另一处**静默分叉**：索引指向一个不存在的目录 ⇒ 模型照抄读不到。
 *   ★ 这与 `capsuleDirRel`（D165）、`notesDirRel`（D170）是**同一条纪律**：
 *     「**同一个目录不许算两遍**」。
 *
 * ★ 取值优先级：`DSH_HOME` 环境变量 → `~/.dsh`（本机默认家）。
 *   ★ 为什么不硬编码某个具体用户的家目录：那是本机私事，进不了发布包
 *     （本项目有"代码里 0 处本机硬编码路径"的发布门槛）。
 *   ★★ 2026-10-15（D216）：这里原来**逐字写了一个真实用户名路径**当反例 ——
 *     结果那句话本身把本机用户名列进了发布包（被发布前隐私体检抓到）。
 *     ⇒ 反例**不许写真值**，写成占位即可（这就是"体检"存在的理由）。
 *
 * @returns {string} 绝对路径（**只算、不建、不读**）
 */

export const LOCK_STORE_VERSION = 1;

/**
 * 读锁记录（**全程吞错** ⇒ 读不到就当没有，绝不因为一个坏 JSON 让插件起不来）。
 *
 * 返回 `{ version, bySession: { sid: { root, cwd, at } } }`。
 */

export const ANCHOR_STORE_FILE = "anchors.json";

/**
 * ★★★★★ 2026-10-17（D231，用户拍板方向②）：**「欠着的义务」落盘**。
 *
 * 用户原话（逐字）：*"很多对话都是在下一个对话才补归档和分流，以及这些都是义务，
 * 你知道吧，就是如果你不完成这些义务的话，万一刚好结束对话的时候，落到压缩中的话，
 * 就会很麻烦。"*
 *
 * ★★★ 为什么必须落盘（结构性的，不是"不够自觉"）：
 *   提醒只挂在 `agent/pre-step`（**回合开头**），而义务的截止点在**回合末尾** ——
 *   走到回合末时插件**没有任何机会再出声**（`turn/end` 之后模型已经不说话了）。
 *   ⇒ 回合内提醒是"尽力而为"，**它救不了"结束对话"这种情况**。
 *   ★ 而此前的 `turnObligationPending` 是**进程内 Map** ⇒ 进程一死就没了 ⇒
 *     "上一条欠了什么"**跨进程不可见**。这正是用户担心的那件事。
 *
 * ★ 所以这里落一份**跨进程可查**的账：`plugin-data\<包名>\owed.json`。
 *   · 与 `locks.json` / `anchors.json` 同目录、同一套"临时文件 + 改名"、
 *     同一个吞错习惯（**别另发明一套持久化** —— 本项目纪律）；
 *   · **只在 `$DSH_HOME` 里**，绝不往用户工作区写（红线不变）；
 *   · 键是 **sid**（会话编号），与锁同一口径（换一场对话就是干净的默认）。
 */

export const OWED_STORE_FILE = "owed.json";

/**
 * 欠账记录最多留多少场对话（超出丢**最旧**的）。
 *
 * ★ 为什么需要上限：`owed.json` 是**只增不减**的记录（每场欠账的对话一条），
 *   而"欠着"这件事只在**它们各自的下一条回复**里才有意义 ——
 *   几十场之前的欠账**已经没有任何人会去看**。
 * ★ 取 200：远大于同时活跃的会话数，又不至于让这个文件无限长大。
 *   （与 `SHADOWED_STORE_SESSIONS` / `CAPSULE_STORE_SESSIONS` 同一思路。）
 */

export const OWED_STORE_MAX = 200;

/** 锚点记录文件路径（与锁同一个目录）。 */

export const CAPABILITY_STORE_FILE = "capabilities.json";

/**
 * ★★★ **能力清单的单一出处** —— 代码就是真相，清单由它算出来（不手抄）。
 *
 * ★ 为什么必须是常量表而不是手写进文件：
 *   手抄的清单**一定会漂**（本项目那条纪律：「记录存在 ≠ 记录准确」——
 *   数字写下来了，写的是错的，守卫还是空的）。⇒ 让**代码自己**报自己有什么能力。
 * ★ 每一项 = 这类记忆的**清单键**（`.dsh-ledger.json` 里的字段名）、**给人看的名字**、
 *   **怎么用**（工具名 / 何时用）、以及**它是哪一版引入的**（给人看"这是新增的"）。
 *
 * ★★★ 为什么是**函数**而不是顶层常量数组 —— 这一条我当场栽过，必须留档：
 *   第一版写成 `const CAPABILITY_KINDS = [ … ]` 并在里面引用 `PRINCIPLE_GRANT_TOOL`
 *   ⇒ **模块加载直接抛** `Cannot access 'PRINCIPLE_GRANT_TOOL' before initialization`。
 *   ★ 那是**TDZ**（暂时性死区）：`PRINCIPLE_GRANT_TOOL` 定义在 5000 行之外，
 *     而顶层 `const` 是**按顺序求值**的 ⇒ 用它的时候它还不存在。
 *   ★★ 本项目**栽过同型的坑一次**（`latestStateForTest` 的 TDZ，见那处注释）——
 *     "声明在使用之后"在 `const`/`let` 上**不是风格问题，是运行期错误**。
 *   ⇒ 正解：**延迟到调用时求值**（下面这个函数）。
 *     ★ 比"把常量前移"更稳：前移会引出新的先后依赖，而函数求值**天然没有顺序问题**。
 */

export const BLOCK_HISTORY_FILE = "blocks.json";

/** 每块变更史的条目上限（防止台账反复大改把这份文件撑爆）。 */

export const BLOCK_HISTORY_MAX = 2000;

/** 不在当前台账里、且**超过这个年纪**的块条目 ⇒ 清理。 */

export const BLOCK_HISTORY_TTL_MS = 90 * 86400e3;

/** 区块变更史文件路径（与锁/锚点同一个目录）。 */

export const SHADOWED_INDEX_FILE = "shadowed.json";
/**
 * ★★★★★ 2026-10-13（D182）：落盘时最多留几场会话 —— 用户原话是*"这个索引**只追加不删**"*。
 *
 * ★ 原实现（60 场）是**整场删除**（`delete store.bySession[k]`）⇒ 与"只追加不删"**直接冲突**。
 * ★ 为什么现在可以放大到 500（实测依据，不是拍的）：
 *   本机 `shadowed.json` = **5,664 B / 7 场 / 16 条** ⇒ **每条约 354 B**。
 *   本插件自己的"胶囊素材"也是 60 场量级，但那份**要进上下文**；
 *   而这份索引**只在压缩后渲染最近 N 行**（见 `renderShadowedIndex`），
 *   **盘上多大都不进上下文** ⇒ 没有任何理由按 60 场砍。
 *   ⇒ 500 场 × 约 2.3 条/场 × 354 B ≈ **0.4 MB**（可忽略）。
 * ★ 那为什么还留个上限（不彻底无界）：**防止一个病态循环**（例如某次改动导致
 *   每步都压一次）把文件撑成几百 MB，进而拖慢**每一次** `readShadowedStore()`。
 *   ⇒ 按**场数**设阀而不是按**条数**，且阀值远大于真实用量 ⇒ 正常使用永远碰不到。
 * ★ 淘汰的是**最旧**的场（不是最新的）—— 与 D182 那个"尾部截断把新记录砍掉"的坑
 *   **相反**：这里必须淘汰最旧的。★ 判据在探针 `_probe-d182-append-only.mjs` 里也验了。
 */

export const SHADOWED_STORE_SESSIONS = 500;

/** 被压段索引的落盘路径（与锁/锚点/胶囊同一个目录）。 */

export const MANIFEST_REL = ".dsh-ledger.json";

/** 注入消息的 source.kind。自定义 kind ⇒ 官方 pre-step 的清理逻辑认不出它、动不了它。 */

export const INJECT_KIND = "project-ledger-notes";

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

export const MODE_STEADY = "steady";

export const MODE_SURGICAL = "surgical";

export const MODES = [MODE_STEADY, MODE_SURGICAL];

// ── ★★★★★ 2026-10-16（D222）：**面板与项目清单，谁说了算** ─────────────────
//
// ★ 用户原话（逐字）：*"我对设置面板的修改没能在老项目这里同步，导致所有设置只对新对话生效
//   ——很不方便，同时我想以设置面板为准，而不是以项目为准"*
//
// ★★ 他报的"所有设置"**不准确**（我逐项数过）：38 项里 **33 项一直跟着面板走**，
//   只有 **5 项**是 project-first（mode / blockInjection / maxActiveLines /
//   changeRegisterMax / logLevels），而"没同步"的观感**全部来自那 5 项**。
// ★★★ 更深的真根因：`ledger_init` 建项目时**把面板当时值当项目值写进清单**
//   （`part4.js:650` 一带）⇒ 每个项目在**创建那一刻冻结**了面板值 ⇒
//   之后面板再改，它永远不跟。所以"只对新对话/新项目生效"是**结构性的**，不是偶发。
//
// ★ 判据（一个事实只能有一个出口）：**"谁优先"必须是一个显式设置**，
//   而不是散在 5 个函数里各判一次 —— 那样加第 6 项时必然漏，且没有断言会红。

/** 以设置面板为准（默认）：面板改什么，所有项目立刻跟着变。 */
export const PRECEDENCE_PANEL = "panel";

/** 以项目清单为准：清单里写了就用清单的（保留"一个仓库两种活"的能力）。 */
export const PRECEDENCE_PROJECT = "project";

export const PRECEDENCES = [PRECEDENCE_PANEL, PRECEDENCE_PROJECT];

/** 受"谁优先"管辖的 6 个键（其余项**一直**以面板为准）。 */
export const PRECEDENCE_KEYS = [
  "mode",
  "blockInjection",
  // ★★★★★ D234：文件锚定也是"会改变模型看到什么"的注入开关，
  //   ⇒ 必须与 `blockInjection` 享受同一套"清单写得进、面板盖得住"的口径。
  //   ★ 漏加这一个的后果：面板改了**不生效**，而面板上看起来改好了（D222 那个病的复发形态）。
  "fileAnchor",
  "maxActiveLines",
  "changeRegisterMax",
  "logLevels",
];

/** 分流单的桶名（用户说的"划分"）。 */

export const TRIAGE_KEEP = "keep";

export const TRIAGE_STASH = "stash";

export const TRIAGE_DROP = "drop";

/** `_stash/` 只存桶的目录名（在项目根下）。 */

export const STASH_DIR = "_stash";


/** 活跃台账行数阈值默认值。 */

export const DEFAULT_MAX_ACTIVE_LINES = 300;

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

export const MAX_READ_CHARS = 60000;

/** 归档时单条最多列多少目录项。 */

export const MAX_ARCHIVE_LIST = 200;

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

export const PRESERVE_HEADING = "## 其他会话的进展（自动保留，未合并）";

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

export const CHANGE_REGISTER_HEADING = "## 变更登记（插件自动维护）";

/** 登记表最多保留多少行。有界是硬要求：台账不能被它自己撑爆。 */

export const CHANGE_REGISTER_MAX = 12;

/** 登记行前缀（用于从既有文本里识别出这一区）。 */

export const CHANGE_REGISTER_LINE_RE = /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \((?:write|append|replace|archive)[^)]*\)/;

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

export const BLOCK_HEADING_RE = /^(#{1,6})\s+(.*)$/;

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

export const WEIGHT_PRINCIPLE_SCORE = 95;

/** 标题声明"已完成/已处理/已过期"的**封顶分**（用户：*"已处理的、已过期的低分"*）。
 *  ★ 用**封顶**而不是扣分：融合分是**归一化相对分**，负分扣不干净 ⇒ 封顶才守得住
 *    "已完成的不该占上下文"（实测：两个模型都给「✅ 已完成（别再重做）」打了高分）。 */

export const WEIGHT_DONE_CAP = 20;

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

export const RRF_K = 60;

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

export const WEIGHT_MUST_INJECT = 50;




/**
 * 渲染**目录**（"非必要区块的相对位置"—— 用户 18:48 的提法）。
 *
 * ★ 只给**位置与身份**，不给正文：标题（截断）+ 行数 + 内容哈希前缀。
 * ★ 截断到 40 字符的理由（实测）：这台机器的标题常常是半句话，
 *   不截断时目录要 **1,413 字符**，截断后约 **1,225** —— 而目录是**每块都要付**的固定成本。
 * ★ 为什么必须带哈希：模型据此知道"这块我有没有见过"（配合 D133 的差异）。
 */

export const TRIAGE_ALWAYS = true;

/** 现在是否要求分流（D129：恒真，见 `TRIAGE_ALWAYS`）。 */

export const CANDIDATE_RE =
  /^(ledger|ledger\.[a-z-]+|台账|任务台账|项目台账|项目状态|project[_-]?ledger|project[_-]?status|status|progress|进度)\.(md|markdown|txt)$/i;

/** 台账默认建议的 .gitignore 条目（只在用户/配置要求时用）。 */

export const DEFAULT_IGNORE_LINES = [];

/**
 * 回合末四选一的工具名。
 *
 * ★ 为什么是一个**工具**而不是插件自己偷偷弹卡片：
 *   卡片要送给用户，必须拿到 `userQuestions` 服务、并且有一个**活的 root agent**；
 *   而"这一刻该不该弹"只有 AI 知道（用户需求 ②：AI 觉得有必要时也可以给）。
 *   所以插件把"问什么、选完干什么、压缩交给谁"做成一个工具，由 AI 决定调用时机。
 */

export const CHECKPOINT_TOOL = "ledger_checkpoint";

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

export const PRESSURE_TIERS = [0.3, 0.5, 0.7];

/**
 * 到这一档就要**停手并让用户决定**（而不是"顺手固化"）。
 *
 * ★ 单独抽一个常量而不是在文案里写 `0.7`：这个数同时被三处用到
 *   （AI 的提醒文案、给用户看的卡片提示、`PRESSURE_TIERS` 的最高档），
 *   写死三遍迟早会有一处忘了改 —— 本机已经栽过"两处各写一份常量"的坑。
 */

export const PRESSURE_STOP_RATIO = 0.7;

/**
 * ★★★★★ 2026-10-17（D240，用户拍板）：**插件强制携带的水位档** —— 不随用户设置转移。
 *
 * 用户原话（逐字）：*"自定义也不应该只保留三档，可以是两档，可以是一档
 * 甚至一档水位都不设定，但是不管用户怎么设定，插件里面强制设定一个 70% 的水位提醒。"*
 *
 * ★ 为什么必须是 70%：它是「**还能在官方 80% 之前自己压一次**」的唯一余量。
 *   把这一档交给用户自定义，等于允许用户把自己配进死局（D236 那次事故正是这样死的）。
 * ★★ 为什么复用 `PRESSURE_STOP_RATIO` 而不另写 `0.7`：同一个数不许有两个出处
 *    （本机已栽过"两处各写一份常量"的坑）。
 * ★ 它与 `PRESSURE_TIERS` 的关系：`PRESSURE_TIERS` 是**默认值**（可被用户整体替换），
 *   而这一档是**强制项**（永远并入，永不可删）。
 */
export const FORCED_PRESSURE_TIER = PRESSURE_STOP_RATIO;

/**
 * 用户设置 + 强制档 ⇒ **实际生效的档位表**（唯一出口）。
 *
 * @param {number[]} [userTiers] 用户在面板里设的档位（**可以为空数组**）
 * @returns {number[]} 升序去重，且**必含 `FORCED_PRESSURE_TIER`**
 *
 * ★ 为什么要有这个函数，而不是在调用处手写 `[...tiers, 0.7]`：
 *   它们要在**三个地方**同时生效（注入提醒 / 面板提示 / 自检断言），
 *   手写三遍必然分叉。★ 而且"强制"这件事必须**可被断言** —— 见 selftest 情形 93。
 */
export function effectivePressureTiers(userTiers) {
  const base = Array.isArray(userTiers) ? userTiers.filter((t) => Number.isFinite(t)) : [];
  return [...new Set([...base, FORCED_PRESSURE_TIER])].sort((a, b) => a - b);
}

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

export const DEFAULT_DELTA_TRIGGER_POINTS = 20;

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

export const NUDGE_MIN_RATIO = 0.45;

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

export const DELTA_TRIGGER_CAP_MARGIN_POINTS = 5;

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

export const DELTA_TRIGGER_MIN_GROWTH_POINTS = 2;

/**
 * ★★ 内核的自动压缩线（`dsh-compaction-basic` 的 `thresholdRatio` 默认值）。
 *
 * ★ 出处：`dsh-compaction-basic/lib/index.js` —— `const DEFAULT_THRESHOLD_RATIO = .8;`
 *   （★ 这条是**读内核源码**得到的，不是猜的；见 `_调研-bundle-patch机制.md`）。
 * ★ 用途：兜底线**绝不能越过它** —— 越过就等于"把压缩权让给内核"（而内核那次抓不到逐字胶囊）。
 */

export const KERNEL_HARD_COMPACT_RATIO = 0.8;

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

export const DEFAULT_DELTA_REMOVE_POINTS = 30;

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

export const MIN_COMPRESS_POINTS = 1;

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

export const HIGH_FIDELITY_COMPACT_RATIO = 0.7;

/**
 * ★★★★★ 2026-10-19（D273，用户拍板）：**默认全量压缩线 0.3 → 0.7**。
 *
 * 用户原话（逐字）：*"同时默认的全量压缩从30%提到70%，因为我们此前已经验证过了，
 * 压缩的越频繁，记忆消失的越快。"*
 *
 * ★ 依据（本项目实测，不是口味）：
 *   · 全库 200 会话 / 134 次压缩：**≤5 万 token 的浅折有 72.7% 会被再折**；
 *     5~10 万 47.2%；10~20 万 10%；20~35 万 5.6%；**≥35 万 0%**。
 *   · 深度 ≥2 的中位折 64,507；深度 =1 的中位折 **266,435（4.1 倍）**。
 *   ⇒ **低水位 ⇒ 折得浅 ⇒ 必然被再折** ⇒ N 层摘要 ⇒ 清晰度衰减。
 *   这正是用户说的"压缩越频繁，记忆消失越快"的机制。
 *
 * ★ 为什么上限仍是 0.79：到 0.8 就与内核自己那次同刻，失去"提前一次"的意义
 *   （见 `SETTING_SPECS` 里 `highFidelityCompactRatio` 的 `max`）。
 *   ⇒ 0.7 与 0.79 之间还留 9 个点的余量。
 *
 * ⚠️ **改默认值不等于改用户已有的设置**：`normalizeSettings` 从
 *   `settingDefaults()` 起算、再用**用户存过的键逐个覆盖** ⇒ 设过 0.3 的人仍然是 0.3。
 *   详见同目录的 `normalizeSettings` 与 D273 的验收。
 */

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

export const CAPSULE_USER_MSG_MAX = 40;
/** 胶囊里单条用户消息的字符上限（粘一整个文件进来的那种才截）。 */

export const CAPSULE_USER_MSG_CHARS = 1200;
/** 胶囊里逐字保留的失败信息条数上限。 */

export const CAPSULE_ERROR_MAX = 20;

export const CAPSULE_ERROR_CHARS = 300;
/** 器物索引最多列多少个文件（按最后一次操作时间倒序）。 */

export const CAPSULE_ARTIFACT_MAX = 60;
/** 胶囊整体字符上限 —— 它**要进上下文**，所以必须有闸门（约 4k token）。 */

export const CAPSULE_MAX_CHARS = 16000;

/**
 * ★★★ 「被压段索引」最多留几条（承 DECISIONS D79「指针推行」）。
 * ★ 为什么必须有上限：这份索引**要常驻上下文**（D46：恢复必须"推"给模型），
 *   所以它必须"小到可常驻"。本机 22 次压缩 ⇒ 22 行约 1.3K 字符，远在回读预算（≈31K tok）内。
 *   上限取 60 ⇒ 即使压得再密，索引也只在 4K 字符量级。
 */

export const SHADOWED_INDEX_MAX = 60;

/** `ledger_recall` 单次**最多**回读多少字符（≈ 6K token）—— 回读预算的闸门。 */

export const RECALL_MAX_CHARS = 24000;

/**
 * ★★★★★ 2026-10-20（D285）：回合内压缩诊断落进**哪个文件名**（在项目根下）。
 *
 * 🔴 为什么需要它（实测）：诊断原本只走 `ctx.logger.warn`，而 logger 是结构化消息、
 *   由 `exporter.export(message)` 派发 —— DSH **没有注册可读的 Exporter**
 *   ⇒ 日志写进虚空。实测 `[midturn] act=… ratio=\d+.\d+%` 这个精确形态在
 *   **53273 条会话事件里命中 0 条**，肉眼完全看不出它跑没跑。
 *
 * ★ 三条硬约束（都为了"诊断绝不能害人"）：
 *   ① **名字固定、显眼、带点前缀** ⇒ 用户一眼看出是调试产物，删起来没有顾虑；
 *   ② **只写这一个文件**，路径 = `path.join(projectRoot, MIDTURN_DIAG_FILE)`，
 *      **不接受任何外部输入**（不拼用户数据，不会跑出项目根）；
 *   ③ **只追加，不轮转、不删除** —— 本插件**绝不**替用户清理文件，要清他自己删。
 * ★★ 默认**不写**：`settings.diagFile === true` 才写（见 part1.js 的 `diagFile`）。
 */

export const MIDTURN_DIAG_FILE = ".dsh-ledger-midturn.log";

/**
 * ★★★ 被挤出胶囊的用户原话，升级归档到哪个文件名（承 D84 修复）。
 * ★ 放在 `_ledger-archive/<YYYY-MM>/weekN/` 下 —— 与归档、日志共用同一期间键。
 * ★ 名字刻意**不含日期**：它是**同一条只追加的流**（历次淘汰都往同一个文件追加），
 *   而所在目录已经带了期间信息；若文件名再嵌日期，反而会**按天碎成很多份**，
 *   "找一句原话"就得先猜是哪天。
 */

export const USER_MSG_ARCHIVE_FILE = "用户原话-完整存档.md";

/**
 * ★★★★★ 2026-10-13（D170）：用户原话兜底副本的**项目相对路径 —— 唯一出口**。
 *
 * ★ 为什么必须收成一个（**D164/D165 的同型漏网**，本轮普查抓到的）：
 *   同一件事（"那个只追加的兜底文件在哪"）被算了两遍，且**两遍的兜底不同**：
 *     · **写**（`archiveEvictedUserMessage`）：`info?.archiveRel`，**取不到就直接不写**；
 *     · **渲染**（`renderCapsule` 的 ② 那条）：`info.archiveRel ?? "_ledger-archive"`
 *       —— 取不到就**编一个**。
 *   ⇒ 没有项目清单的会话（本机实测 **104/112 场在容器根、没有清单**）走的就是这条路：
 *     写盘那侧一条都不写，而胶囊里**照样印着**「② 项目里的
 *     `_ledger-archive/2026-10/week2/用户原话-完整存档.md`」。
 *   ★ 这**正是 D164 抓到的那个形状**：「指针指着一个不存在的地方」——
 *     模型照抄路径去读、什么都读不到，而台账却说"兜底副本在这" ⇒
 *     直接伤 **准确性** 与 **可回溯**（D164 的判据在这里**没盖住**）。
 *   ★ 判据口径与 D165 一致：「**同一个路径不许算两遍**」，且**取不到就如实留空、绝不编**。
 *
 * ★ 一律用**正斜杠**（与 `capsuleDirRel` 同口径）：这串会被写进 markdown 给人和模型
 *   **复制粘贴**，而 Windows 的反斜杠在部分渲染器里是转义符。
 *
 * @param {object} info `inspect(root)` 的结果
 * @param {Date} now 用哪一刻算期间桶（写盘与渲染必须用**同一个**时刻口径）
 * @returns {string|undefined} 取不到 `archiveRel` 时返回 `undefined`
 */

export const CAPSULE_STORE_FILE = "capsules.json";

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

export const capsuleSkipStats = { writes: 0, skipped: 0, mergedOld: 0 };

/** 落盘文件最多记几个会话（本机 139 会话的历史尺度下够用；超出丢最旧的）。 */

export const CAPSULE_STORE_SESSIONS = 60;
/**
 * ★★★★★ 2026-10-13（D170）：落盘文件里每个会话最多留几条 —— **纯卫生上限**（不是策略上限）。
 *
 * ★ 为什么必须与「内存上限」分开（真机缺陷，本轮普查抓到）：
 *   同一个"收几条原话"的上限原来有**两个出处**，且**只有一条带归档**：
 *     · `consume()`：常量 `CAPSULE_USER_MSG_MAX`(=40)，超出 ⇒ 交给 `drainEvicted` 归档；
 *     · `hydrate()` / 落盘：设置项 `numOf("capsuleUserMsgMax")`，超出 ⇒ **直接 slice 掉**。
 *   ★ 实测（沙箱夹具跑出来的，不是读代码推的）：设置调到 **5** 时，
 *     consume 照旧收 12 条（常量在管），重启后 hydrate **静默砍到 5 条**，
 *     而那 7 条 **`drainEvicted` 拿回 0 条** ⇒ 既不在内存、也没进归档 ⇒ **无声消失**；
 *     设置调到 **200** 时 `consume` 仍只收 40 条 ⇒ **面板调了完全没用**（空承诺）。
 *   ⇒ ★ 修的是**出处**（D168 立的判据）：内存上限收成唯一出口 `capsuleUserMsgMaxOf()`，
 *     且**所有**截断都走 `trimUserMessagesInPlace()`（它顺带把被挤出的送进归档通道）。
 *
 * ★★★ 为什么这个常量**必须 ≥ 设置项的上限**（否则会打穿 D159 那条不变量）：
 *   内存上限现在跟随设置（1~200）。若落盘上限比它小，用户把设置调大后，
 *   内存攒到 200 条、落盘却只写 40 条 ⇒ **盘上那份反而变少** ⇒
 *   重启后 hydrate 只能补回 40 条，**160 条真原话失效** —— 正是 D159 修掉的那个病。
 *   ⇒ 它按"设置项能达到的最大值"取，**并且由自检断言钉住这个大小关系**
 *     （`CAPSULE_STORE_USER_HARD_MAX >= SETTING_SPECS 里 capsuleUserMsgMax 的 max`）——
 *     将来有人调大设置上限，断言**当场变红**，而不是悄悄丢数据。
 * ★ 它也**不跟随**设置：跟随就会变成"调小 ⇒ 读的时候就把盘上那份砍了"，
 *   同样打穿"只增不减"（用户把 200 调回 40 时，盘上已有的 200 条会被砍成 40）。
 */

export const CAPSULE_STORE_USER_HARD_MAX = settingSpecMax("capsuleUserMsgMax", CAPSULE_USER_MSG_MAX);
/** 同上，报错桶的对应值（两侧对称，免得只修一半 —— D168 的教训）。 */

export const CAPSULE_STORE_ERROR_HARD_MAX = settingSpecMax("capsuleErrorMax", CAPSULE_ERROR_MAX);

/**
 * ★★★★★ 2026-10-13（D170）：**「胶囊收几条原话」的上限 —— 唯一出口**。
 *
 * ★ 收藏它的理由就是 D168 那条：同一个值算两遍，必然在**某一次改动**上分叉。
 *   这里分叉的后果尤其重 —— 两个出处里**只有一个带归档**（见上面那个常量的注释）。
 * ★ 与 `capsuleErrorMax` 两侧本来就都用 `numOf(...)` 不同：那一对没分叉，
 *   是因为写它的时候**两侧正好都记得**改；这一对漏了一侧。⇒ 靠"记得"不如靠"只有一个出口"。
 */

export const CONTAINER_MARKERS = ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".windsurfrules"];

/** 找"容器工作区"证据时向下扫几层；以及每层最多看几个子目录（防止在巨型目录上卡住）。 */

export const CONTAINER_SCAN_DEPTH = 2;

export const CONTAINER_SCAN_FANOUT = 300;

/**
 * 标志文件要**配上至少这么多子目录**才算容器证据。
 *
 * ★ 为什么不是"有 AGENTS.md 就算容器"：单个新项目完全可能自己带一份 `AGENTS.md`
 *   （那正是规范化项目的做法）。只凭标志文件判容器，会让这种项目**永远收不到**
 *   需求 ① 的初始化提示 —— 把一个"新增功能"变成"新增静默"。
 *   配上"目录里已经有多个子项目"这一条，两边都保住：真容器判得出，单项目不误伤。
 */

export const CONTAINER_MIN_SUBDIRS = 2;

/** 跳过这些目录名：它们不是子项目，且 node_modules 一进去就是几千个包。 */

export const NOT_A_SUBPROJECT_RE = /^(node_modules|\.git|\.svn|\.hg|dist|build|out|target|vendor)$/i;

/** 数一下本层有几个"像子项目"的子目录。读不了就当 0（宁可不判容器）。 */

export const CONTAINER_CACHE_TTL_MS = 60_000;

export const containerCache = new Map();

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

export const DEFAULT_LOG_DIR = "_ledger-log";

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

export const DEFAULT_LOG_LEVELS = { L0: true, L1: true, L2: true, L3: false, L4: true };

/**
 * L4 一行的**硬上限**（字符，含时间戳与编号）。
 *
 * ★ 这是**安全阀**，不是"故意截断"：本机实测 769 条真实用户消息里
 *   p50=51 / p90=291 / p99=5422 / **max=6949** 字符。上限设在 20000 意味着
 *   正常消息**一条都不会被截**，只有"用户粘了一整个文件进来"那种才会被切，
 *   并留下明确标记 —— 那总比让单行无限膨胀、把 grep 与 limit 一起拖垮好。
 */

export const USER_MSG_MAX_CHARS = 20000;

/** L4 只在 `source.kind` 正好是这个值时采集 —— 实测这就是「人类本人发的」。 */

export const USER_MSG_SOURCE_KIND = "user";

/**
 * 默认**读取**档位：L0–L3。
 *
 * ★ 刻意不含 L4：用户消息量大（实测 769 条 vs 工具调用几百条），
 *   若默认混进 timeline，一次"最近发生了什么"的查询会被原话刷屏。
 *   要看它得显式说：`ledger_log({view:"users"})` 或 `levels:["L4"]`。
 */

export const DEFAULT_READ_LEVELS = ["L0", "L1", "L2", "L3"];

/** L3 每行参数截断长度。实测 50 字符 ≈ 64 B/行；截到 90 只多 3 B 但噪音更大。 */

export const LOG_BRIEF_CHARS = 50;

/** 回溯读取的条数上限与默认值。 */

export const LOG_DEFAULT_LIMIT = 200;

export const LOG_MAX_LIMIT = 2000;

/** 日志目录里允许出现的文件名（既是写入白名单，也是读目录时的过滤器）。 */

export const LOG_LEVEL_FILES = {
  L0: "L0-milestones.md",
  L1: "L1-turns.md",
  L2: "L2-files.md",
  L3: "L3-tools.md",
  L4: "L4-user-messages.md",
};

/**
 * ★★★★★ 2026-10-18（D255，用户拍板）：**日志文件按大小滚动拆片**。
 *
 * 用户原话（逐字）：*"或者确实可以把比较大的文件拆分成多个按时间拆分的文件。"*
 *
 * ── 为什么必须拆（实测，不是担心）──────────────────────────────────────
 * `_ledger-log` 按周分桶，实测已越「能整篇读」的边界：
 *   week2/L2-files.md **567 KB** · week2/L1-turns.md 283 KB · week3/L2-files.md 154 KB
 * 而当天速率是 **L2 +16 KB/天 ⇒ 一周 +112 KB** ⇒ **新的一周必然也越界**。
 * ⇒ 后果不是"不好看"，是**「有事才查」这个设计前提失效** —— 查不动就等于没有。
 *
 * ── 为什么按「大小」而不是按「天」──────────────────────────────────────
 * 按天：某天特别密集时**单日照样超**；某天没活时又碎成一堆。
 * 按大小：**确定性上限，永不越界**，且攒够才滚、不浪费。
 * ★ 但**文件名仍带时间感**（见 `shardName` 的注释）—— 大小决定**何时**滚，时间决定**怎么排**。
 *
 * ── 阈值为什么是 128 KB ──────────────────────────────────────────────
 * 「还能整篇读」的实际上限约 100 KB（`read` 默认 2000 行 × 平均行长）。
 * 留 28 KB 余量 ⇒ **跨过阈值那一刻仍然读得动**。写成常量而不是设置项：
 * 用户没要求可调，**少一个旋钮就少一处"配了但没生效"**（D224 的教训）。
 */

export const LOG_SHARD_MAX_BYTES = 128 * 1024;

/** 片数上限：防止极端情况下无限建文件；到上限后继续写最后一片（绝不丢条目）。 */

export const LOG_SHARD_MAX_COUNT = 99;

/**
 * 第 `n` 片的文件名。★ `n === 1` 时**保持原名**（见下）。
 *
 * ★ 序号三位补零 ⇒ **字典序 = 时间序**（`-002` < `-003` < `-010`）。
 *   跨片回溯时要按顺序读，这一条是那个顺序的物理保证。
 * ★ **第 1 片保持原名**（`L2-files.md` 而不是 `L2-files-001.md`）：
 *   现存所有历史文件**一个都不用搬、老版本读得到、新代码也读得到** ⇒ 零迁移。
 */

export function shardName(base, n) {
  if (!Number.isInteger(n) || n <= 1) return base;
  const m = /^(.*?)(\.md)$/.exec(base);
  if (m === null) return `${base}-${String(n).padStart(3, "0")}`;
  return `${m[1]}-${String(n).padStart(3, "0")}${m[2]}`;
}

/**
 * 把一个**物理文件名**剥回**逻辑名**（去掉 `-NNN` 分片后缀）。
 *
 * ★ 为什么需要它：代码里有两处**按文件名硬匹配**的逻辑
 *   （`part3.js:2097` 找 `L0-ledger-changes\.md$`、`part4.js:2832` 生成该名）。
 *   拆片后它们会因为 `$` 锚点而**漏读新片**（= 拆了但读不到，比不拆更糟）。
 *   ⇒ 统一用本函数剥掉序号再比，**以后再加片也不用逐个改匹配**。
 *
 * 例：`L2-files-003.md` → `L2-files.md`；`L2-files.md` → `L2-files.md`
 */

export function logicalLogName(name) {
  const s = typeof name === "string" ? name : "";
  const m = /^(.*?)-\d{3}(\.md)$/.exec(s);
  return m === null ? s : `${m[1]}${m[2]}`;
}

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

export const CAPSULE_DIR_NAME = "capsules";

/** 胶囊文件名用的时间戳：`YYYY-MM-DD-HHmmss`（可排序、无空格、跨平台安全）。 */

export const LOG_FLUSH_DEBOUNCE_MS = 1200;

/**
 * L3 不记的工具。
 *
 * ★ 两类，理由不同：
 *   - `read`/`edit`/`write`：它们的 L3 行只是 L2 行的重复（同一个文件路径），
 *     记两遍不会多出信息；
 *   - 本插件自己的工具：`ledger_log` 若把自己的读取也记进日志，
 *     就会形成"查日志 → 日志变长 → 下次查更多"的自激。
 */

export const L3_EXCLUDE = new Set([
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

export const L2_TOUCHED_SPEC = {
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

export const L2_READ_SPEC = { read: ["file_path"] };

/** 日志档位名 → 是否合法。 */

export const LOG_LEVEL_NAMES = ["L0", "L1", "L2", "L3", "L4"];

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

export const AUDIT_KIND_WRITE = "ledger-write";

export const AUDIT_KIND_ARCHIVE = "ledger-archive";
/**
 * ★★★★★ 2026-10-13（D180）：**根本原则条例**的改动也进审计 —— 用户原话：
 * *"以上两个需要维护的东西，**每一次修改都同步到日志中**。"*
 * ★ 单独一个 kind（而不是并进 `ledger-write`）：它的**权威来源不同** ——
 *   台账/决策是"模型写的"，根本原则是"**用户授权的**"。混在一起就分不出
 *   "这条是谁的主张"。而 `ledger_log({view:"audit"})` 会收全部 kind
 *   （见 `AUDIT_KINDS`）⇒ 分开标不会让它在审计里消失。
 */

export const AUDIT_KIND_PRINCIPLE = "ledger-principles";
/** ★★★★★ 2026-10-13（D181）：**目标树**的改动（用户对"两个需要维护的东西"都要求同步日志）。 */

export const AUDIT_KIND_GOALS = "ledger-goals";
/**
 * ★★★★★ 2026-10-13（D183）：**回合流水**（分类记忆的第 5 种）。
 *
 * ★ 为什么单独一个 kind（而不是并进 `ledger-write`）：它的**语义与活跃台账相反** ——
 *   活跃台账是"**当前状态**"（可被覆盖、被精简、被归档），而流水是"**只追加的历史**"
 *   （写给"以后要查的人"看，不该被改写）。混成一个 kind，"这条是状态还是历史"就分不出。
 */

export const AUDIT_KIND_JOURNAL = "ledger-journal";

export const AUDIT_KINDS = [
  AUDIT_KIND_WRITE,
  AUDIT_KIND_ARCHIVE,
  AUDIT_KIND_PRINCIPLE,
  AUDIT_KIND_GOALS,
  AUDIT_KIND_JOURNAL,
];

/** L0 关注的事件类型 → 写进日志的一句话。`kind` 供回溯时按类型过滤。 */

export const L0_KINDS = {
  "deliverables/presented": (d) =>
    `交付 ${Array.isArray(d?.files) ? d.files.length : 0} 个文件`,
  // ★ 压缩来源（需求 ②③）：四条入口都压同一种压缩，**但它们是四条不同的路**。
  //   不记来源的话，"这次是自动 70% 压的，还是我手动敲的"事后查不出来 ——
  //   而事后查询正是日志存在的理由。来源由插件在 `state.hfSource` 里**当场**记下
  //   （`session/event` 里拿不到它，因为 `compaction/end` 是内核发的，它不知道谁发起）。
  "compaction/end": (d, extra) => {
    const src = extra?.hfSource;
    // ★★★★★ 2026-10-15（D215）：**失败的压缩不许写成「上下文已压缩」**。
    //
    //   ★ 真机为证（本会话 10:24:59，用户报"三条已压缩"时我正是被它误导的）：
    //     · 会话事件（真源）：`compaction/end` 带 `error: "Request aborted"`
    //       （跑了整整 300 秒 = 超时打满 ⇒ 摘要**从未生成**）；
    //     · 而本日志写的是：`上下文已压缩（自动 70%）` —— **一整个假里程碑**。
    //   ★ 代价很具体：这一行正是"用来查压缩到底发生了几次"的那一行，
    //     它一假，**连诊断的人都先被它骗一遍**（纪律 11「记录存在 ≠ 记录准确」）。
    //   ★ 判据**共用唯一出口** `compactionEndFailed()`（它同时也是
    //     `compactionEndSucceeded` 的内核）—— 不许在这里另写一套 `d.error !== undefined`：
    //     两处各写一套 = 将来内核改字段时必然分叉（D159/D163/D164 同族病）。
    const label = src === undefined ? "" : hfSourceShort(src);
    if (compactionEndFailed(d)) {
      const err = String(d?.error ?? "").replace(/\s+/g, " ").slice(0, 160);
      return `压缩失败${label === "" ? "" : `（${label}）`}：${err === "" ? "（无错误详情）" : err}`;
    }
    // ⚠️ 保留 `undefined ⇒ ""` 这条**既有契约**（26a 钉着它）：
    //   没有来源时退化成「上下文已压缩」，不造词、也不写「未知来源」。
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
// ★ 记在哪：**先顺工作区已有的那条通道**（本机是 `60-对话记录与交接\对话总结\`，
//   已有 27 份在用）；**找不到才新建**，而新建时用**通用的**名字 `问题记录`。
//
//   ★★★★★ 2026-10-17（D229，用户拍板）——**为什么默认名不能再是那条本机通道**：
//     用户原话：*"他在我们这里是这个文件夹，但是在别人那里他们不一定应该叫这个文件夹，
//     所以说或许应该新建的这个文件夹统一命名为问题记录。"*
//     ⇒ 判据：**"顺着别人已有的约定"与"替别人新建一个"是两件事** ——
//       · **已存在**的目录：认出它、顺着它（那是**他的**约定，不该改）；
//       · **要新建**的目录：用**通用名**（不能把本机那套结构强加给外人）。
//     ★ 我原来把这两个语义混在同一个常量里（`DEFAULT_NOTES_DIR` 既是"候选之一"又是"新建名"）
//       ⇒ 对**本机**刚好没问题（目录已存在，走的是 guess 那档），对**别人**就会凭空
//       建出一个 `60-对话记录与交接/对话总结` —— 那是**把他的工作区按我们的格局改造**。

/** ★ 「要新建时」用的目录名（相对**容器根/工作区根**）—— 通用名，不含本机的编号结构。 */

export const DEFAULT_NOTES_DIR = "问题记录";

/** 问题记录目录的保守候选名（没登记 notesDir 时按这些名字找**已经存在**的）。 */
//  ★ 顺序即优先级：先认**本机既有通道**（我们这儿在用），再认**通用名**，最后几个短名。
//  ★ 与 `DEFAULT_NOTES_DIR` 的分工：候选名只管"**已经存在**的"，默认名只管"**要新建**的"。

export const NOTE_DIR_CANDIDATES = [
  "60-对话记录与交接/对话总结",
  "60-对话记录与交接",
  "对话总结",
  "问题记录",
  "_问题记录",
  "_notes",
];

/** 一条问题记录的默认分类。分类只影响用哪个二级标签，不影响能不能写。 */

export const NOTE_KINDS = ["问题", "调研", "故障", "决定", "其他"];

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

export const DEFAULT_HANDOFF_DIR = "_handoff";

/**
 * ★★★★★ 2026-10-13（D180，用户拍板）：**根本原则条例**的默认文件名。
 *
 * 用户原话（逐字）：*"第2个需要维护的是根本原则条例，**没有用户的授权，绝对不能往里面写东西
 * 或者修改东西**。以上两个需要维护的东西，**每一次修改都同步到日志中**。"*
 *
 * ★ 为什么它是**独立文件**、而不是塞进 `DECISIONS.md`：
 *   两者的**写入权威**完全不同 —— 决策记录是"模型在工作中定下的"，
 *   而根本原则是"**只由用户授权才成立**"的东西。混在一起 ⇒ 那道守卫必然失效
 *   （要么把决策也锁死、要么把原则也放开，两种都错）。
 */

export const DEFAULT_PRINCIPLES_NAME = "PRINCIPLES.md";

/**
 * ★★★★★ 2026-10-13（D180）：**用户授权的有效期**。
 *
 * ★ 为什么必须有 TTL（而不是"授权一次永久有效"）：
 *   授权是**针对某一次具体修改**的，不是"以后随便改"。若不设期限，
 *   一次点击就等于把这道守卫**永久打开** —— 那等于没有守卫。
 *   ★ 10 分钟足够"点击/答复 → 模型组织文字 → 调用工具"走完；
 *     超时则**要求用户重新授权**（宁可多问一次，也不留下常开的门）。
 */

export const PRINCIPLE_AUTH_TTL_MS = 10 * 60 * 1000;

/**
 * ★★★★★ 2026-10-14（D193）：`/ledger principles approve` 那张**确认卡片**的等待上限。
 *
 * ★ 为什么要自己给超时（而不是无限等）：与 `LEDGER_PICK_TIMEOUT_MS` 同一个坑 ——
 *   卡片被**关掉（dismiss）时那条 waterfall 不结算**，不给 signal 的话命令会永远挂着，
 *   而命令 handler 是被 await 的、平台**不设超时**（`dsh-commands` 里 timeout 命中 0 次）。
 * ★ 为什么给 5 分钟（比选子命令的 2 分钟长）：这一步用户要**真的读那段将被写入的原文**
 *   （可能要上下翻看），不是扫一眼选项就点。
 */

export const PRINCIPLE_APPROVE_TIMEOUT_MS = 5 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★★ 2026-10-13（D180，用户拍板）：**根本原则条例**（写入需要用户授权）
// ═══════════════════════════════════════════════════════════════════════════
//
// 用户原话（逐字）：*"第2个需要维护的是根本原则条例，**没有用户的授权，绝对不能往里面写东西
// 或者修改东西**。以上两个需要维护的东西，**每一次修改都同步到日志中**。"*
// 授权形式（用户原话，**两种都要**）：
//   *"一种是我主动自然语言描述之后模型去修改和增删（比如说模型认为他们有必要进入这个根本原则，
//   然后他自己会询问我，然后我同意之后他会自己去写。或者是我把我的指令描述出来后，模型问我一句，
//   我同意之后他去写。）。另外一种就是，像现在手动点全量压缩那样子，增加一个选项，
//   点击那个选项之后，我再输入我的要增加或者减少的东西。然后回车发给模型。"*
//
// ★★★ **本段的核心设计决定：让模型"根本没有写入路径"。**
//   · 模型能调的只有一个**提议**工具（`ledger_propose_principle`）——
//     它把"想改什么"记成一份**待授权提议**，然后**必须**调 `ledger_checkpoint` 把卡片交给用户；
//   · **真正的写盘发生在插件的回调里**（`applyPrincipleProposal`），而它只由**用户批准**触发。
//   ⇒ 这样"没有授权绝对不能写"是**结构性的**（代码里根本不存在"模型直接写"的路径），
//     而**不是**靠"我们相信模型会先问" —— 后者是纪律，不是守卫。
//   ★ 这与本项目一贯的取舍一致：**能做成结构性的，就不要做成纪律性的。**

/**
 * 原则条例的**唯一写出口**。
 *
 * ★ 为什么收成一个函数：写入路径只能有**一条**（工具、命令、卡片回调都走它），
 *   否则"哪条路绕过了授权"就再也查不清（D170 的"单一出处"判据）。
 * ★ 它**不自己判授权** —— 授权由调用方持有并作为参数传入（`authorizedBy`），
 *   这样"谁授权的"进了审计行，可追。
 */

export const PRINCIPLE_GRANT_TOOL = "ledger_principles_access";

/** 该会话现在有没有**活着的**原则授权窗口？没有就 `undefined`。 */

export const HANDOFF_DIR_CANDIDATES = ["_handoff", "handoff", "交接单", "交接", "docs/交接单"];

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★★ 2026-10-13（D181，用户拍板）：**目标树**（卡片 + 树 + 教训）
// ═══════════════════════════════════════════════════════════════════════════
//
// 用户原话（逐字）：*"第一，现在需要维护的台账增加一个目标表，也是类似的方法，卡片，多维参数，
// 你同样提供一个打分模板（我个人的想法是，至少其中一条标准是根本目标的权重永远很高，
// 当前正在做的目标（可以有好几个，可以一个目标做一半，做另外一个）权重也可以拉高），
// 已经完成的目标，权重随相对时间逐渐下降。每个已经完成的目标，都要标明走过哪些路，
// 然后用过哪些方法，然后哪些路走通了，哪条或者那些路没有走通。"*
// 补充（本轮）：*"其实这个比起目标表更像是一个**目标树**，我也觉得应该可以由不同的**卡片联成树**。"*
//
// ★★★ 范围经用户本轮确认（两条）：
//   ① **不改 D46 总纲** —— 目标树算「**记忆的一种组织方式**」，不另立"学习"体系；
//   ② **单项目** —— 目标树只属于当前项目（与台账同目录），**不跨项目**。
//   ⇒ 这两条把设计关进了笼子：**不造第二套存储、不做跨项目归纳**。
//
// ★★★ 核心设计取舍：**文件里是卡片，树是算出来的。**
//   · 存盘 = **一张卡一段**（`## 目标 <id>` 起），人可以直接读、直接改；
//   · 树 = 由每张卡的 `parent` 字段**现场推导**（`buildGoalTree`）。
//   ★ 为什么不存树结构：存了就必须保证"结构"与"卡片"两处一致 —— 而那正是本项目
//     反复栽的「同一个事实两个出处」（D170）。⇒ **结构是派生物，不是第二份真相。**
//   ★ 好处：你在文件里手删一张卡、改一个 `parent`，**树自动就是对的**，没有失同步的可能。

/** 目标卡片的状态（用英文键，避免中文在判据里的编码风险；渲染时再翻成中文）。 */

export const GOAL_STATUSES = ["root", "active", "paused", "done", "dropped"];

export const GOAL_STATUS_LABEL = {
  root: "根本目标",
  active: "进行中",
  paused: "搁置",
  done: "已完成",
  dropped: "已放弃",
};

/** 默认文件名（`manifest.goals` 可覆盖；**与根本原则不同，这个可以由插件创建**）。 */

export const DEFAULT_GOALS_NAME = "GOALS.md";

/**
 * ★★★★★★ 2026-10-14（D192，用户拍板）：**经验与教训**文件。
 *
 *   用户原话（逐字）：*"是不是可以加一个经验与教训文件，模型踩过的坑都可以写进去——
 *   这对我们现在有用，也对未来进入学习领域有帮助。"*
 *
 * ★★★ 它与 `GOALS.md` 里那些"教训"**不是一回事**（这是本条设计的关键区分）：
 *   | | `GOALS.md` 的 lesson | ★ 本文件 LESSONS.md |
 *   |---|---|---|
 *   | 归属 | **挂在某一张目标卡下** | **平的**，不归属任何目标 |
 *   | 回答 | "**这条路**为什么没走通" | "**这类坑**以后别再踩" |
 *   | 适用范围 | 那个目标做完就基本不动了 | **跨目标、跨会话、长期** |
 *   ⇒ 用户要的是后者：**模型自己踩过的坑**（尺子错、夹具错、守卫放错地方……）。
 *
 * ★★ 为什么它对"未来进入学习领域"有用（用户自己点出的那一层）：
 *   这份文件是**结构化、可累积、且带情境**的负样本集 ——
 *   每一条都是"**做了什么 → 出了什么错 → 正解是什么**"。
 *   那正是将来做学习/训练时最缺的那类数据（本机已有大量这类教训散在 DECISIONS 里，
 *   但它们**按决策编号组织**，不是按"坑"组织 ⇒ 不可直接用作训练集）。
 *
 * ★ 口径与 `goals` **逐字一致**（复用已验过的模式，不另造机制）：
 *   `manifest.lessons` 优先；没登记时**只认已存在的同名文件**（`guess`）；
 *   ★ **不由本工具凭空创建** —— 要建由 `ledger_init` 的 `lessons` 字段明确要（同 `goals`）。
 */

export const DEFAULT_LESSONS_NAME = "LESSONS.md";

/**
 * ★★★★★★ 2026-10-14（D194，用户拍板）：**这份文件要装两类东西 —— 经验 + 教训。**
 *
 *   用户原话（逐字）：*"经验和教训其实不应该只有教训——类似 ledger 子命令是怎么注册的
 *   这种，完全就是经验嘛，如果能固化下来，你就不用每次都探查一次了。加进工作清单里。"*
 *
 * ★★★ 这个区分是**真的**，不是命名洁癖（判据在下面，一眼能分）：
 *   | | **教训**（坑） | **经验**（机制知识） |
 *   |---|---|---|
 *   | 回答 | 「**别再这样**」 | 「**它是这样工作的**」 |
 *   | 形态 | 做了什么 → 错了 → 正解 | 是什么 → **怎么验证的（出处）** → 以后去哪改 |
 *   | 什么时候写 | **踩了坑并修好之后** | **每次花代价探查清一个机制之后** |
 *   | 拿它干什么 | 负样本（避开） | **省掉下一次探查**（复用） |
 *   | 必填 | **根因**（没根因 = 日记） | **出处**（没出处 = 道听途说） |
 *
 * ★★ 为什么"经验"必须带**出处**（这是它比教训更脆的地方）：
 *   教训记录的是"我踩过"，自带事实性；而经验记的是"系统是这样工作的" ——
 *   **一旦记错，下一个人会照它去做，而且不会去验证**（因为它"看起来很权威"）。
 *   这正是本项目那条老纪律「**记录存在 ≠ 记录准确**」最容易发作的地方。
 *   ⇒ 所以 `source`（文件:行号 / 探针路径 / 实测命令）是**必填**：
 *     写不出出处 ⇒ 说明**你还没真的查明** ⇒ 那就先别写进来。
 *
 * ★ 为什么值得把它固化成文件（而不是留在模型脑子里）：**它每次都要重新探查一遍。**
 *   本轮就是活例：为了改 `/ledger principles approve`，我把"子命令怎么注册、工具怎么注册"
 *   整条链路重新读了一遍 —— 而这些答案**下次还会一字不变地需要**。
 *   ⇒ 写一次，此后每一轮都省掉那次探查（这正是"外部记忆"这个词的字面含义）。
 */

export const LESSON_TYPES = ["经验", "教训"];

/** **教训**（坑）的类别 —— 让"坑"可检索、可统计。 */

export const LESSON_KINDS = ["尺子错", "夹具错", "守卫错", "假设错", "记录错", "其他"];

export const LESSON_KIND_LABEL = {
  尺子错: "尺子错（度量/判据本身不对）",
  夹具错: "夹具错（测试前提或数据不对）",
  守卫错: "守卫错（闸门放错地方 / 太弱 / 是假的）",
  假设错: "假设错（没验证就当成事实）",
  记录错: "记录错（写下了但写的是错的）",
  其他: "其他",
};

/**
 * ★★★★★ 2026-10-14（D194）：**经验**（机制知识）的类别。
 *
 * ★ 与教训那六类**刻意不同**：教训按"错在哪"分，经验按"**你要拿它干什么**"分 ——
 *   因为查经验的人总是带着一个动作来的（"我要改它 / 我要找它 / 它到底怎么跑"）。
 */

export const EXPERIENCE_KINDS = ["机制", "入口", "约定", "速查", "其他"];

export const EXPERIENCE_KIND_LABEL = {
  机制: "机制（它是怎么工作的：注册点 / 调用链 / 数据流）",
  入口: "入口（要改某处 ⇒ 该动哪个文件、哪个函数）",
  约定: "约定（本项目定下的口径与规矩，不是错，是「就这么办」）",
  速查: "速查（常用路径 / 命令 / 判据写法 —— 免得每次重找）",
  其他: "其他",
};

/** 某一类（经验/教训）对应的 kind 清单。 */

export const DEFAULT_JOURNAL_NAME = "JOURNAL.md";

/**
 * 解析目标树文件 ⇒ 卡片数组（**纯函数**：只吃字符串，不碰磁盘）。
 *
 * 格式（刻意极简，人可读可改）：
 * ```
 * ## 目标 <id> · <状态>
 * - parent: <父 id 或 ->（表示树根）>
 * - title: 一句话目标
 * - 关键结果: …（可选，多行）
 * - 教训: …（可选，多行 —— "哪些路走错了、以后别踩"）
 * ```
 * ★ 判据只认**结构**（`## 目标 ` 开头 + 缩进行），不认自然语言措辞 ——
 *   这样用户改字面不会把它解析坏（与 `splitBlocks` 同一套"只吃结构"的纪律）。
 */

export const GOAL_RENDER_MAX = 40;

export const NOTE_BAD_CHARS_RE = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * 生成问题记录的文件名：`YYYY-MM-DD-主题.md`。
 *
 * ★ 日期在**前**：这样目录里天然按时间排序，与既有 27 份的命名完全一致。
 *   若把主题放前面，同一件事跨几天就会散落到不同位置。
 */

export const CONFORMANCE = {
  OK: "ok",
  UPGRADEABLE: "upgradeable",
  NONCONFORMING: "nonconforming",
  NONE: "none",
};

/**
 * ★★★★★ 2026-10-19（D272，用户拍板）：**记忆协议版本号**。
 *
 * 用户原话（逐字）：*"最好就是给插件增加一个检测功能，检测当前工作区的协议是否符合
 * 更新之后的协议（也不一定是工作区，可以是项目锁定之后的子项目），如果不符合的话，
 * 模型会主动向用户提出要求，询问是否要更新当前的协议和结构，因为我在另外一台设备
 * 即使已经更新到最新阶段了，但还是没有自动的去完成这个任务，导致他现在还是比较旧的
 * 架构。……这就意味着模型不会把它当成一个任务去做。"*
 *
 * ★★★ 为什么必须有这个常量（**这是我这次真正补上的缺口**）：
 *   改造前 `conformanceOf` 只查「**清单登记过的**东西对不对」——
 *   它对「**该登记而根本没登记**」是**沉默的**：
 *     · 老项目的清单里没有 `decisionsDir` / `lessonsDir` / `goalsDir`；
 *     · 也没有 `logDir` 的分片能力（Log 一直是单个越来越长的文件）；
 *     · 但这些**全都让合规判定通过**（因为"没登记"≠"登记错了"）。
 *   ⇒ 结果正是用户观察到的：另一台设备升到最新版后，**架构一个字节都没变**，
 *     而且**模型根本不知道"还有一代新架构没落地"**（没人把这件事写给它看）。
 *
 * ★ 语义：`PROTOCOL_VERSION` 是**本插件代码**期望的项目架构代次；
 *   项目清单里的 `protocolVersion` 是**这个项目实际停留在哪一代**。
 *   两者不等 ⇒ 需要一次**结构升级**（不是数据迁移，改的是"记忆怎么组织"）。
 *
 * ★ 迁移规则（**只升不降**）：
 *   · 清单里没有 `protocolVersion` ⇒ 视为 **1**（所有旧项目都会落到这一档）。
 *   · 项目版本 < 代码版本 ⇒ 需要升级，`conformanceOf` 报 `UPGRADEABLE` 并列出缺口。
 *   · 项目版本 ≥ 代码版本 ⇒ 不动（**允许别人用更新的插件**，不前向破坏）。
 *
 * ⚠️ **升级动作必须是「加法」**：补清单字段、建空目录、**绝不改写/删除**用户已有内容。
 *   这正是 `conformanceOf` 里 `fixable` 那条既有纪律。
 */
export const PROTOCOL_VERSION = 2;

/**
 * 各代协议**要求清单里必须出现的键**（用于判定"项目停在旧代"）。
 *
 * ★ 判据：**只写"新一代新增了什么"**，不重复第一代就有的键 ——
 *   这样读的人一眼能看出"从 v1 到 v2 到底多了什么"。
 *   ★ 数组顺序 = 升级时补字段的顺序（也是 `reasons` 里的展示顺序）。
 */
export const PROTOCOL_REQUIREMENTS = [
  {
    since: 2,
    // 卡片化：这三类从"单文件"改成"一卡一文件夹"（D202/D204）。
    //   ★ 缺了它们，分类记忆就退化成 3~4 篇越来越长的单文件 —— 正是用户看到的现象。
    keys: ["decisionsDir", "lessonsDir", "goalsDir"],
    label: "记忆卡片化（决策 / 教训 / 目标树各成一卡一文件）",
    why:
      "没有这三个键 ⇒ 那三类记忆会一直堆在单个文件里越长越长，" +
      "每次写入都要整份重读、整份重写，而且压缩时只能整段折掉（D202/D204）。",
    // ★★★★ 2026-10-19（D272 第二轮）：**这一条不是机械可修的，绝对不能归进 fixable。**
    //   🔴 我第一版把它写成 fixable「补清单键 + 建对应空目录（纯加法，不动已有内容）」——
    //     那句话**听着像只做加法，实际会吃掉内容**：
    //     一旦登记了 `decisionsDir`，`cardModeOf` 立刻切到**卡片模式**，
    //     此后所有读取都去那个**空目录**里找卡 ⇒ 原来 `DECISIONS.md` 里那 269 张卡
    //     **从模型视野里消失**（文件还在磁盘上，但**没有任何一处会去读它**）。
    //     ★ 这是比"删掉"更坏的形态：**没删，但看不见了，而且不报错**。
    //   ⇒ 判据：**登记目录键的前提是"内容已经在目录里"**。
    //     真正的升级顺序是 `ledger_migrate`（按卡切分）→ 再登记键；
    //     而"怎么切"需要看懂内容 ⇒ 必须 `needsAI`，不能声称机械可修。
    mechanical: false,
  },
  {
    since: 2,
    // 日志分片：单文件 → 按大小滚动的多片（D255）。
    keys: ["logDir"],
    label: "活动日志按大小分片",
    why:
      "没有 `logDir` ⇒ 活动日志是**一个不断累积、永不分割**的文件；" +
      "查到后来单次读取就会超预算，而且越晚拆越贵（D255 实测过拆片前后的体量）。",
    // ★ 这一条才是真·机械：日志是**按周分桶、只追加**的派生物，
    //   新建一个空目录 + 登记键 ⇒ 之后的写入自然落进去，**不涉及任何已有内容的搬迁**
    //   （历史日志文件留在原地，不会因为换目录而"看不见"）。
    mechanical: true,
  },
];

/**
 * 判定一个项目清单**停留在哪一代协议**，并列出离当前代差了什么。
 *
 * @returns {{projectVersion:number, currentVersion:number, outdated:boolean,
 *            missing:Array<{since:number,keys:string[],label:string,why:string,mechanical:boolean}>}}
 *   `missing` 里每项都带 `label`/`why` —— **给用户看的话要能说清"为什么值得升"**，
 *   只报一个字段名等于让他去猜（本项目纪律：错话/废话比不说更坏）。
 *   ★ `mechanical` 决定这条缺口该归 `fixable`（机械可修）还是 `needsAI`（要看懂内容）——
 *     判错了会给出**代价不相称的建议**（详见 `PROTOCOL_REQUIREMENTS` 里那条长注释）。
 */
export function protocolGapOf(manifest) {
  const m = manifest !== null && typeof manifest === "object" ? manifest : {};
  const raw = m.protocolVersion;
  // ★ 缺省 = 1（历史项目全落这一档）；非有限数/小于 1 也按 1 处理 —— 绝不因为脏值而"判成最新"。
  const projectVersion = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  // ★★★★ 2026-10-19（D272 **第二轮修正**）：**缺口按"键在不在"判，不按版本号门控。**
  //
  //   🔴 我第一版写的是 `PROTOCOL_REQUIREMENTS.filter((r) => r.since > projectVersion)` ——
  //     意思是"只检查**比它新的那一代**新增了什么"。看着很自然，**但它把版本号当成了可信输入**。
  //     实测当场撞到（`tools/_diag-init-protocol.mjs`）：
  //       · `ledger_init` 会写 `protocolVersion: 2`（我上一轮加的）；
  //       · 可它**根本不建 `decisionsDir` / `lessonsDir` / `goalsDir`**，默认也不建 `logDir`；
  //       · ⇒ 一个**刚建出来、纯单文件**的项目，自称第 2 代；
  //       · ⇒ 版本门控 `since(2) > projectVersion(2)` 为假 ⇒ **一个缺口都不查** ⇒ 判 `ok`。
  //     这就是「**谎报成功**」的教科书形态：**自己给自己发合格证，然后拿它当免检依据**。
  //
  //   ⇒ 判据改成：**版本号只是"上一次确认过到哪一代"的记录，不作为免检凭证**。
  //     每一条要求**每次都按实际键检查** —— 键在就是有，键不在就是缺口，与它自称第几代无关。
  //     ★ 代价可接受：键检查是纯字符串比较，几十微秒；换来的是**不可能被一个数字骗过去**。
  //     ★ 这也让「前向兼容」自然成立：更新的插件建的项目必然有我们这几条要求的所有键 ⇒
  //       `missing` 为空 ⇒ 不会被误判成"要回退"。
  const missing = PROTOCOL_REQUIREMENTS.map((r) => {
    // 只报**这个项目确实没登记**的那些键（已登记的就不算缺口）。
    const lack = r.keys.filter((k) => typeof m[k] !== "string" || m[k] === "");
    return {
      since: r.since,
      keys: lack,
      label: r.label,
      why: r.why,
      // ★ 机械可修 vs 需要 AI 判断 —— 这个标记决定 `conformanceOf` 把它归 `fixable` 还是 `needsAI`。
      mechanical: r.mechanical === true,
      complete: lack.length === 0,
    };
  })
    // ★ 一个 requirement 里只要有键缺，就整条算缺口；全都有则不是缺口。
    .filter((r) => r.complete !== true)
    .map(({ complete: _c, ...rest }) => rest);
  // ★★★★★ 2026-10-20（D282 · 用户报「每个新对话都问要不要升协议」）：
  //   **"版本号写着什么"不再单独当作"落后"的证据。**
  //
  //   🔴 病（真跑 `protocolGapOf(本项目)` 坐实）：
  //     本项目 `decisionsDir` / `lessonsDir` / `goalsDir` / `logDir` **四个键全在**、`missing = 0`，
  //     而 `satisfiedProtocolVersion` 算出它就是**第 2 代**；
  //     但清单里没写 `protocolVersion` ⇒ `projectVersion` 回落到 **1** ⇒
  //     原来的 `projectVersion < PROTOCOL_VERSION` **恒真** ⇒ **outdated 永远为真**。
  //     ⇒ 每开一个新对话都走一遍：读清单 → 判 outdated → 弹「要不要升级」。
  //     ★ 而那是个**已经升级好的项目** —— 用户被问得莫名其妙（他的原话）。
  //
  //   ★ 为什么不能靠"补一个 protocolVersion 字段"就完事：
  //     那只能治**这一个项目**。字段缺失/写旧/写错的项目**永远会存在**
  //     （手工编辑、旧版本插件建的、别人拷来的清单）。
  //     ⇒ 判据必须**自己能站住**：**按实际键算出代次**，而不是相信那个数字。
  //
  //   ★ 所以正解是：**换成按事实推出来的代次**——
  //     `satisfiedProtocolVersion(m)` 逐代核键，得到"这份清单**名副其实**达到第几代"。
  //     它 < 当前代 ⇒ 真的落后；它 ≥ 当前代 ⇒ **落后个屁**（数字写没写、写多少，都不作数）。
  //   ★ 这与 D272 那条是同一条纪律的延续：
  //     「**版本号只能由事实推导，不能由愿望填写**」——
  //     那里修的是"虚报满足"（自盖章），这里修的是它**镜像**："虚报不满足"（没写数字就当你落后）。
  //   ★ `projectVersion` 仍然**原样返回**（调用方要看"清单里写的那个数"时还得有）——
  //     它只是**不再单独触发** `outdated`。
  const effectiveVersion = satisfiedProtocolVersion(m);
  return {
    projectVersion,
    // ★ 新增：按实际键算出来的代次（判据真正用的那个）；与 `projectVersion` 并列，
    //   让调用方能一眼看出"写着几代"与"实际几代"是否一致（不一致本身就是值得报的事）。
    effectiveVersion,
    currentVersion: PROTOCOL_VERSION,
    // ★ 现在是：① **实际结构**落后于当前代 ② **实际结构有缺口**（两条都以事实为准）。
    //   注意两条其实是**同一件事的两种说法**（有缺口 ⇒ 必然到不了当前代），
    //   保留 OR 是为了让回执里两条信息都在，不为了双保险。
    outdated: effectiveVersion < PROTOCOL_VERSION || missing.length > 0,
    missing,
  };
}

/**
 * ★★★★ 2026-10-19（D272 第二轮）：**这个清单"名副其实"地达到了第几代**。
 *
 * ★ 为什么需要它：`ledger_init` 原来无条件写 `protocolVersion: PROTOCOL_VERSION` ——
 *   那是**声明**，不是**事实**。它建的是单文件结构，却盖章"第 2 代" ⇒ 自己给自己发合格证。
 *   ⇒ 现在改成：**只盖章"这份清单真的满足"的那一代**（按 `PROTOCOL_REQUIREMENTS` 逐条核键）。
 *
 * ★ 语义：返回**从第 1 代起连续满足**的最高代次。
 *   ★ "连续"是关键 —— 不能跳代：第 1 代的要求若没满足，就算后面某代碰巧满足也不算数。
 *   ★ 没有任何要求时才返回 1。
 *
 * @param {object} manifest 即将写盘的清单对象
 * @returns {number} 名实相符的协议代次（≥1）
 */
export function satisfiedProtocolVersion(manifest) {
  const m = manifest !== null && typeof manifest === "object" ? manifest : {};
  // ★★★★ 2026-10-19（D272 第三轮，被我自己写的 110②c 当场抓出）：**必须逐代"全部"满足。**
  //
  //   🔴 第一版是按 `for (const r of ...) { 若不满足 break; if (r.since > v) v = r.since }`
  //     —— 看着像"逐条核"，但它把**同一代的多条要求**当成了**递进的两代**：
  //     两条要求的 `since` 都是 **2**，于是"卡片化满足"就把 v 抬到 2，
  //     第二条（`logDir`）**即使不满足也 break 在 v=2 之后** ⇒ 返回 2。
  //     实测：`{decisionsDir, lessonsDir, goalsDir}`（**没有 logDir**）⇒ 返回 **2**。
  //     ⇒ 后果：一个"卡片化了但日志还是单文件"的项目会被盖章成第 2 代 ⇒ **免检**。
  //     与第一轮那个"自盖章"是**同一个病**，只是换了个位置（这次在我自己写的判定函数里）。
  //
  //   ⇒ 正解：**先按 `since` 把要求分组成"代"**，再逐代核，**同一代必须全部满足**才算过。
  //     ★ 判据：**"逐条检查"与"逐代检查"不是一回事** —— 决定代次的是**一组**条件，
  //       不是其中任意一条。
  const byGen = new Map();
  for (const r of PROTOCOL_REQUIREMENTS) {
    if (!byGen.has(r.since)) byGen.set(r.since, []);
    byGen.get(r.since).push(r);
  }
  const gens = [...byGen.keys()].sort((a, b) => a - b);
  let v = 1;
  for (const gen of gens) {
    // ★ 这一代（gen）的所有要求都必须满足；有一条不满足 ⇒ 停在上一代，**不许跳**。
    const allOk = byGen.get(gen).every((r) =>
      r.keys.every((k) => typeof m[k] === "string" && m[k] !== "")
    );
    if (!allOk) break;
    v = Math.max(v, gen);
  }
  return v;
}

/**
 * 判一个项目的台账**是否符合本插件的计划**。
 *
 * @returns {{verdict:string, reasons:string[], fixable:string[], needsAI:string[],
 *            deFacto?:{name:string,lines:number}}}
 *   - `fixable`：**能自动修**的（只做加法：补清单字段、补空文件/空目录）
 *   - `needsAI`：**要 AI 判断**的（超阈值要挑条目归档、结构要重新设计）
 */

export const SETTINGS_PREFIX = `/${name}-settings`;

/** 发一个 JSON 响应。响应头与那个插件同款（`no-store` + `nosniff`）。 */

export const LOG_ENTRY_RE = /^-\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(?:\(([^)]*)\)\s*)?(.*)$/;

/** 把一条日志原文解析成结构化条目。认不出就只给 raw。 */

export const settingsBaselines = new Map();

/**
 * ★★★★★★ 2026-10-15（D211）：**变更基线必须按"对话"存，不能按"项目"存。**
 *
 * ★ 病（探针 `tools/_probe-d211-broadcast.mjs` 真跑出来的，不是推理）：
 *   D210 我把基线写成**按 `projectRoot` 共享**。而**一个进程里所有对话共用同一个插件实例**
 *   ⇒ 同一个项目的**第二个对话永远看不到「设置刚改过」** —— 第一个渲染的对话把它**消费**掉了。
 *   探针实测：会话 A 看到「刚改过」= true，**会话 B = false**（它只看到新值）。
 *   ★★ 而用户要的恰恰是「**真正保证那个对话读到我们的改动**」⇒ 这条缺陷正打在他的需求上。
 * ★ 根因：**一个"一次性提醒"被两个消费者共享了**（本项目第 13 条纪律的又一次复发：
 *   「并发/多消费者会打穿"假设只有一个在跑"的所有单槽状态」）。
 *
 * ★ 修法：**基线键 = 项目根 + 对话 id** ⇒ 每个对话各自独立地"看过一次就安静"。
 *   · 值没变 ⇒ 各自都不报（零噪声不变）；
 *   · 值变了 ⇒ **每个对话各报一次**（这正是"每个对话都读到"）；
 *   · 首轮不标（各自的第一轮是"初识"）。
 */

/**
 * ★★★★★★ 2026-10-15（D211）：**"强制推送"计数器** —— 面板那颗按钮就改它。
 *
 * ★ 用户原话（逐字）：*"其实还应该在设置面板中加一个按钮，这个按钮允许主动向每个对话的
 *   新的回复中注入这个设置，这样的话我可以真正保证那个对话读到我们的改动，而不会被忽略。"*
 *
 * ★ 它怎么起作用：它进了 `fingerprintOf`（去重判据）⇒ 每按一次，**所有对话的指纹都变** ⇒
 *   下一次 `pre-step` **必然重注**那份设置快照（不必等文件变化、不必重启、不必开新对话）。
 * ★ 为什么不做成"渲染一次就消费掉的一行提示"：那正是 D210 踩过的**L37「渲染 ≠ 送达」**
 *   —— 提醒会被"渲染过但没送出去"吃掉。⇒ 这里只用它**驱动指纹**，
 *   而"送达"由注入收口处那一行判（见 `commitSettingsBaseline` 的调用点）。
 */

export let settingsBroadcastSeq = 0;

/** 面板按一次「推送到所有对话」就 +1（返回新值，便于回报给用户）。 */

export function bumpSettingsBroadcast() {
  settingsBroadcastSeq += 1;
  return settingsBroadcastSeq;
}

/** 当前广播序号（只读；进指纹用）。 */

export const SETTINGS_SNAPSHOT_MARK = "**⚙️ 当前设置**";

/** 把"当前设置"摊成 `key → 值`（**全部** spec 里认得的项 —— 这是覆盖面②的兑现）。 */

export const blockInjectFallback = new Map();

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

export const blockSnapshots = new Map();

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

export const ROOT_PARAM = {
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

export const OK_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["ok"],
  additionalProperties: true,
};

export const FLUSH_BLOCK_GIVEUP = 3;

/**
 * ★★ 走到这个水位，闸门**不再拦**（用户 2026-10-09："到水位的时候主动按压缩不能进行，
 *   比较危险"）。理由是个**方向性**的问题：
 *   内核在 0.8 会自己压一次，而那一次**我们抓不到逐字胶囊**。所以我们拦下自己的
 *   （安全、有胶囊的）压缩，等于把机会**让给**内核那次不安全的压缩 —— 方向反了。
 *   ⇒ 水位进到这一档，宁愿承认"这一轮还没落盘"也要先压，并在返回值里如实标注。
 */

export const FLUSH_GATE_BYPASS_RATIO = 0.75;

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

export const TRIAGE_OWED_MAX_AGE_MS = 20 * 60 * 1000;

/**
 * ★★★★★ 2026-10-13（D179，用户拍板）：**收尾维护硬门是否生效** —— 唯一出口。
 *
 * 用户原话（逐字）：*"强制维护，我认为必须是个硬门。模型不做完。压缩就不会生效。
 * 同时也要注入非常强烈的信息，让模型主动去干。也就是两个都要。"*
 *
 * ★ 语义：**模型不落盘 + 不分流 ⇒ 压缩不发生**（不再有"拦够 3 次就放行"
 *   或"超时 20 分钟就放行"）。关掉即退回旧行为（那两道兜底恢复）。
 *
 * ★★ 与 D59 的关系（**必须说清，否则后人会以为是回退**）：
 *   D59 的教训是"闸门拦了近 4 小时、零次压缩"。★ 但那次的故事**不是"闸门有牙"**，
 *   而是**闸门从未开口告诉模型该做什么**（它静默地拦）。本轮用户要求的是**两件一起做**：
 *     ① **注入非常强烈的信息**（见 `renderPressureNotice` 与合同块）—— 让模型知道要干什么；
 *     ② **硬门**（这里）—— 让它知道"不做就真的没有压缩"。
 *   ⇒ ★ **只做 ① 不做 ② = 建议**；**只做 ② 不做 ① = 复现 D59**。**必须成对。**
 *
 * ★ 仍然保留的两条旁路（**刻意保留，不是遗漏**）：
 *   · `opts.manual === true`（人按的 `/ledger compact`）—— 那是**用户的授权**，
 *     不是"模型没做完"。硬门约束的是**模型的工作流**，不该把人的明确授权挡回去。
 *   · "这个项目没有台账" —— 没有台账就没有"落盘"这件事，拦它等于让压缩永不发生。
 */

export const FULL_COMPACT_URGENT_RATIO = 0.78;

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

export const DELTA_YIELD_MAX_AGE_MS = 15 * 60 * 1000;


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

export const MANUAL_COMPACT_SOURCES = new Set(["command"]);

/**
 * @param {object} [opts] 旁路判据
 * @param {boolean} [opts.manual] 是否人手动发起（见 `MANUAL_COMPACT_SOURCES`）
 * @param {number} [opts.ratio] 当前水位（0~1），用于 `FLUSH_GATE_BYPASS_RATIO` 那条旁路
 * @param {"delta"|"full"} [opts.mode] 这一趟是**增量**还是**全量**（见 `opts.ratio` 旁路的 D119 改动）
 */

export const CHECKPOINT_OPTIONS = [
  { label: "不记录台账", description: "本轮不写台账，继续下一步。" },
  { label: "只记录台账", description: "把本轮进展写进活跃台账。" },
  { label: "记录台账 + 执行压缩", description: "先写台账，随后自动压缩上下文。" },
  { label: "记录台账 + 写交接单", description: "写台账，并额外产出一份交接文档。" },
];

/** 选项标签 → 内部动作。标签是给用户看的，这里只做一次翻译。 */

export const FIRST_TURN_OPTIONS = [
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

export const CONFORM_OPTIONS = [
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

export const AUTO_OFFER_STALE_MS = 30 * 60 * 1000;

/**
 * 这条 steer 消息是插件发的，**不是用户打的字**。
 *
 * ★ 前缀不只是给人看的：官方 `hasDirectHumanInput` 的注释写明
 *   "An omitted `Agent.followup()` / `steer()` source resolves to `user`, so non-human
 *   producers must supply their own source rather than inheriting this authority."
 *   ⇒ 必须显式给 `source`（我们用自己的 INJECT_KIND），否则这条消息会被当成
 *   用户本人的授权，去影响那些"只在有人类输入时才成立"的判断。
 */

export const TURN_END_PREFIX = "[项目台账·回合末选择] ";

/**
 * ★★★★★ 2026-10-17（D241）：**回合末抽起**那条消息的前缀。
 *
 * ★ 为什么必须单独一个前缀（不能复用 `TURN_END_PREFIX`）：
 *   那个是"用户在卡片上选了某项"的回执（人真的点了东西）；
 *   这个是**插件自己发现义务没做** ⇒ 两者的来源与语义完全不同，
 *   混用一个前缀会让以后回溯"这句到底是谁说的"变成猜谜。
 * ★ 与 `TURN_END_PREFIX` 同一条硬规矩：带方括号、一眼可辨认、且**绝不用 `user` 作 source.kind**
 *   （见 `pullTurnEndObligation` 里那段关于 `dsh-tool-jobs:233` 的注释）。
 */

export const TURN_END_PULL_PREFIX = "[项目台账·回合末实检] ";

/** 这个 agent 是不是活着的 root（子 agent 的回合末不该弹卡片）。 */

export const TRIAGE_KEEP_MAX = 12;

/**
 * ★★★★★ 2026-10-13（D158）：**累积**的 keep 上限（跨多次分流的总量）。
 *
 * ★ 为什么要第二个上限：`TRIAGE_KEEP_MAX`（12）限的是**单次**分流；
 *   而 D158 之后 keep 桶会**跨多次分流累积**到下一次压缩 ⇒ 需要一条**总量**天花板，
 *   否则"每回合分一点"会把上下文重新撑回去（等于没压）。
 * ★ 为什么取 40：单次 12、典型 2~3 次分流就到这里；超了丢**最旧的**（新近判断更可能有效），
 *   并**如实报出丢了几条**（沉默丢弃 = 下一个 D89）。
 */

export const TRIAGE_KEEP_TOTAL_MAX = 40;

export const LOG_L1_FIELD_CHARS = 240;

export const LOG_L1_LINE_CHARS = 1200;

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

export const LEDGER_SUBCOMMANDS = [
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
    label: "压缩上一个回复（手动）",
    description:
      "把**上一个回复（最近那个已结束的回合）**折起来：水位小幅回落，新近细节完整保留。" +
      "★ 它是**手动**动作 —— 因为每次回复结束都会写台账与分流，所以「该折哪一段」已由你按键决定。" +
      "⚠️ 它是**最浅的一种折**（只折一个回合）—— 实测浅折最容易在下次压缩时被**再折一遍**（D185）。",
  },
  { sub: "log", label: "看活动日志状态", description: "五档粒度开没开、有多少文件。不注入上下文。" },
  {
    sub: "principles",
    label: "根本原则条例（**只有你能改**）",
    description:
      "改**根本原则条例**（`PRINCIPLES.md`）—— 模型**无权**改它，只能向你提议。" +
      "★ 用法：敲 `/ledger principles` 后**接着输入你要加/删的内容**（回车发出）；" +
      "不带内容则只**把当前原则全文打给你看**。★ 每一次改动都会记进活动日志的审计。" +
      "★ 子动作：`pending` 看待批准提议 · `approve [id或#序号]` 批准（不带则取最近一条）· " +
      "`deny [id或#序号]` 否决丢弃。",
  },
  {
    sub: "mode",
    label: "看压缩方式（现在只有一种）",
    description:
      "看本项目的压缩方式。★ **两种方式已合并**：现在统一是「分流后压缩」——" +
      "压缩前由 AI 分流（留上下文 / 落进项目 `_stash/` / 丢掉），留在上下文的那份压缩后逐字注回。" +
      "★ 这一项**只为兼容旧项目清单而保留**，选什么都没区别；不带参数则只报当前值。",
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

export const LEDGER_PICK_TIMEOUT_MS = 120_000;

/** `/ledger` 的帮助文本（`/ledger help` 直接打印，卡片超时也回退到它）。 */

export let latestStateForTest;

/** 每个会话的进程内状态。★ 只在内存（红线：不碰 $DSH_HOME 的 sessions/storages）。 */

export function newState() {
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
     * ★★★★★ 2026-10-18（D244，用户拍板「我们自己全程接管」）：**回合内压缩**的进行中状态。
     *
     * 用户原话（逐字）：*"如果遇到一个非常长的工作，则工作到准备接近压缩线的时候，
     * 强制进行这些义务，然后进行一次强制的全量压缩，压缩完之后模型接着工作，
     * 整个过程不需要任何操作。"*
     *
     * ★ 为什么需要它（这是本功能唯一的失控风险）：
     *   "先做义务 → 再压 → 继续"是**两拍**（`steer` 让本回合再跑一步），
     *   而那一步做完又回到 `pre-step` ⇒ **不加状态就会反复抽起、反复压缩**，
     *   把一个长回合变成"抽起-压缩"的死循环。
     * ⇒ 每个 session 一条：`{ phase, ratio, at }`，`phase` ∈
     *   `"owed"`（已抽起等义务）/ `"pressing"`（正在压，防重入）/ `"done"`（本回合已压过，等水位掉回去才清）。
     *
     * ★★ 与 `hfCompactAfterTurn` 的**分工**（别混用）：
     *   · `hfCompactAfterTurn` = **等 idle** 的那条路（`compactNow`，要求回合关）；
     *   · 本项 = **回合内**那条路（`compactRegion`，要求回合开）。
     *   后者是 D244 新增的，专门治"长长的一个回合永远等不到 idle"。
     */
    turnCompact: new Map(),
    /**
     * ★★★★★ 2026-10-18（D248，真机撞出来的）：sid → **最近一次压缩失败的告知**。
     *
     * ★ 病（本机实测）：00:43:50 那次压缩 `compaction/end` 带
     *   `error: "502: workbuddy 上游失败…transport error: fetch failed"` ⇒ **失败了**，
     *   水位**一点没降**，而**模型与用户都收不到任何提示** ⇒ 水位一路涨到 **78.5%**，
     *   离内核 80% 只剩 1.5 点 ⇒ 差点撞进「抓不到胶囊」那一次。
     *   ★ 我是**翻官方会话日志**才发现它失败过 —— 这就是静默失败的代价：
     *     **用户以为开关在起作用，其实一次都没成功。**
     *
     * ★ 与 D167「失败的不冒充成功」**方向相反但互补**：
     *   D167 治「**谎报**成功」（宁可不报，不许报反）；D248 治「**完全不报**」（失败必须说）。
     *   ⇒ 合起来才完整：**成功报成功，失败报失败，绝不沉默。**
     *
     * ★ 结构：`{ at, error, told }` —— `told` 保证同一份失败只注入一次（不每步刷屏）。
     */
    compactFailures: new Map(),
    /**
     * ★★★★★ 2026-10-15（D215）：sid → **紧接这一次压缩是不是我们发起的**。
     *
     * ★ 为什么需要它（91⑥b 当场抓出来的真 bug）：
     *   压缩后重注的文案原来用 `ours: snap !== undefined` 判"谁压的"——
     *   在本修复之前这两件事**恰好等价**（只有我们那条路抓压缩前快照）。
     *   而 D215 让**官方那次也有快照**之后，那个判据当场失真：
     *   官方压的，注入却写「**本插件**主动执行了一次压缩」⇒ **谎报"谁做的"**。
     *   ★ 与 D167 同族：**状态判错时，宁可不报，也不许报反。**
     *
     * ★ 语义：在 `compaction/start` 那一刻写一次（队里有没有我们的票），
     *   重注时读一次并**消费掉**（它只描述"紧接着那一次压缩"，与 `hfSource` 同一口径）。
     */
    compactionOurs: new Map(),
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
     * ★★★★★ 2026-10-13（D180）：sid → **待用户授权的根本原则提议**（有界 8 条）。
     *   ★ 它是"临时态"，不是记忆：批了就消费掉、过期（10 分钟）也清掉。
     *   ★ 模型只能往里放（`ledger_propose_principle`），**只有用户批准才落盘**。
     */
    principleProposals: new Map(),
    /**
     * ★★★★★ 2026-10-14（D191，用户拍板）：sid → **原则的授权窗口**。
     *   `{ at, authorizedBy, reason }` —— 由**用户在卡片上点"授权"**产生（见 `PRINCIPLE_GRANT_TOOL`）。
     *
     * ★ 为什么它比"传一个 `authorizedBy` 字符串"更硬：**模型写不进这个 Map**。
     *   它只能由 `userQuestions` 的回执产生 ⇒ 这是**结构性**的授权判据。
     * ★ 有期限（10 分钟）+ **一次一授权**（写成功即消费）—— 不留常开的门。
     */
    principleGrants: new Map(),
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
    /**
     * ★★★★★ 2026-10-17（D241）：sid → `{turn, n}` —— **本回合已经抽过几次**。
     *
     * ★ 为什么需要（这是本功能唯一的失控风险）：`agent/turn-stopping` 会在**每一步**
     *   结束时都跑一遍（`dsh-agent-loop:1001`，它在 while 循环里）。steer 让回合不 close，
     *   模型跑完一步又回到这里 ⇒ 不加预算就是**无限自唤醒**。
     *   ⇒ 按 `turn` 号记账：换了回合号就重来，同一回合最多 `turnEndPull` 次。
     *
     * ★★ 这个形态是**照抄官方**的：`dsh-tool-jobs:284-296` 的 `maxConsecutiveWakes`
     *   就是"连续自唤醒有预算，花光降级成 inject()" —— 同一个问题人家已经解过一遍。
     *   ★ 而且它的预算**只在用户真说话时重置**（`message.source.kind === "user"`），
     *   所以我们 steer 出去的 source.kind **绝不能写成 `user`**（见 `TURN_END_PREFIX` 那条）。
     */
    turnEndPullSpent: new Map(),
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

export function fingerprintOf(info) {
  // ★★★★★★ 2026-10-15（D210，本探针证明出来的真缺陷）：
  //   **指纹必须覆盖"我们真正注入的全部内容"，不只是台账正文。**
  //
  //   ★ 病（`tools/_probe-d210-delivery-gap.mjs` 真机路径实测，不是推理）：
  //     在同一个会话里，第一步注入过之后，**只改设置、一字不动台账** ⇒
  //     旧指纹（只哈希台账字节）**完全相同** ⇒ `skip === true` ⇒
  //     **第二步 n=0，一个字都不注入** ⇒ 快照里那个新值**永远送不出去**。
  //   ★★ 我原先在 D210 设计里写的「值变了 ⇒ 文本变了 ⇒ 指纹变了 ⇒ 必然注出去」
  //     **是假的** —— 那句话把"**渲染出来的文本**"与"**参与去重的指纹**"
  //     当成了同一个东西。这正是本项目第 26 次「尺子错」候选：
  //     **判据的输入必须是被测对象自己产生的那部分**（纪律 2）。
  //
  //   ★ 修法：把**设置**一并纳入指纹。
  //     · ★★★ 覆盖的必须是**全部 38 项**，不能只拿"快照那 8 行"（`settingsSnapshotLines`）：
  //       我第一版就是拿那 8 行算的，**自检 89⑬⑥ 当场红** —— 因为"不在快照里的那 30 项"
  //       改了之后，指纹**看不出变化** ⇒ 变更行渲染得再对也**送不出去**
  //       ⇒ 用户病根的**另一半**（"不在快照里的改了没人知道"）根本没被修上。
  //       这正是本条要兑现的那句承诺：**覆盖面**。
  //     · 取 `settingsValuesOf`（`key → 值`，走 `SETTING_KEYS` 全集）而不是渲染文本 ——
  //       它与"哪几项被印在快照里"**解耦**：将来往快照里加行/删行，
  //       指纹的覆盖面**不受影响**（判据不吃"展示形态"）。
  //     · ★ 它**不含**变更基线，所以不会"变更行自己把自己顶成新指纹"（自激）。
  const settingsTag = hashTextOf(JSON.stringify(settingsValuesOf(info)));
  // ★★★★★★ 2026-10-15（D211，用户拍板）：**面板那颗「推送到所有对话」的按钮就改这个序号。**
  //   ★ 为什么必须进指纹（而不是渲染一行提示）：去重判据就是指纹 ——
  //     序号一变 ⇒ 指纹变 ⇒ 下一次 pre-step **必然重注**那份设置快照。
  //     ⇒ 这才是"**主动向每个对话注入**"的实现方式：**推**，不是等它来查（D46 铁律）。
  //   ★★ 为什么不做成"渲染一行然后消费掉"：那正是 D210 踩过的 **L37「渲染 ≠ 送达」**
  //     —— 提醒会被"渲染过但没送出去"吃掉。序号留在指纹里 ⇒ **不送达就一直是新的**。
  const broadcastTag = `b${settingsBroadcastSeqOf()}`;
  if (!info.activeExists || info.activeAbs === undefined) return `absent|${settingsTag}`;
  let text;
  try {
    text = fs.readFileSync(info.activeAbs, "utf8");
  } catch {
    // ★ 读不到 ⇒ **返回一个每次都不等的值**（`unreadable|单调递增`）：
    //   宁可多注一次，也不能因为读盘失败就误判成"没变"而**不注**（那才是伤准确性）。
    //   ⚠️ 我第一版写的是 `Date.now()` —— 而**同一毫秒内连续两次调用会得到同一个值**
    //     ⇒ 那正是"误判没变"⇒ 漏注（伤准确性）。自检 54③ 当场抓到 ⇒ 改成单调递增计数。
    unreadableSeq += 1;
    return `${info.activeRel}|unreadable|${unreadableSeq}|${settingsTag}|${broadcastTag}`;
  }
  const h = hashTextOf(text);
  return `${info.activeRel}|${info.activeLines}|${h.toString(16)}|${settingsTag}|${broadcastTag}`;
}

/**
 * FNV-1a 32 位（够用且零依赖：不必引 `crypto`，也不引外部包）。
 * ★ 抽出来是因为 D210 之后**两处**都要算哈希（台账正文 / 设置快照正文）——
 *   各写一份就是"同一个事实两个出口"，改一处必忘另一处（D25/D170）。
 */

export let unreadableSeq = 0;