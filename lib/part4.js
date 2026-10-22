import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AUDIT_KINDS, AUDIT_KIND_ARCHIVE, AUDIT_KIND_GOALS, AUDIT_KIND_JOURNAL, AUDIT_KIND_PRINCIPLE, AUDIT_KIND_WRITE, CHECKPOINT_TOOL, CONFORMANCE, DEFAULT_IGNORE_LINES, DEFAULT_READ_LEVELS, LOG_DEFAULT_LIMIT, LOG_LEVEL_NAMES, LOG_MAX_LIMIT, MANIFEST_REL, MAX_ARCHIVE_LIST, MAX_READ_CHARS, NOTE_KINDS, OK_SCHEMA, PRECEDENCE_PROJECT, PRESERVE_HEADING, PRINCIPLE_GRANT_TOOL, PROTOCOL_REQUIREMENTS, PROTOCOL_VERSION, satisfiedProtocolVersion, ROOT_PARAM, name } from "./defs.js";
import { apply } from "./index.js";
import { archiveSegmentOf, bodyLineCount, bumpRevision, changeRegisterLine, changeRegisterMaxOf, currentSettings, fnv1a, lockStorePath, lockedRootOf, lostEntries, lostLines, manifestRevision, numOf, precedenceIsProject, precedenceValue, recordBlockHistory, sessionTag, setProjectLock, skeletonOf, splitChangeRegister, tagOfId, weightBlocks, withChangeRegister } from "./part1.js";
import { archiveStamp, conformanceOf, consumePrincipleGrant, countLines, defaultLogLevels, ensureDir, fail, git, gitAdd, goalStampMs, handoffFileName, inspect, isUnder, isUnderReal, logDirOf, logFileRel, lossless, memoryBaseOf, memoryRootIgnoreLines, mergeGitignore, noteFileName, parseGoalCards, parseLevels, parseLogLine, principleGrantOf, projectRootOf, readManifest, readTextSafe, renderNote, stageOutcomeOf, stamp, stampSec, toGitRel, writeFileAtomic, writePrinciples } from "./part2.js";
import { noteLedgerTouched, renderResult, rootFromExec } from "./part3.js";
import { migrateToV3 } from "./part7.js";

export function repairConformance(root, opts) {
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
    // ★ V3（D289）：决策记录是**记忆** ⇒ 基准 `memoryBase`。
    const mBase = memoryBaseOf(info, root);
    const abs = path.resolve(mBase, info.decisionsRel);
    if (!isUnder(mBase, abs)) {
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
    // ★ V3（D289）：归档目录是**记忆** ⇒ 基准 `memoryBase`。
    const mBase = memoryBaseOf(info, root);
    const abs = path.resolve(mBase, info.archiveRel);
    if (!isUnder(mBase, abs)) {
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

  // ④ ★★★★★ 2026-10-19（D272 第二轮）：**协议缺口里有"机械可修"的那几条，这里真的去修。**
  //
  //   🔴 原来 `conformanceOf` 的 `fixable` 里写着「补清单键 `logDir` + 建对应空目录」，
  //     但**这个函数根本没实现它** —— 那句承诺是**空的**。
  //     ★ 这正是本项目最忌的那类：**报出来的建议与真正做的事不一致**，
  //       用户点了"修复"、回执说 ok，实际什么都没补，下一轮又报同样的缺口。
  //       （与 D89「记录存在 ≠ 记录准确」同型，这里是「**建议存在 ≠ 建议可执行**」。）
  //
  //   ★ 只修 `mechanical: true` 的那几条（目前只有日志分片）；卡片化**绝不自动登记**
  //     —— 那会让单文件内容从视野里消失（判据见 `PROTOCOL_REQUIREMENTS` 里那段长注释）。
  const protoNow = conf.protocol;
  if (protoNow !== undefined) {
    for (const g of protoNow.missing) {
      if (g.mechanical !== true) {
        skipped.push(`协议缺口「${g.label}」**需要 AI 判断**（先 ledger_migrate 再登记键），本工具不动`);
        continue;
      }
      // 目前 mechanical 的只有 logDir；按 keys 通用地处理，将来加新的也不用改这里。
      for (const key of g.keys) {
        // ★ 目录名照既有的候选约定取（与 `ledger_init` 的默认值同一套），不另发明一个。
        const dirRel = key === "logDir" ? "_ledger-log" : key;
        // ★ V3（D289）：日志目录是**记忆** ⇒ 基准 `memoryBase`。
        const mBaseRc = memoryBaseOf(info, root);
        const abs = path.resolve(mBaseRc, dirRel);
        if (!isUnder(mBaseRc, abs)) {
          skipped.push(`协议缺口 ${key} 的目录路径逃出项目根，跳过：${dirRel}`);
          continue;
        }
        if (fs.existsSync(abs)) {
          if (fs.statSync(abs).isDirectory()) {
            nextManifest[key] = dirRel;
            manifestTouched = true;
            actions.push(`把已存在的日志目录 \`${dirRel}\` 登记进清单（不动目录内容）`);
          } else {
            skipped.push(`${dirRel} 已存在但不是目录，跳过（不擅自改名或删除）`);
          }
        } else if (apply) {
          ensureDir(abs);
          nextManifest[key] = dirRel;
          manifestTouched = true;
          actions.push(`新建日志目录 \`${dirRel}\` 并登记进清单`);
        } else {
          actions.push(`将新建日志目录 \`${dirRel}\` 并登记进清单`);
        }
      }
    }
  }

  // ⑤ 超阈值 / 卡片化这类：**不动**，交给 AI（挑条目、切卡都是判断）
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

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★★★ 2026-10-14（D199，用户拍板）：**老文件迁移 / 拆分 —— 检测并给步骤**
// ═══════════════════════════════════════════════════════════════════════════
//
//  用户原话（逐字，D197 那轮的**后半句**）：
//    *"以及按照插件的更新去把**老版本的文件拆分成新的文件**。
//      或者是按照新版本去**更新新的台账系统和日志系统**。"*
//
// ★★ 与 `ledger_conform` 的**分工**（两条合起来才是完整答案）：
//   · `ledger_conform`：**只做加法**（补清单字段、补空文件/空目录）；
//   · 本能力：**减法/搬家**（把旧架构里混在一起的"状态"与"历史"分开、把旧字段补成新字段）。
//     ⇒ 减法**必然要动已有内容** ⇒ 按本项目一贯纪律，**绝不自动执行**，
//       只**检测 + 给出可执行的拆分步骤**，由 AI（看得懂内容）去动手。
//
// ★★★ 两条设计红线（都是我主动加的，理由写在各自函数上）：
//   ① **检测必须有证据**：不许"看到旧文件就说它旧"。本项目那条纪律
//      「**记录存在 ≠ 记录准确**」的反面同样成立：**报告存在 ≠ 报告准确** ——
//      报一个不存在的"旧格式"会让 AI 去改一个本来没问题的文件（那是破坏）。
//      ⇒ 每个判定都带**实测数字**（几行日期流水 / 几行勾选 / 命中哪个旧字段）。
//   ② **绝不猜旧格式长什么样**：我的第一版想用"日期前缀行"当信号，
//      实测在**真旧台账**上只命中 **5%**（而那份文件的旧格式其实是
//      `## <日期> 归档（…）` 标题 + `- [x] …` 勾选清单）⇒ 若照那个假设去写判据，
//      它会**永远报"没发现旧格式"**（假阴性），而真相是文件很旧。
//      ⇒ 正解：**多信号一起量、如实报占比**，把"怎么判"留给看得懂内容的 AI。

/** 一次迁移检测的**信号表**（单一出处：注入文案与工具输出都从这里取）。 */

export function migrationSignals() {
  return [
    {
      key: "dateFlow",
      label: "**日期流水**（以日期开头的条目行 —— 旧台账习惯把「发生过什么」记在状态文件里）",
      re: /^\s*[-*|]?\s*\d{4}-\d{2}-\d{2}/,
      // ★ 判据刻意**很窄**（必须**行首**就是日期）：宽了会把正文里引用的日期也算进来。
      target: "journal",
      why: "它是**历史**，该搬到 `JOURNAL.md`（只追加、不注入）",
    },
    {
      key: "datedSection",
      label: "**日期节标题**（`## <日期> …` —— 旧台账按天分节，一节就是一批已完成）",
      re: /^#{2,4}\s*\d{4}-\d{2}-\d{2}/,
      target: "archive",
      why: "它是**已完成的历史**，该用 `ledger_archive` 移进归档目录",
    },
    {
      key: "doneChecklist",
      label: "**已完成勾选清单**（`- [x] …` —— 旧台账把「已完成明细」直接列在状态文件里）",
      re: /^\s*[-*]\s*\[[xX]\]/,
      target: "archive",
      why: "它是**已有结论的历史**，该用 `ledger_archive` 移进归档目录（正文一个字不改）",
    },
    {
      key: "inlineDecisions",
      label: "**散落的决策**（同一文件里既讲状态又逐条记决策 —— 旧架构没有独立的决策文件）",
      // ★★★★★ 这里我**当场栽了一次，而且栽的正是本文件自己记下的 L1** —— 必须留档：
      //   第一版写的是 `/^#{2,4}\s*(?:决策|决定|D\d+)\b/m`。
      //   而 **`\b` 在中文后面永远不匹配**（`\b` = `\w`(ASCII) 与非 `\w` 的交界，汉字不属于 `\w`
      //   ⇒ 它后面**不存在交界**）⇒ `## 决策`、`## 决定` 这两种写法**一个都匹配不到**，
      //   只有 `## D1` 那一路活着。★ 更危险的是：**这一条在"该文件本来就是决策文件"时
      //   恰好还命中 208 次**（因为 `DECISIONS.md` 里全是 `## D<n>`）⇒ 表面看"有数"，
      //   于是那个恒 false 的分支**永远不会被发现**。
      //   ⇒ 正解：去掉 `\b`，用**显式否定**避免 `D1` 误匹配 `D1x`（L1 给的就是这个改法）。
      re: /^#{2,4}\s*(?:决策|决定|D\d+(?![\dA-Za-z]))/m,
      target: "decisions",
      why: "它该拆进 `DECISIONS.md`（长决策**不参与归档、永久保留**）",
    },
  ];
}

/**
 * ★★★★★ 检测一个项目的记忆文件**是不是旧架构**，并给出拆分/升级步骤。
 *
 * ★ **只读**：不写任何文件（连备份都不写）。要动内容由 AI 按它给的步骤做。
 * ★ 判据形态：**逐信号量占比 + 只在有明显占比时才报警** ——
 *   零散出现一两个日期是正常的（正文里引用日期很常见），**占比**才是"旧架构"的证据。
 *
 * @param {string} root 项目根
 * @returns {{ok:boolean, needsMigration:boolean, files:Array, steps:string[], notes:string[]}}
 */

export function detectMigration(root) {
  const info = inspect(root);
  const files = [];
  const notes = [];
  const steps = [];

  // ── ① 逐个记忆文件量信号（只读）─────────────────────────────────────────
  const candidates = [
    { rel: info.activeRel, role: "active" },
    { rel: info.decisionsRel, role: "decisions" },
    { rel: info.journalRel, role: "journal" },
    { rel: info.goalsRel, role: "goals" },
    { rel: info.lessonsRel, role: "lessons" },
  ].filter((c) => typeof c.rel === "string" && c.rel !== "");

  for (const c of candidates) {
    const abs = path.resolve(root, c.rel);
    if (!isUnder(root, abs)) continue;
    const text = readTextSafe(abs);
    if (text === undefined) continue;
    const lines = text.split(/\r?\n/);
    const total = lines.length;
    const hits = [];
    for (const s of migrationSignals()) {
      const n = lines.filter((l) => s.re.test(l)).length;
      if (n > 0) hits.push({ key: s.key, label: s.label, count: n, pct: Math.round((n / Math.max(1, total)) * 100), target: s.target, why: s.why });
    }
    files.push({ rel: c.rel, role: c.role, lines: total, hits });
  }

  // ── ② 判"要不要迁移"：**按证据**，不是按"文件存在"──────────────────────
  //
  // ★ 阈值是有意的：**≥10% 或 ≥20 行**才算"这份文件承担了它不该承担的职责"。
  //   为什么两条都要：大文件里 10% 可能是几百行（真的该搬），
  //   小文件里 20 行也可能只占 5%（但那 20 行确实跑错了地方）。
  const THRESHOLD_PCT = 10;
  const THRESHOLD_LINES = 20;
  const problem = [];
  for (const f of files) {
    // ★ 只看**落在错地方**的信号：`active` 里出现"日期流水 / 日期节 / 勾选清单"才算错位；
    //   `decisions` 里出现 `D<n>` 标题是**对的**（那正是它该有的形状）⇒ 不算问题。
    for (const h of f.hits) {
      const misplaced =
        (f.role === "active" && (h.key === "dateFlow" || h.key === "datedSection" || h.key === "doneChecklist" || h.key === "inlineDecisions")) ||
        (f.role === "decisions" && h.key === "dateFlow") ||
        (f.role === "journal" && h.key === "doneChecklist");
      if (!misplaced) continue;
      if (h.pct >= THRESHOLD_PCT || h.count >= THRESHOLD_LINES) {
        problem.push({ ...h, rel: f.rel, role: f.role, total: f.lines });
      }
    }
  }

  // ── ③ 结构化旧字段的迁移（**老字段 ⇒ 新字段**）──────────────────────────
  //
  //  ★ 这是"按照插件的更新去更新新版本"那一半：D198 刚给目标卡加了 `- 更新于:`，
  //    老项目里的卡没有它 ⇒ 这里**如实报出"有几张卡缺时间"**。
  //    ★ 但**不替它补**：补时间要写"什么时候"，而插件不知道那张卡何时被改过 ——
  //      乱补一个"现在"等于伪造事实（正是 D198 禁止的"假装知道"）。
  //      ⇒ 只报数 + 给步骤（让 AI 用 upsert 重写那张卡，插件自然会打上真实时间）。
  if (typeof info.goalsRel === "string" && info.goalsRel !== "") {
    // ★ V3（D289）：目标树是**记忆** ⇒ 基准 `memoryBase`。
    const mBase = memoryBaseOf(info, root);
    const gAbs = path.resolve(mBase, info.goalsRel);
    if (isUnder(mBase, gAbs)) {
      const gText = readTextSafe(gAbs);
      if (gText !== undefined) {
        const cards = parseGoalCards(gText);
        const noTime = cards.filter((c) => goalStampMs(c.updatedAt) === undefined);
        if (noTime.length > 0) {
          const missing = {
            key: "goalNoTime",
            label: "**目标卡缺 `更新于` 字段**（D198 新增 —— 没有它，权重无法按相对时间下降、注入也只能显示「未知」）",
            count: noTime.length,
            pct: Math.round((noTime.length / Math.max(1, cards.length)) * 100),
            target: "goals",
            why: "用 `ledger_goals({op:\"upsert\", id:…})` **重写那张卡** ⇒ 插件会自动打上真实时间（★ 插件**不能替你补**：它不知道那张卡何时被改过，乱补一个「现在」就是伪造事实）",
            ids: noTime.map((c) => c.id),
          };
          const gf = files.find((f) => f.rel === info.goalsRel);
          if (gf !== undefined) gf.hits.push(missing);
          problem.push({ ...missing, rel: info.goalsRel, role: "goals", total: cards.length });
        }
      }
    }
  }

  // ── ④ 由"问题"生成**可执行步骤**（按目标文件归组，顺序有意义）──────────
  if (problem.length > 0) {
    const toJournal = problem.filter((p) => p.target === "journal");
    const toArchive = problem.filter((p) => p.target === "archive");
    const toDecisions = problem.filter((p) => p.target === "decisions");
    const toGoals = problem.filter((p) => p.target === "goals");

    if (toJournal.length > 0) {
      steps.push(
        `**先搬历史**（${toJournal.map((p) => `\`${p.rel}\` 的 ${p.count} 行${p.label.replace(/\*\*/g, "")}`).join("；")}）：\n` +
          "  ⇒ 用 `ledger_write({target:\"journal\", mode:\"append\"})` 把那些段**逐字**搬进 `JOURNAL.md`" +
          "（★ 只追加、不改旧条目；搬完再从活跃台账里删掉这些**已搬走**的段）。\n" +
          "  ★★ 顺序必须是**先写后删**：先 append 进 journal，**确认写成功**，再回去删台账里的那几段 —— 反过来会丢内容。"
      );
    }
    if (toArchive.length > 0) {
      steps.push(
        `**再归档已完成**（${toArchive.map((p) => `\`${p.rel}\` 的 ${p.count} 行${p.label.replace(/\*\*/g, "")}`).join("；")}）：\n` +
          "  ⇒ 用 `ledger_archive` 把那些段移进归档目录（**它自己会写进只追加的归档**，不用手抄）。\n" +
          "  ★ 若超过行数上限，`ledger_archive` 会**拒绝**并告诉你还差几行 —— 那是设计如此，不是故障。"
      );
    }
    if (toDecisions.length > 0) {
      steps.push(
        `**把决策拆出来**（${toDecisions.map((p) => `\`${p.rel}\` 里约 ${p.count} 条${p.label.replace(/\*\*/g, "")}`).join("；")}）：\n` +
          "  ⇒ 逐条写成 `## D<n> · <标题>`（n 递增不重用）追加进 `DECISIONS.md`；\n" +
          "  ★★ 台账里若引用了 `D<n>`，**必须有对应正文**（自检会核「引用必达」，引用了没正文 ⇒ 当场变红）。"
      );
    }
    if (toGoals.length > 0) {
      const ids = toGoals.flatMap((p) => p.ids ?? []).slice(0, 20);
      steps.push(
        `**给目标卡补时间**（${toGoals.length} 处）：\n` +
          `  ⇒ 用 \`ledger_goals({op:"upsert", id:"<卡id>", …})\` **逐张重写**（${ids.join("、")}${ids.length >= 20 ? " …" : ""}）——\n` +
          "  插件写卡时会自动打上**真实**的 `- 更新于:`。★ 别手写时间：插件不知道那张卡何时被改过，\n" +
          "  乱补一个时间就是**伪造事实**（D198 明令禁止「不知道就假装知道」）。"
      );
    }
    steps.push(
      "**最后**：跑一次 `ledger_status` 看行数是否已回到上限内；★ **每做一步就落一次盘**" +
        "（`ledger_write`），别攒到最后 —— 中途出错时，没落盘的那部分就是唯一副本。"
    );
  }

  if (files.length === 0) {
    notes.push("这个项目**还没有登记任何记忆文件** ⇒ 谈不上「迁移」（该走 `ledger_init` 建一套）。");
  }
  notes.push(
    "★ 本检测**只读**（一个字节都没写）。它报的是「**这份文件承担了它不该承担的职责**」，" +
      "不是「文件坏了」 —— 拆与不拆由你判断。"
  );
  if (problem.length === 0 && files.length > 0) {
    notes.push("✅ 这些文件里**没有**发现「职责错位」的证据（占比都低于阈值）—— **不需要迁移**。");
  }

  return {
    ok: true,
    needsMigration: problem.length > 0,
    files,
    problemCount: problem.length,
    steps,
    notes,
  };
}

/**
 * ⑪ ledger_migrate —— 检测**旧架构的记忆文件**并给出拆分/升级步骤（D199）。
 *
 * ★ 与 `ledger_conform` 的分工（用户 D197 后半句要的就是这一半）：
 *   · `conform` = **加法**（补字段、补空文件）⇒ 可以自动做；
 *   · `migrate` = **减法/搬家**（把"历史"从状态文件里搬出去、把决策拆出来、给旧卡片补新字段）
 *     ⇒ **必然动已有内容** ⇒ **绝不自动执行**，只检测 + 给步骤。
 * ★ 默认只读（`op:"detect"` 一个字节都不写）。★★ 但 `op:"split"` 与 `op:"v3"` **会写** ——
 *   它们的共同保证不是"只读"，而是 **`apply` 不传就是干跑**，且**绝不删用户的原文件**
 *   （split 留快照；v3 搬 `_retired`）。**同一句描述不能同时罩住两种语义** —— D224 那类过期文案。
 */

export function defineMigrateTool() {
  return {
    name: "ledger_migrate",
    description:
      "Detect whether an EXISTING project's memory files still use an OLD architecture, and emit " +
      "the concrete split/upgrade steps to bring them to the current spec. " +
      "op=\"detect\" (the default) is READ-ONLY and writes nothing. " +
      "op=\"split\" moves a single-file memory into a card folder; op=\"v3\" moves all memory into the " +
      "private subdirectory `<project>-ledger-memory/` (protocol generation 3). " +
      "★ Both split and v3 DEFAULT TO A DRY RUN — pass apply:true to actually do it — and neither " +
      "code path ever deletes your originals (split keeps the source as a snapshot; v3 retires old " +
      "files instead of removing them). Use this when a project was set up by an older version of " +
      "this plugin, when the active ledger has grown to hold history it should not hold, or when the " +
      "project should move its memory inside the project for generation 3. " +
      "For purely additive repairs (missing manifest fields, missing empty files) use ledger_conform instead.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        // ★ 2026-10-14（D202，用户拍板）：把"单文件 ⇒ 一卡一文件"的**迁移**挂在同一个工具上。
        //   ★ 为什么同一个工具、不加新工具：两者都是"把老形态升到新形态"，
        //     而且**必须一起被看到**（用户要迁卡片时，先跑 detect 看现在什么样）。
        //   ★★ `op:"split"` **不是只读的** —— 它会在项目里建一个卡片目录。
        //     但它**默认 dry-run**（`apply` 不传就是预览），且**绝不删原文件**。
        op: {
          type: "string",
          enum: ["detect", "split", "v3"],
          description:
            "detect (default) = read-only detection of old-format layout. " +
            "split = move a single-file memory into a card folder (ONE CARD PER FILE). " +
            "★ split defaults to a DRY RUN and NEVER deletes the source file — it stays as a snapshot. " +
            "v3 = move all memory files into the private subdirectory `<project>-ledger-memory/` " +
            "(protocol generation 3). ★ v3 defaults to a DRY RUN too, and its switch point is " +
            "one atomic manifest write — before it, the old manifest still points at the old " +
            "locations, so an interruption at any step is safe to retry.",
        },
        kind: {
          type: "string",
          enum: ["decisions", "lessons", "goals"],
          description: "For op:\"split\": which memory to split into cards. Required for split.",
        },
        dir: {
          type: "string",
          description: "For op:\"split\": target folder (default: decisions / lessons / goals). Refused if it already exists and is non-empty.",
        },
        apply: {
          type: "boolean",
          description: "For op:\"split\" / op:\"v3\": default false = dry run (writes nothing). Set true to actually perform the change.",
        },
      },
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec, args);
      // ── `op:"split"`：单文件 ⇒ 一卡一文件（D202）─────────────────────────
      if (args?.op === "split") {
        const kind = typeof args?.kind === "string" ? args.kind : "";
        if (kind !== "decisions" && kind !== "lessons" && kind !== "goals") {
          return {
            ok: false,
            reason: "`op:\"split\"` 需要 `kind`（decisions / lessons / goals）—— 一次拆一类，不混着拆。",
          };
        }
        const info = inspect(root);
        return splitFileIntoCards(root, info, kind, {
          apply: args?.apply === true,
          dir: typeof args?.dir === "string" ? args.dir : undefined,
        });
      }
      // ── `op:"v3"`：记忆搬进私有子目录（D295 · 第三代协议）───────────────
      if (args?.op === "v3") {
        return migrateToV3(root, { apply: args?.apply === true });
      }
      return detectMigration(root);
    },
  };
}

/** ② ledger_init —— 登记 AI 设计的结构 + Git 初始化。 */

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
        memoryRoot: {
          type: "string",
          description:
            "V3: optional relative directory that holds ALL memory files (e.g. " +
            "\"<project-name>-ledger-memory\"). When set, `active` / `decisions` / `archiveDir` / " +
            "`logDir` / the card dirs / journal / goals / lessons / principles are all resolved " +
            "INSIDE it, while `.dsh-ledger.json` and `.gitignore` stay at the project root. " +
            "Omit for the V2 layout (memory files directly in the project root).",
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
      const memoryRootArg = typeof args?.memoryRoot === "string" ? args.memoryRoot.trim() : "";
      let memRootRel;
      let memRootAbs = root;
      if (memoryRootArg !== "") {
        if (path.isAbsolute(memoryRootArg)) {
          throw fail(`ledger_init: 'memoryRoot' 必须是相对路径：${memoryRootArg}`);
        }
        const cand = path.resolve(root, memoryRootArg);
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
      const logDir = typeof args?.logDir === "string" ? args.logDir.trim() : "";
      // ★★★★★ 2026-10-20（D282）：卡片化三目录。口径与 `logDir` 完全一致 ——
      //   传了才建、才登记；不传就是 ""（什么都不做，不擅自创建）。
      const decisionsDir = typeof args?.decisionsDir === "string" ? args.decisionsDir.trim() : "";
      const lessonsDir = typeof args?.lessonsDir === "string" ? args.lessonsDir.trim() : "";
      const goalsDir = typeof args?.goalsDir === "string" ? args.goalsDir.trim() : "";
      // ★ 这三个也是"目录路径"，必须和 active/decisions/archiveDir 走**同一套边界校验**
      //   （绝对路径、逃出项目根都要拒）。漏掉它们 = 开了一个绕过边界检查的入口。
      // ★ V3（D289）：这些路径现在都相对**记忆基准**（不传 memoryRoot 时它就是项目根）。
      //   ★ 边界只需校验一层就够：`memRootAbs` 已被 `isUnderReal` 验过在项目内，
      //     「落在 memRootAbs 内」⇒ 必然也落在项目内。校验两层只是多余的重复。
      for (const [label, value] of [
        ["decisionsDir", decisionsDir],
        ["lessonsDir", lessonsDir],
        ["goalsDir", goalsDir],
      ]) {
        if (value === "") continue; // 可选：空就是不启用
        if (path.isAbsolute(value)) throw fail(`ledger_init: '${label}' 必须是相对路径：${value}`);
        const abs = path.resolve(memRootAbs, value);
        if (!isUnder(memRootAbs, abs)) throw fail(`ledger_init: '${label}' 逃出了项目根：${value}`);
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
        if (path.isAbsolute(value)) throw fail(`ledger_init: '${label}' 必须是相对路径：${value}`);
        const abs = path.resolve(memRootAbs, value);
        if (!isUnder(memRootAbs, abs)) throw fail(`ledger_init: '${label}' 逃出了项目根：${value}`);
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
        //   `LEDGER.md` 会被算成「项目根/LEDGER.md」，而真实文件在记忆子目录里
        //   ⇒ 下面那串"两个角色不许指向同一个文件"的**安全判据全部失效**（且不报错）。
        const abs = path.resolve(memRootAbs, rel.trim());
        // ★ Windows / macOS 的文件系统默认大小写不敏感 ⇒ 身份比较也要忽略大小写
        return process.platform === "win32" || process.platform === "darwin" ? abs.toLowerCase() : abs;
      };
      {
        // 本次**显式传入**的角色（未传的不参与，避免与"清单里的旧值"混淆 —— 旧值在下面那段查）
        const roles = [
          ["active", active],
          ["decisions", decisions],
          ["journal", typeof args?.journal === "string" ? args.journal.trim() : ""],
          ["goals", typeof args?.goals === "string" ? args.goals.trim() : ""],
          ["principles", typeof args?.principles === "string" ? args.principles.trim() : ""],
          ["lessons", typeof args?.lessons === "string" ? args.lessons.trim() : ""],
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
        //   `LEDGER.md` 会被算成「项目根/LEDGER.md」，而真实文件在记忆子目录里
        //   ⇒ 角色冲突检测（同文件两个角色）**静默失效**。这是安全判据，不能错。
        const norm = (rel) => (typeof rel === "string" && rel !== "" ? path.resolve(memRootAbs, rel).toLowerCase() : undefined);
        const prevManifest = readManifest(root) ?? {};
        const prevPrinciplesAbs = norm(prevManifest.principles);
        // 新清单里"原则"这个角色住在哪：显式传入优先，否则继承旧值
        const nextPrinciplesAbs =
          typeof args?.principles === "string" && args.principles.trim() !== ""
            ? norm(args.principles.trim())
            : prevPrinciplesAbs;
        if (nextPrinciplesAbs !== undefined) {
          const otherRoles = [
            ["active", active],
            ["decisions", decisions],
            ["journal", typeof args?.journal === "string" ? args.journal.trim() : prevManifest.journal],
            ["goals", typeof args?.goals === "string" ? args.goals.trim() : prevManifest.goals],
            ["lessons", typeof args?.lessons === "string" ? args.lessons.trim() : prevManifest.lessons],
          ];
          const hits = otherRoles
            .filter(([, rel]) => norm(rel) !== undefined && norm(rel) === nextPrinciplesAbs)
            .map(([label]) => label);
          if (hits.length > 0) {
            throw fail(
              `ledger_init: 拒绝 —— **原则文件不能被登记成普通角色**。\n` +
                `  · 原则文件：\`${path.relative(root, nextPrinciplesAbs)}\`\n` +
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
        if (path.isAbsolute(logDir)) throw fail(`ledger_init: 'logDir' 必须是相对路径：${logDir}`);
        const logAbsCheck = path.resolve(memRootAbs, logDir);
        if (!isUnder(memRootAbs, logAbsCheck)) throw fail(`ledger_init: 'logDir' 逃出了项目根：${logDir}`);
        // 日志目录不能与归档目录互相包含：两者都按 YYYY-MM/weekN 分桶，
        // 嵌套会让"读某一周"同时命中两种东西，回溯结果无法解释。
        const archAbs = path.resolve(memRootAbs, archiveDir);
        if (isUnder(archAbs, logAbsCheck) || isUnder(logAbsCheck, archAbs)) {
          throw fail("ledger_init: 日志目录与归档目录不能互相包含（两者都按周分桶，嵌套会混淆）。");
        }
      }

      // 三者互不重叠：归档目录不能是某个文件的路径，文件也不能塞进归档目录里。
      // ★ V3（D289）：全部相对**记忆基准**（不传 memoryRoot 时它就是项目根）。
      const activeAbs = path.resolve(memRootAbs, active);
      const decisionsAbs = path.resolve(memRootAbs, decisions);
      const archiveAbs = path.resolve(memRootAbs, archiveDir);
      if (isUnder(archiveAbs, activeAbs) || isUnder(archiveAbs, decisionsAbs)) {
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
        if (path.isAbsolute(journal)) throw fail(`ledger_init: 'journal' 必须是相对路径：${journal}`);
        const jAbs = path.resolve(memRootAbs, journal);
        if (!isUnder(memRootAbs, jAbs)) throw fail(`ledger_init: 'journal' 逃出了项目根：${journal}`);
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
        if (path.isAbsolute(value)) throw fail(`ledger_init: '${label}' 必须是相对路径：${value}`);
        const abs = path.resolve(memRootAbs, value);
        if (!isUnder(memRootAbs, abs)) throw fail(`ledger_init: '${label}' 逃出了项目根：${value}`);
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
        //   ★ 为什么"现状已经被挡住"还要补：见 `memoryRootIgnoreLines` 的注释
        //     （靠"同名递归匹配"是巧合；加一类新名字的文件就自动漏，且**不报错**）。
        //   ★ V2 项目（没有 memoryRoot）⇒ 返回空数组 ⇒ **行为逐字不变**。
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
        if (fs.existsSync(abs)) {
          if (typeof given === "string" && given !== "") notes.push(`${rel} 已存在，未覆盖。`);
          return;
        }
        const content = typeof given === "string" && given !== "" ? given : skeletonOf(skelKey);
        if (content === "") return; // 没有骨架可给（如 principles）⇒ 什么都不建
        ensureDir(path.dirname(abs));
        fs.writeFileSync(abs, content, "utf8");
        written.push(rel);
        if (!(typeof given === "string" && given !== "")) skel.push(rel);
      };
      ensureFile(activeAbs, active, args?.initialActive, "active");
      ensureFile(decisionsAbs, decisions, args?.initialDecisions, "decisions");      // ★★★ D269（修 review F07）：**可选参数的建文件全部在这里统一执行**。
      //   🔴 改前它们散在预检区里（journal 的甚至夹在四条校验中间）⇒
      //      git init / .gitignore / LEDGER.md / DECISIONS.md **都先发生**，
      //      直到这里才校验 journal/goals/… ⇒ 非法参数被拒时磁盘上已留下一堆没登记的文件。
      //   ★ 现在：**四条校验全跑完**（在上面的预检区）⇒ 才走到这里。
      // ★ V3（D289）：全部相对**记忆基准**（不传 memoryRoot 时它就是项目根，行为逐字不变）。
      if (journal !== "") ensureFile(path.resolve(memRootAbs, journal), journal, args?.initialJournal, "journal");
      if (goals !== "") ensureFile(path.resolve(memRootAbs, goals), goals, args?.initialGoals, "goals");
      if (lessons !== "") ensureFile(path.resolve(memRootAbs, lessons), lessons, args?.initialLessons, "lessons");

      ensureDir(archiveAbs);
      // ★ 日志目录只在**明确要了**的时候才建 —— 没传 logDir 就不往项目里塞任何东西。
      if (logDir !== "") ensureDir(path.resolve(memRootAbs, logDir));
      // ★★★★★ 2026-10-20（D282）：卡片化三目录**同样"只在明确要了时才建"**。
      //   ★ 为什么建空目录就够了：卡片模式按 `*Dir` 找卡，目录存在 ⇒ 读写入口成立；
      //     第一次 `ledger_write({target:"decisions", cards:[...]})` 会往里写第一张卡。
      //   ⚠️ 与"把已有单文件内容搬进去"是两件事 —— 那件事必须走 `ledger_migrate`
      //     （要读懂内容才能切卡），**绝不在这里替用户切**（D272 那条"登记目录键的前提是内容已经在目录里"）。
      //     ★ 所以这里**只**在目标目录为空/不存在时登记才安全；若同名单文件已有内容，
      //       调用方应当先 migrate 再建 —— 下面回执里会如实提示这件事。
      if (decisionsDir !== "") ensureDir(path.resolve(memRootAbs, decisionsDir));
      if (lessonsDir !== "") ensureDir(path.resolve(memRootAbs, lessonsDir));
      if (goalsDir !== "") ensureDir(path.resolve(memRootAbs, goalsDir));

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
      };
      const honestProtoVersion = Math.max(
        satisfiedProtocolVersion(protoFacts),
        Number.isFinite(prev.protocolVersion) ? Math.floor(prev.protocolVersion) : 1
      );

      const manifest = {
        ...prev,
        version: 1,
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
        autoGitAdd: args?.autoGitAdd !== false,
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
      // ★ D222：档位（`logLevels`）同样只在「以项目清单为准」时才冻结进来 ——
      //   否则面板上那 5 个开关会被"建项目那天"的值钉死。
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
      //   A3 的原实现无条件 `= manifestRevision(prev)` ⇒ 重复 init 后版本号**原地不动**，
      //   而 init 可能改掉 active 指向（内容语义变了）⇒ 别的会话手里那个旧号
      //   看起来仍"最新"，它整份 replace 时就不会触发自动保留 ⇒ 丢条目。
      //   修订号的语义是"台账内容变过一次就 +1"（见 `bumpRevision`），init 满足该条件。
      manifest.revision = hadPrevManifest ? manifestRevision(prev) + 1 : 0;
      // ★ 2026-10-18（D269）：与 `bumpRevision` / active 台账**同一个出口**（原子写）。
      //   清单被截断的后果最隐蔽：revision 读不出来 ⇒ 退化成 0 ⇒ 多会话保护**静默失效**，
      //   而没有任何一处会报错。
      const mw = writeFileAtomic(path.join(root, MANIFEST_REL), JSON.stringify(manifest, null, 2) + "\n");
      if (mw.ok !== true) {
        throw fail(
          `ledger_init: 写清单失败 —— 文件已建好但**没有登记**，请修好权限后重试：${mw.reason ?? "未知"}`,
        );
      }

      // ── 纳入 Git 追踪（只 add 明确路径，绝不 -A）──────────────────────────
      // ★ V3/D290：**走唯一闸门** —— `staged: true` 只有真进过暂存区才为真。
      //   旧写法 `staged = r.ok ? true : …` 会在"全部被 ignore 挡住"时谎报成功。
      let staged;
      let staging;
      if (manifest.autoGitAdd && fs.existsSync(path.join(root, ".git"))) {
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
                howToUpgrade:
                  "卡片化三目录要在 ledger_init 时用 decisionsDir / lessonsDir / goalsDir 传入" +
                  "（只对**新项目**成立）。若这是**已有单文件内容的老项目**，" +
                  "先 ledger_migrate 按卡切分，再登记目录键 —— " +
                  "直接登记空目录会让旧文件里的内容从视野里消失（D272）。",
              }),
        },
        manifestPath: path.join(root, MANIFEST_REL),
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

export function defineConformTool() {
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

export function defineReadTool() {
  return {
    name: "ledger_read",
    description:
      "Read a project ledger file. target \"active\" reads the active ledger, \"decisions\" the " +
      "long-lived decisions record, \"manifest\" the pointer manifest, and \"archive\" lists the " +
      "archive directory (or reads one archive file when archiveFile is given). Read-only. " +
      "★★★ IMPORTANT: a long file (e.g. DECISIONS.md, 474K chars) EXCEEDS the single-read limit, " +
      "so the bare read returns only the beginning. For any file that may be long, pass `entry` " +
      "to fetch ONE entry in full — `entry:\"D195\"` (decision), `\"L1\"`/`\"E7\"` (lesson/experience), " +
      "`\"g4\"` (goal card), or a section-title keyword. Never try to read such a file whole: " +
      "read the returned `toc` (one line per entry) and then fetch the entries you need.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        target: {
          type: "string",
          enum: ["active", "decisions", "principles", "journal", "goals", "lessons", "manifest", "archive"],
          description:
            "Which part of the ledger to read. ★ \"journal\" is the append-only turn journal " +
            "(dated per-session history — read it when you need to look up what happened earlier). " +
            "★ \"goals\"/\"lessons\" read the goal tree / lessons file here too, so `ledger_read` " +
            "covers EVERY memory file (one place to look, instead of guessing which tool reads what).",
        },
        entry: {
          type: "string",
          description:
            "★ Fetch ONE entry by its key instead of reading the file from the top. Accepts " +
            "`D<n>` (decision, e.g. \"D195\"), `L<n>`/`E<n>` (lesson/experience), `g<n>` (goal card), " +
            "or a section-title keyword. Returns that entry's full text plus its line range. " +
            "This is the correct way to resolve a reference like «see D195».",
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
        // ★ V3（D289）：归档目录与归档文件都是**记忆** ⇒ 基准 `memoryBase`。
        const mBase = memoryBaseOf(info, root);
        const dir = path.resolve(mBase, info.archiveRel);
        if (!isUnder(mBase, dir)) throw fail("ledger_read: 归档目录逃出了项目根");

        // ★ D138：两个可调上限（读长 + 列表条数）—— 面板改了必须真生效。
        const arcMax = numOf("maxReadChars", MAX_READ_CHARS);
        const arcListMax = numOf("maxArchiveList", MAX_ARCHIVE_LIST);

        const rel = typeof args?.archiveFile === "string" ? args.archiveFile.trim() : "";
        if (rel !== "") {
          const file = path.resolve(mBase, rel);
          if (!isUnder(mBase, file)) throw fail(`ledger_read: 归档文件逃出了项目根：${rel}`);
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

      // ★★★★★ 2026-10-14（D203）：**卡片模式下的"整份读"** ----------------
      //   ★★★ 病：`relPath` 取自 `info.decisionsRel` —— 而迁移后那个文件是**快照**。
      //     若这里仍读它，模型会拿到一份**冻结的历史**并当成现状（比读不到更危险）。
      //   ⇒ 判据：**读的地方和写的地方必须问同一个 `cardModeOf`**。
      //   ★ 形态：卡片模式 ⇒ 拼出一个"虚拟整份"（顺序由 `listCards` 保证：`D2` 在 `D10` 前），
      //     并在返回里如实标注 `mode:"card"` + 目录 —— 让模型知道这是拼出来的视图。
      const readKind =
        target === "decisions" ? "decisions" : target === "lessons" ? "lessons" : target === "goals" ? "goals" : undefined;
      const cMode = readKind === undefined ? { card: false } : cardModeOf(info, readKind);
      const cardWhole = readKind !== undefined && cMode.card === true ? readKindRaw(root, info, readKind) : undefined;

      const relPath =
        target === "decisions"
          ? info.decisionsRel
          : target === "journal"
            ? info.journalRel
            : target === "principles"
              ? info.principlesRel
              // ★ 2026-10-14（D201）：`ledger_read` **覆盖全部记忆文件** ——
              //   原来 goals/lessons 只能各走自己的工具 ⇒ 模型遇到"想查某条教训"
              //   要先决定"用哪个工具读"（那是**多一处要猜的地方**）。
              //   ★ 判据（D201 用户要的"提高召回率"）：**读的地方要统一** ——
              //     一处找得到，就少一次"想不起来该去哪查"。
              : target === "goals"
                ? info.goalsRel
                : target === "lessons"
                  ? info.lessonsRel
                  : info.activeRel;
      if (cardWhole === undefined && relPath === undefined) {
        return { ok: true, target, found: false, reason: "no such ledger file is registered" };
      }
      // ★ V3（D289）：读的目标是**记忆** ⇒ 基准 `memoryBase`（卡片目录那把也同一套）。
      const mBaseR = memoryBaseOf(info, root);
      const abs = cardWhole !== undefined ? cardDirAbs(mBaseR, cMode.dirRel) : path.resolve(mBaseR, relPath);
      if (!isUnder(mBaseR, abs)) throw fail("ledger_read: 目标逃出了项目根");
      const fileMax = numOf("maxReadChars", MAX_READ_CHARS);
      // ★ 卡片模式：`raw` = 拼出来的整份（按文件名序）；单文件模式：老实读那个文件。
      const raw = cardWhole !== undefined ? cardWhole.raw : readTextSafe(abs);
      if (raw === undefined) return { ok: true, target, found: false, path: abs };

      // ★★★★★ 2026-10-14（D201，用户拍板"提高召回率"）：**按条目取**（entry-level read）。
      //
      //  ★★★ 为什么必须做（实测，`tools/_probe-d201-recall-gap.mjs`）：
      //    · `DECISIONS.md` 474,180 字符，而一次读取上限 60,000 ⇒ **只够到 12.7%**；
      //    · ★★★ **台账引用 44 个 D 号，够得到的只有 2 个（D1、D41）** ——
      //      **95% 的引用取不回来**。而"见 D195"这种引用**不需要任何模糊匹配**
      //      （D195 就是 D195）⇒ 缺的是**取回能力**，不是**匹配能力**。
      //  ★★ 为什么用"语义切片"而不是"字节偏移"：
      //     模型的思考单位是**决策 / 教训 / 目标卡 / 小节**，不是"第 1728 行"。
      //     让模型去算偏移量 = 把本该插件做的事推给它（且它算不准）。
      //  ★ 形态：`entry: "D195"` ⇒ 只返回那一条的**完整正文**（到下一个同级标题为止）。
      //     也支持 `"L1"` / `"E7"`（经验教训）· `"g4"`（目标卡）· 以及小节名/关键字。
      const entry = typeof args?.entry === "string" ? args.entry.trim() : "";
      if (entry !== "") {
        // ★★★★★ 2026-10-14（D202）：**卡片模式优先**（用户拍板"一卡一文件"）。
        //   ★ 三类（decisions / lessons / goals）统一走 `readEntryUnified` ——
        //     它在卡片模式下**直接开那个小文件**（不再把 474K 读进内存再切）。
        const kind = target === "decisions" ? "decisions" : target === "lessons" ? "lessons" : target === "goals" ? "goals" : undefined;
        if (kind !== undefined) {
          const r = readEntryUnified(root, info, kind, entry);
          if (r.found === true) {
            // ★★★★★★ 2026-10-14（D203 · 真机撞出的第 4 个缺陷）：**绝不许把 `undefined` 放进返回值**。
            //   ★ 病（一字不差就是 D188 ① 那个病）：这里原来写 `totalLines: undefined` ——
            //     内核在把返回值 JSON 化时会**丢掉这个键**，然后判定"value is not lossless JSON"
            //     ⇒ **整个调用被拒收**（而卡片其实已经读到了，模型什么也拿不到）。
            //   ★★ 为什么自检抓不到它：自检直接调 `tool.execute()`，**不经过内核的序列化那道**——
            //     它只看返回对象，`undefined` 那个键在 JS 里是可读的。
            //     ⇒ ★ 判据：**"能被内核序列化"是独立的验收面**，只有真机能验。
            //   ★ 修法：**不写这个键**（而不是写 `undefined`）—— 卡片模式下本来就没有"整份行数"。
            return { ...r, target, revision: manifestRevision(info.manifest) };
          }
          // ★ 没找到也**如实回报**（含目录）—— 绝不许硬凑一条相近的（那是制造假记忆）。
          return { ...r, target, revision: manifestRevision(info.manifest) };
        }
        const seg = sliceEntryByKey(raw, entry);
        if (seg === undefined) {
          return {
            ok: true,
            target,
            found: false,
            path: abs,
            relative: relPath,
            lines: countLines(raw),
            chars: raw.length,
            entry,
            reason:
              `没有找到条目「${entry}」。★ 本工具按「条目」切片，认这些形状：` +
              "`D<n>`（决策）· `L<n>`/`E<n>`（教训/经验）· `g<n>`（目标卡）· 或某段小标题的名字。",
            // ★ 找不到时**给一张目录**（只列标题行）—— 比让模型自己猜关键词有用得多，
            //   而且它**很小**（每条一行）。
            toc: entryTocOf(raw),
          };
        }
        return {
          ok: true,
          target,
          found: true,
          path: abs,
          relative: relPath,
          entry,
          heading: seg.heading,
          startLine: seg.startLine,
          endLine: seg.endLine,
          chars: seg.text.length,
          text: seg.text,
          // ★ 条目可能很长（本项目有超长条目），仍按上限截断**但如实标注**。
          truncated: seg.text.length > fileMax,
          ...(seg.text.length > fileMax ? { text: seg.text.slice(0, fileMax) } : {}),
          totalLines: countLines(raw),
          revision: manifestRevision(info.manifest),
        };
      }

      return {
        ok: true,
        target,
        found: true,
        path: abs,
        relative: cardWhole !== undefined ? cMode.dirRel : relPath,
        // ★ D203：卡片模式下**如实标注**这是拼出来的视图（不是某个文件）。
        ...(cardWhole !== undefined
          ? {
              mode: "card",
              dir: cMode.dirRel,
              cardCount: cardWhole.cardCount,
              note:
                `★ 这一类是**卡片模式** ⇒ 上面这份是插件按文件名序**拼出来的视图**（${cardWhole.cardCount} 张卡），` +
                `不是某个文件的内容。要**单条**取用 \`entry\`（如 \`entry:"D195"\`）—— 那才是卡片化真正省的地方。`,
            }
          : {}),
        lines: countLines(raw),
        chars: raw.length,
        text: raw.length > fileMax ? raw.slice(0, fileMax) : raw,
        truncated: raw.length > fileMax,
        // ★★ 截断时**不要把模型丢在黑暗里**：给一条"怎么取到其余部分"的指路 +
        //    一张小目录（每条一行）—— 这正是 D79 说的"小索引 + 按需翻页"。
        ...(raw.length > fileMax
          ? {
              hint:
                `★ 这份文件 ${raw.length} 字符，**超过单次读取上限 ${fileMax}** ⇒ 上面只是开头一部分。` +
                "要继续读：**用 `entry` 按条目取**（如 `entry:\"D195\"`），比读整份更省、也更准。" +
                "下面是它的目录（只列标题行）。",
              toc: entryTocOf(raw),
            }
          : {}),
        // ★ 多会话用：把当前修订号一起给出去，写台账时当 `ifRevision` 传回来，
        //   插件就能判断"你手里这份是不是最新的"，从而决定要不要替你保住别人的条目。
        revision: manifestRevision(info.manifest),
      };
    },
  };
}

/**
 * ★★★★★ 2026-10-14（D201，用户拍板"提高召回率"）：**按条目取正文**（entry-level read）。
 *
 * ★★★ 病（实测 `tools/_probe-d201-recall-gap.mjs`）：
 *   `DECISIONS.md` 474,180 字符 / 13,577 行，而一次读取上限 60,000 字符
 *   ⇒ **只够到 12.7%**；而**台账引用的 44 个 D 号里，够得到的只有 2 个**。
 *   ★ 关键：那些引用写的是 `见 D195` —— **它是精确的，不需要任何模糊匹配**。
 *     缺的是**取回能力**。⇒ 所以本函数按**语义单位**切片，不按字节偏移。
 *
 * ★★ 认的形状（按此顺序判，先具体后笼统）：
 *   ① `D<n>`     ⇒ `## D<n> · …` 那一条（本项目决策的固定形状）
 *   ② `L<n>`/`E<n>` ⇒ `## 教训 L<n> · …` / `## 经验 E<n> · …`（经验教训的固定形状）
 *   ③ `g<n>`     ⇒ `## 目标 <id> · …` 那张卡（目标树）
 *   ④ 其它字符串 ⇒ 当作**小标题关键字**（匹配 `## …` 里含它的那一段）
 *
 * ★ 边界：从命中标题的**下一行**起，到**下一个同级或更高级标题**为止
 *   （`##` 对 `##`；`###` 对 `##`/`###`）—— 这样"取 D195"不会把 D196 也带进来。
 * ★ 找不到 ⇒ 返回 `undefined`（调用方**如实报** + 给目录，**绝不猜一条相近的**）。
 */

export function sliceEntryByKey(raw, key) {
  const src = typeof raw === "string" ? raw : "";
  const lines = src.split(/\r?\n/);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ── 先定"要找哪种标题"（顺序：决策 → 经验/教训 → 目标卡 → 泛化关键字）──────
  let matcher;
  const mD = /^D(\d+)$/i.exec(key);
  const mL = /^([LE])(\d+)$/i.exec(key);
  const mG = /^g([A-Za-z0-9._-]+)$/i.exec(key);
  if (mD !== null) {
    // ★ 用 `(?![\dA-Za-z])` 而不是 `\b` —— `\b` 在中文后不匹配（本文件栽过多次，见 L1/情形 86）。
    matcher = new RegExp(`^##\\s*D${esc(mD[1])}(?![\\dA-Za-z])`);
  } else if (mL !== null) {
    const word = mL[1].toUpperCase() === "L" ? "教训" : "经验";
    matcher = new RegExp(`^##\\s*${word}\\s+${mL[1]}${esc(mL[2])}(?![\\dA-Za-z])`, "i");
  } else if (mG !== null) {
    // ★★ 这里我**当场写错过一次，必须留档**：第一版用 `mG[1]`，而正则的捕获组是
    //   `/^g([A-Za-z0-9._-]+)$/` ⇒ 对 "g1" 它捕获的是 **"1"**（**"g" 被吃在组外**）
    //   ⇒ 拼出来是 `^##\s*目标\s+1` ⇒ **一个都匹配不到**（真形状是 `## 目标 g1 · …`）。
    //   ⇒ 正解：**用整个 key**（`esc(key)`），不要用那个"看起来更干净"的捕获组。
    //   ★ 判据：**凡是"用捕获组拼回一个键"，都要拿真键回读一遍**（组里少了前缀这种错，
    //     代码读起来完全正常 —— 与 L1 的 `\b` 同属"看起来对、其实永不匹配"那一类）。
    matcher = new RegExp(`^##\\s*目标\\s+${esc(key)}(?![A-Za-z0-9._-])`);
  } else {
    matcher = new RegExp(`^#{2,4}\\s*.*${esc(key)}`);
  }

  const start = lines.findIndex((l) => matcher.test(l));
  if (start < 0) return undefined;
  const level = (/^(#{2,4})/.exec(lines[start])?.[1] ?? "##").length;
  // ── 向后找到"下一个同级或更高级标题"为止 ──────────────────────────────
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const hm = /^(#{2,4})\s/.exec(lines[i]);
    if (hm !== null && hm[1].length <= level) { end = i; break; }
  }
  const text = lines.slice(start, end).join("\n").replace(/\s+$/, "");
  return { heading: lines[start].trim(), startLine: start + 1, endLine: end, text };
}

/**
 * ★★★ 2026-10-14（D201）：给一份长文件生成**只列标题行**的小目录。
 *
 * ★ 用途有两个，都是"别让模型在黑暗里"：
 *   ① 读取被截断时 ⇒ 告诉它"其余部分在哪、怎么按需取"（D79：小索引 + 按需翻页）；
 *   ② `entry` 没命中时 ⇒ 给一张目录让它挑，**比让它猜关键词有用**。
 * ★ 有界：最多 `limit` 行（超出如实说"还有 N 条"）—— 目录也可能很长。
 */

export function entryTocOf(raw, limit = 120) {
  const lines = (typeof raw === "string" ? raw : "").split(/\r?\n/);
  const heads = [];
  for (const l of lines) {
    if (/^#{2,4}\s/.test(l)) heads.push(l.trim());
    if (heads.length > limit) break;
  }
  const all = lines.filter((l) => /^#{2,4}\s/.test(l)).length;
  return {
    count: all,
    shown: Math.min(heads.length, limit),
    entries: heads.slice(0, limit),
    ...(all > limit ? { more: `另有 ${all - limit} 条未列出` } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★★★ 2026-10-14（D202，用户拍板）：**卡片化** —— 一卡一文件
// ═══════════════════════════════════════════════════════════════════════════
//
//  用户原话（逐字）：*"所以这就是我的想法，也是我一开始提出来的，所有的台账类别全部变成文件夹，
//  然后各种内容变成卡片类和区块化。一个卡片或者两个卡片组成一个文字。"*
//  + *"问题是实现之后他们就是一整个文件，导致模型有时候很难读取，特别是内容最大的那一些。
//     上面你提出的那几个问题也是因此出现的。"*
//
// ★★★ **病因与症状（措辞很重要，别搞反）**：
//   · **病因**：内容全在**一整个文件**里 ⇒ `DECISIONS.md` 474K 字符；
//   · **症状**（D201 量到的那些，都是"读不动"的后果）：一次读取 87% 够不到 ·
//     台账引用 44 个 D 号只取得到 2 个 · 检索面糊。
//   ⇒ D201 的 `entry` 切片是**给大文件打补丁**（让 44/44 取得到），
//     而**卡片化才是治本**：根本没有"那个大文件"。
//
// ★★ 方向**不是新的** —— 它就是 **D133**（用户 2026-10-12 定的「记忆区块」）：
//   *"把这些全部视为卡片，我们的内容是一大堆卡片，活跃卡片，决策卡片，归档卡片等"*；
//   而机制侧 **D136 早就实现**（`splitBlocks`/`weightBlocks`/`renderBlockInjection`，默认关）。
//
// ★★★ 设计要点（三条，都是为了让改动**尽量不动解析器**）：
//   ① **卡片文件里就是原来那一段原文**（含 `## D195 · …` 标题）⇒
//      `parseGoalCards` / `parseLessonEntries` / `sliceEntryByKey` **全都不用改** ——
//      卡片化是**存储布局**的改变，不是**格式**的改变。★ 迁移因此也只是"切开"。
//   ② **文件名就是地址**（`D195.md`）⇒ 不再依赖"文件内格式"才能定位。
//      这正是卡片化**唯一**能给、而 `entry` 给不了的那条硬收益（见 `_probe-d202-cards-cost`）。
//   ③ **必常驻的那层不卡片化**（用户拍板）：`LEDGER.md` 每回合注入，按 D46 铁律
//      「恢复必须是**推**给模型的，不能是等它来查」⇒ 它变成文件夹就等于放弃必达。
//
// ★★★★ **安全边界（本层最要紧的一条）**：`key` 会**变成文件名** ⇒ 必须挡住路径穿越。
//   判据：`key` 只允许 `[A-Za-z0-9._-]`，且**不许**是 `.`/`..`/以 `..` 开头。
//   ★ 与 `ledger_goals` 的 id 校验**同一套**（那里已验过），此处**逐条照搬**，
//     并在情形 88 里**用真的穿越串打一遍**（`../../x`、`a/b`、`..`）。

/** 卡片键的**白名单**（唯一的合法性出口 —— 所有读写都必须过它）。 */

export function isSafeCardKey(key) {
  if (typeof key !== "string") return false;
  const k = key.trim();
  if (k === "" || k === "." || k === "..") return false;
  if (!/^[A-Za-z0-9._-]+$/.test(k)) return false; // ★ 路径分隔符、空格、引号一律不许
  if (k.startsWith("..")) return false;           // ★ 双保险（`..x` 也挡住）
  // ★ 不许以 `.md` 结尾 ⇒ 否则会生成 `D1.md.md`（不危险，但会让人困惑；
  //   而且"键"与"文件名"就不再是同一件事了 —— 卡片化要的正是这个一致性）。
  if (/\.md$/i.test(k)) return false;
  return true;
}

/**
 * 卡片目录的**绝对路径**。
 *
 * ★★★★★ 2026-10-18（D267 · 修 review v1.2.7 的 F02）：**这里必须自己再查一次边界**。
 *
 * 🔴 病（review 实测）：原注释写"调用方保证 rel 已登记且 isUnder 过"——
 *   而 `cardFileAbs` 只检查**生成的文件在卡片目录内**，**从来没检查卡片目录本身在项目内**。
 *   复现：清单里写 `"decisionsDir": "../outside-cards"` ⇒ 普通
 *   `ledger_write({target:'decisions'})` 就在**项目的兄弟目录**生成了 `outside-cards/D1.md`，
 *   还返回 `ok:true`。
 *
 * ★ 为什么"清单加载时校验过"不算数（review 那句很关键）：
 *   清单可能来自**手工编辑 / 仓库拉取 / 旧版本**。不能因为"正常初始化路径可能拦过"
 *   就把清单当成可信输入。⇒ **判据放在最终出口**，每一次读写都过。
 *
 * ★ 为什么返回 `path.resolve(...)` 而不是抛：这个函数被十几处调用（读、写、删、列目录），
 *   抛异常会让"列目录"这种只读操作也崩。⇒ 保留原签名，边界检查由
 *   `cardDirIsSafe` 承担，真正需要拦的地方（写/删）调它。
 */

export function cardDirAbs(root, dirRel) {
  return path.resolve(root, dirRel);
}

/**
 * ★ 卡片目录是否真的在项目内（词法 + 真实路径两道）。
 * @returns {{ok:boolean, why?:string}}
 */

export function cardDirIsSafe(root, dirRel) {
  if (typeof dirRel !== "string" || dirRel.trim() === "") {
    return { ok: false, why: "卡片目录名是空的" };
  }
  if (path.isAbsolute(dirRel)) {
    return { ok: false, why: `卡片目录必须是**相对路径**，不能用绝对路径：${dirRel}` };
  }
  const r = isUnderReal(root, cardDirAbs(root, dirRel));
  if (r.ok !== true) return { ok: false, why: r.why };
  return { ok: true };
}

/** 一张卡的绝对路径（**先过白名单**，非法返回 undefined）。 */

export function cardFileAbs(root, dirRel, key) {
  if (!isSafeCardKey(key)) return undefined;
  const abs = path.resolve(cardDirAbs(root, dirRel), `${key.trim()}.md`);
  // ★ 第三道：即使白名单被绕过，也要求结果**仍在目录内**（纵深防御）。
  if (!isUnder(cardDirAbs(root, dirRel), abs)) return undefined;
  return abs;
}

/** 列出卡片目录里的全部卡（按**数字后缀**排序 ⇒ `D2` 排在 `D10` 前，不靠字典序）。 */

export function listCards(root, dirRel) {
  const dir = cardDirAbs(root, dirRel);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    // ★★★ 必须**排除索引表自己**（`INDEX.md`）—— 否则它会被当成一张"卡"出现在目录里
    //   （实测：`toc` 报出 4 张，其中一张叫 `INDEX`）。★ 索引是**派生物**，不是内容。
    if (/^INDEX\.md$/i.test(e.name)) continue;
    const key = e.name.slice(0, -3);
    if (!isSafeCardKey(key)) continue; // ★ 目录里混进怪名字 ⇒ 跳过（不猜）
    let chars = 0;
    try {
      chars = fs.readFileSync(path.join(dir, e.name), "utf8").length;
    } catch {
      /* 读不到就是 0 —— 不因为一张坏卡而让整个目录列不出来 */
    }
    out.push({ key, chars });
  }
  // ★ 数字后缀排序：`D2` < `D10`（字典序会反过来）—— 与 `entryTocOf` 的"给人读"口径一致。
  return out.sort((a, b) => {
    const na = Number((/(\d+)$/.exec(a.key) ?? [])[1] ?? NaN);
    const nb = Number((/(\d+)$/.exec(b.key) ?? [])[1] ?? NaN);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.key.localeCompare(b.key);
  });
}

/** 读一张卡（返回**原文**；不存在返回 undefined）。 */

export function readCard(root, dirRel, key) {
  const abs = cardFileAbs(root, dirRel, key);
  if (abs === undefined) return undefined;
  return readTextSafe(abs);
}

/** 写一张卡（**原子写**：先写临时文件再 rename —— 与 `upsertGoalCard` 同一套做法）。 */

export function writeCard(root, dirRel, key, text) {
  const abs = cardFileAbs(root, dirRel, key);
  if (abs === undefined) return { ok: false, reason: `卡片键不合法（只允许字母数字与 . _ -）：${key}` };
  // ★ D267（review F02）：**写之前查一次卡片目录本身在不在项目内**。
  //   原来这里只查了"文件在目录内"，而目录可以来自清单里的 `../outside-cards`。
  const safe = cardDirIsSafe(root, dirRel);
  if (safe.ok !== true) {
    return {
      ok: false,
      reason: `卡片目录 \`${dirRel}\` 不安全，一个字节都没写：${safe.why}`,
      unsafeCardDir: true,
    };
  }
  const w = writeFileAtomic(abs, text);
  if (w.ok !== true) return { ok: false, reason: `写卡片 ${key} 失败：${w.reason}`, atomic: true };
  return { ok: true, path: abs, relative: toGitRel(root, abs) };
}

/** 删一张卡（**只在确有该卡时**删；返回是否删掉了）。 */

export function removeCard(root, dirRel, key) {
  const abs = cardFileAbs(root, dirRel, key);
  if (abs === undefined || !fs.existsSync(abs)) return false;
  // ★ D267（review F02/F03）：**删也必须过边界** —— 越界删比越界写更不可逆。
  if (cardDirIsSafe(root, dirRel).ok !== true) return false;
  fs.unlinkSync(abs);
  return true;
}

/**
 * ★★★ 卡片目录的**目录**（每卡一行：`D195 · 标题`）—— 这是"小索引"，**可以推行**。
 *
 * ★ 与 `entryTocOf` 的区别：那个是**现读大文件、现切标题行**（474K 要先进内存）；
 *   这个是**念目录**（`readdir` + 每卡读首行）。★ 卡片化的性能收益主要就在这里。
 * ★ 有界：最多 `limit` 行（超出如实说还有多少）。
 */

export function renderCardToc(root, dirRel, limit = 120, label = "卡片") {
  const cards = listCards(root, dirRel);
  const shown = cards.slice(0, limit);
  const lines = shown.map((c) => {
    const text = readCard(root, dirRel, c.key) ?? "";
    const title = (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").replace(/^#+\s*/, "").trim();
    return { key: c.key, title, chars: c.chars };
  });
  return {
    dir: dirRel,
    count: cards.length,
    shown: lines.length,
    cards: lines,
    ...(cards.length > limit ? { more: `另有 ${cards.length - limit} 张未列出` } : {}),
    label,
  };
}

/**
 * ★★★★★ 2026-10-14（D202，用户拍板）：**每个卡片文件夹里放一张索引表**。
 *
 * 用户原话（逐字）：*"而且最好也在每个文件夹里面有一张索引表，
 * 这张索引表是用来按之前搞的那多重维度分区块的。"*
 *
 * ★★★ **"之前搞的那多重维度"就是 D136 的 `weightBlocks`** —— 我不另造一套，
 *   直接把每张卡当成一个**块**喂给它（卡片天然是块：有标题、有正文、有哈希）。
 *   ⇒ 四维融合原样复用：**模型判分(3.0) · 时间(1.5) · 稳定(0.8) · 星值(1.0)**。
 *
 * ★★ **三种用法、各读哪一份**（这条定死，避免"两处算分必然分叉"）：
 *   · **注入里推行**（每回合）⇒ **现算**（`renderCardIndex`）—— 因为注入要的是"此刻的排序"，
 *     而它是**纯函数**、几毫秒，且**不依赖任何文件存在**（静态索引会过期）；
 *   · **人用 / 索引文件**（`INDEX.md`）⇒ **落盘**那份，带时间戳，供人翻、供 grep；
 *   · **`ledger_read` 的目录**⇒ 现算的**轻量版**（只要 key+标题，**不跑打分**，
 *     因为"取某一类卡"不需要权重排序，跑打分反而慢）。
 *
 * ★ 判据：**落盘的 `INDEX.md` 永远只是缓存** —— 插件**从不读它来做决定**
 *   （它可能过期/被手改）。这与本项目那条"派生物不当权威"一致。
 */

export function buildCardBlocks(root, dirRel) {
  return listCards(root, dirRel).map((c) => {
    const text = readCard(root, dirRel, c.key) ?? "";
    const heading = (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").replace(/^#+\s*/, "").trim();
    return {
      key: c.key,
      heading,
      hash: fnv1a(text),
      lines: text === "" ? 0 : text.split(/\r?\n/).length,
      text,
      chars: text.length,
    };
  });
}

/**
 * ★ 渲染那张**多维索引表**（供落盘 `INDEX.md` 与人读）。
 *
 * @param {object} opts `{ modelAnswers, histByHash, nowMs, limit }`
 *   ★ `modelAnswers` / `histByHash` 由**调用方**给（`state` 只在调用方可见）——
 *     渲染层刻意不碰 state（本文件一贯的分层）。
 */

export function renderCardIndex(root, dirRel, opts) {
  const blocks = buildCardBlocks(root, dirRel);
  if (blocks.length === 0) return { ok: true, count: 0, markdown: "", rows: [] };
  const weighted = weightBlocks(blocks, opts?.modelAnswers, opts?.histByHash, opts?.nowMs);
  // ★ 按融合分**降序**（最该先看的在前）—— 这就是"相对位置"的落地。
  const rows = weighted
    .map((w) => ({
      key: w.key,
      heading: w.heading ?? w.key,
      lines: w.lines,
      chars: w.chars,
      hash: w.hash,
      score: Math.round(w.weight?.score ?? 0),
      why: (w.weight?.why ?? []).join("；"),
    }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const limit = Number.isFinite(opts?.limit) ? opts.limit : 200;
  const shown = rows.slice(0, limit);
  const md = [
    `| 卡 | 标题 | 行 | 分 | 为什么这个位置 |`,
    `|---|---|---|---|---|`,
    ...shown.map((r) => `| \`${r.key}\` | ${r.heading.replace(/\|/g, "/").slice(0, 60)} | ${r.lines} | **${r.score}** | ${r.why.replace(/\|/g, "/")} |`),
    ...(rows.length > limit ? [`| … | 另有 ${rows.length - limit} 张未列出 | | | |`] : []),
  ].join("\n");
  return { ok: true, count: rows.length, shown: shown.length, markdown: md, rows };
}

/**
 * 把索引表**落盘**成 `<dir>/INDEX.md`（带时间戳；**永远只是缓存**）。
 * ★ 写在 `cards` **之后**、登记清单**之前** —— 这样"索引"绝不会先于内容存在。
 */

export function writeCardIndex(root, dirRel, label, extra) {
  const r = renderCardIndex(root, dirRel, extra);
  if (r.count === 0) return { ok: false, reason: "没有卡片可索引。" };
  const md =
    `# 索引 · ${label}\n\n` +
    `> ★ 这张表由插件在**每次写卡后**自动重算（当前 ${stamp(new Date())}）。\n` +
    "> ★★ **它只是缓存**：插件从*不读它*来做决定（它可能过期、可能被你手改）——\n" +
    "> 权威永远是**卡片文件本身**；要最新排序就用 `ledger_index` 重算或`ledger_read` 现算。\n" +
    "> ★ 打分维度 = **模型判分 3.0 · 时间 1.5 · 稳定 0.8 · 星值 1.0**（D136 的四维秩融合，\n" +
    "> 相对位置 ⇒ 同一张卡在别的目录里分数可能不同，那是**故意的**）。\n\n" +
    r.markdown +
    "\n";
  const abs = path.resolve(cardDirAbs(root, dirRel), "INDEX.md");
  if (!isUnder(cardDirAbs(root, dirRel), abs)) return { ok: false, reason: "索引路径逃出目录" };
  ensureDir(path.dirname(abs));
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, md, "utf8");
  fs.renameSync(tmp, abs);
  return { ok: true, path: abs, count: r.count, shown: r.shown };
}

// ═══════════════════════════════════════════════════════════════════════════
// 卡片层的**读写入口**（双模式：卡片目录 或 单文件 —— 后者是既有项目，必须继续支持）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 取某类记忆的**存储形态**：卡片目录优先，否则单文件。
 *
 * ★ 判据：**`manifest.<kind>Dir` 有没有登记**。登记了 ⇒ 卡片模式。
 * ★★ 为什么不做"自动探测"（目录存在就是卡片模式）：**猜测是本次会话碰巧成立**的推断，
 *   而 `inspect` 里已有同一条教训（`decisionsSource === "guess"` 被判成不合规）——
 *   登记过的才可靠。⇒ 迁移由一个**显式动作**（`ledger_migrate` + 用户确认）完成。
 */

export function cardModeOf(info, kind) {
  const dirRel =
    kind === "decisions" ? info.decisionsDir : kind === "lessons" ? info.lessonsDir : info.goalsDir;
  if (typeof dirRel !== "string" || dirRel === "") return { card: false, fileRel: kindToRel(info, kind) };
  return { card: true, dirRel };
}

/** `kind` ⇒ 单文件模式下它的相对路径（卡片模式下作为**迁移来源**）。 */

export function kindToRel(info, kind) {
  return kind === "decisions" ? info.decisionsRel : kind === "lessons" ? info.lessonsRel : info.goalsRel;
}

/**
 * ★★★★★ 统一读一"条"（卡片模式与单文件模式**同一个返回形状**）。
 *
 * @returns {{ok:boolean, found:boolean, text?:string, heading?:string, fromCard?:boolean, ...}}
 */

export function readEntryUnified(root, info, kind, entry) {
  const mode = cardModeOf(info, kind);
  if (mode.card) {
    const text = readCard(root, mode.dirRel, entry);
    if (text === undefined) {
      return {
        ok: true, found: false, entry, mode: "card",
        dir: mode.dirRel,
        reason: `卡片目录 \`${mode.dirRel}\` 里没有「${entry}」这张卡。`,
        toc: renderCardToc(root, mode.dirRel, 120, kind),
      };
    }
    const heading = (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").replace(/^#+\s*/, "").trim();
    return {
      ok: true, found: true, entry, mode: "card", fromCard: true,
      dir: mode.dirRel,
      path: cardFileAbs(root, mode.dirRel, entry),
      heading,
      chars: text.length,
      text,
    };
  }
  // ── 单文件模式：走已有的 `entry` 切片 ──────────────────────────────────
  const rel = mode.fileRel;
  if (rel === undefined) return { ok: true, found: false, entry, reason: "这一类记忆没有登记（既无目录也无文件）" };
  // ★ V3（D289）：单文件也是**记忆** ⇒ 基准 `memoryBase`。
  const mBaseE = memoryBaseOf(info, root);
  const abs = path.resolve(mBaseE, rel);
  if (!isUnder(mBaseE, abs)) return { ok: true, found: false, entry, reason: "路径逃出项目根" };
  const raw = readTextSafe(abs);
  if (raw === undefined) return { ok: true, found: false, entry, reason: `文件读不到：${rel}` };
  const seg = sliceEntryByKey(raw, entry);
  if (seg === undefined) {
    return {
      ok: true, found: false, entry, mode: "file", relative: rel,
      reason: `没有找到条目「${entry}」。★ 认：\`D<n>\` · \`L<n>\`/\`E<n>\` · \`g<n>\` · 或小标题关键字。`,
      toc: entryTocOf(raw),
    };
  }
  return {
    ok: true, found: true, entry, mode: "file",
    path: abs, relative: rel, heading: seg.heading,
    startLine: seg.startLine, endLine: seg.endLine,
    chars: seg.text.length, text: seg.text,
  };
}

/** 卡片目录的**人读标签**（`INDEX.md` 标题、提示文案共用一处）。 */

export function cardDirLabel(kind) {
  return kind === "decisions" ? "关键决策" : kind === "lessons" ? "经验与教训" : "目标树";
}

/**
 * ★★★★★ 2026-10-14（D203）：**把"这一类记忆"整份读出来**（卡片模式下 = 虚拟整份）。
 *
 * ★★★ 为什么必须有它（**这正是"迁移会造出两份真源"那个缺口的正面修法**）：
 *   卡片化只是**存储布局**变了，而解析器（`parseGoalCards` / `parseLessonEntries` /
 *   `sliceEntryByKey`）全都吃"一整份文本"。若读侧仍去读**那个留在盘上的旧文件**，
 *   迁移后就会变成：**卡片是新真源、旧文件是快照，而读的人拿的是快照** ——
 *   模型会读到一份**冻结的历史**，还以为那是现状（比"读不到"更危险）。
 *   ⇒ 判据：**凡是"整份读"的地方，都必须问一句"这一类现在住在哪"**。
 *
 * ★ 形态：卡片模式 ⇒ 按**文件名序**把每张卡拼起来（`listCards` 已按数字后缀排序，
 *   所以 `D2` 在 `D10` 前）；单文件模式 ⇒ 老实读那个文件。
 * ★ 返回 `mode` 让调用方**知道自己在哪一种**（写侧要靠它决定往哪落）。
 */

export function readKindRaw(root, info, kind) {
  const mode = cardModeOf(info, kind);
  // ★ V3（D289）：卡片目录与单文件都是**记忆** ⇒ 基准 `memoryBase`。
  //   ★ 收口在这里（而不是 30 个调用点）：`readKindRaw` / `writeKindCard` / `removeKindCard`
  //     是卡片读写的**三个总闸**，`part2.js` 里那 30 处调用全都从这里过。
  //     改 3 处 vs 改 30 处 —— 而且下次再有人加调用点时，**自动就是对的**。
  const memBase = memoryBaseOf(info, root);
  if (mode.card === true) {
    const cards = listCards(memBase, mode.dirRel);
    const chunks = [];
    for (const c of cards) {
      const t = readCard(memBase, mode.dirRel, c.key);
      if (t === undefined) continue;
      chunks.push(t.replace(/\s+$/, ""));
    }
    return {
      mode: "card",
      dirRel: mode.dirRel,
      cardCount: cards.length,
      raw: chunks.length === 0 ? "" : `${chunks.join("\n\n")}\n`,
    };
  }
  const rel = mode.fileRel;
  if (typeof rel !== "string" || rel === "") return { mode: "none", raw: "", cardCount: 0 };
  const abs = path.resolve(memBase, rel);
  if (!isUnder(memBase, abs)) return { mode: "none", raw: "", cardCount: 0 };
  return { mode: "file", rel, abs, raw: readTextSafe(abs) ?? "" };
}

/**
 * 把**一条**（决策 / 教训 / 目标卡）落到正确的位置。
 * ★ 卡片模式 ⇒ 写一个**小文件**（键就是地址）；单文件模式 ⇒ 返回 `null`，
 *   由调用方走原来那套"就地改写大文件"的路（**既有项目一行都不改**）。
 */

export function writeKindCard(root, info, kind, key, text) {
  const mode = cardModeOf(info, kind);
  if (mode.card !== true) return null;
  // ★ V3（D289）：卡片是**记忆** ⇒ 基准 `memoryBase`（收口在这里，调用方不必各自判断）。
  const memBase = memoryBaseOf(info, root);
  const r = writeCard(memBase, mode.dirRel, key, text);
  if (r.ok !== true) return { ok: false, reason: r.reason, card: key };
  // ★ 索引表跟着刷新（**只是缓存**，失败不挡写卡 —— 权威永远是卡片本身）。
  let indexed = false;
  try {
    indexed = writeCardIndex(memBase, mode.dirRel, cardDirLabel(kind), {}).ok === true;
  } catch {
    /* 索引失败不算写卡失败 */
  }
  return { ok: true, card: key, dirRel: mode.dirRel, path: r.path, indexRefreshed: indexed };
}

/** 删**一条**（卡片模式才接；单文件模式返回 `null`）。 */

export function removeKindCard(root, info, kind, key) {
  const mode = cardModeOf(info, kind);
  if (mode.card !== true) return null;
  // ★ V3（D289）：同上 —— 基准 `memoryBase`。
  const memBase = memoryBaseOf(info, root);
  const gone = removeCard(memBase, mode.dirRel, key);
  if (gone === true) {
    try {
      writeCardIndex(memBase, mode.dirRel, cardDirLabel(kind), {});
    } catch {
      /* 同上 */
    }
  }
  return { ok: true, removed: gone, card: key, dirRel: mode.dirRel };
}

/** 这一类在注入 / 契约里**该怎么被指路**（卡片模式给目录，单文件给文件）。 */

export function kindLocationOf(info, kind) {
  const mode = cardModeOf(info, kind);
  if (mode.card === true) return { card: true, rel: mode.dirRel };
  const rel = mode.fileRel;
  return typeof rel === "string" && rel !== "" ? { card: false, rel } : { card: false, rel: undefined };
}

/**
 * ★★★★★ 2026-10-14（D202，用户拍板）：**把单文件拆成卡片**（迁移本体）。
 *
 * ★★★ 安全规则（这条路径会**动用户的大文件**，所以规则定死）：
 *   ① **只切片、不改字** —— 每张卡的内容 = 原文件里那一段**逐字**（含它的 `## D195 · …` 标题）。
 *      ⇒ 判据：**所有卡片拼起来必须等于原文件**（忽略空行差异）——情形 88④ 真跑这个断言。
 *   ② **绝不删原文件** —— 原文件**原样留着**（它成为"迁移前快照"）。
 *      ★★ 为什么：万一卡片层有 bug，用户的记忆**还在**。删不删由**用户**决定（我不替他删）。
 *   ③ **先写卡、后登记清单** —— 顺序不能反：
 *      若先登记了目录、写卡却失败，项目会进入"清单说有卡片目录、目录却是空的"这种**半死**状态。
 *   ④ **不是幂等就拒** —— 目标目录已存在且非空 ⇒ **拒绝**（不覆盖、不合并）。
 *
 * @returns {{ok:boolean, dryRun:boolean, cards?:number, written?:number, dir?:string, reason?:string, verify?:object}}
 */

export function splitFileIntoCards(root, info, kind, opts) {
  const apply = opts?.apply === true;
  const mode = cardModeOf(info, kind);
  if (mode.card) {
    return { ok: false, reason: `这一类已经是卡片模式（目录：${mode.dirRel}），无需迁移。` };
  }
  const rel = mode.fileRel;
  if (typeof rel !== "string" || rel === "") {
    return { ok: false, reason: `这一类没有登记单文件，无法迁移（kind=${kind}）。` };
  }
  // ★ V3（D289）：迁移的源是**记忆** ⇒ 基准 `memoryBase`。
  const mBaseS = memoryBaseOf(info, root);
  const srcAbs = path.resolve(mBaseS, rel);
  if (!isUnder(mBaseS, srcAbs)) return { ok: false, reason: "源文件逃出项目根。" };
  const raw = readTextSafe(srcAbs);
  if (raw === undefined) return { ok: false, reason: `源文件读不到：${rel}` };

  // ── 目标目录名（默认：与源文件同级的子目录）─────────────────────────────
  const defaultDir =
    kind === "decisions" ? "decisions" : kind === "lessons" ? "lessons" : "goals";
  const dirRel = typeof opts?.dir === "string" && opts.dir.trim() !== "" ? opts.dir.trim() : defaultDir;
  // ★ V3（D289）：目标卡片目录也是**记忆** ⇒ 同一个基准 `mBaseS`。
  const dirAbs = cardDirAbs(mBaseS, dirRel);
  if (!isUnder(mBaseS, dirAbs)) return { ok: false, reason: `目标目录逃出项目根：${dirRel}` };

  // ④ 目标目录已存在且非空 ⇒ 拒绝（不覆盖、不合并）
  if (fs.existsSync(dirAbs)) {
    let n = 0;
    try { n = fs.readdirSync(dirAbs).length; } catch { n = 0; }
    if (n > 0) {
      return { ok: false, reason: `目标目录 \`${dirRel}\` 已存在且非空（${n} 项）—— 拒绝覆盖。请换一个目录名，或先人工确认。`, dir: dirRel };
    }
  }

  // ── 切片：按"条目起始行"切开（**不改字**）──────────────────────────────
  const parts = splitIntoCardParts(raw, kind);
  if (parts.length === 0) return { ok: false, reason: `按 ${kind} 的形状切不出任何卡片（文件格式可能不合预期）。` };

  // ③ 先算好全部卡片，**逐张写**，最后才登记清单
  const plan = parts.map((p) => ({
    key: p.key,
    text: p.text,
    chars: p.text.length,
    line: p.lineNo,
  }));
  const badKeys = plan.filter((c) => !isSafeCardKey(c.key)).map((c) => c.key);
  if (badKeys.length > 0) return { ok: false, reason: `有不合法的卡片键（会变成文件名）：${badKeys.join(", ")}` };
  // ★★★★★ 重复键 ⇒ **拒绝**，并把**行号**报出来（可行动），绝不静默覆盖。
  //
  //  ★★★ 为什么不是"自动加后缀"（`D189b`）：那会**掩盖一个真缺陷** ——
  //    同一个编号出现两次，说明这份记忆**自己就有重号**（本项目实测有 **2 处**：
  //    `D71` 与 `D189`），而"引用必达"那条守卫**查不出来**（它用 Set 去重，重号被吃掉）。
  //  ★ 正解有两条，都交给看得懂内容的一方：① 把后一条改成子标题 `### D189 补遗`（同一决策的续写）；
  //    ② 或把它改成另一个编号。⇒ 迁移**不替它决定**，只把证据摆出来。
  const seen = new Map();
  const dups = [];
  for (const c of plan) {
    if (seen.has(c.key)) dups.push({ key: c.key, first: seen.get(c.key), second: c.line });
    else seen.set(c.key, c.line);
  }
  if (dups.length > 0) {
    const detail = dups.map((d) => `\`${d.key}\`（第 ${d.first} 行 与 第 ${d.second} 行）`).join(" · ");
    return {
      ok: false,
      reason:
        `切片后出现**重复编号** ⇒ 拒绝写入（覆盖 = 静默丢一张卡）：${detail}\n` +
        "★★ 这是**源文件自己的缺陷**（同一编号出现两次），不是切片错 —— 而「引用必达」守卫查不出它（它去重）。\n" +
        "★ 两条修法（二选一，都很快）：\n" +
        "  ① 若后一条是**同一决策的续写** ⇒ 把它的 `## D189 · …` 改成 `### D189 补遗 · …`（降级成子标题）；\n" +
        "  ② 若它其实是另一条决策 ⇒ 给它一个**未用过**的编号。\n" +
        "改完再跑一次 `op:\"split\"`。",
      duplicates: dups,
      dir: dirRel,
    };
  }

  // ★★ 逐字校验（**写盘前**就算一遍）：**按非空行比**（空行是排版，不是内容 ——
  //   这一条我在探针里先误报过一次"丢内容"，诊断证明差的 202 字符**全是卡片边界的空行**）。
  //   ★ 判据：**比"非空行序列"**，那才是内容；空行差异不构成"丢内容"。
  const nonBlank = (s) => s.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "");
  const aLines = nonBlank(raw);
  const bLines = nonBlank(plan.map((c) => c.text).join("\n"));
  const verify = {
    parts: parts.length,
    cards: plan.length,
    srcChars: raw.length,
    cardChars: plan.reduce((a, c) => a + c.chars, 0),
    srcLines: aLines.length,
    cardLines: bLines.length,
    lossless: aLines.length === bLines.length && aLines.every((l, i) => l === bLines[i]),
  };

  if (!apply) {
    return { ok: true, dryRun: true, kind, dir: dirRel, from: rel, cards: plan.length, verify,
      sample: plan.slice(0, 5).map((c) => c.key),
      note: "这是**预览**（没有写任何东西）。★ 原文件**不会被删**，它会作为迁移前的快照留着。" };
  }

  // ① 写卡（原文件一个字都不动）
  let written = 0;
  for (const c of plan) {
    const r = writeCard(root, dirRel, c.key, c.text);
    if (r.ok !== true) return { ok: false, reason: `写卡片 ${c.key} 失败：${r.reason}`, written, dir: dirRel };
    written++;
  }
  // ③ 再写**索引表**（`INDEX.md`）—— ★ 它在卡片之后、登记之前：
  //   这样"索引"绝不会先于内容存在（若写卡失败，我们早就 return 了）。
  const idx = writeCardIndex(root, dirRel, kind === "decisions" ? "关键决策" : kind === "lessons" ? "经验与教训" : "目标树", {});
  // ④ 最后登记清单（`<kind>Dir`）—— 登记之前这些卡对插件**还不存在**（可安全重试）
  try {
    registerCardDirInManifest(root, info, kind, dirRel);
  } catch {
    return { ok: false, reason: `卡片已写 ${written} 张，但**登记清单失败** ⇒ 它们还不会被读到。请重试或人工在清单里加 \`${kind}Dir: "${dirRel}"\`。`, written, dir: dirRel, verify };
  }
  return { ok: true, dryRun: false, kind, dir: dirRel, from: rel, written, cards: plan.length, verify,
    index: idx.ok === true ? { path: idx.path, count: idx.count } : { error: idx.reason },
    note: `已拆成 ${written} 张卡片（在 \`${dirRel}/\`），并生成了索引表 \`${dirRel}/INDEX.md\`。★ **原文件 \`${rel}\` 原样留着**（迁移前快照）—— 确认无误后你可以自己删，我不替你删。` };
}

/**
 * 把一段文本按**条目**切成卡片段（**逐字**保留每段原文，含它的标题行）。
 *
 * ★ 与 `sliceEntryByKey` 的**区别**：那个是"按 key 找一段"，这个是"把整份切成 N 段"。
 * ★★ 两者必须**认同一套形状**（否则"切出来的卡"与"按 key 取"对不上）——
 *   所以判据共用 `cardKeysOf` 那套正则，**不各写一份**（本项目最忌"两处各写一份"）。
 * ★ 卡片之外的内容（文件头、分隔线等）挂到**第一张卡之前**的前言里 ——
 *   **绝不丢**（拼回去必须等于原文）。
 */

export function splitIntoCardParts(raw, kind) {
  const src = typeof raw === "string" ? raw : "";
  const lines = src.split(/\r?\n/);
  const re =
    kind === "decisions"
      ? /^##\s*D(\d+)(?![\dA-Za-z])/
      : kind === "lessons"
        ? /^##\s*(经验|教训)\s+([LE]\d+)(?![\dA-Za-z])/i
        : /^##\s*目标\s+([A-Za-z0-9._-]+)/;
  const starts = [];
  lines.forEach((l, i) => {
    const m = re.exec(l);
    if (m !== null) {
      const key = kind === "lessons" ? m[2] : kind === "decisions" ? `D${m[1]}` : m[1];
      // ★ 记下**行号**（1-based，给人读）—— 重复编号时要把证据摆出来（见下面 dups）。
      starts.push({ key, line: i, lineNo: i + 1 });
    }
  });
  if (starts.length === 0) return [];
  const parts = [];
  // ★ 前言（第一张卡之前的全部内容）挂到 `_intro` —— 它不是一个"卡片键"，
  //   所以**不写成 `_intro.md`**（那是文件），而是**并入第一张卡**的前面。
  //   ★ 理由：正文里那句"# 关键决策 / > 说明…"是**给人读的头**，
  //     单独一个 `_intro.md` 会在目录里显示成一张"卡"，容易误导。
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].line;
    const to = i + 1 < starts.length ? starts[i + 1].line : lines.length;
    let text = lines.slice(from, to).join("\n").replace(/\s+$/, "");
    if (i === 0 && starts[0].line > 0) {
      const intro = lines.slice(0, starts[0].line).join("\n").replace(/\s+$/, "");
      if (intro.trim() !== "") text = `${intro}\n\n${text}`;
    }
    parts.push({ key: starts[i].key, text, lineNo: starts[i].lineNo });
  }
  return parts;
}

/** 把 `<kind>Dir` 登记进清单（**只补字段**，绝不动别的 —— 与 `registerGoalsInManifest` 同一套）。 */

export function registerCardDirInManifest(root, info, kind, dirRel) {
  const abs = path.resolve(root, MANIFEST_REL);
  const cur = readManifest(root) ?? {};
  const field = kind === "decisions" ? "decisionsDir" : kind === "lessons" ? "lessonsDir" : "goalsDir";
  if (typeof cur[field] === "string" && cur[field] !== "") return;
  const next = { ...cur, [field]: dirRel };
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

/**
 * ⑫ ledger_index —— **多维索引表**（D202，用户拍板："每个文件夹里有一张索引表，
 * 按之前搞的那多重维度分区块"）。
 *
 * ★ 它做两件事，**默认只读**：
 *   ① `op:"show"`（默认）⇒ **现算**并返回那张多维表（模型/时间/稳定/星 四维秩融合，D136 原样）；
 *   ② `op:"write"` ⇒ 把表**落盘**成 `<dir>/INDEX.md`（★ 只是缓存，插件从不读它做决定）。
 * ★★ 为什么默认只读：索引是**派生物** —— 让"重算"比"读缓存"更方便，
 *   才不会出现"缓存过期了却没人知道"（本项目的"派生物不当权威"）。
 */

export function defineIndexTool() {
  return {
    name: "ledger_index",
    description:
      "Build the multi-dimension index table for a card folder (one card per file). The score fuses " +
      "four relative-rank dimensions: model judgement (3.0), recency (1.5), stability (0.8), " +
      "star value (1.0). Defaults to a READ-ONLY recompute; pass op:\"write\" to also persist it as " +
      "<dir>/INDEX.md. ★ The persisted file is only a CACHE — the plugin never reads it to make " +
      "decisions, so recompute whenever you need a trustworthy ordering.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        kind: {
          type: "string",
          enum: ["decisions", "lessons", "goals"],
          description: "Which card folder to index. Required if the project has more than one.",
        },
        op: {
          type: "string",
          enum: ["show", "write"],
          description: "show (default) = recompute and return the table. write = also persist INDEX.md.",
        },
        limit: { type: "number", description: "Max rows to return (default 200)." },
      },
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec, args);
      const info = inspect(root);
      const want = typeof args?.kind === "string" ? args.kind : "";
      const avail = ["decisions", "lessons", "goals"].filter((k) => {
        const m = cardModeOf(info, k);
        return m.card === true;
      });
      if (avail.length === 0) {
        return {
          ok: false,
          reason:
            "这个项目**没有卡片目录**（三类记忆都还是单文件模式）⇒ 没有可索引的卡片。\n" +
            "★ 先用 `ledger_migrate({op:\"split\", kind:…})` 把它拆成卡片（一卡一文件），" +
            "索引表才有意义（单文件模式用 `ledger_read` 的 `toc` 就够）。",
          cardKinds: [],
        };
      }
      const kind = want !== "" ? want : avail.length === 1 ? avail[0] : "";
      if (kind === "" || !avail.includes(kind)) {
        return { ok: false, reason: `请指定 kind（可选：${avail.join(" / ")}）—— 本项目有多于一个卡片目录。`, cardKinds: avail };
      }
      const mode = cardModeOf(info, kind);
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(2000, args.limit)) : 200;
      const r = renderCardIndex(root, mode.dirRel, { limit });
      // ★★★★★★ 2026-10-14（D205 · **真机撞出**）：`rows` 也必须受 `limit` 约束。
      //   ★ 病：`renderCardIndex` 返回的 `rows` 是**全部**（本次真机 `limit:5` ⇒ 回来 204 条），
      //     而工具描述白纸黑字写着 "Max rows to return (default 200)" ⇒ **承诺与实现不符**。
      //   ★★ 为什么这条不只是"文档写错"：它直接打穿 **D79** 那条预算 ——
      //     "目录必须是**小索引 + 按需翻页**"。`markdown` 守住了、`rows` 没守住，
      //     而模型真正吃进去的是 `rows`（结构化那份）⇒ **上限形同虚设**。
      //   ★ 判据：**同一个上限必须同时约束"给人看的那份"和"给模型的那份"** ——
      //     只守一份 = 没守（本项目"同一个值不许有两个出处"的同型）。
      //   ★★ 我这次是**真机才撞见**的：夹具里只有 2 张卡，`limit` 大于总数 ⇒ 两者恰好相同 ⇒ 全绿。
      //     ⇒ 判据：**"上限类"断言必须让总数大于上限**，否则它是空的（与 L30 同型）。
      const base = {
        ok: true, kind, dir: mode.dirRel,
        count: r.count, shown: r.shown,
        markdown: r.markdown,
        rows: r.rows.slice(0, limit),
        ...(r.count > limit ? { more: `另有 ${r.count - limit} 张未列出（用更大的 limit 或按 kind 取单条）` } : {}),
      };
      if (args?.op === "write") {
        const label = kind === "decisions" ? "关键决策" : kind === "lessons" ? "经验与教训" : "目标树";
        const w = writeCardIndex(root, mode.dirRel, label, { limit });
        return { ...base, wrote: w.ok === true, indexPath: w.path, ...(w.ok === true ? {} : { writeError: w.reason }) };
      }
      return base;
    },
  };
}

/** ④ ledger_write —— 写活跃台账 / 决策记录。 */

export function defineWriteTool(state) {
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
          enum: ["active", "decisions", "principles", "journal"],
          description:
            "Which ledger file to write. ★ \"journal\" is the APPEND-ONLY turn journal " +
            "(dated per-session history). ★ It is **append-only, enforced**: passing " +
            "`mode:\"replace\"` is IGNORED for journal (the result tells you so) — a " +
            "history file that can be wiped by a parameter is not append-only. " +
            "use \"active\" for CURRENT STATE (which may be overwritten/condensed). " +
            "★ \"principles\" is the FUNDAMENTAL PRINCIPLES file: " +
            "it CANNOT be written from a tool call at all — the only ways are the user clicking " +
            "the authorization card (`" +
            PRINCIPLE_GRANT_TOOL +
            "`) or the user running `/ledger principles`. A string parameter used to be accepted " +
            "here and that was a hole (anyone can type a string); it was removed in 1.2.8.",
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
        // ★★★★★ 2026-10-18（D266 · 修 review v1.2.7 的 F01）：**这里原来有 `authorizedBy` 参数，
        //   现在整条删掉 —— 不是改描述，是把参数从 schema 里移除。**
        //
        //   🔴 review 实测（两个变体）：
        //     ① 不带 `authorizedBy` ⇒ 被拒（正确）；
        //        加上 `authorizedBy: "I claim user approved"` ⇒ **写入成功**。
        //        代码注释自己都写着"字符串理论上可猜"，却仍然留着这条放行路径。
        //     ② 更狠：删掉参数也不够 —— 对一个已登记 `principles` 的项目重新调 `ledger_init`，
        //        把 `active` 改成 `PRINCIPLES.md` 且**不显式传 principles**（旧字段被保留），
        //        之后普通 `target:"active"` 写入就**改到了原则文件**。
        //
        //   ★ 为什么"删参数"而不是"校验参数"：只要它还在 schema 里，模型就会看到它、
        //     就会被提示词诱导去填它。**一个可见的伪造入口，本身就是一种教唆。**
        //     review 的原话是「它可以作为宿主生成的审计描述，不能作为模型传入即放行的依据」。
        //   ⇒ 授权只剩**唯一一条**模型碰不到的路：`state.principleGrants`
        //     （用户点授权卡片 / 用户亲手敲 `/ledger principles` 命令）。
        //
        //   ★ 变体② 的修法在 `ledger_init` 里（见那里的「保护角色重映射」检查）。
      },
      required: ["target", "content"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const r = writeLedger(rootFromExec(exec, args), args, exec, state);
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

export function writeLedger(root, args, exec, state) {
  const info = inspect(root);
  const target = String(args?.target ?? "active");
  // ★ V3（D289）：台账 / 决策 / 流水都是**记忆** ⇒ 基准 `memoryBase`（V2 里它就是项目根）。
  //   ★★ 必须**在最前面**取值：下面卡片分支（decisions）在 2600 多行就用它了，
  //     放到 2800 处会撞 TDZ（`Cannot access 'memBase' before initialization`）——
  //     这一点是本轮 `_probe-v3-e2e.mjs` 当场抓到的，不是我想出来的。
  const memBase = memoryBaseOf(info, root);
  // ★★★★★ 2026-10-18（D267 · 修 review F02 的**第二半**）：**配置坏掉时必须明说，不许静默降级**。
  //
  //   ★ 这是探针当场抓到的（我的第一版只做了"降级"，没做"告知"）：
  //     清单写 `decisionsDir: "../outside-cards"` ⇒ `inspect` 把它 gated 掉 ⇒ 变成单文件模式
  //     ⇒ 这次 `ledger_write({target:"decisions"})` **写进了 `DECISIONS.md` 并返回 ok:true**。
  //     ★ 危险的不是"越界没发生"（确实没发生），而是**调用方以为卡写到了卡片目录**，
  //       实际写去了另一个文件 —— 这正是 D167「静默失败 = 谎报的镜像」那一条。
  //   ⇒ 只要清单里有**任一**路径被判据拒掉，且本次要动的正是那一类，就**直接拒绝并说明原因**。
  //     不修清单就没法用这一类 —— 这是对的：**坏配置必须被看见**。
  const unsafe = Array.isArray(info.unsafePaths) ? info.unsafePaths : [];
  if (unsafe.length > 0) {
    const kindField = target === "decisions" ? "decisionsDir" : undefined;
    const mine = kindField === undefined ? [] : unsafe.filter((u) => u.field === kindField);
    if (mine.length > 0) {
      const u = mine[0];
      return {
        ok: false,
        reason:
          `清单里的 \`${u.field}\` 被拒绝，所以这一次**什么都没写**：\n  · 值：\`${u.value}\`\n  · 原因：${u.why}\n` +
          "★ 为什么不继续（降级成单文件写）：那会让**你以为卡写到了卡片目录、实际写去了另一个文件** ——\n" +
          "  静默降级比直接报错更危险。\n" +
          `★ 修法：把 \`.dsh-ledger.json\` 里的 \`${u.field}\` 改成**项目内部的相对路径**（例如 \`decisions\`），再重试。`,
        unsafeManifestPath: u,
        nothingWritten: true,
      };
    }
  }
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
  // ★★★★★ 2026-10-13（D183）：**流水默认 append**（与 `decisions` 同一条理由）——
  //   它是"只追加的历史"。默认 `replace` 会让一次普通的
  //   `ledger_write({target:"journal", content})` **静默抹掉全部历史**，
  //   而工具描述称它"只追加"⇒ 实现与承诺直接冲突（**A1 那个坑的同型复发**）。
  //
  // ★★★★★ 2026-10-18（D268 · 修 review v1.2.7 的 F09）：**"默认 append" 不够，必须是"只能 append"**。
  //
  //   🔴 review 实测：`ledger_write({target:"journal", mode:"replace", content:"NEW ONLY"})`
  //      ⇒ **返回 ok:true**，历史流水被整份抹掉。
  //      它给这个问题的定性很准：「这是**行为契约问题**」——
  //      README 与工具描述都写着「只追加、**不改旧条目**」，而代码留了一个显式出口。
  //
  //   ★ 判据：**「只追加」这条承诺，不能靠"默认值"兑现，必须靠"没有别的分支"兑现。**
  //     默认值只影响**不传 mode 的调用**；而"想清空历史"的调用方**一定会去传 mode**。
  //     ⇒ 留一个显式 replace 出口，等于这条承诺**只对老实人成立**。
  //   ⇒ 修法：`target:"journal"` 时**忽略** `mode`，一律 append，并在返回值里如实说明
  //     「你传的 replace 被忽略了、为什么」（D167：不许静默改写调用方的意图）。
  //   ★ 如果将来真的需要"整理历史"：那应该是**单独的、有预览和备份的迁移操作**（review 原话），
  //     不是给日常写入开一个后门。
  const journalAppendOnly = target === "journal";
  const requestedMode = explicitMode;
  const mode =
    journalAppendOnly ? "append" : explicitMode ?? (target === "decisions" ? "append" : "replace");
  const modeIgnored = journalAppendOnly && requestedMode === "replace";
  const content = typeof args?.content === "string" ? args.content : "";
  const createIfMissing = args?.createIfMissing !== false;
  const tag = sessionTag(exec?.agent);

  const relPath =
    target === "decisions"
      ? info.decisionsRel
      : target === "journal"
        ? info.journalRel
        : info.activeRel;

  // ═══════════════════════════════════════════════════════════════════════════
  // ★★★★★ 2026-10-14（D203）：**卡片模式下的写入** —— 这一条是"迁移"能成立的前提。
  // ═══════════════════════════════════════════════════════════════════════════
  //
  //  ★★★ 病（迁移前必须堵住，否则迁移 = 造出**两份真源**）：
  //    `relPath` 取自 `info.decisionsRel`（= 那个留在盘上的**旧文件 / 迁移前快照**）。
  //    卡片化之后**读**走卡片目录（`readKindRaw` / `ledger_read({entry})`），
  //    而**写**若仍写进旧文件 ⇒ 新决策写进一个**再也没人读的文件**：
  //    模型以为"我记下来了"，它却**永远不出现在任何一次读取里**。
  //    ★ 这比"没写"更坏 —— **记录存在 ≠ 记录可被读到**（纪律 11 的同型复发，且更隐蔽）。
  //
  //  ★ 判据：**"这一类现在住在哪"只能有一个答案** —— 读写必须问同一个 `cardModeOf`。
  //  ★ 语义映射（照 `append` 的原意，不新造概念）：
  //    · 追加 ⇒ **写一张新卡**（键 = 那条的 `## D<n>` 编号 —— 也就是它的地址）；
  //    · 编号已存在 ⇒ **拒绝**（同编号两张卡 = 静默丢掉一张，与迁移器同一套判据）；
  //    · `mode:"replace"` ⇒ **拒绝**（一个目录无法被"一次写入替换"）。
  if (target === "decisions" && cardModeOf(info, "decisions").card === true) {
    const cmode = cardModeOf(info, "decisions");
    if (mode === "replace") {
      return {
        ok: false,
        mode: "card",
        dir: cmode.dirRel,
        reason:
          `关键决策是**卡片模式**（\`${cmode.dirRel}/\`）⇒ **不能整份 replace**（一个目录无法被一次写入替换）。\n` +
          `★ 要改某一条 ⇒ 读出来改它那张卡（\`${cmode.dirRel}/D195.md\`）；★ 要新增 ⇒ 用默认的 append（写一张新卡）。`,
      };
    }
    if (content.trim() === "") return { ok: false, reason: "content 不能为空。" };
    const parts = splitIntoCardParts(content, "decisions");
    if (parts.length === 0) {
      return {
        ok: false,
        mode: "card",
        dir: cmode.dirRel,
        reason:
          "卡片模式下写入**必须自带条目编号**（每条以 `## D<n> · <标题>` 开头）—— " +
          "因为**编号就是文件名**（那是卡片化唯一能给、单文件给不了的收益）。\n" +
          "★ 编号取「现有最大 +1」即可。",
      };
    }
    const existingKeys = new Set(listCards(memBase, cmode.dirRel).map((c) => c.key));
    const clash = parts.filter((p) => existingKeys.has(p.key)).map((p) => p.key);
    if (clash.length > 0) {
      return {
        ok: false,
        mode: "card",
        dir: cmode.dirRel,
        reason:
          `这些编号**已经有一张卡了**：${clash.join(" · ")} ⇒ 拒绝覆盖（覆盖 = 静默丢掉原来那张）。\n` +
          "★ 想改它就先 `ledger_read({target:\"decisions\", entry})` 读出来，或换一个**未用过**的编号。",
        duplicates: clash,
      };
    }
    // ★★★★★ 2026-10-18（D266 · 修 review v1.2.7 的 F04）：**同批内部重号必须在写第一张卡之前就拒绝**。
    //
    //   🔴 病（review 的实测，`ok:true` + `written:2` + `cards:['D1','D1']`，磁盘只剩第二条）：
    //      上面那道 `clash` 只查"与**磁盘已有**的编号冲突"，**没查这一批自己内部是否重号**；
    //      而写入循环又没把已写的编号回填进 `existingKeys` ⇒ 同批两条都写到 `D1.md`，
    //      **后一条覆盖前一条，且报成功**。
    //
    //   ★★ 这个缺口最值得记的一点（review 自己指出的）：
    //      **迁移入口早就检查了批次内部重号**（`part4.js` 的 migrate 那段）——
    //      同一个不变量**只在一条路上成立**，另一条路上就漏了。
    //      这正是本项目反复栽的那个病（D59 家族：同一件事两处各写一份，然后其中一处忘了改）。
    //
    //   ★ 修法：**先做完整预检，全部通过才写第一张卡**（不是边写边查）。
    //      预检三件：① 批内重号 ② 与磁盘重号（上面已做）③ 编号能否变成文件名（原来在循环里查，
    //      那意味着"前面几张已经写出去了、才在最后一张报错" ⇒ 半批覆盖）。
    const seenInBatch = new Set();
    const dupInBatch = [];
    for (const p of parts) {
      if (seenInBatch.has(p.key)) dupInBatch.push(p.key);
      seenInBatch.add(p.key);
    }
    if (dupInBatch.length > 0) {
      return {
        ok: false,
        mode: "card",
        dir: cmode.dirRel,
        reason:
          `这一批里**自己就重号了**：${[...new Set(dupInBatch)].join(" · ")} ⇒ **整批拒绝，一张都没写**。\n` +
          "★ 为什么必须整批拒绝：编号就是文件名，同批两条同一个编号 ⇒ 后一条会**静默覆盖**前一条，\n" +
          "  而旧实现会回 `written:2` —— 报告写了两条、磁盘只剩一条，**丢了还报成功**。\n" +
          "★ 请给每条换成不同的编号（例如依次 +1）再重试。",
        duplicates: [...new Set(dupInBatch)],
        batchDuplicates: true,
      };
    }
    // ③ 编号能不能安全变成文件名 —— **也要在写之前全部查完**
    const badKeys = parts.filter((p) => !isSafeCardKey(p.key)).map((p) => p.key);
    if (badKeys.length > 0) {
      return {
        ok: false,
        mode: "card",
        dir: cmode.dirRel,
        reason:
          `这些编号不能变成文件名（只允许字母数字与 . _ -）：${badKeys.join(" · ")} ⇒ **整批拒绝，一张都没写**。\n` +
          "★ 原来这条是在写入循环里查的 ⇒ 前面几张已经落地、到这一张才报错，会留下**半批**。",
        invalidKeys: badKeys,
      };
    }
    const writtenKeys = [];
    for (const p of parts) {
      const w = writeCard(memBase, cmode.dirRel, p.key, p.text);
      if (w.ok !== true) return { ok: false, reason: `写卡片 ${p.key} 失败：${w.reason}`, mode: "card", written: writtenKeys };
      writtenKeys.push(p.key);
    }
    let indexed = false;
    try {
      indexed = writeCardIndex(memBase, cmode.dirRel, cardDirLabel("decisions"), {}).ok === true;
    } catch {
      /* 索引只是缓存 */
    }
    return {
      ok: true,
      mode: "card",
      target: "decisions",
      dir: cmode.dirRel,
      written: writtenKeys.length,
      cards: writtenKeys,
      indexRefreshed: indexed,
      note: `已写成 ${writtenKeys.length} 张卡（在 \`${cmode.dirRel}/\`）。★ 键就是地址：\`${cmode.dirRel}/${writtenKeys[0]}.md\`。`,
    };
  }

  if (relPath === undefined) {
    return {
      ok: false,
      reason:
        "这个项目还没有登记台账结构。请先调用 ledger_init（或让用户执行 /ledger init）。",
      hint: "ledger_init",
    };
  }
  // ★★★★★ 2026-10-13（D180）：**根本原则**是一条**独立的写入路径**，且它**必须**带用户授权。
  //   ★ 判据用"显式 `authorizedBy`"：它由**用户动作**产生（点卡片 / 亲手输入），
  //     模型**没有任何办法**自己产生它 —— 见 `writePrinciples` 上方的整段设计说明。
  //   ⇒ 模型若直接调 `ledger_write({target:"principles"})` 而不带授权 ⇒ **被拒**。
  if (target === "principles") {
    // ★★★★★ 2026-10-18（D266 · 修 review F01）：**`args.authorizedBy` 不再被读取**。
    //
    //   🔴 review 的原话：「工具参数公开了 `authorizedBy` 字符串。原则写入分支只要看到非空字符串，
    //      就会把它作为授权来源；**没有验证该字符串是否出自用户操作**，也没有验证不可伪造的授权记录。」
    //      实测：`{authorizedBy: "I claim user approved"}` ⇒ **写入成功**。
    //
    //   ★ 这不是"模型一定会恶意做"，而是**承诺并没有在程序边界上成立** ——
    //     提示词误导、模型误解"用户已同意"，都会走到这个入口。
    //     而 PRINCIPLES.md 存在的**全部意义**就是"模型不能自己改"。
    //
    //   ★ 判据（现在的唯一一条）：**只认 `state.principleGrants`。**
    //     它是插件自己持有的进程内状态，模型**没有任何工具**能写进去 ——
    //     只能由用户在卡片上点"授权"（`PRINCIPLE_GRANT_TOOL`）或亲手敲命令产生。
    //   ⚠️ 参数虽已从 schema 删除，但**运行时仍可能有调用方硬塞**（旧脚本 / 别的入口）
    //      ⇒ 这里显式忽略它，并在拒绝时告诉用户"那个字符串不算授权"，免得下次又试。
    const forged = typeof args?.authorizedBy === "string" && args.authorizedBy.trim() !== "";
    // ★★★★★ 2026-10-14（D191，用户拍板）：**授权窗口** —— 用户在卡片上点过"授权"就放行。
    //   用户原话（逐字）：*"模型应该可以调用工具，弹一个单独卡片，
    //   选择授权的话就**解锁模型改原则的权利**。"*
    //
    //   ★★★ 为什么这条比"传一个字符串"更硬：判据是**插件自己持有的 state**
    //     （`state.principleGrants`），模型**没有任何办法**把它写进去 ——
    //     它只能由**用户在卡片上点那一下**产生。
    const sidForGrant = String(exec?.agent?.session?.header?.id ?? "");
    const grant = sidForGrant === "" ? undefined : principleGrantOf(state, sidForGrant);
    const authorizedBy = grant === undefined ? "" : grant.authorizedBy;
    if (authorizedBy === "") {
      return {
        ok: false,
        reason:
          "**根本原则条例只能由用户授权后写入** —— 这次调用没有携带**由用户动作产生**的授权，所以一个字节都没写。\n" +
          (forged
            ? "★ 注意：你（或调用方）传了 `authorizedBy`，但**那个字符串从来就不是授权凭据** ——\n" +
              "  任何人都能写一个字符串，所以它证明不了任何事（v1.2.8 起已把它从工具参数里彻底移除）。\n"
            : "") +
          "★ 正确流程（两条，任选）：\n" +
          `  ① 用 \`${PRINCIPLE_GRANT_TOOL}\` 弹一张**授权卡片**，用户点了"授权"即可（一次一授权）；\n` +
          "  ② 用 `ledger_propose_principle` 登记**一条具体提议**，" +
          "再请用户敲 `/ledger principles approve` —— ★ 批准**只在命令行层**，你调不到。",
        refused: true,
        ...(forged ? { selfAssertedAuthIgnored: true } : {}),
        hint: PRINCIPLE_GRANT_TOOL,
      };
    }
    const r = writePrinciples(root, {
      content,
      mode: explicitMode ?? "append",
      authorizedBy,
      exec,
      tag,
    });
    // ★★★ **一次一授权**：写成功后**立刻消费掉**那个窗口。
    //   ★ 为什么必须消费（而不是留着）：留着就等于"点一次 = 此后随便改"，
    //     守卫当场退化成空的。用户的原话是"解锁**改原则的权利**"，
    //     而本项目一贯的取舍是"授权针对**某一次具体修改**"（见 `PRINCIPLE_AUTH_TTL_MS`）。
    if (r.ok === true && grant !== undefined) {
      consumePrincipleGrant(state, sidForGrant);
    }
    return r;
  }

  // ★ V3（D289）：台账 / 决策 / 流水都是**记忆** ⇒ 基准 `memoryBase`（在函数开头已取，
  //   见那里关于 TDZ 的注释）。校验也用同一基准。
  const abs = path.resolve(memBase, relPath);
  if (!isUnder(memBase, abs)) throw fail("ledger_write: 目标逃出了项目根");

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

  // ═══════════════════════════════════════════════════════════════════════════
  // ★★★★★★ 2026-10-14（D206 · 用户拍板）：**台账"骤降"安全网**
  // ═══════════════════════════════════════════════════════════════════════════
  //
  //  ★ 为什么必须加（**本会话真的发生了一次**）：
  //    我调 `ledger_write({target:"active"})` 写一段**增量**内容，**漏了 `mode:"append"`** ——
  //    而 `active` 的默认是 **replace** ⇒ **330 行台账被替换成 38 行**（`changedBy: -291`）。
  //    ★★ 更糟的是：`LEDGER.md` **被 `.gitignore` 忽略、盘上也没有自动备份** ——
  //    那次能救回来，靠的是**插件刚注入的 `<<<LEDGER-BLOCKS>>>` 全文**（运气 + 恰好有）。
  //
  //  ★★★ 用户的顾虑（原话）：*"安全网建立的话，会不会卡死某些情况下的工作推进？"*
  //    ⇒ 判据定死：**"只拦默认、绝不拦明说"** —— 任何**有意的**操作都必须走得通：
  //      · 显式传了 `mode:"replace"` ⇒ **一律放行**（那是"我在精简台账"，是设计允许的）；
  //      · 传了 `force:true` ⇒ **一律放行**（与"超行数上限"复用同一个逃生口）；
  //      · 只对 `active` ⇒ `decisions`/`journal` 默认 append，本来就不会骤降。
  //    ★ 所以它**只会在一种情况下触发**：**你既没说要 replace、又没说要 force、
  //      而这一写会让行数掉到一半以下** —— 那正是"漏参数"的形状。
  //
  //  ★ 阈值（**故意宽松**：宁可漏报，不可误拦）：
  //    ① 掉到原文的 **50% 以下**，**且** ② 绝对减少 **≥ 30 行**。
  //    ⇒ 正常的"精简台账"（删掉十几行过时条目）**碰不到它**；一次抹掉几百行才会。
  const modeWasExplicit = args?.mode === "append" || args?.mode === "replace";
  if (
    target === "active" &&
    mode === "replace" &&
    !modeWasExplicit &&
    args?.force !== true &&
    existing !== undefined
  ) {
    const wasLines = countLines(existing);
    const willLines = countLines(next);
    const dropped = wasLines - willLines;
    if (wasLines >= 40 && willLines < wasLines * 0.5 && dropped >= 30) {
      return {
        ok: false,
        refused: true,
        reason:
          `★ **拒绝写入**：这会是一次**整份替换**，而且行数**从 ${wasLines} 掉到 ${willLines}**（少了 ${dropped} 行）。\n` +
          "★ 为什么拦：这次调用**没有显式声明 `mode`** —— 而 `target:\"active\"` 的**默认就是 `replace`**。\n" +
          "  ⇒ 这个形状正是「**本想追加、却漏了 `mode:\"append\"`**」（本项目真发生过一次：330 → 38 行，`LEDGER.md` 还被 git 忽略、没有备份）。\n" +
          "★ 三条出路（**任选一条即可放行，绝不卡住有意的操作**）：\n" +
          "  ① 你本来就想**追加** ⇒ 传 `mode:\"append\"`（这是最常见的情形）；\n" +
          "  ② 你确实想**整份替换/精简** ⇒ 显式传 `mode:\"replace\"`（**说了就放行**）；\n" +
          "  ③ 你确认要这样 ⇒ 传 `force:true`。\n" +
          "★ 一个字节都没写。",
        stats: { wasLines, willLines, dropped },
        hint: "mode:\"append\" | mode:\"replace\" | force:true",
      };
    }
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

  // ★★★★★ 2026-10-18（D266 · 修 review v1.2.7 的 F06）：**这里是全项目最重要的一次写入，
  //   之前却是唯一还在"直接覆盖"的地方**。
  //
  //   🔴 review 的故障注入实测：让 `writeFileSync` 先写新内容前 8 字节再抛异常 ⇒
  //      调用报错，**而旧台账已经没了**，文件只剩 `# NEW AC`。
  //      ★ 本项目 2026-10-09 真出过同型事故（台账被写成 `orem ipsum`，抹掉 114 行）。
  //
  //   ★ 修法：改走 `writeFileAtomic`（同目录独占临时文件 → 原子 rename）。
  //     语义保证：**要么旧版本完整可读，要么新版本完整写入，绝不留半截**。
  //   ★ 失败必须**如实报**（D167：不许把失败说成成功）——所以这里直接 return ok:false，
  //     而不是"吞掉继续往下走然后报成功"。
  const writeResult = writeFileAtomic(abs, next);
  if (writeResult.ok !== true) {
    return {
      ok: false,
      target,
      mode,
      reason:
        `写台账失败（**旧内容完好，一个字节都没动**）：${writeResult.reason ?? "未知原因"}\n` +
        "★ 这是原子写：新内容要么整体落地，要么完全不落 —— 不会留下半截文件。",
      atomic: true,
      path: abs,
    };
  }

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
        // ★★★★★ 2026-10-13（D183）：**显式给出 kind** —— 流水的改动要和台账改动分得清。
        //   ★ 不给就会退回按 `mode` 推断成 `ledger-write`（76④ 抓到的那个缺口）。
        ...(target === "journal" ? { kind: AUDIT_KIND_JOURNAL } : {}),
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

  // ★ V3/D290：走唯一闸门 —— 全部被 ignore 挡住时 `staged` 必须是 false，不是 true。
  let staged;
  let staging;
  if (info.manifest?.autoGitAdd !== false && fs.existsSync(path.join(root, ".git"))) {
    const r = gitAdd(root, [relPath]);
    staging = stageOutcomeOf(r, [relPath]);
    staged = staging.staged;
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
    // ★★★★ 2026-10-18（D268 · review F09）：**如实告诉调用方"你传的 replace 被我忽略了"**。
    //   ★ 为什么不静默：调用方以为历史被清空、实际没有 ⇒ 它接下来可能会基于一个**错误的世界模型**
    //     继续操作（例如"我清空了，那现在从零开始记"）。D167 那条"不许静默改写意图"。
    ...(modeIgnored
      ? {
          modeIgnored: "replace",
          modeNote:
            "★ 你传了 `mode:\"replace\"`，但 `target:\"journal\"` **只能追加** —— 这个参数被忽略了，" +
            "历史完整保留，本次内容接在末尾。\n" +
            "★ 为什么：流水是「只追加的历史」，这条承诺写在 README、工具描述和台账里。\n" +
            "  只留一个显式出口，等于这条承诺**只对不传参数的调用成立** —— 想清空的人一定会去传它。\n" +
            "★ 若确实需要整理历史：那应当是一次**单独的、有预览与备份的迁移操作**，不是日常写入的后门。",
        }
      : {}),
    // ★ `staged` **只在真的 stage 过时才出现**。不能直接写 `staged`（值可能是 undefined）——
    //   内核校验工具返回值必须是 **lossless JSON**，`undefined` 会让整个调用被判失败，
    //   而写入其实已经落盘（2026-10-08 实测撞到，写日志那条路先报了这个错）。
    ...(staged === undefined ? {} : { staged }),
    // ★ V3/D290：进去了哪些、被挡住哪些，都要说出来（只说"成功"不够）。
    ...(staging === undefined || staging.stagedPaths.length === 0
      ? {}
      : { stagedPaths: staging.stagedPaths }),
    // ★ V3/D290：被 ignore 挡住的路径如实列出（`staged` 为 false 时告诉调用方"为什么"）。
    ...(staging === undefined || staging.stagedSkipped.length === 0
      ? {}
      : { stagedSkipped: staging.stagedSkipped }),
    ...(staging === undefined || staging.stagedNote === undefined
      ? {}
      : { stagedNote: staging.stagedNote }),
  };
}

/** ⑤ ledger_archive —— 把旧条目移进归档（只追加、不删除）。 */

export function defineArchiveTool(state) {
  return {
    name: "ledger_archive",
    description:
      "Move entries out of the active ledger into the append-only archive, under " +
      "`<archiveDir>/YYYY-MM/weekN`. YOU choose which entries to archive and supply both the " +
      "text being archived and the trimmed active ledger. Existing archive files are never " +
      "rewritten: the entries are appended to the current period's file, so history is kept. " +
      "★ THE ONLY REQUIREMENT (the sole content gate): `entries` must be a CONTIGUOUS VERBATIM " +
      "SLICE of the current active ledger — copy it out as-is, do not reword, do not merge " +
      "non-adjacent pieces, do not invent lines. If it is, the call succeeds and reports " +
      "`archivedSegment` (the line range it came from) so the batch is traceable. " +
      "★★ THE ACTIVE LEDGER ITSELF IS YOUR OWN DRAFT: edit it, trim it, rewrite old lines in " +
      "place, delete finished sections — none of that blocks archiving. You are NOT required to " +
      "preserve every old line elsewhere; the only thing that has to be genuine is the slice " +
      "you archive. Leading/trailing blank lines in `entries` are tolerated as formatting noise. " +
      "★ Pass `ifRevision` (the revision you read) to guard against another session writing " +
      "meanwhile — if it no longer matches, nothing is written and you are asked to re-read. " +
      "Nothing at all is written when the call fails for any reason, so it is safe to retry; " +
      "re-sending the same `entries` is recognised and will not duplicate them.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        entries: {
          type: "string",
          description:
            "A CONTIGUOUS VERBATIM SLICE of the active ledger, to append to the archive. " +
            "Copy it from the file exactly; do not reword, reorder, merge non-adjacent pieces, " +
            "or invent lines. (Leading/trailing blank lines are ok.)",
        },
        newActive: {
          type: "string",
          description:
            "The full new content of the active ledger, with the archived slice removed. " +
            "★ You may freely edit, trim, condense or rewrite the remaining lines — this is " +
            "your working draft, so it does NOT have to be a mere deletion of `entries`.",
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

export function archiveLedger(root, args, exec) {
  const info = inspect(root);
  if (info.activeRel === undefined || info.archiveRel === undefined) {
    return { ok: false, reason: "这个项目还没有登记台账结构，先 ledger_init。", hint: "ledger_init" };
  }
  const entries = typeof args?.entries === "string" ? args.entries : "";
  const newActive = typeof args?.newActive === "string" ? args.newActive : "";
  if (entries.trim() === "") {
    return { ok: false, reason: "entries 为空 —— 没有东西要归档。" };
  }

  // ★ V3（D289）：归档目录与活跃台账都是**记忆** ⇒ 基准 `memoryBase`。
  const memBase = memoryBaseOf(info, root);
  const archiveAbs = path.resolve(memBase, info.archiveRel);
  const activeAbs = path.resolve(memBase, info.activeRel);
  if (!isUnder(memBase, archiveAbs)) throw fail("ledger_archive: 归档目录逃出了项目根");
  if (!isUnder(memBase, activeAbs)) throw fail("ledger_archive: 活跃台账逃出了项目根");

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
  // ★★★★★ 2026-10-18（D267 · 修 review v1.2.7 的 F05）：**判据从"列表行"换成"整份正文逐行（保留计数）"**。
  //
  //   🔴 review 实测：原来这里用 `lostEntries`，而它只认 Markdown 列表行 ⇒
  //      **普通段落、表格、代码块、引用块全都不进去**。复现：
  //      ```
  //      ## Critical constraint
  //      MUST PRESERVE THIS PLAIN PARAGRAPH     ← 判据看不见它
  //      - completed
  //      ```
  //      传 `entries:'- completed\n'` + `newActive:'# Ledger\n'` ⇒ **归档成功**，
  //      那段关键段落**既不在新台账、也不在归档** ⇒ 无痕丢失。
  //
  //   ★ 为什么这比"多丢一行"严重：`ledger_archive` 的语义是**移走**（移进只追加的归档），
  //     **没有"有意丢行"这种用法** ⇒ 任何一行旧有新无，都必须是"没搬干净"，不能是"故意删的"。
  //   ★ 而 review 说得对：本项目**允许自由结构**（"存储模型写入的内容"），
  //     那就**不能用"只检查列表"来保证任意正文不丢失** —— 判据必须覆盖全域。
  //
  //   ★ 两根尺子并存（不是替换）：`lostEntries` 仍在给"多会话自动保留"用（它要条目粒度，
  //     改宽了会产生大量假告警）；这里用 `lostLines`（整份正文、保留计数、空行不计）。
  // ★ 归档侧只算"**会被移走却没进 entries**"的那些行 —— 所以要把 entries 也当成"已搬走"的一方。
  //   做法：把 entries 拼到 newActive 后面，作为"搬走之后的完整去处"来比。
  //
  // ★★★★ 2026-10-20（issue #1）：**两边必须先各自剥掉登记区，再拼**。
  //
  //   🔴 病（用户真机上撞到，附了最小复现）：原来直接 `${newActive}\n${entries}`，
  //      而 `newActive` 通常带变更登记区；旧 `splitChangeRegister` 从标题处**一刀切到末尾**
  //      ⇒ `entries` 整段被当成登记区吃掉 ⇒ `lostLines` 看不见它们 ⇒ **必然误报"凭空丢失"**，
  //      报的还恰好是"我要归档的那一段"。三组对照已实测：
  //        · newActive 含登记区 + entries 在后（原实现）→ ❌ 1 行误报
  //        · 改成不含登记区 / entries 在前 / 两边各自先剥 → ✅ 0
  //
  //   ★ 为什么选"各自先剥"而不是"把 entries 挪到前面"：挪顺序只是**躲开**截断点，
  //     `entries` 自己若含登记区标题仍会吃掉 `newActive`。而 `lostLines` 比的是
  //     "**正文对正文**"—— 登记区是插件附注，两侧本来就不该算进去。
  //   ★ 注：`splitChangeRegister` 现在也不再一刀切到末尾（见 part1.js），
  //     两条一起才把这类"拼接后被截断"彻底堵死。
  const priorBodyForArchive = splitChangeRegister(priorActive).body;

  // ═══════════════════════════════════════════════════════════════════════
  // ★★★★★ 2026-10-21（D287，**用户拍板换判据** —— 这是本条守卫生效方式的根本改变）
  //
  // 🔴 用户原话（逐字）：
  //   *"干脆我们这样吧，摸清自己的台账，不管怎么改都不影响，因为那是活跃台账。
  //    再大的内容也大不了多少，更根本的内容会记到其他地方。但是呢只要归档的时候是完整的，
  //    把一整段内容归进去就行，这个也要准确告诉模型。让他知道这个条件。"*
  //
  // ★★★ 旧判据（把每一行旧内容都必须在新台账或 entries 里逐字存活）**错在哪**：
  //   它等于**禁止模型编辑自己的活跃台账** —— 改一个字、删一个旧条目、就地更正一句话，
  //   都会被判成"凭空丢失"而整单拒绝。而 `LEDGER.md` 恰恰是**模型自己的工作底稿**，
  //   本来就该被随意改写、精简、就地更正。
  //   ⇒ 实测代价：本会话为此连撞**四次**（手打、加缩进、脚本读原文都过不去），
  //     每次都得整单重来 —— **成本全在模型身上付**，正是用户抱怨的那件事。
  //
  // ★★★★ 新判据只问一件事：**进归档的那一段，是不是原文里一整段真实连续的内容？**
  //   `archiveSegmentOf(priorBody, entries)`：
  //     ① 在旧的活跃台账里，能否找到**逐字连续**的对应段落（不是拼接、不是编造、不是空壳）；
  //     ② 能 ⇒ 通过，并报出**真实行号**（回执里 `archivedSegment`）。
  //   ⇒ **活跃台账怎么改都无所谓** —— 改不改、删不删、精简不精简，都不影响这一条。
  //
  // ★ 为什么这样反而**更安全**：真实风险不是"我改了几行"，而是"归档里进了假东西"。
  //   新判据恰恰把"拼接/编造/空壳"这三类拦死了（探针 C2/C3/C4/C5 守着），
  //   而旧判据对"我原样贴了一段别处的真内容但贴错了段"其实也拦不住（那行确实存在）。
  //
  // ★ `lostLines` **降级为提示**（不再是门槛）：它算出来的"哪些旧行不在新台账了"
  //   在活跃台账里是**正常现象**，但在回执里如实报出来仍有价值 ——
  //   模型能看见"这一批带走了什么、留下了什么"，可回溯性不降。
  // ═══════════════════════════════════════════════════════════════════════
  const seg = archiveSegmentOf(priorBodyForArchive, entries);
  if (seg.ok !== true) {
    return {
      ok: false,
      reason: seg.why,
      hint: seg.hint,
      nothingWritten: true,
      // ★ 把"要求"直接写进回执，模型下次照着做就行（用户要求"准确告诉模型"）
      contract:
        "归档要求（唯一一条）：`entries` 必须是**旧的活跃台账里一整段连续的真实内容**，" +
        "逐字复制、不许改写、不许拼接。★ 活跃台账本身你怎么改都可以，那是你自己的底稿 —— " +
        "**只有进归档的这一段必须是真的**。",
    };
  }

  // ★ 提示信息（**不拦**）：这一批移走之后，旧台账里还有哪些行不在新台账了。
  //   这既可能是"我顺手精简了"（完全正常），也可能是"我漏搬了一段"（值得看一眼）。
  const goneLines = lostLines(
    priorBodyForArchive,
    splitChangeRegister(newActive).body + "\n" + splitChangeRegister(entries).body,
  );


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
    // ★ D266：归档文件走统一原子写（原来手抄了一份 tmp+rename —— 手抄就是分叉的开始）
    const archWrite = writeFileAtomic(archiveFile, prevArchive + prefix + heading + entries.replace(/\s+$/, "") + "\n");
    if (archWrite.ok !== true) {
      return { ok: false, reason: `写归档文件失败（活跃台账尚未改动）：${archWrite.reason ?? "未知"}`, atomic: true };
    }
  }
  // ★★★★★ 2026-10-18（D266 · 修 review F06 的第二处）：**归档改的是活跃台账，同样必须原子写**。
  //   ★ 顺序也要保：**归档文件先落地，active 才改**（否则 active 变了、归档没写成 ⇒ 内容凭空消失）。
  const activeWrite = writeFileAtomic(activeAbs, registered);
  if (activeWrite.ok !== true) {
    return {
      ok: false,
      reason:
        `写活跃台账失败（**旧内容完好**）：${activeWrite.reason ?? "未知"}\n` +
        "★ 归档文件已写入（只追加，不会丢），但 active 没动 ⇒ 这批条目**还在台账里**，可以原样重试。",
      atomic: true,
      archivedTo: info?.archiveRel,
    };
  }

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

  // ★ V3/D290：走唯一闸门 —— 全部被 ignore 挡住时 `staged` 必须是 false，不是 true。
  let staged;
  let staging;
  if (info.manifest?.autoGitAdd !== false && fs.existsSync(path.join(root, ".git"))) {
    // ★ 注意这里有一条**会被 ignore 规则挡住的路径**：归档文件在 `_ledger-archive/` 下，
    //   而 D288 的规则里就有 `_ledger-archive/` ⇒ 归档这一路**必然**全部被挡。
    //   ⇒ 旧写法在这里**每一次归档**都会谎报 `staged: true`（探针已实测）。
    const wanted = [toGitRel(root, archiveFile), info.activeRel];
    const r = gitAdd(root, wanted);
    staging = stageOutcomeOf(r, wanted);
    staged = staging.staged;
  }

  return {
    ok: true,
    archivedTo: toGitRel(root, archiveFile),
    period: periodLabel,
    activeLines: lines,
    activeWriteTo: info.activeRel,
    appended: prevArchive !== "",
    // ★★★ D287：把「归档的是原文哪一段」如实报出来 —— 这是新契约的**可回溯凭证**。
    //   模型据此能确认"我搬走的确实是这一段"，用户据此能在归档文件里按行号核对。
    archivedSegment: {
      startLine: seg.startLine,
      endLine: seg.endLine,
      lineCount: seg.lineCount,
      note: "这是 entries 在**旧活跃台账**里所处的行号区间（1 基、含两端）。",
    },
    // ★ 提示（**不拦**）：这批移走后，旧台账里还有 N 行不在新台账也不在 entries 了。
    //   ★ 通常是"我顺手精简了"，属正常；若数量明显超出预期，值得回头看是不是漏搬。
    ...(goneLines.length === 0
      ? {}
      : {
          goneFromActive: goneLines.length,
          goneSample: goneLines.slice(0, 3).map((l) => l.slice(0, 80)),
          goneNote:
            "这些行不在新台账、也不在本批 entries 里。★ **这不影响归档成功** —— " +
            "活跃台账是你可以随意编辑的底稿。列出来只是让你知道这次带走了多少、留下了多少；" +
            "如果其中有你以为已经归档的内容，再补一次 ledger_archive 即可。",
        }),
    ...(tag === undefined ? {} : { sessionTag: tag }),
    ...(newRevision === undefined ? {} : { revision: newRevision }),
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

export function appendAudit(root, info, rec) {
  const now = new Date();
  // ★★★★★ 2026-10-18（D255）：拆片后 `logFileRel` 可能返回 `L0-milestones-002.md`
  //   ⇒ 这里要把它换成**同序号**的 `L0-ledger-changes-002.md`，而不是永远第 1 片。
  //   ★ 为什么必须同序号：两者都受同一个 128 KB 阈值约束，若审计永远写第 1 片，
  //     它自己就会涨过阈值而**没人给它滚**（正是这个 bug 的形态）。
  const l0Rel = logFileRel(info, "L0", now);
  const l0Name = path.basename(l0Rel);
  const l0Num = /-(\d{3})\.md$/.exec(l0Name)?.[1];
  const fileRel = l0Rel.replace(/L0-.*\.md$/, l0Num === undefined ? "L0-ledger-changes.md" : `L0-ledger-changes-${l0Num}.md`);
  // ★ V3（D289）：审计流水也是**记忆** ⇒ 基准 `memoryBase`（收口在这里，调用方不必各自判断）。
  const memBase = memoryBaseOf(info, root);
  const abs = path.resolve(memBase, fileRel);
  if (!isUnder(memBase, abs)) return undefined;
  const who = rec.tag === undefined ? "(无编号)" : rec.tag;
  // ★ kind 如实区分"写"与"归档"：归档是**成批删条目**，与一次写入的追溯含义不同
  //   （"这几条哪去了" vs "谁改的"）。`ledger_log` 的 audit 视图**两个都收**，
  //   所以分开标不会让它漏掉归档 —— 见那里的 `AUDIT_KINDS`。
  // ★★★★★ 2026-10-13（D180）：新增第三个来源 `ledger-principles`（**用户授权**才发生的改动）。
  //   ★ 判据优先级：**显式 `rec.kind` 优先** —— 调用方最清楚这次是什么性质；
  //     没给才退回按 `mode` 推断（保持既有两条路径零改动）。
  // ★★★★★ 2026-10-13（D181）：第四个来源 `ledger-goals`（目标树）。
  // ★★★★★ 2026-10-13（D183）：第五个来源 `ledger-journal`（**只追加的回合流水**）。
  //   ★ 为什么它必须显式列出来（**这是 76④ 当场抓到的真缺口**）：
  //     判据原来只白名单了 principle/goals ⇒ 一次 `target:"journal"` 的写入
  //     会被**静默归成 `ledger-write`** ⇒ 日志里看不出"这条是流水还是台账"。
  //     ⇒ 而"分类记忆"的全部意义就是**在日志里也分得清**（用户要求"分成多个种类"）。
  //   ★ 判据仍是**显式 `rec.kind` 优先**，没给才退回按 `mode` 推断。
  const kind =
    rec.kind === AUDIT_KIND_PRINCIPLE ||
    rec.kind === AUDIT_KIND_GOALS ||
    rec.kind === AUDIT_KIND_JOURNAL
      ? rec.kind
      : rec.mode === "archive"
        ? AUDIT_KIND_ARCHIVE
        : AUDIT_KIND_WRITE;
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

export function logFileList(info) {
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
  // ★★★★★ 2026-10-18（D255）：排序必须**按片号**，不能靠 `rel` 的字典序。
  //
  //   ★ 真缺陷（探针当场抓到的）：`-`(0x2D) < `.`(0x2E) ⇒
  //     `L2-files.md` 会排在 `L2-files-002.md` **之后** ⇒ 跨片回溯时**第 1 片排到最末**。
  //     这在没拆片时看不出来（只有一个文件），一拆就错，而且错得很隐蔽。
  //   ⇒ 正解：同目录同逻辑名的文件，**按 (-NNN) 的数值升序**，第 1 片（无序号）算 1。
  const shardNo = (rel) => {
    const m = /-(\d{3})\.md$/.exec(path.basename(rel));
    return m === null ? 1 : Number(m[1]);
  };
  const logicalOf = (rel) => {
    const b = path.basename(rel);
    const m = /^(.*?)-\d{3}(\.md)$/.exec(b);
    return m === null ? b : `${m[1]}${m[2]}`;
  };
  return out.sort((a, b) => {
    const da = path.dirname(a.rel);
    const db = path.dirname(b.rel);
    if (da !== db) return da < db ? -1 : 1; // 不同期间/目录 ⇒ 仍按路径
    const la = logicalOf(a.rel);
    const lb = logicalOf(b.rel);
    if (la !== lb) return la < lb ? -1 : 1; // 不同档 ⇒ 按逻辑名
    return shardNo(a.rel) - shardNo(b.rel); // 同档 ⇒ **按片号升序**
  });
}

/** 把用户给的时间串补成可与日志行时间戳直接比大小的 `YYYY-MM-DD HH:MM:SS`。 */

export function normTime(raw, isEnd) {
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

export function aggregateFiles(entries) {
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

export function logRead(root, args) {  const info = inspect(root);
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
      // ★ V3（D289）：交接单里"去哪重读"那几行是**指针**，必须指到记忆子目录。
      //   ★ 指针指错 = 下一场按它去 ls 一个都找不到 —— 而交接单的全部价值就是这个指针。
      const memBase = memoryBaseOf(info, root);
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
        (info.decisionsRel === undefined
          ? ""
          : `- 关键决策：\`${path.join(memBase, info.decisionsRel)}\`\n`) +
        (info.logRel === undefined
          ? ""
          : `- 活动日志：\`${path.join(memBase, info.logRel)}\`（用 \`ledger_log\` 按需查）\n`) +
        (info.archiveRel === undefined
          ? ""
          : `- 归档：\`${path.join(memBase, info.archiveRel)}\`\n`);
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
