import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AUDIT_KINDS, AUDIT_KIND_ARCHIVE, AUDIT_KIND_GOALS, AUDIT_KIND_JOURNAL, AUDIT_KIND_LESSONS, AUDIT_KIND_PRINCIPLE, AUDIT_KIND_WRITE, CHECKPOINT_TOOL, CONFORMANCE, DEFAULT_IGNORE_LINES, DEFAULT_READ_LEVELS, LOG_DEFAULT_LIMIT, LOG_LEVEL_NAMES, LOG_MAX_LIMIT, MANIFEST_REL, MAX_ARCHIVE_LIST, MAX_READ_CHARS, NOTE_KINDS, OK_SCHEMA, PRECEDENCE_PROJECT, PRESERVE_HEADING, PRINCIPLE_GRANT_TOOL, PROTOCOL_REQUIREMENTS, PROTOCOL_VERSION, satisfiedProtocolVersion, ROOT_PARAM, name } from "./defs.js";
// ★★★★★ 2026-10-25（D322 · Gemini 审查 004 的 F-09）：**删掉 `import { apply } from "./index.js"`**
//   —— 这是全库唯一一条「partN → 入口模块」的反向边，把依赖图变成强连通环。
//
//   ★ 为什么可以安全删（不是靠猜，是数过）：
//     ① `part4` 里**从未把 `apply` 当函数调用**（`apply(` 在全文出现 **0 次**）；
//     ② 它在 L47 被 `const apply = opts?.apply === true` **立刻同名覆盖** ⇒ 即使保留，
//        那个 import 也**永远不可达**。
//   ⇒ 所以这是一条**纯死代码边**，删它不改变任何行为，却切掉一条反向依赖。
//   ★ 判据：**"依赖环"里有一部分边压根没在用** —— 先摘死边，再谈架构重构。
//     报告把它当"需要解耦"的大工程，实际第一步只是删一行没用的 import。
import { archiveSegmentOf, bodyLineCount, bumpRevision, changeRegisterLine, changeRegisterMaxOf, currentSettings, fnv1a, lockStorePath, lockedRootOf, lostEntries, lostLines, manifestRevision, numOf, precedenceIsProject, precedenceValue, recordBlockHistory, sessionTag, setProjectLock, skeletonOf, splitChangeRegister, tagOfId, weightBlocks, withChangeRegister } from "./part1.js";
import { archiveStamp, conformanceOf, consumePrincipleGrant, countLines, defaultLogLevels, ensureDir, fail, findWorkspaceRoot, git, gitAdd, goalStampMs, handoffFileName, ignoreStateOf, inspect, isAbsoluteAnywhere, isUnder, isUnderReal, logDirOf, logFileRel, lossless, memoryBaseOf, memoryRootIgnoreLines, mergeGitignore, noteFileName, parseGoalCards, parseLevels, parseLogLine, principleGrantOf, projectRootOf, readManifest, readTextSafe, refuseIfMemoryRootUnsafe, renderNote, shouldAutoStage, stageOutcomeOf, stamp, stampSec, toGitRel, writeFileAtomic, writePrinciples } from "./part2.js";
import { noteLedgerTouched, renderResult, rootFromExec } from "./part3.js";
import { migrateToV3, writeSecurityMd } from "./part7.js";
// ★★★★★ 2026-10-23（D303）：清单镜像。**叶子模块**（只依赖 node 内建），故意不 import 任何 partN
//   —— `lib/` 的 import 图高度成环，新模块只依赖 fs/path 就不可能改坏求值顺序（本项目栽过）。
import { syncManifestMirror, writeManifestSynced } from "./manifest-mirror.js";
import { applyFingerprint3, clearProjectCache, ensureProjectId, projectOf, readFingerprint3 } from "./fingerprint.js";
import { backupBeforeWrite } from "./backup.js";
import { refuseMemoryRoleCollision } from "./memory-role-guard.js";
// ★★★★★ 2026-10-23（D307 第二刀 · 现场缺陷修复）：**re-export 不等于在本模块可用。**
//   🔴 病（自检当场撞出，`ReferenceError: cardModeOf is not defined`）：
//     `export { cardModeOf, … } from "./card-ops.js";` 只把名字**再导出去**，
//     **不会**在本模块作用域绑定它们；而 part4 后半段（writeLedger / archiveLedger / logRead …）
//     还在调 `cardModeOf`/`readKindRaw`/`writeKindCard`/`kindLocationOf` 等。
//   ★ 判据：**"能导出" ≠ "能在这里用"** —— 第一刀（part2→base）就是这么红的，第二刀又踩了同一个坑，
//     说明这不是偶发，是**拆模块的固定动作**：凡本模块内部还要调的，必须显式再 import 一次。
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

// ★ 2026-10-23（D307 收尾）：下面两个纯函数已搬去 card-ops（消除双向依赖），调用方不用改。
export { sliceEntryByKey, entryTocOf } from "./card-ops.js";

// ★★★★ 2026-10-30（D368）：`defineInitTool` 已搬到 `lib/init-tool.js`（part4 超紧线）。
//   🔴 **必须显式 import，不许只 re-export** —— 这是本项目拆模块栽过四次的同一个坑：
//     `export { defineInitTool } from "./init-tool.js";` 只把名字**导出去**，
//     **不会**在本模块作用域绑定它；而 `index.js` 若经由 part4 取它，就必须这里有真绑定。
//   ★ 本次实测 `callSites=0` —— part4 内部没有别处调它，但 re-export 仍需保留
//     给外部调用方（`index.js` / 自检都按名字从这里取）。
import { defineInitTool } from "./init-tool.js";
export { defineInitTool } from "./init-tool.js";


export function repairConformance(root, opts) {
  const apply = opts?.apply === true;
  const info = inspect(root);
  // ★★★ 2026-10-24（D317 · GPT 审查 002 的 F02）：**只有 apply 时才拦**。
  //   ★ 为什么干跑要放行：`ledger_conform` 不传 apply 就是"体检 + 告诉我会修什么"，
  //     那件事一个字节都不写 —— 若连干跑都拒，用户就没法**看到**"清单坏了"这个事实，
  //     而这正是最需要看到它的时刻。
  //   ★ 判据：**闸门的位置要贴着"真正落盘"那一步，而不是贴着"这个功能"** ——
  //     贴错位置就会出现"读取也被挡"（D316 的 F-02② 就是这么栽的）。
  if (apply) {
    const unsafeConf = refuseIfMemoryRootUnsafe(info);
    if (unsafeConf !== undefined) return { ...unsafeConf, conformance: conformanceOf(info) };
  }
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

  // ① 补 active（当清单位于半残状态、active 靠盘上猜测命中时，必须补写 active 才能被 readManifest 读回）与 revision
  if (prev.active === undefined && typeof info.activeRel === "string" && info.activeRel !== "") {
    nextManifest.active = info.activeRel;
    manifestTouched = true;
    actions.push(`清单补登记 \`active: "${info.activeRel}"\``);
  }
  if ((info.manifest !== undefined || manifestTouched) && prev.revision === undefined) {
    nextManifest.revision = 0;
    manifestTouched = true;
    actions.push("清单补 `revision: 0`");
  }

  // ② 决策记录（含卡片目录 decisionsDir 与单文件 decisionsRel）
  const decMode = cardModeOf(info, "decisions");
  if (decMode.card === true) {
    const mBase = memoryBaseOf(info, root);
    const dirAbs = path.resolve(mBase, decMode.dirRel);
    if (!isUnderReal(mBase, dirAbs).ok) {
      skipped.push(`决策卡片目录路径逃出项目根，跳过：${decMode.dirRel}`);
    } else if (!fs.existsSync(dirAbs)) {
      if (apply) {
        ensureDir(dirAbs);
        actions.push(`创建卡片目录 \`${decMode.dirRel}\``);
      } else {
        actions.push(`将创建卡片目录 \`${decMode.dirRel}\``);
      }
    }
    if (isUnderReal(mBase, dirAbs).ok && info.decisionsRel !== undefined) {
      const legacyAbs = path.resolve(mBase, info.decisionsRel);
      const existingCards = fs.existsSync(dirAbs) ? listCards(mBase, decMode.dirRel).length : 0;
      if (existingCards === 0 && isUnderReal(mBase, legacyAbs).ok && fs.existsSync(legacyAbs)) {
        const legacyParts = splitIntoCardParts(readTextSafe(legacyAbs) ?? "", "decisions");
        if (legacyParts.length > 0) {
          if (apply) {
            ensureDir(dirAbs);
            for (const p of legacyParts) writeCard(mBase, decMode.dirRel, p.key, p.text, { kind: "decisions" });
            writeCardIndex(mBase, decMode.dirRel, cardDirLabel("decisions"));
            actions.push(`往卡片目录 \`${decMode.dirRel}\` 里补决策卡（共 ${legacyParts.length} 张）`);
          } else {
            actions.push(`将往卡片目录 \`${decMode.dirRel}\` 里补决策卡（共 ${legacyParts.length} 张）`);
          }
        }
      }
    }
  }
  const hasDecisionCards = (() => {
    if (decMode.card !== true) return false;
    const mBase = memoryBaseOf(info, root);
    const dirAbs = path.resolve(mBase, decMode.dirRel);
    return isUnderReal(mBase, dirAbs).ok && fs.existsSync(dirAbs) && listCards(mBase, decMode.dirRel).length > 0;
  })();
  if (info.decisionsRel === undefined) {
    if (decMode.card !== true) skipped.push("连候选名都没找到决策记录：它该叫什么需要 AI 决定（结构问题），本次不动");
  } else if (!hasDecisionCards) {
    const mBase = memoryBaseOf(info, root);
    const abs = path.resolve(mBase, info.decisionsRel);
    let hasLstat = false;
    try {
      fs.lstatSync(abs);
      hasLstat = true;
    } catch {
      hasLstat = false;
    }
    if (!isUnderReal(mBase, abs).ok || (!fs.existsSync(abs) && hasLstat)) {
      skipped.push(`决策记录路径逃出项目根，跳过：${info.decisionsRel}`);
    } else if (fs.existsSync(abs)) {
      if (info.decisionsSource !== "manifest") {
        nextManifest.decisions = info.decisionsRel;
        manifestTouched = true;
        actions.push(`把已存在的决策记录 \`${info.decisionsRel}\` 登记进清单（不改文件内容）`);
      }
    } else if (apply) {
      ensureDir(path.dirname(abs));
      writeFileAtomic(abs, `# 关键决策记录\n\n> 长期决策记在这里，**不参与归档、永久保留**。\n`);
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
    if (!isUnderReal(mBase, abs).ok) {
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
  //   ▶ 其余 9 行详注已抽到 源码注释/part4.md（原 part4.js:204-213）
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
        if (!isUnderReal(mBaseRc, abs).ok) {
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

  // ⑤ ★★★★★ 2026-10-23（D315 · Gemini 审查 001 的 F-03）：**V3 那三项机械修复真的去修。**
  //   ▶ 其余 11 行详注已抽到 源码注释/part4.md（原 part4.js:252-263）
  let mirrorRepairEarly;
  const v3Now = (() => {
    if (typeof info.memoryRoot !== "string" || info.memoryRoot === "") return undefined;
    const mBase = memoryBaseOf(info, root);
    return isUnderReal(root, mBase).ok === true ? mBase : undefined;
  })();
  if (v3Now !== undefined) {
    // ★ 从 **conf.reasons 的文本**判定这三项缺口（`conformanceOf` 只是把 v3 的 reasons
    //   ▶ 其余 2 行详注已抽到 源码注释/part4.md（原 part4.js:271-273）
    const v3Reasons = Array.isArray(conf.reasons) ? conf.reasons : [];
    const wantsSec = v3Reasons.some((r) => String(r).includes("SECURITY.md"));
    const wantsIgnore = v3Reasons.some((r) => String(r).includes(".gitignore"));
    const wantsMirror = v3Reasons.some((r) => String(r).includes("镜像"));

    // ① SECURITY.md（★ 走 `writeSecurityMd` —— 它是**唯一实现**，init / migrate 都走它，
    //    见本文件 1286 行那段注释。我第一版写 `SECURITY_MD_TEXT` 是**想当然**：
    //    那个常量在 part4 **根本不存在**，实际报 `ReferenceError`。
    //    ⇒ 判据：**"我印象里有个常量" ≠ "它在当前模块作用域里"**（与 D307 的 re-export 那条同型）。）
    if (wantsSec) {
      const secAbs = path.resolve(v3Now, "SECURITY.md");
      if (isUnderReal(v3Now, secAbs).ok === true && !fs.existsSync(secAbs)) {
        if (apply) {
          ensureDir(v3Now);
          if (writeSecurityMd(v3Now)) {
            actions.push(`写入 \`${info.memoryRoot}/SECURITY.md\`（正文为插件内置模板）`);
          }
        } else {
          actions.push(`将写入 \`${info.memoryRoot}/SECURITY.md\``);
        }
      }
    }

    // ② .gitignore 补记忆目录忽略行（★ 用现成的 memoryRootIgnoreLines / mergeGitignore，
    //    不在这里再拼一套规则 —— "一个事实一个出口"）
    if (wantsIgnore) {
      const lines2 = memoryRootIgnoreLines(info);
      if (Array.isArray(lines2) && lines2.length > 0) {
        const giAbs = path.join(root, ".gitignore");
        const cur = fs.existsSync(giAbs) ? fs.readFileSync(giAbs, "utf8") : "";
        const curLines = cur.split("\n");
        const need = lines2.filter((ln) => !curLines.some((l) => l.trim() === ln.trim()));
        // ★★★ 2026-10-23（D316 · Gemini 审查 002 的 GAP-02）：**"行存在" ≠ "忽略生效"**。
        //
        //   🔴 病（自检 `117①c` 的场景）：`.gitignore` 里已有 `/mem-memory/`，但**后面**又有一行
        //     `!mem-memory/` 把它反选掉了。此时 `need` 算出 `[]` ⇒ 这一段整个跳过
        //     ⇒ `ledger_conform({apply:true})` 回 `{changed:false, actions:[]}`，
        //     **而合规检查仍报"可修"** ⇒ 用户照着修了个寂寞。
        //   ★ 判据：**Git 的忽略规则是"最后一条匹配的赢"** —— 所以判断"生效了吗"必须看
        //     **最后一次提到这一个模式的那一行**是忽略还是反选，不能只看"有没有出现过"。
        //   ⇒ 修法：若最后一次匹配是 `!xxx`（反选）⇒ 必须在**末尾**再追加一次忽略行把它压回去。
        //
        // ★★★★★ 2026-10-24（D317 · GPT 审查 002 的 F05）：**改调唯一出口 `ignoreStateOf`。**
        //   🔴 原来这里自己写了个 `negatedLast()`，它只比**字面目录名**（`bcore === core`）；
        //     而检测侧（`v3-conformance`）认 `*` 通配 ⇒ 两侧判据分叉 ⇒
        //     `*` 后跟通配反选这种真正常见的套路**检测说"可修"、修复却不动**。
        //   ★ 而那条路的风险是**真的**：`*` 加通配反选（"忽略一切但保留目录结构"）
        //     会把 `/mem-memory/` 重新纳回 ⇒ **记忆目录变得可被 `git add`** ⇒ 一次手滑就是隐私泄露。
        //   ⇒ 判据：**同一个事实只能有一个出口**；两套判据必然分叉，而分叉比两边都错更难查。
        const needForNegation = lines2.filter((ln) => {
          const st = ignoreStateOf(ln.replace(/^\/+/, "").replace(/\/+$/, ""), cur);
          return st.ignored !== true; // 没命中 或 最后一条是反选 ⇒ 都要在末尾压回去
        });
        // ★ 注意口径：`need` 判的是"这一行**文本**在不在"，`needForNegation` 判的是
        //   "**忽略是否真生效**"。后者为真时即使前者为空也必须动手 —— 这正是 GAP-02/F05 的缺口。
        if (need.length > 0) {
          if (apply) {
            mergeGitignore(root, lines2);
            actions.push(`往 \`.gitignore\` 追加 ${need.map((x) => `\`${x}\``).join("、")}`);
          } else {
            actions.push(`将往 \`.gitignore\` 追加 ${need.map((x) => `\`${x}\``).join("、")}`);
          }
        } else if (needForNegation.length > 0) {
          // 行在，但被后面的 `!` 反选了 ⇒ 必须在末尾再压一次（Git 只看最后一条匹配）
          const extra = needForNegation;
          if (apply) {
            // ★ 不走 mergeGitignore：它以"行已存在"为由什么都不做（那正是这个 bug）。
            let next = cur;
            if (next !== "" && !next.endsWith("\n")) next += "\n";
            next += "\n# 由 dsh-ledger-memory 追加（覆盖上面的 ! 反选行）\n";
            for (const l of extra) next += l + "\n";
            const _wGi = writeFileAtomic(giAbs, next);
            if (_wGi.ok !== true) return { ok: false, reason: "repairConformance: .gitignore 修复失败: " + String(_wGi.reason ?? "原子写失败") };
            actions.push(
              `在 \`.gitignore\` 末尾重新压回 ${extra.map((x) => `\`${x}\``).join("、")}` +
                "（原有那条被后面的 `!` 反选行覆盖，Git 只认最后一条匹配）",
            );
          } else {
            actions.push(
              `将在 \`.gitignore\` 末尾重新压回 ${extra.map((x) => `\`${x}\``).join("、")}` +
                "（原有那条被后面的 `!` 反选行覆盖，Git 只认最后一条匹配）",
            );
          }
        }
      }
    }

    // ③ 清单镜像（与"根清单"同步；权威 = 内存里的 nextManifest）
    if (wantsMirror && apply && !manifestTouched) {
      if (!nextManifest.projectId) nextManifest.projectId = ensureProjectId(nextManifest).projectId;
      const text = JSON.stringify(nextManifest, null, 2) + "\n";
      const mr = syncManifestMirror(root, nextManifest, text);
      if (mr !== undefined && mr.skipped !== true) {
        mirrorRepairEarly = mr;
        if (mr.ok !== false && mr.changed === true) {
          actions.push(`用权威清单重写镜像 \`${info.memoryRoot}/.dsh-ledger.json\``);
        }
      }
    } else if (wantsMirror && !apply) {
      actions.push(`将用权威清单重写镜像 \`${info.memoryRoot}/.dsh-ledger.json\``);
    }
  }

  // ⑥ 超阈值 / 卡片化这类：**不动**，交给 AI（挑条目、切卡都是判断）
  if (conf.needsAI.length > 0) {
    for (const n of conf.needsAI) skipped.push(`留给 AI：${n}`);
  }

  let wroteManifest = false;
  // ★ D315：`mirrorRepairEarly` 是 ⑤ 里镜像修复先写下的结果，这里再并进来 ——
  //   两处都可能写镜像（"根清单变了"与"镜像本身缺口"），必须先确保根清单写成功后再同步镜像。
  let mirrorRepair = mirrorRepairEarly;
  if (apply && manifestTouched) {
    if (!nextManifest.projectId) nextManifest.projectId = ensureProjectId(nextManifest).projectId;
    const w = writeManifestSynced(root, nextManifest);
    clearProjectCache();
    if (w.ok !== true) {
      return {
        ok: false,
        reason: `改写权威清单失败（这一次**什么都没改成**）：${w.reason || "未知"}`,
        conformance: conf,
        actions,
        skipped,
      };
    }
    wroteManifest = true;
    mirrorRepair = w.mirror;
    if (
      v3Now !== undefined &&
      Array.isArray(conf.reasons) &&
      conf.reasons.some((r) => String(r).includes("镜像")) &&
      w.mirror !== undefined &&
      w.mirror.ok !== false &&
      w.mirror.changed === true
    ) {
      actions.push(`用权威清单重写镜像 \`${info.memoryRoot}/.dsh-ledger.json\``);
    }
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
    // ★ 2026-10-23（D303）：镜像同步结果如实回报（只在 V3 且真写了清单时出现）。
    ...(mirrorRepair === undefined || mirrorRepair.skipped === true
      ? {}
      : {
          manifestMirror: {
            path: mirrorRepair.path,
            changed: mirrorRepair.changed === true,
            ...(mirrorRepair.failed === undefined ? {} : { failed: mirrorRepair.failed }),
          },
        }),
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
      //   ▶ 其余 7 行详注已抽到 源码注释/part4.md（原 part4.js:480-487）
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

  const mBase = memoryBaseOf(info, root);
  for (const c of candidates) {
    const abs = path.resolve(mBase, c.rel);
    if (!isUnderReal(mBase, abs).ok) continue;
    const rawText = readTextSafe(abs);
    if (rawText === undefined) continue;
    const text = readFingerprint3(rawText).ok
      ? applyFingerprint3(rawText, undefined, { strip: true }).text
      : rawText;
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
  //   ▶ 其余 4 行详注已抽到 源码注释/part4.md（原 part4.js:537-541）
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

  // ── ③ 结构化旧字段的迁移（D198：目标卡缺 `- 更新于:`，兼容卡片与单文件模式）──
  {
    const gLoc = kindLocationOf(info, "goals");
    const gRaw = gLoc.rel !== undefined ? readKindRaw(root, info, "goals").raw : "";
    if (gRaw.trim() !== "") {
      const cards = parseGoalCards(gRaw);
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
        let gf = files.find((f) => f.rel === gLoc.rel);
        if (gf === undefined) {
          gf = { rel: gLoc.rel, role: "goals", lines: countLines(gRaw), hits: [] };
          files.push(gf);
        }
        gf.hits.push(missing);
        problem.push({ ...missing, rel: gLoc.rel, role: "goals", total: cards.length });
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
        //   ▶ 其余 4 行详注已抽到 源码注释/part4.md（原 part4.js:684-688）
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
        editable: {
          type: "boolean",
          description: "Read the same editor snapshot as the project board: exact entry keys, fields and etag. Use its etag as ledger_write.ifMatch for conflict-checked edits. Read-only; principles remain protected and journal history cannot be replaced.",
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

      // Board and tool share the same snapshot/CAS service; legacy reads retain their shape.
      if (args?.editable === true) {
        try {
          const editorService = await import("./board-model.js");
          const selected = editorService.boardRead(root, target, args?.entry ?? "");
          const entries = editorService.boardInventory(root).rows.find((row) => row.kind === target)?.items ?? [];
          if (typeof selected.text === "string" && selected.text.length > numOf("maxReadChars", MAX_READ_CHARS)) {
            return { ok: false, reason: "编辑快照超过单次回读预算。请用 entries 中的精确 key 指定一条；不会给截断正文发放可保存的 etag。", entries };
          }
          const result = { ...selected, entries };
          // HTTP permits reason:null, but the registered tool output schema permits only strings.
          if (result.reason == null) delete result.reason;
          return lossless(result);
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error), status: error?.status ?? 400 };
        }
      }

      if (target === "manifest") {
        const raw = readTextSafe(info.manifestPath);
        return { ok: true, target, path: info.manifestPath, found: raw !== undefined, text: raw ?? null };
      }
      const watchFields =
        target === "archive"
          ? ["archiveDir"]
          : target === "decisions"
            ? ["decisionsDir", "decisions"]
            : target === "lessons"
              ? ["lessonsDir", "lessons"]
              : target === "goals"
                ? ["goalsDir", "goals"]
                : [target];
      const unsafeRead = refuseIfMemoryRootUnsafe(info, watchFields);
      if (unsafeRead !== undefined) return unsafeRead;
      if (target === "archive") {
        if (info.archiveRel === undefined) {
          return { ok: true, target, found: false, reason: "no archive directory registered" };
        }
        // ★ V3（D289）：归档目录与归档文件都是**记忆** ⇒ 基准 `memoryBase`。
        const mBase = memoryBaseOf(info, root);
        const dir = path.resolve(mBase, info.archiveRel);
        if (!isUnderReal(mBase, dir).ok) throw fail("ledger_read: 归档目录逃出了项目根");

        // ★ D138：两个可调上限（读长 + 列表条数）—— 面板改了必须真生效。
        const arcMax = numOf("maxReadChars", MAX_READ_CHARS);
        const arcListMax = numOf("maxArchiveList", MAX_ARCHIVE_LIST);

        const rel = typeof args?.archiveFile === "string" ? args.archiveFile.trim() : "";
        if (rel !== "") {
          if (isAbsoluteAnywhere(rel)) throw fail(`ledger_read: 归档文件必须是相对路径：${rel}`);
          let file = path.resolve(mBase, rel);
          if (!fs.existsSync(file) && typeof info.memoryRoot === "string" && info.memoryRoot !== "") {
            const normRel = rel.replace(/\\/g, "/");
            const normMem = info.memoryRoot.replace(/\\/g, "/").replace(/\/+$/, "");
            if (normRel.startsWith(`${normMem}/`)) {
              const alt = path.resolve(mBase, normRel.slice(normMem.length + 1));
              if (isUnderReal(dir, alt).ok && fs.existsSync(alt)) file = alt;
            }
          }
          if (!isUnderReal(dir, file).ok) {
            const inArchiveDir = path.resolve(dir, rel);
            if (isUnderReal(dir, inArchiveDir).ok && fs.existsSync(inArchiveDir)) {
              file = inArchiveDir;
            }
          }
          if (!isUnderReal(dir, file).ok || path.resolve(file) === path.resolve(dir)) {
            throw fail(`ledger_read: 归档文件不在归档目录之内：${rel}`);
          }
          const rawOnDisk = readTextSafe(file);
          if (rawOnDisk === undefined) return { ok: true, target, found: false, path: file };
          const raw = readFingerprint3(rawOnDisk).ok
            ? applyFingerprint3(rawOnDisk, undefined, { strip: true }).text
            : rawOnDisk;
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
            if (e.isSymbolicLink()) continue;
            const p = path.join(d, e.name);
            if (!isUnderReal(dir, p).ok) continue;
            if (e.isDirectory()) walk(p, depth + 1);
            else {
              let bytes = 0;
              try {
                bytes = fs.statSync(p).size;
              } catch {
                /* 拿不到就是 0 */
              }
              files.push({ path: toGitRel(mBase, p), bytes });
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
              //   ▶ 其余 4 行详注已抽到 源码注释/part4.md（原 part4.js:950-954）
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
      if (!isUnderReal(mBaseR, abs).ok) throw fail("ledger_read: 目标逃出了项目根");
      const fileMax = numOf("maxReadChars", MAX_READ_CHARS);
      // ★ 卡片模式：`raw` = 拼出来的整份（按文件名序）；单文件模式：老实读那个文件。
      const rawOnDisk = cardWhole !== undefined ? cardWhole.raw : readTextSafe(abs);
      if (rawOnDisk === undefined) return { ok: true, target, found: false, path: abs };
      const raw =
        cardWhole === undefined && readFingerprint3(rawOnDisk).ok
          ? applyFingerprint3(rawOnDisk, undefined, { strip: true }).text
          : rawOnDisk;

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

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★★ 2026-10-23（D307 第二刀）：上面那一整段**卡片操作**已搬到 `lib/card-ops.js`。
//   ★ 调用方一个都不用改 —— 下面把它们**原样再导出**。
//   ★★ 为什么这里必须「既 import 又 export」（第一刀踩过的坑）：
//     `export { … } from "./card-ops.js"` 只把名字**再导出去**，
//     **不会**在本模块作用域里绑定它们 —— 而本文件后面还在用 `readKindRaw` / `writeKindCard` 等。
//     只 re-export 不 import ⇒ 运行期 `ReferenceError`（自检当场撞出过一次）。
// ═══════════════════════════════════════════════════════════════════════════
export {
  isSafeCardKey,
  cardDirAbs,
  cardDirIsSafe,
  cardFileAbs,
  listCards,
  readCard,
  writeCard,
  removeCard,
  renderCardToc,
  buildCardBlocks,
  renderCardIndex,
  writeCardIndex,
  cardModeOf,
  kindToRel,
  readEntryUnified,
  cardDirLabel,
  readKindRaw,
  writeKindCard,
  removeKindCard,
  kindLocationOf,
  splitFileIntoCards,
  splitIntoCardParts,
  registerCardDirInManifest,
} from "./card-ops.js";


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
      // ★★★★★ 2026-10-23（D310，审计员010 F-02 实锤）：**卡片目录在记忆面 ⇒ 扫描与写盘都用 `memoryBase`。**
      //   🔴 病（真实生产复现）：本项目 299 张决策卡，`ledger_index({kind:"decisions"})` 恒回 `count:0`；
      //     若带 `op:"write"`，还会在**项目根**建出 `decisions/INDEX.md` —— 物理隔离被击穿。
      //   ★★ 与 F-01 是**同一个病**（读侧/写侧基准不一致），只是这条同时**会写**，所以危害更大。
      const memBase = memoryBaseOf(info, root);
      // ★★★ 2026-10-25（D317 · Gemini 审查 004 F-01③）：`ledger_index(op:"write")` 也要拦越界。
      //   🔴 病：`memBase` 在 `memoryRoot` 越界时降级回源码根 ⇒ 本分支会在**源码根**建 `decisions/INDEX.md`。
      //   ★ 注意：本函数那条 D310 注释说的是"卡片目录在记忆面 ⇒ 用 memoryBase"——**那是对的**，
      //     但它假定 `memoryBase` 本身可信；越界时这个假定不成立 ⇒ 必须在算出 `memBase` 之后再加一道。
      const r = renderCardIndex(memBase, mode.dirRel, { limit });
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
      const unsafeIdx = refuseIfMemoryRootUnsafe(info);
      if (args?.op === "write" && unsafeIdx !== undefined) {
        return { ...base, wrote: false, writeError: unsafeIdx.reason };
      }
      if (args?.op === "write") {
        const label = kind === "decisions" ? "关键决策" : kind === "lessons" ? "经验与教训" : "目标树";
        const w = writeCardIndex(memBase, mode.dirRel, label, { limit });
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
      "Staged with `git add -- <path>` when autoGitAdd is on. " +
      "For an existing single entry, first ledger_read(editable:true), then pass its etag as ifMatch and the exact entry key. " +
      "This shares the board editor, validates fields and rejects conflicts without overwriting. " +
      "preview:true validates and returns formatted text without writing; goals/lessons require this editor path. Principles are never writable through the editor.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        target: {
          type: "string",
          enum: ["active", "decisions", "principles", "journal", "goals", "lessons"],
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
        content: { type: "string", description: "The content to write. In the conflict-checked editor, supply either content or fields, never both." },
        entry: { type: "string", description: "Exact editor entry key from ledger_read(editable:true). Requires ifMatch. Omit for the whole singleton file; card collections cannot be overwritten as a whole." },
        ifMatch: { type: "string", description: "Exact etag from the editor snapshot. A stale token is rejected, not merged. Never obtain a fresh token and replay an old draft without reviewing the changes." },
        preview: { type: "boolean", description: "With ifMatch, validate and format without writing. Not an authorization grant." },
        fields: {
          type: "object",
          description: "Structured editor fields from ledger_read(editable:true). Format is generated by the shared board service. IDs and storage paths cannot be changed here.",
          properties: {
            title: { type: "string" }, body: { type: "string" },
            parent: { type: "string" }, status: { type: "string", enum: ["root", "active", "paused", "done", "dropped"] },
            kr: { type: "array", items: { type: "string" } }, lessons: { type: "array", items: { type: "string" } },
            type: { type: "string", enum: ["经验", "教训"] }, kind: { type: "string" },
            symptom: { type: "string" }, cause: { type: "string" }, source: { type: "string" },
            fix: { type: "string" }, scope: { type: "string" }, files: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
        mode: {
          type: "string",
          enum: ["replace", "append"],
          description: "Legacy defaults: active replaces, decisions/journal append. With ifMatch, explicitly choose replace or append; replace edits only the selected entry, and journal replacement is rejected.",
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
      required: ["target"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const editor = args?.ifMatch !== undefined || args?.fields !== undefined || args?.entry !== undefined || args?.preview === true;
      let r;
      if (editor) {
        try {
          const editorService = await import("./board-model.js");
          const root = rootFromExec(exec, args);
          const input = { ...args, kind: args.target };
          r = args?.preview === true ? editorService.boardPreview(root, input) : editorService.boardWrite(root, input, state, exec);
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error), status: error?.status ?? 400 };
        }
      } else {
        if (args?.target === "goals" || args?.target === "lessons") {
          return { ok: false, reason: "目标和经验教训的编辑必须先 ledger_read(editable:true)，带 ifMatch 保存；新增请用 ledger_goals / ledger_lessons。" };
        }
        if (typeof args?.content !== "string") return { ok: false, reason: "content 必须是字符串；结构化 fields 仅适用于带 ifMatch 的编辑入口。" };
        r = writeLedger(rootFromExec(exec, args), args, exec, state);
      }
      // ★ 记回执：工具返回值只发给 AI，用户看不到"台账被改过"。
      //   攒起来，等下一次真正弹卡片时带给用户（见 noteLedgerTouched 的说明）。
      if (r.ok === true && args?.preview !== true) noteLedgerTouched(state, exec, r);
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
  //   ▶ 其余 3 行详注已抽到 源码注释/part4.md（原 part4.js:1360-1363）
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
  // ★★★★ 统一走 refuseIfMemoryRootUnsafe（同时拦截坏清单 manifest、memoryRoot 越界及当前 target 字段越界）
  const watchFields = target === "decisions" ? ["decisionsDir", "decisions"] : [target];
  const unsafeMem = refuseIfMemoryRootUnsafe(info, watchFields);
  if (unsafeMem !== undefined) return { ...unsafeMem, unsafeManifestPath: unsafeMem.unsafeManifestPath };
  const roleCollision = refuseMemoryRoleCollision(root, info, target);
  if (roleCollision !== undefined) return roleCollision;
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
      const w = writeCard(memBase, cmode.dirRel, p.key, p.text, { kind: "decisions" });
      if (w.ok !== true) return { ok: false, reason: `写卡片 ${p.key} 失败：${w.reason}`, mode: "card", written: writtenKeys };
      writtenKeys.push(p.key);
    }
    let indexed = false;
    try {
      indexed = writeCardIndex(memBase, cmode.dirRel, cardDirLabel("decisions"), {}).ok === true;
    } catch {
      /* 索引只是缓存 */
    }
    const newRevision = bumpRevision(root);
    if (info.logRel !== undefined) {
      try {
        appendAudit(root, info, {
          tag,
          target: "decisions",
          mode,
          relPath: cmode.dirRel,
          lines: writtenKeys.length,
          revision: newRevision,
          sessionId: exec?.agent?.session?.header?.id,
        });
      } catch {
        /* 审计失败绝不影响卡片写入本身 */
      }
    }
    return {
      ok: true,
      mode: "card",
      target: "decisions",
      dir: cmode.dirRel,
      written: writtenKeys.length,
      cards: writtenKeys,
      indexRefreshed: indexed,
      ...(newRevision === undefined ? {} : { revision: newRevision }),
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
    //   ▶ 其余 3 行详注已抽到 源码注释/part4.md（原 part4.js:1635-1638）
    if (r.ok === true && grant !== undefined) {
      consumePrincipleGrant(state, sidForGrant);
    }
    return r;
  }

  // ★ V3（D289）：台账 / 决策 / 流水都是**记忆** ⇒ 基准 `memoryBase`（在函数开头已取，
  //   见那里关于 TDZ 的注释）。校验也用同一基准。
  const abs = path.resolve(memBase, relPath);
  if (!isUnderReal(memBase, abs).ok) return { ok: false, target, reason: "ledger_write: 目标逃出了项目根", path: abs, unsafePath: true };

  const rawExisting = readTextSafe(abs);
  if (rawExisting === undefined && !createIfMissing) {
    return { ok: false, reason: `文件不存在且 createIfMissing 为假：${relPath}` };
  }
  const r3Ex = rawExisting !== undefined ? readFingerprint3(rawExisting) : { ok: false };
  const existing = rawExisting !== undefined && r3Ex.ok
    ? applyFingerprint3(rawExisting, undefined, { strip: true }).text
    : rawExisting;
  const r3In = readFingerprint3(content);
  const cleanContent = r3In.ok ? applyFingerprint3(content, undefined, { strip: true }).text : content;

  let next;
  if (mode === "append") {
    // ★★ `append` 必须**追加到正文末尾**，不能追加到文件末尾 ────────────────
    //   ▶ 其余 4 行详注已抽到 源码注释/part4.md（原 part4.js:1663-1667）
    const base = splitChangeRegister(existing ?? "").body;
    if (base === "") next = cleanContent;
    else next = (base.endsWith("\n") ? base : base + "\n") + (cleanContent === "" ? "" : "\n" + cleanContent);
  } else {
    next = cleanContent;
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
  //   ▶ 其余 27 行详注已抽到 源码注释/part4.md（原 part4.js:1726-1753）
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
  //   ▶ 其余 8 行详注已抽到 源码注释/part4.md（原 part4.js:1776-1784）
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
  //   ▶ 其余 2 行详注已抽到 源码注释/part4.md（原 part4.js:1798-1800）
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
  //   ★ 修法：改走 `writeFileAtomic`（同目录独占临时文件 → 原子 rename）。
  //     语义保证：**要么旧版本完整可读，要么新版本完整写入，绝不留半截**。
  //   ★ 失败必须**如实报**（D167：不许把失败说成成功）——所以这里直接 return ok:false，
  //     而不是"吞掉继续往下走然后报成功"。
  // ★★★★ 2026-10-30（D366）：覆盖前先存一份"上一个已知好版本"（详见 lib/backup.js 头注）。
  //   ★ 位置必须在 writeFileAtomic **之前**，且用**刚读到的 `existing`**（不重读）：
  //     否则会出现"备份的是 B、覆盖的是 A"的窗口 ⇒ 备份与它声称保护的那一版不一致。
  //   ★ 失败**绝不阻断写入**（同加指纹的纪律），但结果要带进回执让调用方看见。
  const backup = target === "journal" || target === "decisions" || target === "active"
    ? backupBeforeWrite({ memBase, rel: relPath, prevText: rawExisting, forceHot: true })
    : { ok: false, skipped: true, reason: "非单例目标" };
  const rawFpW = r3Ex.ok
    ? { kind: target, project: r3Ex.id.project ?? projectOf(root), key: "-" }
    : r3In.ok
      ? { project: projectOf(root) ?? r3In.id.project }
      : undefined;
  const fpIdW =
    rawFpW !== undefined
      ? { kind: rawFpW.kind ?? target, project: projectOf(root) ?? rawFpW.project, key: rawFpW.key ?? "-" }
      : undefined;
  const cleanChars = next.length;
  if (fpIdW !== undefined && fpIdW.project !== undefined) next = applyFingerprint3(next, fpIdW).text;
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
  //   ▶ 其余 4 行详注已抽到 源码注释/part4.md（原 part4.js:1869-1873）
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
  // ★★★★★ 2026-10-22（V3 §3.1）：**问中央判据**，不再各自写 `autoGitAdd !== false`。
  //   旧条件的默认值是 true ⇒ V3 项目（记忆在子目录）照样会去 stage。
  if (shouldAutoStage(info).allow) {
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
    chars: cleanChars,
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
    // ★ D366：如实报备份结果 —— 静默会让下一个（含我自己）**以为有备份**而放心做破坏性操作。
    ...(backup?.ok === true ? { backup: backup.rel } : {}),
    ...(backup?.ok === true || backup?.skipped === true ? {} : { backupFailed: backup?.reason ?? "未知" }),
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
    //   ▶ 其余 2 行详注已抽到 源码注释/part4.md（原 part4.js:1951-1953）
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
  // ★★★ 2026-10-23（D316 · GAP-01）：`memoryRoot` 越界 ⇒ 拒绝，不降级写回源码根。
  const unsafeMem = refuseIfMemoryRootUnsafe(info, ["active", "archiveDir"]);
  if (unsafeMem !== undefined) return unsafeMem;
  const roleCollision = refuseMemoryRoleCollision(root, info, "active");
  if (roleCollision !== undefined) return roleCollision;
  if (info.activeRel === undefined || info.archiveRel === undefined) {
    return { ok: false, reason: "这个项目还没有登记台账结构，先 ledger_init。", hint: "ledger_init" };
  }
  const rawEntries = typeof args?.entries === "string" ? args.entries : "";
  const entries = readFingerprint3(rawEntries).ok ? applyFingerprint3(rawEntries, undefined, { strip: true }).text : rawEntries;
  const rawNewActive = typeof args?.newActive === "string" ? args.newActive : "";
  const r3NewActive = readFingerprint3(rawNewActive);
  const newActive = r3NewActive.ok ? applyFingerprint3(rawNewActive, undefined, { strip: true }).text : rawNewActive;
  if (entries.trim() === "") {
    return { ok: false, reason: "entries 为空 —— 没有东西要归档。" };
  }

  // ★ V3（D289）：归档目录与活跃台账都是**记忆** ⇒ 基准 `memoryBase`。
  const memBase = memoryBaseOf(info, root);
  const archiveAbs = path.resolve(memBase, info.archiveRel);
  const activeAbs = path.resolve(memBase, info.activeRel);
  if (!isUnderReal(memBase, archiveAbs).ok) return { ok: false, reason: "ledger_archive: 归档目录逃出了项目根", path: archiveAbs, unsafePath: true };
  if (!isUnderReal(memBase, activeAbs).ok) return { ok: false, reason: "ledger_archive: 活跃台账逃出了项目根", path: activeAbs, unsafePath: true };

  const now = new Date();
  const { dir, label: periodLabel } = archiveStamp(now, info.manifest?.archiveWeekMode);
  const periodDir = path.join(archiveAbs, dir);

  const stem = path.basename(info.activeRel, path.extname(info.activeRel)) || "ledger";
  const archiveFile = path.join(periodDir, `${stem}-archive.md`);

  // ══ ★★★ A2 修复（2026-10-11，审计 002/003 坐实后先写会红用例再改）════════
  //   ▶ 其余 5 行详注已抽到 源码注释/part4.md（原 part4.js:2072-2077）

  // ── ① `ifRevision` 陈旧保护（A2 的另一半）────────────────────────────────
  //   ▶ 其余 5 行详注已抽到 源码注释/part4.md（原 part4.js:2079-2084）
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
  const rawPriorActive = readTextSafe(activeAbs) ?? "";
  const r3Prior = readFingerprint3(rawPriorActive);
  const priorActive = r3Prior.ok ? applyFingerprint3(rawPriorActive, undefined, { strip: true }).text : rawPriorActive;
  const beforeLines = bodyLineCount(priorActive);
  const bodyLines = countLines(newActive);
  let registered = withChangeRegister(
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
      archiveFile: toGitRel(memBase, archiveFile),
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
  //   ▶ 其余 2 行详注已抽到 源码注释/part4.md（原 part4.js:2237-2239）
  const bodySha = createHash("sha256")
    .update(entries.replace(/\s+$/, ""), "utf8")
    .digest("hex")
    .slice(0, 12);
  const batchMark = `<!-- batch:${bodySha} -->`;
  const rawPrevArchive = readTextSafe(archiveFile) ?? "";
  const r3Arch = readFingerprint3(rawPrevArchive);
  const prevArchive = r3Arch.ok ? applyFingerprint3(rawPrevArchive, undefined, { strip: true }).text : rawPrevArchive;
  const alreadyArchived = prevArchive.includes(batchMark);

  ensureDir(periodDir);
  if (!alreadyArchived) {
    // ★ 只追加：读旧内容 + 本批，接在后面。**从不重写整段历史。**
    //   ▶ 其余 2 行详注已抽到 源码注释/part4.md（原 part4.js:2252-2254）
    const heading =
      `\n\n## ${stamp(now)} 归档` +
      `${typeof args?.label === "string" && args.label !== "" ? `（${args.label}）` : ""} ` +
      `${batchMark}\n\n`;
    const prefix = prevArchive === "" ? `# 台账归档 · ${periodLabel}\n` : "";
    // ★ D266：归档文件走统一原子写（原来手抄了一份 tmp+rename —— 手抄就是分叉的开始）
    const fpArchProj = r3Arch.ok ? (projectOf(root) ?? r3Arch.id.project) : undefined;
    const fpOptArch =
      r3Arch.ok && fpArchProj !== undefined
        ? { fp: { kind: r3Arch.id.kind ?? "archive", project: fpArchProj, key: r3Arch.id.key ?? "-" } }
        : undefined;
    const archWrite = writeFileAtomic(archiveFile, prevArchive + prefix + heading + entries.replace(/\s+$/, "") + "\n", fpOptArch);
    if (archWrite.ok !== true) {
      return { ok: false, reason: `写归档文件失败（活跃台账尚未改动）：${archWrite.reason ?? "未知"}`, atomic: true };
    }
  }
  // ★★★★★ 2026-10-18（D266 · 修 review F06 的第二处）：**归档改的是活跃台账，同样必须原子写**。
  //   ★ 顺序也要保：**归档文件先落地，active 才改**（否则 active 变了、归档没写成 ⇒ 内容凭空消失）。
  // ★★★★ D366：归档也会**整份重写活跃台账** ⇒ 同样必须先留上一版。
  //   ★★ 这正是两次事故（D362/D365）的真实发生地 —— 都是 `newActive` 写坏。
  const backup = backupBeforeWrite({ memBase, rel: info.activeRel, prevText: rawPriorActive, forceHot: true });
  const rawFpAct = r3Prior.ok
    ? { kind: "active", project: projectOf(root) ?? r3Prior.id.project, key: "-" }
    : r3NewActive.ok
      ? { project: projectOf(root) ?? r3NewActive.id.project }
      : undefined;
  const fpIdAct =
    rawFpAct !== undefined
      ? { kind: rawFpAct.kind ?? "active", project: rawFpAct.project, key: rawFpAct.key ?? "-" }
      : undefined;
  if (fpIdAct !== undefined && fpIdAct.project !== undefined) registered = applyFingerprint3(registered, fpIdAct).text;
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
  // ★★★★★ 2026-10-22（V3 §3.1）：**问中央判据**，不再各自写 `autoGitAdd !== false`。
  //   旧条件的默认值是 true ⇒ V3 项目（记忆在子目录）照样会去 stage。
  if (shouldAutoStage(info).allow) {
    // ★ 注意这里有一条**会被 ignore 规则挡住的路径**：归档文件在 `_ledger-archive/` 下，
    //   ▶ 其余 2 行详注已抽到 源码注释/part4.md（原 part4.js:2329-2331）
    const wanted = [toGitRel(root, archiveFile), info.activeRel];
    const r = gitAdd(root, wanted);
    staging = stageOutcomeOf(r, wanted);
    staged = staging.staged;
  }

  return {
    ok: true,
    archivedTo: toGitRel(memBase, archiveFile),
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
    ...(backup?.ok === true ? { backup: backup.rel } : {}),
    ...(backup?.ok === true || backup?.skipped === true ? {} : { backupFailed: backup?.reason ?? "未知" }),
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
  if (typeof l0Rel !== "string" || l0Rel === "") return undefined;
  const l0Name = path.basename(l0Rel);
  const l0Num = /-(\d{3})\.md$/.exec(l0Name)?.[1];
  const fileRel = l0Rel.replace(/L0-.*\.md$/, l0Num === undefined ? "L0-ledger-changes.md" : `L0-ledger-changes-${l0Num}.md`);
  // ★ V3（D289）：审计流水也是**记忆** ⇒ 基准 `memoryBase`（收口在这里，调用方不必各自判断）。
  const memBase = memoryBaseOf(info, root);
  const abs = path.resolve(memBase, fileRel);
  if (!isUnderReal(memBase, abs).ok) return undefined;
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
    rec.kind === AUDIT_KIND_JOURNAL ||
    rec.kind === AUDIT_KIND_LESSONS
      ? rec.kind
      : rec.mode === "archive"
        ? AUDIT_KIND_ARCHIVE
        : AUDIT_KIND_WRITE;
  const line =
    `- ${stampSec(now)} (${kind}) [${who}] ${rec.target} ${rec.mode} → \`${rec.relPath}\` ` +
    `${rec.lines} 行` +
    (rec.revision === undefined ? "" : ` · revision→${rec.revision}`) +
    (typeof rec.sessionId === "string" && rec.sessionId !== "" ? ` · \`${rec.sessionId}\`` : "");
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) return undefined;
  } catch {
    /* ENOENT ok */
  }
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
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (!isUnderReal(info.logAbs, abs).ok) continue;
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
      const rel = toGitRel(memoryBaseOf(info, info.projectRoot), abs);
      // 期间键取自相对 logAbs 的路径里的 `YYYY-MM` 段（防止项目目录名含 YYYY-MM 污染 period）。
      const period = /(\d{4}-\d{2})/.exec(toGitRel(info.logAbs, abs))?.[1];
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
  //   ▶ 其余 8 行详注已抽到 源码注释/part4.md（原 part4.js:2584-2592）
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
  //   ▶ 其余 3 行详注已抽到 源码注释/part4.md（原 part4.js:2681-2684）
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
  //   ▶ 其余 5 行详注已抽到 源码注释/part4.md（原 part4.js:2714-2719）
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
// ★★★★ 2026-10-26（D328）：这三个工具已**整块搬出**到 `workspace-tools.js`（给本文件腾容量）。
//   ★ 调用面零改动：`index.js` / `tools/` 里 `from "./part4.js"` 的 import 一个字都不用改。
//   ★ 判据：**搬家可以，改调用面不行**（D307/D318/D319/D323/D326 同一做法）。
export { defineNoteTool, defineHandoffTool, defineLockTool } from "./workspace-tools.js";
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
