import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_PRINCIPLES_NAME, DELTA_YIELD_MAX_AGE_MS, HIGH_FIDELITY_COMPACT_RATIO, INJECT_KIND, LEDGER_PICK_TIMEOUT_MS, LEDGER_SUBCOMMANDS, LOG_DEFAULT_LIMIT, LOG_L1_FIELD_CHARS, LOG_L1_LINE_CHARS, LOG_LEVEL_NAMES, LOG_MAX_LIMIT, MANIFEST_REL, MANUAL_COMPACT_SOURCES, MAX_READ_CHARS, MIN_COMPRESS_POINTS, MODES, MODE_STEADY, MODE_SURGICAL, NUDGE_MIN_RATIO, OK_SCHEMA, PRINCIPLE_APPROVE_TIMEOUT_MS, RECALL_MAX_CHARS, ROOT_PARAM, TRIAGE_KEEP_MAX, TRIAGE_KEEP_TOTAL_MAX, name } from "./defs.js";
import { anchorOf, capsulePathFor, compGateDecision, compactionServiceFor, currentSettings, estimateCompressibleTokens, hydrateCapsuleMemory, lockedRootOf, modeManifestSuspect, modeOf, numOf, persistCapsule, persistCapsuleMemory, persistStash, readSessionRange, recordShadowedIndex, selectIncrementalRange, selectLastTurnRange, sessionTag, setAnchor, setProjectLock, triageRequired, writeManifestMode } from "./part1.js";
import { applyPrincipleProposal, consumePrincipleProposal, countLines, describeProposal, ensureDir, fail, findPendingProposal, gitAdd, inspect, isUnder, logDirOf, logFileRel, pendingProposals, projectRootOf, readTextSafe, renderCapsule, stampSec, writePrinciples } from "./part2.js";
import { flushBeforeCompact, measurePressure, noteFlushed, recentLedgerChanges, renderInjectionBody, renderResult, rootFromExec, triageOwed } from "./part3.js";
import { logFileList, logRead } from "./part4.js";
export function defineTriageTool(state) {
  return {
    name: "ledger_triage",
    description:
      "Split the work done so far into three buckets before a compaction runs. Use it in the " +
      "'surgical' (反复追究) mode, or whenever you are about to lose detail you may need later. " +
      "`keep` = must be known next turn; it is re-injected VERBATIM after the compaction. " +
      "`stash` = may be needed later but should not occupy context; written into the project's " +
      "_stash/ directory and never injected. `drop` = superseded. Being honest here is the whole " +
      "point: if you put everything in `keep`, nothing is compressed.",
    parameters: {
      type: "object",
      properties: {
        keep: {
          type: "array",
          description:
            "Things that MUST be known next turn — current task state, unverified assumptions, " +
            "constraints the user set. Re-injected verbatim after compaction. Keep it SHORT. " +
            `At most ${numOf("triageKeepMax", TRIAGE_KEEP_MAX)} items; extras are truncated (in your order) and reported.`,
          items: {
            type: "object",
            properties: {
              what: { type: "string", description: "The thing itself, one line." },
            },
            required: ["what"],
            additionalProperties: false,
          },
        },
        stash: {
          type: "array",
          description:
            "Worth keeping but NOT worth context — decisions and their reasons, dead ends you " +
            "already ruled out, key file locations. Written to the project's _stash/ for later grep.",
          items: {
            type: "object",
            properties: {
              what: { type: "string", description: "What it is, one line." },
              why: { type: "string", description: "Why it may be worth finding again." },
              where: {
                type: "string",
                description: "Where to look — an exact path or command. ★ Paths, not descriptions.",
              },
            },
            required: ["what"],
            additionalProperties: false,
          },
        },
        drop: {
          type: "array",
          description:
            "Superseded or finished-and-irrelevant. Listed so the split is auditable; nothing is written.",
          items: {
            type: "object",
            properties: { what: { type: "string" } },
            required: ["what"],
            additionalProperties: false,
          },
        },
        // ★★★★ 2026-10-12（D136）：**区块权重**（模型侧的唯一输入）。
        //
        //   ★ 用户要求：*"要给一个通用标准来让不同模型来计算权重"* ⇒
        //     模型**只答是/否**，分数由本插件按常量表算（见 `weightFromAnswers`）。
        //     ★ 所以这里**没有"分数"字段** —— 有的话模型一定会塞，而那就不可复现了
        //     （实测：把实现改成"直接收模型给的 score"⇒ 自检一条都不红，
        //       那说明该主张当时没有断言在守 ⇒ 情形 56②b 就是补它的）。
        //
        //   ★ 为什么搭在 `ledger_triage` 上而不是新开一个工具：
        //     步骤已经够多（用户抱怨过"义务太多被卡"）；而分流本来就是"你在看台账"的时刻，
        //     顺手回答四个是/否，比要求它额外记得调一个新工具**便宜得多**。
        //   ★ 缺省**完全可不传**：不传 ⇒ 该维跳过 ⇒ 退化成"只看星与结构"（不伤准确性）。
        weights: {
          type: "array",
          description:
            "Optional. Per-block yes/no scoring for the ledger's memory blocks — used to decide " +
            "which blocks get injected in full (the rest only appear in the table of contents). " +
            "Answer ONLY true/false; the score is computed by this plugin (same answers ⇒ same " +
            "score, on any model). Omit entirely if you are not scoring — it degrades gracefully.",
          items: {
            type: "object",
            properties: {
              hash: {
                type: "string",
                description:
                  "The block's content-hash prefix, exactly as shown in the ledger table of contents " +
                  "(`#xxxxxxxx`). ★ Use the hash, not the title — titles change, content hashes do not.",
              },
              q1: {
                type: "boolean",
                description:
                  "Does this block contain a constraint that, if NOT followed, causes an ERROR? " +
                  "★ Judge the consequence, not the wording — 「必须/绝不/★」 are this project's house " +
                  "style and appear everywhere; only answer true when disobeying actually breaks things.",
              },
              q2: { type: "boolean", description: "Does it describe what is being done NOW / next?" },
              q3: {
                type: "boolean",
                description: "Is it impossible to derive from elsewhere (other blocks, source, common sense)?",
              },
              q4: { type: "boolean", description: "Would it still hold and still matter in a brand-new session?" },
            },
            required: ["hash"],
            additionalProperties: false,
          },
        },
        root: ROOT_PARAM,
      },
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec, args);
      const info = inspect(root);
      if (info.activeRel === undefined) {
        return {
          ok: false,
          reason:
            "这个项目还没有台账 ⇒ 按约定不往项目里写文件。先 `/ledger init`，" +
            "或者用 `root` 点名一个已经有台账的项目。",
        };
      }
      const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && typeof x === "object") : []);
      const keepAll = arr(args?.keep);
      const stash = arr(args?.stash);
      const drop = arr(args?.drop);

      const keepMax = numOf("triageKeepMax", TRIAGE_KEEP_MAX);
      const keep = keepAll.slice(0, keepMax).map((x) => ({
        what: String(x?.what ?? "").trim(),
      })).filter((x) => x.what !== "");
      const overflow = Math.max(0, keepAll.length - keepMax);

      if (keep.length === 0 && stash.length === 0 && drop.length === 0) {
        return { ok: false, reason: "三个桶都是空的 —— 没有内容可分。" };
      }

      const sid = String(exec?.agent?.session?.header?.id ?? "");
      const at = stampSec(new Date());

      // ★★★★★ 2026-10-13（D158，**用户当场指出的设计缺陷**）：**累积**，不再覆盖。
      //
      //   用户原话（逐字）：*"就是我们的全量压缩事务是根据最后一次分流结果来压缩的，这可不行。
      //   以后就是全量压缩把现有的所有分流情况全部进行压缩"*
      //
      //   ★ 病（读码确认，确实是我写的）：原来这里是 `state.triageKeep.set(sid, {at, items: keep})`
      //     —— **单槽覆盖**，而消费点（压缩后重注）是 `get` + `delete`。
      //     ⇒ 两次分流之间若发生过 ≥2 次 `ledger_triage`，**只有最后一份能活到压缩那一刻**，
      //       前面几份**静默蒸发**（既没进 keep 注回、也没人知道）。
      //   ★★ 而 D157 刚把"每回合强制分流"定成规则 ⇒ 这个缺陷**立刻从"偶发"变成"必然"**：
      //     每回合分一次、压缩却可能几十回合才发生一次 ⇒ **几乎全部分流单都会被丢掉**。
      //   ★ 这正是本项目那条纪律的同型复发：**单槽 Map 在重叠路径上必错**（纪律第 13 条）。
      //     与 D89 那次"压缩来源用单槽、被并发覆盖"是**同一个病**，只是换了个字段。
      //
      //   ★ 修法：**累积**（append），并在**压缩那一刻**一次性交给重注、然后清空。
      //     · 去重：同一条 `what` 只留第一次（模型可能反复说同一件事）；
      //     · 上限：`TRIAGE_KEEP_TOTAL_MAX`，超了**从最旧的开始丢**并**如实计数**
      //       （沉默丢弃 = 下一个 D89）。
      const key0 = String(sid);
      if (keep.length > 0 && sid !== "") {
        const prev = state.triageKeep.get(key0);
        const merged = Array.isArray(prev?.items) ? [...prev.items] : [];
        const seen = new Set(merged.map((x) => String(x?.what ?? "").trim()));
        let added = 0;
        for (const k of keep) {
          const w = String(k?.what ?? "").trim();
          if (w === "" || seen.has(w)) continue;
          seen.add(w);
          merged.push({ what: w, at });
          added += 1;
        }
        // ★ 上限：超了丢**最旧的**（新近的判断更可能仍然有效）。
        const totalMax = numOf("triageKeepTotalMax", TRIAGE_KEEP_TOTAL_MAX);
        const droppedOld = Math.max(0, merged.length - totalMax);
        const kept = droppedOld > 0 ? merged.slice(droppedOld) : merged;
        state.triageKeep.set(key0, { at, items: kept, added, droppedOld, sessions: (prev?.sessions ?? 0) + 1 });
      }
      // ★★ 记下"这次分流做过了" ⇒ 闸门那条**分流义务**随之兑现（见 `triageOwed`）。
      //   ⚠️ 即使 keep 是空的也要记：只 stash / 只 drop 也是一次**合法的分流**，
      //      否则闸门会一直等它做一件它已经做过的事（活锁）。
      if (sid !== "") {
        const key = String(sid);
        state.triageAt.set(key, Date.now());
        state.triageOwedAt?.delete?.(key);
        state.triageBlocked?.delete?.(key);
      }

      // ★★★★ 2026-10-12（D136）：**收下模型的分块四问**（权重那一维的输入）。
      //
      //   ★★ 只认**布尔**，只认**哈希** —— 两道门都在这里把死：
      //     · 模型塞一个 `score: 999` ⇒ **没有这个字段可塞**（schema 里就没有），
      //       而且这里**只读 q1~q4** ⇒ 塞了也不生效；
      //     · 塞字符串"是"/数字 ⇒ `=== true` 判否 ⇒ 不计分。
      //   ⇒ 于是"分数由插件算"这条主张在**生产链路**上也成立，不只是自检里成立。
      //   ★ 存到 state（按会话 + 项目根），注入时取用；★ 不落盘 ⇒ 不污染工作区。
      const weightRows = Array.isArray(args?.weights) ? args.weights : [];
      let weightAccepted = 0;
      if (weightRows.length > 0 && sid !== "") {
        const bucket = new Map();
        for (const raw of weightRows) {
          if (raw === null || typeof raw !== "object") continue;
          const hash = String(raw.hash ?? "").trim().toLowerCase().replace(/^#/, "");
          if (hash === "") continue;
          const row = {};
          for (const k of ["q1", "q2", "q3", "q4"]) {
            if (raw[k] === true) row[k] = true;
            else if (raw[k] === false) row[k] = false;
            // ★ undefined / 字符串 / 数字 一律**不写入** ⇒ `weightFromAnswers` 视为没答
          }
          if (Object.keys(row).length === 0) continue;
          bucket.set(hash, row);
          weightAccepted += 1;
        }
        if (bucket.size > 0) state.blockWeights.set(String(sid), { at: Date.now(), root, byHash: bucket });
      }

      // ★ stash 桶落盘（只在有台账的项目里写）。
      let stashResult = { ok: false, count: 0 };
      if (stash.length > 0) {
        stashResult = persistStash(root, info, sid, stash, {
          source: "manual",
          kept: keep.length,
          dropped: drop.length,
        });
      }

      return {
        ok: true,
        kept: keep.length,
        stashed: stashResult.ok === true ? stashResult.count : 0,
        dropped: drop.length,
        stashPath: stashResult.rel ?? null,
        overflow,
        mode: modeOf(info),
        // ★★ 如实回报收下了几块的权重答案（没传就是 0 ⇒ 那一维跳过，不是错误）。
        weightsScored: weightAccepted,
        note:
          `分流完成：留 ${keep.length} 条（压缩后逐字重注） · ` +
          `落 ${stashResult.ok === true ? stashResult.count : 0} 条` +
          (stashResult.ok === true ? `到 \`${stashResult.rel}\`` : `（未落盘：${stashResult.reason}）`) +
          ` · 丢 ${drop.length} 条。` +
          (weightAccepted > 0
            ? `\n★ 已收下 **${weightAccepted} 块**的是/否判分 ⇒ 它们参与"该注入哪几块"的排序`
            : "\n★ 本次**未判分**（`weights` 没传）⇒ 该维度跳过，排序退化成只看星与结构。不影响准确性。") +
          (overflow > 0
            ? `\n★ keep 超上限 ${keepMax}，**已截掉 ${overflow} 条**（按你给的顺序保留前 ${keepMax} 条）。`
            : "") +
          "\n★ 提醒：**留得太多等于没压。** keep 只放「下一轮不知道就会做错」的东西。",
      };
    },
  };
}

/**
 * ⑦ ledger_log —— 回溯读活动日志（**不注入上下文**，只在需要时读切片）。
 */
/**
 * ★★★ `ledger_recall` —— 把被压缩换掉的历史**按需读回逐字原文**（含推理过程）。
 *
 * 它补的是本项目最核心的那个缺口（承 DECISIONS D46 / D76–D80）：
 *   压缩把一段对话换成摘要（有损），而**原文其实还在**会话日志里
 *   （内核 `dsh-session` 的只追加日志；`session.eventAt(seq)` 可以直接取）
 *   —— 只是**模型不知道去哪找**。
 *   ⇒ 本工具 + 压缩后注入的「被压段索引」= 可回溯、可重建。
 *
 * ★ 只读：绝不写任何东西（这一条比什么都重要 —— 回读不该有副作用）。
 */

export function defineRecallTool(state) {
  return {
    name: "ledger_recall",
    description:
      "Read back the VERBATIM original text of a span that compaction replaced with a summary " +
      "(including the model's reasoning blocks and tool calls). The append-only session log still " +
      "holds the originals; this tool makes them retrievable. Use the seq ranges printed in the " +
      "'被压掉的历史' index after a compaction — do not guess from the summary. Read-only. " +
      "Output is capped (see maxChars); page through with from/to when truncated.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "number", description: "Start seq (inclusive), as printed in the index." },
        to: { type: "number", description: "End seq (inclusive). Keep spans modest; page if needed." },
        reasoning: {
          type: "boolean",
          description:
            "Include reasoning blocks (default true). Set false to read only the visible text and " +
            "tool calls — smaller and usually enough when you only need what was decided.",
        },
        maxChars: {
          type: "number",
          description: `Character cap (default and max ${numOf("recallMaxChars", RECALL_MAX_CHARS)}). The read stops at an event boundary and says so.`,
        },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const session = exec?.agent?.session;
      // ★ D138：面板可调 ⇒ 每次执行时取（不是启动时定死）。
      const recallCap = numOf("recallMaxChars", RECALL_MAX_CHARS);
      const r = readSessionRange(session, args?.from, args?.to, {
        maxChars: Math.min(recallCap, Number(args?.maxChars) || recallCap),
        reasoning: args?.reasoning !== false,
      });
      if (r.ok !== true) return { ok: false, reason: r.reason };
      return {
        ok: true,
        from: r.from,
        to: r.to,
        returned: r.events.length,
        chars: r.chars,
        truncated: r.truncated === true,
        reasoning: r.reasoning,
        // ★ 如实说明"这不是全部"：截断了就明确告诉模型下一段从哪起。
        ...(r.truncated === true
          ? {
              hint:
                "到字符闸门就停了（**只返回了前一段**）。要接着读，用上一次最后一条的 seq + 1 当 from。",
              nextFrom: r.events.length > 0 ? r.events[r.events.length - 1].seq + 1 : r.from,
            }
          : {}),
        events: r.events.map((e) => ({ seq: e.seq, type: e.type, text: e.text })),
      };
    },
  };
}

export function defineLogTool() {
  return {
    name: "ledger_log",
    description:
      "Read back the project's activity log. The log is NEVER injected into context — call this " +
      "only when you actually need history. Buckets are weekly (YYYY-MM/weekN) and share the " +
      "archive's period key, so one query spans the archived ledger entries and the log of the " +
      "same week. Levels: L0 milestones, L1 turn summaries (written by you), L2 file flow, " +
      "L3 tool flow. views: \"timeline\" (default, chronological), \"files\" (deduped per path), " +
      "\"failures\" (only failed tool calls), \"raw\". Read-only.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        levels: {
          type: "array",
          items: { type: "string", enum: LOG_LEVEL_NAMES },
          description: "Restrict to these levels. Default: all four.",
        },
        since: {
          type: "string",
          description:
            "Only entries at or after this local time. \"YYYY-MM-DD\" or \"YYYY-MM-DD HH:MM[:SS]\". " +
            "Pass the previous call's nextCursor to page forward.",
        },
        until: {
          type: "string",
          description: "Only entries at or before this local time. Same formats as since.",
        },
        grep: { type: "string", description: "Case-insensitive substring filter on the raw line." },
        view: {
          type: "string",
          enum: ["timeline", "files", "failures", "users", "audit", "raw"],
          description:
            "How to shape the result. Default timeline. 'users' returns only the archived USER " +
            "messages (L4) grouped by session tag — use it to answer 'what did the user say about " +
            "X'. L4 is excluded from the default level set, so ask for it explicitly.",
        },
        limit: {
          type: "number",
          description: `Max entries to return (1-${LOG_MAX_LIMIT}, default ${numOf("logDefaultLimit", LOG_DEFAULT_LIMIT)}).`,
        },
      },
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      return logRead(rootFromExec(exec, args), args);
    },
  };
}

/**
 * L1 每条字段的截断长度，以及整行上限。
 *
 * ★ 为什么必须截：L1 是**一行一条**（见 `writeLog` 的注释），没有这个上限，
 *   一次啰嗦的摘要能写出几千字符的单行，把 timeline 视图整段挤爆。
 */

export function writeLog(root, args) {
  const info = inspect(root);
  if (logDirOf(info) === undefined) {
    return {
      ok: false,
      reason: "这个项目还没有启用活动日志。请先 `ledger_init` 并传 `logDir`（例如 `_ledger-log`）。",
      ...(info.logGuess === undefined ? {} : { logDirFoundButNotEnabled: info.logGuess }),
      hint: "ledger_init",
    };
  }
  const title = typeof args?.title === "string" ? args.title.trim() : "";
  if (title === "") return { ok: false, reason: "title 不能为空 —— 一条摘要至少要有句话说明这轮干了什么。" };

  const now = new Date();
  const cut = (v) => {
    const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
    return s.length > LOG_L1_FIELD_CHARS ? s.slice(0, LOG_L1_FIELD_CHARS) + "…" : s;
  };
  const parts = [
    ["要什么", cut(args?.goal)],
    ["做了什么", cut(args?.did)],
    ["改了", cut(args?.files)],
    ["卡点", cut(args?.issues)],
    ["下一步", cut(args?.next)],
  ]
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}：${v}`);

  let line = `- ${stampSec(now)} (L1) ${cut(title)}`;
  if (parts.length > 0) line += ` ｜ ${parts.join(" ｜ ")}`;
  if (line.length > LOG_L1_LINE_CHARS) line = line.slice(0, LOG_L1_LINE_CHARS) + "…";

  const fileRel = logFileRel(info, "L1", now);
  const abs = path.resolve(root, fileRel);
  if (!isUnder(root, abs)) throw fail("ledger_log_write: 目标逃出了项目根");

  let created = false;
  try {
    created = !fs.existsSync(abs);
    ensureDir(path.dirname(abs));
    if (created) fs.appendFileSync(abs, `# L1 回合摘要 · ${info.logRel}\n`, "utf8");
    // ★ 只追加，永不 replace。
    fs.appendFileSync(abs, line + "\n", "utf8");
  } catch (e) {
    return { ok: false, reason: `写入日志失败：${String((e && e.message) || e)}`, path: abs };
  }

  let staged;
  if (info.manifest?.autoGitAdd !== false && fs.existsSync(path.join(root, ".git"))) {
    const r = gitAdd(root, [fileRel]);
    staged = r.ok ? true : r.stderr || r.error || "git add 失败";
  }

  return {
    ok: true,
    level: "L1",
    path: abs,
    relative: fileRel,
    created,
    chars: Buffer.byteLength(line, "utf8"),
    ...(staged === undefined ? {} : { staged }),
  };
}

/** ⑧ ledger_log_write 的工具外壳。 */

export function defineLogWriteTool(state) {
  return {
    name: "ledger_log_write",
    description:
      "Append one L1 turn summary to the project's activity log — the ONLY log level a machine " +
      "cannot fill in, because it carries intent (why, what was blocked, what is next) rather " +
      "than what merely happened. L0/L2/L3 are collected automatically and need no call. " +
      "Append-only: it never rewrites what is already in the log. Call it at a natural stopping " +
      "point, typically right before answering the ledger_checkpoint card.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        title: {
          type: "string",
          description: "One short line naming what this turn was about. Required.",
        },
        goal: { type: "string", description: "What the user asked for." },
        did: { type: "string", description: "What was actually done." },
        files: { type: "string", description: "Key files added/changed (free text)." },
        issues: { type: "string", description: "What is blocked, uncertain, or half-done." },
        next: { type: "string", description: "What the next step is." },
      },
      required: ["title"],
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const r = writeLog(rootFromExec(exec, args), args);
      // ★★ L1 写成功也算"这一轮已落袋"（压缩前那道闸门认台账与 L1 任一）。
      if (r.ok === true) noteFlushed(state, exec);
      return r;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// /ledger 命令
// ═══════════════════════════════════════════════════════════════════════════

/** 命令返回给用户的那句话（AI 的正式回答走注入那条路）。 */

export function commandText(summary, detail) {
  return detail === undefined ? summary : `${summary}\n\n${detail}`;
}

/**
 * 处理 /ledger <sub>。
 *
 * ★ 分工是刻意的：`show` / `status` 是**纯读**，当场就能给用户看结果；
 *   `init` / `update` / `archive` 需要 AI 判断内容 ⇒ 这里只**置一个待办标记**，
 *   由下一次 `agent/pre-step` 注入一条明确指令给 AI。
 *   这么分的原因：命令处理器里没法可靠地"替 AI 做判断"，
 *   而且任何会话内容的写入都不该由命令悄悄完成（写坏历史是本机的真实事故）。
 */
/**
 * `/ledger` 的子命令表。
 *
 * ★ 这张表同时驱动三件事：**帮助文本**、**命令补全提示**、以及**裸 `/ledger` 弹出的选择卡片**。
 *   三者共用一份数据，才不会出现"卡片里有 log、帮助里没有"这种分叉。
 */

export function ledgerInputHint() {
  return `[回车=选择卡片 | ${LEDGER_SUBCOMMANDS.map((s) => s.sub).join(" | ")}]`;
}

export function ledgerCommandDescription() {
  return `项目台账：直接敲 /ledger 会弹可点的选择卡片（${LEDGER_SUBCOMMANDS.map((s) => s.sub).join(" / ")}）。`;
}

/** 裸 `/ledger` 选择卡片的等待上限。理由见 `pickLedgerSub`。 */

export function ledgerHelpText(note) {
  return (
    "**/ledger** —— 项目台账\n\n" +
    (note === undefined ? "" : `${note}\n\n`) +
    LEDGER_SUBCOMMANDS.map((s) => `- \`/ledger ${s.sub}\`　${s.description}`).join("\n") +
    "\n\n> 直接敲 `/ledger`（不带参数）会弹一张**可点的选择卡片**；" +
    "命令行本身只支持手打子命令，这是平台限制（命令的 input 只能是提示文字）。"
  );
}

/**
 * 裸 `/ledger` ⇒ 弹一张可点的卡片让用户选功能。
 *
 * ★ 为什么要卡片：平台**不允许**命令自带二级选项菜单 —— `dsh-commands` 校验命令定义时
 *   只接受 `input.hint`（字符串）与可选 `attachments`：
 *     `if (!("hint" in rawInput) || typeof rawInput.hint !== "string") throw ...`
 *   所以命令这一层没法渲染"子命令下拉"，全靠用户手打。官方 `/goal` 也只能把
 *   `[<objective>|clear|edit <objective>|pause|resume]` 当**提示文字**写出来。
 *
 * ★ 但 handler 是**被 await 的**，而且 `dsh-commands` 里**没有任何超时**
 *   （该文件内 timeout/TIMEOUT/setTimeout 命中 0 次），所以命令里弹卡片等用户点是合法的。
 *
 * ★ 必须自己给超时：卡片被**关掉（dismiss）时那条 waterfall 不结算**，
 *   不给 signal 的话 `/ledger` 会永远挂着。给 `AbortSignal.timeout` 之后，
 *   超时/丢弃都会走到 `catch` ⇒ 回退成打印帮助文本。
 */

export async function pickLedgerSub(ctx, invocation) {
  const uq = ctx.get("userQuestions");
  if (uq === undefined || typeof uq.ask !== "function") return undefined;
  const agent = invocation?.agent;
  try {
    const result = await uq.ask({
      questions: [
        {
          id: "ledger-subcommand",
          question: "要对这个项目做哪件事？",
          header: "项目台账",
          options: LEDGER_SUBCOMMANDS.map((s) => ({ label: s.label, description: s.description })),
        },
      ],
      ...(agent === undefined ? {} : { agent }),
      signal: AbortSignal.timeout(LEDGER_PICK_TIMEOUT_MS),
    });
    const first = Array.isArray(result?.answers) ? result.answers[0] : undefined;
    const selected = Array.isArray(first?.selected) ? first.selected[0] : undefined;
    const hit = LEDGER_SUBCOMMANDS.find((s) => s.label === selected);
    if (hit !== undefined) return hit.sub;
    // 用户没点选项、而是自己打了字（打 `log` 也能用）。
    const custom = typeof first?.custom === "string" ? first.custom.trim().toLowerCase() : "";
    if (custom !== "") {
      const word = custom.split(/\s+/)[0];
      const byWord = LEDGER_SUBCOMMANDS.find((s) => s.sub === word);
      if (byWord !== undefined) return byWord.sub;
    }
    return undefined;
  } catch {
    // 超时 / 无应答者 / agent 不是活 root / 卡片被丢弃 ⇒ 一律回退到帮助文本。
    return undefined;
  }
}

/**
 * ★★★ 手动 `/ledger compact`：**能立刻压就立刻压**（2026-10-09 用户要求）。
 *
 * 用户原话：*"为什么这些指令都不是马上执行呢？感觉和官方的压缩不一样，
 * 这容易导致有时候到水位的时候主动按压缩不能进行，比较危险。"*
 *
 * ★ 查清了"为什么等不到"（读内核 `dsh-agent-loop` 真源码，非猜）：
 *   `agent/status` **只在状态真的变化时才发**（`:790-798`
 *   `if (status !== previousStatus) this.dispatch.emit("agent/status", …)`）。
 *   ⇒ 用户**在空闲时**敲命令 → 排队 → 等一个永远不会再发的 `idle` 事件
 *   → **压缩永远不发生**。这正是他说的"按了不能进行"。
 *
 * ★ 官方 `/compact` 的做法就是直接 await（`dsh-command-compact`：
 *   `await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)`）。
 *   我们原来非要多等一个回合，没有理由 —— 命令 handler 本来就被 await、平台不设超时
 *   （`dsh-commands` 里 timeout 命中 0 次），所以当场压完是合法的。
 *
 * @returns {Promise<object>} 命令结果（`{kind, text}`）
 */

export async function runManualCompactNow(ctx, invocation, state, capsule, root) {
  const agent = invocation?.agent;
  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid === "") {
    return { kind: "error", text: "拿不到本会话的 id，无法压缩。" };
  }
  const key = String(sid);

  // ① 先看能不能当场压。**没有服务**要如实说，不能假装排队成功。
  const compaction = compactionServiceFor(ctx, agent);
  if (compaction === undefined) {
    return {
      kind: "error",
      text: "本机没有 `compaction` 服务，无法压缩。（台账功能不受影响。）",
    };
  }

  // ② 抓胶囊（压缩一跑，会话记忆的去重集合就变了 ⇒ 必须**压前**抓）。
  let capsuleChars = 0;
  try {
    const info = inspect(root);
    const snap = renderCapsule(info, capsule?.get?.(key));
    if (snap !== undefined) {
      state.capsuleSnapshot.set(key, snap);
      capsuleChars = snap.length;
    }
  } catch {
    /* 抓不到就不抓，别挡住压缩 */
  }

  // ③ ★ 当场压。`runHighFidelityCompact` 会走同一道闸门 —— 而它认得
  //    `source: "command"`（人手动发起）⇒ 即便没落盘也**放行**（见 `MANUAL_COMPACT_SOURCES`）。
  const r = await runHighFidelityCompact(ctx, state, agent, capsule, "command");

  if (r.ok === true && r.compressed === true) {
    return {
      kind: "success",
      text:
        "**已压缩**（立刻执行，未等回合结束）\n\n" +
        "- 触发：`/ledger compact`（手动）\n" +
        (capsuleChars === 0 ? "" : `- 逐字胶囊：**${capsuleChars} 字符**（下一次注入时随台账一起注回）\n`) +
        // ★ D45：把"存到哪了"直接给出来 —— 可回溯的前提是**知道去哪找**。
        (r.capsuleRel !== undefined
          ? `- ★ 胶囊已**存盘**：\`${r.capsuleRel}\`（原件，可 diff；重启后仍在，压缩链再压也不动它）\n`
          : r.capsulePersistReason !== undefined
            ? `- ⚠ 胶囊**没存盘**：${r.capsulePersistReason}\n`
            : "") +
        (r.flushGate === undefined ? "" : `- 落盘闸门：${r.flushGate}\n`) +
        "\n★ 这是**我们的**压缩，不是内核的 `/compact`：它会先保住" +
        "**你说过的原话、报错原文、改过哪些文件、去哪重读**，压完再注回来。",
    };
  }

  // ④ 压不成 —— 分情况**如实**回报，并按需退回队列。
  //
  //   ★ 这里的关键：**只有"忙"才值得排队**。其余情形（没有可压的历史 /
  //     没有 compaction 服务）排了也白排 —— 那会变成"说已排队，然后永远不发生"。
  //
  // ★★★ 2026-10-12 修（真机事故，用户 01:13 亲自撞上）：**判据原来只认文本，漏了 2/3。**
  //   内核的 `busy` 有**三条**原文（`dsh-compaction-basic`）：
  //     ① `manual compaction: the session already has an open turn`（`:457`）← 旧正则认得
  //     ② `…compaction already in progress; the session compaction lock is already active`（`:538`）← 漏
  //     ③ `manual compaction requires an idle agent with no waking queued work`（`:1009`）← 漏
  //   ⇒ 用户撞的是 ③ ⇒ 插件判成"失败" ⇒ 回「**压缩没有发生**」，
  //     而那一刻**自动全量正在跑**（被压 428,652 tok）⇒ 把"正在做"说成了"没发生"。
  //   ★ 现在**优先判结构化 `code`**（三条 busy 全是 `"busy"`，一次就够、且不怕内核改文案）；
  //     文本正则**保留为兜底** —— 夹具 / 老内核 / 别的实现可能只给 message。
  //     （两个判据都给会"双保险"，但**注释必须写明主次**，否则后人不知道该信哪个。）
  const reason = String(r.reason ?? "未知原因");
  const codeBusy = r.errorCode === "busy";
  const textBusy = /busy|open turn|已有活跃|not idle|already has active work|idle agent|waking queued|compaction lock/i.test(
    reason
  );
  const busy = codeBusy || textBusy;

  if (busy) {
    state.hfCompactAfterTurn.set(key, { at: Date.now(), source: "command" });
    return {
      kind: "success",
      text:
        "**已排队：高保真压缩**\n\n" +
        "- 触发：`/ledger compact`（手动）\n" +
        "- ★ 现在**压不了**（`compaction` 要求 agent 空闲且没有打开的回合）：" +
        `${reason}\n` +
        "- 已退回队列：本回合结束后（agent 空闲时）自动执行，**你不需要再按一次**。",
    };
  }

  return {
    kind: "error",
    text:
      `压缩没有发生：${reason}` +
      (r.hint === undefined ? "" : `\n\n建议：\`${r.hint}\``) +
      // ★★★★★ 2026-10-13（D166）：把内核那句固定文案的**真因**摊开。
      //   ★ 见 `compactionFailureAdvice` 的注释（真机：provider 断流被内核一律写成
      //     "could not produce a smaller summary"，我们原样转述 ⇒ 用户分不清
      //     「重试就行」与「按了也白按」）。
      //   ★ 按**独立块**渲染（不用行内代码块）：它可能多行、且自身带 markdown。
      (r.causeNote === undefined ? "" : `\n\n${r.causeNote}`),
  };
}

/**
 * 手动**轻量**压缩（`/ledger light`）。
 *
 * ★★★ 为什么不能像 `compact` 那样"当场直接压"：
 *   `compactNow`（全量那条）走的是 `agent.runMaintenance(…)` + **`owner: null`**，
 *   所以它**要求 idle**；而增量用的 **`compactRegion` 把 `owner` 硬编成 `"current-turn"`**
 *   （`compaction-basic:971-976`）⇒ 它**要求有打开的回合**，idle 时调用会抛
 *   *"compactRegion: no open turn"*（`:460`）。
 *   ★ 我又确认过 `dsh-compaction-basic` 的 export **只有引擎类**
 *     （`export { BasicCompactionEngine, … }`），**没有**可单独调用的低层函数 ——
 *     所以"在 idle 里手工选一段范围压掉"这条路**走不通**。
 *
 * ⇒ 正解是**复用那条已经被证明能跑的 in-turn 路径**：
 *   ① 在这里立一个「下一次 pre-step 强制压」的旗子；
 *   ② `agent.steer()` 唤醒一轮（与 `init/update/archive` 同一个唤醒口，已验证）；
 *   ③ 那一轮的 `agent/pre-step` 看到旗子 ⇒ `runIncrementalCompact(force)` 压掉最旧一段。
 *
 * ★ 用户价值：他按一下就能**立刻**做一次轻量压缩，不必等水位涨到 20 点。
 */

export async function runManualLightCompactNow(ctx, invocation, state, root) {
  const agent = invocation?.agent;
  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid === "") {
    return { kind: "error", text: "拿不到本会话的 id，无法压缩。" };
  }
  const key = String(sid);

  // ① 先如实检查服务在不在（不在就别假装成功了）。
  const compaction = compactionServiceFor(ctx, agent);
  if (compaction === undefined || typeof compaction.compactRegion !== "function") {
    return {
      kind: "error",
      text:
        "本机没有可用的 `compaction` 服务（或它不支持 `compactRegion`），无法做轻量压缩。\n\n" +
        "（台账功能不受影响。全量压缩 `/ledger compact` 走的是另一个方法，可以另试。）",
    };
  }

  // ② 立旗子：下一次 pre-step 强制压（不看涨幅、不看落盘闸门）。
  //   ★★★★★ 2026-10-14（D190，用户拍板）：**带 `lastTurn: true`** ——
  //     用户原话（逐字）：*"那轻量压缩就可以用了——变成手动命令，
  //     效果是**对上一个回复进行压缩**。"*
  state.deltaForce.set(key, { at: Date.now(), source: "command", lastTurn: true });

  // ③ 唤醒一轮，让 pre-step 真的跑到（idle 时不唤醒就什么都不会发生 —— 这正是 D40 那个坑）。
  let steered = false;
  if (typeof agent.steer === "function") {
    try {
      agent.steer({
        id: randomUUID(),
        // ★ 内容刻意**短**：这轮的目的只是"把 pre-step 触发起来"，
        //   真正该进上下文的东西（台账 + 逐字胶囊）由 pre-step 自己注入。
        content: [
          {
            type: "text",
            text:
              "（插件指令，不是用户的话）用户刚敲了 `/ledger light`，要求立刻做一次**轻量压缩**。" +
              "插件会在本轮的 pre-step 里完成它，**你不需要做任何事**；" +
              "如果本轮结束时你看到压缩提示，照常继续手上的工作即可。",
          },
        ],
        source: { kind: INJECT_KIND, form: "instructions" },
        role: "user",
      });
      steered = true;
    } catch {
      steered = false;
    }
  }

  return {
    kind: "success",
    text:
      "**已请求：轻量（增量）压缩**\n\n" +
      "- 触发：`/ledger light`（手动）\n" +
      "- 做法：**只压最旧一段、保留最近一大块**（不碰新近细节）\n" +
      (steered
        ? "★ **立刻执行**：已把这一步推进 AI 的下一步，插件会在它的 `pre-step` 里压掉。\n"
        : "⚠ 没能唤醒 AI（它当前不便被唤醒）⇒ 这条请求会在它的下一步生效。\n") +
      "\n★ 与 `/ledger compact` 的区别：`compact` 是**全量**（压到很小、保留指针），" +
      "`light` 是**轻量**（只压最旧一段，水位小幅回落）。",
  };
}

/**
 * 真正执行一个子命令。**卡片选中的与手打的走的是同一条路** ——
 * 同一个子命令无论从哪个入口进来，后果必须一模一样。
 */

export async function runLedgerSub(ctx, invocation, state, sub, capsule, argument) {
  const root = projectRootOf(invocation?.agent);
  if (root === undefined) {
    return { kind: "error", text: "找不到本会话的工作目录，无法定位项目。" };
  }

  // ── 手动高保真压缩（需求 ②）────────────────────────────────────────────
  //
  // ★ 这条**不看台账有没有建**：压缩是会话级的事，与项目里有没有台账无关。
  //   （若强行要求台账存在，用户在一个还没建台账的目录里就压不了 —— 没道理。）
  // ★★ 2026-10-09：改成**立刻执行**（原来只排队，用户实测"按了不进行"）。
  //   见 `runManualCompactNow` 的注释：空闲时排队等的是**永远不会再发**的 idle 事件。
  if (sub === "compact") {
    return await runManualCompactNow(ctx, invocation, state, capsule, root);
  }

  // ── 手动**轻量**（增量）压缩 ──────────────────────────────────────────
  //   ★ 它**不能**像 `compact` 那样在这里直接压 —— 增量用的 `compactRegion`
  //     硬编了 `owner:"current-turn"`、要求回合开着，而命令是在 idle 跑的。
  //     详见 `runManualLightCompactNow` 的注释。
  if (sub === "light") {
    return await runManualLightCompactNow(ctx, invocation, state, root);
  }

  // ── ★★★★★ 2026-10-13（D180，用户拍板第二种授权）：根本原则条例 ──────────────
  //
  //   用户原话：*"另外一种就是，像现在手动点全量压缩那样子，增加一个选项，
  //   点击那个选项之后，我再输入我的要增加或者减少的东西。然后回车发给模型。"*
  //
  //   ★ 这里就是那条路的落点：`/ledger principles <内容>` ⇒ **用户亲手写的内容**
  //     ⇒ 授权由**这个动作本身**产生（`authorizedBy: "user-command"`）。
  //   ★ 不带内容 ⇒ **只读**（把当前原则全文打给用户看）—— 「点击选项」之后
  //     第一眼该看到的是现状，而不是被要求输入。
  //   ★★ 注意：这条路**不经过模型**。用户可以完全自己改原则（这正是"没有你的授权不能改"的
  //     最强形式：**你可以一个人改，模型不行**）。
  if (sub === "principles") {
    const rawArg = typeof argument === "string" ? argument.trim() : "";
    // ── ★★★★★ 2026-10-14（D193，用户拍板）：`pending` / `approve` ────────────────
    //
    //   用户原话（逐字）：*"另开 /ledger principles approve <id> 可以做。"*
    //
    //   ★ 这是 D180 那条**从未接线的路**的落点：`applyPrincipleProposal`
    //     （用户批准后写盘的**唯一**函数）原来调用点 = 0（`_probe-d189-apply-wired.mjs`
    //     三重取证：静态剥注释后只剩定义 / 行为上"提议→同意"什么都不会发生 / 对照组
    //     `registerGoalsInManifest` 定义 1 调用 1）。⇒ 这里把它**接上**。
    //
    //   ★★★ 为什么是**命令**而不是挂到 `ledger_checkpoint` 卡片上（两个方案的取舍）：
    //     checkpoint 那张卡片是**四选一**的既有契约（不记录 / 只记台账 / 记台账+压缩 /
    //     记台账+交接单），全库每回合都在用。往里面塞第五个选项 = 动一条已经稳定的路，
    //     而且"这一轮的收尾"与"批准某条具体原则"本来就是**两件事**。
    //     ⇒ 另开命令：**新路不动旧路**，出问题也只影响这一条新命令。
    //
    //   ★★ 授权语义（与 D180/D191 完全一致，**没有因为"更方便"而放松**）：
    //     · 授权由**用户亲手敲这条命令**这个动作本身产生（`authorizedBy: "user-command-approve"`）；
    //     · 提议仍有 10 分钟 TTL —— 过期的提议**拒写**（`applyPrincipleProposal` 里判）；
    //     · 写成功后**消费掉**那条提议（一次一批准）；
    //     · 落盘照旧进审计（`APPROVE` 的授权来源与其它几种可分辨）。
    //   ★ 模型**够不到这条路** —— 它是命令层的（用户输入），不是工具层的。
    const head = rawArg.split(/\s+/)[0]?.toLowerCase() ?? "";
    const restArg = rawArg.split(/\s+/).slice(1).join(" ").trim();

    if (head === "pending" || head === "ls" || head === "list") {
      const list = pendingProposals(state, String(invocation?.agent?.session?.header?.id ?? ""));
      if (list.length === 0) {
        return {
          kind: "success",
          text:
            "**待批准的原则提议：0 条**\n\n" +
            "★ 若模型说它提议过，多半是**插件重启过** —— 提议是内存态，重启即清。" +
            "让模型重新提议一次即可（提议不写任何文件，重提没有代价）。",
        };
      }
      const infoP = inspect(root);
      return {
        kind: "success",
        text:
          `**待批准的原则提议：${list.length} 条**（\`${infoP.principlesRel ?? DEFAULT_PRINCIPLES_NAME}\`）\n\n` +
          list.map((p, i) => describeProposal(p, i)).join("\n") +
          "\n\n---\n★ 批准某一条：`/ledger principles approve <id或#序号>`" +
          "（不带参数则取**最近一条**）。\n" +
          "★ 批准后会**逐条展示**你要写进文件的那段原文 —— 落盘前你还按一次回车。\n" +
          "★ 反悔：`/ledger principles deny <id或#序号>`（只是丢掉提议，不写文件）。",
      };
    }

    if (head === "approve" || head === "deny") {
      const sid = String(invocation?.agent?.session?.header?.id ?? "");
      if (sid === "") {
        return { kind: "error", text: "拿不到本会话 id，无法批准提议。" };
      }
      const found = findPendingProposal(pendingProposals(state, sid), restArg);
      if (found.err !== undefined) return { kind: "error", text: found.err };
      const p = found.p;

      // ── deny：只丢掉提议，**不写任何文件** ──────────────────────────────
      if (head === "deny") {
        consumePrincipleProposal(state, sid, p.id);
        return {
          kind: "success",
          text:
            `已**否决**并丢掉那条提议（\`${p.id}\`）。\n\n` +
            "★ **一个字节都没写** —— 否决与批准的区别就在这。\n" +
            "★ 若还想保留它（只是暂时不想批），下次请少打这一句。",
        };
      }

      // ── approve：★ 先把原文**原样**给用户看，再让他确认 ─────────────────
      //
      //   ★ 为什么批准还要再确认一次（用户的原话只要求"批准"，没要求二次确认）：
      //     这条命令的效果是**往根本原则里写内容**，而根本原则是**约束模型自己**的东西。
      //     `replace` / `remove` 更危险（`remove` 删错一段 = 用户的原则凭空少一条）。
      //     ⇒ 落盘前把**逐字原文 + 模式 + 目标文件**摆出来，用户按一次回车 —— 代价极小，
      //       挡掉的是"我以为批的是第 2 条、其实是第 3 条"这类**不可见**的错。
      //   ★★ 确认卡片送不出去时**不写盘、如实说**（宁可让用户重来一次，也不猜他同意了）。
      const info = inspect(root);
      if (info.principlesRel === undefined) {
        // ★ 文件还不存在**不是拒绝理由**（D189 的教训：守卫要放在真正产生副作用的那一步，
        //   而写盘那一步已经由 writePrinciples 回落默认名 + 登记清单处理了）。
      }
      const opLabel = p.op === "add" ? "追加（append）" : p.op === "remove" ? "删除（replace）" : "整份替换（replace）";
      const body = String(p.text ?? "");
      const preview = body.length > 1200 ? `${body.slice(0, 1200)}\n……（共 ${body.length} 字符，这里只显示前 1200）` : body;

      const uq = ctx.get("userQuestions");
      if (uq === undefined || typeof uq.ask !== "function") {
        return {
          kind: "error",
          text:
            "**没有可用的选项卡片刻就没办法让你确认** ⇒ 这次**没有写任何文件**。\n\n" +
            "★ 要么在有客户端的会话里重试，要么**绕开提议**：你想写什么，直接\n" +
            "`/ledger principles <要追加的内容>` 亲手写（那条路不需要批准）。\n" +
            "★ 本条**故意不放行**：批准会往你的根本原则里写东西，我看不到你，就不替你按这个按钮。",
        };
      }

      let result;
      try {
        result = await uq.ask({
          questions: [
            {
              id: "ledger-principles-approve",
              question:
                `**确认把下面这段写进根本原则吗？**\n\n` +
                `· 目标文件：\`${info.principlesRel ?? DEFAULT_PRINCIPLES_NAME}\`\n` +
                `· 写入方式：**${opLabel}**\n` +
                `· 提议：\`${p.id}\`（${Math.max(0, Math.round((Date.now() - p.at) / 60000))} 分钟前）\n\n` +
                "——— 将要写入的内容（逐字）———\n\n" +
                `${preview}\n\n` +
                "——— 内容结束 ———\n\n" +
                (p.op === "remove"
                  ? "⚠️ **删除**是逐字匹配：文件里找不到这段就报错、一个字节都不写。\n"
                  : "") +
                "★ 写入会记进活动日志的审计（来源 `user-command-approve`）。",
              header: "根本原则 · 批准",
              options: [
                { label: "写入", description: "按上面显示的方式与内容落盘。" },
                { label: "取消", description: "什么都不写，提议留着下次再批。" },
              ],
            },
          ],
          ...(invocation?.agent === undefined ? {} : { agent: invocation.agent }),
          signal: AbortSignal.timeout(PRINCIPLE_APPROVE_TIMEOUT_MS),
        });
        void uq;
      } catch (e) {
        return {
          kind: "error",
          text:
            `**确认卡片没能送到你**（${String((e && e.message) || e)}）⇒ 这次**没有写任何文件**。\n\n` +
            "提议还在，随时可以重打一遍这条命令。",
        };
      }

      const answers = Array.isArray(result?.answers) ? result.answers : [];
      const first = answers[0] ?? {};
      const selected = Array.isArray(first.selected) ? first.selected : [];
      const picked = String(selected[0] ?? "");
      // ★ 只有**明确点了"写入"**才写 —— 取不到、点了取消、卡片被丢弃，一律当**没批准**。
      if (!picked.includes("写入")) {
        return {
          kind: "success",
          text:
            "**没有写入**（你点了取消，或者没有做出选择）。\n\n" +
            `提议 \`${p.id}\` 仍在待批准清单里。`,
        };
      }

      const r = applyPrincipleProposal(root, state, sid, p.id, "user-command-approve", invocation);
      if (r.ok !== true) return { kind: "error", text: `写入失败：${r.reason}` };
      return {
        kind: "success",
        text:
          `已把那段原则写入 \`${r.relPath}\`（${r.mode}，现 ${r.lines} 行）。\n\n` +
          "★ 授权来源：`user-command-approve`（**你亲手敲的这条命令 + 你在卡片上确认**）。\n" +
          "★ 那条提议已消费掉 —— 要再改请让模型**重新提议**（一次一批准）。\n" +
          "★ 本次改动已记入活动日志的审计。",
      };
    }

    const text = rawArg;
    const info = inspect(root);

    if (info.principlesRel === undefined) {
      if (text === "") {
        return {
          kind: "success",
          text:
            "**根本原则条例：还没有**\n\n" +
            `模型**无权**创建或修改它。要建立它：\n` +
            `· 敲 \`/ledger principles <你的原则内容>\` —— 你亲手写，回车即写入；\n` +
            `· 或让模型用 \`ledger_propose_principle\` 提议、你批准后写入。\n\n` +
            `（写入后会记进活动日志的审计行。）`,
        };
      }
      // 用户亲手写第一版 ⇒ 授权成立。
      const r = writePrinciples(root, {
        content: text,
        mode: "append",
        authorizedBy: "user-command",
        exec: invocation,
        tag: sessionTag(invocation?.agent),
      });
      if (r.ok !== true) return { kind: "error", text: `写入失败：${r.reason}` };
      return {
        kind: "success",
        text:
          `已建立根本原则条例 \`${r.relPath}\`（${r.lines} 行）。\n\n` +
          "★ 这是**你**写的（授权来源：`user-command`），模型无法改动它 ——" +
          "它只能提议，由你批准。★ 本次改动已记入活动日志的审计。",
      };
    }

    // 已存在 ⇒ 不带内容就打全文给用户看（只读）。
    if (text === "") {
      const abs = path.resolve(root, info.principlesRel);
      const body = readTextSafe(abs) ?? "";
      return {
        kind: "success",
        text:
          `**根本原则条例**（\`${info.principlesRel}\`，${countLines(body)} 行）\n\n` +
          (body.trim() === "" ? "（目前是空的）" : body.trim()) +
          "\n\n---\n★ 要改它：`/ledger principles <要追加的内容>`（追加）。" +
          "\n★ 删除/整份替换请让模型提议、你批准（它能逐字匹配，避免误删）。" +
          "\n★ 模型**没有**直接改它的权限。",
      };
    }

    const r = writePrinciples(root, {
      content: text,
      mode: "append",
      authorizedBy: "user-command",
      exec: invocation,
      tag: sessionTag(invocation?.agent),
    });
    if (r.ok !== true) return { kind: "error", text: `写入失败：${r.reason}` };
    return {
      kind: "success",
      text:
        `已把这段追加进根本原则条例（\`${r.relPath}\`，现 ${r.lines} 行）。\n\n` +
        "★ 授权来源：`user-command`（**你亲手写的**）。★ 本次改动已记入活动日志的审计。",
    };
  }

  // ── `/ledger mode [steady|surgical]` —— 切换本项目压缩模式（2026-10-10）──
  //
  // ★ 为什么**写进项目清单**而不是全局设置：模式是**项目**的性质（见 `modeOf`）。
  //   写全局会把别的项目一起改掉 —— 而那正是用户明确排除的（他选的是"项目级"）。
  // ★ 为什么**必须**有这条命令：设置面板那一项的 hint 里写了"也可以用 `/ledger mode`
  //   随时切换"。写了就得有，否则是空承诺（本文件反复强调的那条纪律）。
  if (sub === "mode") {
    const info = inspect(root);
    const want = typeof argument === "string" ? argument.trim().toLowerCase() : "";
    const cur = modeOf(info);
    const label = (m) => (m === MODE_SURGICAL ? "反复追究" : "正常推进");

    if (info.activeRel === undefined) {
      return {
        kind: "error",
        text:
          "这个项目还没有台账，写不了模式（模式登记在 `.dsh-ledger.json` 里）。\n\n" +
          "先 `/ledger init`，或直接给工具传 `root` 点名一个有台账的项目。",
      };
    }
    // 不带参数 = 只报当前模式（只读，不改任何东西）。
    if (want === "") {
      const suspect = modeManifestSuspect(info);
      return {
        kind: "success",
        text:
          `**压缩模式：${label(cur)}**（\`${cur}\`）\n\n` +
          (suspect
            ? `⚠ 清单里的 \`mode\` 是 \`${JSON.stringify(info.manifest?.mode)}\`，**不认识** ⇒ ` +
              `当前按默认的「${label(MODE_STEADY)}」在跑。\n\n`
            : "") +
          "· `正常推进`（steady）：压缩时**按位置**只压最旧一段、保留最近一段。" +
          "省一次模型输出，适合一路向前干活。\n" +
          "· `反复追究`（surgical）：压缩**前**先让 AI 分三个桶 —— " +
          "`keep` 留上下文（压缩后逐字注回）/ `stash` 落进项目 `_stash/`（不占上下文，按需查）/ " +
          "`drop` 丢掉。适合要反复回看约束与假设的活。\n\n" +
          `切换：\`/ledger mode steady\` 或 \`/ledger mode surgical\`。` +
          (info.manifest?.mode === undefined
            ? "\n\n（当前项目清单里**没有**登记 mode ⇒ 走的是设置面板里的默认值。）"
            : `\n\n（当前项目清单里登记的 mode = \`${info.manifest.mode}\`。）`),
      };
    }
    if (!MODES.includes(want)) {
      return {
        kind: "error",
        text:
          `认不出模式 \`${want}\`。只有两个：\`steady\`（正常推进）、\`surgical\`（反复追究）。\n\n` +
          "★ 这里**故意不改**任何东西 —— 打错一个字就静默退到默认，" +
          "会让用户以为切过去了（配置类功能最难查的失败模式）。",
      };
    }
    const r = writeManifestMode(root, info, want);
    if (r.ok !== true) {
      return { kind: "error", text: `写清单失败：${r.reason}` };
    }
    return {
      kind: "success",
      text:
        `已把**这个项目**的压缩模式切到「**${label(want)}**」（\`${want}\`）。\n\n` +
        `登记位置：\`${path.join(root, MANIFEST_REL)}\`\n\n` +
        (want === MODE_SURGICAL
          ? "★ 下一档水位提醒（70%）起，压缩前会要求你做一次 `ledger_triage` 分流，" +
            "压完把 `keep` 桶**逐字注回**。\n"
          : "★ 已回到常态：压缩只按位置压最旧一段，不再要求分流。\n") +
        "★ 这项**只影响本项目** —— 别的项目各按自己清单里的模式走。",
    };
  }

  // ── `/ledger lock [子项目路径]` —— 把本场对话锁到一个项目目录（2026-10-10）──
  //
  // ★ 用户原话：*"可以让用户和AI说之后AI调用，或者说把项目注册到对应的文件夹上，
  //   以后各种工具的使用都在那个文件夹上。"* + *"最开始的提示卡片就可以有这样的选择。"*
  // ★ 与 `ledger_lock` 工具**共用** `setProjectLock` / `lockedRootOf` ——
  //   命令与工具走同一条路（本文件反复强调：两个入口必须后果一模一样）。
  // ★ 不带参数 = 报当前锁定状态（若已锁则解锁？不 —— 那太危险）。
  //   这里是**只读报告**；要解锁得明确说 `/ledger lock off` 或 `none`。
  if (sub === "lock") {
    const want = typeof argument === "string" ? argument.trim() : "";
    const cur = lockedRootOf(invocation?.agent);
    const show = (extra) =>
      ({
        kind: "success",
        text:
          extra +
          `\n**当前锁定**：${cur === undefined ? "（无 —— 按会话工作目录解析）" : `\`${cur}\``}\n\n` +
          "用法：\n" +
          "· `/ledger lock <路径>` —— 锁到那个目录（相对路径按当前工作目录解析）\n" +
          "· `/ledger lock off` —— 解锁，回到按会话工作目录解析\n\n" +
          "★ 锁定**会记住**：重启、关掉再开都还在；**每场对话各记各的**，互不影响。\n" +
          `★ 记录放在 **DSH 自己的家**（\`plugin-data\\dsh-ledger-memory\\locks.json\`），` +
          "**不在你的工作区里** —— 你的项目目录不会因此多出任何文件。\n" +
          "★ 要彻底取消，`/ledger lock off` 一次即可（内存与记录一起删）。",
      });

    if (want === "") return show("**锁定状态（只读）**：这条命令不带参数时什么都不改。\n");
    if (["off", "none", "clear", "unlock", "-"].includes(want.toLowerCase())) {
      const r = setProjectLock(invocation?.agent, undefined);
      return show(
        r.wasLocked === true
          ? `已**解锁**${r.wasLockedRoot ? `（原锁定：\`${r.wasLockedRoot}\`）` : ""}，记录也一并删了。`
          : "本来就**没有锁** —— 什么都没变。"
      );
    }

    const base = projectRootOf(invocation?.agent);
    const abs = path.resolve(base ?? process.cwd(), want);
    const r = setProjectLock(invocation?.agent, abs);
    if (r.ok !== true) return { kind: "error", text: r.reason };
    const info = inspect(abs);
    return show(
      `已锁定到 \`${abs}\`${r.persisted === true ? "，**已经记住了**（重启也还在）" : "（⚠️ 记录没写成，只在本次生效）"}。\n\n` +
        (info.activeRel !== undefined
          ? `这个目录有台账：\`${info.activeRel}\`。`
          : "⚠️ 这个目录**还没有台账** —— 要让它有，接着让 AI 调 `ledger_init`。") +
        "\n"
    );
  }

  if (sub === "log") {
    const info = inspect(root);
    if (info.logRel === undefined) {
      const guess = info.logGuess;
      return {
        kind: "success",
        text:
          "**活动日志：未启用**\n\n" +
          (guess === undefined
            ? ""
            : `⚠ 项目里**有** \`${guess}\` 目录，但它没有登记进清单 ⇒ **日志并没有在采集**。` +
              `要让 AI 把清单的 \`logDir\` 设成 \`${guess}\`，登记之后才开始记。\n\n`) +
          "日志是**可选**的，没登记就不会往项目里写任何东西。要启用，让 AI 在 `ledger_init` 时传\n" +
          "`logDir`（例如 `_ledger-log`）；已经初始化过的项目也可以直接用工具改清单。\n\n" +
          "启用后：**L0 里程碑 / L2 文件流水 / L3 工具流水 / L4 用户消息存档**由插件**自动采集**\n" +
          "（不调用模型、不花 token），L1 回合摘要由 AI 写。五档都**永不注入上下文**，只在回溯时读切片。",
      };
    }
    const files = logFileList(info);
    const byLevel = new Map();
    let bytes = 0;
    for (const f of files) {
      byLevel.set(f.level, (byLevel.get(f.level) ?? 0) + 1);
      bytes += f.bytes;
    }
    const levels = info.logLevels;
    const onOff = LOG_LEVEL_NAMES.map((l) => `${l}${levels[l] ? "开" : "**关**"}`).join(" / ");
    return {
      kind: "success",
      text:
        "**活动日志**\n\n" +
        `- 目录：\`${info.logRel}\`\n` +
        `- 档位：${onOff}\n` +
        `- 文件：${files.length} 个（${LOG_LEVEL_NAMES.map((l) => `${l} ${byLevel.get(l) ?? 0}`).join(" · ")}），合计 ${(bytes / 1024).toFixed(1)} KB\n` +
        `- 每 ${info.manifest?.archiveWeekMode === "year" ? "年内周" : "月中周"} 一个子目录，与归档同期间键\n\n` +
        "档位含义：\n" +
        "- **L0** 里程碑 · **L2** 文件流水 · **L3** 工具流水 · **L4 用户消息存档** —— 全部**机器自动采集**（不调用模型、不花 token）；\n" +
        "- **L1** 回合摘要 —— 只有这档由 AI 写（`ledger_log_write`），因为只有它带「为什么」。\n\n" +
        "回溯交给 AI：`ledger_log`（可带 since / until / levels / grep，视图 timeline · files · failures · " +
        "**users** · raw）。\n" +
        "★ 看「用户说过什么」用 **`view:\"users\"`** —— L4 刻意**不在**默认档位里（量最大），要显式要。\n" +
        "★ 它**不注入上下文** —— 日志再大也不会挤占你的窗口。",
    };
  }

  if (sub === "status") {
    const info = inspect(root);
    // ★ 用户问的是「AI 自己把台账做了，我怎么知道」——
    //   `status` 是**他主动问**的地方，所以把最近的台账改动一并报出来。
    //   （被动告知走回合末卡片上的回执，见 `describeTouched`。）
    const recent = recentLedgerChanges(info, 5);
    // ★★★ 2026-10-11（D59 的教训）：把**本会话压缩了几次**报出来。
    //   用户那次是自己发现"一次压缩都没发生"的 —— 他本来不该需要自己发现。
    //   所以这个计数器必须出现在**他随手能查**的地方（`/ledger status`）。
    //   ★ 报的是**当前会话**：计数器按 sid 存，换会话就重新数（与闸门同口径）。
    const sid = invocation?.agent?.session?.header?.id;
    const cc = typeof sid === "string" ? compactCountsOf(state, sid) : undefined;
    const ccLine =
      cc === undefined
        ? "- **本会话压缩次数**：**0**（还没有压缩过）\n"
        : `- **本会话压缩次数**：**${cc.total}**（增量 ${cc.delta} · 全量 ${cc.full}）` +
          (cc.lastAt === undefined
            ? ""
            : `· 最近一次 ${new Date(cc.lastAt).toLocaleString("zh-CN")}` +
              (cc.lastSource === undefined ? "" : `（${cc.lastSource}）`)) +
          "\n";
    return {
      kind: "success",
      text:
        "**项目台账状态**\n\n" +
        `- 项目根：\`${root}\`\n` +
        `- 活跃台账：${info.activeRel !== undefined ? `\`${info.activeRel}\`` : "**无**"}` +
        (info.activeRel !== undefined ? `（${info.activeLines} / ${info.maxActiveLines} 行）` : "") +
        "\n" +
        ccLine +
        `- 关键决策：${info.decisionsRel !== undefined ? `\`${info.decisionsRel}\`` : "**无**"}\n` +
        `- 归档目录：${info.archiveRel !== undefined ? `\`${info.archiveRel}\`` : "**无**"}\n` +
        `- 活动日志：${
          info.logRel !== undefined
            ? `\`${info.logRel}\`（${LOG_LEVEL_NAMES.filter((l) => info.logLevels[l])
                .map((l) => l)
                .join("+") || "全关"}）`
            : "未启用"
        }\n` +
        `- Git 仓库：${info.isGitRepo ? "有" : "**没有**"}\n` +
        `- .gitignore：${info.hasGitignore ? "有" : "没有"}\n` +
        (info.overThreshold ? `\n⚠ 活跃台账已超过 ${info.maxActiveLines} 行，建议归档。\n` : "") +
        (recent.length === 0
          ? "\n**最近改动**：还没有记录（没启用日志，或还没人写过台账）。\n"
          : "\n**最近改动**（谁在什么时候动过这份台账）：\n" +
            recent.map((l) => `${l}\n`).join("") +
            "\n> 完整记录：让 AI 调 `ledger_log`（`view:\"audit\"`）。\n"),
    };
  }

  if (sub === "show") {
    const info = inspect(root);
    if (info.activeRel === undefined) {
      return {
        kind: "success",
        text: `这个工作区还没有台账。执行 \`/ledger init\` 让 AI 为它设计一套。`,
      };
    }
    if (!info.activeExists || info.activeAbs === undefined) {
      return { kind: "error", text: `台账文件 \`${info.activeRel}\` 读不到。` };
    }
    const rawText = readTextSafe(info.activeAbs) ?? "";
    const noteMax = numOf("maxReadChars", MAX_READ_CHARS);
    const body =
      rawText.length > noteMax
        ? rawText.slice(0, noteMax) + "\n\n…（过长，已截断）"
        : rawText;
    return {
      kind: "success",
      text:
        `**${info.activeRel}**（${info.activeLines} 行，上限 ${info.maxActiveLines}）\n\n` +
        "```markdown\n" +
        body +
        "\n```",
    };
  }

  if (sub === "init" || sub === "update" || sub === "archive" || sub === "handoff") {
    const agent = invocation?.agent;
    const sid = String(agent?.session?.header?.id ?? "");
    const pending = { command: sub, at: Date.now(), root };
    const what = {
      init: "为这个项目设计并初始化一套台账（含 Git）",
      update: "把本次会话的进展写回活跃台账",
      archive: "把最旧的已完成条目移进归档",
      handoff: "写一份交接单，给下一场会话接手用",
    }[sub];

    // ★★ 2026-10-09：**立刻唤醒一轮**让 AI 马上做，而不是干等用户再说一句话。
    //
    //   原来只 `state.pending.set(...)`，靠下一次 `agent/pre-step` 注入 ——
    //   而 pre-step 只在**有回合在跑**时才有。用户空闲时敲 `/ledger update`
    //   之后什么都不发生（要等他再随便说一句），这正是他说的
    //   *"这些指令都不是马上执行"*。
    //
    //   `agent.steer()` 是内核的正式唤醒口（`dsh-agent-loop:809-811`
    //   `steer → send(input, "next-step", true) → wakeDriver()`），而
    //   `wakeDriver` 在 idle 时会把 phase 置成 `running` 并 kick
    //   （`:854-868`）⇒ **真的起一轮**。回合末那张卡片本来就是这么做的
    //   （见 `offerTurnEndChoice` 里的 `agent.steer(...)`），所以这条路是验证过的。
    //
    //   ★ 失败就退回老的 `pending` 通道 —— 两条路都留着，任一可用即可。
    let steered = false;
    if (agent !== undefined && typeof agent.steer === "function") {
      try {
        agent.steer({
          id: randomUUID(),
          content: [{ type: "text", text: renderInjectionBody(inspect(root), pending) }],
          source: { kind: INJECT_KIND, form: "instructions" },
          role: "user",
        });
        steered = true;
      } catch {
        steered = false; // steer 不可用（例如会话正在收尾）⇒ 退回注入通道
      }
    }
    if (!steered && sid !== "") state.pending.set(sid, pending);

    return {
      kind: "success",
      text:
        `已请求 AI：**${what}**。\n\n` +
        (steered
          ? "★ **立刻就开始了**（已把这条指令直接推进 AI 的下一步，不需要你再说话）。"
          : "（AI 当前不便被唤醒 ⇒ 这条指令会在它的下一步注入；直接说句话或让它继续即可。）"),
    };
  }

  return {
    kind: "error",
    text:
      `未知子命令 \`${sub}\`。可用：` +
      LEDGER_SUBCOMMANDS.map((s) => s.sub).join(" / ") +
      "。直接敲 `/ledger` 可以点选。",
  };
}

/**
 * `/ledger` 的入口：解析子命令，裸敲时弹卡片。
 *
 * ★ 为什么是 async：裸 `/ledger` 要走 `pickLedgerSub`（等用户点选）。
 *   命令 handler 是被 await 的，且平台对它没有超时，所以这样是安全的。
 */

export async function handleLedgerCommand(ctx, invocation, state, capsule) {
  const raw = String(invocation?.rawInput ?? "").trim();
  const sub = (raw.split(/\s+/)[0] ?? "").toLowerCase();
  // ★ 第二个及之后的词 = 参数（目前只有 `mode <steady|surgical>` 用）。
  //   ★ 平台**没有** `invocation.argument` 这个东西 —— 命令拿到的是整串 `rawInput`
  //     （见上面 `raw.split(/\s+/)[0]` 的原本写法）。所以要自己切出来，
  //     不能想当然地读一个不存在的字段（读了就是永远 `""`）。
  const rest = raw.split(/\s+/).slice(1).join(" ");

  // 显式帮助：不弹卡片，直接印文字（脚本化/观察时不该被一张卡片挡住）。
  if (sub === "help") return { kind: "success", text: ledgerHelpText() };

  // 裸 `/ledger` ⇒ 弹卡片点选。用户点了就等于手打了那个子命令。
  if (sub === "") {
    const picked = await pickLedgerSub(ctx, invocation);
    if (picked === undefined) {
      return { kind: "success", text: ledgerHelpText("（没有选择，以下是用法）") };
    }
    return await runLedgerSub(ctx, invocation, state, picked, capsule, "");
  }

  return await runLedgerSub(ctx, invocation, state, sub, capsule, rest);
}

// ═══════════════════════════════════════════════════════════════════════════
// apply()
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 挂上"下一次 pre-step 强制重注台账"的标记（压缩后）。
 *
 * ★ 键里带项目根：一个会话里换过工作目录时不至于认错台账。
 *   同时按 `session.header.id` 与 `session.id` 各挂一份 —— 官方实现里这两个**是同一个值**
 *   （`dsh-session\lib\index.js:1268`：`get id() { return this.header.id; }`），
 *   所以两份其实重合；留两份只是为了让"事件里拿到的是哪个字段"不影响结果。
 */

export function armReinject(state, sid, agent) {
  const headerId = agent?.session?.header?.id;
  const sessionId = agent?.session?.id;
  const root = projectRootOf(agent);
  const ids = new Set([String(sid), String(headerId ?? ""), String(sessionId ?? "")]);
  for (const id of ids) {
    if (id === "" || id === "undefined") continue;
    let set = state.reinject.get(id);
    if (set === undefined) {
      set = new Set();
      state.reinject.set(id, set);
    }
    set.add(`compacted:${root ?? "*"}`);
  }
}

/**
 * 最近一次 `newState()` 的结果（**仅供自检**）。
 *
 * ★ 为什么必须是模块级：`deltaForce` 是插件内部 state，而自检的严格代理
 *   会拒绝 `run.ctx.state`（实测 `cannot get property "state" without inject`）。
 *
 * ★★★ 2026-10-12（D114）：**声明必须放在 `newState` 之前**。
 *   我第一版把它写在 `newState` **下面** ⇒ `newState` 里那句赋值落在
 *   `let` 的**暂时性死区（TDZ）**里 ⇒ 跑起来直接抛 `Cannot access
 *   'latestStateForTest' before initialization`。
 *   ★ 而当时的表现**不是报错、是"只有第一个用例生效"**：
 *     22c-4 的核心断言（AI 未落盘 ⇒ 不许压）通过、后面两条失败 ——
 *     **一个 TDZ 故障伪装成了"行为不对"**。⇒ 又一次"取不到值先怀疑取法"（纪律 3）。
 */

export async function runIncrementalCompact(ctx, state, agent, capsuleMemory, projectInfo, opts) {
  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid === "") {
    return { ok: false, compacted: false, reason: "拿不到会话 id" };
  }
  const key = String(sid);
  const settings = currentSettings();
  // ★ `opts.force`：人手动敲 `/ledger light` 时**不看涨幅、不看落盘闸门**
  //   —— 闸门约束的是 AI 的工作流，不该把用户的明确授权挡回去（与 D40 的
  //   `manual` 旁路同一条理由）。自动那条永远不带 force。
  const forced = opts?.force === true;

  // ★★★ 2026-10-12（D114，用户要求「让模型按需压，但一定先更新台账日志再压缩」）：
  //
  //   `byNeed` = **"模型自己说它到节点了"**。它与 `force` 是**两个不同的东西**：
  //
  //   | | 涨幅判据 | 让路判据 | **落盘闸门** | 谁用 |
  //   |---|---|---|---|---|
  //   | 自动（默认） | 要过 | 要过 | 要过 | 插件兜底 |
  //   | `force`（人按键） | 不看 | 不看 | ★ **不看** | `/ledger light` |
  //   | `byNeed`（AI 主动） | **不看** | 要过 | ★ **照样要过** | `ledger_compact` |
  //
  //   ★ 为什么 `byNeed` **不看涨幅**：模型是"按需"压（一段用完就压），
  //     它不该被"涨够 20 点"这种数字挡住 —— 那正是用户要去掉的"强制 20 压 10"。
  //   ★ 为什么 `byNeed` **仍然要过闸门**：这正是用户的硬要求 ——
  //     *"一定要让模型先更新台账日志再压缩"*。
  //     ★ 而且闸门的语义**本来就是"你到节点了吗"**（见上面那段注释）：
  //       模型写台账时本就在做"什么留上下文、什么进台账"的判断
  //       ⇒ 闸门 = "按需"的**机器可验证版本**。两者不但不冲突，是同一件事的两种说法。
  //   ★ 为什么 `byNeed` 仍要看**让路**：水位已到全量线时该交给全量（D99 的教训）。
  const byNeed = opts?.byNeed === true;

  const compaction = compactionServiceFor(ctx, agent);
  if (compaction === undefined || typeof compaction.compactRegion !== "function") {
    return { ok: false, compacted: false, reason: "没有 compaction 服务（或它不支持 compactRegion）" };
  }
  const pressure = measurePressure(ctx, agent);
  if (pressure === undefined) return { ok: false, compacted: false, reason: "量不到水位" };

  // ── 判据①：相对上次压缩涨够了吗（用户说的"每输出 20%"）────────────────
  //
  // ★★★ 锚点必须走 `anchorOf`（内存 → 落盘兜底），**不能**直接读 `state.deltaAnchor`。
  //   理由见 `anchorOf` 上面的注释：它是进程内 Map，重启即空，
  //   而空了之后 `since` 会退化成整个水位 ⇒ 重启后必然多压一次（实测 6 次）。
  //   ⚠️ 这与 D51/D52 是**同一类错误**（写了新判定却漏了旧调用点），所以这里一次改到位。
  const anchor = anchorOf(state, key);
  const trigger = settings.deltaTriggerPoints / 100;
  const since = anchor === undefined ? pressure.ratio : pressure.ratio - anchor;
  // ★★★ 2026-10-12（D129，用户拍板）：**`fallback`（机械兜底）已删除**。
  //
  //   它原来是"涨够 40 点仍未压 ⇒ 插件替你压一次"。删它的理由（用户原话）：
  //     *"把所有的压缩全部给模型……全量压缩，最迟最迟发生在 75%（可调），
  //       即使模型没有主动压缩。"*
  //   ⇒ 那条绝对线存在的唯一目的是"别让水位撞进内核 80%"，而现在**全量兜底接住了它**。
  //
  //   ⚠️ 下面整段关于 `capLine` 的历史注释**保留**（它记着 D88/D99 两次教训），
  //     但**代码里已经没有 `capLine` / `byCap` / `byFallback`** —— 别照着它去找那些变量。

  // ★★★ 2026-10-11（D88）：**兜底** —— 触发线不许越过内核硬压线。
  //
  //   原来只有 `since >= trigger` 一条 ⇒ 锚点一高（69%），触发线就到 89%，
  //   而内核 80% 就硬压了 ⇒ **增量永远等不到**（详见 `DELTA_TRIGGER_CAP_MARGIN_POINTS` 的注释）。
  //   ⇒ 现在补一条**绝对线**：水位一到"兜底线"就压，**不再看锚点**。
  //
  //   ★★★ 2026-10-12 修一个**我自己引入的回归**（用户当场看出来的：
  //     *"理论上到这个时候，不应该是全量压缩生效吗？怎么是增量压缩先生效呢？"*）：
  //
  //     **旧写法（错）**：`capLine = min(全量线, 内核线) − 5 点`
  //       ⇒ 用户设全量线 **0.75** 时，兜底线 = **0.70** —— **低于全量线**。
  //       ⇒ 水位一进 `[0.70, 0.75)`，`byCap` 就命中，而**让路判据要 0.75 才命中**
  //         ⇒ **增量抢跑**、把水位压回 ~0.62 ⇒ 水位**永远爬不到 0.75**
  //         ⇒ ★ **全量被永久饿死**（实测：本会话"自动（增量）"9 次 vs "自动（70% 水位）"**仅 1 次**）。
  //
  //     ★ 我当初的注释写着"兜底线也必须早于我们自己的全量线（否则让路先命中 ⇒ 全量先跑 ⇒
  //       增量又被挤掉）" —— **这句话本身是反的**：
  //       **"全量在自己的线上接管"不是 bug，是设计**（全量就是那一档的安全网）。
  //       我把该让的路当成"被挤掉"，于是把兜底线压到全量线底下，让它去偷全量的水位带。
  //
  //     **新写法（对）**：`capLine = min(内核线 − 余量, 全量线)`
  //       · 上界仍是"内核线 − 余量"（**必须早于内核**，否则内核抢先、那次抓不到逐字胶囊）；
  //       · 同时**不许低于全量线** ⇒ 兜底触发的位点**恰好落在或高于全量线**，
  //         而全量线那一档**让路判据先命中** ⇒ 该全量就全量。
  //       · 三种设置都自洽：
  //         全量线 0.75 / 内核 0.80 ⇒ capLine = 0.75（= 全量线 ⇒ 让路优先，全量接管）✅
  //         全量线 0.60             ⇒ capLine = 0.60（同上，全量在其线上接管）✅
  //         全量线 0.85（> 内核）    ⇒ capLine = 0.75（**低于内核** ⇒ 增量仍在 0.80 之前抢救）✅
  //         ★ 后一种是兜底真正的用武之地：全量线高过内核线时**全量根本来不及**，
  //           兜底保证我们在被内核硬压之前先自己压一次。
  //
  //  ★★★ 2026-10-12（D129）：上面整段"兜底线 `capLine`"的讨论**已成历史** ——
  //   用户拍板把机械增量兜底**整个删掉**，所以 `capLine` / `byCap` / `byFallback`
  //   三个东西**都不再存在**。留这段注释只为解释"为什么曾经需要它、现在为什么不需要"。
  //
  //   为什么不需要了：`capLine` 存在的唯一目的是"**别让水位撞进内核 80%**"。
  //   而现在这条职责交给了**全量兜底**（`hfLine`，默认 0.75）⇒ 它接得住，
  //   且它带逐字胶囊（内核那次没有）⇒ 增量那条绝对线**没有存在必要**。
  //
  //   ★ 手动 `forced`（`/ledger light`）照旧绕开一切判据（D40）。
  //
  //   ★ 为什么敢删（这是与 billion 的分工，与 D127 同一条取舍）：
  //     `byCap` / `byFallback` 存在的理由是"怕模型不理轻推 ⇒ 永不压缩"（D59 的前科）。
  //     而现在**全量 75% 那条兜底接住了它** ⇒ 最坏情况仍有"我们自己的、带逐字胶囊的"压缩
  //     （而不是让内核 80% 那次无胶囊硬压）⇒ 那两条机械兜底**已成冗余**。
  //   ★ 为什么删掉**更好**：机械压的时机是"水位到了"，而**模型才知道"这段用完了"** ——
  //     前者会压掉它可能还要用的东西，后者不会。
  //
  //   ⚠️ 保留的判据只有：`forced`（人按 `/ledger light`）、`byNeed`（模型主动调工具）。
  //     两者的区别见上面那张表：**只有人的按键豁免闸门**。

  // ── 判据①：既不按需、也没到兜底线 ⇒ **检查要不要轻推**（本步不压）────────
  //
  // ★★★ 2026-10-12（D117，用户判断）**本轮的核心改动：轻推不再按"涨了多少"触发。**
  //
  //   | | 旧（D115） | 新（D117） |
  //   |---|---|---|
  //   | 轻推条件 | `since ≥ deltaTriggerPoints`（20 点） | ★ **① 水位 ≥ `NUDGE_MIN_RATIO`（0.45）** |
  //   | | | ★ **② 模型已声明"我到节点了"（本周期落过盘）** |
  //   | | | ★ **③ 本周期还没推过**（`deltaNudged`） |
  //
  //   ★★★ 为什么"到节点"要用**落盘闸门**去判，而不是发明新判据：
  //     本文件自己写着（`flushBeforeCompact` 上方）：
  //       *"模型写台账时本就在做『什么留上下文、什么进台账』的判断
  //        ⇒ **那就是它在声明『我到节点了』**"*。
  //     ⇒ ★ **那个判据早就有了，我只是一直没把它用在轻推上。**
  //
  //   ★★ 这个改法带来一条很好的性质：**"能推 ⇒ 一定能压"** ——
  //     轻推与压缩用**同一个节点判据** ⇒ 不会再出现"推了却被闸门拦住、白打扰一次"。
  //     ⚠️ 实现上要注意：**推的时候不能顺手把闸门消费掉**（那会让真正压缩那步失去判据）
  //     ⇒ 所以这里只**读** `flushedAt > lastCompactAt`，**不调用** `flushBeforeCompact`
  //       （它有副作用：会 `rec.count += 1`，见它自己的注释）。
  if (!forced && !byNeed) {
    // ★★★★★ 2026-10-13（D171）**作用域越界 —— 必须声明在外层**。
    //
    //   ★ 病灶（实测，不是读代码猜的）：它原来声明在下面那个
    //     `if (opts?.dryRun === true) {` **块内**，而**下面那条兜底 return 在块外**
    //     也要用它（渲染「未到轻推区间 N%」）⇒ 只要走到那条 return 就抛
    //     `ReferenceError: nudgeMin is not defined`。
    //   ★ 硬证据（探针打点，全自检）：走到该 return **6 次**（其中 **5 次是真调用**），
    //     **每一次都抛** `nudgeMin is not defined`；而调用点的 `catch` 把它**静默吞掉**
    //     （只有 `forcedLight` 才渲染）⇒ **自检全绿、真机也全绿**。
    //   ★★ 今天它"无害"（异常与被吞的普通返回在调用点行为一致），但它是**地雷**：
    //     ① 那条 return 的 `reason` 是**自动路径唯一的解释文本**，一旦有人去渲染它，
    //        或者把让路/空转闸门挪到它前面 ⇒ 当场变成真故障；
    //     ② 它证明**这个出口从来没有被任何断言执行过**（否则 ReferenceError 必红）——
    //        这正是本项目的"绿是假的"形态（纪律 8 / 10）。
    //   ⇒ 修法：**提到外层**（判据只有一个出处），并补一条**直接执行这个出口**的断言。
    const nudgeMin = numOf("nudgeMinRatio", NUDGE_MIN_RATIO);
    if (opts?.dryRun === true) {
      // ★ 条件①：可推区间（照抄 billion 的 0.45 —— 在那之下不打扰）。
      const inNudgeBand = pressure.ratio >= nudgeMin;
      // ★ 条件②：模型已声明节点（本周期落过盘）。
      //   ★ 与 `flushBeforeCompact` 的判据**同源**（`flushedAt > lastCompactAt`），但**只读**。
      const flushedAt3 = state.flushedAt.get(key) ?? 0;
      const lastCompactAt3 = state.lastCompactCycleAt.get(key) ?? 0;
      const declaredNode = flushedAt3 > lastCompactAt3;
      // ★ 条件③：本周期还没推过。
      const nudgedAt = state.deltaNudged.get(key);
      const notNudgedYet = nudgedAt === undefined || since - nudgedAt >= trigger;
      // ★★★★★ 2026-10-12（D141）条件④：**推之前也要过"够不够大"的闸门**。
      //
      //   ★★★ 为什么：轻推的语义是"**你现在可以压了**" —— 若闸门只装在真压那一步，
      //     就会出现 *"推了它、它去压、被闸门拒"* 的**白打扰**（模型付出一次工具调用）。
      //     ⇒ 而 D117 早就立过一条性质：**"能推 ⇒ 一定能压"** —— 这里把它补齐。
      //   ★ 一句话：**两个开口用同一把尺子**（判据只有一个出口，D25/D117）。
      //   ⚠️ 量不到（`undefined`）⇒ 放行（与真压那条同一口径）。
      const nudgeMinPoints = numOf("minCompressPoints", MIN_COMPRESS_POINTS);
      const nudgeCompressible = estimateCompressibleTokens(ctx, agent, pressure, since, settings);
      // ★ 与真压那条**共用同一个纯函数**（`compGateDecision`）⇒ 两个开口一把尺子。
      const bodyBigEnough =
        compGateDecision(nudgeCompressible, nudgeMinPoints, pressure.window, false).pass === true;
      // ★★★ 2026-10-12（D127，用户拍板）：**不再用"涨幅"卡轻推**。
      //   用户原话：*"不再约束，也不再隔这么多再提醒，而是让模型自由的去调用工具压缩。
      //   就类似于 billion"*
      //   ⇒ 我一度在这里加过 `since >= minGrowth` 的门，**已撤**：
      //     那个门会让"轻推"变成"攒够了才提醒"，而那正是用户要去掉的"隔这么久"。
      //   ★ 之所以敢放开（**这是本插件与 billion 的分工**）：
      //     billion 要约束压缩，是因为**它压掉的会丢**；
      //     而我们压掉的东西**有台账兜底 + 逐字胶囊 + `ledger_recall` 可回读**
      //     ⇒ 压缩在我们这里是**可逆的** ⇒ 没有"压错就亏"的顾虑。
      //     用户原话：*"那个插件的优点就是压缩做的非常好，缺点就是记忆不够完善，
      //     而我们的记忆已经足够完善了"*。
      const shouldNudge = inNudgeBand && declaredNode && notNudgedYet && bodyBigEnough;
      if (shouldNudge) {
        return {
          ok: false,
          compacted: false,
          nudge: true, // ★ 调用点据此**渲染**一句轻推（并**在那时**才落 `deltaNudged` 标记）
          dryRun: true,
          sincePoints: Number((since * 100).toFixed(1)),
          // ★ 渲染处要用它落标记（`deltaNudged` 存的是 **since 的比例值**，不是水位）。
          sinceRatio: since,
          triggerPoints: settings.deltaTriggerPoints,
          reason:
            `你刚落过盘（= 到了一个节点）、水位 ${(pressure.ratio * 100).toFixed(1)}% ≥ ` +
            `${Math.round(nudgeMin * 100)}% ⇒ 若这一段已经用完，可以顺手压一次。`,
        };
      }
    }
    return {
      ok: false,
      compacted: false,
      reason:
        `距上次压缩只涨了 ${(since * 100).toFixed(1)} 点（< 轻推线 ${settings.deltaTriggerPoints}），` +
        `水位 ${(pressure.ratio * 100).toFixed(1)}% 未到轻推区间 ${Math.round(nudgeMin * 100)}%`,
    };
  }
  // ★ `byNeed` 的前提：**确有东西可压**（`since > 0`）。
  //
  // ★★★ 2026-10-12（D127，用户明确拍板）：**这里**只**保留这一道**，
  //   不再加"最小涨幅"之类的门槛 —— 用户原话：
  //     *"我倒是觉得随时压也可以，就是比较激进的一个想法，就是不再约束，
  //       也不再隔这么多再提醒，而是让模型自由的去调用工具压缩。就类似于 billion"*
  //
  //   ⇒ 取舍：**把"该不该压"的判断权交还给模型**，插件只保留
  //     ① 「要有东西可压」这条物理底线（`since > 0`，防零收益空转）；
  //     ② 落盘闸门（先记台账再压 —— 那是用户更早定的铁律，不动）。
  //
  //   ★ 我知道的代价（写在这里，不藏）：每一次压缩都会**重写历史 ⇒ prompt 前缀失效**，
  //     所以"压得太勤"会打冷缓存。这正是本文件别处记着的 `zero-yield loop`。
  //     ⇒ 用户是在**知情**的前提下选了"自由"这一边；若哪天觉得不划算，
  //       把这条改回"最小涨幅门"即可（`tools/selftest.mjs` 里有对应用例）。
  if (!forced && byNeed && since <= 0) {
    return {
      ok: false,
      compacted: false,
      reason:
        `你要求按需压缩，但自上次压缩以来水位没有再涨（${(since * 100).toFixed(1)} 点）` +
        `—— 现在压没有可回收的空间。等有新的旧历史再压。`,
    };
  }
  // ★ 压成了（或即将压）⇒ 把轻推标记清掉：下一轮从新的起点重新计。
  state.deltaNudged.delete(key);

  // ═══════════════════════════════════════════════════════════════════════════
  // ★★★★★ 2026-10-12（D141）**空转闸门** —— "这一段够不够大"
  //
  //   ★★★ 放在这里的理由：它必须在**所有判据之后、真正动手之前**
  //     （`forced` 豁免、`byNeed` 与自动两条都已放行）⇒ 一处收口，三条路都受它保护。
  //     ★ 但**手动 `/ledger light` 豁免**（`forced`）—— 那是人的明确授权，
  //       与 D40/D114 的既有取舍一致（闸门约束的是 AI 工作流，不该挡用户的按键）。
  //
  //   ★★★ 为什么是"够不够大"而不是"涨了多少"（D139/D140 的核心结论）：
  //     触发看涨幅，但**能压掉多少取决于最旧那段多大** —— 两者无因果。
  //     `byNeed` 更是只看 `since > 0` ⇒ **涨 1 点也压** ⇒ 必然空转。
  //
  //   ★ 判据用**同一把尺子**与真压一致（`estimateCompressibleTokens` 复用那套算式），
  //     并且**同时用于轻推**（下面 `opts.dryRun` 分支）—— 消灭"推了却被闸门拒"的白打扰。
  //
  //   ⚠️ 量不到（`undefined`）⇒ **放行**，不拦（理由见 `estimateCompressibleTokens`）。
  // ═══════════════════════════════════════════════════════════════════════════
  if (!forced) {
    const minPoints = numOf("minCompressPoints", MIN_COMPRESS_POINTS);
    const minTokens = (Math.max(0, minPoints) / 100) * pressure.window;
    const compressible = estimateCompressibleTokens(ctx, agent, pressure, since, settings);
    // ★ 判断本身走**纯函数**（`compGateDecision`）—— 两个开口共用它，且它可被直接断言。
    const gate = compGateDecision(compressible, minPoints, pressure.window, forced);
    if (gate.pass === false) {
      // ★ 如实回报（**不是失败**）：上层据此**不注入、不打扰**，也不会误报"压缩发生了"。
      //   ★★ 措辞要给出**可操作**的下一步（照 billion 那句 *"Combine more messages"* 的口径）：
      //      告诉模型"再攒点/把范围扩大"，而不是让它以为坏了。
      const pc = Math.round((compressible / Math.max(1, pressure.window)) * 1000) / 10;
      return {
        ok: false,
        compacted: false,
        tooSmall: true, // ★ 专用标记：调用点据此**不重试、不报错**
        compressibleTokens: compressible,
        minTokens: Math.round(minTokens),
        reason:
          `这次可压的内容太小（约 ${compressible.toLocaleString()} tok ≈ ${pc} 点，` +
          `低于门槛 ${minPoints} 点）——压它不划算：` +
          `压完要重注台账与胶囊，代价比省下的多。` +
          `★ 等旧历史再攒一些（或让范围更大）再压，现在先继续干活。`,
      };
    }
  }

  // ── ★★★★★ 2026-10-13（D155）：**「增量让路给全量」整段已删** ─────────────
  //
  //   ★ 为什么删（用户拍板"全量为主力、增量关掉"）：这一段存在的**唯一理由**是
  //     "增量会抢在全量前面把水位压下去 ⇒ 全量永远轮不到"。
  //     而 D155 之后**增量默认关**（`incrementalCompact: false`）⇒ 没有"枪跑者"了
  //     ⇒ 让路逻辑**失去对象**。
  //
  //   ★★★ 而且它在新默认值下会**变成 bug**（这是本轮自检当场抓到的）：
  //     让路判据是 `pressure.ratio >= hfLine`，而 `hfLine` 从 0.75 变成 **0.30**
  //     ⇒ **任何 ≥30% 的水位都会让路** ⇒ 模型主动调 `mode:"light"` 与 `/ledger light`
  //     **全部被拦住**（注入里只留下一句"增量让路"，看起来像"轻量压缩坏了"）。
  //     ★ 这正是"改默认值会连带改变别的判据语义"的典型 —— 改一处必须追所有引用它的判据。
  //
  //   ★ 保留的证据链（为什么当初需要它、后来为什么不需要）见 DECISIONS：
  //     D119（真事故：增量抢吃全量机会）/ D88·D99（饿死 bug）/ D147（全量只能 idle）。
  //
  //   ★★★★★ 2026-10-13（D172）**这段代码到底还在不在 —— 查清了，两条注释里有一条是错的**：
  //
  //     · 本节标题写着「整段已删」（D155 实施清单第 D 项确实要求拆掉它），
  //       但**代码仍在**（就是下面这个 `if`）—— 注释与代码对不上；
  //     · 本节原注释还写「`mode:"light"` **也不被让路拦**」，
  //       而上面 L13005 那张**权威判据表**写的是 `byNeed` **让路判据 = 要过** ⇒ **两条自相矛盾**。
  //
  //     ⇒ 实测定案（A/B 对照，同一套前提：`incrementalCompact: true`、水位 0.50 ≥ 全量线 0.30、
  //       已落盘 + 已分流）：
  //         · `source:"command"`（`/ledger light`，人按键）⇒ **压缩成功**，无让路 ✅（与守卫的 `!forced` 一致）
  //         · `source:"tool"`（模型调 `mode:"light"`）  ⇒ **被让路拦住**，`regionDelta=0`
  //       ⇒ ★ **判据表是对的、本节那句注释是错的**：增量打开时，`byNeed` 确实要过让路。
  //         语义上也自洽 —— 水位已到全量线时，若放它做一次浅压，就会把水位拉回去、
  //         让**该做的那次深压缩**永远轮不到（这正是 D119 那个"增量抢跑 ⇒ 全量饿死"）。
  //
  //     ★ 默认配置下**看不到这一条**：守卫要求 `settings.incrementalCompact === true`，
  //       而默认是 `false` ⇒ 让路块整个跳过 ⇒ 模型 `mode:"light"` 照常放行。
  //       ⇒ 本节原注释「`mode:"light"` 不被让路拦」**只对默认配置成立**，被当成了普遍结论。
  //
  //   ⚠️ 若将来把 `incrementalCompact` 重新打开 ⇒ 自动路径的让路逻辑**会自动恢复**
  //     （下面条件里含 `settings.incrementalCompact === true`）——
  //     否则 D119 那个"增量抢跑 ⇒ 全量永久饿死"会立刻复发。
  //     ★ 刻意**不删代码、只用开关收口**：让"打开增量"这一个动作**同时**恢复它的配套约束，
  //       而不是留下一句"记得同时改两处"的注释（那正是本文件反复栽的"两处各写一份"）。
  //
  //   ⚠️ **可达性提醒**（实测，别照着本节标题去找"已删的代码"）：
  //     让路块的守卫是 `!forced && settings.incrementalCompact === true && …`，
  //     而**上面 L13115 的 `if (!forced && !byNeed)` 会对所有"自动路径"无条件 return**
  //     ⇒ ★ 让路块**只可能由 `byNeed`（模型主动调 `mode:"light"`）到达**，
  //       自动路径**永远到不了这里**（它在那之前就返回了）。
  //     这与 D155 §三-B「`runIncrementalCompact` 保留但**不再被自动调用**」是一致的：
  //     自动那条路现在**只做轻推、不做压缩**。
  if (
    !forced &&
    settings.incrementalCompact === true &&
    settings.highFidelityCompact === true &&
    settings.autoCompact === true
  ) {
    const hfLine = settings.highFidelityCompactRatio;
    const oursDone = state.hfCompacted.get(key);
    let yieldOverdue = false;
    if (pressure.ratio >= hfLine && oursDone !== true) {
      // ★ 记录"从什么时候开始让路"；一直让不出去 ⇒ 超时后放行。
      const now = Date.now();
      const since0 = state.deltaYieldSince.get(key);
      if (since0 === undefined) {
        state.deltaYieldSince.set(key, now);
      } else if (now - since0 >= DELTA_YIELD_MAX_AGE_MS) {
        yieldOverdue = true; // ★ 超时 ⇒ 不再让路（放行增量）
      }
      if (!yieldOverdue) {
        return {
          ok: false,
          compacted: false,
          reason: `水位 ${(pressure.ratio * 100).toFixed(1)}% 已到全量线 ${Math.round(hfLine * 100)}% ⇒ 增量让路，交给全量高保真`,
          yieldedToFull: true,
        };
      }
      // ★ 超时放行 ⇒ 如实标注（不假装没让过路）。
    } else {
      // ★ 水位掉回全量线之下（或全量已压过）⇒ 让路义务解除，清掉计时。
      state.deltaYieldSince.delete(key);
    }
  }

  // ── ★★★ dryRun：只做**零副作用**的判据，回答"这一步该不该动手" ──────────
  //
  // ★ 为什么需要它（D93 / 用户第 2 点的真根因）：
  //   排队那段原来挂在 `text !== undefined` 门下（调用点），意思是"本步恰好有东西要注入
  //   才顺带排队"。可**"水位到线"这件事与"台账有没有变"毫无关系**。
  //   实测（`_probe-why-late.mjs`）：19:24~19:27 水位 ≥75% 的 16 步里**只有 8 步有注入**
  //   ⇒ 另一半根本**没机会**排队 ⇒ 安全网一路拖到 78.4% 才排上。
  //
  // ★ 为什么不另写一个 `wouldIncrementalCompact()`：那会让**判据出现两份**，
  //   早晚分叉（本文件反复栽过"两处各写一份"）。做成参数 ⇒ **判据永远只有一份**。
  //
  // ★ 为什么插在**这里**（判据①/①b 之后、判据② 之前）：
  //   · 判据①（涨幅）与①b（让路）是**纯读**，零副作用 ⇒ dryRun 可以放心跑；
  //   · 判据②（落盘闸门 `flushBeforeCompact`）**有副作用**（会 `rec.count += 1`），
  //     真实调用时还要再跑一次 ⇒ `dryRun` **绝不能**碰它，否则计数会翻倍
  //     （那正是 D59「计数必须放在唯一收口处」的同型病）。
  //   ⇒ 所以 `dryRun` 的语义是「**已经过了涨幅与让路判据 ⇒ 这一步想动手**」，
  //     而不是「一定会压成」。调用方据此**自造一句注入**，让本步不再是"没机会排队"。
  if (opts?.dryRun === true) {
    return {
      ok: false,
      compacted: false,
      dryRun: true,
      wouldAct: true,
      reason: `dryRun：已过涨幅与让路判据（距上次涨了 ${(since * 100).toFixed(1)} 点）`,
    };
  }

  // ── 判据②：落盘闸门（= "到节点了吗"，零 token）────────────────────────
  //   ★ 没过就**本步跳过**（不是失败）：下一步水位更高、且 AI 可能已写完台账。
  //   ★ 手动 force 时跳过这道闸门（理由见上面 `forced` 的注释）。
  //
  // ★★★ 2026-10-12（D129，用户拍板）：**分流义务挂到这里**（原来挂在水位提醒上）。
  //
  //   用户原话：*"轻量压缩的分流义务**还是要有的**，因为这是区分哪些不能压、
  //   哪些能压、哪些怎么压。"*
  //   ⇒ 它**不是**"到了水位就要做的事"，而是"**每次轻量压缩前**要做的事"。
  //   ★ 为什么挂在这里而不是水位处：水位那处已经按他的要求**去掉了义务**（防卡），
  //     而分流的意义是**决定压什么** —— 那正好是"要压缩"这个动作的属性。
  //
  //   ★ 只在 `byNeed`（模型主动调 `ledger_compact`）时立：那是**模型的意图**，
  //     此时要它先分流（区分留/落/丢）最自然；人手动 `/ledger light`（`forced`）不立
  //     —— 与 D40 一致（用户按键就是授权，不该被插件的自律规则挡回去）。
  if (!forced && byNeed && triageRequired()) {
    const t = triageOwed(state, key);
    // 本周期已经分过流 ⇒ 不重复要求（否则每次压缩都要它再分一次，变成纯开销）。
    const lastCompactAtT = state.lastCompactCycleAt.get(key) ?? 0;
    const triageAtT = state.triageAt.get(key) ?? 0;
    if (t.owed !== true && triageAtT <= lastCompactAtT) {
      state.triageOwedAt.set(key, Date.now());
    }
  }
  if (!forced) {
    const gate = flushBeforeCompact(state, key, projectInfo, { manual: false, ratio: pressure.ratio });
    if (gate.ok !== true) {
      return { ok: false, compacted: false, reason: gate.reason, blocked: true };
    }
  }

  // ── 选范围：**棘轮** —— 每轮压掉固定一段，保留量随之抬高 ──────────────
  //
  // ★★★ 2026-10-10（用户指出我**从头就理解错了**，这条是他的原话）：
  //
  //   *"假设开始时10，加20，触发一次增量压缩，减10，就是20，以此类推，
  //     第五或第六次触发一次全量高保真压缩"*
  //
  //   ⇒ 他要的是**阶梯/棘轮**，水位一级一级**往上爬**：
  //
  //        10 →(+20)→ 30 ──压掉10──→ 20
  //        20 →(+20)→ 40 ──压掉10──→ 30
  //        30 →(+20)→ 50 ──压掉10──→ 40
  //        40 →(+20)→ 60 ──压掉10──→ 50
  //        50 →(+20)→ 70 ──★ 全量高保真★
  //
  //   ★ 而旧实现把「保留最近 N 点」当**常量**传给 `selectIncrementalRange`
  //     （那个函数从后往前攒够 retainTokens 就停）⇒ 每次压完都掉回**同一个低位**：
  //
  //        30 →保留10→ 10   再涨到 30 → 又压回 10   ⇒ **永远在 10↔30 之间摆**
  //
  //     ⇒ 观测到的"压后水位一直在 13~28% 打转、棘轮不走"，就是这个常量造成的。
  //     ⇒ 后果正是用户说的："按理说现在已经到全量高保真压缩的时候了，但现在水位还在这里。"
  //
  //   ★ 正确做法：保留量 = **当前水位 − 这轮要压掉的点数**。
  //     于是压掉的是固定的一段（默认 10 点），保留的部分**逐轮变大** ⇒ 水位棘轮上抬。
  //
  //   ★ 与两个设置项的对应关系（口径已写进它们的 hint）：
  //     · `deltaTriggerPoints`（默认 20）：涨够这么多点才**轻推**（D115 起不再是"必压"）；
  //     · `deltaRemovePoints`（默认 10）：每轮**压掉**这么多点 ⇒ 净涨 = 20 − 10 = 10。
  //     ⚠️ 旧设置项 `deltaKeepPoints` 的语义是"保留常量"，与棘轮**在数学上不相容**
  //        （保留恒定 ⇒ 净涨恒为 0）—— 这正是它的注释自相矛盾的原因
  //        （"保留 10~12"与"净增 8~10"不可能同时成立）。故改名为 `deltaRemovePoints`。
  //
  // ★★★ 2026-10-12（D116，用户原话）：**"依旧是压差不多一半"** —— 他选的是
  //   **「每次压掉**当前累计增量**的一半」**（动态），而不是固定 10 点。
  //
  //   ★ 为什么要动态（他自己给的算例就是动态的）：
  //     · D115 之后，兜底那条线的触发量变成 **40 点**（不再是 20）；
  //       若仍固定压 10，那 40 点只压掉 25% —— **"一半"这个说法在兜底那条路上就不成立了**。
  //     · 动态则：涨 20 ⇒ 压 10（= 今天的行为）；涨 40 ⇒ 压 20 ⇒ 净涨 20。
  //       ★ 棘轮仍然成立（保留量逐轮变大），只是步长随涨幅自适应。
  //
  // ★★★ 2026-10-12（D129，用户拍板）：**口径定为"真·一半"**。
  //
  //   用户原话（本轮）：*"然后模型虽然会积极的调用工具，每次调用工具依旧可以压一定额度，
  //   一半左右。"* —— 追问"一半是对什么取一半"，他答：
  //     **「上一次压缩到这一次准备压缩之间的东西」**
  //   ⇒ **`remove = 上一次压缩至今的增量 ÷ 2`**（`since/2`），而不是固定点数。
  //
  //   ★ 与 D116 的差别（这正是本轮修的）：D116 已经写了 `since/2`，
  //     但**又加了一道 `removeBase × 2` 的上限（默认 20 点）** ——
  //     ⇒ `since = 60` 时"一半"应是 30，却被压到 20 ⇒ **"一半"在增量大时就不成立了**。
  //     ⇒ 现在**上限改为 `deltaRemovePoints`（语义由"每轮压多少"改为"单次最多压多少"）**，
  //       默认 **30** ⇒ 正常情形下**就是一半**，上限只在"攒了很久才压"时兜住。
  //       ★ 为什么不取 50：`since ≤ 100` ⇒ 一半最大 50 ⇒ 取 50 时上限**恒不生效**
  //         （面板上留一个永远不起作用的旋钮 —— 本机纪律：写了就得做到）。
  //
  //   ★ 保留量为什么天然安全：`retain = ratio − since/2 = (ratio + anchor)/2`
  //     ⇒ **永远保留在"锚点与当前水位的中点"**，既不会压穿锚点、也不会只剩残渣。
  //     ★ 这正好也照顾了用户另一条硬约束（"上下文太少 ⇒ 断裂感很强"）。
  const removeCap = Math.max(1, settings.deltaRemovePoints);
  const removePoints = Math.max(1, Math.min(Math.round((since * 100) / 2), removeCap));
  const removeRatio = removePoints / 100;

  const meter = ctx.get("tokenMeter");
  if (meter === undefined || typeof meter.measure !== "function") {
    return { ok: false, compacted: false, reason: "没有 tokenMeter" };
  }
  const measurement = meter.measure(agent.session);

  // ★★★ 2026-10-11 修（用户第二次先发现的「零增量压缩」）——
  //   **保留量必须与被压缩对象同尺度算**。
  //
  //   内核 `dsh-token-meter` 的 `measure()` 返回两个**不同尺度**的量（逐字读过源码）：
  //     · `totalTokens` = `estimateToolsTokens(header)` + `surface.surfaceTokens` ← **含工具头**
  //     · `nodes`       = `surface.nodes`（每项 `{seq, tokens, heuristicTokens}`）← **只有 surface**
  //   而本插件原来：
  //     · 用 `totalTokens` 算 `ratio`（对，`measurePressure` 就该用这个）；
  //     · `retainTokens = floor((ratio − removeRatio) × window)` —— **也在 totalTokens 尺度上**；
  //     · 却把它交给 `selectIncrementalRange`，去 **nodes（只有 surface）** 上累加。
  //   ⇒ 只要 **工具头 > removePoints% × window**，就 `retainTokens > Σnodes`
  //     ⇒ 攒满全部节点仍不够 ⇒ `keepFromIdx` 退到 `firstIdx` ⇒ **返回 null**
  //     ⇒ **压缩永不发生**，而那条返回**不带 blocked/requeued** ⇒ **静默**（一条原因都不注入）。
  //
  //   ★ 本机为何必然踩到：**406 个工具**、定义 JSON ≈ **116K token** > **100K**
  //     （1M 窗口的 10% = `deltaRemovePoints` 默认 10）⇒ 稳定失败。
  //   ★★ 为何 934 项自检没抓到：旧夹具**自己写错了前提** ——
  //     30a 的注释断言"真实内核里 `totalTokens` 就是 surface 各节点之和"（原文如此），
  //     于是夹具让两者**内部自洽**，而真实环境**不自洽**。
  //
  //   ⇒ 修法：**把保留量算在 nodes 的尺度上** ——
  //     用 `Σ nodes` 当作"surface 有多大"，再按同一个 `removePoints` 比例扣。
  //     `retainTokens = max(1, Σnodes − removePoints% × window)`
  //     ★ 为什么减的是 `removePoints% × window` 而不是 `% × Σnodes`：
  //       设置项的口径是"**每轮压掉窗口的百分之几**"（用户原话"减10"，指 10 个点 = 窗口的 10%），
  //       那是**绝对量**，不能随 surface 缩放。所以保留 = Σnodes − 那个绝对量。
  //     ★ 下限：`max(1, …)` —— 不能压到 0（否则会把 system 头也搭进去）。
  const nodeSum = Array.isArray(measurement?.nodes)
    ? measurement.nodes.reduce((s, n) => s + Number(n?.tokens ?? 0), 0)
    : 0;
  const keepRatio = Math.max(0.01, pressure.ratio - removeRatio);
  const retainTokens =
    nodeSum > 0
      ? Math.max(1, Math.floor(nodeSum - removeRatio * pressure.window))
      : Math.floor(keepRatio * pressure.window); // 量不到节点时就退回旧口径（保持行为）
  let range;
  try {
    // ★★★★★ 2026-10-14（D190，用户拍板）：`opts.lastTurn` ⇒ **压「上一个回复」**。
    //   用户原话（逐字）：*"那轻量压缩就可以用了——变成手动命令，
    //   效果是**对上一个回复进行压缩**。"*
    //   ★ 语义差别（这一条是重点）：
    //     · 默认（增量）：**压最旧那一大块、保留最近的** —— "从头压"；
    //     · `lastTurn`  ：**只压最近那个已结束的回合** —— "从尾压"。
    //   ⇒ 方向相反，所以**不复用** `selectIncrementalRange`（那会把语义搅乱）。
    range = opts?.lastTurn === true
      ? selectLastTurnRange(agent.session, measurement?.nodes)
      : selectIncrementalRange(agent.session, measurement, retainTokens);
  } catch (e) {
    return { ok: false, compacted: false, reason: `选范围失败：${String(e?.message ?? e)}` };
  }
  if (range === null) {
    // ★ 压不动了（保留段已覆盖全部历史）⇒ 这是**交给全量高保真**的信号，
    //   不再是"没有可压的旧段落"那么简单。如实回报，让上层能据此判断。
    return {
      ok: false,
      compacted: false,
      reason:
        opts?.lastTurn === true
          ? "找不到可压的「上一个回合」（还没有已结束的回合，或边界挪不到平衡切点）"
          : "没有可压的旧段落（保留段已覆盖全部历史）",
      noRange: true,
    };
  }

  // ── 压缩前抓逐字胶囊（与高保真那条同一条规矩）+ **落盘**（D45）─────────
  //   ★ 增量压缩是**常态**那条（自动跑得最勤），所以这里的落盘最有用：
  //     它保证每一次自动压缩都留下一份**原件**，而不是只活在内存里。
  const capPersist = captureCapsuleBeforeCompact(state, key, projectInfo, capsuleMemory, "auto:delta");

  // ── 真压：`compactRegion`（owner 由内核硬编成 current-turn，所以必须在回合内）──
  //   ★★★ 2026-10-11：与全量那条**同样入队**（不再单槽覆盖）。
  //     `compactRegion` 也会发 `compaction/end`，所以票数一样要对上；
  //     下面每个失败/空转的出口都要 `popHfSourceLast` 退票。
  pushHfSource(state, key, "auto:delta");
  let result;
  try {
    result = await compaction.compactRegion(range.start, range.end, agent, AbortSignal.timeout(300_000));
  } catch (e) {
    const reason = String(e?.message ?? e);
    popHfSourceLast(state, key); // 退票：这次没有产生 compaction/end
    // ★ 回合约束没满足（例如恰好没有打开的回合）⇒ 退回"等 idle"那条老路，
    //   别让这一轮白过。这是**如实降级**，不是静默失败。
    if (/no open turn|current-turn/i.test(reason)) {
      state.hfCompactAfterTurn.set(key, { at: Date.now(), source: "auto:delta" });
      return { ok: false, compacted: false, reason: `退回 idle 路径：${reason}`, requeued: true };
    }
    return { ok: false, compacted: false, reason };
  }

  // ── 压成功 ⇒ 量**压后水位**（既当锚点，也当**实绩**）───────────────────
  //
  // ★★★ 锚点必须取**压后**水位，不能取压前（`pressure.ratio`）—— 这是个真 bug，
  //   我用 `tools/_probe-delta-anchor.mjs` 把两种锚点的轨迹摆出来证过：
  //
  //     锚点=压前：峰值 21 → 42 → 63 → **84** → 105 → 126 … 最高 **186 点**
  //     锚点=压后：峰值 21 → 33 → 33 → 33 → 33 …          最高 **30 点**
  //
  //   为什么会漂：压前是 32、压回 12，而锚点却记成 32 ⇒ 下次要涨到 52 才触发
  //   ⇒ **阈值一轮比一轮高**，一路撞进内核 0.8 区 —— 那正好违背用户
  //   *"尽量延缓达到70、80的时间"*。
  //   取压后 ⇒ 触发点稳定在 (压后 + trigger)。⚠️ **这里必须重新量一次**，
  //   因为压缩刚改过 surface，原来那个 `pressure` 已经过期了。
  //
  // ★★★ 2026-10-11（用户要求「把目标和实际完成度分开」）：
  //   同一个 `afterRatio` **顺便就是"这一轮实际压掉了多少点"** ——
  //   因为 `measurePressure` 给的是 `totalTokens/window`，与
  //   `sincePoints`、与注入里「实测：已用 N tokens」**同一把尺子**。
  //   ⇒ 于是"实绩"**不需要新测量、也不需要估**：`(压前 − 压后) × 100` 就是它。
  //   ★ 旧代码把 `removePoints`（**设置里的目标**）当成实绩报给模型，
  //     而实测只有目标的一半左右（根因见 DECISIONS D70）—— 那会误导模型的预算判断。
  //   ★ 为什么"实绩"在真实 token 口径上还会比这个数更小：
  //     内核的启发式估算把 `reasoning` 当文本一样计价，而 provider 对 thinking 的
  //     计费口径不同 ⇒ 真实请求的缩小量更少（实测约为启发式的一半）。
  //     所以下面报数时**只报同一把尺子量到的落差**，并明确标注它是什么尺子。
  let afterRatio;
  try {
    const after = measurePressure(ctx, agent);
    // ★ 兜底改成"**压前水位 − 本轮压掉的量**"（= 预期的压后水位），
    //   而**不是**旧的"保留常量"。量不到压后水位时，这个估计与真实值同阶，
    //   下一次触发点仍然落在 (预期压后 + 触发涨幅) 附近 —— 棘轮照常抬升。
    // ★ 走 `setAnchor` ⇒ **同时落盘**，重启不再丢（见 `anchorOf` 的注释）。
    afterRatio = after === undefined ? Math.max(0, pressure.ratio - removeRatio) : after.ratio;
  } catch {
    // 量不到就退到"预期压后水位"（比用压前的值安全得多）。
    afterRatio = Math.max(0, pressure.ratio - removeRatio);
  }
  setAnchor(state, key, afterRatio);
  // ★ 实绩（点）：压前水位 − 压后水位。**与目标分开报**（用户 2026-10-11 要求）。
  //   ⚠️ 量不到压后水位时 afterRatio 是"预期值"⇒ 此时实绩≈目标，**必须标注它不是实测**。
  const afterMeasured = measurePressure(ctx, agent) !== undefined;
  const actualPoints = afterMeasured ? Math.max(0, (pressure.ratio - afterRatio) * 100) : undefined;
  armReinject(state, key, agent);
  // ★★★ 2026-10-11（承 D79）：把**刚被压掉的这一段**记成可回读索引。
  //   数据来自内核已经写好的 `compaction/summary.shadowedRange/shadowedSeqs` ⇒ **零新增采集**。
  //   ★ 它必须记在**压缩之后**（那时 summary 事件才存在），且要在 `armReinject` 之后
  //     —— 因为压缩后重注会把这份索引一起推给模型。
  // ★★★ 阶段 1 第 2 件：把**逐字原件的去处**一并记进去（原来只记 seq ⇒ 读者只知道
  //   "原文在日志里"，不知道"同一份历史的成品已经有人分好类了"）。
  //   ★ 用 `capPersist.persistRel`（真落盘成功的那个相对路径）优先；
  //     拿不到就退回"按期间算出的胶囊目录"。两个都是**项目相对路径**（可直接复制）。
  recordShadowedIndex(state, key, agent, "auto:delta", {
    capRel: capPersist?.persistRel ?? capsulePathFor(projectInfo, Date.now()),
  });
  state.lastCompactCycleAt.set(key, Date.now());
  state.flushBlocked.delete(key);
  state.triageBlocked.delete(key);
  state.flushedAt.delete(key);
  // ★★★ 2026-10-11：**增量这条也要计数**（D59 的教训，且正是用户报的那一条）。
  //   用户原话：*"你有没有发现我们直到现在都没有进行任何一次**增量压缩**"* ——
  //   他指的正是这条路径。而我第一版把计数器只加在**全量**那条上
  //   ⇒ 若真去查，会得到"压缩 0 次"的**假象**（增量明明在跑）。
  //   ★ 教训与 `flushBeforeCompact` 的计数同一条纪律：
  //     **计数必须放在唯一收口处，否则一定有一条路径被漏掉。**
  //     这里增量与全量是**两个**收口 ⇒ 两处都要记（且用同一个 `compactCountsOf` 口径）。
  try {
    const cc = state.compactCounts.get(key) ?? { total: 0, delta: 0, full: 0 };
    cc.total += 1;
    cc.delta += 1;
    cc.lastAt = Date.now();
    cc.lastSource = "auto:delta";
    state.compactCounts.set(key, cc);
  } catch {
    /* 计数失败绝不影响压缩本身 */
  }

  // ★★ 这里**不再**置 `hfCompacted`。
  //
  //   旧代码在这里写了 `state.hfCompacted.set(key, true)`，注释说"免得紧接着 70% 那条
  //   又把剩下的全压一遍"。**但那是一处真 bug**（2026-10-10 用户报的
  //   "按理说现在已经到全量高保真的时候了，但水位还在这里"，根因之一就是它）：
  //
  //   · `hfCompacted` 的语义是「**本会话已经做过一次全量高保真**」，
  //     而 70% 那条的判据正是 `state.hfCompacted.get(key) !== true`（见 L9520 附近）；
  //   · 它**除了会话销毁（agent/disposed）之外从不复位**；
  //   · ⇒ 增量压缩每成功一次就把它置真 ⇒ **第一次增量之后，70% 全量高保真永久失效**。
  //     于是水位永远到不了"该全量"那一刻 —— 正是用户观测到的现象。
  //
  //   ★ 为什么"怕紧接全压"这个担心本身不成立：
  //     增量压实跑之后水位只降 `removePoints`（默认 10 点），**不会掉到 70% 以下**；
  //     而 70% 那条自带 `pressure2.ratio >= 0.70` 判据 ⇒ 压完若已低于 70%，它自然不排；
  //     若仍在 70% 以上，**那本来就该全量**（用户要的正是这个）。
  //   ⇒ 两道判据各司其职，不需要用 `hfCompacted` 去"堵"另一条。
  return {
    ok: true,
    compacted: true,
    range,
    // ★ 棘轮口径：报"这一轮打算压掉多少点"与"压后预期水位"，而不是旧名"保留 N 点"。
    //   ⚠️ `removedPoints` 是**目标**（来自设置），不是实绩 —— 调用方必须把两者分开写。
    removedPoints: removePoints,
    keptRatio: keepRatio,
    // ★★★ 2026-10-11（用户："把我的目标和实际完成度分开"）：
    //   **实绩** = 压前水位 − 压后水位（同一把尺子量到的真实落差）。
    //   ★ 为什么必须分开：实测实绩只有目标的 **~44%**（DECISIONS D70/D72）——
    //     若只报目标，模型会以为自己腾出了 10 点的空间，从而高估剩余预算。
    //   ★ `actualPoints === undefined` ⇒ 压后水位**量不到**，此时**不许报数**
    //     （宁可不报，也不报一个假实绩 —— 同 `measurePressure` 的既有原则）。
    actualPoints,
    beforePoints: Math.round(pressure.ratio * 1000) / 10,
    afterPoints: Math.round(afterRatio * 1000) / 10,
    sincePoints: Math.round(since * 100),
    shadowedTokens: result?.shadowedTokenCount,
    nodes: result?.shadowedSeqs?.length,
    // ★ 落盘结果如实带回：没启用日志时**说清楚**，不假装存了。
    capsulePersisted: capPersist.persisted,
    capsuleRel: capPersist.persistRel,
    capsulePersistReason: capPersist.persistReason,
  };
}

/**
 * ★★ 高保真压缩的**唯一执行器**（自动 70% 那条与手动那条共用）。
 *
 * 抽成一个函数的原因（2026-10-09 用户要求"手动压缩也要执行我们的压缩"时发现）：
 *   原来有**两条**几乎重复的压缩路 —— 自动那条（水位 70%）会抓胶囊，
 *   而手动那条（用户选「记录台账 + 执行压缩」）**只调 `compactNow`、不抓胶囊**。
 *   ⇒ 用户手动压一次，压完就没有逐字胶囊可重注了，**"我们的压缩"没生效**。
 *   两条路各写一遍，迟早会再分叉。所以这里只留一份。
 *
 * ★ 时序上必须**在 `compactNow` 之前**抓胶囊：压缩一跑，会话事件的去重集合
 *   与"当时上下文里有什么"都变了；压缩后再现取的胶囊会缺掉**刚好被压掉**的那一段，
 *   而那一段正是我们要救的东西。
 *
 * ★ 调用者必须在 agent **idle** 时调（`compactNow` 非 idle 会抛 `busy`）。
 *
 * @returns {Promise<{ok:boolean, compressed:boolean, reason?:string, capsuleChars?:number}>}
 */
/**
 * ★★★ 压缩**前**抓胶囊的**唯一入口**（4 条压缩路径全走它）。
 *
 * 做三件事，缺一不可：
 *   ① 生成胶囊正文（`renderCapsule`）；
 *   ② 存进 `state.capsuleSnapshot` —— 压缩后重注时要用**这一份**
 *      （压缩一跑，"当时上下文里有什么"就变了，压后再取会缺掉刚被压掉的那段）；
 *   ③ **落盘**（`persistCapsule`）—— 原先只有 ①②，于是胶囊一重启就没了、一消费就没了。
 *      落盘失败**不挡压缩**（可回溯是加分项，压缩本身是主功能），但要如实带回原因。
 *
 * @returns {{chars:number, persisted:boolean, persistRel?:string, persistReason?:string}}
 */

export function captureCapsuleBeforeCompact(state, key, info, capsuleMemory, source) {
  const out = { chars: 0, persisted: false };
  if (info === undefined) return out;
  try {
    // ★★★ D61：**先把盘上那份并回来**，再渲染 —— 否则重启后的第一次压缩
    //   只看得见"重启以来"的那几条原话（正是 D61 实测到的 1 条）。
    //   ★ 放在这里（而不是启动时统一读）的理由：只有真正要压缩时才需要这份历史，
    //     启动时读会白白拖慢每一次会话开启。
    try {
      if (state.capsuleHydrated !== undefined && !state.capsuleHydrated.has(key)) {
        state.capsuleHydrated.add(key);
        const n = hydrateCapsuleMemory(capsuleMemory, key);
        if (n > 0) out.hydrated = n;
      }
    } catch {
      /* 并回来失败就按"只有内存那份"走，不许挡住压缩 */
    }

    const snap = renderCapsule(info, capsuleMemory?.get(key));
    if (snap === undefined) return out;
    state.capsuleSnapshot.set(key, snap);
    out.chars = snap.length;
    // ★ 落盘这一步单独 try：写盘失败绝不能让压缩失败。
    try {
      const pr = persistCapsule(info.projectRoot, info, key, snap, { source });
      out.persisted = pr.ok === true;
      if (pr.ok === true) out.persistRel = pr.rel;
      else out.persistReason = pr.reason;
    } catch (e) {
      out.persistReason = String(e?.message ?? e);
    }
    // ★★★ D61：把**素材本身**也刷到盘上（上面那步存的是渲染好的胶囊快照，
    //   那是"证据"；这一步存的是"原材料"，供重启后重新渲染）。
    //   ★ 放在渲染之后：万一渲染抛错，也还有机会在别的路径刷；
    //     但正常路径下它一定执行到。
    try {
      persistCapsuleMemory(key, capsuleMemory?.get(key));
    } catch {
      /* 同上：落盘失败绝不影响压缩 */
    }
  } catch {
    /* 抓不到就不抓，别挡住压缩 */
  }
  return out;
}

/**
 * ★★★ 2026-10-12：从压缩异常里取出**结构化的失败类别**。
 *
 * 内核的 `ManualCompactionError`（`dsh-compaction/lib/types/index.js`）**带一个稳定的
 * `code` 字段**，取值是 `busy | cancelled | persistence | commit | changed | summary`。
 *
 * ★ 为什么必须用它、而**不能靠解析那句话**（真机实测，2026-10-12）：
 *   内核的 `busy` 有**三条不同的原文**，散在三个地方：
 *     ① `manual compaction: the session already has an open turn`（`:457`）—— 旧正则认得
 *     ② `${stage}: compaction already in progress; the session compaction lock is already active`（`:538`）—— **旧正则漏**
 *     ③ `manual compaction requires an idle agent with no waking queued work`（`:1009`）—— **旧正则漏**
 *   ⇒ **3 条 `busy` 漏 2 条**。用户 2026-10-12 01:13 撞上的正是 ③：
 *     插件没认出它 ⇒ 落到"硬错误"分支 ⇒ 回「**压缩没有发生**」，
 *     而那一刻**自动全量正在跑**（428,652 tok 的那次）⇒ **把"已经在做了"说成了"失败了"**。
 *   ★ 而这三条 `code` **全都是 `"busy"`** —— 判 `code` 一次就对，判文本要追三条、
 *     还追不住内核下次改文案。**判据只吃稳定字段。**
 *
 * ★ 为什么这个函数必须存在（否则修复会漏一路）：`runHighFidelityCompact` 的 `catch`
 *   原来 `return { … reason: String(e.message) }` —— **把 `code` 丢在这里**，
 *   于是下游（命令入口）**再也拿不到**它，只能去猜话。修在这个收口处即可覆盖四条入口。
 */

export function compactionErrorCodeOf(e) {
  const code = e?.code;
  if (typeof code === "string" && code !== "") return code;
  // 次要线索：内核给这个类挂了固定 `name`。有它但没 code 时不假装知道类别。
  return undefined;
}

/**
 * ★★★★★ 2026-10-13（D166）：**把内核那句误导标签翻译成人话** —— 唯一出口。
 *
 * ★ 真机缺陷（2026-10-13 13:18，用户原话：
 *   *"压缩没有发生：manual compaction could not produce a smaller summary。
 *     也就是我手动点压缩好像不太行了"*）：
 *   本插件 `runManualCompactNow` 原来把内核 `ManualCompactionError.message`
 *   **原样转述**成「压缩没有发生：<那句话>」。而内核那句**字面即误导** ——
 *   `dsh-compaction-basic:527` 的 `throwManualFailure()` 把**所有**
 *   `stage === "summary"` 的失败（**包括 provider 断流**）**一律**说成
 *   "could not produce a smaller summary"，听着像"**没东西可压**"。
 *   ⇒ 用户**无法区分**两种完全不同的处境：
 *     · 「provider 这次断了，**再按一次就好**」；· 「真的没东西可压，按了也白按」。
 *   ★ 处置方式天差地别 ⇒ 说错就是**误导用户**（伤"准确性"）。
 *
 * ★ 真因在哪（逐字核过内核源码，不是猜）：`throwManualFailure` 把真因塞进
 *   `ErrorOptions.cause`（`{ cause: failure.error }`）⇒ 异常链上就有。
 *   真机那次真因是 `"Stream ended without finish_reason"`
 *   （`@earendil-works/pi-ai/.../openai-completions.js:485`）＝ provider 流中断。
 *
 * ★ 判据口径：**只在"内核那句话本身没有信息量"时才加译注**；
 *   其余 `code`（`busy`/`cancelled`/`persistence`/`commit`/`changed`）原文
 *   **已经说清楚了**，一律不动 —— 不许给好句子硬加尾巴。
 *
 * @param {Error} e 内核抛出的异常
 * @returns {string|undefined} 附加说明（无话可说时返回 `undefined`，由调用方原样回）
 */

export function compactionFailureAdvice(e) {
  try {
    // 只对 `summary` 这档加译注：它是唯一"原文与真因无关"的档。
    if (e?.code !== "summary") return undefined;
    const cause = e?.cause;
    const causeMsg = String(cause?.message ?? cause ?? "").trim();
    // ★ 真因取不到时**如实说取不到**，绝不替内核编一个原因（D164 同一条纪律）。
    const real = causeMsg === "" ? "内核没把真因带出来" : `真因是：${causeMsg}`;
    return (
      `★ 注意：这句是**内核的固定文案**，不等于"没东西可压"。` +
      `内核把所有"摘要阶段"的失败都记成这一句，**真因它塞在 \`cause\` 里**：${real}。\n` +
      (causeMsg === ""
        ? ""
        : "★ 若真因是 **provider 流中断 / 超时**（如 `Stream ended without finish_reason`），" +
          "那是**瞬时故障**：**过一会儿再按一次**通常就能压成；本插件已把台账与逐字胶囊保留好，不会因此丢东西。")
    );
  } catch {
    return undefined;
  }
}

/**
 * ★★★★★ 2026-10-18（D244，用户拍板「我们自己全程接管」）：**回合内**做一次全量压缩。
 *
 * 用户原话（逐字）：*"如果遇到一个非常长的工作，则工作到准备接近压缩线的时候，
 * 强制进行这些义务，然后进行一次强制的全量压缩，压缩完之后模型接着工作，
 * 整个过程不需要任何操作。"*
 *
 * ── 与 `runHighFidelityCompact` 的**唯一差别**（别搞混）──────────────────
 * | | `runHighFidelityCompact`（旧） | **本函数（新，D244）** |
 * |---|---|---|
 * | 内核入口 | `compactNow` | **`compactRegion`** |
 * | 回合要求 | **必须 idle**（回合已关） | **必须回合开着** |
 * | 能不能在长回合中途跑 | ❌ 抛 `busy` | ✅ |
 * | 压到哪里 | 内核自己选（折到 ~10%） | **我们自己选**：保留最近约 10% |
 *
 * ★ 为什么以前做不到（这是真正的病）：`compactNow` 要求 idle ⇒
 *   **一个连续跑很久、始终不结束的回合永远等不到它** ⇒ 只能拖到内核 80% 硬压，
 *   而那一次**抓不到逐字胶囊**（D215 的结论）。
 *
 * ★★ 为什么 `compactRegion` 能在回合内跑（读内核源码，不是猜）：
 *   `dsh-compaction-basic:972-977` 里它硬编 `owner: "current-turn"`；
 *   而内核自己的 `agent/pre-step`（`:840-853`）就是这么调的 —— **官方同源**。
 *
 * @param {number} [keepRatio] 保留最近多少（默认 0.10，即"折到约 10%"）
 * @returns {{compacted:boolean, reason?:string, before?:number, after?:number}}
 */

export async function runTurnCompact(ctx, state, agent, capsuleMemory, projectInfo, keepRatio) {
  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid === "") return { compacted: false, reason: "拿不到会话 id" };
  const key = String(sid);
  const compaction = compactionServiceFor(ctx, agent);
  if (compaction === undefined || typeof compaction.compactRegion !== "function") {
    return { compacted: false, reason: "没有 compaction 服务（或它不支持 compactRegion）" };
  }
  const pressure = measurePressure(ctx, agent);
  if (pressure === undefined) return { compacted: false, reason: "量不到水位" };

  // ★★★★★ 2026-10-18（D252 真 bug 修复）：**必须用 `tokenMeter.measure()` 的原始返回值**。
  //
  //   ★ 原来这一行写的是 `const measurement = { nodes: pressure.nodes };` ——
  //     而 `measurePressure`（part3.js:2145）只返回 `{total, window, ratio}`，**根本没有 `nodes`**
  //     ⇒ 交给 `selectIncrementalRange` 的 `priced` 是 `undefined`
  //     ⇒ part1.js:3291 `if (!Array.isArray(priced)) return null` **必然命中**
  //     ⇒ 本函数自 D244 落地以来**一次都没真正压过**（探针 `_probe-d252-range-bug.mjs` 实证：
  //       同一次测量、同一个选择函数，传 `{nodes: pressure.nodes}` 得 null，
  //       传**原始** measurement 得 `{start:2,end:4}`）。
  //
  //   ★ 这与 `runIncrementalCompact`（:1928）**必须同一把尺子** —— 那里用的就是 meter 的原始返回值。
  //     本项目反复栽的就是"同一件事两处各写一份"（D59 家族），这里正是同型复发。
  const meter = ctx.get("tokenMeter");
  if (meter === undefined || typeof meter.measure !== "function") {
    // ★ 拿不到 meter 就**如实说**，不要拿一个猜的范围去压（D244 边界④「算不出来就不压」）。
    return { compacted: false, reason: "没有 tokenMeter（拿不到可压范围）", noMeasure: true };
  }
  let measurement;
  try {
    measurement = meter.measure(agent.session);
  } catch (e) {
    return { compacted: false, reason: `量不到面：${String(e?.message ?? e)}`, noMeasure: true };
  }
  if (!Array.isArray(measurement?.nodes) || measurement.nodes.length === 0) {
    return { compacted: false, reason: "量不到面（nodes 为空）", noRange: true };
  }

  // ── 选范围：**按目标水位**保留，而不是"保窗口的固定比例" ────────────────────
  //
  //   ★ 用户 2026-10-18 原话：*"为什么现在压缩完之后还是有 4%十几…之前都能压到 10%几二十几"*
  //   ★ 旧口径 `retainTokens = keepRatio × window`（保 10% 窗口）有两个毛病：
  //     ① 它把**工具头**也算进"保留"里 —— 而工具头根本不可压；
  //     ② 它不关心"压完到底落在几成"，只要保了 10% 窗口就收工。
  //   ⇒ 改成**反推**：要让"压后水位"落在 `target`，需要压掉 `total − target × window`，
  //     而能被压掉的只有 surface（nodes）⇒ 保留量 = `Σnodes − (total − target × window)`。
  //   ★ 为什么这样是对的（口径自洽）：压后 `total' ≈ 工具头 + 保留的 surface 部分`，
  //     而 `工具头 = total − Σnodes` ⇒ 代进去正好得到 `total' ≈ target × window`。
  //   ★ 下限 `max(1, …)`：不能压到 0（否则连最后一条消息都没了）。
  //   ★ 上限 `min(Σnodes, …)`：保留量不可能超过整个 surface。
  const target =
    typeof keepRatio === "number" && keepRatio > 0 && keepRatio < 1 ? keepRatio : 0.1;
  if (pressure.ratio <= target) {
    // ★ 已经在目标水位以下 ⇒ **什么都不做**（D244 边界④：宁可晚一次，也不要无意义地压）。
    return {
      compacted: false,
      reason: `水位 ${(pressure.ratio * 100).toFixed(1)}% 已不高于目标 ${(target * 100).toFixed(0)}%，无需压`,
      belowTarget: true,
    };
  }
  const nodeSum = measurement.nodes.reduce((s, n) => s + Number(n?.tokens ?? 0), 0);
  const removeNeeded = pressure.total - target * pressure.window;
  const retainTokens = Math.max(1, Math.min(nodeSum, Math.floor(nodeSum - removeNeeded)));
  let range;
  try {
    range = selectIncrementalRange(agent.session, measurement, retainTokens);
  } catch (e) {
    return { compacted: false, reason: `选范围失败：${String(e?.message ?? e)}` };
  }
  if (range === null) {
    return { compacted: false, reason: "没有可压的旧段落（保留段已覆盖全部历史）", noRange: true };
  }

  // ── 压缩前：抓逐字胶囊（与另外两条路同一条规矩，D47）──────────────────
  try {
    captureCapsuleBeforeCompact(state, key, projectInfo, capsuleMemory, "auto:midturn");
  } catch {
    /* 抓不到胶囊不阻止压缩（它只是备份），但绝不假装抓到 */
  }

  // ── 真压：`compactRegion`（我们的来源票必须与 `compaction/end` 对得上）──
  pushHfSource(state, key, "auto:midturn");
  let result;
  try {
    result = await compaction.compactRegion(range.start, range.end, agent, AbortSignal.timeout(300_000));
  } catch (e) {
    popHfSourceLast(state, key); // 退票：这次没有产生 compaction/end
    const reason = String(e?.message ?? e);
    // ★ 回合没开着（理论上不该发生，因为我们就在 pre-step 里）⇒ **如实降级**：
    //   退回"等回合末"那条老路，别让这一轮白过。这与 `runIncrementalCompact` 同一条策略。
    if (/no open turn|current-turn/i.test(reason)) {
      try {
        state.hfCompactAfterTurn.set(key, { at: Date.now(), source: "auto:midturn" });
      } catch {
        /* 排队失败不掩盖真正的失败原因 */
      }
      return { compacted: false, reason: `退回回合末路径：${reason}`, requeued: true };
    }
    return { compacted: false, reason };
  }

  // ── 压后：量一次实绩（与另外两条路同口径：`(压前 − 压后) × 100`）──────
  //   ★ 必须**重新量**：压缩刚改过 surface，上面那个 `pressure` 已经过期。
  const after = measurePressure(ctx, agent);
  try {
    recordShadowedIndex(state, key, agent, "auto:midturn", {
      shadowedTokens: result?.shadowedTokenCount,
      nodes: result?.shadowedSeqs?.length,
    });
  } catch {
    /* 记索引失败不影响"已经压成"这个事实 */
  }
  return {
    compacted: true,
    before: pressure.ratio,
    after: after?.ratio,
    shadowedTokens: result?.shadowedTokenCount,
    nodes: result?.shadowedSeqs?.length,
  };
}

export async function runHighFidelityCompact(ctx, state, agent, capsuleMemory, source) {
  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid === "") {
    return { ok: false, compressed: false, reason: "拿不到会话 id" };
  }
  const key = String(sid);

  // ★★ 这一处最关键：它是**自动 70% 那条路**唯一压的地方。
  //   原来直接 `ctx.get("compaction")` ⇒ 本 profile 下恒 undefined
  //   ⇒ 这个功能**从未真正执行过**。
  //   见 `compactionServiceFor` 的注释（正解是 agentPresets.serviceFor）。
  const compaction = compactionServiceFor(ctx, agent);
  if (compaction === undefined) {
    return { ok: false, compressed: false, reason: "本机没有 compaction 服务" };
  }

  // ★ 量一下当前水位：闸门有一条旁路要按它判断（≥75% 就不再拦，见
  //   `FLUSH_GATE_BYPASS_RATIO`）。量不到就是 undefined ⇒ 那条旁路不生效
  //   （此时宁可保守地按原规则走，也不假设水位很低）。
  let measuredRatio;
  try {
    measuredRatio = measurePressure(ctx, agent)?.ratio;
  } catch {
    /* 量不到就算了 */
  }

  // ── ★★★★★ 2026-10-15（D215，修 D214 的**主因**）：**过期的自动排队必须作废** ──
  //
  //   ★ 真机事故（用户 2026-10-15 12:07 亲口报的"三条上下文已压缩"）：
  //     11:51:52 水位 72.3% ⇒ 排队（`hfCompactAfterTurn`，来源 `auto:70%`）；
  //     可它一直没轮到 idle —— 直到 **12:05:17** 回合结束才执行；
  //     而那一刻水位只剩 **55.1%**（内核 11:57 的 80% 那次已经压过了）。
  //     ⇒ 插件**照压不误** ⇒ ① 连压两次；② 第二次压掉的 seq `13048..13692`
  //       正是**内核压完之后新产生的最新历史**（压着压着就不清晰了）。
  //
  //   ★ 根因（一句话）：**排队时把水位记下来了，但全库没有一处读它** ——
  //     `hfCompactAfterTurn` 的 `{ratio, at, retry}` 三个字段，`ratio`/`at`/`retry`
  //     grep 出来 **0 处读取**，只有 `source` 被读。
  //   ⇒ 于是"排队"变成了"无条件承诺"：无论中间发生什么，轮到就必须压。
  //
  //   ★★ 为什么这条判据是**必需的**（不是可选优化）：
  //     `compactNow` 要求 idle，而内核 80% 挂在**它自己的 pre-step** 上（**回合中途**就会跑）
  //     ⇒ **长回合里插件结构性赢不了内核**（本机 turn 35 跑了 13 分 40 秒）。
  //     这决定了"插件排的队**经常是过期的**" ⇒ 不重核水位 = 必然连压。
  //
  //   ★★★ 与 D129 的对称性（这是本项目"修一条路 ≠ 修这个病"的第 N 次）：
  //     D129 已经实现了**另一半** —— 「水位掉回线下 ⇒ 重新武装」（`:20368` 附近：
  //     `probe.ratio < highFidelityCompactRatio ⇒ state.hfCompacted.delete(key)`）。
  //     那一半管的是"**下一次还能不能排**"；这一半管"**已经排上的还算不算数**"。
  //     少了任何一半，机制都是漏的 —— 而漏的这半恰好就是本次事故。
  //
  //   ★ 安全边界（三处，任何一处不满足就**照旧压**）：
  //     ① 只对**自动**来源生效（`auto*`）—— 人手动按的（`/ledger compact`）是明确授权，
  //        与闸门 `MANUAL_COMPACT_SOURCES` **同一条口径**，绝不拦；
  //     ② 量不到水位（`undefined`）⇒ **照旧压** —— 宁可多压一次，也不凭猜测撤销；
  //     ③ 只有**真的掉回线下**才撤销（`< 线`）—— 持平不撤（那时它刚起到作用）。
  //
  //   ★★ 位置要紧：**必须放在抓胶囊之前** —— 否则一次过期排队会白白写一份
  //     胶囊文件（真实落盘副作用），而它对应的那次压缩根本不会发生。
  //     「先把所有会失败/会作废的事判完、一个字节都不写」是本项目的一贯纪律
  //     （`ledger_archive` 那段有同款写法与同款理由）。
  {
    // 只认**自动**来源：它们全部以 `auto` 打头（`auto` / `auto:full` / `auto:70%` / `auto:delta`）。
    // ★ 为什么用前缀而不是列举四个字面量：列举法会在"将来新增一个自动来源"时**静默漏掉**
    //   （D59 的教训：多口子判据必然漏一路）。
    // ★ 而 `manual`（工具）/ `command`（命令）/ `user`（卡片）一律**不撤销**
    //   —— 它们是明确授权；`official` 根本不走这条函数（它由内核发起）。
    const autoSourced = typeof source === "string" && source.startsWith("auto");
    const line = numOf("highFidelityCompactRatio", HIGH_FIDELITY_COMPACT_RATIO);
    if (autoSourced && typeof measuredRatio === "number" && measuredRatio < line) {
      return {
        ok: false,
        compressed: false,
        staleQueued: true,
        reason:
          `这次是**过期的排队**：排的时候在水位 ≥ ${Math.round(line * 100)}%，` +
          `而轮到执行时只有 ${Math.round(measuredRatio * 100)}%（已被别的压缩压下去了）` +
          "⇒ **本次作废**，不重复压缩。（只对自动来源生效；手动压缩不受此判据影响。）",
      };
    }
  }

  // ① 压缩**之前**抓胶囊（哪怕接下来压不成，这份快照也不会有害）。
  //
  // ★ 这里同时把 `info` 留下来给闸门用：闸门要判断"**这个项目有没有台账**" ——
  //   没有台账的会话不该被"强制落盘"拦住（那是不可能执行的指令，会变成死锁）。
  let capsuleChars = 0;
  let projectInfo;
  let capsulePersist = { persisted: false };
  try {
    const root = projectRootOf(agent);
    projectInfo = root === undefined ? undefined : inspect(root);
    // ★ 2026-10-10（D45）：改走 `captureCapsuleBeforeCompact` —— 它多了一步**落盘**，
    //   于是胶囊不再"重启就没、消费就没"。
    capsulePersist = captureCapsuleBeforeCompact(state, key, projectInfo, capsuleMemory, source);
    capsuleChars = capsulePersist.chars;
  } catch {
    /* 抓胶囊失败不该挡住压缩本身 */
  }

  // ② 真压。
  //
  // ★★ 压缩前那道**强制落盘**闸门（用户 2026-10-09 反复强调的那一条）：
  //   *"每次压缩之前强制进行台账更新和日志更新"* —— 关键是**强制**。
  //   压在 70% 的语义是"在细节丢掉之前先把状态落袋"；若这一轮的进展还没写进
  //   台账 / L1，那一压就是把**唯一副本**压掉。
  //   ⇒ 闸门放在**这里**（四条入口唯一的收口）⇒ 自动 / 工具 / 命令 / 卡片
  //     四条路**全都**受它约束，一处不漏。
  //   ★ 被拦下**不是失败**：把意图退回队列（`hfCompactAfterTurn` 重新挂上），
  //     等 AI 写完落盘、下一次 idle 再压。这也解释了为什么它必须放在
  //     `runHighFidelityCompact` 里而不是各入口 —— 否则"退回去"要写四遍。
  //
  // ★★ 2026-10-09 补两条**旁路**（用户："到水位的时候主动按压缩不能进行，比较危险"）：
  //   ① 人手动发起的（`/ledger compact`）**不拦** —— 闸门约束的是 AI 的工作流，
  //      不该把用户的明确授权挡回去；
  //   ② 水位 ≥ 75% **不拦** —— 此时拦下自己的安全压缩只会把机会让给内核 0.8 那次
  //      （它抓不到胶囊），方向反了。
  //   两条都在返回值里如实标注（`flushGate` / `flushForcedThrough`），不假装合规。
  const gate = flushBeforeCompact(state, key, projectInfo, {
    manual: MANUAL_COMPACT_SOURCES.has(source),
    ratio: measuredRatio,
    // ★★★ 2026-10-12（D119）：**这里是全量那条路** ⇒ 打上 `mode: "full"`，
    //   闸门据此**不让 0.75 旁路生效**（用户原话："但是全量也要先记台账日志！！！"）。
    //   ★ 理由：全量压得最狠 ⇒ 没落盘的那段进展会成为唯一副本 ⇒ 它比增量**更**需要先落盘。
    mode: "full",
  });
  if (gate.ok !== true) {
    // ★★ 计数**不在这里加**：闸门内部已经加了（`flushBeforeCompact` 里那次
    //   `rec.count += 1`）。这里若再加一次，就会变成"拦 2 次就放弃"（本意是 3 次），
    //   而且与增量那条的计数口径不一致。这里只取回它记下的数字，用于回报。
    const rec = state.flushBlocked.get(key) ?? { count: 0 };

    // ★ 把意图退回去：下一次 idle 会再试一次（届时 AI 可能已经写完了）。
    //   ⚠️ `hfCompacted` **不置真** —— 因为这次根本没压，会话该压的资格还在。
    //     （与"没有可压缩的历史"那条一致：不压就别把资格用掉。）
    state.hfCompactAfterTurn.set(key, { at: Date.now(), source: source ?? "auto", retry: true });

    return {
      ok: false,
      compressed: false,
      reason: gate.reason,
      blocked: true,
      retryQueued: true,
      blockedCount: rec.count,
      ...(gate.hint === undefined ? {} : { hint: gate.hint }),
    };
  }

  // ★ 先把"谁发起的"记下（需求 ②③）：内核的 `compaction/end` **不知道**这一点，
  //   而 L0 采集要在那条事件上写出"自动 70% / 手动（工具/命令/卡片）"。
  //   记在这里而不是各调用点，是因为**四条入口都经过这一个函数** ——
  //   记一处就不可能漏。
  //
  // ★★★ 2026-10-11 实测改正（用户第 2 点）：改成**入队**，不再是覆盖。
  //   旧写法 `state.hfSource.set(key, source)` 是**单槽**，后写覆盖先写。
  //   实测事故（这一条骗过了用户也骗过了我）：
  //     19:27:38 自动全量**真的开始跑了**（胶囊为证），19:27:57 又来了一次手动命令
  //     ⇒ 单槽被后者覆盖 ⇒ 内核发 `compaction/end` 时读到的来源是「command」
  //     ⇒ L0 把那次全量记成「手动（命令）」⇒ **看起来"自动全量从来没跑过"**。
  //   ★ 所以：**压前入队一个票，`compaction/end` 出队一个**。
  //     失败路径必须把票退掉（下面每个 return 都 pop），否则队列越积越长，
  //     后面的 end 会认领到**别人的**来源 —— 那就是同一个 bug 换个方向再犯一次。
  pushHfSource(state, key, source);
  let result;
  try {
    result = await compaction.compactNow(agent, AbortSignal.timeout(300_000));
  } catch (e) {
    popHfSourceLast(state, key); // 票退掉（退**自己**那张）：这次压缩没有产生 compaction/end
    // ★★★ 2026-10-12：**把结构化的 `code` 一起带出去** —— 原来只带 message，
    //   于是下游只能靠猜话认"忙"，而内核的 busy 有三条不同原文（已漏 2 条）。
    //   见 `compactionErrorCodeOf` 的注释（真机事故：把"正在做"说成"没发生"）。
    const code = compactionErrorCodeOf(e);
    // ★★★★★ 2026-10-13（D166）：**把内核那句固定文案翻译成人话**。
    //   ★ 真机缺陷：内核把所有"摘要阶段"的失败（含 provider 断流）一律说成
    //     "could not produce a smaller summary"（字面像"没东西可压"）
    //     ⇒ 我们原样转述 ⇒ 用户无法区分「重试就行」与「按了也白按」。
    //   ★ 修在这一处收口 ⇒ 四条入口（自动/手动命令/卡片/工具）全都覆盖，
    //     不必改四个调用点（D59：计数/记录/翻译都必须放唯一收口，否则必漏一路）。
    const advice = compactionFailureAdvice(e);
    return {
      ok: false,
      compressed: false,
      reason: String((e && e.message) || e),
      // ★ 注意**不复用 `hint`**：那是"指向某个工具名"的短字段，
      //   既被命令入口当**代码块**渲染（`建议：\`${hint}\``），又被自检按
      //   **精确值**断言（`r.hint === "ledger_write"`）⇒ 塞多行说明会同时打破两处。
      //   ⇒ 另开一个字段，由渲染端按块渲染。
      ...(advice === undefined ? {} : { causeNote: advice }),
      ...(code === undefined ? {} : { errorCode: code }),
      capsuleChars,
    };
  }

  if (result === null) {
    popHfSourceLast(state, key);
    // 没有可压的历史：**不要**把 `hfCompacted` 留着为真，否则这轮之后再也不试了。
    state.hfCompacted.delete(key);
    return { ok: false, compressed: false, reason: "没有可压缩的历史", capsuleChars };
  }

  // ③ 压成功 ⇒ 下一次 pre-step 强制重注（台账 + 胶囊）。
  armReinject(state, key, agent);
  // ★★★ 2026-10-11（D86/D87）：**全量也必须更新锚点** —— 这是"增量被饿死"的真根因。
  //
  //   实测（用户 19:1x 亲自观察并质疑）：
  //     `anchors.json` 本会话锚点 = **49.7%**，其 **mtime = 05:39:39**（最后一次**增量**）；
  //     而 15:51 与 17:33 各做过一次**全量** ⇒ **锚点仍是 05:39 那个值**。
  //   代码依据：`setAnchor(` 全仓库只出现一次，位于**增量**那条路（见上文的对应注释），
  //     全量这条路**从头到尾没碰过锚点**。
  //
  //   ⇒ 后果（这就是用户看到的"增量再也不触发"）：
  //     触发判据是 `水位 ≥ 锚点 + deltaTriggerPoints(20)` ⇒ 锚点 49.7% 时**要涨到 69.7%**；
  //     而每涨到 ~70%，**"绝对 70%"那条先满足 ⇒ 排的是全量**；全量压完又不降锚点
  //     ⇒ 锚点永远停在 49.7% ⇒ 下一轮仍要涨回 69.7% ⇒ **全量永远先到，增量被永久挤掉**。
  //   ★ 这是 D54「增量让路给全量」的**反向变体**：让路本身对，但**全量没把锚点降下来**。
  //
  //   ★ 锚点的语义是"**上次压完的水位**"，是"再涨 N 点就压"的基准 ——
  //     任何一次成功的压缩（不论增量还是全量）都必须把它带回来，否则基准就失效。
  //   ★ 为什么取**压后实测水位**（而不是"压前 − 目标"）：与增量那条**同一把尺子**，
  //     这样"距上次压缩涨了几点"在两条路径上是可比的。
  //   ⚠️ 已知反作用（如实记下）：锚点降下来之后，增量会在**更低的水位**就触发
  //     ⇒ 压得更频繁。`deltaTriggerPoints` 的取值是否仍合适，需在真机上观察后再定
  //     （见 DECISIONS D87 的待办）。
  try {
    const afterFull = measurePressure(ctx, agent);
    if (afterFull !== undefined) setAnchor(state, key, afterFull.ratio);
  } catch {
    /* 量不到就不动锚点（宁可保持旧值，也不要写一个猜的） */
  }
  // ★★★ 2026-10-11（承 D79）：高保真这条**同样**要记「被压段索引」。
  //   ★ 与增量那条是**两个收口**，两处都要记 —— 否则又犯"计数只加一条路"的老毛病
  //     （D59：计数必须放在唯一收口处，否则一定漏一条路）。
  // ★★★★★ 2026-10-13（D163）：**`capRel` 必须一起传** —— 真机缺陷：
  //   原来这里只传了 source ⇒ 全量压缩记下的索引行**没有「逐字原件」指针**，
  //   而增量那条（L13194）传了。于是模型看到的那一行只说「原文在日志里」，
  //   不知道"同一份历史的成品（胶囊）已经有人分好类了" —— 那正是 D85 要修的事，
  //   在**全量**这条路上**没修到**。
  //   ★ 现场：本回合注入里那行就缺 `｜逐字原件：…`（而同一份注入的胶囊段是完整的）。
  //   ★ 判别力：摘掉 `capRel` ⇒ 情形 66② 当场红。
  //   ★ `capsulePersist` 就在上面几行手里（`captureCapsuleBeforeCompact` 的返回值），
  //     **路径在手却没传** —— 与 D85 那条"信息有了、没接到一起"是同一族病。
  recordShadowedIndex(state, key, agent, source ?? "auto:full", {
    capRel: capsulePersist?.persistRel ?? capsulePathFor(projectInfo, Date.now()),
  });
  state.hfCompacted.set(key, true);
  // ★★ 记下"本会话刚压过一次" ⇒ 闸门从此要求**新的**一次落盘才能再压
  //   （这就是"一次压缩，一次落盘"的周期起点）。
  state.lastCompactCycleAt.set(key, Date.now());
  // ★★★ 2026-10-11：**可查的计数器**（D59 的教训）。
  //   用户那轮的原话是"你有没有发现我们直到现在都没有进行任何一次增量压缩" ——
  //   我写了棘轮、自检全绿、还发了版，却从没核对过"压缩真的发生了"。
  //   ⇒ 凡是"应该会发生"的事，都必须留下一个**能被读出来的整数**（不是推断）。
  //   ★ 这一个计数器同时救了两种事故：① 功能没跑（数字不涨）；② 跑得不对劲
  //     （比如只增不减、或 delta/total 比例失衡）。
  //   `reason` 用来分辨是"增量"还是"全量"，以及"是为什么放行的"。
  try {
    const cc = state.compactCounts.get(key) ?? { total: 0, delta: 0, full: 0 };
    cc.total += 1;
    if (source === "auto" || source === "auto:delta") cc.delta += 1;
    else cc.full += 1;
    cc.lastAt = Date.now();
    cc.lastSource = source;
    state.compactCounts.set(key, cc);
  } catch {
    /* 计数失败绝不影响压缩本身 */
  }
  // 压成功了 ⇒ 之前攒的"被拦次数"清零（那个计数只描述"连续没落盘"）。
  state.flushBlocked.delete(key);
  state.triageBlocked.delete(key);
  state.flushedAt.delete(key); // 让"落盘时刻"回到未落盘，逼出下一个周期的落盘
  return {
    ok: true,
    compressed: true,
    capsuleChars,
    source,
    // ★ 如实报告闸门是怎么放行的：真落过盘 / 因为没有台账 / 还是因为拦够了放行。
    ...(gate.why === undefined ? {} : { flushGate: gate.why }),
    ...(gate.forcedThrough === true ? { flushForcedThrough: true } : {}),
    // ★ D59 教训：把计数器一并回报，让"到底压了几次"一读就知道。
    ...(compactCountsOf(state, key) === undefined
      ? {}
      : { sessionCompactions: compactCountsOf(state, key) }),
    // ★ D45：胶囊落盘结果（没启用日志时说清原因，不假装存了）。
    capsulePersisted: capsulePersist.persisted,
    ...(capsulePersist.persistRel === undefined ? {} : { capsuleRel: capsulePersist.persistRel }),
    ...(capsulePersist.persistReason === undefined ? {} : { capsulePersistReason: capsulePersist.persistReason }),
  };
}

/**
 * ★★★ 2026-10-11：**本会话到底压缩了几次** —— 一个能被读出来的整数。
 *
 * 为什么必须存在（D59 的教训，用户先发现的）：
 *   我写了棘轮、自检 907 全绿、还发了 1.0.0，**却从没核对过"压缩真的发生了"**。
 *   用户那句 *"你有没有发现我们直到现在都没有进行任何一次增量压缩"* 点破的正是
 *   这个盲区：**"配了就该跑"不是证据**。
 *   ⇒ 凡是"应该会发生"的事，都要有一个**可查的计数器**，而不是靠推断。
 *
 * 返回 `undefined` = 本会话还没压过（**不是** `{total:0}`：两者的区别有意义，
 * 在这里与 `hfCompacted` / `anchors.json` 的口径保持一致）。
 */

export function compactCountsOf(state, sid) {
  const rec = state.compactCounts?.get?.(String(sid));
  return rec === undefined ? undefined : { ...rec };
}

/**
 * ★★★ 2026-10-11：压缩来源的**入队 / 出队**（修「单槽被并发覆盖」，见 `hfSource` 的注释）。
 *
 * 为什么必须是队列而不是单值：内核的 `compaction/start` / `summary` / `end` 是**有序成对**的，
 * 而两次 `runHighFidelityCompact` **可以重叠**（各要几十秒）。
 * 单槽 ⇒ 后写覆盖先写 ⇒ 先跑的那次在 `compaction/end` 上认领到**别人的**来源。
 *
 * ★ 为什么要 `pop` 而不是 `get+delete`：`get+delete` 永远取队首，
 *   而**票数必须与 `end` 数一致**才能一一对上。所以失败路径要把票退掉。
 */

export function pushHfSource(state, sid, source) {
  try {
    const q = state.hfSource.get(String(sid)) ?? [];
    q.push(source === undefined ? "auto" : source);
    state.hfSource.set(String(sid), q);
  } catch {
    /* 记来源失败绝不影响压缩本身 */
  }
}

/**
 * ★★★★★ 2026-10-15（D215）：**看一眼队首但不出队**（"这次压缩是不是我们发起的"）。
 *
 * ★ 为什么要它：`popHfSource` 会**真的取走**那张票 —— 而 `compaction/start` 那条路
 *   只需**判断**要不要补抓胶囊，绝不能顺手把票消费掉（消费了，
 *   后面 `compaction/end` 就认不出这一趟的来源 ⇒ L0 会写成「内核（官方）」，
 *   而那恰恰是本项目反复栽过的「同一个事实两个出口」）。
 *   ⇒ **看（peek）与取（pop）必须分开**。
 */

export function peekHfSource(state, sid) {
  try {
    const q = state.hfSource.get(String(sid));
    if (q === undefined || q.length === 0) return undefined;
    return q[0];
  } catch {
    return undefined;
  }
}

/** 取走队首（`compaction/end` 时调用）。队空返回 `undefined`（= 不是我们发起的，例如内核 80%）。 */

export function popHfSource(state, sid) {
  try {
    const q = state.hfSource.get(String(sid));
    if (q === undefined || q.length === 0) return undefined;
    const src = q.shift();
    if (q.length === 0) state.hfSource.delete(String(sid));
    return src;
  } catch {
    return undefined;
  }
}

/** 撤销**最后一次**入队（失败路径用）：`compactNow` 没跑成 ⇒ 那次不会有 `compaction/end`。 */

export function popHfSourceLast(state, sid) {
  try {
    const q = state.hfSource.get(String(sid));
    if (q === undefined || q.length === 0) return;
    q.pop();
    if (q.length === 0) state.hfSource.delete(String(sid));
  } catch {
    /* 退票失败也无害 */
  }
}

/**
 * 算台账内容的稳定指纹（用于"没变就不重注"）。
 *
 * ★★★ 2026-10-12（D132）**从"便宜指纹"改成"内容感知指纹"**（用户底线内的一条纯赚改动）。
 *
 * **病**（真机实测，`_acc018-cr.mjs`，本会话最近 6 小时 37 条注入）：
 *   旧指纹是 `路径|行数|mtime` —— 而 `mtime` **只要文件被碰过就变**：
 *   · 插件自己追加一行「变更登记」⇒ mtime 变 ⇒ **整份台账（约 17K 字符）重注一遍**；
 *   · 实测：3/36 对注入 **正文字节完全相同**，却因为是新 mtime 而**又注了一遍**
 *     （合计 **58K 字符 = 零信息**）。
 *   ⇒ ★ 直接后果：**水位被无意义地推高 ⇒ 压缩更频繁 ⇒ 缓存反复打冷**。
 *
 * **修法（为什么它不伤准确性 —— 这是用户的硬底线）**：
 *   · 只在**字节完全相同**时才跳过 ⇒ 内容真变了**照旧注全文**，
 *     所以模型手里**永远有完整的台账**（不像"只注变更段"，那会让它手里没有全文）。
 *   · 判据取**正文字节**（`utf8` 内容本身），不取 mtime、不取行数。
 *   ★ 代价：每步读一次台账文件算哈希。台账 ≤ 350 行（约 17K 字符）⇒ 走内存里已有那一步即可，
 *     比"每步真注 17K"便宜得多（后者要占上下文，代价是 token，不是 CPU）。
 *   ★ 用 `activeLines` 仍留在指纹里：内容相同但行数不同不可能（同字节 ⇒ 同行数），
 *     留着只是让它可读、便于诊断 —— 不参与"是否重注"的判断。
 */

export function hashTextOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** 读盘失败时的单调递增计数（见 `fingerprintOf` 里的"每次都不等"）。 */