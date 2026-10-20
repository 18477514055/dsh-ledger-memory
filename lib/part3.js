import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AUTO_OFFER_STALE_MS, CHECKPOINT_OPTIONS, CHECKPOINT_TOOL, CONFORMANCE, CONFORM_OPTIONS, FIRST_TURN_OPTIONS, FLUSH_BLOCK_GIVEUP, FLUSH_GATE_BYPASS_RATIO, FULL_COMPACT_URGENT_RATIO, INJECT_KIND, KERNEL_HARD_COMPACT_RATIO, L0_KINDS, L3_EXCLUDE, LOG_BRIEF_CHARS, LOG_FLUSH_DEBOUNCE_MS, MANIFEST_REL, MAX_READ_CHARS, MODES, MODE_SURGICAL, OK_SCHEMA, PRECEDENCE_KEYS, PRESSURE_STOP_RATIO, PRINCIPLE_GRANT_TOOL, ROOT_PARAM, SETTINGS_SNAPSHOT_MARK, SETTING_KEYS, TRIAGE_KEEP_MAX, TRIAGE_OWED_MAX_AGE_MS, TURN_END_PREFIX, TURN_END_PULL_PREFIX, WEIGHT_MUST_INJECT, blockInjectFallback, blockSnapshots, name, settingsBaselines, settingsBroadcastSeq } from "./defs.js";
import { compactionReachVia, compactionServiceFor, currentSettings, diffBlocks, manifestRevision, modeManifestSuspect, modeOf, numOf, precedenceFromManifest, precedenceIsProject, precedenceValue, renderProtocolBlock, renderProtocolUpgradeNotice, renderToc, renderUnenabledCapabilities, specOf, splitBlocks, tagOfId, triageRequired, weightBlocks } from "./part1.js";
import { briefOf, buildGoalTree, conformanceOf, ensureDir, fail, fileOpsOf, git, gitAdd, gitAvailable, inspect, isErrorResult, isFreshProject, isUnder, levelOn, logDirOf, logFileRel, parseGoalCards, projectRootOf, readManifest, readTextSafe, renderAfterCompaction, renderCapsule, renderGoalTree, renderUserMessageLine, stamp, stampSec, textOut, userMessageOf } from "./part2.js";
import { logicalLogName } from "./defs.js";
import { kindLocationOf, logFileList, readKindRaw } from "./part4.js";
import { compactCountsOf } from "./part5.js";
// ★★★★★ D234：文件锚定（六维相对秩）；★ 与 part3 无循环依赖 —— part6 只 import defs/part1。
import { FILE_ANCHOR_TOP, anchorFiles, renderFileAnchor, renderSurfaceMap, scanMemorySurface } from "./part6.js";
export function renderInjection(info, pending, afterCompaction, shadowedIndex, biOpts) {
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
  // ★★★★★ 2026-10-13（D181）：常规注入也要推行**目标树**（D46 铁律：推，不是等它来查）。
  //   ★ 只读盘 + 解析 + 渲染，**不写**；解析失败静默跳过（绝不挡住台账注入）。
  //   ★ 为什么放在索引块之前：目标树是"我们现在在为什么而努力"，比"哪段原文去哪拿"更上位。
  let goalsBlock = "";
  try {
    // ★★★★★ 2026-10-14（D203）：走 `readKindRaw` —— **卡片模式下念目录拼卡**，
    //   单文件模式老实读那个文件。★ 若这里仍读旧文件，迁移后注入的就是**冻结的快照**。
    const gread = readKindRaw(info.projectRoot, info, "goals");
    if (gread.mode !== "none" && gread.raw.trim() !== "") {
      const gt = buildGoalTree(parseGoalCards(gread.raw));
      goalsBlock = renderGoalTree(gt);
    }
  } catch {
    /* 目标树渲染失败绝不影响台账注入 */
  }
  return renderInjectionBody(info, pending, biOpts) + goalsBlock + idxBlock;
}

/** 所有注入共用的题头：声明这些事实属于哪个工作目录、且不覆盖更上位的指令。 */

export function headOf(info) {
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

export function renderCompactInjection(info, shadowedIndex) {
  return (
    headOf(info) +
    "★ 本轮台账的变化**是你自己刚写下的**（正文已略去 —— 内容就在你刚才那次 `ledger_write` 的" +
    "工具调用里，不必重复占上下文）。要复核请用 `ledger_read`。\n" +
    (shadowedIndex === undefined ? "" : shadowedIndex) +
    // ★★★★★★ 2026-10-14（D208）：**压缩后那份短注入也必须带设置快照**。
    //   ★ 为什么：用户要的是"**每回合**都实时知道当前设置"。而**刚压完的那一回合**
    //     恰恰是最需要它的时刻（上下文被折过一次，模型对"现在是什么状态"最没底）。
    //   ⇒ 与 `renderInjectionBody` 的 tail 用**同一个渲染器**（不各写一份）。
    renderSettingsSnapshot(info)
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

export function renderPressureNotice(info, pressure, tier) {
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
    // ★★★★★ 2026-10-13（D174）：**这一档的文案按架构分支**（承接 D173）。
    //
    //   ★★★ 原来的病：这一档逐字写着「**请你自己调一次压缩** —— `ledger_compact`（`mode:"light"`）…
    //     它在**回合内**执行…**第三步才是真正腾出空间的那一步**」——
    //     那是 **D129**（轻量为主）的架构。用户 **D155** 已改成"**全量为主力、不在回复中直接压缩**"
    //     ⇒ 这段文案**每天都在把模型往你已冻结的那条路上带**（D173 §二）。
    //
    //   ★ 保留 D129 那条正确结论：**不再自称"义务"**（闸门不因水位拦压缩 ⇒ 写"你不做就不发生"是假话）。
    //     去掉的只是**"请你调 light"** 这个错误动作。
    //
    //   ★ 分支 A（增量开着）保留原文案 —— 那是它自己的架构，打开开关就必须同时收到它。
    //     分支 B（默认）改成："你只需落盘 + 分流；压缩由插件在回合末做"。
    if (currentSettings().incrementalCompact !== true) {
      // ★★★★★ 2026-10-17（D240，用户拍板）：**70% 这一档的语义反转**。
      //
      //   用户原话（逐字）：*"直接在 70% 的水位提醒里面加一句额外的提醒，让模型主动停止工作就好了。"*
      //
      //   ★★★ 与 **D129（2026-10-09）** 是一处**明确反转**，必须记清楚，别让后人以为是笔误：
      //     · D129 原话：*"AI 执行完我们插件的功能之后，要继续工作，工作是不能被影响的"*
      //       ⇒ 当时的文案逐字写着「**做完就继续手上的工作，不要停**」。
      //     · 现在的理由变了：D236 那次事故证明 **不压就会撞死**（20:12 已 72.3%，拖到 22:46 变 135 万）。
      //       ⇒ 用户改口：**这一档要"停一下"**。
      //   ★ 但**只改语义、不设拦截**（软停）：D129 删掉"水位档立义务"是因为它会**卡死**
      //     （D59 前科：拦了近 4 小时、零次压缩）。⇒ 这里说"先做完再继续"，
      //     而真正的强制执行点仍然只有一处：`flushedAt > lastCompactCycleAt`（压缩闸门）。
      return (
        head +
        "### ★ 到 " + line + "% 了：**先停下，把这一段固化，再继续**\n\n" +
        "到这里，请**主动暂停手上的工作**，先把**这一段的进展固化下来**。\n" +
        "★★ **这是义务，不是建议** —— 插件不会强行拦你，但**这就是命令**。\n" +
        "★ 至于**怎么分、留什么**，仍由你判断（插件不替你决定内容）。\n\n" +
        (surgical
          ? "**标准动作是两步**：\n"
          : "**动作是一步**：\n") +
        "1. 把本轮进展写进活跃台账（`ledger_write`，带 `ifRevision` 与你的会话编号）；\n" +
        (info.logRel !== undefined
          ? "2. 写一条活动日志 L1 摘要（`ledger_log_write`，title 必填）；\n"
          : "") +
        (surgical ? triageStep : "") +
        "★★ **做完这两步，再继续手上的工作。**\n\n" +
        // ★★★ 与旧版**反向**的一句：明确告诉它「**不要**去调压缩工具」。
        //   理由：老的 D129 文案正是在这里叫它调 `light` ⇒ 用户已冻结那条路（D155）。
        "★★ **压缩不需要你动手**：水位一旦越过全量线，插件会在**本回合结束之后**\n" +
        "做一次**高保真全量压缩**（先抓逐字胶囊、压完连台账一起重注）。\n" +
        "**不要**为了腾地方而在回复中途调 `ledger_compact`（轻量那条已冻结，不是常规动作）。\n\n" +
        "★ **为什么现在要求你停下来（与 2026-10-09 那句相反，是**有据可依**的反转）**：\n" +
        "**压缩本身就是一次完整的模型调用** —— 它的输入 = 现有历史 + 压缩指令。\n" +
        "⇒ 一旦上下文**超过模型窗口**，压缩请求**自己也会超窗** ⇒ **压不动、也救不回来**（实测：135 万 > 104 万）。\n" +
        "⇒ 所以真正该做的是「**在还压得动的时候把它压掉**」，而不是「等撞墙再说」。\n\n" +
        "★ **为什么仍然要落盘**：压缩会把旧历史换成摘要 ⇒ **没落盘的那段进展就是唯一副本**；\n" +
        "而**没分流** ⇒ 压缩不知道该保住哪些（`keep` 桶会被**逐字注回**）。\n\n" +
        "★ 压缩对你**基本无感**：旧历史会被换成摘要，同时插件会把你这一段用过的" +
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
      "★★ **这一步做完再继续手上的工作**（先停下把上面三步做完，别边走边写）。" +
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
    //   —— 因为所有通道都只提醒它"该压缩了"这个**概念**。
    //
    // ★★★★★ 2026-10-13（D174）：**但"给出的那个动作"必须与当前架构一致**。
    //   旧文案在这里给的动作是"**调 `ledger_compact`（`mode:"light"`）**"——
    //   那是 D129（轻量为主）的动作；用户 D155 已冻结那条路 ⇒ 在默认架构下
    //   **这个"动作"本身是错的**（D173 §二：每天都在把模型往冻结的路上带）。
    //   ⇒ 分两支：增量开着 ⇒ 语义不变（给 light 动作，D125 的诉求照旧满足）；
    //            增量关着 ⇒ 给**正确**的动作（落盘 + 分流），并**明说压缩不用你动手**。
    (currentSettings().incrementalCompact === true
      ? "★ 若这一段你已经用完（探索做完 / 大段输出已消费 / 结论已写进台账），" +
        "**可以顺手调一次** `ledger_compact`（`mode:\"light\"`）把它折起来：" +
        "它在**回合内**执行、**不影响你手头的工作**；压掉的内容留了逐字副本，" +
        "以后能用 `ledger_recall` 读回来。★ **不必等水位，也不必等回合结束。**\n" +
        (surgical
          ? "★ 压缩前的标准动作是三步（顺序不能换）：`ledger_write` → " +
            "`ledger_triage`（分流：留 / 落 / 丢）→ `ledger_compact`。\n"
          : "")
      : "★ 你**不需要**在这里动手压缩：压缩由插件在**回合末**自动完成" +
        "（水位越过全量线时做一次高保真全量压缩）。**把这一轮做完就好。**\n" +
        (surgical
          ? "★ 你要做的是**两件**（顺序不能换）：`ledger_write`（落盘）→ " +
            "`ledger_triage`（分流：留 / 落 / 丢）—— 它是压缩的前置条件。\n"
          : "★ 你要做的是**一件**：`ledger_write`（落盘）—— 它是压缩的前置条件。\n")) +
    "★ 任何时候你**自己觉得有必要**（做完一个阶段、要换方向、改动很大），" +
    `都可以随时调用 \`${CHECKPOINT_TOOL}\` —— 不必等水位。\n\n` +
    "（本条每个会话每个水位只发一次；压缩之后水位会掉回去，届时会重新武装。）"
  );
}

/** 组装注入正文。`pending` 有值 ⇒ 是 /ledger 命令的兑现指令。 */
/**
 * ★★★★★★ 2026-10-14（D210，用户拍板）：**设置变更感知** —— "改了要能被注意到"。
 *
 * ★★★ 用户的病（他原话，逐字）：
 *   *"我的意思是，模型每回合获得的设置清单能否不影响工作还有足够的提醒效果，
 *     否则有些标准改了之后永远不会生效"*
 *
 * ★★ 为什么 D208 的快照**不够**（两个缺口，都是真的）：
 *   ① **只是陈述事实**：值改了，模型看到的是**同样形状的一段文字** ⇒
 *      **没有"这跟上次不一样"的信号** ⇒ 改了也未必注意；
 *   ② **只覆盖 8 项**：而设置有 **38 项** ⇒ 不在快照里的那些（如 `capsuleMaxChars`、
 *      `logLevels`）**改了完全没人知道**。
 *   ⇒ 判据：**"知道现在的值" ≠ "知道它刚变过"** ——
 *     这与 D198「**看得见内容 ≠ 看得出它该更新了**」是同型（第三次）。
 *
 * ★★★ 两条硬要求（用户明确提的"不影响工作"）：
 *   ① **平时零噪声**：值没变 ⇒ 快照与今天**逐字一致**（一个字节都不多）；
 *   ② **只对"真变过"那几项顶一行**：`★ 设置刚改过：<项> <旧> → <新>`。
 *   ★★ **变更检测必须覆盖全部设置项**（不只快照那 8 项）—— 否则缺口②还在。
 *
 * ★★★ 为什么"渲染即推进"在这里**不会漏**（这一条是它敢这么写的前提）：
 *   注入去重是**按内容指纹**做的（D132）—— **值变了 ⇒ 文本变了 ⇒ 指纹变了 ⇒ 必然注出去**。
 *   ⇒ 所以"渲染一次"就等于"送达一次"，不必另设"确认送达"的信号。
 * ★ 基线按**项目根**存（模块级 Map）：不同项目的设置互不干扰。
 * ★ **首轮不标**（没有基线 ⇒ 那是"初识"而不是"变更"）。
 */

export function settingsBroadcastSeqOf() {
  return settingsBroadcastSeq;
}

/**
 * ★★★ 设置快照的**题头**（唯一真源）。
 *
 * ★ 为什么要抽成常量（D210）：它现在有**两个**消费者 ——
 *   ① 渲染它的那个函数；② 注入收口处判"**这次送出去的文本里到底有没有它**"
 *      （只有真送出去才推进变更基线）。
 * ★★ 若两处各写一份字面串，改一处忘另一处 ⇒ 收口处会**永远判否** ⇒
 *   变更提醒**永远不推进基线、每次都重报**（或永远不报）——
 *   那正是"一个事实两个出处"（D25/D170）的老病。
 */

export function settingsValuesOf(info) {
  const s = currentSettings();
  const man = info?.manifest ?? {};
  const out = {};
  for (const key of SETTING_KEYS) {
    const hasMan = Object.prototype.hasOwnProperty.call(man, key) && man[key] !== undefined && man[key] !== null;
    const v = hasMan ? man[key] : s[key];
    out[key] = v === undefined ? "(未设)" : JSON.stringify(v);
  }
  return out;
}

/**
 * 算出"**刚改过**"的那几项（**纯读，不推进基线**）。
 *
 * ★★★★★ 2026-10-15（D210）：**刻意与推进分开** —— 这一条是探针逼出来的。
 *
 * ★ 病（我第一版）：`renderSettingsSnapshot` 里**顺手**推进基线（"渲染即推进"）。
 *   而我写探针时发现：**渲染 ≠ 送达** —— 只要多渲染一次（探针自己调了一次、
 *   或者这一拍最终没注出去），变更行就被**消费掉**，而模型**一个字都没看到**
 *   ⇒ **正是用户抱怨的那件事**（"改了之后永远不生效"）。
 *   ★ 这与本项目 **L14「源码 ≠ 送达文本」是同型的第 N 次**：
 *     这次是「**渲染 ≠ 送达**」。
 *   ★★ 判据：**观测者不许改变被观测对象**；**提醒只在真正送出去之后才算送达**
 *     ⇒ 渲染**纯读**，推进**单独一个函数**、只在**确认要注出去**时调。
 *
 * @returns {Array<{key:string, from:string, to:string}>} 空的 ⇒ 什么都没改（平时就是这样）
 */

export function settingsChangesOf(info) {
  const cur = settingsValuesOf(info);
  const prev = settingsBaselines.get(settingsBaselineKeyOf(info));
  if (prev === undefined) return []; // ★ 首轮不标（初识不是变更）
  const out = [];
  for (const key of SETTING_KEYS) {
    if (prev[key] !== cur[key]) out.push({ key, from: prev[key] ?? "(未设)", to: cur[key] ?? "(未设)" });
  }
  return out;
}

/**
 * ★★★★★ 2026-10-15（D211）：变更基线的**键** —— **项目根 + 对话 id**。
 *
 * ★ 为什么必须带对话 id（探针证明的真缺陷，见 `settingsBaselines` 上面那段）：
 *   只按项目根存 ⇒ 同项目的**第二个对话收不到「刚改过」**（被第一个消费掉了）。
 *   ⇒ 而用户要的正是「**每个对话都能读到我们的改动**」。
 *
 * ★ 为什么还要带项目根：设置值本身是**按项目**算的（清单优先）⇒ 同一个对话锁到别的项目时，
 *   它的基线不该拿 A 项目的值去比 B 项目（与 `blockWeights` 只认同 root 同一条纪律）。
 *
 * ★ 取不到 sid 时**退回项目根**（保守：宁可退化成 D210 的行为，也不要两条都不报）。
 */

export function settingsBaselineKeyOf(info) {
  const root = String(info?.projectRoot ?? "");
  const sid = info?.sid === undefined || info.sid === null ? "" : String(info.sid);
  return sid === "" ? root : `${root}\u0000${sid}`;
}

/**
 * 把基线推进到"当前值"（**只有在这一次确实要送出去时才调**）。
 *
 * ★ 详见 `settingsChangesOf` 上面那段：渲染是纯读的，推进在这里。
 * ★ 首轮也推进 —— 没有基线时那是"初识"，不是"变更"，但基线必须立起来。
 */

export function commitSettingsBaseline(info) {
  settingsBaselines.set(settingsBaselineKeyOf(info), settingsValuesOf(info));
}

/** 一项设置的**人读标签**（变更行要写"哪一项"，不能只印内部键 —— D163 那条纪律）。 */

export function settingLabelOf(key) {
  const spec = specOf(key);
  return spec === undefined ? key : `${spec.label}`;
}

/**
 * 把一个设置的**内部值**渲染成人读文字（变更行要印"旧值 → 新值"）。
 *
 * @param {string} raw `settingsValuesOf` 给的 `JSON.stringify` 结果，或 `"(未设)"`
 * @returns {string}
 */

export function settingValueTextOf(key, raw) {
  if (raw === "(未设)") return raw;
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return String(raw);
  }
  const spec = specOf(key);
  if (spec?.kind === "boolean") return v === true ? "开" : v === false ? "关" : String(v);
  if (spec?.kind === "levels" && v !== null && typeof v === "object") {
    return ["L0", "L1", "L2", "L3", "L4"].map((k) => `${k}${v?.[k] ? "✅" : "❌"}`).join(" ");
  }
  // ★ 比例类按百分比印：判据**从 spec 自己取**（`min/max` 都在 0~1 区间 ⇒ 它是个比例），
  //   绝不另写一张"哪些键是比例"的名单 —— 那又是一处会分叉的出处（D25/D170）。
  const isRatio =
    typeof spec?.min === "number" && typeof spec?.max === "number" && spec.min >= 0 && spec.max <= 1;
  if (isRatio && Number.isFinite(v)) return `${Math.round(Number(v) * 100)}%`;
  const unit = typeof spec?.unit === "string" && spec.unit !== "" ? ` ${spec.unit}` : "";
  return `${String(v)}${unit}`;
}

/**
 * ★★★★★★ 2026-10-15（D210）：**"设置刚改过"那一行**。
 *
 * ★ 用户原话（逐字）：*"模型每回合获得的设置清单能否不影响工作还有足够的提醒效果，
 *   否则有些标准改了之后永远不生效"*
 * ★★ 判据：**"知道现在的值" ≠ "知道它刚变过"** ——
 *   与 D198「看得见内容 ≠ 看得出它该更新了」、D208「知道现值」是**同型的第三次**。
 *
 * ★ 两条形态要求（都是用户当场定的）：
 *   ① **不影响工作** ⇒ 没有变更时**返回空串** ⇒ 快照与旧版**逐字一致**（零噪声）；
 *   ② **足够提醒** ⇒ 变更时顶一行，且给**旧值 → 新值**（只说"变了"它不知道该按哪个做）。
 *
 * @returns {string} 空串 = 什么都没改（平时就是这样）
 */

export function renderSettingsChangeLine(changes) {
  if (!Array.isArray(changes) || changes.length === 0) return "";
  const parts = changes.map(
    (c) =>
      `**${settingLabelOf(c.key)}** ${settingValueTextOf(c.key, c.from)} → ${settingValueTextOf(c.key, c.to)}`
  );
  return `> ★★ **设置刚改过**：${parts.join("；")}\n>   （**上面那张表已经是新值** —— 请按新的来。）\n`;
}

/**
 * ★★★★★★ 2026-10-14（D208，用户拍板）：**每回合注入一份「当前设置」快照**。
 *
 * ★★★ 用户的病（他原话，逐字）：
 *   *"每次模型开头都应该被注入一份占比比较小的，但是能比较清楚的这个设置情况，
 *     因为实际上我现在已经台账设置为 400，但是你仍然认为是 350，然后有些模型认为是 150，
 *     有些模型认为是 300，所以说我认为模型理应每个回合都实时了解到当前的各种设置情况。"*
 *
 * ★★ 分叉到底出在哪（我查清了，三个都是**真缺口**）：
 *   ① **面板值 ≠ 项目值**：`maxActiveLines` 是 **project-first** 的 ——
 *      真源在 `.dsh-ledger.json`（本项目 **350**），面板那个数只是"**新项目的默认值**"。
 *      用户把面板设成 400，注入里仍报 350 ⇒ **两个数都对，但没人告诉他哪个管用**。
 *   ② **默认值散落三处**：`DEFAULT_MAX_ACTIVE_LINES` 现在是 **300**；
 *      而用户记得的 **150** 是**更早的默认**（D18 曾把它 150 → 300）⇒ 不同会话读到的文档/记忆不同版。
 *   ③ **"120 点"那类数字**（水位线）在别处是 `0.30` ⇒ 同一个东西有"点"与"比例"两种写法。
 *   ⇒ 判据：**"谁管用"必须每回合明说**，而且要带**来源**（项目清单 / 插件面板 / 默认值）。
 *
 * ★ 形态要求（用户："占比比较小"）：**一行一项、只给生效值与来源**，不给解释（解释在面板里）。
 *   本函数只渲染**行**，由调用方决定塞进哪一段。
 */

export function settingsSnapshotLines(info) {
  const s = currentSettings();
  const pct = (v) => `${Math.round(Number(v) * 100)}%`;
  const man = info?.manifest ?? {};
  // ★★★★★ 2026-10-17（D226）：这里原来有一个局部函数 `pick(key, fmt)`，它**自己写了一遍
  //   "清单优先"**（`hasMan ? man[key] : s[key]`）—— 那正是 D222 收掉的第 5 个判定点之一。
  //   D222 把 5 个取值点全部改走 `precedenceValue` / `precedenceIsProject` 之后，
  //   **`pick` 再没有任何调用点** ⇒ 它成了**死代码**。
  //   ★ 为什么必须删而不是留着：它是一份**看起来还在生效的旧口径** ——
  //     下次有人"顺手用它"就会把 D222 的修复绕过去（D220 那条"清单里留着旧键"的同型病）。
  //   ★ 判据：**当一个事实被收成唯一出口之后，旧出口必须消失。**
  const onOff = (v) => (v === true ? "开" : v === false ? "关" : String(v));
  // ★★★★★ 2026-10-14（D208 自检发现）：**这里第一版把标签说反了** ——
  //   它写「面板值 350（项目）」，而我一眼看到的是"面板值"三个字 ⇒ **正是用户抱怨的那种混淆**
  //   （"我明明设了 400，为什么说 350"）。⇒ 标签必须**先说这是谁的值**：
  //     · 项目值 = 清单里显式写的（**它管用**）；
  //     · 面板值 = 插件级设置（**只管新项目**）。
  //   ★★ 判据：**标签本身就是信息** —— 写错标签比不写更坏（它让人确信一个错的结论）。
  const ledMan = man.maxActiveLines;
  const hasLedMan = ledMan !== undefined && ledMan !== null;
  // ★★★★★ 2026-10-16（D222）：**这段话必须跟着"谁优先"走** ——
  //   否则它会在"以面板为准"时还写着"项目清单定了 400（它管用）" ⇒ **一句错话**，
  //   而错话比不写更坏（它让人确信一个错的结论，正是用户抱怨的那种混淆）。
  const pf = precedenceIsProject();
  const ledLine = pf
    ? hasLedMan
      ? `- **活跃台账上限**：**${info?.maxActiveLines ?? "?"} 行**（现 ${info?.activeLines ?? "?"} 行）` +
        `︱★ **项目清单定了 ${ledMan}**（**它管用** —— 当前设为「以项目清单为准」）`
      : `- **活跃台账上限**：**${info?.maxActiveLines ?? "?"} 行**（现 ${info?.activeLines ?? "?"} 行）` +
        `︱★ **清单没写** ⇒ 用面板值 ${s.maxActiveLines}`
    : `- **活跃台账上限**：**${info?.maxActiveLines ?? "?"} 行**（现 ${info?.activeLines ?? "?"} 行）` +
      `︱★ **面板值 ${s.maxActiveLines} 管用**（当前设为「以面板为准」` +
      `${hasLedMan ? `；该项目清单里还留着旧值 ${ledMan}，**已被面板盖过**` : ""}）`;
  const lines = [
    ledLine,
    // ★ D222：把"谁说了算"本身印出来 —— 用户报的困扰正是"不知道哪个数管用"。
    // ★★★★★ D234 就地更正：这一行原来把 5 项**手工列死**（"压缩方式 / 区块注入 / 行数上限 / 登记条数 / 日志档位"）。
    //   加了 `fileAnchor` 之后 `PRECEDENCE_KEYS.length` 变成 6，而**枚举仍旧是那 5 个名字**
    //   ⇒ 句子变成"6 项：〈列了5项〉" —— **数与名字对不上**。
    //   ★ 这正是 D224/D225/D226 那一类"行为改了、告知没跟上"的**复发形态**，
    //     只是这次混在**同一行**里，所以"改数字"看起来像改好了。
    //   ⇒ 判据：**枚举不许手抄，从 `PRECEDENCE_KEYS` 现算**（同一个值只有一个出处）。
    `- **谁说了算**：**${pf ? "以项目清单为准" : "以设置面板为准（默认）"}**` +
      `（管 ${PRECEDENCE_KEYS.length} 项：${PRECEDENCE_KEYS.map((k) => specOf(k)?.label ?? k).join(" / ")}）`,
    `- **全量压缩线**：**${pct(s.highFidelityCompactRatio)}**︱单次最多压 ${s.deltaRemovePoints} 点︱` +
      `最小心得体量 ${s.minCompressPoints} 点`,
    `- **压缩方式**：${s.incrementalCompact ? "增量 + 全量" : "**只全量**（增量默认关）"}︱` +
      `插件自动压缩 ${onOff(s.autoCompact)}︱收尾硬门 ${onOff(s.hardMaintenanceGate)}`,
    `- **分流单**：单次最多 ${s.triageKeepMax} 条 / 累积 ${s.triageKeepTotalMax} 条`,
    `- **注入**：区块级注入 ${onOff(blockInjectionEnabled(info))}（**${
      blockInjectionEnabled(info) === true ? "块级" : "整份"
    }**）︱单次台账上限 ${s.maxReadChars} 字符`,
    // ★★★★★ D234：文件锚定开关也**必须印出来** —— 用户的原话（D195）是
    //   *"看不见的东西等于没有"*；一个默认关的新功能若不显示，用户永远不知道它存在、更不会去开。
    `- **文件锚定**：${onOff(fileAnchorEnabled(info))}（六维相对秩 + 记忆面地图；**关 = 完全无痕的旧行为**）`,
    `- **胶囊 / 回读**：胶囊 ${s.capsuleMaxChars} 字符︱` +
      `\`ledger_recall\` 单次 ${s.recallMaxChars} 字符`,
    // ★★★★★ 2026-10-18（D241）：**回合末抽起**也必须印出来 —— 与 `fileAnchor` **同一条理由**
    //   （D195 用户原话："看不见的东西等于没有"）。
    //   ★ 但这里比 `fileAnchor` 更要紧：`fileAnchor` 默认关、不开就无痕；
    //     **这一项默认开（1 次）**，它**每一回合都在改行为** ⇒ 不显示的话，
    //     用户会看到"回合明明结束了，AI 又被叫回来做台账"却**不知道是谁干的、更不知道去哪关**。
    `- **回合末抽起**：${
      s.turnEndPull > 0 ? `同回合最多 **${s.turnEndPull}** 次` : "**关**（只提醒，不唤醒）"
    }（台账或分流缺任一项才抽；抽满即放行并记欠账，绝不卡住工作）`,
    // ★★★★★ 2026-10-18（D246）：**长回合中途压缩也必须印出来**。
    //
    //   ★ 为什么必须加这一行（我当场撞的墙，不是理论）：
    //     用户在面板打开了 `midTurnCompact`，而**注入里没有任何一行能证实它生效了** ——
    //     他只能看到「文件锚定：开」，那证明的是**另一个**开关。
    //     ⇒ 我**无法从注入判断 gate 到底跑没跑**，只能去翻官方会话日志找 `turn` 字段。
    //   ★★ 这与 D195「看不见的东西等于没有」是同一条，但更硬：
    //     前三项（`fileAnchor` / `blockInjection` / `turnEndPull`）都是"关了就无痕"，
    //     而这一项**改的是压缩发生的时刻** —— 它不生效时**看起来跟生效一样**（都在回合末压）。
    //     ⇒ **不印出来，等于永远无法区分"没开"与"开了但没跑"。**
    //   ★ 所以这一行**必须同时印出水位线**，否则"开了"与"到线了没"还是两回事。
    `- **长回合中途压缩**：${s.midTurnCompact === true ? `**开**（水位 ≥ ${Math.round(s.highFidelityCompactRatio * 100)}% 就在回合内压）` : "**关**（只在回合末压）"}`,
    `- **日志**：L0/L1/L2/L4 = ${["L0", "L1", "L2", "L3", "L4"]
      .map((k) => `${k}${s.logLevels?.[k] ? "✅" : "❌"}`)
      .join(" ")}`,
  ];
  return lines;
}

/**
 * 渲染那份快照（**带题头 + 有界**）。
 * ★ 为什么单独一个函数：注入有两个入口（常规注入 / 压缩后的短注入），
 *   而**"当前设置"这两种情形都需要** —— 用户要的是"**每回合**都实时知道"。
 */

export function renderSettingsSnapshot(info) {
  const body = settingsSnapshotLines(info).join("\n");
  // ★★★★★ 2026-10-17（D226）：脚注要印「谁说了算」—— 走**唯一出口** `precedenceIsProject()`
  //   （在 part1，与 `precedenceValue`/`precedenceFromManifest` 同一族）。
  //   ⚠️ 我第一版**直接用了上面那个函数的局部变量 `pf`** ⇒ `ReferenceError: pf is not defined`
  //     —— **与 D222 在 `inspect()` 里踩的是同一个错**（把局部变量跨函数用）。
  //   ★ 而第二版我又在各函数里各写一遍表达式 ⇒ 那正是 D25「一个事实两个出口」。
  //     ⇒ 最终：**判据只有一个出口**，各处都调它。
  const pf = precedenceIsProject();
  // ★★★★★★ 2026-10-15（D210）：**"设置刚改过"那一行**。
  //   ★ 为什么必须在这里（而不是另起一处）：快照是**每回合唯一**那块设置文字 ——
  //     变更提示必须长在它身上才叫"每回合都看得见"。
  //   ★★★ 顺序要紧：**先算变更、再拼正文** —— 变更行说的是"上面那张表相对上次变了什么"，
  //     所以它必须与**这一次渲染出来的正文**同源。
  //   ★★★★ `settingsChangesOf` 是**纯读**的（**不推进基线**）——
  //     推进在 `commitSettingsBaseline`，只在**这次确实注出去**时调。
  //     ⇒ 判据：**渲染 ≠ 送达**（L14 同型），提醒不许被"渲染了一次"吃掉。
  //   ★ 零噪声保证：没变更时它返回空串 ⇒ 下面的拼接与旧版**逐字一致**。
  const changeLine = renderSettingsChangeLine(settingsChangesOf(info));
  return (
    "\n\n---\n" +
    SETTINGS_SNAPSHOT_MARK +
    "（**每回合实时渲染** —— 面板改了就立刻反映在这里）\n" +
    changeLine +
    "> ★ 带「项目」= 该项目清单（`.dsh-ledger.json`）**显式指定**；\n" +
    ">   带「插件」= 用插件面板的值（或它派生的默认值）。\n" +
    // ★★★★★ 2026-10-17（D226）：这一行**原来写死「两者不一致时以「项目」为准」** ——
    //   而 D222 把默认反转为「以面板为准」之后，它就成了**一句错话**，且**每回合都推给模型**。
    //   ★ 它与上面 `ledLine` 是**同一个事实**（谁说了算）⇒ 必须走**同一个出口**，
    //     不许各写一遍（否则就是 D25「一个事实两个出口」的复发，本文件已栽过一次）。
    `>   ★ **两者不一致时，以「${pf ? "项目清单" : "设置面板"}」为准**` +
      `（当前设为「${pf ? "以项目清单为准" : "以设置面板为准（默认）"}」）。\n` +
    body +
    "\n"
  );
}

export function renderInjectionBody(info, pending, biOpts) {
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
  //   所以现在要接着给出路：**问题记录**（`ledger_note`）—— 它**优先顺工作区已有的**记录通道
  //   （本机是 `60-对话记录与交接\对话总结\`），**找不到才新建** `问题记录/`，
  //   全程不碰 Git。★ D229：新建时用通用名，不把本机格局强加给别人。
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
      // ★★★★★ 2026-10-14（D203）：这三行**必须报"这一类现在住在哪"** ——
      //   卡片模式下若还写 `DECISIONS.md`，模型会去读**迁移前的快照**并当成现状
      //   （比"读不到"更危险）。⇒ 统一问 `kindLocationOf`。
      (() => {
        const d = kindLocationOf(info, "decisions");
        if (d.rel === undefined) return "";
        return d.card
          ? `- 关键决策：\`${d.rel}/\`（**一卡一文件**，文件名就是编号：\`${d.rel}/D195.md\`；用 \`ledger_read({target:"decisions", entry:"D195"})\` 取一条 —— ★ **不要**去读根目录那份同名旧文件，它是**迁移前的快照**）\n`
          : `- 关键决策：\`${d.rel}\`（**不参与归档、永久保留**）\n`;
      })() +
      (() => {
        const g = kindLocationOf(info, "goals");
        if (g.rel === undefined) return "";
        const where = g.card ? `\`${g.rel}/\`（**一卡一文件**，如 \`${g.rel}/g1.md\`）` : `\`${g.rel}\``;
        return (
          `- 目标树：${where}（卡片联成树；用 \`ledger_goals\` 维护 —— ` +
          "★ **完成一个目标时补一条教训**：“哪些路走通了 / 哪些没走通”）\n"
        );
      })() +
      // ═══════════════════════════════════════════════════════════════════════
      // ★★★★★ 2026-10-14（D195，用户拍板）：**把"漏掉的两个记忆文件"接进契约**
      // ═══════════════════════════════════════════════════════════════════════
      //
      //  用户原话（逐字）：*"下一个目标是让台账记忆系统活起来——之前只有 ledger 到 design 的
      //  索引与连接，我的一个想法是，让**有必要连起来的用索引和其他东西连起来**，
      //  让整个系统成为一个**有机整体**。"*
      //
      // ★★★ **修的是实测出来的缺口**（不是想象的）：`tools/_probe-d195-connectivity.mjs`
      //   渲染**真实注入**后，把「插件自己写的那段结构契约」单独摘出来逐项核对，
      //   结果 **`PRINCIPLES.md` 与 `LESSONS.md` 在契约里一条都没有** ——
      //   而上面那张列表里，LEDGER / DECISIONS / GOALS / 归档 / 日志 / 交接单**都在**。
      //
      // ★★ 后果有多大：这两个文件**工具都够得着**（`ledger_read({target:'principles'})`、
      //   `ledger_lessons({op:'list'})`），但**模型每回合收到的契约里没有它们** ⇒
      //   模型**不知道它们存在** ⇒ 于是 D180–D194 做的那一整套（授权窗口 / 提议批准 /
      //   经验教训）**在真实运行里几乎不会被用到**（D186 已经量过一次：全库 `ledger_goals` = 0 次）。
      //   ⇒ ★★★ 这正是 **D46** 那条结论的反面教材：**"恢复必须是推给模型的"** ——
      //     能力做了、入口也开了，**但没推行**，就等于**没有**。
      //   ★ 也正因为这样，它是本项目第 N 次同型复发：
      //     **代码对、决策对，而"实际送达模型的那一份"没人对齐**（D173/D174 那条）。
      //
      // ★ 两条都**按已有形状**写（`info.xxxRel !== undefined` 时才出现）——
      //   没登记的文件不会凭空出现在契约里，那正是"不擅自创建"的同一口径。
      //   ★★ 每条都带 **`用 X 维护`**：光说"有这个文件"不够，
      //     契约的价值在于**告诉模型该怎么用它**（否则模型知道有文件也不会去动）。
      (info.principlesRel !== undefined
        ? `- 根本原则：\`${info.principlesRel}\`（**只有用户能改**；你只能 ` +
          "`ledger_propose_principle` 提议、或 `" +
          PRINCIPLE_GRANT_TOOL +
          "` 请用户开一个授权窗口 —— ★ 改原则前**先读它**，别把用户定的规矩当成不存在）\n"
        : "") +
      // ★ D203：经验与教训也可能被卡片化 ⇒ 这一行也问 `kindLocationOf`（**不说快照**）。
      (() => {
        const l = kindLocationOf(info, "lessons");
        if (l.rel === undefined) return "";
        const where = l.card
          ? `\`${l.rel}/\`（**一卡一文件**：\`${l.rel}/L1.md\` / \`E2.md\`）`
          : `\`${l.rel}\``;
        return (
          `- 经验与教训：${where}（用 \`ledger_lessons\` 维护 —— ` +
          "**教训**（`L<n>`，踩了坑并修好之后记一条，`cause` 根因必填）· " +
          "**经验**（`E<n>`，花代价探查清一个机制之后记一条，`source` 出处必填）；" +
          "★ 动手之前先 `list` 一遍，**别重踩同一个坑、别重查同一个机制**）\n"
        );
      })() +
      (info.archiveRel !== undefined ? `- 归档目录：\`${info.archiveRel}\`（只追加不删除）\n` : "") +
      // ★★★★★ 2026-10-14（D195）：**`JOURNAL.md` 也是实测出来漏掉的那一个**（第三个）。
      //   ★ 探针原先把它的"命中"记在**目标树正文**里（目标树也被渲染进契约区），
      //     而那**不是插件的保证** —— 目标树是模型自己写的，换个措辞这个词就没了。
      //   ⇒ 判据必须是"**契约列表自己**列了它、且给了用法"。
      (info.journalRel !== undefined
        ? `- 回合流水：\`${info.journalRel}\`（**只追加不改**；写它用 ` +
          "`ledger_write({target:\"journal\"})` —— ★ 它**不注入**，" +
          "要查早期某一段发生过什么时才用 `ledger_read({target:\"journal\"})`）\n"
        : "") +
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
      // ═══════════════════════════════════════════════════════════════════════
      // ★★★★★ 2026-10-19（D272，用户拍板）：**协议过期 ⇒ 模型的义务**
      // ═══════════════════════════════════════════════════════════════════════
      //
      //  用户原话（逐字）：*"如果不符合的话，模型会主动向用户提出要求，询问是否要更新
      //  当前的协议和结构，因为我在另外一台设备即使已经更新到最新阶段了，但还是没有自动
      //  的去完成这个任务，导致他现在还是比较旧的架构。……这就意味着模型不会把它当成
      //  一个任务去做。"*
      //
      //  🔴 病根（改造前）：`conformanceOf` 只查「登记过的对不对」，
      //     对「该登记而根本没登记」**沉默** ⇒ 注入里从未出现过"你还停在旧架构"这句话
      //     ⇒ 模型当然不会把它当任务（它根本不知道）。
      //     而合规卡片只在**回合末**且**判定不为 OK** 时弹 —— 老项目判 OK，永不弹。
      //
      //  ★ 所以这里必须**在每回合注入里就写死这句话**，而且用**义务句式**（"你必须…"），
      //    不是告知句式（"这个项目是旧的"）—— 后者模型会当成背景资料读过去。
      //  ★ 三个约束（都来自既有纪律）：
      //    ① **只提示、不擅自改**：补键/建目录会改用户项目结构 ⇒ 必须**先问用户**
      //       （与 `ledger_init` / `PRINCIPLES` 同一条授权纪律）。
      //    ② **只报一次**：注入了就够，不重复催（避免每回合刷屏打烂缓存）。
      //    ③ **说清"升了有什么好处"**：只报字段名等于让人猜（本项目「错话比不说更坏」）。
      renderProtocolUpgradeNotice(info) +
      // ═══════════════════════════════════════════════════════════════════════
      // ═══════════════════════════════════════════════════════════════════════
      // ★★★★★★ 2026-10-14（D196，用户拍板）：**功能清单 / 升级通道**
      // ═══════════════════════════════════════════════════════════════════════
      //
      //  用户原话（逐字）：*"我建议就是每个使用我们插件的都维护一个小的功能清单，
      //  不然的话你插件更新之后，其他对话都不知道，然后还是用此前的规格去建这个系统。
      //  就无法跟着更新。"*
      //
      // ★★★ 这里是 **D195 的反面**，两条合起来契约才完整：
      //   · D195：**已启用**的 ⇒ 必须可见（否则模型不知道该用）；
      //   · D196：**未启用**的 ⇒ 也**必须让模型知道它存在**（否则旧项目永远升不上来）。
      //   ★ 实测缺口（`_probe-d196-capability-gap.mjs`）：一个"旧规格项目"的注入里，
      //     **5/5 项新能力一个都没提** ⇒ **插件更新对它等于没发生**。
      //   ⇒ 这一段就是**升级通道**：老项目也能看到"这个版本还带了什么能用"。
      //
      // ★ 为什么**放在契约末尾**（而不是开头）：它是**补充信息**，
      //   不该挤掉"这个项目现在是什么样"那几条（主体是现状，这是"还能是什么"）。
      // ★★ 它**不催、不擅自创建** —— 只如实报"有这些、怎么用"，要不要启用由用户决定
      //   （与本插件一贯口径一致：`GOALS`/`PRINCIPLES`/`LESSONS` 都不凭空创建）。
      renderUnenabledCapabilities(info) +
      // ★★★★★ 2026-10-14（D197，用户拍板）：**文件格式协议**。
      //   ★ 与 D196 那一段**各管一面、刻意相邻而不重复**：
      //     D196 = "这个版本还带了什么能用"（未启用的）；
      //     D197 = "你正在用的这些，格式该怎么写"（已启用的）。
      //   ⇒ 用户原话：*"他连协议都不知道的话，就很难去填这些东西"* —— 实测 7/7 项都没推行。
      renderProtocolBlock(info) +
      (info.decisionsRel !== undefined
        ? "\n用户在会话中定了**架构 / 接口 / 协议**这类长期决策时，" +
          `用 \`ledger_write({target:"decisions", mode:"append"})\` 记一条 —— 它不会随日常更新被覆盖。\n`
        : "") +
      // ═══════════════════════════════════════════════════════════════════════
      // ★★★★★ 2026-10-13（D173/D174）：**压缩策略合同 —— 对齐全量架构**
      // ═══════════════════════════════════════════════════════════════════════
      //
      //  ★★★ 这一段原来写的是 **D129** 的架构（"每涨 4~5 点做三步 / 以轻量为主 / 由你主动压"）。
      //    用户 2026-10-13（**D155**）已拍板改成：
      //    *"模型将把全量压缩当成主力，不用在回复中直接压缩，而是在回复完成后，
      //      如检测到这个水位高于30%（这个可以调）则进行一次全量压缩。
      //      但是切记，模型的每一条回复，在结束以前必须强制进行台账和分流。"*
      //    ⇒ 代码默认值早已改对（`incrementalCompact: false`、全量线 0.3），
      //      **唯独这段"发给模型看的合同"没跟着改** ⇒ 模型每天收到旧指令、插件按新架构执行。
      //    ★ 这是本文件已栽两遍的同一个病（纪律 11「记录存在 ≠ 记录准确」）的**第三种形态**：
      //      **代码对、决策对，而"实际送达模型的那一份"没人对齐**（D173 §二/§三）。
      //
      //  ★ 修法：**合同由设置渲染**（`incrementalCompact` 开/关 → 两套文本），
      //    这样"开关"与"合同"不可能再分叉 —— 与 `maxActiveLines` 同一条"单一来源"口径。
      //  ★ 并补**会红的断言**（情形 70）：摘掉任一套 ⇒ 当场变红（否则下次改架构还会只改代码）。
      (currentSettings().incrementalCompact === true
        ? // ── 分支 A：增量（分段）压缩**开着** —— 即 D129 那套（现已非默认）──────────
          "\n★★★ **压缩策略（这是你与插件之间的合同）**\n" +
          "- 压缩**全部由你决定**：轻量（`mode:\"light\"`，回合内压最旧一段）与全量\n" +
          "  （`mode:\"full\"`，回合末执行）都由你按需调用 `ledger_compact`。\n" +
          "- ★ **每涨 4~5 点，按这个顺序做三步**（这是标准动作，不是三个可选项）：\n" +
          "  ① **`ledger_write`**（+ `ledger_log_write`）—— 把这一段进展落盘；\n" +
          "  ② **`ledger_triage`** —— 当场把这一段分成三个桶（`keep` 留上下文 / " +
          "`stash` 落进项目 `_stash/` / `drop` 丢掉）；\n" +
          "  ③ **`ledger_compact`（`mode:\"light\"`）** —— 轻量压缩，回合内执行、不影响工作。\n" +
          "  ★ **顺序不能换**：①②是压缩的前置条件（闸门会拦），③做完会重新注入台账与胶囊。\n" +
          "- **节奏建议**：大约每涨 **4~5 点**折一次 —— 一次压掉「上次压缩以来增量的一半」。\n" +
          "  ★ 不必更碎（那只是白打冷缓存），也不要攒很久（那会让分流难做、细节丢得快）。\n"
        : // ── 分支 B：**默认** —— 全量为主力、回合末由插件执行（D155 架构）────────────
          "\n★★★ **压缩策略（这是你与插件之间的合同）**\n" +
          "- ★ **压缩由插件在回合末自动完成 —— 你不需要操心它的时机。**\n" +
          `  · 本插件有一条**全量压缩线**（当前 **${Math.round(currentSettings().highFidelityCompactRatio * 100)}%**）：` +
          "**回合结束之后**若水位在它之上，插件就做一次**高保真全量压缩**" +
          "（一次折到约 10%），压完把台账与逐字胶囊重新注入。\n" +
          "  · ★ 所以**不要为了压缩而打断自己**，也不要在回复中途调压缩工具去腾地方 ——" +
          "把这一轮做完，压缩交给回合末。\n" +
          "  · 水位到线时你会收到一句通知（那**只是如实告知**），" +
          "**你不需要回应它、更不需要抢在它前面压**。\n" +
          // ★★★★★ 2026-10-13（D179 硬门）：**用户要的"非常强烈的信息"就加在这里。**
          //   这是模型**每回合都看到**的那份合同 ⇒ 让"这次是你自己的活"变成常驻认知，
          //   而不是等到被拦下才知道（★ 与硬门**成对**：只强信息 = 建议；只硬门 = 复现 D59）。
          (hardMaintenanceGateOn()
            ? "- ★★★ **【硬门】这一条不是建议，是压缩的前提条件 —— 不做完，压缩就不会发生。**\n" +
              "  每一条回复**结束以前**，你必须做完这两步（顺序不能换）：\n" +
              "  ① **`ledger_write`**（+ `ledger_log_write`）—— 把这一段进展写进台账；\n" +
              "  ② **`ledger_triage`** —— 分三个桶（`keep` 留上下文 / `stash` 落进项目 / `drop` 丢掉）。\n" +
              "  ★★ **不做会怎样**：回合末那次高保真压缩**不会执行** —— 上下文会一直涨，" +
              "直到官方 **80%** 那次硬压，而**那一次抓不到逐字胶囊**" +
              "（用户原话 / 报错原文 / 器物索引会一起丢，且**不可追回**）。\n" +
              "  ★ 做了就会立刻继续：压缩意图已挂在队列上，下一次空闲时自动重试。\n"
            : "") +
          "- ★★ **你的义务只有一条，但每一条回复都必须做：结束以前先落盘 + 分流。**\n" +
          "  ① **`ledger_write`**（+ `ledger_log_write`）—— 把这一段进展写进台账；\n" +
          "  ② **`ledger_triage`** —— 当场把这一段分成三个桶（`keep` 留上下文 / " +
          "`stash` 落进项目 `_stash/` / `drop` 丢掉）。\n" +
          "  ★ **顺序不能换**：落盘是压缩的前置条件（闸门会拦）；" +
          "分流决定「哪些能压、哪些怎么压」—— " +
          "`keep` 桶里那些「下一轮不知道就会做错」的东西，压缩后会被**逐字注回**。\n" +
          "- ★ **轻量压缩（`mode:\"light\"`）已冻结 —— 它不是常规动作。**\n" +
          "  它仍在（`/ledger light` 与工具都可调用），但**不要按涨幅、不要按节奏去调它**；" +
          "只有你明确判断「某一段确实该单独折掉」时才用。\n") +
      "- ★ **每次压缩前必须先落盘**（`ledger_write` + `ledger_log_write`）：\n" +
      "  压缩会把旧历史换成摘要，**没落盘的那段进展就是唯一副本**。没落盘 ⇒ 会被闸门拦下。" +
      // ★★★★★ 2026-10-13（D179 硬门）：说清"拦下之后会怎样"——硬门下**没有到期放行**。
      (hardMaintenanceGateOn()
        ? "★★ **【硬门】这里没有超时放行、也没有次数放行 —— 不落盘就是不压。**" : "") +
      "\n" +
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
      // ★★★★★ 2026-10-13（D174）：这一句原写「回合内的轻量压缩不必等回合结束」——
      //   那是**分支 A** 的措辞，在默认（全量）架构下会**再把模型往"中途压"上带**
      //   ⇒ 改成**两套架构都为真**的中性表述（不提"回合内"、不提"轻量"）。
      "★ 压缩**不影响你手头的工作**：压完之后台账与逐字胶囊会**重新注入**，你照常继续。\n" +
      `★ 只有在**这一轮确实说不完、值得写交接单**这类情况下，才调用 \`${CHECKPOINT_TOOL}\` ` +
      "把四选一交给用户（不记录 / 只记台账 / 记台账+压缩 / 记台账+写交接单）。" +
      "正做到一半、打断代价大时别问，做完再问。\n" +
      // ★★★★★★ 2026-10-14（D208，用户拍板）：**每回合都带上"当前设置"**。
      //   ★ 用户原话（逐字）：*"每次模型开头都应该被注入一份占比比较小的，但是能比较清楚的
      //     这个设置情况，因为实际上我现在已经台账设置为 400，但是你仍然认为是 350，
      //     然后有些模型认为是 150，有些模型认为是 300。"*
      //   ★★★ 放在 `tail` 里而不是各分支里 —— `tail` 是**所有注入形态共用**的那一段
      //     （整份 / 区块级 / 压缩后短注入都拼它）⇒ 一处接线 = **每回合都在**，
      //     不会出现"某个分支忘了带"（这正是 D207 那条"堵在唯一经过处"的同一条纪律）。
      renderSettingsSnapshot(info) +
      // ═══════════════════════════════════════════════════════════════════════
      // ★★★★★ 2026-10-17（D234）**文件锚定 + 记忆面地图**
      // ═══════════════════════════════════════════════════════════════════════
      //
      //  用户原话（逐字）：*"这么看来可以像给卡片打分一样，给文件也提供类似的多参数锚定"*
      //
      //  ★★★ 要治的病：「**取得到、但没去取**」—— 模型查到一份看起来够用的材料就停了。
      //    D46 的「推」只解决"不知道去哪找"，**不解决"找到了就不再找"**；
      //    而「推」的副作用正是：**推过去的东西成了检索终止符**。
      //  ⇒ 所以这一段**不只是排行榜**，它必须同时回答两件事：
      //    ① **该先读哪份**（六维相对秩）；
      //    ② ★ **还有哪些面你没看**（记忆面地图）+ **你手上那份已经落后多少代**。
      //
      //  ★★ 为什么放在 `tail` 里（与 `renderSettingsSnapshot` 同一条纪律）：
      //    `tail` 是**所有注入形态共用**的那一段（整份 / 区块级 / 压缩后短注入都拼它）
      //    ⇒ 一处接线 = 每回合都在，不会出现"某个分支忘了带"。
      //
      //  ★★★ 三条安全绳（与区块注入同源，缺一条就会碰准确性底线）：
      //    ① **扫描范围有界**（深度 ≤3 / 文件 ≤400 / 每份只读头部 64 KB）
      //      ⇒ 绝不因为锚定把一次注入拖成读全库；
      //    ② **任何一步失败 ⇒ 这一段整段不出**（`try/catch` 包住、返回空串），
      //      绝不因为锚定算不出来而让整份注入崩掉；
      //    ③ **默认关**（设置项 `fileAnchor`，默认 `false`）—— 它是又一个会改变
      //      "模型实际看到什么"的改动，与 `blockInjection` 同一条口径：
      //      没有实测对照之前，默认必须与今天**逐字一致**。
      renderFileAnchorBlock(info);

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

export function blockInjectionEnabled(info) {
  // ★ D222：改走**唯一出口**（默认「以面板为准」⇒ 面板一开，所有项目立刻块级注入）。
  const v = precedenceValue(info, "blockInjection");
  if (v === true || v === false) return v;
  return currentSettings().blockInjection === true;
}

/**
 * ★★★★★ 2026-10-17（D234）：**文件锚定段到底出不出**（唯一出口）。
 *
 * ★ 与 `blockInjectionEnabled` 同一条口径：走 `precedenceValue`
 *   ⇒ **清单写得进、面板也盖得住**，两处不会分叉。
 * ★★ 默认 **false**（设置项 `fileAnchor`）：这是又一个会改变"模型实际看到什么"的改动。
 */
export function fileAnchorEnabled(info) {
  const v = precedenceValue(info, "fileAnchor");
  if (v === true || v === false) return v;
  return currentSettings().fileAnchor === true;
}

/**
 * ★★★★★ 文件锚定段的**装配点**（注入侧唯一调用处）。
 *
 * ★★★ 三条安全绳全在这里落地（与 `renderBlockInjection` 同源纪律）：
 *   ① **有界**：扫描深度 ≤3、文件 ≤400、每份只读头部 64 KB；
 *   ② **失败即静默**：任何异常 ⇒ 返回 `""`，绝不拖垮整份注入
 *      （用户的底线是"不要影响模型的准确性" ⇒ **少一段宁可比崩掉好**）；
 *   ③ **默认关**：设置项 `fileAnchor`。
 *
 * ★ 为什么要有 `stats`：本项目纪律「**「配了就该跑」不是证据，要有可查计数器**」——
 *   没有它，事后只能看到"没这一段"，查不出是"关着"还是"扫出来是空的"。
 */
export function renderFileAnchorBlock(info) {
  try {
    if (fileAnchorEnabled(info) !== true) return "";
    const root = info?.projectRoot;
    if (typeof root !== "string" || root === "") return "";

    const files = scanMemorySurface(root, info);
    if (files.length === 0) return "";

    // ★ 被引用度的语料 = **权威结论**（决策卡 / 经验教训 / 目标树）。
    //   ★ 为什么只用它们：在别的调研稿里互相提及会形成"互相抬高"的假信号。
    //   ★ 没有语料 ⇒ 这一维进 `missing`（未计分），**不静默按 0 算**。
    const corpus = files.filter((f) => f.kind === "conclusion").map((f) => ({ rel: f.rel, text: f.head }));

    // ★ 代际维的分母 = **全库当前最大 D 号**。
    //   ★ 从语料里现算，不写死（写死就会随项目长大而失效 —— 那正是"旧口径"的来源）。
    let maxDecision;
    for (const c of corpus) {
      for (const m of String(c.text).matchAll(/\bD(\d{1,3})\b/g)) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && (maxDecision === undefined || n > maxDecision)) maxDecision = n;
      }
    }

    const anchored = anchorFiles(files, { maxDecision, corpus });
    // ★ 面地图：**只有出现在磁盘上的面才报**（"配了但没建"不算存在）。
    const counts = new Map();
    for (const f of files) {
      const k = `${f.surface}\u0000${f.rel.split("/").slice(0, -1).join("/")}`;
      if (!counts.has(k)) counts.set(k, { label: f.surface, rel: f.rel.includes("/") ? f.rel.split("/").slice(0, -1).join("/") : "（项目根）", kind: f.kind, why: f.surfaceWhy, count: 0 });
      counts.get(k).count += 1;
    }
    // ★★★★★ 2026-10-18（D261 · 用户当场纠正）：**必须传 `fullList: true`**。
    //
    //   用户原话：*"但是，模型依旧应该去查所有的文本 —— 看不看取决于分数高低，
    //   但得让模型知道相关的有哪些文件"*
    //
    //   🔴 原来 `renderFileAnchor` 默认**只列前 6 名**，第 7 名之后折成一行
    //      「另有 N 份未被列出」⇒ **模型根本不知道它们叫什么**。
    //      分数于是从「顺序」变成了「资格线」，而筛选是整条链上最不可逆的一步。
    //
    //   ★ 实测代价（`_probe-anchor-full-list-size.mjs`）：material 面 25 条 ≈ 1.7K 字符
    //     （只列 6 条约 0.4K）⇒ 多花 1.3K 换掉「不知道有 19 份存在」极其划算。
    //     ★ 但 fragment/history/conclusion 合计 ≈ 2.5 万字符 ⇒ **不能全列**（会淹掉真材料）。
    //     ⇒ 所以是**两档**：material 全列，其余仍折叠。
    return (
      renderFileAnchor(anchored, { top: FILE_ANCHOR_TOP, fullList: true }) +
      renderSurfaceMap([...counts.values()])
    );
  } catch {
    // ★ 安全绳②：锚定算不出来 ⇒ **这一段整段不出**，绝不拖垮注入。
    return "";
  }
}

export function renderBlockInjection(info, opts) {
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
    // ★★★★★ 2026-10-14（D184）**这里修过一次致命的优先级错误 —— 记清楚，别再写回去**：
    //
    //   ❌ 错的原写法（跑了好几天，是活的缺陷）：
    //        const isMust =
    //          afterCompaction === true ||     ← 安全绳②
    //          w.capped === "zero"
    //            ? false
    //            : ( …四条充分条件… );
    //
    //   ★ JS 里 `||` 的优先级**高于** `?:` ⇒ 它实际是
    //        (afterCompaction === true || w.capped === "zero") ? false : ( … )
    //     而 `afterCompaction === true` **压缩后恒为真** ⇒ 短路进 `?` 的 true 支
    //     ⇒ **`isMust` 恒为 `false`** ⇒ **压缩后一块正文都不注**。
    //
    //   ★★ 后果正好与**安全绳②的意图相反**：注释写"压缩后一律重注"，
    //      实际成了"压缩后一律**不**注" —— 而压缩恰恰是**最需要台账正文**的时刻
    //      （上下文刚被截短，正是 D136 步 3 写下这条绳子的理由）。
    //
    //   ★★★ 真机证据（`tools/_probe-d184-precedence.mjs`，同一份台账同一版代码）：
    //       `23:45:27` 压缩**前** ⇒ **11 块**；`23:54:28` 压缩**后** ⇒ **0 块**。
    //
    //   ⇒ 正解：**显式写成嵌套三元**，让 `afterCompaction` 单独成一支
    //     （与上面 7297 行那句"压缩后 ⇒ **全部块按必注处理**"逐字一致）。
    //     ⚠️ **不要**把它"简化"回 `||` 串联 —— 那正是这个 bug 的成因。
    const isMust =
      // ★ 安全绳 ②：压缩后一律重注（不靠权重判）—— **全部块**，含元数据那种
      afterCompaction === true
        ? true
        : // ★ 硬规则：元数据恒 0 ⇒ 永远只进目录（它就是"变更登记"那种）
          w.capped === "zero"
          ? false
          : // ★ 四条"必注"的充分条件
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

export function createLogCollector(ctx) {
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

export function rootFromExec(exec, args) {
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

export function renderResult(_args, value) {
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

export function noteLedgerTouched(state, exec, r) {
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

export function noteFlushed(state, exec) {
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

export function triageOwed(state, sid) {
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

export function hardMaintenanceGateOn() {
  return currentSettings().hardMaintenanceGate === true;
}

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

export function flushBeforeCompact(state, sid, info, opts) {
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
      // ★★★★★ 2026-10-13（D179 硬门）：**超时放行是"宽容阀"，硬门开时它不生效。**
      //   ★ 为什么这条要一起硬：它是 D59 之后加的"避免压缩永不发生"的兜底。
      //     硬门的语义恰是"**没做完就真的不发生**" ⇒ 两者**直接冲突** ⇒ 必须二选一。
      //   ★ 但**不删**它：`hardMaintenanceGate: false` 时它照旧生效（保留回退路）。
      if (overdue && !hardMaintenanceGateOn()) {
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
      // ★★★★★ 2026-10-13（D179 硬门）：**"连续拦 N 次就放行"是宽容阀 ⇒ 硬门开时不许放行。**
      //   ★★★ 判据方向**极容易写反**（我第一版就写成了 `!hardMaintenanceGateOn() && count < GIVEUP`，
      //     那等于"硬门开 ⇒ 跳过拦截 ⇒ 直接放行"，与意图**正好相反**）：
      //     这里 `if` 为真表示**拦截**，所以硬门开时必须让条件**恒真**。
      //   ⇒ 正确写法：`count < FLUSH_BLOCK_GIVEUP || hardMaintenanceGateOn()`
      //     （旧行为：没拦够 3 次就继续拦；硬门：**永远**拦）。
      const hard = hardMaintenanceGateOn();
      if (trec.count < FLUSH_BLOCK_GIVEUP || hard) {
        return {
          ok: false,
          missing: ["分流单"],
          // ★ 文案**按硬门分两套**：硬门开着还说"超过 20 分钟会放行"= **空承诺**，
          //   而模型一旦知道"反正会放行"，硬门就当场失效（本项目最忌的那类谎）。
          reason: hard
            ? "本项目在**反复追究**模式：压缩前要先做一次分流，而**这一轮还没做**。" +
              "用 `ledger_triage` 把这一段分成三个桶（`keep` 留上下文 / `stash` 落进项目 / " +
              "`drop` 丢掉），之后压缩会自动继续。" +
              "★★ **这是硬门：你不做，压缩就真的不会发生**（没有超时放行、也没有次数放行）。" +
              "⇒ 上下文会一直涨，直到撞上官方 80% 那次硬压 —— **那一次抓不到逐字胶囊**，" +
              "用户原话 / 报错原文 / 器物索引会一起丢。"
            : "本项目在**反复追究**模式：压缩前要先做一次分流，而**这一轮还没做**。" +
              "用 `ledger_triage` 把这一段分成三个桶（`keep` 留上下文 / `stash` 落进项目 / " +
              "`drop` 丢掉），之后压缩会自动继续。" +
              "★ 这是**义务不是建议**：不做，压缩就**一直不会发生** —— " +
              `超过 ${Math.round(numOf("triageOwedMaxAgeMs", TRIAGE_OWED_MAX_AGE_MS) / 60000)} 分钟插件才会带着` +
              "「这一轮没有分流单」的标注强行放行（那会丢掉 keep 桶的逐字注回）。",
          hint: "ledger_triage",
          blockedCount: trec.count,
          owedTriage: true,
          hardGate: hard,
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
  // ★★★★★ 2026-10-13（D179 硬门）：**这段是"宽容阀"，硬门开时不放行。**
  //   ★ 它存在的理由是 D59（怕闸门把压缩永久卡住）；而用户本轮明确要求
  //     *"模型不做完，压缩就不会生效"* ⇒ 硬门就是**主动接受那种风险**。
  //   ★ 但**不删代码**：`hardMaintenanceGate: false` 时它照旧生效（回退路完整）。
  const hard = hardMaintenanceGateOn();
  const rec = state.flushBlocked.get(key) ?? { count: 0 };
  rec.count += 1;
  rec.reason = "自上次压缩以来未落盘";
  state.flushBlocked.set(key, rec);
  if (!hard && rec.count >= FLUSH_BLOCK_GIVEUP) {
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
      "写一条 L1 摘要，之后压缩会自动继续（意图已退回队列，下一次空闲时重试）。" +
      (hard
        ? "★★ **这是硬门：你不落盘，压缩就真的不会发生**（没有次数放行、也没有超时放行）。" +
          "⇒ 上下文会一直涨，直到官方 80% 那次硬压 —— **那一次抓不到逐字胶囊**。"
        : ""),
    hint: "ledger_write",
    blockedCount: rec.count,
    hardGate: hard,
  };
}

/**
 * 取回并清空本会话攒下的"台账已改动"回执（弹卡片时调用）。
 */

export function takeTouched(state, sid) {
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

export function describeTouched(rec) {
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

export function renderTouchedForAi(rec) {
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

export function recentLedgerChanges(info, limit) {
  if (info.logAbs === undefined) return [];
  // ★★★★★ 2026-10-18（D255）：拆片后文件名会变成 `L0-ledger-changes-002.md`，
  //   而原来这里用的是 `/L0-ledger-changes\.md$/`（**`$` 锚定**）⇒ **新片一条都读不到**。
  //   ⇒ 改用 `logicalLogName` 剥掉 `-NNN` 再比 —— 以后再加更多片也不用改这里。
  const files = logFileList(info).filter((f) => logicalLogName(path.basename(f.rel)) === "L0-ledger-changes.md");
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

export function choiceOfLabel(label) {
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

export function measurePressure(ctx, agent) {
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

export function checkpointLedgerNote(info) {
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

export function checkpointNext(choice, info, received) {
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
    // ★★★★★ 2026-10-13（D174）：这一条原来写「**写完台账之后，请你立刻自己调一次
    //   `ledger_compact`**（`mode:"light"` 在回合内就能跑…你是这一档动作的执行者）」——
    //   那是 **D129**（轻量为主）的架构。用户 **D155** 已改成"**全量为主力、不在回复中直接压缩**"。
    //   ⇒ 用户选「记录台账 + 执行压缩」的**真实后果**是：写台账 ⇒ **本轮结束后插件自动做一次全量**
    //     （`runHighFidelityCompact`，见 `agent/status` 那条 idle 路）。
    //   ⇒ 分两支：增量开着 ⇒ 保留原文案（它就是那套架构的动作）；
    //            增量关着 ⇒ 说**如实**的话（你只管落盘，压缩由回合末接管）。
    "record+compact": [
      "用户选了「记录台账 + 执行压缩」。先用 `ledger_write` 把本轮进展写进活跃台账（" + ledgerNote + "）。",
      multiNote,
      logNote,
      " **必须先写台账再结束本轮**（压缩会清掉本轮上下文）。",
      currentSettings().incrementalCompact === true
        ? "★ **写完台账之后，请你立刻自己调一次 `ledger_compact`**" +
          "（`mode:\"light\"` 在回合内就能跑，不必等回合结束；你刚落盘，闸门必过）。" +
          "插件在你结束本轮后还会兜底补一次（安全网），但那**不该是你的替代品** —— 你是这一档动作的执行者。"
        : "★ **压缩不用你动手**：水位越过全量线时，**插件会在本轮结束后**做一次高保真全量压缩" +
          "（先抓逐字胶囊、压完连台账一起重注）。**你只要确保写完了台账，然后把这一轮做完。**" +
          "★ 不要为了压缩而在回复中途调 `ledger_compact`（轻量那条已冻结，不是常规动作）。",
    ].join(""),
    "record+handoff": `用户选了「记录台账 + 写交接单」。先用 \`ledger_write\` 写活跃台账（${ledgerNote}）。${multiNote}${logNote} 然后**必须**用 \`ledger_handoff\` 写交接单（**不要自己找地方写** —— 那个工具会落到项目的约定位置，新会话才知道去哪读）。写清：做了什么、当前状态、下一步、**关键文件的确切路径**、有没有卡点。`,
    unknown: `用户的选择没有对上四个选项（收到：${received ?? ""}）。请按最稳妥的方式继续：把本轮进展写进台账。`,
  }[choice];
}

/** 组一张四选一的卡片。两条路径共用，保证选项与 id 逐字一致。 */

export function checkpointQuestions(questionText) {
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

export function conformChoiceOf(label) {
  const s = typeof label === "string" ? label : "";
  if (s.includes("修复")) return "repair";
  if (s.includes("先给我看")) return "preview";
  if (s.includes("不用改")) return "skip";
  return "unknown";
}

/** 「建项目 or 不建」的选项标签 → 内部动作。 */

export function firstTurnChoiceOf(label) {
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

export function firstTurnNext(choice, info, received) {
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

export function offerConformChoice(ctx, state, agent, info) {
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
      // ★★★★★ 2026-10-19（D272 第三轮）：用户选了「不用改」⇒ **把这件事落盘**。
      //
      //   🔴 为什么要落盘（这是我自己埋的一个真缺陷）：
      //     注入里那句「**这是你本次开场必须主动处理的一件事**」是**每回合都写**的；
      //     而用户明确说了「不用改」之后，下一回合它**照旧命令模型去处理**
      //     —— 两条指令（"别再动结构" vs "你必须主动处理"）**直接打架，而且都出自我们**。
      //   ⇒ 落 `protocolDeclined`（时间戳）到清单，注入据此**降级成"现状陈述"**：
      //     照样每回合告知现状（不然模型会忘），但**不再催**。
      //   ★ 为什么用盘上的事实而不是进程内 Set：**跨重启也要记得**。
      //     用户说过一次不用改，不该因为重启就又被催一遍（他会被问烦的）。
      if (choice === "skip") {
        try {
          const mfPath = path.join(info.projectRoot, MANIFEST_REL);
          const cur = readManifest(info.projectRoot) ?? {};
          if (typeof cur.protocolDeclined !== "string" || cur.protocolDeclined === "") {
            cur.protocolDeclined = stamp(new Date());
            fs.writeFileSync(mfPath, `${JSON.stringify(cur, null, 2)}\n`, "utf8");
          }
        } catch {
          // 记不下就算了 —— 绝不因为"记不住拒绝"而把卡片流程搞崩。
        }
      }
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

export function conformNext(choice, info, conf, received) {
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

export function offerProjectChoice(ctx, state, agent, info) {
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

export function isLiveRootAgent(ctx, agent) {
  try {
    const agents = ctx.get("agents");
    if (agents === undefined || typeof agents.roots !== "function") return true;
    return agents.roots().includes(agent);
  } catch {
    return true;
  }
}

/**
 * ★★★★★ 2026-10-13（D176，用户拍板）：**这个会话是不是子代理会话**。
 *
 * 用户原话（逐字）：*"所有的子代理不用遵循插件，可以完全无视。他们是一次性的，
 * 之前有一个派了一大堆子代理的对话，饱受其苦。"*
 *
 * ★ 判据取自**内核自己**（不是我发明的）：`agent.session.header.parentSession`。
 *   实现在 `dsh-subagent/lib/index.js`（asar 内）—— 它做血缘校验时用的就是这一句：
 *   `if (activation.handle.agent.session.header.parentSession !== authority.parentSessionId)
 *      throw new SubagentError("… belongs to another parent session", "UNAUTHORIZED")`。
 *   ⇒ **子代理会话有 `parentSession`，root 会话没有** —— 这是官方语义，不是启发式。
 *
 * ★ 为什么优先用它、而不是 `isLiveRootAgent()`：
 *   `isLiveRootAgent` 依赖 `agents.roots()` 这个**服务**，取不到时它**返回 true**（保守）。
 *   对"豁免"这件事，那意味着"取不到服务 ⇒ 子代理照样被注入" ⇒ **豁免失效**。
 *   而 `header.parentSession` 是**会话数据自带的字段**，不依赖任何服务 ⇒ 更可靠。
 *
 * ★ 失败方向：读不到 header 时**返回 false（当 root 处理）** ——
 *   宁可子代理多收一次，也**绝不能**因为读不到字段就让用户的 root 会话失去记忆。
 */

export function isSubagentSession(agentOrSession) {
  try {
    // ★ 同时接受 **agent**（`agent.session.header`）与 **session**（`session.header`）：
    //   `session/event` 那条链手里**只有 session**，没有 agent（见它的处理器签名）。
    //   ⇒ 若只认 agent，日志与胶囊那两处就**判不了**，豁免又漏掉两条路。
    const header =
      agentOrSession?.session?.header ?? agentOrSession?.header ?? undefined;
    const parent = header?.parentSession;
    return typeof parent === "string" && parent !== "";
  } catch {
    return false;
  }
}

/**
 * ★★★★★ 2026-10-13（D176）：**本插件是否该管这个会话**（唯一出口）。
 *
 * ★ 为什么要收成一个出口：豁免必须**穷尽**（注入 / 日志 / 胶囊 / 义务记账 / 压缩旁听），
 *   而每处各写一套判据 ⇒ 必然在某条路上漏掉（本项目反复栽的"两处各写一份"）。
 *   ⇒ 所有入口统一问这一个函数，将来加新入口也只需问它。
 *
 * ★ 判据 = **不是子代理会话**（`header.parentSession` 为空）。
 *   ★ 刻意**不**在这里叠 `isLiveRootAgent()`：那个函数取不到服务时返回 true（保守方向对
 *     "弹卡片"是对的），但对"是否管这个会话"它不够硬；而 `parentSession` 是自带的。
 */

export function shouldHandleSession(agentOrSession) {
  return !isSubagentSession(agentOrSession);
}

/**
 * ★★★★★ 2026-10-18（D242，用户当场指出的真漏洞）：**义务"过期"判定** —— 用序号比先后，不用工具白名单。
 *
 * ── 病（用户原话，逐字）────────────────────────────────────────────────
 *   *"如果模型因为觉得已经到了转折点，主动进行了一次义务，然后又进行了一批工作，
 *   这种时候又怎么判断呢？"*
 *
 *   旧判据只有 `rec.wrote` / `rec.triaged` 两个**一次性置真的布尔** ⇒
 *   「写台账 → 又干了一批活 → 回合结束」这一整圈里，**后半批活根本没写进台账**，
 *   但判据仍报"已兑现" ⇒ **不抽** ⇒ 那段进展成为唯一副本（正是本项目最怕的事）。
 *
 * ── 实测证据（官方会话日志，seq 严格递增已验证 5,579 条 / 逆序 0）──────
 *   `seq 241 ledger_write → seq 260 edit` · `seq 247 ledger_write → seq 260 edit`
 *   `seq 255 ledger_triage → seq 260 edit` · `seq 285 ledger_write → seq 287 grep`
 *   ⇒ 「义务在前、干活在后」是**真实发生过的**，不是假想。
 *
 * ── 判据（用户拍板：比时间点，不维护名单）──────────────────────────────
 *   `tool/call` 事件带**全局严格递增的 `seq`** ⇒ 拿它当时间轴：
 *     · `writeSeq` / `triageSeq` = **上一次**真正写台账 / 分流时的 seq；
 *     · `lastNonLedgerSeq` = **上一次非 `ledger_*` 工具**的 seq（= "又干了活"）。
 *   ⇒ **`lastNonLedgerSeq > writeSeq` ⇒ 台账过期**（写完还没记新活）；
 *      `lastNonLedgerSeq > triageSeq` ⇒ 分流过期。
 *
 * ★★ 为什么用「**非 `ledger_*`**」而不是"改工作区的工具名单"：
 *   名单会过期（以后装新插件就有新工具，本项目已栽过 B8「文件索引是白名单」）。
 *   而 `ledger_*` 是**我们自己的前缀**，永远不会变 ⇒ **零维护**。
 *   ★ 而且它顺手解决了误判：写完台账顺手 `ledger_status` 查一下**不算又干活**。
 *
 * ★ 为什么 `ledger_triage` 不覆盖 `writeSeq`：分流**不写台账正文**。
 *   若把它也算成"覆盖"，`写(100) → 改文件(101) → 分流(102)` 这一串会被误判成"已兑现"，
 *   而 101 那批改动**从没进过台账**。
 *
 * @param {object} rec `state.turnObligation` 里本回合那条记录
 * @returns {{missingWrite:boolean, missingTriage:boolean, wroteStale:boolean,
 *            triagedStale:boolean, ok:boolean, lastNonLedgerSeq?:number}}
 */

export function obligationGaps(rec) {
  const wrote = rec?.wrote === true;
  const triaged = rec?.triaged === true;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const last = num(rec?.lastNonLedgerSeq);
  const wSeq = num(rec?.writeSeq);
  const tSeq = num(rec?.triageSeq);
  // ★ 取不到序号 ⇒ **不判过期**（宁可漏抽，不可误抽 —— 与 recordOwed 同一条口径）。
  const wroteStale = wrote && last !== undefined && wSeq !== undefined && last > wSeq;
  const triagedStale = triaged && last !== undefined && tSeq !== undefined && last > tSeq;
  return {
    missingWrite: !wrote,
    missingTriage: !triaged,
    wroteStale,
    triagedStale,
    ok: wrote && triaged && !wroteStale && !triagedStale,
    lastNonLedgerSeq: last,
  };
}

/**
 * ★★★★★ 2026-10-17（D241，用户拍板）：**回合末真的抽一次** —— 把"提醒"变成"执行"。
 *
 * 用户原话（逐字）：*"就算你再怎么提示，再怎么强调模型也会不去做这件事，所以就会很难受。"*
 * 以及他对本方案的裁决：*"默认为一次，由用户自行定义，到底要不要抽？
 * 是零还是一还是二还是三还是一直循环，在设置面板中体现。"*
 *
 * ── 为什么这条路走得通（读内核源码得出的，不是猜）────────────────────────
 * 官方 `dsh-agent/README.zh.md:68` 逐字：
 *   *"`agent/turn-stopping` 在本可完成的轮次关闭前运行，**并可通过 steer 使其保持打开**。"*
 * 内核 `dsh-agent-loop\lib\index.js:1001-1008` 就是那个窗口：
 *   ```js
 *   if (turnEnds && this.inbox.nextStep.length === 0) {
 *       await this.dispatch.serial("agent/turn-stopping", { turn, signal });
 *       signal.throwIfAborted();
 *   }
 *   if (turnEnds && this.inbox.nextStep.length === 0) break;   // ← 再查一次
 *   ```
 * ⇒ 在钩子里 `steer()`（= 往 `next-step` 塞一条）⇒ 第二个判断不成立 ⇒ 回合不关。
 * ★ 这与"提醒文案"是**两件事**：提醒在**回合开头**说话，模型看一眼就过去了（实测 47% 漏做）；
 *   这个是**回合即将关闭那一刻**的一次真检查。
 *
 * ── 三条安全边界（缺一条就是灾难）──────────────────────────────────────
 * ① **预算**：`turn-stopping` 在 while 循环里每一步都跑 ⇒ 不加预算就是无限自唤醒。
 *    按 `turn` 号记账，同回合最多 `turnEndPull` 次。★ 形态照抄官方
 *    `dsh-tool-jobs:284-296`（`maxConsecutiveWakes`：花光就降级成 `inject()`）。
 * ② **不侵占"下次唤醒"**：模型自己设的定时/后台任务是 `followup()`（写 `next-turn`），
 *    我们写 `next-step` —— 两条队列（`dsh-agent-loop:801-815`），
 *    ★ 所以**不会互相覆盖、不会把它的任务挤掉**。代价只是"先多跑一步再关回合"。
 * ③ **绝不卡死工作**：抽满就**放行并记 owe**（`recordOwed` 已有），不硬拦。
 *    ★ D59 前科：硬拦曾让压缩**近 4 小时一次没发生**。代价必须由"多花一轮"承担，
 *      不能由"用户干不了活"承担。
 *
 * @returns {{pulled:boolean, reason?:string, n?:number}} 仅用于自检与观测，调用方不依赖
 */

export function pullTurnEndObligation(ctx, state, agent, turn) {
  try {
    // ── 边界一：开关与预算都从**设置**来（用户可 0/1/2/3/5）──────────────
    const budget = numOf("turnEndPull", 1);
    if (!(budget > 0)) return { pulled: false, reason: "off" };
    if (!shouldHandleSession(agent)) return { pulled: false, reason: "subagent" };
    const sid = agent?.session?.header?.id;
    if (typeof sid !== "string" || sid === "") return { pulled: false, reason: "no-session" };
    const key = String(sid);

    // ── 边界二：**没有台账就不该有义务**（D231b 定下的判据）──────────────
    //   ★ 与"记欠账"同一条口径：用户可能只做问题记录、或压根没建项目 ⇒
    //     那时催"写台账"是**无意义的自我矛盾**（用户原话："甚至有时候会陷入自我矛盾中"）。
    const root = projectRootOf(agent);
    if (typeof root !== "string") return { pulled: false, reason: "no-root" };
    let hasLedger = false;
    try {
      hasLedger = inspect(root).activeRel !== undefined;
    } catch {
      hasLedger = false;
    }
    if (!hasLedger) return { pulled: false, reason: "no-ledger" };

    // ── 边界三：本回合义务**已经兑现，且没有过期** ⇒ 什么都不做（安静）─────
    //
    // ★★★★★ 2026-10-18（D242，用户当场指出的漏洞）：判据从"两个布尔"升级成
    //   `obligationGaps()` —— 它比的是**序号先后**，不是"做过没有"。
    //   用户原话（逐字）：*"如果模型因为觉得已经到了转折点，主动进行了一次义务，
    //   然后又进行了一批工作，这种时候又怎么判断呢？"*
    //   ⇒ 旧判据在那种场景下报"已兑现" ⇒ **不抽** ⇒ 后半批活从没进台账。
    //   ★ 现在：`lastNonLedgerSeq > writeSeq` ⇒ 台账**过期** ⇒ 仍然要抽一次。
    const rec = state.turnObligation.get(key);
    const gaps = obligationGaps(rec);
    if (gaps.ok) return { pulled: false, reason: "done" };

    // ── 预算记账：同一 turn 号最多抽 budget 次（换回合就重来）─────────────
    const spent = state.turnEndPullSpent.get(key);
    const n = spent !== undefined && spent.turn === turn ? spent.n : 0;
    if (n >= budget) return { pulled: false, reason: "budget", n };

    // ★ 文案要**如实说明是哪一种**：没做 / 做了但过期（后又干了一批活）。
    //   ★ 这两件事对模型的指令不同：前者"现在去做"，后者"你做过，但之后又改了东西，要补记"。
    const missing = [];
    if (gaps.missingWrite) missing.push("ledger_write（这一轮的进展还没写进台账）");
    else if (gaps.wroteStale)
      missing.push(
        "ledger_write（你写过台账，但**之后又做了一批工作**，那部分还没记进去 ⇒ 请补记增量）"
      );
    if (gaps.missingTriage) missing.push("ledger_triage（分成 keep / stash / drop 三个桶）");
    else if (gaps.triagedStale)
      missing.push("ledger_triage（上次分流**之后又有了新进展** ⇒ 请重分一次）");

    state.turnEndPullSpent.set(key, { turn, n: n + 1 });

    // ★ `source.kind` **绝不能是 `user`**：
    //   官方 `dsh-tool-jobs:233` 用 `message.source.kind === "user"` 判定"用户真说话了"
    //   来**重置别人的自唤醒预算** ⇒ 我们冒充 user 会把人家那条安全阀冲掉。
    //   官方原注释也写明：省略 source 会解析成 `user`，非人类生产者必须自带 source。
    agent.steer({
      id: randomUUID(),
      content: [
        {
          type: "text",
          text:
            `${TURN_END_PULL_PREFIX}这一轮**即将关闭**，但有收尾义务还没做：\n` +
            `· 缺：${missing.join("；")}\n` +
            `★ 这是**插件在回合末实检**发现的（不是提醒，不是建议）。请现在就地补完：\n` +
            `  ① 若这一轮确有进展 ⇒ \`ledger_write\`（带 \`mode:"append"\` + \`ifRevision\`）；\n` +
            `     若确实没有值得记的 ⇒ 也写一条「本轮无实质更新」的记号（这是**变相履行**，不是免做）。\n` +
            `  ② \`ledger_triage\` 分三个桶（keep 留上下文 / stash 落项目 / drop 丢掉）。\n` +
            `★ 做完就直接继续原来的工作，不必向我汇报这件事本身。\n` +
            `★ 这是本回合第 ${n + 1}/${budget} 次唤醒；到上限后插件**不会再抽**，只会记欠账放行。`,
        },
      ],
      source: { kind: INJECT_KIND, form: "instructions" },
      role: "user",
    });
    return { pulled: true, n: n + 1, missing };
  } catch {
    // ★ 抽起失败**绝不许影响回合关闭** —— 它只是"多一次机会"，不是主流程。
    return { pulled: false, reason: "error" };
  }
}

/**
 * ★★★★★ 2026-10-18（D244，用户拍板「我们自己全程接管」）：**回合内压缩**的纯判据。
 *
 * 用户原话（逐字）：*"如果遇到一个非常长的工作，则工作到准备接近压缩线的时候，
 * 强制进行这些义务，然后进行一次强制的全量压缩，压缩完之后模型接着工作，
 * 整个过程不需要任何操作。"*
 *
 * ── 为什么这件事"能做成"（读内核源码得出的，不是猜）──────────────────────
 * 内核**自己**就是在回合中途压的 —— `dsh-compaction-basic:840-853`：
 *   ```js
 *   ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
 *       const result = await this.compactIfNeeded(agent, "pressure", signal);  // ← 每步之前
 *       return next();
 *   });
 *   ```
 * 而它内部调的是 `this.compactRegion(...)`（`:957`），后者硬编 `owner:"current-turn"`（`:974`）。
 * ⇒ ★ **`compactRegion` 就是"回合内全量压缩"的官方入口**；
 *   此前我们一直以为"全量必须回合末"，那是 `compactNow`（要求 idle）的限制，**不是它**。
 *
 * ── 为什么必须"先做义务、再压、再继续"三步而不是一步 ──────────────────
 * 压缩会丢掉逐字历史 ⇒ 没落盘的那段进展就是**唯一副本**（D47 铁律）。
 * 所以顺序不能换：**义务 → 压缩 → 继续**。
 *
 * ── 四条边界（缺一条就是灾难）────────────────────────────────────────
 * ① **一次只走一步**：`steer` 让本回合多跑一拍，那一拍做完又回 pre-step ⇒
 *    ★ 不加状态就会"抽起-压缩"死循环。⇒ `phase` 三态 + `done` 必须等**水位掉回线下**才清。
 * ② **不能与内核抢**：内核的 pre-step 在**我们 `next()` 之后**跑完 ——
 *    所以我们的判断必须放在 `await next()` **之后**，且压之前再量一次水位
 *    （内核可能已经压过了）。
 * ③ **绝不卡死**：压失败就退回"等回合末"那条老路（`hfCompactAfterTurn`），
 *    并**如实告诉用户**，不静默吞掉。★ D59 前科在这里同样适用。
 * ④ **算不出来就不压**：水位/范围任一取不到 ⇒ 什么都不做（宁可晚一次）。
 *
 * @param {{enabled:boolean, phase:string|undefined, ratio:number|undefined,
 *          line:number, gapsOk:boolean, urgent?:number}} x
 *          ★ `urgent`（D265）：水位到这个值就不再节流（78% 紧急线）。
 * @returns {{act:"none"|"pull"|"compact"|"wait", why:string}}
 */
export function midTurnCompactGate(x) {
  if (x?.enabled !== true) return { act: "none", why: "off" };
  const ratio = x.ratio;
  const line = x.line;
  // 量不到水位 / 线没配 ⇒ 不猜（宁可晚一次）
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return { act: "none", why: "unmeasurable" };
  if (typeof line !== "number" || !Number.isFinite(line)) return { act: "none", why: "no-line" };
  // 水位没到线 ⇒ 什么都不做（长回合的大部分时间都走这一支）
  if (ratio < line) {
    // ★ 掉回线下 ⇒ 本回合的"已压过"标记可以清了（下一轮涨上来还能再压）。
    return { act: "none", why: "below-line" };
  }
  // 正在压（防重入）⇒ 等
  if (x.phase === "pressing") return { act: "wait", why: "pressing" };
  // 本回合已经压过、而且水位还没掉回线下 ⇒ 等（防连环重压）
  if (x.phase === "done") return { act: "wait", why: "already-done" };
  // ★★★★★ 2026-10-18（D265）：**本回合已经失败过 ⇒ 这一回合不再试**。
  //
  //   🔴 病（故障报告 007 §8.1）：原来失败就把相位删掉（"让下一次还能试"）——
  //     而 `pre-step` **每个 step 都跑** ⇒ "下一次"= 几秒到几十秒后。
  //     真机实测连试 4 次（间隔 21s / 21s / 27s），而每次失败收尾都在 `turn/end`
  //     之后落盘 ⇒ **每多试一次，就多写出一条可能的坏档**。失败本身是允许的，
  //     **几秒后重试的那个放大器才是病**。
  //
  //   ★ 为什么"不删相位"就等于"隔一个回合"：`turn/end` 那条路本来就会
  //     `state.turnCompact.delete(key)`（D246 的修复）⇒ 下一回合开始时相位是干净的。
  //     用**已有的生命周期**做节流，不引入计时器（计时器会带上时钟漂移这类新失败面）。
  //
  //   ★★ 必须配例外：水位到 `urgent`（78%）就**不再等** —— 否则等于把机会让给
  //     内核 80% 那次抓不到逐字胶囊的硬压（用户最在意的正是"逐字可回读"）。
  //     ★ 但紧急旁路**不豁免「先落盘」**：下面 `gapsOk` 那条仍然在前面拦。
  if (x.phase === "failed") {
    const urgent = typeof x.urgent === "number" && Number.isFinite(x.urgent);
    const over = urgent && typeof ratio === "number" && ratio >= x.urgent;
    if (!over) return { act: "wait", why: "failed-this-turn" };
  }
  // 已抽起等义务 ⇒ 等模型那一步做完（它做完会再回到这里）
  if (x.phase === "owed") return { act: "wait", why: "awaiting-owed" };
  // 到线了、义务还没做 ⇒ 先抽起做义务
  if (x.gapsOk !== true) return { act: "pull", why: "owed-first" };
  // 义务已做 + 到线 ⇒ 压
  return { act: "compact", why: "ready" };
}

/**
 * ★★★★★ 2026-10-18（D244）：**在回合内真做一次「先补义务 → 全量压缩 → 继续」**。
 *
 * 分工：本函数只负责**推进状态机**；真正的压缩交给 `runTurnCompact`（part5，用 `compactRegion`）。
 * ★ 为什么把压缩本身放 part5：那里已有 `pushHfSource` / 胶囊 / 记账全套，
 *   重写一遍就是"两处各一份"（本项目反复栽的那个坑）。
 *
 * @returns {{act:string, why:string, compacted?:boolean, reason?:string}}
 */
export async function runMidTurnCompact(ctx, state, agent, deps) {
  try {
    const sid = agent?.session?.header?.id;
    if (typeof sid !== "string" || sid === "") return { act: "none", why: "no-session" };
    if (!shouldHandleSession(agent)) return { act: "none", why: "subagent" };
    const key = String(sid);
    const s = currentSettings();
    if (s.midTurnCompact !== true) return { act: "none", why: "off" };

    const pressure = deps?.pressure ?? measurePressure(ctx, agent);
    const ratio = pressure?.ratio;
    const line = s.highFidelityCompactRatio;
    const rec = state.turnObligation.get(key);
    const gapsOk = obligationGaps(rec).ok === true;

    const held = state.turnCompact.get(key);
    // ★ 水位掉回线下 ⇒ **清掉本回合的"已压过"**，让下一轮涨上来还能再压一次。
    //   ★ 与 `hfCompacted` 的重新武装**同一条设计**（D129）：
    //     只有掉回去才说明上一轮真的生效了；只看时间会让它在水位仍高时反复排队。
    if (held !== undefined && typeof ratio === "number" && ratio < line) {
      state.turnCompact.delete(key);
    }
    const gate = midTurnCompactGate({
      enabled: true,
      phase: state.turnCompact.get(key)?.phase,
      ratio,
      line,
      gapsOk,
      // ★ D265：在 78% 紧急线之上不再节流（否则等于把机会让给内核那次抓不到胶囊的硬压）。
      //   ★ 复用常量、**不写裸数字** —— 两处各写一个 0.78 就是下一场分叉（判据 105⑦ 守着）。
      urgent: FULL_COMPACT_URGENT_RATIO,
    });

    // ★★★★★ 2026-10-20（诊断，用户选中方案 A）：**把 gate 的判定结果打出来**。
    //
    //   🔴 为什么要打（真机事实，不是猜测）：实测 `compaction/start` 34 次里，
    //      **回合内只有 8 次**，且全部集中在 turn 35 / 87 / 97 / 98；
    //      当前 turn 149 ⇒ **之后 51 个 turn 一次都没再发生**。
    //      而义务是做完的（每次压缩前 8~26 个 seq 都有 ledger_write + ledger_triage）
    //      ⇒ **不是卡在 `owed-first`**。嫌疑落在 `state.turnCompact` 的相位（尤其 `failed`）。
    //      ★ 但相位是**内存态**，日志里看不到 —— 所以必须让它自己说出来。
    //
    //   ★ 位置选在**六个分支的汇合处**（gate 刚算完、还没分派），一处覆盖全部，
    //     不用在六个 return 前各写一遍（那就是"两处各一份"的雏形）。
    //
    //   ★★ 防水位爆炸：`pre-step` 每 step 都跑 ⇒ 每步都打会淹没日志。
    //     ⇒ 判据：**水面下只在"判定变化"时打**（进入/退出 below-line 各一次）；
    //       **水面上（ratio ≥ line）每次打** —— 那才是关键窗口，条数有限。
    //     用 `state.midTurnDbg` 记上一次的 act/why（**只用于诊断，不参与任何判定**）。
    try {
      const prevDbg = state.midTurnDbg?.get(key);
      const sig = `${gate.act}/${gate.why}`;
      const aboveLine = typeof ratio === "number" && typeof line === "number" && ratio >= line;
      const changed = prevDbg === undefined || prevDbg.sig !== sig;
      if (aboveLine || changed) {
        const pct = (v) => (typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "?");
        const held = state.turnCompact.get(key);
        const gaps = rec === undefined ? "无记录" : `wrote=${rec.wrote === true} triaged=${rec.triaged === true}`;
        // ★ logger 自己抛错绝不许污染主流程 —— 诊断是观察者，不是参与者。
        try {
          ctx?.logger?.warn?.(
            `[midturn] act=${gate.act} why=${gate.why} phase=${held?.phase ?? "none"} ` +
              `ratio=${pct(ratio)} line=${pct(line)} turn=${deps?.turn ?? "?"} ` +
              `gapsOk=${gapsOk} (${gaps}) heldAt=${held?.at ?? "-"} heldReason=${held?.reason ?? "-"}`
          );
        } catch {
          /* 日志本身失败 ⇒ 忽略（绝不因为打日志把压缩搞坏） */
        }
        if (state.midTurnDbg === undefined) state.midTurnDbg = new Map();
        state.midTurnDbg.set(key, { sig, at: Date.now() });
      }
    } catch {
      /* 诊断的任何异常都不许外溢 */
    }

    if (gate.act === "none" || gate.act === "wait") return { act: gate.act, why: gate.why };

    if (gate.act === "pull") {
      // 先立相位**再**抽起：抽起之后那一拍会立刻回到这里，
      // 若相位还没写上，它会**又抽一次**（正是本功能最容易犯的错）。
      state.turnCompact.set(key, { phase: "owed", at: Date.now(), ratio });
      const r = pullTurnEndObligation(ctx, state, agent, deps?.turn ?? 0);
      // ★ 抽不起来（例如预算已用完）⇒ 别把相位卡在 "owed"（那会让本回合永远等下去），
      //   直接放行到"压" —— 义务做不了不能连带让压缩也不发生（D59 的教训方向）。
      if (r.pulled !== true) {
        state.turnCompact.set(key, { phase: "pressing", at: Date.now(), ratio });
        if (typeof deps?.runTurnCompact === "function") {
          // ★ D257：必须 await —— `compactRegion` 用全表面判据，摘要期间 surface 一动就废。
          //   详见 index.js 里 `runTurnCompact` 那段长注释（内核源码证据在那里）。
          return await deps.runTurnCompact();
        }
        return { act: "pull", why: "pull-failed-then-compact" };
      }
      return { act: "pull", why: gate.why };
    }

    if (gate.act === "compact") {
      if (typeof deps?.runTurnCompact !== "function") return { act: "compact", why: "no-runner" };
      // 先立 `pressing` **再**调：runner 是异步的（摘要几十秒），
      // 而 pre-step 会一拍一拍回来 —— 不立相位就会**并发压两次**（撞 assertNoActiveCompaction）。
      state.turnCompact.set(key, { phase: "pressing", at: Date.now(), ratio });
      const out = await deps.runTurnCompact();
      // ★★★ runner 有两种形态，**必须都认**（这一条我第一版写漏了）：
      //   ① 同步返回 `{compacted:true}`（自检 / 未来可能的同步实现）；
      //   ② 返回 `{reason:"async-started"}`（真实预置：压缩在后台跑，结果回来再写相位）
      //      ⇒ 此时**不许**清相位 —— 清了就等于允许它再来一次，会并发压。
      if (out?.compacted === true) {
        state.turnCompact.set(key, { phase: "done", at: Date.now(), ratio });
        return { act: "compact", why: "ok", compacted: true };
      }
      if (out?.reason === "async-started") {
        return { act: "compact", why: "started", compacted: undefined };
      }
      // ★★★★★ 2026-10-18（D265）：**不许删相位** —— 改写成 `failed`。
      //
      //   🔴 原来这里写 `state.turnCompact.delete(key); // 没压成 ⇒ 清相位，让下一次还能试`
      //      —— 注释里那句「让下一次还能试」**就是病**：`pre-step` 每个 step 都跑，
      //      "下一次" = 几秒到几十秒后。真机实测连试 4 次（21s/21s/27s），
      //      而每次失败的收尾都在 `turn/end` **之后**落盘 ⇒ 每试一次多一个坏档窗口。
      //
      //   ★ 改写成 `failed` 之后，`midTurnCompactGate` 会一直 `wait` 到本回合结束；
      //     而 `turn/end` 本来就会清掉这个相位 ⇒ **天然的「隔一回合再试」**。
      //     ★ `ratio` 一起记下来：78% 紧急线那支要用当前水位，但记着便于事后排查。
      state.turnCompact.set(key, { phase: "failed", at: Date.now(), ratio, reason: out?.reason });
      return { act: "compact", why: "failed", compacted: false, reason: out?.reason };
    }

    return { act: "none", why: "unreachable" };
  } catch {
    // ★ 回合内压缩失败**绝不许影响模型干活** —— 它只是"更好的时机"，不是主流程。
    return { act: "none", why: "error" };
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

export function describePressureForUser(pressure) {
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

export function offerTurnEndChoice(ctx, state, agent) {
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

export function defineCompactTool(ctx, state, capsule) {
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
    // ★★★★★ 2026-10-13（D174）：这段描述必须与 D155 架构一致，**但不能"在注册时读设置"**。
    //
    //   ★★★ 我先写成"按 `currentSettings()` 分支"——**当场自己否掉**：
    //     工具描述是**注册时算一次**的常量（本函数只在挂载时跑），而 `incrementalCompact`
    //     是**运行时可变**的设置 ⇒ 用户在面板上改一次，这段描述就**永远停在旧架构上**。
    //     那正是本文件反复栽的"**同一个事实两个出处**"（D170 的判据）——只是换了个位置。
    //
    //   ⇒ 正解：**描述写成中性、永远为真**（两种模式都如实描述，**不推荐任何一种**），
    //     把"现在哪一种是常规"**只交给注入合同**去说 —— 那段是**每次渲染时现算**的
    //     （`renderInjectionBody`），天然不会过期。★ 单一出处。
    description:
      "Compact this conversation's history so you can keep working with a long context. " +
      "TWO modes exist:\n" +
      "• mode=\"full\" (default when omitted): a HIGH-FIDELITY whole-conversation compaction " +
      "that must wait for the agent to be idle (end of turn). It first captures a VERBATIM " +
      "capsule (the user's own words, error strings, the artifact index of changed files, and " +
      "the paths to re-read) and re-injects it afterwards.\n" +
      "• mode=\"light\": compresses only the OLDEST segment, keeping the recent head intact. " +
      "It runs IN-TURN via `compactRegion` (no need to wait for the turn to end).\n" +
      "★ WHICH mode is routine depends on the plugin's current configuration — the injected " +
      "project-ledger instructions tell you which one applies and when to act. **Follow those " +
      "instructions** rather than assuming either mode.\n" +
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
            "\"full\" = high-fidelity whole-conversation compaction, run when the agent is idle " +
            "(end of turn). \"light\" = compress only the oldest segment, in-turn. " +
            "Which one is routine depends on the current configuration (see the injected " +
            "project-ledger instructions).",
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

export function defineCheckpointTool(ctx, state) {
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

export function defineStatusTool(ctx, state) {
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