/**
 * workspace-tools.js —— `ledger_note` / `ledger_handoff` / `ledger_lock` 三个工具的定义。
 *
 * ★★★ 2026-10-26（D328）：**从 `part4.js` 整块搬出**，目的是给它腾容量。
 *   🔴 起因：我修 010 F-01（项目锁自囚）时在 `part4.js` 加了两处边界判据，
 *     把它从 253,118 B 顶到 **255,252 B** ⇒ 距 262,144 上限只剩 6,892 B，
 *     **跌破探针 `_probe-d323-f07-split.mjs` 的 8 KiB 红线**（那条当场变红）。
 *   ★ 处置**不是删注释**（那是一次性的，009 那轮已经用过一次），
 *     而是按 D325/D327 早就点名的内聚簇**真拆**。
 *
 * ★★ 搬家方式（判据）：**逐字复制，不重写**。
 *   本文件正文与 `part4.js` 原位置逐字相同，只在顶部加 import 头与这段说明。
 *   ⇒ 行为等价性不需要重新论证，它读的就是原来那些字节。
 *
 * ★★ 调用面**零改动**：`part4.js` 原位置留了转发导出，
 *   ⇒ `index.js` 与 `tools/` 里那些 `from "./part4.js"` 的 import 一个字都不用改。
 *   （D307/D318/D319/D323/D326 同一做法：**搬实现可以，改调用面不行**。）
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AUDIT_KINDS, AUDIT_KIND_ARCHIVE, AUDIT_KIND_GOALS, AUDIT_KIND_JOURNAL, AUDIT_KIND_LESSONS, AUDIT_KIND_PRINCIPLE, AUDIT_KIND_WRITE, CHECKPOINT_TOOL, CONFORMANCE, DEFAULT_IGNORE_LINES, DEFAULT_READ_LEVELS, LOG_DEFAULT_LIMIT, LOG_LEVEL_NAMES, LOG_MAX_LIMIT, MANIFEST_REL, MAX_ARCHIVE_LIST, MAX_READ_CHARS, NOTE_KINDS, OK_SCHEMA, PRECEDENCE_PROJECT, PRESERVE_HEADING, PRINCIPLE_GRANT_TOOL, PROTOCOL_REQUIREMENTS, PROTOCOL_VERSION, satisfiedProtocolVersion, ROOT_PARAM, name } from "./defs.js";
import { archiveSegmentOf, bodyLineCount, bumpRevision, changeRegisterLine, changeRegisterMaxOf, currentSettings, fnv1a, lockStorePath, lockedRootOf, lostEntries, lostLines, manifestRevision, numOf, precedenceIsProject, precedenceValue, recordBlockHistory, sessionTag, setProjectLock, skeletonOf, splitChangeRegister, tagOfId, weightBlocks, withChangeRegister } from "./part1.js";
import { archiveStamp, conformanceOf, consumePrincipleGrant, countLines, defaultLogLevels, ensureDir, fail, findWorkspaceRoot, git, gitAdd, goalStampMs, handoffFileName, ignoreStateOf, inspect, isAbsoluteAnywhere, isUnder, isUnderReal, logDirOf, logFileRel, lossless, memoryBaseOf, memoryRootIgnoreLines, mergeGitignore, noteFileName, parseGoalCards, parseLevels, parseLogLine, principleGrantOf, projectRootOf, readManifest, readTextSafe, refuseIfMemoryRootUnsafe, renderNote, shouldAutoStage, stageOutcomeOf, stamp, stampSec, toGitRel, writeFileAtomic, writePrinciples } from "./part2.js";
import { noteLedgerTouched, renderResult, rootFromExec } from "./part3.js";
import { migrateToV3, writeSecurityMd } from "./part7.js";
import { syncManifestMirror, writeManifestSynced } from "./manifest-mirror.js";
import {
  cardDirLabel,
  cardDirAbs,
  cardModeOf,
  // ★★ 2026-10-23（D307 收尾）：这两个**必须 import**（不能只 re-export）——
  //   part4 自己在 `readEntryUnified` 那几处还在调它们（1758 / 1774 / 1826 行）。
  //   🔴 又是同一个坑（这是第四次）：re-export 只把名字导出去，**不在本模块作用域绑定**。
  entryTocOf,
  isSafeCardKey,
  kindLocationOf,
  listCards,
  readEntryUnified,
  readKindRaw,
  renderCardIndex,
  sliceEntryByKey,
  splitFileIntoCards,
  splitIntoCardParts,
  writeCard,
  writeCardIndex,
  writeKindCard,
} from "./card-ops.js";


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

export function defineNoteTool() {
  return {
    name: "ledger_note",
    description:
      "Write a PROBLEM/INVESTIGATION note — for work that is NOT a project. Use this instead of " +
      "ledger_init when the session is about solving a problem, investigating something, or " +
      "diagnosing a fault: such work has an endpoint, so it has no \"current goal / next step / " +
      "archive\" to maintain. " +
      // ★★★★★ 2026-10-17（D229）：这里原来**写死**了本机那条通道名当例子
      //   （`e.g. 60-对话记录与交接/对话总结/`）—— 那是**我们的**格局，别人那儿未必有。
      //   ⇒ 改成如实描述两档：**有就用已有的，没有才新建 `问题记录`**。
      "The note goes to the workspace's EXISTING notes channel if one is found (a registered " +
      "`notesDir`, or an existing directory by a known name); if none exists it creates `问题记录/` " +
      "at the workspace root. Files are named `YYYY-MM-DD-title.md`, and an existing file is " +
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
      const unsafeNote = refuseIfMemoryRootUnsafe(info, ["notesDir"]);
      if (unsafeNote !== undefined) return unsafeNote;
      if (info.notesAbs === undefined || info.notesRel === undefined) {
        return { ok: false, reason: "解析不出问题记录目录（容器判定异常）。" };
      }
      const wsBase = findWorkspaceRoot(root) ?? root;
      if (!isUnderReal(wsBase, info.notesAbs).ok) {
        return { ok: false, reason: `问题记录目录路径越界（含符号链接或指向工作区外）：${info.notesRel}`, unsafePath: true };
      }

      const title = typeof args?.title === "string" ? args.title.trim() : "";
      if (title === "") return { ok: false, reason: "title 不能为空 —— 文件名要用它。" };

      const now = new Date();
      const fileName = noteFileName(now, title);
      const abs = path.join(info.notesAbs, fileName);
      // 防御：文件名由我们拼，但仍然确认一次没有逃出目录。
      if (!isUnderReal(info.notesAbs, abs).ok) return { ok: false, reason: "ledger_note: 目标逃出了记录目录", path: abs, unsafePath: true };

      let noteExists = fs.existsSync(abs);
      if (!noteExists) {
        try { noteExists = fs.lstatSync(abs) !== undefined; } catch { noteExists = false; }
      }
      if (noteExists) {
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

export function defineHandoffTool() {
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
      // ★★★ 2026-10-23（D316 · GAP-01）：`memoryRoot` 越界 ⇒ 拒绝，不降级写回源码根。
      const unsafeMem = refuseIfMemoryRootUnsafe(info, ["handoffDir"]);
      if (unsafeMem !== undefined) return unsafeMem;
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
      const memBase = memoryBaseOf(info, root);
      if (!isUnderReal(memBase, info.handoffAbs).ok) {
        return { ok: false, reason: `交接单目录路径越界（含符号链接或指向记忆根外）：${info.handoffRel}`, unsafePath: true };
      }
      const baseFileName = handoffFileName(now, title);
      const stem = baseFileName.replace(/\.md$/i, "");
      let fileName = baseFileName;
      let abs = path.join(info.handoffAbs, fileName);
      if (!isUnderReal(info.handoffAbs, abs).ok || !isUnderReal(memBase, abs).ok) {
        return { ok: false, reason: "ledger_handoff: 目标逃出了交接单目录", path: abs, unsafePath: true };
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
          : `- 活跃台账：\`${path.join(memBase, info.activeRel)}\`\n`) +
        (kindLocationOf(info, "decisions").rel === undefined
          ? ""
          : `- 关键决策：\`${path.join(memBase, kindLocationOf(info, "decisions").rel)}\`\n`) +
        (info.logRel === undefined
          ? ""
          : `- 活动日志：\`${path.join(memBase, info.logRel)}\`（用 \`ledger_log\` 按需查）\n`) +
        (info.archiveRel === undefined
          ? ""
          : `- 归档：\`${path.join(memBase, info.archiveRel)}\`\n`);
      try {
        ensureDir(info.handoffAbs);
        if (!isUnderReal(memBase, info.handoffAbs).ok) {
          return { ok: false, reason: `交接单目录路径越界：${info.handoffRel}`, path: abs };
        }
        let written = false;
        for (let i = 1; i <= 99; i += 1) {
          fileName = i === 1 ? baseFileName : `${stem}-${i}.md`;
          abs = path.join(info.handoffAbs, fileName);
          if (!isUnderReal(info.handoffAbs, abs).ok || !isUnderReal(memBase, abs).ok) {
            return { ok: false, reason: "ledger_handoff: 目标逃出了交接单目录", path: abs, unsafePath: true };
          }
          try {
            fs.writeFileSync(abs, body, { encoding: "utf8", flag: "wx" });
            written = true;
            break;
          } catch (e2) {
            if (e2?.code !== "EEXIST" || i === 99) throw e2;
          }
        }
        if (!written) throw new Error("同一分钟内同名交接单已达 99 份上限");
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

export function defineLockTool() {
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
      // ★★★★★ 2026-10-26（D328 · Gemini 010 F-01 **实测复现的「项目锁自囚」**）：
      //   🔴 病：`base` 一旦被锁到容器里的某个 **Git 子仓库**（如 `<ws>/proj-a`），
      //     `findWorkspaceRoot(base)` 遇到 `proj-a/.git` 就**停在 proj-a**、不再回到 `<ws>`
      //     ⇒ 此后想切到**兄弟项目** `proj-b`：
      //       · 传绝对路径 / `../proj-b` ⇒ `isUnderReal(proj-a, proj-b)` 判 `lexical-escape`，拒绝；
      //       · 传相对名 `proj-b` ⇒ 解析成 `proj-a/proj-b`（不存在），拒绝。
      //     ⇒ **三者全堵死**，除非先手动解锁 —— 用户被自己的锁关在里面。
      //   ★ 实测（`tools/_probe-d328-f01.mjs`）：三条路径**全部 `ok:false`**。
      //   ⇒ 修法（两件事，缺一不可）：
      //     ① **解析基准**：先按 `base` 解析；那个路径**不存在**时，再按**会话初始 cwd** 解析
      //        （会话 cwd 是用户在容器里站着的地方，兄弟项目相对它才说得通）。
      //     ② **边界判据**：目标在 `findWorkspaceRoot(base)` **或**
      //        `findWorkspaceRoot(cwdBase)` **任一**真实边界之内就放行 —— 两者都是"用户真实的上级工作区"，
      //        取并集不降低安全性；**跳出最外层工作区仍被严格拦**（探针第 3 段验这条）。
      //   ★ 不改 `isUnderReal` 本身 —— 它是全仓共用的安全基石，只在这里喂**正确的边界**。
      const rawCwd = agent?.session?.header?.cwd;
      const cwdBase = typeof rawCwd === "string" && rawCwd.trim() !== "" ? path.resolve(rawCwd) : undefined;
      const anchorBase = base ?? cwdBase ?? process.cwd();
      const candBase = path.resolve(anchorBase, raw);
      const candCwd =
        !fs.existsSync(candBase) && cwdBase !== undefined ? path.resolve(cwdBase, raw) : undefined;
      const abs = candCwd !== undefined && fs.existsSync(candCwd) ? candCwd : candBase;
      {
        const inside = (rootAbs) => {
          if (typeof rootAbs !== "string" || rootAbs === "") return false;
          return isUnderReal(findWorkspaceRoot(rootAbs) ?? rootAbs, abs).ok === true;
        };
        if (!inside(anchorBase) && !inside(cwdBase)) {
          const why = isUnderReal(findWorkspaceRoot(anchorBase) ?? anchorBase, abs).why;
          return { ok: false, reason: `拒绝锁定：目标目录 \`${abs}\` 越出了当前会话工作区边界（${why}）。` };
        }
      }
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

