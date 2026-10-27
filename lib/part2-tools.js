/**
 * part2-tools.js —— 四个 `ledger_*` 工具的**定义体**（从 `part2.js` 原样搬出）
 *
 * ★ 为什么单独一个模块（D332）：`part2.js` 撞上了它自己 20 KB 的安全余量红线
 *   （241,272 B，距 241,664 只剩 **392 B**）。挑出来的是**最干净的一簇**：
 *   - 四个 `define*Tool` 合计 **约 36,000 B**
 *   - 它们在 `part2.js` 内部被引用 **0 次**（只有 `index.js` 调它们）
 *   - 依赖**全是函数声明** ⇒ 反向 import 安全、无 TDZ 风险
 *
 * ★★ **调用面一个字都没改**：`part2.js` 原位留了
 *   `export { defineGoalsTool, … } from "./part2-tools.js"`
 *   ⇒ `index.js` 仍从 `./part2.js` import，行为完全不变。
 *
 * ★★★ **实现体是逐字节搬过来的**，没有重写、没有"顺手优化"。
 *   （判据：搬之前用 `origText.includes(body)` 逐段校验过。）
 *
 * ★ 关于循环依赖（这里**是**双向的，但合法）：
 *   `part2-tools` → import `part2`（拿 inspect / renderGoalTree 等实现）
 *   `part2`       → export…from `part2-tools`（转发四个 tool）
 *   ESM 允许这种环，**前提是顶层不求值**。已实测确认：四个 tool 体内没有 IIFE、
 *   没有顶层 await、没有顶层 new；依赖里 const/let 为 **0 个**（全是函数声明，提升）。
 *   ⇒ 调用发生在模块求值完成之后，拿到的永远是真身。
 *
 * ★★★ 依赖清单是**求交集**得来的（不是静态扫英文散文猜的）：
 *   "实现体里出现的标识符" ∩ "part2 的符号表" ⇒ 44 个，一个不多一个不少。
 *   走这条路是因为：静态扫自由标识符会把工具描述里的 This / You / Never 全当符号，
 *   一次报出 **284 个假阳性**（真缺的只有 8 个）。★ 判据：**能求交集就别猜**。
 */
import path from "node:path";

// ── 项目内模块 ─────────────────────────────────────────────────────────────────
//   ★ `./part2.js` 是**反向**依赖：本模块用它提供的实现（inspect / renderGoalTree …）
//   ★ 这构成了一个 ESM 循环（part2 ↔ part2-tools），**合法**且已实测：
//     四个 tool 体内没有顶层求值，且这些依赖全是**函数声明**（提升）⇒ 调用时才解析。
import { buildGoalTree, goalAgeOf, goalStampMs, goalTimeScope, goalWeightBasis, idPrefixOfType, inspect, kindsOfType, parseGoalCards, parseLessonEntries, proposePrinciple, recordGoalsChange, registerGoalsInManifest, renderGoalCard, renderGoalTree, renderLessonEntry, upsertGoalCard } from "./part2.js";
import {
  countLines,
  fail,
  isUnderReal,
  memoryBaseOf,
  readTextSafe,
  refuseIfMemoryRootUnsafe,
  stamp,
  writeFileAtomic,
} from "./base.js";
import {
  AUDIT_KIND_LESSONS,
  DEFAULT_GOALS_NAME,
  EXPERIENCE_KINDS,
  GOAL_STATUSES,
  GOAL_STATUS_LABEL,
  LESSON_KINDS,
  LESSON_TYPES,
  OK_SCHEMA,
  PRINCIPLE_AUTH_TTL_MS,
  PRINCIPLE_GRANT_TOOL,
  ROOT_PARAM,
  name,
} from "./defs.js";
import { bumpRevision, sessionTag } from "./part1.js";
import { renderResult, rootFromExec } from "./part3.js";
import {
  appendAudit,
  cardModeOf,
  isSafeCardKey,
  readKindRaw,
  removeKindCard,
  writeKindCard,
} from "./part4.js";

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
      // ★★★ 2026-10-23（D316 · GAP-01）：`list` 是只读（照旧放行），其余 op 会写卡片 ⇒ 记忆根越界必须拒。
      if (String(args?.op ?? "") !== "list") {
        const unsafeMem = refuseIfMemoryRootUnsafe(info, ["lessonsDir", "lessons"]);
        if (unsafeMem !== undefined) return unsafeMem;
      }
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
          relPath: lcard ? lmode.dirRel : rel,
          mode: lcard ? "card" : "file",
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
      if (abs !== undefined && !isUnderReal(memBaseL, abs).ok) return { ok: false, reason: "ledger_lessons: 目标逃出了项目根", path: abs, unsafePath: true };
      const body0 = readKindRaw(root, info, "lessons").raw;
      const existing = parseLessonEntries(body0);

      const recordLessonAudit = (relOut, linesOut) => {
        let rev;
        try {
          rev = bumpRevision(root);
        } catch {
          rev = undefined;
        }
        if (info.logRel !== undefined) {
          try {
            appendAudit(root, info, {
              kind: AUDIT_KIND_LESSONS,
              tag: sessionTag(exec?.agent),
              target: "lessons",
              mode: op,
              relPath: relOut,
              lines: linesOut,
              revision: rev,
              sessionId: String(exec?.agent?.session?.header?.id ?? ""),
            });
          } catch {
            /* 审计失败不阻断教训写入 */
          }
        }
        return rev;
      };

      if (op === "rm") {
        const id = typeof args?.id === "string" ? args.id.trim() : "";
        if (id === "") return { ok: false, reason: "rm 需要一个 id（形如 L1 或 E2）。" };
        if (!existing.some((e) => e.id === id)) return { ok: false, reason: `没有这条：${id}` };
        // ★ D203：卡片模式 ⇒ 删那个小文件（不再从大文件里"挖段"）。
        const rmc = removeKindCard(root, info, "lessons", id);
        if (rmc !== null) {
          if (rmc.removed !== true) return { ok: false, reason: `没找到卡片文件：${id}` };
          const rev = recordLessonAudit(rmc.dirRel, Math.max(0, existing.length - 1));
          return { ok: true, removed: id, mode: "card", relPath: rmc.dirRel, ...(rev === undefined ? {} : { revision: rev }) };
        }
        const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // ★ 类型词也要认两种（`经验`/`教训`）—— 否则删经验条目会定位不到。
        const re = new RegExp(
          `(^|\\n)##\\s*(?:经验|教训)\\s+${esc}\\s*(?:[·|][^\\n]*)?\\n[\\s\\S]*?(?=\\n##\\s*(?:经验|教训)\\s|$)`
        );
        const m = re.exec(body0);
        if (m === null) return { ok: false, reason: `没能在文件里定位「${id}」那段（一个字节都没删）。` };
        const next = (body0.slice(0, m.index) + (m[1] ?? "") + body0.slice(m.index + m[0].length)).replace(/\n{3,}/g, "\n\n");
        const _w = writeFileAtomic(abs, next);
        if (_w.ok !== true) return { ok: false, path: abs, reason: String(_w.reason ?? "原子写失败") };
        const rev = recordLessonAudit(rel, countLines(next));
        return { ok: true, removed: id, relPath: rel, ...(rev === undefined ? {} : { revision: rev }) };
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
          const rev = recordLessonAudit(written.dirRel, existing.length + 1);
          return {
            ok: true,
            id: entry.id,
            type: entry.type,
            kind: entry.kind,
            mode: "card",
            relPath: written.dirRel,
            path: written.path,
            count: existing.length + 1,
            ...(rev === undefined ? {} : { revision: rev }),
          };
        }
        const next = head + block;
      const _w = writeFileAtomic(abs, next);
      if (_w.ok !== true) return { ok: false, path: abs, reason: String(_w.reason ?? "原子写失败") };
        const rev = recordLessonAudit(rel, countLines(next));
        return {
          ok: true,
          id: entry.id,
          type: entry.type,
          kind: entry.kind,
          relPath: rel,
          count: existing.length + 1,
          ...(rev === undefined ? {} : { revision: rev }),
        };
      }

      return { ok: false, reason: `不认识的 op：${op}（用 list / add / rm）` };
    },
  };
}

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
      // ★★★ 2026-10-23（D316 · GAP-01）：`tree` 是只读（照旧放行），其余 op 会写卡片 ⇒ 记忆根越界必须拒。
      if (String(args?.op ?? "") !== "tree") {
        const unsafeMem = refuseIfMemoryRootUnsafe(info, ["goalsDir", "goals"]);
        if (unsafeMem !== undefined) return unsafeMem;
      }
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
      const id = typeof args?.id === "string" ? args.id.trim() : "";
      if (id === "") return { ok: false, reason: `${op} 需要一个 id（形如 g1）。` };
      if (!/^[A-Za-z0-9._-]+$/.test(id) || !isSafeCardKey(id)) {
        return { ok: false, reason: `id 不合法或为保留名（只允许字母数字与 . _ -，不能是 INDEX/README/.. 或以 .md 结尾；收到：${id}）—— 它是结构键，不当作正文。` };
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
          const rev = recordGoalsChange(root, info, { op, id, tag, relPath: dropped.dirRel, lines: Math.max(0, cards.length - 1), sessionId: String(exec?.agent?.session?.header?.id ?? "") });
          return { ok: true, removed: id, mode: "card", relPath: dropped.dirRel, ...(rev === undefined ? {} : { revision: rev }) };
        }
        const mBaseG = memoryBaseOf(info, root);
        const abs = path.resolve(mBaseG, targetRel);
        if (!isUnderReal(mBaseG, abs).ok) return { ok: false, reason: `目标文件路径逃出记忆根：${targetRel}` };
        const body = readTextSafe(abs) ?? "";
        const re = new RegExp(`(^|\\n)##\\s*目标\\s+${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:[·|][^\\n]*)?\\n[\\s\\S]*?(?=\\n##\\s*目标\\s|$)`);
        const m = re.exec(body);
        if (m === null) return { ok: false, reason: `没能在文件里定位「${id}」那段（一个字节都没删）。` };
        const next = (body.slice(0, m.index) + (m[1] ?? "") + body.slice(m.index + m[0].length)).replace(/\n{3,}/g, "\n\n");
    const _w = writeFileAtomic(abs, next);
    if (_w.ok !== true) return { ok: false, path: abs, reason: String(_w.reason ?? "原子写失败") };
        const rev = recordGoalsChange(root, info, { op, id, tag, relPath: targetRel, lines: countLines(next), sessionId: String(exec?.agent?.session?.header?.id ?? "") });
        return { ok: true, removed: id, relPath: targetRel, ...(rev === undefined ? {} : { revision: rev }) };
      }
      if (op === "lesson") {
        if (existing === undefined) return { ok: false, reason: `没有这张卡：${id}（先用 upsert 建它）` };
        const text = typeof args?.lesson === "string" ? args.lesson.trim() : "";
        if (text === "") return { ok: false, reason: "lesson 不能为空。" };
        const next = { ...existing, lessons: [...existing.lessons, text] };
        const r = putCard(next);
        if (r.ok !== true) return { ok: false, reason: r.reason ?? "写卡失败" };
        const rev = recordGoalsChange(root, info, { op, id, tag, relPath: r.relPath ?? r.dirRel, lines: r.lines ?? cards.length, sessionId: String(exec?.agent?.session?.header?.id ?? "") });
        return { ok: true, id, lessons: next.lessons.length, relPath: r.relPath ?? r.dirRel, mode: r.card === undefined ? "file" : "card", ...(rev === undefined ? {} : { revision: rev }) };
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
        const rev = recordGoalsChange(root, info, { op, id, tag, relPath: r.relPath ?? r.dirRel, lines: r.lines ?? cards.length, sessionId: String(exec?.agent?.session?.header?.id ?? "") });
        // ★ 完成时**主动提示**写教训 —— 那正是用户"以后不要踩"要的东西。
        return {
          ok: true,
          id,
          status: st,
          relPath: r.relPath ?? r.dirRel,
          mode: r.card === undefined ? "file" : "card",
          ...(rev === undefined ? {} : { revision: rev }),
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
        const trimmedParent = typeof rawParent === "string" ? rawParent.trim() : undefined;
        const parent =
          rawParent === undefined || rawParent === null
            ? (existing?.parent ?? null)
            : trimmedParent === "" || trimmedParent === "-" || trimmedParent === "无"
              ? null
              : String(rawParent).trim();
        // ★ 父必须存在（除非是树根）—— 不许把树接成孤儿，也不许形成自环或多跳祖先环。
        if (parent !== null) {
          const byId = new Map(cards.map((c) => [c.id, c]));
          if (!byId.has(parent)) {
            return {
              ok: false,
              reason: `parent=「${parent}」不存在 ⇒ 会变成挂不上树的孤儿。先用 upsert 建那张父卡，或用 parent:"-" 当树根。`,
            };
          }
          if (parent === id) return { ok: false, reason: "parent 不能是它自己。" };
          const visited = new Set([id]);
          let cur = parent;
          while (cur !== null && cur !== undefined) {
            if (visited.has(cur)) {
              return { ok: false, reason: `parent=「${parent}」会让目标树形成环路（${id} ⇄ ${parent}）—— 拒绝写入。` };
            }
            visited.add(cur);
            cur = byId.get(cur)?.parent ?? null;
          }
        }
        const st = String(args?.status ?? existing?.status ?? "active");
        if (!GOAL_STATUSES.includes(st)) {
          return { ok: false, reason: `status 必须是 ${GOAL_STATUSES.join(" / ")}（收到：${st}）` };
        }
        const kr = Array.isArray(args?.kr)
          ? args.kr.map((x) => String(x).trim()).filter((x) => x !== "")
          : [...(existing?.kr ?? [])];
        const lessons = [...(existing?.lessons ?? [])];
        if (typeof args?.lesson === "string" && args.lesson.trim() !== "") lessons.push(args.lesson.trim());
        const card = { id, parent, status: st, title: title === "" ? existing?.title ?? id : title, kr, lessons };
        const r = putCard(card);
        if (r.ok !== true) return { ok: false, reason: r.reason ?? "写卡失败" };
        if (!gcard && rel === undefined) {
          try {
            registerGoalsInManifest(root, info, targetRel);
          } catch {
            /* 登记失败不挡写入：文件写下去，下次 inspect 会按 guess 认到它 */
          }
        }
        const rev = recordGoalsChange(root, info, { op, id, tag, relPath: r.relPath ?? r.dirRel, lines: r.lines ?? (existing === undefined ? cards.length + 1 : cards.length), sessionId: String(exec?.agent?.session?.header?.id ?? "") });
        return { ok: true, id, created: r.created ?? existing === undefined, status: st, parent, relPath: r.relPath ?? r.dirRel, ...(r.lines === undefined ? {} : { lines: r.lines }), mode: r.card === undefined ? "file" : "card", ...(rev === undefined ? {} : { revision: rev }) };
      }

      return { ok: false, reason: `不认识的 op：${op}` };
    },
  };
}
