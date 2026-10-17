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
 *   ④ 落地   —— 给 AI **二十一个工具**，让它按自己设计的结构读写台账
 *   ⑤ 归档   —— 活跃台账超阈值 ⇒ 把 AI 点名的旧条目移进 archiveDir/YYYY-MM/weekN
 *   ⑥ Git    —— git init + 合并式 .gitignore + `git add -- <明确路径>`（绝不 add -A）
 *   ⑦ 命令   —— /ledger（裸敲弹选择卡片）| status | show | init | update | archive |
 *                compact | light | log | principles | mode | lock | handoff
 *   ⑧ 日志   —— 可选的活动日志（L0 里程碑 / L1 回合摘要 / L2 文件流水 / L3 工具流水 /
 *                L4 用户原话逐字存档），**永不注入上下文**，按周分桶且与归档共用期间键
 *   ⑨ 问题记录 —— 给"不是项目、只是一次性问题/调研"的那一类。落到工作区既有的记录通道，
 *                **不是台账**、没有归档。
 *   ⑩ 重构   —— 检测**已存在**项目的台账是否合规；不合规时弹卡片问要不要改，
 *                修复**只做加法**（补清单字段、补缺失的空文件/空目录），绝不改写已有内容
 *   ⑪ 搬家   —— `ledger_migrate`：`conform` 的反面（把"历史"从状态文件里搬出去、
 *                把决策拆成卡片、给旧卡片补新字段）—— 同样是显式动作 + 用户确认
 *   ⑫ 卡片化 —— `decisions/` · `goals/` · `lessons/` 都是**一卡一文件**；
 *                `ledger_index` 给卡片目录生成多维索引表（**权威永远是卡片本身**，索引只是缓存）
 *   ⑬ 记忆类别 —— 活跃台账 / 回合流水 / 决策 / 目标树 / 根本原则 / 经验与教训，
 *                各自一个文件或目录（**语义不同 ⇒ 分开放**，表见 README 与台账 §七）
 *   ⑭ 回合末 —— agent/turn-stopping 自动给出四选一（不阻塞回合）
 *   ⑮ 第一轮 —— 会话第一轮结束时先弹「建项目 or 不建」（也是一次性、只问一次）
 *   ⑯ 压缩前 —— `compaction/start` ⇒ **那一瞬间抓「压缩前胶囊」**（此时历史还完整；
 *                官方那次也一样抓 —— D215 的 27 秒窗口）
 *   ⑰ 压缩后 —— compaction/end ⇒ 台账 + 逐字胶囊强制重注并提示（**失败的不冒充成功**）
 *   ⑱ 回执   —— AI 写完台账后，**下一次弹卡片时告知用户**改了什么、哪个会话改的
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
// ★ 2026-10-14（D196）：读自己的 `package.json` 取版本号要它。
//   ⚠️ 我第一版**直接用了 `fileURLToPath` 却没 import** —— 纪律 9 那条
//   （"函数名看起来最硬，却最容易凭印象编"）的又一次现形：**用之前先 grep 一次**。
import { fileURLToPath } from "node:url";

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

/** 插件 id。★ 必须与 package.json 的 name、cordis.patch.yml 里的 id 三处一致。 */
import { CHECKPOINT_TOOL, INJECT_KIND, PRINCIPLE_GRANT_TOOL, SETTINGS_SNAPSHOT_MARK, blockSnapshots, fingerprintOf, name, newState, setActiveSettings } from "./defs.js";
import { compactVsInject, compactionEndSucceeded, currentSettings, hydrateCapsuleMemory, owedFor, persistCapsuleMemory, recordOwed, recordShadowedIndex, renderShadowedIndex, settingsOf, tagOfId, writeCapabilityManifest } from "./part1.js";
import { archiveEvictedUserMessage, createCapsuleMemory, createCapsulePersister, defineGoalsTool, defineLessonsTool, definePrinciplesAccessTool, defineProposePrincipleTool, deriveSettingsView, inspect, installSettingsRoutes, isFreshProject, lossless, projectRootOf, projectRootOfSession, renderCapsule } from "./part2.js";
import { commitSettingsBaseline, createLogCollector, defineCheckpointTool, defineCompactTool, defineStatusTool, hardMaintenanceGateOn, measurePressure, offerConformChoice, offerProjectChoice, offerTurnEndChoice, renderCompactInjection, renderInjection, renderPressureNotice, renderTouchedForAi, shouldHandleSession, takeTouched } from "./part3.js";
import { defineArchiveTool, defineConformTool, defineHandoffTool, defineIndexTool, defineInitTool, defineLockTool, defineMigrateTool, defineNoteTool, defineReadTool, defineWriteTool } from "./part4.js";
import { armReinject, captureCapsuleBeforeCompact, defineLogTool, defineLogWriteTool, defineRecallTool, defineTriageTool, handleLedgerCommand, ledgerCommandDescription, ledgerInputHint, peekHfSource, popHfSource, runHighFidelityCompact, runIncrementalCompact } from "./part5.js";

export { name, inject, Config, __test } from "./defs.js";

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

  // ── ★★★★★★ 2026-10-14（D196）：**把"本版本有哪些能力"落盘成功能清单** ──────
  //
  //  用户原话（逐字）：*"每个使用我们插件的都维护一个小的功能清单，不然的话你插件更新之后，
  //  其他对话都不知道……**不要把文件混杂到别人项目的文件里面**。"*
  //
  // ★ 落在 `$DSH_HOME\plugin-data\dsh-ledger-memory\capabilities.json` —— **插件的家**，
  //   不进任何用户项目（用户的硬约束，且与 `locks.json`/`anchors.json` 等既有惯例同处）。
  // ★ 时机：`apply()` 里做一次（插件每次被加载就是一次"版本可能变了"的时机）。
  //   ★ 幂等：内容（掐掉时间戳后）没变就不重写 ⇒ 不产生无谓 IO。
  // ★★ **写失败绝不抛**（与锁/锚点同一口径）：清单存不下来不该让插件起不来。
  //   —— 而且**真正的交付通道是注入**（`renderUnenabledCapabilities`），
  //     文件只是给人/给别的工具看的持久副本；就算它没写成功，模型那边照样收得到。
  try {
    const capInfo = writeCapabilityManifest();
    // ★ 用 **debug** 而不是 info：这是**例行**动作（每次加载都做，且幂等），
    //   不是需要人看的警告。★ 自检当场抓到了这一点（"无注册警告"那条变红）——
    //   它是对的：插件加载时不该往日志里倒例行信息。
    ctx.logger?.debug?.(
      `${name}: 功能清单 ${capInfo.written ? "已更新" : "无变化"}（${capInfo.count} 项 · ` +
        `版本 ${capInfo.version ?? "未知"} · ${capInfo.path}）`
    );
  } catch {
    /* 清单写失败不影响插件加载 */
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
    // ★ 2026-10-14（D199）：**减法/搬家**那一半（`conform` 只做加法）。
    ["ledger_migrate", defineMigrateTool],
    // ★ 2026-10-14（D202，用户拍板）：**多维索引表**（卡片目录用；D136 的秩融合原样复用）。
    ["ledger_index", defineIndexTool],
    ["ledger_propose_principle", () => defineProposePrincipleTool(state)],
    // ★★★★★ 2026-10-14（D191）：原则的**授权窗口**（用户点卡片解锁"改原则的权利"）。
    [PRINCIPLE_GRANT_TOOL, () => definePrinciplesAccessTool(ctx, state)],
    ["ledger_goals", defineGoalsTool],
    // ★★★★★ 2026-10-14（D192）：**经验与教训**（模型踩过的坑）。
    ["ledger_lessons", defineLessonsTool],
    ["ledger_compact", () => defineCompactTool(ctx, state, capsule)],
    [CHECKPOINT_TOOL, () => defineCheckpointTool(ctx, state)],
  ]) {
    try {
      // ★★★★★★ 2026-10-14（D207）：**在唯一的注册点统一清理返回值**。
      //   ★ 为什么放这里（而不是各工具自己清理）：这个病**已经复发三次**
      //     （D188① / D203 / D207），每一次都是"某个分支的返回对象恰好带了 `undefined`"。
      //     逐个工具补 = 永远在追着下一个分支跑；**一个包装覆盖全部工具**才是把根堵上。
      //   ★★ 判据：**凡是"必须对全部工具成立"的约束，就该在"全部工具都经过的那一处"实现。**
      //     （这与本项目"守卫要放在真正产生副作用的那一步"是同一条纪律的镜像：
      //      这次是放在**真正离开进程的那一步**。）
      const tool = factory();
      const rawExecute = tool.execute;
      if (typeof rawExecute === "function") {
        tool.execute = async (a, e) => lossless(await rawExecute(a, e));
      }
      const d = ctx.tools.register(tool);
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

        // ★★★★★ 2026-10-13（D176，用户拍板）：**子代理完全无视本插件** —— 最前、最外的一道豁免。
        //
        //   用户原话（逐字）：*"所有的子代理不用遵循插件，可以完全无视。他们是一次性的，
        //   之前有一个派了一大堆子代理的对话，饱受其苦。"*
        //
        //   ★ 为什么必须堵在这里（而不是各分支各判一次）：
        //     这条 waterfall 是**本插件一切注入的唯一入口**（台账全文 / 水位提醒 /
        //     回合末义务 / 压缩合同 / 胶囊重注，全都从这里出去）。
        //     ⇒ 堵在入口，等于**一次性豁免全部**；分散去判，必然漏掉将来新加的那条。
        //
        //   ★★ 为什么以前没堵（这是真缺陷、不是设计）：`isLiveRootAgent()` 这个判据
        //     **早就存在**（L8943），但只用在三处 **弹卡片** 的地方（四选一 / 合规卡 /
        //     第一轮卡）⇒ 结果是"子代理不弹卡，但**照样被注入**"。
        //     ★ 用户当时（本机实测）不得不**在每个子代理的 prompt 里手写**
        //       "绝对不许调用任何 ledger_* 工具""忽略水位义务话术" ——
        //       那正是这条缺陷的代价：**把插件该做的事变成了用户的工作量**。
        //
        //   ★ 失败方向刻意沿用 `isLiveRootAgent` 的 `return true`（取不到 `agents` 服务
        //     就当成 root）—— 对"豁免"这个动作，**保守方向是"照旧注入"**：
        //     宁可子代理多收一次，也不能因为服务缺失就让用户的 root 会话**失去记忆**。
        // ★★★★★ 2026-10-13（D176）：判据换成**唯一出口** `shouldHandleSession()` ——
        //   它既认 `agents.roots()`（服务在时），也认 `header.parentSession`（会话自带，
        //   服务不在时仍然可靠）。两个入口写两套判据 = 必然在某个内核版本上分叉（D170 判据）。
        if (!shouldHandleSession(agent)) return decision;

        const root = projectRootOf(agent);
        if (root === undefined) return decision;

        // ★★★ 2026-10-12（D126 收窄）：给每一拍盖一个**步号**。
        //   闸门要用它回答"这次提醒是本拍发的、还是上一拍发的"——
        //   光比 `Date.now()` 区分不了（同拍时提醒必然更晚一点点，看着与"上拍"一样）。
        // ★★★ 2026-10-12（D131）：`stepSeq`/`stepKey` 随 `flushOwedAt` 一起清掉了
        //   （它只服务 D126 那个"同拍/上拍"判据，而那整段已成死代码）。
        //   ★ 若将来又要判"某一拍"，**重新引入时务必连带把它写进清账路径**。

        const info = inspect(root);
        // ★★★★★ 2026-10-15（D211）：把**本对话的 sid** 挂进 info —— 变更基线要按"项目根 + 对话"
        //   存（探针证明：只按项目根存 ⇒ **同项目的第二个对话收不到「刚改过」**）。
        //   ★ 只在这一个入口挂（注入链唯一取 info 的地方）⇒ 不散落、不各写一份。
        info.sid = String(sid);
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
          // ★★★★★ 2026-10-15（D215）：**"谁压的"取这里，不取"有没有快照"**。
          //   ★ 为什么必须分开（91⑥b 当场抓到的谎报）：本修复让官方那次**也有快照**了
          //     ⇒ 原来那句 `ours: snap !== undefined` 会把官方压的写成
          //     「**本插件**主动执行了一次压缩」。
          //   ★ 消费掉（删除）：它只描述"紧接着那一次压缩"，与 `hfSource` 同一口径。
          const oursFlag = state.compactionOurs?.get(String(sid)) === true;
          state.compactionOurs?.delete(String(sid));
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
            // ★★★★★ 2026-10-15（D215）：**这是"谁压的"，不是"有没有快照"**（见 `compactionOurs` 的注释）。
            ours: oursFlag,
            keep: tri?.items,
            shadowedIndex: renderShadowedIndex(state, String(sid), agent),
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
              ? renderCompactInjection(info, renderShadowedIndex(state, String(sid), agent))
              : renderInjection(info, undefined, undefined, renderShadowedIndex(state, String(sid), agent), biOpts);
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
        // ★★★★★ 2026-10-14（D190，用户拍板）：`/ledger light` 的**新语义** ——
        //   用户原话（逐字）：*"第二是模型现在不是每次回复都会履行写台账和分流义务吗？
        //   那轻量压缩就可以用了——变成手动命令，效果是**对上一个回复进行压缩**。"*
        //   ⇒ 旗子里带 `lastTurn: true`，消费处把它传给 `runIncrementalCompact`，
        //     由它改用 `selectLastTurnRange`（"从尾压"）而不是默认的"从头压"。
        let lightLastTurn = false;
        try {
          const fr = state.deltaForce.get(String(sid));
          if (fr !== undefined) {
            state.deltaForce.delete(String(sid)); // 用完即删：只描述紧接着这一次
            if (fr.source === "command") forcedLight = true;
            else toolRequestedLight = true;
            // ★ 只有**人手动那条**才带 `lastTurn`（AI 主动那条语义不变，见 D129）。
            if (fr.lastTurn === true && fr.source === "command") lightLastTurn = true;
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
              // ★★★★★ 2026-10-14（D190）：人手动那条 ⇒ **只压「上一个回复」**。
              lastTurn: lightLastTurn,
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
              // ★★★★★ 2026-10-13（D179 硬门）：**文案必须按硬门分两套，且硬门下要"非常强烈"**。
              //   用户原话：*"必须强制模型在回合即将结束的时候，调用工具进行维护，不然的话，
              //   什么都没做，就直接被压缩了，就麻烦了。"* + *"同时也要注入非常强烈的信息，
              //   让模型主动去干。也就是两个都要。"*
              //   ★★ 旧文案这里写「这一档是**兜底**：正常用法是你自己先调 `ledger_compact`」——
              //     那是 **D129** 架构的措辞（轻量为主），与 D155「全量为主力」**再次冲突**
              //     （与 D174 同型的漏网处，**这次在压缩编排的文案里**）。
              const hardGate = hardMaintenanceGateOn();
              text +=
                "\n\n---\n**本插件即将执行一次高保真压缩**（水位 " +
                Math.round(pressure2.ratio * 100) +
                "% ≥ " +
                pct +
                "%）：压缩会自动发生，你**不需要**做任何事；压缩完成后台账与这份" +
                "逐字胶囊会重新注入。\n" +
                (hardGate
                  ? "★★★ **但有一件事你必须现在做：这一轮的进展落盘 + 分流。**\n" +
                    "· 用 `ledger_write` 把当前状态写进台账（有日志就再写一条 `ledger_log_write`）；\n" +
                    "· 用 `ledger_triage` 分三个桶（`keep` / `stash` / `drop`）。\n" +
                    "★★ **这是硬门：不做完，这次压缩就不会生效** —— 上下文会继续涨，" +
                    "直到官方 80% 那次硬压，而**那一次抓不到逐字胶囊**" +
                    "（用户原话 / 报错原文 / 器物索引会一起丢）。\n" +
                    "⇒ **做完这两步，压缩就会立刻继续**（意图已挂在队列上，下一次空闲时重试）。\n"
                  : "★ 这一档是**兜底**：正常的用法是**你自己在到线前**先调一次 " +
                    "`ledger_compact`（把用过的旧历史折起来），兜底只在你没来得及调时接管。\n" +
                    "★ 所以**现在请确保这一轮的进展已经用 `ledger_write` 落盘**，" +
                    "并写一条 L1 活动日志摘要（`ledger_log_write`）。\n");
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
          // ★★★★★ 2026-10-17（D231）：**内存没有就去看盘上那份**。
          //
          //   ★ 为什么必须加这一步（否则落盘等于白做）：
          //     `state.turnObligationPending` 是**进程内 Map** ⇒ 重启 / 崩溃之后它是空的
          //     ⇒ 只写盘、不读盘的话，那份记录**永远没有消费者**。
          //     用户要的恰恰是"结束对话之后再回来也能看到上次欠了什么"。
          //   ★ 所以：内存优先（本进程内最及时），盘上兜底（跨进程）。
          //     与 `activeLockFor` / `anchorOf` 完全同一套"内存覆盖层 + 落盘底座"口径。
          const pendMem = state.turnObligationPending.get(okey);
          const pendDisk = pendMem === undefined ? owedFor(okey) : undefined;
          const pend = pendMem ?? pendDisk;
          const cur = state.turnObligation.get(okey);
          const needWrite = cur === undefined || cur.wrote !== true;
          const needTriage = cur === undefined || cur.triaged !== true;
          // ★ 本回合已提醒过 ⇒ 不再说（`turnReminded` 在 `turn/end` 时清空）。
          const reminded = cur?.reminded === true;
          // ★★★★★ 2026-10-17（D231b，**用户当场报的真缺陷**）：**没有台账 ⇒ 不提醒**。
          //
          //   用户原话（逐字）：*"当我在第一轮选择了只做问题记录不锁定项目的情况下，
          //   仍然插件会在任何一个回合去提醒这个对话，履行义务以后就会导致这个对话
          //   消耗一些tokens去思考到底该不该履行义务，甚至有时候会陷入自我矛盾中。"*
          //
          //   ★★★ 这是个**前后矛盾**，不是"提醒太啰嗦"：
          //     ① `ledger_triage` 在**没有台账时直接拒绝执行**（`part5.js:121`：
          //        "这个项目还没有台账 ⇒ 按约定不往项目里写文件"）；
          //     ② `flushBeforeCompact` 那条闸门也**明确豁免**没有台账的项目
          //        （`part3.js:1715`："这个项目没有台账，无需落盘"）；
          //     ③ **唯独这段提醒**一个字都没查 `activeRel` ⇒ 它催的是一件
          //        **工具会拒绝、闸门也认为不必做**的事。
          //   ⇒ 模型收到它只能反复权衡"到底该不该做"，而**两边都是错的**：
          //     做 ⇒ 撞在工具拒绝上；不做 ⇒ 看起来违抗了硬门话术。**这就是自我矛盾。**
          //
          //   ★ 判据与闸门**同源**（`info.activeRel === undefined`）：同一件事只有一个判断，
          //     不许两处各写一套（D170/D222 反复栽过的那种"半修"）。
          //   ★ 但**不因此丢掉真正的提醒**：有台账时照旧提醒。
          //     而"上一条欠着"（`pend`）在有台账时才可能真的欠 —— 没台账时它也不该存在，
          //     因为落盘同样只在有台账时才有意义 ⇒ 一并纳入同一条判据。
          const hasLedger = info?.activeRel !== undefined;
          if (hasLedger && !reminded && (pend !== undefined || needWrite || needTriage)) {
            const missingBits = [];
            if (pend !== undefined) {
              if (pend.wrote !== true) missingBits.push("台账");
              if (pend.triaged !== true) missingBits.push("分流");
            }
            // ★★★★★ 2026-10-17（D231）：**两种"欠着"必须分开说** —— 否则会撒谎。
            //
            //   ★ 为什么要分：`pendMem`（本进程内存）说的是"**上一条回复**没做完"，
            //     那时序还在同一场对话里、事实就在眼前；
            //     而 `pendDisk`（盘上那份）可能来自**上一次进程 / 另一场同名会话的最后一条** ——
            //     把它写成"上一条回复结束时没有完成"是**一句我们无法确认的话**
            //     （中间可能重启过、也可能用户早就另起了一轮）。
            //   ★ 本项目纪律：**不许把"我们从盘上读到的"说成"我们刚刚看到的"**。
            //     ⇒ 盘上那份要如实带时间，并说明它是**跨进程**记住的。
            const pendIsDisk = pendMem === undefined && pendDisk !== undefined;
            const whenOf = (ms) => {
              if (!Number.isFinite(ms) || ms <= 0) return "";
              try {
                const d = new Date(ms);
                const p = (n) => String(n).padStart(2, "0");
                return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
              } catch {
                return "";
              }
            };
            const line =
              "\n\n---\n★ **本回合收尾义务（不是障碍，做完就安静）**\n" +
              (pend !== undefined
                ? pendIsDisk
                  ? `**这场对话上一次结束时没有完成**：${missingBits.join(" + ")}` +
                    `${whenOf(pend.at) === "" ? "" : `（记于 ${whenOf(pend.at)}）`}` +
                    " —— 这是插件**记在磁盘上**的欠账（所以即使重启过也还在）。请现在补上。\n"
                  : `**上一条回复结束时没有完成**：${missingBits.join(" + ")} —— 请现在补上。\n`
                : "") +
              (needWrite ? "· ① `ledger_write` 记下这一段进展（有日志就再来一条 `ledger_log_write`）\n" : "") +
              (needTriage ? "· ② `ledger_triage` 分三个桶（`keep` 留上下文 / `stash` 落项目 / `drop` 丢掉）\n" : "") +
              "★ **为什么每回合都要做**：压缩会把旧历史换成摘要 ⇒ 没落盘的那段进展就是唯一副本；\n" +
              "  而没分流 ⇒ 压缩不知道该保住哪些（`keep` 桶会被逐字注回）。\n" +
              // ★★★★★★ 2026-10-15（D216，用户拍板）：**这一行原来在与硬门唱反调，必须按硬门分两套。**
              //
              //   ★ 病（用户报的，我 grep 到确凿两处）：同一份注入里，合同区（`renderInjectionBody`
              //     那段）写的是「**【硬门】不做完，压缩就不会发生**」，而**这里**却写
              //     「**不拦任何东西**……**没做也不会卡住压缩**」⇒ **模型同时读到硬门与"不拦"**，
              //     于是把义务当**背景知识**而不是必须做的事。
              //   ★★ 哪一句是真的（**核过闸门实现，不是推理**）：
              //     `flushBeforeCompact` 里分流那条是 `if (trec.count < FLUSH_BLOCK_GIVEUP || hard)`
              //     ⇒ **硬门开时恒真 ⇒ 永远拦、不释放**；落盘那条同理（`if (!hard && rec.count >= …)`）。
              //     ⇒ 所以「不拦任何东西 / 没做也不会卡住压缩」**是假的** —— 它是 D179 **之前**的老文案，
              //       D179 只改了合同区、**没改这里**（与 D174「代码对、送达文本没对齐」同型复发）。
              //   ★★★ 诚实边界（不许把话说满）：硬门**不是**"永不发生" —— 水位到
              //     `FULL_COMPACT_URGENT_RATIO`（78%）时那条**紧急旁路**仍会放行（D119 的刻意设计：
              //     宁可用"没落盘的我们"压，也不留给内核 80% 那次**抓不到胶囊**的）。
              //     ⇒ 所以准确说法是"**会一直涨到 78% 才被强压，那一次没有你先落盘的进展**"。
              (hardMaintenanceGateOn()
                ? "★★★ **【硬门】这不是提醒，是压缩的前提条件：不做完，回合末那次压缩就不会发生。**\n" +
                  "  · **没有超时放行，也没有次数放行**（硬门下两者都不生效）。\n" +
                  "  · 后果：上下文会一直涨，直到 **78%** 那条紧急旁路才强压一次（**那一次没有你先落盘的进展**），\n" +
                  "    再往上就是官方 **80%** 那次硬压 —— **那一次抓不到逐字胶囊**" +
                  "（用户原话 / 报错原文 / 器物索引会一起丢，且**不可追回**）。\n" +
                  "  ⇒ **做完这两步，压缩立刻继续**（意图已挂在队列上，下一次空闲自动重试）。\n"
                : "★ 它**不拦任何东西**：做完这些下一步照常；**没做也不会卡住压缩**。\n");
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
        // ★★★★★★ 2026-10-15（D210）：**基线在这里推进 —— 因为这里才是"送出去"的那一刻。**
        //
        //   ★ 上面所有 return 都是"这一步什么都没送"：`text === undefined`、
        //     `already`（本步已有一条一模一样的）、`note.id` 不合法。
        //     ⇒ 那些路径上**绝不能**推进基线，否则这次变更提醒就被**吃掉**了 ——
        //       而模型一个字都没看到 ⇒ 正是用户抱怨的"改了之后永远不生效"。
        //   ★★ 只在**这次真的注出去**时推进（判据 = 走到的这一行）。
        //   ★★★ 还必须**确认这次送出去的文本里真有那份快照**：注入并不总是带快照
        //     （例如**只**发了一条水位提醒时）。那种情况下快照没送达 ⇒ **不推进**，
        //     等下一次快照真送出去时再报这句"刚改过"。
        //   ★ 判据：**一句话只有在真的被送到之后，才算说过了。**
        if (text.includes(SETTINGS_SNAPSHOT_MARK)) commitSettingsBaseline(info);
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
        // ★★★★★ 2026-10-13（D176）：**子代理空闲不许触发压缩**（用户拍板：子代理完全无视本插件）。
        //   ★ 为什么这里是**最危险**的一处：压缩是**破坏性**动作（它真的折叠历史、
        //     写胶囊、写归档）。若子代理的 idle 也能排队/执行压缩 ⇒
        //     轻则白压一次、重则把**子代理的上下文**当成主会话压掉。
        //     而子代理"一次性、随时被丢弃" ⇒ 对它的任何压缩都是纯浪费 + 潜在污染。
        //   ★ 判据走唯一出口 `shouldHandleSession(agent)`。
        if (!shouldHandleSession(agent)) return;
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
    // ── ★★★★★ 2026-10-13（D176）：**子代理会话一律不管**（最前、最外的一道）──────
    //
    //   用户原话：*"所有的子代理不用遵循插件，可以完全无视。他们是一次性的，
    //   之前有一个派了一大堆子代理的对话，饱受其苦。"*
    //
    //   ★ 为什么这条**特别重要**（不是"顺手加一句"）：
    //     `session/event` 对**每一条会话**都会触发 —— 包括子代理自己的会话。
    //     实测污染（本轮量的）：本项目 `_ledger-log/.../L4-user-messages.md` 里
    //     **208 条里有 15 条是子代理的 prompt**（如"你是资料搜索员，你的任务是…"），
    //     它们**被当成了"用户说过的话"**记进了永久记忆。
    //     ⇒ 那不只是噪音：**用户的原话是这套记忆的最高权威**（胶囊 ∝ 用户原话），
    //       子代理 prompt 混进去 ⇒ 以后回溯"用户到底要什么"时**读到的是子代理的任务书**。
    //
    //   ★ 判据走唯一出口 `shouldHandleSession(session)` —— 它认 `header.parentSession`。
    if (!shouldHandleSession(session)) return;

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
          // ★★★★★ 2026-10-17（D231，用户拍板方向②）：**同一件事落一份盘**。
          //
          //   ★ 为什么内存里那份不够（这正是用户担心的事）：
          //     `state.turnObligationPending` 是**进程内 Map** ⇒ 关窗口 / 崩溃 / 重启
          //     都会让它消失 ⇒ "上一条欠了什么"**跨进程根本查不到**。
          //     而用户说的正是"结束对话的时候，正好落到压缩中" ⇒ 那一刻连进程都可能没了。
          //   ⇒ 所以这里写 `owed.json`（`$DSH_HOME\plugin-data\<包名>\`，不碰工作区）。
          //   ★ 它**只是欠账凭据**，⛔ 不是台账内容 —— 绝不替模型写台账（会产出空洞条目）。
          try {
            // 项目根走与注入同一个出口（`projectRootOfSession` 那条路拿的是 session）。
            const root = projectRootOfSession(session);
            // ★★ **与提醒同一条判据**（D231b）：没有台账 ⇒ 不存在"落盘/分流"这回事
            //    ⇒ 既不记欠账，还要把盘上可能残留的旧条目**清掉**
            //    （否则用户重建/删除项目之后，一条永远还不掉的假欠账会一直在）。
            const hasLedger =
              typeof root === "string" && inspect(root).activeRel !== undefined;
            recordOwed(key, {
              // ★ 没有台账时**报成"都已兑现"** ⇒ `recordOwed` 会把它从盘上删掉。
              wrote: hasLedger ? rec.wrote === true : true,
              triaged: hasLedger ? rec.triaged === true : true,
              root: typeof root === "string" ? root : undefined,
              tag: tagOfId(key),
            });
          } catch {
            /* 落盘失败只影响"记不住"，绝不影响主流程（这是提醒的备份，不是主流程） */
          }
          state.turnObligation.set(key, { wrote: false, triaged: false });
        }
      }
    } catch {
      /* 义务记账失败绝不影响任何事（它只是提醒，不是主流程） */
    }

    // ── ⓪ ★★★★★ 2026-10-15（D215）：**外来的压缩在开始那一刻就抓「压缩前胶囊」** ──
    //
    //   ★ 用户的诉求（逐字）：*"就是让80%的那次压缩也能和我们的全量压缩保留的信息，
    //     或者说至少功能类是相等的。"*
    //
    //   ★★★ 为什么**必须**在这里抓（读内核实现得出的，不是猜）：
    //     内核 `compactSurfaceRegion`（`dsh-compaction-basic:450-500`）的顺序是
    //       `:469 session.append("compaction/start")`   ← **先落盘**
    //       `:478 await summarizeCompaction(...)`       ← **再 await 摘要**（实测 27 秒）
    //       `:482 commitCompactionBody(...)`            ← 到这一步才真正改写 surface
    //     ⇒ **`start` 落盘时，历史还完整地在 `session.log` 里** ⇒ 我们有整整一段
    //       （= 摘要那 27 秒）的窗口去抓。
    //     ★ 而压缩**之后**再抓就晚了 —— `compaction/end` 时 surface 已被改写，
    //       "当时上下文里有什么"已经变了 ⇒ 现取的胶囊**恰好缺掉被压掉的那一段**
    //       （这正是 D161 在 `:19806-19809` 自己记下的那个病灶）。
    //
    //   ★ 为什么以前没做（这是真缺口，不是设计）：抓胶囊只长在**我们自己的**
    //     `runHighFidelityCompact` 里（`:19148`）⇒ **官方 80% 那条路从来没有胶囊**。
    //     ⇒ 于是"官方那次"与"我们自己那次"保留的信息**结构性地不等价** ——
    //       而这与摘要提示词无关（那个改不了，见 D215 §二）。
    //
    //   ★ 判据怎么区分"是不是我们发起的"：**看 `hfSource` 队列**。
    //     · 我们那条路在 `compactNow` 之前**一定先入队一张票**（`:19226`）；
    //     · 队列非空 ⇒ 就是我们自己压的 —— 而它**已经**在压缩前抓好胶囊了
    //       （`:19148`），这里再抓一遍纯属重复落盘。
    //     ⇒ 所以：**队列空 + 没有待用快照** ⇒ 判定为**外来压缩**（内核 80% / 别的插件）⇒ 抓。
    //   ★ 为什么还要看 `capsuleSnapshot`：并发重叠时队列可能被别人占着，
    //     而"已经有待用快照"本身就说明这一轮不欠胶囊 —— 宁可不抓，也不重复落盘。
    try {
      if (event?.type === "compaction/start") {
        const sidStart = String(session?.header?.id ?? session?.id ?? "");
        if (sidStart !== "" && capsule !== undefined) {
          const oursQueued = peekHfSource(state, sidStart) !== undefined;
          // ★★★★★ 2026-10-15（D215）：**把"这一次是不是我们发起的"记下来**。
          //
          //   ★ 为什么必须单独记（这是 91⑥b 当场抓出来的真 bug）：
          //     压缩后重注的文案原来是 `ours: snap !== undefined`（"有没有压缩前快照"）
          //     —— 在本修复之前这两件事**恰好等价**（只有我们那条路抓快照）。
          //     可本修复让**官方那次也有快照**了 ⇒ 那个判据当场失真：
          //     官方压的，注入却写「**本插件**在水位到 N% 时主动执行了一次压缩」
          //     ⇒ **谎报"谁做的"**。★ 与 D167 那条同族：状态判错时，宁可不报，不许报反。
          //   ★ 判据就是队里那张票（我们那条路在 `compactNow` 之前一定入队，见 `pushHfSource`）。
          state.compactionOurs.set(sidStart, oursQueued);
          const alreadySnap = state.capsuleSnapshot?.get(sidStart) !== undefined;
          if (!oursQueued && !alreadySnap) {
            const rootStart = projectRootOfSession(session);
            if (typeof rootStart === "string" && rootStart !== "") {
              // ★ 走**同一个** `captureCapsuleBeforeCompact`（它同时负责抓快照 + 落盘成品）。
              //   ★★ 为什么不另写一套：本项目最忌"两条路各写一套判据"（D159/D163/D164），
              //     而这条函数的语义恰好是"压缩前抓一份" —— 与它存在的理由完全一致。
              captureCapsuleBeforeCompact(state, sidStart, inspect(rootStart), capsule, "official");
            }
          }
        }
      }
    } catch {
      /* 抓不到就不抓：绝不许因为补胶囊而连累官方落盘（它同步跑在 append 路径上） */
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
      // ★★★★★ 2026-10-13（D176）：**子代理的回合末一律不管**（用户拍板：子代理完全无视本插件）。
      //   ★ 为什么必须也堵这里：子代理**也有回合**，也会走 turn-stopping。
      //     原先只在三处**弹卡片**的地方判 `isLiveRootAgent` ⇒ 结果是
      //     "子代理不弹卡，但**它的回合末照样触发这本插件的逻辑**"（日志 flush 等）。
      //   ★ 判据走唯一出口 `shouldHandleSession(agent)`（认 `header.parentSession`）。
      if (!shouldHandleSession(agent)) return;

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
      state.compactionOurs.delete(String(sid));
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
