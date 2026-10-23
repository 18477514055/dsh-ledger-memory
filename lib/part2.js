import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
// ★★★★★ 2026-10-23（D307 现场缺陷修复）：**re-export 不等于在本模块里可用。**
//   🔴 病（自检当场撞出，`ReferenceError: readTextSafe is not defined` @ part2.js:3682）：
//     `export { readTextSafe, … } from "./base.js";` 只把名字**重新导出**，
//     **不会**在本模块作用域绑定它们。而 part2 自己还在用 `readTextSafe`（9 处）、
//     `ensureDir`（6 处）、`memoryBaseOf`（14 处）、`fail`（8 处）…
//   ★ 判据：**"能导出" ≠ "能在这里用"** —— 在 ESM 里这是两件事，我把它们当成了一件。
//     ⇒ 拆模块时，凡是**本模块内部还要调**的，必须显式再 import 一次（与 re-export 并存，合法且必要）。
import {
  archiveStamp,
  countLines,
  ensureDir,
  fail,
  isUnder,
  isUnderReal,
  lossless,
  memoryBaseOf,
  readTextSafe,
  stamp,
  stampSec,
  toGitRel,
  writeFileAtomic,
} from "./base.js";
import { AUDIT_KIND_GOALS, AUDIT_KIND_PRINCIPLE, CANDIDATE_RE, CAPSULE_ARTIFACT_MAX, CAPSULE_ERROR_CHARS, CAPSULE_MAX_CHARS, CAPSULE_USER_MSG_CHARS, CAPSULE_USER_MSG_MAX, CONFORMANCE, CONTAINER_CACHE_TTL_MS, CONTAINER_MARKERS, CONTAINER_MIN_SUBDIRS, CONTAINER_SCAN_DEPTH, CONTAINER_SCAN_FANOUT, DEFAULT_GOALS_NAME, DEFAULT_HANDOFF_DIR, DEFAULT_JOURNAL_NAME, DEFAULT_LESSONS_NAME, DEFAULT_NOTES_DIR, DEFAULT_PRINCIPLES_NAME, EXPERIENCE_KINDS, GOAL_RENDER_MAX, GOAL_STATUSES, GOAL_STATUS_LABEL, HANDOFF_DIR_CANDIDATES, L2_READ_SPEC, L2_TOUCHED_SPEC, LESSON_KINDS, LESSON_TYPES, LOG_ENTRY_RE, LOG_FLUSH_DEBOUNCE_MS, LOG_LEVEL_FILES, LOG_LEVEL_NAMES, LOG_SHARD_MAX_BYTES, LOG_SHARD_MAX_COUNT, logicalLogName, shardName, MANIFEST_REL, NOTE_BAD_CHARS_RE, NOTE_DIR_CANDIDATES, NOT_A_SUBPROJECT_RE, OK_SCHEMA, PRINCIPLE_AUTH_TTL_MS, PRINCIPLE_GRANT_TOOL, protocolGapOf, ROOT_PARAM, SETTINGS_PREFIX, SETTING_GROUPS, SETTING_SPECS, USER_MSG_MAX_CHARS, USER_MSG_SOURCE_KIND, bumpSettingsBroadcast, containerCache, name, setActiveSettings } from "./defs.js";
import { activeLockFor, autoFullPct, capsuleDirRel, capsuleErrorMaxOf, capsuleUserMsgMaxOf, countChildDirs, currentSettings, normalizeSettings, numOf, persistCapsuleMemory, precedenceFromManifest, precedenceValue, sessionTag, settingDefaults, settingsOf, trimErrorsInPlace, trimUserMessagesInPlace, userMsgArchiveRel } from "./part1.js";
import { headOf, renderInjectionBody, renderResult, rootFromExec, settingsBroadcastSeqOf } from "./part3.js";
import { appendAudit, cardModeOf, readKindRaw, removeKindCard, writeKindCard } from "./part4.js";
// ★★★★★ 2026-10-21（1.5.0）：**扩展记忆**的服务端入口。
//   ★ 为什么 part2 可以直接 import part8：part2 → part3 → part8 这条环**本来就在**
//     （`part3.js` 早已 `import { renderExtensionInjection } from "./part8.js"`），
//     且 93 条探针证明它工作正常 ⇒ 再补一条同向 import **不改变求值顺序**。
import { EXT_MODES, EXT_MODE_KEYS, createExtension, deleteExtension, listExtensions, updateExtension } from "./part8.js";
// ★★★★★ 2026-10-23（D310，审计员010 F-04）：清单写入的**唯一出口**（原子写 + 同步镜像）。
//   `registerGoalsInManifest` / `registerPrinciplesInManifest` 走它。
//   ★ 它是**叶子模块**（只依赖 node 内建）⇒ 这条 import 不改变求值顺序、不成环。
import { writeManifestSynced } from "./manifest-mirror.js";
// ★ 2026-10-23（D310 / F-07）：V3 核心机制的合规体检（叶子模块，不成环）。
import { v3ConformanceGaps } from "./v3-conformance.js";
export function writePrinciples(root, { content, mode, authorizedBy, exec, tag } = {}) {
  const info = inspect(root);
  let relPath = info.principlesRel;
  // ★★★★★ 2026-10-14（D189）**修 D188 ④ 那个卡住 PRINCIPLES.md 的真缺口**：
  //
  //   ❌ 原来的行为：`relPath === undefined` ⇒ **直接拒绝**（"插件不会自动创建它"）。
  //   ★★ 后果（真机实测，我本人撞上的）：**文件还不存在时，
  //      "模型提议 → 用户批准"那条授权路也写不进去** —— 因为提议最终也走本函数。
  //      ⇒ 唯一入口只剩用户亲手敲 `/ledger principles <内容>`。
  //   ★★★ 这与 D180 的明文承诺**直接矛盾**：
  //      *"一种是我主动自然语言描述之后模型去修改和增删……或者是我把我的指令描述出来后，
  //        模型问我一句，我同意之后他去写"* —— **两种形式都要**，
  //      而文件还不存在时第二种被堵死。
  //
  //   ★ 为什么"当时拒绝"是**过度**了（想清楚这一层很重要）：
  //     D180 要守的是「**模型不能在没有用户授权时写入**」，而这条守在**调用方**：
  //       · `ledger_write({target:"principles"})` ⇒ 没有 `authorizedBy` 一律拒（在更上面）；
  //       · `applyPrincipleProposal` ⇒ 只由**用户批准**触发。
  //     ⇒ 能走到本函数的，**必然已经带了授权**。
  //     用"文件是否存在"当闸门，是**把守卫放错了地方**：它拦不住未授权者，
  //     只拦住了**已授权但文件还没建**的人 —— 那是纯粹的"拦错人"。
  //
  //   ⇒ 所以：`relPath` 缺失时**回落到默认名**（与 `ledger_goals` 建 GOALS.md 同一套做法），
  //     并**登记进清单**。★ 注意：这里**不需要**再加"有没有授权"的判断 ——
  //     本函数的**每一个调用点**都已经是授权后才到的（见上）。多加一层只会再造一次"拦错人"。
  //   ⚠️ 但如果 `authorizedBy` 是空的（理论上不该发生），仍然拒绝 —— 双保险，且**说清原因**。
  if (relPath === undefined && String(authorizedBy ?? "").trim() === "") {
    return {
      ok: false,
      reason: "写根本原则必须带用户授权（authorizedBy）。这次没有 ⇒ 一个字节都没写。",
      refused: true,
      hint: "ledger_propose_principle",
    };
  }
  if (relPath === undefined) {
    relPath = DEFAULT_PRINCIPLES_NAME;
    // ★ 登记进清单 —— 否则下次 `inspect` 仍认不到它（只能靠"文件已存在"的 guess 兜底）。
    //   与 `registerGoalsInManifest` 同一套做法：**只补字段，绝不动别的**。
    try {
      registerPrinciplesInManifest(root, info, relPath);
    } catch {
      /* 登记失败不挡写入：文件写下去，下次 inspect 会按 guess 认到它 */
    }
  }
  // ★ V3（D289）：原则是**记忆** ⇒ 基准是 `memoryBase`（V2 里它就是项目根，行为不变）。
  //   ★ 边界校验也**必须跟着同一个基准**：`isUnder(root, abs)` 若仍用项目根，
  //     V3 下 `abs` 在记忆子目录里 —— 仍算"在项目根下"，校验会通过（碰巧对）；
  //     但反过来，若哪天 memoryRoot 指向项目外的**合法**位置，用项目根校验就会误拒。
  //     ⇒ 基准与校验**共用同一个变量**，不给自己留"两处各判一次"的机会。
  const memBase = memoryBaseOf(info, root);
  const abs = path.resolve(memBase, relPath);
  if (!isUnder(memBase, abs)) throw fail("writePrinciples: 目标逃出了项目根");

  const existing = readTextSafe(abs) ?? "";
  const body = typeof content === "string" ? content : "";
  const m = mode === "append" && existing.trim() !== "" ? "append" : mode === "replace" ? "replace" : "append";
  const next = m === "append" && existing.trim() !== "" ? `${existing}\n\n${body}\n` : `${body}\n`;

  // ★ 原子写：临时文件 + rename（与归档那条同一套做法，见 A2 的修法）。
  //   ★ 为什么这里也要原子：这是**用户的原则**，写坏一次就等于规则丢失。
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  ensureDir(path.dirname(abs));
  fs.writeFileSync(tmp, next, "utf8");
  fs.renameSync(tmp, abs);

  // ★★ 用户要求"每一次修改都同步到日志中" —— 走**同一个**审计出口。
  const rec = {
    kind: AUDIT_KIND_PRINCIPLE,
    tag: tag ?? "(无编号)",
    target: "principles",
    mode: m,
    relPath,
    lines: countLines(next),
    sessionId: String(exec?.agent?.session?.header?.id ?? ""),
    authorizedBy: String(authorizedBy ?? "unknown"),
  };
  let audit;
  try {
    audit = appendAudit(root, info, rec);
  } catch {
    /* 审计写失败不许挡住原则落盘（与台账那条同一口径） */
  }
  return {
    ok: true,
    target: "principles",
    mode: m,
    relPath,
    lines: rec.lines,
    authorizedBy: rec.authorizedBy,
    ...(audit === undefined ? {} : { auditRel: audit.relative }),
  };
}

/**
 * ★★★★★ 2026-10-13（D180）：**待授权的原则提议**（模型只能走到这里为止）。
 *
 * ★ 为什么要有这一层（而不是让模型直接调 `ledger_write` 带个 `authorized` 标志）：
 *   让模型"自己声明已被授权"= **把守卫交给被守卫的人**。模型完全可能（善意地）
 *   以为用户已经同意了就写上 `authorized: true` —— 那不是恶意，但守卫就没了。
 *   ⇒ 结构性做法：模型**只能提议**；批准这一动作**只能由用户产生**
 *     （点卡片 / 回一句话，两者都由**插件**解析后调用 `applyPrincipleProposal`）。
 */

export function proposePrinciple(state, sid, proposal) {
  const key = String(sid);
  const list = state.principleProposals.get(key) ?? [];
  const rec = {
    id: `p${Date.now()}-${list.length + 1}`,
    at: Date.now(),
    op: proposal.op, // "add" | "replace" | "remove"
    text: proposal.text,
    reason: proposal.reason,
    proposedBy: proposal.proposedBy, // 会话 tag
  };
  list.push(rec);
  // ★ 有界：只留最近 8 条（提议是"待授权"的临时态，不是记忆）。
  while (list.length > 8) list.shift();
  state.principleProposals.set(key, list);
  return rec;
}

/** 取回待授权的提议（按 id；不传 id 则取最近一条）。 */

export function principleProposalOf(state, sid, id) {
  const list = state.principleProposals.get(String(sid)) ?? [];
  if (id === undefined) return list.length === 0 ? undefined : list[list.length - 1];
  return list.find((x) => x.id === id);
}

/** 用掉一条提议（授权已发出 ⇒ 它不再待批）。 */

export function consumePrincipleProposal(state, sid, id) {
  const key = String(sid);
  const list = state.principleProposals.get(key) ?? [];
  const next = list.filter((x) => x.id !== id);
  state.principleProposals.set(key, next);
}

/**
 * ★★★★★ 2026-10-14（D193，用户拍板）：**待批准提议的检索与展示**。
 *
 *   用户原话（逐字）：*"另开 /ledger principles approve <id>可以做。"*
 *
 * ★ 为什么需要这一小节（而不是让用户直接手打 id 就完了）：
 *   提议 id 是 `p<毫秒时间戳>-<序号>` —— **给人看、给人打，都极其难用**。
 *   若只有"approve <id>"这一条路，用户得从模型的回复里**复制粘贴**那串数字；
 *   一旦打错一个字符，得到的是一句"找不到" —— 而用户此刻并不知道自己打错了什么。
 *   ⇒ 所以配套三件：① `pending` 能把待批清单**带序号**打出来；② `approve` 不带 id
 *     默认取**最近一条**；③ 认 **`#序号`**、**完整 id**、以及**唯一前缀**三种写法，
 *     ★ 而**前缀有多种匹配时宁可不认**（列出来让用户选），**绝不猜**。
 *
 * ★★ 与 `principleGrantOf` 一样，提议是**内存态**（`state.principleProposals`）：
 *   重启即消失。这在语义上是对的 —— 它是"待授权"的临时态，不是记忆。
 *   ⚠️ 但**必须在文案里说明**，否则用户重启后看到"没有待批准"会以为提议丢了是 bug。
 */

export function pendingProposals(state, sid) {
  return state.principleProposals.get(String(sid)) ?? [];
}

/** 把一条待批准提议渲染成给人看的几行（含序号 / id / 类型 / 年龄 / 正文摘要）。 */

export function describeProposal(p, index) {
  const ageMs = Date.now() - p.at;
  const ageMin = Math.max(0, Math.round(ageMs / 60000));
  const expired = ageMs > PRINCIPLE_AUTH_TTL_MS;
  const opLabel = p.op === "add" ? "追加" : p.op === "remove" ? "删除" : "整份替换";
  const oneLine = String(p.text ?? "").replace(/\s+/g, " ").trim();
  const excerpt = oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
  return (
    `- **#${index + 1}** \`${p.id}\`　［${opLabel}］　${ageMin} 分钟前` +
    (expired
      ? `　⚠️ **已失效**（超过 ${Math.round(PRINCIPLE_AUTH_TTL_MS / 60000)} 分钟，approve 会被拒）`
      : "") +
    `\n  > ${excerpt === "" ? "(空)" : excerpt}` +
    (p.reason === undefined || p.reason === "" ? "" : `\n  > 理由：${p.reason}`)
  );
}

/**
 * 按用户给的 token 找**一条**待批准提议。
 *
 * ★ 三种写法（用户原话只要求了 id 那一种，另两种是"少让用户打错"）：
 *   · 不传 token ⇒ **最近一条**（列表末尾）；
 *   · `#N` 或纯数字 ⇒ **清单里的第 N 条**（配合 `pending` 打出来的序号）；
 *   · 完整 id / **唯一前缀** ⇒ 命中那一条。
 * ★★ 命中多条 ⇒ **返回歧义错误并列出候选**，绝不替用户挑一条
 *   （挑错 = 把用户没同意的原则写进根本原则 —— 本项目最贵的一类错）。
 */

export function findPendingProposal(list, token) {
  const t = String(token ?? "").trim();
  if (list.length === 0) {
    return {
      err:
        "**现在没有待批准的原则提议。**\n\n" +
        "★ 两种可能：① 模型还没提议过；② 提议是**内存态**，**插件重启后就没了** —— " +
        "这种情况让模型重新提议一次即可（提议不写任何文件，重提没有代价）。",
    };
  }
  if (t === "") return { p: list[list.length - 1], how: "latest" };

  const asIndex = /^#?(\d+)$/.exec(t);
  if (asIndex !== null) {
    const idx = Number(asIndex[1]);
    if (idx >= 1 && idx <= list.length) return { p: list[idx - 1], how: "index" };
    return {
      err: `序号 \`#${idx}\` 超出范围 —— 现在只有 ${list.length} 条待批准（用 \`/ledger principles pending\` 看清单）。`,
    };
  }

  const exact = list.filter((x) => x.id === t);
  if (exact.length === 1) return { p: exact[0], how: "id" };

  const prefix = list.filter((x) => x.id.startsWith(t));
  if (prefix.length === 1) return { p: prefix[0], how: "prefix" };
  if (prefix.length > 1) {
    return {
      err:
        `\`${t}\` 匹配到 **${prefix.length}** 条提议 —— **不替你挑**。请给更完整的 id：\n` +
        prefix.map((p, i) => `  · \`${p.id}\`${i === 0 ? "" : ""}`).join("\n"),
      ambiguous: true,
    };
  }
  return {
    err:
      `找不到 id 为 \`${t}\` 的待批准提议。\n` +
      "用 `/ledger principles pending` 看现有清单（若清单是空的，见那里的说明）。",
  };
}

/**
 * ★★★★★ 2026-10-13（D180）：**用户授权之后的落盘** —— 全流程里唯一会把原则写进文件的地方。
 *
 * ★ 调用者只有两处，**两处都由用户动作触发**：
 *   ① `ledger_checkpoint` 的卡片回调（用户点了"授权并写入"）；
 *   ② `/ledger principles` 命令里用户自己输入内容那一路（用户亲手写的）。
 * ★ 模型**够不到这个函数** —— 这是"结构性"的落实处。
 */

export function applyPrincipleProposal(root, state, sid, proposalId, authorizedBy, exec) {
  const p = principleProposalOf(state, sid, proposalId);
  if (p === undefined) {
    return { ok: false, reason: "找不到那条待授权的提议（可能已被写入或被新提议覆盖）。" };
  }
  // 授权有效期：过期的提议**不许**凭旧授权落盘（见 PRINCIPLE_AUTH_TTL_MS 的注释）。
  if (Date.now() - p.at > PRINCIPLE_AUTH_TTL_MS) {
    consumePrincipleProposal(state, sid, p.id);
    return {
      ok: false,
      reason:
        `那条提议已放置超过 ${Math.round(PRINCIPLE_AUTH_TTL_MS / 60000)} 分钟，授权已失效 —— ` +
        "请让模型重新提议一次（宁可多问一次，也不留下一扇常开的门）。",
      expired: true,
    };
  }
  const info = inspect(root);
  const rel = info.principlesRel;
  // ★ 写入方式按 op：
  //   · `add`    ⇒ 追加（原则是累积的，不覆盖旧的）
  //   · `remove` ⇒ 从正文里删掉那一段（**必须精确匹配**，删不到就报错、绝不猜）
  //   · `replace`⇒ 整份替换（**最危险**，所以要求提议里带全文）
  let content = "";
  let mode = "append";
  if (p.op === "add") {
    content = p.text;
    mode = "append";
  } else if (p.op === "replace") {
    content = p.text;
    mode = "replace";
  } else if (p.op === "remove") {
    // ★ V3（D289）：读的是**记忆**文件 ⇒ 基准 `memoryBase`。
    const existing =
      readTextSafe(rel === undefined ? "" : path.resolve(memoryBaseOf(info, root), rel)) ?? "";
    const needle = String(p.text ?? "").trim();
    if (needle === "" || !existing.includes(needle)) {
      return {
        ok: false,
        reason:
          "要删除的那段**在文件里找不到**（逐字匹配失败）⇒ 一个字节都没写。" +
          "★ 这是刻意的：删不到就报错，**绝不猜**（猜着删 = 可能删掉用户别的原则）。",
        notFound: true,
      };
    }
    content = existing.split(needle).join("").replace(/\n{3,}/g, "\n\n");
    mode = "replace";
  } else {
    return { ok: false, reason: `不认识的提议类型：${String(p.op)}` };
  }

  const r = writePrinciples(root, { content, mode, authorizedBy, exec, tag: p.proposedBy });
  if (r.ok === true) consumePrincipleProposal(state, sid, p.id);
  return r;
}

/**
 * ★★★★★ 2026-10-14（D191，用户拍板）：**原则的「授权窗口」** —— 用户点一下卡片，解锁模型改原则的权利。
 *
 *   用户原话（逐字）：*"模型应该可以调用工具，弹一个单独卡片，
 *   选择授权的话就**解锁模型改原则的权利**。"*
 *
 * ★★★ 这与 D180 的"提议 → 批准"是**两条不同的授权形态**，各有用途：
 *   | | D180 提议路 | ★ 本条「授权窗口」 |
 *   |---|---|---|
 *   | 粒度 | **一条具体改动**（文本已定） | **一段时间的改的权利** |
 *   | 适合 | 模型想改，让用户逐个把关 | 用户说"你自己去把原则整理一下" |
 *   | 授权载体 | 那条提议 | **本次会话的授权窗口** |
 *
 * ★★★★ 为什么这条**在结构上比 D180 那条更硬**（值得记下来）：
 *   D180 的判据是"调用方传一个 `authorizedBy` **字符串**"——
 *   字符串是**可猜、可复制、可被提示词诱导写出来**的（虽然本机还没发生过）。
 *   本条的判据是**插件自己持有的状态**（`state.principleGrants`），
 *   ★ 模型**没有任何办法**把它写进 state —— 它只能由**用户在卡片上点那一下**产生。
 *   ⇒ 这才是真正的"**结构性**"（D180 自己那句取舍：能做成结构性的，就别做成纪律性的）。
 *
 * ★★ 三条与 D180 一致的硬约束（不许因为"更方便"而放松）：
 *   ① **有期限**（`PRINCIPLE_AUTH_TTL_MS`，10 分钟）—— 不留一扇常开的门；
 *   ② **一次一授权**：写入成功后**立刻消费掉**（改一次要问一次），
 *      ★ 否则"点一次 = 此后随便改"，守卫就等于没有；
 *   ③ **每一次改动照旧进审计**（用户 2026-10-13 原话："每一次修改都同步到日志中"）。
 */

export function principleGrantOf(state, sid) {
  const key = String(sid);
  const g = state.principleGrants?.get(key);
  if (g === undefined) return undefined;
  // ★ 过期即失效（并且**顺手清掉** —— 免得它一直躺在 state 里让人误以为还有效）。
  if (Date.now() - g.at > PRINCIPLE_AUTH_TTL_MS) {
    state.principleGrants.delete(key);
    return undefined;
  }
  return g;
}

/** 消费掉那个窗口（**一次一授权**）。 */

export function consumePrincipleGrant(state, sid) {
  state.principleGrants?.delete(String(sid));
}

/**
 * ★★★★★ 2026-10-14（D191）：**模型请求"改原则的权利"** —— 弹一张单独的卡片。
 *
 * ★ 它是**唯一**能给模型开那个窗口的地方（见 `principleGrantOf` 的说明）。
 * ★ 卡片只有两个选项，且**默认不是授权** —— 用户必须**主动**点"授权"。
 */

export function definePrinciplesAccessTool(ctx, state) {
  const OPTIONS = [
    {
      label: "授权（本次可改）",
      description: `解锁我修改 PRINCIPLES.md 的权利，有效期 ${Math.round(PRINCIPLE_AUTH_TTL_MS / 60000)} 分钟、改一次就用掉。`,
    },
    { label: "不授权", description: "我继续只能提议，不能改。" },
  ];
  return {
    name: PRINCIPLE_GRANT_TOOL,
    description:
      "Ask the user to UNLOCK your right to modify the project's FUNDAMENTAL PRINCIPLES " +
      "(PRINCIPLES.md), by showing a dedicated card. " +
      "★ Normally you have NO write path to that file (D180): you may only propose. " +
      "Call this tool when the user asks you to maintain/tidy/update the principles yourself, " +
      "or when you judge it necessary and need their permission. " +
      `If the user picks the authorize option, you get a ${Math.round(PRINCIPLE_AUTH_TTL_MS / 60000)}-minute window ` +
      "in which `ledger_write({target:\"principles\"})` succeeds; the window is consumed by the " +
      "first successful write (authorize once per change). " +
      "★ Never claim the rights were granted unless this tool returns authorized:true.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why you need write access — shown on the card so the user can decide.",
        },
        root: ROOT_PARAM,
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec, args);
      const agent = exec?.agent;
      const sid = String(agent?.session?.header?.id ?? "");
      if (sid === "") return { ok: false, reason: "拿不到本会话 id，无法请求授权。" };
      const info = inspect(root);

      const uq = ctx.get("userQuestions");
      if (uq === undefined || typeof uq.ask !== "function") {
        return {
          ok: false,
          reason:
            "本机没有可用的 userQuestions 服务（没有会渲染选项卡片的客户端）⇒ 卡片弹不出来，" +
            "所以**没有**任何权利被解锁。请改用自然语言问用户，或直接请他敲 " +
            "`/ledger principles <内容>` 亲手写。",
          options: OPTIONS.map((o) => o.label),
        };
      }

      const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
      const questions = [
        {
          id: "ledger-principles-access",
          question:
            `**你授权我修改根本原则吗？**\n\n` +
            (reason === "" ? "（我没有说明理由。）" : `我的理由：${reason}`) +
            `\n\n★ 授权后我可以在 ${Math.round(PRINCIPLE_AUTH_TTL_MS / 60000)} 分钟内改 ` +
            `${info.principlesRel ?? "PRINCIPLES.md"}，**改一次就用掉**；每次改动都记进活动日志的审计。` +
            `\n★ 不授权也行 —— 我仍然可以**提议**，由你定夺。`,
          header: "根本原则 · 授权",
          options: OPTIONS,
        },
      ];

      let result;
      try {
        const callId = typeof exec?.callId === "string" && exec.callId !== "" ? exec.callId : undefined;
        result = await uq.ask({
          questions,
          agent,
          ...(callId === undefined ? {} : { wait: { callId } }),
        });
      } catch (e) {
        return {
          ok: false,
          reason: `卡片没能送到用户（${String((e && e.message) || e)}）⇒ **没有**权利被解锁。`,
          options: OPTIONS.map((o) => o.label),
        };
      }

      const answers = Array.isArray(result?.answers) ? result.answers : [];
      const first = answers[0] ?? {};
      const selected = Array.isArray(first.selected) ? first.selected : [];
      const picked = String(selected[0] ?? "");
      // ★ 判据只看"用户点的是不是授权那一条" —— 取不到就当**没授权**（宁可少开一次）。
      const authorized = picked.includes("授权") && !picked.includes("不授权");

      if (!authorized) {
        return {
          ok: true,
          authorized: false,
          reason: "用户没有授权（或没做出选择）⇒ 我**仍然没有**修改原则的路径，只能提议。",
        };
      }
      state.principleGrants.set(sid, { at: Date.now(), authorizedBy: "user-card", reason });
      return {
        ok: true,
        authorized: true,
        ttlMinutes: Math.round(PRINCIPLE_AUTH_TTL_MS / 60000),
        note:
          `★ 用户**已授权**：在 ${Math.round(PRINCIPLE_AUTH_TTL_MS / 60000)} 分钟内，` +
          `\`ledger_write({target:"principles", ...})\` 会成功；**改一次窗口就用掉**（要再改就再问一次）。` +
          "★ 请只写用户希望的原则，并在回复里说明你改了什么。",
        hint: "ledger_write",
      };
    },
  };
}

/**
 * ★★★★★ 2026-10-13（D180）：**模型唯一能碰根本原则的工具** —— 只提议，不写。
 *
 * ★ 它**故意不提供**"直接写"的参数。模型想改原则，唯一的路是：
 *   ① 调本工具登记提议；② 请用户敲 `/ledger principles approve`（D193）。
 * ★ 这条设计让"没有授权绝对不能写"**不依赖模型的自觉**（见上面那段注释）。
 *
 * ★★★★★ 2026-10-14（D193）**就地更正本函数原来的一句错误指引**：
 *   它原来写着 *"After calling this, you MUST call `ledger_checkpoint` so the user can
 *   authorize"* —— **那句话描述了一条不存在的路**：`ledger_checkpoint` 没有处理提议的
 *   分支（它是"本轮收尾怎么处理"的四选一），而 `applyPrincipleProposal` 当时的调用点是 0。
 *   ⇒ 结果：**模型提议 → 用户同意 → 什么都没发生**（D189 已经查实，本轮接线）。
 *   ★ 这类"文案指向一个不存在的机制"是本项目反复栽的坑（纪律 11 的同型）：
 *     写下来了（`MUST call X`）、写的是**错的**、读的人（模型）会照做 ⇒ 建议 + 承诺一起落空。
 *   ⇒ 现在的指引是**真实存在的那个动作**：让用户敲 `/ledger principles approve`。
 *
 * ★★★ 为什么不让模型**自己调**一个"批准"工具（那条路更顺）：
 *   批准的效果是"往根本原则里写东西"，而根本原则正是**约束模型自己**的东西。
 *   若模型能调"批准"，那它就能**自己批准自己** —— 守卫当场归零。
 *   ⇒ 所以批准**刻意只存在于命令层**（用户输入），工具层里**没有**这个入口。
 *     这不是"少做了一个工具"，这是**这条设计的地基**。
 */

export function defineProposePrincipleTool(state) {
  return {
    name: "ledger_propose_principle",
    description:
      "Propose a change to the project's FUNDAMENTAL PRINCIPLES (PRINCIPLES.md). " +
      "★ You can ONLY propose — this tool never writes the file. The plugin writes it only after " +
      "the USER approves it. This is deliberate: the principles are the user's, not yours. " +
      "After calling this, tell the user the proposal id and ask them to run " +
      "`/ledger principles pending` (to list pending proposals) and " +
      "`/ledger principles approve <id>` (to approve; approving needs no id to take the latest). " +
      "★ There is NO approval tool — you cannot approve your own proposal; only the user can, " +
      "from the command line. Do not claim the proposal was written; it is pending until they approve it. " +
      "Use op=\"add\" to append a new principle, op=\"remove\" to delete one (paste the exact text " +
      "to delete), op=\"replace\" only when the whole file must be rewritten (paste the full text).",
    parameters: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["add", "remove", "replace"],
          description: "add = append; remove = delete exact text; replace = rewrite the whole file.",
        },
        text: {
          type: "string",
          description:
            "For add/replace: the principle text. For remove: the EXACT existing text to delete " +
            "(verbatim — a fuzzy match is refused, nothing is written).",
        },
        reason: { type: "string", description: "Why it belongs in the fundamental principles." },
        root: ROOT_PARAM,
      },
      required: ["op", "text"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec, args);
      const info = inspect(root);
      // ★★★★★ 2026-10-14（D189）**这里原来是 D188 ④ 的另一半**：
      //   它原来在 `info.principlesRel === undefined` 时**直接拒绝登记提议** ——
      //   而"提议"**本身不写任何文件**（只是记一条待授权的东西）⇒ **没有理由拒绝**。
      //   ★★ 真机后果：文件还不存在时，**第二条授权路（模型提议 → 用户批准）整个走不通**
      //     ⇒ 与 D180 那句"两种授权形式都要"直接矛盾。
      //   ⇒ 正解：**提议阶段不检查文件在不在**（那是写盘阶段的事，
      //     而写盘阶段已经由 `writePrinciples` 回落到默认名 + 登记清单来处理了）。
      //   ★ 判据：**守卫要放在"真正产生副作用"的那一步**，
      //     放在"只是记个意图"的那一步 = 拦错人（D189 的教训）。
      void info;
      const sid = String(exec?.agent?.session?.header?.id ?? "");
      if (sid === "") return { ok: false, reason: "拿不到本会话 id，无法登记提议。" };
      const op = String(args?.op ?? "");
      if (op !== "add" && op !== "remove" && op !== "replace") {
        return { ok: false, reason: `op 必须是 add / remove / replace（收到：${op}）` };
      }
      const text = typeof args?.text === "string" ? args.text.trim() : "";
      if (text === "") return { ok: false, reason: "text 不能为空。" };
      const rec = proposePrinciple(state, sid, {
        op,
        text,
        reason: typeof args?.reason === "string" ? args.reason.trim() : "",
        proposedBy: sessionTag(exec?.agent),
      });
      return {
        ok: true,
        proposalId: rec.id,
        op: rec.op,
        status: "pending-user-authorization",
        note: "**还没有写入文件** —— 必须由**用户**批准，而你没有批准的工具。",
        next:
          "把这条提议的内容摘要与 id **说给用户听**，并请他敲 " +
          "`/ledger principles pending` 看清单、`/ledger principles approve " +
          rec.id +
          "` 批准。「批准」这个动作**只存在于命令行层**，你**调不到**它 —— " +
          "不要声称它已经写入。",
      };
    },
  };
}

/**
 * 交接单目录的候选名（登记优先，其次按这些名字找**已存在**的目录）。
 *
 * ★ 顺序有意义：`_handoff` 是我们自己的约定；后面几个是"别人已经在用的名字"，
 *   找到了就顺着它，不另起一个散落的地方（与 `NOTE_DIR_CANDIDATES` 同一套思路）。
 */

export function kindsOfType(type) {
  return type === "经验" ? EXPERIENCE_KINDS : LESSON_KINDS;
}
/** 某一类条目的 id 前缀（**两类各自编号** —— 引用 `L3` 或 `E2` 绝不会撞）。 */

export function idPrefixOfType(type) {
  return type === "经验" ? "E" : "L";
}

/**
 * 解析 `LESSONS.md` ⇒ 条目数组（**经验 + 教训两类**，D194）。
 *
 * ★ 格式刻意**极简**（一行标题 + 几个 `- key: value`），与目标卡同一套写法：
 *   因为这份文件会**一直被追加**，格式越简单越不容易写坏。
 * ★ 与 `renderLessonEntry` 是**互逆**的一对（一个写得出来、这里读得回去）。
 *
 * ★★ 兼容**旧的、只有教训的**文件：老条目写作 `## 教训 L1 · 尺子错`；
 *   新格式是 `## <类型> <id> · <kind>`（类型 ∈ 经验/教训）。
 *   两种都读得回来 ⇒ **不需要迁移脚本**（改口径却不迁移，是"记录存在≠准确"最容易发作的地方；
 *   这里用"读得懂两种"来避免它）。
 */

export function parseLessonEntries(text) {
  const out = [];
  const re = /^##\s*(经验|教训)\s+(\S+)\s*(?:[·|]\s*([^\n]*))?$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    marks.push({
      type: m[1],
      id: m[2],
      kind: (m[3] ?? "").trim(),
      index: m.index,
      len: m[0].length,
    });
  }
  for (let i = 0; i < marks.length; i += 1) {
    const body = text.slice(marks[i].index + marks[i].len, i + 1 < marks.length ? marks[i + 1].index : text.length);
    const field = (name) => {
      const r = new RegExp(`^-\\s*${name}\\s*[:：]\\s*(.*)$`, "m");
      const x = r.exec(body);
      return x === null ? "" : x[1].trim();
    };
    const listField = (name) => {
      const r = new RegExp(`^-\\s*${name}\\s*[:：]\\s*(.*)$`, "gm");
      const vals = [];
      let x;
      while ((x = r.exec(body)) !== null) vals.push(x[1].trim());
      return vals;
    };
    out.push({
      type: marks[i].type,
      id: marks[i].id,
      kind: marks[i].kind,
      title: field("标题"),
      symptom: field("现象"),
      cause: field("根因"),
      fix: field("正解"),
      // ★★★ 经验专属：**出处必填**（文件:行号 / 探针 / 实测命令）——
      //   经验记的是"系统怎么工作"，记错了后人会照做且不验证 ⇒ 必须能回查。
      source: field("出处"),
      scope: field("适用范围"),
      files: listField("相关文件"),
      at: field("时间"),
    });
  }
  return out;
}

/** 一条（经验/教训）⇒ markdown 块（**唯一**的形状出处，与 `parseLessonEntries` 互逆）。 */

export function renderLessonEntry(e) {
  const type = e.type === "经验" ? "经验" : "教训";
  const out = [`## ${type} ${e.id} · ${e.kind}`];
  out.push(`- 标题: ${e.title}`);
  // ★ 教训三件套（现象 → 根因 → 正解）；经验录的是机制与出处。
  //   ★ 两种都**只写非空的** ⇒ 老条目（没有 source）不会被写出一行空的「出处: 」
  //     （空字段会让解析回来变成 ""，看着像"没有出处"，其实是"这行本来不该有"）。
  if (e.symptom !== "") out.push(`- 现象: ${e.symptom}`);
  if (e.cause !== "") out.push(`- 根因: ${e.cause}`);
  if (e.source !== undefined && e.source !== "") out.push(`- 出处: ${e.source}`);
  if (e.fix !== "") out.push(`- 正解: ${e.fix}`);
  if (e.scope !== "") out.push(`- 适用范围: ${e.scope}`);
  for (const f of e.files ?? []) out.push(`- 相关文件: ${f}`);
  if (e.at !== "") out.push(`- 时间: ${e.at}`);
  return out.join("\n") + "\n";
}

/**
 * ★★★★★★ 2026-10-14（D192）：`ledger_lessons` —— 经验与教训的**唯一**读写工具。
 *
 * ★ 为什么带 `op`（而不是四个工具）：与 `ledger_goals` 同一条理由 ——
 *   四个工具会把"解析 / 写盘 / 审计"抄四遍。
 *
 * ★★ 权限：**不需要用户逐次授权**（它记的是**模型自己踩的坑**，不是用户的规矩）；
 *   但**每一次改动都进审计**（与 goals / journal 同口径）。
 * ★ 与根本原则的界线：**教训是事实记录，原则是用户的规矩** —— 不得互相冒充。
 */

export function defineLessonsTool() {
  return {
    name: "ledger_lessons",
    description:
      "维护项目的**经验与教训**（LESSONS.md）—— ★ **两类东西**，别混着写：\n" +
      "① **教训**（type=教训，id 形如 `L3`）：**你自己踩过的坑**。回答「**别再这样**」。\n" +
      "  什么时候写：**踩了坑并修好之后**就记一条。kind ∈ " +
      LESSON_KINDS.join(" / ") +
      "。\n" +
      "  ★ 必填 `cause`（根因）—— 没有根因的记录等于日记，下次还得重诊一遍。\n" +
      "② **经验**（type=经验，id 形如 `E2`）：**你花代价探查清楚的机制知识**。回答「**它是这样工作的**」。\n" +
      "  什么时候写：**每次为了干活而重新读源码/重新探查搞清楚一个机制之后**就记一条 ——\n" +
      "  这样下一轮（或下一场会话）**不用再探查一次**。kind ∈ " +
      EXPERIENCE_KINDS.join(" / ") +
      "。\n" +
      "  ★ 必填 `source`（出处：`文件:行号` / 探针路径 / 实测命令）—— 经验记错了后人会照做且不验证。\n" +
      "★ 判据（一眼分）：教训 = 做了什么→错了→正解；经验 = 是什么→**怎么验证的**→以后去哪改。\n" +
      "★ 与 `GOALS.md` 的 `lesson` 的**区别**：那个挂在具体目标下（回答「这条路为什么没走通」），\n" +
      "  这两类是**平的**、跨目标跨会话。\n" +
      "ops: `list`（可按 type / kind 过滤）· `add`（记一条）· `rm`（删一条）",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "add", "rm"] },
        type: {
          type: "string",
          enum: LESSON_TYPES,
          description:
            "For add: 经验（mechanism knowledge you PAID to discover） or 教训 (a pitfall you hit). " +
            "Defaults to 教训 when omitted (back-compatible).",
        },
        kind: {
          type: "string",
          description:
            `For add: which category. 教训: ${LESSON_KINDS.join(" / ")}. ` +
            `经验: ${EXPERIENCE_KINDS.join(" / ")}.`,
        },
        title: { type: "string", description: "For add: one-line name." },
        symptom: { type: "string", description: "教训 only: what you SAW (the observable symptom)." },
        cause: { type: "string", description: "教训 only — REQUIRED: the ROOT CAUSE." },
        source: {
          type: "string",
          description:
            "经验 only — REQUIRED: the evidence trail (file:line / probe path / command you ran). " +
            "Without it the entry is hearsay.",
        },
        fix: { type: "string", description: "教训: the correct approach. 经验: how to change it / where to go." },
        scope: { type: "string", description: "For add: when this applies (so it is reusable)." },
        files: {
          type: "array",
          items: { type: "string" },
          description: "For add: files/probes that matter.",
        },
        id: { type: "string", description: "For rm: the id (e.g. L7 or E2)." },
        root: ROOT_PARAM,
      },
      required: ["op"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec, args);
      const info = inspect(root);
      const rel = info.lessonsRel;
      // ★★★★★ 2026-10-14（D203）：**卡片模式**（`lessonsDir` 登记了）⇒ 读=拼卡、写=写小文件。
      const lmode = cardModeOf(info, "lessons");
      const lcard = lmode.card === true;
      const lhas = lcard || (typeof rel === "string" && rel !== "");
      const op = String(args?.op ?? "");
      // ★ D194：`type` 缺省 = 教训（**向后兼容** —— 旧的调用与旧的文件都还能用）。
      const wantType = args?.type === "经验" ? "经验" : "教训";

      if (op === "list") {
        if (!lhas) {
          return {
            ok: true,
            empty: true,
            note:
              "这个项目还没有经验与教训文件（`LESSONS.md`）。它**不由本工具凭空创建** —— " +
              "要建它，用 `ledger_init({ lessons: \"LESSONS.md\", initialLessons: \"# 经验与教训\\n\" })` 明确登记。",
          };
        }
        const all = parseLessonEntries(readKindRaw(root, info, "lessons").raw);
        const wantKind = typeof args?.kind === "string" ? args.kind : "";
        // ★ type 过滤：只在**显式传了** type 时才筛（不传 ⇒ 两类都给，这才是"看全部"）。
        const wantTypeFilter = args?.type === "经验" || args?.type === "教训" ? args.type : "";
        let entries = wantTypeFilter === "" ? all : all.filter((e) => e.type === wantTypeFilter);
        if (wantKind !== "") entries = entries.filter((e) => e.kind === wantKind);
        const byKind = {};
        const byType = {};
        for (const e of all) {
          byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
          byType[e.type] = (byType[e.type] ?? 0) + 1;
        }
        return {
          ok: true,
          relPath: rel,
          count: entries.length,
          total: all.length,
          byType,
          byKind,
          entries,
        };
      }

      if (!lhas) {
        return {
          ok: false,
          reason:
            "这个项目还没有 `LESSONS.md`，而本工具**不凭空创建**它 —— " +
            "请先用 `ledger_init({ lessons: \"LESSONS.md\", initialLessons: \"…\" })` 登记（与 `goals` 同一套口径）。",
          hint: "ledger_init",
        };
      }
      // ★ D203：卡片模式**没有聚合文件** ⇒ `abs` 只服务单文件那条路。
      // ★ V3（D289）：教训文件是**记忆** ⇒ 基准 `memoryBase`，校验同基准。
      const memBaseL = memoryBaseOf(info, root);
      const abs = lcard ? undefined : path.resolve(memBaseL, rel);
      if (abs !== undefined && !isUnder(memBaseL, abs)) throw fail("ledger_lessons: 目标逃出了项目根");
      const body0 = readKindRaw(root, info, "lessons").raw;
      const existing = parseLessonEntries(body0);

      if (op === "rm") {
        const id = typeof args?.id === "string" ? args.id.trim() : "";
        if (id === "") return { ok: false, reason: "rm 需要一个 id（形如 L1 或 E2）。" };
        if (!existing.some((e) => e.id === id)) return { ok: false, reason: `没有这条：${id}` };
        // ★ D203：卡片模式 ⇒ 删那个小文件（不再从大文件里"挖段"）。
        const rmc = removeKindCard(root, info, "lessons", id);
        if (rmc !== null) {
          if (rmc.removed !== true) return { ok: false, reason: `没找到卡片文件：${id}` };
          return { ok: true, removed: id, mode: "card", relPath: rmc.dirRel };
        }
        const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // ★ 类型词也要认两种（`经验`/`教训`）—— 否则删经验条目会定位不到。
        const re = new RegExp(
          `(^|\\n)##\\s*(?:经验|教训)\\s+${esc}\\s*(?:[·|][^\\n]*)?\\n[\\s\\S]*?(?=\\n##\\s*(?:经验|教训)\\s|$)`
        );
        const m = re.exec(body0);
        if (m === null) return { ok: false, reason: `没能在文件里定位「${id}」那段（一个字节都没删）。` };
        const next = (body0.slice(0, m.index) + (m[1] ?? "") + body0.slice(m.index + m[0].length)).replace(/\n{3,}/g, "\n\n");
        const tmpR = `${abs}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmpR, next, "utf8");
        fs.renameSync(tmpR, abs);
        return { ok: true, removed: id, relPath: rel };
      }

      if (op === "add") {
        const type = wantType;
        const kind = typeof args?.kind === "string" ? args.kind : "";
        const validKinds = kindsOfType(type);
        if (!validKinds.includes(kind)) {
          return {
            ok: false,
            reason: `${type} 的 kind 必须是 ${validKinds.join(" / ")}（收到：${kind || "（空）"}）`,
          };
        }
        const title = typeof args?.title === "string" ? args.title.trim() : "";
        if (title === "") return { ok: false, reason: "add 需要一个 title。" };
        const cause = typeof args?.cause === "string" ? args.cause.trim() : "";
        const source = typeof args?.source === "string" ? args.source.trim() : "";

        // ★★★ **两类各自的"命门字段"必须填** —— 这是 D192/D194 那条取舍的延续：
        //   · 教训没有 `cause` ⇒ 等于日记（下次还得重诊一遍）
        //   · 经验没有 `source` ⇒ 等于**道听途说**，而且**比没有更危险**：
        //     它会被当成"已查明的机制"照做，**没有人会再去验证**。
        //   ⇒ 两种都**明确拒绝**，不默默收下一条没用的记录。
        if (type === "教训" && cause === "") {
          return {
            ok: false,
            reason:
              "教训需要 `cause`（根因）—— 没有根因的记录等于日记，下次还得重诊一遍。" +
              "请写清「**为什么**会这样」，而不是复述现象。",
          };
        }
        if (type === "经验" && source === "") {
          return {
            ok: false,
            reason:
              "经验需要 `source`（出处）—— 例如 `lib/index.js:16947` / `tools/_probe-xxx.mjs` / " +
              "你实际跑过的那条命令。★ 没有出处的经验**比没有经验更危险**：" +
              "后人会把它当成已查明的机制照做，而且**不会去验证**。" +
              "★ 若你其实还没查清 ⇒ 先去查（grep 一次 / 跑一遍），再回来写。",
          };
        }

        // id 递增：取**同类**现有最大数字 +1（两类各自编号 ⇒ `L` 与 `E` 不撞）。
        const prefix = idPrefixOfType(type);
        let maxN = 0;
        for (const e of existing) {
          if (!String(e.id).startsWith(prefix)) continue;
          const n = Number(String(e.id).replace(/^[^0-9]*/, ""));
          if (Number.isFinite(n) && n > maxN) maxN = n;
        }
        const entry = {
          type,
          id: `${prefix}${maxN + 1}`,
          kind,
          title,
          symptom: typeof args?.symptom === "string" ? args.symptom.trim() : "",
          cause,
          source,
          fix: typeof args?.fix === "string" ? args.fix.trim() : "",
          scope: typeof args?.scope === "string" ? args.scope.trim() : "",
          files: Array.isArray(args?.files) ? args.files.filter((f) => typeof f === "string") : [],
          at: stamp(new Date()),
        };
        const head = body0.trim() === "" ? "# 经验与教训\n\n" : `${body0.replace(/\s+$/, "")}\n\n`;
        const block = renderLessonEntry(entry);
        // ★ D203：卡片模式 ⇒ **只写这一条的小文件**（键就是地址：`lessons/L12.md`）。
        const written = writeKindCard(root, info, "lessons", entry.id, block);
        if (written !== null) {
          if (written.ok !== true) return { ok: false, reason: `写卡片 ${entry.id} 失败：${written.reason}` };
          return {
            ok: true,
            id: entry.id,
            type: entry.type,
            kind: entry.kind,
            mode: "card",
            relPath: written.dirRel,
            path: written.path,
            count: existing.length + 1,
          };
        }
        const next = head + block;
        const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
        ensureDir(path.dirname(abs));
        fs.writeFileSync(tmp, next, "utf8");
        fs.renameSync(tmp, abs);
        return {
          ok: true,
          id: entry.id,
          type: entry.type,
          kind: entry.kind,
          relPath: rel,
          count: existing.length + 1,
        };
      }

      return { ok: false, reason: `不认识的 op：${op}（用 list / add / rm）` };
    },
  };
}

/**
 * ★★★★★ 2026-10-13（D183）：**回合流水**文件（分类记忆的第 5 种）—— 用户 21:05 原话：
 * *"等你重构整个台账体系，**分成多个种类，多个文件**，甚至是卡片化之后，
 * 你就可以开始正常维护台账了。"*
 *
 * ★★★ 为什么必须有这一种（**这是本轮用数据定下来的，不是我拍的**）：
 *   重构前 `LEDGER.md` **645 行**，其中**按顶层标题切出来的日期条目占 412 行（64%）** ——
 *   也就是**活跃台账里三分之二是"某年某月某日某会话做了什么的流水"**。
 *   而那正是用户反复说的「**旧的记忆污染**」的**物质形态**：
 *   它挤在一个"只该放当前状态"的文件里，于是
 *   ① 每次注入都要带上 64% 的历史；② 行数上限永远被历史顶爆（现 645 / 上限 350，靠临时授权挂着）；
 *   ③ 找"现在到底什么状态"要先滤掉三分之二历史。
 *
 * ★★ 判据（三种记忆的**语义**不同，所以必须分文件）：
 *   · **活跃台账** = **当前状态** —— 会被**覆盖、精简、归档**；每回合注入。
 *   · **回合流水**（本常量）= **只追加的历史** —— **只增不改**；★ **不注入**（按需查）。
 *   · **决策记录** = 长期决策 —— 只追加，不参与归档。
 *   ★ 把"状态"与"历史"放同一个文件 ⇒ 两者必然互相干扰（上面那 64% 就是后果）。
 *
 * ★ 口径与 `goals` / `principles` **刻意一致**（复用同一套已验过的模式，不另造机制）：
 *   `manifest.journal` 优先；没登记时**只认已经存在的同名文件**（`guess`）——
 *   **绝不凭空创建**（与 `decisions`/`principles` 那条"不擅自创建"一致）。
 */

export function parseGoalCards(text) {
  const src = typeof text === "string" ? text : "";
  const lines = src.split(/\r?\n/);
  const cards = [];
  let cur;
  const push = () => {
    if (cur !== undefined) cards.push(cur);
  };
  for (const ln of lines) {
    const m = /^##\s*目标\s+([A-Za-z0-9._-]+)\s*(?:[·|]\s*(.*))?$/.exec(ln);
    if (m !== null) {
      push();
      cur = { id: m[1], status: undefined, parent: undefined, title: "", kr: [], lessons: [], updatedAt: undefined };
      const st = (m[2] ?? "").trim();
      // 状态：认英文键，也认中文标签（用户可能手写中文）。
      for (const [k, label] of Object.entries(GOAL_STATUS_LABEL)) {
        if (st === k || (st !== "" && st.includes(label))) {
          cur.status = k;
          break;
        }
      }
      continue;
    }
    if (cur === undefined) continue;
    // ★ 2026-10-14（D198）：`更新于` —— 卡片自己的时间。
    //   ★★ 为什么要有它：D198 查出**卡里根本没有时间** ⇒ 权重无法"随相对时间下降"、
    //     注入也无法显示"这张卡多久没动"（两者都因此**从未实现**）。
    //   ★ 兼容：老文件没有这一行 ⇒ 解析成 `undefined`，调用方**如实标"时间未知"**（绝不假装知道）。
    //     同时认英文 `updated`（人可能手写英文）。
    const f = /^-\s*(parent|title|status|更新于|updated)\s*[:：]\s*(.*)$/.exec(ln);
    if (f !== null) {
      const v = f[2].trim();
      if (f[1] === "parent") cur.parent = v === "" || v === "-" || v === "无" ? null : v;
      else if (f[1] === "title") cur.title = v;
      else if (f[1] === "更新于" || f[1] === "updated") cur.updatedAt = v === "" ? undefined : v;
      else if (v !== "") {
        for (const [k, label] of Object.entries(GOAL_STATUS_LABEL)) {
          if (v === k || v.includes(label)) { cur.status = k; break; }
        }
      }
      continue;
    }
    const g = /^-\s*(关键结果|教训)\s*[:：]\s*(.*)$/.exec(ln);
    if (g !== null) {
      (g[1] === "教训" ? cur.lessons : cur.kr).push(g[2].trim());
      continue;
    }
    // 续行（缩进的普通行）⇒ 接到上一段。
    if (/^\s+\S/.test(ln)) {
      const last = cur.lessons.length > 0 ? cur.lessons : cur.kr;
      if (last.length > 0) last[last.length - 1] += ` ${ln.trim()}`;
    }
  }
  push();
  // ★ 缺省状态：没写就按"进行中"（对模型最安全的默认是**别把它当已完成**）。
  for (const c of cards) if (c.status === undefined) c.status = "active";
  // ★ 缺省 title：退回 id（绝不编内容）。
  for (const c of cards) if (c.title === "") c.title = c.id;
  return cards;
}

/**
 * 由卡片**推导**树（纯函数）。
 *
 * ★ 它同时返回**结构问题**（`issues`）：父 id 不存在 / 成环 / 多根 ——
 *   ★★ 这些**不抛错、不自动修**，而是**如实报出来**（让模型或人来决定）。
 *     自动"修好"= 猜用户的意思，本项目一贯的取舍是**报而不猜**。
 */

export function buildGoalTree(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const byId = new Map(list.map((c) => [c.id, c]));
  const issues = [];
  const childrenOf = new Map();
  const roots = [];
  for (const c of list) {
    if (c.parent === null || c.parent === undefined) {
      roots.push(c.id);
      continue;
    }
    if (!byId.has(c.parent)) {
      issues.push(`「${c.id}」的 parent=「${c.parent}」**不存在** ⇒ 先按树根处理`);
      roots.push(c.id);
      continue;
    }
    const arr = childrenOf.get(c.parent) ?? [];
    arr.push(c.id);
    childrenOf.set(c.parent, arr);
  }
  // 环检测（DFS 三色）。
  const color = new Map();
  const cycle = new Set();
  const walk = (id) => {
    const st = color.get(id);
    if (st === 1) { cycle.add(id); return; }
    if (st === 2) return;
    color.set(id, 1);
    for (const kid of childrenOf.get(id) ?? []) walk(kid);
    color.set(id, 2);
  };
  for (const c of list) walk(c.id);
  for (const id of cycle) issues.push(`「${id}」处在**环**里（父子互相指）⇒ 树不完整`);
  return { cards: list, byId, childrenOf, roots, issues };
}

/**
 * ★★★ 目标卡的**权重规则**（用户逐字给的标准）。
 *
 * 用户要求三条：
 *   ① **根本目标的权重永远很高**；
 *   ② **当前正在做的**（可有多个）权重也拉高；
 *   ③ **已完成的，权重随相对时间逐渐下降**。
 * ★ ④（我按 D136 的既有纪律补一条）：**被放弃的**权重低——但**它的"教训"反而要留**
 *   （那正是用户要的"哪些路没有走通"）。
 *
 * ★★ 与 D136 一致的两条纪律：
 *   · **时间段必须用相对序**（"更久以前完成" vs "更近完成"），不是绝对时长；
 *   · **绝对判据在大家都满足时无区分力** ⇒ 这里给的是**基准分** + 一个**相对衰减**。
 *
 * ★★★★★ 2026-10-14（D198）**就地更正 —— 第 ③ 条原来根本做不到**：
 *   上面那句"具体排序仍交给 `fuseWeight` 的相对位置秩融合"是**空头承诺**：
 *   `fuseWeight` 只服务**台账区块**（它的时间维喂的是 `lastChangedAt` = **块**的变更时间），
 *   **与目标卡零交集**（2 个调用点都在 `weightBlocks` 那条线上）。
 *   而且卡里**没有时间字段**（`renderGoalCard` 不写、`parseGoalCards` 不读）
 *   ⇒ 本函数**连"这张卡多久以前完成的"都拿不到** ⇒ 第 ③ 条**从未实现**（`done` 恒 45）。
 *   ⇒ 现修：① 卡片带上 `- 更新于:`；② `parseGoalCards` 读回；③ 本函数按**相对序**衰减。
 *
 * @param {object} card 目标卡
 * @param {{nowMs?:number, oldestDoneMs?:number}} [scope]
 *   ★ `oldestDoneMs` = **所有已完成卡里最老那张**的时间（由 `goalTimeScope` 算）。
 *     衰减是**相对于这一棵树**的（D136 口径：相对位置，不是绝对时长）——
 *     所以同一张卡在小项目里可能算"很旧"、在大项目里算"挺新"，这是**故意**的。
 */

export function goalWeightBasis(card, scope) {
  const why = [];
  let score = 50;
  if (card.status === "root") { score = 100; why.push("根本目标 ⇒ 基准 100（用户：永远很高）"); }
  else if (card.status === "active") { score = 85; why.push("进行中 ⇒ 基准 85（用户：拉高）"); }
  else if (card.status === "paused") { score = 55; why.push("搁置 ⇒ 基准 55"); }
  else if (card.status === "done") { score = 45; why.push("已完成 ⇒ 基准 45（再按相对时间下降）"); }
  else if (card.status === "dropped") { score = 30; why.push("已放弃 ⇒ 基准 30（但教训要留）"); }
  // ★ 教训是"跨任务的知识"⇒ 有教训的卡**加一档**（哪怕它是 done/dropped）。
  if (card.lessons.length > 0) { score += 10; why.push(`带 ${card.lessons.length} 条教训 ⇒ +10`); }
  // ★★★ 2026-10-14（D198）：**第 ③ 条真正落地** —— 已完成的按**相对序**逐渐下降。
  //
  //   ★ 只在**已不在推进**的卡上衰减（done / dropped）：它们"越久以前收尾 ⇒ 越不重要"。
  //     `root`/`active`/`paused` 不衰减 —— 进行中的东西不会因为"放得久"而变得不重要。
  //   ★ 最多扣 15 分 ⇒ `done` 落在 **[30, 45]**（**永远不低于 dropped 的 30**，
  //     也就是说"一件较早完成的事"不会比"一件被放弃的事"更没价值 —— 这个下限是刻意的）。
  //   ★★ 拿不到时间的卡**一分不扣**（`updatedAt === undefined` ⇒ 跳过）：
  //     老文件没有 `- 更新于:` 是**正常状态**，绝不能因为"信息缺失"就把它当"很旧"。
  //     ⇒ 即"不知道 ⇒ 不惩罚"（与"不知道 ⇒ 不假装知道"同一条纪律）。
  if (
    (card.status === "done" || card.status === "dropped") &&
    Array.isArray(scope?.doneTimes)
  ) {
    const t = goalStampMs(card.updatedAt);
    // ★★★★ 用**相对序（秩）**，不用"时间跨度占比" —— 这一条我当场栽过，必须留档：
    //   第一版写的是 `ratio = (now − t) / (now − oldest)`。而 `stamp()` **只精确到分钟**
    //   ⇒ 树里**只有一张**已收尾的卡时，`now − oldest` 仍**不是 0**（最多差 60 秒）
    //   ⇒ `ratio = 1` ⇒ **无端扣满 15 分**。自检情形 74⑥（"带教训的卡 ≥ 40 分"）
    //   当场把它抓了出来（40 − 15 = 25）。
    //   ★ 根因正是 D136 那条纪律：**绝对量（时长）会被"分母不是 0"骗过去，
    //     而秩只看"谁比谁新"** —— 一张卡时无比较对象 ⇒ 不衰减，天然正确。
    //   ⇒ 现为：`newer` = 比它**更新**的卡有几张；`n` = 可比较的卡总数。
    const times = scope.doneTimes;
    const n = times.length;
    if (t === undefined) {
      why.push("★ 没有 `更新于` 字段（老格式或手写）⇒ **不衰减**（不知道就不惩罚）");
    } else if (n < 2) {
      why.push("本树只有这一张已收尾的卡 ⇒ **无相对可比对象**，不衰减");
    } else {
      const newer = times.filter((x) => x > t).length;
      const cut = Math.round((newer / (n - 1)) * 15);
      if (cut > 0) {
        score -= cut;
        why.push(`收尾时间在本树里排第 ${n - newer}/${n} 新 ⇒ −${cut}（相对序，不是绝对时长）`);
      } else {
        why.push("收尾时间是本树里最新的一批 ⇒ 不衰减");
      }
    }
  }
  // ★ 有子目标（是个"岔路口"）⇒ 稍高：它是结构节点，删了会丢上下文。
  return { score, why };
}

/**
 * ★ 2026-10-14（D198）：把卡上的 `更新于` 文本解析成毫秒（**本地时**，与 `stamp` 同口径）。
 *
 * ★ 为什么不用 `Date.parse` 直接吃字符串就完事：`"2026-10-14 09:26"` 这种格式
 *   在 Node 里**能**被解析，但会按**运行环境的解释**走（历史上各引擎对无时区串的解释不一致）
 *   ⇒ 自己按本地时建 `Date`，**与写入用的是同一把尺子**（纪律：显示与判据同时区）。
 * ★ 认不出的串一律返回 `undefined`（**绝不猜**：猜成 1970 会让它看起来"极旧"而被多扣分）。
 */

export function goalStampMs(text) {
  if (typeof text !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(text.trim());
  if (m === null) return undefined;
  const d = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    m[4] === undefined ? 0 : Number(m[4]),
    m[5] === undefined ? 0 : Number(m[5])
  );
  const t = d.getTime();
  return Number.isFinite(t) ? t : undefined;
}

/**
 * ★ 2026-10-14（D198）：算这棵树的**时间参照**（相对序用），并顺带给出"多久没动"。
 *
 * ★ 只统计**已收尾**（done/dropped）的卡：衰减只作用在它们身上，
 *   参照系用别的状态的卡去算会把尺子搞歪（那些卡本就不衰减）。
 * ★ 没有任何可解析时间的已收尾卡 ⇒ 返回 `{}` ⇒ 调用方**不衰减、也不显示年龄**。
 */

export function goalTimeScope(cards, nowMs) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const times = (cards ?? [])
    .filter((c) => c.status === "done" || c.status === "dropped")
    .map((c) => goalStampMs(c.updatedAt))
    .filter((t) => t !== undefined)
    // ★ 排序（升序）—— 下面按**秩**衰减时只看"谁比谁新"，顺序本身不影响结果，
    //   但排序后再算 `newer` 更便于人读、也便于断言。
    .sort((a, b) => a - b);
  return { nowMs: now, doneTimes: times };
}

/**
 * ★ 2026-10-14（D198）：卡片"多久没动"的**给人读**的说法。
 *
 * ★ 判据：**时间未知就明说未知**（老文件没这字段是正常状态）——
 *   绝不省略、也绝不编一个"刚刚"。★ 这正是 D198 那条"看得出它旧吗"的交付物。
 */

export function goalAgeOf(card, nowMs) {
  const t = goalStampMs(card?.updatedAt);
  if (t === undefined) return "更新于：**未知**（老格式没有该字段）";
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const mins = Math.max(0, Math.round((now - t) / 60000));
  const ago =
    mins < 60
      ? `${mins} 分钟前`
      : mins < 60 * 24
        ? `${Math.round(mins / 60)} 小时前`
        : `${Math.round(mins / (60 * 24))} 天前`;
  return `更新于 ${card.updatedAt}（${ago}）`;
}

/**
 * 渲染**给模型看的**目标树（推行，不是等它来查 —— D46 铁律）。
 *
 * ★ 形态：**一层缩进的树 + 每张卡的状态与关键结果**；★ 教训**逐字**列在它的卡下
 *   （那正是用户"以后不要踩"要的东西，摘要一下就没了）。
 * ★ 有界：只列前 `GOAL_RENDER_MAX` 张（按基准分），超出如实说"还有 N 张"。
 */

export function renderGoalTree(tree) {
  if (tree === undefined || tree.cards.length === 0) return "";
  // ★★★★★ 2026-10-14（D198）：**给每张卡带上"多久没动"**。
  //   ★ 为什么非有不可（这是 D198 查出的第二个缺口）：原来注入里**没有任何时间信号**
  //     ⇒ **旧树与新树在模型眼里长得一模一样** ⇒ 模型**没有理由去更新它**
  //     （实测：建树后维护 **0** 次，而同期台账写了 11 次）。
  //   ★ 判据：**时间未知就明说未知**，绝不省略、绝不编"刚刚"（老文件没这字段是正常状态）。
  const nowMs = Date.now();
  const scope = goalTimeScope(tree.cards, nowMs);
  // ★ 排序：基准分高的在前（根本目标自然浮到最上 + 已收尾的按相对时间下沉）。
  const scored = tree.cards.map((c) => ({ c, ...goalWeightBasis(c, scope) }));
  const top = scored.slice().sort((a, b) => b.score - a.score).slice(0, GOAL_RENDER_MAX);
  const shown = new Set(top.map((x) => x.c.id));
  const fmt = (c, depth) => {
    const pad = "  ".repeat(depth);
    const st = GOAL_STATUS_LABEL[c.status] ?? c.status;
    const out = [`${pad}- **${c.title}**（\`${c.id}\` · ${st} · ${goalAgeOf(c, nowMs)}）`];
    for (const k of c.kr) out.push(`${pad}  - KR: ${k}`);
    for (const l of c.lessons) out.push(`${pad}  - ★ 教训: ${l}`);
    return out.join("\n");
  };
  const lines = [];
  const seen = new Set();
  const walk = (id, depth) => {
    if (seen.has(id) || depth > 6) return;
    seen.add(id);
    const c = tree.byId.get(id);
    if (c === undefined) return;
    if (shown.has(id)) lines.push(fmt(c, depth));
    for (const kid of tree.childrenOf.get(id) ?? []) walk(kid, depth + 1);
  };
  for (const r of tree.roots) walk(r, 0);
  // ★ 没被 walk 到的（成环/孤岛）也要如实列出来 —— **不许静默丢卡**。
  for (const x of top) if (!seen.has(x.c.id)) lines.push(fmt(x.c, 0) + "（⚠️ 没接进树）");
  const issues = tree.issues.length === 0 ? "" : `\n⚠️ **结构问题**：${tree.issues.join("；")}`;
  const more = tree.cards.length > top.length ? `\n（另有 ${tree.cards.length - top.length} 张目标卡未列出 —— 见 \`GOALS.md\`）` : "";
  return `\n### 目标树（**记忆的组织方式** · 非项目根时以台账为准）\n\n${lines.join("\n")}${issues}${more}\n`;
}

/** 追加/更新一张目标卡（按 id 找到旧块 ⇒ **原地替换**，找不到才追加）。 */

export function upsertGoalCard(root, relPath, card, info) {
  // ★ V3（D289）：目标树是**记忆** ⇒ 基准 `memoryBase`。
  //   ★ 这里用**可选第 4 参** `info` 而不是改签名：调用点有两处，
  //     而"改掉已有参数顺序"会让某处漏改后**静默用错的基准**（最坏的一种升级事故）。
  //     不传 `info` ⇒ 退回 `root` ⇒ 与 V2 逐字一致（老调用方零改动、行为不变）。
  const memBaseG = memoryBaseOf(info, root);
  const abs = path.resolve(memBaseG, relPath);
  if (!isUnder(memBaseG, abs)) throw fail("upsertGoalCard: 目标逃出了项目根");
  const existing = readTextSafe(abs) ?? "";
  const block = renderGoalCard(card);
  const cards = parseGoalCards(existing);
  const has = cards.some((c) => c.id === card.id);
  let next;
  if (!has) {
    next = existing.trim() === "" ? `# 目标树\n\n${block}` : `${existing.replace(/\s+$/, "")}\n\n${block}`;
  } else {
    // ★ 原地替换那一张卡（**逐字**保住别人的卡不被碰）。
    const re = new RegExp(`(^|\\n)##\\s*目标\\s+${card.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:[·|][^\\n]*)?\\n[\\s\\S]*?(?=\\n##\\s*目标\\s|$)`);
    const m = re.exec(existing);
    if (m === null) next = `${existing.replace(/\s+$/, "")}\n\n${block}`;
    else next = existing.slice(0, m.index) + (m[1] ?? "") + block + existing.slice(m.index + m[0].length);
  }
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  ensureDir(path.dirname(abs));
  fs.writeFileSync(tmp, next, "utf8");
  fs.renameSync(tmp, abs);
  return { ok: true, relPath, created: !has, lines: countLines(next) };
}

/** 一张卡 ⇒ markdown 块（**唯一**的形状出处：解析与渲染必须互逆）。 */

export function renderGoalCard(card, now) {
  const out = [`## 目标 ${card.id} · ${GOAL_STATUS_LABEL[card.status] ?? card.status}`];
  out.push(`- parent: ${card.parent === null || card.parent === undefined ? "-" : card.parent}`);
  out.push(`- title: ${card.title}`);
  // ★ 2026-10-14（D198）：**卡片的时间**（写入即刷新）。
  //   ★ 为什么放在 `title` 之后：它是这张卡自身的元数据，跟 parent/title 同族；
  //     而 `关键结果` / `教训` 是**内容**（可能很多行），元数据夹在中间会打断阅读。
  //   ★★ 一律取「现在」、**不读 `card.updatedAt`**：本函数**只在写这张卡时**被调用
  //     （`upsertGoalCard` 的唯一渲染出口）⇒ 写下去的那一刻就是它的更新时间。
  //     ★ 若改成"沿用旧值"，`lesson` / `status` 这两个 op 会因为把 `...existing` 摊开而
  //       **把时间留在过去** ⇒ 明明刚改过、却显示很旧（正是本轮要修的那个病）。
  out.push(`- 更新于: ${stamp(now instanceof Date ? now : new Date())}`);
  for (const k of card.kr ?? []) out.push(`- 关键结果: ${k}`);
  for (const l of card.lessons ?? []) out.push(`- 教训: ${l}`);
  return out.join("\n") + "\n";
}

/**
 * ★★★★★ 2026-10-13（D181）：`ledger_goals` —— 目标树的**唯一**读写工具。
 *
 * ★ 为什么是一个工具带 `op` 而不是五个工具：五个工具会把"共同的前置检查"
 *   （解析、建树、写盘、审计）抄五遍 —— 那正是本项目反复栽的"多处各写一份"。
 *   ⇒ 一个入口，五个 op。
 * ★ 与根本原则的**关键区别**：这个**不需要用户逐次授权**（用户没这么要求），
 *   但**每一次改动都进审计**（用户对"两个需要维护的东西"都要求同步到日志）。
 */

export function defineGoalsTool() {
  return {
    name: "ledger_goals",
    description:
      "维护项目的**目标树**（GOALS.md）：目标是一张张**卡片**，靠 `parent` 字段联成树。" +
      "它记录：为了什么目标、有哪些子目标、**哪些路走通了 / 哪些没走通**（教训）。" +
      "★ 权重规则（用户的）：**根本目标永远权重最高**；**进行中的拉高**；" +
      "**已完成的随相对时间逐渐下降**；★ 但**带教训的卡即使完成也保留高分**（教训要留）。\n" +
      "ops: `tree`（读树，含结构问题）· `upsert`（新增或更新一张卡）· " +
      "`lesson`（给某张卡追加一条教训 —— 最常用）· `status`（改状态）· `rm`（删一张卡）。",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["tree", "upsert", "lesson", "status", "rm"] },
        id: { type: "string", description: "Goal card id (e.g. `g1`). Required for upsert/lesson/status/rm." },
        title: { type: "string", description: "For upsert: one-line goal title." },
        parent: {
          type: "string",
          description:
            "For upsert: parent card id, or \"-\" for a tree root. ★ Use \"-\" for a fundamental/root goal.",
        },
        status: {
          type: "string",
          enum: GOAL_STATUSES,
          description: "For upsert/status: root | active | paused | done | dropped (default active).",
        },
        kr: { type: "array", items: { type: "string" }, description: "For upsert: key results (optional)." },
        lesson: {
          type: "string",
          description:
            "For lesson/upsert: a lesson — what path was tried and whether it worked. " +
            "★ This is the field that answers «哪些路不要重走».",
        },
        root: ROOT_PARAM,
      },
      required: ["op"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec, args);
      const info = inspect(root);
      const rel = info.goalsRel;
      // ★★★★★ 2026-10-14（D203）：**卡片模式**（`goalsDir` 登记了）⇒ 整份读 = 念目录 + 拼卡。
      //   ★ 判据：读的人不能拿"迁移前的快照"当现状 —— 见 `readKindRaw` 的说明。
      const gmode = cardModeOf(info, "goals");
      const gcard = gmode.card === true;
      const ghas = gcard || (typeof rel === "string" && rel !== "");
      const op = String(args?.op ?? "");
      const tag = sessionTag(exec?.agent);

      if (op === "tree") {
        if (!ghas) {
          return {
            ok: true,
            empty: true,
            note: "这个项目还没有目标树（`GOALS.md`）。用 `ledger_goals({op:\"upsert\", id:\"g1\", title:…, parent:\"-\", status:\"root\"})` 建第一张根本目标卡。",
          };
        }
        const cards = parseGoalCards(readKindRaw(root, info, "goals").raw);
        const tree = buildGoalTree(cards);
        const scope = goalTimeScope(cards, Date.now());
        return {
          ok: true,
          relPath: gcard ? gmode.dirRel : rel,
          mode: gcard ? "card" : "file",
          count: cards.length,
          roots: tree.roots,
          issues: tree.issues,
          // ★ 2026-10-14（D198）：带上 `更新于` 与"多久没动"，让模型**看得出这张树旧不旧**。
          cards: cards.map((c) => ({ ...c, ...goalWeightBasis(c, scope), age: goalAgeOf(c) })),
          tree: renderGoalTree(tree),
          // ★★ 老格式的卡没有时间 ⇒ 如实提示"该补了"，而不是静默。
          ...(cards.some((c) => goalStampMs(c.updatedAt) === undefined)
            ? {
                staleFormat: true,
                hint:
                  "★ 有卡片**没有 `更新于` 字段**（老格式）⇒ 它们的权重拿不到时间、" +
                  "注入里也只能显示「更新于：未知」。用 `ledger_goals({op:\"upsert\", id:…})` " +
                  "重写一次那张卡即会自动补上（**插件只补它写的那张卡的这一行，不动别的**）。",
              }
            : {}),
        };
      }

      // ── 写操作：先保证文件存在（**这个文件可以由插件创建**，与原则不同）────────
      // ★★★ D203：卡片模式 ⇒ **不建聚合文件**（那正是我们要摆脱的东西）；建目录即可。
      const targetRel = gcard ? undefined : rel ?? DEFAULT_GOALS_NAME;
      if (!gcard && rel === undefined) {
        try {
          registerGoalsInManifest(root, info, targetRel);
        } catch {
          /* 登记失败不挡写入：文件写下去，下次 inspect 会按 guess 认到它 */
        }
      }
      const id = typeof args?.id === "string" ? args.id.trim() : "";
      if (id === "") return { ok: false, reason: `${op} 需要一个 id（形如 g1）。` };
      if (!/^[A-Za-z0-9._-]+$/.test(id)) {
        return { ok: false, reason: `id 只能用字母数字与 . _ -（收到：${id}）—— 它是结构键，不当作正文。` };
      }

      const cards = parseGoalCards(readKindRaw(root, info, "goals").raw);
      const existing = cards.find((c) => c.id === id);

      // ★ D203：**写这一张卡的唯一出口**（卡片模式写小文件，单文件模式就地改写）。
      //   ★ 判据：两模式**共用一个渲染器**（`renderGoalCard`）⇒ "写↔读互逆"只需验一次。
      const putCard = (card) => {
        const r = writeKindCard(root, info, "goals", card.id, renderGoalCard(card));
        if (r !== null) return r;
        return upsertGoalCard(root, targetRel, card, info);
      };
      const dropCard = () => {
        const r = removeKindCard(root, info, "goals", id);
        if (r !== null) return r;
        return null; // 下方走单文件那套"就地删段"
      };

      if (op === "rm") {
        if (existing === undefined) return { ok: false, reason: `没有这张卡：${id}` };
        const kids = cards.filter((c) => c.parent === id);
        if (kids.length > 0) {
          // ★ 不许静默制造孤儿：如实拒绝并给出选择（**报而不猜**）。
          return {
            ok: false,
            reason:
              `「${id}」还有 ${kids.length} 个子目标（${kids.map((k) => k.id).join("、")}）—— ` +
              "直接删会让它们变成孤儿。先把子目标改挂到别处（或一并删除），再删这张。",
            children: kids.map((k) => k.id),
          };
        }
        // ★ D203：卡片模式 ⇒ 直接删掉那个小文件（不再从大文件里"挖段"）。
        const dropped = dropCard();
        if (dropped !== null) {
          if (dropped.removed !== true) return { ok: false, reason: `没找到卡片文件：${id}` };
          recordGoalsChange(root, info, { op, id, tag, sessionId: String(exec?.agent?.session?.header?.id ?? "") });
          return { ok: true, removed: id, mode: "card", relPath: dropped.dirRel };
        }
        const abs = path.resolve(memoryBaseOf(info, root), targetRel);
        const body = readTextSafe(abs) ?? "";
        const re = new RegExp(`(^|\\n)##\\s*目标\\s+${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:[·|][^\\n]*)?\\n[\\s\\S]*?(?=\\n##\\s*目标\\s|$)`);
        const m = re.exec(body);
        if (m === null) return { ok: false, reason: `没能在文件里定位「${id}」那段（一个字节都没删）。` };
        const next = (body.slice(0, m.index) + (m[1] ?? "") + body.slice(m.index + m[0].length)).replace(/\n{3,}/g, "\n\n");
        const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, next, "utf8");
        fs.renameSync(tmp, abs);
        recordGoalsChange(root, info, { op, id, tag, sessionId: String(exec?.agent?.session?.header?.id ?? "") });
        return { ok: true, removed: id, relPath: targetRel };
      }
      if (op === "lesson") {
        if (existing === undefined) return { ok: false, reason: `没有这张卡：${id}（先用 upsert 建它）` };
        const text = typeof args?.lesson === "string" ? args.lesson.trim() : "";
        if (text === "") return { ok: false, reason: "lesson 不能为空。" };
        const next = { ...existing, lessons: [...existing.lessons, text] };
        const r = putCard(next);
        if (r.ok !== true) return { ok: false, reason: r.reason ?? "写卡失败" };
        recordGoalsChange(root, info, { op, id, tag, sessionId: String(exec?.agent?.session?.header?.id ?? "") });
        return { ok: true, id, lessons: next.lessons.length, relPath: r.relPath ?? r.dirRel, mode: r.card === undefined ? "file" : "card" };
      }

      if (op === "status") {
        if (existing === undefined) return { ok: false, reason: `没有这张卡：${id}` };
        const st = String(args?.status ?? "");
        if (!GOAL_STATUSES.includes(st)) {
          return { ok: false, reason: `status 必须是 ${GOAL_STATUSES.join(" / ")}（收到：${st}）` };
        }
        const next = { ...existing, status: st };
        const r = putCard(next);
        if (r.ok !== true) return { ok: false, reason: r.reason ?? "写卡失败" };
        recordGoalsChange(root, info, { op, id, tag, sessionId: String(exec?.agent?.session?.header?.id ?? "") });
        // ★ 完成时**主动提示**写教训 —— 那正是用户"以后不要踩"要的东西。
        return {
          ok: true,
          id,
          status: st,
          relPath: r.relPath ?? r.dirRel,
          mode: r.card === undefined ? "file" : "card",
          ...(st === "done" || st === "dropped"
            ? { hint: `这张卡现在是「${GOAL_STATUS_LABEL[st]}」⇒ 请用 op:"lesson" 补上**哪些路走通了 / 哪些没走通**（那样以后才不用重踩）。` }
            : {}),
        };
      }

      if (op === "upsert") {
        const title = typeof args?.title === "string" ? args.title.trim() : "";
        if (existing === undefined && title === "") {
          return { ok: false, reason: "新建一张卡必须给 title。" };
        }
        const rawParent = args?.parent;
        const parent =
          rawParent === undefined || rawParent === null || rawParent === "" || rawParent === "-"
            ? (existing?.parent ?? null)
            : String(rawParent).trim();
        // ★ 父必须存在（除非是树根）—— 不许把树接成孤儿。
        if (parent !== null) {
          const ok = cards.some((c) => c.id === parent);
          if (!ok) {
            return {
              ok: false,
              reason: `parent=「${parent}」不存在 ⇒ 会变成挂不上树的孤儿。先用 upsert 建那张父卡，或用 parent:"-" 当树根。`,
            };
          }
          if (parent === id) return { ok: false, reason: "parent 不能是它自己。" };
        }
        const st = String(args?.status ?? existing?.status ?? "active");
        if (!GOAL_STATUSES.includes(st)) {
          return { ok: false, reason: `status 必须是 ${GOAL_STATUSES.join(" / ")}（收到：${st}）` };
        }
        const kr = Array.isArray(args?.kr)
          ? args.kr.map((x) => String(x).trim()).filter((x) => x !== "")
          : (existing?.kr ?? []);
        const lessons = existing?.lessons ?? [];
        if (typeof args?.lesson === "string" && args.lesson.trim() !== "") lessons.push(args.lesson.trim());
        const card = { id, parent, status: st, title: title === "" ? existing?.title ?? id : title, kr, lessons };
        const r = putCard(card);
        if (r.ok !== true) return { ok: false, reason: r.reason ?? "写卡失败" };
        recordGoalsChange(root, info, { op, id, tag, sessionId: String(exec?.agent?.session?.header?.id ?? "") });
        return { ok: true, id, created: r.created ?? existing === undefined, status: st, parent, relPath: r.relPath ?? r.dirRel, lines: r.lines, mode: r.card === undefined ? "file" : "card" };
      }

      return { ok: false, reason: `不认识的 op：${op}` };
    },
  };
}

/** 目标改动 ⇒ 审计（与台账/原则同一套；用户要求"两个需要维护的东西"都同步到日志）。 */

export function recordGoalsChange(root, info, rec) {
  try {
    appendAudit(root, info, {
      kind: AUDIT_KIND_GOALS,
      tag: rec.tag ?? "(无编号)",
      target: "goals",
      mode: rec.op,
      relPath: info.goalsRel ?? DEFAULT_GOALS_NAME,
      lines: 0,
      sessionId: rec.sessionId,
    });
  } catch {
    /* 审计失败不许挡住目标写入 */
  }
}

/**
 * 把目标树文件登记进清单（只补字段，绝不动别的）。
 *
 * @returns {{ok:boolean, skipped?:boolean, reason?:string, mirror?:object}}
 *   ★★★ 2026-10-23（D313，GPT 静态审查 001 的 F04 附带项）：**必须返回写盘结果。**
 *   🔴 原来它 `return;`（无返回值）且**吞掉** `writeManifestSynced` 的结果 ——
 *     调用方若想知道"登记成了没有"就永远拿不到。F04 指出的正是这一类：
 *     **写失败被静默吞掉，上层误以为成功。**
 *   ★ 现在的契约与 `registerCardDirInManifest` 一致（同一条纪律：**同一件事的两个实现必须同契约**）。
 *   ★ 语义保留：**它仍然不抛**（"只补一个字段"不该炸掉整个业务写入）——
 *     但**必须把失败如实交出去**，由调用方决定怎么处理。这两件事不矛盾：
 *     "不打断"与"不隐瞒"是两件事。
 */
export function registerGoalsInManifest(root, info, rel) {
  const cur = info?.manifest;
  if (cur === null || typeof cur !== "object") {
    return { ok: false, reason: "拿不到清单对象（info.manifest 不可用）" };
  }
  // ★ 已经登记过 ⇒ 幂等成功，但**说清是 skipped**
  if (typeof cur.goals === "string" && cur.goals !== "") {
    return { ok: true, skipped: true, reason: `\`goals\` 已登记为 \`${cur.goals}\`` };
  }
  const next = { ...cur, goals: rel };
  // ★ 走统一出口（原子写 + 同步镜像），**并把结果交出去**（D310 修的写，D313 补的契约）。
  const w = writeManifestSynced(root, next);
  if (w?.ok !== true) return { ok: false, reason: w?.reason ?? "清单写入失败（未给原因）" };
  return { ok: true, skipped: false, mirror: w.mirror };
}

/**
 * ★★★★★ 2026-10-14（D189）：把**根本原则**文件登记进清单（只补字段，绝不动别的）。
 *
 * ★ 与 `registerGoalsInManifest` **逐字同一套做法** —— 复用已验过的模式，不新造机制。
 * ★ 它只在"用户授权后首次建立 PRINCIPLES.md"这一条路上被调用（见 `writePrinciples`）。
 * ★★ 2026-10-23（D313 / F04 附带项）：**契约与 `registerGoalsInManifest` 完全一致**（返回写盘结果）。
 *    ★ 判据：**"逐字同一套做法"必须包括"怎么回报成败"** —— 只复制前半段（怎么写）
 *      而漏掉后半段（怎么报），就正是 F04 那个病的形状。
 *
 * @returns {{ok:boolean, skipped?:boolean, reason?:string, mirror?:object}}
 */
export function registerPrinciplesInManifest(root, info, rel) {
  const cur = info?.manifest;
  if (cur === null || typeof cur !== "object") {
    return { ok: false, reason: "拿不到清单对象（info.manifest 不可用）" };
  }
  if (typeof cur.principles === "string" && cur.principles !== "") {
    return { ok: true, skipped: true, reason: `\`principles\` 已登记为 \`${cur.principles}\`` };
  }
  const next = { ...cur, principles: rel };
  const w = writeManifestSynced(root, next);
  if (w?.ok !== true) return { ok: false, reason: w?.reason ?? "清单写入失败（未给原因）" };
  return { ok: true, skipped: false, mirror: w.mirror };
}



/** 交接单文件名：`YYYY-MM-DD-HHmm-主题.md`（日期在前 ⇒ 目录里天然按时间排序）。 */

export function handoffFileName(now, title) {
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

export function latestHandoffIn(projectRoot, handoffAbs) {
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

export function noteFileName(now, title) {
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

export function renderNote({ title, kind, problem, cause, conclusion, actions, files, related }, stampText) {
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

export function findWorkspaceRoot(start, maxUp) {
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

export function conformanceOf(info) {
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
  //
  // ★★★★★ 2026-10-16（D220）**真缺陷修复**：卡片模式下这条判据**必须改判目录**。
  //
  //   **病**（本项目真撞到）：卡片化之后 `decisions/` 有 220 张卡，而清单里**同时**留着
  //   旧键 `decisions: "DECISIONS.md"`。`inspect()` 照旧算出 `decisionsRel = "DECISIONS.md"`
  //   ⇒ 下面这段**只看那个单文件**、文件早被删了 ⇒ 报
  //     「清单登记了关键决策记录 `DECISIONS.md`，但**该文件不存在**（硬约束之一）」
  //   ⇒ ★ 更糟的是它给出的"可修"建议是**「创建一个空的决策记录 `DECISIONS.md`」** ——
  //     照做就等于**把卡片化往回推**（重建单文件），而真正的问题只是**清单里留了个过时键**。
  //
  //   ★ 判据：**"这一类现在住在哪"只能有一个答案，而那个答案由 `cardModeOf` 说了算**
  //     （与 `part4.js:2153` 那条"读写必须问同一个 `cardModeOf`"是同一条纪律）。
  //     ⇒ 卡片模式（`<kind>Dir` 已登记）下：合规 = **该目录在且里面有卡**，
  //       而旧单文件键**只是在不在都已与合规无关**。
  {
    const cmode =
      typeof cardModeOf === "function" ? cardModeOf(info, "decisions") : { card: false };
    if (cmode.card === true) {
      // ★ V3（D289）：卡片目录是**记忆** ⇒ 基准 `memoryBase`。
      const mBase = memoryBaseOf(info, info.projectRoot);
      const dirAbs = path.resolve(mBase, cmode.dirRel);
      const dirOk = isUnder(mBase, dirAbs) && fs.existsSync(dirAbs);
      let cards = 0;
      if (dirOk) {
        try {
          cards = fs.readdirSync(dirAbs).filter((n) => /\.md$/i.test(n) && !/^INDEX\.md$/i.test(n)).length;
        } catch {
          cards = 0;
        }
      }
      if (!dirOk || cards === 0) {
        reasons.push(
          dirOk
            ? `卡片目录 \`${cmode.dirRel}\` 里**一张决策卡都没有**（硬约束之一）`
            : `清单登记了卡片目录 \`${cmode.dirRel}\`，但**该目录不存在**（硬约束之一）`
        );
        fixable.push(dirOk ? "往卡片目录里补决策卡" : `创建卡片目录 \`${cmode.dirRel}\``);
      }
    } else {
      // ★ V3（D289）：决策记录是**记忆** ⇒ 基准 `memoryBase`（校验同基准）。
      const mBase = memoryBaseOf(info, info.projectRoot);
      const abs =
        info.decisionsRel === undefined ? undefined : path.resolve(mBase, info.decisionsRel);
      const exists = abs !== undefined && isUnder(mBase, abs) && fs.existsSync(abs);
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
  }
  {
    // ★ V3（D289）：归档目录是**记忆** ⇒ 基准 `memoryBase`。
    const mBase = memoryBaseOf(info, info.projectRoot);
    const abs =
      info.archiveRel === undefined ? undefined : path.resolve(mBase, info.archiveRel);
    const exists = abs !== undefined && isUnder(mBase, abs) && fs.existsSync(abs);
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

  // ── ★★★★★ 2026-10-23（D310，审计员010 F-07 实锤）：**V3 核心机制专项体检** ──────
  //
  //   ★ 实现在 `lib/v3-conformance.js`（**叶子模块**，不成环）。
  //     抽出去的两个理由：① 本文件只剩 3512 B 余量（硬上限 262,144 B）；
  //     ② 语义上它回答的是"第 3 代的四项保障在不在"，与本函数里那一大堆
  //        "V2 登记资产在不在"本来就不是一回事。
  //   ★ 触发条件用 `memoryRoot` 有值 —— **不是** `info.isV3`（那个字段 inspect() 根本不返回，
  //     我第一版写成 `info.isV3 === true` ⇒ 恒假 ⇒ 四条断言全红，看着像"修了没用"）。
  {
    const gaps = v3ConformanceGaps(info, { memoryBaseOf });
    for (const r of gaps.reasons) reasons.push(r);
    for (const x of gaps.fixable) fixable.push(x);
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

  // ── ★★★★★ 2026-10-19（D272）：**记忆协议版本**（这是本次真正补上的缺口）──────
  //
  //   🔴 改造前的盲区：上面每一条判据问的都是「**登记过的东西对不对**」，
  //     于是「**该登记而根本没登记**」一路放行 ⇒ 老项目永远判 OK ⇒
  //     **模型既不会被告知、也不会去动它**。
  //     用户实测：另一台设备升到最新版，架构一个字节都没变（3~4 篇越来越长的
  //     单文件 + 一个不断累积的日志），而插件全程沉默。
  //
  //   ⇒ 现在把「协议代次」当成**一等判据**：
  //     · 清单没写 `protocolVersion` 或写得比代码旧 ⇒ 这里**必定**报进 reasons；
  //     · 缺口逐条带 `label` + `why`（"为什么值得升"），因为只说字段名等于让人猜；
  //     · 修复仍是**纯加法**（补键 + 建空目录），绝不改写用户已有内容。
  const proto = protocolGapOf(info.manifest);
  if (proto.outdated) {
    // ★★ 2026-10-19（D272 第二轮）：**「停在旧代」与「结构有缺口」是两件事，必须分开说。**
    //   🔴 之前这里只按 `proto.outdated` 一句 `reasons.push`，于是出现自相矛盾的输出：
    //      `记忆协议停在**第 2 代**，本插件要求第 2 代`（同一代却说"停在"，读起来像 bug）。
    //     真因是 `outdated` 现在有**两个**触发源（版本号落后 / 实际键有缺口），而文案只写了一个。
    //   ⇒ 判据：**一个判据有多个触发源时，文案必须按触发源分别写** ——
    //     否则报出来的那句话既不准确，也没法让人据此动手。
    if (proto.projectVersion < proto.currentVersion) {
      reasons.push(
        `记忆协议停在**第 ${proto.projectVersion} 代**，本插件要求第 ${proto.currentVersion} 代`
      );
    }
    for (const g of proto.missing) {
      // ★★★★★ 2026-10-23（D308 现场回归修复）：**可选代次（第 3 代）走 notes，不走 reasons。**
      //
      //   🔴 病（改完 `PROTOCOL_VERSION = 3` 之后自检当场红了 18 条）：原来这里对**每条缺口**
      //     都 `reasons.push`，而非 mechanical 的又进 `needsAI` ⇒ verdict = `NONCONFORMING`
      //     ⇒ `offerConformChoice` 弹卡片 ⇒ **每一个健康的 V2 项目升级完插件第一回合就被告知"你不合规"**。
      //     而它其实完全正常工作 —— 那只是"还没迁"，是**待办**，不是**缺陷**。
      //
      //   ★ 判据：**"新一代还没迁过来" ≠ "旧一代没做到"。**
      //     · 卡片化（D202）：旧项目自己就没做到 ⇒ 报不合规，正确；
      //     · 第 3 代：刚出现的一代 ⇒ 健康 V2 项目不该因此被催、被弹卡。
      //   ⇒ 可选缺口的正确去处是 `notes`：**能进注入给模型看**（该知道有这回事），
      //     但**不进 reasons、不进 needsAI** ⇒ 不弹卡片、不改 verdict。
      //   ★ 这与本函数顶部那条既有纪律一字不差：「可选/自愈的东西不许塞进 reasons」。
      if (g.optional === true) {
        notes.push(
          `可升级到第 ${g.since} 代：${g.label} —— ${g.why}\n` +
            `★ 这**不是缺陷**，本项目当前工作完全正常。要迁时**必须**走 \`ledger_migrate({op:"v3"})\`，` +
            `**不要**只补 \`memoryRoot\`（那会让项目根上那些真实存在的记忆从视野里消失，D272/D308）。`
        );
        continue;
      }
      reasons.push(`缺「${g.label}」：清单里没有 ${g.keys.map((k) => `\`${k}\``).join(" / ")}`);
      // ★★ `why` 一律进 `needsAI`（用户拍板前需要知道的理由），**但修法按代价分档**：
      //
      //   🔴 2026-10-19（D272 第二轮）**这是我第一版判错的地方**，写清楚免得后人改回去：
      //     我把**所有**协议缺口都归进了 `fixable`「补键 + 建空目录（纯加法，不动已有内容）」。
      //     对 `logDir` 那是对的；**对卡片化那三个键是灾难性错误**：
      //       登记 `decisionsDir` ⇒ `cardModeOf` 立刻切卡片模式 ⇒ 之后读取只去那个**空目录**找，
      //       原 `DECISIONS.md` 里的卡**从模型视野里消失**（没删、没报错、就是读不到了）。
      //     ★ 判据：**"只做加法"不能只看"没删文件"，要看"有没有内容从视野里掉出去"。**
      //   ⇒ 现在按 `mechanical` 分：日志分片 = 机械可修；卡片化 = 必须 AI 先 `ledger_migrate` 切卡。
      if (g.mechanical) {
        // ★ **不要**放进 `needsAI`：`needsAI` 非空 ⇒ verdict 变 `NONCONFORMING`
        //   ⇒ 一个"建个空目录 + 补个键"的机械动作被报成"要 AI 决定"。
        //   理由放 `notes`（给人看），动作放 `fixable`（真能自动做）。
        //   ★ 判据：**归类决定 verdict，所以归类必须按"谁来做"分，不能按"重要性"分。**
        notes.push(`${g.label} —— ${g.why}`);
        fixable.push(
          `补清单键 ${g.keys.map((k) => `\`${k}\``).join(" / ")} + 建对应空目录（纯加法，不动已有内容）`
        );
      } else {
        needsAI.push(
          `${g.label} —— ${g.why}\n` +
            `★ **不要**直接补这几个清单键：一旦登记成卡片目录，读取就会切过去，` +
            `原来的单文件内容会**从视野里消失**（文件还在，但没有任何一处读它）。` +
            `正确顺序是先用 \`ledger_migrate\`（看内容切卡）→ 再登记键。`
        );
      }
    }
    // ★★★ 只有"缺结构且全都能机械补"才算 `UPGRADEABLE`；
    //   只要有一条需要看得懂内容（卡片化），就必须 `NONCONFORMING`。
    //
    //   ★ 为什么保留"只缺版本号 ⇒ 可修"这条：那是**纯一个数字**，不涉及任何结构。
    //     判据必须与代价相称 —— 把"写一个数"报成"要 AI 决定"会让噪声淹掉真缺陷。
    if (proto.missing.length === 0) {
      fixable.push(
        `在清单里补 \`protocolVersion: ${proto.currentVersion}\`（**纯加一个字段**，不动任何内容）`
      );
    }
  } else if (proto.projectVersion > proto.currentVersion) {
    // ★ 不前向破坏：别人用更新的插件建的项目，旧插件不该把它判成"要回退"。
    notes.push(
      `项目协议是第 ${proto.projectVersion} 代，比本插件（第 ${proto.currentVersion} 代）更新 —— 不做任何改动`
    );
  }

  if (reasons.length === 0) {
    return { verdict: CONFORMANCE.OK, reasons, fixable, needsAI, notes };
  }
  const verdict = needsAI.length > 0 ? CONFORMANCE.NONCONFORMING : CONFORMANCE.UPGRADEABLE;
  return { verdict, reasons, fixable, needsAI, notes, protocol: proto };
}

/**
 * 在项目**根目录**找一份"事实上的台账"（保守命名）。
 *
 * ★ 只在根目录找，不下钻：子目录里的 `进度台账-….md` 往往是**某一轮的工作底稿**
 *   （实测那份 249 行的就是，而且开头标明已完成）—— 那种是历史档案，不该被接管。
 * ★ 排除 README / AGENTS / CHANGELOG / 交接单：它们各有用途，不是台账。
 */

export function findDeFactoLedger(projectRoot) {
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




// ═══════════════════════════════════════════════════════════════════════════
// ★★★★★ 2026-10-23（D307）：上面这 16 个纯基础函数**已搬到 `lib/base.js`**
//   （只依赖 node 内建 ⇒ 叶子模块 ⇒ 不可能成环）。
//   ★ 这里保留 **re-export**，所以 `import { … } from "./part2.js"` 的调用方**一个都不用改**。
//   ★ 判据：**搬实现可以，改调用面不行** —— 后者会把"体积问题"变成"全库回归问题"。
// ═══════════════════════════════════════════════════════════════════════════
export {
  textOut,
  fail,
  isUnder,
  isUnderReal,
  realpathOf,
  nearestExistingAncestor,
  writeFileAtomic,
  countLines,
  readTextSafe,
  lossless,
  ensureDir,
  memoryBaseOf,
  toGitRel,
  archiveStamp,
  stamp,
  stampSec,
  // ★★★★★ 2026-10-23（D310）：跨卷安全移动（`migrateToV3` 搬旧文件用）。
  //   放在这里 re-export 的理由：`part7.js` 只 import part2（既有方向），
  //   直接 import base 会**新开一条边** —— 而 part7 → part2 → base 已经有了。
  moveAcrossVolumes,
} from "./base.js";

// ═══════════════════════════════════════════════════════════════════════════
// 设置面板的后端（HTTP 小工具 + 读写）
// ═══════════════════════════════════════════════════════════════════════════
//
// 形状抄自本工作区已验证的两处：另一个插件的 `lib/index.js` 与
// `7.模型路由/lib/index.js`（都是 `webServer.register` + `sendJson` + `readBody`）。
// ★ 这里**不复用**它们的文件（那是别的插件，跨插件 import 会把两个插件的生命周期绑死），
//   但形状保持一致 —— 本机排障时一眼就认得。

/** 设置路由的前缀。带包名，绝不可能撞上别人的路由。 */

export function sendJson(res, status, obj) {
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

export function readBody(req, limit = 1 << 20) {
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

export function handleFor(handler) {
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

export function deriveSettingsView(ctx) {
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
    // ★★★★★ 2026-10-15（D211）：面板要显示"推送过几次"，也要显示**当前项目的清单** ——
    //   后者是回答用户那句「只对新对话生效的，不能对旧对话生效吗」的关键：
    //   清单里的值是**每回合现读**的（探针 `_probe-d211-live-manifest.mjs` 实测）
    //   ⇒ 改它**下一个回合就生效**，与面板那个"新项目默认值"是两码事。
    broadcastSeq: settingsBroadcastSeqOf(),
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

export function findSettingsEntry(editor) {
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

/**
 * ★★★★★ 2026-10-16（D221）：**请求授权闸门** —— 面板路由不在 `/api` 之下，官方**不替我们鉴权**。
 *
 * ★ 这是 DSH STORE 审核员复核时指出的**唯一阻塞**（issue #1376）。
 *   官方 webserver 的逐字自述（`@deepseek-ai/dsh-host-webserver` README「Known Limitations」）：
 *     *"**No server-wide TLS, authentication, or origin policy** — route owners such as
 *       `dsh-client-connection` enforce their own request policy."*
 *   ⇒ **谁注册路由，谁负责鉴权。** 我们原来没做 ⇒ 同机任何进程、任何网页
 *     对着 `127.0.0.1:<port>` 发一个 GET 就能读走全部设置
 *     （**实测复现**：我们的路由 `200` + 9532 字节；同一时刻官方 `/api/health` `401`）。
 *
 * ★ 修法**不自己造鉴权**，而是用官方**为这种情形专门准备**的那个方法
 *   （活内核 `cordis_inspect` 的 Service 契约，逐字）：
 *     `connection.requestRejection(request)` ——
 *     *"Apply Connection's Host/Origin checks and browser authentication to **another Web route**."*
 *     *"rejection status, or undefined when the route may accept the request."*
 *   ⇒ 它一次做两件事：① Host/Origin 围栏（挡 DNS rebinding 与跨站请求）
 *     ② 浏览器会话鉴权（`dsh-auth-*` 签名 cookie）。返回 `401 | 403 | undefined`。
 *
 * ★★ 为什么**取不到授权上下文就拒绝**（fail closed）：
 *   「拿不到 `connection` 就当没这回事、照常放行」**正是被指出的那个毛病本身**。
 *   取不到 ⇒ 我们**无法判定调用者是谁** ⇒ 一律 `503` 拒绝，并说清原因
 *   （宁可面板暂时用不了，也不让设置被匿名读走）。
 *   ★ 什么情况下真的会取不到：纯 CLI 宿主 —— 而它**本来就没有 `webServer`**，
 *     这两条路由压根不会注册（见 `lib/index.js` 的软失败）。
 *
 * ★★ 为什么加了它**不会弄坏桌面端面板**（这条我单独查过，不是想当然）：
 *   活桌面端主进程 `app.asar` 的 `lib/main.js:11589-11603` 会为**发往宿主的那条请求**
 *   主动改写头并补上面板 cookie：
 *     `origin: target.origin` · `cookie: hostCookie` · `sec-fetch-site: "same-origin"`
 *   （`hostCookie` 来自 `authenticateWebHost(ready.url)`，即官方那次 `?token=` 换 cookie）
 *   ⇒ 桌面端请求**带 cookie、Origin 也对** ⇒ 过闸。
 *   而 `dsh-app://app` 之外的来源，主进程自己就 `cancel` 掉了。
 *
 * @param {object} scope 注入了 `webServer` 的那个 ctx（用它 `get("connection")`）
 * @param {Function} handler 真正的业务 handler
 * @returns {Function} 已过闸门的 handler
 */
function settingsGate(scope, handler) {
  return (req, res) => {
    const verdict = authorizeRequest(scope, req);
    if (verdict.allowed !== true) {
      sendJson(res, verdict.status, { ok: false, error: verdict.error });
      return undefined;
    }
    // ★ 把授权结论**传给下游**（而不是只在闭包里）。下游 handler 自己还会断言一次
    //   （见 `assertAuthorized`），这样审核者无论从哪一层开始读，都能看到授权检查。
    try {
      req.__ledgerAuthorized = { at: Date.now(), status: 0 };
    } catch {
      /* 有些 req 是冻结对象 ⇒ 拿不到就靠下游自查，绝不因此放行 */
    }
    return handler(req, res);
  };
}

/**
 * ★★★★★ 2026-10-18（D258）：**授权判定抽成独立函数 + 下游可自查**。
 *
 * 为什么要有这一层（这是 DSH STORE 复核否决的直接回应）：
 *   审核员读的是 `saveSettings` 内部，看到它直接调 `configEditor.edit()`，
 *   就判「没有建立调用方授权」。而实际闸门在 `webServer.register` 那一层
 *   （`handler: handleFor(settingsGate(scope, handler))`）—— **他漏了外层包装**。
 *
 * 与其争辩「你看漏了」，不如**让检查在两处都看得见**：
 *   ① 路由层 `settingsGate` 用本函数判定（第一道）；
 *   ② 业务层 `saveSettings` / broadcast 用 `assertAuthorized` 再断言一次（第二道，冗余）。
 *   ⇒ 任何从任一层开始读的人，都能看到 fail-closed 的授权判定。
 *
 * ★ 判定规则（三档全拒，`allowed` 只在明确通过时为 true）：
 *   - 取不到 `connection` / 没有 `requestRejection` ⇒ `503`（判不出调用者是谁，宁可不伺候）
 *   - `requestRejection` 抛错 ⇒ `403`（判不了 = 不放行）
 *   - 返回非 undefined ⇒ 按它给的状态码拒（`403` 跨源 / `401` 需会话）
 *   - 返回 undefined ⇒ `allowed: true`
 *
 * @returns {{allowed: boolean, status?: number, error?: string}}
 */
export function authorizeRequest(scope, req) {
  let connection;
  try {
    connection = typeof scope?.get === "function" ? scope.get("connection") : undefined;
  } catch {
    connection = undefined;
  }
  if (connection === undefined || typeof connection.requestRejection !== "function") {
    return {
      allowed: false,
      status: 503,
      error:
        "本机没有可用的 `connection` 服务（宿主请求授权上下文缺失），" +
        "已按安全默认拒绝这次设置读写。设置面板需要 DSH 宿主自带该服务时才可用；" +
        "插件本体（台账 / 压缩 / 日志）不受影响。",
    };
  }
  let rejection;
  try {
    rejection = connection.requestRejection(req);
  } catch (e) {
    return {
      allowed: false,
      status: 403,
      error: `请求授权检查失败，已拒绝：${String((e && e.message) || e)}`,
    };
  }
  if (rejection !== undefined) {
    return {
      allowed: false,
      status: rejection,
      error:
        rejection === 403
          ? "请求不是同源的（Host / Origin 未通过围栏）。"
          : "需要浏览器会话授权：请从本机打印的那条带令牌的地址打开面板。",
    };
  }
  return { allowed: true };
}

/**
 * ★ 业务层自查（第二道闸）。`scope` 与 `req` 都拿得到时重算一遍；
 *   **任何一项拿不到 ⇒ 拒绝**（fail closed，绝不因为「查不了」而放行）。
 *
 * ★ 为什么允许 `scope === undefined` 的既有调用路径不算违规：
 *   本插件的 `saveSettings(scope, req, res)` 与 broadcast handler 都从路由层进来，
 *   `scope` 一定在；若将来有人直接调它而没给 scope，本函数会返回拒绝 ⇒ 也没事。
 */
export function assertAuthorized(scope, req) {
  if (req === undefined || req === null) {
    return { allowed: false, status: 503, error: "内部调用缺少请求对象，已拒绝。" };
  }
  const verdict = authorizeRequest(scope, req);
  if (verdict.allowed !== true) return verdict;
  // ★ 与路由层互证：两边都通过才算真通过（路由层若没跑过，这里也照样独立判定）。
  return { allowed: true };
}


export function installSettingsRoutes(scope, view, ctx) {
  const registered = [];
  const failures = [];
  const reg = (p, handler) => {
    try {
      const dispose = scope.webServer.register({
        kind: "exact",
        path: SETTINGS_PREFIX + p,
        // ★ D221：先过授权闸门，再进业务 handler（`handleFor` 在最外层兜异常）。
        handler: handleFor(settingsGate(scope, handler)),
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

  // ★★★★★★ 2026-10-15（D211，用户拍板）：**「推送到所有对话」那颗按钮**。
  //
  //   ★ 用户原话（逐字）：*"其实还应该在设置面板中加一个按钮，这个按钮允许主动向每个对话的
  //     新的回复中注入这个设置，这样的话我可以真正保证那个对话读到我们的改动，而不会被忽略。"*
  //
  //   ★ 它做什么：**只**把 `settingsBroadcastSeq` +1（一个进程内的整数）。
  //     而那个序号进了 `fingerprintOf`（去重判据）⇒ 序号一变 ⇒ 指纹变 ⇒
  //     **每个对话的下一次 pre-step 都会重注那份设置快照**。
  //   ★★ 为什么这样最可靠（而不是"广播一条消息给所有会话"）：
  //     本插件**没有**"向别的会话推消息"的能力（`agent.steer` 只对当前那一个 agent 有效），
  //     而 `pre-step` 注入是**每个会话各自、每回合**都会走的路 ⇒ 改一个全局判据，
  //     比去够每个会话可靠得多（也**不需要**知道有哪些会话在跑 —— 那是内核的事）。
  //   ★ 为什么它**安全**、不影响准确性：它只让"设置快照"那段文字重注一次，
  //     台账正文的重注仍受原指纹支配（D132 的省流逻辑没被绕过 —— 内容没变照样不注）。
  reg("/broadcast.json", (req, res) => {
    // ★★★★★ D258：**业务层自查（第二道闸）** —— 在 `bumpSettingsBroadcast()` 这个
    //   全局副作用发生之前再判定一次授权。理由同 `saveSettings`。
    const verdict = assertAuthorized(scope, req);
    if (verdict.allowed !== true) {
      sendJson(res, verdict.status, { ok: false, error: verdict.error });
      return;
    }
    if (req?.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "请用 POST。" });
      return;
    }
    const seq = bumpSettingsBroadcast();
    sendJson(res, 200, {
      ok: true,
      seq,
      text:
        `已请求把「⚙️ 当前设置」推送到**每个对话的下一条回复**里（第 ${seq} 次）。\n` +
        "★ 各对话在**下一次说话时**就会收到 —— 不必重启，也不必新开对话。",
    });
  });

  // ── ★★★★★ 2026-10-21（1.5.0）：**自定义扩展记忆**的读写入口 ────────────
  //
  //   ★ 为什么走 `settings.section` 的**同一批路由**、而不是另开一套：
  //     ① 那道闸门（`settingsGate` + `assertAuthorized`）是**两层授权**，已经验过；
  //        另开一套就要再写一遍，两套判据必然分叉（D25）。
  //     ② 面板本来就在这个前缀下，前端不必多认一个 base。
  //
  //   ★★★ **"允许哪些项目根"这条判据绝不能放开**（这是本路由唯一的安全边界）：
  //     名单**只取活跃 root 会话的生效项目根**（`agents.roots()` → `projectRootOf`），
  //     与 `ledger_extension` 工具那条路是**同一个出口**。
  //     ⇒ 前端传一个任意绝对路径（例如 `C:\`）一律 403 —— **不许**"传什么就干什么"。
  //     ★ 取不到 `agents` 服务 ⇒ 503 + 一句人话，**绝不**退化成"随便传个根都照做"。
  const allowedRootsOf = () => {
    const agents = (() => {
      try {
        return ctx?.get?.("agents");
      } catch {
        return undefined;
      }
    })();
    if (agents === undefined || typeof agents.roots !== "function") {
      return { ok: false, status: 503, error: "当前取不到会话服务，无法确定可配置的项目。请稍后重试。" };
    }
    let roots;
    try {
      roots = agents.roots();
    } catch (e) {
      return { ok: false, status: 503, error: `列出会话失败：${String((e && e.message) || e)}` };
    }
    const list = [];
    for (const ag of Array.isArray(roots) ? roots : []) {
      const r = projectRootOf(ag);
      if (typeof r === "string" && r !== "" && !list.includes(r)) list.push(r);
    }
    return { ok: true, roots: list };
  };

  reg("/extensions.json", (req, res) => {
    return (async () => {
      // ★ 业务层自查（第二道闸）：与 `saveSettings` 同一口径 —— 写之前再判一次。
      const verdict = assertAuthorized(scope, req);
      if (verdict.allowed !== true) {
        sendJson(res, verdict.status, { ok: false, error: verdict.error });
        return;
      }
      const allowed = allowedRootsOf();
      if (allowed.ok !== true) {
        sendJson(res, allowed.status, { ok: false, error: allowed.error });
        return;
      }
      // 模式清单由服务端出 ⇒ 客户端零硬编码（以后加模式只改 part8 一处）。
      const modes = EXT_MODE_KEYS.map((k) => ({
        key: k,
        label: EXT_MODES[k].label,
        hint: EXT_MODES[k].hint,
      }));

      if (req?.method !== "POST") {
        const projects = [];
        for (const root of allowed.roots) {
          let info;
          try {
            info = inspect(root);
          } catch {
            continue;
          }
          let listed;
          try {
            listed = listExtensions(info, root);
          } catch (e) {
            projects.push({ root, name: path.basename(root), error: String((e && e.message) || e), extensions: [] });
            continue;
          }
          if (listed.ok !== true) {
            projects.push({ root, name: path.basename(root), error: listed.reason, extensions: [] });
            continue;
          }
          projects.push({
            root,
            name: path.basename(root),
            registryPath: listed.registryPath,
            inconsistent: listed.inconsistent,
            extensions: listed.extensions.map((x) => ({
              id: x.id,
              name: x.name,
              description: x.description,
              mode: x.mode,
              modeLabel: x.modeLabel,
              modeHint: x.modeHint,
              inject: x.inject,
              createdAt: x.createdAt,
              updatedAt: x.updatedAt,
              storagePath: x.storagePath,
              usage: x.usage,
            })),
          });
        }
        sendJson(res, 200, { ok: true, modes, projects, roots: allowed.roots.length });
        return;
      }

      let body;
      try {
        const raw = await readBody(req);
        body = raw === "" ? {} : JSON.parse(raw);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${String((e && e.message) || e)}` });
        return;
      }
      const root = typeof body?.root === "string" ? body.root : "";
      // ★★ 允许名单之外一律拒绝 —— 这是"面板不能当通用文件读写口"的那条线。
      if (!allowed.roots.includes(root)) {
        sendJson(res, 403, { ok: false, error: "这个项目不在当前可配置的名单里（面板只允许活跃会话的项目根）。" });
        return;
      }
      let info;
      try {
        info = inspect(root);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `项目无法解析：${String((e && e.message) || e)}` });
        return;
      }
      const op = String(body?.op ?? "");
      let r;
      try {
        if (op === "create") {
          r = createExtension(info, root, {
            name: body?.name,
            description: body?.description,
            mode: body?.mode,
            inject: body?.inject,
          });
        } else if (op === "update") {
          r = updateExtension(info, root, body?.id, {
            name: body?.name,
            description: body?.description,
            inject: body?.inject,
          });
        } else if (op === "delete") {
          r = deleteExtension(info, root, body?.id, { confirm: body?.confirm === true });
        } else {
          sendJson(res, 400, { ok: false, error: `不认识的 op：${op}` });
          return;
        }
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
        return;
      }
      // ★ 业务拒绝（重名 / 保留名 / 空名称 / needConfirm）走 **200 + ok:false** ——
      //   那些 reason 是写给用户看的一句话，客户端原样显示即可，不当红色报错。
      sendJson(res, 200, r);
    })();
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

export function saveSettings(scope, req, res) {
  return (async () => {
    // ★★★★★ D258：**业务层自查（第二道闸）** —— 在任何副作用（尤其 `configEditor.edit`）
    //   发生**之前**再判定一次调用方授权。理由见 `authorizeRequest` 的注释：
    //   路由层已经拦过，这里再拦一次是**冗余而非替代** —— 目的是让「授权发生在写之前」
    //   这件事在 `saveSettings` 内部也看得见，不必追到 `webServer.register` 才成立。
    const verdict = assertAuthorized(scope, req);
    if (verdict.allowed !== true) {
      sendJson(res, verdict.status, { ok: false, error: verdict.error });
      return;
    }

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

export function defaultLogLevels() {
  return currentSettings().logLevels;
}

/**
 * 归一化档位设置。接受 `{L0:true,...}` / 数组 / undefined。
 * ★ 返回的**始终是四项齐全**的对象：开关判断点因此不必到处写 `?.` 兜底。
 */

export function parseLevels(raw, fallback) {
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

export function levelOn(info, level) {
  // ★ D222：改走**唯一出口**（默认「以面板为准」⇒ 面板上那 5 个档位开关对所有项目立刻生效）。
  const levels = parseLevels(precedenceValue(info, "logLevels"), defaultLogLevels());
  return levels[level] === true;
}

/** 日志根目录（相对路径）：清单里没登记就不采集（**绝不擅自往项目里塞目录**）。 */

export function logDirOf(info) {
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

export function logFileRel(info, level, now) {
  const dir = logDirOf(info);
  if (dir === undefined) return undefined;
  const { dir: period } = archiveStamp(now, info?.manifest?.archiveWeekMode);
  const base = LOG_LEVEL_FILES[level];
  if (base === undefined) return `${dir}/${period}/${base}`;

  // ★★★★★ 2026-10-18（D255）：**按大小滚动拆片**。
  //
  //   ★ 这一段是**所有写入的唯一出口**（part3 的 L0/L2/L3/L4、part4 的 L0-ledger-changes、
  //     part5 的 L1 全走它）⇒ 只改这里，六处写入一起生效。
  //   ★ 读取侧**不用改**：`logFileList` 只认 `^(L[0-4])-.*\.md$` 并递归，
  //     所以 `L2-files-002.md` 天然会被收进来。
  //   ★ 阈值与命名都在 `defs.js`（`LOG_SHARD_MAX_BYTES` / `shardName`）——
  //     这里是唯一判据，别在别处再写一份（D59：两处各一份必然分叉）。
  // ★ V3（D289）：日志是**记忆** ⇒ 用 `memoryBase`（不是 `projectRoot`）。
  //   ★ 原来这里是 `info?.projectRoot`；V3 下日志目录搬进了记忆子目录，
  //     若仍拿项目根去 `stat`，每次都会**拿不到大小 ⇒ 当成 0** ⇒
  //     **拆片阈值永远不触发**，日志只涨不滚（而它不报错，只是悄悄不生效）。
  const root = memoryBaseOf(info, info?.projectRoot);
  if (typeof root !== "string" || root === "") {
    // 拿不到项目根 ⇒ **退回老行为**（不能因为拆片逻辑而让日志写不进去）。
    return `${dir}/${period}/${base}`;
  }
  const sizeOf = (rel) => {
    try {
      return fs.statSync(path.resolve(root, rel)).size;
    } catch {
      // ★ 拿不到就当 0：**绝不让 IO 失败阻断日志写入**（D47 铁律的另一面）。
      return 0;
    }
  };
  for (let n = 1; n <= LOG_SHARD_MAX_COUNT; n += 1) {
    const rel = `${dir}/${period}/${shardName(base, n)}`;
    if (sizeOf(rel) < LOG_SHARD_MAX_BYTES) return rel;
  }
  // ★ 到片数上限：**继续写最后一片**（宁可它变大，也绝不丢条目）。
  return `${dir}/${period}/${shardName(base, LOG_SHARD_MAX_COUNT)}`;
}

/**
 * 日志行格式：`- 2026-10-08 10:23:41 (kind) 正文`
 *
 * ★ 刻意是**面向人的 markdown**、不是 JSONL：日志要能被 `read`/`grep` 直接看，
 *   而 grep 恰好就是回溯时最常用的手段。二进制/JSONL 会让 grep 结果不可读。
 *   代价是解析要按格式约定来 —— 因此解析器是**容错**的：认不出的行照样返回，
 *   只是没有结构化字段（宁可回一堆原文，也不要"读不到"）。
 */

export function parseLogLine(level, raw) {
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

export function renderUserMessageBody(content) {
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

export function archiveEvictedUserMessage(root, info, msg, sid) {
  try {
    if (typeof root !== "string" || root === "") return false;
    const rel = info?.archiveRel;
    if (typeof rel !== "string" || rel === "") return false;
    const text = typeof msg?.text === "string" ? msg.text : "";
    if (text === "") return false;
    const now = new Date();
    // ★★★★★ 2026-10-13（D170）：路径走**唯一出口** `userMsgArchiveRel` ——
    //   原来这里自己 `path.join(root, rel, period, USER_MSG_ARCHIVE_FILE)`，
    //   而渲染那侧（`renderCapsule`）自己拼了另一份（还带 `?? "_ledger-archive"` 兜底）
    //   ⇒ 两遍会在"没有清单的会话"上分叉成"写不出来 vs 印一个假路径"。
    const relFile = userMsgArchiveRel(info, now);
    if (relFile === undefined) return false;
    const file = path.join(memoryBaseOf(info, root), ...relFile.split("/"));
    ensureDir(path.dirname(file));
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

export function renderUserMessageLine(content, tag, when) {
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

export function userMessageOf(event) {
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

export function briefOf(toolName, rawArgs, cap) {
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

export function fileOpsOf(toolName, rawArgs) {
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

export function isErrorResult(event) {
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

export function errorTextOf(event) {
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
/**
 * ★★★★★ 2026-10-13（D168）：胶囊**每条会话记录**的**唯一构造出口**。
 *
 *   病因（真机，不是推断）：这个形状原来被**搭了两遍**而且**两遍不一样** ——
 *     · `createCapsuleMemory().rec()`      ⇒ 有 `seenMsgIds`；
 *     · `hydrateCapsuleMemory()` 内存空时 ⇒ **漏了** `seenMsgIds`。
 *   而 `consume()` 处理**用户原话**的第一件事就是 `r.seenMsgIds.has(um.id)`
 *   ⇒ 拿到 hydrate 搭的那条记录 ⇒ **TypeError** ⇒ 被 `session/event` 的
 *   `catch` **静默吞掉**（L15084 那一层是故意的：不许连累官方写日志）。
 *
 *   ★ 为什么"只有用户原话丢"（这是本缺陷最强的指纹）：
 *     `consume` 里三条路，**只有用户原话读 `seenMsgIds`** ——
 *     报错原文、器物索引那两条根本不碰它 ⇒ **照常入库**。
 *     真机症状正是这个不对称：`errors` 更新到 13:23，`artifacts` 记到了 14:41，
 *     而 `userMessages` **停在 03:05**（第一次"压缩后重启"之前）。
 *
 *   ★ 为什么必然跨重启复发：`seenMsgIds` 只活在内存记录里，
 *     hydrate 恰好只在**内存空**（= 刚重启）时走那条分支。
 *     真机三个进程边界（P2 03:27 / P3 04:28 / P4 13:09）后的**首条原话
 *     全部缺席**（seq 56478 / 57288 / 57727 都不在盘上）—— 而且之后**永远补不回来**，
 *     因为记录一经 hydrate 就被 `set` 回内存，那条记录**整个进程**都缺这个字段。
 *
 *   ★ 修法遵守 D165/D164 那条纪律：**同一个形状不许搭两遍** ——
 *     两处都改成调这个函数，以后加字段只改一处。
 *     （只给 hydrate 补一个 `new Set()` 也能治今天，但下次再加字段还会分叉。）
 */

export function newCapsuleRecord() {
  return {
    /** 逐字用户消息（新→旧，落盘时再反转）。 */
    userMessages: [],
    /** 逐字失败原文（新→旧）。 */
    errors: [],
    /** 器物索引：绝对路径 → { op, at, tool }（后写覆盖，天然去重）。 */
    artifacts: new Map(),
    /** 已记过的用户消息 id，防同一事件被喂两次。 */
    seenMsgIds: new Set(),
  };
}

export function createCapsuleMemory() {
  /** 每条会话的逐字素材。key = sid。 */
  const bySid = new Map();

  function rec(sid) {
    let r = bySid.get(sid);
    if (r === undefined) {
      r = newCapsuleRecord();
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
          //   ★★★★★ 2026-10-13（D170）：这段逻辑已收进 `trimUserMessagesInPlace()` ——
          //     因为 `hydrateCapsuleMemory()` 那侧有一份**只 slice、不归档**的重复实现
          //     （实测：设置调小后重启，7 条原话无声消失）。上限也改走唯一出口。
          trimUserMessagesInPlace(r, capsuleUserMsgMaxOf());
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
        // ★★★★★ 2026-10-13（D170）：截断走唯一出口（原来这里手写 `.length = errMax`，
        //   而 hydrate 那侧写的是 `.slice(0, errMax)` —— 同一个动作两处各写一遍）。
        trimErrorsInPlace(r, capsuleErrorMaxOf());
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

export function createCapsulePersister(capsule, sidOf) {
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

export function renderCapsule(info, mem, opts) {
  if (mem === undefined) return undefined;
  const { projectRoot } = info;
  // ★★★★★ 2026-10-21（D289 · V3）：**胶囊里所有"去哪重读"的指针都必须指到记忆子目录**。
  //
  //   ★ 为什么不沿用 `projectRoot`：胶囊的整个价值是**压缩后告诉模型"原文在哪"**。
  //     V3 下记忆文件搬进了 `<项目名>-ledger-memory/`，指针若仍打印项目根路径
  //     ⇒ 模型照着它 ls **一个都找不到** —— 这与 D164（胶囊目录指错一层）是同一个病，
  //     只是这次错的是**根**，比错一层更彻底。
  //
  //   ★ 用一个局部量收口 10 处，而不是逐处替换：这个函数里凡是拼记忆路径的
  //     都该用同一个基准，让它**在视觉上就是同一个变量**，漏一处最难查。
  const memBase = memoryBaseOf(info, projectRoot);
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
    // ★★★★★ 2026-10-13（D170）：兜底副本的路径走**唯一出口**，取不到就**不印那半句**。
    //   ★ 旧写法是 `path.join(info.archiveRel ?? "_ledger-archive", …)` —— **取不到就编一个**。
    //     而写盘那侧（`archiveEvictedUserMessage`）取不到就**直接不写** ⇒
    //     没有清单的会话（本机 104/112 场）**一条都没写过**，胶囊里却照样印着那个路径。
    //   ★ 这是 D164 的**同型**（指针指向不存在的地方 ⇒ 模型照抄读不到），
    //     而 D164 的判据当时只盖住了"胶囊目录"那一处，**没盖住这一处**。
    const archRel = userMsgArchiveRel(info, new Date());
    const viaArchive =
      archRel === undefined
        ? `> ② 本会话没有登记归档目录，**没有兜底副本** —— 更早的原话只在上面的 L4 里。\n`
        : `> ② 项目里的 \`${archRel}\` —— **从胶囊挤出去的那部分的兜底副本**（只追加，永不删）。\n`;
    userBlock =
      `\n### 用户原话（**逐字**，按时间正序 —— 含他的约束与纠正）\n\n` +
      `> ⚠️ **这里只有最近的 ${capsuleUserMsgMaxOf()} 条**，不是全部。\n` +
      `> 要找**更早的完整原话**，按顺序试这两处：\n` +
      `> ① \`ledger_log({view:"users"})\` —— 活动日志的 **L4 全量**（按会话分组，带时间）；\n` +
      viaArchive +
      `\n` +
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
    copies.push(`- 活跃台账：\`${path.join(memBase, info.activeRel)}\`（当前状态，**先读这个**）`);
  }
  if (info.decisionsRel !== undefined) {
    copies.push(`- 关键决策：\`${path.join(memBase, info.decisionsRel)}\`（永久保留，不参与归档）`);
  }
  if (info.archiveRel !== undefined) {
    copies.push(`- 归档目录：\`${path.join(memBase, info.archiveRel)}\`（旧条目，只追加）`);
  }
  if (info.logRel !== undefined) {
    copies.push(
      `- 活动日志：\`${path.join(memBase, info.logRel)}\`（**含 L4 用户消息全量**，` +
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
        `- 历次逐字胶囊（**原件**）：\`${path.join(memBase, capDirRel)}\`` +
          `（每次压缩存一份，永不覆写；★ 按期间分桶，往上一层 \`${path.join(memBase, info.logRel)}\` 能看到历期）`
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
      `- ★ **上一次交接单**：\`${path.join(memBase, info.handoffLatestRel)}\`（**接手先读这一份**）`
    );
    if (info.handoffRel !== undefined) {
      copies.push(`- 交接单目录：\`${path.join(memBase, info.handoffRel)}\`（历次交接都在这里）`);
    }
  } else if (info.handoffRel !== undefined) {
    copies.push(
      `- 交接单目录：\`${path.join(memBase, info.handoffRel)}\`（**目前还没有** —— 收尾时用 \`ledger_handoff\` 写一份，新会话就能接上）`
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

export function renderAfterCompaction(info, capsule, meta, biOpts) {
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
    // ★★★★★ 2026-10-13（D177，用户拍板）：**压缩后的第 1 条回复，先做一次"主动回想"**。
    //
    //   用户原话（逐字）：*"不用我主动去问，而是在每次压缩完成之后的第 1 条模型回复开头，
    //   让它自动主动去回想，类似于我现在每次压缩完之后都问一句『你现在还记得什么』，
    //   这能促进模型去主动回想（但是也不用回答我，主要是让模型的延续性更强）。"*
    //
    //   ★ 为什么必须由**注入**来做，而不能指望模型自己想起来：
    //     压缩把上下文截短了，而**模型不知道自己被压缩过** —— 它只看到"历史变短了"。
    //     ⇒ 若不告诉它，它会**若无其事地继续**，而把已经丢掉的东西当成"还在"（幻觉的温床）。
    //     ★ 这正是用户那句"什么都没做，就直接被压缩了，就麻烦了"的机制。
    //
    //   ★ 为什么放在**最前面**（而不是塞在末尾的"接下来"里）：
    //     用户指定了位置 —— *"第 1 条模型回复开头"*。回想是**回复的第一步动作**，
    //     把它压到一大段（台账全文 + 胶囊）之后，模型很可能**先看到结论、直接开干**，
    //     回想就名存实亡。★ 顺序即语义。
    //
    //   ★ "不用回答我"怎么落实：明确说"**一两行即可、不必写成给我的答复**" ——
    //     既逼它真的生成那段回想（不生成就等于没回想），又不让它把它当成正式回答去打磨。
    "\n## ★ 先做一次「主动回想」（压缩刚发生，这是你要做的第一件事）\n\n" +
    "你刚才的上下文被压缩过 —— **这不是让你汇报，是让你先把自己对齐**。" +
    "请在这条回复**开头**用一两行（**不必写成给我的答复**）过一遍这四问：\n\n" +
    "1. **我现在的目标**是什么？（不是「这个项目在做什么」，是**眼下这一轮**要推进什么）\n" +
    "2. **我手上正做到哪一步**？（改到哪个文件、哪个函数、验证到哪了）\n" +
    "3. 有哪些**约束 / 底线**是我**不能违反**的？（用户明确说过的边界）\n" +
    "4. **下一步动作**是什么？\n\n" +
    "★ 想完就**直接继续干活** —— 不要停下来问我，也不要把它当成一次汇报。\n" +
    "★ 若上面四问里有任何一条你**答不上来**：那说明它被压掉了 ⇒ " +
    "**按台账与胶囊去查**（它们是权威），或用 `ledger_recall({from,to})` 读回被压的那段原文 —— " +
    "★ **绝不要凭印象补一个**（那正是记忆污染最危险的形态）。\n" +
    "\n---\n" +
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

export function projectRootOf(agent) {
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

export function projectRootOfSession(session) {
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

export function resolveProjectRoot(sid, cwd) {
  const here = typeof cwd === "string" && cwd !== "" ? path.resolve(cwd) : undefined;
  const locked = activeLockFor(sid);
  if (locked === undefined) return here; // 没锁 ⇒ 与以前完全一致
  // 锁了：当前目录**自己有台账**就以它为准（锁只接管"没有台账"的情况）。
  if (here !== undefined && readManifest(here) !== undefined) return here;
  return locked;
}

/** 读指针清单（不存在 ⇒ undefined）。 */

export function readManifest(projectRoot) {
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

export function guessActive(projectRoot) {
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

export function guessDecisions(projectRoot) {
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

export function guessArchiveDir(projectRoot) {
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

export function guessLogDir(projectRoot) {
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

export function inspect(projectRoot) {
  const manifest = readManifest(projectRoot);

  // ═══════════════════════════════════════════════════════════════════════════
  // ★★★★★ 2026-10-21（D289 · V3 阶段 1 第一刀）：**`memoryRoot` —— 记忆文件的实际基准**
  //
  // 🔴 为什么需要它（V3 任务书 §2.1/§2.3）：
  //   V3 要求把全部项目记忆集中到 `<项目名>-ledger-memory/` 子目录里。
  //   而本插件**所有**记忆路径都是相对某个"根"解析的 —— 那个根就是这里。
  //
  // ★★★ 关键设计（这是整个 V3 能落地的最小切口）：
  //   下面的 30 处 `projectRoot` **不动**，只把「解析记忆路径的那个变量」换成 `memoryBase`。
  //   于是：
  //     · 清单里**没有** `memoryRoot` ⇒ `memoryBase === projectRoot` ⇒ **行为与今天逐字一致**
  //       （这正是"不破坏第二代"的技术保证：旧项目一行代码不改也照旧）；
  //     · 清单里**有** `memoryRoot` ⇒ 记忆路径整体迁到那个目录。
  //
  // ★★ 哪些路径**跟着** memoryBase（= 会被迁移）：
  //     active / decisions / archiveDir / logDir / journal / goals / lessons / principles /
  //     decisionsDir / lessonsDir / goalsDir / handoff / capsule / stash / notes(若跟随项目)
  //   ★ 哪些**永远留在项目根**（= 绝不能迁移）：
  //     `.git`（找仓库要往上走）· `.gitignore`（保护性配置，任务书 §3.2 明说）
  //     · `.dsh-ledger.json` 的**寻址本身**（否则会陷入"要读清单才能知道清单在哪"的循环）
  //
  // ★★★ 边界纪律（不可省）：`memoryRoot` 来自用户可编辑的清单 ⇒ 必须过 `isUnderReal` 校验。
  //   越界（`../` / 绝对路径 / 符号链接逃逸）时**降级回项目根**并记入 `unsafePaths`，
  //   而不是硬用它 —— 与 `gateDir` 那条纪律同款（D167：不许把失败说成没发生）。
  // ═══════════════════════════════════════════════════════════════════════════
  const memoryRootRaw = typeof manifest?.memoryRoot === "string" ? manifest.memoryRoot.trim() : "";
  let memoryBase = projectRoot;
  let memoryRoot = undefined; // 只有清单里登记了才回这个字段（undefined = V2 形态）
  let memoryRootUnsafe;
  if (memoryRootRaw !== "") {
    const cand = path.resolve(projectRoot, memoryRootRaw);
    const r = isUnderReal(projectRoot, cand);
    if (r.ok === true) {
      memoryBase = cand;
      memoryRoot = memoryRootRaw;
    } else {
      // ★ 越界 ⇒ 降级回项目根，并如实记下（不许静默忽略，否则"配了却不生效"最难查）
      memoryRootUnsafe = { field: "memoryRoot", value: memoryRootRaw, why: r.why };
    }
  }

  const isGitRepo = (() => {
    try {
      return fs.existsSync(path.join(projectRoot, ".git"));
    } catch {
      return false;
    }
  })();
  // ★ `.gitignore` 永远在**项目根**：它是保护性配置，不属于私有记忆内容（任务书 §3.2）。
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const hasGitignore = fs.existsSync(gitignorePath);

  let activeRel = manifest?.active;
  let source = "manifest";
  if (typeof activeRel !== "string" || activeRel === "") {
    activeRel = guessActive(memoryBase);
    source = activeRel === undefined ? "none" : "guess";
  }

  let decisionsRel = manifest?.decisions;
  let decisionsSource = "manifest";
  if (typeof decisionsRel !== "string" || decisionsRel === "") {
    decisionsRel = guessDecisions(memoryBase);
    decisionsSource = decisionsRel === undefined ? "none" : "guess";
  }

  let archiveRel = manifest?.archiveDir;
  let archiveSource = "manifest";
  if (typeof archiveRel !== "string" || archiveRel === "") {
    archiveRel = guessArchiveDir(memoryBase);
    archiveSource = archiveRel === undefined ? "none" : "guess";
  }

  // ── ★★★★★ 2026-10-13（D180）：根本原则条例（**独立文件，写入需要用户授权**）──────
  //   ★ 口径与 `decisions` **刻意不同**：这里是 `manifest` 优先，若清单没登记，
  //     则**只认已经存在的同名文件**（`guess`），**绝不凭空创建** ——
  //     因为它是一份"只有用户授权才成立"的文件，插件不该因为它不存在就自己造一份出来。
  let principlesRel = manifest?.principles;
  let principlesSource = "manifest";
  if (typeof principlesRel !== "string" || principlesRel === "") {
    const cand = path.resolve(projectRoot, DEFAULT_PRINCIPLES_NAME);
    if (fs.existsSync(cand)) {
      principlesRel = DEFAULT_PRINCIPLES_NAME;
      principlesSource = "guess";
    } else {
      principlesRel = undefined;
      principlesSource = "none";
    }
  }

  // ── ★★★★★ 2026-10-13（D181）：目标树（**卡片联成树**；与根本原则不同，**可由插件创建**）──
  //   ★ 口径：`manifest.goals` 优先；★ 没登记时**只认已存在的同名文件**（`guess`）——
  //     与 `decisions` 那条"不擅自创建"一致；真正需要时由 `ledger_goals` 工具显式建。
  let goalsRel = manifest?.goals;
  let goalsSource = "manifest";
  if (typeof goalsRel !== "string" || goalsRel === "") {
    const cand = path.resolve(projectRoot, DEFAULT_GOALS_NAME);
    if (fs.existsSync(cand)) {
      goalsRel = DEFAULT_GOALS_NAME;
      goalsSource = "guess";
    } else {
      goalsRel = undefined;
      goalsSource = "none";
    }
  }

  // ── ★★★★★ 2026-10-13（D183）：**回合流水**（只追加的历史；★ **不注入**）──────────
  //   ★ 口径与 `goals` / `principles` 一致：`manifest.journal` 优先，
  //     没登记时**只认已经存在的同名文件**（`guess`）—— **绝不凭空创建**。
  let journalRel = manifest?.journal;
  let journalSource = "manifest";
  if (typeof journalRel !== "string" || journalRel === "") {
    const cand = path.resolve(projectRoot, DEFAULT_JOURNAL_NAME);
    if (fs.existsSync(cand)) {
      journalRel = DEFAULT_JOURNAL_NAME;
      journalSource = "guess";
    } else {
      journalRel = undefined;
      journalSource = "none";
    }
  }

  // ── ★★★★★ 2026-10-14（D192）：经验与教训（**模型踩过的坑**）────────────
  //   ★ 口径与 `goals` **逐字一致**：`manifest.lessons` 优先；没登记时**只认已存在的同名文件**；
  //     ★ **绝不凭空创建**（要建得由 `ledger_init` 明确要，与 `journal`/`logDir` 同口径）。
  let lessonsRel = manifest?.lessons;
  let lessonsSource = "manifest";
  if (typeof lessonsRel !== "string" || lessonsRel === "") {
    const cand = path.resolve(projectRoot, DEFAULT_LESSONS_NAME);
    if (fs.existsSync(cand)) {
      lessonsRel = DEFAULT_LESSONS_NAME;
      lessonsSource = "guess";
    } else {
      lessonsRel = undefined;
      lessonsSource = "none";
    }
  }

  // ── ★★★★★ 2026-10-14（D202，用户拍板）：**卡片目录**（一卡一文件）──────────────
  //   ★ 判据：`manifest.<kind>Dir` **登记了**才算卡片模式（**不做自动探测** ——
  //     猜测是"本次会话碰巧成立"的推断，与 `decisionsSource === "guess"` 那条同一条纪律）。
  //   ★★ 三类的**权限刻意不同**，沿用各自单文件时的口径：
  //     · decisions / lessons：`ledger_init` 可建（用户明确要建项目时）；
  //     · goals：可由插件创建（`ledger_goals` 本来就会建它）。
  //   ★ 未登记 ⇒ `undefined` ⇒ 走单文件（既有项目照旧，一个字节都不动）。
  const decisionsDir = typeof manifest?.decisionsDir === "string" && manifest.decisionsDir !== "" ? manifest.decisionsDir : undefined;
  const lessonsDir = typeof manifest?.lessonsDir === "string" && manifest.lessonsDir !== "" ? manifest.lessonsDir : undefined;
  const goalsDir = typeof manifest?.goalsDir === "string" && manifest.goalsDir !== "" ? manifest.goalsDir : undefined;

  // ★★★★★ 2026-10-18（D267 · 修 review v1.2.7 的 F02）：**清单里的路径要先验边界，再用它**。
  //
  //   🔴 review 的实测：清单写 `"decisionsDir": "../outside-cards"` ⇒ 普通
  //      `ledger_write({target:'decisions'})` 就在**项目兄弟目录**生成了 `outside-cards/D1.md`，
  //      还返回 `ok:true`。
  //
  //   ★ 为什么在 `inspect` 里验（而不是只在写入处）：`inspect` 是**所有读写共用的唯一出口**，
  //     在这里把不合法的目录**当成"没有这个目录"**（降级成单文件模式 / 未启用），
  //     就等于**一次性挡住了读、写、删、列**四条路 —— 而不用在十几处各查一遍
  //     （那种分散检查正是本项目反复栽的"同一件事两处各写一份"）。
  //   ★ 但**只降级、不静默**：把被拒的原因记在 `unsafePaths` 里，让 `ledger_status`
  //     能如实告诉用户"清单里这个东西被拒了、为什么"（D167：不许把失败说成没发生）。
  const unsafePaths = [];
  const gateDir = (label, rel) => {
    if (rel === undefined) return undefined;
    // ★ 这个函数里项目根叫 `projectRoot`（不是 `root`）—— 第一版我写成 `root` ⇒ 运行时
    //   `ReferenceError`，被探针当场抓到。**报错是好事**：它证明探针真跑的是这份代码。
    // ★★★ V3（D289）：卡片目录属于**记忆** ⇒ 基准换成 `memoryBase`（V2 项目里它就是项目根）。
    //   越界的含义随之变成"必须在记忆区内" —— 这比原来的"在项目内"更严，不会放松。
    const r = isUnderReal(memoryBase, path.resolve(memoryBase, rel));
    if (r.ok !== true) {
      unsafePaths.push({ field: label, value: rel, why: r.why });
      return undefined;
    }
    return rel;
  };
  const safeDecisionsDir = gateDir("decisionsDir", decisionsDir);
  const safeLessonsDir = gateDir("lessonsDir", lessonsDir);
  const safeGoalsDir = gateDir("goalsDir", goalsDir);

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
    const candidate = path.resolve(memoryBase, logRel);
    if (isUnder(memoryBase, candidate)) logAbs = candidate;
  }
  // 猜到的同名目录：**只报告，不启用**。清单里已经登记了就不必猜。
  const logGuess =
    typeof logRel === "string" && logRel !== "" ? undefined : guessLogDir(memoryBase);
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
  //   ★★★★★ 2026-10-16（D222）：**改走唯一出口**。
  //     ① 面板选了「以面板为准」（默认）⇒ 面板值管用 ⇒ 面板一改，所有项目立刻跟；
  //     ② 面板选了「以项目清单为准」⇒ 清单里有就用清单的（老行为，一个仓库两种活）。
  //   ★ 老注释里那句"插件级设置不参与"**现在只在 ② 下成立** —— 就地更正，不留错话。
  //   ★ 注意：`inspect()` 内部只有局部 `manifest`（结果对象在下面才拼出来）
  //     ⇒ 这里必须传 `{ manifest }` 那个**同形**的假 info，不能直接用 `info`（它还不存在，
  //       我第一次就写成 `info` ⇒ ReferenceError，被自检当场抓住）。
  const maxActiveLinesRaw = precedenceValue({ manifest }, "maxActiveLines");
  const maxActiveLines =
    Number.isFinite(maxActiveLinesRaw) && maxActiveLinesRaw > 0
      ? Math.floor(maxActiveLinesRaw)
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
    const candidate = path.resolve(memoryBase, activeRel);
    if (isUnder(memoryBase, candidate)) activeAbs = candidate;
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
      // ★★★ V3（D289）：交接单是**记忆** ⇒ 基准 memoryBase（V2 里它就是项目根，行为不变）。
      const cand = path.resolve(memoryBase, manifestHandoff);
      if (isUnder(memoryBase, cand)) {
        handoffRel = toGitRel(memoryBase, cand);
        handoffAbs = cand;
      }
    } else {
      // 没登记 ⇒ 只认**已经存在**的候选目录，绝不擅自新建。
      for (const c of HANDOFF_DIR_CANDIDATES) {
        try {
          if (fs.statSync(path.resolve(memoryBase, c)).isDirectory()) {
            handoffRel = c;
            handoffAbs = path.resolve(memoryBase, c);
            break;
          }
        } catch {
          /* 不存在就下一个 */
        }
      }
      if (handoffRel === undefined) {
        // 连候选都没有 ⇒ 用我们的约定名（**写的时候才建目录**）。
        handoffRel = DEFAULT_HANDOFF_DIR;
        handoffAbs = path.resolve(memoryBase, DEFAULT_HANDOFF_DIR);
      }
    }
    // ★ 顺带找出**最新的一份**：这才是"新会话该去读哪一份"的答案。
    //   只列目录不说哪份最新，等于把挑选的活推回给模型。
    if (handoffAbs !== undefined) {
      handoffLatestRel = latestHandoffIn(memoryBase, handoffAbs);
    }
  }

  return {
    projectRoot,
    // ★★★★★ V3（D289）：**记忆根** —— 记忆文件的解析基准。
    //   · V2 项目：`memoryRoot === undefined`，`memoryBase === projectRoot`（与今天逐字一致）
    //   · V3 项目：`memoryRoot = "<项目名>-ledger-memory"`，全部记忆路径相对它解析
    //   ★ 调用方判据：**要碰记忆文件 ⇒ 用 `info.memoryBase`；要碰项目本身 ⇒ 用 `info.projectRoot`。**
    memoryRoot,
    memoryBase,
    ...(memoryRootUnsafe === undefined ? {} : { memoryRootUnsafe }),
    manifest,
    // ★ 清单**永远在项目根**：它是"寻址器"，不能自己也被搬走（否则陷入循环）。
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
    // ★ 2026-10-14（D202）：卡片目录（登记了就走"一卡一文件"）。
    // ★★ 2026-10-18（D267）：**只回"验过边界、确实在项目内"的那些** ——
    //    越界/不可判定的已经在上面被 gated 掉（`unsafePaths` 里留了原因）。
    decisionsDir: safeDecisionsDir,
    lessonsDir: safeLessonsDir,
    goalsDir: safeGoalsDir,
    // ★ 被判据拒掉的清单路径（供 `ledger_status` 如实报出来）。
    //   ★ 为什么不静默丢弃：用户改了清单却"看起来没生效"是最难查的一类问题。
    // ★ V3（D289）：`memoryRoot` 越界也要进这个清单 —— 否则"配了却不生效"最难查。
    unsafePaths:
      unsafePaths.length === 0 && memoryRootUnsafe === undefined
        ? undefined
        : [...(memoryRootUnsafe === undefined ? [] : [memoryRootUnsafe]), ...unsafePaths],
    principlesRel: typeof principlesRel === "string" ? principlesRel : undefined,
    principlesSource,
    goalsRel: typeof goalsRel === "string" ? goalsRel : undefined,
    goalsSource,
    journalRel: typeof journalRel === "string" ? journalRel : undefined,
    journalSource,
    lessonsRel: typeof lessonsRel === "string" ? lessonsRel : undefined,
    lessonsSource,
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
    // ★★★★★ 2026-10-16（D222）：**第 6 个判定点** —— 我第一版漏了它，
    //   被我自己新写的那条断言（"日志档位也跟面板"）当场抓出来。
    //   原来这里直接读 `manifest?.logLevels` ⇒ `ledger_status` 会**如实报告一个不管用的值**
    //   （面板说了算时，清单里那个数只是遗留）⇒ 正是"一个事实两个出口"。
    //   ⇒ 统一走 `precedenceValue`（与 `levelOn` 同一个出口，绝不会各判一次）。
    logLevels: parseLevels(precedenceValue({ manifest }, "logLevels"), defaultLogLevels()),
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

export function findNestedGitRepo(projectRoot) {
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

export function findContainerMarker(projectRoot) {
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

export function containerFacts(projectRoot) {
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

export function isFreshProject(info) {
  if (info.isGitRepo || info.activeRel !== undefined) return false;
  if (info.containerMarker !== undefined) return false;
  if (info.nestedRepo !== undefined) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Git
// ═══════════════════════════════════════════════════════════════════════════

/** 跑一条 git 子命令。**永不抛**，返回 {ok, stdout, stderr, code}。 */

export function git(projectRoot, args) {
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

export function gitAvailable() {
  const r = git(process.cwd(), ["--version"]);
  return r.ok ? r.stdout : undefined;
}

/**
 * 合并式写 .gitignore：**不覆盖**已有内容，只补齐缺的行。
 * 返回 {changed, added, path}。
 */

/**
 * ★★★★★ 2026-10-21（D292 · V3 阶段 2）：**V3 记忆子目录的动态 ignore 规则。**
 *
 * 🔴 为什么需要它 —— 先说清一件**我先判断错、后来被实测推翻**的事：
 *
 *   我原以为「V3 把记忆搬进 `<项目名>-ledger-memory/`，而 `DEFAULT_IGNORE_LINES` 是固定列表
 *   ⇒ V3 项目的记忆完全裸奔」。**实测（`_probe-v3-ignore-v3dir.mjs`）证明不是。**
 *   原因：`.gitignore` 里 `LEDGER.md` 这种**无斜杠模式是递归的**，
 *   会匹配**任意层级**下的同名文件 ⇒ V3 子目录里那些同名文件**碰巧**都被挡住了。
 *   （证据：`git check-ignore -v` 输出 `.gitignore:1:LEDGER.md  xxx-ledger-memory/LEDGER.md`）
 *
 *   ★★ 逐项点名 12 处（台账/决策卡/归档/日志分片/胶囊/分流/交接单/清单/目标/原则/流水/日志目录）
 *     **全部被挡住** ⇒ 现状不危险。
 *
 * ★★★ **但"恰好正确"不是"设计正确"**，差在三处：
 *   ① 它依赖「记忆目录里的文件名与 V2 那批**恰好同名**」。
 *      哪天 V3 加一类**新名字**的文件（如 `handoff/` 换成别的名、或加 `extensions/`），
 *      它就**自动漏掉** —— 而漏掉**不报错**，只是不再被挡。这正是不该依赖的形态。
 *   ② 用户可能**自己改写** ignore 规则（比如嫌 `decisions/` 太宽而删掉），
 *      那时记忆目录就靠"递归同名"这一条撑着，很容易连坐失效。
 *   ③ **同名是个脆弱的巧合**：`DECISIONS.md` 被挡是因为列表里恰好有它，
 *      而不是因为"它在记忆目录里"这个**语义**。
 *
 * ⇒ 正解：**按语义再补一条**，让"整个记忆目录"被整体挡住，与里面叫什么名字无关。
 *
 * ★ 规则为什么写成 `/＜目录名＞/`：
 *   · **前导 `/`** = 只锚**项目根**下这个名字 —— 避免误伤别的子目录里的同名目录
 *     （比如用户自己在 `src/` 下也有个同名目录，那不是我们的记忆）。
 *   · **尾随 `/`** = 只匹配目录。
 *   · 目录名来自清单的 `memoryRoot`（用户可编辑）⇒ **必须过边界校验**，
 *     且**只接受落在项目内的相对路径**（否则一条 `../../` 就能往 ignore 里写怪东西）。
 *
 * @param {object} info `inspect()` 的结果
 * @returns {string[]} 要追加的规则行（V2 项目返回空数组 —— **行为逐字不变**）
 */
export function memoryRootIgnoreLines(info) {
  const raw = typeof info?.memoryRoot === "string" ? info.memoryRoot.trim() : "";
  if (raw === "") return [];
  // ★ 只接受"项目内的相对路径"：绝对路径 / 越界 / 含 `..` 一律不写。
  if (path.isAbsolute(raw)) return [];
  const norm = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (norm === "" || norm.split("/").some((seg) => seg === ".." || seg === "")) return [];
  // ★ 只取**最外层**那一段做锚：`a/b` 这种嵌套也要求整个 `a/` 被挡（记忆根在它内部）
  return [`/${norm}/`];
}

export function mergeGitignore(projectRoot, lines) {
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
 *
 * ★★★★★ 2026-10-21（D288）：**被 `.gitignore` 挡住的路径不许让整条 `git add` 失败**。
 *
 *   🔴 实测（不是猜）：对一条被忽略的路径执行 `git add -- <path>`，
 *     git **退出码 1** 且 stderr 打 "The following paths are ignored…"，**其余路径照样未暂存**
 *     （`git status` 里只剩别的文件）。而 `part4.js` 把"r.ok 为假"直接写成
 *     `staged = stderr`，看起来像**整个归档/写入失败了**，其实只是"这几类文件被正确挡住了"。
 *   ⇒ 一旦我们把 `DEFAULT_IGNORE_LINES` 填上（记忆文件现在**应当**被忽略），
 *     `ledger_init` / `ledger_write` / `ledger_archive` **每次都会**撞上这个 code 1。
 *     那会变成一个"功能正常但回执全是红的"的假故障 —— 比原 bug 更难查。
 *
 *   ★ 修法：**先问 `git check-ignore`，把被忽略的路径摘出去**，只 add 其余的。
 *     摘掉的那些如实回报（`skipped`），让调用方看得见"哪些被挡住了" ——
 *     **默认挡住 + 显式告诉你挡了什么**，这两件事必须同时成立。
 */
/**
 * ★★★★★ 2026-10-21（D290 · V3 阶段 2）：**staging 的唯一闸门。**
 *
 * 🔴 为什么要它（探针 `_probe-v3-stage-gate.mjs` 当场抓到，不是推断）：
 *
 *   D288 填了 `DEFAULT_IGNORE_LINES`（19 条，记忆文件全部忽略），
 *   而 `gitAdd()` 在被挡住时返回 `{ok:true, skipped:[…], note:"全部被 .gitignore 挡住"}`。
 *   ⇒ 三处调用点都写着 `staged = r.ok ? true : …` ⇒ **回执里出现 `staged: true`**。
 *
 *   ★ 实测（同一个临时仓库、同一段代码）：
 *     · 有 ignore 规则 ⇒ `git status` 里**只有** `.gitignore`，记忆文件一个都没进暂存区；
 *     · 拿掉规则     ⇒ 立刻 `A .dsh-ledger.json / A DECISIONS.md / A LEDGER.md`。
 *   ⇒ 那条 `staged: true` 会让调用方以为**记忆文件也进去了** —— 而它一个都没进。
 *
 *   ★★ 这正是 D167「静默失败 = 谎报的镜像」那条纪律的同型，而且更坏 ——
 *     静默失败至少不骗人，**含糊的成功会让调用方以为已经安全了**。
 *
 * ★★★ 判据（三条，一起成立才算"如实"）：
 *   ① `staged` 只在这**真的进过暂存区**时为 `true`；
 *   ② **进去了哪些**（`stagedPaths`）必须写出来 —— 光说"成功了"不算交代；
 *   ③ 被挡住的（`stagedSkipped`）必须如实列出，一个都没进时给出**为什么**。
 *
 *   ★ 第 ② 条是第二版加的，起因是**探针的第二条断言也报红**：
 *     那次 `.gitignore` 真的进了暂存区（`A .gitignore`），所以 `staged: true` 是**实话**；
 *     但回执只说"成功"，不说"只成功了 `.gitignore` 这一个"
 *     ⇒ 调用方读到 `staged: true` 仍会以为记忆文件进去了。
 *     ★ 判据：**"成功"必须能回答「成功的是哪些」** —— 否则它只是好看。
 *
 * ★ 为什么做成一个函数而不是在三处各判一次：
 *   三处各写一遍判据，**下次加第四个调用点必然漏**（与 `memoryBaseOf` 同一个理由）。
 *
 * @param {{ok:boolean, skipped?:string[], stderr?:string, error?:string, note?:string}} r `gitAdd()` 的返回
 * @param {string[]} wanted 这次**希望** stage 的路径（用来算"哪些没被挡住"）
 */
export function stageOutcomeOf(r, wanted) {
  const wantedList = Array.isArray(wanted) ? wanted.filter((p) => typeof p === "string" && p !== "") : [];
  const skipped = Array.isArray(r?.skipped) ? r.skipped : [];

  // ★★★ 判"到底加进去没有"必须看两件事，缺一不可：
  //   ① `r.ok === true`（git add 没报错）；
  //   ② **确实有路径没被挡住** —— 也就是 `wanted` 减掉 `skipped` 之后还有剩。
  //
  //   🔴 第一版这里写的是 `r.staged?.length > 0`，**完全反了**。
  //     实测（`_probe-v3-autogitadd-default.mjs` 当场抓到）：
  //     `gitAdd()` **成功**时返回的是 `git()` 的原始结果 `{ok, code, stdout, stderr}`，
  //     **根本没有 `staged` 数组**；只有"全部被挡"那两个分支才返回 `staged: []`。
  //     ⇒ 于是"真的加进去了"被判成 false、"一个都没加"被判成 true —— 正好颠倒。
  //     ★ 这是本项目纪律第 16 条的同型（**按字段名猜形状**）：我以为返回里有 `staged`，
  //       而它只在失败分支存在。**写判据前必须先把返回值 dump 出来看形状。**
  const attempted = wantedList.filter((p) => !skipped.includes(p));
  const really = r?.ok === true && attempted.length > 0;

  return {
    staged: really,
    stagedPaths: really ? attempted : [],
    stagedSkipped: skipped,
    stagedNote:
      really
        ? skipped.length > 0
          ? `已 stage：${attempted.join("、")}；被 .gitignore 挡住（预期）：${skipped.join("、")}`
          : undefined
        : skipped.length > 0
          ? `全部被 .gitignore 挡住（预期行为）：${skipped.join("、")}`
          : r?.stderr || r?.error || r?.note || "git add 没有加进任何路径",
  };
}

/**
 * ★★★★★ 2026-10-21（D293 · V3 阶段 2）：**查出「记忆已经被 commit 进仓库」的项目 —— 只查、只报警，绝不动手。**
 *
 * 🔴 为什么需要它（这是 ignore 规则的**盲区**，不是它的 bug）：
 *
 *   `.gitignore` **只管「尚未被跟踪」的文件**。
 *   一个文件一旦被 `git add` 过，它就进入索引 ⇒ **此后 ignore 规则对它完全无效**：
 *   它会继续出现在 `git status` 里当已跟踪文件、继续被下一次 `git commit` 带上。
 *
 *   ⇒ 所以 D288 补的那些规则，**对「规则之前就已经提交过记忆」的老项目一点用都没有**。
 *     而 `06-DSH-mobile` 那次真事故正是这种状态 —— 它**已经推上去了**。
 *
 * ★★★ 这一项的全部安全性在于**「只报不做」**。用户已拍板（逐字）：
 *   *"泄露只报警 + 给方案，不自动 rewrite。"*
 *
 *   ★ 为什么这条边界必须守住（不是保守，是那三个动作真的都不可逆）：
 *     · `git rm --cached` ⇒ 只是从索引里摘掉，**历史里那份还在**，clone 下来照样能拿到；
 *     · `git filter-repo` / `filter-branch` ⇒ **改写所有 commit 的 SHA**，
 *       所有协作者必须重新 clone，且**远端要 force push**；
 *     · force push 到公开仓库 ⇒ **无法撤回**（别人可能已经 fork / 缓存 / 被爬过）。
 *   ⇒ 这三件事**没有一件**能由插件替用户决定。
 *
 * ★ 判据：**查出 → 说清后果 → 给出三条可选路（各自的代价都写出来）→ 让他选。**
 *
 * @param {string} projectRoot 项目根（**git 操作永远用项目根，不是记忆根**）
 */
export function detectTrackedMemory(projectRoot) {
  // ★ 非 git 目录 ⇒ **如实说「没法查」**，绝不能返回 `{ok:true, tracked:[]}`。
  //   那会让调用方以为「查过了、很干净」，而实际上**根本没查** —— 与 D290 的 `staged:true` 同一个病。
  const inside = git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.ok !== true || inside.stdout !== "true") {
    return {
      ok: false,
      reason:
        "这里不是 Git 工作区，无法检查「记忆是否已被提交」。" +
        "★ 注意这**不等于**「没有泄漏」—— 是**查不了**。",
    };
  }

  const listed = git(projectRoot, ["ls-files", "-z"]);
  if (listed.ok !== true) {
    return { ok: false, reason: `git ls-files 失败：${listed.stderr || listed.error || "未知原因"}` };
  }

  // ★ 用 `-z`（NUL 分隔）+ 解析：路径里有空格/中文时，按行切会切坏。
  const all = String(listed.stdout ?? "")
    .split("\0")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  // ★ 判据：**记忆文件名 / 目录名**（名字全部取自 `DEFAULT_IGNORE_LINES` 那张表）。
  const MEMORY_NAMES = [
    "LEDGER.md",
    "DECISIONS.md",
    "JOURNAL.md",
    "GOALS.md",
    "LESSONS.md",
    "PRINCIPLES.md",
    ".dsh-ledger.json",
  ];
  const MEMORY_DIRS = ["decisions", "lessons", "goals", "_ledger-archive", "_ledger-log", "_stash", "_handoff"];

  const tracked = all.filter((p) => {
    const norm = p.replace(/\\/g, "/");
    const base = norm.split("/").pop() ?? norm;
    if (MEMORY_NAMES.includes(base)) return true;
    // ★ 目录匹配必须**按路径段**，不能用 `includes("decisions")` —— 那会把
    //   `src/decisions-helper.ts` 这种无关文件也算进来（误报会让人不信任报警）。
    const segs = norm.split("/");
    return segs.some((s) => MEMORY_DIRS.includes(s));
  });

  if (tracked.length === 0) {
    return { ok: true, tracked: [], checkedPatterns: [...MEMORY_NAMES, ...MEMORY_DIRS.map((d) => `${d}/`)] };
  }

  // ★★★ 方案必须**把代价写出来**，不能只说「建议 rm --cached」。
  //   只给命令不给代价，等于把不可逆的选择伪装成一个小操作。
  const advice =
    `发现 ${tracked.length} 个**已经被纳入版本控制**的记忆文件。\n` +
    "★ `.gitignore` 对它们**无效** —— 一旦进入索引，规则就不再管它们了。\n" +
    "★★ 这件事只能由**你**决定怎么处理，插件不会替你动（三条路都有代价）：\n" +
    "  1) **只从索引里摘掉**（最简单，但历史里那份还在）：\n" +
    "     `git rm --cached -r -- <上面的路径>` 然后 commit。\n" +
    "     ⚠️ 这不是清除 —— clone 这个仓库的人**仍然能拿到历史里的那份**。\n" +
    "  2) **改写历史**（能真正清掉，但会改变所有 commit 的 SHA）：\n" +
    "     用 `git filter-repo`（或 `filter-branch`）把这些路径从全部历史里去掉。\n" +
    "     ⚠️ 所有协作者必须**重新 clone**；推送需要 **force push**；\n" +
    "        若仓库是公开的，**别人可能已经 fork / 缓存 / 被爬过** —— 那部分无法撤回。\n" +
    "  3) **换一个仓库**：把这些文件留在本地，远端仓库重建。\n" +
    "★ 若这些内容**已经推送到公开仓库**：先假设它已经泄露（改密钥/令牌），再处理历史。\n" +
    "★ 插件**不会**自动执行以上任何一条。";

  return {
    ok: true,
    tracked,
    advice,
    checkedPatterns: [...MEMORY_NAMES, ...MEMORY_DIRS.map((d) => `${d}/`)],
  };
}

/**
 * ★★★★★ 2026-10-21（D294 · V3 阶段 2 最后一刀）：**可选 `pre-commit` 钩子 —— 默认不装。**
 *
 * 🔴 先说清它**是什么、不是什么**（这比代码本身重要）：
 *
 *   **它是**：在「提交那一刻」拦一道，让**走正常流程的人**发现自己要把记忆提交进去。
 *   **它不是**：安全边界。三条路**直接绕过**，而且都是设计如此：
 *     · `git commit --no-verify` —— git 自带的跳过开关；
 *     · `core.hooksPath` 被改道 —— 用户或别的工具配了就绕开；
 *     · 别的提交工具根本不走这条路。
 *
 *   ⇒ **绝不能在 README / 面板文案里把它写成「防护」**。写「提醒」才是准的。
 *     与 D293 同一条调子：**只报警 + 给方案，不假装能阻止。**
 *
 * ★★★ 为什么**默认不装**（用户已拍板，我同意）：
 *   往用户的 `.git/hooks/` 里放东西是**动他仓库的机制** —— 钩子影响他**所有**提交，
 *   包括那些与记忆毫无关系的提交。这种动作必须**显式同意**。
 *   与 `git init`（D291）同一判据：**默认值的取向跟着「错哪边代价更大」走。**
 *
 * @param {string} projectRoot 项目根
 * @param {{enabled?:boolean}} [opts] **不传或 `enabled` 不为 true ⇒ 卸载 / 不装**
 */
export function installPreCommitHook(projectRoot, opts) {
  const enabled = opts?.enabled === true;

  // ★ 非 git 目录 ⇒ 如实说「装不了」，**不假装成功**。
  const inside = git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.ok !== true || inside.stdout !== "true") {
    return { installed: false, reason: "这里不是 Git 工作区 —— 没有 hooks 目录可装。" };
  }

  // ★ 用 `git rev-parse --git-path hooks` 取**真实** hooks 目录：
  //   worktree / submodule / 配过 `core.hooksPath` 时，`.git/hooks` 这个字面路径**可能是错的**。
  const hp = git(projectRoot, ["rev-parse", "--git-path", "hooks"]);
  if (hp.ok !== true) {
    return { installed: false, reason: `取不到 hooks 目录：${hp.stderr || hp.error || "未知原因"}` };
  }
  const hooksDir = path.resolve(projectRoot, hp.stdout);
  const hookFile = path.join(hooksDir, "pre-commit");

  const MARK = "# dsh-ledger-memory:pre-commit:v1";
  const existing = readTextSafe(hookFile);

  // ── 卸载 ────────────────────────────────────────────────────────────────
  if (!enabled) {
    if (existing === undefined) {
      return { installed: false, reason: "本来就没有 pre-commit 钩子（无需卸载）。", path: hookFile };
    }
    // ★★★ 只删**自己装的那一个**。别人的钩子**绝对不碰** —— 那是用户的文件。
    if (!existing.includes(MARK)) {
      return {
        installed: false,
        reason:
          "已有一个**不是本插件装的** `pre-commit` 钩子 —— 为免毁掉你的东西，不动它。" +
          "要卸掉本插件装的那个，请手动删掉含 `" +
          MARK +
          "` 的文件。",
        path: hookFile,
        foreign: true,
      };
    }
    try {
      fs.unlinkSync(hookFile);
      return { installed: false, removed: true, path: hookFile };
    } catch (e) {
      return { installed: false, reason: `删除失败：${String((e && e.message) || e)}`, path: hookFile };
    }
  }

  // ── 安装 ────────────────────────────────────────────────────────────────
  // ★ 已有钩子且不是我们的 ⇒ **拒绝覆盖**（同一条理由：静默毁掉别人的检查最恶劣）。
  if (existing !== undefined && !existing.includes(MARK)) {
    return {
      installed: false,
      reason:
        "已有一个**不是本插件装的** `pre-commit` 钩子。**不覆盖** —— " +
        "覆盖会静默毁掉你原有的检查。若确实要装，请先自行移走那个钩子。",
      path: hookFile,
      foreign: true,
    };
  }

  const body =
    "#!/bin/sh\n" +
    MARK +
    "\n" +
    "#\n" +
    "# 在提交那一刻提醒：**记忆文件不该被提交**。\n" +
    "#\n" +
    "# ★★ 这不是安全边界：`git commit --no-verify` 会直接跳过本钩子；\n" +
    "#    改 `core.hooksPath` 也能绕开；别的提交工具根本不走这条路。\n" +
    "#    它只拦「走正常流程的人」。\n" +
    "#\n" +
    "# 卸载：直接删这个文件，或用插件的开关关掉（只删本插件装的那个）。\n" +
    "\n" +
    "bad=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '(^|/)(LEDGER\\.md|DECISIONS\\.md|JOURNAL\\.md|GOALS\\.md|LESSONS\\.md|PRINCIPLES\\.md|\\.dsh-ledger\\.json)$|(^|/)(decisions|lessons|goals|_ledger-archive|_ledger-log|_stash|_handoff)/' || true)\n" +
    "\n" +
    'if [ -n "$bad" ]; then\n' +
    '  echo "" >&2\n' +
    '  echo "✗ 这次提交里包含记忆文件（含用户原话 / 本机路径 / 私有项目名）：" >&2\n' +
    '  echo "$bad" | sed "s/^/    /" >&2\n' +
    '  echo "" >&2\n' +
    '  echo "  若确实要提交：git commit --no-verify（本钩子会被跳过）" >&2\n' +
    '  echo "  若不该提交：git restore --staged <路径>  把它移出暂存区" >&2\n' +
    '  echo "" >&2\n' +
    "  exit 1\n" +
    "fi\n" +
    "exit 0\n";

  try {
    ensureDir(hooksDir);
    fs.writeFileSync(hookFile, body, "utf8");
    // ★ 执行位：Windows 上不需要，但同一个仓库可能被 clone 到 Linux/macOS。
    //   拿不到（某些文件系统不支持）也**不算失败** —— 那是环境限制。
    let chmodOk = true;
    try {
      fs.chmodSync(hookFile, 0o755);
    } catch {
      chmodOk = false;
    }
    return {
      installed: true,
      path: hookFile,
      executable: chmodOk,
      note:
        "已装。★ 它是**提醒**，不是安全边界：`--no-verify` 会直接跳过；" +
        "`core.hooksPath` 改道也能绕开。",
    };
  } catch (e) {
    return { installed: false, reason: `写入钩子失败：${String((e && e.message) || e)}`, path: hookFile };
  }
}

/**
 * ★★★★★ 2026-10-22（V3 任务书 §3.1）：**自动暂存的唯一判据。**
 *
 * 判据两层：**V3（记忆根 ≠ 项目根）⇒ 一律不许**，清单写 `autoGitAdd: true` 也不行；
 * V2 ⇒ 保持原有行为（`!== false`，不改既有项目）。
 * 改之前是五处各写一遍 `autoGitAdd !== false`（默认 true ⇒ 迁成 V3 后照样 stage，正是 §3.1 那个洞）。
 * ★ 完整理由与实测见 `decisions/D300.md`。
 *
 * @param {object} info `inspect(projectRoot)` 的返回
 * @returns {{allow:boolean, reason:string, v3?:boolean}}
 */
export function shouldAutoStage(info) {
  const projectRoot = typeof info?.projectRoot === "string" ? info.projectRoot : "";
  if (projectRoot === "") return { allow: false, reason: "没有项目根" };
  if (!fs.existsSync(path.join(projectRoot, ".git"))) {
    return { allow: false, reason: "项目不是 git 仓库" };
  }

  const mb = memoryBaseOf(info, projectRoot);
  let isV3 = false;
  try {
    isV3 = path.resolve(mb) !== path.resolve(projectRoot);
  } catch {
    isV3 = mb !== projectRoot;
  }

  if (isV3) {
    return {
      allow: false,
      v3: true,
      reason:
        "第三代项目（记忆在 " +
        mb +
        "）默认禁止自动暂存；清单里的 autoGitAdd 不能重新开启它（任务书 §3.1）",
    };
  }

  const allow = info?.manifest?.autoGitAdd !== false;
  return { allow, reason: allow ? "第二代默认允许（清单未显式关闭）" : "清单显式关闭" };
}

/**
 * `git add -- <明确路径>`。
 *
 * ★ 红线：**永不 `git add -A`** —— 只把我们点到名的台账文件加进去。
 *
 * ★★★★★ 2026-10-22（V3 §3.1）：**路径级硬拒绝（纵深防御）。**
 *   `shouldAutoStage()` 管"这次要不要 stage"，这里管"即使要，哪些路径也不许进"。
 *   一层不够：调用方可能拿错 `info`，也可能有人绕过判据直接调 `gitAdd`。
 *   记忆根 == 项目根时（V2）**不拦** —— 那时该由 ignore 规则挡，不是由这里挡。
 *
 * ★★★★★ 2026-10-21（D288）：**被 `.gitignore` 挡住的路径不许让整条 `git add` 失败**。
 *   （完整说明在下面 ② 那段；这里只留结论。）
 */
export function gitAdd(projectRoot, relPaths) {
  let unique = [...new Set(relPaths.filter((p) => typeof p === "string" && p !== ""))];
  if (unique.length === 0) return { ok: false, reason: "no paths" };

  // ── ⓪ §3.1 路径级硬拒绝：落在记忆根之下的路径，**一律不 stage** ────────────
  //   ★ 与 `shouldAutoStage()` 是两层，不是重复：那层看项目形态，这层看路径本身。
  const refused = [];
  try {
    const info = inspect(projectRoot);
    const mb = memoryBaseOf(info, projectRoot);
    const prResolved = path.resolve(projectRoot);
    const mbResolved = path.resolve(mb);
    // ★ 记忆根 == 项目根（V2）⇒ **不拦**：那时记忆文件本来就在项目根里，
    //   拦了会把一切正常暂存都禁掉。V2 该由 .gitignore 规则挡，不是由这里挡。
    if (mbResolved !== prResolved) {
      const kept = [];
      for (const p of unique) {
        let abs;
        try {
          abs = path.resolve(prResolved, p);
        } catch {
          abs = p;
        }
        if (abs === mbResolved || abs.startsWith(mbResolved + path.sep)) refused.push(p);
        else kept.push(p);
      }
      unique = kept;
    }
  } catch {
    // ★ inspect 失败 ⇒ **fail closed**：宁可这一轮完全不暂存，也不冒险把记忆加进去。
    return {
      ok: false,
      refused: unique,
      skipped: [],
      note: "无法确认记忆根，已拒绝暂存（fail closed，§3.1）",
    };
  }

  if (unique.length === 0) {
    return {
      ok: false,
      refused,
      skipped: [],
      note: `拒绝暂存私有记忆（§3.1）：${refused.join("、")}`,
    };
  }

  // ── ① 先摘掉被 .gitignore 挡住的路径 ──────────────────────────────────
  const skipped = [];
  let toAdd = unique;
  try {
    // `git check-ignore` 对被忽略的路径**打印出来并以 1 退出**；没被忽略则静默退出 1。
    //   ⇒ 不能靠退出码判断"有没有被忽略"，只能**看输出里出现了哪些路径**。
    const r = git(projectRoot, ["check-ignore", "--", ...unique]);
    const marked = String(r.stdout ?? "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    if (marked.length > 0) {
      const set = new Set(marked);
      skipped.push(...unique.filter((p) => set.has(p)));
      toAdd = unique.filter((p) => !set.has(p));
    }
  } catch {
    // check-ignore 本身失败（极老 git / 仓库异常）⇒ **照旧全 add**，绝不因此阻断写入
    toAdd = unique;
  }

  if (toAdd.length === 0) {
    return { ok: true, skipped, staged: [], note: "全部被 .gitignore 挡住（这是预期行为）" };
  }

  const r = git(projectRoot, ["add", "--", ...toAdd]);
  // ★ 兜底：万一仍有被忽略的路径混进来导致 code 1，且 stderr 明确是"被忽略"——
  //   那是**预期结果**不是故障，不能报成失败。
  if (r.ok !== true) {
    const msg = String(r.stderr ?? r.error ?? "");
    if (/ignored by one of your \.gitignore files/i.test(msg)) {
      return { ok: true, skipped: [...skipped, ...toAdd], staged: [], note: "git add 全部被忽略" };
    }
  }
  const out = skipped.length === 0 ? r : { ...r, skipped };
  // ★ 有被拒绝的私有路径时，**如实带上** —— 调用方看得见"哪些被 §3.1 挡了"。
  return refused.length === 0 ? out : { ...out, refused };
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