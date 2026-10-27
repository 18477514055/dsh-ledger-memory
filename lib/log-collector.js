/**
 * log-collector.js —— 活动日志采集器（L0–L4）
 *
 * ★★★ 2026-10-25（D323 · 005 报告 F-07）：**从 `part3.js` 整块搬出**。
 *   判据：`part3.js` 已到 258,991 B / 262,144 B（**剩 3,153 B**），与 `part2.js`
 *   同属"贴线"状态。报告只点了 part2，但"贴线"是**结构问题**，不是单点问题。
 *
 * ★ 为什么挑这一段：量尺（`tools/_measure-f07-e.mjs`）显示它是 part3 里
 *   **唯一「零本地依赖 + 万字节级」**的块 —— 它不调用 part3 的任何其他函数
 *   ⇒ 搬走**不会**造出 part3 ↔ 新模块的环。
 *
 * ★★ 搬家方式：**逐字复制，不重写**（正文与原 L1532–L1845 逐字相同）。
 * ★★ 调用面**零改动**：part3 原位置留 `export { createLogCollector } from "./log-collector.js";`。
 */
import fs from "node:fs";
import path from "node:path";
import { L0_KINDS, L3_EXCLUDE, LOG_BRIEF_CHARS, LOG_FLUSH_DEBOUNCE_MS, name } from "./defs.js";
import { numOf, tagOfId } from "./part1.js";
import { briefOf, ensureDir, fileOpsOf, git, gitAdd, inspect, isErrorResult, isUnder, isUnderReal, levelOn, logDirOf, logFileRel, memoryBaseOf, projectRootOf, refuseIfMemoryRootUnsafe, renderUserMessageLine, shouldAutoStage, stampSec, userMessageOf } from "./part2.js";

export function createLogCollector(ctx) {
  /** L3 要等 tool/result 才知道成败 ⇒ 先攒着。key = callId。 */
  const pendingCalls = new Map();
  /**
   * `commandId → 命令名`。
   *
   * ★★★ 为什么必须有这个（2026-10-10 实测发现）：`command/done` 的载荷是
   *   `{ commandId, kind, text?, sourceEventSeq? }` —— **没有 name**；
   *   命令名只在**另一条**事件 `command/run`（`{ commandId, name, args?, source }`）上。
   *   ⇒ 旧代码直接读 `d.name`，恒 undefined ⇒ **每条都记成 `命令 /?`**。
   * ★ 用 Map 而不是让 `L0_KINDS` 自己持有：格式化函数应当是**纯的**，
   *   状态留在采集器里（与 `pendingCalls` 同一个理由）。
   * ★ 有界：只保留最近 64 个 —— 一个会话不会同时在跑那么多命令，
   *   而无限增长等于慢性泄漏（这个采集器是**长期活着**的）。
   */
  const commandNames = new Map();
  /** 键（项目根 + 会话 id）→ { root, info, buffers:Map<fileRel,string[]> } */
  const buffers = new Map();
  /** 定时器句柄；有攒着的东西才存在。 */
  let timer;

  /** 记下命令名（有界，见 `commandNames` 的注释）。 */
  function rememberCommand(id, name) {
    if (typeof id !== "string" || id === "" || typeof name !== "string" || name === "") return;
    commandNames.set(id, name);
    if (commandNames.size > 64) {
      // 删最旧的那个（Map 保持插入序）。
      const oldest = commandNames.keys().next().value;
      if (oldest !== undefined) commandNames.delete(oldest);
    }
  }

  /**
   * 该会话的缓冲桶（惰性建）。
   *
   * ★★★ 2026-10-21（D298 · V3 迁移后真跑撞出的**第二个「地址两个出处」**）：
   *   桶里原来只记 `root`（**项目根**），而落盘时用
   *   `path.resolve(b.root, fileRel)` 解析 —— 可 `fileRel`（来自 `logFileRel`）
   *   **是相对记忆根 `memoryBase` 的**（`logFileRel` 早在 D289 就改成 V3 语义了）。
   *
   *   🔴 后果：V3 项目里**每一条日志都写回项目根**，而不是写进记忆子目录。
   *     实测：迁移完成后项目根**又长出** `_ledger-log/…/L2-files-003.md`，
   *     而且**重启也没用** —— 不是缓存问题，是**每一条日志都走这条路**。
   *     ★ 最恶劣的地方：`isUnder(b.root, abs)` 那道防御检查**通过了**
   *       （记忆子目录本来就在项目根下面），所以**没有任何报错**，
   *       看起来一切正常，只是日志悄悄分裂成两份。
   *
   *   ⇒ 修法：桶里**同时记下 `memBase`**，落盘按它解析；边界检查也对着它做。
   *     与插件本体同一条原则：**地址只有一个出处**（`memoryBaseOf`）。
   */
  function bucketFor(root, sid, memBase) {
    const key = `${root}\u0000${sid}`;
    let b = buffers.get(key);
    if (b === undefined) {
      b = { root, sid, memBase, lines: new Map() };
      buffers.set(key, b);
    } else if (typeof b.memBase !== "string" || b.memBase === "") {
      // 老桶补上（正常情况下不会走到）。
      b.memBase = memBase;
    }
    return b;
  }

  function push(b, fileRel, line) {
    if (fileRel === undefined || line === undefined || line === "") return;
    let arr = b.lines.get(fileRel);
    if (arr === undefined) {
      arr = [];
      b.lines.set(fileRel, arr);
    }
    arr.push(line);
  }

  function arm() {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      // 去抖落盘**不 stage**（理由见 flushAll 的 stage 说明）。
      flushAll(false);
    }, LOG_FLUSH_DEBOUNCE_MS);
    // ★ 别让这个定时器把进程钉住不退（node 的定时器默认会）。
    if (typeof timer.unref === "function") timer.unref();
  }

  /**
   * 把攒下的行真正追加到磁盘。全程吞错。
   *
   * @param {boolean} stage 是否顺带 `git add`。
   *   ★ 去抖那条路**不 stage**：默认 1.2 秒就可能冲一次，而每次 stage 都要
   *   spawn 一个 git 进程（几十毫秒）并重写 git index —— 一场 490 次调用的会话
   *   会白白拉起几百个 git。所以只在**回合末 / 卸载**这种真正收尾的时刻 stage。
   */
  function flushAll(stage, onlySid) {
    for (const [key, b] of [...buffers.entries()]) {
      if (onlySid !== undefined && b.sid !== onlySid) continue;
      try {
        const written = [];
        // ★★★ 2026-10-24（D317 · GPT 审查 002 的 F02）：**后台日志采集也要问同一道闸门。**
        //
        //   🔴 病：`memoryRoot` 越界时 `inspect()` 把 `memoryBase` 降级回 `projectRoot`，
        //     桶里记下的就是这个降级值 ⇒ 下面那条 `isUnderReal(base, abs)` **当然通过**
        //     （记忆子目录的名义位置在项目根下，而 base 就是项目根）
        //     ⇒ 日志在**源码根**长出 `_ledger-log/`，然后可能被 `git add` 带走。
        //   ★ 它比其它入口更隐蔽：这条路**没有调用方看回执**（后台采集），
        //     所以以前连"看起来像成功"都不需要 —— 它悄悄写，谁也不知道。
        //   ⇒ 判据：**越是"没有回执"的写路径，越必须用中央闸门挡**，否则它是最安全的漏点。
        const infoForGuard = inspect(b.root);
        const unsafeLog = refuseIfMemoryRootUnsafe(infoForGuard, ["logDir"]);
        if (unsafeLog !== undefined) {
          // 如实记一笔再丢弃这批（不写盘、不静默吞掉）
          try {
            ctx.logger?.warn?.(`${name}: 记忆根越界 ⇒ 日志这次一个字节都不写：${unsafeLog.reason}`);
          } catch { /* 连 logger 都没有就算了 */ }
          b.lines.clear();
          continue;
        }
        for (const [fileRel, lines] of b.lines.entries()) {
          if (lines.length === 0) continue;
          // ★★★ 2026-10-21（D298）：按**记忆根**解析，不是项目根 ——
          //   `fileRel` 是 `logFileRel` 给的，那个函数已经是 V3 语义（相对 memoryBase）。
          //   拿项目根去拼 ⇒ V3 项目里日志会全部写回项目根（且不报错）。
          const base = typeof b.memBase === "string" && b.memBase !== "" ? b.memBase : b.root;
          const abs = path.resolve(base, fileRel);
          // ★★★ 2026-10-23（D316 · NEW-01）：**必须 `.ok`**（对象恒真 ⇒ 漏写等于拆掉守卫）。
          if (!isUnderReal(base, abs).ok) continue; // 逃出记忆根 ⇒ 丢弃（防御式）
          ensureDir(path.dirname(abs));
          // ★ 纯追加：`flag: "a"`。绝不先读后写，那样会在并发下把别人的行覆盖掉。
          fs.appendFileSync(abs, lines.join("\n") + "\n", "utf8");
          written.push(fileRel);
        }
        b.lines.clear();
        // 日志与台账同一套 Git 规矩：只 add 明确路径（绝不 -A）。
        // ★ V3/D290：这条路的返回值**本来就丢弃**（后台采集，没有调用方看回执），
        //   所以不需要 `stageOutcomeOf`。★ 但它必须与另外三处**同一个闸门**（`gitAdd`），
        //   否则将来有人给这里加回执时会抄错写法。
        if (stage === true && written.length > 0) {
          const info = inspect(b.root);
          // ★★★★★ 2026-10-22（V3 §3.1）：**问中央判据，不再各自写条件。**
          //   旧写法 `info.manifest?.autoGitAdd !== false` 默认 true ⇒ V3 项目也会去 stage。
          if (shouldAutoStage(info).allow) {
            gitAdd(b.root, written);
          }
        }
      } catch (e) {
        try {
          ctx.logger?.warn?.(`${name}: 日志落盘失败已忽略：${String((e && e.message) || e)}`);
        } catch {
          /* 连 logger 都没有就算了 */
        }
        // 落盘失败就丢掉这批，避免无限堆积（日志不值得为它撑爆内存）。
        b.lines.clear();
      }
      void key;
    }
  }

  /** 把当前攒着的全部落盘（回合末 / 销毁时调用）。这里才 stage。 */
  function flushNow() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    flushAll(true);
  }

  /**
   * 消费一条会话事件。
   *
   * @param {string} root 项目根（调用方已解析好）
   * @param {string} sid  会话 id
   * @param {object} event 官方落盘事件
   * @param {object} [extra] 采集器需要但**事件里没有**的东西（目前只有 `hfSource`）
   */
  function consume(root, sid, event, extra) {
    const info = inspect(root);
    if (logDirOf(info) === undefined) return; // 这个项目没启用日志
    const type = event?.type;
    if (typeof type !== "string") return;
    const now = new Date();
    // ★★★ D298：把**记忆根**一并交给桶 —— 落盘时按它解析（`logFileRel` 是相对它的）。
    const b = bucketFor(root, sid, memoryBaseOf(info, root));

    // ── 命令名缓存：`command/run` 带 name，`command/done` 只有 commandId ──
    //   ★ 顺序上 run 一定在 done 之前，所以在 done 之前收下就够了。
    if (type === "command/run") {
      rememberCommand(event.data?.commandId, event.data?.name);
    }

    // ── L0 里程碑 ─────────────────────────────────────────────────────────
    const l0 = L0_KINDS[type];
    if (l0 !== undefined && levelOn(info, "L0")) {
      push(
        b,
        logFileRel(info, "L0", now),
        `- ${stampSec(now)} (${type}) ${l0(event.data, { ...extra, commandNames })}`
      );
    }

    // ── L4 用户消息存档（用户需求：自动记住用户发的所有消息）─────────────
    //
    // ★ 为什么在这里（`session/event`）而不是别处：这是**唯一**一条
    //   "用户说了什么"必然经过的路，而且是官方自己落盘用的那条（见文件头 ⑦）。
    //   所以它不花 token、不靠 AI 记得、也不会漏 —— 用户要的正是"**自动**记住"。
    //
    // ★ 为什么**不注入上下文**：用户明确要求了。注入的话每轮都要把历史消息
    //   再抄一遍进 prompt，那是纯亏（钱与本就不宽裕的窗口）。它只在
    //   `ledger_log`（view "users"）里按需读切片 —— 与 L0–L3 同一套规矩。
    if (type === "user/message" && levelOn(info, "L4")) {
      const um = userMessageOf(event);
      if (um !== undefined) {
        push(
          b,
          logFileRel(info, "L4", um.when),
          renderUserMessageLine(um.content, tagOfId(sid), um.when)
        );
      }
    }

    // ── L3：tool/call 先攒着（成败要等 tool/result）───────────────────────
    if (type === "tool/call") {
      const d = event.data ?? {};
      const callId = d.callId ?? d.toolCallId;
      const toolName = typeof d.name === "string" ? d.name : "?";
      if (typeof callId === "string" && callId !== "" && !L3_EXCLUDE.has(toolName)) {
        pendingCalls.set(callId, {
          at: stampSec(now),
          turn: d.turn,
          step: d.step,
          toolName,
          args: d.arguments,
          // ★ 记下会话：`forget(sid)` 要靠它清理。漏了这一步，会话销毁后
          //   这些待配对项会永远留在内存里（因为只有 tool/result 才会删）。
          sid: String(sid),
        });
        // 上限兜底：配对不上 result 的调用（进程被杀、工具崩了）不该无限堆积。
        if (pendingCalls.size > 5000) {
          const first = pendingCalls.keys().next();
          if (first.done !== true) pendingCalls.delete(first.value);
        }
      }
      // ── L2：文件流水 ───────────────────────────────────────────────────
      if (levelOn(info, "L2")) {
        const { touched, read } = fileOpsOf(toolName, d.arguments);
        for (const { path: p, op } of touched) {
          push(b, logFileRel(info, "L2", now), `- ${stampSec(now)} (${op}) ${p}  [${toolName}]`);
        }
        for (const { path: p, op } of read) {
          push(b, logFileRel(info, "L2", now), `- ${stampSec(now)} (${op}) ${p}  [${toolName}]`);
        }
      }
      arm();
      return;
    }

    // ── L3：tool/result 补上成败，这时才写行 ──────────────────────────────
    if (type === "tool/result") {
      const d = event.data ?? {};
      const callId = d.callId ?? d.toolCallId ?? d.message?.toolCallId;
      const pending = typeof callId === "string" ? pendingCalls.get(callId) : undefined;
      if (pending !== undefined) {
        pendingCalls.delete(callId);
        if (levelOn(info, "L3")) {
          const bad = isErrorResult(event) ? " [失败]" : "";
          const brief = briefOf(pending.toolName, pending.args, numOf("logBriefChars", LOG_BRIEF_CHARS));
          push(
            b,
            logFileRel(info, "L3", now),
            `- ${pending.at} (tool) t${pending.turn ?? "?"}/s${pending.step ?? "?"} ` +
              `${pending.toolName}${bad}${brief === "" ? "" : ` — ${brief}`}`
          );
        }
        arm();
      }
      return;
    }

    // 其余事件对日志没有直接贡献；L1 由 AI 通过 ledger_log_write 写。
    if (b.lines.size > 0) arm();
  }

  /** 会话销毁：清掉该会话的待办与缓冲（先把能落的落了）。 */
  function forget(sid) {
    for (const [callId, p] of [...pendingCalls.entries()]) {
      // 只有 callId 里带得出会话的才删得掉；拿不准就留着让它自然被上限清掉。
      if (p.sid === sid) pendingCalls.delete(callId);
    }
    flushAll(true, sid);
    for (const [key, b] of [...buffers.entries()]) {
      if (b.sid === sid) {
        buffers.delete(key);
      }
    }
  }

  return { consume, flushNow, forget, _buffers: buffers, _pending: pendingCalls };
}

// ═══════════════════════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 所有写入/读取类工具共用的参数：**显式指定项目根**。
 *
 * ★ 为什么必须有它：本插件的项目根取 `session.header.cwd`（`projectRootOf`）。但用户
 *   经常**从容器工作区开着会话**（如一个汇总工作区），真实项目在它的子目录里。
 *   没有这个参数，那种会话里**任何**台账工具都只能指向容器根 —— 而容器根恰恰是
 *   禁止初始化的那个目录，于是整个插件对它最主要的那些项目**全都不可用**
 *   （2026-10-08 实测撞上：回合末卡片让 AI 写台账，AI 却无处可写）。
 *
 * ★ 它**不绕过**容器闸门：`ledger_init` 仍会对"传进来的这个根是不是容器"再判一次。
 *   显式指定根只回答"哪个目录"，不回答"该不该在这里初始化"。
 */

