/**
 * ledger_init 工具的定义 —— 从 `part4.js` 拆出来（D368）。
 *
 * ★ 为什么单独一个文件（不是审美）：
 *   `part4.js` 在 D367 之后 **242,971 B > 241,664 紧线**（DSH STORE 单文件硬上限 262,144）。
 *   本项目自检里那条注释写得对：**接近上限时应当拆文件，而不是把注释删到刚好压线**。
 *
 * ★ 为什么挑这一块：
 *   ① 它是 part4 里最大的一块（84,486 B ≈ 34.8%）；
 *   ② **零模块级声明依赖** —— 它只吃 import 绑定，不碰 part4 里的任何局部变量
 *      ⇒ 可以**原样搬**，不需要连带搬状态（这是最不容易搬错的一类）。
 *
 * ★★★ 拆模块的固定坑（本项目前四次都栽在同一处）：
 *   **re-export 只把名字导出去，不会在本模块作用域绑定它。**
 *   所以 `part4.js` 若还要调 `defineInitTool`，必须**显式再 import 一次** —— 见那边的注释。
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_IGNORE_LINES, MANIFEST_REL, OK_SCHEMA, PROTOCOL_REQUIREMENTS, PROTOCOL_VERSION, ROOT_PARAM, name, satisfiedProtocolVersion } from "./defs.js";
import { bumpRevision, currentSettings, manifestRevision, precedenceIsProject, precedenceValue, skeletonOf } from "./part1.js";
import { defaultLogLevels, ensureDir, fail, git, gitAdd, inspect, isAbsoluteAnywhere, isUnder, isUnderReal, lossless, memoryRootIgnoreLines, mergeGitignore, parseLevels, readManifest, realpathOf, shouldAutoStage, stageOutcomeOf, stamp, toGitRel, writeFileAtomic } from "./part2.js";
import { renderResult, rootFromExec } from "./part3.js";
import { migrateToV3, writeSecurityMd } from "./part7.js";
import { syncManifestMirror } from "./manifest-mirror.js";
import { clearProjectCache, ensureProjectId } from "./fingerprint.js";
// ★ 这六个来自 card-ops（拆卡迁移那一段要用）。切分脚本的单行正则没匹配到 part4 里那条多行 import，
//   于是漏了它们 —— 是 node --check 抓出来的，不是我想到的。
import { cardDirLabel, cardModeOf, listCards, splitIntoCardParts, writeCard, writeCardIndex } from "./card-ops.js";

export function defineInitTool() {
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
        journal: {
          type: "string",
          description:
            "Optional relative path of the APPEND-ONLY TURN JOURNAL, e.g. \"JOURNAL.md\". Keep " +
            "dated per-session history here instead of in the active ledger: the active ledger " +
            "is CURRENT STATE (may be condensed/archived) while the journal is HISTORY (append-only). " +
            "Omit to leave it unregistered (nothing is created uninvited).",
        },
        initialJournal: {
          type: "string",
          description:
            "Optional initial content for the journal. Written only if it does not already exist.",
        },
        // ★★★★★ 2026-10-14（D187，用户拍板）：**目标树与根本原则也纳入初始化登记**。
        //   用户原话：*"GOALS.md，PRINCIPLES.md 纳入初始化台账的清单和维护清单"*。
        //
        //   ★★ 但两者的**创建权限刻意不同**（照 D180/D181 的既定口径，不新造规矩）：
        //     · `goals` —— **插件可以创建**（`ledger_goals` 本来就会建它）；
        //     · `principles` —— ★ **只登记路径、绝不创建**：
        //       它是"只由用户授权才成立"的东西 ⇒ 若在这里替它写第一版，
        //       就等于**新开了一条绕过授权的写入口** ⇒ 违反 D180 那条"结构性"保证
        //       （"模型根本没有写入路径"）。⇒ 这里只登记，写入仍走**唯一**那条授权路。
        goals: {
          type: "string",
          description:
            "Optional relative path of the GOAL TREE, e.g. \"GOALS.md\". Goals are cards linked " +
            "into a tree (maintained via the `ledger_goals` tool): for what objective, which " +
            "sub-objectives, and WHICH PATHS WORKED / WHICH DID NOT (lessons). The plugin MAY " +
            "create this file. Omit to leave it unregistered (nothing is created uninvited).",
        },
        initialGoals: {
          type: "string",
          description:
            "Optional initial content for the goal tree. Written only if it does not already exist.",
        },
        principles: {
          type: "string",
          description:
            "Optional relative path of the FUNDAMENTAL PRINCIPLES file, e.g. \"PRINCIPLES.md\". " +
            "★ This call only REGISTERS the path — it NEVER creates or writes that file. The " +
            "principles are the USER's, not yours: they come into existence and change ONLY " +
            "through explicit user authorization (`/ledger principles <text>` typed by the user, " +
            "or `ledger_propose_principle` + user approval). Registering the path is what makes " +
            "that authorized path usable.",
        },
        // ★★★★★ 2026-10-14（D192，用户拍板）：**经验与教训**（模型踩过的坑）。
        //   用户原话：*"是不是可以加一个经验与教训文件，模型踩过的坑都可以写进去——
        //   这对我们现在有用，也对未来进入学习领域有帮助。"*
        lessons: {
          type: "string",
          description:
            "Optional relative path of the LESSONS file, e.g. \"LESSONS.md\". Holds the pitfalls " +
            "YOU hit (wrong measuring stick, bad fixture, misplaced guard, unverified assumption, " +
            "wrongly recorded value), each with symptom / root cause / fix. The plugin MAY create " +
            "this file. Omit to leave it unregistered (nothing is created uninvited).",
        },
        initialLessons: {
          type: "string",
          description:
            "Optional initial content for the lessons file. Written only if it does not already exist.",
        },
        // ★★★★★ 2026-10-20（D282 · 用户报「init 是不是没升到第 2 代」）：
        //   **补上卡片化三键的登记入口 —— 原来这三个参数根本不存在。**
        //
        //   🔴 病（真跑 `_probe-init-protocol.mjs` 坐实）：`ledger_init` **无论怎么调用**
        //     都只能建出单文件结构 —— 因为它的参数表里**没有** `decisionsDir` / `lessonsDir` /
        //     `goalsDir`（全文只在读 `prev` 时出现，从未写入）。
        //     ⇒ 新项目**注定从第 1 代起** ⇒ 立刻触发注入里那句「要不要升级成卡片化 + 日志分片」
        //     ⇒ 而**没有任何一条命令能一步升到第 2 代** ⇒ 每个新对话都被问一遍。
        //   ★ 这不是"谎报"（它如实写 1，符合 D272 那条"版本号只能由事实推导"）——
        //     是**缺能力**：它能诚实地说"我没建成"，却没本事"建成"。
        //
        //   ★ 口径与 `logDir` 一致：**传了才建、才登记**；不传 ⇒ 什么都不做（不擅自创建）。
        decisionsDir: {
          type: "string",
          description:
            "Optional relative directory for ONE-CARD-PER-FILE decisions, e.g. \"decisions\". " +
            "Pass this to initialize a CARD-MODE project (protocol generation 2) instead of a " +
            "single-file one. ★ Only registers the directory and creates it if needed — it does " +
            "NOT migrate an existing single-file `decisions` record; use `ledger_migrate` for that.",
        },
        lessonsDir: {
          type: "string",
          description:
            "Optional relative directory for ONE-CARD-PER-FILE lessons (`L<n>` pitfalls / `E<n>` " +
            "experience), e.g. \"lessons\". Same semantics as `decisionsDir`.",
        },
        goalsDir: {
          type: "string",
          description:
            "Optional relative directory for ONE-CARD-PER-FILE goal-tree cards (`g<n>`), e.g. " +
            "\"goals\". Same semantics as `decisionsDir`.",
        },
        gitInit: {
          type: "boolean",
          description:
            "Set true to run `git init` when the project is not already a repository. " +
            "**Default is FALSE** — the plugin will NOT create a repository for you. " +
            "Rationale: `git init` turns the directory into a repo, and everything placed there " +
            "afterwards may end up in a later `git add`/`push`. That decision belongs to the user. " +
            "Pass `gitInit: true` only when you are sure this project should be version-controlled.",
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
        // ★★★★★ 2026-10-24（用户拍板）：**默认就是第三代**，这里是"退回第二代"的显式开关。
        //
        //   ★ 为什么必须留这条路：既有项目重跑 init 时不能被偷偷升级（判据是清单空不空），
        //     但**新项目**也可能有人就想要老布局（文件直接躺项目根）。
        //     ⇒ 没有退回开关 = 所有人的布局一次性被改掉，那不是"改默认值"，那是"改所有人的项目"。
        //   ★ 判据：**改默认值必须配一条显式退回的路**，否则它就是一次不可逆的批量迁移。
        layout: {
          type: "string",
          enum: ["v3", "flat"],
          description:
            "Memory layout. Default (omit) = generation 3 for a BRAND-NEW project: memory files go " +
            "into a private subdirectory `<project-name>-ledger-memory/`, and the card dirs + log dir " +
            "are created there so the project is born conformant. Existing projects are never " +
            "silently upgraded. `\"flat\"` = keep the legacy V2 layout (memory files directly in the " +
            "project root). `\"v3\"` = force generation 3 even when re-running on an existing project.",
        },
        memoryRoot: {
          type: "string",
          description:
            "V3: optional relative directory that holds ALL memory files (e.g. " +
            "\"<project-name>-ledger-memory\"). When set, `active` / `decisions` / `archiveDir` / " +
            "`logDir` / the card dirs / journal / goals / lessons / principles are all resolved " +
            "INSIDE it, while `.dsh-ledger.json` and `.gitignore` stay at the project root. " +
            "OMIT on a brand-new project to get generation 3 by default; pass `layout:\"flat\"` " +
            "to get the legacy V2 layout instead.",
        },
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
            L4: { type: "boolean" },
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

      // ═══════════════════════════════════════════════════════════════════════════
      // ★★★★★ 2026-10-21（D289 · V3 阶段 1）：**`ledger_init` 是唯一能"生出"V3 项目的入口**
      //
      //   ★ 判据与 `inspect()` 完全一致，但**不能调 `inspect()`**：
      //     它在**写清单之前**，此刻清单里还没有 `memoryRoot` ⇒ `inspect` 只会返回 V2 形状。
      //     ⇒ 这里自己按参数的**字面值**算一遍基准，**校验规则与 inspect 一模一样**
      //       （相对路径 + 必须落在项目内 + 走 `isUnderReal` 防符号链接逃逸）。
      //
      //   ★★ 为什么校验必须同源：用户可编辑的就是这个字段。两处各写一套校验必然分叉，
      //     而分叉的那一天就会出现"init 能建、inspect 不认"或反过来 —— 那是最难查的一类。
      //
      //   ★ 不传 `memoryRoot` ⇒ `memRootAbs === root` ⇒ **V2 布局逐字不变**（不传就完全没变化）。
      // ═══════════════════════════════════════════════════════════════════════════
      // ═══════════════════════════════════════════════════════════════════════════
      // ★★★★★ 2026-10-24（用户拍板 · 第 10/11 点）：**新项目默认直接生第三代。**
      //
      //   用户原话（逐字，两次拍板）：
      //     *"然后如果是一个新的指定的项目的话，那么当模型或者用户选择把台账初始化之后
      //       （或者锁定到某个文件夹），文件夹中立刻会初始化出一个子文件夹…
      //       然后最好是第三代的，而不是前面那几代的。"*
      //     *"然后初始的话默认三代现在立刻马上去做。"*
      //
      //   ★ 修法：把「不传 memoryRoot」的缺省行为从 **V2** 改成 **V3**，
      //     并且**自动补齐第三代必须的四样**（卡片三目录 + 日志目录）——
      //     否则"默认三代"只是把文件挪进子目录，仍然缺 `decisionsDir` 等，
      //     照样被判不合规 ⇒ 那不是"生而在最新代"。
      //
      //   🔴 **三条边界（缺一条就是灾难）**：
      //     ① **不许偷偷升级既有项目**：判据是 `readManifest(root)` **空不空**。
      //        空 = 全新项目 ⇒ 给默认值；非空 = 已经有一套 ⇒ **原样不动**
      //        （重跑 init 补建东西时，绝不能把它从 V2 拽到 V3 —— 那是用户没要求的数据搬迁）。
      //     ② **V2 必须是一条能走通的路**：新增 `layout:"flat"` 显式退回。
      //        ★ 为什么必须有：探针/自检里有大量夹具在测 V2 语义，
      //          而真实用户也可能就想要老布局（他明确说过"不擅自改变已有结构"）。
      //          没有退回开关 = 把所有人的布局一次性改掉。
      //     ③ **显式传 `memoryRoot` 仍然优先级最高**（那条路一个字都不改）。
      //
      //   ★ 判据（这次决定背后的道理，记在 D319）：
      //     **"诚实"不等于"让用户从最差的状态起步"。**
      //     按事实推导版本号解决了"老项目不自知"，但把"零起点"也算成"落后"，
      //     是**把两种不同的起点混为一谈** —— 对零起点，"升级"意味着"本来没做过的事"，
      //     那它就该**生而在最新代**。
      // ═══════════════════════════════════════════════════════════════════════════
      const layoutArg = typeof args?.layout === "string" ? args.layout.trim().toLowerCase() : "";
      if (layoutArg !== "" && layoutArg !== "v3" && layoutArg !== "flat") {
        throw fail(`ledger_init: 'layout' 只能是 "v3" 或 "flat"（收到 "${layoutArg}"）`);
      }
      const manifestBefore = readManifest(root);
      if (manifestBefore === undefined && fs.existsSync(path.join(root, MANIFEST_REL))) {
        throw fail(`ledger_init: 拒绝覆盖 —— \`${MANIFEST_REL}\` 已存在但无法解析为合法 JSON，请先修复或备份后再重试。`);
      }
      const isBrandNew = manifestBefore === undefined || Object.keys(manifestBefore ?? {}).length === 0;
      const explicitMemoryRoot = typeof args?.memoryRoot === "string" ? args.memoryRoot.trim() : "";
      const prevMemoryRoot = typeof manifestBefore?.memoryRoot === "string" ? manifestBefore.memoryRoot.trim() : "";
      // 默认第三代的目录名：**与 migrateToV3 同一套算法**（part7:136-137），不另发明。
      const defaultMemDirName = `${path.basename(root)}-ledger-memory`;
      // 全新项目（或显式传 layout:"v3"）且没显式传 memoryRoot、没显式要 flat 时给默认值；
      // 既有 V3 项目重跑 init 且未重传 memoryRoot 时，继承清单里已有的 memoryRoot（绝不把新文件散落回项目源码根）。
      const wantV3ByDefault = explicitMemoryRoot === "" && layoutArg !== "flat" && (isBrandNew || layoutArg === "v3");
      const memoryRootArg = explicitMemoryRoot !== ""
        ? explicitMemoryRoot
        : prevMemoryRoot !== "" && layoutArg !== "flat"
          ? prevMemoryRoot
          : wantV3ByDefault
            ? defaultMemDirName
            : "";
      // ★ 默认第三代时顺手补齐四样（用户要的是"立刻建出子文件夹里那套记忆系统"）。
      //   用户显式传了就不覆盖他的选择。
      const wantsV3Now = memoryRootArg !== "";
      const dflt = (v, name) => (v !== "" ? v : wantsV3Now && (isBrandNew || layoutArg === "v3") ? name : v);
      let memRootRel;
      let memRootAbs = root;
      if (memoryRootArg !== "") {
        if (isAbsoluteAnywhere(memoryRootArg)) {
          throw fail(`ledger_init: 'memoryRoot' 必须是相对路径：${memoryRootArg}`);
        }
        const cand = path.resolve(root, memoryRootArg);
        const rootResolved = path.resolve(root);
        if (cand === rootResolved || (fs.existsSync(cand) && realpathOf(cand) === realpathOf(rootResolved))) {
          throw fail(`ledger_init: 'memoryRoot' 不能指向项目根目录本身：${memoryRootArg}`);
        }
        const r = isUnderReal(root, cand);
        if (r.ok !== true) {
          throw fail(`ledger_init: 'memoryRoot' 逃出了项目根：${memoryRootArg}（${r.why}）`);
        }
        memRootRel = toGitRel(root, cand);
        memRootAbs = cand;
      }

      const active = typeof args?.active === "string" ? args.active.trim() : "";
      const decisions = typeof args?.decisions === "string" ? args.decisions.trim() : "";
      const archiveDir = typeof args?.archiveDir === "string" ? args.archiveDir.trim() : "";
      // ★ 2026-10-24：默认生第三代时，日志目录一并给上（用户要的是"整套记忆系统立刻建出来"）。
      //   显式传了就用他的；已有项目（非全新）不给默认，避免把日志突然打开。
      const logDir = dflt(typeof args?.logDir === "string" ? args.logDir.trim() : "", "_ledger-log");
      // ★★★★★ 2026-10-20（D282）：卡片化三目录。口径与 `logDir` 完全一致 ——
      //   传了才建、才登记；不传就是 ""（什么都不做，不擅自创建）。
      // ★ 2026-10-24：**默认生第三代时这三样也一并给**，否则"第三代"只挪了文件、
      //   仍缺卡片目录 ⇒ 立刻被判不合规（那不是用户要的"生而在最新代"）。
      const decisionsDir = dflt(typeof args?.decisionsDir === "string" ? args.decisionsDir.trim() : "", "decisions");
      const lessonsDir = dflt(typeof args?.lessonsDir === "string" ? args.lessonsDir.trim() : "", "lessons");
      const goalsDir = dflt(typeof args?.goalsDir === "string" ? args.goalsDir.trim() : "", "goals");
      // ★ 这三个也是"目录路径"，必须和 active/decisions/archiveDir 走**同一套边界校验**
      //   （绝对路径、逃出项目根都要拒）。漏掉它们 = 开了一个绕过边界检查的入口。
      // ★ V3（D289）：这些路径现在都相对**记忆基准**（不传 memoryRoot 时它就是项目根）。
      //
      // ★★★★★ 2026-10-23（D313，GPT 静态审查 001 的 F01）**真缺陷修复**：
      //   🔴 病：这里原来用 `isUnder()`（**纯词法**：resolve + relative），**不解析符号链接**。
      //     ⇒ 在 `mem/` 里放一个指向项目外的链接 `escape/`，再传 `active: "escape/LEDGER.md"`
      //       就能**在项目外真的写出 LEDGER.md**（本机实测复现：项目外凭空出现文件）。
      //   ★ 而 `base.js` 里**早就有 `isUnderReal()`**，它的注释第一句就是
      //     *"review F03 实测，Linux 复现 … 项目内放一个 linked/ 指向外部目录 ⇒ 覆盖了项目外的 LEDGER.md"*
      //     —— **同一类缺陷、同一个修法，早就写好了，只是没接到这条路上。**
      //   ★★★ 判据（值得记）：**"已经有正确的工具" ≠ "已经在用正确的工具"**。
      //     我上一轮修 D310 时按"入口个数"点过一遍读写基准，但**没点过"每个边界校验用的是哪个函数"**
      //     —— 那也是一份清单，而且更长。**凡有 isUnder / isUnderReal 两个版本并存的地方，
      //     都要问一句"这里该用哪个"**（词法版只适合"字符串是不是这个前缀"这种纯文本判断）。
      const memBaseResolved = path.resolve(memRootAbs);
      for (const [label, value] of [
        ["decisionsDir", decisionsDir],
        ["lessonsDir", lessonsDir],
        ["goalsDir", goalsDir],
      ]) {
        if (value === "") continue; // 可选：空就是不启用
        if (isAbsoluteAnywhere(value)) throw fail(`ledger_init: '${label}' 必须是相对路径：${value}`);
        const abs = path.resolve(memRootAbs, value);
        if (abs === memBaseResolved) {
          throw fail(`ledger_init: '${label}' 不能指向项目/记忆根目录本身：${value}`);
        }
        // ★ 用真实路径版：会解析符号链接（目标不存在时解析"最近的已存在祖先"）
        const chk = isUnderReal(memRootAbs, abs);
        if (chk.ok !== true) throw fail(`ledger_init: '${label}' 逃出了项目根：${value}（${chk.why}）`);
      }
      // ★ 卡片目录与同名单文件**不能同时登记** —— 那是"这一类记忆住在哪有两个答案"，
      //   而 `cardModeOf` 只认一个 ⇒ 必然有一边的读取路径落空（D220 那个病）。
      if (decisionsDir !== "" && decisions !== "" && decisionsDir === decisions) {
        throw fail("ledger_init: 'decisionsDir' 与 'decisions' 不能是同一个路径");
      }
      for (const [label, value] of [
        ["active", active],
        ["decisions", decisions],
        ["archiveDir", archiveDir],
      ]) {
        if (value === "") throw fail(`ledger_init: '${label}' 必须是非空字符串`);
        if (isAbsoluteAnywhere(value)) throw fail(`ledger_init: '${label}' 必须是相对路径：${value}`);
        const abs = path.resolve(memRootAbs, value);
        if (abs === memBaseResolved) {
          throw fail(`ledger_init: '${label}' 不能指向项目/记忆根目录本身：${value}`);
        }
        // ★ D313 / F01：同上，必须用真实路径版（符号链接可越界）
        const chk = isUnderReal(memRootAbs, abs);
        if (chk.ok !== true) throw fail(`ledger_init: '${label}' 逃出了项目根：${value}（${chk.why}）`);
      }
      // ★★★★★ 2026-10-18（D269 · 修 review v1.2.7 的 F08）：**角色身份按"最终文件"比，不按原始字符串比**。
      //
      //   🔴 review 实测：`active:'LEDGER.md'` + `decisions:'./LEDGER.md'` ⇒ **被接受**，
      //      清单里两个角色指向**同一个文件**。它给的理由很到位：
      //      "**通用角色冲突本身也会破坏状态/历史分离**"——那两个角色本该是两种记忆语义。
      //
      //   ★ 为什么原来会漏：这一行只做 `active === decisions` 的**原始字符串**比较。
      //     `LEDGER.md` ≠ `./LEDGER.md` ⇒ 字符串不等 ⇒ 放行。
      //     同一个坑还有更多形状：`a//b.md`、`A.md` vs `a.md`（Windows 大小写）、`x/../y.md`。
      //
      //   ★ 修法：**规范化成绝对路径再比**，并把"大小写"按平台处理
      //     （Windows/macOS 文件系统默认大小写不敏感；Linux 敏感 —— 用 `process.platform` 判）。
      //   ★ 而且不只比 active/decisions：**五个文件角色两两之间都不许重合**
      //     （journal/goals/principles/lessons 之间的冲突会破坏记忆分类本身）。
      //     目录角色（archiveDir / logDir）不能与文件角色同名 —— 那是另一条，已在下面单独查。
      const fileIdentityOf = (rel) => {
        if (typeof rel !== "string" || rel.trim() === "") return undefined;
        // ★ V3（D289）：文件角色身份必须按**记忆基准**算 —— 否则 V3 下
        //   ▶ 其余 2 行详注已抽到 源码注释/init-tool.md（原 init-tool.js:422-424）
        const abs = path.resolve(memRootAbs, rel.trim());
        // ★ Windows / macOS 的文件系统默认大小写不敏感 ⇒ 身份比较也要忽略大小写
        return process.platform === "win32" || process.platform === "darwin" ? abs.toLowerCase() : abs;
      };
      const prevManifestForRoles = readManifest(root) ?? {};
      const isValidInheritedRel = (v) => {
        if (typeof v !== "string" || v.trim() === "") return false;
        const t = v.trim();
        if (isAbsoluteAnywhere(t)) return false;
        const abs = path.resolve(memRootAbs, t);
        return abs !== memBaseResolved && isUnderReal(memRootAbs, abs).ok === true;
      };
      const effRole = (argVal, prevVal) =>
        typeof argVal === "string" && argVal.trim() !== ""
          ? argVal.trim()
          : isValidInheritedRel(prevVal)
            ? prevVal.trim()
            : "";
      {
        // 本次生效的文件角色（显式传入优先，未传则继承旧清单已有值，防重跑 init 撞上旧角色）
        const roles = [
          ["active", active],
          ["decisions", decisions],
          ["journal", effRole(args?.journal, prevManifestForRoles.journal)],
          ["goals", effRole(args?.goals, prevManifestForRoles.goals)],
          ["principles", effRole(args?.principles, prevManifestForRoles.principles)],
          ["lessons", effRole(args?.lessons, prevManifestForRoles.lessons)],
        ].filter(([, v]) => v !== "");
        const seen = new Map(); // identity -> { label, rel }
        const clashes = [];
        for (const [label, rel] of roles) {
          const id = fileIdentityOf(rel);
          if (id === undefined) continue;
          const prev = seen.get(id);
          if (prev !== undefined) {
            clashes.push(`${prev.label}(${prev.rel}) 与 ${label}(${rel})`);
          } else {
            seen.set(id, { label, rel });
          }
        }
        if (clashes.length > 0) {
          throw fail(
            `ledger_init: 这几个**角色指向同一个文件** ⇒ 拒绝：\n  · ${clashes.join("\n  · ")}\n` +
              "★ 为什么必须拒：每种记忆的**语义不同**（状态 / 历史 / 决策 / 原则 / 目标 / 教训），\n" +
              "  两个角色落在一个文件上 ⇒ 一边写就是把另一边覆盖掉，而且**看起来都正常**。\n" +
              "★ 判据按**规范化后的绝对路径**比（`LEDGER.md` 与 `./LEDGER.md` 是同一个文件）：\n" +
              "  原始字符串比较会放过 `./x`、`a//b`、`x/../y` 这些写法" +
              (process.platform === "win32" || process.platform === "darwin" ? "，以及大小写差异" : "") +
              "。\n" +
              "★ 修法：给每个角色一个**不同的相对路径**再重试。",
            { roleClashes: clashes },
          );
        }
      }
      if (active === decisions) {
        throw fail("ledger_init: 活跃台账与决策记录必须是两个不同的文件（需求硬约束）。");
      }

      // ★★★★★ 2026-10-18（D266 · 修 review v1.2.7 的 F01 变体②）：**保护角色不许被重映射**。
      //
      //   🔴 review 的实测（这是它给出的"删掉参数也不够"那个变体）：
      //     对一个**已经登记** `principles: 'PRINCIPLES.md'` 的项目重新调 `ledger_init`，
      //     传 `active: 'PRINCIPLES.md'`、`decisions: 'DECISIONS.md'`，**不显式传 principles**
      //     ⇒ 旧 principles 字段被保留 ⇒ **之后普通 `target:"active"` 的写入就改到了原则文件**，
      //     而初始化与写入**都返回成功**，全程没有原则授权。
      //
      //   ★ 为什么这一条比"删参数"更要紧：删参数只堵住**一个入口**，
      //     而重映射是**改变角色的身份** —— 一旦 `PRINCIPLES.md` 被登记成 active，
      //     它此后收到的每一次普通写入都是"合法"的。保护形同虚设。
      //
      //   ★ 判据（三件事，按 review 建议的"按最终目标文件检查保护角色"）：
      //     ① 把**新**的 active/decisions/journal/goals/lessons 全部解析成绝对路径；
      //     ② 与**旧**清单里的 principles 路径比**规范化后的绝对路径**（不是原始字符串 ——
      //        那正是 review F08 指出的另一个坑：`LEDGER.md` 与 `./LEDGER.md` 会算成两个）；
      //     ③ 任一撞上 ⇒ **拒绝**，并说清"改变原则路径/解除保护本身需要用户同意"。
      //
      //   ★ 还有一层：即便用户**显式**传了 `principles` 指向同一个文件，
      //     `active === principles` 也必须拒 —— 那是"两个角色一个文件"，
      //     状态与原则混在一起，与 `active === decisions` 是同一个硬约束的延伸。
      {
        // ★ V3（D289）：角色规范化必须用**记忆基准** —— 否则 V3 下
        //   ▶ 其余 2 行详注已抽到 源码注释/init-tool.md（原 init-tool.js:505-507）
        const norm = (rel) => (typeof rel === "string" && rel.trim() !== "" ? path.resolve(memRootAbs, rel.trim()).toLowerCase() : undefined);
        const prevManifest = readManifest(root) ?? {};
        const prevPrinciplesAbs = norm(prevManifest.principles);
        const defaultPrinciplesDisk = path.resolve(memRootAbs, "PRINCIPLES.md");
        const diskPrinciplesAbs = fs.existsSync(defaultPrinciplesDisk) ? defaultPrinciplesDisk.toLowerCase() : undefined;
        // 新清单里"原则"这个角色住在哪：显式传入优先，否则继承旧值或盘上已有的 PRINCIPLES.md
        const nextPrinciplesAbs =
          typeof args?.principles === "string" && args.principles.trim() !== ""
            ? norm(args.principles.trim())
            : prevPrinciplesAbs ?? diskPrinciplesAbs;
        const protectedPrinciplesSet = new Set(
          [prevPrinciplesAbs, diskPrinciplesAbs, nextPrinciplesAbs].filter((x) => x !== undefined),
        );
        if (protectedPrinciplesSet.size > 0) {
          const otherRoles = [
            ["active", active],
            ["decisions", decisions],
            ["archiveDir", archiveDir],
            ["logDir", logDir],
            ["decisionsDir", decisionsDir],
            ["lessonsDir", lessonsDir],
            ["goalsDir", goalsDir],
            ["journal", typeof args?.journal === "string" ? args.journal.trim() : prevManifest.journal],
            ["goals", typeof args?.goals === "string" ? args.goals.trim() : prevManifest.goals],
            ["lessons", typeof args?.lessons === "string" ? args.lessons.trim() : prevManifest.lessons],
          ];
          const hits = otherRoles
            .filter(([, rel]) => {
              const n = norm(rel);
              return n !== undefined && protectedPrinciplesSet.has(n);
            })
            .map(([label]) => label);
          if (hits.length > 0) {
            const hitTarget = nextPrinciplesAbs ?? prevPrinciplesAbs ?? diskPrinciplesAbs;
            throw fail(
              `ledger_init: 拒绝 —— **原则文件不能被登记成普通角色**。\n` +
                `  · 原则文件：\`${path.relative(root, hitTarget)}\`\n` +
                `   · 被撞上的角色：${hits.join(" · ")}\n` +
                `★ 为什么必须拒：一旦它同时是 active/journal 之类的普通角色，\n` +
                `  此后**每一次普通 ledger_write 都会合法地改到原则文件** —— 保护就形同虚设。\n` +
                `★ 「改变原则路径 / 解除原则保护」本身**是需要用户明确同意**的操作，\n` +
                `  不能用一次 ledger_init 悄悄完成。\n` +
                `★ 若你确实想换原则文件：先把新路径**显式**传进 \`principles\`（不与任何角色重合），再重试。`,
            );
          }
        }
      }
      // logDir 是**可选**的：给了才校验。
      if (logDir !== "") {
        if (isAbsoluteAnywhere(logDir)) throw fail(`ledger_init: 'logDir' 必须是相对路径：${logDir}`);
        const logAbsCheck = path.resolve(memRootAbs, logDir);
        if (logAbsCheck === memBaseResolved) {
          throw fail(`ledger_init: 'logDir' 不能指向项目/记忆根目录本身：${logDir}`);
        }
        // ★ D313 / F01：**同一个病在这一条路上也有**（GPT 报告只点了 active/decisions/archiveDir，
        //   ▶ 其余 2 行详注已抽到 源码注释/init-tool.md（原 init-tool.js:548-550）
        {
          const chk = isUnderReal(memRootAbs, logAbsCheck);
          if (chk.ok !== true) throw fail(`ledger_init: 'logDir' 逃出了项目根：${logDir}（${chk.why}）`);
        }
        // 日志目录不能与归档目录互相包含：两者都按 YYYY-MM/weekN 分桶，
        // 嵌套会让"读某一周"同时命中两种东西，回溯结果无法解释。
        const archAbs = path.resolve(memRootAbs, archiveDir);
        if (isUnderReal(archAbs, logAbsCheck).ok || isUnderReal(logAbsCheck, archAbs).ok) {
          throw fail("ledger_init: 日志目录与归档目录不能互相包含（两者都按周分桶，嵌套会混淆）。");
        }
      }

      // 三者互不重叠：归档目录不能是某个文件的路径，文件也不能塞进归档目录里。
      // ★ V3（D289）：全部相对**记忆基准**（不传 memoryRoot 时它就是项目根）。
      {
        const dirRoles = [
          ["decisionsDir", effRole(decisionsDir, prevManifestForRoles.decisionsDir)],
          ["lessonsDir", effRole(lessonsDir, prevManifestForRoles.lessonsDir)],
          ["goalsDir", effRole(goalsDir, prevManifestForRoles.goalsDir)],
          ["archiveDir", archiveDir],
          ["logDir", effRole(logDir, prevManifestForRoles.logDir)],
        ].filter(([, v]) => typeof v === "string" && v !== "");
        const dirSeen = new Map();
        const dirClashes = [];
        for (const [label, rel] of dirRoles) {
          const id = fileIdentityOf(rel);
          if (id === undefined) continue;
          const prev = dirSeen.get(id);
          if (prev !== undefined) {
            dirClashes.push(`${prev.label}(${prev.rel}) 与 ${label}(${rel})`);
          } else {
            dirSeen.set(id, { label, rel });
          }
        }
        if (dirClashes.length > 0) {
          throw fail(`ledger_init: 这几个**目录角色指向同一个目录** ⇒ 拒绝：\n  · ${dirClashes.join("\n  · ")}`, {
            dirRoleClashes: dirClashes,
          });
        }
        const fileRolesForCross = [
          ["active", active],
          ["decisions", decisions],
          ["journal", effRole(args?.journal, prevManifestForRoles.journal)],
          ["goals", effRole(args?.goals, prevManifestForRoles.goals)],
          ["principles", effRole(args?.principles, prevManifestForRoles.principles)],
          ["lessons", effRole(args?.lessons, prevManifestForRoles.lessons)],
        ].filter(([, v]) => v !== "");
        const fileDirClashes = [];
        for (const [fLabel, fRel] of fileRolesForCross) {
          const fId = fileIdentityOf(fRel);
          if (fId === undefined) continue;
          const dHit = dirSeen.get(fId);
          if (dHit !== undefined) {
            fileDirClashes.push(`${dHit.label}(${dHit.rel}) 与 ${fLabel}(${fRel})`);
          }
        }
        if (fileDirClashes.length > 0) {
          throw fail(
            `ledger_init: **目录角色与文件角色不能指向同一个路径** ⇒ 拒绝：\n  · ${fileDirClashes.join("\n  · ")}`,
            { fileDirClashes },
          );
        }
      }
      const activeAbs = path.resolve(memRootAbs, active);
      const decisionsAbs = path.resolve(memRootAbs, decisions);
      const archiveAbs = path.resolve(memRootAbs, archiveDir);
      if (isUnderReal(archiveAbs, activeAbs).ok || isUnderReal(archiveAbs, decisionsAbs).ok) {
        throw fail("ledger_init: 活跃台账/决策记录不能位于归档目录之内（归档只追加，会互相干扰）。");
      }

      // ★ 这是 `ledger_init` **登记新项目**时的默认上限 ⇒ 正是插件级设置该管的地方
      //   （设置面板改的就是"新项目登记成多少"）。已有项目走清单，不受影响。
      //
      //   ★★★★★ 2026-10-14（D188）**真机缺陷 —— 上面那句注释原来在骗人**：
      //     原实现只写 `args.maxActiveLines ?? currentSettings().maxActiveLines`
      //     ⇒ **重复 `ledger_init` 会把已有项目的上限静默改成插件级的值**。
      //     ★ 现场（我本人 01:05 那次调用）：本项目的上限被 **350 → 400** 悄悄改掉，
      //       而台账头部与自检都还写着 350 ⇒ **口径当场分叉**
      //       （正是"记录存在 ≠ 记录准确"，注释说"不受影响"、代码偏要覆盖）。
      //   ★★ 而**紧挨着的 `changeRegisterMax` 早就有保留逻辑**（A3 修过）——
      //     两个同类字段，一个修了一个没修 ⇒ **同一个病的半修**。
      //   ⇒ 修法：与 `changeRegisterMax` **逐字同一套口径**（显式传入 > 清单已有 > 插件级）。
      //   ⚠️ 这里**不能**用下面那个 `prev` —— 它在函数更后面才定义（`const` ⇒ TDZ，
      //      引用会直接 `ReferenceError`）。⇒ 就地读一次清单（只读一个小 JSON）。
      const prevForLimit = readManifest(root) ?? {};
      const maxActiveLines =
        Number.isFinite(args?.maxActiveLines) && args.maxActiveLines > 0
          ? Math.floor(args.maxActiveLines)
          : Number.isFinite(prevForLimit.maxActiveLines) && prevForLimit.maxActiveLines > 0
            ? Math.floor(prevForLimit.maxActiveLines)
            : currentSettings().maxActiveLines;

      const notes = [];

      // ═══════════════════════════════════════════════════════════════════════
      // ★★★ D269（修 review F07）：**完整预检区** —— 下面任何一行都不许写盘。
      //   验收：任一非法参数 ⇒ 不创建文件、不改清单、不初始化 Git。
      // ═══════════════════════════════════════════════════════════════════════
      const journal = typeof args?.journal === "string" ? args.journal.trim() : "";
      if (journal !== "") {
        if (isAbsoluteAnywhere(journal)) throw fail(`ledger_init: 'journal' 必须是相对路径：${journal}`);
        const jAbs = path.resolve(memRootAbs, journal);
        if (jAbs === memBaseResolved) {
          throw fail(`ledger_init: 'journal' 不能指向项目/记忆根目录本身：${journal}`);
        }
        // ★ D313 / F01：同一条（真实路径校验）
        {
          const chk = isUnderReal(memRootAbs, jAbs);
          if (chk.ok !== true) throw fail(`ledger_init: 'journal' 逃出了项目根：${journal}（${chk.why}）`);
        }
        if (journal === active || journal === decisions) {
          throw fail("ledger_init: 流水与活跃台账/决策记录必须是不同的文件（三种记忆语义不同）。");
        }
        // ★ D197：与 active/decisions 同一套 —— 没传 initialJournal 就用**骨架**建。
        // ★ D269：**建文件不在这里** —— 预检区禁止任何写盘动作。真正建在下面「副作用区」。
      }
      // ★★★★★ 2026-10-14（D187）：目标树与根本原则也纳入登记（用户拍板）。
      //   ★ 校验共用一套（相对路径 / 不逃出根 / 不与别的记忆文件同名）——
      //     与 `journal` 完全同口径，不新造规矩。
      //   ★★ 但**创建权限不同**（见工具描述的说明）：goals 可建、principles **只登记**。
      const goals = typeof args?.goals === "string" ? args.goals.trim() : "";
      const principles = typeof args?.principles === "string" ? args.principles.trim() : "";
      // ★★★★★ 2026-10-14（D192）：经验与教训 —— 与 `goals` **同权限**（可创建，不需逐次授权）。
      const lessons = typeof args?.lessons === "string" ? args.lessons.trim() : "";
      for (const [label, value] of [
        ["goals", goals],
        ["principles", principles],
        ["lessons", lessons],
      ]) {
        if (value === "") continue; // 可选：不给就不登记（与 journal / logDir 同口径）
        if (isAbsoluteAnywhere(value)) throw fail(`ledger_init: '${label}' 必须是相对路径：${value}`);
        const abs = path.resolve(memRootAbs, value);
        if (abs === memBaseResolved) {
          throw fail(`ledger_init: '${label}' 不能指向项目/记忆根目录本身：${value}`);
        }
        // ★ D313 / F01：同一条（goals / principles / lessons 也是写入目标）
        {
          const chk = isUnderReal(memRootAbs, abs);
          if (chk.ok !== true) throw fail(`ledger_init: '${label}' 逃出了项目根：${value}（${chk.why}）`);
        }
        if (value === active || value === decisions) {
          throw fail(`ledger_init: '${label}' 与活跃台账/决策记录必须是不同的文件（记忆语义不同）。`);
        }
      }
      if (goals !== "" && principles !== "" && goals === principles) {
        throw fail("ledger_init: 目标树与根本原则必须是不同的文件（一个是目标、一个是底线）。");
      }
      // ── 目标树：**可以**写初始内容（它由插件维护，不由用户授权）───────────────
      //   ★ D197：没传 initialGoals ⇒ 用**骨架**建（骨架里带卡片格式，模型照着填）。
      //   ★ D269：**建文件移到下面的「副作用区」**（预检区禁止写盘）。
      // ── ★★★★★ 经验与教训：与目标树**同权限**（可创建；它记的是模型自己踩的坑）────
      //   ★ D197：没传 initialLessons ⇒ 用**骨架**建（骨架里带两类条目的格式）。
      //   ★ D269：**建文件移到下面的「副作用区」**（预检区禁止写盘）。
      // ═══════════════════ 预检区结束 · 下面才开始写盘 ═══════════════════

      // ── ★ 容器工作区闸门 ─────────────────────────────────────────────────
      //   ▶ 其余 5 行详注已抽到 源码注释/init-tool.md（原 init-tool.js:700-705）
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
      //
      // ★★★★★ 2026-10-21（D291 · V3 阶段 2）：**`git init` 必须显式** —— 默认**不再**初始化仓库。
      //
      //   🔴 改前：`if (args?.gitInit !== false)` ⇒ **不传就 init**。
      //     ★ 这与用户早已拍板的决策**正好相反**（七个拍板决策之一就是「`git init` 必须显式」）。
      //     ★ 为什么这是危险的（不是"多建一个目录"那么轻）：
      //       `git init` 会**就地造出一个版本库**。在用户还没想清楚"这个目录要不要纳入版本控制"时
      //       替他把 `.git` 建好，等于**替他做了一个不可轻率撤销的决定** ——
      //       而这个仓库里此后放进去的**每一个文件**，都可能被某次 `git add` 带上去。
      //       本项目已经发生过真实泄露事故（D288），根因链里就有"插件替他把它变成仓库"这一环。
      //   ⇒ 现在：**只有显式 `gitInit: true` 才 init**。不传 = 什么都不做。
      //
      //   ★★★ 这条与"默认挡住记忆文件"（D288）方向一致：**错哪边代价更大，就朝哪边默认**。
      //     少建一个 `.git` = 用户手动 `git init` 一次；
      //     多建一个 `.git` = 可能把私有记忆推上公网。
      //
      //   ★ 回执必须让调用方知道**这件事现在需要他决定**，不能只是静默不做事。
      const wantsGitInit = args?.gitInit === true;
      let gitInitDone = false;
      if (!wantsGitInit) {
        // ★ 已经是仓库的不必提醒；**还不是仓库**的才要提示"我没替你建，要建请显式说"。
        if (!fs.existsSync(path.join(root, ".git"))) {
          notes.push(
            "未执行 `git init`（**默认不建仓库**）。这不会影响台账本身。" +
              "★ 若你确实要把这个项目纳入 Git，请显式传 `gitInit: true` 后重跑，或自行 `git init`。"
          );
        }
      } else if (fs.existsSync(path.join(root, ".git"))) {
        notes.push("已经是 Git 仓库，跳过 git init。");
      } else {
        const r = git(root, ["init"]);
        if (r.ok) {
          gitInitDone = true;
          notes.push("已执行 git init（**你显式要求**的）。");
        } else {
          notes.push(`git init 失败（不影响台账本身）：${r.stderr || r.error || "未知原因"}`);
        }
      }

      // ── .gitignore（合并式，绝不覆盖）────────────────────────────────────
      let ignoreResult;
      if (args?.gitignore !== false) {
        const extra = Array.isArray(args?.gitignoreLines)
          ? args.gitignoreLines.filter((l) => typeof l === "string")
          : [];
        // ★ V3（D292）：再补一条**按语义**的规则 —— 整个记忆子目录被整体挡住。
        //   ▶ 其余 3 行详注已抽到 源码注释/init-tool.md（原 init-tool.js:772-775）
        const v3Lines = memoryRootIgnoreLines({ memoryRoot: memRootRel, projectRoot: root });
        ignoreResult = mergeGitignore(root, [...DEFAULT_IGNORE_LINES, ...v3Lines, ...extra]);
      }

      // ── 初始内容（只在文件不存在时写，绝不覆盖用户的活文件）──────────────
      //
      // ★★★★★ 2026-10-14（D197，用户拍板）：**"插件建骨架、AI 填内容"**。
      //
      //   用户原话（逐字）：*"最好就是插件本体在被指定项目之后就会**自动生成所需要的各项文件**，
      //   然后由 AI 填写就可以了。……**他连协议都不知道的话，就很难去填这些东西**"*。
      //
      // ★★★ 原来的行为：**只有传了 `initial*` 才建文件** ⇒ 不传就**只登记清单**。
      //   也就是说原来是「**AI 想内容 + AI 建文件 + 插件登记**」。用户要改的正是这一点：
      //   「**插件建骨架（带格式提示）+ AI 只填内容**」。
      //
      // ★★ 为什么这样更好（不是省事，是**少一个出错面**）：
      //   模型**不必先凭空想格式**，照着骨架填即可 ⇒ 格式从一开始就对，
      //   不会出现"写了半天、插件解析不到"（那正是用户说的后果）。
      // ★ 界线（**不许越**）：骨架**只在文件不存在时**写 —— **绝不覆盖**用户的活文件。
      //   已有的 `initial*` 仍然优先（那段行为一个字没改，向后兼容）。
      const written = [];
      const skel = [];
      /** 文件不存在 ⇒ 用 `content`（传了就用它，否则用该类文件的骨架）建出来。 */
      const ensureFile = (abs, rel, given, skelKey) => {
        if (!isUnderReal(memRootAbs, abs).ok) return;
        let hasEntry = false;
        try {
          fs.lstatSync(abs);
          hasEntry = true;
        } catch {
          hasEntry = false;
        }
        if (hasEntry || fs.existsSync(abs)) {
          if (typeof given === "string" && given !== "") notes.push(`${rel} 已存在，未覆盖。`);
          return;
        }
        const content = typeof given === "string" && given !== "" ? given : skeletonOf(skelKey);
        if (content === "") return; // 没有骨架可给（如 principles）⇒ 什么都不建
        ensureDir(path.dirname(abs));
        if (writeFileAtomic(abs, content).ok === true) {
          written.push(rel);
          if (!(typeof given === "string" && given !== "")) skel.push(rel);
        }
      };
      ensureFile(activeAbs, active, args?.initialActive, "active");
      ensureFile(decisionsAbs, decisions, args?.initialDecisions, "decisions");      // ★★★ D269（修 review F07）：**可选参数的建文件全部在这里统一执行**。
      //   🔴 改前它们散在预检区里（journal 的甚至夹在四条校验中间）⇒
      //   ▶ 其余 4 行详注已抽到 源码注释/init-tool.md（原 init-tool.js:822-826）
      if (journal !== "") ensureFile(path.resolve(memRootAbs, journal), journal, args?.initialJournal, "journal");
      if (goals !== "") ensureFile(path.resolve(memRootAbs, goals), goals, args?.initialGoals, "goals");
      if (lessons !== "") ensureFile(path.resolve(memRootAbs, lessons), lessons, args?.initialLessons, "lessons");

      ensureDir(archiveAbs);

      // ★★★★★ 2026-10-22（V3 任务书 §3.6）：**在专用记忆目录内建一份 SECURITY.md。**
      //
      //   §3.6 逐字要求：*"在专用记忆目录内建立一份插件管理的安全说明，例如 `SECURITY.md`。"*
      //   ★★ 三条边界（照 `ensureFile` 的既有约定，绝不另搞一套）：
      //     ① **只在 V3**（给了 memoryRoot）时建 —— V2 项目一个字节都不多写；
      //     ② **幂等**：已存在就跳过，**绝不覆盖**（用户可能自己改过这份文件）；
      //     ③ `written` 里记**裸相对名**（与 `ensureFile` 的 `written.push(rel)` 一致），
      //        不写 `path.join(memRootRel, …)` —— 那样会混进带反斜杠的路径，与其余条目不同源。
      //
      //   ★★★★★ 2026-10-23（D301 · 审计员 010 阶段一）**就地改：正文搬去 `part7.js`，两条路共用一份。**
      //   🔴 病：原来这段 55 行的文本**只写在这里**，而 `migrateToV3` 一个字都不建
      //      ⇒ 从 V2 迁移上来的项目**永久缺少 SECURITY.md**（任务书 §3.6 明说要建）。
      //   ⇒ 判据（D59）：**收口不收，必漏一路** —— 修法不是"给迁移补第二段"，是**把正文提出去**。
      //     现在 `writeSecurityMd(memAbs)` 是唯一实现：init 与 migrate 都走它，
      //     下次改这份安全说明只有一处要动，也不可能再分叉。
      //   ★ 附带解除体积红线：`part4.js` 本来只剩 **947 B** 余量，搬走这 2.5K 正文后余量翻倍。
      if (memRootRel !== undefined) {
        if (writeSecurityMd(memRootAbs)) {
          written.push("SECURITY.md");
          skel.push("SECURITY.md");
        }
      }

      // ★ 日志目录只在**明确要了**的时候才建 —— 没传 logDir 就不往项目里塞任何东西。
      if (logDir !== "") ensureDir(path.resolve(memRootAbs, logDir));
      // ★★★★★ 2026-10-20（D282）：卡片化三目录**同样"只在明确要了时才建"**。
      //   ★ 为什么建空目录就够了：卡片模式按 `*Dir` 找卡，目录存在 ⇒ 读写入口成立；
      //     第一次 `ledger_write({target:"decisions", cards:[...]})` 会往里写第一张卡。
      //   ⚠️ 与"把已有单文件内容搬进去"是两件事 —— 那件事必须走 `ledger_migrate`
      //     （要读懂内容才能切卡），**绝不在这里替用户切**（D272 那条"登记目录键的前提是内容已经在目录里"）。
      //     ★ 所以这里**只**在目标目录为空/不存在时登记才安全；若同名单文件已有内容，
      //       调用方应当先 migrate 再建 —— 下面回执里会如实提示这件事。
      const prev = readManifest(root) ?? {};
      const { projectId } = ensureProjectId(prev);
      for (const [dirRel, initRaw, kindKey] of [
        [decisionsDir, args?.initialDecisions, "decisions"],
        [lessonsDir, args?.initialLessons, "lessons"],
        [goalsDir, args?.initialGoals, "goals"],
      ]) {
        if (dirRel === "") continue;
        const dirAbs = path.resolve(memRootAbs, dirRel);
        ensureDir(dirAbs);
        if (typeof initRaw === "string" && initRaw.trim() !== "" && listCards(memRootAbs, dirRel).length === 0) {
          const split = splitIntoCardParts(initRaw, kindKey);
          for (const p of split) {
            writeCard(memRootAbs, dirRel, p.key, p.text, { kind: kindKey, project: projectId });
          }
          if (split.length > 0) writeCardIndex(memRootAbs, dirRel, cardDirLabel(kindKey));
        }
      }

      // ── 指针清单 ─────────────────────────────────────────────────────────
      const now = new Date();
      // ★★★ A3 修复（2026-10-11，审计 002/003 坐实后先写会红用例再改）：
      //   ▶ 其余 5 行详注已抽到 源码注释/init-tool.md（原 init-tool.js:886-891）
      const hadPrevManifest = Object.keys(prev).length > 0;
      // ★★★★★ 2026-10-13（D183）：**回合流水**（分类记忆第 5 种，可选）。
      //   ★ 与 `logDir` 同一套口径：**只在明确要了的时候**才登记与建文件 ——
      //     没传就一个字都不往项目里塞（不擅自创建）。
      // ★★★ 2026-10-18（D269 · 修 review F07）：**这一段（journal / goals / principles /
      //   lessons 的声明 + 校验 + 建文件）已整体上移到所有写盘动作之前**。
      //   ⇒ 顺序是：**四条校验全跑完 → 才开始建文件 / git init**。
      //   🔴 改前：git init、.gitignore、LEDGER.md、DECISIONS.md、归档目录**都先发生**，
      //      直到这里才校验 journal/goals/... ⇒ 非法参数被拒时**磁盘上已留下一堆没登记的文件**。
      //   ★ 若将来要加新的可选参数：校验与执行都写上移区，**不许**写回这一段。

      // ── ★★★★ 根本原则：**只登记路径，一个字都不写** ────────────────────────
      //   ★ 为什么这里坚决不写第一版（即使调用者传了内容也**没有** `initialPrinciples` 这个参数）：
      //     一旦 init 能创建它，"模型根本没有写入路径"这条**结构性**保证就破了 ——
      //     模型可以让 AI 调 `ledger_init({principles:...})` 绕开 D180 的授权闸门。
      //   ⇒ 正解：**参数表里根本不存在** `initialPrinciples`（不是"传了也不写"）。
      //     ★ 这与 D180 一贯的取舍一致：**能做成结构性的，就不要做成纪律性的。**
      if (principles !== "") {
        const pAbs = path.resolve(memRootAbs, principles);
        notes.push(
          fs.existsSync(pAbs)
            ? `根本原则 ${principles} 已登记（文件已存在）。`
            : `根本原则 ${principles} 已登记路径 —— 但**没有创建文件**（它只能由用户授权产生：` +
              `让用户敲 \`/ledger principles <内容>\`）。`
        );
      }

      // ★★★★★ 2026-10-19（D272 **第二轮修正**）：**先算出"名实相符的代次"，再写进清单。**
      //
      //   🔴 原来这里直接写 `PROTOCOL_VERSION` —— 那是**声明**不是**事实**：
      //     `ledger_init` **并不建** `decisionsDir` / `lessonsDir` / `goalsDir`
      //     （默认也不建 `logDir`），建出来的是**单文件结构**，却盖了"第 2 代"的章。
      //     实测（`tools/_diag-init-protocol.mjs`）：刚建好的纯单文件项目
      //     `protocolVersion: 2`、`decisionsDir: undefined` ⇒ 合规判定 **ok**、零提示。
      //     **这正是用户抱怨的那个病，换了个位置复发。**
      //
      //   ⇒ 现在：只盖章「**这份清单真的满足**」的那一代（逐条核键，从第 1 代起连续满足）。
      //     · 新项目建的是单文件 ⇒ 诚实地写 **1** ⇒ 下一回合注入里就会出现
      //       「你的记忆协议停在旧代，要不要升级成卡片化 + 日志分片」
      //       —— **那才是用户要的"模型主动来问"**。
      //     · 已卡片化的项目重跑 init ⇒ 核键全中 ⇒ 写 2（不会把它降级）。
      //     · 别人用更新插件建的 ⇒ `prev` 里那个更高的数字被 `Math.max` 保住（不前向破坏）。
      //   ★ 判据：**版本号只能由事实推导，不能由愿望填写。**
      const protoFacts = {
        // ★★★★★ 2026-10-20（D282）：**这次会建什么也要算进来**，不能只看旧清单。
        //   🔴 原来是 `typeof prev.decisionsDir === "string" ? prev.decisionsDir : undefined`
        //      —— 只读 `prev`。可 `ledger_init` 原来**根本不写这三个键**
        //      ⇒ 就算调用方给了 `decisionsDir`，`protoFacts` 里也是 undefined
        //      ⇒ `satisfiedProtocolVersion` 永远算 1 ⇒ **永远自报第 1 代**。
        //   ⇒ 现在：**"这次明确要建的" 优先，其次才是"旧清单里已有的"**。
        //     （同一个优先级：新的意图 > 旧的残留）
        decisionsDir: decisionsDir !== "" ? decisionsDir
          : typeof prev.decisionsDir === "string" ? prev.decisionsDir : undefined,
        lessonsDir: lessonsDir !== "" ? lessonsDir
          : typeof prev.lessonsDir === "string" ? prev.lessonsDir : undefined,
        goalsDir: goalsDir !== "" ? goalsDir
          : typeof prev.goalsDir === "string" ? prev.goalsDir : undefined,
        // 日志：这次明确给了才算（与下面 manifest 里 `logDir` 的写入口径一致）。
        logDir: logDir !== "" ? logDir : typeof prev.logDir === "string" ? prev.logDir : undefined,
        // ★★★★★ 2026-10-23（D308 阶段二）：**第三代的键**。
        //   ★ 口径同上（这次要建 > 旧清单已有）——但**顺序在这里尤其重要**：
        //     `memRootRel` 只有"这次显式传了 memoryRoot"才有值；
        //     而 `prev.memoryRoot` 是"这项目本来就是 V3"的证据。
        //   🔴 若这里漏了它，会出现一个**很隐蔽**的错：
        //     `ledger_init` 给 V3 项目补建东西（重跑 init）时，`honestProtoVersion` 会算出 2
        //     ⇒ `Math.max(2, prev.protocolVersion=3)` 被 prev 救回来 ⇒ 看着没事；
        //     但**新项目第一次 init（传了 memoryRoot）时 prev 是空的** ⇒ 会盖成 2，
        //     而它明明是第 3 代 ⇒ 之后每次 `protocolGapOf` 都会误报"这个项目停在旧代"。
        //   ★ 判据：**"这次建了什么"必须进事实集**，否则版本号又一次「由愿望决定」而不是由事实推导（D272 那条）。
        memoryRoot: memRootRel !== undefined
          ? memRootRel
          : typeof prev.memoryRoot === "string" && prev.memoryRoot !== "" ? prev.memoryRoot : undefined,
      };
      const honestProtoVersion = Math.max(
        satisfiedProtocolVersion(protoFacts),
        Number.isFinite(prev.protocolVersion) ? Math.floor(prev.protocolVersion) : 1
      );

      const manifest = {
        ...prev,
        version: 1,
        projectId,
        active,
        decisions,
        archiveDir,
        // ★★★★★ 2026-10-16（D222）：**这就是"只对新项目生效"的真根因，就地修**。
        //
        //   老行为：**无条件**把 `maxActiveLines` 写进清单（值取"显式传入 > 清单已有 > 面板"）
        //   ⇒ 每个项目在**创建那一刻冻结**面板值 ⇒ 之后面板再改，它永远不跟。
        //   用户的感受正是"面板改了老项目不跟"（他原话见 D222）。
        //
        //   ★ 新口径（与 `precedenceValue` 同一份判据，不另立一套）：
        //     · 「以项目清单为准」⇒ 照旧写（那时清单**就是**权威，写下来才有意义）；
        //     · 「以面板为准」（默认）⇒ **只在调用方显式传了数时才写**（那是明确的按项目决定）；
        //       否则**不写这个键** ⇒ 面板永远权威，也不会留下一个"看着存在、其实不生效"的陈旧值。
        //   ★ 为什么不能"写了也无所谓"：那样用户一旦切到「以项目清单为准」，
        //     会突然生效一批**建项目那天**的陈旧值 —— 那是更难查的坑。
        ...(Number.isFinite(args?.maxActiveLines) && args.maxActiveLines > 0
          ? { maxActiveLines: Math.floor(args.maxActiveLines) }
          : precedenceIsProject()
            ? { maxActiveLines }
            : Number.isFinite(prev.maxActiveLines) && prev.maxActiveLines > 0
              ? { maxActiveLines: Math.floor(prev.maxActiveLines) } // 老清单里已有的，保留不动
              : {}),
        // ★ 只在这次明确给了 `journal` 时才写这个字段（否则保留清单里已有的）。
        ...(journal !== "" ? { journal } : {}),
        // ★★★★★ 2026-10-20（D282）：**卡片化三目录的登记** —— 这是"新项目能直接建成第 2 代"的关键。
        //   口径照 `logDir`：这次给了就写；没给就保留旧值（不抹掉），都没有就不写这个键。
        ...(decisionsDir !== "" ? { decisionsDir }
          : typeof prev.decisionsDir === "string" ? { decisionsDir: prev.decisionsDir } : {}),
        ...(lessonsDir !== "" ? { lessonsDir }
          : typeof prev.lessonsDir === "string" ? { lessonsDir: prev.lessonsDir } : {}),
        ...(goalsDir !== "" ? { goalsDir }
          : typeof prev.goalsDir === "string" ? { goalsDir: prev.goalsDir } : {}),
        // ★★ 同上口径：只在明确给了时才写，避免重复 init 把已登记的路径抹掉。
        ...(goals !== "" ? { goals } : {}),
        ...(principles !== "" ? { principles } : {}),
        ...(lessons !== "" ? { lessons } : {}),
        // ★ 变更登记条数：与 maxActiveLines **同一套 D222 口径**（写不写由"谁优先"决定）。
        ...(Number.isFinite(args?.changeRegisterMax) && args.changeRegisterMax > 0
          ? { changeRegisterMax: Math.floor(args.changeRegisterMax) }
          : precedenceIsProject()
            ? {
                changeRegisterMax:
                  Number.isFinite(prev.changeRegisterMax) && prev.changeRegisterMax > 0
                    ? Math.floor(prev.changeRegisterMax)
                    : currentSettings().changeRegisterMax,
              }
            : Number.isFinite(prev.changeRegisterMax) && prev.changeRegisterMax > 0
              ? { changeRegisterMax: Math.floor(prev.changeRegisterMax) }
              : {}),
        // ★★★★★ 2026-10-22（V3 §3.1）：**第三代默认关闭自动暂存。**
        //   逐字要求：*"第三代默认关闭自动暂存。"*
        //   ★ 口径：显式给了就照给（`true`/`false` 都尊重），**没给时按项目形态定默认**：
        //     · V3（这次给了 memoryRoot，或清单里已有 memoryRoot）⇒ **false**
        //     · V2 ⇒ 保持原来的默认 **true**（不改变已经存在的几十个项目的行为）
        //   ⚠️ 注意：这只是**清单里写什么**。真正拦人的是 `shouldAutoStage()` ——
        //     它对 V3 **无条件拒绝**，所以即使有人手改成 `true` 也不会生效（§3.1 第二条要求）。
        autoGitAdd:
          args?.autoGitAdd === true
            ? true
            : args?.autoGitAdd === false
              ? false
              : memRootRel === undefined && typeof prev.memoryRoot !== "string",
        archiveWeekMode: args?.archiveWeekMode === "year" ? "year" : "month",
        // ★★★★★ 2026-10-21（D289 · V3）：**记忆子目录的登记**。
        //   口径照 `journal` / `goals` 那几条：**这次给了就写；没给就保留旧值**。
        //   ★ 为什么"没给"不能抹掉：重复 `ledger_init` 若把 `memoryRoot` 删了，
        //     下一次 `inspect()` 会**悄悄把全部记忆路径切回项目根**
        //     ⇒ 表现成"台账突然空了"（文件还在记忆子目录里，只是没人去那儿找）。
        //     那正是 D289 要防的那种"不报错的错"。
        //   ★★ 迁移（把 V2 项目改成 V3）**不走这条** —— 那是阶段 3 的事，必须事务化：
        //     先建影子目录、全量复制校验、原子改名，**最后一步**才改这个键。
        ...(memRootRel !== undefined
          ? { memoryRoot: memRootRel }
          : typeof prev.memoryRoot === "string" && prev.memoryRoot !== ""
            ? { memoryRoot: prev.memoryRoot }
            : {}),
        createdAt: typeof prev.createdAt === "string" ? prev.createdAt : stamp(now),
        // ★★★★★ 2026-10-19（D272）：**登记协议代次 —— 只写"名实相符"的那个数**。
        //   这个值由上面的 `honestProtoVersion` 算出来（逐条核键，不是无条件盖章）；
        //   为什么不能无条件写 `PROTOCOL_VERSION`，见 `honestProtoVersion` 上方那段注释。
        protocolVersion: honestProtoVersion,
        updatedAt: stamp(now),
      };
      // 日志是可选的：只在登记了目录时写这两个字段。
      //   ▶ 其余 2 行详注已抽到 源码注释/init-tool.md（原 init-tool.js:1057-1059）
      if (logDir !== "") {
        manifest.logDir = logDir;
        if (
          args?.logLevels !== undefined ||
          precedenceIsProject() ||
          prev.logLevels !== undefined
        ) {
          manifest.logLevels = parseLevels(args?.logLevels ?? prev.logLevels, defaultLogLevels());
        }
      } else if (typeof prev.logDir === "string" && prev.logDir !== "") {
        // ★ 这次没传 logDir，但上次登记过 ⇒ **保留**，别把它悄悄关掉。
        manifest.logDir = prev.logDir;
        manifest.logLevels = parseLevels(args?.logLevels ?? prev.logLevels, defaultLogLevels());
      }
      // ★ 修订号：首次登记立 0；**重复登记必须递增**。
      //   ▶ 其余 4 行详注已抽到 源码注释/init-tool.md（原 init-tool.js:1074-1078）
      manifest.revision = hadPrevManifest ? manifestRevision(prev) + 1 : 0;
      // ★ 2026-10-18（D269）：与 `bumpRevision` / active 台账**同一个出口**（原子写）。
      //   清单被截断的后果最隐蔽：revision 读不出来 ⇒ 退化成 0 ⇒ 多会话保护**静默失效**，
      //   而没有任何一处会报错。
      const manifestText = JSON.stringify(manifest, null, 2) + "\n";
      const mw = writeFileAtomic(path.join(root, MANIFEST_REL), manifestText);
      if (mw.ok !== true) {
        throw fail(
          `ledger_init: 写清单失败 —— 文件已建好但**没有登记**，请修好权限后重试：${mw.reason ?? "未知"}`,
        );
      }
      // ★★★★★ 2026-10-23（D303 · 用户拍板"清单保留在外，也在子目录中复制一份，注意同步"）：
      //   根那份**已经原子写成功**了 ⇒ 现在才碰镜像（写序不可颠倒：根失败则一字节都不碰镜像）。
      //   ★ 镜像失败**不回滚根**（根已经是对的），但必须如实回报 —— 不许静默。
      clearProjectCache();
      const mirrorInit = syncManifestMirror(root, manifest, manifestText);

      // ── 纳入 Git 追踪（只 add 明确路径，绝不 -A）──────────────────────────
      //   ▶ 其余 2 行详注已抽到 源码注释/init-tool.md（原 init-tool.js:1096-1098）
      let staged;
      let staging;
      // ★★★★★ 2026-10-22（V3 §3.1）：**问中央判据。**
      //   旧写法 `manifest.autoGitAdd && …` 在 V3 初始化时默认为 true ⇒ 会去 stage，
      //   而那时记忆文件已经写进子目录 ⇒ 正是 §3.1 点名要堵的那个洞。
      //   ★ 这里必须**重新 inspect**：`manifest` 是刚拼出来的内存对象，
      //     而 `shouldAutoStage` 要判断"记忆根 vs 项目根"，那是磁盘事实。
      if (shouldAutoStage(inspect(root)).allow) {
        const wanted = [
          MANIFEST_REL,
          active,
          decisions,
          // ★ D187：新登记的记忆文件也纳入（**只 add 真的写过/存在的路径**，绝不 -A）
          ...(written.includes(journal) ? [journal] : []),
          ...(written.includes(goals) ? [goals] : []),
          ...(written.includes(lessons) ? [lessons] : []),
          ...(ignoreResult?.created ? [".gitignore"] : []),
        ];
        const r = gitAdd(root, wanted);
        staging = stageOutcomeOf(r, wanted);
        staged = staging.staged;
      }

      return {
        ok: true,
        projectRoot: root,
        // ★ 2026-10-23：**如实回报名义形态**（V3=记忆子目录名；V2=undefined）。
        //   ▶ 其余 2 行详注已抽到 源码注释/init-tool.md（原 init-tool.js:1125-1127）
        ...(memRootRel !== undefined ? { memoryRoot: memRootRel } : {}),
        structure: {
          active,
          decisions,
          archiveDir,
          maxActiveLines,
          ...(journal !== "" ? { journal } : {}),
          ...(goals !== "" ? { goals } : {}),
          ...(principles !== "" ? { principles } : {}),
          ...(lessons !== "" ? { lessons } : {}),
          // ★ D282：建成了哪几个卡片目录，如实回报（没传的就不出现）。
          ...(decisionsDir !== "" ? { decisionsDir } : {}),
          ...(lessonsDir !== "" ? { lessonsDir } : {}),
          ...(goalsDir !== "" ? { goalsDir } : {}),
        },
        // ★★★★★ 2026-10-20（D282）：**把"这次建成了第几代"如实告诉调用方**。
        //   ★ 为什么值得单独一个字段：调用方（模型）拿到 `protocolVersion: 1` 时
        //     极可能不解其意 —— 它可能以为"写错了"，于是去手改清单（那会让判定失真）。
        //   ⇒ 这里直接说清：建成第几代、还差哪几条要求、如果要升级下一步是什么。
        protocol: {
          builtGeneration: honestProtoVersion,
          currentGeneration: PROTOCOL_VERSION,
          // ★★★★★ 2026-10-24（用户第 10/11 点）：**说清默认是第几代、目录在哪、怎么退回。**
          //
          //   ★ 为什么必须写在回执里（而不是只写在文档里）：
          //     现在"不传 memoryRoot"的**默认行为变了**（从 V2 变成 V3）。
          //     调用方若不知道这件事，看到文件搬进子目录会以为出了错；
          //     而想保持老布局的人**不知道有 `layout:"flat"` 这条路** ⇒ 只能手改清单（危险）。
          //   ★ 判据：**改了默认行为，就必须在同一处把"默认成了什么 / 怎么退回去"讲清。**
          //     否则这次改动对用户就是"我的文件莫名其妙搬家了"。
          ...(wantsV3Now
            ? {
                layout: "v3",
                memoryDir: memRootRel,
                note:
                  `记忆文件全部在 \`${memRootRel}/\` 子目录里（第 ${honestProtoVersion} 代，` +
                  `当前最新是第 ${PROTOCOL_VERSION} 代）。` +
                  "如果你其实想用**老布局**（记忆文件直接躺在项目根），" +
                  "请在 `ledger_init` 里传 `layout:\"flat\"` —— 但那只对**全新项目**有效；" +
                  `本项目已经建成第 ${honestProtoVersion} 代，要改布局请用 \`ledger_migrate\`。`,
              }
            : {
                layout: "flat",
                note:
                  "记忆文件直接躺在项目根（V2 老布局）。" +
                  "若不传 `layout` 或传 `layout:\"v3\"` 在**全新项目**上初始化，会默认建第 3 代" +
                  "（记忆全部收进 `<项目名>-ledger-memory/` 子目录）。",
              }),
          ...(honestProtoVersion >= PROTOCOL_VERSION
            ? {}
            : {
                // ★★★ 2026-10-20（D282 自查抓到）：这里原来是
                //   `PROTOCOL_REQUIREMENTS.filter(r => r.since > honestProtoVersion)`
                //   —— **按代次筛**，于是"已建了卡片化、只差 logDir"的项目会被报成
                //   **两条都缺**（把已经做到的那条也冤枉进去）。
                //   ★ 实测（场景③）：`decisionsDir/lessonsDir/goalsDir` 全建好了，
                //     `stillMissing` 里却还挂着「记忆卡片化」—— **回执在说假话**。
                //   ⇒ 改成**按实际键筛**：哪些要求的键真的缺，就只报哪些。
                //     （与 `protocolGapOf` 的 `missing` 同一套尺子，不另立一份判据。）
                stillMissing: PROTOCOL_REQUIREMENTS
                  .filter((r) => r.keys.some((k) => typeof protoFacts[k] !== "string" || protoFacts[k] === ""))
                  .map((r) => r.label),
                howToUpgrade: (() => {
                  // ★★★ 2026-10-23（D308 阶段二）：原来这段文案**只讲卡片化**，而第 3 代缺的是
                  //   `memoryRoot` ⇒ 照它做**永远升不到第 3 代**（模型会一直在第 2 代原地打转）。
                  //   ★ 判据：**升级指引必须按"实际缺的那几条"给**，不能只写最早那一条。
                  const miss = PROTOCOL_REQUIREMENTS.filter((r) =>
                    r.keys.some((k) => typeof protoFacts[k] !== "string" || protoFacts[k] === "")
                  );
                  const parts = [];
                  if (miss.some((r) => r.since === 3)) {
                    parts.push(
                      "**第 3 代（记忆集中到子目录）**：`ledger_init` 时传 `memoryRoot`（例如 `\"<项目名>-ledger-memory\"`）" +
                        "可以给**新项目**直接建成；**已有内容的项目**必须先 `ledger_migrate({op:\"v3\"})` " +
                        "（事务化搬迁 + 校验 + 旧文件进 `_retired`），**迁完再登记** —— " +
                        "直接给老项目补 `memoryRoot` 会让根上那些真实存在的记忆**从视野里消失**（不报错、也没删，D272/D308）。"
                    );
                  }
                  if (miss.some((r) => r.since === 2 && r.keys.includes("decisionsDir"))) {
                    parts.push(
                      "**第 2 代（卡片化）**：`ledger_init` 时用 `decisionsDir` / `lessonsDir` / `goalsDir` 传入" +
                        "（只对**新项目**成立）。已有单文件内容的老项目先 `ledger_migrate` 按卡切分，再登记目录键 —— " +
                        "直接登记空目录同样会让旧内容从视野里消失。"
                    );
                  }
                  if (miss.some((r) => r.since === 2 && r.keys.includes("logDir"))) {
                    parts.push("**日志分片**：传 `logDir` 即可（新建空目录 + 登记键，**不搬任何已有内容**）。");
                  }
                  return parts.length === 0 ? "没有缺口。" : parts.join(" ");
                })(),
              }),
        },
        manifestPath: path.join(root, MANIFEST_REL),
        // ★★★★★ 2026-10-23（D303）：**镜像的落点与结果如实回报**（做了没做，外面都得看得见）。
        //   ★ 只在 V3（有 memoryRoot）时出现，V2 项一个字节都不多。
        ...(mirrorInit === undefined || mirrorInit.skipped === true
          ? {}
          : {
              manifestMirror: {
                path: mirrorInit.path,
                created: mirrorInit.created === true,
                changed: mirrorInit.changed === true,
                ...(mirrorInit.failed === undefined ? {} : { failed: mirrorInit.failed }),
              },
            }),
        gitInit: gitInitDone,
        // ★★★★★ 2026-10-14（D188）**真机缺陷**：这里原来是 `gitignore: ignoreResult`，
        //   而 `gitignore:false` 时 `ignoreResult` 是 **`undefined`**
        //   ⇒ 返回对象里带着一个 `undefined` 值 ⇒ **不是 lossless JSON**
        //   ⇒ **DSH 把整个 `ledger_init` 调用判为无效**：
        //      `Error: tool "ledger_init" returned invalid output: value is not lossless JSON`。
        //
        //   ★★★ 现场（2026-10-14 01:05，我本人调用的）：
        //     文件其实**已经写对了**（台账/清单/GOALS.md 都落了盘），
        //     但内核**拒收返回值** ⇒ 调用方（模型）只看到一条错误 ⇒ 会**重试**或**误以为失败**。
        //     ★ 这与本项目那条已知坑同型（**"写成功了但报失败"**）—— 最容易引出重复动作。
        //
        //   ★★ 为什么**自检一直没抓到**（值得记一条纪律）：
        //     自检直接读 `r.ok` / `r.notes`，**从不把返回值喂给 DSH 的输出校验器**
        //     ⇒ 夹具绕过了**真实存在的那个校验层** ⇒ 典型假绿
        //     （"夹具没走通 ≠ 被测对象没问题"的反面：**夹具太宽松 ⇒ 真问题照不进来**）。
        //   ⇒ 修法两条，缺一不可：
        //     ① 这里改成**条件展开**（与下一行 `staged` 同一写法，同一处口径）；
        //     ② 情形 77 补一条**扫描全返回值有没有 `undefined`** 的断言 ——
        //        那是"lossless JSON"的**可离线判据**（不必依赖 DSH 运行时）。
        //   ⚠️ 同类**还有一处**要一起看：`structure` 里我刚加的三个字段已经用了条件展开，
        //      但**旧字段**（active/decisions/archiveDir/maxActiveLines）都是必填项，无需处理。
        ...(ignoreResult === undefined ? {} : { gitignore: ignoreResult }),
        wroteInitial: written,
        // ★★★★★ 2026-10-14（D197）：**"哪些文件是插件自动建的骨架"** —— 单独报出来。
        //   ★ 为什么要单独一个字段（而不是并进 `wroteInitial`）：
        //     两者语义不同 —— `wroteInitial` 是"写了内容"，`wroteSkeletons` 是
        //     "**插件替你起了个骨架，等你填**"。模型看到后者才知道**该去填**。
        wroteSkeletons: skel,
        // ★ V3/D290：`staged` 只在**真进过暂存区**时为 true；进去了哪些、被挡住哪些都写出来。
        ...(staged === undefined ? {} : { staged }),
        ...(staging === undefined || staging.stagedPaths.length === 0
          ? {}
          : { stagedPaths: staging.stagedPaths }),
        ...(staging === undefined || staging.stagedSkipped.length === 0
          ? {}
          : { stagedSkipped: staging.stagedSkipped }),
        ...(staging === undefined || staging.stagedNote === undefined
          ? {}
          : { stagedNote: staging.stagedNote }),
        notes,
      };
    },
  };
}
