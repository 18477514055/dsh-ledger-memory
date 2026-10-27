import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MANIFEST_MIRROR_NAME, manifestMirrorPath, syncManifestMirror, verifyManifestMirror } from "./manifest-mirror.js";
import { DEFAULT_IGNORE_LINES, MANIFEST_REL, STASH_DIR, satisfiedProtocolVersion} from "./defs.js";
import {
  detectTrackedMemory,
  ensureDir,
  isAbsoluteAnywhere,
  isUnderReal,
  memoryRootIgnoreLines,
  mergeGitignore,
  moveAcrossVolumes,
  readManifest,
  stamp,
  stampSec,
  writeFileAtomic,
} from "./part2.js";

/**
 * ★★★★★ 2026-10-23（D301 · 审计员 010 阶段一）：**记忆目录内部安全原则的唯一正文。**
 *
 * ★★★ 为什么从 `part4.js` 搬到 `part7.js`（**不是搬着玩**）：
 *   `ledger_init` 会建 `SECURITY.md`，而 `migrateToV3` **一个字都不建** ——
 *   同一个事实写在两处、只有一处实现，迁移上来的项目就永久缺这份文件
 *   （任务书 §3.6 要求"在专用记忆目录内建立"，没说"只有新建项目才建"）。
 *
 *   ★ 本项目的既有判据（D59）：**收口不收，必漏一路**。
 *     所以修法不是"给迁移补一段"，而是**把正文提出来，两条路共用同一份** ——
 *     这样下次改这份安全说明，只有一处要改，也不可能再分叉。
 *   ★ 附带收益：`part4.js` 从 261,197 B 降到 ~258.6K（它本来只剩 **947 B** 余量，
 *     正卡在 262,144 打包上限上）。搬走这段 2.5K 正文 ⇒ **两条路都受益**。
 */
export const SECURITY_MD_TEXT = [
  "# 内部项目记忆区域安全原则（SECURITY.md）",
  "",
  "> **【面向模型的安全约束 · 必须遵守】**",
  "> 本目录是**内部项目记忆区域**，由插件管理。以下约束适用于本目录及其全部内容。",
  "",
  "1. **区域性质**：本目录供本插件与模型在本地会话中维护项目的长期状态，**不是**项目源码的一部分。",
  "2. **含敏感内容**：本目录包含项目的长期上下文、可能的**使用者原话**（如 L4 逐字日志）、",
  "   未脱敏的运行报错与内部决策等敏感信息。",
  "3. **不得自行公开或外传**：不得将本目录内任何数据**公开**、**复制**到发布目录或打包产物、",
  "   或搬到任何对外可读的路径。",
  "4. **不得自行提交或推送**：不得对本目录文件执行 Git **暂存**、**提交**或**推送**。",
  "   ★ 使用者定过一条原则：「所有来自本插件构建的东西，除非使用者亲自允许，否则绝对不允许模型自己推送到云端。」",
  "5. **共享须明确授权**：确需导出或共享记忆数据（调试、跨环境迁移等），**必须获得使用者的明确授权**；",
  "   未获授权一律禁止。",
  "6. **源码提交隔离**：项目源码的正常 Git 提交**不应包含**任何记忆数据；两者必须在版本控制层面解耦。",
  "",
  "---",
  "",
  "## 边界（必读，别把它当成银弹）",
  "",
  "7. **这不是 Git 隔离的唯一实现**。本文件只负责让模型**理解**安全原则；",
  "   真正的隔离由三层共同承担：",
  "   · 目录与源码**物理分离**（`<项目名>-ledger-memory/`）；",
  "   · 插件代码里的**结构性拒绝暂存**（V3 项目一律不自动 `git add`，见 `shouldAutoStage`）；",
  "   · 项目根 `.gitignore` 的**忽略规则**。",
  "8. **技术边界要诚实**：`.gitignore` + 本地钩子 + 插件代码，**无法在数学意义上保证**",
  "   任意外部程序、强制添加（`git add -f`）、跳过钩子（`--no-verify`）或直接复制文件不泄露。",
  "   一旦记忆内容被推到公开仓库，本地迁移**无法撤回**远端历史、Fork、缓存或其他副本 ——",
  "   若曾泄露过凭据，还需另行撤销或轮换。",
  "",
  "## 典型场景",
  "",
  "- **打包 / 构建时**：确认输出目录里没有记忆文件被脚本误复制进去。",
  "- **执行 Git 操作前**：先看 `git status`，确认暂存区里没有任何记忆子目录内的文件。",
  "- **生成对外材料时**：若需引用记忆内容，先脱敏并改写成摘要，**不要直接复制敏感原文**。",
  "",
].join("\n");

/**
 * 在记忆目录内建 `SECURITY.md`（**幂等 + 绝不覆盖**）。
 *
 * ★ 判据与 `ensureFile` 一致：**已存在就跳过** —— 用户可能自己改过这份文件。
 * @returns {boolean} 是否真的写了（调用方用它决定要不要记进 `written`）
 */
export function writeSecurityMd(memAbs) {
  const abs = path.resolve(memAbs, "SECURITY.md");
  if (!isUnderReal(memAbs, abs).ok) return false;
  try {
    fs.lstatSync(abs);
    return false;
  } catch {
    /* 路径尚不存在（含非悬空符号链接）⇒ 允许新建 */
  }
  if (fs.existsSync(abs)) return false;
  ensureDir(path.dirname(abs));
  return writeFileAtomic(abs, SECURITY_MD_TEXT).ok === true;
}

/**
 * ★★★★★ 2026-10-21（D295 · V3 阶段 3）：**事务化迁移 V2 → V3。**
 *
 * 🔴 为什么必须事务化（任务书 §5.2 禁止「两个可被同时写入的权威源」）：
 *
 *   最直观的做法是「边搬边改」—— 把 `LEDGER.md` 搬到子目录，改一行清单，再搬下一个。
 *   **那样会在中途出现一个状态：一部分记忆在根、一部分在子目录，而清单只说得清一半。**
 *   那一刻如果中断（或有人写入），就**同时存在两个权威源** —— 之后没人能说清哪个是真的。
 *
 * ⇒ 本实现的核心性质：**切换点只有「改清单」那一次原子写。**
 *   在这之前，**旧清单仍指旧位置** ⇒ 插件行为**完全没变** ⇒ 中断在任何一步都能安全重试。
 *
 * 五个阶段（每个阶段都可重入）：
 *   ① 影子目录 `<项目名>-ledger-memory.partial/`
 *   ② 全量复制 + **逐项校验**（文件数 / 每个文件的 sha256）
 *   ③ **原子改名**（`.partial` → 正式名）—— 一次 `rename`，要么全成要么全不成
 *   ④ **最后一步才改清单**（`memoryRoot`）
 *   ⑤ 旧文件搬到 `$DSH_HOME\plugin-data\dsh-ledger-memory\_retired\<项目名>\`（**不是删除**）
 *
 * ★★★ 三个刻意的设计选择：
 *
 *   · **干跑是默认**（不传 `apply` 就只出计划）。这是"先看再动"的保证 ——
 *     迁移是唯一会移动真实记忆的操作，不该有一个"手一滑就执行"的默认。
 *   · **校验不过就不改名**。带着坏副本往前冲，比不迁更糟。
 *   · **旧文件搬到 `_retired`，不删**。用户拍板：挪到插件数据目录下按项目名归档。
 *     理由：迁移本身可能出错，**删了就不可逆**；而留着只占磁盘。
 *
 * @param {string} projectRoot 项目根
 * @param {{apply?:boolean, stopBeforeManifest?:boolean, dryRun?:boolean}} [opts]
 */
export function migrateToV3(projectRoot, opts) {
  const apply = opts?.apply === true;
  const manifestPath = path.join(projectRoot, MANIFEST_REL);
  const manifest = readManifest(projectRoot) ?? {};

  // ★ 已经是 V3 ⇒ 明确说「不用迁」。**不许重复搬**（那会造出第二个权威源）。
  if (typeof manifest.memoryRoot === "string" && manifest.memoryRoot !== "") {
    return {
      ok: false,
      reason: `这个项目**已经是 V3 形态**（清单里 memoryRoot = ${manifest.memoryRoot}），无需迁移。`,
      alreadyV3: true,
    };
  }
  if (Object.keys(manifest).length === 0) {
    if (fs.existsSync(manifestPath)) {
      return {
        ok: false,
        reason: "项目根的清单（.dsh-ledger.json）损坏或缺少必填的 `active` 字段 —— 拒绝迁移（请先修复清单，不要当成未初始化覆盖）。",
        manifestBroken: true,
      };
    }
    return { ok: false, reason: "没有清单（.dsh-ledger.json）—— 这个项目还没建台账，先 ledger_init。" };
  }

  const baseName = path.basename(projectRoot);
  const memDirName = `${baseName}-ledger-memory`;
  const memAbs = path.join(projectRoot, memDirName);
  const partialAbs = `${memAbs}.partial`;

  // ★ 要搬的东西：**清单里登记过的 + 记忆目录本身**。
  //   判据：清单说「这一类记忆在哪」就说搬哪 —— 不猜、不扩大范围。
  const rels = [];
  const pushRel = (v) => {
    if (typeof v === "string" && v !== "" && !rels.includes(v)) rels.push(v);
  };
  pushRel(manifest.active);
  pushRel(manifest.decisions);
  pushRel(manifest.decisionsDir);
  pushRel(manifest.journal);
  pushRel(manifest.goals);
  pushRel(manifest.goalsDir);
  pushRel(manifest.lessons);
  pushRel(manifest.lessonsDir);
  pushRel(manifest.principles);
  pushRel(manifest.archiveDir);
  pushRel(manifest.logDir);
  pushRel(STASH_DIR); // 分流细节
  pushRel(manifest.handoffDir ?? "_handoff");
  // ★★★ 2026-10-23（D315 · Gemini 审查 001 的 F-06①）：**扩展记忆目录也必须搬。**
  //   🔴 病：迁移前已建的自定义扩展住在 `<项目根>/extensions/`，而 `part8.js` 迁移后
  //      改去 `<memoryRoot>/extensions/` 找 ⇒ **原有扩展记忆全部失联**，
  //      而且那份目录还留在源码根（暴露在会被 `git add` / 打包的位置）。
  //   ★ 判据：**"这一类记忆住在哪"的口径改了，所有取它的地方都得跟着改** ——
  //      这不是"漏了一个目录"，是"迁移清单与读取口径不一致"。
  pushRel("extensions");

  const existing = rels.filter((r) => fs.existsSync(path.join(projectRoot, r)));
  if (existing.length === 0) {
    return { ok: false, reason: "清单里登记的路径一个都不存在 —— 没有东西可迁（先确认台账结构）。" };
  }

  // ★ 边界：只搬**项目内**的相对路径。绝对路径 / 越界一律拒绝（清单是用户可编辑的）。
  for (const r of existing) {
    if (isAbsoluteAnywhere(r) || r.split(/[\\/]/).some((s) => s === "..")) {
      return { ok: false, reason: `清单里的路径 \`${r}\` 不是项目内的相对路径 —— 拒绝迁移（先修清单）。` };
    }
  }

  // ★★★★ 2026-10-24（D317 · GPT 审查 002 的 F03）：**真实路径边界 + 符号链接一律拒绝。**
  //
  //   🔴 病：上面那道只查**路径文本**（绝对路径 / `..`）。而真正危险的是**文本规范但实体越界**：
  //     项目里一个 `ledger/` 目录是符号链接 → 指向 `D:\某个外面的大文件夹`。
  //     文本上看它规规矩矩在项目内，`isUnder` 也过 —— 而 `fs.statSync` / `readdirSync` / `copyFileSync`
  //     **全都跟随链接** ⇒ 迁移会把**项目外的内容复制进**项目记忆目录。
  //   ★ 判据：**词法在项目内 ≠ 实体在项目内**（这正是 `isUnderReal` 存在的理由）。
  //     而这里连 `isUnderReal` 都不够 —— 因为它只判"目标路径的实体在不在根内"，
  //     判不出"中途某一级是个链接"。
  //   ⇒ 修法（宁可拒绝，不做"聪明的跟随"）：
  //     ① 对待迁移的每个 rel 逐级 `lstat`，**任何一级是符号链接就拒绝**；
  //     ② 再用 `isUnderReal(projectRoot, abs)` 兜一道（覆盖 rel 本身是链接的情况）。
  //   ★ 为什么直接拒绝而不是"支持链接但审计"：迁移是一次性、不可轻易回退的操作；
  //     链接语义（相对/绝对、跨卷、成环、目标后来又变）无法在一次检查里定死。
  //     判据：**一次性且不可回退的操作，宁可拒绝也不做"聪明的省略"。**
  const linkRejected = [];
  const checkNoNestedSymlink = (dirAbs) => {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      const p = path.join(dirAbs, e.name);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        return false;
      }
      if (st.isSymbolicLink() || !isUnderReal(projectRoot, p).ok) return false;
      if (st.isDirectory() && !checkNoNestedSymlink(p)) return false;
    }
    return true;
  };
  for (const r of existing) {
    const segs = r.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
    let cur = projectRoot;
    for (const seg of segs) {
      cur = path.join(cur, seg);
      let st;
      try {
        st = fs.lstatSync(cur);
      } catch {
        break; // 中途不存在 ⇒ 后面 copyInto 会如实失败
      }
      if (st.isSymbolicLink()) { linkRejected.push(r); break; }
    }
    if (linkRejected.includes(r)) continue;
    const absR = path.join(projectRoot, r);
    const rr = isUnderReal(projectRoot, absR);
    if (rr.ok !== true) { linkRejected.push(r); break; }
    try {
      if (fs.lstatSync(absR).isDirectory() && !checkNoNestedSymlink(absR)) {
        linkRejected.push(r);
        break;
      }
    } catch {
      /* ignore */
    }
  }
  if (linkRejected.length > 0) {
    return {
      ok: false,
      reason:
        `这些待迁移的路径**不是项目内的实体路径**（中间有符号链接，或真实位置在项目外）：${linkRejected
          .map((x) => `\`${x}\``)
          .join("、")}\n` +
        "★ 为什么整件事都不做：迁移会 `statSync` / `readdirSync` / `copyFileSync`，**这三者都跟随链接** ——\n" +
        "  那会把**项目外的内容复制进**你的记忆目录，而且你从清单上看不出来。\n" +
        "★ 修法：把那些链接换成真目录（或把它们移出清单）后重跑。**清单与原记忆现在一个字节都没动。**",
      symlinked: linkRejected,
    };
  }

  // ── ① 计划 ────────────────────────────────────────────────────────────────
  const plan = {
    target: memDirName,
    moves: existing.map((r) => ({ from: r, to: `${memDirName}/${r}` })),
  };

  // ★★★★★ 2026-10-23（D301 · 任务书 §3.3）：**迁移前先查「旧记忆是否已被 Git 追踪」。**
  //
  //   🔴 010 查出的真缺口：原实现里 `detectTrackedMemory` **0 命中** ⇒
  //     旧文件若已被 `git add` / `commit` 过，迁移会**静默**把它们搬走，
  //     索引里留下一堆 staged deletion，而用户**得不到任何告警**。
  //
  //   ★ 边界（照 D293 已定的纪律，绝不越）：**只查、只报，绝不动手。**
  //     `git rm --cached` / `filter-repo` / force push 三件事都不可逆，
  //     没有一件能由插件替用户决定 —— 这里只把后果和三条路写出来。
  //
  //   ★★ 它**不阻断迁移**（刻意）：迁移本身是可逆的（旧文件进 `_retired`），
  //     而"因为历史里有过记忆就拒绝迁移"会让用户卡死在一个更差的状态里。
  //     判据：**能修的先修，改不了历史的如实报出来 + 给路。**
  const trackedCheck = detectTrackedMemory(projectRoot);

  if (!apply) {
    return {
      ok: true,
      dryRun: true,
      plan,
      // ★ 干跑阶段就把风险摊开 —— 让用户"先看再动"时看得到全部后果。
      ...(trackedCheck.ok === true && trackedCheck.tracked.length > 0
        ? {
            trackedWarning: {
              count: trackedCheck.tracked.length,
              paths: trackedCheck.tracked.slice(0, 20),
              truncated: trackedCheck.tracked.length > 20,
              advice: trackedCheck.advice,
            },
          }
        : trackedCheck.ok !== true
          ? { trackedCheckFailed: trackedCheck.reason }
          : {}),
      note: "干跑：只出计划，**一个字节都没写**。确认后传 apply: true。",
    };
  }

  // ── ② 复制到影子目录 + 逐项校验 ───────────────────────────────────────────
  //
  // ★ 为什么用 `.partial` 而不是直接写正式名：
  //   复制过程中若中断，正式名目录会**半满**，而之后没人能分清"半满"与"本来就少"。
  //   `.partial` 这个名字本身就是"我还没做完"的标记。
  const hashOf = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

  /** 递归列出 rel 下所有文件（相对 root）。 */
  const listFiles = (root, rel) => {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return [rel];
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(path.relative(root, p).split(path.sep).join("/"));
      }
    };
    walk(abs);
    return out;
  };

  /** 把 root 下的 rel 复制到 destRoot 下的同一 rel。 */
  const copyInto = (destRoot, rel) => {
    const from = path.join(projectRoot, rel);
    const to = path.join(destRoot, rel);
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      ensureDir(to);
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        copyInto(destRoot, `${rel}/${e.name}`);
      }
    } else {
      ensureDir(path.dirname(to));
      fs.copyFileSync(from, to);
    }
  };

  // ★ 重入：若上次留下 `.partial`，先清掉重来（它是"没做完"的产物，不是真数据）
  if (fs.existsSync(partialAbs)) {
    fs.rmSync(partialAbs, { recursive: true, force: true });
  }
  ensureDir(partialAbs);

  const expected = [];
  for (const rel of existing) {
    for (const f of listFiles(projectRoot, rel)) {
      expected.push({ rel: f, size: fs.statSync(path.join(projectRoot, f)).size, hash: hashOf(path.join(projectRoot, f)) });
    }
    copyInto(partialAbs, rel);
  }

  // ★★★ 2026-10-21（D295 · **仅供探针使用的故障注入点**）：
  //   为什么生产代码里要留一个"能故意造坏"的入口？
  //
  //   🔴 因为**校验那段代码在正常路径上永远不会失败**。我第一次做反向验证时，
  //     注入"跳过校验"的回归 ⇒ 探针**照样全绿** —— 那段代码**根本没被执行过**。
  //     （正常复制不会坏，而旧 `.partial` 又会被主动清掉，所以造不出坏副本。）
  //   ⇒ 纪律 10 的直接应用：**看不见红的断言不是断言**。
  //     要让"校验不过就不改名"这条**可被验证**，就必须有一个**能让复制真的坏掉**的入口。
  //
  //   ★ 它**只在显式传 `injectCorruptCopy` 时动作**，生产永远不传 ⇒ 零风险。
  //   ★ 名字里带 `inject` 是刻意的：任何人看到都知道这是测试钩子，不是功能。
  if (opts?.injectCorruptCopy === true) {
    const victim = expected[0];
    if (victim !== undefined) {
      fs.writeFileSync(path.join(partialAbs, victim.rel), "★ 被故意写坏的内容（探针注入）\n", "utf8");
    }
  }

  // ★★★ 校验：**逐文件比 sha256**，不是只比数量。
  //   比数量只能发现"少复制了"，发现不了"内容坏了"。
  const problems = [];
  for (const e of expected) {
    const p = path.join(partialAbs, e.rel);
    if (!fs.existsSync(p)) {
      problems.push(`缺文件：${e.rel}`);
      continue;
    }
    const st = fs.statSync(p);
    if (st.size !== e.size) {
      problems.push(`大小不符：${e.rel}（${e.size} → ${st.size}）`);
      continue;
    }
    if (hashOf(p) !== e.hash) problems.push(`内容不符：${e.rel}`);
  }
  if (problems.length > 0) {
    // ★ 校验不过 ⇒ **不改名、不改清单**，把影子目录留着便于排查。
    return {
      ok: false,
      reason: `复制校验未通过（${problems.length} 项）⇒ **没有改名、没有改清单**，旧结构原样可用。`,
      problems: problems.slice(0, 20),
      partialPath: partialAbs,
    };
  }

  // ── ③ 原子改名 ────────────────────────────────────────────────────────────
  //
  // ★ `rename` 在同一卷上是原子的：要么整个目录出现在正式名下，要么完全没有。
  //
  // ★★★★ 2026-10-24（D317 · GPT 审查 002 的 F01 —— **这条是它报得最准的一条**）：
  //
  //   🔴 病（原写法）：目标已存在就**直接沿用并删掉校验过的影子副本**。
  //     可"目标已存在"有**两种**来历，而当时只按好的那一种处理：
  //       ① 上次 `rename` 成功但后续中断 ⇒ 沿用它是对的（那就该接着做完）；
  //       ② **用户/别的工具早就建了那个目录**（空的、半满的、或是过期的旧台账），
  //          甚至**它是指向项目外的符号链接** ⇒ 沿用它 = 把权威清单指向一份**从未校验过的内容**，
  //          然后把源码根上那批真数据搬进 `_retired`（读路径上就"消失"了）。
  //   ★ 判据：**"文件在不在" 与 "文件对不对" 是两件事。**
  //     我们对 `.partial` 做了逐文件 sha256 校验，却**没对最终被采用的那个目录做同样的校验** ——
  //     等于把校验做在了**不被使用的那一份**上。这是"验了影子、没验本体"。
  //   ⇒ 修法：目标已存在时，**拿它跟已校验的 `expected` 逐项比对**（文件集 + 大小 + sha256）；
  //     一致才沿用；不一致 ⇒ `ok:false`，**清单与原记忆一个字节都不动**，并把差异报出来。
  //   ★ 另外：目标若是符号链接，即使内容对也不沿用 —— `rename` 语义与后续写入都会跟着链接跑。
  let memLst;
  try {
    memLst = fs.lstatSync(memAbs);
  } catch (e) {
    if (e?.code !== "ENOENT") {
      return { ok: false, reason: `正式目标目录读不出属性：${String((e && e.message) || e)}`, targetDir: memAbs };
    }
  }
  if (memLst === undefined) {
    fs.renameSync(partialAbs, memAbs);
  } else {
    // ① 目标不得是符号链接（含悬空符号链接：existsSync 对悬空链接返 false，必须先过 lstatSync）
    const lst = memLst;
    if (lst.isSymbolicLink()) {
      return {
        ok: false,
        reason:
          `正式目标 \`${memDirName}\` 是一个**符号链接** ⇒ 拒绝迁移（清单与原记忆都没动）。\n` +
          "★ 为什么不继续：后续所有记忆写入都会跟着这个链接跑到它指向的地方 —— 那是把记忆写到项目外。\n" +
          "★ 修法：把那个链接删掉（或改成一个真目录）后重跑。",
        targetDir: memAbs,
        partialPath: partialAbs,
      };
    }
    // ② 目标内部不得含嵌套符号链接/目录联接，且必须与"已校验过的那一份"**双向逐项一致**（既不少文件，也不多出未知文件）
    if (!isUnderReal(projectRoot, memAbs).ok || !checkNoNestedSymlink(memAbs)) {
      return {
        ok: false,
        reason: `正式目标 \`${memDirName}\` 内部含有符号链接或指向项目外 ⇒ 拒绝迁移（清单与原记忆都没动）。`,
        targetDir: memAbs,
        partialPath: partialAbs,
      };
    }
    const mismatched = [];
    const expectedSet = new Set(expected.map((e) => e.rel));
    for (const e of expected) {
      const p = path.join(memAbs, e.rel);
      if (!fs.existsSync(p)) { mismatched.push(`缺文件：${e.rel}`); continue; }
      const st = fs.statSync(p);
      if (st.size !== e.size) { mismatched.push(`大小不符：${e.rel}（应有 ${e.size}，实为 ${st.size}）`); continue; }
      if (hashOf(p) !== e.hash) mismatched.push(`内容不符：${e.rel}`);
    }
    for (const actualRel of listFiles(memAbs, ".")) {
      if (actualRel === "SECURITY.md" || actualRel === ".dsh-ledger.json") continue;
      if (!expectedSet.has(actualRel)) {
        mismatched.push(`多出未知文件：${actualRel}`);
      }
    }
    if (mismatched.length > 0) {
      return {
        ok: false,
        reason:
          `正式目标 \`${memDirName}\` **已经存在，但它的内容与这次迁移要写的不一致**（${mismatched.length} 项）\n` +
          "⇒ **没有沿用、没有改清单、没有搬走任何原记忆**，源码根上的旧结构原样可用。\n" +
          "★ 为什么不沿用：那个目录可能是空的 / 半截的 / 过期的旧台账，甚至是被别的东西建的。\n" +
          "  沿用它等于把权威清单指向一份**从未校验过的内容**，而你源码根上那批真数据会被搬进 `_retired`\n" +
          "  （文件还在，但读路径上「消失」了）。\n" +
          "★ 修法（二选一）：① 把那个目录改名留档（例如 `_old-memory`）后重跑迁移；\n" +
          "  ② 确认它就是你要的，再手工把源码根那批记忆并进去 —— 但那是**你的判断**，插件不替你做。",
        targetDir: memAbs,
        problems: mismatched.slice(0, 20),
        partialPath: partialAbs,
      };
    }
    // 一致 ⇒ 上次确实做完了改名，影子目录是多余产物，清掉
    fs.rmSync(partialAbs, { recursive: true, force: true });
  }

  // ★★ 探针用的"在改清单之前停下"—— 模拟中断，验证旧清单仍可用。
  if (opts?.stopBeforeManifest === true) {
    return {
      ok: false,
      stoppedBeforeManifest: true,
      reason:
        "已在**改清单之前**停下（这是刻意模拟的中断）。★ 清单没变 ⇒ 插件仍按旧位置工作 ⇒ 重跑可接着做完。",
      targetDir: memAbs,
    };
  }

  // ── ④ 安全收口（**必须在改清单之前**）──────────────────────────────────────
  //
  // ★★★★★ 2026-10-23（D301 · 任务书 §3.2 / §3.6）：**这两件事原来一件都没做。**
  //
  //   🔴 010 查出的两个 P0 缺口（`part7.js` 全文 `mergeGitignore` 0 命中、`SECURITY` 0 命中）：
  //     · 迁移上来的项目，其记忆子目录**完全没被 Git 忽略** ⇒ 一次 `git add .` 就全量进仓库；
  //     · 记忆目录里**没有 `SECURITY.md`** ⇒ 模型永远不知道那块区域是禁发区。
  //
  //   ★★ 为什么放在"改清单"之前而不是之后：改清单是**唯一的切换点**，
  //     之后清单就说"记忆住在 memDirName"了。若此时 ignore 还没配好，
  //     就存在一个"权威源已搬家、但保护还没生效"的窗口 —— 而窗口里的任何一次 `git add`
  //     都会把新目录整个收进去。**先上锁，再开门。**
  //
  //   ★ 为什么失败不阻断：`.gitignore` 写不进去（权限/只读）不该让迁移半途而废 ——
  //     那时记忆已经搬完、清单还没改，用户会停在一个"两边都不像"的状态。
  //     ⇒ **如实记录失败原因，继续迁移**，最后在回执里报出来（而不是静默吞掉）。
  let ignoreResult;
  let ignoreError;
  try {
    // ★ 与 `ledger_init` **同一个函数、同一张表、同一条 V3 规则**（D59：收口不收必漏一路）。
    const v3Lines = memoryRootIgnoreLines({ memoryRoot: memDirName, projectRoot });
    ignoreResult = mergeGitignore(projectRoot, [...DEFAULT_IGNORE_LINES, ...v3Lines]);
  } catch (e) {
    ignoreError = String((e && e.message) || e);
  }

  let securityWritten = false;
  let securityError;
  try {
    securityWritten = writeSecurityMd(memAbs);
  } catch (e) {
    securityError = String((e && e.message) || e);
  }

  // ── ⑤ 最后一步：改清单（唯一的切换点）────────────────────────────────────
  // ★ 顺手把 `autoGitAdd` 落成 `false`（任务书 §3.1「第三代默认关闭自动暂存」）：
  //   `shouldAutoStage()` 对 V3 本来就**无条件拒绝**，所以这个值**不改变行为**，
  //   但清单里留着一个 `true` 会让后来读它的人/工具误以为"这项目还在自动暂存"。
  //   010 把这条列为"高危残留"是**口径过重**（它不生效），但**值确实是错的** ⇒ 一并改正。
  const next = {
    ...manifest,
    memoryRoot: memDirName,
    autoGitAdd: false,
    // ★★★ 2026-10-23（D315 · Gemini 审查 001 的 F-06②）：**必须把 protocolVersion 一起升上去。**
    //   🔴 病：原来只写 `memoryRoot` ⇒ 迁移完的项目 `protocolVersion` 仍停在旧值 ⇒
    //      `ledger_status` 报 `protocolVersion: 2 / effectiveVersion: 3` **互相矛盾**。
    //   ★ 这是"迁移只做了一半"：**搬了文件、改了布局，却没把"我是第几代"这个事实写下来**。
    //     ⇒ 判据：**凡"把项目升代"的操作，必须同时更新"声明代次"的那个字段** ——
    //       否则下一代的所有判据都会按旧代去读它。
    protocolVersion: satisfiedProtocolVersion({ ...manifest, memoryRoot: memDirName }),
    updatedAt: stamp(new Date()),
  };
  const manifestText = `${JSON.stringify(next, null, 2)}\n`;
  const w = writeFileAtomic(manifestPath, manifestText);
  if (w?.ok === false) {
    return { ok: false, reason: `改清单失败：${w.reason || "未知"}`, targetDir: memAbs };
  }
  // ★★★★★ 2026-10-23（D303）：迁移是**第一次**让清单拥有 memoryRoot 的地方 ⇒
  //   镜像必须在这一刻建出来（否则迁移完的项目要等到下一次写入才有镜像）。
  //   ★ 写序：根已成功 ⇒ 才碰镜像。
  const mirror = syncManifestMirror(projectRoot, next, manifestText);

  // ── ⑥ 旧文件搬到 _retired（**不是删除**）──────────────────────────────────
  //
  // ★ 用户拍板：旧文件挪到 `$DSH_HOME\plugin-data\dsh-ledger-memory\_retired\<项目名>\`。
  //   ★ 为什么不删：迁移本身可能出错，**删了就不可逆**；留着只占磁盘。
  //   ★ 为什么不留在项目里：那会与记忆目录形成**两个权威源**（任务书 §5.2 明令禁止）。
  let retiredTo;
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
    const retiredRoot = path.join(home, "plugin-data", "dsh-ledger-memory", "_retired", baseName);
    retiredTo = path.join(retiredRoot, stampSec(new Date()).replace(/[: ]/g, "-"));
    ensureDir(retiredTo);
    for (const rel of existing) {
      const from = path.join(projectRoot, rel);
      if (!fs.existsSync(from)) continue;
      const to = path.join(retiredTo, rel);
      ensureDir(path.dirname(to));
      // ★★★★★ 2026-10-23（D310，审计员010 F-05 实锤）：**跨卷安全移动**。
      //   🔴 原来是裸 `fs.renameSync`。本机 `$DSH_HOME` 在 C:、项目常在 D:
      //     ⇒ 必抛 `EXDEV: cross-device link not permitted`（实测复现）。
      //     后果：清单已指向新位置、旧文件却还在根目录 ⇒ **两份可写的权威源**。
      //   ★ `moveAcrossVolumes`：同卷 rename（原子）；跨卷「复制 → 字节校验 → 才删源」；
      //     失败时**源文件一定还在**（不会用"我以为复制成功了"换掉唯一副本）。
      const mv = moveAcrossVolumes(from, to);
      if (mv.ok !== true) {
        // ★ 单个文件搬不动就**如实中断**并报出原因，不静默跳过 ——
        //   静默跳过正是"双权威源"的来源（搬了 3 个、漏了 1 个，没人知道）。
        throw new Error(`${mv.reason}（文件：${rel}）`);
      }
    }
  } catch (e) {
    // ★ 搬旧文件失败**不影响迁移本身**（清单已经指向新位置）—— 但要如实报出来。
    return {
      ok: true,
      targetDir: memDirName,
      manifestUpdated: true,
      retireFailed: String((e && e.message) || e),
      ...(mirror === undefined || mirror.skipped === true
        ? {}
        : { manifestMirror: { path: mirror.path, created: mirror.created === true, ...(mirror.failed === undefined ? {} : { failed: mirror.failed }) } }),
      ...(ignoreResult === undefined ? {} : { gitignore: ignoreResult }),
      ...(ignoreError === undefined ? {} : { gitignoreFailed: ignoreError }),
      securityMdWritten: securityWritten,
      ...(securityError === undefined ? {} : { securityMdFailed: securityError }),
      ...(trackedCheck.ok === true && trackedCheck.tracked.length > 0
        ? { trackedWarning: { count: trackedCheck.tracked.length, paths: trackedCheck.tracked.slice(0, 20), advice: trackedCheck.advice } }
        : {}),
      note: "迁移已生效（清单已指向新位置），但**旧文件的归档搬运失败** —— 请手动处理，别让两份共存。",
    };
  }

  return {
    ok: true,
    targetDir: memDirName,
    manifestUpdated: true,
    retiredTo,
    fileCount: expected.length,
    // ★★★ 2026-10-23（D303）：镜像落点与结果（迁移是第一次产生 memoryRoot 的地方）。
    ...(mirror === undefined || mirror.skipped === true
      ? {}
      : {
          manifestMirror: {
            path: mirror.path,
            created: mirror.created === true,
            changed: mirror.changed === true,
            ...(mirror.failed === undefined ? {} : { failed: mirror.failed }),
          },
        }),
    // ★★★ 三个安全动作的**如实回报**（这正是 010 查出的缺口：做了没做，外面都得看得见）。
    ...(ignoreResult === undefined ? {} : { gitignore: ignoreResult }),
    ...(ignoreError === undefined ? {} : { gitignoreFailed: ignoreError }),
    securityMdWritten: securityWritten,
    ...(securityError === undefined ? {} : { securityMdFailed: securityError }),
    ...(trackedCheck.ok === true && trackedCheck.tracked.length > 0
      ? {
          trackedWarning: {
            count: trackedCheck.tracked.length,
            paths: trackedCheck.tracked.slice(0, 20),
            truncated: trackedCheck.tracked.length > 20,
            advice: trackedCheck.advice,
          },
        }
      : trackedCheck.ok !== true
        ? { trackedCheckFailed: trackedCheck.reason }
        : {}),
    note:
      "迁移完成。★ 旧文件已搬到 `_retired`（**没删**），项目根上不再有记忆文件 ⇒ 只有一个权威源。" +
      (ignoreResult === undefined && ignoreError === undefined ? "" : " ★ 记忆目录已被 .gitignore 保护。") +
      (securityWritten ? " ★ 已在记忆目录内建立 SECURITY.md。" : ""),
  };
}
