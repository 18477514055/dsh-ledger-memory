import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANCHOR_STORE_FILE, BLOCK_HEADING_RE, BLOCK_HISTORY_FILE, BLOCK_HISTORY_MAX, BLOCK_HISTORY_TTL_MS, CAPABILITY_STORE_FILE, CAPSULE_ARTIFACT_MAX, CAPSULE_DIR_NAME, CAPSULE_ERROR_CHARS, CAPSULE_ERROR_MAX, CAPSULE_MAX_CHARS, CAPSULE_STORE_ERROR_HARD_MAX, CAPSULE_STORE_FILE, CAPSULE_STORE_SESSIONS, CAPSULE_STORE_USER_HARD_MAX, CAPSULE_USER_MSG_CHARS, CAPSULE_USER_MSG_MAX, CHANGE_REGISTER_HEADING, CHANGE_REGISTER_LINE_RE, CHANGE_REGISTER_MAX, DEFAULT_DELTA_REMOVE_POINTS, DEFAULT_DELTA_TRIGGER_POINTS, DEFAULT_LOG_LEVELS, DEFAULT_MAX_ACTIVE_LINES, HIGH_FIDELITY_COMPACT_RATIO, INJECT_KIND, LOCK_STORE_DIRNAME, LOCK_STORE_FILE, LOCK_STORE_PKG, LOCK_STORE_VERSION, LOG_BRIEF_CHARS, LOG_DEFAULT_LIMIT, MANIFEST_REL, MAX_ARCHIVE_LIST, MAX_READ_CHARS, MIN_COMPRESS_POINTS, MODES, MODE_STEADY, NOT_A_SUBPROJECT_RE, NUDGE_MIN_RATIO, OWED_STORE_FILE, OWED_STORE_MAX, PRECEDENCES, PRECEDENCE_PANEL, PRECEDENCE_PROJECT, PRESSURE_TIERS, PRINCIPLE_GRANT_TOOL, protocolGapOf, RECALL_MAX_CHARS, SETTING_KEYS, SETTING_SPECS, SHADOWED_INDEX_FILE, SHADOWED_INDEX_MAX, SHADOWED_STORE_SESSIONS, STASH_DIR, TRIAGE_ALWAYS, TRIAGE_KEEP_MAX, TRIAGE_KEEP_TOTAL_MAX, TRIAGE_OWED_MAX_AGE_MS, USER_MSG_ARCHIVE_FILE, USER_MSG_MAX_CHARS, WEIGHT_DONE_CAP, WEIGHT_MUST_INJECT, WEIGHT_PRINCIPLE_SCORE, activeSettings, capsuleSkipStats, name, sessionProjectLock } from "./defs.js";
import { archiveStamp, countLines, ensureDir, isUnder, isUnderReal, logDirOf, newCapsuleRecord, parseLevels, readManifest, readTextSafe, realpathOf, stamp, stampSec, writeFileAtomic } from "./part2.js";
export function settingDefaults() {
  return {
    // ★★★★★ 2026-10-16（D222）：**默认「以面板为准」**（用户拍板）。
    //   ★ 为什么默认改成它：老行为是"建项目时把面板值冻结进清单"，
    //     用户实际的感受是"面板改了老项目不跟" ⇒ 默认必须是**它会跟**。
    //   ★ 想要"一个仓库两种活"的人，把它切到 `project` 即可（能力没丢）。
    settingPrecedence: PRECEDENCE_PANEL,
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
    // ★★★★★ 2026-10-17（D234）：**文件锚定**（六维相对秩 + 记忆面地图）。默认**关**。
    //   ★ 默认关的理由与 `blockInjection` **逐字相同**：它也会改变"模型实际看到什么"，
    //     而用户底线是"不要影响模型的准确性" ⇒ 没有实测对照之前，默认必须与今天逐字一致。
    //   ★★ 但它与 `blockInjection` 有一个关键差别：区块注入是**省字符**（可回退到整份），
    //     文件锚定是**加一段**（不省，只多）⇒ 关掉它就是完全无痕的旧行为。
    fileAnchor: false,
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
    // ★★★★★ 2026-10-17（D241，用户拍板「默认为一次，由用户自行定义」）：
    //   **回合末没做义务就 steer 抽几次**。0 = 关；1 = 只抽一次（推荐）。
    //   ★ 为什么默认 1 而不是"永远开到底"：D59 前科（拦近 4 小时、零次压缩）证明
    //     「拦死」的代价由用户付；抽一次能把大部分漏写补回来，且最坏只多花一轮上下文。
    turnEndPull: 1,
    // ★★★★★ 2026-10-18（D244，用户拍板）：**长回合中途自动压缩**。默认**关**。
    //   ★ 默认关的理由（与 `fileAnchor` / `blockInjection` **同一条纪律**）：
    //     它会**改变压缩发生的时刻**（从"回合末"提前到"回合内"），
    //     而压缩是最危险的动作之一 ⇒ 没有实测对照之前，默认必须与今天逐字一致。
    //   ★ 但用户要的正是它（原话：*"整个过程不需要任何操作"*）⇒ 由他在面板上开。
    midTurnCompact: false,
    // ★★★★★ 2026-10-13（D179，用户拍板）：**收尾维护硬门**。
    //   用户原话：*"强制维护，我认为必须是个硬门。模型不做完。压缩就不会生效。
    //   同时也要注入非常强烈的信息，让模型主动去干。也就是两个都要。"*
    //   ⇒ 默认 **开**。关掉即退回旧行为（连续拦 3 次 / 超时 20 分钟放行）。
    hardMaintenanceGate: true,
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

export function numOf(key, fallback) {
  const v = currentSettings()[key];
  return Number.isFinite(v) ? v : fallback;
}

/**
 * ★★★★★ 2026-10-16（D222）：**"面板 vs 项目清单，谁说了算"的唯一出口**。
 *
 * ★ 为什么必须有这一个函数（而不是在 5 个取值点各判一次）：
 *   本项目纪律「**一个事实只能有一个判定出口**」（D25）。改之前那 5 处
 *   （`modeOf` / `changeRegisterMaxOf` / `maxActiveLines` / `levelOn` /
 *   `blockInjectionEnabled`）**各自写了一遍"清单优先"** ⇒
 *   ① 想改口径要改 5 处，漏一处就是**半修**；
 *   ② 没有断言会红（改错一处，其余四处照旧"看起来对"）。
 *   ⇒ 收成一个出口：**管辖范围内 + 项目优先 + 清单里显式有** 三者同时成立才用清单值。
 *
 * @param {object} info `inspect()` 的结果（带 `manifest`）
 * @param {string} key 设置键（**必须是 `PRECEDENCE_KEYS` 里的**）
 * @returns {*} 生效值：清单值 或 面板值（永不为 undefined，除非两边都没有）
 */
export function precedenceValue(info, key) {
  const s = currentSettings();
  const panel = s[key];
  // ① 面板选了"以面板为准"（默认）⇒ 清单**不参与**（这正是不必逐项目去改的原因）。
  if (!precedenceIsProject()) return panel;
  // ② 选了"以项目清单为准" ⇒ 清单里**显式写了**才用它。
  const man = info?.manifest;
  const v = man?.[key];
  if (v === undefined || v === null) return panel;
  return v;
}

/**
 * ★★★★★ 2026-10-17（D226）：**「现在是谁说了算」的唯一出口**。
 *
 * ★ 为什么必须单独抽出来：`precedenceValue`（取值）与 `precedenceFromManifest`（标注）
 *   内部都写着同一个表达式 `currentSettings().settingPrecedence === PRECEDENCE_PROJECT`。
 *   而 **D226 修文案时，第三处、第四处也要印这句话**（注入脚注 / 台账快照）——
 *   我第一版就是在各函数里各写一遍（甚至跨函数误用局部变量 `pf` ⇒ `ReferenceError`，
 *   **与 D222 在 `inspect()` 里踩的是同一个错**）。
 *   ⇒ 收成这一个出口：**"谁说了算"只判一次**，其余各处都调它。
 * ★ 判据（本项目那条纪律）：**一个事实只能有一个出口**（D25 / D222）。
 */
export function precedenceIsProject() {
  return currentSettings().settingPrecedence === PRECEDENCE_PROJECT;
}

/**
 * 某个键是不是"以项目清单为准 **且** 清单里真的写了" —— 给 UI / 快照标注用。
 * ★ 与 `precedenceValue` 共用同一份判据，**不允许各判一次**（否则标注与行为会分叉）。
 */
export function precedenceFromManifest(info, key) {
  if (!precedenceIsProject()) return false;
  const v = info?.manifest?.[key];
  return v !== undefined && v !== null;
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

export function specOf(key) {
  return SETTING_SPECS.find((s) => s.key === key);
}

/**
 * ★★★★★ 2026-10-13（D170）：某个数值设置在**面板单位下的上限**。
 *
 * ★ 为什么要这个函数（而不是在存储侧抄一个数）：存储侧的硬上限必须
 *   **永远 ≥ 该设置能达到的最大值**，否则用户把设置调大后盘上反而写不下 ⇒
 *   "盘上只增不减"（D159）被打穿。若把 200 硬写死，将来有人把 spec 的 max 调成 500，
 *   **没有任何东西会红**，只会静静丢数据。
 *   ⇒ 让它**从 spec 派生**（spec 是边界唯一真源，见 `specOf` 的注释）；
 *     自检另有一条断言直接钉这个大小关系（双保险：一个自动跟随、一个事后报警）。
 *
 * ★ 只用于**计数类**设置（`scale` 未声明 ⇒ 面板单位 = 内部单位）。
 *   若将来给这类项加了 `scale`，这里要先换算 —— 自检会当场发现（值会明显不对）。
 */

export function clampNumber(key, v) {
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

export function normalizeSettings(raw) {
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
    if (k === "settingPrecedence") {
      // ★ D222：与 `mode` 同一条口径（只认登记过的值，打错就**丢弃并如实报告**）。
      //   ★ 这里尤其不能静默退默认：写错一个字会让用户以为"已经以面板为准"，
      //     而实际仍在按项目清单走 ⇒ 正是他报的那个困扰原样复现。
      if (typeof v !== "string" || !PRECEDENCES.includes(v)) {
        dropped.push(k);
        continue;
      }
      value.settingPrecedence = v;
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
      // ★★★★★ 2026-10-17（D240，用户拍板）：**空数组现在是合法的**。
      //
      //   用户原话（逐字）：*"自定义也不应该只保留三档，可以是两档，可以是一档
      //   甚至一档水位都不设定，但是不管用户怎么设定，插件里面强制设定一个 70% 的水位提醒。"*
      //
      //   ★ 所以：**"一个自定义档都不要"是一个正当选择** —— 用户此时拿到的就是
      //     「只有插件强制那一个 70%」的效果。旧版把它当误操作丢掉，等于**不让他这么选**。
      //   ★★ 而 `PRESSURE_TIERS`（0.3/0.5/0.7）里的 0.7 现在是**强制**的、与设置无关
      //     （见 `defs.js` 的 `FORCED_PRESSURE_TIER` 与 `effectivePressureTiers`）⇒
      //     **"一档都不设"永远不会真的变成"永不提醒"**，安全网还在。
      value.pressureTiers = tiers; // 允许为空数组
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

export function settingsOf(cfg) {
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

export function currentSettings() {
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

export function dshHome() {
  const home = process.env.DSH_HOME;
  return typeof home === "string" && home !== "" ? home : path.join(os.homedir(), ".dsh");
}

/**
 * 锁记录文件路径。
 *
 * ★ 也**不**去读 `$DSH_HOME\sessions\`、`storages\`（红线）—— 这里只写自己的
 *   `plugin-data\<包名>\` 一个目录，与别家插件同一套规矩。
 *   ⚠️ 例外：`officialSessionPath()` 会**算**官方 sessions 的路径，
 *     但那只是**给模型一个指针**（我们既不读也不写它）—— 见那个函数的说明。
 */

export function lockStorePath() {
  return path.join(dshHome(), LOCK_STORE_DIRNAME, LOCK_STORE_PKG, LOCK_STORE_FILE);
}

/** 锁记录的形态版本（将来改结构时用来识别旧文件）。 */

export function readLockStore() {
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

export function writeLockStore(store) {
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

export function anchorStorePath() {
  return path.join(path.dirname(lockStorePath()), ANCHOR_STORE_FILE);
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★★★ 2026-10-14（D196，用户拍板）：**功能清单**（capabilities）
// ═══════════════════════════════════════════════════════════════════════════
//
//  用户原话（逐字）：*"对了，我建议就是每个使用我们插件的都维护一个小的功能清单，
//  不然的话你插件更新之后，其他对话都不知道，然后还是用此前的规格去建这个系统。
//  就无法跟着更新。**但是我们插件维护的小的功能清单，不要把文件混杂到别人项目的文件里面**。"*
//
// ★★★ 这条正好补上 **D195 的反面**（两轮合起来才完整）：
//   · **D195**：**已登记**的能力 ⇒ 必须在契约里可见（否则模型不知道该用）；
//   · **D196**：**未登记**的能力 ⇒ **也必须让模型知道它存在**（否则旧项目永远升不上来）。
//   ★ 病根：契约里每条都带 `info.xxxRel !== undefined` 门控（"没登记就不出现"）——
//     这本身**是对的**（契约不许承诺不存在的东西），**但副作用是**：
//     **按旧规格建的项目，永远收不到"后来多了哪些能力"的通知** ⇒ 插件更新对它等于没发生。
//   ★ 实测（`tools/_probe-d196-capability-gap.mjs`）：造一个"旧规格项目"（只登记 active+decisions），
//     注入正文里**5/5 项新能力一个都没提**（目标树 / 回合流水 / 根本原则 / 经验与教训 / 活动日志）。
//     ⇒ ★ 这不是"少写一句"，而是**升级通道断了**：老项目只会照它当年那套规格一直跑。
//
// ★★ 用户的硬约束（**必须遵守，且正好与既有惯例对齐**）：
//   *"不要把文件混杂到别人项目的文件里面"* ⇒ 清单**不进任何项目目录**，
//     落在插件自己的家：`$DSH_HOME\plugin-data\dsh-ledger-memory\`
//     （`locks.json` / `anchors.json` / `blocks.json` … 本来就都在那儿，与别家插件同一套规矩）。
//   ★ 为什么放这里而不是每个项目里各放一份：项目目录是**用户的**（红线），
//     而这个清单是**插件自己的元数据**（"我这一版有哪些能力"），它跟**插件**走，不跟项目走。
//     ⇒ 换项目、删项目、项目还没建，清单都照旧有效。
//
// ★★★ 为什么还要**推行到注入**（光有文件不够 —— 与 D195 同一条纪律）：
//   清单文件存在 ≠ 模型会去读它。**"恢复必须是推给模型的"**（D46）。
//   ⇒ 所以下面既**写**清单，也把它**注入**进每回合的契约里。
//
// ⚠️ 如实说明它**照不到**的地方（不夸大）：`plugin-data` 是**本机**的。
//   若某个项目是在**另一台机**上用旧规格建的，这台机的清单照不到它 ——
//   但那种情况由**注入**覆盖（每个会话都会拿到当前版本的清单）。

/** 功能清单文件名（**插件自己的家**，不进用户项目）。 */

export function capabilityKinds() {
  return [
    {
      key: "active", infoField: "activeRel", label: "活跃台账", since: "0.1.0",
      usage: "`ledger_write({target:\"active\"})` 写，`ledger_read({target:\"active\"})` 读",
    },
    {
      key: "decisions", infoField: "decisionsRel", label: "关键决策", since: "0.1.0",
      usage: "`ledger_write({target:\"decisions\"})` 追加（不参与归档）",
    },
    {
      key: "archive", infoField: "archiveRel", label: "归档目录", since: "0.1.0",
      usage: "`ledger_archive` 归档；`ledger_read({target:\"archive\"})` 查",
    },
    {
      key: "log", infoField: "logRel", label: "活动日志", since: "D7",
      usage: "自动采集；`ledger_log` 按需查、`ledger_log_write` 写 L1 —— ★ 永不注入",
    },
    {
      key: "goals", infoField: "goalsRel", label: "目标树", since: "D181",
      usage: "`ledger_goals`（卡片联成树；完成一个目标时补一条教训）",
    },
    {
      key: "journal", infoField: "journalRel", label: "回合流水", since: "D183",
      usage: "`ledger_write({target:\"journal\"})` 追加；`ledger_read({target:\"journal\"})` 查 —— ★ 不注入",
    },
    {
      key: "principles", infoField: "principlesRel", label: "根本原则", since: "D180",
      usage:
        "**只有用户能改**；你只能 `ledger_propose_principle` 提议，或 `" +
        PRINCIPLE_GRANT_TOOL +
        "` 请用户授权",
    },
    {
      key: "lessons", infoField: "lessonsRel", label: "经验与教训", since: "D192",
      usage: "`ledger_lessons`（教训 `cause` 必填 / 经验 `source` 必填；动手前先 `list` 一遍）",
    },
  ];
}

/**
 * 算"这个项目启用了哪些能力"（**只读** `info`，不碰磁盘）。
 *
 * ★ 保留判据与 `inspect` 一致：该字段是**非空字符串**才算登记。
 *
 * ★★★ **这里我当场栽过一次，必须留档**（D196）：
 *   第一版用 `${c.key}Rel` **拼**字段名。而 `key` 我写的是 `archiveDir` / `logDir`
 *   ⇒ 拼出来是 `archiveDirRel` / `logDirRel` —— **`inspect` 里根本没有这两个字段**
 *   （它给的是 `archiveRel` / `logRel`）。
 *   ⇒ 后果：**归档目录与活动日志永远被判成"未启用"**，
 *     连"全部启用"的项目也会被反复告知"你还没启用归档/日志"。
 *   ★★ 它**不会报错**（读 `undefined` 只是 falsy），所以是一类**静默的假阴性**：
 *     要让 `enabledKeysOf` 真报出 `info` 里确实有的字段，才测得出来。
 *   ⇒ 正解：**显式写 `infoField`**，不靠字符串拼 —— 拼出来的名字**没有任何东西保证它存在**。
 *     ★ 这正是本项目那条老纪律的形态：**字段名是"约定"，不是"查证过的接口"**。
 */

export function enabledKeysOf(info) {
  const on = new Set();
  for (const c of capabilityKinds()) {
    const v = info?.[c.infoField];
    if (typeof v === "string" && v !== "") on.add(c.key);
  }
  return on;
}

/**
 * 取**插件版本号**（唯一出口）。
 *
 * ★ 为什么读自己的 `package.json` 而不是写一个常量：写常量**一定会漂**
 *   （发了 1.2.0 忘了改常量 ⇒ 清单报旧版本，正是"记录存在≠记录准确"）。
 * ★★ 读不到就**如实返回 undefined**（不编一个版本号）——
 *   注入里会因此**不显示版本**，而不是显示一个假的。
 */

export function pluginVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // lib/
    const pkgPath = path.join(here, "..", "package.json");
    const raw = readTextSafe(pkgPath);
    if (raw === undefined) return undefined;
    const pkg = JSON.parse(raw);
    const v = pkg?.version;
    return typeof v === "string" && v !== "" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 功能清单文件路径（**插件自己的家** —— 用户的硬约束：不混进别人的项目）。
 */

export function capabilityStorePath() {
  return path.join(path.dirname(lockStorePath()), CAPABILITY_STORE_FILE);
}

/**
 * ★★★ 把"本版本有哪些能力"落盘成清单（**幂等**：内容没变就不写）。
 *
 * ★ 为什么每次都要能算出来并且**更新**：清单的意义就是**跟着插件版本走**。
 *   升了版本、加了能力 ⇒ 清单应当自动跟上（用户要的正是这个"跟着更新"）。
 * ★ 为什么幂等（内容相同不重写）：避免每次注入都动一次磁盘（无谓 IO +
 *   让"文件变新"这件事失去信息量）。
 * ★ 失败**绝不抛**（与 `locks.json` / `anchors.json` 同一口径）：
 *   清单写不出去不该让插件起不来或让注入失败。
 *
 * @returns {{path: string, written: boolean, version: string|undefined, count: number}}
 */

export function writeCapabilityManifest() {
  const p = capabilityStorePath();
  const version = pluginVersion();
  const payload = {
    schema: 1,
    plugin: LOCK_STORE_PKG,
    version: version ?? null,
    at: stamp(new Date()),
    // ★ 清单本身就是"功能清单"的正文：每项都带**怎么用**（否则只是一串名字）
    capabilities: capabilityKinds().map((c) => ({
      key: c.key,
      label: c.label,
      since: c.since,
      usage: c.usage,
    })),
  };
  let written = false;
  try {
    const prev = readTextSafe(p);
    // ★ 比较时**掐掉时间戳**：否则每次都会"看起来变了"⇒ 幂等失效。
    const strip = (s) => (s === undefined ? "" : s.replace(/^\s*"at":\s*"[^"]*",?\s*$/m, ""));
    const nextText = JSON.stringify(payload, null, 2) + "\n";
    if (strip(prev) !== strip(nextText)) {
      ensureDir(path.dirname(p));
      const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, nextText, "utf8");
      fs.renameSync(tmp, p);
      written = true;
    }
  } catch {
    /* 清单写失败不挡任何事（与锁/锚点同一口径） */
  }
  return { path: p, written, version, count: capabilityKinds().length };
}

/**
 * ★★★★★ 渲染"**还没启用的能力**"那一段（D196 的核心产出）。
 *
 * ★ 判据：只报**本版本有、而这个项目没启用**的那些。
 *   ⇒ 模型看到它就会知道：**"这个插件还有这些能力，我可以问用户要不要用"**。
 *   ★★ 这正是"跟着更新"的机制：老项目不会永远停在旧规格上。
 *
 * ★ 两条文案纪律：
 *   ① **不催**：不写成"你应该启用" —— 启不启用是用户的决定（本插件一贯"不擅自创建"）；
 *   ② **给路径**：每条都带**怎么启用**，否则模型只知道"有这个东西"却不知道怎么开。
 *   ⇒ 与 D195 那条判据同源：**只列名字不够，必须带用法**。
 *
 * @returns {string} 渲染好的 Markdown 片段（没有可报的就返回空串）
 */

export function renderUnenabledCapabilities(info) {
  const on = enabledKeysOf(info);
  const off = capabilityKinds().filter((c) => !on.has(c.key));
  if (off.length === 0) return "";
  const v = pluginVersion();
  return (
    "\n### ★ 这个插件**还有这些能力**，本项目尚未启用（D196 · 功能清单）\n" +
    (v === undefined ? "" : `（当前插件版本：\`${v}\`）\n`) +
    "★ 以下是**本版本插件带、但本项目清单里没登记**的记忆能力 —— 上面没列它们**不代表没有**。\n" +
    "★ 用途：**你在按旧规格维持这个项目时，要能知道后来多了什么**（否则插件更新对你等于没发生）。\n" +
    "★ **要不要启用由用户决定** —— 想用就**问用户**，别自己往项目里加文件（本插件不擅自创建）。\n\n" +
    off.map((c) => `- **${c.label}**（自 ${c.since}）—— ${c.usage}`).join("\n") +
    "\n"
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★★★ 2026-10-14（D197，用户拍板）：**骨架 + 协议** —— 让每条记忆都"填得对"
// ═══════════════════════════════════════════════════════════════════════════
//
//  用户原话（逐字）：*"最好就是插件本体在被指定项目之后就会**自动生成所需要的各项文件**，
//  然后由 AI 填写就可以了。然后 AI 自己也要从清单那里知道，**并且他要知道协议**，
//  也就是**他连协议都不知道的话，就很难去填这些东西**，以及按照插件的更新
//  去把老版本的文件拆分成新的文件。或者是按照新版本去更新新的台账系统和日志系统。"*
//
// ★★★ 这是 D196 的**下一层**（两轮递进，别混为一谈）：
//   · **D196**：模型知不知道该能力**存在**（可见性）；
//   · **D197**：模型知不知道每个文件的**格式协议**（能不能填对）。
//     ⇒ 用户那句"**不知道协议就很难去填**"是**准的**，而且实测比"能不能填对"更严重：
//       实测**协议 7/7 项都没推行**（`tools/_probe-d197-protocol-gap.mjs`）。
//
// ★★ 必须分清"协议"的两种形态（我核过，别把已经有的报成缺的）：
//   · **A. 工具参数协议**：走 `ledger_goals({op:"upsert",…})` 时，字段由**工具 schema** 定，
//     而工具定义**本来就在模型上下文里** ⇒ **这一面不缺**。
//   · **B. 文件正文协议**：模型**直接写文件内容**时（`initial*` 参数、以及**把老文件拆成新文件**）
//     才需要 ⇒ **这一面缺**。
//   ⇒ 判据：**哪些文件的格式是插件自己解析的，那些格式就必须算"协议"，必须推行。**
//     · `goals` ⇒ 插件 `parseGoalCards` 解析 ⇒ **格式固定**；
//     · `lessons` ⇒ 插件 `parseLessonEntries` 解析 ⇒ **格式固定**；
//     · `decisions` ⇒ 自检按 `^## D(\d+)` 查**引用必达** ⇒ **格式固定**；
//     · `journal` ⇒ 只追加、不解析 ⇒ 格式较自由（仍给形状）；
//     · `active` ⇒ **用户明说"结构由 AI 设计"** ⇒ **不锁格式**（只给起手骨架）；
//     · `principles` ⇒ **用户的文件，模型无权创建**（D180）⇒ **绝不给骨架**。
//
// ★★★ 为什么还要**骨架**（不只是协议）：
//   协议告诉模型"该长什么样"，骨架**把文件先建出来**（带表头与格式提示）⇒
//   ① 模型不必"先想格式再落笔"，**照着填**即可；② 格式从一开始就是对的，
//   不会出现"写了半天、插件解析不到"（那正是"他连协议都不知道就很难填"的后果）。
//   ★ 与前几轮"不擅自创建"的界线：**`ledger_init` 是用户明确要建项目的动作**
//     （不是工具顺手创建）⇒ 在这里建骨架是用户要的；而 `ledger_goals`/`ledger_lessons`
//     **仍然不凭空创建**（那两个是"日常写"的工具，不是"建项目"的动作）。

/**
 * ★★★ **每种记忆文件的骨架与协议 —— 单一出处**（骨架与注入那一段都由它渲染）。
 *
 * ★ 为什么不手抄进文档：手抄必漂（纪律 11）。这里的字符串**就是**解析器认的形状。
 * ★★ `skeleton` 与 `protocol` 分开：骨架是**文件里的**（给人和 AI 看），
 *   协议是**注入里的**（每回合提醒模型"格式别写错"）。
 */

export function fileSpecs() {
  return {
    active: {
      label: "活跃台账",
      // ★ 唯一**不锁格式**的文件：用户明说"结构由 AI 自己设计"。
      //   ⇒ 骨架只给**起手提示**，不规定分节（那是 AI 的判断）。
      skeleton:
        "# 项目台账 · 当前状态\n\n" +
        "> ★ **结构由你（AI）按项目类型设计** —— 插件只做流程，不预设模板。\n" +
        "> ★ 建议包含：项目目标 / 已完成 / 进行中 / 下一步 / 关键锚点（自己调整）。\n" +
        "> ★ 保持精简（上限见下方注入的「台账约定」）；超了先用 `ledger_archive` 归档最旧的已完成条目。\n",
      protocol: "", // ★ 刻意留空：它的格式**不由插件解析** ⇒ 不进"协议"那一段
    },
    decisions: {
      label: "关键决策",
      skeleton:
        "# 关键决策（长期保留 · 不参与归档）\n\n" +
        "> ★ 每条一行标题：`## D<n> · <一句话标题>`（n 递增、**不重用**）。\n" +
        "> ★ 台账里会写 `见 D<n>` —— 自检**会核对「引用必达」**（引用了却没有正文 ⇒ 当场变红）。\n" +
        "> ★ 追加用 `ledger_write({target:\"decisions\", mode:\"append\"})`。\n",
      protocol:
        "每条 `## D<n> · <标题>`（n 递增不重用）。台账用 `D<n>` 引用 ⇒ **引用必达**（引用了必须有正文）。" +
        "追加：`ledger_write({target:\"decisions\", mode:\"append\"})`。",
    },
    journal: {
      label: "回合流水",
      skeleton: "# 回合流水（只追加 · 不注入上下文）\n\n> ★ 按天/按会话**只追加**；**不要改旧条目**（发生过就是历史）。\n" +
        "> ★ 它**不注入**——要查早期某一段时才用 `ledger_read({target:\"journal\"})`。\n",
      protocol: "只追加、**不改旧条目**。写：`ledger_write({target:\"journal\"})`（默认 append）；查：`ledger_read({target:\"journal\"})`。★ 它**不注入**。",
    },
    goals: {
      label: "目标树",
      skeleton: "# 目标树\n\n" +
        "> ★ **卡片格式固定**（插件按这个解析；格式错了就**读不到**）：\n" +
        "> ```\n> ## 目标 <id> · <状态>\n> - parent: <父id 或 ->\n> - title: 一句话目标\n> - 更新于: <YYYY-MM-DD HH:mm>   ← 插件写卡时自动加，别手改\n> - 关键结果: 可选 · 可多行\n> - 教训: 可选 · 可多行\n> ```\n" +
        "> ★ `<状态>` 只能取：`root` / `active` / `paused` / `done` / `dropped`。\n" +
        "> ★ 优先用 `ledger_goals`（它保证格式对）；手写文件时**照上面的形状**。\n",
      protocol:
        "**卡片格式固定**（插件按此解析）：`## 目标 <id> · <状态>` + `- parent: <父id 或 ->` + `- title: …`" +
        " + `- 更新于: <YYYY-MM-DD HH:mm>`（★ **插件写卡时自动加，别手改** —— 它决定「已完成」的权重衰减与「多久没动」）" +
        " + 可多行 `- 关键结果: …` / `- 教训: …`。★ 状态只能取 `root`/`active`/`paused`/`done`/`dropped`。" +
        "★ 优先用 `ledger_goals`（保证格式对）；**手写文件必须照这个形状**。",
    },
    lessons: {
      label: "经验与教训",
      skeleton: "# 经验与教训\n\n" +
        "> ★ **两类条目，格式固定**（插件按这个解析）：\n" +
        "> ```\n> ## 经验 E<n> · <机制|入口|约定|速查|其他>\n> - 标题: …\n> - 出处: <文件:行号 / 探针 / 实测命令>   ← **经验必填**\n> - 正解: …\n> ```\n" +
        "> ```\n> ## 教训 L<n> · <尺子错|夹具错|守卫错|假设错|记录错|其他>\n> - 标题: …\n> - 根因: …   ← **教训必填**\n> - 正解: …\n> ```\n" +
        "> ★ 两类**各自编号**（`L<n>` / `E<n>`，不重用）。\n",
      protocol:
        "**格式固定**：`## 经验 E<n> · <kind>` 或 `## 教训 L<n> · <kind>`，随后 `- 标题:` 起若干 `- key: value`。" +
        "★ 经验 kind ∈ 机制/入口/约定/速查/其他，**`- 出处:` 必填**；" +
        "教训 kind ∈ 尺子错/夹具错/守卫错/假设错/记录错/其他，**`- 根因:` 必填**。★ 优先用 `ledger_lessons`。",
    },
  };
}

/** 取某类文件的骨架（没有就给空串 —— **`active`/`principles` 刻意不给**）。 */

export function skeletonOf(key) {
  return fileSpecs()[key]?.skeleton ?? "";
}

/**
 * ★★★★★ 渲染"**格式协议**"那一段（D197 的核心产出）。
 *
 * ★ 判据：**只报这个项目真的启用了的文件**（没启用的由 D196 那一段负责介绍）。
 *   ⇒ 两条各管一面，不重复：D196 = "还有什么能用"；D197 = "在用的这些该怎么写"。
 * ★ 为什么必须**每回合**都在：模型随时可能直接写这些文件（改老文件、拆分、迁移），
 *   而它**不会记得**上一次看过的格式。这东西很小（几百字），代价远低于"写错格式"。
 *
 * @returns {string} 渲染好的 Markdown 片段（没有可报的就返回空串）
 */

/**
 * ★★★★★ 2026-10-19（D272，用户拍板）：**协议过期时的义务提示**。
 *
 * 用户原话（逐字）：*"如果不符合的话，模型会主动向用户提出要求，询问是否要更新当前的
 * 协议和结构……这就意味着模型不会把它当成一个任务去做。"*
 *
 * ★★ 与 `renderProtocolBlock` 的分工（**各管一面，刻意相邻而不重复**）：
 *   · `renderProtocolBlock`  = "你正在用的这些，格式该怎么写"（已启用）
 *   · `renderUnenabledCapabilities` = "这个版本还带了什么能用"（未启用）
 *   · **本函数** = "**你这个项目的架构本身旧了，这是需要你主动去做的一件事**"
 *
 * ★ 三条设计依据（都来自本项目已栽过的坑）：
 *   ① **义务句式而非告知句式**：写"你必须在开场问用户"而不是"这个项目是旧的"——
 *      后者会被模型当背景资料读过去（D195/D196 反复验证过这一点）。
 *   ② **必须在开场问**：把时机写死。否则模型会"等有空再说"，而那件事永远不会发生。
 *   ③ **说清代价**：只说"缺 decisionsDir"等于让人猜；要说清"不升会怎样"。
 *
 * ⚠️ 只在 `outdated` 时输出；`projectVersion > currentVersion` 时**输出空串**
 *   （别人用更新的插件建的项目，旧插件不催他回退 —— 不前向破坏）。
 */
export function renderProtocolUpgradeNotice(info) {
  // ★ D272 第三轮：用户已经答过「暂时不升级」⇒ 换成"现状陈述"，**不再命令他必须处理**。
  //   判据见 `renderProtocolDeclinedNote` 的注释（告知义务 ≠ 催促频率）。
  const declined = renderProtocolDeclinedNote(info);
  if (declined !== "") return declined;

  const g = protocolGapOf(info?.manifest);
  if (g.outdated !== true) return "";

  // ★ 缺口为空也是一种"过期"：清单里字段齐全，只是**没写 protocolVersion**。
  //   那时不该吓唬用户说"架构旧了"，而该说清"只需补一个版本号"。
  const hasGaps = g.missing.length > 0;
  const lines = [];
  lines.push(
    "\n### 🔴 本项目记忆协议**停在旧版本**（第 " + g.projectVersion + " 代 / 现为第 " + g.currentVersion + " 代）"
  );
  lines.push("");
  lines.push("★ **这是你本次开场必须主动处理的一件事**（不要等用户问、也不要当成背景资料读过去）。");
  if (hasGaps) {
    lines.push("");
    lines.push("**这个项目缺下列结构**，所以它一直停留在旧架构：");
    for (const m of g.missing) {
      lines.push(`- **${m.label}** —— ${m.why}`);
      lines.push(`  · 清单里缺：${m.keys.map((k) => `\`${k}\``).join(" / ")}`);
    }
    lines.push("");
    lines.push(
      "**你该做的**：在**本回合开头**就问用户——" +
        "「这个项目的记忆结构还是旧版（" +
        g.missing.map((m) => m.label).join(" / ") +
        "），要不要我升级成新结构？**只做加法**：补清单字段、建空目录，绝不改写或删除已有内容。」"
    );
    lines.push("★ **不要自己先动手** —— 建目录/改清单会改动用户项目结构，必须**先得到他同意**。");
    lines.push(
      "★ 他同意之后：补清单键 + 建空目录 + 把 `protocolVersion` 写成 " +
        g.currentVersion +
        "，然后**把已有内容搬进新结构**（例如把单文件拆成一卡一文件）。"
    );
  } else {
    lines.push("");
    lines.push("★ 结构其实已经齐全（卡片化 / 日志分片都在），**只是清单里没写协议版本号**。");
    lines.push(
      "**你该做的**：本回合开场问用户一句——「要不要我把协议版本补记成第 " +
        g.currentVersion +
        " 代？」他同意后，在清单里补 `protocolVersion: " +
        g.currentVersion +
        "` 即可（**纯加一个字段，不动任何内容**）。"
    );
  }
  // ★ 用 "\n" 连接 —— 每条 `lines` 是**一整行**，行与行之间必须换行。
  //   ⚠️ 第一版写成 `join("")`，于是 `- **label**` 与 `  · 清单里缺：…` 会被拼成同一行
  //     （探针打出来才看见）。**判据：数组元素是"行"时，连接符就是换行。**
  return lines.join("\n") + "\n";
}

/**
 * ★★★★★ 2026-10-19（D272 第三轮）：**用户已经说了「不用改」之后，这段该怎么说。**
 *
 * 🔴 病（我在上面那个函数里埋的）：它每回合都写
 *   「★ **这是你本次开场必须主动处理的一件事**」。
 * 于是：
 *   ① 用户在合规卡上选了「不用改」 ⇒ `conformNext` 明确告诉他
 *      「**不要再动这个项目的台账结构**」；而下一回合注入又命令他
 *      「**你必须主动处理**」⇒ **两条指令直接打架**，而它们都来自我们。
 *   ② 就算用户没被问过（例如他根本没碰那张卡），每回合重复同一段"必须"，
 *      会让模型把这段当背景噪声读过去 —— **催得越勤，越没人听**。
 *
 * ★ 判据：**"告知义务"和"催促频率"是两件事。**
 *   · 告知：**每回合都要说**（否则模型会忘 —— D46 那条"推，不是等它来查"）；
 *   · 催促：**只在还没被答复过时说**，答复过就降级成"现状陈述 + 不要擅自改"。
 *
 * ★ 谁记"已经拒绝过"：`ledger_conform` 的答复走 `state.conformAsked`（会话级 Set）。
 *   这里拿不到那个 Set（`renderInjectionBody` 是纯函数），所以用**盘上的事实**判：
 *   清单里有没有 `protocolDeclined` 这个键（由拒绝那条路写下去）。
 *   ★ 用"盘上的事实"而不是"进程内状态"还有一个好处：**跨重启也记得**
 *     （用户说过一次不用改，不该因为重启就又被催一遍）。
 */
export function renderProtocolDeclinedNote(info) {
  const m = info?.manifest;
  if (m === null || typeof m !== "object") return "";
  const declinedAt = m.protocolDeclined;
  if (typeof declinedAt !== "string" || declinedAt === "") return "";
  const g = protocolGapOf(m);
  // 用户后来自行升级了（缺口没了）⇒ 这条提醒自然消失，不需要他再去清标记。
  if (g.outdated !== true) return "";
  return (
    "\n### 记忆协议：仍是旧版（**用户已知情并选择保持现状**）\n\n" +
    "★ 用户在 " +
    declinedAt +
    " 已经回答过这个问题：**暂时不升级**。\n" +
    "★ 所以：**不要再主动问他这件事**，也不要自己动手改结构（补键 / 建目录 / 迁移卡片）。\n" +
    "★ 但仍要知道现状：这个项目的记忆仍是第 " +
    g.projectVersion +
    " 代（现为第 " +
    g.currentVersion +
    " 代），" +
    (g.missing.length > 0
      ? "缺：" + g.missing.map((x) => x.label).join(" / ") + "。"
      : "结构齐全，只差版本号。") +
    "\n★ 什么情况下可以再提：用户自己问起、或他明确说要升级。**别的时候一个字都不用说。**\n"
  );
}

export function renderProtocolBlock(info) {
  const specs = fileSpecs();
  const on = enabledKeysOf(info);
  // ★ 只报**启用了**且**有固定协议**的那些（`active` 不锁格式、`principles` 无权创建）。
  //   ★★ 判据写死为"protocol 非空" ⇒ 以后加一类记忆、忘了写协议 ⇒ **它不会混进这一段**
  //     （宁可少报，也不许在这一段里出现一个空条 —— 那会让模型以为"协议就是空"）。
  const items = ["decisions", "journal", "goals", "lessons"].filter(
    (k) => on.has(k) && specs[k] !== undefined && String(specs[k].protocol ?? "").trim() !== ""
  );
  if (items.length === 0) return "";
  return (
    "\n### ★ 文件格式协议（**写这些文件前先看这一节** · D197）\n" +
    "★ 这些文件的格式**是插件解析用的** —— **写错格式 = 插件读不到**（内容还在，但等于白写）。\n" +
    "★ 优先用对应工具（它保证格式对）；**手写 / 迁移 / 拆分老文件时，必须照下面的形状**。\n\n" +
    items.map((k) => `- **${specs[k].label}**：${specs[k].protocol}`).join("\n") +
    "\n"
  );
}

/** 读锚点记录：`{ version, bySession: { sid: ratio } }`（坏条目丢掉，不整份作废）。 */

export function readAnchorStore() {
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

export function writeAnchorStore(store) {
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

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★★ 2026-10-17（D231，用户拍板方向②）：**「欠着的收尾义务」落盘**
// ═══════════════════════════════════════════════════════════════════════════
//
//  用户原话（逐字）：*"很多对话都是在下一个对话才补归档和分流，以及这些都是义务…
//  万一刚好结束对话的时候，落到压缩中的话，就会很麻烦。"*
//
//  ★★★ 病根（**读代码确认，不是推理**）：
//    义务提醒挂在 `agent/pre-step`（回合**开头**），而义务截止在回合**末尾** ——
//    走到回合末时插件**没有任何机会再出声**。
//    ⇒ 而记账用的 `state.turnObligationPending` 是**进程内 Map** ⇒
//      **进程一死（关窗口 / 崩溃 / 重启）就没了** ⇒ "上一条欠了什么"**跨进程不可见**。
//    ⇒ 所以他担心的"结束对话时正落入压缩"那一幕里，**连"欠着"这件事本身都会消失**。
//
//  ★ 修法：在 `turn/end` 那一刻把"欠了什么"**落盘**（`owed.json`）。
//    · 与 `locks.json` / `anchors.json` **同目录、同一套"临时文件 + 改名"、同一个吞错**；
//    · 只写 `$DSH_HOME\plugin-data\<包名>\`，**绝不碰用户工作区**（红线不变）；
//    · ⛔ **绝不在这里替模型写台账内容** —— 那会产出"看似完整其实空洞"的条目，
//      比欠着更坏（用户 D231 也否掉了这条路）。
//      ⇒ 落盘的只是**欠账凭据**，不是台账本身。
// ═══════════════════════════════════════════════════════════════════════════

/** 欠账记录文件路径（与锁、锚点同一个目录）。 */

export function owedStorePath() {
  return path.join(path.dirname(lockStorePath()), OWED_STORE_FILE);
}

/**
 * 读欠账记录：`{ version, bySession: { sid: { at, wrote, triaged, root, tag } } }`。
 *
 * ★ 全程吞错 + 逐条校验（坏条目丢掉而不是整份作废）—— 与 `readLockStore` 同一套。
 */

export function readOwedStore() {
  const empty = { version: 1, bySession: {} };
  const raw = readTextSafe(owedStorePath());
  if (raw === undefined) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return empty;
    const by = parsed.bySession;
    if (by === null || typeof by !== "object") return empty;
    const clean = {};
    for (const [sid, rec] of Object.entries(by)) {
      if (typeof sid !== "string" || sid === "") continue;
      if (rec === null || typeof rec !== "object") continue;
      // ★ 只有"真的欠着"才收：两个都兑现的条目**不许留在盘上**（否则下次假报欠账）。
      if (rec.wrote === true && rec.triaged === true) continue;
      clean[sid] = {
        at: Number.isFinite(rec.at) ? rec.at : 0,
        wrote: rec.wrote === true,
        triaged: rec.triaged === true,
        root: typeof rec.root === "string" ? rec.root : undefined,
        tag: typeof rec.tag === "string" ? rec.tag : undefined,
      };
    }
    return { version: 1, bySession: clean };
  } catch {
    return empty;
  }
}

/** 写欠账记录（吞错 + 临时文件改名；写不进去只影响"记不住"，绝不影响主流程）。 */

export function writeOwedStore(store) {
  const file = owedStorePath();
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
 * 记下 / 清掉一场对话的欠账 —— **唯一出口**（两个调用点都走这里，不许别处直接写盘）。
 *
 * ★ 为什么必须是唯一出口：本项目反复栽在"两处各写一套判据"上（D170/D222 都是）。
 *
 * @param {string} sid 会话编号
 * @param {{wrote:boolean, triaged:boolean, root?:string, tag?:string}} rec 本回合兑现情况
 * @returns {{ok:boolean, owed:boolean}}
 */

export function recordOwed(sid, rec) {
  if (typeof sid !== "string" || sid === "") return { ok: false, owed: false };
  const store = readOwedStore();
  const owed = rec?.wrote !== true || rec?.triaged !== true;
  if (!owed) {
    // 都兑现了 ⇒ 从盘上删掉（否则下一场会读到一条早已还清的假欠账）。
    if (store.bySession[sid] !== undefined) {
      delete store.bySession[sid];
      writeOwedStore(store);
    }
    return { ok: true, owed: false };
  }
  store.bySession[sid] = {
    at: Date.now(),
    wrote: rec?.wrote === true,
    triaged: rec?.triaged === true,
    root: typeof rec?.root === "string" ? rec.root : undefined,
    tag: typeof rec?.tag === "string" ? rec.tag : undefined,
  };
  // ★ 防无限增长：只留最近 `OWED_STORE_MAX` 场（欠账是"最近欠的"，老账没有意义）。
  const entries = Object.entries(store.bySession);
  if (entries.length > OWED_STORE_MAX) {
    entries.sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0));
    store.bySession = Object.fromEntries(entries.slice(0, OWED_STORE_MAX));
  }
  const w = writeOwedStore(store);
  return { ok: w.ok === true, owed: true };
}

/** 取一场对话在盘上有没有未还的欠账（**跨进程**可查）。 */

export function owedFor(sid) {
  if (typeof sid !== "string" || sid === "") return undefined;
  return readOwedStore().bySession[sid];
}

/**
 * 取这一场对话的压缩锚点（内存优先，其次落盘的那份）。
 * ★ **唯一的取锚点出口** —— 与项目锁同一条纪律：不许别处再直接读 Map
 *   （D51/D52 都是"写了新判定却漏了旧调用点"出的缺口）。
 */

export function anchorOf(state, key) {
  const mem = state?.deltaAnchor?.get(key);
  if (Number.isFinite(mem)) return mem;
  const disk = readAnchorStore().bySession[key];
  return Number.isFinite(disk) ? disk : undefined;
}

/** 记下这一场对话的锚点（内存 + 落盘各一份）。 */

export function setAnchor(state, key, ratio) {
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

export function blockHistoryPath() {
  return path.join(path.dirname(lockStorePath()), BLOCK_HISTORY_FILE);
}

/** 读区块变更史：`{ version, byRoot: { root: { writes, lastWriteAt, present, blocks } } }`。 */

export function readBlockHistory() {
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

export function writeBlockHistory(store) {
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

export function recordBlockHistory(root, text, nowMs) {
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

export function blockHistoryFor(root, nowMs) {
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

export function capsuleStorePath() {
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

export function autoFullLabel() {
  return `自动（${autoFullPct()}% 水位）`;
}

/** 同上，只存单那份的措辞（保留"压缩前"三个字，与本来的口径一致）。 */

export function autoFullLabelBefore() {
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

export function autoFullPct() {
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

export function hfSourceShort(src) {
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
 * ★★★★★ 2026-10-15（D215）：`compaction/end` 是不是**失败**的？—— **唯一出口**。
 *
 * ★ 为什么必须与 `compactionEndSucceeded` **共用同一个判据**：
 *   本项目的同族病（D159/D163/D164）就是"同一个事实写了两套判据 ⇒ 内核一改字段就分叉"。
 *   ⇒ 这里只留**一个**表达式，两个函数互为反面（`!failed` ⇔ `succeeded`）。
 *
 * ★ 判据吃**结构化字段**（`data.error`），不吃文案：内核在失败时才 append `error`
 *   （`session.append("compaction/end", { ...lifecycle, error: errorChain(error) })`，
 *   实测 `dsh-compaction-basic:495-498`），成功那条**根本没有这个键**
 *   ⇒ 一次判断就够，且不怕内核改措辞。
 *
 * @param {object} data `compaction/end` 事件的 `data`
 * @returns {boolean}
 */

export function compactionEndFailed(data) {
  return data?.error !== undefined;
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
 * ★★★★★ 2026-10-15（D215）：判据**下沉到 `compactionEndFailed`**（唯一表达式）——
 *   本函数现在只是它的反面。这样做是因为 L0 日志那条也要用同一个判据；
 *   若两处各写一遍 `data.error !== undefined`，就是 D159/D163/D164 的同族病换第三个地方复发。
 *
 * @param {object} event 会话事件
 * @returns {boolean} 只有"是 compaction/end 且没有 error"才为真
 */

export function compactionEndSucceeded(event) {
  return event?.type === "compaction/end" && !compactionEndFailed(event?.data);
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

export function compactVsInject(agent) {
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

export function shadowedStorePath() {
  return path.join(path.dirname(lockStorePath()), SHADOWED_INDEX_FILE);
}

/**
 * ★★★★ 2026-10-13（D182）：**把 cwd 编成官方会话目录名**。
 *
 * ★ 出处：**实测出来的，不是我推的** —— `tools/_probe-official-session-path.mjs`。
 *   ⚠️ 我第一版**推错了**：以为 `:` 与 `\` **都**换成 `-` ⇒ 产出 `D--Deepseek…`；
 *     真实目录名是 `--D-Deepseek~5DE5~4F5C~533A--`（**一个**连字符）。
 *     探针当场把三个 cwd 全部报 MISS ⇒ 才定案。**这就是"尺子先验"的又一次兑现。**
 * ★ 真规则：**盘符的 `:` 丢掉**；分隔符（`\` `/`）⇒ `-`；
 *   非 ASCII 字符 ⇒ `~XXXX`（大写十六进制；补充平面按 UTF-16 拆成两个）；
 *   整串**首尾各加 `--`**。
 * ★ 有损、**不可逆**：目录名内部的 `-`（如 `deepseek-harness`）与路径分隔符
 *   长得一样 ⇒ **只做正向编码，永不解码**（探针里的反解一路 MISS 就是这个原因）。
 *
 * @param {string} cwd 会话工作目录
 * @returns {string} 官方目录名（不含 sessions 前缀）
 */

export function encodeSessionDirName(cwd) {
  const BS = String.fromCharCode(92);
  let out = "";
  for (const ch of cwd) {
    // ★ 盘符的 `:` **丢掉**（不是换成 `-`）—— 这一行写错就是 D182 那个坑。
    if (ch === ":") continue;
    if (ch === BS || ch === "/") {
      out += "-";
      continue;
    }
    if (ch.codePointAt(0) < 128) {
      out += ch;
      continue;
    }
    for (const u of ch.length === 2 ? [ch.charCodeAt(0), ch.charCodeAt(1)] : [ch.charCodeAt(0)]) {
      out += "~" + u.toString(16).toUpperCase().padStart(4, "0");
    }
  }
  return "--" + out + "--";
}

/**
 * ★★★★★ 2026-10-13（D182）：**官方会话日志的绝对路径 —— 唯一出口**。
 *
 * ★ 用户对 ③ 索引的原话要求是：*"每一次压缩都把被压缩的原文建造一个索引
 *   （**…指向官方的保存**），这个索引只追加不删。"*
 *   ⇒ "指向官方的保存"就是这一函数存在的**全部理由**：
 *     索引原来只给 `ledger_recall({from,to})`（那是**读回我们内存里的日志**），
 *     而**官方那份**（内核自己写的、跨进程跨重启永在、我们无权删的）
 *     才是"最后一道回溯底牌"。指不指得到它，直接决定「可回溯性」这条底线。
 *
 * ★★ 红线怎么处理（这一条必须讲清楚，否则会被误读成"插件去读官方目录了"）：
 *   红线是「**不读、不写** `$DSH_HOME\sessions\`」。
 *   本函数**只算一个路径给模型看**，插件自己**一个字都不读、不写**。
 *   ★ 唯一一处例外是 `fs.existsSync` —— 见下面那条判据。
 *
 * ★★★ 判据：**算出来必须先验证它真的在**（`fs.existsSync`），在才返回。
 *   为什么（D164/D165 的同型防线）：这个路径会被**复制粘贴**去读。
 *   指向一个不存在的地方 ⇒ 模型照抄读不到、而台账写着"原文在这"
 *   ⇒ 直接伤「准确性」与「可回溯」—— 比"没有指针"更糟。
 *   ⇒ 宁可返回 `undefined`（渲染时**如实留空**），也绝不编一个路径。
 *
 * ★ 会话目录有两种形态（本机实测都有）：`session-<uuid>` 与**裸** `<uuid>`
 *   ⇒ 两种都试，命中哪个用哪个。
 *
 * @param {string} sid 会话 id（`agent.session.header.id`）
 * @param {string} cwd 会话工作目录（`agent.session.header.cwd`）
 * @returns {string|undefined} 官方 `session.v4.jsonl.zstd` 的绝对路径；算不出/不存在 ⇒ undefined
 */

export function officialSessionPath(sid, cwd) {
  try {
    if (typeof sid !== "string" || sid === "") return undefined;
    if (typeof cwd !== "string" || cwd === "") return undefined;
    const dir = path.join(dshHome(), "sessions", encodeSessionDirName(path.resolve(cwd)));
    for (const name of [`session-${sid}`, sid]) {
      const file = path.join(dir, name, "session.v4.jsonl.zstd");
      if (fs.existsSync(file)) return file;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * ★★★★★ 2026-10-13（D182）：**官方会话日志的展示形态**。
 *
 * ★ 为什么要单独一个函数：路径要在**注入**里出现，而注入是**模型读的**。
 *   直接甩一个 `<家目录>\.dsh\sessions\<一个很长的编码路径>`，
 *   既难读、又难核。⇒ 给两样东西：
 *     · `$DSH_HOME` 相对形态 —— 短、可读、跨机器可解释（模型看得出是同一条规矩）；
 *     · 绝对路径 —— 可**直接复制粘贴**去读（这是它存在的意义）。
 *   ★ 两者**必须来自同一个 `officialPath`**（D170：同一个事实不许两个出处）——
 *     否则"相对形态"和"绝对路径"会在某一次改动上分叉。
 *
 * @param {string|undefined} officialAbs `officialSessionPath` 的结果
 * @returns {string} 可直接拼进注入的一行；算不出 ⇒ **空串**（如实留空，绝不编）
 */

export function officialSessionDisplay(officialAbs) {
  if (typeof officialAbs !== "string" || officialAbs === "") return "";
  const home = dshHome();
  let rel = officialAbs;
  try {
    const r = path.relative(home, officialAbs);
    // 只在"确实在 home 里"时才用 `$DSH_HOME` 形态（`..` 开头说明不在，那就别假装）。
    if (!r.startsWith("..") && !path.isAbsolute(r)) rel = r.split(path.sep).join("/");
  } catch {
    /* 保留绝对路径 */
  }
  return `官方原件：\`$DSH_HOME/${rel}\`（可直接读；\`${officialAbs}\`）`;
}

/**
 * 读被压段索引：`{ version, bySession: { sid: [rec, …] } }`。
 *
 * ★ 逐条校验、**坏条目丢掉、不整份作废**（照 `readAnchorStore` / `readCapsuleStore`）。
 *   一条坏的索引不该让整份历史失去指针。
 */

export function readShadowedStore() {
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

export function writeShadowedStore(store) {
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

export function persistShadowedIndex(sid, list) {
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

export function shadowedIndexOf(state, sid) {
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

/**
 * 从一个 session 事件里抽出**会产生消息**的那部分文本。
 *
 * ★ 只回这些字段；其余（usage / source / 附件元数据）不回 ——
 *   否则会把上下文塞满与被压内容无关的技术字段。
 * ★ 抽成公共函数的原因：**回读（取正文）与索引（只取摘要）必须用同一把尺子**，
 *   否则"索引里说有 800 字、真去取只有 300 字"，模型会以为内容丢了。
 */
function eventTextOf(e, withReasoning) {
  const blocks = e.data?.message?.content ?? e.data?.content;
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
    return parts.join("\n");
  }
  if (typeof blocks === "string") return blocks;
  return "";
}

export function readSessionRange(session, from, to, opts) {
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
    const text = eventTextOf(e, withReasoning);
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
 * ★★★ 索引层：**先看有什么，再决定取哪段**（承 D79「回读预算 `R* ≈ 31K tok`」）。
 *
 * 为什么需要它（这是本函数存在的**唯一**理由）：
 *   `readSessionRange({from,to})` 是"整段一次取"，撞到字符闸门就截断。
 *   ⇒ 模型在**取之前**不知道里面有什么，只能靠注入里那一行摘要猜区间。
 *   猜错的代价是：要么取回来一堆无关内容（烧上下文），要么根本没取到。
 *   ⇒ 索引层把「哪一段落在哪个 seq、多长、开头说了什么」先给出来（**每条约 50–100 tok**），
 *     再让模型用 `seqs` 精确取正文（**每条约 500–1,000 tok**）。
 *
 * ★ 这一层**只读**，且**不改变任何已有效果**：不传 `mode` 时 `ledger_recall` 的行为逐字节不变。
 *
 * ★ 为什么不用向量检索：claude-mem 靠 Chroma 做语义检索，而我们的语料是**按 seq 线性的会话日志**，
 *   位置本身就是最强的信号（台账 D79 已论证）。给线性日志配向量库是过度设计。
 *
 * @param {object} session 当前会话
 * @param {number} from 起始 seq（含）
 * @param {number} to 结束 seq（含）
 * @param {object} [opts] `{ reasoning, gistChars, maxRows }`
 * @returns {{ok:boolean, rows?:Array, reason?:string}}
 */
export function readSessionIndex(session, from, to, opts) {
  const a = Math.max(0, Number(from) || 0);
  const b = Math.max(a, Number(to) || 0);
  const withReasoning = opts?.reasoning !== false;
  // ★ gist 默认 60 字：够看出"这条在讲什么"，又不至于让索引本身变成一份正文。
  const gistChars = Math.max(20, Math.min(200, Number(opts?.gistChars) || 60));
  const maxRows = Math.max(1, Math.min(2000, Number(opts?.maxRows) || 400));
  if (typeof session?.eventAt !== "function") {
    return { ok: false, reason: "这个执行里没有可读的会话（session.eventAt 不存在）" };
  }
  const rows = [];
  let totalChars = 0;
  let omitted = 0;
  for (let seq = a; seq <= b; seq += 1) {
    let e;
    try {
      e = session.eventAt(seq);
    } catch {
      e = undefined;
    }
    if (e === undefined || e === null) continue;
    // ★★ 与取正文**同一把尺子**（`eventTextOf`）—— 否则索引报的字数与真取到的对不上。
    const text = eventTextOf(e, withReasoning);
    if (text === "") continue;
    totalChars += text.length;
    if (rows.length >= maxRows) { omitted += 1; continue; }
    const flat = text.replace(/\s+/g, " ").trim();
    rows.push({
      seq,
      type: e.type,
      time: e.time,
      chars: text.length,
      gist: flat.length > gistChars ? `${flat.slice(0, gistChars)}…` : flat,
      // ★ 只给"有没有推理块"这一个粗信号：回读时可以据此决定要不要带 reasoning。
      hasReasoning: Array.isArray(e.data?.message?.content)
        ? e.data.message.content.some((c) => c?.type === "reasoning")
        : false,
    });
  }
  return {
    ok: true,
    rows,
    from: a,
    to: b,
    totalChars,
    events: rows.length,
    omitted,
    gistChars,
    reasoning: withReasoning,
  };
}

/**
 * 按**指定 seq 列表**取正文（索引层的第二段）。
 *
 * ★ 与 `readSessionRange` 的区别只有一个：**要哪些由调用方点名**，不按区间扫。
 *   闸门与截断语义完全一致（超了就停在那条之前并如实标注）。
 * ★ 为什么要单独一个函数而不是给 `readSessionRange` 加参数：
 *   两者的"范围来源"根本不同（一个是区间，一个是名单），混在一起判据会绕。
 *
 * @param {object} session 当前会话
 * @param {number[]} seqs 要取的 seq（去重、升序由调用方或这里保证）
 * @param {object} [opts] `{ maxChars, reasoning }`
 * @returns {{ok:boolean, events?:Array, chars?:number, truncated?:boolean, skipped?:number[], reason?:string}}
 */
export function readSessionPicked(session, seqs, opts) {
  const maxChars = Math.max(200, Number(opts?.maxChars) || 24000);
  const withReasoning = opts?.reasoning !== false;
  if (typeof session?.eventAt !== "function") {
    return { ok: false, reason: "这个执行里没有可读的会话（session.eventAt 不存在）" };
  }
  const wanted = [...new Set((Array.isArray(seqs) ? seqs : []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0))]
    .sort((x, y) => x - y);
  const out = [];
  const skipped = [];
  let chars = 0;
  let truncated = false;
  for (const seq of wanted) {
    let e;
    try {
      e = session.eventAt(seq);
    } catch {
      e = undefined;
    }
    if (e === undefined || e === null) { skipped.push(seq); continue; }
    const text = eventTextOf(e, withReasoning);
    if (text === "") { skipped.push(seq); continue; }
    if (chars + text.length > maxChars) { truncated = true; break; }
    chars += text.length;
    out.push({ seq, type: e.type, time: e.time, text });
  }
  return {
    ok: true,
    events: out,
    chars,
    truncated,
    // ★ 如实报告"点了名但取不到"的 seq —— 悄悄跳过会让模型以为自己取全了。
    ...(skipped.length > 0 ? { skipped } : {}),
    reasoning: withReasoning,
    picked: wanted.length,
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

export function recordShadowedIndex(state, sid, agent, source, extra) {
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
      // ★★★★ 2026-10-13（D182）：**官方的保存在这里不存**。
      //   ★ 为什么（D170「同一个事实不许两个出处」）：
      //     官方原件是**按会话**分目录的（`sessions/<编码 cwd>/<会话>/`），
      //     而本结构是一个会话一个数组 ⇒ 把同一个路径**在每条记录里都存一遍**，
      //     等于同一事实写了 N 份；将来它一变（换家 / 换会话），必有一部分是旧的。
      //   ⇒ 正确的落点：**渲染时按会话算一次**（见 `renderShadowedIndex` 的 `officialAbs`）。
      //     这样老记录（没有这个字段）也照样能拿到官方指针 —— 不需要数据迁移。
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
      // ★★★★★ 2026-10-13（D182，用户原话）：*"这个索引**只追加不删**"*。
      //
      //   ★ 原实现是 `if (list.length > idxMax) list.length = idxMax;` —— 这是
      //     **尾部截断**（保留最旧的 N 条），后果**恰好与用户要求相反**：
      //       到上限之后，**刚 push 进去的那条**（最新的路标）**被当场砍掉**
      //       ⇒ 索引**永久冻结在最早的 60 段**，而长会话里最需要的正是**最近的**路标。
      //   ★ 这不是我读代码"觉得"的：`tools/_probe-d182-append-only.mjs` 用同样的
      //     三行语义喂 62 条 ⇒ 第 61/62 条**不在结果里**（实测见红）。
      //   ⇒ 修法分两层，**不要混为一谈**（这是本处最容易写错的地方）：
      //     · **存储**（内存 + `shadowed.json`）：**永不删** —— 这就是"只追加"。
      //     · **注入**（模型每回合看到的那几行）：**必须仍有界** ——
      //       它是常驻上下文的东西，无限长会占掉上下文（D46 的"小到可常驻"）。
      //   ⇒ 有界只发生在**渲染**（`renderShadowedIndex`），不在**记录**。
      //     口径：**盘上全留、给模型看最近 N 条**。
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

export function capsuleDirRel(info, now) {
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

export function capsulePathFor(info, atMs) {
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
 *
 * ★★★★★ 2026-10-13（D182，用户原话*"这个索引**只追加不删**"*）：
 *   存储侧已经从"截断"改成"只追加"（见 `recordShadowedIndex` / `SHADOWED_STORE_SESSIONS`）。
 *   ⇒ 这里**仍必须有界**（口径：**盘上全留、给模型看最近 N 条**）：
 *     · 这一块是**常驻上下文**的东西（D46：它要"小到可常驻"）；
 *     · 若无限长，压得越久注入越大 ⇒ **反过来挤掉真正的内容**。
 *   ★★ 但要**如实告诉模型**"还有更旧的被折叠了"——否则它会以为
 *     "索引里没有 = 那段历史不存在"（这正是本项目反复修的「记录存在 ≠ 记录准确」）。
 *   ⇒ 折叠时补一行"更早的 N 段未展开，可在 shadowed.json 里取"。
 *
 * @param {object} state 插件状态
 * @param {string} sid 会话 id
 * @param {object} [agent] 会话 agent（用来取 `header.cwd` 算**官方原件**的路径）
 */

export function renderShadowedIndex(state, sid, agent) {
  // ★★★ 2026-10-13（D160）：**内存优先、落盘兜底** —— 原来只读内存，
  //   而重启后内存是空的 ⇒ 压缩后重注里**一句路标都没有**（真机实测：D159 §三）。
  //   ★ 走 `shadowedIndexOf`（唯一出口）而不是这里直接读两个来源：
  //     取法只有一处，将来改口径不会漏（D51/D52 都是"写了新判定却漏了旧调用点"）。
  const list = shadowedIndexOf(state, sid);
  if (!Array.isArray(list) || list.length === 0) return "";
  // ★ cwd 在**这一处**取（与 `recordShadowedIndex` 同一条口径）—— 别让三个调用点各写一遍。
  const cwd = agent?.session?.header?.cwd;
  const hm = (ms) => {
    try {
      return new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 16);
    } catch {
      return "?";
    }
  };
  // ★ 有界**只在渲染**：最近 N 条（新的在后面，取尾部）——与记录侧的"只追加"配合。
  const idxMax = Math.max(1, numOf("shadowedIndexMax", SHADOWED_INDEX_MAX));
  const folded = list.length > idxMax ? list.length - idxMax : 0;
  const shown = folded > 0 ? list.slice(list.length - idxMax) : list;
  // ★★★★★ 2026-10-13（D182）：**官方原件 —— 按会话算一次**（不在每行重复）。
  //   ★ 用户原话：*"每一次压缩都把被压缩的原文建造一个索引（…**指向官方的保存**）"*。
  //   ★ 为什么按会话算而不是按记录存：官方文件按 `sessions/<编码 cwd>/<会话>/` 分目录，
  //     而本索引**本身就是按会话分组的**（`bySession[sid]`）⇒ 一个会话只有一个官方文件，
  //     存进每条记录 = 同一事实写 N 份（D170）。★ 这样老记录也自动获得指针，无需迁移。
  //   ★ 算不出就**不显示这一行**（`officialSessionPath` 会验证存在性）——
  //     宁可没有，也绝不写一个指不到东西的路径（伤「可回溯」）。
  const officialAbs = officialSessionPath(sid, cwd);
  const officialNote =
    officialAbs === undefined
      ? ""
      : `★ **官方原件**（内核自己写的、跨重启永在，我们**无权删**）：\n` +
        `  \`${officialAbs}\`\n` +
        `  ★ 这是**最后一道回溯底牌**：上面的 \`ledger_recall\` 读的是**本进程**的会话日志，` +
        `而这个文件是**官方**的。两者都在 ⇒ 才叫"原文不丢"。\n\n`;
  const rows = shown.map((x) => {
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
  // ★ 折叠要**说出来**（不许让"没展开"被读成"不存在"）。
  const foldedNote =
    folded > 0
      ? `★ 上面只列出**最近 ${idxMax} 段**：更早的 **${folded} 段**未展开 —— 它们**没有被删**` +
        `（本索引**只追加**，全部记录在 \`$DSH_HOME/plugin-data/dsh-ledger-memory/shadowed.json\`）。` +
        `需要时按 seq 直接调 \`ledger_recall\`（seq 越大越新，往前推即可）。\n`
      : "";
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
    officialNote +
    foldedNote +
    rows.join("\n") +
    "\n"
  );
}

/**
 * 读胶囊素材：`{ version, bySession: { sid: {userMessages, errors, artifacts} } }`。
 * ★ 逐条校验，**坏条目丢掉、不整份作废**（照 `readAnchorStore` 的既有做法）——
 *   这个文件可能被人手改坏、也可能被半截写入；一条坏的不该让全部历史失效。
 */

export function readCapsuleStore() {
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
        // ★★★★★ 2026-10-13（D170）：这里用**硬上限**、不跟随设置 ——
        //   读盘是"把人家已经写下来的东西读出来"，按当前设置去砍它 =
        //   用户把 200 调回 40 时，盘上那 160 条当场失效（打穿 D159 的"只增不减"）。
        //   ⇒ 策略上限只在**内存**那一侧生效（`capsuleUserMsgMaxOf()`），
        //     这里只做"防手改坏/防异常大文件"的卫生。
        userMessages: um.slice(0, CAPSULE_STORE_USER_HARD_MAX),
        errors: er.slice(0, CAPSULE_STORE_ERROR_HARD_MAX),
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

export function writeCapsuleStore(store) {
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

export function mergeCapsuleMatter(prev, mem, caps) {
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
  // ★★★★★ 2026-10-13（D170）：默认上限取**硬上限**（不是策略上限）——
  //   这个函数把"盘上那份"与"内存这份"并起来写回盘上，而它的硬约束是
  //   **输出长度 ≥ 盘上那份长度**（D159 的形式化）。
  //   ★ 若默认取策略上限（设置值），用户把 200 调回 40 时，并集结果会被砍到 40
  //     ⇒ **盘上那 160 条当场蒸发**，正好违反它自己的硬约束。
  //   ⇒ 策略上限只在**内存**那侧生效；调用方（`persistCapsuleMemory`）显式传硬上限。
  const userMax = Number.isFinite(caps?.userMax) ? caps.userMax : CAPSULE_STORE_USER_HARD_MAX;
  const errorMax = Number.isFinite(caps?.errorMax) ? caps.errorMax : CAPSULE_STORE_ERROR_HARD_MAX;

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

export function persistCapsuleMemory(sid, mem) {
  if (typeof sid !== "string" || sid === "") return;
  if (mem === undefined) return;
  try {
    const store = readCapsuleStore();
    const prev = store.bySession[sid];

    // ★★★ 合并逻辑在**纯函数**里（`mergeCapsuleMatter`）—— 这里只管读/写/记账。
    //   ★ 为什么分开：那个函数是"这次修复的本体"，自检要能**单独摘掉它看红**；
    //     夹在这里的话摘掉它连落盘也一起摘了，反向验证分不清是谁在起作用（D136 的教训）。
    const merged = mergeCapsuleMatter(prev, mem, {
      // ★★★★★ 2026-10-13（D170）：**显式传硬上限**（不跟随设置）——
      //   这个函数的硬约束是"输出 ≥ 盘上那份"，跟随设置会把它破坏掉（见
      //   `mergeCapsuleMatter` 里 `userMax` 的注释）。策略上限只在内存那侧生效。
      userMax: CAPSULE_STORE_USER_HARD_MAX,
      errorMax: CAPSULE_STORE_ERROR_HARD_MAX,
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

export function hydrateCapsuleMemory(capsule, sid) {
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
      // ★★★★★ 2026-10-13（D168）：**必须用与 `rec()` 同一个出处**。
      //   ★ 原来这里手搭 `{userMessages, errors, artifacts}` —— **漏了 `seenMsgIds`**，
      //     而 `consume` 处理**用户原话**时要读它 ⇒ 一碰原话就 TypeError（被静默吞掉）。
      //   ★ 判据见 `newCapsuleRecord` 的注释（含真机症状的指纹）。
      live = newCapsuleRecord();
      for (const x of saved.userMessages ?? []) live.userMessages.push(x);
      for (const x of saved.errors ?? []) live.errors.push(x);
      for (const [p, o] of Object.entries(saved.artifacts ?? {})) live.artifacts.set(p, o);
      // ★★★★★ 2026-10-13（D170）：**截断必须走唯一出口**，被挤出的进归档通道。
      //   ★ 旧写法在这里 `if (live.userMessages.length < numOf("capsuleUserMsgMax", …)) push`
      //     —— 一个"够数就默默不 push"的循环：实测设置调到 5 时，
      //     **7 条原话既不在内存、也没进归档**（`drainEvicted` 拿回 0），无声消失
      //     —— 直接违背"一旦记住就永不丢"。
      //   ★ 顺带把上限换成与 `consume` 同一个出口（原来两侧一个常量、一个设置项）。
      trimUserMessagesInPlace(live, capsuleUserMsgMaxOf());
      trimErrorsInPlace(live, capsuleErrorMaxOf());
      capsule.set(sid, live);
      // ★ 返回值语义：**补进来多少条素材**（供调用方如实报"hydrated N"）。
      return live.userMessages.length + live.errors.length;
    }

    const keyOf = (x) => `${x.at ?? ""}\u0000${x.text}`;
    const have = new Set(live.userMessages.map(keyOf));
    const older = saved.userMessages.filter((x) => !have.has(keyOf(x)));
    if (older.length > 0) {
      // 内存里是"新→旧"；盘上那批更旧 ⇒ 接在尾部，再截到上限（**溢出进归档**）。
      live.userMessages = live.userMessages.concat(older);
      trimUserMessagesInPlace(live, capsuleUserMsgMaxOf());
    }

    const haveErr = new Set(live.errors.map(keyOf));
    const olderErr = saved.errors.filter((x) => !haveErr.has(keyOf(x)));
    if (olderErr.length > 0) {
      live.errors = live.errors.concat(olderErr);
      trimErrorsInPlace(live, capsuleErrorMaxOf());
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

export function persistentLockFor(sid) {
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

export function activeLockFor(sid) {
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

export function lockedRootOf(agent) {
  return activeLockFor(agent?.session?.header?.id);
}

/**
 * 锁定 / 解锁 / 查询（`ledger_lock` 与 `/ledger lock` 共用这一处，避免两处口径分叉）。
 *
 * ★ 现在会**同时**写内存（立刻生效）与落盘（跨重启记得住）。落盘失败**不挡锁定**，
 *   但会把原因如实带回 —— 否则用户会以为"记住了"，而下次重启又没了。
 */

export function setProjectLock(agent, root) {
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

export function tagOfId(id) {
  if (typeof id !== "string" || id === "") return undefined;
  // `session-<uuid>` ⇒ 去掉 `session-` 前缀，取第一段 hex 的前 4 位。
  const core = id.replace(/^session-/, "");
  const seg = core.split("-")[0] ?? core;
  const tag = seg.slice(0, 4).toLowerCase();
  return /^[0-9a-z]{4}$/.test(tag) ? tag : undefined;
}

export function sessionTag(agent) {
  return tagOfId(agent?.session?.header?.id);
}

/** 渲染"这条是谁写的"前缀；没有编号可用时给空串（不硬造）。 */

export function tagPrefix(tag) {
  return tag === undefined ? "" : `[${tag}] `;
}

/**
 * 取出文本里的**条目行**（`- xxx` / `* xxx` / `1. xxx`），忽略标题与空行。
 *
 * ★ 为什么只认条目行：多会话保护要判断"哪些内容会被这次覆盖弄丢"。
 *   标题（`## 已完成`）在 AI 重排结构时会正常地"消失"，把它当成丢失内容会
 *   制造大量假告警；而**条目**才是真正的进展，也正是用户说的"条目"。
 */

export function entryLines(text) {
  if (typeof text !== "string") return [];
  return text.split("\n").filter((l) => /^\s*(?:[-*+]|\d+\.)\s+\S/.test(l));
}

/** 自动保留区的标题。它出现在活跃台账里，是可见、可归档的普通内容。 */

export function splitBlocks(text) {
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

export function fnv1a(s) {
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

export function mechanicalWeight(block, hist, nowMs) {
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
  //
  //    ★★★★ 2026-10-20（D284）补了「已作废」这一族 —— 原来漏了它：
  //      实测 `decisions/` 有 **5 张卡** heading 明写「已作废」（D274–D278，团队方向被整体回退），
  //      而词表里**没有"已作废"** ⇒ 它们 `done` 不成立 ⇒ **与有效卡一样参与排序**。
  //      ⇒ 这两件事本来是同一种状态（"这条路已经不算数了"），只是用了不同的词。
  //
  //    ⚠️⚠️ **判据只吃 `h`（卡片标题 / 区块标题），绝不许扫正文。**
  //       实测反证：正文里提到"作废"的卡有 **7 张**（D49 / D57 / D117 / D136 / D173 / D254 / D279）——
  //       它们说的都是**卡内某个局部结论**作废（"上一版数字作废"、"我上轮那条建议已撤销"），
  //       卡片本身**完全有效**。扫正文会把它们一起误伤。
  //       ⇒ 这正是 D136 那条「`isPrinciple` 判据别变成认关键词」的同型陷阱。
  //       判据必须吃**结构位**（heading），不能吃**全文**。
  const done =
    /\u5df2\u5b8c\u6210|\u5df2\u5904\u7406|\u5df2\u8fc7\u671f|\u4e0d\u8981\u91cd\u505a|\u522b\u518d\u91cd\u505a|\u5df2\u4f5c\u5e9f|\u5df2\u5e9f\u5f03|\u5df2\u64a4\u9500|\u5df2\u88ab\u53d6\u4ee3|\u88ab\u5426/.test(
      h
    );
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

export function weightFromAnswers(a) {
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

export function ranksOf(entries, better) {
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

export function starValueOf(text) {
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

export function fuseWeight(blocks, histByHash, modelAnswers, isPrinciple) {
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

export function weightBlocks(blocks, modelAnswers, histByHash, nowMs) {
  void nowMs; // ★ 融合用的是**相对**序，不需要"现在"这个绝对量（用户已更正）
  return fuseWeight(blocks, histByHash, modelAnswers);
}

/** 必注阈值（用户 2026-10-12 拍板：*"我建议是改成 50 分注入"*）。
 *  ★ 归一化后"50 分"= **接近榜首的一半** ⇒ 它随台账组成自动收放，不必调参。 */

export function renderToc(blocks, opts) {
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

export function diffBlocks(prev, next) {
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
 *
 * ★★★ 2026-10-20（issue #1）：`body` 现在 = **登记区之前 + 登记区之后**拼起来。
 */

export function splitChangeRegister(text) {
  if (typeof text !== "string" || text === "") return { body: "", entries: [] };
  const idx = text.indexOf(CHANGE_REGISTER_HEADING);
  if (idx < 0) return { body: text, entries: [] };
  const head = text.slice(0, idx).replace(/\s+$/, "");
  const rest = text.slice(idx + CHANGE_REGISTER_HEADING.length).split("\n");
  // ★★★★ 2026-10-20（issue #1 的真根因）：**登记区的边界不是一个标题，而是一段「登记行」**。
  //
  //   🔴 病（用户真机上撞到，issue #1 附了最小复现）：原来从标题处**一刀切到文本末尾** ⇒
  //      只要「登记区之后还有内容」—— 调用方把登记区抄在 `newActive` 中间、或盘上那份
  //      被人手工挪过位置 —— **后面的正文就被静默当成登记区丢掉**。
  //      探针 `_probe-issue1-dropped2.mjs` 实测：`## B 段 / B 正文` 整段消失，而调用报 ok。
  //
  //   ⇒ 正解：**先跳过标题后的 `>` 说明行与空行，再连着吃掉登记行**；遇到第一条
  //      「不是登记行」的非空行 ⇒ 登记区到此为止，**剩下的全部还给正文**（拼回 `body`）。
  //   ★ 这不只是修一个边角：`lostLines` / `bodyLineCount` / `lostEntries` 全都吃 `body`，
  //      切掉尾巴会让「整份正文」这把尺子**系统性看不见一段**（issue #1 的主症状）。
  //
  //   ★★ `>` 引用行**只在第一条登记行之前**才算"说明"。见过登记行之后再遇到 `>`，
  //      它是**正文里的引用块**（台账里很常见），必须留给 `body` ——
  //      否则"登记区后面跟着一段引用"会被静默吃掉，正是这次要修的那个病换个形状复发。
  let i = 0;
  let sawEntry = false;
  while (i < rest.length) {
    const t = rest[i].trim();
    if (t === "") { i += 1; continue; }
    if (CHANGE_REGISTER_LINE_RE.test(t)) { sawEntry = true; i += 1; continue; }
    if (!sawEntry && t.startsWith(">")) { i += 1; continue; } // 标题下的那两行说明
    break;
  }
  const entries = rest
    .slice(0, i)
    .map((l) => l.trim())
    .filter((l) => CHANGE_REGISTER_LINE_RE.test(l));
  // ★ 收尾要把"为了探边界而跳过的空行"还回去：`rest.slice(i)` 之后若还有正文，
  //   前面的空行属于**正文的分隔**，不是登记区的残渣。
  const tail = rest.slice(i).join("\n").replace(/^\s*\n/, "").replace(/\s+$/, "");
  // ★ 两段都非空时用一个空行接起来 —— 登记区本来就在两段之间，删掉它之后
  //   前后两段是**连续正文**，拼回去才是"移走登记区"而不是"又切了一刀"。
  const body = head === "" ? tail : tail === "" ? head : `${head}\n\n${tail}`;
  return { body, entries };
}

/** 渲染变更登记区（含标题）。`entries` 新的在前。 */

export function renderChangeRegister(entries, max) {
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

export function changeRegisterMaxOf(info) {
  // ★ D222：改走**唯一出口**。默认「以面板为准」⇒ 面板改了这个数，所有项目立刻跟。
  const n = Number(precedenceValue(info, "changeRegisterMax"));
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

export function modeOf(info) {
  // ★ D222：改走**唯一出口**（默认「以面板为准」）。
  const m = precedenceValue(info, "mode");
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

export function triageRequired() {
  return TRIAGE_ALWAYS;
}

/** 清单里的 mode 是不是写错了（供 `ledger_status` 如实报告，不静默）。 */

export function modeManifestSuspect(info) {
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

export function bodyLineCount(text) {
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

export function withChangeRegister(text, line, priorText, max) {
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

export function changeRegisterLine(now, rec) {
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

export function lostEntries(currentText, nextText) {
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
 * ★★★★★ 2026-10-18（D267 · 修 review v1.2.7 的 F05）：**按整份正文算"哪些行被移走了"**。
 *
 * 🔴 病（review 实测）：上面那个 `lostEntries` 只从 **Markdown 列表行**里提取
 *   （`entryLines` 的正则是 `^\s*(?:[-*+]|\d+\.)\s+\S`）⇒ **普通段落、表格、代码块、
 *   引用块、标题正文全都不进去**。而 `ledger_archive` 的"不许丢内容"判据**只用它**。
 *   实测复现：
 *   ```
 *   # Ledger
 *   ## Critical constraint
 *   MUST PRESERVE THIS PLAIN PARAGRAPH      ← 不是列表行 ⇒ 判据看不见它
 *   - completed
 *   ```
 *   传 `entries:'- completed\n'`、`newActive:'# Ledger\n'` ⇒ **归档返回成功**，
 *   而那段关键段落**既没进归档、也没留在新台账**。
 *
 * ★ 为什么不能"把 entryLines 改成吞下所有行"就完事：
 *   同一个 `entryLines` 还喂着**多会话自动保留**那条路。那里若把所有正文都当"条目"，
 *   标题、空行、代码围栏都会被搬进"其他会话的进展"区 ⇒ **大量假告警**（D89 那类）。
 *   ⇒ ★ 正解是**两根尺子并存，各管各的**：
 *      · `lostEntries`（列表行）—— 继续管"多会话自动保留"（它要的是**条目粒度**）；
 *      · `lostLines`（**整份正文逐行**）—— 新尺子，只管 `ledger_archive` 的
 *        "**移走 ≠ 删除**" 那条硬约束（它要的是**一个字节都不许凭空消失**）。
 *
 * ★ 判据怎么算才不误报（这几条都是踩过的）：
 *   ① **按行比对、保留计数**，不用 `Set` / `includes` —— 重复行（例如两条 `---`）若用集合，
 *      丢了一条也看不出来（review 明确写了"重复内容需要保留计数和顺序语义"）。
 *   ② 两侧都先**归一化**（去行尾空白、`\r\n` → `\n`）—— 否则 CRLF 文件会整份误报。
 *   ③ **空行不计**：台账被精简时空行必然变，把它算成"丢失"会淹没真信号。
 *   ④ 仍然**剥掉变更登记区**（理由同 `lostEntries`）。
 *
 * @returns {string[]} 在 `currentText` 里有、而在 `nextText` 里**数量不够**的那些行（原样保留，供报错展示）
 */

export function lostLines(currentText, nextText) {
  const normLine = (l) => String(l).replace(/\r$/, "").replace(/\s+$/, "");
  // ⑤ **标题行不计** —— 这一条是自检 22g 当场抓出来的（第一版没排除它 ⇒ 合法归档被误拒）。
  //    理由与 `entryLines` 当初排除标题**逐字相同**：归档把某标题下的条目全搬走之后，
  //    那个标题**变成空标题**，删掉它是最正常的整理动作 —— 把它算成"丢失"会制造大量假告警。
  //    ★ 但它只是"不计入丢失"，**不是"不保护"**：标题下面的正文仍然是内容，
  //      照样会被下面那条判据逐行盯着（review 的 R5 用例正是靠那段正文被拦下的）。
  const isHeading = (l) => /^\s*#{1,6}\s/.test(l);
  const tally = (text) => {
    const m = new Map();
    for (const raw of splitChangeRegister(text ?? "").body.split(/\r?\n/)) {
      const l = normLine(raw);
      // ③ 只忽略**纯空行**与**标题行**；表格行、代码行、引用、嵌套列表全部计入
      if (l.trim() === "") continue;
      if (isHeading(l)) continue;
      m.set(l, (m.get(l) ?? 0) + 1);
    }
    return m;
  };
  const before = tally(currentText);
  const after = tally(nextText);
  const out = [];
  for (const [l, n] of before) {
    const kept = after.get(l) ?? 0;
    // ① 差几条就报几条（保留计数语义）
    for (let i = kept; i < n; i++) out.push(l);
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

export function manifestRevision(manifest) {
  return Number.isFinite(manifest?.revision) && manifest.revision >= 0
    ? Math.floor(manifest.revision)
    : 0;
}

/** 把清单里的 revision +1 并写回。返回新值。失败时返回 undefined（调用方别据此声称成功）。 */

export function bumpRevision(root) {
  try {
    const prev = readManifest(root);
    if (prev === undefined) return undefined;
    const next = { ...prev, revision: manifestRevision(prev) + 1, updatedAt: stamp(new Date()) };
    // ★★★★★ 2026-10-18（D266 · 修 review F06 的第三处）：**清单也必须原子写**。
    //   🔴 原来这里是直接 `fs.writeFileSync`。清单被截断的后果**比台账更隐蔽**：
    //      revision 读不出来 ⇒ 退化成 0 ⇒ 所有会话的 `ifRevision` 全都对不上或被当成"最新"
    //      ⇒ **多会话保护静默失效**，而没有任何一处会报错。
    //   ★ 它是"恢复所需记录"（review 的原话），写失败必须在返回值里体现（`undefined`）。
    const w = writeFileAtomic(path.join(root, MANIFEST_REL), JSON.stringify(next, null, 2) + "\n");
    if (w.ok !== true) return undefined;
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

export function writeManifestMode(root, info, mode) {
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

export function compactionServiceFor(ctx, agent) {
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

export function toolCallDeltaOf(event) {
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

export function balanceFlagsOf(session, nodes) {
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

export function estimateCompressibleTokens(ctx, agent, pressure, since, settings) {
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

export function compGateDecision(compressible, minPoints, window, forced) {
  // ★ 手动豁免：那是人的明确授权，不该被"划不划算"挡住（D40/D114 的既有取舍）。
  if (forced === true) return { pass: true, why: "manual" };
  // ★★ 量不到 ⇒ **放行**（不是拦）：闸门目的是省钱，不是阻止压缩。
  //   拿不到数就拦 ⇒ "测不到"会变成"永远不压" —— 那正是 D59 事故的形态。
  if (compressible === undefined) return { pass: true, why: "unmeasurable" };
  const minTokens = (Math.max(0, minPoints) / 100) * window;
  if (compressible < minTokens) return { pass: false, why: "tooSmall" };
  return { pass: true, why: "bigEnough" };
}

export function selectIncrementalRange(session, measurement, retainTokens) {
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
 * ★★★★★ 2026-10-14（D190，用户拍板）：**选出「上一个回合」的范围** —— 供 `/ledger light` 用。
 *
 *   用户原话（逐字）：*"第二是模型现在不是每次回复都会履行写台账和分流义务吗？
 *   那轻量压缩就可以用了——变成手动命令，效果是**对上一个回复进行压缩**。"*
 *
 * ★ 语义（照用户的措辞定）：**「上一个回复」= 最近那个已经结束的回合**。
 *   ⇒ 取**最后一个 `turn/end` 之前**、且**在更早那个 `turn/end` 之后**的那一段。
 *   ★ 为什么必须锚在 `turn/end` 而不是"最近 N 个节点"：
 *     用户说的是"**上一个回复**"（一个**回合**），不是"最近一段消息"。
 *     锚在回合边界 ⇒ 压掉的正是一个**完整、自洽**的单元（不会压半个回合）。
 *
 * ★★ 两个边界都必须是**平衡切点**（内核 `compactRegion` 会校验，见其 `:557-558`）：
 *   起点要 `toolPairingBalancedBefore`、终点要 `toolPairingBalancedAfter`，
 *   否则内核**直接抛错**。⇒ 这里复用既有的 `balanceFlagsOf`（与增量那条同一把尺子）。
 *
 * ★ 为什么不复用 `selectIncrementalRange`：那个的语义是"**保留最近一大块、压最旧的**"，
 *   本函数的语义是"**只压上一个回合**"—— **方向相反**（那是从头压，这是从尾压）。
 *   硬套会把语义搅乱 ⇒ 另立一个函数，但**共用同一把平衡尺子**。
 *
 * @param {object} session 会话（要 `surface.nodes` 与 `eventAt`）
 * @param {Array} priced `measurement.nodes`（校验用；与 surface 必须同长同序）
 * @returns {{start:number, end:number}|null} 要压的闭区间；拿不到就 `null`（**绝不猜**）
 */

export function selectLastTurnRange(session, priced) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  if (!Array.isArray(priced) || priced.length !== nodes.length) return null;
  // 内核会校验 token-meter 的 surface 与当前 surface 一致；不一致就别猜（与增量那条同规矩）。
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i] !== priced[i]?.seq) return null;
  }

  // ★★★★★ **第一版选法在这里，已作废 —— 留档，别再写回去**：
  //   我原来想"在 surface 里从后往前找 `turn/end`"来定位回合边界。
  //   ★★★ 探针 `tools/_probe-d190-turn-on-surface.mjs` 实测（**32 个可判定会话，0 个命中**）：
  //     **`turn/end` 根本不在 surface 上** —— 全库 705 个 `turn/end` 事件，
  //     与 `compaction/summary.shadowedSeqs`（内核亲自写的 surface 真子集）**零交集**。
  //   ⇒ 照那一版发布 ⇒ `/ledger light` 会**永远**回"找不到可压的上一个回合" ⇒ **功能等于没做**。
  //   ★★ 而它当时的表现是"**三个既有断言变红**" —— 那**不是夹具坏了**，
  //     是**我的实现依赖了一个不存在的东西**（纪律 8 的镜像：夹具前提错了会假绿，
  //     **实现前提错了会假红**，两者都是"前提没验"）。
  //   ⇒ 所以我**没有**去改夹具让它变绿，而是先证明前提，再按事实重写（见下）。
  //
  // ── 正解：surface 上只有"消息类"事件，没有回合标记 ⇒ 从**消息序列**里推 ──────
  //   "上一个回复"= 从**用户提问**到**模型答完**那一段 ⇒ 锚在 `user/message`。
  const typeAt = (seq) => {
    try {
      return session.eventAt(seq)?.type;
    } catch {
      return undefined;
    }
  };
  // ① 从尾部往前找**最近那个 `user/message`**（"上一个回复"的起点）。
  let startIdx = -1;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    if (typeAt(nodes[i]) === "user/message") {
      startIdx = i;
      break;
    }
  }
  if (startIdx <= 0) return null;
  // ② ★ 必须**再往前还有一个 `user/message`** —— 否则"最近这个"就是整场的第一问，
  //    压掉它等于把整段历史都压了（那不是"压上一个回复"，那是"全压"）。
  //    ⇒ 找不到更早的那个 ⇒ **拒绝**（如实回 null），绝不猜。
  let prevUserIdx = -1;
  for (let i = startIdx - 1; i >= 0; i -= 1) {
    if (typeAt(nodes[i]) === "user/message") {
      prevUserIdx = i;
      break;
    }
  }
  if (prevUserIdx < 0) return null;

  let endIdx = nodes.length - 1;
  // ★★ 首个节点若是 system/message ⇒ 它永不进压缩范围（内核 `systemHead` 的语义）。
  const headType = typeAt(nodes[0]);
  if (headType === "system/message" && startIdx === 0) startIdx = 1;

  // ── 两个边界都挪到最近的**平衡切点**（内核会校验，挪不动就放弃）──────────────
  //   ★★★ 这一段我**第一版写错了**，正解留在这里（纪律 9：别凭印象猜形状）：
  //     我原以为 `balanceFlagsOf` 返回 `{before, after}` —— **它返回的是扁平 `boolean[]`**，
  //     长度 `nodes.length + 1`，语义是 `flags[i]` = **第 i 个节点之前那个切点**是否平衡
  //     （`flags[nodes.length]` = 最后一个节点**之后**那个切点）。
  //     ⇒ 于是：**起点**要 `flags[startIdx] === true`；**终点**要 `flags[endIdx + 1] === true`。
  //   ★ 与 `selectIncrementalRange` **同一把尺子**（`_probe-toolpairing-parity.mjs` 验过
  //     它与内核逐位一致）⇒ 不会在这里分叉出第二套判据。
  const flags = balanceFlagsOf(session, nodes);
  //   起点：不平衡就往**后**挪（直到找到一个"之前是平衡的"节点）。
  while (startIdx <= endIdx && flags[startIdx] !== true) startIdx += 1;
  //   终点：剪口不平衡就往**前**挪（`flags[endIdx + 1]` = endIdx 之后那个切点）。
  while (endIdx >= startIdx && flags[endIdx + 1] !== true) endIdx -= 1;
  if (startIdx > endIdx) return null;
  // ★ 压掉一整段必须**至少含两个节点**（否则等于没压，纯粹白付重注成本）——
  //   那正是 D141「空转闸门」的同一条理由，这里就地兜一层。
  if (endIdx - startIdx < 1) return null;
  return { start: nodes[startIdx], end: nodes[endIdx] };
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

export function compactionReachVia(ctx, agent) {
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

export function userMsgArchiveRel(info, now) {
  const rel = info?.archiveRel;
  if (typeof rel !== "string" || rel === "") return undefined;
  const { dir: period } = archiveStamp(now, info?.manifest?.archiveWeekMode);
  return `${rel}/${period}/${USER_MSG_ARCHIVE_FILE}`;
}

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

export function capsuleUserMsgMaxOf() {
  return numOf("capsuleUserMsgMax", CAPSULE_USER_MSG_MAX);
}

/**
 * ★★★★★ 2026-10-13（D170）：**「胶囊收几条报错」的上限 —— 唯一出口**。
 *
 * ★ 报错这一对当时**没有**分叉（两侧都写了 `numOf("capsuleErrorMax", …)`），
 *   但**写法**仍散在多处（`consume` / `hydrate` / 落盘 / 渲染各一遍）。
 *   ⇒ 收成出口是为了**不让下一次改动只改到一处** —— 这正是 D168/D170 抓到的形状。
 *   ★ 与用户原话那对**故意对称**：将来任何人要改错这一对，两处一眼看得出是孪生的。
 */

export function capsuleErrorMaxOf() {
  return numOf("capsuleErrorMax", CAPSULE_ERROR_MAX);
}

/**
 * ★★★★★ 2026-10-13（D170）：把记录里的用户原话截到上限，**被挤出去的送进归档通道**。
 *
 * ★ 为什么必须共同一个函数（而不是每处各写一遍 `slice`）：
 *   `consume()` 那处原本**自带**归档（D84 修复），而 `hydrate()` 那处**只 slice** ——
 *   于是"重启后从盘上补回来"这条路上，被挤掉的原话**没有任何去处**（实测 drainEvicted = 0）。
 *   ★ 判断"哪一条被挤出"的知识只该有一份（就是这里的 `slice(cap)` 语义），
 *     在别处再算一遍 = 两套判据必然分叉（D59 的老坑，本文件已记过多次）。
 *
 * ★ 它**就地改** `r`，并把溢出追加到 `r.evictedUserMessages` ——
 *   那正是 `drainEvicted()` 读的字段，所以调用方（`session/event` 里那段）会照常归档。
 *
 * @param {{userMessages:Array, evictedUserMessages?:Array}} r 胶囊记录（就地修改）
 * @param {number} cap 保留几条
 * @returns {number} 被挤出去几条
 */

export function trimUserMessagesInPlace(r, cap) {
  if (r === undefined || !Array.isArray(r.userMessages)) return 0;
  if (!Number.isFinite(cap) || cap < 0) return 0;
  if (r.userMessages.length <= cap) return 0;
  const evicted = r.userMessages.slice(cap);
  r.userMessages.length = cap;
  if (!Array.isArray(r.evictedUserMessages)) r.evictedUserMessages = [];
  r.evictedUserMessages.push(...evicted);
  return evicted.length;
}

/**
 * ★★★★★ 2026-10-13（D170）：把记录里的**报错原文**截到上限（**不归档** —— 见下）。
 *
 * ★ 与 `trimUserMessagesInPlace` 收成一对的理由是**对称性**：两侧的上限本来就都走
 *   `numOf("capsuleErrorMax", …)`（没分叉），但**截断动作**原来也是各写一遍
 *   （`consume` 里一句 `.length = errMax`、`hydrate` 里一句 `.slice(0, errMax)`）。
 *   ⇒ 留着两处就等着下一次"只改了一处"（这正是 D168 抓到的那个形状）。
 *
 * ★ 为什么报错**不**进归档通道（与用户原话不对称）：
 *   D84 只为**用户原话**建立了"一旦记住就永不丢"的兜底（`evictedUserMessages`
 *   ⇒ `用户原话-完整存档.md`），因为用户原话**不可重放**（他不会再发一遍同样的约束）。
 *   报错原文大多**可以重跑**（重试那条命令就又有了一份）⇒ 不为它新建一条归档流。
 *   ⇒ 这个不对称是**有意的**，写在这里免得后人当成 bug 去"补齐"。
 */

export function trimErrorsInPlace(r, cap) {
  if (r === undefined || !Array.isArray(r.errors)) return 0;
  if (!Number.isFinite(cap) || cap < 0) return 0;
  if (r.errors.length <= cap) return 0;
  r.errors.length = cap;
  return 1;
}

/**
 * "这是容器工作区，不是项目"的**标志文件**。
 *
 * 这些文件的共同点：它们只在**有人刻意经营过**的目录里出现，用来指挥 AI 或编辑器，
 * 而不是项目自身的产物。一个刚 `mkdir` 出来的新项目不会有 `AGENTS.md`。
 */

export function countChildDirs(projectRoot) {
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

export function capsuleFileStamp(now) {
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

export function persistCapsule(root, info, sid, snap, opts) {
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
    // ★★★★★ 2026-10-15（D215）：**外来压缩也要有正经标签**。
    //   ★ 为什么不能落到下面那条 `String(opts.source)`：那会把内部键 `official`
    //     原样印进给人读的文件头（本项目反复修过的「内部键泄漏」—— D163 就是同一个病）。
    //   ★ 复用**唯一出口** `hfSourceShort`：它认 `official ⇒ 内核（官方）`，
    //     与 L0 里程碑、被压段索引**同一张映射表** ⇒ 不会分叉。
    : typeof opts?.source === "string" && opts.source !== "" ? hfSourceShort(opts.source)
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

export function persistStash(root, info, sid, items, opts) {
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