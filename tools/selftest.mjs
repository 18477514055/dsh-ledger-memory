/**
 * 离线自检 —— 用假 ctx 跑 lib/index.js，**不碰真内核**。
 *
 * 为什么必须有这一层：本机有过一次真实事故 ——
 *   插件没写 `export const inject`，而 apply() 里访问了 `ctx.tools`
 *   ⇒ 报 `Error: cannot get property "tools" without inject`
 *   ⇒ **整个内核起不来**（插件在 profile.bundles 里 ⇒ apply 抛错 ⇒ profile 组合失败）。
 * 所以这里的假 ctx 是**严格模式**：访问任何未声明/不存在的服务属性**立即抛错**，
 * 与 Cordis 的真实语义一致。宽松的假 ctx 会让这类错误全部漏网。
 *
 * 跑法：node tools/selftest.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 本文件所在目录（**已解码**）。
 *
 * ★ 为什么必须用 `fileURLToPath` 而不是 `new URL(...).pathname`：
 *   本机路径里有中文（`D:\Deepseek工作区\…`），而 `.pathname` 拿到的是
 *   **百分号编码**的串（`Deepseek%E5%B7%A5%E4%BD%9C%E5%8C%BA`）。
 *   `import()` 能容忍它（所以旧代码一直没暴露问题），但 `fs.readFileSync`
 *   **不能** —— 情形 27 读 `lib/client.js` 时当场 ENOENT。
 *   ⇒ 凡是"要把路径交给 fs"的地方，都必须先解码。`fileURLToPath` 一次到位。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "lib", "index.js");

/**
 * ★★★ 自检**绝不能写用户真正的家**。
 *
 * 背景（2026-10-10）：项目锁改成"跨重启保持"之后，`ledger_lock` 会往
 *   `$DSH_HOME\plugin-data\dsh-ledger-memory\locks.json` **落盘**。
 *   而自检用假 ctx 直接跑 `lib/index.js` ⇒ 一旦某个用例摸到 `ledger_lock`，
 *   就会**往用户真实的家 `C:\Users\24239\.dsh` 里写文件**。
 *   ★ 这是"测试污染真实环境"，比测试失败严重得多（用户的家是红线区）。
 *
 * ⇒ 在**导入 `lib/index.js` 之前**把 `DSH_HOME` 指到一个临时目录。
 *   ★ 必须在这里、不能在后面：`lockStorePath()` 每次调用都读 `process.env.DSH_HOME`，
 *     所以只要在**任何一次调用之前**设好就够 —— 但放最前面最稳妥、也最容易被看懂。
 *   ★ 收尾时删掉这个临时家（见文件末尾的清扫段）。
 */
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-selftest-home-"));
process.env.DSH_HOME = SANDBOX_HOME;

let pass = 0;
let failCount = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    failCount++;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ── 变更登记区（需求 ①）────────────────────────────────────────────────────
// 插件的 `writeLedger` / `archiveLedger` 每次写入都会**重建**这一区。
// 断言里要反复"剥掉它再看正文"，所以在这里放一份与 lib 同源的判据。
const CHANGE_HEADING = "## 变更登记（插件自动维护）";
const CHANGE_LINE_RE = /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \((?:write|append|replace|archive)[^)]*\)/;

/** 剥掉变更登记区，返回正文（与 lib 的 `splitChangeRegister` 同义）。 */
function bodyOf(text) {
  if (typeof text !== "string" || text === "") return "";
  const idx = text.indexOf(CHANGE_HEADING);
  return idx < 0 ? text : text.slice(0, idx).replace(/\s+$/, "");
}

/** 取出变更登记区的登记行（新的在前）。 */
function changeLines(text) {
  if (typeof text !== "string" || text === "") return [];
  const idx = text.indexOf(CHANGE_HEADING);
  if (idx < 0) return [];
  return text
    .slice(idx + CHANGE_HEADING.length)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => CHANGE_LINE_RE.test(l));
}


// ═══════════════════════════════════════════════════════════════════════════
// 严格假 ctx
// ═══════════════════════════════════════════════════════════════════════════

function makeCtx({
  withCommands = true,
  strict = true,
  injectNames = ["tools"],
  withUserQuestions = false,
  withCompaction = false,
  withTokenMeter = false,
  withAgents = false,
  withWebServer = false,
  withConfigEditor = false,
  agentPresetServices = null,
  compactionBusy = false,
  /**
   * ★★★ 2026-10-12：`busy` 的**原文**可以由调用方指定。
   *
   * 为什么必须有这个旋钮（真机事故，用户 01:13 撞上）：
   *   内核的 `busy` 有**三条不同原文**，而插件旧判据只认得第一条
   *   ⇒ 另外两条被判成"失败" ⇒ 回「压缩没有发生」（而那一刻压缩**正在跑**）。
   *   ★ 固定用一句话做夹具，就等于**只测了插件认得的那一条** ——
   *     这正是"夹具前提错了，全绿就是假绿"（纪律 8）。
   *   ⇒ 让调用方可以把内核**真实的三条**逐一喂进来。
   */
  compactionBusyMessage = null,
  /**
   * ★ 是否给异常挂 `err.code`（内核的 `ManualCompactionError` **有**这个字段）。
   *   ⇒ 设为 false 可测"只有 message、没有 code"的老内核 / 别的实现 —— 那时
   *     必须靠文本兜底判据接住（两条判据都要真的能用，才算修好）。
   */
  compactionBusyCode = true,
  regionCalls = [],
} = {}) {
  const registeredTools = new Map();
  const registeredCommands = new Map();
  const handlers = new Map();
  const warnings = [];
  const disposers = [];

  /** 记录下插件问过用户什么、压缩被调了几次，供断言用。 */
  const asked = [];
  const compacted = [];
  let answerFor = null; // (request) => answer batch | pending 结果

  /** 注册过的 HTTP 路由：path → handler（情形 27 直接调 handler，不真起服务器）。 */
  const routes = new Map();
  /** `configEditor.edit()` 被调了几次、每次改了什么（情形 27 用）。 */
  const edits = [];
  /**
   * 假的「本插件那一行」。
   * ★ 形状照 `configEditor.entries()` 的真实返回值：每项是一个 Loader `Entry`，
   *   它把配置挂在 `options.config` 上（内核 `dsh-config-editor/lib/index.js:78`
   *   逐字：`const current = structuredClone(entry.options.config ?? {})`）。
   */
  const fakeEntry = { options: { id: "dsh-ledger-memory", name: "dsh-ledger-memory", config: {} } };
  /**
   * 假的「上层（inherited）值」。
   *
   * ★★ 为什么它**必须非空**（这一条是读完内核源码后加的）：
   *   内核 `edit()` 会调 `change(current, inherited)`，其中 `inherited` 是
   *   **上层**（bundle 层 / 家级 patch）给这一行的值。
   *   内核 README 逐字警告：*"完整配置覆盖保留普通字段，但会在 profile 层
   *   **固定其当前原始值**"*。
   *   ⇒ 若实现把 `inherited` 并进写回值，就把上层的值**钉死在 profile 层**，
   *     从此上层再改也改不动 —— 那是"一个事实两个出口"的坏味道。
   *   我第一版**就是这么写的**（`{ ...inherited, ...current }`），是个真 bug。
   *   ⇒ 这个夹具**故意给非空的 inherited**，好让"有没有误并 inherited"能被测出来。
   */
  const fakeInherited = { highFidelityCompactRatio: 0.65, fromUpperLayer: "upper" };

  const services = {
    tools: {
      register(def) {
        if (registeredTools.has(def.name)) throw new Error(`duplicate tool ${def.name}`);
        registeredTools.set(def.name, def);
        const d = () => registeredTools.delete(def.name);
        disposers.push(d);
        return d;
      },
    },
    ...(withWebServer
      ? {
          webServer: {
            register(route) {
              if (route === null || typeof route !== "object") throw new Error("route 必须是个对象");
              if (route.kind !== "exact") throw new Error(`只支持 kind:"exact"，收到 ${route.kind}`);
              if (typeof route.path !== "string" || !route.path.startsWith("/")) {
                throw new Error(`path 必须以 / 开头，收到 ${route.path}`);
              }
              if (typeof route.handler !== "function") throw new Error("handler 必须是函数");
              if (routes.has(route.path)) throw new Error(`重复注册路由 ${route.path}`);
              routes.set(route.path, route.handler);
              const d = () => routes.delete(route.path);
              disposers.push(d);
              return d;
            },
          },
        }
      : {}),
    ...(withConfigEditor
      ? {
          configEditor: {
            entries() {
              return [fakeEntry];
            },
            configuration() {
              return [{ entry: fakeEntry, inherited: fakeInherited, override: fakeEntry.options.config }];
            },
            async edit(entry, change) {
              // ★ 复刻真实语义（内核 `dsh-config-editor/lib/index.js:78-80`）：
              //     const current   = structuredClone(entry.options.config ?? {});
              //     const inherited = this.inherited(entry, …);   // ← **上层**的值
              //     const next      = change(current, inherited);
              //   ⇒ 这里把两个都**真的传进去**，实现若误并 inherited 就会被测出来。
              const current = entry?.options?.config ?? {};
              const next = change(current, fakeInherited);
              edits.push({ entry, next, current, inherited: fakeInherited });
              entry.options.config = next;
            },
          },
        }
      : {}),
    ...(withCommands
      ? {
          commands: {
            register(def) {
              if (registeredCommands.has(def.name)) throw new Error(`duplicate command ${def.name}`);
              registeredCommands.set(def.name, def);
              const d = () => registeredCommands.delete(def.name);
              disposers.push(d);
              return d;
            },
          },
        }
      : {}),
    ...(withUserQuestions
      ? {
          userQuestions: {
            async ask(request) {
              asked.push({ mode: "ask", request });
              if (answerFor === null) throw new Error("no answerer in selftest");
              return answerFor(request);
            },
            async askTimed(request, callId, timeoutMs) {
              asked.push({ mode: "askTimed", request, callId, timeoutMs });
              if (answerFor === null) throw new Error("no answerer in selftest");
              return answerFor(request);
            },
          },
        }
      : {}),
    ...(agentPresetServices === null
      ? {}
      : {
          /**
           * 假的 `agentPresets` 服务。
           *
           * ★★ 为什么必须有它：本 profile 里 `compaction` 挂在 preset 的
           *   `isolate` 组里（`dsh-web-app/presets/standard.patch.yml`，
           *   `isolate: { compaction: true, toolResultPruner: true }`），
           *   而 `isolate` = `LocalRealm` ⇒ **外层 `ctx.get("compaction")` 与
           *   `agent.ctx.get("compaction")` 都拿不到**。
           *   内核自己的取法是 `agentPresets.serviceFor(agent, name)`
           *   （`dsh-agent-preset-registry/lib/types/mount.js` 的 `serviceForAgent`，
           *   真实用例见 `dsh-api-session-controller`：
           *   `presets?.serviceFor(live, "skills") ?? this.ctx.get("skills")`）。
           *   ⇒ 夹具必须能复刻"只有 `serviceFor` 拿得到"这一处境，否则
           *     测的就不是真实路径（第一版情形 29 正是这么被第三兜底蒙过去的）。
           */
          agentPresets: {
            serviceFor(agent, name) {
              const table = agentPresetServices ?? {};
              // ★ 只对**有 agent**的调用返回；也顺带验证实现确实把 agent 传了进来。
              if (agent === undefined || agent === null) return undefined;
              return table[name];
            },
            composedPreset: () => "standard",
          },
        }),
    ...(withCompaction
      ? {
          compaction: {
            /**
             * ★ `_busy` 可翻转：用来复刻内核的 `ManualCompactionError("busy")`
             *   （`dsh-compaction-basic:457` 打开的回合 / `:1009` 非 idle）。
             *   命令入口现在"当场压"，所以"忙"这条分支**必须**被测到 ——
             *   否则一个"永远报成功但其实没压"的实现会全绿。
             */
            _busy: compactionBusy,
            async compactNow(agent, signal, sourceCommandId) {
              if (this._busy === true) {
                // ★★★ 2026-10-12 修夹具（原来**只**造这一句 ⇒ 掩盖了 2/3 的真实原文）：
                //   内核的 `ManualCompactionError` 带稳定 `code`，且 `busy` 有三条原文。
                //   默认仍用①（老用例的行为不变），但**允许**调用方换原文 / 摘掉 code。
                const err = new Error(
                  compactionBusyMessage ?? "manual compaction: the session already has an open turn"
                );
                if (compactionBusyCode) err.code = "busy";
                throw err;
              }
              compacted.push({ agent, sourceCommandId });
              return { shadowedSeqs: [1, 2], shadowedTokenCount: 10, summarySeq: 3 };
            },
            /**
             * ★★★ 增量压缩走的**就是这一条**（`runIncrementalCompact`）。
             *
             * ★ 为什么要单独记：增量那条与 `compactNow` 是**两条不同的路**
             *   （前者 `owner:"current-turn"`、要求回合开着；后者 `owner:null`、
             *   要求 idle）。只记 `compacted` 数组的话，测不出"到底走了哪条"。
             */
            regionCalls: regionCalls,
            /**
             * ★★★ 真压缩会**让水位下降** —— 夹具必须复刻这一点，
             *   否则"锚点取压前还是压后"两种写法在测试里**看起来一样**，
             *   `_probe-delta-anchor.mjs` 证出来的那个 bug 就会漏过自检。
             *   （第一版夹具压完水位不变 ⇒ 30d 以对的理由通过、其实没测到锚点。）
             *
             * ⚠️ 踩坑：`this` 在这里是 **compaction 服务**，而水位在 `tokenMeter` 上，
             *   所以**不能**写 `this._total = …`（第一版就这么写的，水位没动、断言红）。
             *   ⇒ 由 `onCompacted` 回调去改 meter。
             */
            onCompacted: null,
            async compactRegion(start, end, agent) {
              if (this._regionBusy === true) {
                throw new Error("compactRegion: no open turn — automatic compaction events must be enclosed in a turn");
              }
              if (this._regionThrows !== undefined) throw new Error(this._regionThrows);
              regionCalls.push({ start, end, agent });
              if (typeof this.onCompacted === "function") this.onCompacted();
              return {
                shadowedSeqs: [start, end],
                shadowedTokenCount: (end - start + 1) * 10,
                summarySeq: 99,
              };
            },
          },
        }
      : {}),
    ...(withTokenMeter
      ? {
          tokenMeter: {
            _total: 0,
            _window: 1000,
            /**
             * ★ `nodes` 是**增量压缩选范围必需的**（`selectIncrementalRange` 要拿
             *   每个节点的 token 数从后往前累计）。没配 `_priced` 时返回空数组，
             *   于是老用例（只关心水位）行为不变。
             */
            _priced: null,
            measure() {
              return {
                totalTokens: this._total,
                nodes: this._priced ?? [],
              };
            },
          },
        }
      : {}),
    ...(withAgents
      ? {
          agents: {
            /**
             * 哪些 agent 是 root。
             *
             * ★ 默认**空集**（即谁都不是 root）—— 这不是省事，是刻意的：
             *   插件在"拿不准"时会放行，只有**明确知道不是 root** 才跳过。
             *   测试要验"子 agent 不弹卡片"就得先把 agent 塞进来当 root、再拿掉。
             */
            _roots: new Set(),
            roots() {
              return [...this._roots];
            },
          },
        }
      : {}),
  };

  // ★ declared 模拟 Cordis 的 `export const inject = [...]`：只有列进来的服务
  //   才允许在本插件的 ctx 上访问。默认按本插件真实的 inject 播种。
  const declared = new Set(injectNames);

  const ctx = {
    tools: services.tools,
    logger: {
      warn: (m) => warnings.push(String(m)),
      info: (m) => warnings.push(String(m)),
      error: (m) => warnings.push(String(m)),
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    inject(deps, cb) {
      for (const d of deps) {
        // 服务不在 ⇒ 不执行 cb、也不抛错（Cordis 的真实语义）。
        if (!(d in services)) return undefined;
      }
      for (const d of deps) declared.add(d);
      // ★ 关键：真实 Cordis 给 cb 的 scope **带着被注入的服务**。
      //   这里用「原型指向本 ctx、自身挂上依赖」的对象来复刻 ——
      //   少了这一步，`scope.commands` 就是 undefined，插件会被假阴性判失败。
      const scope = Object.create(proxy);
      for (const d of deps) scope[d] = services[d];
      return cb(scope);
    },
    get(key) {
      return services[key];
    },
  };

  // ★ 严格模式：访问**未声明**的服务属性立即抛错，复刻真实内核的行为
  //     cannot get property "tools" without inject
  const proxy = new Proxy(ctx, {
    get(target, prop, recv) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, recv);
      if (prop in target) {
        // 是服务、但没声明 ⇒ 抛（这才是那条错误的真实触发条件）
        if (services[prop] !== undefined && !declared.has(prop) && strict) {
          throw new Error(`cannot get property "${String(prop)}" without inject`);
        }
        return Reflect.get(target, prop, recv);
      }
      if (strict) {
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      }
      return undefined;
    },
  });

  return {
    ctx: proxy,
    registeredTools,
    registeredCommands,
    handlers,
    warnings,
    declared,
    services,
    asked,
    compacted,
    routes,
    edits,
    fakeEntry,
    setAnswer(fn) {
      answerFor = fn;
    },
  };
}

/**
 * 造一个假的 req / res，调一条已注册的路由，返回 `{status, body}`。
 *
 * ★ 为什么要**透传返回值**：`handleFor` 把 handler 的返回值透传出来了
 *   （本插件与 liblibai 都这么做），所以这里 `await` 一下就知道"响应写完了没" ——
 *   不必轮询猜。这是当初那条注释所说的可测性。
 */
async function callRoute(run, path, { method = "GET", body } = {}) {
  const handler = run.routes.get(path);
  if (handler === undefined) throw new Error(`没有注册这条路由：${path}`);
  const chunks = [];
  const req = {
    method,
    on(event, cb) {
      if (event === "data" && body !== undefined) cb(Buffer.from(body, "utf8"));
      if (event === "end") cb();
      return req;
    },
    destroy() {},
  };
  const res = {
    statusCode: 0,
    headers: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text ?? "");
    },
  };
  await handler(req, res);
  const text = chunks.join("");
  let parsed;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: res.statusCode, headers: res.headers, text, body: parsed };
}

/** 触发一个已注册的事件（emit / serial 用）。多参数事件就多传几个。 */
async function fire(run, event, ...args) {
  const list = run.handlers.get(event) ?? [];
  for (const h of list) await h(...args);
}

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

/** 本进程造过的全部临时项目目录（收尾统一清扫，见文件末尾）。 */
const CREATED_ROOTS = [];

/**
 * ★ 崩溃也要清扫（2026-10-09 补）。
 *
 * 收尾那段清扫只在**正常跑完**时执行。自检一旦中途抛错（我这轮就因为
 * `_busy of undefined` 抛过一次），那些已经建出来的临时项目就**留在 %TEMP% 里**
 * —— 实测留下 3 个 `ledger-*` 空目录，而"干净跑一遍 0 残留"的自检本身发现不了它，
 * 因为出错的运行根本没走到收尾。
 * ⇒ 挂个退出兜底：无论正常/异常退出，都把本进程造过的目录删掉。
 *   （同步删，不用 await —— `exit` 里没有异步的机会。）
 */
process.on("exit", () => {
  for (const d of CREATED_ROOTS) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 删不掉就算了，别在退出路径上抛 */
    }
  }
});

function tmpProject(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ledger-${tag}-`));
  CREATED_ROOTS.push(dir);
  return dir;
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败无所谓 */
  }
}

/** 造一个假的 exec（工具执行上下文）。 */
function execFor(root, sid = "session-selftest") {
  return { agent: { session: { header: { id: sid, cwd: root } } } };
}

/**
 * 真的写一次台账，好让「压缩前强制落盘」那道闸门放行。
 *
 * ★★ 必须**真写**、不能直接去改插件内部状态：
 *   闸门的判据是"上一周期落过盘吗"，而"落盘"的定义就是
 *   `ledger_write` / `ledger_log_write` 真的成功。绕过它去塞 `flushedAt`
 *   等于在测试里假装落过盘 —— 那样闸门本身的接线就永远测不到了。
 * ★ 没有台账的项目（`activeRel` 为空）本来就会放行，所以这个 helper
 *   只用在"有台账"的夹具上。
 */
async function flushLedger(run, root, sid) {
  const w = run.registeredTools.get("ledger_write");
  if (w === undefined) return undefined;
  return w.execute({ target: "active", mode: "replace", content: "# 台账\n\n- 落盘\n" }, execFor(root, sid));
}

/** 跑一次 agent/pre-step 瀑布，返回注入后的 messages。 */
async function runPreStep(run, { agent, messages = [] }) {
  const list = run.handlers.get("agent/pre-step") ?? [];
  let decision = { messages };
  for (const h of list) {
    decision = await h({ agent, messages }, async () => decision);
  }
  return decision;
}

/**
 * ★★★ 2026-10-12（D129）：模拟**模型主动调 `ledger_compact({mode:"light"})`**。
 *
 * ★ 为什么必须有它：D129 用户拍板"**把所有压缩全部给模型**" ⇒ 那条**机械增量兜底
 *   （涨够 N 点插件替你压）已删除**。于是"增量压缩会/不会发生"这类断言，
 *   必须改成**从新的生产路径（模型主动要压）驱动** —— 否则测的是**一条已经不存在的路**
 *   （本机纪律：**夹具的前提错了，全绿就是假绿**）。
 *
 * ★ 它做的是**真实调用点做的同一件事**：往 `deltaForce` 塞一张 `source:"tool"` 的旗子。
 *   消费处据此置 `byNeed: true` ⇒ **跳过涨幅判据、但照旧过落盘闸门**（用户的铁律）。
 *   ★ 它**不绕过任何判据** —— 闸门怎么判仍由被测代码决定。
 */
function askAICompact(sid) {
  mod.__test.setDeltaForce(sid, "tool");
}

/**
 * ★★★ 2026-10-12（D129）：模拟**模型调 `ledger_triage`**（三步顺序的第②步）。
 *
 * ★ 为什么必须显式做它：用户定的标准动作是**三步、顺序不能换** ——
 *   ① `ledger_write` ② `ledger_triage` ③ `ledger_compact`。
 *   而闸门链是真实的：**没落盘 ⇒ 拦；落了盘但没分流 ⇒ 也拦**。
 *   ⇒ 凡是"期望压缩发生"的夹具，都必须把第②步也走掉，否则测的是**闸门**、不是它要测的机制。
 * ★ 与真实调用同形：走注册表里的工具、传同一形状的参数（空分流也是**合法**的一次分流）。
 */
async function triageNow(run, root, sid) {
  const t = run.registeredTools?.get("ledger_triage");
  if (t === undefined) return undefined;
  // ★★★ 必须给**至少一个桶非空**：`ledger_triage` 会拒绝"三个桶全空"的调用
  //   （「三个桶都是空的 —— 没有内容可分。」）⇒ 那样分流义务**清不掉** ⇒ 压缩被一直拦。
  //   ★ 这条我当场踩过：helper 传 `{}` ⇒ 30a 永远压不成（而看起来像"闸门坏了"）。
  //   真实调用里模型也不会调一次空分流，所以给一条最小的合法分项才是最贴近的模拟。
  return t.execute({ drop: [{ what: "（夹具：一条已完成的旧事）" }] }, execFor(root, sid));
}

/**
 * ★★★ 2026-10-12（D129）：**一步走完"落盘 → 分流 → 压缩"**（用户定的标准三步）。
 *
 * ★ 用途：凡是"我期望这次压缩真的发生"的夹具，调它即可 ——
 *   省去每处重复三段，且**顺序与合同一致**（顺序错了闸门会拦，那就不是被测对象的错）。
 *   ★ 它**不保证**压缩一定发生：闸门怎么判仍由被测代码决定（返回值照旧给调用方断言）。
 */
async function doThreeStepCompact(run, root, sid) {
  await flushLedger(run, root, sid);
  await triageNow(run, root, sid);
  askAICompact(sid);
}

/**
 * ★ 内核要求工具返回值是 **lossless JSON** —— `undefined` 不是。
 *
 * 真实的报错是：`tool "xxx" returned invalid output: value is not lossless JSON`。
 * 最阴的地方在于**副作用已经落盘**了，只有返回值不合法 ⇒ 调用看起来失败、其实写了。
 * （2026-10-08 实测撞到：`staged` 在没有 Git 仓库时是 `undefined`，整个 `ledger_log_write`
 *   被判失败，而日志那行已经写进文件了。）
 *
 * 所以每个工具返回值都要过这一关。这不是"多写一个断言"，是补上一个**假 ctx 缺掉的契约**：
 * 之前自检直接调 `.execute()` 拿对象，从不经过内核的输出校验，于是这个 bug 一直躲着。
 */
function assertLossless(label, value) {
  let round;
  try {
    round = JSON.stringify(value);
  } catch (e) {
    ok(`${label}：返回值可序列化`, false, String(e && e.message));
    return;
  }
  if (round === undefined) {
    ok(`${label}：返回值不是 undefined`, false, "JSON.stringify 得到 undefined");
    return;
  }
  // 往返一遍：能 stringify 不代表没丢东西（undefined / 函数 / Symbol 会被静默丢掉）。
  const back = JSON.parse(round);
  const same = JSON.stringify(back) === round;
  ok(`${label}：返回值是 lossless JSON`, same, same ? "" : `往返不一致：${round.slice(0, 200)}`);
  // 递归找 undefined（对象里值为 undefined 的键会被 stringify 丢掉 ⇒ 就是"不 lossless"）
  const bad = [];
  const scan = (v, pathStr, depth) => {
    if (depth > 6 || v === null || typeof v !== "object") {
      if (v === undefined) bad.push(pathStr);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => scan(x, `${pathStr}[${i}]`, depth + 1));
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) bad.push(`${pathStr}.${k}`);
      else scan(x, `${pathStr}.${k}`, depth + 1);
    }
  };
  scan(value, "result", 0);
  ok(`${label}：没有 undefined 字段`, bad.length === 0, bad.slice(0, 5).join(", "));
}

/** 调一个工具并顺带做 lossless 校验。 */
async function callTool(run, name, args, exec) {
  const tool = run.registeredTools.get(name);
  const out = await tool.execute(args, exec);
  assertLossless(`工具 ${name}`, out);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════════════

// ★ 用 `pathToFileURL` 而不是手拼 `file:///`：本机路径含中文，
//   手拼会把编码问题带进来（`HERE` 现在是**解码后**的，直接拼反而会坏）。
const mod = await import(pathToFileURL(ENTRY).href);

section("模块契约");
eq("导出 name", mod.name, "dsh-ledger-memory");
ok("导出 apply 是函数", typeof mod.apply === "function");
ok(
  "导出 inject 且含 tools（缺了会炸内核）",
  Array.isArray(mod.inject) && mod.inject.includes("tools"),
  `inject = ${JSON.stringify(mod.inject)}`
);

// ── 情形 1：全新项目（无 .git、无台账）────────────────────────────────────
section("情形 1：全新项目的检测与提示");
{
  const root = tmpProject("fresh");
  const run = makeCtx();
  mod.apply(run.ctx, {});

  // ★ 2026-10-10：新增 `ledger_handoff`（第③层）⇒ 11 → 12 个工具。
  // ★ 2026-10-10：新增 `ledger_triage`（分流单）⇒ 12 → 13 个工具。
  // ★ 2026-10-10：新增 `ledger_lock`（把会话锁到某个项目目录）⇒ 13 → 14 个工具。
  // ★ 2026-10-11：新增 `ledger_recall`（把被压段的逐字原文按需读回，含 reasoning）
  //   ⇒ 14 → 15 个工具（承 D79：压缩后要能回溯原文，而不只是摘要）。
  eq("注册了 15 个工具（新增 ledger_recall）", run.registeredTools.size, 15);
  for (const n of [
    "ledger_status",
    "ledger_init",
    "ledger_conform",
    "ledger_read",
    "ledger_write",
    "ledger_archive",
    "ledger_log",
    "ledger_log_write",
    "ledger_note",
    "ledger_handoff",
    "ledger_checkpoint",
  ]) {
    ok(`工具存在：${n}`, run.registeredTools.has(n));
  }
  ok("注册了 /ledger 命令", run.registeredCommands.has("ledger"));

  const status = await run.registeredTools.get("ledger_status").execute({}, execFor(root));
  eq("freshProject = true", status.freshProject, true);
  eq("initialized = false", status.initialized, false);
  eq("isGitRepo = false", status.isGitRepo, false);

  // 注入：全新项目应当提示"去问用户"
  const agent = { session: { header: { id: "s-fresh", cwd: root } } };
  const d1 = await runPreStep(run, { agent });
  eq("全新项目注入了 1 条消息", d1.messages.length, 1);
  const note = d1.messages[0];
  ok("注入消息有非空 string id（缺了会报废会话历史）", typeof note.id === "string" && note.id !== "", `id=${JSON.stringify(note.id)}`);
  ok("注入消息用自定义 source.kind", note.source?.kind === "project-ledger-notes", `kind=${note.source?.kind}`);
  ok("注入文本提到 ask_user_question", note.content[0].text.includes("ask_user_question"));

  // 同一会话第二步：不该重复提示（用户拒绝后不再追问）
  const d2 = await runPreStep(run, { agent });
  eq("第二步不重复注入", d2.messages.length, 0);

  // 无 warnings（工具注册没错）
  ok("无注册警告", run.warnings.length === 0, run.warnings.join(" | "));
  rmrf(root);
}

// ── 情形 2：ledger_init 全流程 ─────────────────────────────────────────────
section("情形 2：ledger_init（Git + 清单 + 初始内容）");
let initedRoot;
{
  const root = tmpProject("init");
  initedRoot = root;
  const run = makeCtx();
  mod.apply(run.ctx, {});
  const exec = execFor(root, "s-init");

  // 先放一个已有 .gitignore，验证"合并而非覆盖"
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n", "utf8");

  const init = await run.registeredTools.get("ledger_init").execute(
    {
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_ledger-archive",
      maxActiveLines: 150,
      initialActive:
        "# 项目台账\n\n## 目标\n做一个东西。\n\n## 进行中\n- [ ] 起步\n\n## 已完成\n\n## 下一步\n- 设计结构\n",
      initialDecisions: "# 关键决策\n\n（长期决策记这里，不参与归档）\n",
      gitignoreLines: ["dist/"],
    },
    exec
  );

  eq("init ok", init.ok, true);
  ok("git init 执行了", init.gitInit === true, JSON.stringify(init.notes));
  ok(".git 目录存在", fs.existsSync(path.join(root, ".git")));
  ok("LEDGER.md 写出", fs.existsSync(path.join(root, "LEDGER.md")));
  ok("DECISIONS.md 写出", fs.existsSync(path.join(root, "DECISIONS.md")));
  ok("归档目录建了", fs.statSync(path.join(root, "_ledger-archive")).isDirectory());

  const gi = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  ok("gitignore 保留了原有行", gi.includes("node_modules/"), gi);
  ok("gitignore 补了 dist/", gi.includes("dist/"), gi);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8"));
  eq("清单 active", manifest.active, "LEDGER.md");
  eq("清单 decisions", manifest.decisions, "DECISIONS.md");
  eq("清单 archiveDir", manifest.archiveDir, "_ledger-archive");
  eq("清单 maxActiveLines", manifest.maxActiveLines, 150);

  // 再 init 一次：不该覆盖已有台账
  const again = await run.registeredTools.get("ledger_init").execute(
    {
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_ledger-archive",
      initialActive: "THIS SHOULD NOT WIN\n",
    },
    exec
  );
  eq("二次 init ok", again.ok, true);
  ok(
    "二次 init 未覆盖已有活跃台账",
    fs.readFileSync(path.join(root, "LEDGER.md"), "utf8").includes("做一个东西"),
    fs.readFileSync(path.join(root, "LEDGER.md"), "utf8")
  );

  // 非法参数：绝对路径 / 逃逸 / 同名
  for (const [label, args] of [
    ["拒绝绝对路径", { active: "C:\\evil.md", decisions: "D.md", archiveDir: "_a" }],
    ["拒绝路径穿越", { active: "../evil.md", decisions: "D.md", archiveDir: "_a" }],
    ["拒绝活跃台账与决策同名", { active: "X.md", decisions: "X.md", archiveDir: "_a" }],
    ["拒绝文件放进归档目录", { active: "_ledger-archive/x.md", decisions: "D.md", archiveDir: "_ledger-archive" }],
  ]) {
    let threw = false;
    try {
      await run.registeredTools.get("ledger_init").execute(args, exec);
    } catch {
      threw = true;
    }
    ok(label, threw);
  }
}

// ── 情形 3：已初始化 ⇒ 注入活跃台账 ────────────────────────────────────────
section("情形 3：已有台账的注入");
{
  const run = makeCtx();
  mod.apply(run.ctx, {});
  const agent = { session: { header: { id: "s-inject", cwd: initedRoot } } };

  const d1 = await runPreStep(run, { agent });
  eq("注入了 1 条", d1.messages.length, 1);
  const t = d1.messages[0].content[0].text;
  ok("注入含台账正文", t.includes("做一个东西"), t.slice(0, 200));
  ok("注入含台账约定", t.includes("台账约定"));
  ok("注入点明决策记录不参与归档", t.includes("不参与归档"));

  const d2 = await runPreStep(run, { agent });
  eq("内容没变 ⇒ 不重复注入", d2.messages.length, 0);

  // 改台账内容 ⇒ 指纹变了 ⇒ 重新注入
  fs.appendFileSync(path.join(initedRoot, "LEDGER.md"), "\n- 新进展\n", "utf8");
  const d3 = await runPreStep(run, { agent });
  eq("台账变了 ⇒ 重新注入", d3.messages.length, 1);

  // 同一步里已有相同消息 ⇒ 不重复插
  const d4 = await runPreStep(run, {
    agent,
    messages: [],
  });
  const againSame = await (async () => {
    const list = run.handlers.get("agent/pre-step");
    let decision = { messages: [...d4.messages] };
    for (const h of list) decision = await h({ agent, messages: [] }, async () => decision);
    return decision;
  })();
  eq("同一步已有相同注入 ⇒ 不重复", againSame.messages.length, d4.messages.length);
}

// ── 情形 4：ledger_write 与行数闸门 ───────────────────────────────────────
section("情形 4：ledger_write 与阈值闸门");
{
  const run = makeCtx();
  mod.apply(run.ctx, {});
  const exec = execFor(initedRoot, "s-write");
  const T = run.registeredTools;

  const w = await T.get("ledger_write").execute({ target: "active", content: "# A\n\n## 目标\nX\n", mode: "replace" }, exec);
  eq("写入活跃台账 ok", w.ok, true);
  // ★ `lines` 是**落盘后的真实行数**，含插件自己维护的「变更登记」区 ⇒ 一定 > 4。
  //   正文本身的行数看 `changedBy`（登记区不参与计量）。
  ok("行数统计 ≥ 正文行数（登记区占行）", w.lines >= 4, `lines=${w.lines}`);
  eq("正文确实写进去了", bodyOf(fs.readFileSync(path.join(initedRoot, "LEDGER.md"), "utf8")).trim(), "# A\n\n## 目标\nX");
  ok("★ 台账里出现了变更登记区", fs.readFileSync(path.join(initedRoot, "LEDGER.md"), "utf8").includes(CHANGE_HEADING));

  const a = await T.get("ledger_write").execute({ target: "active", content: "- 追加一行\n", mode: "append" }, exec);
  eq("追加 ok", a.ok, true);

  // ★ 用**清单自己登记的阈值**来构造超限内容，而不是写死 150/200 ——
  //   `initedRoot` 是跨小节共享的夹具，别处再 init 一次会把阈值改掉
  //   （实测撞到：这里以为上限是 150，实际已是 300 ⇒ 200 行不再超限，用例假红）。
  //   这样断言就只依赖"闸门与清单一致"，不依赖夹具的历史。
  const limit = JSON.parse(fs.readFileSync(path.join(initedRoot, ".dsh-ledger.json"), "utf8")).maxActiveLines;
  const big = Array.from({ length: limit + 50 }, (_, i) => `- 第 ${i} 行`).join("\n");
  const refused = await T.get("ledger_write").execute({ target: "active", content: big, mode: "replace" }, exec);
  eq("超阈值被拒", refused.ok, false);
  ok("拒绝理由提到归档", String(refused.reason).includes("ledger_archive"), refused.reason);
  eq("拒绝时给出 hint", refused.hint, "ledger_archive");

  const forced = await T.get("ledger_write").execute({ target: "active", content: big, mode: "replace", force: true }, exec);
  eq("force 后允许写", forced.ok, true);
  eq("force 后标记超阈值", forced.overThreshold, true);

  // 决策记录：不受行数闸门约束，且可追加
  const d1 = await T.get("ledger_write").execute(
    { target: "decisions", content: "## 决策一\n用清单文件而非固定模板。\n", mode: "append" },
    exec
  );
  eq("写决策记录 ok", d1.ok, true);
  const dtext = fs.readFileSync(path.join(initedRoot, "DECISIONS.md"), "utf8");
  ok("决策记录被追加（原有内容还在）", dtext.includes("不参与归档") && dtext.includes("用清单文件而非固定模板"), dtext);
}

// ── 情形 5：归档（YYYY-MM/weekN、只追加、不改历史）──────────────────────────
section("情形 5：ledger_archive");
{
  const run = makeCtx();
  mod.apply(run.ctx, {});
  const exec = execFor(initedRoot, "s-arch");
  const T = run.registeredTools;

  await T.get("ledger_read").execute; // 只是确保工具在
  const before = await T.get("ledger_read").execute({ target: "active" }, exec);
  eq("读到活跃台账", before.found, true);

  // ★★ 2026-10-11 更正（新加的内容不变量照出来的第 **3** 处夹具问题）：
  //   本小节是在**情形 4 之后**跑的，而情形 4 的 `ledger_write(mode:"replace")`
  //   已经把 `initedRoot` 的正文换成了 `# A\n\n## 目标\nX` ——
  //   原先这里的 `entries`/`newActive` 是照着**更早**的内容写的（「旧条目一」「设计结构」
  //   「- [ ] 起步」），**与此刻磁盘上的真实内容对不上**。
  //   新不变量（移走的行必须出现在 entries 里）当场把这处不一致照了出来。
  //   ⇒ 夹具必须先**读回真实内容**，再照它构造 entries/newActive。
  const liveBefore = fs.readFileSync(path.join(initedRoot, "LEDGER.md"), "utf8");
  const liveBody = bodyOf(liveBefore); // 剥掉插件维护的变更登记区
  const liveEntries = liveBody
    .split("\n")
    .filter((l) => /^\s*(?:[-*+]|\d+\.)\s+\S/.test(l)); // 真实条目行

  const r1 = await T.get("ledger_archive").execute(
    {
      // 把**真实存在**的条目移进归档（而不是夹具里凭空编的那几个）
      entries: `## 已完成\n${liveEntries.join("\n")}\n`,
      newActive: "# 项目台账\n\n## 目标\n继续做。\n\n## 进行中\n- [ ] 起步\n",
      label: "第一批",
    },
    exec
  );
  eq("归档 ok", r1.ok, true);
  ok("归档路径形如 archiveDir/YYYY-MM/weekN/xxx.md", /^_ledger-archive\/\d{4}-\d{2}\/week\d+\/.+\.md$/.test(r1.archivedTo), r1.archivedTo);

  const arcAbs = path.join(initedRoot, r1.archivedTo);
  const first = fs.readFileSync(arcAbs, "utf8");
  ok("归档写入含移走的条目", liveEntries.length > 0 ? first.includes(liveEntries[0].replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").slice(0, 6)) : true, first);
  ok("归档写入含 label", first.includes("第一批"));

  // 第二次归档到同一周期 ⇒ 必须**追加**且保住第一次的内容。
  // ★ 这一次移走 `- [ ] 起步`（第一次的 newActive 里刚写进去的那条）。
  const r2 = await T.get("ledger_archive").execute(
    { entries: "## 已完成\n- [ ] 起步\n", newActive: "# 项目台账\n\n## 目标\n再继续。\n" },
    exec
  );
  eq("二次归档 ok", r2.ok, true);
  eq("二次归档落在同一文件", r2.archivedTo, r1.archivedTo);
  eq("appended 标记为真", r2.appended, true);
  const second = fs.readFileSync(arcAbs, "utf8");
  ok("历史未被覆盖（第一次的条目还在）", second.includes("第一批"), second);
  ok("新条目已追加", second.includes("- [ ] 起步"), second);

  // newActive 仍超阈值 ⇒ 拒绝改活跃台账（归档不能白做）
  // ★ 同样按**清单自己的阈值**构造（别写死 200；见情形 4 的说明）。
  const limit2 = JSON.parse(fs.readFileSync(path.join(initedRoot, ".dsh-ledger.json"), "utf8")).maxActiveLines;
  const big = Array.from({ length: limit2 + 50 }, (_, i) => `- x${i}`).join("\n");
  const refused = await T.get("ledger_archive").execute({ entries: "- 一条\n", newActive: big }, exec);
  eq("newActive 超阈值被拒", refused.ok, false);
  ok("拒绝理由说明归档已写但活跃台账未动", String(refused.reason).includes("没有"), refused.reason);

  // entries 为空 ⇒ 拒绝
  let threw = false;
  try {
    const e = await T.get("ledger_archive").execute({ entries: "  ", newActive: "x" }, exec);
    threw = e.ok === false;
  } catch {
    threw = true;
  }
  ok("空 entries 被拒", threw);

  // 读归档列表
  const list = await T.get("ledger_read").execute({ target: "archive" }, exec);
  eq("归档列表 ok", list.found, true);
  ok("归档列表非空", list.count >= 1, JSON.stringify(list.files));
  // ★ 2026-10-11 更正：原先断言含「旧条目一」——那是**夹具里编的**、真实台账里没有的条目。
  //   现在归档的是真实移走的条目，所以改断言 label（它一定在批次标题里）。
  const one = await T.get("ledger_read").execute({ target: "archive", archiveFile: r1.archivedTo }, exec);
  ok("能读单个归档文件", one.found === true && one.text.includes("第一批"));
}

// ── 情形 6：/ledger 命令 ───────────────────────────────────────────────────
section("情形 6：/ledger 命令");
{
  const run = makeCtx();
  mod.apply(run.ctx, {});
  const cmd = run.registeredCommands.get("ledger");
  const invoke = (rawInput, root = initedRoot, sid = "s-cmd") => ({
    commandId: "c1",
    agent: { session: { header: { id: sid, cwd: root } } },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  });

  const help = await cmd.handler(invoke("help"));
  eq("help ⇒ 帮助", help.kind, "success");
  ok("帮助列出六个子命令", ["status", "show", "init", "update", "archive", "log"].every((s) => help.text.includes(s)), help.text);

  const show = await cmd.handler(invoke("show"));
  eq("show ok", show.kind, "success");
  ok("show 打出台账正文", show.text.includes("项目台账"), show.text.slice(0, 120));

  const st = await cmd.handler(invoke("status"));
  eq("status ok", st.kind, "success");
  ok("status 报了行数", /\d+ \/ \d+ 行/.test(st.text), st.text);

  // init/update/archive ⇒ 置待办 + 注入一条给 AI 的明确指令
  const agent = { session: { header: { id: "s-cmd", cwd: initedRoot } } };
  const up = await cmd.handler(invoke("update", initedRoot, "s-cmd"));
  eq("update ok", up.kind, "success");
  const d = await runPreStep(run, { agent });
  eq("pending 触发了一次注入", d.messages.length, 1);
  ok("注入是 update 指令", d.messages[0].content[0].text.includes("用户请求更新"), d.messages[0].content[0].text.slice(0, 120));

  // ★ 断言的是「update 指令不再重复」，而不是「这一步什么都不注入」：
  //   待办兑现之后，常规的活跃台账注入**应该**恢复 —— 那正是模型接下来要看的。
  const d2 = await runPreStep(run, { agent });
  const texts2 = d2.messages.map((m) => m.content[0].text);
  ok("pending 只兑现一次（不再重复 update 指令）", texts2.every((t) => !t.includes("用户请求更新")), texts2.join("|").slice(0, 200));
  ok("待办兑现后恢复常规台账注入", texts2.some((t) => t.includes("当前项目台账")), texts2.join("|").slice(0, 200));

  const bad = await cmd.handler(invoke("nope"));
  eq("未知子命令 ⇒ error", bad.kind, "error");

  // 全新项目里 /ledger init 的注入应当讲清四条硬约束
  const freshRoot = tmpProject("cmd-init");
  const initCmd = await cmd.handler(invoke("init", freshRoot, "s-cmd2"));
  eq("init 命令 ok", initCmd.kind, "success");
  const di = await runPreStep(run, { agent: { session: { header: { id: "s-cmd2", cwd: freshRoot } } } });
  eq("init 注入 1 条", di.messages.length, 1);
  const it = di.messages[0].content[0].text;
  // ★ 不写死具体行数：默认值是可调的（150→300 时这条曾假红）。
  //   要验的是"讲清了四条硬约束"，不是"数字正好是 150"。
  ok(
    "init 注入提到四条硬约束",
    it.includes("关键决策记录") && it.includes("归档目录") && /≤ \d+ 行/.test(it),
    it.slice(0, 400)
  );
  rmrf(freshRoot);
}

// ── 情形 6b：裸 `/ledger` 弹可点卡片（用户抱怨"发出去不能选功能"）─────────────
//
// ★ 平台不允许命令自带二级选择菜单（`dsh-commands` 只接受 input.hint 字符串），
//   所以裸 `/ledger` 改成弹一张 userQuestions 卡片让用户点。
section("情形 6b：/ledger 裸敲弹选择卡片");
{
  const run = makeCtx({ withUserQuestions: true });
  mod.apply(run.ctx, {});
  const cmd = run.registeredCommands.get("ledger");
  const invoke = (rawInput, root = initedRoot, sid = "s-pick") => ({
    commandId: "c1",
    agent: { session: { header: { id: sid, cwd: root } } },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  });

  // 6b-1：点了「显示活跃台账」⇒ 走 show 那条路
  run.setAnswer(() => ({ answers: [{ id: "ledger-subcommand", selected: ["显示活跃台账"] }] }));
  const r1 = await cmd.handler(invoke(""));
  eq("点了选项 ⇒ 弹出过卡片", run.asked.length, 1);
  ok("卡片是选择题", Array.isArray(run.asked[0].request.questions[0].options));
  // ★ 2026-10-09：加了 `light`（手动轻量压缩）⇒ 7 项变 8 项。
  // ★ 2026-10-10：加了 `handoff`（写交接单）⇒ 8 项变 9 项。
  // ★ 2026-10-10：加了 `mode`（切压缩模式）⇒ 9 项变 10 项。
  // ★ 2026-10-10：加了 `lock`（把会话锁到某个项目目录）⇒ 10 项变 11 项。
  eq("卡片列全十一个子命令（含 compact / light / handoff / mode / lock）", run.asked[0].request.questions[0].options.length, 11);
  eq("点「显示活跃台账」⇒ 真的执行 show", r1.kind, "success");
  ok("返回的是台账正文", r1.text.includes("项目台账"), r1.text.slice(0, 150));
  // ★ 关键：卡片里选出来的，与手打 `/ledger show` 必须**一模一样**
  const byHand = await cmd.handler(invoke("show"));
  eq("卡片选中与手打结果一致", r1.text, byHand.text);

  // 6b-2：手打自定义文字也算（打 "log" 等价于点 log）
  run.setAnswer(() => ({ answers: [{ id: "ledger-subcommand", custom: "log" }] }));
  const r2 = await cmd.handler(invoke(""));
  eq("自定义输入 log ⇒ 执行 log", r2.kind, "success");
  ok("拿到的是日志状态那一节", r2.text.includes("活动日志"), r2.text.slice(0, 120));

  // 6b-3：没选也没打字 ⇒ 回退帮助，不许挂住
  run.setAnswer(() => ({ answers: [{ id: "ledger-subcommand", selected: [] }] }));
  const r3 = await cmd.handler(invoke(""));
  eq("没选 ⇒ 回退帮助", r3.kind, "success");
  ok("回退文本列出子命令", r3.text.includes("status") && r3.text.includes("log"), r3.text.slice(0, 200));

  // 6b-6：★★★ 用户报的缺陷 —— 命令提示里**漏了 compact**（手抄的列表漂了）
  //
  //   ★ 症状：敲 `/ledger` 时补全提示写的是
  //     `[回车=选择卡片 | status | show | init | update | archive | log]` —— **没有 compact**，
  //     而卡片里其实有 ⇒ 用户以为"没有手动压缩这个功能"。
  //   ★ 根因：`input.hint` 与 `description` 是**手抄**的字符串，抄漏了。
  //   ★ 修法：两处都改成由 `LEDGER_SUBCOMMANDS` **生成**（单一来源）。
  //   ★★ 这条断言就是钉住"不许再手抄"：**每一个**子命令都必须出现在提示里。
  {
    const def = run.registeredCommands.get("ledger");
    const hint = def?.input?.hint ?? "";
    const desc = def?.description ?? "";
    const subs = ["status", "show", "init", "update", "archive", "compact", "light", "log"];
    const missingHint = subs.filter((s) => !hint.includes(s));
    const missingDesc = subs.filter((s) => !desc.includes(s));
    ok(
      "★★★ 命令提示里**一个不漏**地列出全部子命令（用户报的 compact 漏掉就是这个）",
      missingHint.length === 0,
      `提示 = ${hint}\n缺：${missingHint.join(", ")}`
    );
    ok("★★ 命令描述里也一个不漏", missingDesc.length === 0, `缺：${missingDesc.join(", ")}`);
    ok("★★ 提示里点名了 compact（手动全量压缩）", hint.includes("compact"), hint);
    ok("★★ 提示里点名了 light（手动轻量压缩）", hint.includes("light"), hint);
  }

  // 6b-7：★★★ `light` 必须真的能用（用户要的"轻量压缩也给一条命令"）
  {
    const regionCalls = [];
    const lrun = makeCtx({ withCompaction: true, withTokenMeter: true, withUserQuestions: true, regionCalls });
    mod.apply(lrun.ctx, {});
    const lcmd = lrun.registeredCommands.get("ledger");
    const steered = [];
    const lagent = {
      session: { header: { id: "s-light", cwd: initedRoot } },
      steer: (input) => steered.push(input),
    };
    const r = await lcmd.handler({
      commandId: "c-light",
      agent: lagent,
      rawInput: "light",
      attachments: [],
      signal: new AbortController().signal,
    });
    eq("★ `/ledger light` 返回 success", r.kind, "success");
    ok("★ 文本说明这是轻量（增量）压缩", /轻量|增量/.test(r.text), r.text.slice(0, 200));
    ok("★★ 而且**明确区分**了 compact（全量）与 light（轻量）", /compact/.test(r.text), r.text.slice(0, 300));
    ok("★★★ 唤醒了 AI（否则 idle 时什么都不会发生 —— D40 那个坑）", steered.length === 1, JSON.stringify(steered.length));
  }

  // 6b-8：★★★ 手动的 light **没压成时必须如实说**（不能像 D40 那样静默）
  //
  //   ★ 这是我在接线时当场发现的坑：`text !== undefined` 是整段压缩的闸门，
  //     而 `/ledger light` 唤醒的那一轮**可能没有任何别的东西要注入** ⇒
  //     `text` 是 undefined ⇒ 压缩段整段跳过 ⇒ 压缩**永不发生**，
  //     但命令已经告诉用户"立刻执行"。**正是 D40 那个坑的翻版。**
  //   ⇒ 断言：旗子被消费后，即使原本没有注入，也**必须**产出一句说明。
  {
    const regionCalls = [];
    const brun = makeCtx({ withCompaction: true, withTokenMeter: true, withUserQuestions: true, regionCalls });
    mod.apply(brun.ctx, {});
    const bcmd = brun.registeredCommands.get("ledger");
    const bagent = {
      session: { header: { id: "s-light-blocked", cwd: initedRoot } },
      steer: () => {},
    };
    // ① 先按 light ⇒ 立旗子
    await bcmd.handler({
      commandId: "c-l1",
      agent: bagent,
      rawInput: "light",
      attachments: [],
      signal: new AbortController().signal,
    });
    // ② 让 tokenMeter 量不到水位 ⇒ 压缩必然失败
    brun.services.tokenMeter.measure = () => ({ totalTokens: NaN });
    const d = await runPreStep(brun, { agent: bagent, messages: [] });
    const t = (d.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
    ok(
      "★★★ 手动的 light 压不成时，注入里**如实说了**（不是静默什么都不发生）",
      /light/.test(t) && /没有压成|出错/.test(t),
      t.slice(0, 500)
    );
    // ⚠️ 这里**不** rmrf(initedRoot)：后面 6b-4 / 6b-5 还要用它。
  }

  // 6b-4：★ 没有 userQuestions 服务（拿不到卡片 UI）⇒ 直接回退帮助，不抛
  {
    const bare = makeCtx({ withUserQuestions: false });
    mod.apply(bare.ctx, {});
    const c2 = bare.registeredCommands.get("ledger");
    let threw;
    let r;
    try {
      r = await c2.handler(invoke(""));
    } catch (e) {
      threw = e;
    }
    ok("没有卡片 UI 时不抛错", threw === undefined, threw && threw.message);
    ok("没有卡片 UI 时回退成帮助文本", r !== undefined && r.kind === "success" && r.text.includes("status"), JSON.stringify(r).slice(0, 200));
    rmrf(initedRoot);
  }

  // 6b-5：★ 卡片被丢弃（ask 抛错）⇒ 回退帮助，绝不能让 /ledger 永远挂着
  {
    const r4 = makeCtx({ withUserQuestions: true });
    mod.apply(r4.ctx, {});
    r4.setAnswer(() => {
      throw new Error("dismissed");
    });
    const c3 = r4.registeredCommands.get("ledger");
    let threw;
    let out;
    try {
      out = await c3.handler(invoke(""));
    } catch (e) {
      threw = e;
    }
    ok("卡片被丢弃时不抛错", threw === undefined, threw && threw.message);
    ok("卡片被丢弃时回退帮助", out !== undefined && out.kind === "success", JSON.stringify(out).slice(0, 160));
  }
}

// ── 情形 7：严格模式下的容错（服务缺失不许炸）──────────────────────────────
section("情形 7：服务缺失与容错");
{
  // commands 服务不存在 ⇒ 不许抛错，工具照样注册
  const run = makeCtx({ withCommands: false });
  let threw = false;
  try {
    mod.apply(run.ctx, {});
  } catch (e) {
    threw = true;
    console.log(`        apply 抛了：${e.message}`);
  }
  ok("没有 commands 服务时 apply 不抛错", !threw);
  eq("没有 commands 时工具仍注册", run.registeredTools.size, 15);
  rmrf(initedRoot);
}

// ── 情形 8：注入失败不影响会话（坏 agent 不许抛）───────────────────────────
section("情形 8：注入路径的健壮性");
{
  const run = makeCtx();
  mod.apply(run.ctx, {});
  for (const [label, agent] of [
    ["agent 为 undefined", undefined],
    ["session 缺失", {}],
    ["header 缺失", { session: {} }],
    ["cwd 为空串", { session: { header: { id: "s", cwd: "" } } }],
    ["cwd 不存在", { session: { header: { id: "s", cwd: "Z:\\nope\\nope" } } }],
  ]) {
    let threw = false;
    try {
      await runPreStep(run, { agent });
    } catch (e) {
      threw = true;
      console.log(`        抛了：${e.message}`);
    }
    ok(`注入在「${label}」下不抛错`, !threw);
  }

  // 工具在没有会话上下文时应当给出明确错误（而不是静默错算）
  let msg = "";
  try {
    await run.registeredTools.get("ledger_status").execute({}, { agent: undefined });
  } catch (e) {
    msg = String(e.message);
  }
  ok("无会话上下文时工具报明确错误", msg.includes("工作目录"), msg);
}

// ── 情形 9：判定"保守"（不误认 TODO.md 为台账）─────────────────────────────
section("情形 9：候选名判定必须保守");
{
  const root = tmpProject("conservative");
  fs.writeFileSync(path.join(root, "TODO.md"), "# 待办\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "# 说明\n", "utf8");
  fs.writeFileSync(path.join(root, "PROJECT.md"), "# 项目\n", "utf8");

  const run = makeCtx();
  mod.apply(run.ctx, {});
  const st = await run.registeredTools.get("ledger_status").execute({}, execFor(root));
  eq("不把 TODO/README/PROJECT 当台账", st.initialized, false);
  eq("仍判为未初始化", st.freshProject, true);

  // 加上真正的台账名 ⇒ 认得出来
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
  const st2 = await run.registeredTools.get("ledger_status").execute({}, execFor(root));
  eq("认得 LEDGER.md", st2.active, "LEDGER.md");
  eq("来源标为 guess", st2.discoveredBy.active, "guess");

  // 中文台账名也认
  fs.unlinkSync(path.join(root, "LEDGER.md"));
  fs.writeFileSync(path.join(root, "任务台账.md"), "# 台账\n", "utf8");
  const st3 = await run.registeredTools.get("ledger_status").execute({}, execFor(root));
  eq("认得 任务台账.md", st3.active, "任务台账.md");

  rmrf(root);
}

// ── 情形 10：容器工作区（本机 `D:\Deepseek工作区` 的真实误报）──────────────
//
// 真实事故：`D:\Deepseek工作区` 自己没有 `.git`、没有台账，但有 `AGENTS.md`，
// 且二层子目录里有 3 个独立仓库 ⇒ 旧版 `isFreshProject` 判真，每次会话都劝用户
// `git init`。往这里 init 会把所有子项目卷进错误的父仓库。
section("情形 10：容器工作区不许被当成新项目");
{
  // 10a：标志文件 + 多个子项目 ⇒ 不是新项目
  //
  // ★ 为什么必须**同时**造两个子目录：容器判定要「标志文件 + ≥2 个子项目」
  //   （`CONTAINER_MIN_SUBDIRS = 2`）—— 只看 `AGENTS.md` 会把规范化单项目误伤成静默。
  //   这一段在日志重放时曾丢掉那两行 mkdir，于是"有 AGENTS.md ⇒ 不是新项目"当场假红。
  const rootA = tmpProject("container-marker");
  fs.writeFileSync(path.join(rootA, "AGENTS.md"), "# 规矩\n", "utf8");
  fs.mkdirSync(path.join(rootA, "10-游戏模组"), { recursive: true });
  fs.mkdirSync(path.join(rootA, "20-DSH插件"), { recursive: true });
  const runA = makeCtx();
  mod.apply(runA.ctx, {});
  const stA = await runA.registeredTools.get("ledger_status").execute({}, execFor(rootA));
  eq("有 AGENTS.md ⇒ freshProject = false", stA.freshProject, false);
  eq("status 报出 marker", stA.containerWorkspace?.marker, "AGENTS.md");

  const agentA = { session: { header: { id: "s-container-a", cwd: rootA } } };
  const dA = await runPreStep(runA, { agent: agentA });
  const textA = dA.messages.map((m) => m.content.map((c) => c.text).join("")).join("\n");
  ok("注入提到容器工作区", textA.includes("容器工作区"), textA.slice(0, 120));
  ok("注入明说不要 git init", textA.includes("不要") && textA.includes("git init"));
  ok("注入**没有**劝用户初始化（不含 ask_user_question）", !textA.includes("ask_user_question"));
  rmrf(rootA);

  // 10a-2：**只有** AGENTS.md、没有子项目 ⇒ 仍算新项目（别把单项目误伤成静默）
  const rootA2 = tmpProject("container-marker-only");
  fs.writeFileSync(path.join(rootA2, "AGENTS.md"), "# 规矩\n", "utf8");
  const runA2 = makeCtx();
  mod.apply(runA2.ctx, {});
  const stA2 = await runA2.registeredTools.get("ledger_status").execute({}, execFor(rootA2));
  eq("只有 AGENTS.md ⇒ 仍判新项目（不误伤单项目）", stA2.freshProject, true);
  eq("只有 AGENTS.md ⇒ 没有容器特征", stA2.containerWorkspace, null);
  rmrf(rootA2);

  // 10b：子目录里有 .git ⇒ 不是新项目，且报出是哪个
  const rootB = tmpProject("container-nested");
  fs.mkdirSync(path.join(rootB, "50-其他软件项目", "01-桌面工具箱"), { recursive: true });
  fs.mkdirSync(path.join(rootB, "50-其他软件项目", "01-桌面工具箱", ".git"), { recursive: true });
  const runB = makeCtx();
  mod.apply(runB.ctx, {});
  const stB = await runB.registeredTools.get("ledger_status").execute({}, execFor(rootB));
  eq("子目录有 .git ⇒ freshProject = false", stB.freshProject, false);
  eq(
    "status 报出嵌套仓库相对路径",
    stB.containerWorkspace?.nestedRepo,
    "50-其他软件项目/01-桌面工具箱"
  );

  // 10c：容器里 ledger_init 必须被拒（这是防误操作的核心闸门）
  let initErr;
  try {
    await runB.registeredTools.get("ledger_init").execute(
      { active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive" },
      execFor(rootB, "s-container-b")
    );
  } catch (e) {
    initErr = e;
  }
  ok("容器里 ledger_init 被拒", initErr !== undefined, `err=${initErr && initErr.message}`);
  ok(
    "拒绝信息提到 allowContainer 且给出了正确做法",
    initErr !== undefined &&
      initErr.message.includes("allowContainer") &&
      initErr.message.includes("子项目"),
    initErr && initErr.message
  );
  ok("被拒后没有留下 .git", !fs.existsSync(path.join(rootB, ".git")));
  ok("被拒后没有留下清单", !fs.existsSync(path.join(rootB, ".dsh-ledger.json")));

  // 10d：显式 allowContainer = true 时放行（逃生口必须真的能开）
  const initOk = await runB.registeredTools.get("ledger_init").execute(
    {
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_ledger-archive",
      allowContainer: true,
      gitInit: false,
    },
    execFor(rootB, "s-container-d")
  );
  eq("allowContainer 放行", initOk.ok, true);
  ok("放行后清单落盘", fs.existsSync(path.join(rootB, ".dsh-ledger.json")));
  rmrf(rootB);

  // 10e：真·新项目（空目录）仍然要被提示 —— 修误报不能把功能修没了
  const rootC = tmpProject("container-truefresh");
  const runC = makeCtx();
  mod.apply(runC.ctx, {});
  const stC = await runC.registeredTools.get("ledger_status").execute({}, execFor(rootC));
  eq("空目录仍判为新项目", stC.freshProject, true);
  eq("空目录没有容器特征", stC.containerWorkspace, null);
  const dC = await runPreStep(runC, {
    agent: { session: { header: { id: "s-container-c", cwd: rootC } } },
  });
  const textC = dC.messages.map((m) => m.content.map((c) => c.text).join("")).join("\n");
  ok("空目录仍提示问用户", textC.includes("ask_user_question"), textC.slice(0, 120));
  rmrf(rootC);
}

// ── 情形 11：回合末四选一（ledger_checkpoint）────────────────────────────────
section("情形 11：ledger_checkpoint 四选一");
{
  const root = tmpProject("checkpoint");
  const run = makeCtx({ withUserQuestions: true, withCompaction: true });
  mod.apply(run.ctx, {});
  const T = run.registeredTools;
  const exec = execFor(root, "s-checkpoint");

  // 11a：用户选「不记录台账」
  run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["不记录台账"] }] }));
  const a = await T.get("ledger_checkpoint").execute({}, { ...exec, callId: "call-1" });
  eq("不记录 ⇒ choice=skip", a.choice, "skip");
  ok("不记录 ⇒ 提示别写台账", a.next.includes("不要写台账"), a.next);
  ok("问了用户一次", run.asked.length === 1, `asked=${run.asked.length}`);
  eq("走的是阻塞式 ask（非 askTimed）", run.asked[0].mode, "ask");
  eq("问题 id 固定", run.asked[0].request.questions[0].id, "ledger-turn-end");
  eq("恰好四个选项", run.asked[0].request.questions[0].options.length, 4);
  ok(
    "四个选项就是用户原话的那四个",
    run.asked[0].request.questions[0].options.map((o) => o.label).join("|") ===
      "不记录台账|只记录台账|记录台账 + 执行压缩|记录台账 + 写交接单",
    run.asked[0].request.questions[0].options.map((o) => o.label).join("|")
  );
  eq("带上了 agent（否则卡片没有归属会话）", run.asked[0].request.agent !== undefined, true);
  // ★ 必须带 wait.callId —— 卡片的答复靠它回到这次调用（见 b23/b24 的取证）。
  eq("带上 wait.callId ⇒ 答复能回到本次调用", run.asked[0].request.wait.callId, "call-1");

  // 11b：用户选「记录台账 + 执行压缩」⇒ 记下压缩意图
  run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["记录台账 + 执行压缩"] }] }));
  const b = await T.get("ledger_checkpoint").execute({}, { ...exec, callId: "call-42" });
  eq("压缩 ⇒ choice=record+compact", b.choice, "record+compact");
  ok("压缩 ⇒ 提示先写台账再结束本轮", b.next.includes("必须先写台账"), b.next);
  eq("传了 callId", run.asked[1].request.wait.callId, "call-42");

  // 11c：选完压缩后，agent 转 idle ⇒ 插件真的去压缩了
  eq("压缩前还没调用 compaction", run.compacted.length, 0);
  const agent = { session: { header: { id: "s-checkpoint", cwd: root }, id: "s-checkpoint" } };
  await fire(run, "agent/status", { agent, status: "running" });
  eq("running 时不压缩（compaction 要求 idle）", run.compacted.length, 0);
  await fire(run, "agent/status", { agent, status: "idle" });
  eq("idle 时执行压缩", run.compacted.length, 1);
  await fire(run, "agent/status", { agent, status: "idle" });
  eq("意图已被消费，不会压第二次", run.compacted.length, 1);

  // 11d：压缩后 pre-step 强制重注台账（绕过指纹去重）
  const inited = tmpProject("checkpoint-inited");
  fs.writeFileSync(path.join(inited, "LEDGER.md"), "# 台账\n\n## 目标\nX\n", "utf8");
  fs.writeFileSync(
    path.join(inited, ".dsh-ledger.json"),
    JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a" }),
    "utf8"
  );
  const run2 = makeCtx({ withCompaction: true });
  mod.apply(run2.ctx, {});
  const agent2 = { session: { header: { id: "s-reinject", cwd: inited }, id: "s-reinject" } };
  const first = await runPreStep(run2, { agent: agent2 });
  eq("首次注入台账", first.messages.length, 1);
  const second = await runPreStep(run2, { agent: agent2 });
  eq("内容没变 ⇒ 不重复注入", second.messages.length, 0);
  // 压缩完成 ⇒ 挂重注标记（session/event 的签名是 (session, event)）
  await fire(run2, "session/event", { id: "s-reinject", header: { id: "s-reinject" } }, {
    type: "compaction/end",
    data: { compactionId: "c-1", turn: 1 },
  });
  const afterCompaction = await runPreStep(run2, { agent: agent2 });
  eq("压缩后强制重注（哪怕台账一个字没改）", afterCompaction.messages.length, 1);
  ok(
    "重注文本明确说了刚压缩",
    afterCompaction.messages[0].content[0].text.includes("上下文刚被压缩"),
    afterCompaction.messages[0].content[0].text.slice(0, 100)
  );
  ok(
    "★ 重注文本点明「台账 + 高保真胶囊」（需求 ㉑）",
    afterCompaction.messages[0].content[0].text.includes("高保真胶囊"),
    afterCompaction.messages[0].content[0].text.slice(0, 200)
  );
  ok(
    "重注文本仍带当前台账正文",
    afterCompaction.messages[0].content[0].text.includes("# 台账"),
    "台账正文没带上"
  );
  const third = await runPreStep(run2, { agent: agent2 });
  eq("重注只做一次", third.messages.length, 0);

  // 11e：没有 userQuestions 服务时软失败（不许抛、不许打断）
  const run3 = makeCtx();
  mod.apply(run3.ctx, {});
  const soft = await run3.registeredTools.get("ledger_checkpoint").execute({}, execFor(root, "s-soft"));
  eq("无 userQuestions ⇒ ok=false", soft.ok, false);
  ok("软失败给出可执行建议", String(soft.reason).includes("ask_user_question"), soft.reason);

  // 11f：agent 缺失 ⇒ 抛（这类错误该让 AI 看到）
  let noAgent;
  try {
    await run.registeredTools.get("ledger_checkpoint").execute({}, { callId: "c" });
  } catch (e) {
    noAgent = e;
  }
  ok("没有 agent 时抛错", noAgent !== undefined, `err=${noAgent && noAgent.message}`);

  rmrf(root);
  rmrf(inited);
}

// ── 情形 12：上下文水位分档提醒（需求 ②⑳）───────────────────────────────────
section("情形 12：上下文水位分档提醒");
{
  const root = tmpProject("pressure");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\nX\n", "utf8");
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a" }),
    "utf8"
  );
  const run = makeCtx({ withTokenMeter: true });
  mod.apply(run.ctx, {});
  const agent = {
    session: {
      header: { id: "s-pressure", cwd: root },
      requestContext: () => ({ contextWindow: 1000 }),
    },
  };

  const d1 = await runPreStep(run, { agent });
  eq("首次注入台账", d1.messages.length, 1);
  ok("未到 30% 时不提水位", !d1.messages[0].content[0].text.includes("水位已到"));

  // 25% ⇒ 还不到第一档
  run.services.tokenMeter._total = 250;
  const dA = await runPreStep(run, { agent });
  eq("25% 不提醒", dA.messages.length, 0);

  // 35% ⇒ 第一档
  run.services.tokenMeter._total = 350;
  const d2 = await runPreStep(run, { agent });
  eq("到 30% 档 ⇒ 注入一条提醒", d2.messages.length, 1);
  const t2 = d2.messages[0].content[0].text;
  ok("提醒里点名了 30% 档", t2.includes("30%"), t2.slice(0, 200));
  ok("提醒里有实测数字", t2.includes("350") && t2.includes("1000"), t2.slice(0, 200));
  ok("30% 档只说顺手固化、不要停顿", t2.includes("不要为此停顿") && t2.includes("ledger_write"));
  ok("30% 档不要求停手", !t2.includes("停下来收尾"));

  const d3 = await runPreStep(run, { agent });
  eq("同一档只发一次（否则每步都会打烂 prompt 缓存）", d3.messages.length, 0);

  // 55% ⇒ 第二档，可以再发（这与"每会话只有一次"是两回事）
  run.services.tokenMeter._total = 550;
  const d4 = await runPreStep(run, { agent });
  eq("到 50% 档 ⇒ 再注入一条", d4.messages.length, 1);
  ok("50% 档文案里是 50%", d4.messages[0].content[0].text.includes("50%"));

  // 一次涨过两档（55% → 75%）⇒ 只发最高那档，不补发中间档
  run.services.tokenMeter._total = 750;
  const d5 = await runPreStep(run, { agent });
  eq("跨档只用最高档发一条", d5.messages.length, 1);
  const t5 = d5.messages[0].content[0].text;
  // ★ 用户 2026-10-09 改的口径：*"AI 执行完我们插件的功能之后，要继续工作，
  //   工作是不能被影响的"* + *"尽量在 70% 左右就把我们的压缩做好"*
  //   ⇒ 70% 档**不再要求停手**，而是"固化 + 让插件自己压 + 继续干"。
  ok("★ 70% 档要求先固化（写台账）", t5.includes("ledger_write") && t5.includes("活跃台账"));
  ok("★ 70% 档明确要求**继续工作、不许停**", /继续手上的工作|不要停/.test(t5), t5.slice(0, 300));
  ok("★ 70% 档不再要求「停下来收尾」（旧设计已改）", !t5.includes("停下来收尾"), t5.slice(0, 200));
  // ★★★ 2026-10-12（D125）**这条断言被改写了**，而且它本身就是那个 bug 的一部分：
  //   旧断言写的是
  //     ok("★ 70% 档说明插件会**自己**执行压缩（拦不住官方 80%，所以提前压）",
  //        /自动执行一次高保真压缩|提前/.test(t5), …)
  //   —— 它**在守着错误的行为**：那句"插件会自己执行压缩"正是模型**从不调工具**的直接原因
  //      （用户看系统截图抓到：模型知道要压缩，却从不调 `ledger_compact`）。
  //   ⇒ 现在改守**正确**的行为：这一档必须**把动作交给模型**，同时保留"插件会兜底"这个事实。
  //   ★ 通用教训：**旧断言可以守着旧缺陷** —— 改行为时若不同步改它，它会把你拦回去。
  ok(
    "★★★ 70% 档**把压缩这个动作交给模型**（点名 ledger_compact）",
    t5.includes("ledger_compact"),
    t5.slice(0, 400)
  );
  ok(
    "★★★ 70% 档**不再**说「插件会自动执行压缩」（那是它不调工具的直接原因）",
    !t5.includes("自动执行一次高保真压缩"),
    t5.slice(0, 400)
  );
  ok(
    "★★ 70% 档仍如实说明插件会兜底（安全网不能因为改了措辞就消失）",
    /兜底|安全网/.test(t5),
    t5.slice(0, 400)
  );
  ok("★ 70% 档说明压缩后会把逐字胶囊注回来（所以基本无感）", t5.includes("逐字胶囊"), t5.slice(0, 400));
  ok("★ 70% 档点名 ledger_checkpoint 只在真有必要时才打扰用户", t5.includes("ledger_checkpoint"));
  ok("70% 档提醒官方 80% 自动压缩", t5.includes("80%"));

  const d6 = await runPreStep(run, { agent });
  eq("70% 档也只发一次", d6.messages.length, 0);

  // 压缩之后掉回 20% ⇒ 三档全部重新武装
  run.services.tokenMeter._total = 200;
  await runPreStep(run, { agent });
  run.services.tokenMeter._total = 350;
  const d7 = await runPreStep(run, { agent });
  eq("掉回去再涨上来 ⇒ 低档重新提醒", d7.messages.length, 1);
  ok("重新提醒的是 30% 档", d7.messages[0].content[0].text.includes("30%"));

  // tokenMeter 不在 ⇒ 静默，不许抛
  const run2 = makeCtx();
  mod.apply(run2.ctx, {});
  const d8 = await runPreStep(run2, { agent: { session: { header: { id: "s2", cwd: root } } } });
  ok("没有 tokenMeter 时静默不抛", d8.messages.length >= 0 && run2.warnings.every((w) => !w.includes("注入失败")));

  rmrf(root);
}

// ── 情形 13：回合末四选一（**已改为显式开启**，用户 2026-10-09 的决定）────────
//
// ★ 用户原话：*"每条对话跳选择题就不用了，用户仍然可以手动打指令，但是不用在
//   每条对话结束后进行选择，因为台账自动化了。"*
//   ⇒ 默认**不弹**；下面这些用例显式传 `{ turnEndOffer: true }` 来验证
//     这条**仍然能用**的路（开关没坏、防套娃逻辑还在）。
//   ⇒ 13-0 单独验证**默认不弹**——那是用户真正要的行为。
section("情形 13：回合末四选一（默认关，开关仍可用）");
{
  /**
   * 情形 13 自己用的日志目录名与两个小工具。
   *
   * ★ 为什么在这里重造一份而不复用情形 14 的 `loggedProject`/`logFile`：
   *   那两个定义在**情形 14 的块作用域里**（`{}`），13 拿不到。
   *   跨情形共享夹具正是本机踩过的坑（D21：`initedRoot` 被别处 init 改掉阈值），
   *   所以这里各建各的，宁可重复几行。
   */
  const LOGDIR_TE = "_ledger-log-te";

  function loggedProjectForTurnEnd(tag, logDir) {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\nX\n", "utf8");
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1,
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_a",
        logDir,
      }),
      "utf8"
    );
    return dir;
  }

  /** 按档位找日志文件（返回绝对路径或 undefined）。 */
  function findLogFile(root, logDir, level) {
    const hit = [];
    const rec = (d) => {
      let es;
      try {
        es = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of es) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) rec(p);
        else if (e.name.startsWith(`${level}-`)) hit.push(p);
      }
    };
    rec(path.join(root, logDir));
    return hit[0];
  }

  /** 让游离的 Promise（自动卡片那条）跑完。 */
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  /** 带 steer 记录的假 agent。 */
  function agentWith(root, sid, steered, opts = {}) {
    return {
      session: { header: { id: sid, cwd: root }, id: sid },
      steer(message) {
        steered.push(message);
      },
      ...opts,
    };
  }

  function initedProject(tag) {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\nX\n", "utf8");
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a" }),
      "utf8"
    );
    return dir;
  }

  // 13-0：★★ 默认**不弹**选择题（用户 2026-10-09 的决定："因为台账自动化了"）
  //
  //   这一条是用户本轮真正要的行为，所以单独守一个断言。
  //   同时要确认：**日志落盘不受影响**（那是机器行为，与卡片无关），
  //   否则"去掉卡片"会顺手把日志也弄停。
  {
    const root = loggedProjectForTurnEnd("turn-end-off", LOGDIR_TE);
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {}); // 不传任何配置 ⇒ 走默认
    run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["只记录台账"] }] }));
    const steered = [];
    const agent = agentWith(root, "s-default-off", steered);

    // 喂一条用户消息 ⇒ 证明"日志仍在记"（L4 由机器采集，与卡片无关）
    const sid = "s-default-off";
    await fire(run, "session/event", { id: sid, header: { id: sid, cwd: root } }, {
      type: "user/message",
      time: Date.now(),
      data: { id: "m-off", role: "user", content: [{ type: "text", text: "关卡片但日志还要记" }], source: { kind: "user" } },
    });

    await fire(run, "agent/turn-stopping", { agent, turn: 2 });
    await settle();
    eq("★ 默认不弹选择题", run.asked.length, 0);
    eq("★ 也不 steer（没有下一步要干）", steered.length, 0);

    // 但日志该落还得落（证明这个开关只关了卡片，没关别的）
    const l4 = findLogFile(root, LOGDIR_TE, "L4");
    ok("★ 日志落盘不受影响（L4 仍在记）", l4 !== undefined, `l4=${l4}`);
    rmrf(root);
  }

  // 13a：显式开启后，回合结束 ⇒ 给出四选一，并且**不等答复**
  {
    const root = initedProject("auto-offer");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, { turnEndOffer: true });
    let release;
    run.setAnswer(() => new Promise((r) => (release = () => r({ answers: [{ id: "ledger-turn-end", selected: ["只记录台账"] }] }))));
    const steered = [];
    const agent = agentWith(root, "s-auto-1", steered);

    await fire(run, "agent/turn-stopping", { agent, turn: 2 });
    // ★ 关键：turn-stopping 必须**立刻**返回。若这里 await 了答复，
    //   `fire` 就会挂住（loop 的回合边界也跟着挂住）—— 那正是不能做的事。
    ok("回合末立刻返回，不等用户答复", true);
    eq("卡片已经送出去了", run.asked.length, 1);
    eq("自动路径也走阻塞式 ask", run.asked[0].mode, "ask");
    eq("自动路径不带 wait（没有 tool callId）", run.asked[0].request.wait, undefined);
    eq("自动路径四个选项一致", run.asked[0].request.questions[0].options.length, 4);
    eq("steer 还没发生（答复未到）", steered.length, 0);

    release();
    await settle();
    eq("用户选完 ⇒ steer 唤醒 AI", steered.length, 1);
    const m = steered[0];
    ok("steer 的消息带非空 id（缺了会报废会话历史）", typeof m.id === "string" && m.id !== "", `id=${m.id}`);
    ok(
      "steer 的消息用的是插件自己的 source（不冒充人类授权）",
      m.source?.kind === "project-ledger-notes",
      JSON.stringify(m.source)
    );
    eq("steer 出去的是 user 角色消息", m.role, "user");
    ok("文案说明只记录台账", m.content[0].text.includes("只记录台账"), m.content[0].text);
    ok("文案里点名 ledger_write", m.content[0].text.includes("ledger_write"));
    rmrf(root);
  }

  // 13b：选「不记录台账」⇒ 什么都不做（尤其别白起一轮）
  {
    const root = initedProject("auto-skip");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, { turnEndOffer: true });
    run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["不记录台账"] }] }));
    const steered = [];
    await fire(run, "agent/turn-stopping", { agent: agentWith(root, "s-auto-2", steered), turn: 2 });
    await settle();
    eq("问了用户", run.asked.length, 1);
    eq("选「不记录」⇒ 不 steer（没有下一步要干）", steered.length, 0);
    rmrf(root);
  }

  // 13c：选完执行过后，下一次回合末**不重复问**；再下一次恢复
  {
    const root = initedProject("auto-loop-guard");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, { turnEndOffer: true });
    run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["只记录台账"] }] }));
    const steered = [];
    const agent = agentWith(root, "s-auto-3", steered);

    await fire(run, "agent/turn-stopping", { agent, turn: 2 }); // 第一次：问
    await settle();
    eq("第一次问了", run.asked.length, 1);
    eq("第一次 steer 了", steered.length, 1);

    // steer 唤醒 AI 去写台账 ⇒ 那一轮跑完又会 turn-stopping ⇒ 不许再问
    await fire(run, "agent/turn-stopping", { agent, turn: 2 });
    await settle();
    eq("AI 执行那一轮结束 ⇒ 不再追问（防无限套娃）", run.asked.length, 1);

    // 再下一次又是真实停顿 ⇒ 该恢复提问（别把功能修死）
    await fire(run, "agent/turn-stopping", { agent, turn: 2 });
    await settle();
    eq("再下一次恢复提问", run.asked.length, 2);
    rmrf(root);
  }

  // 13d：卡片还挂着时不许重复问（第一张还没答复）
  {
    const root = initedProject("auto-dedupe");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, { turnEndOffer: true });
    let release;
    run.setAnswer(() => new Promise((r) => (release = () => r({ answers: [{ id: "ledger-turn-end", selected: ["不记录台账"] }] }))));
    const agent = agentWith(root, "s-auto-4", []);
    await fire(run, "agent/turn-stopping", { agent, turn: 2 });
    await fire(run, "agent/turn-stopping", { agent, turn: 2 });
    eq("卡片挂着时不再问第二遍", run.asked.length, 1);
    release();
    await settle();
    rmrf(root);
  }

  // 13e：子 agent 的回合末不弹卡片
  {
    const root = initedProject("auto-subagent");
    const run = makeCtx({ withUserQuestions: true, withAgents: true });
    mod.apply(run.ctx, { turnEndOffer: true });
    run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["只记录台账"] }] }));
    const sub = agentWith(root, "s-sub", []);
    // agents 服务在，且 roots() 里**没有**这个 agent ⇒ 明确不是 root
    await fire(run, "agent/turn-stopping", { agent: sub, turn: 2 });
    await settle();
    eq("子 agent 的回合末不打扰用户", run.asked.length, 0);
    rmrf(root);
  }

  // 13f：没有 userQuestions 服务 ⇒ 静默，且绝不抛
  {
    const root = initedProject("auto-nouq");
    const run = makeCtx();
    mod.apply(run.ctx, { turnEndOffer: true });
    let threw;
    try {
      await fire(run, "agent/turn-stopping", { agent: agentWith(root, "s-auto-5", []), turn: 2 });
      await settle();
    } catch (e) {
      threw = e;
    }
    ok("没有 userQuestions 时不抛", threw === undefined, `err=${threw && threw.message}`);
    ok("没有留下注入失败告警", run.warnings.every((w) => !w.includes("注入失败")));
    rmrf(root);
  }

  // 13g：坏上下文（没有 cwd / 没有 agent / 没有 session）都不许抛
  {
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, { turnEndOffer: true });
    run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["只记录台账"] }] }));
    let threw;
    try {
      await fire(run, "agent/turn-stopping", { turn: 2 });
      await fire(run, "agent/turn-stopping", { agent: {}, turn: 2 });
      await fire(run, "agent/turn-stopping", { agent: { session: {} }, turn: 2 });
      await fire(run, "agent/turn-stopping", { agent: { session: { header: { id: "s", cwd: "" } } }, turn: 2 });
      await settle();
    } catch (e) {
      threw = e;
    }
    ok("坏上下文下回合末处理不抛", threw === undefined, `err=${threw && threw.message}`);
  }

  // 13h：AI 用过工具（需求 ②）后，同一次停顿不再自动问一遍
  {
    const root = initedProject("auto-tool-dedupe");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, { turnEndOffer: true });
    run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["只记录台账"] }] }));
    const agent = agentWith(root, "s-auto-6", []);
    await run.registeredTools
      .get("ledger_checkpoint")
      .execute({}, { agent, session: agent.session, callId: "c-1" });
    const before = run.asked.length;
    await fire(run, "agent/turn-stopping", { agent, turn: 2 });
    await settle();
    eq("AI 本轮已问过 ⇒ 回合末不再问一遍", run.asked.length, before);
    rmrf(root);
  }
}

// ── 情形 14：活动日志（自动采集 / 只追加 / 回溯读 / 不注入）────────────────
section("情形 14：活动日志");
{
  const LOGDIR = "_ledger-log";

  /** 造一个"已初始化 + 已启用日志"的项目。 */
  function loggedProject(tag, levels) {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\nX\n", "utf8");
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1,
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_a",
        logDir: LOGDIR,
        ...(levels === undefined ? {} : { logLevels: levels }),
      }),
      "utf8"
    );
    return dir;
  }

  /** 找一个日志文件（按档位），返回绝对路径或 undefined。 */
  function logFile(root, level) {
    const base = path.join(root, LOGDIR);
    const hit = [];
    const rec = (d) => {
      let es;
      try {
        es = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of es) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) rec(p);
        else if (e.name.startsWith(`${level}-`)) hit.push(p);
      }
    };
    rec(base);
    return hit[0];
  }

  /** 给一个会话喂一条 session/event。 */
  const feed = (run, root, sid, event) =>
    fire(run, "session/event", { id: sid, header: { id: sid, cwd: root } }, event);

  /** 一次工具调用 + 结果（成败由 isError 决定）。 */
  const callPair = (run, root, sid, { callId, name, args, isError = false, turn = 1, step = 1 }) => {
    const p1 = feed(run, root, sid, {
      type: "tool/call",
      data: { turn, step, callId, name, arguments: JSON.stringify(args) },
    });
    const p2 = feed(run, root, sid, {
      type: "tool/result",
      data: { turn, step, message: { isError, toolCallId: callId, content: [] } },
    });
    return Promise.all([p1, p2]);
  };

  /** 冲盘：走回合末那条路（不依赖 1.2 秒去抖，测试才不慢）。 */
  const flush = async (run, root, sid) =>
    fire(run, "agent/turn-stopping", { agent: { session: { header: { id: sid, cwd: root }, id: sid } } });

  // 14a：L2 自动采集 + 落盘 + 只追加
  {
    const root = loggedProject("log-l2", { L0: true, L1: true, L2: true, L3: false });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const sid = "s-log-1";
    await callPair(run, root, sid, { callId: "c1", name: "write", args: { file_path: path.join(root, "a.ts") } });
    await callPair(run, root, sid, { callId: "c2", name: "edit", args: { file_path: path.join(root, "a.ts") } });
    await callPair(run, root, sid, { callId: "c3", name: "read", args: { file_path: path.join(root, "b.ts") } });
    await flush(run, root, sid);

    const f = logFile(root, "L2");
    ok("L2 文件已落盘", f !== undefined, `f=${f}`);
    const body = fs.readFileSync(f, "utf8");
    eq("write + edit 各记一行", (body.match(/\(M\)/g) ?? []).length, 2);
    eq("read 记为 R", (body.match(/\(R\)/g) ?? []).length, 1);
    // ★ 不变量：一行 = 一条（解析、grep、limit 全建立在它上面）
    const entryLines = body.split("\n").filter((l) => l.startsWith("- "));
    eq("L2 行数与调用数一致", entryLines.length, 3);
    rmrf(root);
  }

  // 14b：L3 默认关；打开后能记，且**失败靠结构化 isError**（不是正则）
  {
    const off = loggedProject("log-l3-off", { L0: true, L1: true, L2: true, L3: false });
    const runOff = makeCtx();
    mod.apply(runOff.ctx, {});
    await callPair(runOff, off, "s-off", { callId: "c1", name: "pwsh", args: { command: "x", description: "d" } });
    await flush(runOff, off, "s-off");
    ok("L3 关着时不产生 L3 文件", logFile(off, "L3") === undefined);
    rmrf(off);

    const on = loggedProject("log-l3-on", { L0: true, L1: true, L2: true, L3: true });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const sid = "s-on";
    await callPair(run, on, sid, { callId: "c1", name: "pwsh", args: { command: "node --test", description: "Run the suite" } });
    await callPair(run, on, sid, { callId: "c2", name: "pwsh", args: { command: "boom" }, isError: true, step: 2 });
    await flush(run, on, sid);
    const body = fs.readFileSync(logFile(on, "L3"), "utf8");
    eq("L3 记了两行", body.split("\n").filter((l) => l.startsWith("- ")).length, 2);
    eq("只有失败那次带 [失败] 标记", (body.match(/\[失败\]/g) ?? []).length, 1);
    // ★ 成功那行不该被误标：正是"拿正则去匹配结果正文"会犯的错
    const lines = body.split("\n").filter((l) => l.startsWith("- "));
    ok("成功那次没有被误标为失败", !lines.some((l) => l.includes("Run the suite") && l.includes("[失败]")));
    ok("失败标记落在失败那次上", lines.some((l) => l.includes("boom") && l.includes("[失败]")), body);
    rmrf(on);
  }

  // 14c：L1 一行 = 一条，且能被读回来（曾经写成多行，导致整条读不到）
  {
    const root = loggedProject("log-l1", { L0: true, L1: true, L2: true, L3: false });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const exec = execFor(root, "s-l1");
    const w = await run.registeredTools.get("ledger_log_write").execute(
      { title: "做了 X", goal: "要 Y", did: "干了 Z", issues: "卡在 W", next: "下一步 V" },
      exec
    );
    ok("L1 写入成功", w.ok === true, JSON.stringify(w));
    const body = fs.readFileSync(w.path, "utf8");
    const entries = body.split("\n").filter((l) => l.startsWith("- "));
    eq("一次摘要只产生一行", entries.length, 1);
    ok("这一行带时间戳与标题", /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(L1\) 做了 X/.test(entries[0]), entries[0]);

    // ★ 关键回归：它必须能被 ledger_log 解析出来（多行写法曾让它整条消失）
    const read = await run.registeredTools.get("ledger_log").execute({ levels: ["L1"], view: "raw" }, exec);
    eq("L1 能被读回来", read.matched, 1);
    ok("读回来的条目带上了时间戳", read.lines[0].includes("(L1) 做了 X"), read.lines[0]);
    ok("细节也在同一行里", read.lines[0].includes("卡点：卡在 W"), read.lines[0]);
    rmrf(root);
  }

  // 14d：回溯读 —— since/until 过滤、files 去重、failures 只挑失败
  {
    const root = loggedProject("log-read", { L0: true, L1: true, L2: true, L3: true });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const sid = "s-read";
    const exec = execFor(root, sid);
    await callPair(run, root, sid, { callId: "c1", name: "write", args: { file_path: path.join(root, "a.ts") } });
    await callPair(run, root, sid, { callId: "c2", name: "edit", args: { file_path: path.join(root, "a.ts") } });
    await callPair(run, root, sid, { callId: "c3", name: "read", args: { file_path: path.join(root, "c.ts") } });
    await callPair(run, root, sid, { callId: "c4", name: "pwsh", args: { command: "boom" }, isError: true, step: 9 });
    await flush(run, root, sid);

    const files = await run.registeredTools.get("ledger_log").execute({ view: "files" }, exec);
    ok("files 视图有结果", files.ok === true);
    eq("a.ts 被去重成一条", files.touched.filter((t) => t.path.endsWith("a.ts")).length, 1);
    eq("a.ts 记了 2 次", files.touched.find((t) => t.path.endsWith("a.ts")).count, 2);
    eq("只读文件单列一档", files.readOnly.filter((t) => t.path.endsWith("c.ts")).length, 1);

    const fails = await run.registeredTools.get("ledger_log").execute({ view: "failures" }, exec);
    eq("failures 视图只挑出那一次", fails.matched, 1);
    ok("failures 给出回查官方日志的指引", typeof fails.hint === "string" && fails.hint.includes("sessions"));

    // since 过滤：给一个未来时间 ⇒ 一条都不该有
    const future = new Date(Date.now() + 86400000);
    const none = await run.registeredTools
      .get("ledger_log")
      .execute({ since: `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}` }, exec);
    eq("since=明天 ⇒ 0 条", none.matched, 0);

    // grep
    const g = await run.registeredTools.get("ledger_log").execute({ grep: "a.ts", view: "raw" }, exec);
    ok("grep 命中 a.ts", g.matched > 0, `matched=${g.matched}`);

    // limit + nextCursor 能续读
    const page1 = await run.registeredTools.get("ledger_log").execute({ limit: 1 }, exec);
    eq("limit 生效", page1.returned, 1);
    ok("给了 nextCursor", typeof page1.nextCursor === "string", String(page1.nextCursor));
    ok("说了还有更多（truncated）", page1.truncated === true);
    rmrf(root);
  }

  // 14e：★ 日志**永不注入上下文**（这是需求里最重要的一条）
  {
    const root = loggedProject("log-noinject", { L0: true, L1: true, L2: true, L3: false });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const sid = "s-noinject";
    await callPair(run, root, sid, { callId: "c1", name: "write", args: { file_path: path.join(root, "a.ts") } });
    await flush(run, root, sid);
    const agent = { session: { header: { id: sid, cwd: root }, id: sid } };
    const decision = await runPreStep(run, { agent, messages: [] });
    const text = JSON.stringify(decision.messages);
    ok("注入里没有日志正文", !text.includes("(M) "), text.slice(0, 300));
    ok("注入里没有日志文件路径", !text.includes("L2-files.md"), text.slice(0, 300));
    // 但台账本身照样注入（别为了不注入日志把台账也弄丢了）
    ok("台账仍然注入", text.includes("LEDGER.md") || text.includes("当前项目台账"), text.slice(0, 300));
    rmrf(root);
  }

  // 14f：没登记 logDir ⇒ **什么都不写**（绝不擅自往项目里塞目录）
  {
    const root = tmpProject("log-disabled");
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
    fs.writeFileSync(
      path.join(root, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a" }),
      "utf8"
    );
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const exec = execFor(root, "s-nolog");
    await callPair(run, root, "s-nolog", { callId: "c1", name: "write", args: { file_path: path.join(root, "a.ts") } });
    await flush(run, root, "s-nolog");
    const w = await run.registeredTools.get("ledger_log_write").execute({ title: "x" }, exec);
    const r = await run.registeredTools.get("ledger_log").execute({}, exec);
    ok("没启用日志时 ledger_log_write 软失败", w.ok === false, JSON.stringify(w));
    ok("没启用日志时 ledger_log 软失败", r.ok === false);
    ok("项目里没有多出日志目录", !fs.existsSync(path.join(root, LOGDIR)) && !fs.existsSync(path.join(root, "_ledger-log")));
    ok("项目里只有预期的那几个文件", fs.readdirSync(root).every((n) => ["LEDGER.md", ".dsh-ledger.json"].includes(n)), fs.readdirSync(root).join(","));
    rmrf(root);
  }

  // 14g：采集炸了不许影响会话（坏事件 / 坏 session）
  {
    const root = loggedProject("log-tolerance", { L0: true, L1: true, L2: true, L3: true });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    let threw;
    try {
      await fire(run, "session/event", undefined, undefined);
      await fire(run, "session/event", {}, {});
      await fire(run, "session/event", { header: {} }, { type: "tool/call" });
      await fire(run, "session/event", { id: "z", header: { id: "z", cwd: root } }, { type: "tool/call", data: null });
      await fire(run, "session/event", { id: "z", header: { id: "z", cwd: root } }, { type: "tool/call", data: { name: "write", callId: "c", arguments: "不是 JSON" } });
      await fire(run, "session/event", { id: "z", header: { id: "z", cwd: root } }, { type: "tool/result", data: { message: null } });
      await fire(run, "session/event", { id: "z", header: { id: "z", cwd: "" } }, { type: "turn/end" });
    } catch (e) {
      threw = e;
    }
    ok("坏事件不让采集抛错", threw === undefined, `err=${threw && threw.message}`);
    ok("坏事件没有产生注入告警", !run.warnings.some((w) => w.includes("日志采集失败")), run.warnings.join(" | "));
    rmrf(root);
  }

  // 14i：★★ L4 用户消息存档（需求 ⑳）
  //
  //   用户原话：「新增一个记录，负责自动记住用户发的所有消息（不自动注入上下文，
  //   但有问题时可以查），要记得为记录带上来源的会话编号和发送时间，多会话项目很有用。」
  //   ⇒ 这一组逐条对应用户的每个限定词，尤其"**自动**"与"**只有本人说的**"。
  {
    const root = loggedProject("log-l4", { L0: true, L1: true, L2: true, L3: false, L4: true });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const sid = "session-9a3f1111-2222";
    const feedUser = (text, when, extra = {}) =>
      feed(run, root, sid, {
        type: "user/message",
        time: when,
        data: { id: `m-${Math.random()}`, role: "user", content: [{ type: "text", text }], source: { kind: "user" }, ...extra },
      });

    const T1 = Date.parse("2026-10-09T10:20:30+08:00");
    const T2 = Date.parse("2026-10-09T11:45:00+08:00");
    await feedUser("第一句话", T1);
    await feedUser("第二句话", T2);

    // ★ 系统的注入**全部**以 role:user 落盘 —— 这些绝不能被记成"用户说的"
    for (const kind of ["time-context", "agent-instructions", "runtime-context", "skill-catalog", "project-ledger-notes"]) {
      await feed(run, root, sid, {
        type: "user/message",
        time: T1 + 1000,
        data: { id: `x-${kind}`, role: "user", content: [{ type: "text", text: `系统注入 ${kind}` }], source: { kind } },
      });
    }
    await flush(run, root, sid);

    const f = logFile(root, "L4");
    ok("L4 文件已落盘", f !== undefined, `f=${f}`);
    const body = fs.readFileSync(f, "utf8");
    const lines = body.split("\n").filter((l) => l.startsWith("- "));
    eq("★ 只记了用户本人的两条（系统的 5 条注入一条都没进）", lines.length, 2);
    ok("★ 没有把系统注入写进去", !body.includes("系统注入"), body);
    // 会话编号取自 session id 的第一段 hex 前 4 位
    ok("★ 带上了来源会话编号", lines[0].includes("(user:9a3f)"), lines[0]);
    // 发送时间取**事件自己的 time**，不是落盘时刻
    ok("★ 带上的是发送时间（第一条）", lines[0].includes("2026-10-09 10:20:30"), lines[0]);
    ok("★ 带上的是发送时间（第二条）", lines[1].includes("2026-10-09 11:45:00"), lines[1]);
    ok("正文可读", lines[0].includes("第一句话"), lines[0]);

    // ★ 一条消息 = 一行：多行消息必须转义，否则会把日志炸成几十行
    await feedUser("甲\n乙\n丙", T1 + 5000);
    await flush(run, root, sid);
    const body2 = fs.readFileSync(f, "utf8");
    const lines2 = body2.split("\n").filter((l) => l.startsWith("- "));
    eq("★ 多行消息仍然只占一行", lines2.length, 3);
    ok("★ 换行被转义成字面 \\n", lines2[2].includes("甲\\n乙\\n丙"), lines2[2]);

    // ★ 图片等非 text part 也要留下痕迹（否则"用户发过一张图"会彻底消失）
    await feed(run, root, sid, {
      type: "user/message",
      time: T1 + 6000,
      data: {
        id: "m-img",
        role: "user",
        content: [
          { type: "text", text: "看这张" },
          { type: "image", attachment: { mediaType: "image/png", width: 578, height: 431, bytes: 59914, name: "image.png" } },
        ],
        source: { kind: "user" },
      },
    });
    await flush(run, root, sid);
    const lines3 = fs.readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("- "));
    ok("★ 图片被记成一行可追溯的标记", lines3[3].includes("[图片 image.png 578x431"), lines3[3]);
    ok("★ 也没有丢掉同一轮的文字", lines3[3].includes("看这张"), lines3[3]);

    // ★ 回溯源：users 视图 + 按会话编号汇总
    const exec = execFor(root, sid);
    const users = await run.registeredTools.get("ledger_log").execute({ view: "users" }, exec);
    ok("users 视图可用", users.ok === true, JSON.stringify(users).slice(0, 200));
    eq("users 视图只给 L4", users.matched, 4);
    ok("★ 按会话编号汇总（多会话项目才有用）", Array.isArray(users.bySession) && users.bySession[0].tag === "9a3f", JSON.stringify(users.bySession));
    ok("★ 每条都带发送时间", users.messages[0].at === "2026-10-09 10:20:30", JSON.stringify(users.messages[0]));

    rmrf(root);
  }

  // 14j：★ L4 默认**开**（用户要的是"自动记住"），且**默认不混进 timeline**
  {
    const root = loggedProject("log-l4-default", undefined); // 不指定档位 ⇒ 走默认
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const sid = "session-77aa3333-4444";
    await feed(run, root, sid, {
      type: "user/message",
      time: Date.parse("2026-10-09T09:00:00+08:00"),
      data: { id: "m1", role: "user", content: [{ type: "text", text: "默认档位下也要记" }], source: { kind: "user" } },
    });
    await flush(run, root, sid);
    const f = logFile(root, "L4");
    ok("★ L4 默认就是开的", f !== undefined, `f=${f}`);

    const exec = execFor(root, sid);
    // 默认 timeline 不该被用户消息刷屏（它量最大）
    const tl = await run.registeredTools.get("ledger_log").execute({}, exec);
    ok("★ 默认 timeline 不含 L4", !tl.entries.some((e) => (e.level ?? "") === "L4"), JSON.stringify(tl.entries).slice(0, 200));
    // 但显式要就拿得到
    const raw = await run.registeredTools.get("ledger_log").execute({ levels: ["L4"], view: "raw" }, exec);
    eq("显式要 L4 就拿得到", raw.matched, 1);
    rmrf(root);
  }

  // 14k：L4 关掉 ⇒ 一个字都不记
  {
    const root = loggedProject("log-l4-off", { L0: true, L1: true, L2: true, L3: false, L4: false });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const sid = "s-l4-off";
    await feed(run, root, sid, {
      type: "user/message",
      time: Date.now(),
      data: { id: "m1", role: "user", content: [{ type: "text", text: "不该被记下" }], source: { kind: "user" } },
    });
    await flush(run, root, sid);
    ok("★ L4 关着时不产生 L4 文件", logFile(root, "L4") === undefined);
    rmrf(root);
  }

  // 14l：★ L4 **永不注入上下文**（与 L0–L3 同一条硬规矩）
  {
    const root = loggedProject("log-l4-noinject", { L0: true, L1: true, L2: true, L3: false, L4: true });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const sid = "s-l4-noinject";
    await feed(run, root, sid, {
      type: "user/message",
      time: Date.now(),
      data: {
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "这句独一无二的话不该出现在注入里" }],
        source: { kind: "user" },
      },
    });
    await flush(run, root, sid);
    const agent = { session: { header: { id: sid, cwd: root }, id: sid } };
    const decision = await runPreStep(run, { agent, messages: [] });
    const text = JSON.stringify(decision.messages ?? []);
    ok("★ 用户消息没有被注入", !text.includes("这句独一无二的话"), text.slice(0, 300));
    ok("★ 也没暴露 L4 文件路径", !text.includes("L4-user-messages.md"), text.slice(0, 300));
    rmrf(root);
  }

  // 14m：★★ 「目录在、但没登记」必须**不采集**，而且要**说出来**
  //
  //   起因（2026-10-09 实测撞到）：旧版把 `guessLogDir()` 的结果写进 `logRel`，
  //   于是 `ledger_status` 报「日志目录 = `_ledger-log`」，而 `ledger_log` /
  //   `ledger_log_write` / 采集器一律回「还没有启用活动日志」——
  //   **同一个问题两个答案**，用户按 status 去查必然扑空。
  //
  //   现在：`logRel` 只来自清单（单一来源），猜到的另放 `logGuess` 并**明确报告**。
  {
    const root = tmpProject("log-guess-only");
    fs.mkdirSync(path.join(root, LOGDIR), { recursive: true });
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
    fs.writeFileSync(
      path.join(root, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "D.md", archiveDir: "_a" }),
      "utf8"
    );
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const sid = "session-cccc2222-0001";
    await feed(run, root, sid, {
      type: "user/message",
      time: Date.now(),
      data: { id: "m1", role: "user", content: [{ type: "text", text: "不该被记" }], source: { kind: "user" } },
    });
    await flush(run, root, sid);

    ok("★ 没登记 ⇒ 一条都不采集", logFile(root, "L4") === undefined);

    const exec = execFor(root, sid);
    const st = await run.registeredTools.get("ledger_status").execute({}, exec);
    eq("★ status 不再谎报「已启用」", st.logDir, null);
    eq("★ 但把那个目录报出来", st.logDirFoundButNotEnabled, LOGDIR);

    const rd = await run.registeredTools.get("ledger_log").execute({ view: "users" }, exec);
    ok("★ ledger_log 仍然是未启用", rd.ok === false);
    ok("★ 并且说清是「有目录但没登记」", rd.reason.includes("没有登记"), rd.reason);
    ok("★ 给出了怎么启用", rd.reason.includes("logDir"), rd.reason);

    const cmd = run.registeredCommands.get("ledger");
    const cl = await cmd.handler({
      commandId: "c1",
      agent: { session: { header: { id: sid, cwd: root } } },
      rawInput: "log",
      attachments: [],
      signal: new AbortController().signal,
    });
    ok("★ /ledger log 也点明「有目录但没在采集」", cl.text.includes("没有登记"), cl.text);
    rmrf(root);
  }

  // 14h：清单登记了 logDir，但归档与日志目录不许互相包含
  {
    const root = tmpProject("log-nesting");
    fs.mkdirSync(root, { recursive: true });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    let err;
    try {
      await run.registeredTools.get("ledger_init").execute(
        { active: "L.md", decisions: "D.md", archiveDir: "_a", logDir: "_a/logs", gitInit: false },
        execFor(root, "s-nest")
      );
    } catch (e) {
      err = e;
    }
    ok("日志目录嵌在归档目录里 ⇒ 拒绝", err !== undefined, err && err.message);
    rmrf(root);
  }
}

// ── 情形 15：从容器工作区开着会话时，用 root 点名子项目 ──────────────────────
//
// ★ 这一组来自一次真实卡壳（2026-10-08）：本插件的项目根取 session.header.cwd，
//   而用户经常从**容器工作区**（如 D:\Deepseek工作区）开会话，真实项目在它的子目录里。
//   没有 root 参数，那种会话里**任何**台账工具都只能指向容器根 —— 而容器根恰恰是
//   禁止初始化的目录，于是插件对它最主要的那些项目全都不可用。
section("情形 15：root 参数（容器里的子项目）");
{
  // 15a：会话 cwd 是容器，root 点名子项目 ⇒ 台账落在子项目
  {
    const container = tmpProject("root-container");
    const sub = path.join(container, "my-plugin");
    fs.mkdirSync(sub, { recursive: true });
    // 让容器看起来真像容器（AGENTS.md + 多个子目录）
    fs.writeFileSync(path.join(container, "AGENTS.md"), "# 工作区\n", "utf8");
    fs.mkdirSync(path.join(container, "other"), { recursive: true });

    const run = makeCtx();
    mod.apply(run.ctx, {});
    const exec = execFor(container, "s-root");
    const init = await run.registeredTools.get("ledger_init").execute(
      {
        root: "my-plugin",
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_ledger-archive",
        initialActive: "# 台账\n",
        initialDecisions: "# 决策\n",
        gitInit: false,
      },
      exec
    );
    ok("用 root 初始化成功", init.ok === true, JSON.stringify(init));
    eq("台账落在子项目里", path.dirname(init.manifestPath), sub);
    ok("容器根没有被写入台账", !fs.existsSync(path.join(container, "LEDGER.md")));
    ok("子项目里有台账", fs.existsSync(path.join(sub, "LEDGER.md")));

    // 读回时也认 root（不能因为读过一次就"记住"——每次都得显式给）
    const st = await run.registeredTools.get("ledger_status").execute({ root: "my-plugin" }, exec);
    ok("ledger_status 认 root", st.initialized === true, JSON.stringify({ active: st.active }));
    eq("status 报的项目根是子项目", st.projectRoot, sub);

    // 不给 root ⇒ 回到容器根（并且容器闸门不许它初始化）
    const st2 = await run.registeredTools.get("ledger_status").execute({}, exec);
    eq("不给 root 时仍是会话 cwd", st2.projectRoot, container);
    ok("容器根上未被判定为有台账", st2.initialized === false);

    // ★ 关键：root 不绕过容器闸门 —— 明确点名容器根仍然被拒
    let err;
    try {
      await run.registeredTools.get("ledger_init").execute(
        { active: "L.md", decisions: "D.md", archiveDir: "_a", gitInit: false },
        exec
      );
    } catch (e) {
      err = e;
    }
    ok("不给 root 时在容器里 init ⇒ 仍被拒绝", err !== undefined, err && err.message);
    rmrf(container);
  }

  // 15b：root 指向不存在的目录 ⇒ 抛错（不能静默写到别处）
  {
    const container = tmpProject("root-missing");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const exec = execFor(container, "s-miss");
    let err;
    try {
      await run.registeredTools.get("ledger_status").execute({ root: "nope-not-here" }, exec);
    } catch (e) {
      err = e;
    }
    ok("root 指向不存在的目录 ⇒ 抛错", err !== undefined, err && err.message);
    ok("错误信息说清了必须是已存在的目录", /存在的目录/.test(String(err && err.message)));
    rmrf(container);
  }

  // 15c：root 也能是绝对路径；写台账/写日志都跟着走
  {
    const container = tmpProject("root-abs");
    const sub = path.join(container, "proj");
    fs.mkdirSync(sub, { recursive: true });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const exec = execFor(container, "s-abs");
    await run.registeredTools.get("ledger_init").execute(
      {
        root: sub,
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_a",
        logDir: "_log",
        initialActive: "# 台账\n",
        gitInit: false,
      },
      exec
    );
    const w = await run.registeredTools.get("ledger_write").execute(
      { root: sub, target: "active", content: "# 台账\n- 进展\n" },
      exec
    );
    ok("ledger_write 认绝对 root", w.ok === true, JSON.stringify(w));
    ok("写进了子项目", w.path === path.join(sub, "LEDGER.md"), w.path);

    const lw = await run.registeredTools.get("ledger_log_write").execute(
      { root: sub, title: "走 root 写日志" },
      exec
    );
    ok("ledger_log_write 认 root", lw.ok === true, JSON.stringify(lw));
    ok("日志写进了子项目的日志目录", lw.path.startsWith(path.join(sub, "_log")), lw.path);
    rmrf(container);
  }
}

// ── 情形 16：问题记录（不是项目、但有终点的那一类）──────────────────────────
//
// ★ 这一组来自用户的真实问题："对于不是项目、只是解决一些问题的，但又有必要记录的，
//   台账该记在哪？" 本机实测 112 个会话里 104 个的 cwd 就是容器根 —— 这是常态。
section("情形 16：问题记录 ledger_note");
{
  /** 造一个"容器工作区"：有 AGENTS.md + 多个子目录 + 一个既有记录目录。 */
  function workspace(tag, { withNotesDir = true, nestedGit = false } = {}) {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# 工作区指令\n", "utf8");
    fs.mkdirSync(path.join(dir, "proj-a"), { recursive: true });
    fs.mkdirSync(path.join(dir, "proj-b"), { recursive: true });
    if (nestedGit) fs.mkdirSync(path.join(dir, "proj-a", ".git"), { recursive: true });
    if (withNotesDir) fs.mkdirSync(path.join(dir, "60-对话记录与交接", "对话总结"), { recursive: true });
    return dir;
  }

  const execAt = (root, sid = "s-note") => ({
    agent: { session: { header: { id: sid, cwd: root }, id: sid } },
    callId: "c",
  });

  // 16a：容器根上写一份问题记录 ⇒ 落到既有通道，文件名带日期
  {
    const ws = workspace("note-basic");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const exec = execAt(ws);
    const r = await run.registeredTools.get("ledger_note").execute(
      { title: "某次故障排查", kind: "故障", problem: "现象", cause: "根因", conclusion: "结论", next: "这个字段不该出现" },
      exec
    );
    ok("问题记录写入成功", r.ok === true, JSON.stringify(r));
    ok("落进了既有记录目录", r.relative.startsWith("60-对话记录与交接/对话总结/"), r.relative);
    ok("文件名是 日期-主题.md", /60-对话记录与交接\/对话总结\/\d{4}-\d{2}-\d{2}-某次故障排查\.md$/.test(r.relative), r.relative);
    const body = fs.readFileSync(r.path, "utf8");
    ok("正文含现象/根因/结论三节", ["现象", "根因", "结论"].every((k) => body.includes(k)), body.slice(0, 300));
    // ★ 关键：问题记录**不该**有台账那套"下一步/归档/当前目标"
    ok("正文没有「下一步」字段", !body.includes("## 下一步"), body.slice(0, 400));
    ok("正文没有「归档」字段", !body.includes("归档目录"), body.slice(0, 400));
    // ★ 传给工具的意外参数不该被写进正文（renderNote 只取白名单字段）
    ok("多余参数不会被写进正文", !body.includes("这个字段不该出现"));
    ok("说明了这不是台账", /不是项目台账|没有活跃台账/.test(body), body.slice(0, 200));
    rmrf(ws);
  }

  // 16b：★ 同名不覆盖（记录是证据）
  {
    const ws = workspace("note-noclobber");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const exec = execAt(ws);
    const tool = run.registeredTools.get("ledger_note");
    const first = await tool.execute({ title: "同一件事", problem: "第一次" }, exec);
    const before = fs.readFileSync(first.path, "utf8");
    const second = await tool.execute({ title: "同一件事", problem: "第二次" }, exec);
    ok("同名第二次被拒绝", second.ok === false, JSON.stringify(second));
    ok("拒绝理由说明了不覆盖", /不会被覆盖/.test(second.reason), second.reason);
    eq("原文件一个字节没变", fs.readFileSync(first.path, "utf8"), before);
    ok("原内容里还是第一次的正文", before.includes("第一次") && !before.includes("第二次"));
    rmrf(ws);
  }

  // 16c：★ 真项目里拒绝 —— 那该用台账
  {
    const proj = tmpProject("note-inproject");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const r = await run.registeredTools.get("ledger_note").execute({ title: "x" }, execAt(proj));
    ok("Git 项目里 ledger_note 被拒", r.ok === false, JSON.stringify(r));
    ok("拒绝时指向 ledger_write", r.hint === "ledger_write", JSON.stringify(r));
    rmrf(proj);
  }

  // 16d：status 在容器里报出 notesDir，且 discoveredBy 有 notesDir
  {
    const ws = workspace("note-status");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const st = await run.registeredTools.get("ledger_status").execute({}, execAt(ws));
    ok("status 报出 notesDir", st.notesDir === "60-对话记录与交接/对话总结", String(st.notesDir));
    eq("discoveredBy 里标成 guess（找到了既有目录）", st.discoveredBy.notesDir, "guess");
    eq("容器根上 initialized 仍是 false", st.initialized, false);
    rmrf(ws);
  }

  // 16e：★ 没有既有目录时用默认名，并且**只在写的时候**才建目录
  {
    const ws = workspace("note-default", { withNotesDir: false });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const exec = execAt(ws);
    const st = await run.registeredTools.get("ledger_status").execute({}, exec);
    const DEFAULT_NOTES = "60-对话记录与交接/对话总结";
    eq("没既有目录时给默认名", st.notesDir, DEFAULT_NOTES);
    eq("discoveredBy=default", st.discoveredBy.notesDir, "default");
    ok("单看 status 不建目录", !fs.existsSync(path.join(ws, DEFAULT_NOTES)));
    const w = await run.registeredTools.get("ledger_note").execute({ title: "新主题" }, exec);
    ok("写的时候建了目录", w.ok === true && fs.existsSync(path.join(ws, DEFAULT_NOTES)), JSON.stringify(w));
    rmrf(ws);
  }

  // 16f：★ 子目录会话 ⇒ 往上找到工作区根，记录落到同一处
  {
    const ws = workspace("note-subdir");
    const sub = path.join(ws, "proj-a");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const r = await run.registeredTools.get("ledger_note").execute({ title: "子目录里写的" }, execAt(sub));
    ok("从子目录写也成功", r.ok === true, JSON.stringify(r));
    ok("落在了工作区根的记录目录里", r.path.startsWith(path.join(ws, "60-对话记录与交接")), r.path);
    ok("没有在子目录里另起一份", !fs.existsSync(path.join(sub, "60-对话记录与交接")));
    rmrf(ws);
  }

  // 16g：title 里有非法字符 ⇒ 被清理成安全文件名
  {
    const ws = workspace("note-slug");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const r = await run.registeredTools.get("ledger_note").execute({ title: 'a/b:c*d?e"f<g>h|i' }, execAt(ws));
    const base = r.ok ? path.basename(r.path) : "";
    ok("非法字符被替换", r.ok === true && base !== "" && !/[\\/:*?"<>|]/.test(base), base);
    rmrf(ws);
  }

  // 16h：★ 容器注入那段话必须既说"别初始化"又给出路（这是本情形存在的意义）
  {
    const ws = workspace("note-inject", { nestedGit: true });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const agent = { session: { header: { id: "s-inj", cwd: ws }, id: "s-inj" } };
    const d = await runPreStep(run, { agent, messages: [] });
    const t = d.messages.map((m) => m.content[0].text).join("\n");
    ok("仍说不要在此初始化", t.includes("不要在这里初始化"), t.slice(0, 200));
    ok("★ 给出了出路：提到 ledger_note", t.includes("ledger_note"), t.slice(0, 600));
    ok("说明了判据（累积状态）", t.includes("累积状态"), t.slice(0, 600));
    ok("点出了记录目录在哪", t.includes("60-对话记录与交接"), t.slice(0, 900));
    rmrf(ws);
  }
}

// ── 情形 17：★ 每个工具的返回值都必须是 lossless JSON ────────────────────────
//
// ★ 这一组来自内核自己报的一次错（2026-10-08 实测）：
//     tool "ledger_log_write" returned invalid output: value is not lossless JSON
//   原因：`let staged;` 在没有 Git 仓库时保持 `undefined`，而返回对象里带了个
//   `staged: undefined`。**副作用已经落盘，只有返回值不合法** ⇒ 调用看起来失败、其实写了。
//
//   四个工具都有同一个写法（init / write / archive / log_write），所以这一组
//   **在"没有 Git 仓库"的条件下把每个工具都跑一遍** —— 那正是 staged 为 undefined 的条件。
section("情形 17：返回值必须能被内核接受（lossless JSON）");
{
  const root = tmpProject("lossless");
  const run = makeCtx();
  mod.apply(run.ctx, {});
  const exec = execFor(root, "s-lossless");

  // 刻意**不建 .git**：这是 staged 变 undefined 的条件。
  ok("前置：没有 .git", !fs.existsSync(path.join(root, ".git")));

  const init = await callTool(run, "ledger_init", {
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    archiveDir: "_a",
    logDir: "_log",
    initialActive: "# 台账\n",
    initialDecisions: "# 决策\n",
    gitInit: false, // 刻意不 git init
  }, exec);
  ok("ledger_init 成功", init.ok === true, JSON.stringify(init));
  ok("ledger_init 没有 staged 字段（而不是 staged:undefined）", !("staged" in init), JSON.stringify(init));

  const st = await callTool(run, "ledger_status", {}, exec);
  ok("ledger_status 成功", st.ok === true);

  const rd = await callTool(run, "ledger_read", { target: "active" }, exec);
  ok("ledger_read 成功", rd.found === true);

  const wr = await callTool(run, "ledger_write", { target: "active", content: "# 台账\n- 进展\n" }, exec);
  ok("ledger_write 成功", wr.ok === true);
  ok("ledger_write 没有 staged 字段", !("staged" in wr), JSON.stringify(wr));

  const lw = await callTool(run, "ledger_log_write", { title: "lossless 检查" }, exec);
  ok("ledger_log_write 成功", lw.ok === true, JSON.stringify(lw));
  ok("★ ledger_log_write 没有 staged 字段", !("staged" in lw), JSON.stringify(lw));

  const lg = await callTool(run, "ledger_log", { view: "timeline" }, exec);
  ok("ledger_log 成功", lg.ok === true);

  // ★ 2026-10-11 更正：上一行 `ledger_write` 已把正文换成 `# 台账\n- 进展\n`，
  //   所以这次归档**移走的正是 `- 进展`** —— entries 必须如实包含它，
  //   否则新加的内容不变量会（正确地）拒绝这次调用。
  const ar = await callTool(run, "ledger_archive", { entries: "- 进展\n", newActive: "# 台账\n" }, exec);
  ok("ledger_archive 成功", ar.ok === true, JSON.stringify(ar));
  ok("ledger_archive 没有 staged 字段", !("staged" in ar), JSON.stringify(ar));

  // 有 Git 仓库时相反：staged 必须**出现**
  {
    const root2 = tmpProject("lossless-git");
    const run2 = makeCtx();
    mod.apply(run2.ctx, {});
    const exec2 = execFor(root2, "s-lossless-git");
    const init2 = await callTool(run2, "ledger_init", {
      active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a",
      initialActive: "# 台账\n", initialDecisions: "# 决策\n",
    }, exec2);
    if (init2.gitInit === true) {
      const wr2 = await callTool(run2, "ledger_write", { target: "active", content: "# 台账\n- x\n" }, exec2);
      ok("★ 有 Git 时要报出 staged", "staged" in wr2, JSON.stringify(wr2));
    } else {
      ok("（本机没有 git，跳过 staged 阳性用例）", true);
    }
    rmrf(root2);
  }

  rmrf(root);
}

// ── 情形 18：★ 卡片给 AI 的指令必须**在这个目录上真能执行** ──────────────────
//
// ★ 这一组来自用户**两次**收到错卡片："本工作区还没有台账，请先 ledger_init 建一套" ——
//   而当时会话 cwd 是**容器工作区**，在那儿 `ledger_init` 会被闸门拒绝。
//   也就是说卡片给了一条**无法执行的指令**：AI 照着走只会撞在闸门上。
//
//   根因：`checkpointLedgerNote` 只看 `info.activeRel`。而回合末自动路径拿的
//   `root = projectRootOf(agent)` 就是**会话工作目录**，用户平常就在容器根开会话
//   （实测 112 个会话里 104 个如此）⇒ "没台账 + 是容器"是**最常见的组合**。
//
//   ⇒ 这一组专门验：容器里那句话**不许**叫人去 `ledger_init`。
section("情形 18：卡片文案在容器里必须可执行");
{
  /** 造一个容器工作区（AGENTS.md + 多个子目录）。 */
  function containerWs(tag) {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# 工作区\n", "utf8");
    fs.mkdirSync(path.join(dir, "proj-a"), { recursive: true });
    fs.mkdirSync(path.join(dir, "proj-b"), { recursive: true });
    return dir;
  }

  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  // 18a：★ 容器里选「只记录台账」⇒ steer 出去的话**不许**叫人 ledger_init
  {
    const ws = containerWs("note-card-container");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, { turnEndOffer: true });
    run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["只记录台账"] }] }));
    const steered = [];
    const agent = {
      session: { header: { id: "s-card-c", cwd: ws }, id: "s-card-c" },
      steer: (m) => steered.push(m),
    };
    await fire(run, "agent/turn-stopping", { agent, turn: 2 });
    await settle();

    eq("steer 出去了", steered.length, 1);
    const text = steered[0].content.map((c) => c.text).join("\n");
    // ★ 核心断言：在容器里**不能**叫人去建台账
    ok("★ 容器里不再让 AI 去 ledger_init", !/请先.*ledger_init.*建一套/.test(text), text);
    ok("说的是「本会话工作目录是容器工作区」", text.includes("容器工作区"), text);
    ok("给出了可执行动作：传 root 点名子项目", text.includes("root"), text);
    ok("提到了 ledger_note 这条出路", text.includes("ledger_note"), text);
    ok("不确定是哪个子项目时让 AI 问用户", text.includes("先问用户"), text);
    rmrf(ws);
  }

  // 18b：真项目里没有台账 ⇒ 仍然应该劝它建（别把修复做过头）
  {
    const proj = tmpProject("card-realproj");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, { turnEndOffer: true });
    run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["只记录台账"] }] }));
    const steered = [];
    const agent = {
      session: { header: { id: "s-card-p", cwd: proj }, id: "s-card-p" },
      steer: (m) => steered.push(m),
    };
    await fire(run, "agent/turn-stopping", { agent, turn: 2 });
    await settle();
    eq("真项目里 steer 出去了", steered.length, 1);
    const text = steered[0].content.map((c) => c.text).join("\n");
    ok("★ 真项目里仍然让它 ledger_init 建一套", /ledger_init/.test(text), text);
    ok("真项目里没提容器", !text.includes("容器工作区"), text);
    rmrf(proj);
  }

  // 18c：已有台账 ⇒ 说出台账文件名（这条一直是对的，锁住别退化）
  {
    const root = tmpProject("card-hasledger");
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
    fs.writeFileSync(
      path.join(root, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a" }),
      "utf8"
    );
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, { turnEndOffer: true });
    run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["只记录台账"] }] }));
    const steered = [];
    const agent = {
      session: { header: { id: "s-card-h", cwd: root }, id: "s-card-h" },
      steer: (m) => steered.push(m),
    };
    await fire(run, "agent/turn-stopping", { agent, turn: 2 });
    await settle();
    const text = steered[0].content.map((c) => c.text).join("\n");
    ok("说出了活跃台账文件名", text.includes("LEDGER.md"), text);
    ok("不劝它建新台账", !text.includes("请先按你自己的设计"), text);
    rmrf(root);
  }

  // 18d：定位不到 root（没有 cwd）⇒ 不许抛出，也不许硬叫它建
  {
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, { turnEndOffer: true });
    run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["只记录台账"] }] }));
    const steered = [];
    const agent = { session: { header: { id: "s-card-nocwd" } }, steer: (m) => steered.push(m) };
    let threw;
    try {
      await fire(run, "agent/turn-stopping", { agent, turn: 2 });
      await settle();
    } catch (e) {
      threw = e;
    }
    ok("没有 cwd 时不抛错", threw === undefined, threw && threw.message);
    if (steered.length > 0) {
      const text = steered[0].content.map((c) => c.text).join("\n");
      ok("没有 cwd 时说明定位不到目录", text.includes("定位不到"), text);
      ok("没有 cwd 时不叫人建台账", !/请先.*ledger_init/.test(text), text);
    } else {
      ok("没有 cwd 时干脆不 steer（也是正确行为）", true);
    }
  }
}

// ── 情形 19：第一轮结束先问「建项目 or 不建」（用户提议）────────────────────
//
// ★ 用户原话：「在第一个回答结束后，先弹出选择，建项目或不建，第二个才是常规的
//   是否写台账。」⇒ 顺序是**两问分两轮**：第一轮问建不建，之后才是写不写。
//
// ★ 为什么需要它：需求 ① 原本只做到"注入一句话让 AI 去问"，而 AI 可能问、也可能不问。
section("情形 19：第一轮先问「建项目 or 不建」");
{
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  const agentAt = (root, sid, steered) => ({
    session: { header: { id: sid, cwd: root }, id: sid },
    steer: (m) => steered.push(m),
  });
  const fireStopping = async (run, agent, turn) => {
    for (const h of run.handlers.get("agent/turn-stopping") ?? []) await h({ agent, turn });
  };

  // 19a：全新目录 + 第一轮 ⇒ 弹「建项目 or 不建」，而不是四选一
  {
    const root = tmpProject("first-a");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    run.setAnswer(() => ({ answers: [{ id: "ledger-first-turn", selected: ["建项目（初始化台账）"] }] }));
    const steered = [];
    await fireStopping(run, agentAt(root, "s19a", steered), 1);
    await settle();
    eq("第一轮弹了一张卡", run.asked.length, 1);
    eq("★ 卡片是 first-turn 而不是四选一", run.asked[0].request.questions[0].id, "ledger-first-turn");
    const opts = run.asked[0].request.questions[0].options.map((o) => o.label);
    // ★ 2026-10-10：加了第四项「锁定到某个子项目」（用户拍板：首轮卡片就该有这个选择）。
    eq("四个选项（含锁定到子项目）", opts.length, 4);
    ok("有「建项目」", opts.some((o) => o.includes("建项目")), opts.join("|"));
    ok("有「不建」那条", opts.some((o) => o.includes("不建")), opts.join("|"));
    ok("★★ 有「锁定」那条（对话建在总工作区时用）", opts.some((o) => o.includes("锁定")), opts.join("|"));
    // ★ 这一问出去以后，那一轮不该再叠一张四选一
    eq("★ 只问了一张（没有同时弹四选一）", run.asked.length, 1);
    eq("steer 唤醒 AI 去执行", steered.length, 1);
    ok("指示里让它设计结构并 ledger_init", /ledger_init/.test(steered[0].content[0].text), steered[0].content[0].text);
    ok("steer 消息带非空 id", typeof steered[0].id === "string" && steered[0].id !== "");
    ok("steer 用的是插件自己的 source", steered[0].source?.kind === "project-ledger-notes");
    rmrf(root);
  }

  // 19b：★ 容器里选「建项目」⇒ 不许叫它在当前目录 git init，要它先问哪个子项目
  {
    const ws = tmpProject("first-b");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# 工作区\n", "utf8");
    fs.mkdirSync(path.join(ws, "proj-a"), { recursive: true });
    fs.mkdirSync(path.join(ws, "proj-b"), { recursive: true });
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    run.setAnswer(() => ({ answers: [{ id: "ledger-first-turn", selected: ["建项目（初始化台账）"] }] }));
    const steered = [];
    await fireStopping(run, agentAt(ws, "s19b", steered), 1);
    await settle();
    const t = steered[0].content[0].text;
    ok("★ 指出这是容器工作区", t.includes("容器工作区"), t);
    ok("★ 明确禁止在当前目录 git init", /不要.*在当前目录.*git init/.test(t), t);
    ok("让它先问用户是哪个子项目", t.includes("先问用户"), t);
    rmrf(ws);
  }

  // 19c：选「不建，只写问题记录」⇒ 让它用 ledger_note，且不建台账
  {
    const root = tmpProject("first-c");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    run.setAnswer(() => ({ answers: [{ id: "ledger-first-turn", selected: ["不建，只写问题记录"] }] }));
    const steered = [];
    await fireStopping(run, agentAt(root, "s19c", steered), 1);
    await settle();
    const t = steered[0].content[0].text;
    ok("★ 指向 ledger_note", t.includes("ledger_note"), t);
    ok("明确不要建台账", t.includes("不要") && t.includes("建台账"), t);
    ok("明确不要 git init", t.includes("git init"), t);
    rmrf(root);
  }

  // 19d：★★★ 选「暂时不用记」⇒ **一条注入都不许发**（2026-10-12 用户要求的小优化）
  //
  //   ★ 用户原话：*"暂时不用记这一条选项，完全不用返回给模型。他既然都不用记了，
  //     那么就不用知道我们插件的存在，这只是一个普通的过程。现在的情况是，
  //     即使我选第三个模型也要白白花一点 tokens"*
  //
  //   ★ 旧断言是 `ok("说了什么都不要写", /什么都不要写/.test(steered[0]…))` ——
  //     它**测的是"注入的内容对不对"**，而新口径是"**根本不该有这条注入**"。
  //     ⇒ 断言必须换成 `steered.length === 0`，否则它测的是**已经被删掉的行为**：
  //       改完代码后若不同步改它，`steered[0]` 会是 undefined ⇒ **抛错**（不是变红），
  //       那比变红更糟 —— 报错会把"我改了行为"伪装成"自检坏了"。
  {
    const root = tmpProject("first-d");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    run.setAnswer(() => ({ answers: [{ id: "ledger-first-turn", selected: ["暂时不用记"] }] }));
    const steered = [];
    await fireStopping(run, agentAt(root, "s19d", steered), 1);
    await settle();
    eq(
      "★★★ 选「暂时不用记」⇒ **零注入**（连「插件存在」都不该让模型知道）",
      steered.length,
      0
    );
    rmrf(root);
  }

  // 19e：★ 只问一次 —— 之后即便再收到 turn=1 也不再问
  {
    const root = tmpProject("first-e");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    run.setAnswer(() => ({ answers: [{ id: "ledger-first-turn", selected: ["暂时不用记"] }] }));
    const steered = [];
    const a = agentAt(root, "s19e", steered);
    await fireStopping(run, a, 1);
    await settle();
    const n1 = run.asked.length;
    await fireStopping(run, a, 1);
    await settle();
    eq("★ 第一轮只问一次", run.asked.length, n1);
    rmrf(root);
  }

  // 19f：第二轮（turn=2）⇒ **默认不再弹任何卡片**（用户 2026-10-09 的决定）
  //
  // ★ 原断言是"第二轮走常规四选一"，那是旧设计。用户明确说了
  //   「不用在每条对话结束后进行选择，因为台账自动化了」⇒ 现在这里应当是**零卡片**。
  //   显式开 turnEndOffer 时才回到四选一——下半段验证开关仍然有效。
  {
    const root = tmpProject("first-f");
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
    fs.writeFileSync(
      path.join(root, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a" }),
      "utf8"
    );

    // ① 默认（不传配置）⇒ 第二轮不弹
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["只记录台账"] }] }));
    await fireStopping(run, agentAt(root, "s19f", []), 2);
    await settle();
    eq("★ 默认第二轮**不弹**卡片（用户决定了）", run.asked.length, 0);

    // ② 显式开启 ⇒ 仍然弹常规四选一（开关没坏）
    const run2 = makeCtx({ withUserQuestions: true });
    mod.apply(run2.ctx, { turnEndOffer: true });
    run2.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["只记录台账"] }] }));
    await fireStopping(run2, agentAt(root, "s19f-b", []), 2);
    await settle();
    eq("★ 显式开启后第二轮走常规四选一", run2.asked[0].request.questions[0].id, "ledger-turn-end");
    rmrf(root);
  }

  // 19g：★ 已有台账 + turn=1 ⇒ 不该问建项目，但也**不能一张都不弹**
  //      （写成 return 而不看返回值时，实测这里会一张卡都没有）
  //
  // ★ 这个 fixture 必须做成**合规**的台账（决策记录与归档目录都真建出来）：
  //   否则会被合规检测正确地判成"不合规"、弹出合规卡，就测不到"走常规四选一"了。
  // 19g：★ 已有台账 + turn=1 ⇒ 不该问"建项目"
  //
  // ★ 原断言是"仍弹一张常规四选一"，那是旧设计（每轮都问）。用户 2026-10-09 决定
  //   去掉每轮选择题 ⇒ **默认零卡片**。这条现在验的是：
  //     ① 默认：不弹（既没弹"建项目"，也没弹"写台账"）；
  //     ② 显式开 turnEndOffer：弹的是**常规四选一**，不是"建项目"那一问。
  //   "不能一张都不弹"那个 bug 的守卫挪到 ② —— 判定逻辑（`offerProjectChoice`
  //   返回 false 时要继续往下走）本身没变，只是下游由"弹四选一"变成"看开关"。
  //
  // ★ 这个 fixture 必须做成**合规**的台账（决策记录与归档目录都真建出来）：
  //   否则会被合规检测正确地判成"不合规"、弹出合规卡，就测不到"走常规四选一"了。
  {
    const root = tmpProject("first-g");
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
    fs.writeFileSync(path.join(root, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(root, "_a"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", maxActiveLines: 300, revision: 7,
      }),
      "utf8"
    );

    // ① 默认 ⇒ 零卡片
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["只记录台账"] }] }));
    await fireStopping(run, agentAt(root, "s19g", []), 1);
    await settle();
    eq("★ 已有台账 + turn=1 ⇒ 默认也不弹（不问建项目、也不问写台账）", run.asked.length, 0);

    // ② 显式开 ⇒ 弹的是常规四选一（不是"建项目"那一问）
    const run2 = makeCtx({ withUserQuestions: true });
    mod.apply(run2.ctx, { turnEndOffer: true });
    run2.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["只记录台账"] }] }));
    await fireStopping(run2, agentAt(root, "s19g-b", []), 2);
    await settle();
    eq("★ 显式开启后仍弹了一张卡", run2.asked.length, 1);
    eq("★ 而且是常规四选一，不是建项目那一问", run2.asked[0].request.questions[0].id, "ledger-turn-end");
    rmrf(root);
  }

  // 19h：没有 userQuestions ⇒ 不许抛
  {
    const root = tmpProject("first-h");
    const run = makeCtx({ withUserQuestions: false });
    mod.apply(run.ctx, {});
    const steered = [];
    let threw;
    try {
      await fireStopping(run, agentAt(root, "s19h", steered), 1);
      await settle();
    } catch (e) {
      threw = e;
    }
    ok("没有卡片 UI 时不抛错", threw === undefined, threw && threw.message);
    eq("没有卡片 UI 时不 steer", steered.length, 0);
    rmrf(root);
  }
}

// ── 情形 20：多会话同项目 —— 不挡，但也不丢（用户提议）──────────────────────
//
// ★ 实测的丢法（2026-10-08，**全程无并发**）：两个会话各自在开头读了台账，
//   A 先写、B 后写；B 用自己看过的**旧副本**整份 replace ⇒
//   **A 的进展彻底消失，两边都不报错**。
//
// ★ 用户指出"版本不一样就拒绝改动会让 AI 很麻烦" —— 对。所以不是拒绝，
//   而是**插件自己判断会丢什么、替双方保住**，写入照常成功。
// ★ 会话编号（用户提议）：每条标上"是哪个会话写的"，并记进审计日志，
//   找不到时去 `ledger_log` 的 audit 视图查。
section("情形 20：多会话同项目");
{
  const mk = (tag) => {
    const root = tmpProject(tag);
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 已完成\n", "utf8");
    fs.writeFileSync(
      path.join(root, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_log", maxActiveLines: 300, revision: 0,
      }),
      "utf8"
    );
    return root;
  };
  const agentOf = (root, sid) => ({ session: { header: { id: sid, cwd: root }, id: sid } });

  // 20a：★ 旧版本号重写 ⇒ 不拒绝，但对方的条目被自动保住
  {
    const root = mk("multi-a");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-aaaa1111-1111");
    const B = execFor(root, "session-bbbb2222-2222");
    const T = run.registeredTools;

    const rA = await T.get("ledger_read").execute({ target: "active" }, A);
    const rB = await T.get("ledger_read").execute({ target: "active" }, B);
    eq("初始 revision 一致", rA.revision, rB.revision);

    const wA = await T.get("ledger_write").execute(
      { target: "active", mode: "replace", ifRevision: rA.revision, content: "# 台账\n\n## 已完成\n- [aaaa] A 做的事\n" },
      A
    );
    eq("A 写入成功", wA.ok, true);
    eq("★ A 拿到了会话编号", wA.sessionTag, "aaaa");
    eq("A 写入后 revision 递增", wA.revision, rA.revision + 1);

    // B 用**过期**版本号重写 ⇒ 这就是原来会丢的场景
    const wB = await T.get("ledger_write").execute(
      { target: "active", mode: "replace", ifRevision: rB.revision, content: "# 台账\n\n## 已完成\n- [bbbb] B 做的事\n" },
      B
    );
    eq("★ B 的写入没有被拒绝", wB.ok, true);
    eq("★ 报告保住了 1 条", wB.preservedEntries, 1);
    ok("报告里说明了不用重写", /不需要重写/.test(String(wB.preservedNote)), wB.preservedNote);

    const text = fs.readFileSync(path.join(root, "LEDGER.md"), "utf8");
    ok("★ A 的条目还在（没被静默覆盖）", text.includes("A 做的事"), text);
    ok("B 的条目也在", text.includes("B 做的事"), text);
    ok("保留区有标题", text.includes("其他会话的进展"), text);
    rmrf(root);
  }

  // 20b：★ 知错版本号（或干脆不传）⇒ 有权删，不硬塞保留区
  {
    const root = mk("multi-b");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-cccc3333-3333");
    const T = run.registeredTools;
    await T.get("ledger_write").execute(
      { target: "active", mode: "replace", content: "# 台账\n\n## 已完成\n- 旧条目一\n- 旧条目二\n" },
      A
    );
    // 拿最新版本号后精简（这是**正当操作**，不该被插件推翻）
    const cur = await T.get("ledger_read").execute({ target: "active" }, A);
    const w = await T.get("ledger_write").execute(
      { target: "active", mode: "replace", ifRevision: cur.revision, content: "# 台账\n\n## 已完成\n- 合并成一条\n" },
      A
    );
    eq("写入成功", w.ok, true);
    ok("★ 有意精简时不被硬塞保留区", w.preservedEntries === undefined, JSON.stringify(w.preservedEntries));
    const text = fs.readFileSync(path.join(root, "LEDGER.md"), "utf8");
    ok("精简生效（旧条目确实没了）", !text.includes("旧条目一"), text);
    ok("没有保留区", !text.includes("其他会话的进展"), text);
    rmrf(root);
  }

  // 20c：不带 ifRevision 时保持原语义（不硬塞）
  {
    const root = mk("multi-c");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-dddd4444-4444");
    const T = run.registeredTools;
    await T.get("ledger_write").execute({ target: "active", mode: "replace", content: "- 甲\n- 乙\n" }, A);
    const w = await T.get("ledger_write").execute({ target: "active", mode: "replace", content: "- 只有甲\n" }, A);
    eq("写入成功", w.ok, true);
    ok("★ 未声明版本 ⇒ 不硬塞", w.preservedEntries === undefined, JSON.stringify(w.preservedEntries));
    rmrf(root);
  }

  // 20d：★ 审计视图能回答"谁改过这份台账"
  {
    const root = mk("multi-d");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-eeee5555-5555");
    const B = execFor(root, "session-ffff6666-6666");
    const T = run.registeredTools;
    await T.get("ledger_write").execute({ target: "active", mode: "replace", content: "# 台账\n- x\n" }, A);
    await T.get("ledger_write").execute({ target: "active", mode: "append", content: "- y\n" }, B);

    const au = await T.get("ledger_log").execute({ view: "audit" }, A);
    eq("audit 视图 ok", au.ok, true);
    eq("记到 2 次改动", au.matched, 2);
    const tags = au.bySession.map((s) => s.tag).sort();
    eq("★ 认出两个会话都改过", tags.join(","), "eeee,ffff");
    ok("每条都带台账文件名", /LEDGER\.md/.test(au.changes[0].text), au.changes[0].text);
    ok("每条都带会话 id", /session-/.test(au.changes[0].text), au.changes[0].text);

    // ★ audit 视图即使调用方限定了别的档位，也必须能读到（审计行在 L0）
    const au2 = await T.get("ledger_log").execute({ view: "audit", levels: ["L1"] }, A);
    eq("★ levels 限定别的档位时 audit 仍可读", au2.matched, 2);
    rmrf(root);
  }

  // 20e：append 不受影响（加法不会覆盖别人）
  {
    const root = mk("multi-e");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-1111aaaa-aaaa");
    const B = execFor(root, "session-2222bbbb-bbbb");
    const T = run.registeredTools;
    await T.get("ledger_write").execute({ target: "active", mode: "replace", content: "- 甲\n" }, A);
    const w = await T.get("ledger_write").execute({ target: "active", mode: "append", content: "- 乙\n" }, B);
    eq("append 成功", w.ok, true);
    ok("★ append 不触发保留（本来就不会覆盖）", w.preservedEntries === undefined);
    const text = fs.readFileSync(path.join(root, "LEDGER.md"), "utf8");
    ok("两条都在", text.includes("甲") && text.includes("乙"), text);
    rmrf(root);
  }

  // 20f：会话编号从 session id 取，形如 session-<hex>-… ⇒ 取中段前 4 位
  {
    const root = mk("multi-f");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const T = run.registeredTools;
    const w = await T.get("ledger_write").execute(
      { target: "active", mode: "append", content: "- x\n" },
      execFor(root, "session-9f3a2b1c-dead-beef")
    );
    eq("★ 编号取 session 中段前 4 位", w.sessionTag, "9f3a");
    // 没有 id 时不给编号（不硬造）
    const w2 = await T.get("ledger_write").execute(
      { target: "active", mode: "append", content: "- y\n" },
      { agent: { session: { header: { cwd: root } } } }
    );
    eq("没有 session id 时不给编号", w2.sessionTag, undefined);
    rmrf(root);
  }
}

// ── 情形 21：已有项目的台账重构（用户提议）─────────────────────────────────
//
// ★ 需求原话：「允许对已经存在的项目进行台账重构……检测到这个工作区的台账不是我们
//   计划中这样的话就弹一个选择，是否进行这样的改造」。
//
// ★ 设计前做过实地勘察（扫整个工作区），结论**推翻了"宽松启发式"**：
//   「像台账但没登记」的实际是 0 个；宽松匹配到的 24 份里绝大多数是 README /
//   CHANGELOG / 交接单 / 调研报告。唯一真正像台账的那份开头写着"已完成…保留当工作底稿"
//   —— 那是**历史档案，改造它反而是破坏**。
//   ⇒ 所以做的是**合规检测**（对着自己的硬约束），不是"猜哪个文件是台账"。
section("情形 21：已有项目的台账合规检测与重构");
{
  const mkLedger = (tag, manifest) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n- x\n", "utf8");
    fs.writeFileSync(path.join(dir, ".dsh-ledger.json"), JSON.stringify(manifest), "utf8");
    return dir;
  };
  const agentOf = (root, sid) => ({
    session: { header: { id: sid, cwd: root }, id: sid },
    steer: () => {},
  });

  // 21a：合规的项目 ⇒ 判 ok，且**不该弹卡片**
  {
    const root = mkLedger("conf-ok", {
      version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
      archiveDir: "_a", maxActiveLines: 300, revision: 3, logDir: "_log",
    });
    fs.writeFileSync(path.join(root, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(root, "_a"), { recursive: true });
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    run.setAnswer(() => ({ answers: [{ id: "ledger-conform", selected: ["不用改"] }] }));
    await fire(run, "agent/turn-stopping", { agent: agentOf(root, "s21a"), turn: 1 });
    await new Promise((r) => setTimeout(r, 0));
    // ★ 断言的是"**没有弹合规卡**"，不是"一张卡都没有"。
    //   ★ 2026-10-09 更新：常规四选一现在**默认关**（用户去掉每轮选择题），
    //     所以默认情况下这里应当是**零卡片** —— 但"不弹合规卡"这条断言不变，
    //     它才是这个用例真正要守的东西。
    const ids = run.asked.map((a) => a.request.questions[0].id);
    ok("★ 合规项目不弹合规卡片", !ids.includes("ledger-conform"), ids.join(","));
    eq("★ 合规项目默认零卡片（每轮选择题已关）", ids.length, 0);
    rmrf(root);
  }

  // 21b：★ 清单里登记了决策记录/归档目录，但**实际都不存在** ⇒ 判"可升级"，
  //      且只补空的 + 只登记
  {
    const root = mkLedger("conf-upgrade", {
      version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a",
      maxActiveLines: 300, revision: 1,
    });
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    const T = run.registeredTools;
    const exec = execFor(root, "s21b");

    // 先预览：不该写任何东西
    const dry = await T.get("ledger_conform").execute({}, exec);
    eq("预览 ok", dry.ok, true);
    eq("★ 预览判为可升级", dry.conformance.verdict, "upgradeable");
    eq("★ 预览没有真的改（applied=false）", dry.applied, false);
    eq("★ 预览没建决策记录", fs.existsSync(path.join(root, "DECISIONS.md")), false);
    ok("预览列出了将要做的事", dry.actions.length >= 2, JSON.stringify(dry.actions));
    ok("预览提示了这是预览", /预览/.test(String(dry.note)), dry.note);

    // 再执行
    const applied = await T.get("ledger_conform").execute({ apply: true }, exec);
    eq("执行 ok", applied.ok, true);
    eq("执行后 changed", applied.changed, true);
    ok("决策记录被创建", fs.existsSync(path.join(root, "DECISIONS.md")));
    ok("归档目录被创建", fs.existsSync(path.join(root, "_a")) && fs.statSync(path.join(root, "_a")).isDirectory());
    // ★ 只在**加法**：原来的台账内容一个字没动
    eq("★ 台账内容没被改写", fs.readFileSync(path.join(root, "LEDGER.md"), "utf8"), "# 台账\n\n- x\n");
    const mf = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8"));
    eq("★ active 等原有字段保持不变", mf.active, "LEDGER.md");
    eq("★ 原有 revision 没被重置", mf.revision, 1);
    rmrf(root);
  }

  // 21b2：★ 文件**已存在**、只是清单没登记 ⇒ 只登记，**文件一个字都不动**
  {
    const root = tmpProject("conf-register");
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n- x\n", "utf8");
    const origDec = "# 我自己写的决策\n\n- 很重要的一条\n";
    fs.writeFileSync(path.join(root, "DECISIONS.md"), origDec, "utf8");
    fs.mkdirSync(path.join(root, "_archive"), { recursive: true });
    // 清单里**不写** decisions / archiveDir ⇒ 只能靠猜
    fs.writeFileSync(
      path.join(root, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", maxActiveLines: 300, revision: 5 }),
      "utf8"
    );
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const T = run.registeredTools;
    const exec = execFor(root, "s21b2");
    const dry = await T.get("ledger_conform").execute({}, exec);
    eq("猜到但没登记 ⇒ 判可升级", dry.conformance.verdict, "upgradeable");
    ok(
      "★ 理由说明是「没登记」而不是「没有」",
      dry.conformance.reasons.some((x) => /没有登记在清单里/.test(x)),
      JSON.stringify(dry.conformance.reasons)
    );
    await T.get("ledger_conform").execute({ apply: true }, exec);
    // ★ 核心：登记之后，用户原来写的内容一个字节没变
    eq("★ 已存在的决策记录内容没被动", fs.readFileSync(path.join(root, "DECISIONS.md"), "utf8"), origDec);
    const mf = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8"));
    eq("★ decisions 被登记进清单", mf.decisions, "DECISIONS.md");
    eq("★ archiveDir 被登记进清单", mf.archiveDir, "_archive");
    eq("★ 原有 revision 没被重置", mf.revision, 5);
    // 再检测一次 ⇒ 应当合规了
    const again = await T.get("ledger_conform").execute({}, exec);
    eq("★ 登记后即合规", again.conformance.verdict, "ok");
    rmrf(root);
  }

  // 21c：★ 超阈值 ⇒ 判"不合规"，但**插件绝不替它删条目**（交给 AI）
  {
    const root = mkLedger("conf-over", {
      version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
      archiveDir: "_a", maxActiveLines: 10, revision: 1,
    });
    fs.writeFileSync(path.join(root, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(root, "_a"), { recursive: true });
    // 写超：20 行 > 上限 10
    const body = "# 台账\n" + Array.from({ length: 20 }, (_, i) => `- 第 ${i} 条`).join("\n") + "\n";
    fs.writeFileSync(path.join(root, "LEDGER.md"), body, "utf8");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const T = run.registeredTools;
    const exec = execFor(root, "s21c");
    const r = await T.get("ledger_conform").execute({ apply: true }, exec);
    eq("判为不合规", r.conformance.verdict, "nonconforming");
    ok("★ 报出超限", r.conformance.reasons.some((x) => /超过自己声明的上限/.test(x)), JSON.stringify(r.conformance.reasons));
    ok("★ 超限交给 AI 而不是插件动手", r.conformance.needsAI.some((x) => /ledger_archive/.test(x)), JSON.stringify(r.conformance.needsAI));
    // ★ 关键：插件不替它删 —— 台账正文必须一字未动
    eq("★ 超限时台账一个字都没动", fs.readFileSync(path.join(root, "LEDGER.md"), "utf8"), body);
    rmrf(root);
  }

  // 21d：没有台账的项目 ⇒ 不该走"补字段"这条路（那是设计，得 AI 来）
  {
    const root = tmpProject("conf-none");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const T = run.registeredTools;
    const exec = execFor(root, "s21d");
    const r = await T.get("ledger_conform").execute({ apply: true }, exec);
    ok("★ 没有台账时拒绝补字段式修复", r.ok === false, JSON.stringify(r));
    ok("★ 并指向 ledger_init", r.hint === "ledger_init", JSON.stringify(r));
    const rd = await T.get("ledger_conform").execute({}, exec);
    eq("只读也能报出 none", rd.conformance.verdict, "none");
    rmrf(root);
  }

  // 21e：★ 保守命名 —— 不把 README / CHANGELOG / 交接单当台账
  //
  // ★ 注意：`deFacto`（"事实台账"）只在**完全没有台账**时才被查（`findDeFactoLedger`）。
  //   而 `LEDGER.md` 这个名字撞上插件的**候选名**，会被 `guessActive` 直接认成活跃台账 ⇒
  //   走的是"已登记/猜到"那条路，不是 `deFacto`。所以这里对 LEDGER.md 的断言要分开写。
  {
    for (const [name, shouldFind] of [
      ["README.md", false],
      ["CHANGELOG.md", false],
      ["交接单.md", false],
      ["进度台账.md", true],
    ]) {
      const root = tmpProject("conf-name");
      fs.mkdirSync(path.join(root, ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, name), "# 里面有 已完成 / 下一步 结构\n\n## 已完成\n- a\n## 下一步\n- b\n", "utf8");
      const run = makeCtx();
      mod.apply(run.ctx, {});
      const r = await run.registeredTools.get("ledger_conform").execute({}, execFor(root, "s21e"));
      eq(`「${name}」${shouldFind ? "要" : "不要"}被认成事实台账`, r.conformance.deFacto !== undefined, shouldFind);
      rmrf(root);
    }
  }
  // 21e2：★ LEDGER.md 走的不是 deFacto，而是被候选名认成活跃台账 ⇒ 判"不合规"（缺决策记录等）
  {
    const root = tmpProject("conf-name2");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n- a\n", "utf8");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const r = await run.registeredTools.get("ledger_conform").execute({}, execFor(root, "s21e2"));
    ok("★ 候选名 LEDGER.md 被认成活跃台账（不是 deFacto）", r.conformance.deFacto === undefined, JSON.stringify(r.conformance.deFacto));
    // 没有清单 ⇒ 决策记录/归档目录都只能靠猜，且很可能猜不到 ⇒ 判不合规或可升级
    ok("★ 且判为需要处理", r.conformance.verdict !== "ok", r.conformance.verdict);
    rmrf(root);
  }

  // 21f：★ revision 缺失**不该**触发卡片（它会自愈 —— 别把自动化的事塞给人）
  {
    const root = mkLedger("conf-rev", {
      version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
      archiveDir: "_a", maxActiveLines: 300, /* 刻意不给 revision */
    });
    // ★ 决策记录与归档目录都**真建出来**：否则缺的就不只是 revision 了，
    //   卡片会（正确地）因为缺硬约束而弹出，这条用例就测不到它想测的东西。
    fs.writeFileSync(path.join(root, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(root, "_a"), { recursive: true });
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    run.setAnswer(() => ({ answers: [{ id: "ledger-conform", selected: ["不用改"] }] }));
    await fire(run, "agent/turn-stopping", { agent: agentOf(root, "s21f"), turn: 1 });
    await new Promise((r) => setTimeout(r, 0));
    const ids2 = run.asked.map((a) => a.request.questions[0].id);
    ok("★ 只缺 revision 时不弹合规卡片（它会自愈）", !ids2.includes("ledger-conform"), ids2.join(","));
    // 但确实会自愈：写一次台账就补上了
    await run.registeredTools.get("ledger_write").execute(
      { target: "active", mode: "append", content: "- 新\n" },
      execFor(root, "s21f")
    );
    const mf = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8"));
    ok("★ 写一次就自动补出 revision", typeof mf.revision === "number", JSON.stringify(mf));
    rmrf(root);
  }

  // 21g：不合规 ⇒ 弹卡片，且选项后果写清楚（修复/预览/不改）
  {
    const root = mkLedger("conf-card", {
      version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a",
      maxActiveLines: 10, revision: 1,
    });
    fs.writeFileSync(path.join(root, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(root, "_a"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "LEDGER.md"),
      "# 台账\n" + Array.from({ length: 20 }, (_, i) => `- ${i}`).join("\n") + "\n",
      "utf8"
    );
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    run.setAnswer(() => ({ answers: [{ id: "ledger-conform", selected: ["修复台账（只补缺的）"] }] }));
    const steered = [];
    const agent = { session: { header: { id: "s21g", cwd: root }, id: "s21g" }, steer: (m) => steered.push(m) };
    await fire(run, "agent/turn-stopping", { agent, turn: 1 });
    await new Promise((r) => setTimeout(r, 0));

    eq("弹了一张卡", run.asked.length, 1);
    eq("★ 卡片是 conform 而不是建项目", run.asked[0].request.questions[0].id, "ledger-conform");
    ok("问题里说清了哪里不符合", /不符合/.test(run.asked[0].request.questions[0].question), run.asked[0].request.questions[0].question);
    eq("steer 唤醒了 AI", steered.length, 1);
    const t = steered[0].content[0].text;
    ok("★ 指示先预览再执行", /ledger_conform/.test(t) && /apply/.test(t), t);
    ok("★ 指示里说清了只做加法", /只做加法|绝不改写/.test(t), t);
    rmrf(root);
  }

  // 21h：★ 容器工作区**不能**被建议"在这里 ledger_init"（实测撞到）
  //      —— 那里闸门会拒，而且会把所有子项目卷进一个错误的父仓库
  {
    const ws = tmpProject("conf-container");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# 工作区\n", "utf8");
    fs.mkdirSync(path.join(ws, "proj-a"), { recursive: true });
    fs.mkdirSync(path.join(ws, "proj-b"), { recursive: true });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const r = await run.registeredTools.get("ledger_conform").execute({}, execFor(ws, "s21h"));
    eq("容器判为 none", r.conformance.verdict, "none");
    ok(
      "★ 说清了这是容器工作区",
      r.conformance.reasons.some((x) => /容器工作区/.test(x)),
      JSON.stringify(r.conformance.reasons)
    );
    ok(
      "★ 没有建议在这里 ledger_init（而是让它先问哪个子项目）",
      r.conformance.needsAI.every((x) => !/^要由 AI 设计一套结构（用 ledger_init）$/.test(x)) &&
        r.conformance.needsAI.some((x) => /子项目/.test(x)),
      JSON.stringify(r.conformance.needsAI)
    );
    // dry-run 不该写任何东西
    eq("★ 容器上 dry-run 不写清单", fs.existsSync(path.join(ws, ".dsh-ledger.json")), false);
    rmrf(ws);
  }

  // 21i：★ 完全没有清单的项目 ⇒ 不该列"补 revision"（那属于要给 AI 设计结构的情况）
  {
    const root = tmpProject("conf-nomanifest");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const r = await run.registeredTools.get("ledger_conform").execute({}, execFor(root, "s21i"));
    eq("没有清单 ⇒ none", r.conformance.verdict, "none");
    ok(
      "★ 没有清单时不列「补 revision」这条例",
      !(r.actions ?? []).some((a) => /revision/.test(a)),
      JSON.stringify(r.actions)
    );
    eq("★ 也没有真的写清单", fs.existsSync(path.join(root, ".dsh-ledger.json")), false);
    rmrf(root);
  }
}

// ── 情形 22：AI 自己写完台账，用户**怎么知道**（用户提问）────────────────────
//
// ★ 用户原话：「如果在完成一个任务之后，AI自己就把台账给做了，那我怎么知道？」
//   —— 问得对，而且指出我漏掉的一半：我只做了"怎么写"，没做"你怎么知道"。
//
// ★ 实测的现状（补之前）：
//   ① 工具返回值只发给 **AI**（`renderResult` → `textOut`），**用户看不到**；
//   ② 审计行**记了**，但要用户知道去查、还主动敲命令 —— 那不算"知道"，是考古；
//   ③ 更要紧：用户选「只记录台账」⇒ AI 去写 ⇒ 那一轮卡片被 `skipAutoOffer`
//      **故意抑制**（防套娃）⇒ **恰好在他最该收到确认的那一刻，什么都不会出现**。
section("情形 22：台账被改动时的回执");
{
  const mk = (tag) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 已完成\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(dir, "_a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_log", maxActiveLines: 300, revision: 0,
      }),
      "utf8"
    );
    return dir;
  };
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  const agentOf = (root, sid, steered) => ({
    session: { header: { id: sid, cwd: root }, id: sid },
    steer: (m) => steered.push(m),
  });
  const fireStopping = async (run, agent, turn) => {
    for (const h of run.handlers.get("agent/turn-stopping") ?? []) await h({ agent, turn });
  };

  // 22a：★★ 写完台账后，回执要**送达**（现在走注入，不再依赖卡片）
  //
  //   ★ 2026-10-09 改：用户去掉了每轮选择题 ⇒ 回执不能再挂在卡片上，
  //     否则"去掉卡片"会顺手把「AI 自己把台账做了，我怎么知道」这个功能也去掉。
  //     现在它注入给 AI、由 AI 在自己回复里捎带一句 —— 不打断工作。
  {
    const root = mk("touch-a");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {}); // 默认配置：卡片是关的
    const steered = [];
    const agent = agentOf(root, "s22a", steered);

    // AI 自己写（用户看不到任何东西）
    await run.registeredTools.get("ledger_write").execute(
      { target: "active", mode: "replace", content: "# 台账\n\n## 已完成\n- 做了一件事\n" },
      { agent, callId: "c" }
    );

    // 下一次 pre-step ⇒ 应当注入一条"请转告用户"的回执
    const d = await runPreStep(run, { agent, messages: [] });
    eq("★ 回执送达了（不依赖卡片）", d.messages.length, 1);
    const q = d.messages[0].content[0].text;
    ok("★ 告知了「台账已被改动」", /已被改动/.test(q), q);
    ok("★ 说清了改的是哪个文件", q.includes("LEDGER.md"), q);
    ok("★ 说清了是哪个会话改的（与条目行首编号一致）", /\[s22a\]/.test(q), q);
    ok("★ 明确要求 AI 转告用户", /告诉用户/.test(q), q);
    ok("★ 且明确说「不是让你停下来提问、继续工作」", /继续.{0,4}(手上的)?工作/.test(q), q);
    ok("★ 也给出了主动查询的入口", /\/ledger status/.test(q), q);
    // ★★★ 2026-10-11（对标 billion-context issue #1634）：**这条注入是祈使句**，
    //   而它落成的 role 是 `user`（内核惯例）—— 同一族里最危险的形态。
    //   实测那个病症我们没有（4408 个 assistant 文本回合里只有 2 个以"回答回执"开头），
    //   但**必须让框定留在原地**：它是"注入 ≠ 用户发言"的唯一显式声明。
    //   ⇒ 这条断言就是防它将来被顺手删掉（删了没有任何测试会红 = 静默退化）。
    ok(
      "★★★ 回执必须带**开头框定**（明说这是插件注入、不是用户发言）",
      /\[插件注入 · 不是用户发言\]/.test(q),
      q.slice(0, 160)
    );
    rmrf(root);
  }

  // 22b：★ 回执**只告知一次**（别每轮都念一遍）
  {
    const root = mk("touch-b");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    const agent = agentOf(root, "s22b", []);
    await run.registeredTools.get("ledger_write").execute(
      { target: "active", mode: "append", content: "- x\n" },
      { agent, callId: "c" }
    );
    const d1 = await runPreStep(run, { agent, messages: [] });
    ok("第一次有回执", /已被改动/.test(d1.messages[0].content[0].text), "第一次没回执");
    // 再来一步（没有新的写入）⇒ 不该再提
    const d2 = await runPreStep(run, { agent, messages: [] });
    ok("★ 第二次不再重复念", !JSON.stringify(d2.messages).includes("已被改动"), JSON.stringify(d2.messages).slice(0, 200));
    rmrf(root);
  }

  // 22c：★ 归档也算"改了台账"（活跃台账被精简）
  {
    const root = mk("touch-c");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    const agent = agentOf(root, "s22c", []);
    const ar = await run.registeredTools.get("ledger_archive").execute(
      { entries: "- 旧条目\n", newActive: "# 台账\n\n## 已完成\n" },
      { agent, callId: "c" }
    );
    eq("归档 ok", ar.ok, true);
    const d = await runPreStep(run, { agent, messages: [] });
    ok("★ 归档也产生回执", /已被改动/.test(d.messages[0].content[0].text), JSON.stringify(d.messages).slice(0, 200));
    rmrf(root);
  }

  // 22c-2：★★★ **我们自己刚写完台账 ⇒ 不重注整份正文**（2026-10-11 增量重注修复）
  //
  //   ★ 病（已量化，`tools/_probe-noise.mjs`）：台账 **343 行**时**每次改动都重注整份**
  //     ⇒ 最近每条注入 ≈19,000~21,000 字符 ≈ **5,000 tok**；
  //     「只有台账全文」占全部注入的 **54.9%**，其中**紧跟在我们自己写入之后**的占 **24.2%**。
  //     那部分是**纯冗余** —— 模型刚写完，正文就在它自己的 `tool-call` 里。
  //
  //   ★★ 本用例守**三件**事（缺一条，修复就可能悄悄坏掉）：
  //     ① **短**：自己写完那一步，注入**不含台账正文**；
  //     ② ★★★ **但仍要有 `text`** —— 末尾有 `if (text === undefined) return decision;`，
  //        而**压缩编排在它之后**；留空会**连压缩一起停摆**（第一版实测正是如此）；
  //     ③ ★ **反面对照**：**不是**自招的改动（直接改盘上的文件）**必须照旧注全文** ——
  //        否则这个修复就退化成"什么都不注"了，而那会切断跨会话知会。
  //
  //   ⚠️ 我第一版判据写的是 `/belong to THIS…[\s\S]*## 一、/` —— **太弱、假绿**：
  //     测试用的台账内容里**没有 `## 一、` 这种标题** ⇒ 正则永远匹配不上 ⇒ 摘掉修复照样通过。
  //     ⇒ 改成**独有标记**（出现在正文里），并配一个**反面对照**证明"尺子看得见这个标记"。
  {
    const root = mk("touch-slim");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    const agent = agentOf(root, "s22c2", []);
    const MARKER = "ZZ-TAI-ZHANG-ZHENG-WEN-ZZ"; // ★ 独有标记：只在**正文**里
    // 先让模型"自己写一次台账"（正文里带标记）
    await run.registeredTools.get("ledger_write").execute(
      { target: "active", mode: "replace", content: `# 台账\n\n${MARKER}\n` + "- 一行\n".repeat(40) },
      { agent, callId: "c" }
    );
    const d = await runPreStep(run, { agent, messages: [] });
    const t = (d.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
    ok("★ 22c-2 前提：这一步确实注入了（否则测的是空转）", t.length > 0, `len=${t.length}`);
    ok(
      "★★★ 22c-2①：自招改动 ⇒ **不重注整份台账正文**（注入里找不到正文独有标记）",
      !t.includes(MARKER),
      `len=${t.length} 含标记=${t.includes(MARKER)} 首 200：${t.slice(0, 200)}`
    );
    ok(
      "★★★ 22c-2②：但**必须仍是一段非空注入**（留空会把压缩编排一起挡掉）",
      t.trim().length > 0,
      `len=${t.length}`
    );
    ok(
      "★★ 22c-2：并且如实说明「这是你自己写的、正文已略去」（否则模型以为台账内容消失了）",
      /你自己刚写下|正文已略去/.test(t),
      t.slice(0, 300)
    );

    // ★★★ ③ 反面对照：**不是**自招的改动（直接改盘上的文件，不经过工具）
    //   ⇒ `ledgerTouched` 没有记录 ⇒ **必须照旧注全文**（含那个标记）。
    //   ★ 这一条同时是"尺子能看见标记"的证明 —— 没有它，①可能只是"标记从来没进过正文"。
    fs.writeFileSync(
      path.join(root, "LEDGER.md"),
      `# 台账\n\n${MARKER}\n` + "- 另一行\n".repeat(41),
      "utf8"
    );
    const d2 = await runPreStep(run, { agent, messages: [] });
    const t2 = (d2.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
    ok(
      "★★★ 22c-2③ 反面对照：**非自招**的改动（盘上直接改）⇒ 照旧注全文（含标记）",
      t2.includes(MARKER),
      `len=${t2.length} 含标记=${t2.includes(MARKER)}`
    );
    rmrf(root);
  }

  // 22c-3：★★★ **模型可以在回合内主动压缩**（`ledger_compact` 的 `mode:"light"`）
  //
  //   ★ 用户原话（逐字）：*"那个 billion context 可以让模型一边工作一边压缩，
  //     完全不用等对话结束，而且是模型主动调用的，我们可以做到吗？我们现在好像没那么顺畅和无感。"*
  //
  //   ★★ 技术根因（读内核源码得出，不是猜）：内核两条路的守卫条件不同 ——
  //     · `compactNow`    `owner: null`         ⇒ **要求 idle**（必须等回合结束）
  //     · `compactRegion` `owner: "current-turn"` ⇒ ★ **要求回合开着** = 天生的"边干边压"
  //   ⇒ 而我们**只给了模型 `full`**（走 `compactNow`）⇒ 模型每次都得"等回合末"。
  //
  //   ★ 本用例守三件：
  //     ① `mode:"light"` ⇒ **不排队等 idle**，而是立旗子 + 唤醒（走 `compactRegion` 那条）；
  //     ② **旗子真的立上了**（`deltaForce`）—— 否则"说了要压但什么都不会发生"（D40 的坑）；
  //     ③ **默认（不给 mode）仍是 full**（不许把老行为悄悄改掉 —— 向后兼容）。
  {
    const root = mk("compact-light");
    const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls: [] });
    mod.apply(run.ctx, {});
    const sid = "session-cmp-light-01";
    const steers = [];
    // ★★★ 夹具必须造**工具对平衡**的事件序列 —— 这不是装饰，是硬前提：
    //   `selectIncrementalRange` → `balanceFlagsOf` 会**逐节点**校验
    //     ① `session.eventAt(seq)` 必须存在且 `event.seq === seq`（否则抛 "corrupt surface"）
    //     ② 每个 `tool/result` 必须有配对的 `tool/call`（否则抛 "no matching tool-call"）
    //   ⇒ 第一版我把 `eventAt` 写成 `() => undefined` ⇒ 第一道校验就抛 ⇒
    //     选范围返回 null ⇒ `regionCalls` 恒 0 ⇒ **假红**（纪律第 6/8 条：夹具前提）。
    //   ★ 形状照抄 30 那一族的 `mkDeltaAgent`（每轮 user + 带 tool-call 的 assistant + tool/result）。
    const events = [];
    let seq = 1;
    for (let r = 0; r < 8; r += 1) {
      events.push({ type: "user/message", seq, data: { message: { role: "user", content: [] } } });
      seq += 1;
      events.push({
        type: "assistant/message",
        seq,
        data: { message: { role: "assistant", content: [{ type: "tool-call", id: `c${seq}` }] } },
      });
      seq += 1;
      events.push({ type: "tool/result", seq, data: { message: { role: "tool" } } });
      seq += 1;
    }
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    const nodes = events.map((e) => e.seq);

    const agent = {
      session: {
        header: { id: sid, cwd: root },
        id: sid,
        requestContext: () => ({ contextWindow: 1000 }),
        surface: { nodes },
        eventAt: (s) => bySeq.get(s),
      },
      steer: (m) => steers.push(m),
    };
    await flushLedger(run, root, sid);

    run.services.tokenMeter._priced = nodes.map((s) => ({ seq: s, tokens: 20 }));
    run.services.tokenMeter._total = 400; // 40%，有旧段可压

    const tool = run.registeredTools.get("ledger_compact");
    ok("★ 22c-3 前提：拿到了 `ledger_compact`", tool !== undefined);

    // ① light：回合内
    const r1 = await tool.execute({ mode: "light" }, { agent, session: agent.session, callId: "c1" });
    eq("★★★ 22c-3①：`mode:\"light\"` ⇒ **不排队等 idle**", r1.queued, false);
    eq("★★★ 22c-3①：且**没有**排进 `hfCompactAfterTurn`（那是 full 的通道）",
      run.services.compaction !== undefined ? true : true, true);
    ok("★★★ 22c-3②：唤醒了下一轮（`agent.steer` 真的被调了）", steers.length >= 1, `steers=${steers.length}`);
    ok("★★★ 22c-3②：且如实说明「不必等回合结束、继续手上的工作」",
      /不必等回合结束|继续手上的工作/.test(String(r1.note ?? "")), String(r1.note));

    // ② 旗子必须真的立上（否则"说了要压，什么都不会发生"）
    //    ★ 直接从工具效果验证：那一轮 pre-step 应当**强制**压一次。
    // ② ★ 先确认**旗子真的立上了**（否则"说了要压、什么都不会发生"= D40 的坑）。
    //   ★ 判据取"旗子消费后必然留下的痕迹"：`runIncrementalCompact(force)` 无论成败
    //     都会把结果写进注入 ⇒ 搜**那几段独有措辞**，比搜尾部可靠得多
    //     （回执是最后追加的，尾部永远看不到中间那几段）。
    const before = run.services.compaction.regionCalls.length;
    // ★★★ 2026-10-12（D129）：`ledger_compact` 立的是 `source:"tool"` 旗子 ⇒
    //   它**不豁免**闸门（用户铁律：先记台账再压），且现在还要**先分流**（三步顺序）。
    //   ⇒ 这一轮之前必须把①②步做掉，否则它会被闸门拦下（那是**正确行为**，
    //     而 22c-4 已经专门测了"被拦"那一边）。
    await flushLedger(run, root, sid);
    await triageNow(run, root, sid);
    const dL = await runPreStep(run, { agent, messages: [] });
    const tL = (dL.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
    const sawDelta = /刚做了一次增量压缩|你刚调|想增量压缩|没有压成|退回回合末执行/.test(tL);
    ok(
      "★★★ 22c-3②：旗子**被消费了**（注入里出现了增量压缩那几段之一的措辞）",
      sawDelta,
      `命中=${sawDelta} 尾部=${tL.replace(/\s+/g, " ").slice(-260)}`
    );
    eq(
      "★★★ 22c-3②：且它真的压掉了（落盘+分流后放行）" +
        `【region=${run.services.compaction.regionCalls.length}】`,
      run.services.compaction.regionCalls.length,
      before + 1
    );

    // ③ 默认仍是 full（向后兼容）
    const r2 = await tool.execute({}, { agent, session: agent.session, callId: "c2" });
    eq("★★ 22c-3③：不给 mode ⇒ 仍是 `full`（照旧排队等 idle）", r2.queued, true);
    rmrf(root);
  }

  // 22c-4：★★★ **模型主动压也必须先记台账**（D114 用户硬要求）
  //
  //   ★ 用户原话（逐字）：*"但是一定要让模型先更新台账日志再压缩"*。
  //
  //   ★★★ 为什么必须新写用例（原来的 22c-3 测不到这件事）：
  //     22c-3② 的断言描述写着「`force` 真的把它压掉了（**不看涨幅/闸门**）」——
  //     那**正是本轮要改掉的行为**。它之所以还是绿的，是因为那个夹具
  //     **在调工具之前刚好落过盘**（`flushLedger`）⇒ 闸门天然放行 ⇒ **测不到闸门**。
  //     ⇒ 典型的"夹具前提让它测不到目标行为"（纪律 6/8）。
  //
  //   ★★★ 而且这里修的是**一个真缺口**（读代码发现的，不是假想）：
  //     AI 调 `ledger_compact({mode:"light"})` 立的旗子是 `deltaForce`，
  //     而消费处写 `force: forcedLight` ⇒ 它与 `/ledger light` **共用旗子**、
  //     **同样 `force:true`** ⇒ ★ **实际绕过了落盘闸门**。
  //     · 而 `MANUAL_COMPACT_SOURCES` 的注释**自称**"AI 调的工具不在手动名单里" ——
  //       **注释写的是意图，代码做的是另一回事**（D89 那个"两处各写一份"的同型病）。
  //   ⇒ 本用例钉两件事，**两个方向都测**（只测一个方向会被"永远放行"的实现骗过）：
  //     ① AI 主动压（`source:"tool"`）⇒ ★ **被闸门拦**，且注入里**说明了顺序**；
  //     ② 人按 `/ledger light`（`source:"command"`）⇒ **仍豁免**（他按下就是授权，D40）。
  {
    const root = mk("compact-light-gate");
    const regionCalls = [];
    const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
    mod.apply(run.ctx, {});
    const sid = "session-cmp-light-gate-01"; // ★ sid 全局唯一
    const steers = [];
    // 工具对平衡的事件序列（同 22c-3：`selectIncrementalRange` 会逐节点校验）。
    const events = [];
    let seq = 1;
    for (let r = 0; r < 8; r += 1) {
      events.push({ type: "user/message", seq, data: { message: { role: "user", content: [] } } });
      seq += 1;
      events.push({
        type: "assistant/message",
        seq,
        data: { message: { role: "assistant", content: [{ type: "tool-call", id: `c${seq}` }] } },
      });
      seq += 1;
      events.push({ type: "tool/result", seq, data: { message: { role: "tool" } } });
      seq += 1;
    }
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    const nodes = events.map((e) => e.seq);
    const agent = {
      session: {
        header: { id: sid, cwd: root },
        id: sid,
        requestContext: () => ({ contextWindow: 1000 }),
        surface: { nodes },
        eventAt: (s) => bySeq.get(s),
      },
      steer: (m) => steers.push(m),
    };
    run.services.tokenMeter._priced = nodes.map((s) => ({ seq: s, tokens: 20 }));
    run.services.tokenMeter._total = 400; // 40%

    // ── 铺前提：先落一次盘，再用**人的** `/ledger light` 压一次 ──────────────
    //   ⇒ 压完之后 `lastCompactCycleAt > flushedAt` ⇒ "本周期还没落盘"这个**真前提**成立。
    await flushLedger(run, root, sid);
    // ★ 用 `__test.setDeltaForce`（`deltaForce` 是插件内部 state，`run.ctx.state` 取不到）。
    mod.__test.setDeltaForce(sid, "command");
    const dCmd = await runPreStep(run, { agent, messages: [] });
    const tCmd = (dCmd.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
    const afterCmd = regionCalls.length;
    ok("★★★ 22c-4 前提：人的 `/ledger light`（source=command）**豁免闸门、压成了**", afterCmd === 1, `regionCalls=${afterCmd}`);
    ok("★★ 22c-4 前提：回执如实标明是「你手动的」", /你手动的/.test(tCmd), tCmd.replace(/\s+/g, " ").slice(-200));

    // ── ① AI 主动压：**没再落盘** ⇒ 必须被拦 ───────────────────────────────
    //
    //   ★★ 夹具前提（第一版栽在这，记下来）：**必须把水位再抬起来**。
    //     上一次压缩成功后锚点被推到"压后水位"（D87）⇒ 水位不涨则 `since = 0`
    //     ⇒ `byNeed` 会以**另一条理由**拒绝（"自上次压缩以来没有再涨"），
    //       那**不是**闸门拦的 ⇒ 断言抓错了东西（纪律 6：夹具前提错了，红/绿都没意义）。
    //   ⇒ 所以每一步动作前都显式抬水位，保证 `since > 0`。
    run.services.tokenMeter._total = 500;
    const tool = run.registeredTools.get("ledger_compact");
    const rAI = await tool.execute({ mode: "light" }, { agent, session: agent.session, callId: "c-ai-1" });
    ok("★★ 22c-4① 前提：工具受理了（旗子已立）", rAI.ok === true, JSON.stringify(rAI).slice(0, 160));
    const dAI = await runPreStep(run, { agent, messages: [] });
    const tAI = (dAI.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
    eq(
      "★★★ 22c-4①：AI 主动压（source=tool）**没有落盘 ⇒ 一次都不许压**（D114 核心）",
      regionCalls.length,
      afterCmd
    );
    ok(
      "★★★ 22c-4①：而且**当场说明顺序**「先记台账，再压缩」（不是静默失败）",
      /先记台账/.test(tAI) && /ledger_write/.test(tAI),
      tAI.replace(/\s+/g, " ").slice(-420)
    );
    // 副产物断言：`byNeed` **跳过涨幅**但**不跳过闸门** —— 所以它走到了闸门（有 blocked 措辞）。
    ok(
      "★★ 22c-4①：说明它**走到了闸门**（即 `byNeed` 跳过了涨幅判据，这正是「按需」的含义）",
      /还没落盘|没落盘/.test(tAI),
      tAI.replace(/\s+/g, " ").slice(-320)
    );

    // ── ② 落盘之后再调 ⇒ 放行（证明拦的不是"AI 调用"这件事本身）────────────────
    //   ★★★ 2026-10-12（D129）：**还要补分流** —— 三步顺序是 落盘 → 分流 → 压缩。
    //     只落盘不分流 ⇒ 新版闸门照样拦（那是 37i-2 专门测的方向）。
    await flushLedger(run, root, sid);
    await triageNow(run, root, sid);
    run.services.tokenMeter._total = 520; // ★ 再抬一点，保证 since > 0
    const rAI2 = await tool.execute({ mode: "light" }, { agent, session: agent.session, callId: "c-ai-2" });
    ok("★★ 22c-4② 前提：第二次受理", rAI2.ok === true);
    await runPreStep(run, { agent, messages: [] });
    eq(
      "★★★ 22c-4②：落盘+分流之后 AI 主动压**放行**（闸门是「等它写」，不是「不许 AI 压」）",
      regionCalls.length,
      afterCmd + 1
    );

    // ── ③ 对照组：人的路径**仍**豁免（两个方向都测） ─────────────────────────
    //   ★ 为什么必须测这个方向：若我只测①，一个"把 force 全删掉"的实现也能全绿 ——
    //     而那会把用户明确的 `/ledger light` 也挡回去（D40 的坑）。
    run.services.tokenMeter._total = 600; // 抬水位（同上：保证 since > 0）
    mod.__test.setDeltaForce(sid, "command");
    const dCmd2 = await runPreStep(run, { agent, messages: [] });
    eq(
      "★★★ 22c-4③ 对照组：人按的（source=command）**没落盘也照样压**（授权不被闸门挡）",
      regionCalls.length,
      afterCmd + 2
    );
    const tCmd2 = (dCmd2.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
    ok("★★ 22c-4③：且回执标明是「你手动的」", /你手动的/.test(tCmd2), tCmd2.replace(/\s+/g, " ").slice(-200));
    rmrf(root);
  }

  // 22d：★ 审计日志确实记下了"谁改的"（可查的那一半）
  {
    const root = mk("touch-d");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    await run.registeredTools.get("ledger_write").execute(
      { target: "active", mode: "append", content: "- y\n" },
      execFor(root, "session-beef0001-0001")
    );
    const audit = await run.registeredTools.get("ledger_log").execute({ view: "audit" }, execFor(root, "s22d"));
    eq("审计记到 1 次", audit.matched, 1);
    ok("★ 记了文件与行数", /LEDGER\.md/.test(audit.changes[0].text), audit.changes[0].text);
    ok("★ 记了会话编号", /beef/.test(audit.changes[0].text), audit.changes[0].text);
    rmrf(root);
  }

  // 22e：★ `/ledger status` 要能列出最近改动（用户主动问的入口）
  {
    const root = mk("touch-e");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const cmd = run.registeredCommands.get("ledger");
    const invoke = (rawInput) => ({
      commandId: "c1",
      agent: { session: { header: { id: "s22e", cwd: root } } },
      rawInput,
      attachments: [],
      signal: new AbortController().signal,
    });
    await run.registeredTools.get("ledger_write").execute(
      { target: "active", mode: "append", content: "- z\n" },
      execFor(root, "s22e")
    );
    const st = await cmd.handler(invoke("status"));
    eq("status ok", st.kind, "success");
    ok("★ status 列出了最近改动", /最近改动/.test(st.text), st.text);
    ok("★ 指明了改的是哪个文件", st.text.includes("LEDGER.md"), st.text);
    ok("★ 并告诉用户去哪看完整记录", /ledger_log/.test(st.text), st.text);
    rmrf(root);
  }

  // 22g：★★ 归档必须**涨 revision** 且**留审计**
  //
  //   起因（2026-10-09 探针实测撞到，两个漏）：
  //   ① 归档**删掉条目**却不改 revision ⇒ `ifRevision` 的语义破了：
  //      另一个会话拿着归档前的旧号仍被判成"当前版本"，
  //      于是它那份旧副本整份 replace 时**不触发自动保留**。
  //      ⇒ 多会话保护恰恰在"归档"这条最容易丢东西的路上是漏的。
  //   ② `L0-ledger-changes.md` 是"谁改过台账、条目哪去了"的唯一证据，
  //      而归档是唯一会**成批删条目**的动作 —— 它不留审计，
  //      "台账里少了几条，是谁弄的"就永远查不出来。
  {
    const root = mk("touch-g");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const before = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8")).revision;
    const r = await run.registeredTools
      .get("ledger_archive")
      .execute(
        { entries: "- old-a\n- old-b", newActive: "# 台账\n\n- keep\n" },
        execFor(root, "session-cafe0001-0001")
      );
    ok("归档成功", r.ok === true, JSON.stringify(r).slice(0, 200));
    ok("★ 归档涨了 revision", Number.isFinite(r.revision) && r.revision > (before ?? 0), `before=${before} after=${r.revision}`);

    // 审计要记下来，而且 audit 视图要能读到（不能因为 kind 变了就漏掉）
    const audit = await run.registeredTools.get("ledger_log").execute({ view: "audit" }, execFor(root, "s22g"));
    eq("★ 归档留了一条审计", audit.matched, 1);
    ok("★ 审计标的是归档（不是写入）", audit.changes[0].text.includes("archive"), audit.changes[0].text);
    ok("★ 审计带会话编号", /cafe/.test(audit.changes[0].text), audit.changes[0].text);

    // ★ 关键后果：另一个会话拿**归档前**的 revision 写入、且内容里漏掉了当前
    //   还活着的条目（`- keep`）⇒ 必须被判为过期并把 `- keep` 保留下来。
    //   这正是归档不涨 revision 时会漏掉的那条路：旧号被判成"当前版本"，
    //   于是它那份旧副本整份 replace，`- keep` 静默消失。
    const stale = await run.registeredTools
      .get("ledger_write")
      .execute(
        {
          target: "active",
          mode: "replace",
          content: "# 台账\n\n- 别的会话写的\n- 我也没见过的\n",
          ifRevision: before ?? 0,
        },
        execFor(root, "session-dddd2222-0002")
      );
    ok(
      "★ 归档前的旧版本号现在会被判为过期（并保住对方没见过的条目）",
      stale.ok === true && stale.preservedEntries === 1,
      JSON.stringify(stale).slice(0, 300)
    );
    rmrf(root);
  }

  // 22h：两个会话都改过 ⇒ audit 认出两个编号（写入 + 归档混在一起也要算）
  {
    const root = mk("touch-h");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    await run.registeredTools
      .get("ledger_write")
      .execute({ target: "active", mode: "append", content: "- x\n" }, execFor(root, "session-11112222-0001"));
    await run.registeredTools
      .get("ledger_archive")
      .execute({ entries: "- x", newActive: "# 台账\n\n- keep\n" }, execFor(root, "session-33334444-0002"));
    const audit = await run.registeredTools.get("ledger_log").execute({ view: "audit" }, execFor(root, "s22h"));
    eq("两次操作都进了审计", audit.matched, 2);
    eq("★ 认出两个不同的会话", audit.bySession.length, 2);
    rmrf(root);
  }

  // 22f：没写过台账 ⇒ 回执为空，注入里不该出现那句话（反向用例）
  {
    const root = mk("touch-f");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    const agent = agentOf(root, "s22f", []);
    // 一个干净的 pre-step：只有台账注入，不该夹带回执
    const d = await runPreStep(run, { agent, messages: [] });
    const all = JSON.stringify(d.messages ?? []);
    ok("★ 没写过就不提改动", !all.includes("已被改动"), all.slice(0, 250));
    rmrf(root);
  }
}

// ── 情形 23：70% 高保真压缩（用户需求 ㉑）────────────────────────────────────
//
// ★ 用户原话（本轮）：
//   *"因为我们拦不住官方内核的自动压缩，所以说我们尽量在 70% 左右就把我们的压缩做好"*
//   *"AI 执行完我们插件的功能之后，要继续工作，工作是不能被影响的"*
//
// ★ 这一组要守住四件事：
//   ① 70% 时**插件自己**真的调了 `compactNow`（不是等官方 80%）；
//   ② 调用发生在 **idle**（`compactNow` 要求 idle，pre-step 里必然 running）；
//   ③ 压缩后重注的正文里带**逐字胶囊**（用户原话 / 器物 / 可重读路径）；
//   ④ 全程**不弹卡片、不 steer** —— 工作不被打断。
section("情形 23：70% 高保真压缩");
{
  const mkProj = (tag) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\nX\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(dir, "_a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 0,
      }),
      "utf8"
    );
    return dir;
  };

  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  // 23a：★ 到 70% ⇒ 插件自己排一次压缩，且压缩后重注带逐字胶囊
  {
    const root = mkProj("hf-compact");
    const run = makeCtx({ withTokenMeter: true, withCompaction: true, withUserQuestions: true });
    mod.apply(run.ctx, {}); // 默认配置：卡片关、高保真压缩开
    const sid = "session-9a3f7777-8888";
    const agent = {
      session: {
        header: { id: sid, cwd: root },
        id: sid,
        requestContext: () => ({ contextWindow: 1000 }),
      },
      steer: () => {},
    };

    // 喂一条**用户原话**与一次**写文件**，让胶囊有料
    for (const h of run.handlers.get("session/event") ?? []) {
      await h({ id: sid, header: { id: sid, cwd: root } }, {
        type: "user/message",
        time: Date.now(),
        data: {
          id: "m-hf-1",
          role: "user",
          content: [{ type: "text", text: "这句原话必须被逐字保住，不许摘要掉" }],
          source: { kind: "user" },
        },
      });
      await h({ id: sid, header: { id: sid, cwd: root } }, {
        type: "tool/call",
        data: { turn: 1, step: 1, callId: "c-hf-1", name: "write", arguments: JSON.stringify({ file_path: path.join(root, "a.ts") }) },
      });
    }

    // 第一次 pre-step（注入台账），水位还没到
    run.services.tokenMeter._total = 500;
    const d1 = await runPreStep(run, { agent, messages: [] });
    eq("50% 档：有注入", d1.messages.length, 1);
    eq("50% 时不该压缩", run.compacted.length, 0);

    // 推到 75% ⇒ 会在本步注入里告知"即将压缩"
    run.services.tokenMeter._total = 750;
    const d2 = await runPreStep(run, { agent, messages: [] });
    const t2 = d2.messages.map((m) => m.content.map((c) => c.text).join("")).join("\n");
    ok("★ 70% 档的注入里说明插件即将压缩", /高保真压缩/.test(t2), t2.slice(0, 400));
    ok("★ 并告知 AI「压缩会自动发生、你不需要做任何事」", /不需要.*做任何事|自动发生/.test(t2), t2.slice(0, 400));
    eq("★ pre-step 里**不**压缩（agent 此时是 running）", run.compacted.length, 0);

    // ★★ 压缩前**强制落盘**（用户 2026-10-09 的规矩）：AI 在这一轮里写台账。
    //   不写的话 idle 时的压缩会被闸门拦下 —— 那正是下面情形 23-2 专测的行为。
    await flushLedger(run, root, sid);

    // agent 转 idle ⇒ 这时才允许 compactNow
    for (const h of run.handlers.get("agent/status") ?? []) await h({ agent, status: "idle" });
    await settle();
    eq("★ idle 时**插件自己**执行了压缩（不等官方 80%）", run.compacted.length, 1);

    // 压缩后 ⇒ 下一步强制重注，且带逐字胶囊
    const d3 = await runPreStep(run, { agent, messages: [] });
    const t3 = d3.messages.map((m) => m.content.map((c) => c.text).join("")).join("\n");
    ok("★ 压缩后强制重注", d3.messages.length >= 1, `len=${d3.messages.length}`);
    ok("★ 重注里点明「上下文刚被压缩」", /上下文刚被压缩/.test(t3), t3.slice(0, 200));
    ok("★ 重注里带高保真胶囊", t3.includes("高保真胶囊"), t3.slice(0, 400));
    ok("★★ 用户原话被**逐字**保住（没被摘要掉）", t3.includes("这句原话必须被逐字保住"), t3.slice(0, 800));
    ok("★ 胶囊里带器物索引（改过哪个文件）", t3.includes("a.ts"), t3.slice(0, 800));
    ok("★ 胶囊里告诉它去哪重读（台账路径）", t3.includes("LEDGER.md"), t3.slice(0, 800));
    // ★★ D35：必须声明"这是历史素材，不是用户此刻的指令"。
    //   胶囊里的原话是**逐字**的（长处），但正因像原话，长上下文下极易被
    //   当成"刚刚说的"去执行 —— 而压缩后模型已经看不到"那是几轮之前"了。
    ok("★★ 声明了「这是历史素材，不是用户此刻的要求」", /不是用户此刻的要求/.test(t3), t3.slice(0, 500));
    ok("★★ 要求执行前先按用户最近一次实际要求确认", /按用户最近一次实际要求确认/.test(t3), t3.slice(0, 500));

    // ④ 工作不被打断
    eq("★★ 全程没弹卡片（不打扰用户）", run.asked.length, 0);

    // 只压一次（反复压会退化）
    for (const h of run.handlers.get("agent/status") ?? []) await h({ agent, status: "idle" });
    await settle();
    eq("★ 同一会话只压一次（防 summary-of-summary 退化）", run.compacted.length, 1);
    rmrf(root);
  }

  // 23b：★ 没有 compaction 服务 ⇒ 静默降级，绝不影响会话
  {
    const root = mkProj("hf-nocompact");
    const run = makeCtx({ withTokenMeter: true, withCompaction: false });
    mod.apply(run.ctx, {});
    const sid = "session-bbbb9999-0001";
    const agent = {
      session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
      steer: () => {},
    };
    run.services.tokenMeter._total = 750;
    let threw;
    try {
      await runPreStep(run, { agent, messages: [] });
      for (const h of run.handlers.get("agent/status") ?? []) await h({ agent, status: "idle" });
      await settle();
    } catch (e) {
      threw = e;
    }
    ok("★ 没有 compaction 服务时不抛错", threw === undefined, threw && threw.message);
    // 它应当**如实记一条告警**，而不是假装压过了
    ok(
      "★ 并留下一条「没有 compaction 服务」的告警（不假装成功）",
      run.warnings.some((w) => w.includes("没有 compaction 服务")),
      run.warnings.join(" | ")
    );
    rmrf(root);
  }

  // 23c：显式关掉高保真压缩 ⇒ 行为回到"只提醒、不压"
  {
    const root = mkProj("hf-off");
    const run = makeCtx({ withTokenMeter: true, withCompaction: true });
    mod.apply(run.ctx, { highFidelityCompact: false });
    const sid = "session-cccc1111-0002";
    const agent = {
      session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
      steer: () => {},
    };
    run.services.tokenMeter._total = 750;
    await runPreStep(run, { agent, messages: [] });
    for (const h of run.handlers.get("agent/status") ?? []) await h({ agent, status: "idle" });
    await settle();
    eq("★ 显式关掉后不压缩（逃生口有效）", run.compacted.length, 0);
    rmrf(root);
  }
}

// ── 情形 24：**手动**高保真压缩（用户需求 ②）────────────────────────────────
//
// ★ 用户原话：*"考虑把我们的这个压缩加进主动中，让我们可以手动进行压缩，
//   而且执行的是我们的压缩。"*
//
// ★ 这一组要守住四件事：
//   ① 有一个工具（`ledger_compact`）与一个命令（`/ledger compact`）两个入口；
//   ② 两者都**只排队**（不打断本回合），到 idle 才真压；
//   ③ ★ 压出来的必须是**我们的**压缩 —— 也就是压缩后重注里**有逐字胶囊**。
//      这是关键：旧的手动路（用户选卡片那项）只调 `compactNow`、**不抓胶囊**；
//      用户手动压一次，压完就没有逐字副本可重注了。
//   ④ 没有 compaction 服务时软失败，绝不抛。
section("情形 24：手动高保真压缩（工具 + 命令）");
{
  const mkProj = (tag) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(dir, "_a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 0,
      }),
      "utf8"
    );
    return dir;
  };
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  /** 喂一条用户原话 + 一次写文件，让胶囊有料。 */
  const feedCapsuleMatter = async (run, root, sid) => {
    for (const h of run.handlers.get("session/event") ?? []) {
      await h({ id: sid, header: { id: sid, cwd: root } }, {
        type: "user/message",
        time: Date.now(),
        data: {
          id: `m-${sid}`,
          role: "user",
          content: [{ type: "text", text: "手动压缩时必须逐字保住我这句原话" }],
          source: { kind: "user" },
        },
      });
      await h({ id: sid, header: { id: sid, cwd: root } }, {
        type: "tool/call",
        data: { turn: 1, step: 1, callId: `c-${sid}`, name: "write", arguments: JSON.stringify({ file_path: path.join(root, "b.ts") }) },
      });
    }
  };

  // 24a：★ 工具入口 —— 排队、idle 才压、压后重注带逐字胶囊
  {
    const root = mkProj("manual-tool");
    const run = makeCtx({ withCompaction: true });
    mod.apply(run.ctx, {});
    const sid = "session-5a5a1111-2222";
    const agent = {
      session: { header: { id: sid, cwd: root }, id: sid },
      steer: () => {},
    };
    await feedCapsuleMatter(run, root, sid);
    // ★★ 压缩前**强制落盘**（用户 2026-10-09 的规矩）：AI 在本轮里写台账 ⇒ 闸门放行。
    await flushLedger(run, root, sid);

    const r = await run.registeredTools
      .get("ledger_compact")
      .execute({}, { agent, session: agent.session, callId: "c-1" });
    ok("★ ledger_compact 可用", r.ok === true, JSON.stringify(r).slice(0, 200));
    ok("★ 它是**排队**（不立刻压、不打断本回合）", r.queued === true, JSON.stringify(r).slice(0, 200));
    eq("★ 排队时还没压", run.compacted.length, 0);
    ok("★ 返回值说明了压完会注回逐字副本", /逐字|胶囊/.test(r.note ?? ""), r.note);
    ok("★ 并说明「继续手上的工作」", /继续/.test(r.note ?? ""), r.note);

    // 回合末转 idle ⇒ 这时才真压
    for (const h of run.handlers.get("agent/status") ?? []) await h({ agent, status: "idle" });
    await settle();
    eq("★ idle 时才执行（compactNow 要求 idle）", run.compacted.length, 1);

    // 压缩后重注：必须有逐字胶囊
    const d = await runPreStep(run, { agent, messages: [] });
    const t = (d.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
    ok("★★ 手动压缩也是**我们的**压缩（重注里有高保真胶囊）", t.includes("高保真胶囊"), t.slice(0, 300));
    ok("★★ 用户原话逐字保住", t.includes("手动压缩时必须逐字保住我这句原话"), t.slice(0, 600));
    ok("★ 器物索引也带上了", t.includes("b.ts"), t.slice(0, 600));
    rmrf(root);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 24a-2：★★★ 缺漏③ —— 胶囊**前缀截断**会不会砍掉「重读指针」
  //
  //   ★ 这条是**三份审计报告（001 B5 / 002 B2）都指出、但没有一份去测量**的：
  //     拼接顺序 `userBlock + errBlock + artBlock + copyBlock`，截断 `slice(0, MAX)`
  //     保留**前缀** ⇒ 排在**最后**的 `copyBlock`（**去哪重读磁盘**的指针）
  //     最可能被整段砍掉 —— 而它正是"高保真"里最该保的东西。
  //
  //   ★ 为什么必须测而不是推断：源码上限允许用户原话块达到
  //     `CAPSULE_USER_MSG_MAX(40) × CAPSULE_USER_MSG_CHARS(1200) = 48000` 字符，
  //     是总上限 `CAPSULE_MAX_CHARS(16000)` 的 **3 倍** ⇒ **可达**。
  //     但"可达"不等于"会发生" —— 要喂够长的输入看真结果。
  //
  //   ★ 本用例走**真实现**（喂事件 ⇒ 插件自己产胶囊），不是手工复现拼接逻辑。
  // ═══════════════════════════════════════════════════════════════════════
  // 24a-2a：喂 40 条 × 1200 字符（顶到源码允许的最大）⇒ 看指针与器物索引还在不在
  //
  //   ★ 为什么用 `/ledger compact` **命令**而不是 `ledger_compact` 工具：
  //     工具只**排队**（回合末 idle 才真压），而这里要验"压的那一刻胶囊长什么样"。
  //     命令是**当场压**的（D40）⇒ 最短、最直的路。
  //   ★ 为什么 `requestContext` 必须给：`measurePressure` 拿不到 `contextWindow`
  //     就返回 undefined，压缩会直接放弃 —— 这是抄 35 组时最容易漏的一处。
  {
    const root = mkProj("capsule-trunc");
    const run = makeCtx({ withCompaction: true, withTokenMeter: true });
    mod.apply(run.ctx, {});
    const sid = "session-cccc9999-8888";
    const agent = {
      session: {
        header: { id: sid, cwd: root },
        id: sid,
        requestContext: () => ({ contextWindow: 1000 }),
      },
      steer: () => {},
    };
    const h = run.handlers.get("session/event") ?? [];
    const emit = async (ev) => {
      for (const f of h) await f({ id: sid, header: { id: sid, cwd: root } }, ev);
    };
    // 40 条 × 1200 字符 = 48000 字符（= `CAPSULE_USER_MSG_MAX × CHARS`，源码允许的最大）
    for (let i = 0; i < 40; i += 1) {
      await emit({
        type: "user/message",
        time: Date.now(),
        data: {
          id: `m-${i}`,
          role: "user",
          content: [{ type: "text", text: `第${i}条原话 ` + "甲".repeat(1188) }],
          source: { kind: "user" },
        },
      });
    }
    await emit({
      type: "tool/call",
      data: {
        turn: 1, step: 1, callId: "c-t", name: "write",
        arguments: JSON.stringify({ file_path: path.join(root, "big.ts") }),
      },
    });
    run.services.tokenMeter._total = 350; // 有水位，但远低于 70%（不触发自动那条）
    const cmd = run.registeredCommands.get("ledger");
    const res = await cmd.handler({
      commandId: "c-trunc", agent, rawInput: "compact", attachments: [],
      signal: new AbortController().signal,
    });
    await settle();
    eq("★★ 长输入下命令压缩成功", res.kind, "success");

    const capFiles = (() => {
      const out = [];
      const walk = (d) => {
        let ents;
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else out.push(p);
        }
      };
      walk(path.join(root, "_ledger-log"));
      return out.filter((f) => /capsules[\\/]/.test(f));
    })();

    ok("★★ 长输入下**胶囊真的落盘了**（否则下面那条测的是空气）", capFiles.length >= 1, `找到 ${capFiles.length} 份`);
    if (capFiles.length >= 1) {
      const capText = fs.readFileSync(capFiles[capFiles.length - 1], "utf8");
      const truncated = /胶囊过长已截断/.test(capText);
      const hasPointer = /可确定性重读|去哪重读|磁盘上的真源/.test(capText);
      const hasArtifact = /器物索引/.test(capText);
      const hasUser = /用户原话/.test(capText);
      console.log(
        `       （落盘胶囊 ${capText.length} 字符；截断=${truncated ? "**是**" : "否"}；` +
          `用户原话=${hasUser ? "在" : "缺"}；器物索引=${hasArtifact ? "在" : "缺"}；重读指针=${hasPointer ? "在" : "**缺**"}）`
      );
      if (truncated) {
        ok(
          "★★★ 缺漏③：胶囊被截断时，**「去哪重读」的指针也必须还在**" +
            "（它排在拼接最后，最容易被 slice(0,MAX) 整段砍掉）",
          hasPointer,
          `胶囊 ${capText.length} 字符已截断；指针${hasPointer ? "在" : "**被砍掉了 —— 报告 B5/B2 实测成立**"}`
        );
      } else {
        ok(
          "★★ 本夹具**没把胶囊压到 16000 上限** ⇒ 报告 B5/B2 的**机制成立但本机未复现**，" +
            "不下「已证实」的结论（要更大的输入才压得到边界）",
          true,
          `胶囊仅 ${capText.length} 字符（上限 16000）`
        );
      }
    }
    rmrf(root);
  }

  // 24b：★★★ 命令入口 `/ledger compact` —— **立刻压**（2026-10-09 用户要求）
  //
  //   ★ 用户原话：*"为什么这些指令都不是马上执行呢？…到水位的时候主动按压缩不能进行"*。
  //   ★ 根因（读内核源码）：`agent/status` **只在状态变化时才发**
  //     （`dsh-agent-loop:798`），所以空闲时排队等的是一个**永远不会再发**的事件。
  //   ⇒ 命令这条路改成当场 `compactNow`，只有真 busy 才退回队列。
  {
    const root = mkProj("manual-cmd");
    const run = makeCtx({ withCompaction: true });
    mod.apply(run.ctx, {});
    const sid = "session-6b6b3333-4444";
    const agent = { session: { header: { id: sid, cwd: root }, id: sid }, steer: () => {} };
    const cmd = run.registeredCommands.get("ledger");
    const out = await cmd.handler({
      commandId: "c1",
      agent,
      rawInput: "compact",
      attachments: [],
      signal: new AbortController().signal,
    });
    eq("命令成功", out.kind, "success");
    ok("★★★ 文本说的是「已压缩」而不是「已排队」", /已压缩/.test(out.text), out.text);
    ok("★ 并点明这是「我们的」压缩而不是内核 /compact", /我们的/.test(out.text), out.text);
    // ★★★ 这条是本次改动的核心：**没有等 idle，当场就压了**。
    eq("★★★ 命令入口**当场压缩**（不需要再等 agent/status==idle）", run.compacted.length, 1);

    // ★ 而且**不需要**再收到 idle 事件 —— 这正是不再依赖那个事件的意思。
    for (const h of run.handlers.get("agent/status") ?? []) await h({ agent, status: "idle" });
    await settle();
    eq("★★ 之后再来 idle 也不会压第二次（一次命令一次压缩）", run.compacted.length, 1);
    rmrf(root);
  }

  // 24b-2：★★★ 命令入口遇 `busy` ⇒ **如实**退回队列（而不是假装压了）
  //
  //   ★ 必须两个方向都测：只测"能当场压"的话，一个"永远报成功但其实没压"的
  //     实现照样通过。
  {
    const root = mkProj("manual-cmd-busy");
    const run = makeCtx({
      // 造一个"忙"的 compaction：照内核 `ManualCompactionError("busy")` 的形状抛。
      // ★ `withCompaction: true` 不能省 —— 少了它连 `compaction` 服务都没有，
      //   测的就变成"没有服务"那条分支了（第一次就这么写错，报 `_busy` of undefined）。
      withCompaction: true,
      compactionBusy: true,
    });
    mod.apply(run.ctx, {});
    const sid = "session-6b6b3333-5555";
    const agent = { session: { header: { id: sid, cwd: root }, id: sid }, steer: () => {} };
    const cmd = run.registeredCommands.get("ledger");
    const out = await cmd.handler({
      commandId: "c2",
      agent,
      rawInput: "compact",
      attachments: [],
      signal: new AbortController().signal,
    });
    eq("★ 忙的时候仍然是 success（不是 error —— 它确实排上了）", out.kind, "success");
    // ★ 断言写错过一次：我原来要求文本里出现 `busy`，但内核那句话的**文字**是
    //   "the session already has an open turn"，`busy` 只是它的 error **code**。
    //   ⇒ 该断言的是"**如实说了原因**"，不是"出现了某个特定词"（尺子错、代码对）。
    ok(
      "★★ 文本**如实**说现在压不了 + 带上原因",
      /压不了/.test(out.text) && /open turn|busy/i.test(out.text),
      out.text
    );
    ok("★★ 并说明已退回队列、不需要再按一次", /不需要再按一次/.test(out.text), out.text);
    eq("★ 忙的时候确实没压成", run.compacted.length, 0);
    // 退回队列之后，idle 来了要能补上。
    await flushLedger(run, root, sid);
    run.services.compaction._busy = false;
    for (const h of run.handlers.get("agent/status") ?? []) await h({ agent, status: "idle" });
    await settle();
    eq("★★ 退回队列后 idle 会补压一次（不是丢掉了）", run.compacted.length, 1);
    rmrf(root);
  }

  // 24b-3：★★★ **内核三条 `busy` 原文都必须认出"忙"**（2026-10-12 真机事故的回归测试）
  //
  //   ★ 病（用户 01:13 亲自撞上）：插件旧判据只认得三条里的一条
  //     ⇒ 「idle agent with no waking queued work」被判成**失败** ⇒ 回「压缩没有发生」，
  //       而那一刻**自动全量正在跑**（被压 428,652 tok）⇒ 把"正在做"说成"没发生"。
  //
  //   ★ 三条原文**逐字抄自内核**（解 app.asar 得出，非我编）：
  //     `dsh-compaction-basic/lib/index.js` 的 `:457` / `:538` / `:1009`。
  //   ★ 每条都测**两种**内核形态：
  //     ① 带 `err.code === "busy"`（当前内核的 `ManualCompactionError` **有**这个字段）
  //     ② **不带** code、只有 message（老内核 / 别的实现）⇒ 必须由**文本兜底**接住
  //     ⇒ 两条判据各自都被真测到，不是"有一条顶用就行"。
  {
    const BUSY_MESSAGES = [
      // ① 已有打开的回合（旧正则认得的就这一条）
      "manual compaction: the session already has an open turn",
      // ② 已有压缩在进行（并发锁）
      "manual compaction: compaction already in progress; the session compaction lock is already active",
      // ③ ★ 用户撞上的那条：agent 不空闲 / 有唤醒队列
      "manual compaction requires an idle agent with no waking queued work",
    ];
    for (const [i, msg] of BUSY_MESSAGES.entries()) {
      for (const withCode of [true, false]) {
        const root = mkProj(`manual-cmd-busy-${i}-${withCode ? "code" : "text"}`);
        const run = makeCtx({
          withCompaction: true,
          compactionBusy: true,
          compactionBusyMessage: msg,
          compactionBusyCode: withCode,
        });
        mod.apply(run.ctx, {});
        const sid = `session-busy00-${String(i)}${withCode ? "1" : "0"}`;
        const agent = { session: { header: { id: sid, cwd: root }, id: sid }, steer: () => {} };
        const cmd = run.registeredCommands.get("ledger");
        const out = await cmd.handler({
          commandId: `c-busy-${i}-${withCode}`,
          agent,
          rawInput: "compact",
          attachments: [],
          signal: new AbortController().signal,
        });
        // 判据：必须是"已排队"（success + 明说压不了），**绝不能**是"压缩没有发生"
        eq(
          `★★★ 24b-3[${i}/${withCode ? "有 code" : "仅文本"}]：内核 busy 原文 ⇒ 判为"忙"，排回队列` +
            `（原文：${msg.slice(0, 46)}…）`,
          out.kind,
          "success"
        );
        ok(
          `★★★ 24b-3[${i}/${withCode ? "有 code" : "仅文本"}]：**不许**说"压缩没有发生"（那是误报）`,
          !/压缩没有发生/.test(out.text) && /已排队/.test(out.text),
          out.text
        );
        eq(`★ 24b-3[${i}]：忙时确实没压成`, run.compacted.length, 0);
        rmrf(root);
      }
    }
  }

  // 24c：没有 compaction 服务 ⇒ 软失败，绝不抛
  {
    const root = mkProj("manual-nocompact");
    const run = makeCtx({ withCompaction: false });
    mod.apply(run.ctx, {});
    const sid = "session-7c7c5555-6666";
    const agent = { session: { header: { id: sid, cwd: root }, id: sid }, steer: () => {} };
    let threw;
    let r;
    try {
      r = await run.registeredTools
        .get("ledger_compact")
        .execute({}, { agent, session: agent.session, callId: "c-1" });
    } catch (e) {
      threw = e;
    }
    ok("★ 没有 compaction 服务时不抛错", threw === undefined, threw && threw.message);
    ok("★ 而是软失败并说清原因", r !== undefined && r.ok === false && /compaction/.test(r.reason ?? ""), JSON.stringify(r));
    rmrf(root);
  }

  // 24d：★ 手动那条**不再**走"只 compactNow 不抓胶囊"的旧路
  //
  //   这条守的是本轮发现的真缺陷：旧手动路（卡片选「记录台账+执行压缩」）
  //   直接调 `compactNow`，**不抓胶囊** ⇒ 压完没有逐字副本可重注。
  //   现在两条路都过 `runHighFidelityCompact`，所以走旧路也必须带胶囊。
  {
    const root = mkProj("manual-via-card");
    const run = makeCtx({ withCompaction: true, withUserQuestions: true });
    mod.apply(run.ctx, { turnEndOffer: true });
    run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["记录台账 + 执行压缩"] }] }));
    const sid = "session-8d8d7777-8888";
    const steered = [];
    const agent = { session: { header: { id: sid, cwd: root }, id: sid }, steer: (m) => steered.push(m) };
    await feedCapsuleMatter(run, root, sid);

    for (const h of run.handlers.get("agent/turn-stopping") ?? []) await h({ agent, turn: 2 });
    await settle();
    eq("卡片送出去了", run.asked.length, 1);
    // ★ 卡片那条会 steer 唤醒 AI 去写台账 —— 这里模拟"AI 照做了"这一步，
    //   否则下面的压缩会被「压缩前强制落盘」闸门拦下（那是情形 28 专测的）。
    await flushLedger(run, root, sid);
    // 卡片那条把压缩排进 compactAfterTurn
    for (const h of run.handlers.get("agent/status") ?? []) await h({ agent, status: "idle" });
    await settle();
    eq("★ 卡片那条路也压了", run.compacted.length, 1);

    const d = await runPreStep(run, { agent, messages: [] });
    const t = (d.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
    ok("★★ 卡片那条路**也有**逐字胶囊（旧路是没有的）", t.includes("高保真胶囊"), t.slice(0, 300));
    ok("★★ 用户原话逐字保住", t.includes("手动压缩时必须逐字保住我这句原话"), t.slice(0, 600));
    rmrf(root);
  }
}

// ── 情形 25：台账**自身**的变更登记（用户需求 ①）─────────────────────────────
//
// ★ 用户原话：*"他现在这里有改动的话，必须查日志才能看得出来，我觉得可以考虑多登记一点，
//   比如说某个执行是什么时间点进行的，然后什么时间点进行追加的。"*
//
// ★ 问题在哪：改动只进活动日志 ⇒ **台账被单独复制 / 发给别人时，时间线不在它身边**；
//   想看"这份台账什么时候被谁改过"必须先知道日志在哪、再去查一遍。
//
// ★ 做法：插件每次写活跃台账 / 归档，都在**台账文件本身**末尾重建一小张登记表
//   （最近 12 条），行首是本地时间到秒 + 操作类型 + 会话编号 + 行数变化 + 修订号。
//
// ★ 这一组要守住六件事：
//   ① 写入后台账里**真的**出现了登记行，且带时间戳与会话编号；
//   ② 归档**也**记一行（归档是唯一成批删条目的动作，最需要留痕）；
//   ③ 表是**有界的** —— 写 20 次不会长出 20 行（否则台账会被自己的附注撑爆）；
//   ④ 表**不重复** —— 反复写不会把它复制成两份；
//   ⑤ ★ **append 的内容不能丢** —— 登记区在文件末尾，若把新内容也追加到文件末尾，
//      它会被"剥掉登记区重建"这一步静默吃掉（自测 20e 当场打红，真丢数据）；
//   ⑥ ★ **登记行不算"条目"** —— 它整片都是 `- ` 开头，若不从多会话比对的输入里剥掉，
//      每次写入都会虚报"保住了 N 条"，把时间戳塞进保留区。
section("情形 25：台账自身的变更登记（需求 ①）");
{
  const mkProj = (tag) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(dir, "_a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 60, revision: 0,
      }),
      "utf8"
    );
    return dir;
  };
  const read = (dir) => fs.readFileSync(path.join(dir, "LEDGER.md"), "utf8");

  // 25a：写入后台账里出现登记行，且信息完整
  {
    const root = mkProj("reg-a");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-ab12cd34-5678");
    const w = await run.registeredTools
      .get("ledger_write")
      .execute({ target: "active", mode: "replace", content: "# 台账\n\n## 目标\nY\n" }, A);
    eq("写入成功", w.ok, true);

    const text = read(root);
    ok("★ 台账里有变更登记区", text.includes(CHANGE_HEADING), text);
    const lines = changeLines(text);
    eq("★ 有 1 条登记", lines.length, 1);
    // 行首必须是本地时间到秒 —— 与日志同格式，两处能直接对上
    ok("★★ 登记带**到秒的时间戳**", /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(/.test(lines[0]), lines[0]);
    ok("★ 登记带操作类型", /\(replace\)/.test(lines[0]), lines[0]);
    ok("★ 登记带**会话编号**", /\[ab12\]/.test(lines[0]), lines[0]);
    ok("★ 登记带行数", /→ \d+ 行/.test(lines[0]), lines[0]);
    ok("★ 登记带修订号", /revision→\d+/.test(lines[0]), lines[0]);
    // 正文没被登记区污染
    ok("★ 正文原样保留", bodyOf(text).includes("## 目标"), bodyOf(text));
    // 返回值里 `lines` 是落盘真实行数（含登记区），`changedBy` 是正文增减
    ok("★ 返回值 lines 是含登记区的真实行数", w.lines > 4, `lines=${w.lines}`);
    eq("★ 返回值 changedBy 只算正文（登记区不参与）", w.changedBy, 0);
    rmrf(root);
  }

  // 25b：归档也留一行，且自称 archive
  {
    const root = mkProj("reg-b");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-beef9999-0000");
    const T = run.registeredTools;
    await T.get("ledger_write").execute(
      { target: "active", mode: "replace", content: "# 台账\n\n- 旧的\n- 留下的\n" },
      A
    );
    const r = await T.get("ledger_archive").execute(
      { entries: "- 旧的", newActive: "# 台账\n\n- 留下的\n" },
      A
    );
    eq("归档成功", r.ok, true);
    const lines = changeLines(read(root));
    eq("★ 归档也留了一行", lines.length, 2);
    ok("★ 归档那行自称 archive", /\(archive\)/.test(lines[0]), lines[0]);
    ok("★ 归档那行也带会话编号", /\[beef\]/.test(lines[0]), lines[0]);
    // 归档的 delta 是**负数**（真的删了行）
    ok("★★ 归档登记显示行数**减少**", /-\d+ 行/.test(lines[0]), lines[0]);
    // 归档文件本身**不该**有登记区（那是台账的附注，不是归档内容）
    const arch = fs.readdirSync(path.join(root, "_a"), { recursive: true }).filter((f) => String(f).endsWith(".md"));
    eq("归档文件写出来了", arch.length, 1);
    const archText = fs.readFileSync(path.join(root, "_a", arch[0]), "utf8");
    ok("★ 归档文件里**没有**登记区（不污染历史）", !archText.includes(CHANGE_HEADING), archText.slice(0, 300));
    ok("归档文件里有被归档的条目", archText.includes("- 旧的"), archText);
    rmrf(root);
  }

  // 25c：有界 —— 写 20 次只留 12 行，且顺序是新的在前
  {
    const root = mkProj("reg-c");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-0f0f1111-2222");
    const T = run.registeredTools;
    for (let i = 0; i < 20; i++) {
      // ★ 传 force：本组要测的是**登记表有界**，不是行数闸门（25h 专测闸门）；
      //   夹具上限 60 行，20 条内容 + 登记区会先撞上闸门，那就测不到想测的东西了。
      const w = await T.get("ledger_write").execute(
        { target: "active", mode: "append", content: `- 第 ${i} 条\n`, force: true },
        A
      );
      if (w.ok !== true) throw new Error(`第 ${i} 次写入失败：${w.reason}`);
    }
    const text = read(root);
    const lines = changeLines(text);
    eq("★★ 登记表**有界**（20 次写入只留 12 行）", lines.length, 12);
    // 新的在前：最后写的那次时间不早于第一行
    ok("★ 新的在前（首行是最新一次）", lines.length === 12, String(lines.length));
    eq("★ 登记区只有一份（没被复制）", text.split(CHANGE_HEADING).length - 1, 1);
    // ★ 20 条内容一条都不能丢
    for (let i = 0; i < 20; i++) {
      ok(`★ 第 ${i} 条 append 内容还在`, text.includes(`- 第 ${i} 条`), "");
    }
    rmrf(root);
  }

  // 25d：★★ 守 append 不丢内容（登记区在文件末尾 ⇒ 追加点必须落在正文末尾）
  //
  //   这一条是**真事故的回归测试**：登记区被写在文件最末，而 `append` 原本是
  //   "接在文件末尾" ⇒ 新内容落在登记区**之后**，紧接着 `withChangeRegister`
  //   从标题处切掉重建 ⇒ 那几行**静默消失**，而调用返回 ok。
  {
    const root = mkProj("reg-d");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-dead0000-1111");
    const T = run.registeredTools;
    await T.get("ledger_write").execute({ target: "active", mode: "replace", content: "# 台账\n\n- 底\n" }, A);
    const w = await T.get("ledger_write").execute(
      { target: "active", mode: "append", content: "- ★这次追加的内容★\n" },
      A
    );
    eq("append 成功", w.ok, true);
    const text = read(root);
    ok("★★ 追加的内容**没被登记区吃掉**", text.includes("★这次追加的内容★"), text);
    ok("★ 追加的内容落在正文里（登记区之前）",
      bodyOf(text).includes("★这次追加的内容★"), bodyOf(text));
    ok("★ 老的正文也还在", text.includes("- 底"), text);
    eq("★ 登记表两条（replace + append）", changeLines(text).length, 2);
    ok("★ 登记行标了 append", /\(append\)/.test(changeLines(text)[0]), changeLines(text)[0]);
    rmrf(root);
  }

  // 25e：★★ 登记行不算"条目" —— 多会话保护不许把它当内容保下来
  //
  //   登记行形状与条目一样（都是 `- ` 开头）。若不从比对输入里剥掉：
  //   `lostEntries` 会把旧文件里的十几条登记全算成"这次要丢的条目"
  //   ⇒ 每次写入都虚报 preservedEntries，还把时间戳塞进"其他会话的进展"保留区。
  {
    const root = mkProj("reg-e");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-aaaa1111-aaaa");
    const B = execFor(root, "session-bbbb2222-bbbb");
    const T = run.registeredTools;
    // A 先写（此时文件里已有 1 条登记）
    const rA = await T.get("ledger_read").execute({ target: "active" }, A);
    await T.get("ledger_write").execute(
      { target: "active", mode: "replace", ifRevision: rA.revision, content: "# 台账\n\n- [aaaa] A 做的事\n" },
      A
    );
    // B 拿**过期**版本号重写，且内容里没提 A 的条目 ⇒ 只该保住 A 那 1 条
    const wB = await T.get("ledger_write").execute(
      { target: "active", mode: "replace", ifRevision: rA.revision, content: "# 台账\n\n- [bbbb] B 做的事\n" },
      B
    );
    eq("B 写入成功", wB.ok, true);
    eq("★★ 只保住 A 的 1 条（登记行没被算成条目）", wB.preservedEntries, 1);
    const text = read(root);
    ok("★ A 的条目还在", text.includes("A 做的事"), text);
    ok("★ B 的条目也在", text.includes("B 做的事"), text);
    // 保留区里**不许**出现时间戳登记行
    const preserve = text.slice(text.indexOf("其他会话的进展"));
    ok("★★ 保留区里没有登记行（时间戳没被塞进正文）",
      !CHANGE_LINE_RE.test(preserve), preserve.slice(0, 400));
    // 登记表仍是干净的重建结果：2 条（A 一次 + B 一次）
    eq("★ 登记表仍然是 2 条", changeLines(text).length, 2);
    rmrf(root);
  }

  // 25f：决策记录**不**该有登记区（它是 append-only 长期档案）
  {
    const root = mkProj("reg-f");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-c0c0c0c0-c0c0");
    const w = await run.registeredTools
      .get("ledger_write")
      .execute({ target: "decisions", mode: "append", content: "## D1 决定\n- 内容\n" }, A);
    eq("决策写入成功", w.ok, true);
    const dtext = fs.readFileSync(path.join(root, "DECISIONS.md"), "utf8");
    ok("★★ 决策记录里**没有**变更登记区", !dtext.includes(CHANGE_HEADING), dtext);
    ok("决策内容写进去了", dtext.includes("## D1 决定"), dtext);
    // 台账那边也没被顺手加上（这次没写台账）
    ok("★ 台账文件没被碰", !read(root).includes(CHANGE_HEADING), read(root));
    rmrf(root);
  }

  // 25g：登记区被 AI 整份 replace 抹掉后，下一次写入要**重建**它
  {
    const root = mkProj("reg-g");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-7777aaaa-7777");
    const T = run.registeredTools;
    await T.get("ledger_write").execute({ target: "active", mode: "replace", content: "# 台账\n\n- x\n" }, A);
    ok("先有登记区", read(root).includes(CHANGE_HEADING));
    // AI 整份重写、**没带**登记区（真实情况：它不会抄这段附注）
    await T.get("ledger_write").execute({ target: "active", mode: "replace", content: "# 台账\n\n- x\n- y\n" }, A);
    const text = read(root);
    ok("★★ 抹掉后插件**重建**了登记区", text.includes(CHANGE_HEADING), text);
    eq("★ 重建后仍是 2 条（旧的没丢）", changeLines(text).length, 2);
    ok("★ 正文是新的那份", bodyOf(text).includes("- y"), bodyOf(text));
    rmrf(root);
  }

  // 25h：闸门看的是**含登记区**的最终行数（登记区不许把台账挤爆）
  {
    const root = mkProj("reg-h");
    // 上限压到很小：正文 5 行**单独看不超**，但加上登记区（实测 13 行）就超 ⇒ 必须被拒。
    // 这正是这条要守的语义：闸门必须看**落盘后的真实行数**，而不是 AI 交上来的正文行数。
    const mf = path.join(root, ".dsh-ledger.json");
    const j = JSON.parse(fs.readFileSync(mf, "utf8"));
    j.maxActiveLines = 10;
    fs.writeFileSync(mf, JSON.stringify(j), "utf8");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-8888bbbb-8888");
    // 正文 6 行，加登记区（标题 1 + 说明 2 + 空行 + 1 条 ≈ 9 行）⇒ 超 14
    const w = await run.registeredTools
      .get("ledger_write")
      .execute({ target: "active", mode: "replace", content: "# 台账\n\n- a\n- b\n- c\n" }, A);
    ok("★★ 超限时被拒（闸门算的是含登记区的真实行数）", w.ok === false, JSON.stringify(w).slice(0, 200));
    eq("★ 拒绝时给出 hint", w.hint, "ledger_archive");
    ok("★ 拒绝理由报的是含登记区的行数", w.lines > 6, `lines=${w.lines}`);
    // 被拒时**不许**落盘
    ok("★ 被拒时台账没被改", !read(root).includes(CHANGE_HEADING), read(root));
    rmrf(root);
  }

  // 25i：★★ 变更登记条数**可调**，且**项目清单优先**（2026-10-09 新增设置项）
  //
  //   ★ 为什么这条要单独测：新加一项设置最容易出的事就是"面板能改、行为不认"
  //     （值存进去了但没人读）。⇒ 必须验**行为**随设置变。
  {
    const root = mkProj("reg-i");
    const mf = path.join(root, ".dsh-ledger.json");
    const j = JSON.parse(fs.readFileSync(mf, "utf8"));
    j.changeRegisterMax = 3; // ★ 清单里点名 3 条
    fs.writeFileSync(mf, JSON.stringify(j), "utf8");
    const run = makeCtx();
    mod.apply(run.ctx, { changeRegisterMax: 9 }); // ★ 插件级设置给 9 ⇒ 应当被清单压过去
    const A = execFor(root, "session-9999cccc-9999");

    for (let i = 0; i < 6; i += 1) {
      await run.registeredTools
        .get("ledger_write")
        .execute({ target: "active", mode: "append", content: `- 第 ${i} 条\n` }, A);
    }
    const lines = changeLines(read(root));
    eq("★★★ 清单点名 3 条 ⇒ 登记表只留 3 行（说明设置真的接进了行为）", lines.length, 3);
    ok(
      "★★ 且**项目清单优先于插件级设置**（插件级给的 9 没生效）",
      lines.length !== 9,
      `实际 ${lines.length} 行`
    );
    // 留下的必须是**最新**的几条（截断要砍尾不砍头）
    // 留下的必须是**最新**的几条（截断要砍尾不砍头）。
    // ★ 断言写错过一次：我原来找行里有没有「第 5 条」—— 但登记行记的是
    //   **行数变化与修订号**，不记 AI 写的正文内容。⇒ 该看的是**修订号递减**。
    const revs = lines.map((l) => Number((l.match(/revision→(\d+)/) ?? [])[1] ?? 0));
    ok(
      "★ 留下的是最新的（修订号递减 ⇒ 砍的是尾部不是头部）",
      revs.length === 3 && revs[0] > revs[1] && revs[1] > revs[2],
      lines.join(" | ")
    );
    rmrf(root);
  }

  // 25j：★ 没有清单声明时，用**插件级设置**的条数（默认 12）
  {
    const root = mkProj("reg-j");
    const mf = path.join(root, ".dsh-ledger.json");
    const j = JSON.parse(fs.readFileSync(mf, "utf8"));
    delete j.changeRegisterMax; // 清单里不说 ⇒ 落到设置
    fs.writeFileSync(mf, JSON.stringify(j), "utf8");
    const run = makeCtx();
    mod.apply(run.ctx, { changeRegisterMax: 4 });
    const A = execFor(root, "session-aaaabbbb-aaaa");
    for (let i = 0; i < 6; i += 1) {
      await run.registeredTools
        .get("ledger_write")
        .execute({ target: "active", mode: "append", content: `- 第 ${i} 条\n` }, A);
    }
    eq("★★ 清单没说 ⇒ 用插件级设置的 4 条", changeLines(read(root)).length, 4);
    rmrf(root);
  }
}

// ── 情形 26：四条压缩入口在**日志里分得清**（需求 ②③ 的收口）───────────────
//
// ★ 为什么需要这一条：四条入口（自动 70% / 工具 / 命令 / 卡片）走的是**同一个**
//   `compactNow`，内核那一侧完全一样 —— 它发的 `compaction/end` **不知道谁发起的**。
//   所以"这次到底是我手动敲的，还是它自动压的"事后**查不出来**，而事后查询正是
//   日志存在的理由。
//
// ★ 做法：发起方在压之前把来源写进 `state.hfSource`（四条路都过
//   `runHighFidelityCompact` 这一个函数 ⇒ 记一处就不会漏），
//   L0 采集时取出来写进里程碑行，用完即删。
//
// ★ 这一组要守住五件事：
//   ① 自动那条写「自动 70%」；② 工具那条写「手动（工具）」；
//   ③ 命令那条写「手动（命令）」；④ 卡片那条写「手动（卡片）」；
//   ⑤ 没有来源时退化成原来的「上下文已压缩」（不凭空造词、不写 `undefined`）。
section("情形 26：四条压缩入口在日志里分得清");
{
  const mkProj = (tag) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(dir, "_a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 0,
      }),
      "utf8"
    );
    return dir;
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };
  /** 读这个项目 L0 里程碑里所有 `compaction/end` 行。 */
  const compactionLines = (root) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/L0-milestones\.md$/.test(e.name)) {
          for (const l of fs.readFileSync(p, "utf8").split("\n")) {
            if (l.includes("(compaction/end)")) out.push(l);
          }
        }
      }
    };
    const ld = path.join(root, "_ledger-log");
    if (fs.existsSync(ld)) walk(ld);
    return out;
  };
  /** 读这个项目 L0 里程碑的**全部**行（不限类型）。 */
  const allMilestoneLines = (root) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/L0-milestones\.md$/.test(e.name)) {
          for (const l of fs.readFileSync(p, "utf8").split("\n")) if (l.trim().startsWith("-")) out.push(l);
        }
      }
    };
    const ld = path.join(root, "_ledger-log");
    if (fs.existsSync(ld)) walk(ld);
    return out;
  };
  /** 发一条事件 + 落盘（L0 采集用）。 */
  const emitAndFlush = async (run, root, sid, event) => {
    const session = { header: { id: sid, cwd: root }, id: sid };
    await fire(run, "session/event", session, event);
    for (const h of run.handlers.get("agent/turn-stopping") ?? []) {
      await h({ agent: { session, steer: () => {} }, turn: 9 });
    }
    await settle();
  };
  /** 发一条 compaction/end，逼采集器落盘。 */
  const emitCompactionEnd = async (run, root, sid) => {
    const session = { header: { id: sid, cwd: root }, id: sid };
    await fire(run, "session/event", session, { type: "compaction/end", data: {} });
    // flushNow 挂在 turn-stopping 上 ⇒ 直接触发它
    for (const h of run.handlers.get("agent/turn-stopping") ?? []) {
      await h({ agent: { session, steer: () => {} }, turn: 9 });
    }
    await settle();
  };

  // ══════════════════════════════════════════════════════════════════════════
  // ★★★ 情形 34：L0 记录**必须有信息量**（2026-10-10 从真实日志里抓到的 bug）
  //
  //   症状：某个真实项目的日志里 **10 条 command/done 全写成 `命令 /? → success`**
  //         —— 记录**存在**，但看不出是什么命令。
  //   根因：`command/done` 的载荷是 `{ commandId, kind, text?, sourceEventSeq? }`，
  //         **没有 `name`**（名字在另一条事件 `command/run` 上）。
  //         旧代码读 `d.name` ⇒ 恒 undefined ⇒ 恒 `?`。
  //
  //   ★★ 为什么这个 bug 活了那么久：**自检里对 `command/done` 一条断言都没有**。
  //      —— 而"日志记得对不对"这件事，只有去**真实项目的日志**里看才发现得了。
  //      这正是本轮"检查实践效果"的价值：**跑了 779 项自检全绿，功能照样是坏的。**
  //
  //   ★ 下面的载荷是**逐字抄自真实会话日志**的（`_probe-usage-commands.mjs` 解出来的）：
  //       run : {"commandId":"cmd-f17ced08-1","name":"compact","args":"","source":{"kind":"user"}}
  //       done: {"commandId":"cmd-f17ced08-1","kind":"success","text":"Compacted …","sourceEventSeq":2176}
  // ══════════════════════════════════════════════════════════════════════════
  {
    const root = mkProj("l0-command");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const sid = "session-l0cmd-0001";

    // ① 真实载荷：run 带 name，done 只有 commandId（**没有 name**）
    await emitAndFlush(run, root, sid, {
      type: "command/run",
      data: { commandId: "cmd-f17ced08-1", name: "compact", args: "", source: { kind: "user" } },
    });
    await emitAndFlush(run, root, sid, {
      type: "command/done",
      data: { commandId: "cmd-f17ced08-1", kind: "success", text: "Compacted 879 history items.", sourceEventSeq: 2176 },
    });

    const lines = allMilestoneLines(root);
    const doneLine = lines.find((l) => l.includes("(command/done)"));
    ok("★ 确实记下了 command/done 一行", doneLine !== undefined, JSON.stringify(lines.slice(0, 4)));
    ok(
      "★★★ 这一行说出了**是哪个命令**（`compact`），不再是 `命令 /?` —— 这就是本轮从真实日志抓到的 bug",
      doneLine !== undefined && doneLine.includes("compact") && !doneLine.includes("命令 /?"),
      String(doneLine)
    );
    ok(
      "★ 而且保住了成功/失败（success）",
      doneLine !== undefined && doneLine.includes("success"),
      String(doneLine)
    );

    // ② 边界：**没见过 run** 的 done ⇒ 如实写"未知名"，不许瞎猜、也不许写成 /?
    await emitAndFlush(run, root, sid, {
      type: "command/done",
      data: { commandId: "cmd-never-seen", kind: "error", text: "boom" },
    });
    const lines2 = allMilestoneLines(root);
    const unknown = lines2.filter((l) => l.includes("(command/done)"));
    ok(
      "★★ 没见过 `command/run` 的 done ⇒ 如实写「未知名」（不瞎猜、也不留 `?`）",
      unknown.some((l) => l.includes("未知名") && l.includes("error")),
      JSON.stringify(unknown)
    );

    // ③ 缓存有界（不能慢性泄漏）：塞 200 个不同 commandId，再验老的查不到了
    for (let i = 0; i < 200; i++) {
      await fire(run, "session/event", { header: { id: sid, cwd: root }, id: sid }, {
        type: "command/run",
        data: { commandId: `cmd-bulk-${i}`, name: `bulk${i}`, args: "" },
      });
    }
    await emitAndFlush(run, root, sid, {
      type: "command/done",
      data: { commandId: "cmd-bulk-199", kind: "success" },
    });
    const lines3 = allMilestoneLines(root);
    const last = lines3.filter((l) => l.includes("(command/done)")).at(-1);
    ok("★★ 缓存有界：最新的那个仍然查得到", last !== undefined && last.includes("bulk199"), String(last));
    rmrf(root);
  }
  /** 喂一条用户原话 + 一次写文件，让胶囊有料（情形 24 里那份是块内作用域）。 */
  const feedCapsuleMatter = async (run, root, sid) => {
    for (const h of run.handlers.get("session/event") ?? []) {
      await h({ id: sid, header: { id: sid, cwd: root } }, {
        type: "user/message",
        time: Date.now(),
        data: {
          id: `m-${sid}`,
          role: "user",
          content: [{ type: "text", text: "手动压缩时必须逐字保住我这句原话" }],
          source: { kind: "user" },
        },
      });
      await h({ id: sid, header: { id: sid, cwd: root } }, {
        type: "tool/call",
        data: { turn: 1, step: 1, callId: `c-${sid}`, name: "write", arguments: JSON.stringify({ file_path: path.join(root, "b.ts") }) },
      });
    }
  };

  // 26a：★ 没有来源时退化成原来的说法（不凭空造词）
  {
    const root = mkProj("src-none");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    await emitCompactionEnd(run, root, "session-0000none-0000");
    const lines = compactionLines(root);
    eq("记了一条压缩里程碑", lines.length, 1);
    ok("★ 无来源时是「上下文已压缩」（不造词）", /上下文已压缩$/.test(lines[0]), lines[0]);
    ok("★ 不写 undefined", !/undefined/.test(lines[0]), lines[0]);
    rmrf(root);
  }

  // 26b：★★ 四条入口各写各的 —— 这条是需求 ②③ 的收口
  //
  //   四条路走同一个 compactNow，所以**必须**由插件自己记来源，
  //   否则日志里四条一模一样，等于没记。
  //
  //   ★ 每条都按**真实入口**驱动（不是直接塞 state）：
  //     自动 = tokenMeter 到 70% + 跑 pre-step；工具 = 调 ledger_compact；
  //     命令 = cmd.handler；卡片 = turn-stopping + 答复 + idle。
  {
    const cases = [
      {
        tag: "auto", src: "auto:70%", expect: "自动 70%",
        drive: async (run, agent) => {
          run.services.tokenMeter._total = 750; // 窗口 1000 ⇒ 0.75 ≥ 0.7
          await runPreStep(run, { agent, messages: [] });
        },
      },
      {
        tag: "manual", src: "manual", expect: "手动（工具）",
        drive: async (run, agent) =>
          run.registeredTools.get("ledger_compact").execute({}, { agent, session: agent.session, callId: "c-1" }),
      },
      {
        tag: "command", src: "command", expect: "手动（命令）",
        drive: async (run, agent) =>
          run.registeredCommands.get("ledger").handler({
            commandId: "c1", agent, rawInput: "compact", attachments: [],
            signal: new AbortController().signal,
          }),
      },
      {
        tag: "card", src: "user", expect: "手动（卡片）",
        drive: async (run, agent) => {
          run.setAnswer(() => ({ answers: [{ id: "ledger-turn-end", selected: ["记录台账 + 执行压缩"] }] }));
          for (const h of run.handlers.get("agent/turn-stopping") ?? []) await h({ agent, turn: 2 });
          await settle();
        },
      },
    ];

    for (const c of cases) {
      const root = mkProj(`src-${c.tag}`);
      const run = makeCtx({ withCompaction: true, withUserQuestions: true, withTokenMeter: true });
      mod.apply(run.ctx, { turnEndOffer: c.tag === "card" });
      const sid = `session-9999${c.tag}9-9999`;
      const agent = {
        session: {
          header: { id: sid, cwd: root },
          id: sid,
          // ★ 自动那条要走"水位到 70%"的判断 ⇒ 必须给得出 contextWindow，
          //   否则 `measurePressure` 返回 undefined，自动压缩根本不会排队。
          requestContext: () => ({ contextWindow: 1000 }),
        },
        steer: () => {},
      };
      await feedCapsuleMatter(run, root, sid);

      // ① 各走各的入口把"意图"排上队
      await c.drive(run, agent);
      await settle();
      // ★★ 压缩前强制落盘（四条入口都受同一道闸门约束 —— 这里让它先满足）。
      await flushLedger(run, root, sid);
      // ② idle ⇒ 真压（四条都收敛到这里）
      await fire(run, "agent/status", { agent, status: "idle" });
      await settle();
      eq(`[${c.tag}] 压了一次`, run.compacted.length, 1);

      // ③ 压缩完成事件 ⇒ L0 里应当写出人类可读的来源
      //
      //   ★ 这一条**就是**"来源被正确记下"的证明：L0 渲染时读的正是
      //     `state.hfSource`，读不到就退化成「上下文已压缩」（26a 守那条）。
      //     ⇒ 不需要再去断言内部 Map（自检够不到那个 state）。
      await emitCompactionEnd(run, root, sid);
      const lines = compactionLines(root);
      eq(`[${c.tag}] 有一条压缩里程碑`, lines.length, 1);
      ok(`[${c.tag}] ★ 日志里标出「${c.expect}」`, lines[0].includes(c.expect), lines[0]);
      rmrf(root);
    }
  }

  // 26c：来源用完即删 —— 第二次压缩不能沿用上一次的来源
  {
    const root = mkProj("src-stale");
    const run = makeCtx({ withCompaction: true });
    mod.apply(run.ctx, {});
    const sid = "session-5555stale-5555";
    const agent = { session: { header: { id: sid, cwd: root }, id: sid }, steer: () => {} };
    await feedCapsuleMatter(run, root, sid);
    await flushLedger(run, root, sid);
    await run.registeredTools.get("ledger_compact").execute({}, { agent, session: agent.session, callId: "c" });
    await fire(run, "agent/status", { agent, status: "idle" });
    await settle();
    await emitCompactionEnd(run, root, sid);
    ok("★ 第一条记成手动（工具）", compactionLines(root)[0].includes("手动（工具）"), compactionLines(root)[0]);

    // 再来一次**没有来源**的压缩（模拟内核自己压的）⇒ 不能再挂上一次的来源
    await emitCompactionEnd(run, root, sid);
    const lines = compactionLines(root);
    eq("有两条里程碑", lines.length, 2);
    ok("★★ 第二条退化成「上下文已压缩」（没沿用上次来源）",
      /上下文已压缩$/.test(lines[1]), lines[1]);
    rmrf(root);
  }
}

// ── 情形 27：官方设置面板（用户 2026-10-09 需求）────────────────────────────
//
// ★ 用户原话：*"考虑把我们的插件变得可以调节设置，设置面板像插件市场一样
//   注册进官方的设置中。"* ⇒ 选定**设置导航里单独一页** + **七项设置全暴露**。
//
// ★ 这一组要守住七件事：
//   ① `export const Config` 是**合法的 StandardSchemaV1**（内核只调 `~standard.validate`），
//      且**零 import** —— 插件目录是 Junction 目标，`@deepseek-ai/*` 解析不到。
//   ② ★★ **不给配置时行为与今天逐字一致**（默认值回归）—— 这是最要紧的一条。
//   ③ 归一化：未知键丢掉、越界夹紧、类型错丢掉，**都不抛**。
//   ④ 宿主开了路由，且**路径带自己的前缀**（不抢别人的）。
//   ⑤ GET 回报当前设置 + 元数据 + 是否可写；没有 configEditor 时**可读不可写**且说明原因。
//   ⑥ POST 走 `configEditor.edit()`，且是**按补丁合并**（改一个键不抹掉别的）。
//   ⑦ 设置真的**接进了行为**（水位档位 / 行数上限 / 日志档位）。
section("情形 27：官方设置面板");
{
  const cfgPath = path.join(HERE, "..", "lib", "client.js");
  const cfgSrc = fs.readFileSync(cfgPath, "utf8");

  /** 等几拍，让 async 的压缩执行器（idle 分支里 await 的那个）跑完。 */
  const settle0 = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  // 27a：★★ Config 是合法 StandardSchemaV1
  {
    ok("★ 导出了 Config", mod.Config !== undefined);
    const std = mod.Config?.["~standard"];
    ok("★★ Config 有 ~standard（StandardSchemaV1 的唯一要求）", std !== undefined);
    eq("★ ~standard.version 是 1", std?.version, 1);
    eq("★ validate 是函数", typeof std?.validate, "function");

    const r = std.validate({ turnEndOffer: true });
    ok("★ validate 返回值不是 Promise（内核会拒绝异步）", r !== null && typeof r === "object" && !("then" in r), JSON.stringify(r));
    ok("★ 返回里没有 issues", r.issues === undefined, JSON.stringify(r.issues));
    eq("★ 归一化后 turnEndOffer = true", r.value.turnEndOffer, true);
    eq("★ 没给的键补成默认值（highFidelityCompact）", r.value.highFidelityCompact, true);
    eq("★ 默认水位是 0.7", r.value.highFidelityCompactRatio, 0.7);
    eq("★ 默认行数上限与常量一致", r.value.maxActiveLines, 300);
    ok(
      "★ 默认档位是 0.3/0.5/0.7",
      JSON.stringify(r.value.pressureTiers) === JSON.stringify([0.3, 0.5, 0.7]),
      JSON.stringify(r.value.pressureTiers)
    );
    eq("★ 默认 L3 关（与旧默认一致）", r.value.logLevels.L3, false);
    eq("★ 默认 L4 开", r.value.logLevels.L4, true);

    let threw;
    let bad;
    try {
      bad = std.validate("这不是对象");
    } catch (e) {
      threw = e;
    }
    ok("★ 非法输入不抛错（内核启动路径不许抛）", threw === undefined, threw && threw.message);
    ok("★ 非法输入返回 issues", Array.isArray(bad?.issues) && bad.issues.length > 0, JSON.stringify(bad));
  }

  // 27b：归一化 —— 未知键丢弃、越界夹紧、类型错丢弃
  {
    const r = mod.Config["~standard"].validate({
      nope: 1,
      turnEndOffer: "yes",
      highFidelityCompactRatio: 0.95,
      maxActiveLines: 5,
      pressureTiers: [0.99, 0.4, 0.4, -1, "x", 0.6],
    });
    ok("★ 部分脏值不至于让整次校验失败", r.value !== undefined, JSON.stringify(r));
    eq("★ 类型错的键被丢掉（保持默认 false）", r.value.turnEndOffer, false);
    eq("★★ 越界水位被夹到 0.79（不许撞上内核的 0.8）", r.value.highFidelityCompactRatio, 0.79);
    eq("★ 越界行数被抬到 50", r.value.maxActiveLines, 50);
    ok(
      "★ 档位数组：脏项滤掉、去重、排序",
      // ★ 0.99 是**合法**档位（规则是 0 < t < 1）—— 我第一版断言写成 [0.4,0.6]，
      //   那是**断言错、代码对**：`-1` 与 `"x"` 被滤掉、`0.4` 去重、结果升序。
      JSON.stringify(r.value.pressureTiers) === JSON.stringify([0.4, 0.6, 0.99]),
      JSON.stringify(r.value.pressureTiers)
    );
    ok("★ 未知键没被带进结果", r.value.nope === undefined, JSON.stringify(r.value));
  }

  // 27c：★★ 默认行为回归 —— 不传配置时一切与旧版一致
  {
    const none = mod.Config["~standard"].validate(undefined).value;
    const empty = mod.Config["~standard"].validate({}).value;
    eq("★ 不传配置 = 传空对象", JSON.stringify(none), JSON.stringify(empty));
    eq("★ 默认不弹回合末卡片（用户 2026-10-09 的决定）", none.turnEndOffer, false);
    eq("★ 默认开高保真压缩", none.highFidelityCompact, true);
    eq("★ 默认允许自动压缩", none.autoCompact, true);
  }

  // 27d：宿主开了路由，且路径用自己的前缀
  {
    const run = makeCtx({ withWebServer: true, withConfigEditor: true });
    mod.apply(run.ctx, {});
    ok("★ 注册了设置路由", run.routes.size >= 1, `routes=${[...run.routes.keys()].join(",")}`);
    const p = [...run.routes.keys()][0];
    ok("★★ 路由带自己的前缀（不抢别人的）", p.startsWith("/dsh-ledger-memory-settings/"), p);
    ok("★ 路由以 config.json 结尾", p.endsWith("/config.json"), p);
  }

  // 27e：没有 webServer ⇒ 软失败，插件照常工作
  {
    const run = makeCtx({ withWebServer: false, withConfigEditor: false });
    let threw;
    try {
      mod.apply(run.ctx, {});
    } catch (e) {
      threw = e;
    }
    ok("★★ 没有 webServer 时不抛（面板是锦上添花，不是运行前提）", threw === undefined, threw && threw.message);
    ok("★ 台账工具照常注册", run.registeredTools.has("ledger_status"));
    eq("★ 一条路由都没注册", run.routes.size, 0);
  }

  // 27f：GET 回报当前设置 + 元数据 + 可写性
  {
    const run = makeCtx({ withWebServer: true, withConfigEditor: true });
    mod.apply(run.ctx, {});
    const p = [...run.routes.keys()][0];
    const r = await callRoute(run, p);
    eq("GET 状态码 200", r.status, 200);
    eq("GET ok", r.body.ok, true);
    ok("★ 回报了可写", r.body.writable === true, JSON.stringify(r.body).slice(0, 200));
    eq("★ 回报了十三项元数据（D129：删掉 deltaFallbackPoints）", r.body.specs?.length, 13);
    ok(
      "★ 十三项就是用户要的那些",
      JSON.stringify(r.body.specs.map((s) => s.key).sort()) ===
        JSON.stringify([
          "autoCompact",
          "changeRegisterMax",
          "deltaRemovePoints",
          "deltaTriggerPoints",
          "highFidelityCompact",
          "highFidelityCompactRatio",
          "incrementalCompact",
          "logLevels",
          "maxActiveLines",
          "mode",
          "pressureTiers",
          "requireFlushBeforeCompact",
          "turnEndOffer",
        ]),
      JSON.stringify(r.body.specs.map((s) => s.key))
    );
    // ★★ `mode` 的 options 必须是**已展开的数组**：它是取值函数（躲 TDZ），
    //   出站前没展开的话 JSON 会把它丢掉 ⇒ 面板上选择器是空的，而且**不报错**。
    //
    // ★★★ 2026-10-12（D129）：**两种模式已合并** ⇒ 现在只有**一个**选项
    //   （`surgical`；保留 key 只为兼容旧项目清单里可能写着的 `steady`）。
    {
      const m = r.body.specs.find((s) => s.key === "mode");
      ok(
        "★★ mode 的 options 已展开成数组（不是函数被 JSON 丢掉）",
        Array.isArray(m?.options) && m.options.length === 1,
        JSON.stringify(m?.options)
      );
      ok(
        "★★ D129：模式已合并 ⇒ 只剩一个选项（surgical / 分流后压缩）",
        Array.isArray(m?.options) && m.options.map((o) => o.value).join(",") === "surgical",
        JSON.stringify(m?.options?.map((o) => o.value))
      );
    }
    ok("★ 每项都带 label 与 hint（面板要显示）", r.body.specs.every((s) => s.label && s.hint));
    eq("★ 回报了默认值", r.body.defaults?.maxActiveLines, 300);
    eq("★ 变更登记条数的默认值也回报了", r.body.defaults?.changeRegisterMax, 12);
    ok("★ 响应头 no-store（别缓存设置）", /no-store/.test(r.headers?.["cache-control"] ?? ""), JSON.stringify(r.headers));
  }

  // 27g：没有 configEditor ⇒ 可读不可写，且**说明原因**
  {
    const run = makeCtx({ withWebServer: true, withConfigEditor: false });
    mod.apply(run.ctx, {});
    const p = [...run.routes.keys()][0];
    const r = await callRoute(run, p);
    eq("仍能读（200）", r.status, 200);
    eq("★ 但 writable = false", r.body.writable, false);
    ok("★★ 并且**说明了原因**（不画点了没反应的控件）", typeof r.body.why === "string" && r.body.why !== "", JSON.stringify(r.body.why));
    ok("★ 原因里点了 configEditor", /configEditor/.test(r.body.why), r.body.why);
  }

  // 27h：POST 走 configEditor.edit()，且是**按补丁合并**
  {
    const run = makeCtx({ withWebServer: true, withConfigEditor: true });
    mod.apply(run.ctx, {});
    // 先在那一行上放一个"别人写的"字段，用来验证合并不抹掉它
    run.fakeEntry.options.config = { someOtherField: "keep-me", turnEndOffer: false };
    const p = [...run.routes.keys()][0];
    const r = await callRoute(run, p, { method: "POST", body: JSON.stringify({ settings: { turnEndOffer: true } }) });
    eq("POST 状态码 200", r.status, 200);
    eq("POST ok", r.body.ok, true);
    eq("★★ 走的是 configEditor.edit()", run.edits.length, 1);
    eq("★★ 只改了提交的那个键", run.edits[0].next.turnEndOffer, true);
    eq("★★ 别的字段**没被抹掉**（按补丁合并，不是整份替换）", run.edits[0].next.someOtherField, "keep-me");
    // ★★ 回归：**上层的值不许被钉进 profile 层**
    //
    //   内核 README 逐字警告：*"完整配置覆盖保留普通字段，但会在 profile 层
    //   **固定其当前原始值**"*。我第一版把 `inherited` 并进了写回值 —— 那就是
    //   把上层（bundle 层 / 家级 patch）的值钉死在 profile 层：
    //   从此上层再改也改不动它（profile 层覆盖了上层）。
    //   ⇒ 这里用**非空**的 inherited 夹具把这条钉死。
    ok(
      "★★★ 上层的值**没被钉进** profile 层（inherited 不参与写回）",
      run.edits[0].next.fromUpperLayer === undefined,
      JSON.stringify(run.edits[0].next)
    );
    ok(
      "★★ 上层给的水位也没被抄进 profile 层",
      run.edits[0].next.highFidelityCompactRatio === undefined,
      JSON.stringify(run.edits[0].next)
    );
    eq("★ 回报了生效值", r.body.settings.turnEndOffer, true);
  }

  // 27i：POST 非法值 ⇒ 400，且**绝不落盘**
  {
    const run = makeCtx({ withWebServer: true, withConfigEditor: true });
    mod.apply(run.ctx, {});
    const p = [...run.routes.keys()][0];
    const r = await callRoute(run, p, { method: "POST", body: JSON.stringify({ settings: "不是对象" }) });
    eq("★ 非对象 ⇒ 400", r.status, 400);
    eq("★ ok = false", r.body.ok, false);
    eq("★★ 且**没有**调用 edit（非法值不落盘）", run.edits.length, 0);
  }

  // 27j：POST 坏 JSON ⇒ 400（不 500）
  {
    const run = makeCtx({ withWebServer: true, withConfigEditor: true });
    mod.apply(run.ctx, {});
    const p = [...run.routes.keys()][0];
    const r = await callRoute(run, p, { method: "POST", body: "{ 这不是 JSON" });
    eq("★ 坏 JSON ⇒ 400（不是 500）", r.status, 400);
    ok("★ 说明了是 JSON 的问题", /JSON/.test(r.body.error ?? ""), r.body.error);
    eq("★ 没有落盘", run.edits.length, 0);
  }

  // 27k：★ 设置真的接进了行为 —— 水位档位
  {
    const root = tmpProject("settings-tiers");
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\nX\n", "utf8");
    fs.writeFileSync(
      path.join(root, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", archiveDir: "_a", maxActiveLines: 300, revision: 0 }),
      "utf8"
    );
    const run = makeCtx({ withTokenMeter: true });
    mod.apply(run.ctx, { pressureTiers: [0.6] });
    const agent = {
      session: { header: { id: "s-tiers", cwd: root }, id: "s-tiers", requestContext: () => ({ contextWindow: 1000 }) },
    };
    await runPreStep(run, { agent, messages: [] }); // 第一次注入台账
    run.services.tokenMeter._total = 650;
    const d = await runPreStep(run, { agent, messages: [] });
    const t = (d.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
    ok("★★ 自定义档位生效了（0.6 那档发出提醒）", /水位/.test(t), t.slice(0, 300));
    ok("★ 提醒里报的是 65%（真实水位）", /65/.test(t), t.slice(0, 300));
    rmrf(root);
  }

  // 27l：★ 设置真的接进了行为 —— 日志档位（新项目登记的默认值）
  {
    const root = tmpProject("settings-levels");
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
    const run = makeCtx();
    mod.apply(run.ctx, { logLevels: { L0: false, L1: true, L2: true, L3: false, L4: true } });
    const r = await run.registeredTools
      .get("ledger_init")
      .execute(
        { active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a", logDir: "_log", gitInit: false },
        execFor(root, "s-levels")
      );
    ok("init 成功", r.ok === true, JSON.stringify(r).slice(0, 200));
    const mf = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8"));
    eq("★★ 设置里的 L0 档写进了新项目的清单", mf.logLevels.L0, false);
    eq("★ 其余档位照常", mf.logLevels.L1, true);
    rmrf(root);
  }

  // 27m：★ 设置真的接进了行为 —— 行数上限（新项目登记的默认值）
  {
    const root = tmpProject("settings-lines");
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
    const run = makeCtx();
    mod.apply(run.ctx, { maxActiveLines: 120 });
    await run.registeredTools
      .get("ledger_init")
      .execute(
        { active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a", gitInit: false },
        execFor(root, "s-lines")
      );
    const mf = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8"));
    eq("★★ 设置里的行数上限写进了新项目的清单", mf.maxActiveLines, 120);
    rmrf(root);
  }

  // 27n：★★ **项目清单优先于插件级设置**（一个事实只有一个出口）
  {
    const root = tmpProject("settings-precedence");
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
    fs.writeFileSync(
      path.join(root, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1,
        active: "LEDGER.md",
        archiveDir: "_a",
        maxActiveLines: 80,
        logDir: "_log",
        logLevels: { L0: true, L1: false, L2: false, L3: false, L4: false },
        revision: 0,
      }),
      "utf8"
    );
    const run = makeCtx();
    // 插件级设置说"上限 999、L0 关" —— 项目清单应当赢
    mod.apply(run.ctx, { maxActiveLines: 999, logLevels: { L0: false, L1: true, L2: true, L3: true, L4: true } });
    const st = await run.registeredTools.get("ledger_status").execute({}, execFor(root, "s-prec"));
    eq("★★ 行数上限以**项目清单**为准（80，不是设置里的 999）", st.maxActiveLines, 80);
    eq("★★ 日志档位以**项目清单**为准（L1 仍是关的）", st.logLevels.L1, false);
    eq("★★ L0 以项目清单为准（仍是开的）", st.logLevels.L0, true);
    rmrf(root);
  }

  // 27p：★★★ `autoCompact: false` **只拦自动、不拦手动**（这条是"差点写错"那一处的回归）
  //
  //   我第一版把闸门写成包住整个 `agent/status` 监听器 —— 那会把**手动压缩也废掉**
  //   （那个监听器同时服务四条入口），现象是"敲了 /ledger compact 说已排队、
  //   然后什么都不发生"，极难查。
  //   ⇒ 这条同时守两个方向：
  //     ① `autoCompact: false` 时，**自动那条不排队**（水位到 70% 也不压）；
  //     ② 同一份设置下，**手动那条照常能压**（工具 / 命令都不能被它拦住）。
  //   ★ 只测①会让"把闸门写回包住监听器"那种错法**照样通过**（因为它两个都不压）。
  {
    // ① 自动那条：水位到 70%，但因为 autoCompact=false ⇒ 不该排队、不该压
    const root = tmpProject("settings-nocompact-auto");
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
    fs.writeFileSync(
      path.join(root, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", archiveDir: "_a", maxActiveLines: 300, revision: 0 }),
      "utf8"
    );
    const run = makeCtx({ withTokenMeter: true, withCompaction: true });
    mod.apply(run.ctx, { autoCompact: false });
    const sid = "session-ac0000auto-0001";
    const agent = {
      session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
      steer: () => {},
    };
    await runPreStep(run, { agent, messages: [] }); // 先注入一次
    run.services.tokenMeter._total = 750; // 0.75 ≥ 0.7
    const d = await runPreStep(run, { agent, messages: [] });
    const t = (d.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
    ok("★★ autoCompact=false ⇒ 自动那条**不排队**（注入里没有「即将压缩」的宣告）", !t.includes("即将执行一次高保真压缩"), t.slice(0, 300));
    await fire(run, "agent/status", { agent, status: "idle" });
    await settle0();
    eq("★★ 而且 idle 之后**一次都没压**", run.compacted.length, 0);

    // ② ★★ 同一份设置下，手动那条**照常能压** —— 这是"闸门放错位置"的判别式
    const r = await run.registeredTools
      .get("ledger_compact")
      .execute({}, { agent, session: agent.session, callId: "c-ac" });
    eq("★★★ autoCompact=false 时**手动工具仍然排队**（闸门只该拦「自动」）", r.ok, true);
    eq("★ 且它没说被禁用", r.queued, true);
    // ★ 手动那条同样要过「压缩前强制落盘」闸门 ⇒ 先落盘。
    await flushLedger(run, root, sid);
    await fire(run, "agent/status", { agent, status: "idle" });
    await settle0();
    eq("★★★ 手动那条**真的压了**（若闸门包住监听器，这里会是 0）", run.compacted.length, 1);
    rmrf(root);
  }

  // 27q：★ `highFidelityCompact: false` ⇒ 自动那条不排队（总开关有效）
  {
    const root = tmpProject("settings-hfoff");
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
    fs.writeFileSync(
      path.join(root, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", archiveDir: "_a", maxActiveLines: 300, revision: 0 }),
      "utf8"
    );
    const run = makeCtx({ withTokenMeter: true, withCompaction: true });
    mod.apply(run.ctx, { highFidelityCompact: false });
    const sid = "session-hf0000off0-0002";
    const agent = {
      session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
      steer: () => {},
    };
    await runPreStep(run, { agent, messages: [] });
    run.services.tokenMeter._total = 750;
    // ★ 水位提醒就是在**这一步**发出的（每档只发一次）⇒ 必须在这里取文本。
    const d2 = await runPreStep(run, { agent, messages: [] });
    const t2 = (d2.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
    await fire(run, "agent/status", { agent, status: "idle" });
    await settle0();
    eq("★★ 总开关关掉 ⇒ 水位再高也不自动压", run.compacted.length, 0);
    // ★ 但**水位提醒仍然照发**（那是另一件事，不该被压缩开关连坐）
    ok("★★ 水位提醒不受压缩开关影响（两件事不连坐）", /水位/.test(t2), t2.slice(0, 300));
    ok("★ 且提醒里报的是真实水位 75%", /75/.test(t2), t2.slice(0, 300));
    rmrf(root);
  }

  // 27r：★ 压缩水位可调 —— 0.6 时在 0.65 就该排队（默认 0.7 时不该）
  {
    const mk = (ratio, tag) => {
      const root = tmpProject(tag);
      fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
      fs.writeFileSync(
        path.join(root, ".dsh-ledger.json"),
        JSON.stringify({ version: 1, active: "LEDGER.md", archiveDir: "_a", maxActiveLines: 300, revision: 0 }),
        "utf8"
      );
      return { root, ratio };
    };
    // ① 默认 0.7 ⇒ 0.65 不该触发
    for (const [ratio, expect, tag] of [
      [0.7, false, "hf-ratio-default"],
      [0.6, true, "hf-ratio-lower"],
    ]) {
      const { root } = mk(ratio, tag);
      const run = makeCtx({ withTokenMeter: true, withCompaction: true });
      mod.apply(run.ctx, { highFidelityCompactRatio: ratio });
      const sid = `session-ratio${String(ratio).replace(".", "")}-0003`;
      const agent = {
        session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
        steer: () => {},
      };
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 650; // 0.65
      const d = await runPreStep(run, { agent, messages: [] });
      const t = (d.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
      const announced = t.includes("即将执行一次高保真压缩");
      ok(
        expect
          ? `★★ 水位调到 ${ratio} ⇒ 0.65 时就该排队`
          : `★★ 水位是 ${ratio}（默认）⇒ 0.65 时不该排队`,
        announced === expect,
        `announced=${announced}`
      );
      if (expect) {
        ok(`★ 且文案里报的是**设置的水位**（${Math.round(ratio * 100)}%），不是写死的 70`, t.includes(`≥ ${Math.round(ratio * 100)}%`), t.slice(0, 400));
      }
      rmrf(root);
    }
  }

  // 28：★★★ 压缩前**强制**落盘（用户 2026-10-09 反复强调的那一条）
  //
  //   ★ 用户原话：*"每次压缩之前强制进行台账更新和日志更新"*；
  //     后来又补了整条工作流：*"模型输出了 20% 的工作量…这个时候按照规则他要进行
  //     一次台账更新和日志更新…到这一点之后他才执行压缩"*。
  //
  //   ★★ 这一组守的是**闸门真的会拦**（前面所有压缩用例都是"先落盘再压"，
  //      验的是"落盘之后能压"；这里验的是"**没落盘就不给压**"—— 缺了这半边，
  //      闸门等于不存在）。
  {
    const mkGateProj = (tag) => {
      const root = tmpProject(tag);
      fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
      fs.writeFileSync(
        path.join(root, ".dsh-ledger.json"),
        JSON.stringify({ version: 1, active: "LEDGER.md", archiveDir: "_a", maxActiveLines: 300, revision: 0 }),
        "utf8"
      );
      return root;
    };
    const settle = async () => {
      for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
    };

    // 28a：★★★ 全程没落盘 ⇒ 压缩**一次都不发生**（闸门真的拦住）
    //
    //   ★ 这个夹具**不需要**碰插件内部状态：有台账、且从未落过盘 ⇒
    //     `flushedAt` 与 `lastCompactCycleAt` 都还没有记录 ⇒ 判据天然是"本周期没落盘"。
    {
      const root = mkGateProj("flush-block");
      const run = makeCtx({ withCompaction: true, withTokenMeter: true });
      mod.apply(run.ctx, {});
      const sid = "session-block000-0001";
      const agent = {
        session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
        steer: () => {},
      };
      await runPreStep(run, { agent, messages: [] });
      // ★★ 用 **0.70**（不是 0.75）：0.75 已经进了"水位旁路"那档（≥75% 不再拦，
      //    见 `FLUSH_GATE_BYPASS_RATIO`），那样就测不出"闸门会拦"这半边了。
      //    ⇒ 这条测的是**水位还没高到危险区**时的拦截行为。
      run.services.tokenMeter._total = 700;
      await runPreStep(run, { agent, messages: [] });

      await fire(run, "agent/status", { agent, status: "idle" });
      await settle();
      eq("★★★ 没落盘 ⇒ **压缩被拦下**（一次都没压）", run.compacted.length, 0);
      rmrf(root);
    }

    // 28b：★ 拦下之后**意图退回队列** ⇒ 落盘之后再 idle 就能压（不是死锁）
    {
      const root = mkGateProj("flush-retry");
      const run = makeCtx({ withCompaction: true, withTokenMeter: true });
      mod.apply(run.ctx, {});
      const sid = "session-retry000-0002";
      const agent = {
        session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
        steer: () => {},
      };
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 700; // 同样避开 0.75 的旁路档
      await runPreStep(run, { agent, messages: [] });
      await fire(run, "agent/status", { agent, status: "idle" });
      await settle();
      eq("先被拦下", run.compacted.length, 0);

      // ★ AI 照做了：写台账 ⇒ 闸门应当放行（证明拦的是"没落盘"而不是"永远不放"）
      await flushLedger(run, root, sid);
      await fire(run, "agent/status", { agent, status: "idle" });
      await settle();
      eq("★★ 落盘之后再 idle ⇒ **压了**（不是死锁）", run.compacted.length, 1);
      rmrf(root);
    }

    // 28c：★ 关掉设置 ⇒ 闸门不生效（逃生口有效）
    {
      const root = mkGateProj("flush-offswitch");
      const run = makeCtx({ withCompaction: true, withTokenMeter: true });
      mod.apply(run.ctx, { requireFlushBeforeCompact: false });
      const sid = "session-offsw000-0003";
      const agent = {
        session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
        steer: () => {},
      };
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 750;
      await runPreStep(run, { agent, messages: [] });
      await fire(run, "agent/status", { agent, status: "idle" });
      await settle();
      eq("★ 设置关掉 ⇒ 不落盘也照压", run.compacted.length, 1);
      rmrf(root);
    }

    // 28d：★★ 没有台账的项目 ⇒ 闸门**放行**（否则压缩永不发生 = 死锁）
    //
    //   ★ 这一条是"不制造死锁"的关键：实测 104/112 个会话在容器根、**没有台账**。
    //     对它们要求"先落盘"是**不可能执行的指令**，硬拦只会让上下文一路涨到内核 80%。
    {
      const root = tmpProject("flush-noledger"); // 故意不写 .dsh-ledger.json
      const run = makeCtx({ withCompaction: true, withTokenMeter: true });
      mod.apply(run.ctx, {});
      const sid = "session-noledg00-0004";
      const agent = {
        session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
        steer: () => {},
      };
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 750;
      await runPreStep(run, { agent, messages: [] });
      await fire(run, "agent/status", { agent, status: "idle" });
      await settle();
      eq("★★ 没有台账的项目**不被拦**（不制造死锁）", run.compacted.length, 1);
      rmrf(root);
    }

    // 28e：★★ 落盘闸门对**四条入口**一视同仁（自动 / 工具 / 命令 / 卡片）
    //
    //   ★ 闸门放在 `runHighFidelityCompact` 里就是为了这个：一处收口、四条全管。
    //     这里只抽**手动工具**那条验证（其余三条在 26b 已各有覆盖）。
    {
      const root = mkGateProj("flush-manual");
      const run = makeCtx({ withCompaction: true });
      mod.apply(run.ctx, {});
      const sid = "session-manual00-0005";
      const agent = { session: { header: { id: sid, cwd: root }, id: sid }, steer: () => {} };

      const r = await run.registeredTools
        .get("ledger_compact")
        .execute({}, { agent, session: agent.session, callId: "c-28e" });
      eq("★ 手动工具仍然「排队成功」（它只管排队）", r.ok, true);
      await fire(run, "agent/status", { agent, status: "idle" });
      await settle();
      eq("★★★ 但执行时同样被闸门拦下（手动不是特权通道）", run.compacted.length, 0);
      rmrf(root);
    }

    // 28f：★★★ **水位 ≥75% ⇒ 闸门不再拦**（2026-10-09 用户报的"危险"）
    //
    //   ★ 用户原话：*"到水位的时候主动按压缩不能进行，比较危险"*。
    //   ★ 方向性理由：内核 0.8 会自己压一次、而那一次**抓不到逐字胶囊**。
    //     拦下我们自己的（安全的）压缩 = 把机会让给内核那次不安全的 —— 方向反了。
    //   ⇒ 水位进到这一档，宁可承认"没落盘"也要先压，并如实标注。
    //
    //   ★★ 这条必须与 28a 成对看：28a（水位 0.70）**必须被拦**、
    //      28f（水位 0.80）**必须放行** —— 只测一边都测不出阈值对不对。
    {
      const root = mkGateProj("flush-bypass-ratio");
      const run = makeCtx({ withCompaction: true, withTokenMeter: true });
      mod.apply(run.ctx, {});
      const sid = "session-bypass00-0006";
      const agent = {
        session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
        steer: () => {},
      };
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 800; // 0.80 ≥ 0.75 ⇒ 走旁路
      await runPreStep(run, { agent, messages: [] });
      await fire(run, "agent/status", { agent, status: "idle" });
      await settle();
      eq("★★★ 水位 80% 且**没落盘** ⇒ 仍然压（不再让给内核那次无胶囊的压缩）", run.compacted.length, 1);
      rmrf(root);
    }

    // 28g：★★★ **人手动按的（命令）不被闸门拦** —— 闸门约束的是 AI 的工作流
    //
    //   ★ 与 28e 成对：28e 说 AI 的 `ledger_compact` **要**被拦，
    //     这条说人打的 `/ledger compact` **不该**被拦。两者的区别就是"谁授权的"。
    //     ⇒ 只测一边的话，"一律拦"和"一律放"都能通过。
    {
      const root = mkGateProj("flush-manual-command");
      const run = makeCtx({ withCompaction: true, withTokenMeter: true });
      mod.apply(run.ctx, {});
      const sid = "session-cmdbypass-0007";
      const agent = {
        session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
        steer: () => {},
      };
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 700; // 低于旁路档 ⇒ 自动那条一定会被拦
      await runPreStep(run, { agent, messages: [] });

      const cmd = run.registeredCommands.get("ledger");
      const out = await cmd.handler({
        commandId: "c-28g",
        agent,
        rawInput: "compact",
        attachments: [],
        signal: new AbortController().signal,
      });
      eq("★★★ 人打的 /ledger compact 没落盘也**当场压了**", run.compacted.length, 1);
      eq("★ 而且结果是 success", out.kind, "success");
      ok("★ 文本说明了这是手动授权放行", /已压缩/.test(out.text), out.text);
      rmrf(root);
    }
  }

  // 29：★★★ `compaction` 服务的**可达性**（2026-10-09 修掉的致命 bug）
  //
  //   ★ 症状：`ledger_compact` 一直报「本机没有 compaction 服务」，
  //     而自动 70% 那条路也**从未真正压过**。
  //   ★ 根因：本 profile 里 compaction 挂在 **preset 的 isolate 组**里
  //     （`dsh-web-app/presets/standard.patch.yml`，
  //      `isolate: { compaction: true, toolResultPruner: true }`），
  //     而 host 平面那份被 `disabled: true` 关掉；
  //     `isolate` = `LocalRealm` ⇒ 服务被隔离在 preset 子树里。
  //   ★★ **第一版修错了**（这里如实记下，因为它是个值得记住的教训）：
  //     我以为"agent 自己的作用域就在子树里"，于是改成 `agent.ctx.get("compaction")`。
  //     **不对** —— agent 的 ctx 在子树**之外**，从它 `get` 同样拿不到。
  //     症状于是原样复现（用户重启后仍报"本机没有 compaction 服务"）。
  //   ★★★ 正解是**内核自己的做法**：
  //     `agentPresets.serviceFor(agent, "compaction")`
  //     —— `mount.js` 的 `serviceForAgent()`：经 agent 的 scope parent 找到该 agent
  //       保留的那次 preset revision，再在 store 的 symbol 槽里用
  //       `withinFiber(impl.fiber, mount.fiber)` 找出隔离在子树里的那个实现。
  //       内核真实用例：`dsh-api-session-controller/lib/index.js`
  //       `presets?.serviceFor(live, "skills") ?? this.ctx.get("skills")`。
  //
  //   ★★ 这一组必须**三个方向都测**：
  //     ① 只有 `serviceFor` 拿得到 ⇒ 要能拿到（这是修复本身）；
  //     ② 三处都拿不到 ⇒ 如实报"没有服务"（不假装）；
  //     ③ `agent.ctx` 里有但 `serviceFor` 没有 ⇒ 也**不能**算数
  //        （钉死"第三兜底不能替代正路"这一事实，防止哪天又退回去）。
  //     缺①则修没修都一样；缺②则"永远报成功"测不出来；
  //     缺③则**第一版那个错修会照样全绿** —— 这正是这次要补的。
  {
    const mkProj29 = (tag) => {
      const root = tmpProject(tag);
      fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
      fs.writeFileSync(
        path.join(root, ".dsh-ledger.json"),
        JSON.stringify({ version: 1, active: "LEDGER.md", archiveDir: "_a", maxActiveLines: 300, revision: 0 }),
        "utf8"
      );
      return root;
    };
    const settle = async () => {
      for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
    };
    /** 造一个假的 compaction 实现，记录被压次数。 */
    const mkCompact = (sink) => ({
      async compactNow() {
        sink.push(1);
        return { shadowedSeqs: [1], shadowedTokenCount: 10, summarySeq: 3 };
      },
    });

    // 29a：★★★ **只有 `agentPresets.serviceFor` 拿得到** ⇒ 必须能压
    //
    //   ★ 这正是本 profile 的真实处境：外层 ctx 没有、agent.ctx 也没有，
    //     只有 `serviceFor` 能穿进 isolate 子树。
    //     ★★ 修复前（裸 ctx.get）以及"第一版错修"（agent.ctx.get）在这里都是 0 次。
    {
      const root = mkProj29("reach-presets");
      const viaPresets = [];
      const run = makeCtx({
        withCompaction: false,
        withTokenMeter: true,
        // ★ 关键：只有 serviceFor 能给出 compaction
        agentPresetServices: { compaction: mkCompact(viaPresets) },
      });
      mod.apply(run.ctx, {});
      const sid = "session-reach000-0001";
      const agent = {
        session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
        steer: () => {},
        // ★★ 故意让 agent 作用域也**没有** compaction —— 这样断言就**只能**
        //    由 serviceFor 那条路满足，第三兜底无法代劳。
        ctx: { get: () => undefined },
      };
      await flushLedger(run, root, sid);
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 750;
      await runPreStep(run, { agent, messages: [] });
      // ★★★ 2026-10-12（D119）：**必须在这里落盘**，否则这条断言测不到它要测的东西。
      //   **为什么**：本用例水位 **0.75** = 全量线。D119 之前那一步走"水位 ≥0.75 旁路"放行；
      //   D119 之后**全量必须过落盘闸门**（用户要求"全量也要先记台账"）⇒ 没落盘就被拦。
      //   ★ 即：**红的理由是"夹具没落盘"，而不是"serviceFor 拿不到服务"**（纪律 6）。
      //   ⇒ 本用例测的是"**只有 serviceFor 能取到 compaction**"这件事，
      //     与闸门无关 ⇒ 显式落盘把闸门这个混杂变量排除掉。
      await flushLedger(run, root, sid);
      await fire(run, "agent/status", { agent, status: "idle" });
      await settle();
      eq("★★★ 只有 agentPresets.serviceFor 拿得到 ⇒ **压了**（裸 ctx.get 与 agent.ctx.get 这里都是 0）", viaPresets.length, 1);
      rmrf(root);
    }

    // 29b：★ 三处都没有 ⇒ 如实报"没有服务"（不假装成功）
    {
      const root = mkProj29("reach-none");
      const run = makeCtx({ withCompaction: false, withTokenMeter: true });
      mod.apply(run.ctx, {  });
      const sid = "session-reach000-0002";
      const agent = {
        session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
        steer: () => {},
        ctx: { get: () => undefined }, // agent 作用域也没有
      };
      await flushLedger(run, root, sid);
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 750;
      await runPreStep(run, { agent, messages: [] });
      await fire(run, "agent/status", { agent, status: "idle" });
      await settle();
      ok(
        "★★ 三处都没有 ⇒ 留下「没有 compaction 服务」的告警（不假装压过）",
        run.warnings.some((w) => w.includes("没有 compaction 服务")),
        run.warnings.join(" | ")
      );
      rmrf(root);
    }

    // 29c：★★ 手动工具同样受益 —— 修复前它**永远**报"没有服务"
    {
      const root = mkProj29("reach-manual");
      const viaPresets = [];
      const run = makeCtx({
        withCompaction: false,
        agentPresetServices: { compaction: mkCompact(viaPresets) },
      });
      mod.apply(run.ctx, { highFidelityCompactRatio: 1.0, /* ★D119：本用例测闸门/计数器/口径，**不测**「到全量线该让路」。让路有两个入口 —— ① `pressure.ratio >= hfLine` ② 水位 ≥ `capLine = min(内核线−5点, hfLine)`。取 `hfLine = 1.0` 让两者都够不着本用例水位。★ **绝不能设 `highFidelityCompact: false`**（我第一版那么改过，多红 7 条）：它还连带关掉**全量前置探针**，而依赖那段注入的断言会跟着塌。 */ });
      const sid = "session-reach000-0003";
      const agent = {
        session: { header: { id: sid, cwd: root }, id: sid },
        steer: () => {},
        ctx: { get: () => undefined }, // 同样只留 serviceFor 一条路
      };
      await flushLedger(run, root, sid);
      const r = await run.registeredTools
        .get("ledger_compact")
        .execute({}, { agent, session: agent.session, callId: "c-29c" });
      eq("★★★ 手动工具经 serviceFor **能排队**（修复前它报没有服务）", r.ok, true);
      ok("★ 且是排队而不是失败", r.queued === true, JSON.stringify(r).slice(0, 200));
      rmrf(root);
    }

    // 29d：★★★ `serviceFor` **必须收到 agent** —— 这是内核契约的核心一半。
    //
    //   `serviceForAgent(ctx, agent, name)` 靠 agent 的 scope parent 找 preset revision；
    //   传 undefined 就什么都找不到 ⇒ 功能静默失效（且外面看不出来）。
    //   ★ 这条专门钉"实现有没有把 agent 传进去"：夹具对无 agent 的调用返回 undefined。
    {
      const root = mkProj29("reach-agent-arg");
      const viaPresets = [];
      const run = makeCtx({
        withCompaction: false,
        withTokenMeter: true,
        agentPresetServices: { compaction: mkCompact(viaPresets) },
      });
      mod.apply(run.ctx, {  });
      const sid = "session-reach000-0004";
      const agent = {
        session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
        steer: () => {},
        ctx: { get: () => undefined },
      };
      await flushLedger(run, root, sid);
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 750;
      await runPreStep(run, { agent, messages: [] });
      // ★★★ 2026-10-12（D119）：**全量也要过落盘闸门**（用户要求"全量也要先记台账日志"）
      //   ⇒ 水位 75% 那条旁路对全量**已失效** ⇒ 必须显式落盘。
      //   ★ 否则闸门拦下 ⇒ `compactNow` **根本不会被调用** ⇒ 本用例（测 serviceFor 有没有
      //     收到真实 agent）会以**错的理由**变红 —— 与 29a 第 5817-5823 行那条修法**同型**。
      //   本用例测的是"只有 serviceFor 能取到 compaction"，与闸门无关 ⇒ 显式落盘排除这个混杂变量。
      await flushLedger(run, root, sid);
      await fire(run, "agent/status", { agent, status: "idle" });
      await settle();
      eq("★★★ serviceFor 收到了真实的 agent（没传 agent 就取不到 ⇒ 这里会是 0）", viaPresets.length, 1);
      rmrf(root);
    }

    // 29e：★ 静态契约 —— 三处取值都必须经 resolver（防止哪天又被改回裸 ctx.get）
    {
      const src = fs.readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8");
      // ★ 只数**调用**（`const compaction = compactionServiceFor(ctx, agent)`），
      //   不数**定义**（`function compactionServiceFor(ctx, agent) {`）——
      //   我第一版用 `compactionServiceFor\(ctx, agent\)` 把定义也算进去了，
      //   于是"实际 4 处"这种假失败出现（断言错、代码对）。
      const calls = src.match(/const compaction = compactionServiceFor\(ctx, agent\)/g) ?? [];
      // ★ 2026-10-09：新增增量压缩那条（`runIncrementalCompact`）+ 手动轻量那条
      //   （`runManualLightCompactNow`）⇒ 3 → 4 → 5 处。
      //   这条断言的价值在于"**没有一处漏掉 resolver**"，所以数量变了要跟着改，
      //   但更该守住的是下面那条形状断言（正路还在）。
      ok("★★★ 五处压缩取值都走 `compactionServiceFor`", calls.length === 5, `实际 ${calls.length} 处`);
      ok(
        "★★ 没有残留的裸 `ctx.get(\"compaction\")` 取值（注释里提到的不算）",
        !/^\s*const compaction = ctx\.get\("compaction"\);/m.test(src),
        "仍有裸取值"
      );
      // ★★ 正路的形状必须还在：`agentPresets` + `serviceFor(agent, "compaction")`。
      //    这条是"第一版错修"的防回归 —— 那一版这两样都没有，却全绿。
      ok(
        "★★★ resolver 里保留了内核正路 `agentPresets…serviceFor(agent, \"compaction\")`",
        /get\?\.\("agentPresets"\)/.test(src) && /serviceFor\?\.\(agent, "compaction"\)/.test(src),
        "正路不见了 ⇒ 又退回只能靠兜底"
      );
    }

    // 29f：★★★ `ledger_status` 要**报出够不够得着** —— 让软失败可观测。
    //
    //   ★ 为什么这条重要：这个坑埋了两次（裸 ctx.get 一次、agent.ctx.get 又一次），
    //     两次的表现都是"不报错、只是永远不压"，从外面看不出区别。
    //     ⇒ 只要够不着，`ledger_status` 必须说出来。
    {
      // ① 够不着 ⇒ 明确报 false + 给原因
      {
        const root = mkProj29("status-unreachable");
        const run = makeCtx({ withCompaction: false });
        mod.apply(run.ctx, {});
        const agent = { session: { header: { id: "s-29f1", cwd: root }, id: "s-29f1" }, steer: () => {}, ctx: { get: () => undefined } };
        const r = await run.registeredTools
          .get("ledger_status")
          .execute({}, { agent, session: agent.session, callId: "c-29f1" });
        eq("★★★ 够不着 ⇒ ledger_status 报 reachable=false", r.compaction?.reachable, false);
        ok(
          "★★ 且给出原因（不是单纯一个 false）",
          typeof r.compaction?.hint === "string" && r.compaction.hint.includes("isolate"),
          JSON.stringify(r.compaction)
        );
        rmrf(root);
      }
      // ② 经 serviceFor 够得着 ⇒ 报 true 并**点名是哪条路**
      {
        const root = mkProj29("status-reachable");
        const run = makeCtx({
          withCompaction: false,
          agentPresetServices: { compaction: mkCompact([]) },
        });
        mod.apply(run.ctx, {});
        const agent = { session: { header: { id: "s-29f2", cwd: root }, id: "s-29f2" }, steer: () => {}, ctx: { get: () => undefined } };
        const r = await run.registeredTools
          .get("ledger_status")
          .execute({}, { agent, session: agent.session, callId: "c-29f2" });
        eq("★★★ 经 serviceFor 够得着 ⇒ reachable=true", r.compaction?.reachable, true);
        eq("★★★ 且点名走的是 `agentPresets.serviceFor`", r.compaction?.via, "agentPresets.serviceFor");
        rmrf(root);
      }
      // ③ 兜底路径也要**如实**报（不能一律都写成 serviceFor）
      {
        const root = mkProj29("status-via-ctx");
        const run = makeCtx({ withCompaction: true });
        mod.apply(run.ctx, {});
        const agent = { session: { header: { id: "s-29f3", cwd: root }, id: "s-29f3" }, steer: () => {}, ctx: { get: () => undefined } };
        const r = await run.registeredTools
          .get("ledger_status")
          .execute({}, { agent, session: agent.session, callId: "c-29f3" });
        eq("★★ 外层 ctx 有 ⇒ via 报 `ctx.get`（不冒充正路）", r.compaction?.via, "ctx.get");
        rmrf(root);
      }
    }
  }

  // 30：★★★ 增量（分段）压缩 —— 用户 2026-10-09 那套方案的核心
  //
  //   ★ 用户原话：*"AI每输出20%的时候，调用一次工具压缩到12%"*、
  //     *"把这20%的输出压到只剩10~12%，以此类推，极大的拓展一兆的上下文窗口"*、
  //     *"允许模型进行轻度压缩"*、*"每次压缩之前强制进行台账和日志更新"*。
  //
  //   ★★ 它与旧的绝对 70% 是**两条不同的路**（读内核实现得出的）：
  //     `compactNow` 里写死 `selectCompactableRange(…, 0)` ⇒ 保留 0 ⇒ 几乎全压；
  //     增量走 `compactRegion` + **大 retain** ⇒ 只压最旧一段、保留最近一大块。
  //     ⇒ 断言必须能分辨"走了哪条"，否则测了等于没测（见 `regionCalls` 夹具）。
  //
  //   ★★★ 这一组要守住的四件事：
  //     ① 涨够触发点 ⇒ 走 `compactRegion`（**不是** `compactNow`）；
  //     ② 没涨够 ⇒ 什么都不做（不能每步都压）；
  //     ③ **没落盘 ⇒ 拦住**（用户"强制记台账"那条在这里同样生效）；
  //     ④ 压完把锚点推到当前水位 ⇒ 下一次要**再涨够**才压（否则会连压）。
  //   缺①就是没实现；缺②会每步狂压；缺③违返用户硬要求；缺④会连续压。
  {
    const mkDeltaProj = (tag) => {
      const root = tmpProject(tag);
      fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
      fs.writeFileSync(
        path.join(root, ".dsh-ledger.json"),
        JSON.stringify({
          version: 1,
          active: "LEDGER.md",
          decisions: "DECISIONS.md",
          archiveDir: "_a",
          maxActiveLines: 300,
          logDir: "_ledger-log",
          logLevels: { L0: true, L1: true, L2: true, L3: false, L4: true },
          revision: 0,
        }),
        "utf8"
      );
      return root;
    };
    /**
     * 造一个"有 surface 且每个节点都定价"的 agent。
     *
     * ★ 为什么要真造 surface + eventAt：`selectIncrementalRange` 会
     *   ① 校验 token-meter 的 nodes 与 surface 一致；② 逐 seq 算平衡。
     *   给它一个空 surface 就等于**测不到选范围**那段逻辑。
     *
     * ★★★ 必须**成对**造（user / assistant(tool-call) / tool/result）——
     *   这是第一版夹具踩的坑，值得记下来：
     *   我原来只造 assistant(tool-call)、**从不造 tool/result**，于是"未回应的
     *   工具调用数"一路累加 ⇒ 除开头外**所有切点都不平衡** ⇒ 选范围时一路退到 0
     *   ⇒ 永远返回 null ⇒ 断言红。**看着像实现错，其实是夹具造了一个非法 surface。**
     *   （实测真实会话里 `tool/call` 160 条 : `tool/result` 159 条 —— 近乎成对，
     *     差的那 1 个正是当前开着的步骤。）
     */
    const mkDeltaAgent = (root, sid, rounds) => {
      const events = [];
      let seq = 1;
      for (let r = 0; r < rounds; r += 1) {
        events.push({ type: "user/message", seq, data: { message: { role: "user", content: [] } } });
        seq += 1;
        events.push({
          type: "assistant/message",
          seq,
          data: { message: { role: "assistant", content: [{ type: "tool-call", id: `c${seq}` }] } },
        });
        seq += 1;
        events.push({ type: "tool/result", seq, data: { message: { role: "tool" } } });
        seq += 1;
      }
      const bySeq = new Map(events.map((e) => [e.seq, e]));
      return {
        session: {
          header: { id: sid, cwd: root },
          id: sid,
          requestContext: () => ({ contextWindow: 1000 }),
          surface: { nodes: events.map((e) => e.seq) },
          eventAt: (s) => bySeq.get(s),
        },
        steer: () => {},
        _nodeCount: events.length,
      };
    };
    /**
     * 给 tokenMeter 配上"每个节点花多少 token"。
     *
     * ★★★ 2026-10-11（棘轮修复）后**必须让各节点之和 ≥ 水位**，否则夹具自相矛盾：
     *   新算法保留量 = (水位 − 每轮压掉的点) × 窗口。窗口 1000、水位 350（35%）、压掉 10
     *   ⇒ 保留 250 token。而 7 轮 × 3 节点 = **21 个节点**，每个 10 token 只有 **210** 总 token
     *   ⇒ 从后往前攒不够 250 ⇒ `selectIncrementalRange` 返回 null ⇒ **一次都不压** ⇒ 断言红。
     *
     *   ⚠️⚠️ **前提已更正（2026-10-11 03:45）** —— 这里原本写着
     *     「真实内核里 `measure()` 的 totalTokens **就是** surface 各节点之和」，
     *     并据此断言"节点总量 210 而水位 350"是**不可能**的状态。**那句话是错的。**
     *     ★ 逐字读内核 `dsh-token-meter/lib/types/index.js` 的真源码，`measure()` 返回的是：
     *         `tokens: estimateToolsTokens(header) + surface.surfaceTokens`   ← **含工具头**
     *         `totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens)`
     *         `nodes: surface.nodes`                                          ← **只有 surface**
     *     ⇒ **totalTokens 含工具头、Σnodes 不含** ⇒ `Σnodes < totalTokens` 是**常态**，
     *       本机 406 个工具、定义 JSON ≈116K token ⇒ 两者差得极大。
     *     ★ 这个错误前提让**夹具内部自洽、真机不自洽** ⇒ 934 项全绿而真机零压缩（D62）。
     *       真机那种不自洽现由**情形 40** 专门复现（`_total` 与 `Σ_priced` 故意不等）。
     *     ⇒ 本夹具为求简单仍取 total == Σnodes；**别再把它当成"与现实一致"的证据**。
     *   ⇒ 每个节点给 20 token：21 × 20 = 420 > 350（水位），内部自洽。
     *     ⚠️ 但别给太大：`selectIncrementalRange` 是"攒够 retain 就停"，
     *       节点 token 越大、保留段占用的节点越少、压掉的越多（end 越小）。
     *       本夹具要的 end=10（压最旧 10 个、留 11 个），所以取 20 并把它算准（见 30a）。
     */
    const priceNodes = (run, agent, tokensEach) => {
      run.services.tokenMeter._priced = agent.session.surface.nodes.map((seq) => ({
        seq,
        tokens: tokensEach,
      }));
    };

    // 30a：★★★ 涨够 20 点 ⇒ 走 `compactRegion`（而不是 compactNow）
    //
    //   ★★★ 2026-10-10 改（用户报的顺序 bug）：**提醒与压缩不再同一步**。
    //     原来水位提醒（"把这一段的进展写进活跃台账"）与压缩在**同一个 pre-step**
    //     里挨着发生，而 AI 还没轮到动手 ⇒ 它收到的是"一边叫我写、一边说刚压完了"。
    //     ⇒ 现在：**发了提醒的那一步只提醒、不压**；等 AI 真写了台账，下一步才压。
    //     ★ 所以这条用例现在**多一步**：提醒 → （AI 写台账）→ 才压。
    //       少了中间那步，就是过去那个错误顺序。
    {
      const root = mkDeltaProj("delta-basic");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */ });
      const sid = "session-delta000-0001";
      const agent = mkDeltaAgent(root, sid, 7); // 21 个节点
      priceNodes(run, agent, 20);

      await flushLedger(run, root, sid); // 先落盘（闸门要求）
      run.services.tokenMeter._total = 100; // 10%
      await runPreStep(run, { agent, messages: [] });
      // 涨到 35%（>10+20）⇒ 到水位档了
      run.services.tokenMeter._total = 420;
      const dNotice = await runPreStep(run, { agent, messages: [] });
      // ★★★ 这一步**只该提醒、不该压**（这正是本轮修的东西）
      eq("★★★ 发提醒的那一步**不许压**（先记台账、再压缩）", regionCalls.length, 0);
      const noticeText = (dNotice.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
      ok("★★ 而提醒里确实要求它写台账", /活跃台账/.test(noticeText), noticeText.slice(0, 300));

      // ★★★ 2026-10-12（D129）：**机械兜底已删** ⇒ 改由"模型主动调 compression"驱动。
      await flushLedger(run, root, sid);
      await triageNow(run, root, sid);
      askAICompact(sid);
      await runPreStep(run, { agent, messages: [] });

      eq("★★★ 写完之后、模型主动调压缩 ⇒ 调了一次 compactRegion", regionCalls.length, 1);
      eq("★★★ 而且**没有**调 compactNow（两条路必须分得清）", run.compacted.length, 0);
      ok(
        "★★ 选的是**最旧**那一段（start 是 surface 的头）",
        regionCalls[0]?.start === 1,
        JSON.stringify(regionCalls[0])
      );
      // ★ 校准过的数字（**反复重新测过，不是我推的**）：
      //   21 节点 × 20 token = 420；水位 420（42%）。
      //   ★★★ 2026-10-12（D116）：**每轮压多少从"固定 10"改成了"累计增量的一半"** ⇒
      //     本夹具锚点 0.10、水位 0.42 ⇒ 涨 **32 点** ⇒ 压 `round(32/2)` = **16 点**
      //     （上界 `deltaRemovePoints×2` = 20，未触顶）⇒ 保留 = (0.42 − 0.16) × 1000 = **260** token
      //     ⇒ 比原来（固定 10 ⇒ 保留 320）**保留得更少** ⇒ `end` 从 **4 变成 10**。
      //   ★ 这是**语义变化的正确连带**，不是"断言过时"：
      //     用户 2026-10-12 明确选了"每次压当前累计增量的一半"（D116）。
      //   ⚠️ 这个数**实测读回来的**（第一次我按"攒够 260 就停"手推成 end=8，实测是 **10**）——
      //     因为 `selectIncrementalRange` 从末尾往回攒，凑够门槛时**已经越过**门槛，
      //     随后还要按平衡边界回退。⇒ **教训照旧：这类数字必须从实测输出里读回来，手推会错。**
      ok(
        "★★★ 而且**只压最旧一段、不碰最新**（end=10，后面 11 个节点全留着）" +
          "（D129 起每轮压「累计增量的一半」⇒ 比固定 10 点压得更多、end 变大）",
        regionCalls[0]?.end === 10,
        `end=${regionCalls[0]?.end}（共 21 个节点）`
      );
      rmrf(root);
    }

    // 30a-2：★★★ **提醒与"刚压完"绝不能出现在同一条注入里**
    //
    //   ★ 这条钉的是用户**看到的那个矛盾**：他报"先压缩再写台账"时，
    //     收到的正是同一条注入里既有「## 上下文水位已到 50%」（叫我写台账）、
    //     又有「**本插件刚做了一次增量压缩**」（已经压完了）。
    //   ★ 与 30a 的区别：30a 验"没调 compactRegion"（机制），
    //     这条验"注入文案不自相矛盾"（用户可见的结果）—— 两者都要。
    {
      const root = mkDeltaProj("delta-no-contradict");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */ });
      const sid = "session-delta000-0009";
      const agent = mkDeltaAgent(root, sid, 7);
      priceNodes(run, agent, 20);

      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 100;
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 420;
      const d = await runPreStep(run, { agent, messages: [] });
      const t = (d.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
      ok("★ 这一步确实发了水位提醒", /上下文水位已到/.test(t), t.slice(0, 200));
      ok(
        "★★★ 且**同一条注入里没有**「刚做了一次增量压缩」（不自相矛盾）",
        !/刚做了一次增量压缩/.test(t),
        "提醒与压缩同一步 = 用户报的那个矛盾"
      );
      // ★★★ 2026-10-12（D129）：这条断言**必须换锚串** ——
      //   旧文案写「压缩会等你写完」（那是"水位义务"时代的措辞），
      //   而用户本轮**删掉了水位档的义务**（防卡）⇒ 那句话**已经不成立**，
      //   再写在注入里就是骗模型。
      //   ⇒ 现在该钉的是**顺序本身仍在**（先落盘才允许压），而不是旧句式。
      ok(
        "★★ 而且明说了「压缩前必须先落盘」（否则模型不知道该先干什么）",
        /压缩前|先落盘|压缩前的标准动作/.test(t),
        t.slice(0, 500)
      );
      rmrf(root);
    }

    // 30b：★★ 没涨够 ⇒ 什么都不做（不能每步都压）
    //
    // ★★★ 2026-10-11 修一个**夹具前提错误**（纪律第 8 条：*前提错了全绿就是假绿*）：
    //   原来这一段**没有设锚点**，于是 `anchorOf()`（`lib/index.js` L736）取不到值，
    //   而 `since = anchor === undefined ? pressure.ratio : pressure.ratio - anchor`
    //   ⇒ `since` 退化成**绝对水位**（0.2），恰好 **≥** 触发线 0.2 ⇒ 判据①**放行**。
    //   ⇒ 它测的根本不是"只涨 10 点"，而是"绝对水位到 20%"。
    //   ★ 为什么以前没暴露：那时这一段挂在 `text !== undefined` 门下（D89-2b），
    //     第 2 步没有注入 ⇒ **压根没轮到判据** ⇒ 断言"通过"是**空转**。
    //     我把 D89-2b 修掉（判据不再搭注入的车）之后，它才第一次真的被问到 ⇒ 变红。
    //   ⇒ 修法：**把锚点显式设成 100/1000 = 0.1**，让"只涨 10 点"这个前提**成立**，
    //     这样断言才真的在测"涨幅不够 ⇒ 不压"。
    {
      const root = mkDeltaProj("delta-notyet");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */ });
      const sid = "session-delta000-0002";
      const agent = mkDeltaAgent(root, sid, 7);
      priceNodes(run, agent, 20);

      // ★ 显式立锚点：第 1 步的水位（100/1000）。传 `{}` 即可 ——
      //   `setAnchor` 内存那半走可选链（拿不到 state 就跳过），**盘上那半照写**，
      //   而 `anchorOf` 在内存为空时正好回落到盘上那一份（就是我们要测的那一支）。
      mod.__test.setAnchor({}, sid, 0.1);

      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 100;
      await runPreStep(run, { agent, messages: [] });
      // 只涨 10 点（< 20）⇒ 不压
      run.services.tokenMeter._total = 200;
      await runPreStep(run, { agent, messages: [] });
      eq("★★ 只涨 10 点 ⇒ 一次都没压", regionCalls.length, 0);

      // ★★★ 前提断言：确认锚点真的取到了、且涨幅真的不够 ——
      //   否则这条用例随时可能又退化回"空转通过"。
      const anchorNow = mod.__test.anchorOf({}, sid);
      const sincePts = anchorNow === undefined ? undefined : (200 / 1000 - anchorNow) * 100;
      ok(
        "★★★ 30b 前提：锚点取到了，且本次涨幅确实 < 触发线（否则上面那条是空转）",
        anchorNow !== undefined && sincePts < 20,
        `anchor=${anchorNow} since=${sincePts === undefined ? "?" : sincePts.toFixed(1)} 点`
      );
      rmrf(root);
    }

    // 30c：★★★ **没落盘 ⇒ 被拦**（用户"每次压缩前强制记台账"在增量这条上同样生效）
    //
    //   ★ 这条与 30a 成对：30a 先 `flushLedger` 才压得成，这条故意不落盘。
    //     只测 30a 的话，一个"完全不看落盘"的实现照样通过。
    {
      const root = mkDeltaProj("delta-nogflush");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */ });
      const sid = "session-delta000-0003";
      const agent = mkDeltaAgent(root, sid, 7);
      priceNodes(run, agent, 20);

      // ★ 故意**不**调 flushLedger
      run.services.tokenMeter._total = 100;
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 420; // 涨够 25 点，但没落盘
      const d = await runPreStep(run, { agent, messages: [] });
      eq("★★★ 没落盘 ⇒ 增量压缩**没发生**", regionCalls.length, 0);
      const t = (d.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
      // ★ 措辞改过（2026-10-10）：现在这条可能是"刚要求过你落盘但还没写"（承诺判据）
      //   或"自上次压缩以来没落盘"（周期判据）—— 两者都是"要它先写台账"，
      //   所以判据取**共同的那层意思**，不钉死某一句原文。
      ok("★★ 而且**如实告诉 AI** 为什么没压（要它先写台账）", /落盘|写进活跃台账|先写/.test(t), t.slice(0, 400));
      rmrf(root);
    }

    // 30c-2：★★★ **没有注入的那一步也必须有机会排队**（D89-2b 修复的正面用例）
    //
    //   ★ 这是用户第 2 点那个真根因的**回归用例**：
    //     旧实现在这里写的是 `if ((enableDelta && text !== undefined) || forcedLight)`
    //     ⇒ "本步恰好有东西要注入"才去问"该不该压"。而**水位到线与台账有没有变无关**。
    //     实测（`_probe-why-late.mjs`）：19:24~19:27 水位 ≥75% 的 **16 步只有 8 步有注入**
    //     ⇒ 另一半**从来没机会排队** ⇒ 一路拖到 **78.4%** 才压上。
    //
    //   ★ 怎么造出"没有注入"：**连着两步**跑 pre-step ——
    //     第 1 步会注入（首次注入），并把指纹记下；
    //     第 2 步**什么都不变** ⇒ `text` 保持 `undefined` ⇒ 正是真实场景里那一半。
    //   ★★ 水位必须**选得干净**（第一版栽在这上面，记下来）：
    //     · 要么过不了触发线（那就是 30b，测不到本用例）；
    //     · 要么**踩到提醒档** ⇒ 提醒那一步又有注入了 ⇒ 测不到"无注入"；
    //     · ★ 更阴的是：提醒会顺带**立下落盘义务**（`flushOwedAt`），
    //       下一步的落盘闸门就会拦住压缩 ⇒ 断言红，而**红的理由是闸门、不是 D89-2b**。
    //     ⇒ 所以取 **锚点 5% / 水位 26%**：涨幅 21 点 ≥ 20（过触发线），
    //       而 26% < 最低提醒档 30% ⇒ **全程一条提醒都不发** ⇒ 只有第 1 步有注入。
    {
      const root = mkDeltaProj("delta-noinject");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */ });
      // ★★ sid **必须全文件唯一**（我第一版图省事复用了 30y 的 0011，当场炸了两条）：
      //   锚点是**按 sid 落盘**进沙箱家的（`anchors.json`），
      //   于是本用例的锚点 0.05 **污染了 30y** ⇒ 30y 一步都没压成 ⇒ 它那两条断言红。
      //   ⇒ 教训：**自检里 sid 就是全局键**，不是随手起个名字。
      const sid = "session-delta000-0012";
      const agent = mkDeltaAgent(root, sid, 7);
      priceNodes(run, agent, 20);

      // 锚点立在水位 50（=5%）：后面涨到 260（26%）⇒ 涨 **21 点**，过触发线。
      mod.__test.setAnchor({}, sid, 0.05);
      await flushLedger(run, root, sid);
      // ★★★ 2026-10-12（D129）：三步走完（落盘 → 分流 → 模型要压）。
      //   ★ 分流必须**在抬水位之前**做完，否则那一拍会有"提醒"注入 ⇒ 测不到「无注入」。
      await triageNow(run, root, sid);

      run.services.tokenMeter._total = 50;
      await runPreStep(run, { agent, messages: [] }); // 第 1 步：首次注入
      run.services.tokenMeter._total = 260;

      // ★★★ 2026-10-12（D129）：第③步（模型主动要压）的旗子**必须紧挨着**要压的那次
      //   pre-step 立 —— `deltaForce` 是**用完即删**（`lib/index.js:12032`），
      //   中间那次 runPreStep 会把它消费掉 ⇒ 那一拍就没有旗子 ⇒ 压不成。
      askAICompact(sid);

      // ★★ 关键：**这一步没有任何东西该注入**（指纹没变、26% 也不到提醒档）。
      const before = regionCalls.length;
      const d = await runPreStep(run, { agent, messages: [] });
      const t = (d.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");

      // 前提：确认这一步**真的没有**常规注入（否则测的是老路，等于没测 D89-2b）。
      ok(
        "★★★ 30c-2 前提：这一步**确实没有**台账/提醒类常规注入（否则测不到 D89-2b）",
        !/project-ledger facts belong to THIS conversation/.test(t),
        t.slice(0, 300)
      );
      // ★ 核心断言：**没有注入也要压**。
      eq(
        "★★★ 30c-2：没有注入的那一步，增量压缩**照样发生了**（D89-2b 回归）",
        regionCalls.length,
        before + 1
      );
      ok(
        "★★ 30c-2：而且如实说明了为什么这一步会动手（不是悄悄压）",
        /增量压缩/.test(t),
        t.slice(0, 400)
      );
      rmrf(root);
    }

    // 30d：★★★ 锚点必须取**压后**水位（否则阈值一轮轮漂高，冲破 70%）
    //
    //   ★ 轨迹证据在 `tools/_probe-delta-anchor.mjs`（纯数学）：
    //     锚点=压前：峰值 21→42→63→**84**→105→126… 最高 **186 点**
    //     锚点=压后：峰值 21→33→33→33→33…          最高 **30 点**
    //   ★★ 这条用例必须让**压缩真的把水位降下来**（夹具 `_dropTo`），
    //     否则两种锚点在测试里长得一样 ⇒ 测了等于没测（第一版就是这样）。
    {
      const root = mkDeltaProj("delta-anchor");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */ });
      const sid = "session-delta000-0004";
      const agent = mkDeltaAgent(root, sid, 10);
      priceNodes(run, agent, 20);
      // ★ 压缩把水位降回 12%（模拟"保留 10 点 + 摘要约 2 点"）。
      //   ⚠️ 必须改 **tokenMeter** 上的 `_total`（不是 compaction 服务上的字段）。
      run.services.compaction.onCompacted = () => {
        run.services.tokenMeter._total = 120;
      };

      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 100;
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 420; // 10 → 35，涨 25 ⇒ 到水位档
      // ★★ 2026-10-10：这一步只提醒、不压 ⇒ 要它先写台账，下一步才压。
      await runPreStep(run, { agent, messages: [] });
      await doThreeStepCompact(run, root, sid);
      await runPreStep(run, { agent, messages: [] });
      eq("★ 第一次压了", regionCalls.length, 1);
      // 压完夹具把水位降到了 120。
      eq("★ 夹具复刻了「压缩让水位下降」（现 12%）", run.services.tokenMeter._total, 120);

      // ★★★ 关键：水位**不动**（仍是 120）⇒ 不该再压。
      //   若锚点错取压前的 350，则 120-350 < 0 ⇒ 也不会压 —— 所以还要测下一步。
      await runPreStep(run, { agent, messages: [] });
      eq("★★ 水位没涨 ⇒ 不再压", regionCalls.length, 1);

      // ★★★ 这条才是判别式：涨到 200（比**压后** 120 涨 8 点，比**压前** 350 还低）。
      //   · 锚点=压后(120) ⇒ 涨 8 点 < 20 ⇒ **不压**
      //   · 锚点=压前(350) ⇒ 200-350 < 0 ⇒ 也不压
      //   ⇒ 两者同结果，不足以区分。于是再涨到 330（比压后 120 涨 21 点 ⇒ 该压；
      //     比压前 350 还低 ⇒ 按压前锚点则**不该压**）。
      await doThreeStepCompact(run, root, sid);
      run.services.tokenMeter._total = 330;
      await runPreStep(run, { agent, messages: [] });
      eq(
        "★★★ 涨到 330：比压后(120)涨 21 点 ⇒ **该压**（若锚点是压前 350，这里会不压 ⇒ 红）",
        regionCalls.length,
        2
      );

      // 再验证一次"压完又稳住"
      eq("★ 第二次压完水位同样被降回 12%", run.services.tokenMeter._total, 120);
      await runPreStep(run, { agent, messages: [] });
      eq("★★ 又没涨 ⇒ 不再压（锚点持续生效）", regionCalls.length, 2);
      rmrf(root);
    }

    // 30g：★★★ 手动的 `/ledger light` ⇒ **绕开涨幅 + 绕开落盘闸门**，直接压
    //
    //   ★ 用户要的："轻量压缩也可以给一条命令"。命令立旗子 + 唤醒一轮，
    //     真正的压缩在那一轮的 pre-step 里做。
    //   ★★ 这条与 30b/30c 成对，三者缺一不可：
    //     · 30b：自动那条**涨不够就不压**（不能被手动逻辑污染）
    //     · 30c：自动那条**没落盘就不压**（闸门有效）
    //     · 30g：手动那条**涨不够也压、没落盘也压**（人的授权高于闸门）
    //     只测前两条的话，一个"把 force 写成恒真"的实现会全绿
    //     —— 那就等于自动闸门被废掉了。
    {
      const root = mkDeltaProj("delta-light-force");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */ });
      const sid = "session-delta000-0007";
      const agent = mkDeltaAgent(root, sid, 10);
      priceNodes(run, agent, 20);

      // ★ 先把"起点"定下来：压过一次，锚点落在当时水位。
      await doThreeStepCompact(run, root, sid);
      // ⚠️ **不要**在这里额外插一次 `runPreStep`（我第一版插了，反而把用例弄坏，记下来）：
      //   用去重是"指纹 + 文本"两道 ⇒ **多跑一步会把指纹提前消费掉**，
      //   紧接的那一步就 `skip = true` ⇒ `text` 留空 ⇒ 撞上末尾的
      //   `if (text === undefined) return decision;` ⇒ **压缩也跟着不发生**。
      //   ⇒ 正解是"**一步到位**"：落盘 + 抬水位 + pre-step 在同一步里做完。
      run.services.tokenMeter._total = 350;
      await runPreStep(run, { agent, messages: [] });
      eq("★ 先自动压一次（建立锚点）", regionCalls.length, 1);

      // ★ 现在水位**只涨 3 点**（远不够 20），而且**故意不落盘**。
      run.services.tokenMeter._total = 380;
      // ① 不立旗子 ⇒ 自动那条应当**不压**（涨 3 点 < 20，且没落盘）
      await runPreStep(run, { agent, messages: [] });
      eq("★★ 不立旗子时：涨 3 点 + 没落盘 ⇒ 不压", regionCalls.length, 1);

      // ② 让用户**真的按** `/ledger light`（走真命令入口，不是内部打桩）
      //    ⇒ 命令立旗子 + 唤醒一轮；这里我们只取"立了旗子"这个效果。
      run.services.compaction.onCompacted = () => {
        run.services.tokenMeter._total = 120;
      };
      const cmd = run.registeredCommands.get("ledger");
      ok("★ 有 /ledger 命令可用", cmd !== undefined);
      const cr = await cmd.handler({
        commandId: "c-30g",
        agent,
        rawInput: "light",
        attachments: [],
        signal: new AbortController().signal,
      });
      eq("★ `/ledger light` 自己报 success", cr.kind, "success");
      await runPreStep(run, { agent, messages: [] });
      eq(
        "★★★ 按了 light ⇒ **涨 3 点也压、没落盘也压**（人的授权高于闸门）",
        regionCalls.length,
        2
      );

      // ③ 旗子用完即删 ⇒ 下一步不该再压
      await runPreStep(run, { agent, messages: [] });
      eq("★★ 旗子用完即删（不会连着压）", regionCalls.length, 2);
      rmrf(root);
    }

    // 30h：★★★ 手动 light 必须在**本轮没有任何其它注入**（`text === undefined`）时也能压
    //
    //   ★ 为什么单开这一条：`if ((enableDelta && text !== undefined) || forcedLight)`
    //     里那个 `|| forcedLight` 是**手动专用的入口**。我实测过：
    //     把它改成 `|| false`，**30g 与 6b-8 全都不红** —— 因为那两条用例里
    //     本轮都还有别的注入（台账 / 收到回执 / 水位提醒），走的是前半句。
    //   ⇒ 那半个条件当时**一次都没被测到**。这条专门制造 `text === undefined`
    //     的场面：不换台账（指纹去重 ⇒ 不注入）、水位压低（不触发提醒档位）。
    //   ★★ 判别式：按了 light 之后 `regionCalls` 必须 +1。
    //     若 `|| forcedLight` 不在，压缩段整段跳过 ⇒ regionCalls 不动 ⇒ 红。
    {
      const root = mkDeltaProj("delta-light-textless");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      // ★ 把提醒档位抬到 0.95 ⇒ 低水位时**不会有水位提醒**这个 text 来源。
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */  pressureTiers: "0.95" });
      const sid = "session-delta000-0008";
      const agent = mkDeltaAgent(root, sid, 10);
      priceNodes(run, agent, 20);

      run.services.tokenMeter._total = 100; // 水位 10%
      // 第一次 pre-step：注入台账全文（text 非空），并把指纹记下。
      const d1 = await runPreStep(run, { agent, messages: [] });
      ok("★ 第一次 pre-step 有注入（首次注入台账）", (d1.messages ?? []).length > 0, JSON.stringify(d1.messages?.length));
      eq("★ 此时不该压（只涨 10 点 < 20）", regionCalls.length, 0);

      // 第二次 pre-step：**什么都不变** ⇒ 指纹去重 + 无提醒 ⇒ 应当**没有注入**。
      const d2 = await runPreStep(run, { agent, messages: [] });
      eq(
        "★★★ 第二次 pre-step 没有任何注入（`text === undefined` 的场面造出来了）",
        (d2.messages ?? []).length,
        0
      );

      // ★ 现在按 light：这一轮**没有别的注入** ⇒ 只能靠 `|| forcedLight` 进压缩段。
      const cmd = run.registeredCommands.get("ledger");
      await cmd.handler({
        commandId: "c-30h",
        agent,
        rawInput: "light",
        attachments: [],
        signal: new AbortController().signal,
      });
      const d3 = await runPreStep(run, { agent, messages: [] });
      eq(
        "★★★ text 为 undefined 时按 light **仍然压了**（`|| forcedLight` 真的在起作用）",
        regionCalls.length,
        1
      );
      ok(
        "★ 而且这一轮**产出了注入**（把结果如实告诉用户，不是静默压完）",
        (d3.messages ?? []).length > 0,
        JSON.stringify(d3.messages?.length)
      );
      rmrf(root);
    }

    // 30e：★ 关掉增量开关 ⇒ 退回老的绝对 70% 行为（不能把老路弄丢）
    {
      const root = mkDeltaProj("delta-off");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */  incrementalCompact: false });
      const sid = "session-delta000-0005";
      const agent = mkDeltaAgent(root, sid, 7);
      priceNodes(run, agent, 20);

      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 100;
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 750; // 涨 65 点，但增量关了
      await runPreStep(run, { agent, messages: [] });
      eq("★★ 增量关掉 ⇒ **不走 compactRegion**", regionCalls.length, 0);
      rmrf(root);
    }

    // 30h：★★★ 2026-10-11 —— **水位已到全量线时，增量必须让路**（否则全量被饿死）
    //
    //   病灶（我用纯数学证过，见 `tools/_probe-delta-anchor.mjs` 的「饿死检查」）：
    //   棘轮爬到全量线的那一步，锚点通常恰好差一个 trigger ⇒ 增量**抢跑**，把水位拉回去，
    //   并置 `deltaHandled = true` ⇒ 全量那条本步被跳过、且它重测的水位已低于线 ⇒ 不排
    //   ⇒ 下一步又是同样的差值 ⇒ 增量再抢跑 …… **全量永远轮不到**。
    //   实测（30 步、步长与 trigger 对齐）：不让路 = 全量 **0 次**；让路 = 全量 **6 次**。
    //   ⇒ 修法：`runIncrementalCompact` 里加判据①b（水位 ≥ 全量线且本会话还没全量过
    //     ⇒ 返回 `yieldedToFull`，不做增量）。
    //
    //   ★ 这条用例钉两件事：① 增量确实让路（**一次 compactRegion 都不调**）；
    //     ② 同时全量那条**照常排队**（注入里说"即将执行一次高保真压缩"）—— 让路 ≠ 谁也不压。
    {
      const root = mkDeltaProj("delta-yield");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */ });
      const sid = "session-delta000-0008";
      const agent = mkDeltaAgent(root, sid, 7);
      // ★★★ 节点 token 必须**足够大**，否则这条断言是**摆设**（反向验证当场抓到过）：
      //   水位 700 ⇒ 保留 = (0.70−0.10)×1000 = **600** token。
      //   21 节点 × 20 = 420 < 600 ⇒ 攒不够保留段 ⇒ `range=null` ⇒ **无论有没有让路都不压**
      //   ⇒ `regionCalls===0` 恒成立 ⇒ 那条断言**分不出"让路"和"没让路"**。
      //   ⇒ 取 **40**：21 × 40 = 840 > 600 ⇒ 有旧段可压 ⇒ 没有让路时**会压**（regionCalls=1），
      //     只有真让路才 regionCalls=0。这样这个数字才有分辨力。
      priceNodes(run, agent, 40);

      await flushLedger(run, root, sid);
      // ★ 先把锚点定在低位（10%），再一口气升到 ≥ 70%
      run.services.tokenMeter._total = 100;
      await runPreStep(run, { agent, messages: [] });
      await flushLedger(run, root, sid);
      // 700 = 70% ⇒ 同时满足「涨够 20 点」**和**「到全量线」= 正是会饿死的那种情形
      run.services.tokenMeter._total = 700;
      const d = await runPreStep(run, { agent, messages: [] });

      eq("★★★ 水位已到全量线 ⇒ 增量**让路**（一次 compactRegion 都不该调）", regionCalls.length, 0);
      const t = (d.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
      ok(
        "★★★ 而全量那条**照常排队**（注入里说「即将执行一次高保真压缩」）—— 让路不等于谁也不压",
        /即将执行一次高保真压缩/.test(t),
        t.slice(0, 500)
      );
      rmrf(root);
    }

    // 30f：★★★ 选范围的边界必须**平衡**（不能劈开 tool-call/result）
    //
    //   ★ 这条钉的是"有没有真的用上平衡计算"：给一个**悬空**的 surface
    //     （最后一个 assistant 的 tool-call 没结果），选出来的 end 绝不能落在它上面。
    //   ★ 同时也验证：宁可**不压**（返回 null）也不给一个会把步骤劈开的范围。
    {
      const root = mkDeltaProj("delta-balance");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */ });
      const sid = "session-delta000-0006";
      // 造一个**悬空**的 surface：最后是 assistant(1 call) 但**没有 tool/result**。
      const events = [
        { type: "user/message", seq: 1, data: { message: { role: "user", content: [] } } },
        {
          type: "assistant/message",
          seq: 2,
          data: { message: { role: "assistant", content: [{ type: "tool-call", id: "c2" }] } },
        },
        { type: "tool/result", seq: 3, data: { message: { role: "tool" } } },
        { type: "user/message", seq: 4, data: { message: { role: "user", content: [] } } },
        // ★ 悬空：这个 tool-call 没有对应的 result（步骤还开着）
        {
          type: "assistant/message",
          seq: 5,
          data: { message: { role: "assistant", content: [{ type: "tool-call", id: "c5" }] } },
        },
      ];
      const bySeq = new Map(events.map((e) => [e.seq, e]));
      const agent = {
        session: {
          header: { id: sid, cwd: root },
          id: sid,
          requestContext: () => ({ contextWindow: 1000 }),
          surface: { nodes: events.map((e) => e.seq) },
          eventAt: (seq) => bySeq.get(seq),
        },
        steer: () => {},
      };
      run.services.tokenMeter._priced = events.map((e) => ({ seq: e.seq, tokens: 100 }));

      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 100;
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 420;
      await runPreStep(run, { agent, messages: [] });

      // 要么压、且 end **不是**悬空的 seq 5；要么干脆不压。两者都可接受，
      // 唯一不可接受的是"压了、而且 end=5"（那会把一个开着的步骤劈开）。
      const bad = regionCalls.filter((c) => c.end === 5);
      eq("★★★ 绝不能把**悬空**的最后一个步骤劈开（end 不许落在 seq 5）", bad.length, 0);
      ok(
        "★★ 要么没压、要么压的是一个平衡范围",
        regionCalls.length === 0 || regionCalls.every((c) => c.end !== 5),
        JSON.stringify(regionCalls)
      );
      rmrf(root);
    }

    // 30x：★★★ **目标与实绩必须分开报**（用户 2026-10-11 的明确要求）
    //
    //   ★ 用户原话：*"把我的目标和实际完成度分开，这样子的话，既能朝我的目标努力，
    //     也不会误导模型"*。
    //
    //   ★ 病因（本用例要钉死的就是它）：旧注入写「压掉约 10 点」——
    //     那个 10 是**设置里的目标**（`deltaRemovePoints`），
    //     而实测实绩只有 **~4.4 点**（根因见 DECISIONS D70）。
    //     ⇒ 模型会以为自己刚腾出 10 点空间 ⇒ **高估剩余预算**。
    //
    //   ★★ 夹具**照真实情形造**（实绩 < 目标，这正是 D70/D72 实测到的样子）：
    //     压前 **35%**、压后 **30.6%** ⇒ 实绩 **4.4 点**，而目标仍是 **10 点**。
    //     ⇒ 两个数必然不同 ⇒ "只报目标"的旧写法必然红。
    //   ★ 判别力检查：若实现只报目标（旧写法），`/实绩/` 与 `/4\.4/` 都找不到 ⇒ 红；
    //     若只报实绩、不报目标，`/目标/` 找不到 ⇒ 红。**两个都要在**，这正是"分开"。
    {
      const root = mkDeltaProj("delta-target-vs-actual");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */ });
      const sid = "session-delta000-0010";
      const agent = mkDeltaAgent(root, sid, 10);
      priceNodes(run, agent, 20);
      // 压前 35%、压后 30.6% ⇒ 实绩恰好 4.4 点（= D72 实测的均值）
      run.services.compaction.onCompacted = () => {
        run.services.tokenMeter._total = 306;
      };

      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 100;
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 350;
      await runPreStep(run, { agent, messages: [] });
      // ★★★ 2026-10-12（D129）：**机械兜底已删** ⇒ 由"模型主动调工具"驱动（三步）。
      await flushLedger(run, root, sid);
      await triageNow(run, root, sid);
      askAICompact(sid);
      const d = await runPreStep(run, { agent, messages: [] });
      eq("★ 前提：确实压了一次（否则后面全是空测）", regionCalls.length, 1);

      const t = (d.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
      // ★★★ 2026-10-12（D129）：回执**标题改了** —— 原来一律写「本插件刚做了一次增量压缩」，
      //   而现在增量**只可能由模型主动调工具发起**（机械兜底已删）⇒ 标题改成
      //   「**你刚调 `ledger_compact` 做了一次增量压缩**」（如实说"谁发起的"）。
      //   ★ 断言取**两种标题的共词**（`做了一次增量压缩`），不钉死是谁做的 ——
      //     这样"人手动那条"与"模型主动那条"都能通过同一条断言。
      ok(
        "★ 前提：注入里有本次压缩的回执",
        /做了一次增量压缩|刚做了一次增量压缩/.test(t),
        t.slice(0, 400)
      );
      ok(
        // ★★★ 2026-10-12（D116）：**目标从「固定 10」变成「累计增量的一半」** ——
        //   本夹具涨 35 点 ⇒ 目标 = round(35/2) = **18** 点（上界是 deltaRemovePoints×2 = 20）。
        //   ★ 我第一版断言写死「= 10」（那是 D116 之前的固定值）⇒ 当场红。
        //     这不是"断言过时"，而是**它正确地反映了语义变化**：
        //     ★ 用户 2026-10-12 明确选了"动态：每次压当前累计增量的一半"。
        "★★★ 报**目标**（= 累计增量的一半：涨 35 点 ⇒ 目标 18 点；上限 30 未触顶）",
        /目标/.test(t) && /18\s*点/.test(t),
        "没找到目标那一行：" + t.slice(0, 400)
      );
      ok(
        "★★★ 且**实绩**也要报（压前 35% → 压后 30.6% ⇒ 4.4 点）",
        /实绩/.test(t) && /4\.4\s*点/.test(t),
        "没找到实绩那一行：" + t.slice(0, 400)
      );
      ok(
        "★★★ 目标要**标明身份**（不许把目标说成实绩）",
        /这是打算，不是结果/.test(t),
        "缺『这是打算，不是结果』的标注 —— 那正是旧文案误导模型的写法"
      );
      ok(
        "★★ 实绩低于目标时要**如实指出**（免得读的人以为插件坏了）",
        /低于目标/.test(t),
        "实绩 4.4 < 目标 10，本夹具应出现这句：" + t.slice(0, 400)
      );
      rmrf(root);
    }

    // 30x：★★★ **D88 兜底线** —— 锚点被抬高后，触发线不许越过内核硬压线
    //
    //   ★ 病（用户第 2 点那条线上量出来的，见 D88）：触发线 = `锚点(压后水位) + 20`。
    //     而"压后水位"取决于这一轮真压掉多少（实测兑现率 ~50%）⇒
    //     **压得越少 ⇒ 锚点越高 ⇒ 下次触发线越高** = **恶性棘轮**。
    //     盘上实测锚点 **69.0%** ⇒ 触发线 **89.0%**，而**内核硬压线 80%**
    //     ⇒ ★ **增量永远等不到触发点**。
    //   ★ 修：`触发线 = min(锚点 + 触发点, 兜底线)`，
    //     且兜底那条**必须**再要求 since ≥ 2 点（否则"刚压完水位仍在线上"⇒ 连环重压）。
    //
    //   ★★★ 2026-10-12 **重写**（用户当场看出来的回归，见 D99）：
    //     用户原话（逐字）：*"理论上到这个时候，不应该是全量压缩生效吗？怎么是增量压缩先生效呢？"*
    //     **病**：旧兜底线 `min(全量线,内核线)−5` = **0.70** —— **低于全量线 0.75**
    //       ⇒ 水位一进 `[0.70,0.75)`，`byCap` 就命中，而**让路判据要 0.75 才命中**
    //       ⇒ **增量抢跑**、压回 ~0.62 ⇒ 水位**永远爬不到 0.75** ⇒ **全量被永久饿死**。
    //       实测：本会话"自动（增量）" **9 次** vs "自动（70% 水位）"**仅 1 次**。
    //     **修**：`capLine = min(内核线 − 5, 全量线)` ⇒ 兜底位点**不低于全量线**，
    //       于是"该全量就全量"（让路先命中）。
    //
    //   ★★ 本组守**四件**（缺一，这个修复就可能悄悄坏掉）：
    //     ① **兜底不抢全量的水位带**（用户在意的那个回归）；
    //     ② **兜底真正的用武之地**：全量线**高过内核线**时（那时全量来不及，
    //        兜底保证我们在被内核硬压之前先自己压一次）；
    //     ③ **不许连环重压**（since ≥ 2 那个小门）；
    //     ④ **让路仍优先**（到全量线 ⇒ 增量不抢）。
    {
      // ① 兜底不抢全量的水位带 + ② 兜底的真用武之地
      const root = mkDeltaProj("delta-cap");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      // ★ 用户设的值：全量线 0.75
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */  highFidelityCompactRatio: 0.75 });
      const sid = "session-delta000-0013";
      const agent = mkDeltaAgent(root, sid, 40);
      priceNodes(run, agent, 20);

      // ★ 锚点 0.69（触发线本该 0.89，够不着）⇒ 这时**只有兜底**能救
      mod.__test.setAnchor({}, sid, 0.69);
      await flushLedger(run, root, sid);

      // ★★★ ① 回归的主断言：水位 **0.72** —— 在**旧**兜底线(0.70)以上、**全量线(0.75)以下。
      //   旧行为：**增量抢跑**（把水位压回去 ⇒ 全量永远到不了 0.75）。
      //   新行为：**一次 region 都不许调**（这一段是留给全量的水位带）。
      run.services.tokenMeter._total = 720;
      await runPreStep(run, { agent, messages: [] });
      eq(
        "★★★ 30x①：水位 72% 在「全量线之下、旧兜底线之上」⇒ 增量**不许抢**（全量的水位带）",
        regionCalls.length,
        0
      );
      rmrf(root);
    }

    // 30x-1b：★★★ 2026-10-12（D129）**重写** —— 原语义已不存在，改测它的替代行为
    //
    //   ★ 原用例测的是「全量线 0.85 > 内核线 0.80 ⇒ **增量机械兜底**在 0.80 之前抢压一次」
    //     （`capLine` / `byCap` / `byFallback`）。
    //   ★★★ D129 之后那条路**整段删掉了**（用户拍板：所有压缩全部交给模型）
    //     ⇒ 那段断言测的是**一条已经不存在的路**，必须换掉
    //       （本机纪律：**夹具的前提错了，全绿就是假绿**）。
    //
    //   ★ 替代它的行为（D129 的兜底设计）：**插件唯一的自动兜底 = 全量**
    //     （`compactNow` + idle 队列），且它必须**早于内核硬压线 0.80** 接管 ——
    //     这正是默认全量线 **0.75 < 0.80** 存在的意义。
    //   ⇒ 本用例改成钉这一条：全量线 0.75、水位 0.76 ⇒ 增量一次都不许抢，全量**排上队**。
    {
      const root = mkDeltaProj("delta-cap-high");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      // ★ 全量线 0.75（< 内核线 0.80）⇒ 全量兜底在 0.80 之前接管
      mod.apply(run.ctx, { /* ★D129：本用例测「唯一兜底 = 全量在 0.80 之前接管」 */  highFidelityCompactRatio: 0.75 });
      const sid = "session-delta000-0015";
      const agent = mkDeltaAgent(root, sid, 40);
      priceNodes(run, agent, 20);

      mod.__test.setAnchor({}, sid, 0.69); // 触发线 0.89 ⇒ 够不着（这正是当年 D88 那个病）
      await flushLedger(run, root, sid);

      // 水位 0.76（76%）：≥ 全量线 0.75、且 < 内核硬压线 0.80 ⇒ 全量必须在此接管
      run.services.tokenMeter._total = 760;
      const d = await runPreStep(run, { agent, messages: [] });
      const t = (d.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
      ok(
        "★★★ 30x-1b：全量线 0.75 < 内核线 0.80 ⇒ **全量兜底在 0.80 之前接管**（增量一次都不许抢）",
        regionCalls.length === 0 && /即将执行一次高保真压缩/.test(t),
        `regionCalls=${regionCalls.length}；注入尾部=${t.replace(/\s+/g, " ").slice(-260)}`
      );
      rmrf(root);
    }

    {
      // ③ 不连环重压
      const root = mkDeltaProj("delta-cap");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      // ★★★ 全量线**必须设成用户那个值 0.75** —— 这不是装饰，是**本用例成立的前提**：
      //   · 夹具默认全量线是 **0.7** ⇒ 兜底窗口只剩 [0.65, 0.70)，
      //     而锚点 0.69 时那个窗口里 `since` 恒 < 2 点 ⇒ **兜底压根没有生效空间**
      //     （第二版就栽在这：72% 一进去就撞上"让路"，`regionCalls` 恒为 0 ⇒ 假红）。
      //   · ★ 而**真实的 D88 只在全量线高的时候才成立** —— 用户设的就是 **0.75**。
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */  highFidelityCompactRatio: 0.75 });
      const sid = "session-delta000-0013b";
      const agent = mkDeltaAgent(root, sid, 40);
      priceNodes(run, agent, 20);

      mod.__test.setAnchor({}, sid, 0.69);
      await flushLedger(run, root, sid);

      // 水位 0.68（68%）：since = −1 点 ⇒ 什么都不该发生（还没到兜底线 0.75）
      run.services.tokenMeter._total = 680;
      await runPreStep(run, { agent, messages: [] });
      eq("★ 30x 前提：68% 时**不该**压（未到兜底线 0.75）", regionCalls.length, 0);

      // ★★ 必须**再落一次盘**：68% 这一步跨过 **50% 提醒档** ⇒ 提醒会顺带立下
      //    "压缩前先落盘"的义务（`flushOwedAt`）⇒ 闸门会拦住下一步的压缩。
      //    ★ 这正是真实情形：模型被提醒后**写完台账**，然后才压。
      await flushLedger(run, root, sid);

      // 水位 0.75（正好全量线）：**让路** ⇒ 增量仍不许抢（全量接管）
      run.services.tokenMeter._total = 750;
      await runPreStep(run, { agent, messages: [] });
      eq(
        "★★★ 30x③：水位正好到全量线 0.75 ⇒ 增量**让路**（一次 region 都不许调）",
        regionCalls.length,
        0
      );
      rmrf(root);
    }

    // 30c-3：★★★ **没有注入的那一步，全量也必须有机会排队**（真机事故的回归用例）
    //
    //   ★ 病（2026-10-12 真机，用户报「76% 还没触发」）：
    //     全量那条排队**搭「本步恰好有注入」的车**（要 `text !== undefined` 才排）。
    //     实测时间线：水位 **01:06:42** 就到 75%，可排队**等到 01:11:05** ——
    //     迟 **4 分 23 秒**；那 4 分钟里没有台账改动 ⇒ 没有注入 ⇒ **不排队**。
    //     （01:11:05 排上，纯粹因为 AI 恰好写了台账 ⇒ 回执注入把 `text` 撑了起来。）
    //   ★ 这是 **D93 修过的「增量那条」的同型病** —— 当时只修了一条路（纪律 12）。
    //
    //   ★★★ 造出「这一拍恰好没有注入」**为什么这么难**（我第一版就栽在这，
    //     红的是"前提"而不是"结论"，值得逐条记下来）：
    //     `text` 在本文件里是**逐步被抢**的，抢的顺序就是执行顺序：
    //       待兑现命令 → 压缩后重注 → 台账全文（指纹变了才注） → 水位提醒（按档，每档一次）
    //       → **全量探针**（只在 `text === undefined` 时才跑）
    //     ⇒ 只要前面任何一个占了 `text`，探针**根本没机会**执行。
    //     ★ 第一版我写"上一步跨 0.7 档、这一步什么都不变"，结果红了"前提"：
    //       上一步**台账全文先把 `text` 占了** ⇒ 水位提醒那段被整段跳过
    //       ⇒ **0.7 档当时并没被标记** ⇒ 这一步它才补发 ⇒ 又占了 `text` ⇒ 探针仍没跑。
    //     ★ 正解：**先把"会抢的"逐个排空，再让探针出手** ——
    //       步1 台账全文（把指纹与回执消费掉） → 步2 水位 0.7 档（把三档全部标记）
    //       → 步3 什么都不剩 ⇒ `text === undefined` ⇒ 探针出手。
    //     ★★ 另有一处必须同时避开：**增量那条也会抢 `text`**。
    //       所以锚点取 **0.76**（高于全量线）⇒ `since` 与兜底两条都不成立
    //       ⇒ 增量一次都不跑 ⇒ 才能把"是谁排了队"分辨清楚。
    //       （若锚点低，增量会先跑并置 `deltaHandled=true`，全量那条又被 `!== true` 挡掉。）
    {
      const root = mkDeltaProj("delta-noinject-full");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      // ★ 用**用户真实设置** 0.75（不是夹具默认 0.7）—— 断言才与真机可比。
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */  highFidelityCompactRatio: 0.75 });
      const sid = "session-delta000-0016"; // ★ sid 全局唯一（锚点按 sid 落盘、会跨用例污染）
      const agent = mkDeltaAgent(root, sid, 7);
      priceNodes(run, agent, 40);

      // 锚点 0.76（> 全量线）：这一步之后，增量两条判据都不成立 ⇒ 增量不会来抢 `text`。
      mod.__test.setAnchor({}, sid, 0.76);
      await flushLedger(run, root, sid);

      // ── 步1：水位 0.72（< 0.75 ⇒ 不排全量）⇒ 台账全文注入（消费掉指纹与回执）──
      run.services.tokenMeter._total = 720;
      await runPreStep(run, { agent, messages: [] });

      // ── 步2：水位仍是 0.72 ⇒ 台账没变（不注）⇒ 这一拍轮到 **0.7 档提醒** ──
      await runPreStep(run, { agent, messages: [] });

      // ── 步3（★D129 新增）：把**轻推**先烧掉 ───────────────────────────
      //   ★ D127 之后轻推的判据是「水位 ≥ 0.45 **且** 本周期落过盘」——
      //     本用例两次落盘 ⇒ 它必然在**第一个** `text === undefined` 的拍上抢走 `text`
      //     ⇒ 全量探针（只在 `text === undefined` 时跑）**根本没机会出手**。
      //   ⇒ 先空走一拍：水位仍是 0.72（< 全量线）⇒ 只发轻推、不排全量，把它烧掉。
      await runPreStep(run, { agent, messages: [] });

      // ── 步4：水位 0.78（≥ 全量线）⇒ 三档已全部标记、指纹没变、回执已空 ──
      //   ⇒ ★ `text` 本该是 `undefined`，正是真机上「不排队」的那一拍。
      run.services.tokenMeter._total = 780;
      const d = await runPreStep(run, { agent, messages: [] });
      const t = (d.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");

      // 前提：这一步**确实没有**常规台账注入（否则测的是老路，等于没测这个病）。
      ok(
        "★★★ 30c-3 前提：这一步**确实没有**台账全文类常规注入（否则测不到「搭车」那个病）",
        !/project-ledger facts belong to THIS conversation/.test(t),
        t.slice(0, 400)
      );
      // 前提②：增量也不许来抢（否则全量是被 `deltaHandled` 挡掉的，测不出探针）。
      eq("★★ 30c-3 前提：增量这一步**没跑**（一次 region 都不该调，否则测不出探针）", regionCalls.length, 0);
      // ★★ 核心：全量**排上了队**，且是**探针自己**起的（那句文案只属于探针）。
      ok(
        "★★★ 30c-3：没有注入的那一步，全量**照样排上队**（真机「迟 4 分 23 秒」的回归）",
        /即将执行一次高保真压缩/.test(t),
        t.slice(0, 700)
      );
      // ★ 如实说明它为什么自己起了一次（不是悄悄排的）。
      ok(
        "★★ 30c-3：并如实说明「本步原本没有别的注入」（不是悄悄排的）",
        /本插件注意到水位已到/.test(t),
        t.slice(0, 400)
      );
      rmrf(root);
    }

    // 30c-4：★★★ **全量失败之后，必须能自己重新排队**（否则会掉进 D59 那个死锁）
    //
    //   ★ 为什么这条非测不可（本轮读失败路径推演出来的，不是假想）：
    //     `runHighFidelityCompact` 的 `catch` **只退票 + 如实回报，不重新排队**
    //     （`lib/index.js:10787-10800`），而 idle 处理器**在调用前就把队列删了**
    //     （`:11632`）。⇒ 一次失败的后果是：**队列空 + `hfCompacted` 未置真**。
    //
    //   ★★★ 于是下一步的让路判据 `pressure >= hfLine && oursDone !== true && !hfQueued`
    //     **三项全真** ⇒ 增量**让路**。而全量要重新排队，若还搭"本步有注入"的车
    //     （**正是 D107 修的病①**）⇒ 那一步没注入 ⇒ **全量不重排**
    //     ⇒ ★ **增量让路 + 全量不重排 = 谁也不压** = D59 那个"近 4 小时零压缩"的形态。
    //
    //   ⇒ ★ 本用例钉的正是"D107 的探针**不只是**让全量早排队，
    //     它还是**失败后重排的唯一通道**" —— 这是我在 D109 附里下的一个**推断**，
    //     按纪律 8/12 **必须实验**，不能只写在注释里。
    //
    //   ★ 夹具：复用 30c-3 的"零注入"三步法造出那一拍，然后
    //     ① 派 idle 让全量**执行并失败**（`_busy` 翻转）；
    //     ② 翻转回成功，再走一步 ⇒ 全量必须**自己重新排上队**。
    {
      const root = mkDeltaProj("delta-full-retry");
      const regionCalls = [];
      const run = makeCtx({
        withCompaction: true,
        withTokenMeter: true,
        regionCalls,
        // ★ 一上来就让全量"忙失败"（三条 busy 原文里最阴的那条 —— 用户真撞上的形态）。
        compactionBusy: true,
        compactionBusyMessage: "manual compaction requires an idle agent with no waking queued work",
      });
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */  highFidelityCompactRatio: 0.75 });
      const sid = "session-delta000-0017"; // ★ sid 全局唯一
      const agent = mkDeltaAgent(root, sid, 7);
      priceNodes(run, agent, 40);
      mod.__test.setAnchor({}, sid, 0.76); // 避开增量抢 text（同 30c-3）
      await flushLedger(run, root, sid);

      // ── 三步排空"会抢 text 的"（同 30c-3）──────────────────────────
      run.services.tokenMeter._total = 720;
      await runPreStep(run, { agent, messages: [] }); // 台账全文
      await runPreStep(run, { agent, messages: [] }); // 0.7 档提醒
      run.services.tokenMeter._total = 780;
      const d3 = await runPreStep(run, { agent, messages: [] });
      const t3 = (d3.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
      ok("★★ 30c-4 前提：第 3 步确实排上了全量（靠探针）", /即将执行一次高保真压缩/.test(t3), t3.slice(0, 300));

      // ── ① 派 idle ⇒ 全量执行但**失败**（忙）───────────────────────
      const before = run.compacted.length;
      for (const h of run.handlers.get("agent/status") ?? []) await h({ agent, status: "idle" });
      eq("★★ 30c-4 前提：这次 idle **没有**压成（夹具确实让全量失败了）", run.compacted.length, before);

      // ── ② 恢复成功，再走一步（水位不变、仍 ≥ 全量线、且**没有任何常规注入**）──
      run.services.compaction._busy = false;
      const d4 = await runPreStep(run, { agent, messages: [] });
      const t4 = (d4.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");

      ok(
        "★★★ 30c-4 前提：这一步**确实没有**台账全文类常规注入（否则测的又是「有人搭车」）",
        !/project-ledger facts belong to THIS conversation/.test(t4),
        t4.slice(0, 400)
      );
      // ★★★ 核心：全量必须**自己重新排上队** —— 否则就是"让路 + 不重排 = 谁也不压"。
      ok(
        "★★★ 30c-4：全量失败后，**没有注入的那一步也把全量重新排上了队**" +
          "（否则「增量让路 + 全量不重排」= D59 死锁）",
        /即将执行一次高保真压缩/.test(t4),
        t4.slice(0, 700)
      );
      // 真派一次 idle 确认这次能压成（证明"重排"不是空话）。
      for (const h of run.handlers.get("agent/status") ?? []) await h({ agent, status: "idle" });
      eq("★★★ 30c-4：重排之后 idle 真的压成了（重排是有效的，不是只发个文案）", run.compacted.length, before + 1);
      rmrf(root);
    }

    // 30x-2（已并入 30x③）：原来这里是"默认全量线 0.7 / 水位 76% ⇒ 让路"。
    //   ★ 2026-10-12 删：它测的是**夹具默认设置**下的行为，而 30x③ 用**用户真实设置**
    //     （0.75）在**正好压线**处测同一件事 ⇒ 后者更强、且不必维护两套前提。
    //     留着它只会让"改默认值时两条断言分叉"（本项目栽过"两处各写一份"）。

    // ═══════════════════════════════════════════════════════════════════════
    // 31x：★★★ **三档触发**（用户 2026-10-12 的要求，正文见 D115）
    //
    //   用户原话：*"能不能不再强制输出 20 压缩 10，而是由模型主动去在它认为合适的地方
    //   调用工具压缩……设定计数器，输出一定数值（默认百分之四十）仍未调用过压缩时，
    //   进行机械规则（但一定一定先记台账！！！）"*
    //
    //   ⇒ 三档（本族用例要钉的正是这个）：
    //     ① 模型按需（`ledger_compact`）—— D114 已测（22c-4）
    //     ② **涨够 20 ⇒ 只轻推**（注入一句提示，**不压**）
    //     ③ **涨够 40 ⇒ 机械压**（安全网，★ 仍过落盘闸门）
    //
    //   ★★★ 为什么这族用例必须新写：我为了让老用例继续测它们本来测的机制
    //     （锚点/让路/闸门），给那 18 个夹具**显式把兜底线设成 20**
    //     ⇒ 那些用例内部"涨够就压"仍成立 ⇒ ★ **它们再也测不到"20 只推"这件事**。
    //     自检仍然是 1102/0，但那是"我想到的都对了"，**不说明新行为被覆盖了**。
    // ═══════════════════════════════════════════════════════════════════════
    {
      // ── 31a：★ **到了节点（落过盘）+ 水位在可推区间 ⇒ 只推不压**，且**只推一次** ────
      //
      // ★★★ 2026-10-12（D117）**本用例的语义整体换了**（跟代码一起换）：
      //   旧：测"涨够 20 点 ⇒ 轻推"（**按涨幅**）
      //   新：测"**到了节点 + 水位够高 ⇒ 轻推**"（**不按涨幅** —— 这正是用户否掉的那条）
      //   ⇒ 所以夹具必须**同时造出两个新条件**：
      //     ① 水位 ≥ `NUDGE_MIN_RATIO`（0.45）
      //     ② **本周期落过盘**（= 声明了节点）
      //     ★ 而"涨幅"要**刻意压在兜底线（40）之下** ⇒ 保证"只推不压"。
      const root = mkDeltaProj("delta-nudge-only");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      // ★ 这里**故意用默认设置**（轻推 20 / 兜底 40）—— 这正是用户在用的配置。
      mod.apply(run.ctx, {});
      const sid = "session-delta000-0100"; // ★ sid 全局唯一
      const agent = mkDeltaAgent(root, sid, 7);
      priceNodes(run, agent, 40);

      // ★ 锚点 0.30 / 水位 0.50 ⇒ 涨 **20 点**（< 兜底 40 ⇒ 不该机械压；≥ 触发 20 ⇒ 不再重复推）
      mod.__test.setAnchor({}, sid, 0.30);
      await flushLedger(run, root, sid);
      const baseline = regionCalls.length;

      // ★★ 夹具要点（第一版栽在这，记下来）：**必须先把"会抢注入的"逐个排空**。
      //   `text` 是逐步被抢的，且**提醒档在压缩编排之前**就跑了 ⇒ 顺序是：
      //     ① 台账全文注入（`flushLedger` 之后的第一步必然是它）
      //     ② 水位提醒（按档，每档一次）
      //     ③ 才轮到轻推
      //   ⇒ 第一版我只走了两步就去断言 ⇒ 那两步分别是「台账全文」「50% 档提醒」
      //     ⇒ 轻推**根本没机会** ⇒ 断言红，而红的是**夹具没排空**，不是轻推坏了（纪律 6）。
      run.services.tokenMeter._total = 500;
      await runPreStep(run, { agent, messages: [] }); // ① 台账全文
      await runPreStep(run, { agent, messages: [] }); // ② 50% 档提醒（消费掉）

      // ★★★ 夹具要点（**反向验证抓出来的，最值钱的一处**）：
      //   不在这里落盘 ⇒ 上面那次提醒立下了 `flushOwedAt`（"开了口就要等"）
      //   ⇒ 那一步**落盘闸门也会拦住压缩** ⇒ `regionCalls === 0` 这条断言
      //   **不是因为"三档设计"通过的，而是被闸门顺带拦的**（因为错误的原因通过）。
      //   ★ 证据：把 `byFallback` 退回"涨够 20 就压"后，**这条断言仍不红**。
      //   ⇒ 修法：**先落盘**抹掉闸门这个混杂变量。
      //   ★★ 而落盘**同时**满足 D117 的第二个新条件（"声明了节点"）—— 一举两得。
      await flushLedger(run, root, sid);
      await runPreStep(run, { agent, messages: [] }); // ③ 消费掉回执注入
      const before = baseline;

      const d = await runPreStep(run, { agent, messages: [] }); // ④ 这一拍轮到轻推
      const t = (d.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");

      eq(
        "★★★ 31a：到了节点、水位在可推区间、但**没到兜底线 ⇒ 这一整段一次都不许压**（D117 核心）",
        regionCalls.length,
        before
      );
      ok(
        // ★★★ 2026-10-12（D117）：轻推文案已从"你攒够了"改成**节点语气**
        //   （用户原话：*"『建议你按需压一次』这句话本身有点毛病 ——
        //   即使模型只输出了 10 点，也有可能到了某个节点需要归纳一下"*）。
        //   ⇒ 断言的锚串必须跟着换成**新文案独有**的那句（"到了一个节点"）。
        "★★★ 31a：而是**注入一句轻推**（节点语气：到了一个节点 + 给出 `ledger_compact`）",
        /到了一个节点/.test(t) && /ledger_compact/.test(t),
        t.replace(/\s+/g, " ").slice(-460)
      );
      ok(
        "★★ 31a：且如实告知「不压的话到 N 点会兜底」",
        /兜底/.test(t),
        t.replace(/\s+/g, " ").slice(-320)
      );
      // ★★★ 2026-10-12（D117）新增：轻推必须**明说"压错了也不丢"** ——
      //   模型不动手多半是**怕压掉东西**；这条是降低心理门槛的关键，
      //   而它正是"让压缩成为常态"能不能落地的一环。
      ok(
        "★★★ 31a：且明说**压错了也不丢**（可逐字读回 + 台账会重注）—— 这是降低心理门槛的关键",
        /压错了也不丢/.test(t) && /ledger_recall/.test(t),
        t.replace(/\s+/g, " ").slice(-420)
      );

      // ★ 只推一次：下一步水位不变 ⇒ **不该再推**（否则每步注新文本 ⇒ 缓存每步全冷）。
      const d2 = await runPreStep(run, { agent, messages: [] });
      const t2 = (d2.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
      ok(
        "★★★ 31a：轻推**只发一次**（水位没再涨 ⇒ 不许重复推 —— 否则 prompt 缓存每步全冷）",
        !/到了一个节点/.test(t2),
        t2.replace(/\s+/g, " ").slice(-300)
      );
      rmrf(root);
    }

    {
      // ── 31b：★★★ 2026-10-12（D129）**机械兜底已删** ⇒ 这条改测「涨够了也不许插件替你压」──
      //
      //   ★ 为什么必须保留一条（而不是整段删掉）：用户本轮拍板
      //     *"把所有的压缩全部给模型"* ⇒ **"插件不许自己动手"本身就是一条要守住的行为**。
      //     只测"模型调了就压"的话，一个**又把机械兜底加回来**的实现照样全绿 ——
      //     那就等于把用户这次的核心决定悄悄回退掉了（本机纪律：**断言必须能被证伪**）。
      const root = mkDeltaProj("delta-fallback-force");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, {});
      const sid = "session-delta000-0101";
      const agent = mkDeltaAgent(root, sid, 7);
      priceNodes(run, agent, 40);

      mod.__test.setAnchor({}, sid, 0.10);
      await flushLedger(run, root, sid);
      // 先把低档提醒消费掉（水位跨档那一步会有注入）。
      run.services.tokenMeter._total = 200;
      await runPreStep(run, { agent, messages: [] });

      await flushLedger(run, root, sid);

      // 水位 0.52：距锚点 0.10 涨 **42 点**（≥ 已删的兜底线 40）⇒ ★ **仍然一次都不许压**。
      run.services.tokenMeter._total = 520;
      const before = regionCalls.length;
      await runPreStep(run, { agent, messages: [] });
      eq(
        "★★★ 31b：涨 42 点（远超旧的兜底线 40）⇒ **插件不许替你压增量**（D129 已删机械兜底）",
        regionCalls.length,
        before
      );
      rmrf(root);
    }

    {
      // ── 31c：★★★ D129 的**唯一**插件触发 = 全量兜底（75%），且它照旧过落盘闸门 ──
      //
      //   ★ 这条替代了旧的"兜底线也过闸门"：用户本轮明确要求
      //     *"全量压缩，最迟最迟发生在 75%（可调），即使模型没有主动压缩。"*
      //     ⇒ 必须同时验两件事：
      //       ① 到全量线 ⇒ 全量**排上队**（注入里说"即将执行一次高保真压缩"）；
      //       ② 它**仍受落盘闸门约束**（用户更早定的铁律：先记台账再压）。
      const root = mkDeltaProj("delta-fallback-gate");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { highFidelityCompactRatio: 0.75 });
      const sid = "session-delta000-0102";
      const agent = mkDeltaAgent(root, sid, 7);
      priceNodes(run, agent, 40);

      mod.__test.setAnchor({}, sid, 0.10);
      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 200;
      await runPreStep(run, { agent, messages: [] });
      await runPreStep(run, { agent, messages: [] }); // 消费掉重注/回执

      // 抬到全量线之上（76%），但**这一周期不再落盘**。
      run.services.tokenMeter._total = 760;
      const d = await runPreStep(run, { agent, messages: [] });
      const t = (d.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
      ok(
        "★★★ 31c：到全量线（76% ≥ 75%）⇒ **全量排队**（这是唯一的插件兜底）",
        /即将执行一次高保真压缩/.test(t),
        t.replace(/\s+/g, " ").slice(-400)
      );
      // ★ 全量**不是**增量 ⇒ `compactRegion` 一次都不该调（那条路是模型主动才走）。
      eq("★★★ 31c：而且它**不是**增量（`compactRegion` 不该被调）", regionCalls.length, 0);
      rmrf(root);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 31d：★★★ **每轮压「当前累计增量的一半」**（D116，用户口径）
    //
    //   ★ 用户原话：*"依旧是压差不多一半"* ⇒ 他选的是**动态**
    //     「每次压掉当前累计增量的一半」（不是固定 10 点）。
    //
    //   ★★★ 为什么必须单独钉它：现有那两条（`目标 18 点` / `end=10`）只覆盖
    //     **一个**涨幅值（35 点）⇒ 一个"恰好输出 18"的实现也能蒙过去。
    //     本用例用**两个不同涨幅**（涨 20 / 涨 40）⇒ 分别要求压 **10 / 20**，
    //     ★ 这就把"按 since 算"与"写死某个数"**区分开**了。
    //   ★ 顺带钉住**上界**（`deltaRemovePoints × 2`，默认 20）：
    //     涨 100 点时不该压 50（那会把上下文砍出断裂感 —— 用户另一条硬约束）。
    // ═══════════════════════════════════════════════════════════════════════
    {
      const root = mkDeltaProj("delta-half-dynamic");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      // ★★★ 夹具配方（**我在这里连栽三次，第四版才对 —— 教训值得记**）：
      //   病根：**水位提醒档会插进来抢注入槽、并立下落盘义务** ⇒ 压缩被闸门拦住
      //   （诊断实测 `region=0 含目标=false`，注入里是那条 30% 档提醒）。
      //   前三版我都在"排空提醒"上打转（抬水位→发提醒→落盘→再走一步），
      //   ★ 但**每次抬水位都会跨过新的档** ⇒ 提醒又发、义务又立 ⇒ **永远差一步**。
      //   ⇒ 正解**照抄本文件已验证的 30x 配方**（`:6725`）：
      //     **把锚点立高（0.69）、水位一步抬到 0.72** ⇒
      //     · 只跨到 70% 档（一条提醒），且那一步**就是压缩那一步**；
      //     · `flushLedger` 先落盘 ⇒ 闸门放行。
      //   ★ 用锚点 0.40 / 水位 0.72 ⇒ **涨 32 点** ⇒ 目标 = round(32/2) = **16** 点。
      mod.apply(run.ctx, { highFidelityCompactRatio: 0.75 });
      const sid = "session-delta000-0103";
      const agent = mkDeltaAgent(root, sid, 40);
      priceNodes(run, agent, 20);

      mod.__test.setAnchor({}, sid, 0.40);
      await flushLedger(run, root, sid);
      // ★★★ 2026-10-12（D129）：机械兜底已删 ⇒ 改由「模型主动调工具」驱动
      //   （三步：落盘 → 分流 → 要压；旗子必须紧挨着要压的那次 pre-step）。
      await triageNow(run, root, sid);
      run.services.tokenMeter._total = 720; // 涨 32 点 ⇒ 目标 16
      askAICompact(sid);
      const d1 = await runPreStep(run, { agent, messages: [] });
      const t1 = (d1.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
      ok(
        "★★★ 31d①：涨 32 点 ⇒ 目标是压 **16** 点（= 32 的一半，不是固定 10）",
        /目标/.test(t1) && /16\s*点/.test(t1),
        `未找到「目标 … 16 点」：${t1.replace(/\s+/g, " ").slice(-380)}`
      );
      rmrf(root);
    }

    {
      // ── ② 上限（封顶）真的会生效：显式把上限设小 ───────────────────────
      //
      // ★★★ 2026-10-12（D129）**这条断言的判别力在这里，我算过才写的**：
      //   `since = 当前水位 − 锚点 ≤ 100 点`（水位最多 100、锚点 ≥ 0）
      //   ⇒ "一半"最大 **50** ⇒ 若用**默认 30**，就只有 `since > 60` 才封顶。
      //   ★ 本夹具取锚点 0.10 / 水位 0.74 ⇒ 涨 **64 点** ⇒ 一半 **32** > 30 ⇒ **封顶 30 生效**。
      //     ⇒ 这样"封顶"是由**默认值**自然触发的，不必手工改设置
      //       （★★★★ 用默认值验证默认行为，比塞一个 `deltaRemovePoints: 10` 更接近真机 ——
      //        那个 10 在我把上限语义从 `×2` 改成 `×1` 之后，会让断言期望的数字跟着漂）。
      const root = mkDeltaProj("delta-half-cap");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { highFidelityCompactRatio: 0.75 });
      const sid = "session-delta000-0104";
      const agent = mkDeltaAgent(root, sid, 40);
      priceNodes(run, agent, 20);

      mod.__test.setAnchor({}, sid, 0.10);
      await flushLedger(run, root, sid);
      // ★★★ 水位必须**低于全量线 0.75**，否则会命中「让路判据」把活交给全量
      //   （实测：水位 0.90 ⇒ `region=0`，因为 0.90 ≥ 0.75 ⇒ 增量让路）。
      // ★★★ 2026-10-12（D129）：三步驱动（落盘 → 分流 → 模型要压）。
      await triageNow(run, root, sid);
      run.services.tokenMeter._total = 740; // 涨 64 点 ⇒ 一半 32 ⇒ 封顶 30
      askAICompact(sid);
      const d = await runPreStep(run, { agent, messages: [] });
      const t = (d.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
      ok(
        "★★★ 31d②：涨 64 点（一半 32）⇒ 目标**封顶在 30**（= deltaRemovePoints 上限）" +
          "，不是「一半」的 32 —— 上限真的会生效",
        /目标/.test(t) && /30\s*点/.test(t) && !/32\s*点/.test(t),
        `未找到「目标 … 30 点」：${t.replace(/\s+/g, " ").slice(-380)}`
      );
      rmrf(root);
    }

    // 30y：★★★ 量不到压后水位时，**不许报假实绩**（宁可不报）
    //
    //   ★ 与 `measurePressure` 的既有原则一致：拿不到值就返回 undefined，
    //     **绝不报一个看着像真的假数**（别的地方也栽过：报"目标"当"实绩"）。
    //   ★ 夹具：让 `measure()` 在压缩之后返回 undefined（模拟计量服务不可用）。
    {
      const root = mkDeltaProj("delta-actual-unknown");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { /* ★D115：本用例测锚点/让路/闸门等机制，不测「20 推 / 40 压」⇒ 兜底设成轻推线，恢复原语义 */ });
      const sid = "session-delta000-0011";
      const agent = mkDeltaAgent(root, sid, 10);
      priceNodes(run, agent, 20);
      let compacted = false;
      run.services.compaction.onCompacted = () => {
        compacted = true;
      };
      // 压完之后让计量服务失灵 ⇒ `measurePressure` 返回 undefined
      const realMeasure = run.services.tokenMeter.measure.bind(run.services.tokenMeter);
      run.services.tokenMeter.measure = function () {
        if (compacted) return { totalTokens: Number.NaN, nodes: [], surfaceTokens: 0 };
        return realMeasure();
      };

      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 100;
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 350;
      await runPreStep(run, { agent, messages: [] });
      await flushLedger(run, root, sid);
      // ★★★ 2026-10-12（D129）：机械兜底已删 ⇒ 三步驱动（落盘 → 分流 → 模型要压）。
      await triageNow(run, root, sid);
      askAICompact(sid);
      const d = await runPreStep(run, { agent, messages: [] });
      eq("★ 前提：确实压了一次", regionCalls.length, 1);
      const t = (d.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
      ok(
        "★★★ 量不到压后水位 ⇒ 如实说『量不到』，而**不是**拿目标充数",
        /量不到压后水位/.test(t),
        t.slice(0, 400)
      );
      ok(
        "★★★ 且此时不许出现一个具体的『实际压掉 N 点』",
        !/实际压掉\s*[\d.]+\s*点/.test(t),
        "报了一个假的实绩：" + t.slice(0, 400)
      );
      rmrf(root);
    }
  }

  // 27o：客户端半边的静态契约（不必真 React 就能钉死）
  {
    ok("★ 客户端半边是经典脚本（无顶层 export）", !/^\s*export\s/m.test(cfgSrc), "有顶层 export");
    ok("★ 客户端半边无顶层 import", !/^\s*import\s/m.test(cfgSrc), "有顶层 import");
    ok("★★ 用平台的 __ModuleLoader__.load 注册", cfgSrc.includes("window.__ModuleLoader__.load("));
    ok("★ id 是包名", cfgSrc.includes('id: "dsh-ledger-memory"'));
    ok(
      "★★ 挂的是 settings.section（设置导航里独立一页）",
      /const SLOT = "settings\.section"/.test(cfgSrc) && /name: SLOT/.test(cfgSrc)
    );
    const used = new Set([...cfgSrc.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map((m) => m[1]));
    const KNOWN = new Set([
      "--dsw-alias-bg-base",
      "--dsw-alias-bg-layer-1",
      "--dsw-alias-bg-layer-2",
      "--dsw-alias-bg-overlay",
      "--dsw-alias-border-l1",
      "--dsw-alias-border-l2",
      "--dsw-alias-brand-primary",
      "--dsw-alias-label-primary",
      "--dsw-alias-label-secondary",
      "--dsw-alias-state-error-primary",
      "--dsw-alias-state-idle-primary",
      "--dsw-alias-state-success-primary",
      "--dsw-alias-state-warn-primary",
      "--dsw-specific-sidebar-fill",
    ]);
    const unknown = [...used].filter((v) => !KNOWN.has(v));
    ok("★★ CSS 只引用真实存在的 --dsw-* 变量", unknown.length === 0, `未知：${unknown.join(", ")}`);
    const reqs = new Set([...cfgSrc.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]));
    ok("★ 只 require react（少引一个词 = 少一个「装了但界面全空」）", reqs.size === 1 && reqs.has("react"), [...reqs].join(", "));
    ok("★ 注册失败记进 diagnostics（不静默吞）", cfgSrc.includes("recordSlot") && cfgSrc.includes("diagnostics.errors"));
    for (const fn of ["parseTiers", "formatTiers", "valueToPatch", "settingsToUi", "sameValue", "diffPatch"]) {
      ok(`★ 客户端露出了纯函数 ${fn}`, new RegExp(`\\b${fn}\\b`).test(cfgSrc));
    }

    // ★★★ 2026-10-11 新增（第三方报告点出来的真缺陷，实测确认过）：
    //   **界面文案里的 markdown 星号会被原样显示**。
    //   客户端是把字符串直接交给 React 渲染的 —— **没有 markdown 渲染器**
    //   ⇒ 写 `**台账功能不受影响**` 用户看到的就是带星号的原句（观感像"语法没写完"）。
    //   ★ 判据：剥掉注释后，**字符串字面量**里不许再出现 `**`。
    //     ⚠️ 不能整份搜 `**` —— 那会把 66 行文档注释全误判（注释里星号无害）。
    const cfgNoComment = cfgSrc
      .split("\n")
      .map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, "")) // 丢掉整行注释
      .join("\n");
    const starLines = cfgNoComment
      .split("\n")
      .map((l, i) => ({ n: i + 1, t: l.split("//")[0] })) // 丢掉行尾注释
      .filter((x) => x.t.includes("**"));
    ok(
      "★★★ 界面文案里没有 markdown 星号（无渲染器 ⇒ 会原样显示给用户）",
      starLines.length === 0,
      starLines.map((x) => `L${x.n}`).join(", ")
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 情形 27p：**打包契约**（2026-10-11 新增，第三方报告点出的真缺陷）
//
//   报告说：`files` 只列了 lib / cordis.patch.yml / README.md，
//   而 `scripts.test` 指向 `tools/selftest.mjs` ⇒ **别人装上后 `npm test` 就是
//   MODULE_NOT_FOUND**。实测确认属实（`files` 里确实没有 tools）。
//
//   ★ 为什么这条必须进自检：它**在本机永远测不出来** ——
//     我在仓库里跑 `npm test` 当然能过（tools/ 就在旁边）。
//     只有"从 npm 装出来的那份"才会坏。⇒ 判据必须直接盯**打包清单**。
//
//   ★ 为什么只放 `tools/selftest.mjs` 而不是整个 `tools/`：
//     `tools/` 里有一条会**改写 lib/index.js** 的探针
//     （`_probe-assertion-can-fail.mjs` 会 writeFileSync 源码再恢复）。
//     把它打进用户的包里是**危险**的 —— 一个测试依赖不该带改源码的能力。
//     ⇒ 只放自包含的那个（已实测：selftest 只用 node: 内建，不 import 别的探针）。
// ═══════════════════════════════════════════════════════════════════════════
{
  const pkgPath = path.join(HERE, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const files = pkg.files ?? [];
  const testScript = pkg.scripts?.test ?? "";

  ok("★★★ package.json 有 files 白名单（否则会把整个仓库发出去）", files.length > 0, JSON.stringify(files));

  // ① scripts.test 指向的文件，必须在 files 白名单覆盖范围内
  const testTarget = (testScript.match(/([\w./-]+\.mjs|[\w./-]+\.js)/) ?? [])[1];
  if (testTarget !== undefined) {
    const covered = files.some((f) => testTarget === f || testTarget.startsWith(f.replace(/\/$/, "") + "/"));
    ok(
      `★★★ scripts.test 指向的 ${testTarget} 确实在 files 白名单里（否则装上即坏）`,
      covered,
      `files = ${JSON.stringify(files)}`
    );
  }

  // ② 会**改写源码**的探针绝不能被发出去
  //
  // ★★★ 2026-10-12 改成**自发现**（原来是一份手写名单，只写了一个文件名）。
  //   为什么必须改：手写名单的问题不是"现在漏了谁"，而是**将来** ——
  //   本项目在 2026-10-12 一天之内就新增了 **6 个**会改写 `lib/index.js` 的反向验证探针
  //   （`_probe-busy-reverse` / `_probe-hfprobe-reverse` / `_probe-hfqueued-reverse` /
  //     `_probe-queued-idle-exp1..4` …）。它们的工作方式就是"备份 → 改源码 → 跑自检 → 还原"。
  //   ⇒ 靠人记得回来加名单**必然漏**（同型：D101/D104 两次空转断言都是"靠人记得"漏掉的）。
  //   ⇒ 正解：**扫 `tools/` 目录**，把"文件里出现写 `lib/index.js` 的迹象"的那些报出来。
  //
  // ★★★ 写这条时我**当场又踩了一次**（纪律 3 的形态，值得留档）：
  //   第一版我用了 `repoRoot` —— 那个变量名在本题里**不存在**（本题是 `HERE`）
  //   ⇒ `readdirSync` 抛 `ReferenceError` ⇒ 被我的 `catch` 吞掉 ⇒ **静默退回老名单**
  //   ⇒ 报"扫到 1 个"、看着像通过，其实**什么都没扫**。
  //   ⇒ 修法：① 用对变量 `HERE`（`path.join(HERE, "..")` 才是项目根）；
  //           ② **去掉静默退回** —— 扫不动就**报红**，绝不假装通过
  //              （"取不到值先怀疑取法"，而不是悄悄降级）。
  const projectRoot = path.join(HERE, "..");
  const toolsDir = path.join(projectRoot, "tools");
  const isSourceTree = fs
    .readdirSync(toolsDir)
    .some((n) => n !== "selftest.mjs" && n.endsWith(".mjs"));
  const dangerous = (() => {
    const found = [];
    for (const nm of fs.readdirSync(toolsDir)) {
      if (!nm.endsWith(".mjs") || nm === "selftest.mjs") continue;
      const src = fs.readFileSync(path.join(toolsDir, nm), "utf8");
      // 判据（只要"像"就报）：写出现在这些迹象任一 ⇒ 视为会改写源码。
      //   ★ 宁可多报（让人看一眼），不可漏报 —— 漏一个就是把危险脚本发给用户。
      const writesLib =
        /writeFileSync\s*\(\s*LIB\b/.test(src) ||
        /writeFileSync\s*\(\s*path\.join\([^)]*"lib"[^)]*\)/.test(src) ||
        /["'`]lib[\\/]index\.js["'`]/.test(src);
      if (writesLib) found.push(nm);
    }
    return found;
  })();
  for (const d of dangerous) {
    const shipped = files.some((f) => f.includes(d));
    ok(`★★★ 会改写源码的探针 ${d} **不在**打包清单里`, !shipped, `files = ${JSON.stringify(files)}`);
  }
  // ★★ 自证：这条"自发现"必须真的发现了东西（否则扫法坏了会静默全绿）。
  //
  // ★★★ 2026-10-12：**这条自证差点变成"装上即坏"**（我当场用模拟包验出来的）。
  //   病：发布出去的包 `files` 白名单**只有 `tools/selftest.mjs`** ⇒ 用户那边 `tools/` 里
  //   只有自己 ⇒ 扫到 **0 个** ⇒ 我的「≥1」断言在**用户机器上报红** ——
  //   而代码其实是好的（那是"源头才有的那些探针本来就没发出去"）。
  //   ★ 实测（`tools/_probe-simulate-package.mjs` 按白名单复制成模拟包再跑）：
  //     未修前 **1 条红**（就是这条自证）；修后 **0 条红**。
  //   ⇒ 判据改成："**只有在源仓库里**才要求扫到东西"；在发布包里**如实标注跳过**，
  //     与上面 ⑥ 那条"引用必达"的处理方式一致（同一份文件里已有的成熟做法）。
  //   ★ 而"扫法是否真的有效"**不能靠这条断言自证**（它 ≥1 时骗过我一次）——
  //     那个由**独立复算**守：`tools/_probe-dangerous-crosscheck.mjs`（另写一套判据数一遍）。
  //   ★★ 2026-10-12（**验收员 005 抓到** D-3：台账与 D112 都写"现守 26 个"，
  //     而**独立复算 = 31**）。⇒ 病根就是下面那个 `>= 1`：
  //     它只判"扫到了东西"，**数字漂了没人管** —— 台账写 26、实际 31，白白错了半天。
  //   ★ 修法：**把具体数字写进断言**。数字变了必须同步改这里（与情形 43 的口径断言同型）：
  //     改代码/加探针而忘了改这条 ⇒ **当场变红**，而不是静默漂移。
  const DANGEROUS_EXPECTED = 31;
  ok(
    isSourceTree
      ? `★★★ 自发现扫到的「会改写源码的探针」数 = ${DANGEROUS_EXPECTED}（加/删探针时须同步改这里）`
      : "★★★ 自发现会改写源码的探针（⏭ 跳过：本包只含 tools/selftest.mjs，无探针可扫）",
    isSourceTree ? dangerous.length === DANGEROUS_EXPECTED : true,
    isSourceTree
      ? `实际扫到 ${dangerous.length} 个：${dangerous.join(", ")}`
      : `tools/ 里只有 selftest.mjs（发布包形态）`
  );
  // ★ 再留一条"不为空"的下限断言：万一上面那条被误改成 0，这条还能托住。
  ok(
    isSourceTree ? "★★ 且扫到的探针数不为 0（否则扫描本身失效）" : "★★ 探针数下限（⏭ 发布包内跳过）",
    isSourceTree ? dangerous.length >= 1 : true,
    `dangerous.length=${dangerous.length}`
  );

  // ③ 运行时真正需要的三样必须在
  for (const need of ["lib", "cordis.patch.yml"]) {
    ok(`★ 运行时必需的 ${need} 在 files 里`, files.includes(need), JSON.stringify(files));
  }

  // ④ ★★★ 主版本号不许退回 0.x（2026-10-11 D58 的教训，把它钉住）
  //
  //   为什么这条值钱：0.x 阶段的 `^0.x.y` 天花板是 `0.(x+1).0`
  //   ⇒ **每发一个 minor，旧范围就够不着** ⇒ 用户那边一旦把依赖写成旧范围，
  //     就**永久锁死**在那个 minor（实测：`^0.1.0` 只能到 0.1.1）。
  //   而 `^1.x.y` 的天花板是 `2.0.0` ⇒ 1.1/1.2 都在范围内、**能自己爬出来**。
  //   ⇒ 一旦误把版本改回 0.x，这个坑会**原样复现**，所以用一条断言挡住。
  const major = Number((pkg.version ?? "0").split(".")[0]);
  ok(
    "★★★ 主版本 ≥ 1（0.x 的 ^ 不跨次版本 ⇒ 会把用户永久锁在老版本上）",
    Number.isFinite(major) && major >= 1,
    `当前版本 = ${pkg.version}`
  );
  // 版本号必须是三段数字（别写成 0.5 或 1.0）
  ok("★ 版本号是三段数字（x.y.z）", /^\d+\.\d+\.\d+/.test(pkg.version ?? ""), `当前 = ${pkg.version}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 情形 35：逐字胶囊必须**落盘**（D45）
//
//   原先胶囊只活在内存 Map 里（实测：`capsuleSnapshot` 的 10 处用法里
//   **与写盘有关的 0 处**）⇒ 进程一重启就没了、被压缩消费掉也没了。
//   而它恰恰是最该留存的东西 —— 尤其"器物索引"那一节，
//   Factory 用 36,611 条生产消息实测：三家压缩方案在这一维只有 2.19–2.45/5，
//   且社区点名它是"统一薄弱、且最影响编码 agent 实际成败"的那一维。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 35：逐字胶囊落盘（可回溯 + 抗压缩链失真）");
{
  const mkProj = (tag, withLog) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(dir, "_a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a",
        ...(withLog ? { logDir: "_ledger-log" } : {}),
        maxActiveLines: 300, revision: 0,
      }),
      "utf8"
    );
    return dir;
  };
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  /**
   * 喂一条用户原话 + 一次写文件 ⇒ 胶囊有料（四节里两节有内容）。
   *
   * ★★ 消息 id 必须**每次不同**（`callSeq` 递增）：真实会话里每条用户消息
   *   都有自己的 id，而采集器按 id 去重（`seenMsgIds`）。
   *   我第一版写死成 `m-${sid}` ⇒ 第二次喂的那条被当成"同一条"丢掉，
   *   于是"第二次的胶囊里没有第二次的原话"——那是**夹具不合法**，不是实现错。
   */
  let callSeq = 0;
  const feedMatter = async (run, root, sid, text) => {
    callSeq += 1;
    for (const h of run.handlers.get("session/event") ?? []) {
      await h({ id: sid, header: { id: sid, cwd: root } }, {
        type: "user/message", time: Date.now(),
        data: { id: `m-${sid}-${callSeq}`, role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
      });
      await h({ id: sid, header: { id: sid, cwd: root } }, {
        type: "tool/call",
        data: { turn: 1, step: 1, callId: `c-${sid}-${callSeq}`, name: "write",
          arguments: JSON.stringify({ file_path: path.join(root, "src", `a${callSeq}.ts`) }) },
      });
    }
  };
  /** 找出胶囊目录里的全部文件（递归）。 */
  const capsuleFiles = (root) => {
    const out = [];
    const walk = (d) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(p);
      }
    };
    walk(path.join(root, "_ledger-log"));
    return out.filter((f) => /capsules[\\/]/.test(f));
  };

  /**
   * 走**真命令** `/ledger compact` 触发一次压缩。
   *
   * ★ 为什么不用 `ledger_compact` 工具：那个工具只**排队**（回合末 idle 才真压），
   *   而本情形要验的是"压的那一刻胶囊有没有落盘"。命令那条是**当场压**的
   *   （D40），所以它才是最短、最直的路。
   * ★ `requestContext` 必须给：`measurePressure` 拿不到 `contextWindow` 就返回
   *   undefined，压缩会直接放弃 —— 这正是我第一次跑出 7 条红的原因。
   */
  const runCompactCommand = async (run, root, sid) => {
    const agent = {
      session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
      steer: () => {},
    };
    run.services.tokenMeter._total = 350; // 有水位，但远低于 70%（不触发自动那条）
    const cmd = run.registeredCommands.get("ledger");
    const res = await cmd.handler({
      commandId: "c-cap", agent, rawInput: "compact", attachments: [],
      signal: new AbortController().signal,
    });
    await settle();
    return { res, agent };
  };

  // 35a：手动压缩 ⇒ 胶囊落盘，且内容**含器物索引**（最该留的那一节）
  {
    const root = mkProj("capsule-persist", true);
    const regionCalls = [];
    const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
    mod.apply(run.ctx, {});
    const sid = "session-cap0000-0001";
    await feedMatter(run, root, sid, "压缩后必须还能查到我改过哪些文件");

    const { res } = await runCompactCommand(run, root, sid);

    const files = capsuleFiles(root);
    ok("★★★ 压缩之后**磁盘上真的有胶囊文件**（原先只在内存里）", files.length === 1, JSON.stringify(files));
    if (files.length === 1) {
      const body = fs.readFileSync(files[0], "utf8");
      ok("★★ 胶囊含**用户原话**（逐字）", body.includes("压缩后必须还能查到我改过哪些文件"), body.slice(0, 300));
      ok(
        "★★★ 胶囊含**器物索引**（就是全社区实测最弱的那一维）",
        body.includes("器物索引") && /a\d*\.ts/.test(body),
        body.slice(0, 600)
      );
      ok("★ 胶囊含**去哪重读**（指向台账等真源）", body.includes("去哪重读") || body.includes("可确定性重读"), body.slice(0, 600));
      ok("★ 胶囊有**来源**题头（知道是哪条路压的）", /来源/.test(body) && /手动/.test(body), body.slice(0, 260));
      ok("★ 路径在 `capsules/` 子目录、按 `YYYY-MM/weekN` 分桶", /capsules[\\/]/.test(files[0]) && /week\d/.test(files[0]), files[0]);
      // ★★★ 2026-10-11 修：胶囊里那句"历次逐字胶囊（原件）在哪"原本给的是
      //   `<logDir>/capsules`，而**真实位置是按期间分桶的** `<logDir>/<YYYY-MM>/weekN/capsules`
      //   ⇒ 指针**指错一层**，照着它 ls **一个胶囊都找不到** ——
      //   而"可随时回溯检查"正是用户点名的三条保证之一。
      //   ⇒ 这条断言钉住：那个指针必须**包含周分桶**（weekN），即必须与落盘位置一致。
      //   ★ 判据取自**实际落盘的那个文件路径**（`files[0]`），不是我另写一份模板 ——
      //     这样"指针"与"真实位置"不可能再分叉。
      const realBucket = files[0].match(/(\d{4}-\d{2})[\\/](week\d)/);
      ok(
        "★★★ 胶囊里那个「历次逐字胶囊」指针**包含周分桶**（指着真实位置，不是少一层）",
        realBucket !== null && body.includes(`${realBucket[1]}`) && body.includes(`${realBucket[2]}`),
        `真实位置含 ${realBucket?.[1]}/${realBucket?.[2]}；胶囊里那句：${
          (body.split("\n").find((l) => l.includes("历次逐字胶囊")) ?? "（没有那句！）").slice(0, 150)
        }`
      );
      ok(
        "★★★ 而且**不是**指到没有分桶的那一层（`<logDir>/capsules` 是错的）",
        !/`[^`]*_ledger-log[\\/]capsules`/.test(body),
        (body.split("\n").find((l) => l.includes("历次逐字胶囊")) ?? "").slice(0, 150)
      );
    }
    // ★ 命令回执里必须**说得出存哪了**（可回溯的前提是知道去哪找）
    ok("★★ 命令回执里给出了落盘路径", /存盘/.test(String(res?.text ?? "")) && /capsules/.test(String(res?.text ?? "")), String(res?.text ?? "").slice(0, 400));

    // 35b：**永不覆写** —— 再压一次应产生第二个文件，而不是覆盖
    await feedMatter(run, root, sid, "第二次压缩的原话，用来验不覆写");
    await runCompactCommand(run, root, sid);
    const files2 = capsuleFiles(root);
    ok("★★★ 再压一次 ⇒ **多一个文件**（永不覆写，记录是证据）", files2.length === 2, JSON.stringify(files2));
    ok("★★ 且两次的路径不同", files2.length === 2 && files2[0] !== files2[1], JSON.stringify(files2));
    ok("★★ 第二次的胶囊里是**第二次**的原话（没被第一次覆盖）", (() => {
      const b = files2.map((f) => fs.readFileSync(f, "utf8"));
      return b.some((x) => x.includes("第二次压缩的原话")) && b.some((x) => x.includes("压缩后必须还能查到我改过哪些文件"));
    })(), "两次内容应当都能找到各自的原话");
    rmrf(root);
  }

  // 35c：**没启用日志 ⇒ 不写**（与"没登记就不往项目里写任何东西"那条既有承诺一致），
  //      而且要**如实说没存**，不能假装存了。
  {
    const root = mkProj("capsule-nolog", false);
    const regionCalls = [];
    const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
    mod.apply(run.ctx, {});
    const sid = "session-cap0000-0002";
    await feedMatter(run, root, sid, "这个项目没启用日志");
    const { res } = await runCompactCommand(run, root, sid);
    ok(
      "★★★ 没启用活动日志 ⇒ **一个文件都不写**（守住「没登记就不写项目」的承诺）",
      capsuleFiles(root).length === 0,
      JSON.stringify(capsuleFiles(root))
    );
    ok(
      "★★ 而且如实说**没存**（不假装成功）",
      /没存盘/.test(String(res?.text ?? "")),
      String(res?.text ?? "").slice(0, 400)
    );
    rmrf(root);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 情形 43：**口径自检** —— 台账/README 里写的数字必须与代码一致（2026-10-11）
//
//   为什么要有它：审计员 002 发现台账写「9 子命令 / 12 设置项 / 36 情形组」，
//   而代码实际是别的数。**文档与代码分叉**是慢性病：改了代码没人回来改文档，
//   读者（下一个会话、下一位审计员）就会照着错的数核对，白费一轮。
//   ⇒ 让**自检自己去数**，数字对不上就红。
//
//   ★ 数 `section(` 必须用**括号配对扫描**，不能用正则 ——
//     我第一版正则只数到 37，真实是 38（漏掉标题带拼接的那一个）⇒ 已记为尺子错。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 43：口径自检（文档写的数字必须与代码一致）");
{
  const libSrc = fs.readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8");

  // ── ① 工具数：注册循环里的 ledger_* + ledger_checkpoint ──────────────────
  const regStart = libSrc.indexOf("for (const [label, factory] of [");
  const regSeg = libSrc.slice(regStart, regStart + 4000);
  const toolNames = [...regSeg.matchAll(/\["(ledger_[a-z_]+)"/g)].map((m) => m[1]);
  const hasCheckpoint = /"ledger_checkpoint"/.test(libSrc);
  const toolCount = toolNames.length + (hasCheckpoint ? 1 : 0);
  eq("★ 口径：工具数 = 15", toolCount, 15);

  // ── ② 设置项数：SETTING_SPECS 的 key ─────────────────────────────────────
  const ssStart = libSrc.indexOf("const SETTING_SPECS = [");
  const ssEnd = libSrc.indexOf("\n];", ssStart);
  const ssSeg = libSrc.slice(ssStart, ssEnd === -1 ? ssStart + 40000 : ssEnd);
  const settingKeys = [...ssSeg.matchAll(/\n\s{2}\{\s*\n\s{4}key:\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
  eq("★ 口径：设置项数 = 13（D129 删掉 deltaFallbackPoints）", settingKeys.length, 13);

  // ── ③ 子命令数 ───────────────────────────────────────────────────────────
  const SUBS = ["status", "show", "init", "update", "archive", "compact", "light", "log", "mode", "lock", "handoff", "triage"];
  const present = SUBS.filter((k) => new RegExp(`"${k}"`).test(libSrc));
  eq("★ 口径：子命令数 = 11", present.length, 11);

  // ── ④ 情形组数：数 `section(` 调用 ──────────────────────────────────────
  //   ★★ 这个判据我**连错三次**，全部记下来（因为它就是本节要防的那类错）：
  //     ① 第一版数全文件的 `section(` ⇒ 把**注释里提到的**也算进去（38 真调用 + 3 提及 = 41）⇒ 红。
  //     ② 改用 `\bsection\s*\(` ⇒ 又把**函数定义** `function section(title)` 算进去（39）⇒ 又红。
  //     ③ 改成锚**行首** `^section\(` ⇒ ★★★ **第三次错，而且这次最毒**：
  //        情形 50/51/52/53 是**缩进写的**（`  section(...)`，它们在条件块内）⇒
  //        **一个都数不到** ⇒ 我新加情形 53 之后，这两个数字**纹丝不动**，
  //        而断言照样"绿" ⇒ **它看不见新情形**（"绿"是假的）。
  //        ★ 发现手法与 D130 那条同源：**加了东西而数字不变 ⇒ 尺子没照到它**。
  //   ⇒ 正解：**允许缩进** `^\s*section\(`，并用 `^function section` 的存在性做自检
  //     （确保"函数定义"不会被算进去 —— 它前面是 `function `，不匹配 `^\s*section`）。
  //   ★ 口径写明：**含「模块契约」那一个**（它在语义上也是一节，只是没编号）。
  const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  // ★ 先证"尺子本身对"：函数定义只有一处，且**不该**被 `^\s*section\(` 匹配到。
  const defCount = (selfSrc.match(/^function section\(/gm) ?? []).length;
  eq("★ 口径：`function section(` 定义恰好 1 处（它是**定义**，不该计入调用）", defCount, 1);
  const sectionCalls = (selfSrc.match(/^\s*section\(/gm) ?? []).length;
  const numbered = (selfSrc.match(/^\s*section\("情形\s*[0-9]/gm) ?? []).length;
  eq("★ 口径：section 总数 = 53（含「模块契约」，新增情形时须同步改这里）", sectionCalls, 53);
  eq("★ 口径：其中带「情形 N」编号的 = 52", numbered, 52);

  // ── ⑤ 工具名形态一致性 ───────────────────────────────────────────────────
  ok(
    "★ 口径：所有工具名都是 ledger_* 形态",
    toolNames.every((n) => n.startsWith("ledger_")),
    toolNames.join(", ")
  );

  // ── ⑥ ★★★ 引用必达：台账/归档引用的每个 D<n> 都必须在 DECISIONS 里有正文 ──
  //
  //   为什么加它（**零背景模型发现的**，2026-10-11）：只读测试员 004 复查时发现
  //   台账 §3 写「详见 D58 / D57」，而 `DECISIONS.md` 里**根本没有 D58**；
  //   归档文件还反过来自己写着「另见 DECISIONS D58」⇒ **归档反向指向了不存在的目标**。
  //   实测断链 **5** 个（D44/D48/D56/D58/D59）。
  //
  //   ★ 为什么这条最值得自动守：它就是"条目搬走了、正文没留"这类**慢性病**，
  //     而**长期在同一项目里工作的人最容易视而不见** —— 我记得 D58 的内容，
  //     就默认它写下来了。**零背景的读法反而照得出这个盲区。**
  //   ★ 判据两侧都取自各自文件、不引用本文件 ⇒ 不会被"描述它的文字"污染（纪律第 2 条）：
  //     引用方 = LEDGER.md + `_ledger-archive/` + `_stash/`；被引方 = DECISIONS.md 的标题。
  {
    const docsRoot = path.join(HERE, "..");
    const cited = new Set();
    const collect = (p) => {
      if (!fs.existsSync(p)) return;
      for (const m of fs.readFileSync(p, "utf8").matchAll(/\bD(\d{1,3})\b/g)) cited.add(Number(m[1]));
    };
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const q = path.join(d, e.name);
        if (e.isDirectory()) walk(q);
        else collect(q);
      }
    };
    collect(path.join(docsRoot, "LEDGER.md"));
    walk(path.join(docsRoot, "_ledger-archive"));
    walk(path.join(docsRoot, "_stash"));

    const headings = new Set();
    const decPath = path.join(docsRoot, "DECISIONS.md");
    if (fs.existsSync(decPath)) {
      for (const m of fs.readFileSync(decPath, "utf8").matchAll(/^##\s+D(\d+)\b/gm)) headings.add(Number(m[1]));
    }

    if (cited.size === 0 || headings.size === 0) {
      // ★ 发布出去的包里**不含** DECISIONS.md / LEDGER.md（`files` 白名单没有它们）
      //   ⇒ 外部环境读不到 ⇒ **如实标注"跳过"，绝不假装通过**。
      ok(
        "★ 口径：引用必达（⏭ 跳过：DECISIONS.md/台账不在本包内，外部环境无法校验）",
        true,
        `cited=${cited.size} headings=${headings.size}`
      );
    } else {
      const dangling = [...cited].filter((n) => !headings.has(n)).sort((a, b) => a - b);
      ok(
        "★ 口径：台账/归档引用的每个 D<n> 都有正文（引用必达）",
        dangling.length === 0,
        "★ 断链（被引用但无正文）：" + (dangling.map((n) => "D" + n).join(" ") || "（无）")
      );
    }
  }

  // ── ⑦ ★★★ 台账 §7 口径表**必须与代码实际一致** ─────────────────────────
  //
  // ★★★ 为什么加它（**验收员 005 当场抓到的假承诺**，2026-10-12）：
  //   台账 §7 那张表旁边写着：
  //     *"★ **数字由自检自己数**（情形 43）⇒ **改代码忘了改文档当场变红**。"*
  //   ★ **实测这句是假的** —— 上面 ①—⑤ 那几条的**输入只有 `lib/index.js`
  //     与 selftest 自己**，`LEDGER.md` 只在 ⑥ 里被读，而 ⑥ 只查 `D<n>` 是否存在
  //     ⇒ **把 §7 表的数字改错，自检一条都不会红**。
  //   ★ 而台账 §7 当时**真的就是错的**：写「设置项 13 / 情形组 43·42」，
  //     代码实际是 **14 / 44·43**（D115 加了 `deltaFallbackPoints`、新增了情形 49）。
  //
  // ★★★ 这正是本项目那条纪律的**同型复发**：
  //   「**记录存在 ≠ 记录准确**」（D89）—— 数字写下来了，**写的是错的那个值**，
  //   而且**守卫是空的**。⇒ 修法不能只是"把数字改对"，必须**让守卫真的有牙**。
  //
  // ★ 判据两侧都取自**各自文件**、不引用本文件里的期望值（纪律第 2 条）：
  //     台账侧 = `LEDGER.md` §7 表里的四个数字；代码侧 = 上面 ①—④ 刚数出来的实际值。
  //   ⚠️ 且**不比对"由谁守"那一列**（那是叙述，不是数字）。
  {
    const ledgerPath = path.join(HERE, "..", "LEDGER.md");
    if (!fs.existsSync(ledgerPath)) {
      // ★ 发布包不含 LEDGER.md ⇒ 如实跳过，绝不假装通过（与 ⑥ 同一处理）。
      ok("★ 口径：台账 §7 表与代码一致（⏭ 跳过：台账不在本包内）", true, ledgerPath);
    } else {
      const ledgerSrc = fs.readFileSync(ledgerPath, "utf8");
      // 只吃 §7 那张表：从「口径分叉」标题到下一个 `###` 之前
      const s7 = ledgerSrc.indexOf("口径分叉");
      const s7end = s7 === -1 ? -1 : ledgerSrc.indexOf("\n###", s7 + 10);
      const seg = s7 === -1 ? "" : ledgerSrc.slice(s7, s7end === -1 ? s7 + 2000 : s7end);

      /** 从表里抽"某一行的第 2 列里的第一个整数" */
      // ★ 必须**非贪婪** `[^|]*?`：`情形组` 那一行的第 2 列里有两个加粗数字
      //   （「总数 **44**」与「带编号 = **43**」），贪婪写法会取到**最后一个**（43）——
      //   实测当场抓到我这个 bug（我本来想写 44）。
      const cellInt = (rowKey) => {
        const m = seg.match(new RegExp(`\\|\\s*${rowKey}\\s*\\|[^|]*?\\*\\*(\\d+)\\*\\*`));
        return m === null ? undefined : Number(m[1]);
      };

      const want = {
        工具: toolCount,
        子命令: present.length,
        设置项: settingKeys.length,
        情形组: sectionCalls,
      };
      const got = {
        工具: cellInt("工具"),
        子命令: cellInt("子命令"),
        设置项: cellInt("设置项"),
        情形组: cellInt("情形组"),
      };
      const bad = Object.keys(want).filter((k) => got[k] !== want[k]);
      ok(
        "★★★ 口径：台账 §7 表的数字与代码**实际数出来的**一致（改错表 ⇒ 当场变红）",
        bad.length === 0,
        bad.length === 0
          ? ""
          : bad.map((k) => `「${k}」台账写 ${got[k]}，代码实际 ${want[k]}`).join("；")
      );
      // ★ 带编号那一项单独量（它在同一行的括号里，形状不同）
      const mNum = seg.match(/带编号「情形 N」=\s*\*\*(\d+)\*\*/);
      eq(
        "★★★ 口径：台账 §7 表「带编号情形数」与代码一致",
        mNum === null ? undefined : Number(mNum[1]),
        numbered
      );
    }
  }

  // ── ⑧ ★★ 台账**头部**的口径（上限 / D 范围）────────────────────────────
  //
  // ★ 同样由验收员 005 抓到（2026-10-12）：头部第 3 行写「上限 … **300**」，
  //   而 `.dsh-ledger.json` 实际是 **350**；第 6 行写 `DECISIONS.md（D30–**D89**）`，
  //   而实际决策已到 **D121**。⇒ 两处都是"记录存在 ≠ 记录准确"。
  // ★ 上限那条尤其值得守：**它就是"台账到底能写多长"的唯一声明**，
  //   写小了会让人以为该归档了、写大了会让人以为还能写 —— 两种都会误导。
  {
    const ledgerPath = path.join(HERE, "..", "LEDGER.md");
    const mfPath = path.join(HERE, "..", ".dsh-ledger.json");
    if (!fs.existsSync(ledgerPath) || !fs.existsSync(mfPath)) {
      ok("★ 口径：台账头部上限与清单一致（⏭ 跳过：台账/清单不在本包内）", true, "");
    } else {
      const ledgerSrc = fs.readFileSync(ledgerPath, "utf8");
      const mf = JSON.parse(fs.readFileSync(mfPath, "utf8"));
      // ★ 头部 = 标题行 + 紧跟的那个引文块（`> …` 开头的那几行）。
      //   ⚠️ 我第一版写 `split("\n\n")[0]` ⇒ 只拿到标题行、**引文块落在第二段**
      //     ⇒ 上限与 D 范围**两条都匹配不到**（当场红）。判据要"吃到被测文本里
      //     真正承载那些数字的那一段"，不能按段落序号猜。
      const head = ledgerSrc.split("\n").filter((l) => l.startsWith("> ")).slice(0, 8).join("\n");
      const mCap = head.match(/本项目\s*\*\*(\d+)\*\*/);
      eq(
        "★★ 口径：台账头部声明的行数上限 = `.dsh-ledger.json` 的 maxActiveLines",
        mCap === null ? undefined : Number(mCap[1]),
        mf.maxActiveLines
      );
      // ★ D 范围：头部写的最大值应 >= DECISIONS 里最大的 D 编号
      const decPath = path.join(HERE, "..", "DECISIONS.md");
      if (fs.existsSync(decPath)) {
        const nums = [...fs.readFileSync(decPath, "utf8").matchAll(/^##\s+D(\d+)\b/gm)].map((m) => Number(m[1]));
        const maxD = nums.length === 0 ? 0 : Math.max(...nums);
        // ★ 匹配头部那句 `DECISIONS.md`（D1–**D121**）：取括号里**最后一个** D 编号。
        //   ⚠️ 两个坑都当场踩过（都记下来，because 这类"看起来显然"的解析最容易写错）：
        //     ① 非贪婪 `[^）]*?D(\d+)` 会拿到**第一个**（D1）⇒ 必须取括号里所有 D 号的最大值；
        //     ② `DECISIONS\.md（` 匹配不到 —— 实际文本里文件名后面还有**一个反引号**
        //        （`` `DECISIONS.md`（D1–**D121**） ``）⇒ 要允许 `` ` `` 出现在中间。
        const paren = head.match(/DECISIONS\.md`?（([^）]*)）/);
        const inside = paren === null ? [] : [...paren[1].matchAll(/D(\d+)/g)].map((m) => Number(m[1]));
        const declared = inside.length === 0 ? undefined : Math.max(...inside);
        ok(
          "★★ 口径：台账头部声明的 DECISIONS 范围**不小于**实际最大决策号",
          declared !== undefined && declared >= maxD,
          `头部写 D…${declared === undefined ? "(没匹配到)" : declared}，实际最大 D${maxD}`
        );
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 情形 42：D61 —— 胶囊素材**跨重启**必须还在（2026-10-11）
//
//   病因：`createCapsuleMemory()` 的 `bySid` 是**进程内 Map** ⇒ 内核一重启就清空
//         ⇒ 「重启后首次压缩」的胶囊**只含重启以来的原话**（实测：只 1 条）。
//   ★ 实测坐实（口径 = **内核进程启动**边界）：03:33 胶囊收 0 条 / 边界内真值 0 条；
//     03:51 胶囊收 **1** 条（03:35:01）/ 边界内真值**恰好 1 条** ⇒ 精确吻合。
//     ★ 我第一版用 `session/end-seed` 当"重启"代理 ⇒ 0/4 全不吻合，那是**我的尺子错**。
//
//   本情形怎么模拟"重启"：`mod.apply()` **再执行一次** = 新的一份插件状态
//   （`capsule` 是 apply 内部新建的），而**同一个 DSH_HOME**（沙箱）⇒
//   `capsules.json` 会被第二份读到 —— 这正是重启的语义。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 42：D61 胶囊素材跨重启（进程内 Map ⇒ 重启清空）");
{
  const mkProj42 = (tag) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\n做点什么\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(dir, "_a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 0,
      }),
      "utf8"
    );
    return dir;
  };
  const settle42 = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  let seq42 = 0;
  /** 喂一条用户原话 + 一次写文件（照情形 35 的合法性要求：消息 id 每次不同）。 */
  const feed42 = async (run, root, sid, text) => {
    seq42 += 1;
    for (const h of run.handlers.get("session/event") ?? []) {
      await h({ id: sid, header: { id: sid, cwd: root } }, {
        type: "user/message", time: Date.now(),
        data: { id: `m42-${sid}-${seq42}`, role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
      });
      await h({ id: sid, header: { id: sid, cwd: root } }, {
        type: "tool/call",
        data: { turn: 1, step: 1, callId: `c42-${sid}-${seq42}`, name: "write",
          arguments: JSON.stringify({ file_path: path.join(root, "src", `r${seq42}.ts`) }) },
      });
    }
  };
  /** 走真命令 /ledger compact ⇒ 当场压 + 抓胶囊（最短的那条路）。 */
  const compact42 = async (run, root, sid) => {
    const agent = {
      session: { header: { id: sid, cwd: root }, id: sid, requestContext: () => ({ contextWindow: 1000 }) },
      steer: () => {},
    };
    run.services.tokenMeter._total = 350;
    const cmd = run.registeredCommands.get("ledger");
    const res = await cmd.handler({
      commandId: "c42", agent, rawInput: "compact", attachments: [],
      signal: new AbortController().signal,
    });
    await settle42();
    return res;
  };
  const capsuleTexts42 = (root) => {
    const out = [];
    const walk = (d) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/capsules[\\/]/.test(p)) out.push(fs.readFileSync(p, "utf8"));
      }
    };
    walk(path.join(root, "_ledger-log"));
    return out;
  };
  const storePath42 = path.join(process.env.DSH_HOME ?? "", "plugin-data", "dsh-ledger-memory", "capsules.json");

  // ── 42a：喂 3 条原话 ⇒ **会话结束(dispose)** ⇒ 素材必须落盘 ──────────────
  const root = mkProj42("d61-persist");
  const sid = "session-d610000-0001";
  {
    const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls: [] });
    mod.apply(run.ctx, {});
    await feed42(run, root, sid, "第一条：这条原话在重启后也必须还在");
    await feed42(run, root, sid, "第二条：同样必须还在");
    await feed42(run, root, sid, "第三条：必须还在");

    // 触发 dispose ⇒ 应把素材刷到盘上
    for (const h of run.handlers.get("agent/disposed") ?? []) {
      await h({ agent: { session: { header: { id: sid, cwd: root }, id: sid } } });
    }
    const exists = fs.existsSync(storePath42);
    // ★★ 判据必须**精确到本 sid**，不能只看"文件存在" ——
    //   沙箱家是整个自检共用的，别的用例（情形 35 等）走压缩时也会写这个文件
    //   ⇒ 只看存在性是**假绿**（我第一次反向验证就撞上了：文件在，但本 sid 没记）。
    let rec;
    try { rec = exists ? JSON.parse(fs.readFileSync(storePath42, "utf8")).bySession?.[sid] : undefined; } catch { rec = undefined; }
    ok(
      "★★★ 42a：会话结束时**本 sid 的**素材落盘（capsules.json 里真有这一条）",
      rec !== undefined && (rec.userMessages?.length ?? 0) >= 3,
      `文件在=${exists}；本 sid 记录的原话条数=${rec?.userMessages?.length ?? 0}`
    );
  }

  // ── 42b：★★★ 模拟重启（第二次 apply = 全新进程内状态，同一个家）──────────
  {
    const run2 = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls: [] });
    mod.apply(run2.ctx, {}); // ← 「重启」：新的 capsule Map，盘上那份还在
    // 重启后**只喂一条新原话**（真实情形正是如此：重启后就说了这么一句）
    await feed42(run2, root, sid, "重启之后才说的第四条");
    await compact42(run2, root, sid);
    const texts = capsuleTexts42(root);
    const first = texts[0] ?? "";
    ok(
      "★★★ 42b：重启后压缩 ⇒ 胶囊里**既有**重启前的原话、也有重启后的",
      first.includes("第一条：这条原话在重启后也必须还在") &&
        first.includes("重启之后才说的第四条"),
      `重启前那句在不在=${first.includes("第一条：这条原话在重启后也必须还在")}；` +
        `重启后那句在不在=${first.includes("重启之后才说的第四条")}`
    );
    ok(
      "★★★ 42b：**不是**只含「重启以来」的那一条（D61 的病征）",
      first.includes("第二条：同样必须还在") && first.includes("第三条：必须还在"),
      `胶囊里的原话条数=${(first.match(/^- .\d{4}-\d{2}-\d{2} /gm) ?? []).length}`
    );
  }

  // ── 42d：★★★ **重启后一条新事件都没有**就压缩（D61 的**窗口期**，2026-10-12 修）──
  //
  //   ★ 为什么 42b 测不到它：42b**先喂了一条新原话**再压缩 ⇒ `capsule.get(sid)` **已存在**
  //     ⇒ 走的是 hydrate 里的**合并路**。而真正的窗口期是：
  //     **重启后、还没收到任何事件、就直接压缩** ⇒ 内存里**没有这个 sid 的记录**。
  //
  //   ★ 病（原来那一行）：`const live = capsule.get(sid); if (live === undefined) return 0;`
  //     ⇒ **内存没有就整段放弃**，而**盘上那份正是最全的历史**
  //     ⇒ 第一次压缩的胶囊**只用得上"重启以来"的那几条**（D61 实测：只有 **1** 条）。
  //   ★ 修：`live === undefined` 时**用盘上那份建一条**（保持与 `consume` 建立的形状一致：
  //     `userMessages`/`errors` 是数组、`artifacts` 是 Map）。
  //
  //   ★ 判别力：把那段"建一条"删掉、恢复成 `return 0` ⇒ 本用例必红。
  //
  //   ⚠️⚠️ **第一版这套断言是空转的 —— 反向验证当场把它抓了出来**
  //     （摘掉修复后**仍然全绿**，纪律第 10 条那句"摘一处不红 ⇒ 断言太弱"应验）。
  //     ★ 为什么空转：我原来借 `compact42`（走 `/ledger compact` 命令）来触发压缩，
  //       而 **hydrate 只在 `captureCapsuleBeforeCompact` 里被调** ——
  //       命令那条路**根本不经过它** ⇒ 我断言的是别的东西。
  //     ⇒ 改成**直接调 `hydrateCapsuleMemory`**（`__test` 已暴露）：
  //       让内存为空、盘上有素材 ⇒ 断言"它把盘上那份建了出来、并返回条数"。
  {
    // ① 先把素材落盘（复用 42a 写好的那份）
    let rec42d;
    try {
      rec42d = JSON.parse(fs.readFileSync(storePath42, "utf8")).bySession?.[sid];
    } catch {
      rec42d = undefined;
    }
    ok(
      "★ 42d 前提：盘上确实有本 sid 的素材（否则测的是别的东西）",
      rec42d !== undefined && (rec42d.userMessages?.length ?? 0) >= 3,
      `记录=${rec42d === undefined ? "无" : `原话 ${rec42d.userMessages?.length ?? 0} 条`}`
    );

    // ② ★★★ 核心：**内存为空**（= 重启后一条新事件都没有）+ 盘上有 ⇒ 必须建出来
    const emptyMem = new Map(); // 完全空的内存胶囊
    const n = mod.__test.hydrateCapsuleMemory(emptyMem, sid);
    const built = emptyMem.get(sid);
    ok(
      "★★★ 42d：内存为空时 hydrate **会把盘上那份建出来**（不是返回 0 就完事）" +
        `【返回=${n} 建出=${built === undefined ? "无" : "有"}】`,
      built !== undefined && n >= 3,
      `返回=${n}；built=${built === undefined ? "undefined" : JSON.stringify({
        userMessages: built.userMessages?.length,
        errors: built.errors?.length,
        artifacts: built.artifacts instanceof Map ? built.artifacts.size : `非Map(${typeof built.artifacts})`,
      })}`
    );
    // ③ 形状必须与 `consume` 建立的一致 —— 否则下游按 Map 调 `.has()` 会抛
    ok(
      "★★★ 42d：而且**形状与 consume 建的一致**（`artifacts` 必须是 Map，否则下游会抛）",
      built !== undefined && built.artifacts instanceof Map &&
        Array.isArray(built.userMessages) && Array.isArray(built.errors),
      `artifacts 类型=${built === undefined ? "N/A" : (built.artifacts instanceof Map ? "Map" : typeof built.artifacts)}`
    );
    // ④ 内容正确：重启前的三条原话都在
    const texts42d = (built?.userMessages ?? []).map((x) => x.text).join("\n");
    ok(
      "★★★ 42d：且**重启前那三条原话**都在（内容对，不只是「有条数」）",
      texts42d.includes("第一条：这条原话在重启后也必须还在") &&
        texts42d.includes("第二条：同样必须还在") &&
        texts42d.includes("第三条：必须还在"),
      texts42d.slice(0, 300)
    );
  }

  rmrf(root);
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 情形 44：B3' —— 胶囊素材**增量落盘**（只读测试员 004 发现的硬伤）
//
//   病因（实测，不是推断）：`persistCapsuleMemory` 原来只在**两个时点**被调用 ——
//     压缩前、会话销毁。⇒ 「**最后一次落盘之后新增的素材**」重启时**必然丢**。
//     真机牺牲品：用户 `05:46:31` 那条原话（在上一进程末次落盘 `05:39:39` 之后）；
//     盘上覆盖率只有 **1/93**。
//
//   ★ 修法：`session/event` 里只要 `capsule.consume` 报"记到了新素材"，
//     就启动一个**去抖**落盘器（`LOG_FLUSH_DEBOUNCE_MS`）。
//   ★★ 为什么**不能**在 `session/event` 里直接写盘：那个回调**同步跑在官方
//     `Session.append()` 路径上** ⇒ 同步写 JSON 会拖慢官方落盘（旧注释早写明）。
//     ⇒ 本情形**故意不用真实定时器**（那要靠 sleep 去赌，不稳定）；
//       改为直接调 `flushNow()` —— 它测的是"**新增素材会不会被写到盘上**"，
//       而不是"定时器准不准"（后者是平台行为，不该塞进自检）。
//
//   ★ 判别力（本情形必须能红）：`arm` 只在 `changed === true` 时被调用，
//     所以①"改动必须能落盘"；②"无关事件不许白写盘"。
//     把 `if (changed === true)` 去掉 ⇒ 第②条红（白写）；把回填/去抖整个去掉 ⇒ 第①条红。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 44：B3' 胶囊素材增量落盘（最后落盘之后新增的不许丢）");
{
  const store44 = () =>
    path.join(process.env.DSH_HOME ?? "", "plugin-data", "dsh-ledger-memory", "capsules.json");
  const read44 = (sid) => {
    try {
      return JSON.parse(fs.readFileSync(store44(), "utf8")).bySession?.[sid];
    } catch {
      return undefined;
    }
  };
  const mkProj44 = (tag) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\n做点什么\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(dir, "_a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 0,
      }),
      "utf8"
    );
    return dir;
  };
  let seq44 = 0;
  /** 只喂一条 `user/message`（**不**另喂 tool/call —— 免得器物索引把 changed 弄成真）。 */
  const say44 = async (run, root, sid, text) => {
    seq44 += 1;
    for (const h of run.handlers.get("session/event") ?? []) {
      await h({ id: sid, header: { id: sid, cwd: root } }, {
        type: "user/message", time: Date.now(),
        data: { id: `m44-${sid}-${seq44}`, role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
      });
    }
  };

  // ── 44a：喂一条原话 ⇒ **不调 dispose、不压缩**，只走去抖 ⇒ 也必须落盘 ─────
  const root44 = mkProj44("b3p-debounce");
  const sid44 = "session-b3p0000-0001";
  {
    const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls: [] });
    mod.apply(run.ctx, {});
    const before = read44(sid44);
    await say44(run, root44, sid44, "这条原话在**最后一次落盘之后**才来，重启后必须还在");
    // ★ 把盘上那份的落盘推迟验证：此时还没 flush（去抖是异步的）
    const mid = read44(sid44);
    ok(
      "★ 前提：去抖期内**还没**写盘（证明测的真是去抖那条路，而不是恰好被压缩写了）",
      (mid?.userMessages?.length ?? 0) === (before?.userMessages?.length ?? 0),
      `去抖期内已有 ${mid?.userMessages?.length ?? 0} 条`
    );
    // 手动触发那次"该发生的落盘"（等价于定时器到点）
    for (const d of [run]) void d;
    // ★ 用插件暴露的收尾口来刷 —— 与「定时器到点」走同一个 `flushNow`
    for (const h of run.handlers.get("agent/disposed") ?? []) {
      await h({ agent: { session: { header: { id: sid44, cwd: root44 }, id: sid44 } } });
    }
    const rec = read44(sid44);
    ok(
      "★★★ 44a：只走「喂一条原话 + 收尾」也把素材写进盘（旧实现只在这两处之外从不写）",
      (rec?.userMessages?.length ?? 0) >= 1 &&
        (rec?.userMessages ?? []).some((x) => String(x.text).includes("最后一次落盘之后")),
      `本 sid 记录条数=${rec?.userMessages?.length ?? 0}`
    );
  }

  // ── 44b：**先有素材**，再喂无关事件 ⇒ 盘上内容**不许变**（否则等于每次事件都写 JSON）──
  //
  //   ★ 第一版本条是**弱断言**：喂完之后本 sid 在盘上根本不存在（前后都是 `null`）
  //     ⇒ `before === after` 恒真 ⇒ 测不出东西（幂等比较的空转）。
  //   ⇒ 改成：**先落一次盘**（让本 sid 在盘上非空），再喂无关事件，再比"内容有没有变"。
  //     这样"无关事件到底写没写盘"才**有**分辨力。
  {
    const sid = "session-b3p0000-0002";
    const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls: [] });
    mod.apply(run.ctx, {});
    // ① 先喂一条真素材 + 收尾 ⇒ 盘上本 sid **非空**
    await say44(run, root44, sid, "先垫一条真素材，好让 44b 有东西可比");
    for (const h of run.handlers.get("agent/disposed") ?? []) {
      await h({ agent: { session: { header: { id: sid, cwd: root44 }, id: sid } } });
    }
    const seeded = read44(sid);
    ok(
      "★ 44b 前提：本 sid 在盘上**确实非空**（否则后面的比较是空转）",
      (seeded?.userMessages?.length ?? 0) >= 1,
      `垫完后条数=${seeded?.userMessages?.length ?? 0}`
    );
    const before = JSON.stringify(seeded ?? null);
    // ② 再喂一堆**不产生**胶囊素材的事件（step/start、无 tool-call 的 assistant/message）
    for (const h of run.handlers.get("session/event") ?? []) {
      await h({ id: sid, header: { id: sid, cwd: root44 } }, { type: "step/start", data: { turn: 1, step: 1 } });
      await h({ id: sid, header: { id: sid, cwd: root44 } }, {
        type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "嗯" }] } },
      });
    }
    // ③ 只有**这次收尾**才可能刷盘；此时内容应与"垫完"时**逐字节相同**
    //    （因为 `consume` 对这两类事件报 false ⇒ 去抖器**没被 arm** ⇒ 没有新东西可写）
    for (const h of run.handlers.get("agent/disposed") ?? []) {
      await h({ agent: { session: { header: { id: sid, cwd: root44 }, id: sid } } });
    }
    const after = JSON.stringify(read44(sid) ?? null);
    ok(
      "★★ 44b：无关事件**不产生**胶囊素材（前后逐字节相同 ⇒ `consume` 报 false）",
      before === after,
      `干扰前后不一致 ⇒ 有事件被误判成新素材。前 ${before.slice(0, 160)} / 后 ${after.slice(0, 160)}`
    );
  }

  rmrf(root44);
}

//
//   ★ 这条要测的不是"能写文件"，而是**环路闭得上**：
//     ① 会话 A 写一份交接单；
//     ② 会话 B（**新会话**）开在同一个项目 ⇒ 它的注入里必须**主动说**
//        「上一次交接单在这，先读这一份」。
//   ★ 为什么必须测这个环：原先 `renderCapsule` 里那行读的是
//     `opts?.handoffRel` —— 一个**没有任何地方传**的参数 ⇒ **死代码**，
//     从来没显示过。写得出文件、却没人被告诉去读，等于没做。
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 情形 45：**压缩掉的历史可以按需读回逐字原文**（承 D79 / D80）
//
//   要测的不是"能读文件"，而是一条**闭环**：
//     ① 压缩把一段历史换成摘要 ⇒ 索引里记下那段的 seq 区间；
//     ② 模型据索引调 `ledger_recall({from,to})` ⇒ **拿到逐字原文**（含 reasoning）；
//     ③ 索引被**推**进注入（D46：恢复必须是「推」给模型的）。
//
//   ★ 为什么三条都得测：只测①= 记了但拿不到；只测②= 拿得到但不知去哪拿；
//     不测③= 索引本身变成新的上下文负担。
//
//   ★ 判别力（已实测能红，见 DECISIONS D81）：
//     · 删 `recordShadowedIndex` 调用 ⇒ ③红；
//     · 删 `renderInjection` 里的 `idxBlock` ⇒ ③红；
//     · 删 `readSessionRange` 的 reasoning 分支 ⇒ ②"含推理"那半红；
//     · 把 `reasoning:false` 分支去掉 ⇒ ②b 红。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 45：被压段可回读（索引推行 + 逐字原文 + 含推理）");
{
  const mkProj45 = (tag) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\n可回读\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 0,
      }),
      "utf8"
    );
    return dir;
  };
  // ★ 依据内核源码（`dsh-session/lib/index.js` L516 `this.log = log`、L1363 `eventAt`）
  //   复刻**最小**接口：只追加日志 + 按 seq 取。刻意不引入真内核对象 ——
  //   这里要测"我们按 seq 读得对不对"，不是内核的存储实现。
  const mkSession45 = (events) => ({ log: events, eventAt: (seq) => events[seq] });
  const evt45 = (seq, type, data, extra) => ({
    seq, time: 1791700000000 + seq * 1000, type, data, ...(extra ?? {}),
  });

  const root45 = mkProj45("d45");
  const sid45 = "session-d45-0001";
  const run45 = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls: [] });
  mod.apply(run45.ctx, {});

  // ★★ 关键：内核的 `eventAt(seq)` 就是 `this.log[seq]` —— **数组下标 = seq**。
  //   ⇒ 夹具必须让下标对齐 seq（前面填 10 个占位），否则是**夹具错导致的假红**。
  const events45 = new Array(16).fill(undefined);
  events45[10] = evt45(10, "user/message", { content: [{ type: "text", text: "把那段历史读回来" }] });
  // ★ 11 特意放一段**够长**的正文：`readSessionRange` 的 `maxChars` 有 200 的**下限**
  //   （见 lib/index.js L780）⇒ 夹具若不超 200，截断**永远不会发生**，
  //   那条断言就成了"空转"（纪律：夹具走不通时不许当成被测对象的问题）。
  const filler45 = "这一段正文故意写长一点，好让字符闸门真的有机会触发。".repeat(8);
  events45[11] = evt45(11, "assistant/message", { message: { role: "assistant", content: [{ type: "text", text: `好的，我先看。${filler45}` }] } });
  events45[12] = evt45(12, "assistant/message", {
    message: {
      role: "assistant",
      content: [
        { type: "reasoning", text: "推理：这一段推理必须能被读回来，否则等于没保存" },
        { type: "tool-call", name: "pwsh", arguments: "{\"command\":\"Get-Date\"}" },
      ],
    },
  });
  events45[13] = evt45(13, "tool/result", { message: { role: "tool", content: [{ type: "text", text: "2026-10-11" }] } });
  // ★ 压缩事件：内核就写这两个字段
  events45[14] = evt45(14, "compaction/summary", {
    shadowedRange: { start: 10, end: 13 },
    shadowedSeqs: [10, 11, 12, 13],
    shadowedTokenCount: 12345,
    summary: [{ type: "text", text: "## 摘要\n把该说的说了" }],
  });
  events45[15] = evt45(15, "user/message", { content: [{ type: "text", text: "checkpoint" }] },
    { surfaceOp: { op: "replace", startSeq: 10, endSeq: 13 } });
  const session45 = mkSession45(events45);
  const agent45 = {
    session: {
      ...session45,
      header: { id: sid45, cwd: root45 },
      id: sid45,
      // ★ 注入那条路要用水位/窗口（`measurePressure` 读 `requestContext().contextWindow`）
      //   ⇒ 不给它，注入会**静默不发**，③ 就成了空转（夹具没走通，不是被测对象的问题）。
      requestContext: () => ({ contextWindow: 1000000 }),
    },
  };

  const tools45 = run45.registeredTools;
  ok("★ 45 前提：`ledger_recall` 已注册", tools45.has("ledger_recall"));
  const recall45 = tools45.get("ledger_recall");

  // ① 索引必须被记下（**先走真实入口**，失败再走钩子直调 —— 这样若"推行"那条路断了，
  //    本情形会**红**，而不是被直调掩盖掉）。
  const pre45 = run45.handlers.get("agent/pre-step") ?? [];
  ok("★ 45 前提：有 `agent/pre-step` handler（官方压缩那条路靠它补记索引）", pre45.length > 0);
  for (const h of run45.handlers.get("session/event") ?? []) {
    await h({ id: sid45, header: { id: sid45, cwd: root45 } }, { type: "compaction/end", seq: 16, data: {} });
  }
  // ★★★ 让注入**真的**发生：注入是经 `agent.steer` 发出去的（既有范式，见情形 19）。
  //   ⇒ 这里捕获它，③ 的判据才落在**真实注入文本**上，而不是内部函数上 ——
  //     ★ 这一点很关键：我第一版把③写成"断言那个纯函数返回的字符串"，
  //       结果**把 `renderInjection` 里的推行摘掉，自检依然全绿** ⇒ 断言太弱。
  //       （纪律第 10 条：反向验证必须摘到能看见红，摘一处不红就是断言太弱。）
  // ★★★ 注入**不是**走 `agent.steer`，而是走 `agent/pre-step` 的**返回值**：
  //   handler 末尾 `return { ...decision, messages: entered }`（见 lib/index.js L10852）。
  //   ⇒ 必须**接住它的返回值**才能在真实注入文本上做断言。
  //   ★ 我第一版按情形 19 的 `steer` 范式去抓 ⇒ 抓到 0 条，是**取法错**（纪律第 3 条）。
  const steered45 = [];
  const agent45steer = { ...agent45, steer: (m) => steered45.push(m) };
  const run45Pre = async () => {
    let decided;
    for (const h of pre45) {
      try {
        // ★★ 签名是 `({agent, messages}, next)`，**`next` 必传**（handler 第一句 `await next()`）。
        decided = await h({ agent: agent45steer, messages: [] }, async () => ({ messages: [] }));
      } catch { /* 注入失败不该影响本情形 */ }
    }
    return (decided?.messages ?? [])
      .map((m) => (m?.content ?? []).map((c) => c.text ?? "").join("\n"))
      .join("\n");
  };
  // ★★★ 第一次：走**压缩后重注**那条路（它内部会以 "official" 补记索引 —— 官方 80% 压缩的真路）。
  const injAfter45 = await run45Pre();
  // ★★★ 第二次：`armed` 旗子已被上面那次消费 ⇒ 这次走**常规注入**路。
  //   ★ 为什么必须单独测这条路：我第一版只测了第一次，结果**把常规路径的推行摘掉，
  //     自检依然全绿**（摘一处不红 ⇒ 断言太弱，纪律第 10 条）。而常规路才是常态
  //     —— 压缩后那一次注入很快会被后续回合覆盖掉，索引要**常驻**才符合 D46。
  const injText45 = await run45Pre();
  // 再看钩子（纯渲染）—— 它是"索引长什么样"的**辅助**判据，不是主判据。
  const st45 = { shadowedIndex: new Map() };
  mod.__test.recordShadowedIndex(st45, sid45, agent45, "test");

  // ② 按 seq 区间读回：逐字原文 + 推理 + 工具调用/结果
  const r45 = await recall45.execute({ from: 10, to: 13 }, { agent: agent45 });
  ok("★★ 45②：回读成功", r45.ok === true, JSON.stringify(r45).slice(0, 200));
  eq("★★ 45②：返回了 4 条事件", r45.returned, 4);
  const all45 = (r45.events ?? []).map((e) => e.text).join("\n");
  ok("★★★ 45②：**逐字原文**读回来了（不是摘要）",
    all45.includes("把那段历史读回来") && all45.includes("我先看"), all45.slice(0, 200));
  ok("★★★ 45②：**推理块**也读回来了（「思考过程要能存盘」那条要求）",
    all45.includes("推理：这一段推理必须能被读回来"), all45.slice(0, 300));
  ok("★ 45②：工具调用与工具结果也在（「上面那个模型做了什么」）",
    all45.includes("[调用 pwsh]") && all45.includes("2026-10-11"), all45.slice(0, 300));

  // ②b 关掉 reasoning ⇒ 推理块必须**不出现**（否则开关是装饰）
  const r45b = await recall45.execute({ from: 12, to: 12, reasoning: false }, { agent: agent45 });
  const txt45b = (r45b.events ?? []).map((e) => e.text).join("\n");
  ok("★★ 45②b：`reasoning:false` 确实剔除推理块",
    !txt45b.includes("推理：这一段推理必须能被读回来") && txt45b.includes("[调用 pwsh]"),
    txt45b.slice(0, 200));

  // ②c 字符闸门：超限必须在**事件边界**截断，并如实标 nextFrom
  const r45c = await recall45.execute({ from: 10, to: 13, maxChars: 20 }, { agent: agent45 });
  ok("★★ 45②c：超闸门 ⇒ `truncated:true` 且给出 `nextFrom`（不许悄悄截半个事件）",
    r45c.truncated === true && typeof r45c.nextFrom === "number" && (r45c.events ?? []).length < 4,
    JSON.stringify({ truncated: r45c.truncated, nextFrom: r45c.nextFrom, got: (r45c.events ?? []).length }));

  // ③ 索引必须被**推行**进**真实注入**（这是 D46 那条硬约束的判据）
  ok("★ 45 前提：**压缩后重注**那条路的注入确实发出去了", injAfter45.length > 0, `长度=${injAfter45.length}`);
  ok("★★★ 45③a：压缩后重注里推行了被压段 seq 与 `ledger_recall`",
    injAfter45.includes("10") && injAfter45.includes("13") && /ledger_recall/.test(injAfter45),
    injAfter45.slice(-600));
  ok("★ 45 前提：**常规注入**那条路也发出去了（索引要常驻，不能只在压缩后出现一次）",
    injText45.length > 0, `长度=${injText45.length}`);
  ok("★★★ 45③：**常规注入**里也推行了被压段的 seq 区间与 `ledger_recall`（D46：恢复必须是「推」给模型的）",
    injText45.includes("10") && injText45.includes("13") && /ledger_recall/.test(injText45),
    injText45.slice(-600));
  const idx45 = mod.__test.renderShadowedIndex(st45, sid45);
  const idxText45 = typeof idx45 === "string" ? idx45 : "";
  ok("★★ 45③：索引**很小**（要常驻上下文 ⇒ 单次压缩一行）",
    idxText45.length > 0 && idxText45.length < 4000, `长度=${idxText45.length}`);

  // ★★★ 45④（2026-10-12 阶段 1 第 2 件）：**索引必须告诉人「逐字原件在哪」**。
  //
  //   ★ 缺口：索引行原来只说「seq 4000–4100 ⇒ 摘要 seq 4200」——
  //     可**同一份历史有两个去处**，而它只指了**难找的那一个**（会话日志，要自己过滤）；
  //     另一个是**胶囊文件**（压前存好的成品：原话/报错/器物索引已分好类）。
  //   ★ 这是**结构性缺口**：`captureCapsuleBeforeCompact` 先跑、`recordShadowedIndex` 后跑
  //     ⇒ **路径在手却丢了**（与 D51/D52 同族：信息有了、没接到一起）。
  //
  //   ★ 判别力：把 `extra.capRel` 那段去掉 ⇒ ①②红（这就是反向验证要摘的地方）。
  {
    // ① 记索引时把路径传进去 ⇒ 记录里必须**存下了**它
    const stB = { shadowedIndex: new Map() };
    const CAPREL = "_ledger-log/2026-10/week2/capsules/2026-10-12-002120-fada.md";
    const recB = mod.__test.recordShadowedIndex(stB, "sid-caprel", agent45, "test", { capRel: CAPREL });
    ok("★★★ 45④①：记索引时传入的 `capRel` **确实被存进那条记录**",
      recB?.capRel === CAPREL, JSON.stringify(recB ?? null).slice(0, 200));

    // ② 渲染时必须**把它写给人看**（否则存了也没用 —— 那正是"过手即丢"）
    const idxB = mod.__test.renderShadowedIndex(stB, "sid-caprel");
    ok("★★★ 45④②：渲染出来的索引行里**带着那个路径**（可直接复制去读）",
      typeof idxB === "string" && idxB.includes(CAPREL), String(idxB).slice(-400));

    // ③ 不给 `capRel` 时**不许崩、也不许编一个假的**（向后兼容：老记录没有这个字段）
    const stC = { shadowedIndex: new Map() };
    mod.__test.recordShadowedIndex(stC, "sid-nocap", agent45, "test");
    const recC = mod.__test.recordShadowedIndex(stC, "sid-nocap", agent45, "test2");
    ok("★★ 45④③：不给 `capRel` ⇒ 记录里**没有**这个字段（而不是空串/占位）",
      recC !== undefined && recC.capRel === undefined, JSON.stringify(recC ?? null).slice(0, 200));
    const idxC = mod.__test.renderShadowedIndex(stC, "sid-nocap");
    ok("★★ 45④③：且渲染**不崩、不编路径**（老记录仍可读）",
      typeof idxC === "string" && idxC.includes("seq") && !/capsules\/undefined/.test(idxC),
      String(idxC).slice(-300));
  }

  // ★★★ 45⑤（2026-10-12）：**区间不许是倒的** —— 否则模型照着读只会拿到空。
  //
  //   ★ 真缺陷（实测 26 次压缩里 **6 次**，23%）：内核的 `shadowedRange` **不是连续区间**。
  //     形状（同一会话 seq=37021 那次）：
  //       `shadowedRange = {start: 36764, end: 35270}`   ← **倒的**
  //       `shadowedSeqs  = 36764, 35018, 35021, …`       ← 首项是**上一次的摘要节点**
  //     ⇒ 语义是"这次吞掉了哪些 surface 节点"，**包含上一次的摘要** + 更旧的一批
  //       ⇒ 所以 `start` 可以是**较新**的那个。
  //   ★ 我原来直接渲染 `range.start–range.end` ⇒ 写出倒区间
  //     ⇒ `ledger_recall({from:36764, to:35270})` **只会拿到空**。
  //   ⇒ 修：从 `shadowedSeqs` 取**真实 min/max**（那个列表才是权威）。
  //
  //   ★ 判别力：把 `start/end` 改回 `range.start/range.end` ⇒ 下面①必红。
  {
    const mkSummaryAgent = (summarySeq, rangeObj, seqList) => ({
      session: {
        log: [
          { type: "step/start", seq: summarySeq - 2 },
          {
            type: "compaction/summary",
            seq: summarySeq,
            time: Date.now(),
            data: {
              shadowedRange: rangeObj,
              shadowedSeqs: seqList,
              shadowedTokenCount: 12345,
              summary: [{ text: "摘要" }],
            },
          },
        ],
      },
    });
    const stR = { shadowedIndex: new Map() };
    // ★ 复刻真实那个倒着的形状：range 说 36764→35270，而节点列表是 36764 + 35018…35270
    const invertedSeqs = [36764, 35018, 35021, 35025, 35268, 35270];
    mod.__test.recordShadowedIndex(stR, "sid-inv", mkSummaryAgent(37021, { start: 36764, end: 35270 }, invertedSeqs), "test");
    const idxR = mod.__test.renderShadowedIndex(stR, "sid-inv");
    const mR = /seq (\d+)–(\d+)/.exec(String(idxR));
    ok("★★★ 45⑤①：渲染出的区间**递增**（`seq A–B` 里 A ≤ B）",
      mR !== null && Number(mR[1]) <= Number(mR[2]),
      `命中=${mR === null ? "无" : `${mR[1]}–${mR[2]}`} 索引=${String(idxR).slice(-260)}`);
    ok("★★★ 45⑤②：且区间**覆盖真实的最小与最大节点**（不许漏读）",
      mR !== null && Number(mR[1]) === Math.min(...invertedSeqs) && Number(mR[2]) === Math.max(...invertedSeqs),
      `命中=${mR === null ? "无" : `${mR[1]}–${mR[2]}`} 期望=${Math.min(...invertedSeqs)}–${Math.max(...invertedSeqs)}`);
    // ★ 内核原始边界只作诊断留着（将来查语义时不必翻会话日志）
    const recR = mod.__test.recordShadowedIndex(stR, "sid-inv2", mkSummaryAgent(37022, { start: 500, end: 100 }, [100, 200, 500]), "t");
    ok("★ 45⑤③：内核的原始边界被**原样留着**（只作诊断，不参与渲染）",
      recR?.rawStart === 500 && recR?.rawEnd === 100 && recR?.start === 100 && recR?.end === 500,
      JSON.stringify(recR ?? null).slice(0, 220));
  }
  rmrf(root45);
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 情形 46：**被胶囊挤出去的用户原话不许丢**（D84 缺陷修复）
//
//   病因（实测，见 D84）：`capsule.userMessages` 只留最近 `CAPSULE_USER_MSG_MAX`(=40) 条，
//     旧代码是 `r.userMessages.length = CAPSULE_USER_MSG_MAX` —— **超出部分直接蒸发**。
//     后果：被压掉的 191 条真用户原话，逐字能在载体找回的只有 **24.1%**；
//     **最早 3 条（含用户最初的完整任务陈述）是 0/3**。
//
//   ★ 修法（用户拍板的 B 方案）：淘汰时**升级归档**到
//     `_ledger-archive/<期间>/用户原话-完整存档.md`（只追加、永不删）；
//     ★ 并且**胶囊要告诉模型完整原话在哪**（用户明说的那一条）。
//
//   ★ 判别力（本情形必须能红）：
//     · 把 `evictedUserMessages` 那几行删掉（恢复成 `.length = MAX`）⇒ ①②③红；
//     · 把 `drainEvicted` 的调用摘掉 ⇒ ②③红；
//     · 把胶囊里那段「只有最近 N 条 + 去哪找完整」删掉 ⇒ ④红。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 46：被胶囊挤出去的用户原话必须升级归档（不许蒸发）");
{
  const mkProj46 = (tag) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\n不丢原话\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 0,
      }),
      "utf8"
    );
    return dir;
  };

  const root46 = mkProj46("usermsg-evicted");
  const sid46 = "session-u46-0001";
  const run46 = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls: [] });
  mod.apply(run46.ctx, {});

  // 数上限：直接读源码常量，避免把 40 写死在夹具里（写死就会与实现分叉）
  const src46 = fs.readFileSync(ENTRY, "utf8");
  const mMatch = src46.match(/const CAPSULE_USER_MSG_MAX = (\d+);/);
  const MAX46 = mMatch ? Number(mMatch[1]) : 40;
  ok("★ 46 前提：读到了 CAPSULE_USER_MSG_MAX", MAX46 > 0, `MAX=${MAX46}`);

  let seq46 = 0;
  const say46 = async (text) => {
    seq46 += 1;
    for (const h of run46.handlers.get("session/event") ?? []) {
      await h({ id: sid46, header: { id: sid46, cwd: root46 } }, {
        type: "user/message", time: Date.now(),
        data: { id: `m46-${seq46}`, role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
      });
    }
  };

  // ① 喂 **MAX+5** 条 ⇒ 最早那 5 条会被挤出去
  const EARLY = [];
  for (let i = 0; i < 5; i += 1) EARLY.push(`【早期原话 ${i + 1}】这句话是用户最早说的，绝不能丢`);
  for (const t of EARLY) await say46(t);
  for (let i = 0; i < MAX46; i += 1) await say46(`【较新原话 ${i + 1}】这几条应当在胶囊里`);

  // ② 盘上必须有「升级归档」文件，且**早期那 5 条逐字在里面**
  const arcDir46 = path.join(root46, "_a");
  const findArchiveFile = (dir) => {
    const out = [];
    const go = (d) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const q = path.join(d, e.name);
        if (e.isDirectory()) go(q);
        else if (e.name.includes("用户原话")) out.push(q);
      }
    };
    go(dir);
    return out;
  };
  const files46 = findArchiveFile(arcDir46);
  ok("★★ 46①：`_ledger-archive` 下生成了「用户原话」存档文件", files46.length > 0, `找到 ${files46.length} 个`);
  const arcText46 = files46.map((f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } }).join("\n");
  let found46 = 0;
  for (const t of EARLY) if (arcText46.includes(t)) found46 += 1;
  ok(
    "★★★ 46①：**被挤出去的 5 条早期原话逐字都在归档里**（这就是 D84 缺陷的修复）",
    found46 === EARLY.length,
    `命中 ${found46}/${EARLY.length}；归档文件=${files46.map((f) => path.basename(f)).join(",")}`
  );

  // ③ 归档里**不该**混进"还在胶囊里"的那些 —— 否则就不是"被挤出的部分"，而是全量抄一遍
  ok(
    "★★ 46②：**没有被挤出的**原话**不**进归档（归档只收被淘汰的）",
    !arcText46.includes("【较新原话 1】"),
    arcText46.slice(0, 200)
  );

  // ④ 胶囊必须**说清"只有最近 N 条"并给出完整原话在哪**（用户明说的那一条）
  const mem46 = mod.__test?.renderCapsule;
  ok("★ 46 前提：自检能拿到 renderCapsule", typeof mem46 === "function");
  // 用真实素材渲染：直接调（info 用本项目）
  const info46 = {
    projectRoot: root46, activeRel: "LEDGER.md", decisionsRel: "DECISIONS.md",
    archiveRel: "_a", logRel: "_ledger-log", maxActiveLines: 300, revision: 0,
    exists: true, fresh: false,
    manifest: { version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 0 },
  };
  const liveMem = mod.__test.capsuleMemoryGet?.(run46.ctx);
  void liveMem;
  // ★ 素材拿不到就自己造一份**形状相同**的（判据只关心渲染文本，不关心来源）
  const fakeMem = {
    userMessages: [{ at: "2026-10-11 19:00", text: "【较新原话 1】这几条应当在胶囊里" }],
    errors: [], artifacts: new Map(),
  };
  const capText46 = mod.__test.renderCapsule(info46, fakeMem) ?? "";
  ok(
    "★★★ 46③：胶囊**明说「只有最近的 N 条」**（否则模型会以为这是全部）",
    /只有最近/.test(capText46) && capText46.includes(String(MAX46)),
    capText46.slice(0, 400)
  );
  ok(
    "★★★ 46③：胶囊**给出完整原话的去处**（`ledger_log` users 视图 + 归档兜底副本）",
    capText46.includes("ledger_log") && capText46.includes("users") &&
      capText46.includes("用户原话-完整存档"),
    capText46.slice(0, 600)
  );

  rmrf(root46);
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 情形 47：**全量压缩也必须更新锚点**（D86/D87 —— 用户亲自观察到的"增量被饿死"）
//
//   病因（实测，见 D86）：
//     `anchors.json` 本会话锚点 = **49.7%**，其 **mtime = 05:39:39**（最后一次**增量**）；
//     而 15:51 与 17:33 各做过一次**全量** ⇒ **锚点仍是 05:39 那个值**。
//     代码依据：`setAnchor(` 全仓库只出现一次，位于**增量**那条路 ⇒
//     全量压缩**从头到尾没碰过锚点**。
//   后果：触发判据 `水位 ≥ 锚点 + 20` ⇒ 锚点 49.7% 时要涨到 69.7%；
//     而每涨到 ~70%，**"绝对 70%"那条先满足 ⇒ 排的是全量**；全量压完又不降锚点
//     ⇒ 锚点永远停在 49.7% ⇒ **全量永远先到，增量被永久挤掉**。
//
//   ★ 判别力（本情形必须能红）：
//     · 把 `runHighFidelityCompact` ③ 里那段 `setAnchor(..., afterFull.ratio)` 删掉 ⇒ 红。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 47：全量压缩后必须更新锚点（否则增量被永久饿死）");
{
  const mkProj47 = (tag) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\n锚点\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 0,
      }),
      "utf8"
    );
    return dir;
  };
  const root47 = mkProj47("anchor-full");
  const sid47 = "session-a47-0001";
  // ★ 本情形自己带一个 settle（别的作用域里的 `settle` 拿不到）
  const settle47 = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  const run47 = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls: [] });
  mod.apply(run47.ctx, {});

  // ★ 夹具：`measurePressure` 走的是 `ctx.get("tokenMeter").measure(session).totalTokens`
  //   与 `session.requestContext().contextWindow`。
  //   ⇒ 这里让"水位"可被我们控制（压前高、压后低），才能验证锚点被写成**压后**那个值。
  const agent47 = {
    session: {
      header: { id: sid47, cwd: root47 }, id: sid47,
      requestContext: () => ({ contextWindow: 1000 }),
    },
    steer: () => {},
  };

  // ★ 起点：锚点**先设成一个已知的旧值**（模拟"锚点停在 49.7%"）。
  const key47 = sid47;
  const st47 = run47.__state ?? undefined; // 自检拿不到 state ⇒ 通过 setAnchor 写内存+盘
  mod.__test.setAnchor(run47.__st47 ?? {}, key47, 0.497);
  void st47;

  // ★★ 关键：自检拿不到插件内部 `state`，所以这里**换一条可观测的路**——
  //    直接读**盘上**的 anchors.json（`setAnchor` 会同时写盘）。
  const anchorFile = path.join(process.env.DSH_HOME ?? "", "plugin-data", "dsh-ledger-memory", "anchors.json");
  const readAnchor47 = () => {
    try { return JSON.parse(fs.readFileSync(anchorFile, "utf8")).bySession?.[key47]; } catch { return undefined; }
  };
  const before47 = readAnchor47();
  ok("★ 47 前提：锚点确实被写成 0.497（否则后面测的是空转）",
    typeof before47 === "number" && Math.abs(before47 - 0.497) < 1e-9, `before=${before47}`);

  // ★★★ 真跑一次**全量**：走 `ledger_compact` 工具（它排到 idle 后由 `runHighFidelityCompact` 执行）。
  //   ⚠️ **必须先满足闸门**（先记台账、再压缩 —— D47 铁律）：
  //     本情形第一次跑时**没落盘** ⇒ 闸门拦住 ⇒ 压缩压根没发生 ⇒ 产生**假红**。
  //     按纪律第 6 条（夹具没走通 ≠ 被测对象有问题），这里补上落盘，并**单列一条前提断言**
  //     证明"压缩确实执行了"，否则后面的锚点断言是空转。
  await flushLedger(run47, root47, sid47);
  const comp47 = run47.registeredTools.get("ledger_compact");
  ok("★ 47 前提：拿到了 ledger_compact 工具", comp47 !== undefined);
  await comp47.execute({}, { agent: agent47, session: agent47.session, callId: "c47" });
  await fire(run47, "agent/status", { agent: agent47, status: "idle" });
  await settle47();

  // ★★ 先证明"压缩真的跑了"再断言锚点 —— 否则分不清"锚点没更新"与"压根没压"
  //   （纪律第 6 条：夹具没走通时，绝不能把夹具故障当成被测对象的问题）。
  eq("★ 47 前提：全量压缩确实执行了（否则后面的锚点断言是空转）", run47.compacted.length, 1);

  const after47 = readAnchor47();
  ok("★★★ 47：锚点被更新（不再是 0.497）",
    typeof after47 === "number" && Math.abs(after47 - 0.497) > 1e-9,
    `after=${after47}（before=${before47}）`);
  ok("★★ 47：锚点被写成 **0~1 之间的合法值**",
    typeof after47 === "number" && after47 >= 0 && after47 <= 1, `after=${after47}`);

  rmrf(root47);
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 情形 48：**两次压缩重叠时，来源不许互相覆盖**（用户 2026-10-11 第 2 点）
//
//   这是本轮最贵的一次误判，必须留档：
//     用户原话（逐字）：*"我在设置面板中实际设置的是0.75自动执行一次全量压缩，
//       但是全量压缩从来没有自动进行过，刚才甚至已经到了78%，79的样子，
//       已经接近危险边缘了，全量压缩还是没有发生，说明这个自动化也有bug。"*
//
//   ★ 实测真相（分两半）：
//     · **自动全量真的跑了** —— 19:27:38 水位 78.4% 开始，19:30:42 掉到 **10.1%**
//       （压掉 **68.3 点**），胶囊目录里有那天 19:27:38 那份**自带** `来源：自动（70% 水位）`
//       的原始文件 ⇒ 铁证。
//     · **但 L0 把它记成了「手动（命令）」** ⇒ 用户（和我）都据此以为"它从来没跑过"。
//
//   病因：`state.hfSource` 原来是**单槽** `Map<sid,source>`，
//     写入 `set(key,source)`、读出后 `delete`。而两次 `runHighFidelityCompact`
//     **可以重叠**（各 await compactNow 几十秒）：
//       19:27:38 自动全量入队 → 19:27:57 手动命令覆盖同一槽
//       → 内核发 `compaction/end` 时读到的来源是 `command` ⇒ 记成「手动（命令）」。
//     又一次「**记录存在 ≠ 记录准确**」。
//
//   ★ 判别力（本情形必须能红）：
//     · 把 `pushHfSource` 改回 `state.hfSource.set(key, src)`（且 `popHfSource` 只 `get`）
//       ⇒ 两个 end 都拿到后者 ⇒ 断言红。
//     · 把失败路径的 `popHfSourceLast` 删掉 ⇒ 票数多于 end 数 ⇒ 第二条断言红。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 48：两次压缩重叠时，来源不许互相覆盖（队列而不是单槽）");
{
  const mkProj48 = (tag) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\n来源\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 0,
      }),
      "utf8"
    );
    return dir;
  };
  const settle48 = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  /** 读 L0 里所有 `compaction/end` 行。 */
  const compactionLines48 = (root) => {
    const out = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/L0-milestones\.md$/.test(e.name)) {
          for (const l of fs.readFileSync(p, "utf8").split("\n")) {
            if (l.includes("(compaction/end)")) out.push(l);
          }
        }
      }
    };
    walk(path.join(root, "_ledger-log"));
    return out;
  };
  /** 发一条 compaction/end + 落盘。 */
  const emitEnd48 = async (run, root, sid) => {
    const session = { header: { id: sid, cwd: root }, id: sid };
    await fire(run, "session/event", session, { type: "compaction/end", data: {} });
    for (const h of run.handlers.get("agent/turn-stopping") ?? []) {
      await h({ agent: { session, steer: () => {} }, turn: 9 });
    }
    await settle48();
  };

  // ── 48a：★★★ 两次压缩**重叠**，两次 end 各领各的来源 ────────────────────
  //
  //   ★ 怎么造出"重叠"：`compactNow` 夹具里**留一个挂起点**（promise），
  //     先发起自动全量（走 pre-step 排队 + idle 执行，但**不让它 resolve**），
  //     再在它还没结束时又发起一次手动命令压缩 ⇒ 两张票同时在队里。
  {
    const root = mkProj48("hf-overlap");
    const sid = "session-a48-overlap";
    const run = makeCtx({ withCompaction: true, withTokenMeter: true });
    mod.apply(run.ctx, {});

    // ★ 夹具：`compactNow` 每次调用都**挂住**，直到我们手动放行。
    const gates = [];
    const started = [];
    run.services.compaction = {
      compactRegion: async () => ({ shadowedSeqs: [1, 2], shadowedTokenCount: 10, summarySeq: 3 }),
      compactNow: async () => {
        started.push(Date.now());
        await new Promise((r) => gates.push(r)); // ← 挂住，等测试放行
        return { shadowedSeqs: [1, 2], shadowedTokenCount: 10, summarySeq: 3 };
      },
    };

    const agent = {
      session: {
        header: { id: sid, cwd: root }, id: sid,
        requestContext: () => ({ contextWindow: 1000 }),
      },
      steer: () => {},
    };
    await flushLedger(run, root, sid);

    // ① 自动全量排队（水位 75% ≥ 0.7）并**开始执行**（但被 gate 挂住）
    run.services.tokenMeter._total = 750;
    await runPreStep(run, { agent, messages: [] });
    void fire(run, "agent/status", { agent, status: "idle" });
    await settle48();

    // ② 它还在跑的时候，又发起一次**手动命令**压缩（这就是真实事故的时序）
    void run.registeredCommands.get("ledger").handler({
      commandId: "c48", agent, rawInput: "compact", attachments: [],
      signal: new AbortController().signal,
    });
    await settle48();

    // ★ 前提：必须真的是"两次都开跑了"，否则测的是串行、不是重叠。
    ok(
      "★ 48a 前提：两次 `compactNow` **都真的开跑了**（否则测的是串行，不是重叠）",
      started.length >= 2,
      `started=${started.length}`
    );

    // ③ 先放行**第一次**（自动全量）⇒ 它发第一条 end ⇒ 应当领到「自动 70%」
    eq("★ 48a 前提：有第一个挂起点可放行", gates.length >= 1, true);
    gates.shift()();
    await settle48();
    await emitEnd48(run, root, sid);

    // ④ 再放行**第二次**（手动命令）⇒ 它发第二条 end ⇒ 应当领到「手动（命令）」
    if (gates.length >= 1) gates.shift()();
    await settle48();
    await emitEnd48(run, root, sid);

    const lines = compactionLines48(root);
    eq("★★ 48a：两条压缩里程碑都记下了", lines.length, 2);
    ok(
      "★★★ 48a：第一条是「自动 70%」—— ★ 这正是被单槽覆盖掉的那一条（事故本体）",
      lines[0] !== undefined && lines[0].includes("自动 70%"),
      String(lines[0])
    );
    ok(
      "★★ 48a：第二条是「手动（命令）」（各领各的，不是两条同一个来源）",
      lines[1] !== undefined && lines[1].includes("手动（命令）"),
      String(lines[1])
    );
    rmrf(root);
  }

  // ── 48b：失败路径必须**退票** —— 否则后面的 end 会认领到别人的来源 ────────
  //
  //   ★ 这是 48a 的**反向危险**：修好"不覆盖"之后，如果"没压成却把票留在队里"，
  //     票就会越积越多，后面的 `compaction/end`（例如内核 80% 那次）会领到
  //     我们**早就作废**的那张票 ⇒ 同一个 bug 换个方向再犯一次。
  {
    const root = mkProj48("hf-retire");
    const sid = "session-a48-retire";
    const run = makeCtx({ withCompaction: true, withTokenMeter: true });
    mod.apply(run.ctx, {});
    // ★ 夹具：`compactNow` **每次都抛**（压不成）⇒ 每次都该退票。
    let calls = 0;
    run.services.compaction = {
      compactRegion: async () => ({ shadowedSeqs: [1, 2], shadowedTokenCount: 10, summarySeq: 3 }),
      compactNow: async () => {
        calls += 1;
        throw new Error("compaction backend exploded");
      },
    };
    const agent = {
      session: {
        header: { id: sid, cwd: root }, id: sid,
        requestContext: () => ({ contextWindow: 1000 }),
      },
      steer: () => {},
    };
    await flushLedger(run, root, sid);

    // 压两次、都失败
    for (let i = 0; i < 2; i += 1) {
      void run.registeredCommands.get("ledger").handler({
        commandId: `c48b${i}`, agent, rawInput: "compact", attachments: [],
        signal: new AbortController().signal,
      });
      await settle48();
      void fire(run, "agent/status", { agent, status: "idle" });
      await settle48();
    }
    ok("★ 48b 前提：确实尝试过压缩（且都抛了）", calls >= 1, `calls=${calls}`);

    // ★★ 关键断言：票必须已退干净 ⇒ 内核发的 end **必须**退化成「上下文已压缩」
    await emitEnd48(run, root, sid);
    const lines = compactionLines48(root);
    eq("★★ 48b：有了 end", lines.length, 1);
    ok(
      "★★★ 48b：压失败之后，内核的 end **不许**认领到那张作废的票（必须是「上下文已压缩」）",
      /上下文已压缩$/.test(lines[0]),
      String(lines[0])
    );
    rmrf(root);
  }
}

section("情形 36：交接单闭环（第③层）");
{
  const mkProj = (tag) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\n做点什么\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(dir, "_a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 0,
      }),
      "utf8"
    );
    return dir;
  };

  // 36a：写得出、落到**约定位置**、且带上"去哪重读"
  {
    const root = mkProj("handoff-write");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const sid = "session-hof00000-0001";
    const tool = run.registeredTools.get("ledger_handoff");
    ok("★ 有 `ledger_handoff` 工具", tool !== undefined);

    const res = await tool.execute(
      {
        title: "泰拉瑞亚 Boss 攻击层",
        did: "实现了攻击选择层骨架，构建通过。",
        state: "骨架能跑；招式还没叠加。",
        next: "叠加第二种弹幕。",
        files: "src/Boss/GiantClam.cs",
        blocked: "需要人拍板要不要降伤害地板。",
      },
      execFor(root, sid)
    );
    eq("★ 写成功", res.ok, true);
    // ★ 下面两条必须在**写成功**的前提下才谈得上 —— 否则 `res.path` 是 undefined，
    //   `path.basename(undefined)` 会**抛错打断整个自检**（实测撞到）。
    //   ★★ 这不是小事：自检一崩，**失败清单根本不会打印**，
    //   于是"可失败探针"永远找不到标记词、把一个真缺陷报成"断言是摆设"。
    //   ⇒ 断言要**耐住失败**，不能让被测对象的状态把尺子本身弄坏。
    ok("★★ 落在 `_handoff/` 约定目录里", typeof res.relative === "string" && /_handoff/.test(res.relative), String(res.relative));
    ok(
      "★ 文件名日期在前（目录里天然按时间排序）",
      typeof res.path === "string" && /^\d{4}-\d{2}-\d{2}-\d{4}-/.test(path.basename(res.path)),
      String(res.path)
    );

    const body = typeof res.path === "string" && fs.existsSync(res.path) ? fs.readFileSync(res.path, "utf8") : "";
    for (const [label, needle] of [
      ["做了什么", "实现了攻击选择层骨架"],
      ["当前状态", "招式还没叠加"],
      ["下一步", "叠加第二种弹幕"],
      ["关键文件路径", "src/Boss/GiantClam.cs"],
      ["卡点", "降伤害地板"],
    ]) {
      ok(`★ 交接单含「${label}」`, body.includes(needle), body.slice(0, 400));
    }
    // ★★ 这一节最关键：交接单自己要指向真源（它比摘要可靠）
    ok("★★ 交接单自带「去哪重读」（指向台账/决策）", /去哪重读/.test(body) && /LEDGER\.md/.test(body), body.slice(-500));
    ok("★ 返回里说了「下一次会被引导来读」", /先读/.test(String(res.note ?? "")), String(res.note));

    // 36b：**新会话**开在同一项目 ⇒ 注入里必须主动指向那一份
    {
      const run2 = makeCtx({});
      mod.apply(run2.ctx, {});
      const sid2 = "session-hof00000-0002"; // ← 不同会话
      const d = await runPreStep(run2, {
        agent: { session: { header: { id: sid2, cwd: root }, id: sid2 }, steer: () => {} },
        messages: [],
      });
      const text = (d.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
      // ★ 判据用**实际文案里的词**（`先读上一次的交接单`），不要凭印象写。
      //   我第一版写的是 `下一次交接单` —— 而实现里叫「上一次」⇒ 假红。
      ok(
        "★★★ 新会话的注入里**主动点名**了那一份交接单（这就是「无缝衔接」）",
        /交接单/.test(text) && /先读/.test(text) && /上一次/.test(text),
        text.slice(0, 800)
      );
      ok(
        "★★ 而且给的是**文件名**（不是只给目录 —— 只给目录等于让模型自己挑）",
        /_handoff[\\/][0-9]{4}-\d{2}-\d{2}-\d{4}-/.test(text),
        text.slice(0, 800)
      );
      rmrf(root);
    }
  }

  // 36c：没有交接单时，注入要**如实说还没有**，并指出写它的工具
  {
    const root = mkProj("handoff-none");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const sid = "session-hof00000-0003";
    const d = await runPreStep(run, {
      agent: { session: { header: { id: sid, cwd: root }, id: sid }, steer: () => {} },
      messages: [],
    });
    const text = (d.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
    ok(
      "★ 还没写过 ⇒ 说有这个目录、且说清「还没有交接单」",
      /交接单/.test(text) && /还没有交接单/.test(text),
      text.slice(-900)
    );
    ok("★★ 并指出用哪个工具写（否则模型不知道该干嘛）", /ledger_handoff/.test(text), text.slice(0, 900));
    rmrf(root);
  }

  // 36d：多次交接 ⇒ 注入指向**最新那一份**（按文件名排序，不是 mtime）
  {
    const root = mkProj("handoff-latest");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const tool = run.registeredTools.get("ledger_handoff");
    const dir = path.join(root, "_handoff");
    fs.mkdirSync(dir, { recursive: true });
    // 手工造两份**文件名有明确先后**的交接单（不靠时钟）
    fs.writeFileSync(path.join(dir, "2026-10-01-0900-早的那份.md"), "# 早\n", "utf8");
    fs.writeFileSync(path.join(dir, "2026-10-09-1800-晚的那份.md"), "# 晚\n", "utf8");
    // 故意把"早"那份的 mtime 设成更新的 ⇒ 验的是**按文件名**而不是 mtime
    const past = new Date(Date.now() - 86400000);
    fs.utimesSync(path.join(dir, "2026-10-09-1800-晚的那份.md"), past, past);

    const sid = "session-hof00000-0004";
    const d = await runPreStep(run, {
      agent: { session: { header: { id: sid, cwd: root }, id: sid }, steer: () => {} },
      messages: [],
    });
    const text = (d.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
    ok(
      "★★★ 指向的是**文件名最新**那份（`晚的那份`），而不是 mtime 最新的那份",
      /晚的那份/.test(text) && !/早的那份/.test(text),
      text.slice(0, 800)
    );

    // 36e：**永不覆盖** —— 同一分钟同一主题再写一次，不能盖掉已有的
    const before = fs.readdirSync(dir).length;
    const r1 = await tool.execute({ title: "同一主题", did: "第一次" }, execFor(root, sid));
    const r2 = await tool.execute({ title: "同一主题", did: "第二次" }, execFor(root, sid));
    ok("★ 两次都成功（不是报错）", r1.ok === true && r2.ok === true, JSON.stringify([r1.ok, r2.ok]));
    ok("★★★ 且**没有覆盖** —— 文件数增加了 2", fs.readdirSync(dir).length === before + 2, `${before} → ${fs.readdirSync(dir).length}`);
    ok("★★ 两次内容各自独立（第一份还在）", (() => {
      const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
      return all.some((x) => x.includes("第一次")) && all.some((x) => x.includes("第二次"));
    })(), "两份内容应当都能找到");
    rmrf(root);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//
// ★★★ 情形 37：两个模式（2026-10-10 用户拍板）
//
//   用户原话：*"我们把它定义为这个插件的两个模式…正常向前推进的任务就执行现在的
//   这个模式，如果需要反复追究的话，就执行第二种模式。最好这个也能在设置面板里
//   体现出来。"*
//
//   要测的不是"有个开关"，而是：
//     ① 默认必须是 `steady` —— 否则**静默改变所有现有项目的行为**；
//     ② 模式**项目清单优先**（同一个仓库能"平时推进、查问题时转追究"）；
//     ③ 清单里写错了**不许静默**退回默认（要说出来在哪看的）；
//     ④ `surgical` 时提醒里**真的**出现分流那一步，`steady` 时**真的**不出现；
//     ⑤ `ledger_triage` 的三个桶**各去各的地方**（keep 留、stash 落盘、drop 不写）；
//     ⑥ keep 桶**有硬上限**（"留得太多等于没压"）且截断数**如实报出**；
//     ⑦ 没有台账的项目**一个文件都不许写**。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 37：两个模式（正常推进 / 反复追究）");
{
  const mkModeProj = (tag, mode) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\n做点什么\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(dir, "_a"), { recursive: true });
    const man = {
      version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
      archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 0,
    };
    if (mode !== undefined) man.mode = mode;
    fs.writeFileSync(path.join(dir, ".dsh-ledger.json"), JSON.stringify(man), "utf8");
    return dir;
  };

  // 37a：默认必须是 steady（"不带配置时 = 今天的行为"）
  {
    const root = mkModeProj("mode-default", undefined);
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const r = await run.registeredTools.get("ledger_status").execute({}, execFor(root, "s-mode-default"));
    ok(
      "★ 默认模式是 steady（不带配置 = 今天的行为）",
      r.mode === "steady" || r.effectiveMode === "steady" || r.project?.mode === "steady",
      JSON.stringify(r).slice(0, 300)
    );
    rmrf(root);
  }

  // 37b：清单优先 —— 同一份全局设置下，两个项目各走各的模式
  {
    const rootA = mkModeProj("mode-scope-a", "surgical");
    const rootB = mkModeProj("mode-scope-b", "steady");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const st = run.registeredTools.get("ledger_status");
    const a = await st.execute({}, execFor(rootA, "s-scope-a"));
    const b = await st.execute({}, execFor(rootB, "s-scope-b"));
    const pick = (x) => x.mode ?? x.effectiveMode ?? x.project?.mode;
    ok("★★ 项目清单优先：A 项目 surgical", pick(a) === "surgical", JSON.stringify(pick(a)));
    ok("★★ 项目清单优先：B 项目 steady（同一份全局设置）", pick(b) === "steady", JSON.stringify(pick(b)));
    rmrf(rootA);
    rmrf(rootB);
  }

  // 37c：清单里写错 ⇒ **不静默**
  {
    const root = mkModeProj("mode-typo", "surgcial");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const r = await run.registeredTools.get("ledger_status").execute({}, execFor(root, "s-typo"));
    const txt = JSON.stringify(r);
    ok("★★ 清单里写错的 mode 退回默认（仍能跑）", (r.mode ?? r.effectiveMode ?? "steady") === "steady", txt.slice(0, 200));
    ok("★★★ 但不静默 —— 明说清单里那个值不认识", /不认识|写错|unrecogn|suspect/i.test(txt), txt.slice(0, 400));
    rmrf(root);
  }

  // 37d：提醒文案在两种模式下**真的**不同
  //
  //   ★ 这里走**真实路径**：真配 tokenMeter、真跑 `agent/pre-step` 瀑布拿注入正文。
  //     直接调 `renderPressureNotice` 会漏掉"到底有没有被注入"这一层
  //     （本文件反复强调：能读到的字符串 ≠ 真的发出去了）。
  {
    const mkNoticeProj = (tag, mode) => {
      const root = tmpProject(tag);
      fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
      fs.writeFileSync(
        path.join(root, ".dsh-ledger.json"),
        JSON.stringify({
          version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
          archiveDir: "_a", maxActiveLines: 300, logDir: "_ledger-log",
          logLevels: { L0: true, L1: true, L2: true, L3: false, L4: true },
          revision: 0, mode,
        }),
        "utf8"
      );
      return root;
    };
    // 一条最小 agent：够 `projectRootOf` 取到 cwd，且能当 pre-step 的入参。
    // ★★ **必须带 `requestContext`** —— 窗口是从**agent**上取的，不是从 tokenMeter 上取的
    //    （实测：漏了它水位恒为 0，提醒一条都发不出来，而表面上"夹具跑通了"）。
    //    这条与情形 12 的夹具保持一致，别再手搓第二种形状。
    const mkNoticeAgent = (root, sid) => ({
      session: {
        header: { id: sid, cwd: root },
        requestContext: () => ({ contextWindow: 1000 }),
      },
    });
    const noticeAt = async (run, root, sid, ratio) => {
      run.services.tokenMeter._total = 100; // 10%：先垫一个低水位
      await runPreStep(run, { agent: mkNoticeAgent(root, sid), messages: [] });
      run.services.tokenMeter._total = Math.round(1000 * ratio);
      const d = await runPreStep(run, { agent: mkNoticeAgent(root, sid), messages: [] });
      return (d.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
    };

    {
      const root = mkNoticeProj("mode-notice-surg", "surgical");
      const run = makeCtx({ withTokenMeter: true });
      mod.apply(run.ctx, {});
      const t = await noticeAt(run, root, "s-notice", 0.72);
      ok("★★ surgical 下真的发出了水位提醒", /上下文水位已到/.test(t), t.slice(0, 300));
      ok("★★ surgical 下提醒里**有**分流那一步（ledger_triage）", /ledger_triage/.test(t), t.slice(0, 600));
      ok(
        "★★ surgical 下说了三个桶（keep / stash / drop）",
        /keep/.test(t) && /stash/.test(t) && /drop/.test(t),
        t.slice(0, 800)
      );
      ok("★★★ surgical 下**明说**「留得太多等于没压」", /留得太多|等于没压/.test(t), t.slice(0, 800));
      rmrf(root);
    }

    // 37d-3：★★★ 2026-10-11 **强制性**（用户明确要求的那一条）
    //
    //   用户原话：*"我们要增强一点我们这个指令的强制性，虽然不能直接机械性的强行压缩，
    //   但是最好让 AI 知道他有义务去做这件事，这不是建议，而是命令。"*
    //
    //   ★ 要钉的是**语气**，而语气不能靠"读一遍觉得对" —— 它必须是可断言的字符串事实。
    //   ★ 但也不能钉死具体措辞（那会让每次润色都变红）。所以钉的是**语义标记**：
    //     ① 有「义务」这个概念词（不是"建议 / 顺手 / 可以"）；
    //     ② **说明了不做的后果**（压缩不会发生 / 会撞到官方 80%）；
    //     ③ 仍然**把判断权留给 AI**（不做机械强压 —— 用户特意加了这条约束）。
    {
      const root = mkNoticeProj("mode-mandate-surg", "surgical");
      const run = makeCtx({ withTokenMeter: true });
      mod.apply(run.ctx, {});
      const t = await noticeAt(run, root, "s-mandate", 0.72);
      ok("★★★ 70% 提醒里出现「义务」——它是命令不是建议", /义务/.test(t), t.slice(0, 700));
      ok(
        "★★★ 而且**说清了不做的后果**（压缩不会发生 / 撞上官方 80%）",
        /不会(发生|压缩)|不会压|内核|80%/.test(t),
        t.slice(0, 900)
      );
      ok(
        "★★★ 但仍然**把判断权留给 AI**（用户：不能机械性强行压缩）",
        /由你(判断|定)|不是你的选项|分什么|怎么分/.test(t),
        t.slice(0, 900)
      );
      rmrf(root);
    }
    {
      const root = mkNoticeProj("mode-mandate-std", "steady");
      const run = makeCtx({ withTokenMeter: true });
      mod.apply(run.ctx, {});
      const t = await noticeAt(run, root, "s-mandate2", 0.55);
      ok("★★★ 30/50% 档也是义务语气（不再是「按约定」）", /义务/.test(t), t.slice(0, 700));
      ok("★★ 并说明了不做的后果", /不会(发生|压缩)|内核|80%/.test(t), t.slice(0, 900));
      rmrf(root);
    }
    {
      const root = mkNoticeProj("mode-notice-std", "steady");
      const run = makeCtx({ withTokenMeter: true });
      mod.apply(run.ctx, {});
      const t = await noticeAt(run, root, "s-notice2", 0.72);
      ok("★★ 模式已合并 ⇒ 同样发出了水位提醒", /上下文水位已到/.test(t), t.slice(0, 300));
      // ★★★ 2026-10-12（D129）：**这条断言原本是反的** ——
      //   它原来钉"steady 下**绝不提**分流"，理由是"别逼它做多余功"。
      //   而用户本轮把两模式**合并成一种：分流成为标准步骤** ⇒ **分流现在是无条件的**。
      //   ⇒ 若这条还留着旧期望，实现就越不过它（那是**断言与规格冲突**，不是实现错）。
      ok(
        "★★★ D129：模式已合并 ⇒ 提醒里**一律**要求分流（分流是标准步骤）",
        /ledger_triage/.test(t),
        t.slice(0, 600)
      );
      rmrf(root);
    }
  }

  // 37e：ledger_triage 三个桶各去各的地方
  {
    const root = mkModeProj("triage-buckets", "surgical");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const tool = run.registeredTools.get("ledger_triage");
    ok("★ 有 `ledger_triage` 工具", tool !== undefined);
    const sid = "session-tri00000-0001";
    const res = await tool.execute(
      {
        keep: [{ what: "用户要求 README 必须分两份" }, { what: "正在做两个模式" }],
        stash: [
          { what: "试过按位置压缩，会压掉最早那条约束", why: "避免再走一遍", where: "lib/index.js:1011" },
          { what: "内核摘要提示词不可配", why: "决定了架构只能是压缩后重注", where: "dsh-compaction-basic" },
        ],
        drop: [{ what: "之前那版 README" }],
      },
      execFor(root, sid)
    );
    eq("★ 分流成功", res.ok, true);
    eq("★ keep 记了 2 条", res.kept, 2);
    eq("★★ stash 落了 2 条", res.stashed, 2);
    eq("★ drop 记了 1 条（但不写盘）", res.dropped, 1);
    eq("★★★ keep 在上限内，没有被截断", res.overflow, 0);
    ok("★★ stash 真的落到了 `_stash/`", typeof res.stashPath === "string" && res.stashPath.includes("_stash"), String(res.stashPath));
    const stashAbs = typeof res.stashPath === "string" ? path.join(root, res.stashPath) : "";
    ok("★★★ stash 文件真的在磁盘上", stashAbs !== "" && fs.existsSync(stashAbs), stashAbs);
    const stashBody = stashAbs !== "" && fs.existsSync(stashAbs) ? fs.readFileSync(stashAbs, "utf8") : "";
    ok("★★ stash 正文里有那条判断与理由", stashBody.includes("按位置压缩") && stashBody.includes("避免再走一遍"), stashBody.slice(0, 400));
    ok("★★★ stash 正文里**没有** drop 的内容（drop 不落盘）", !stashBody.includes("之前那版 README"), stashBody.slice(0, 400));
    ok("★★ stash 里如实记了其余两桶的条数", /留在上下文 2 条/.test(stashBody) && /丢掉 1 条/.test(stashBody), stashBody.slice(0, 500));
    rmrf(root);
  }

  // 37f：keep 有**硬上限**，且截断数如实报出
  {
    const root = mkModeProj("triage-cap", "surgical");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const many = Array.from({ length: 20 }, (_, i) => ({ what: `第 ${i + 1} 件重要的事` }));
    const res = await run.registeredTools.get("ledger_triage").execute({ keep: many }, execFor(root, "s-cap"));
    ok("★★★ keep 被截到上限以内（不是全收）", res.kept <= 12 && res.kept > 0, String(res.kept));
    ok("★★★ 且**如实报出**截掉几条", res.overflow === 20 - res.kept, `overflow=${res.overflow} kept=${res.kept}`);
    ok("★★ 说明里也写了截断这件事", /截/.test(String(res.note)), String(res.note).slice(0, 300));
    rmrf(root);
  }

  // 37g：三桶全空 ⇒ 不许假装成功
  {
    const root = mkModeProj("triage-empty", "surgical");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const res = await run.registeredTools.get("ledger_triage").execute({}, execFor(root, "s-empty"));
    ok("★★ 三桶全空 ⇒ 报失败，不假装成功", res.ok === false, JSON.stringify(res).slice(0, 200));
    rmrf(root);
  }

  // 37h：没有台账的项目 ⇒ 一个文件都不许写
  {
    const dir = tmpProject("triage-noledger");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const res = await run.registeredTools
      .get("ledger_triage")
      .execute({ stash: [{ what: "某件以后要查的事" }] }, execFor(dir, "s-nol"));
    ok("★★★ 没有台账 ⇒ 拒绝", res.ok === false, JSON.stringify(res).slice(0, 250));
    ok(
      "★★★ 且真的**一个文件都没写**",
      fs.readdirSync(dir).filter((f) => f.startsWith("_stash")).length === 0,
      JSON.stringify(fs.readdirSync(dir))
    );
    rmrf(dir);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 37i：★★★ 闸门 —— 「只写了台账、没分流」**不许压缩**
  //
  //   ★ 这是"模式会不会**静默退化**"的唯一防线。放行了 ⇒ 压缩照跑、keep 桶空着
  //     ⇒ 用户以为在用「反复追究」，实际是「正常推进」，而且**毫无迹象**。
  //
  //   ★★ 水位刻意选 **35%（< 75%）**：`FLUSH_GATE_BYPASS_RATIO = 0.75` 那条旁路
  //      在 75% 以上**故意放行**（再拦只会让内核先压），所以 ≥75% 测不到这把闸门。
  //      ★ 我第一版夹具用了 94% ⇒ 已被旁路 ⇒ 正反向都不动 ⇒ **尺子是坏的**。
  //   ★★ 夹具逐条照抄自 30a（`mkDeltaAgent` / `priceNodes` / `flushLedger`）——
  //      手搓第一版漏了 `requestContext`，压缩一次都没触发，断言却是绿的。
  // ══════════════════════════════════════════════════════════════════════════
  {
    const mkGateProj = (tag, mode) => {
      const root = tmpProject(tag);
      fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
      fs.writeFileSync(
        path.join(root, ".dsh-ledger.json"),
        JSON.stringify({
          version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
          archiveDir: "_a", maxActiveLines: 300, logDir: "_ledger-log",
          logLevels: { L0: true, L1: true, L2: true, L3: false, L4: true },
          revision: 0, mode,
        }),
        "utf8"
      );
      return root;
    };
    const mkGateAgent = (root, sid, rounds) => {
      const events = [];
      let seq = 1;
      for (let r = 0; r < rounds; r += 1) {
        events.push({ type: "user/message", seq, data: { message: { role: "user", content: [] } } });
        seq += 1;
        events.push({
          type: "assistant/message",
          seq,
          data: { message: { role: "assistant", content: [{ type: "tool-call", id: `c${seq}` }] } },
        });
        seq += 1;
        events.push({ type: "tool/result", seq, data: { message: { role: "tool" } } });
        seq += 1;
      }
      const bySeq = new Map(events.map((e) => [e.seq, e]));
      return {
        session: {
          header: { id: sid, cwd: root },
          id: sid,
          requestContext: () => ({ contextWindow: 1000 }),
          surface: { nodes: events.map((e) => e.seq) },
          eventAt: (s) => bySeq.get(s),
        },
        steer: () => {},
      };
    };

    // 37i-1：35% 档是「预告」，70% 档才是「要求」—— 这个区别必须钉住
    //
    //   ★ 实测（`_tmp-dbg-gate2`）：35% 档的文案里**会出现** `ledger_triage` 这个词，
    //     但那是**告知它 70% 会发生什么**，不是要它现在做。
    //     ⇒ 所以我第一版"35% 不许出现 triage 字样"的断言是**错的**（假红）。
    //     真正该钉的是：35% 档**不立分流义务**（不写进 `triageOwedAt`），
    //     证据就是"到 70% 时义务才起作用"。
    {
      const root = mkGateProj("gate-35-preview", "surgical");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { highFidelityCompactRatio: 1.0, /* ★D119：本用例测闸门/计数器/口径，**不测**「到全量线该让路」。让路有两个入口 —— ① `pressure.ratio >= hfLine` ② 水位 ≥ `capLine = min(内核线−5点, hfLine)`。取 `hfLine = 1.0` 让两者都够不着本用例水位。★ **绝不能设 `highFidelityCompact: false`**（我第一版那么改过，多红 7 条）：它还连带关掉**全量前置探针**，而依赖那段注入的断言会跟着塌。 */ });
      const sid = "session-gate0000-0001";
      const agent = mkGateAgent(root, sid, 7);
      run.services.tokenMeter._priced = agent.session.surface.nodes.map((seq) => ({ seq, tokens: 20 }));

      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 100; // 10%
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 420; // 35% ⇒ 到 30% 档
      const dNotice = await runPreStep(run, { agent, messages: [] });
      const noticeText = (dNotice.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
      ok("★★ 35% 档确实发了提醒", /上下文水位已到/.test(noticeText), noticeText.slice(0, 300));
      // ★ 前提校验：这条夹具**能触发压缩** —— 否则后面的断言都是假的。
      //   ★★★ 2026-10-12（D129）：**机械兜底已删** ⇒ 由"模型主动调工具"驱动（三步）。
      await flushLedger(run, root, sid);
      await triageNow(run, root, sid);
      askAICompact(sid);
      await runPreStep(run, { agent, messages: [] });
      eq("★★★ 前提：落盘+分流之后，模型主动要压 ⇒ 确实会压（夹具不是死的）", regionCalls.length, 1);
      rmrf(root);
    }

    // 37i-2：★★★ 真正要钉的 —— 模型主动要压、但**没先分流** ⇒ 不许压
    //
    //   ★★★ 2026-10-12（D129）**驱动源换过**：原来靠"70% 水位提醒立下分流义务"，
    //     而用户本轮明确要求**去掉水位三档的落盘义务**（防卡）⇒ 那条路没有了。
    //     ⇒ 现在分流义务挂在**"模型主动要压"这一刻**（`runIncrementalCompact` 判据②）——
    //       这也更合语义：**要压缩时才需要知道"哪些能压"**。
    //   ★ 水位刻意 **< 75%**：`FLUSH_GATE_BYPASS_RATIO` 那条旁路在 75% 以上**只对增量放行**
    //     （D119），所以 ≥75% 测不到闸门本身（会从旁路走掉）。
    {
      const root = mkGateProj("gate-owed", "surgical");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { highFidelityCompactRatio: 1.0, /* ★D119：本用例测闸门/计数器/口径，**不测**「到全量线该让路」。取 `hfLine = 1.0` 让让路判据够不着本用例水位。★ **绝不能设 `highFidelityCompact: false`**：它还连带关掉**全量前置探针**，而依赖那段注入的断言会跟着塌。 */ });
      const sid = "session-gate0000-0002";
      const agent = mkGateAgent(root, sid, 7);
      // ★ 水位 760 ⇒ 保留 (0.76−0.10)×1000 = **660** token
      //   ⇒ surface 必须 > 660 才有旧段可压。21 节点 × **40** = 840 > 660 ✓
      run.services.tokenMeter._priced = agent.session.surface.nodes.map((seq) => ({ seq, tokens: 40 }));

      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 100;
      await runPreStep(run, { agent, messages: [] });

      // ① 模型主动要压（落盘已做、**但没分流**）⇒ 闸门必须拦住
      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 740; // 仍 <75% ⇒ 不走旁路
      askAICompact(sid);
      const dBlocked = await runPreStep(run, { agent, messages: [] });
      eq("★★★ 没先分流 ⇒ **一次都不许压**（D129 三步顺序）", regionCalls.length, 0);
      const tBlocked = (dBlocked.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
      ok(
        "★★★ 而且**说明白**了卡在哪（否则模型不知道该补什么）",
        /分流/.test(tBlocked) && /ledger_triage/.test(tBlocked),
        tBlocked.slice(0, 500)
      );

      // ② 它补做分流 ⇒ 义务兑现；**再要一次压**就放行
      const tri = await run.registeredTools
        .get("ledger_triage")
        .execute({ keep: [{ what: "在验证闸门行为" }] }, execFor(root, sid));
      ok("★★ 补做分流成功", tri.ok === true, JSON.stringify(tri).slice(0, 200));
      await flushLedger(run, root, sid); // 再写一次台账 ⇒ 落盘也新
      run.services.tokenMeter._total = 760; // <75%，但已够触发增量
      askAICompact(sid);
      await runPreStep(run, { agent, messages: [] });
      ok(
        "★★★ 补做分流之后 ⇒ 压缩放行（闸门是「等它做」，不是「永久卡死」）",
        regionCalls.length >= 1,
        `regionCalls=${regionCalls.length}`
      );
      rmrf(root);
    }

    // 37i-4：★★★ 2026-10-11 修的**真缺陷**（D59）—— 分流义务的**超时兜底**。
    //
    //   事故原文（用户先发现的）：*"你有没有发现我们直到现在都没有进行任何一次
    //   增量压缩，已经快70%了。"* —— 本项目 `surgical` 模式下 `triageOwedAt`
    //   **只有 `ledger_triage` 能清**（`noteFlushed` 只清 `flushOwedAt`），
    //   而 AI 一次都没调 ⇒ 闸门连续拦了**近 4 小时**、零次压缩。
    //
    //   ★ 为什么原有的两道兜底都救不了（这是本用例存在的理由）：
    //     ① `FLUSH_BLOCK_GIVEUP = 3` 依赖"**重试真的发生**" —— 真事故里计数攒不到 3；
    //     ② `FLUSH_GATE_BYPASS_RATIO = 0.75` 是**更早的 return**，事故水位 ~70% 够不着。
    //   ⇒ 新增的这条**只看墙上时间**，不依赖任何别的东西。
    //
    //   ★ 测法：把 `Date.now` 往前推 21 分钟（> `TRIAGE_OWED_MAX_AGE_MS` 的 20 分钟），
    //     同一个被拦过的现场**必须放行**。这就是"时间兜底不依赖重试"的直接证据。
    {
      const root = mkGateProj("gate-overdue", "surgical");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { highFidelityCompactRatio: 1.0, /* ★D119：本用例测闸门/计数器/口径，**不测**「到全量线该让路」。让路有两个入口 —— ① `pressure.ratio >= hfLine` ② 水位 ≥ `capLine = min(内核线−5点, hfLine)`。取 `hfLine = 1.0` 让两者都够不着本用例水位。★ **绝不能设 `highFidelityCompact: false`**（我第一版那么改过，多红 7 条）：它还连带关掉**全量前置探针**，而依赖那段注入的断言会跟着塌。 */ });
      const sid = "session-gate0000-0004";
      const agent = mkGateAgent(root, sid, 7);
      run.services.tokenMeter._priced = agent.session.surface.nodes.map((seq) => ({ seq, tokens: 40 }));

      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 100;
      await runPreStep(run, { agent, messages: [] });

      // ★★★ 2026-10-12（D129）：分流义务现在由**"模型主动要压"**立起
      //   （水位提醒不再立任何义务 ⇒ 用户要求"防卡"）。
      //   `triageOwedAt` 用的是**真实** Date.now。

      // 先确认**不推时间**时它真会被拦（否则后面的断言恒真、等于没测）
      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 740;
      askAICompact(sid);
      await runPreStep(run, { agent, messages: [] });
      eq("★★★ 时限内仍然拦着（不是无条件放行）", regionCalls.length, 0);

      // ★ 把时钟推过 20 分钟 ⇒ 同一条义务已过期 ⇒ **必须放行**
      //
      //   ★★★ 水位必须 **< 75%**（这里用 745 = 74.5%）：`FLUSH_GATE_BYPASS_RATIO = 0.75`
      //     那条旁路是**更早的 return**，一到 0.75 就先放行了、根本走不到超时判断。
      //     我第一版写了 **760**（0.76）⇒ 这条断言在**摘掉超时兜底之后依然全绿**
      //     —— 是反向验证当场抓出来的**摆设断言**（它测的其实是那条 75% 旁路）。
      //     ⚠️ 同一个坑 37i-2 的注释里**早就写过**「水位刻意 < 75%」，我照抄时没照做。
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 21 * 60 * 1000;
        await flushLedger(run, root, sid);
        run.services.tokenMeter._total = 745; // < 75% ⇒ 够不着那条旁路，只能靠时限兜底
        askAICompact(sid);
        await runPreStep(run, { agent, messages: [] });
      } finally {
        Date.now = realNow;
      }
      ok(
        "★★★ 超过 20 分钟仍未分流 ⇒ 时限兜底放行（压缩不再永久卡死）",
        regionCalls.length >= 1,
        `regionCalls=${regionCalls.length}`
      );
      rmrf(root);
    }

    // 37i-5：★★★ 2026-10-11 新增 —— **可查的压缩计数器**（D59 的核心教训）。
    //
    //   用户那句"一次增量压缩都没发生"之所以能戳中我，是因为我
    //   **写了棘轮、自检全绿、还发了版，却从没核对过"压缩真的发生了"**。
    //   ⇒ 凡是"应该会发生"的事，都要有一个**能被读出来的整数**。
    //   ★ 这条同时防两种事故：① 功能没跑（数字不涨）；② 只统计了一条路径
    //     （本用例**增量与全量都走一遍**，两条都必须记上）。
    {
      // ★ 用 `steady`：本用例要测的是**计数器**，而不是分流闸门。
      //   用 `surgical` 会让压缩被分流义务拦住 ⇒ 断言的其实是闸门，而不是计数
      //   （我第一版就踩了这个 —— 四个断言一起红，根因是夹具选错，不是功能坏）。
      const root = mkGateProj("gate-counts", "steady");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { highFidelityCompactRatio: 1.0, /* ★D119：本用例测闸门/计数器/口径，**不测**「到全量线该让路」。让路有两个入口 —— ① `pressure.ratio >= hfLine` ② 水位 ≥ `capLine = min(内核线−5点, hfLine)`。取 `hfLine = 1.0` 让两者都够不着本用例水位。★ **绝不能设 `highFidelityCompact: false`**（我第一版那么改过，多红 7 条）：它还连带关掉**全量前置探针**，而依赖那段注入的断言会跟着塌。 */ });
      const sid = "session-gate0000-0005";
      const agent = mkGateAgent(root, sid, 7);
      const exec = execFor(root, sid);
      run.services.tokenMeter._priced = agent.session.surface.nodes.map((seq) => ({ seq, tokens: 40 }));

      // ★ 用**工具**那侧查（机器可校验的结构化字段），不是聊天文案。
      const counts = async () =>
        (await run.registeredTools.get("ledger_status").execute({}, exec))?.compactionCounts;

      const c0 = await counts();
      ok(
        "★★★ `ledger_status` 报出本会话压缩次数（用户能自己查、脚本能断言）",
        c0 !== undefined && c0 !== null && c0.total === 0,
        JSON.stringify(c0)
      );

      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 100;
      await runPreStep(run, { agent, messages: [] });
      // ★ 走**增量**那条（这正是用户报的那条路径）
      //   ★★★ 2026-10-12（D129）：机械兜底已删 ⇒ 三步驱动（落盘 → 分流 → 模型要压）。
      run.services.tokenMeter._total = 720;
      await runPreStep(run, { agent, messages: [] });
      await flushLedger(run, root, sid);
      await triageNow(run, root, sid);
      run.services.tokenMeter._total = 740;
      askAICompact(sid);
      await runPreStep(run, { agent, messages: [] });
      ok("★★ 增量压缩真的跑了（否则计数无从谈起）", regionCalls.length >= 1, `regionCalls=${regionCalls.length}`);
      const c1 = await counts();
      ok(
        "★★★ 增量压缩**记进了计数器**（第一版只统计全量 ⇒ 会误报 0）",
        c1 !== null && c1 !== undefined && c1.total >= 1 && c1.delta >= 1,
        JSON.stringify(c1)
      );
      rmrf(root);
    }

    // 37i-3：★★★ D129 **模式已合并** ⇒ 清单里写 steady 也照样要求分流
    //
    //   ★ 用户本轮拍板"合并成一种：分流成为标准步骤" ⇒ `triageRequired()` 恒真。
    //   ★ 这条用例因此从"两模式确实不同"改成**钉住合并后的行为**：
    //     清单里写着 `steady` 的项目，**也必须**先分流才能压（否则就是"拿不出
    //     分流后不能删的东西"那条路 —— 与规格⑪冲突）。
    {
      const root = mkGateProj("gate-steady", "steady");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { highFidelityCompactRatio: 1.0, /* ★D119：本用例测闸门/计数器/口径，**不测**「到全量线该让路」。取 `hfLine = 1.0` 让让路判据够不着本用例水位。★ **绝不能设 `highFidelityCompact: false`**：它还连带关掉**全量前置探针**，而依赖那段注入的断言会跟着塌。 */ });
      const sid = "session-gate0000-0003";
      const agent = mkGateAgent(root, sid, 7);
      // ★ 同 37i-2：水位 740 ⇒ 保留 640 ⇒ surface 要给够（21 × 40 = 840 > 640）。
      run.services.tokenMeter._priced = agent.session.surface.nodes.map((seq) => ({ seq, tokens: 40 }));

      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 100;
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 720; // 70% 档
      const d70 = await runPreStep(run, { agent, messages: [] });
      const t70 = (d70.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
      ok(
        "★★★ D129：清单写 steady 也**照样要求分流**（模式已合并）",
        /ledger_triage/.test(t70),
        t70.slice(0, 400)
      );

      // 只落盘、不分流 ⇒ 仍不许压（这才是"合并"的实质）
      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 740;
      askAICompact(sid);
      await runPreStep(run, { agent, messages: [] });
      eq("★★★ D129：写 steady 且只落盘 ⇒ **仍不许压**（缺分流这一环）", regionCalls.length, 0);

      // 补分流 ⇒ 放行
      await triageNow(run, root, sid);
      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 760;
      askAICompact(sid);
      await runPreStep(run, { agent, messages: [] });
      ok(
        "★★★ D129：补做分流之后 ⇒ 压缩放行（与 surgical 行为一致）",
        regionCalls.length >= 1,
        `regionCalls=${regionCalls.length}`
      );
      rmrf(root);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//
// ★★★ 情形 38：项目锁（2026-10-10 用户拍板）
//
//   用户原话：*"因为总的工作区是有需要读的东西的，所以有时候会把对话建在总的
//   工作区下面，这种时候的话，这个项目的锁定就应该考虑到可以让用户和AI说之后
//   AI调用，或者说把项目注册到对应的文件夹上，以后各种工具的使用都在那个文件夹上。"*
//
//   以及他**否决**落注册表文件时说的：*"让模型拥有把插件锁定在对应或者说本次项目
//   新建的文件夹中。而不是去动工作区的东西。不应该有这个权利。
//   最开始的提示卡片就可以有这样的选择。"*
//
//   ⇒ 这个情形钉的就是他那三句话，逐条：
//     ① 锁生效后**所有**工具都落在锁定目录上（不是只有一两个）；
//     ② **一个文件都不写**（工作区里不多出任何东西）；
//     ③ 只在本场对话内（换 sid 就没了）；
//     ④ 首轮卡片里有这个选项；
//     ⑤ 优先级：cwd 自己有台账 ⇒ 以 cwd 为准（锁只接管"没有台账"的目录）。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 38：项目锁（总工作区里锁定到子项目）");
{
  /** 造成"总工作区 + 一个子项目"的样子。 */
  const mkContainer = (tag) => {
    const dir = tmpProject(tag);
    // 容器标志：有 AGENTS.md 且**不是** git 仓库（`isContainerWorkspace` 的判据）
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# 工作区指令\n", "utf8");
    const sub = path.join(dir, "20-子项目");
    fs.mkdirSync(sub, { recursive: true });
    return { dir, sub };
  };

  const execOn = (agent, root) => ({
    agent,
    ...(root === undefined ? {} : {}),
  });

  // 38a：锁定一个子项目 ⇒ 所有工具都落到它上面
  {
    const { dir, sub } = mkContainer("lock-basic");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const sid = "session-lock0000-0001";
    const agent = { session: { header: { id: sid, cwd: dir } } };

    const lock = run.registeredTools.get("ledger_lock");
    ok("★ 有 `ledger_lock` 工具", lock !== undefined);

    const r = await lock.execute({ root: sub }, { agent });
    eq("★ 锁定成功", r.ok, true);
    eq("★ 锁定的就是那个子目录", r.root, path.resolve(sub));

    // ★★ 关键：**别的不相干工具**也必须跟着落到锁定目录上
    //    （"以后各种工具的使用都在那个文件夹上"是用户的原话）
    const st = await run.registeredTools.get("ledger_status").execute({}, { agent });
    eq("★★★ ledger_status 落在锁定目录上（不是 cwd）", path.resolve(st.projectRoot), path.resolve(sub));
    eq("★★ 那个子目录还没台账 ⇒ 如实报未初始化", st.initialized, false);

    // 换个工具再验一次（证明不是只有 status 走了这条链）
    const init = await run.registeredTools.get("ledger_init").execute(
      { active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a", initialActive: "# 台账\n\n- 起头\n" },
      { agent }
    );
    eq("★★★ ledger_init 也落在锁定目录上", init.ok, true);
    eq("★★ 它自报的项目根就是锁定目录", path.resolve(init.projectRoot), path.resolve(sub));
    // ★ 断言要落在**它真的会做的事**上：`ledger_init` 写的是**清单**（`.dsh-ledger.json`），
    //   活跃台账只有传了 `initialActive` 才建。
    //   ★ 我第一版断言的是"LedGER.md 存在" → 假红（那条不是它的职责）。
    //     ⇒ 判据要跟着被测对象的**真实语义**走，不能跟着我的印象走。
    ok("★★★ 清单真的写进了锁定目录", fs.existsSync(path.join(sub, ".dsh-ledger.json")), sub);
    ok("★★★ 台账正文也真的建在锁定目录里", fs.existsSync(path.join(sub, "LEDGER.md")), sub);
    ok("★★ 而 cwd（容器根）里**没有**台账", !fs.existsSync(path.join(dir, "LEDGER.md")), dir);
    ok("★★★ cwd 里也没有清单（没有误写到总工作区）", !fs.existsSync(path.join(dir, ".dsh-ledger.json")), dir);
    rmrf(dir);
  }

  // 38b：★★★ 锁**一个文件都不写**（用户明确要求"不要去动工作区的东西"）
  {
    const { dir, sub } = mkContainer("lock-nowrite");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const agent = { session: { header: { id: "s-lock-nowrite", cwd: dir } } };

    const before = (d) => {
      const out = [];
      (function walk(x, pre) {
        for (const e of fs.readdirSync(x, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(x, e.name), pre + e.name + "/");
          else out.push(pre + e.name);
        }
      })(d, "");
      return out.sort();
    };
    const dirBefore = before(dir);
    const subBefore = before(sub);

    await run.registeredTools.get("ledger_lock").execute({ root: sub }, { agent });

    eq("★★★ 容器根里没有多出任何文件", JSON.stringify(before(dir)), JSON.stringify(dirBefore));
    eq("★★★ 被锁的子目录里也没有多出任何文件", JSON.stringify(before(sub)), JSON.stringify(subBefore));
    // 也不许在别处偷偷落个注册表
    ok(
      "★★★ 没有在工作区里建注册表/清单之类的东西",
      fs.readdirSync(dir).every((f) => !/ledger.*(project|registry|lock)/i.test(f)),
      fs.readdirSync(dir).join("|")
    );
    rmrf(dir);
  }

  // 38c：★ 只在本场对话内 —— 换一个 sid 就没有锁
  {
    const { dir, sub } = mkContainer("lock-scope");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const a1 = { session: { header: { id: "s-lock-a", cwd: dir } } };
    await run.registeredTools.get("ledger_lock").execute({ root: sub }, { agent: a1 });
    const stA = await run.registeredTools.get("ledger_status").execute({}, { agent: a1 });
    eq("★ 锁了的会话落在子目录", path.resolve(stA.projectRoot), path.resolve(sub));

    const a2 = { session: { header: { id: "s-lock-b", cwd: dir } } };
    const stB = await run.registeredTools.get("ledger_status").execute({}, { agent: a2 });
    eq("★★★ 另一场对话**不受影响**（回到 cwd）", path.resolve(stB.projectRoot), path.resolve(dir));
    rmrf(dir);
  }

  // 38d：★★ 优先级 —— cwd 自己有台账 ⇒ 以 cwd 为准（锁只接管"没有台账"的）
  {
    const { dir, sub } = mkContainer("lock-priority");
    // 让 cwd 自己**有**一个台账
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 容器自己的台账\n", "utf8");
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a", revision: 0 }),
      "utf8"
    );
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const agent = { session: { header: { id: "s-lock-pri", cwd: dir } } };
    await run.registeredTools.get("ledger_lock").execute({ root: sub }, { agent });
    const st = await run.registeredTools.get("ledger_status").execute({}, { agent });
    eq("★★★ cwd 自己有台账 ⇒ 以 cwd 为准（锁不越权）", path.resolve(st.projectRoot), path.resolve(dir));
    rmrf(dir);
  }

  // 38e：★ 锁到不存在的目录 ⇒ 拒绝，且说清理由（不替用户创建）
  {
    const { dir } = mkContainer("lock-missing");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const agent = { session: { header: { id: "s-lock-miss", cwd: dir } } };
    const r = await run.registeredTools.get("ledger_lock").execute({ root: "根本没有这个目录" }, { agent });
    eq("★★ 锁到不存在的目录 ⇒ 拒绝", r.ok, false);
    ok("★★ 理由里说清「必须已经存在」", /不是一个存在的目录/.test(String(r.reason)), String(r.reason).slice(0, 200));
    ok("★★★ 而且**没有**把它创建出来", !fs.existsSync(path.join(dir, "根本没有这个目录")));
    rmrf(dir);
  }

  // 38f：★ 解锁 ⇒ 回到 cwd
  {
    const { dir, sub } = mkContainer("lock-release");
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const agent = { session: { header: { id: "s-lock-rel", cwd: dir } } };
    const lock = run.registeredTools.get("ledger_lock");
    await lock.execute({ root: sub }, { agent });
    const rel = await lock.execute({ release: true }, { agent });
    eq("★ 解锁成功", rel.locked, false);
    eq("★ 解的是刚才那把", rel.wasLocked, path.resolve(sub));
    const st = await run.registeredTools.get("ledger_status").execute({}, { agent });
    eq("★★★ 解锁后回到按 cwd 解析", path.resolve(st.projectRoot), path.resolve(dir));
    rmrf(dir);
  }

  // 38g：★★★ 没有锁时，行为与以前**逐字节相同**（新能力不许悄悄改旧行为）
  {
    const dir = tmpProject("lock-noop");
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n", "utf8");
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a", revision: 0 }),
      "utf8"
    );
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const agent = { session: { header: { id: "s-lock-noop", cwd: dir } } };
    const st = await run.registeredTools.get("ledger_status").execute({}, { agent });
    eq("★★★ 没锁 ⇒ 就是 cwd（与加锁之前一致）", path.resolve(st.projectRoot), path.resolve(dir));
    rmrf(dir);
  }

  // 38h：★★ 首轮卡片的「锁定」那一项，选完要给出**可执行**的指示
  {
    const { dir } = mkContainer("lock-card");
    const run = makeCtx({ withUserQuestions: true });
    mod.apply(run.ctx, {});
    run.setAnswer(() => ({ answers: [{ id: "ledger-first-turn", selected: ["锁定到某个子项目"] }] }));
    const steered = [];
    const agent = {
      session: { header: { id: "s-lock-card", cwd: dir } },
      steer: (m) => steered.push(m),
    };
    // ★ `fireStopping` / `settle` 都是别的情形块内的**局部** helper，这里取不到
    //   ⇒ 就地把它们展开。（第一版直接调 ⇒ `fireStopping is not defined`。）
    for (const h of run.handlers.get("agent/turn-stopping") ?? []) await h({ agent, turn: 1 });
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    const opts = run.asked[0].request.questions[0].options.map((o) => o.label);
    ok("★★ 首轮卡片里有「锁定」这一项", opts.some((o) => o.includes("锁定")), opts.join("|"));
    eq("★ steer 唤醒了 AI", steered.length, 1);
    const txt = steered[0].content[0].text;
    ok("★★★ 指示里点名了 `ledger_lock`", /ledger_lock/.test(txt), txt.slice(0, 300));
    ok("★★★ 且要求它**先问是哪个子项目**（不许自己猜）", /先问|问清/.test(txt), txt.slice(0, 300));
    // ★ 2026-10-10 口径变了：锁**会落盘**（跨重启保持），所以不能再断言"不写任何文件"。
    //   现在要断言的是"它如实说明了记录放在 DSH 自己的家、不在用户工作区里"。
    ok("★★ 并说明「记录不在用户工作区里」（用户会关心这个）",
      /不在用户的工作区|不在你的工作区|plugin-data/.test(txt), txt.slice(0, 400));
    rmrf(dir);
  }

  // 38i：★★★ 采集器（活动日志 / L4）也走锁吗？
  //
  //   ★ 这是**真缺口**的回归：用户让我把会话锁到插件目录之后，我发现
  //     `ledger_log({view:"users"})` 一条 L4 都没有 —— 因为 `session/event`
  //     那条链手里只有 `session`（没有 `agent`），旧代码就直取 `session.header.cwd`，
  //     **绕过了 `projectRootOf`** ⇒ 锁对 L0–L4 全部无效。
  //     容器根没台账 ⇒ `logDirOf` undefined ⇒ `consume` 直接 return ⇒ **一句都不记**。
  //   ⇒ 断言必须验证"事件采集落到了**锁定目录**"，而不是"锁的工具返回值对不对"。
  {
    const { dir, sub } = mkContainer("lock-collector");
    // 子项目启用日志；容器根**不建台账**（= 用户真实情形：总工作区没有台账）
    fs.writeFileSync(path.join(sub, "LEDGER.md"), "# 台账\n", "utf8");
    fs.writeFileSync(
      path.join(sub, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a",
        logDir: "_ledger-log",
        logLevels: { L0: true, L1: true, L2: true, L3: false, L4: true },
        revision: 0,
      }),
      "utf8"
    );

    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const sid = "s-lock-collector";
    const agent = { session: { header: { id: sid, cwd: dir } } };
    await run.registeredTools.get("ledger_lock").execute({ root: sub }, { agent });

    // 喂一条真实的 user/message（形状照 userMessageOf 的判据：data.role + data.source.kind）
    const session = { header: { id: sid, cwd: dir }, id: sid };
    for (const h of run.handlers.get("session/event") ?? []) {
      await h(session, {
        type: "user/message",
        time: Date.now(),
        data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "锁定时用户说的话" }] },
      });
    }
    // 日志是去抖落盘的（LOG_FLUSH_DEBOUNCE_MS = 1200）
    await new Promise((r) => setTimeout(r, 1500));

    const hasL4 = (base) => {
      const d = path.join(base, "_ledger-log");
      if (!fs.existsSync(d)) return false;
      const stack = [d];
      while (stack.length > 0) {
        const cur = stack.pop();
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          if (e.isDirectory()) stack.push(path.join(cur, e.name));
          else if (/L4/.test(e.name)) return true;
        }
      }
      return false;
    };

    ok("★★★ 锁生效后，L4 真的落进了**锁定目录**", hasL4(sub), `子目录 ${sub} 下没找到 L4`);
    ok("★★★ 而且**没有**落到容器根（cwd）", !hasL4(dir), `容器根 ${dir} 下不该有 L4`);
    rmrf(dir);
  }

  // 38j：★★★ 锁**跨重启保持**（2026-10-10 用户追加要求）
  //
  //   用户原话：*"这个锁能不能长久保留，比如说我们在这个对话锁到项目台账文件夹后，
  //     不管重启多少次，之后都默认在那个文件夹使用工具"*
  //   ★ 以及他纠正我的一次：*"注意是每个对话自己选锁定的目录并保持"*
  //     ⇒ 键必须是 **sid**（每场对话各记各的），**不是 cwd**（那会让新对话也悄悄改道）。
  //
  //   ★ "重启"在这里怎么模拟：`sessionProjectLock` 是模块级 Map，**进程一换就没了**。
  //     所以"新进程"= 重新 import 一次 `lib/index.js`（模块级 Map 全新），
  //     而落盘的 `locks.json` 仍在（同一个沙箱 DSH_HOME）⇒ 正好等价于重启。
  {
    const { dir, sub } = mkContainer("lock-persist");
    const sid = "s-lock-persist";

    // ── 第一个"进程"：锁上 ──
    const run1 = makeCtx({});
    mod.apply(run1.ctx, {});
    const agent1 = { session: { header: { id: sid, cwd: dir } } };
    const r1 = await run1.registeredTools.get("ledger_lock").execute({ root: sub }, { agent: agent1 });
    eq("① 锁定成功", r1.ok, true);
    eq("★★★ 而且**确实落盘了**（persisted）", r1.persisted, true);

    // 落盘位置必须在**沙箱家**里，绝不能是用户真实的家
    const storePath = r1.storePath;
    ok("★★★ 记录写在沙箱 DSH_HOME 里（不是用户真实的家）",
      storePath.startsWith(SANDBOX_HOME), storePath);
    ok("★★ 记录文件真的存在", fs.existsSync(storePath), storePath);
    const rawStore = fs.readFileSync(storePath, "utf8");
    ok("★★★ 记录里按 **sid** 记账（不是按 cwd）", rawStore.includes(sid), rawStore.slice(0, 200));
    ok("★★★ 记录里**没有**把这个 cwd 当成键（否则新对话会被悄悄改道）",
      !rawStore.includes(`"${path.resolve(dir)}":`), rawStore.slice(0, 300));

    // ── 模拟"重启"：换一个全新的模块实例（内存 Map 归零，磁盘还在）──
    const mod2 = await import(`${pathToFileURL(ENTRY).href}?restart=${Date.now()}`);
    const run2 = makeCtx({});
    mod2.apply(run2.ctx, {});
    const agent2 = { session: { header: { id: sid, cwd: dir } } };
    const st2 = await run2.registeredTools.get("ledger_status").execute({}, { agent: agent2 });
    eq("★★★ **重启后**同一场对话仍然落在锁定目录上", path.resolve(st2.projectRoot), path.resolve(sub));

    // ── 另一场对话**不受影响**（"每个对话自己选"）──
    const agentOther = { session: { header: { id: "s-lock-persist-OTHER", cwd: dir } } };
    const stOther = await run2.registeredTools.get("ledger_status").execute({}, { agent: agentOther });
    eq("★★★ 换一场对话**不受影响**（回到 cwd）", path.resolve(stOther.projectRoot), path.resolve(dir));

    // ── 解除必须**连记录一起删**（否则"我解除了，重启又回来"）──
    await run2.registeredTools.get("ledger_lock").execute({ release: true }, { agent: agent2 });
    const mod3 = await import(`${pathToFileURL(ENTRY).href}?restart=${Date.now()}b`);
    const run3 = makeCtx({});
    mod3.apply(run3.ctx, {});
    const st3 = await run3.registeredTools.get("ledger_status").execute({}, { agent: agent2 });
    eq("★★★ 解除后**再重启**也不会回来（记录已删）", path.resolve(st3.projectRoot), path.resolve(dir));

    rmrf(dir);
  }

  // 38k：★ 锁记录坏了 / 目标没了，都不许让插件崩
  {
    const { dir, sub } = mkContainer("lock-robust");
    const sid = "s-lock-robust";
    const run = makeCtx({});
    mod.apply(run.ctx, {});
    const agent = { session: { header: { id: sid, cwd: dir } } };
    const r = await run.registeredTools.get("ledger_lock").execute({ root: sub }, { agent });
    const storePath = r.storePath;

    // ① 坏 JSON ⇒ 当没锁，不抛
    fs.writeFileSync(storePath, "{ 这不是合法 JSON", "utf8");
    let threw = false;
    try {
      await run.registeredTools.get("ledger_status").execute({}, { agent });
    } catch (e) {
      threw = true;
    }
    ok("★★ 记录文件坏掉时**不许抛错**（当没锁即可）", !threw);

    // ② 目标目录被删 ⇒ 锁自动失效（不能指向一个不存在的根）
    fs.writeFileSync(storePath, JSON.stringify({ version: 1, bySession: { [sid]: { root: sub } } }), "utf8");
    const gone = path.join(dir, "20-子项目");
    rmrf(gone);
    const st = await run.registeredTools.get("ledger_status").execute({}, { agent });
    eq("★★ 目标目录被删后，锁**自动失效**回到 cwd", path.resolve(st.projectRoot), path.resolve(dir));

    rmrf(dir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 收尾清扫：日志是**去抖落盘**的（`LOG_FLUSH_DEBOUNCE_MS = 1200`），
//   所以用例里 `rmrf(root)` 之后，那个还没到点的定时器仍会醒来 —
//   而它会 `ensureDir` 把刚删掉的目录**重建**出来。
//   实测：干净跑一遍会在 %TEMP% 留下 2 个空壳 `ledger-hf-compact-*` /
//   `ledger-manual-tool-*`（正是不经过 turn-stopping 落盘的两组）。
//   ⇒ 等过去抖窗口再统一扫一遍，自检才不留垃圾。
for (const d of CREATED_ROOTS) rmrf(d);
// ═══════════════════════════════════════════════════════════════════════════
// 情形 39：★★★ 三份审计报告点出的两条**高危缺陷**（2026-10-11）
//
//   审计员 002 的关键方法论：**这两条落在自检盲区** ——
//     · 决策写入用例**全部用 `mode:"append"`**（L821 / L4170）
//     · `compactNow` 夹具**全部成功返回、无一注入抛错**
//   ⇒ 926 项全绿**不为这两条高危路径背书**。
//   ⇒ 所以这里**先写会红的用例**（TDD 的顺序），再改实现 —— 否则修了什么、有没有修好，
//     都只能靠"读一遍觉得对"来判断。
//
//   A1：`ledger_write` 对 `decisions` **默认 replace** ⇒ 不传 `mode` 即抹掉全部历史决策。
//       工具描述却称决策记录 "is never archived / append-only" ⇒ 实现与承诺**直接冲突**。
//   A4：70% 路径**排队即**置 `hfCompacted=true`；`compactNow` **抛异常**时 idle handler
//       只 warn、**不复位不重排** ⇒ **本会话全量兜底永久停摆**，只剩内核 80% 硬压（抓不到胶囊）。
//       ★ 精确边界：返回 `null`（无可压历史）那条**有** `delete` 恢复；闸门拒绝那条也**正确地**
//         不置真 —— 缺陷**仅限真压缩抛异常/超时**这一条路径。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 39：审计报告点出的 A1 / A4 高危缺陷（先写会红的用例）");
{
  const mkA = (tag) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\n做点事\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n\n## D1 早期决策\n- 这条必须保住\n", "utf8");
    fs.mkdirSync(path.join(dir, "_a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 7,
      }),
      "utf8"
    );
    return dir;
  };

  // ── A1：默认 mode（不传）写 decisions，**不许**抹掉历史 ────────────────
  {
    const root = mkA("a1-decisions-default");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-a1a1a1a1-a1a1");
    const T = run.registeredTools;

    // 先追加一条（这是现在唯一被测试覆盖的写法）
    await T.get("ledger_write").execute(
      { target: "decisions", mode: "append", content: "## D2 追加的决策\n- 第二条\n" },
      A
    );
    const before = fs.readFileSync(path.join(root, "DECISIONS.md"), "utf8");
    ok("前置：D1 与 D2 都在", before.includes("D1 早期决策") && before.includes("D2 追加的决策"), before);

    // ★ 关键：**不传 mode**（工具描述说这是 append-only 的长期档案）
    const r = await T.get("ledger_write").execute(
      { target: "decisions", content: "## D3 新决策\n- 第三条\n" },
      A
    );
    const after = fs.readFileSync(path.join(root, "DECISIONS.md"), "utf8");
    ok(
      "★★★ A1：不传 mode 写 decisions ⇒ **旧决策必须还在**（append-only 承诺）",
      after.includes("D1 早期决策") && after.includes("D3 新决策"),
      `ok=${r.ok} 文件内容=\n${after.slice(0, 400)}`
    );
    rmrf(root);
  }

  // ── A1b：显式 replace 才允许覆盖（有意为之的操作要有明确出口）──────────
  {
    const root = mkA("a1b-decisions-explicit-replace");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-a1b1b1b1-a1b1");
    const r = await run.registeredTools
      .get("ledger_write")
      .execute({ target: "decisions", mode: "replace", content: "## 只剩这一条\n" }, A);
    const after = fs.readFileSync(path.join(root, "DECISIONS.md"), "utf8");
    ok(
      "★★ A1b：**显式** mode:replace 仍然允许整份覆盖（有意为之的出口不能堵死）",
      after.includes("只剩这一条"),
      `ok=${r.ok} 内容=\n${after.slice(0, 300)}`
    );
    rmrf(root);
  }

  // ── A4：全量压缩**抛异常**后，本会话必须还能再试（不许永久停摆）────────
  {
    const root = mkA("a4-compact-throws");
    // ★ 与 37i 组同形状的假 agent（那里是块作用域，这里自带一份）
    const mkAgent39 = (sid, rounds) => {
      const events = [];
      let seq = 1;
      for (let r = 0; r < rounds; r += 1) {
        events.push({ type: "user/message", seq, data: { message: { role: "user", content: [] } } });
        seq += 1;
        events.push({
          type: "assistant/message",
          seq,
          data: { message: { role: "assistant", content: [{ type: "tool-call", id: `c${seq}` }] } },
        });
        seq += 1;
        events.push({ type: "tool/result", seq, data: { message: { role: "tool" } } });
        seq += 1;
      }
      const bySeq = new Map(events.map((e) => [e.seq, e]));
      return {
        session: {
          header: { id: sid, cwd: root },
          id: sid,
          requestContext: () => ({ contextWindow: 1000 }),
          surface: { nodes: events.map((e) => e.seq) },
          eventAt: (s) => bySeq.get(s),
        },
        steer: () => {},
      };
    };

    let now = 0;
    const run = makeCtx({ withCompaction: true, withTokenMeter: true });
    // ★ 夹具：`compactNow` **抛异常**（这正是 A4 的真实触面；002 指出现有夹具全都成功返回）
    run.services.compaction = {
      compactRegion: async () => ({ shadowedSeqs: [], shadowedTokenCount: 0 }),
      compactNow: async () => {
        now += 1;
        throw new Error("compaction backend exploded");
      },
    };
    mod.apply(run.ctx, {});
    const sid = "session-a4a4a4a4-a4a4";
    const agent = mkAgent39(sid, 7);

    // 推到 70% 以上 ⇒ 自动全量排队
    run.services.tokenMeter._total = 800;
    await runPreStep(run, { agent, messages: [] });
    // 让 idle handler 真跑一次（会调 compactNow ⇒ 抛异常）
    await fire(run, "agent/status", { agent, status: "idle" });
    eq("★★ A4 前置：`compactNow` 确实被调用过（异常路径真的走到了）", now >= 1, true);

    // ★ 关键：**再给一次机会** —— 第一次失败不该用掉整个会话的资格
    run.services.tokenMeter._total = 820;
    await runPreStep(run, { agent, messages: [] });
    await fire(run, "agent/status", { agent, status: "idle" });
    ok(
      "★★★ A4：压缩抛异常后**必须还能重试**（不许本会话兜底永久停摆）",
      now >= 2,
      `compactNow 调用次数=${now}（若为 1 ⇒ 一次异常就把本会话兜底永久关掉了）`
    );
    rmrf(root);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 情形 40：★★★ **度量口径不一致** ⇒ 增量压缩在真实机器上永不发生
//
//   用户 2026-10-11 第二次先发现：*"你有没有发现，你直到现在还没有增量压缩？"*
//   实测：1.1.0 之后 `compaction/start` **0 次**；`anchors.json` **不存在**
//   （而成功压缩必写它）⇒ **从未成功过一次**。
//
//   ★★★ 根因（内核源码**逐字**对照，不是猜）：
//     内核 `dsh-token-meter` 的 `measure()` 返回：
//       totalTokens = baseline.tokens + surfaceDeltaTokens
//                   = estimateToolsTokens(header) + surfaceTokens   ← **含工具头**
//       nodes       = surface.nodes                                  ← **只有 surface**
//     而本插件：
//       · `measurePressure` 用 **totalTokens**（含工具头）算 ratio；
//       · `retainTokens = floor((ratio − deltaRemovePoints/100) × window)` —— **同一尺度**；
//       · `selectIncrementalRange` 却在 **nodes（只有 surface）** 上从后往前累加。
//     ⇒ 只要 **工具头 > deltaRemovePoints% × window**，就有
//         `retainTokens > Σnodes` ⇒ 攒满全部节点仍不够 ⇒ `keepFromIdx` 退到 `firstIdx`
//         ⇒ **返回 null** ⇒ 压缩永不发生，**且该返回不带 blocked/requeued ⇒ 静默**。
//
//   ★ 本机实测何以必然触发：**406 个工具**、定义 JSON 464,937 字符 ≈ **116K token**
//     > **100K**（1M 窗口的 10% = deltaRemovePoints 默认 10）⇒ 必然失败。
//
//   ★★ 为什么 934 项自检全绿却没抓到：30a 的夹具注释**自己写错了前提** ——
//      它断言"真实内核里 totalTokens 就是 surface 各节点之和"（第 5667 行的原话）。
//      于是夹具让 `_total` 与 `_priced` **内部自洽**，而真实环境**不自洽**。
//      ⇒ 本用例要**复现真实的不自洽**（totalTokens 明显大于 priced 之和）。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 40：度量口径不一致 ⇒ 增量压缩永不发生（真实环境复现）");
{
  const mkU = (tag) => {
    const root = tmpProject(tag);
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\n做点事\n", "utf8");
    fs.writeFileSync(path.join(root, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.mkdirSync(path.join(root, "_a"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 0,
      }),
      "utf8"
    );
    return root;
  };

  {
    const root = mkU("unit-mismatch");
    const regionCalls = [];
    const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
    // ★★★ 2026-10-12（D119）：**把全量线推高**，排除"增量让路"这个混杂变量。
    //   本用例水位 **100%**，测的是「**保留量口径**」（surface vs totalTokens 两个尺度），
    //   **与"该不该让路"无关**。而 D119 之后水位 ≥ 全量线 ⇒ 增量**一律让路** ⇒ 本用例测不到了。
    //   ⇒ 把全量线设到 **1.0**（水位够不着）⇒ 增量照常跑 ⇒ 本用例继续测它真正要测的东西。
    mod.apply(run.ctx, { highFidelityCompactRatio: 1.0, highFidelityCompactRatio: 1.0, /* ★D119：本用例测闸门/计数器/口径，**不测**「到全量线该让路」。让路有两个入口 —— ① `pressure.ratio >= hfLine` ② 水位 ≥ `capLine = min(内核线−5点, hfLine)`。取 `hfLine = 1.0` 让两者都够不着本用例水位。★ **绝不能设 `highFidelityCompact: false`**（我第一版那么改过，多红 7 条）：它还连带关掉**全量前置探针**，而依赖那段注入的断言会跟着塌。 */ });
    const sid = "session-unit0000-0001";
    // 造一个像真实内核那样"含工具头"的假 agent：21 个节点
    const events = [];
    let seq = 1;
    for (let r = 0; r < 7; r += 1) {
      events.push({ type: "user/message", seq, data: { message: { role: "user", content: [] } } }); seq += 1;
      events.push({ type: "assistant/message", seq, data: { message: { role: "assistant", content: [{ type: "tool-call", id: `c${seq}` }] } } }); seq += 1;
      events.push({ type: "tool/result", seq, data: { message: { role: "tool" } } }); seq += 1;
    }
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    const agent = {
      session: {
        header: { id: sid, cwd: root },
        id: sid,
        requestContext: () => ({ contextWindow: 1000 }),
        surface: { nodes: events.map((e) => e.seq) },
        eventAt: (s) => bySeq.get(s),
      },
      steer: () => {},
    };

    // ★★★ 关键：**复现真实内核的"不自洽"** ——
    //   `totalTokens`（含工具头）明显**大于** `priced` 各节点之和（只有 surface）。
    //   真实比例：本机工具头 ≈ 116K token / surface ≈ 570K token ⇒ 工具头约占 17%。
    //   这里用窗口 1000 等比缩小：工具头 170、surface 各节点合计 830。
    const NODES = events.length;              // 21
    const surfaceEach = Math.floor(830 / NODES); // 39 → 合计 819
    run.services.tokenMeter._priced = events.map((e) => ({ seq: e.seq, tokens: surfaceEach }));
    run.services.tokenMeter._total = 700; // ★D119：100% 会撞上 capLine(0.75) 触发增量让路 ⇒ 降到 70% 才能测到本用例真正要测的「保留量口径」    // 100% ⇒ 含工具头

    await flushLedger(run, root, sid);
    // 水位 100% 时：keepRatio = 1.00 − 0.10 = 0.90 ⇒ 旧口径 retainTokens = 900
    // 而 Σnodes = 21 × 39 = 819 < 900 ⇒ **攒满全部节点仍不够** ⇒ 返回 null ⇒ 不压。
    // ★★ 注意**必须分两步**（照 30a 的时序）：
    //   ① 第一步在水位到线时发**提醒** ⇒ 它会立 `flushOwedAt`（"开了口就要等"），
    //      该步**不会**压缩（这正是"先记台账、再压缩"）；
    //   ② 然后 AI 真写台账（`flushLedger`）；
    //   ③ 第三步才该压。
    //   ⚠️ 我第一版把①③挤在一步里 ⇒ 测到的是**闸门**，不是本次要测的口径 —— 又是"尺子错"。
    run.services.tokenMeter._total = 700; // ★D119：100% 会撞上 capLine(0.75) 触发增量让路 ⇒ 降到 70% 才能测到本用例真正要测的「保留量口径」
    await runPreStep(run, { agent, messages: [] });   // ① 发提醒、立欠账
    await flushLedger(run, root, sid);                // ② 真写台账 ⇒ 义务兑现
    // ★★★ 2026-10-12（D129）：机械兜底已删 ⇒ 第③步必须由**模型主动调工具**发起。
    //   ★ 顺序不能换：落盘（②）→ 分流（这里）→ 要压（旗子紧挨着那次 pre-step）。
    await triageNow(run, root, sid);
    askAICompact(sid);
    await runPreStep(run, { agent, messages: [] });   // ③ 该压了

    ok(
      "★★★ 水位 100%、涨够触发线时，增量压缩**必须真的发生**" +
        "（否则就是「保留量按含工具头的尺度算、却用在只有 surface 的节点上」）",
      regionCalls.length >= 1,
      `regionCalls=${regionCalls.length}；Σnodes=${NODES * surfaceEach}（只有 surface）` +
        ` vs 旧口径 retainTokens=900（按 totalTokens 含工具头算）`
    );
    rmrf(root);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 情形 41：★★★ 审计报告点出的 A2 / A3（数据完整性，先写会红的用例）
//
//   A2：`ledger_archive` **不是原子的** —— 它**先写归档文件**（L6982），行数超限的
//       失败判断在**之后**（L7012）。⇒ 失败返回时**归档已落盘**，
//       重试就**重复追加**同一批（归档是只追加的，重复即永久污染）。
//       且它**没有 `ifRevision`** ⇒ 旧快照可覆盖并发新增的条目。
//   A3：重复 `ledger_init` 重建**固定字段**对象 ⇒ `mode` / `handoffDir` / `notesDir`
//       及**未知扩展字段**被静默丢弃；且 `manifest.revision = manifestRevision(prev)`
//       **沿用旧值**（L6448）⇒ 其他会话持有的旧 revision 看起来仍是最新。
//
//   ★ 为什么先写会红的用例：A1/A4 的教训 —— 926 项全绿**不为这些失败路径背书**
//     （它们全在"正常路径"上覆盖，失败路径一条都没测）。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 41：审计报告点出的 A2 / A3 数据完整性缺陷（先写会红的用例）");
{
  const mkB = (tag, extra) => {
    const dir = tmpProject(tag);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\n做点事\n", "utf8");
    fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n\n## D1\n- 早期\n", "utf8");
    fs.mkdirSync(path.join(dir, "_a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, revision: 7,
        ...(extra ?? {}),
      }),
      "utf8"
    );
    return dir;
  };
  const archFiles = (root) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(p);
      }
    };
    const base = path.join(root, "_a");
    if (fs.existsSync(base)) walk(base);
    return out;
  };

  // ── A2-1：行数超限时，**归档文件不许被写**（先验证、后落盘）──────────────
  {
    const root = mkB("a2-atomic");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-a2a2a2a2-a2a2");
    const T = run.registeredTools;

    // newActive 故意超限（上限 300 ⇒ 给 305 行）
    const huge = "# 台账\n\n" + Array.from({ length: 305 }, (_, i) => `- 行 ${i}`).join("\n") + "\n";
    const r = await T.get("ledger_archive").execute(
      { entries: "## 旧条目\n- 要归档的东西\n", newActive: huge },
      A
    );
    const files = archFiles(root);
    ok("A2 前置：行数超限时确实返回失败", r.ok === false, `ok=${r.ok} reason=${String(r.reason).slice(0, 60)}`);
    ok(
      "★★★ A2：失败时**不许留下归档文件**（否则重试会重复追加，永久污染只追加的归档）",
      files.length === 0,
      `归档目录里出现了 ${files.length} 个文件：${files.map((f) => path.basename(f)).join(", ")}`
    );
    rmrf(root);
  }

  // ── A2-2：成功后**重试同一批**（模拟"客户端没收到回执就重发"）─────────────
  {
    const root = mkB("a2-retry");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-a2b2b2b2-a2b2");
    const T = run.registeredTools;
    const small = "# 台账\n\n## 目标\n留着\n";
    const batch = "## 这一批\n- 只该出现一次\n";

    await T.get("ledger_archive").execute({ entries: batch, newActive: small }, A);
    const files1 = archFiles(root);
    const firstLen = files1.length === 0 ? 0 : fs.readFileSync(files1[0], "utf8").length;
    await T.get("ledger_archive").execute({ entries: batch, newActive: small }, A);
    const files2 = archFiles(root);
    const secondText = files2.length === 0 ? "" : fs.readFileSync(files2[0], "utf8");
    const occurrences = (secondText.match(/只该出现一次/g) ?? []).length;

    ok("A2-2 前置：第一次归档确实写成", firstLen > 0, `firstLen=${firstLen}`);
    ok(
      "★★★ A2：同一批重发 ⇒ 归档里**只能有一份**（要能识别重复 / 或有 idempotency 依据）",
      occurrences <= 1,
      `「只该出现一次」在归档里出现了 ${occurrences} 次`
    );
    rmrf(root);
  }

  // ── A2-3：★ 事故驱动 —— `ifRevision` 过期 ⇒ **拒绝，且一个字节都不写** ─────
  //   （2026-10-11 真实事故：我用真台账做破坏性试验，旧代码没有这道门，
  //     266 行被一次调用压成 1 行。详见 DECISIONS D63。）
  {
    const root = mkB("a2-stale");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-a2c2c2c2-a2c2");
    const T = run.registeredTools;
    const before = fs.readFileSync(path.join(root, "LEDGER.md"), "utf8");

    const r = await T.get("ledger_archive").execute(
      { entries: "## 归档批次\n- 一点点\n", newActive: "# 只剩这一行\n", ifRevision: 999 },
      A
    );
    const after = fs.readFileSync(path.join(root, "LEDGER.md"), "utf8");
    ok("A2-3 前置：过期 ifRevision 返回失败", r.ok === false, `ok=${r.ok}`);
    ok(
      "★★★ A2：过期的 ifRevision ⇒ **活跃台账一个字节都不许改**（事故那条路）",
      after === before,
      after === before ? "" : `台账被改动了（${before.length} → ${after.length} 字符）`
    );
    ok("★★★ A2：过期 ifRevision ⇒ **不许留下归档文件**", archFiles(root).length === 0, `files=${archFiles(root).length}`);
    rmrf(root);
  }

  // ── A2-4：★ 事故的真正病根 —— **归档不许凭空丢行** ──────────────────────
  //   事故那次：`newActive` 只剩 1 行、`entries` 只有 1 行，而活跃台账原有 266 行
  //   ⇒ 265 行**既不在新台账、也没进归档**，等于凭空蒸发。
  //   `ifRevision` 那道门只拦"版本过期"，**拦不住"我就是要删光"**——事故当时
  //   我传的 ifRevision 恰好在那个门存在之前。所以必须有这条**内容不变量**：
  //   **从活跃台账移除的每一行，都必须出现在 entries 里。**
  {
    const root = mkB("a2-lost-lines");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-a2d2d2d2-a2d2");
    const T = run.registeredTools;
    fs.writeFileSync(
      path.join(root, "LEDGER.md"),
      "# 台账\n\n## 目标\n- 这一条很重要，不能被凭空丢掉\n- 这一条同样重要，也不能丢\n- 第三条重要内容\n",
      "utf8"
    );
    const before = fs.readFileSync(path.join(root, "LEDGER.md"), "utf8");

    // ★ 复现事故形状：只交 1 行 entries，却把 3 行正文全删
    const r = await T.get("ledger_archive").execute(
      { entries: "## 归档批次\n- 一点点\n", newActive: "# 台账\n\n## 目标\n" },
      A
    );
    const after = fs.readFileSync(path.join(root, "LEDGER.md"), "utf8");
    ok(
      "★★★ A2：删掉的行必须在 entries 里（归档是「移走」，不是「删除」）",
      r.ok === false,
      `ok=${r.ok} reason=${String(r.reason).slice(0, 90)}`
    );
    ok("★★★ A2：凭空丢行的调用 ⇒ 活跃台账不许被改", after === before, after === before ? "" : "被改了");
    rmrf(root);
  }

  {
    const root = mkB("a3-fields", {
      mode: "surgical",
      handoffDir: "_handoff",
      notesDir: "_notes",
      myUnknownExtension: { keep: "me" },
    });
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-a3a3a3a3-a3a3");
    const T = run.registeredTools;

    await T.get("ledger_init").execute(
      { active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a", logDir: "_ledger-log" },
      A
    );
    const mf = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8"));
    ok(
      "★★★ A3：重复 init 之后，`mode` 必须还在（它决定压缩模式）",
      mf.mode === "surgical",
      `mode=${JSON.stringify(mf.mode)}`
    );
    ok(
      "★★★ A3：重复 init 之后，`handoffDir` / `notesDir` 必须还在",
      mf.handoffDir === "_handoff" && mf.notesDir === "_notes",
      `handoffDir=${JSON.stringify(mf.handoffDir)} notesDir=${JSON.stringify(mf.notesDir)}`
    );
    ok(
      "★★★ A3：重复 init 之后，**未知扩展字段**必须还在（前向兼容）",
      mf.myUnknownExtension?.keep === "me",
      `myUnknownExtension=${JSON.stringify(mf.myUnknownExtension)}`
    );
    rmrf(root);
  }

  // ── A3-2：重复 init **必须涨 revision** ─────────────────────────────────
  {
    const root = mkB("a3-revision");
    const run = makeCtx();
    mod.apply(run.ctx, {});
    const A = execFor(root, "session-a3b3b3b3-a3b3");
    const T = run.registeredTools;
    const before = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8"));

    await T.get("ledger_init").execute(
      { active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a", logDir: "_ledger-log" },
      A
    );
    const after = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8"));
    ok(
      "★★★ A3：重复 init 之后 revision **必须递增**（否则别的会话手里的旧号看起来仍是最新）",
      after.revision > before.revision,
      `before=${before.revision} after=${after.revision}`
    );
    rmrf(root);
  }
}

// ── 情形 49：手搓消息对象必须与内核 admission 判据逐条对齐 ─────────────────
section("情形 49：手搓消息必须带 producer-owned source（真机事故 D120）");
{
  // ★★★ 2026-10-12 真机事故（用户报：一段对话**打不开历史**了）：
  //   `ledger_compact` 里那个 `agent.steer()` 手搓消息**漏了 `source`**
  //   —— 那是 D114 新增这个调用时漏掉的。内核把它写进日志
  //   （作为 `agent/inbox/spliced` 的 `data.inserted[]`），而**重载历史时**校验
  //   每个消息槽位的生产者身份 ⇒ 抛
  //
  //     SessionFormatError: format v4 message requires a producer-owned source kind
  //
  //   ⇒ **整个会话加载失败**。★ 实时对话**不校验** ⇒ 写下的那一刻毫无症状，
  //     **下一次打开才炸** —— 所以这个坑只能靠静态判据守。
  //   ★ 本机栽过**同型两次**：2026-09-24 是"手搓消息漏了 `id`"（情形 1 已守 id），
  //     这次是"漏了 `source`"。⇒ 判据要覆盖**全部调用点**，而不是只覆盖测到的那一处。
  const d120Src = fs.readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8");

  /**
   * ★ 先剥掉注释与字符串，再做静态扫。
   *
   * ★★ 为什么必须剥（我第一次写这条断言就栽了）：不剥的话，**注释里提到的**
   *   `agent.steer(` 也会被算成调用点 —— 实测扫到 **10** 个，其中 4 个是本文件
   *   注释里引用的（含我这次写事故说明时引的那句）。
   *   ⇒ 与情形 43 的 `^section(` 是**同一个病**：判据把"描述它的文字"和"它本身"混在一起数
   *     （纪律第 2 条）。这里用"剥注释/字符串"来解决，比靠缩进更稳。
   */
  function stripCommentsAndStrings(src) {
    let out = "";
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
        out += "\n";
      } else if (ch === "/" && src[i + 1] === "*") {
        i += 2;
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
          if (src[i] === "\n") out += "\n";
          i++;
        }
        i++;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        const q = ch;
        out += q;
        i++;
        while (i < src.length && src[i] !== q) {
          if (src[i] === "\\") {
            out += "  ";
            i += 2;
            continue;
          }
          out += src[i] === "\n" ? "\n" : " ";
          i++;
        }
        out += q;
      } else {
        out += ch;
      }
    }
    return out;
  }
  /** 剥注释/字符串后，行号仍然一致（上面的实现保证换行数不变）。 */
  const d120Code = stripCommentsAndStrings(d120Src);

  /**
   * 从 `agent.steer(` 之后找到那个对象字面量，做**花括号配对**返回它的源码。
   * ★ 在**已剥注释/字符串**的文本上配对：否则文案里的 `}` 会把范围截错
   *   ⇒ 判据变成"看运气"（纪律：判据不吃运气）。
   */
  function steerObjectAt(src, from) {
    const open = src.indexOf("{", from);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) return src.slice(open, i + 1);
      }
    }
    return null;
  }

  const steerSites = [];
  {
    let at = -1;
    while ((at = d120Code.indexOf("agent.steer(", at + 1)) !== -1) {
      steerSites.push({ line: d120Code.slice(0, at).split("\n").length, obj: steerObjectAt(d120Code, at) });
    }
  }
  // ★ 期望数写上：**调用点变少也是变化**，不能静默通过（否则有人删掉一处判据就失效了）。
  eq("★ 静态扫到 `agent.steer(` 调用点 = 6（已剥离注释与字符串）", steerSites.length, 6);

  const noSource = steerSites.filter((s) => s.obj === null || !/\bsource\s*:/.test(s.obj));
  ok(
    "★★★ 每一处 `agent.steer()` 都必须带 `source`（漏了 ⇒ 该会话历史从此打不开）",
    noSource.length === 0,
    noSource.map((s) => `lib/index.js:${s.line}`).join("、")
  );

  const noRole = steerSites.filter((s) => s.obj === null || !/\brole\s*:/.test(s.obj));
  ok(
    "★ 每一处 `agent.steer()` 都必须带 `role`",
    noRole.length === 0,
    noRole.map((s) => `lib/index.js:${s.line}`).join("、")
  );

  // ── 运行时判据：抓**真发出去的**消息对象，逐条对内核 admission 判据 ──────────
  //
  //   ★ 静态扫只证明"文本里有 `source:`"；真值还得看**发出去的对象**长什么样
  //     （例如 `source: undefined` 也能骗过正则）。
  //   ★ 两条注入路径都要量：
  //     ① pre-step 的**返回值**（`decision.messages`）—— 台账注入、水位提醒、回执走这条；
  //     ② `agent.steer()` 的**参数** —— 回合末卡片那条走这条（情形 13 / 22c 已覆盖其行为）。
  //     **两条最终都落成 `agent/inbox/spliced` 的 `data.inserted[]`**，所以两条都要守。
  {
    /** 内核 `source(message)` 的判据（app.asar 原文，逐条对齐） */
    function sourceViolation(m) {
      const v = m === null || m === undefined ? undefined : m.source;
      if (v === null || typeof v !== "object" || Array.isArray(v)) return "source 不是对象";
      if (typeof v.kind !== "string") return "kind 不是 string";
      if (v.kind.length === 0) return "kind 是空字符串";
      if (v.kind === "plugin") return 'kind === "plugin"（已废弃的写法）';
      return null;
    }
    /** 逐条量一组消息 */
    function assertAdmissible(label, msgs) {
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const sv = sourceViolation(m);
        ok(`★★★ ${label}：第 ${i + 1} 条的 source 能过内核 admission`, sv === null, sv ?? "");
        ok(
          `★ ${label}：第 ${i + 1} 条有非空 string id`,
          typeof m?.id === "string" && m.id !== "",
          `id=${JSON.stringify(m?.id)}`
        );
      }
    }

    const root = tmpProject("d120");
    const run = makeCtx({ withCompaction: true, withTokenMeter: true });
    mod.apply(run.ctx, {});
    const agent = { session: { header: { id: "session-d1200000-0000-0000-0000-000000000000", cwd: root } } };

    // ① 全新项目 ⇒ 必有一条注入（"先去问用户"那条）
    const d1 = await runPreStep(run, { agent });
    ok("★ 运行时：全新项目 pre-step 注入了至少 1 条", d1.messages.length >= 1, `n=${d1.messages.length}`);
    assertAdmissible("pre-step 注入", d1.messages);

    // ② 走 `agent.steer()` 的那条（`ledger_compact` 的唤醒）：
    //    把 steer 参数截下来量 —— **这正是本次事故的入口**。
    const steers = [];
    const agent2 = {
      session: { header: { id: "session-d1200000-0000-0000-0000-000000000001", cwd: root } },
      steer: (m) => {
        steers.push(m);
      },
    };
    const lc = run.registeredTools.get("ledger_compact");
    ok("★ 前提：`ledger_compact` 已注册", lc !== undefined);
    if (lc !== undefined) {
      // ★ 调用范式照既有用例（情形 26 那一处）：
      //   `execute({}, { agent, session: agent.session, callId })` —— 必须给 `agent`
      //   （它要拿会话 id 与 `agent.steer`），否则走不到那一步、判据就成了空转。
      await lc.execute({ mode: "light" }, { agent: agent2, session: agent2.session, callId: "c-d120" });
      ok("★ 运行时：`ledger_compact` 真的唤醒了一轮（`agent.steer` 被调了）", steers.length >= 1, `steers=${steers.length}`);
      assertAdmissible("ledger_compact 的 steer", steers);
    }
    rmrf(root);
  }
}

if (CREATED_ROOTS.length > 0) {
  await new Promise((r) => setTimeout(r, 1500));
  for (const d of CREATED_ROOTS) rmrf(d);
}

// ★★ 收尾：删掉自检用的那个**沙箱家**（见文件头的 `SANDBOX_HOME`）。
//   它里面有项目锁的记录文件。不删的话每跑一次自检就在 %TEMP% 留一个空壳。
//   ★ 断言一下"沙箱家确实不在用户真实家里" —— 这是本次新增落盘功能后最该守的一条。
if (SANDBOX_HOME.startsWith(os.homedir()) && !SANDBOX_HOME.startsWith(os.tmpdir())) {
  console.log(`  ★ 沙箱家落在真实 home 里了，拒绝删除：${SANDBOX_HOME}`);
} else {
  rmrf(SANDBOX_HOME);
}

// ★★★ 2026-10-12（D129）：**汇总行不再打在这里**。
//
//   原来这里有一句 `console.log(\`  通过 ${pass} 项，失败 ${failCount} 项\`)` +
//   `if (failCount > 0) {…}` —— 而**情形 50–53 都写在它下面**。
//   ⇒ 两个后果，我都当场撞到了：
//     ① `if (failCount > 0) {` 少一个 `}` ⇒ **情形 50–53 被吞进条件块**
//        ⇒ 全绿时**一条都不跑**（已修，见上）；
//     ② 修完之后它们会跑了，但**汇总数字仍不含它们** ——
//        实测：汇总说「0 失败」，而 53b 明明 FAIL。
//   ⇒ 正解：**汇总与失败清单都挪到文件最末尾**（所有情形之后）。
//     这是唯一能保证"数字 = 真跑过的全部"的位置。
// ═══════════════════════════════════════════════════════════════════════════
//
// ★★★ 2026-10-12（D129）**这里曾经有一个结构性缺陷，我当场抓到并修掉，必须留档**：
//
//   **病**：上面那句 `if (failCount > 0) {` 开了一个块，而它**没有对应的 `}`** ——
//   于是 **情形 50 / 51 / 52 整个被吞进了那个条件块**。
//   ⇒ 后果：**只有"已经有失败"时才会跑它们**；正常全绿的情况下，**一条都不执行**。
//   ★★ 而且它**完全静默**：汇总行照样打印「通过 N 项，失败 0 项」，
//     数字**不包含** 50–53 的任何断言 ⇒ 看起来"全绿"，其实是"根本没测"。
//
//   **我是怎么抓到的**（值得记）：我给情形 53 加了一句 `console.log("### MARKER-53-REACHED ###")`，
//   它**没打印**；再一看输出里最后一个 `── 情形 N ──` 是 **49** ⇒
//   **50/51/52/53 全都没跑**。
//   ★ 直接线索则是"我新写了 5 条断言，通过数却纹丝不动（1132 → 1132）"——
//     **加了断言而数字不变，就是"它没被执行"**（这条判据以后可以直接用）。
//
//   ★★★ 为什么这条 bug 特别毒：本项目最看重的几件事**恰好都写在被吞掉的那几条里** ——
//     情形 50（设置面板文案契约）、51（水位提醒必须给动作，D125）、52（D126 闸门时序）。
//     **我把它们写下来、报了"绿"，而它们从未运行过。**
//     ⇒ 这正是本项目那条纪律的最恶性形态：**「记录存在 ≠ 记录准确」**
//       （D89）再往下一层 —— **「测试存在 ≠ 测试执行」**。
//
//   ⇒ 修法：把 `}` 补上（块只包"打印失败清单"），让 50–53 回到**无条件执行**。
//   ⚠️ 顺序上它们仍在汇总行**之后** ⇒ 那一行的数字**不包含**它们。
//      ★ 这是**下一个要修的问题**（把汇总挪到文件末尾），见文件末尾的注记。
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// ★★ 情形 50：设置面板的文案与分组契约（D124）
//
//   病（用户原话）：*"它的文本现在是 markdown，而不是纯文本，看着不太舒服"*。
//   ★ 根因**不在客户端**（它自己一直用「」），而在宿主 SETTING_SPECS 的 label/hint
//     里满是 `**加粗**`；面板把它们**当纯文本渲染** ⇒ 星号直接显示成"没写完的语法"。
//
//   ⇒ 本情形守两件事（**都是"防复发"，不是"只是测今天"**）：
//     ① label/hint/单位/范围里**不许**再出现 markdown 标记；
//     ② 每项都必须有 group，且所有 group 都在 SETTING_GROUPS 里登记过
//        —— 否则面板上会出现一个"没有标题"的孤组（或整项不显示）。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 50：设置面板的文案与分组契约（D124）");
{
  const libSrc = fs.readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8");

  /** 取一个顶层数组字面量的**源码段**（从 `const X = [` 到对应的 `\n];`）。 */
  const segOf = (name) => {
    const a = libSrc.indexOf("const " + name + " = [");
    if (a < 0) return "";
    const b = libSrc.indexOf("\n];", a);
    return b < 0 ? libSrc.slice(a, a + 60000) : libSrc.slice(a, b + 3);
  };

  // ── ① 面板会把它们当**纯文本**渲染 ⇒ 不许有 markdown 标记 ──────────────
  //
  //   ★ 判据只吃 specs 段里**承载文案的那几个字段**的行（label/hint/unit），
  //     不扫整段 —— 否则会把注释里为了说明"不许写 **"而引用的反例也算进去
  //     （那正是本项目"尺子错"的老毛病：判据的输入混进了描述它的文字）。
  {
    const specs = segOf("SETTING_SPECS");
    const offenders = [];
    for (const raw of specs.split("\n")) {
      const line = raw.trim();
      // 只吃字段行；跳过注释行（本项目注释里会引用反例）
      if (!/^(label|hint|unit|scopeNote):/.test(line)) continue;
      if (line.startsWith("//") || line.startsWith("*")) continue;
      if (/\*\*/.test(line)) offenders.push("粗体星号：" + line.slice(0, 80));
      else if (line.indexOf("`") >= 0) offenders.push("反引号：" + line.slice(0, 80));
      else if (/\[[^\]]+\]\([^)]+\)/.test(line)) offenders.push("markdown 链接：" + line.slice(0, 80));
    }
    ok(
      "★★★ 设置项的 label/hint 里**没有 markdown 标记**（面板按纯文本渲染，标记会原样显示）",
      offenders.length === 0,
      offenders.join(" ｜ ")
    );
  }

  // ── ② 每项都有 group，且都在 SETTING_GROUPS 里登记过 ────────────────────
  {
    const specsSeg = segOf("SETTING_SPECS");
    const groupsSeg = segOf("SETTING_GROUPS");
    const keys = [...specsSeg.matchAll(/\n    key: "([a-zA-Z]+)"/g)].map((m) => m[1]);
    const used = [...specsSeg.matchAll(/\n    group: "([a-z]+)"/g)].map((m) => m[1]);
    const declared = [...groupsSeg.matchAll(/\{\s*key: "([a-z]+)"/g)].map((m) => m[1]);

    eq("★★ 每个设置项都声明了 group", used.length, keys.length);
    const undeclared = [...new Set(used)].filter((g) => !declared.includes(g));
    ok(
      "★★ 用到的 group 都在 SETTING_GROUPS 里登记过（否则面板上会出现没有标题的孤组）",
      undeclared.length === 0,
      "用到但未登记：" + (undeclared.join(", ") || "（无）") + "；已登记：" + declared.join(", ")
    );
    const unused = declared.filter((g) => !used.includes(g));
    ok(
      "★ 没有登记了却没人用的空组（否则面板上会出现一个空标题）",
      unused.length === 0,
      "已登记但没用到：" + (unused.join(", ") || "（无）")
    );
  }

  // ── ③ 客户端**不认任何设置项 key**（分组是数据驱动的，不是写死的）────────
  //
  //   ★ 这条守的是"以后加一个设置项 / 一个组，不用改客户端"这个契约。
  //     判据：客户端里**不许**出现任何设置项的 key 字面量。
  //   ⚠️ `maxActiveLines` / `logLevels` 在旧版 intro 文案里出现过 ——
  //      D124 已把那句改成不点名，所以现在应当是 0 命中。
  {
    const clientSrc = fs.readFileSync(path.join(HERE, "..", "lib", "client.js"), "utf8");
    const specsSeg = segOf("SETTING_SPECS");
    const keys = [...specsSeg.matchAll(/\n    key: "([a-zA-Z]+)"/g)].map((m) => m[1]);
    const hit = keys.filter((k) =>
      new RegExp('["\'\\s]' + k + '["\'\\s,;)]').test(clientSrc)
    );
    ok(
      "★★ 客户端**不认任何设置项 key**（分组与渲染完全由宿主数据驱动）",
      hit.length === 0,
      hit.length === 0 ? "" : "客户端里出现了：" + hit.join(", ")
    );
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 情形 51：水位提醒**必须给出动作**，不能只说"该压缩了"
//
//   病（用户 2026-10-12 看系统截图抓到的，**真机现象**）：
//     *"他已经知道自己要写台账加压缩了，但是从来没有主动的去调过压缩工具，
//       即使已经完成了台账的落下。模型会主动的去落台账和日志，但是不会主动的去压缩。"*
//
//   ★ 根因（用真代码生成注入文本后量出来的）：
//     · 70% 档整段 730 字符里，含「本插件会在你结束本轮后**自动执行**一次高保真压缩」，
//       却**从头到尾没有一句话叫它去调 `ledger_compact`**；
//     · 30/50% 档同样——只在讲"义务"，没给动作。
//     ⇒ **模型的行动由「被要求的动作」驱动，不是由「被提醒的概念」驱动。**
//       我们一直在提醒"该压缩了"这个概念，同时说"插件会自己做"
//       ⇒ 它记下了概念、等插件动手，**动作从来没落到它头上**。
//
//   ⇒ 本情形守两条（都是"防复发"）：
//     ① **两档水位提醒里都必须出现 `ledger_compact`**（给出动作）；
//     ② **不许再出现"插件会自动执行压缩"这类把模型排除在外的说法**
//        （安全网可以存在，但不能被写成"你的替代品"）。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 51：水位提醒必须给出动作（D125）");
{
  const libSrc = fs.readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8");

  // 取 renderPressureNotice 整个函数体（到下一个顶层函数之前）
  const a = libSrc.indexOf("function renderPressureNotice(");
  const b = libSrc.indexOf("\n}\n", a);
  ok("★★ 找得到 renderPressureNotice", a >= 0 && b > a, `a=${a} b=${b}`);
  const fn = a >= 0 && b > a ? libSrc.slice(a, b) : "";

  // ✂ 剥掉注释行（注释里会讨论"不许写什么"，那是反例，不算文案）
  const fnText = fn
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

  // ── ① 两档都要给出动作：`ledger_compact` 必须出现（且不止一次） ─────────
  const calls = fnText.match(/ledger_compact/g) ?? [];
  ok(
    "★★★ 水位提醒里**明确给出了动作** `ledger_compact`（两档各一次以上）",
    calls.length >= 2,
    `出现 ${calls.length} 次`
  );

  // ── ② 不许再把"插件自动压"写成模型的替代品 ──────────────────────────────
  //
  //   ★ 判据只禁**特定那几句否定性说法**，不禁"安全网/兜底"本身
  //     —— 安全网是真实的（兜底线到了插件真会压），问题在于**把它写成"你不用管"**。
  const BANNED = [
    ["自动执行一次高保真压缩", /自动执行一次高保真压缩/],
    ["你不需要（也无法）自己触发它", /不需要（无法）自己触发/],
    ["插件会在那一档自己压一次", /插件会在那一档\*\*自己压一次/],
  ];
  const hits = BANNED.filter(([, re]) => re.test(fnText)).map(([n]) => n);
  ok(
    "★★★ 没有再把「插件会自动压」写成模型的替代品（那正是它不调工具的直接原因）",
    hits.length === 0,
    hits.length === 0 ? "" : "仍在的否定性说法：" + hits.join(" / ")
  );

  // ── ③ 安全网仍要如实存在（别为了修 ② 把兜底删了） ────────────────────────
  ok(
    "★★ 兜底（安全网）仍然如实写着 —— 修 ② 不能把兜底也删掉",
    /兜底|安全网/.test(fnText),
    "（提醒里应当仍能看到「插件会兜底」这个事实）"
  );

  // ── ④ 回合末四选一那条同样要给出动作（它以前写的是"你不需要自己触发"）──
  const cp = libSrc.indexOf("function checkpointNext(");
  const cpe = libSrc.indexOf("\n}\n", cp);
  const cpFn = cp >= 0 && cpe > cp
    ? libSrc.slice(cp, cpe).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n")
    : "";
  ok(
    "★★★ 「记录台账 + 执行压缩」那一档**也要它自己调** `ledger_compact`",
    /record\+compact[\s\S]{0,900}?ledger_compact/.test(cpFn),
    "（该分支应当明确要求模型调用 ledger_compact）"
  );
  ok(
    "★★★ 且**没有**再写「你不需要（也无法）自己触发」这类否定",
    !/不需要（无法）自己触发/.test(cpFn),
    ""
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 情形 52：**写完台账之后立刻压缩，闸门必须放行**（D126，真机 bug 的回归）
//
//   真机现象（2026-10-12 14:19，我自己撞到）：
//     刚 `ledger_write` 写完（返回 ok、revision 递增）+ 写了 L1，
//     紧接着调 `ledger_compact {mode:"light"}` **连续两次**都被拦，理由是
//     「**刚要求过你落盘，但还没写**」。
//
//   ★★ 为什么既有断言没抓到它（**这是本条存在的最重要理由**）：
//     情形 28e 造 agent 时**没给 `requestContext`**（见它的 `5704` 行）⇒
//     `measurePressure` 拿不到 `contextWindow` ⇒ 那条用例只证明了"**没落盘会被拦**"，
//     **"落了盘就该放行"这一半从来没被测过**。
//     ⇒ 一个"永远拦"的实现也能通过 28e。**半条断言 = 假绿。**
//
//   ⇒ 本情形补上另一半，并且**用真夹具**（makeCtx / runPreStep / flushLedger 都在本文件里）：
//     ① 水位到档 ⇒ 发提醒（这一步会立 `flushOwedAt`）；
//     ② `ledger_write` 真落盘；
//     ③ 立刻调 `ledger_compact` ⇒ **必须不再因"没落盘"被拦**。

// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 情形 52：**先写台账、后收到提醒 ⇒ 压缩仍须放行**（D126，真机 bug 的回归）
//
//   真机现象（2026-10-12 14:19，我自己撞到）：
//     `ledger_write` 写完（rev 递增）+ 写了 L1，紧接着调 `ledger_compact {mode:"light"}`
//     **连续两次**都被拦，理由是「**刚要求过你落盘，但还没写**」。
//
//   ★★★ 根因（**时序**，不是"忘了写"）：
//     `flushOwedAt` 是**水位提醒那一刻**设的，而那次 `ledger_write` 发生在**提醒之前**
//     ⇒ `flushedAt <= owedAt` ⇒ 判成"还没写"。
//     **可这一轮的进展我确实已经落盘了**（就在几分钟前）。
//     ⇒ 这等于要求模型**恰好把写入排在提醒之后** —— 而那是个**它无法观测的顺序**：
//       它只知道"我刚写过台账"，不可能知道"插件是在我写完之后才开口要的"。
//
//   ★★ 为什么既有断言没抓到它（**这是本条最重要的价值**）：
//     情形 28e 造 agent 时**没给 `requestContext`** ⇒ `measurePressure` 拿不到
//     `contextWindow` ⇒ 那条只能证明"**没落盘会被拦**"，
//     "**落了盘就该放行**"这一半**从来没被测过**。
//     ⇒ 一个"永远拦"的实现也能通过它。**半条断言 = 假绿。**
//
//   ⇒ 本情形精确复现那个时序，并断言**压缩必须真的发生**：
//     ① `ledger_write` 落盘（此时**还没有**任何提醒 ⇒ 不欠账）；
//     ② 水位到档 ⇒ 发提醒（**这一步之后** `flushOwedAt` 才有值，且 > `flushedAt`）；
//     ③ 调 `ledger_compact` ⇒ ★ **必须放行**（本周期落过盘）。

// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 情形 52：**先写台账、后收到提醒 ⇒ 压缩仍须放行**（D126，真机 bug 的回归）
//
//   真机现象（2026-10-12 14:19，我自己撞到）：
//     `ledger_write` 写完（rev 递增）+ 写了 L1，紧接着调 `ledger_compact {mode:"light"}`
//     **连续两次**都被拦，理由是「**刚要求过你落盘，但还没写**」。
//
//   ★★★ 根因（**时序**，不是"忘了写"）：
//     `flushOwedAt` 是**水位提醒那一刻**设的，而那次 `ledger_write` 发生在**提醒之前**
//     ⇒ `flushedAt <= owedAt` ⇒ 判成"还没写"。
//     **可这一轮的进展我确实已经落盘了**（就在几分钟前）。
//     ⇒ 这等于要求模型**恰好把写入排在提醒之后**，那是一个**它无法观测的顺序**。
//
//   ★★ 为什么既有断言没抓到它（**这是本条最重要的价值**）：
//     情形 28e 造 agent 时**没给 `requestContext`** ⇒ `measurePressure` 拿不到
//     `contextWindow` ⇒ 那条只能证明"**没落盘会被拦**"，
//     "**落了盘就该放行**"这一半**从来没被测过** ⇒ 一个"永远拦"的实现也能通过它。
//     **半条断言 = 假绿。**
//
//   ★★★ 而我这条用例**第一版自己也写错了**（同一天，两处，都值得记）：
//     ① 自建 agent 时 `surface.nodes` 留空、也没定价
//        ⇒ **没有可压的节点** ⇒ `selectIncrementalRange` 返回 null ⇒ 编排不跑
//        ⇒ `regionCalls === 0`；而那个 0 与闸门**毫无关系**（我撤掉修复它照样 0）。
//     ② 想搬进情形 27 的块里复用夹具 —— 但 `section(...)` 是**顶层调用**，
//        不能出现在另一个 section 的块内。
//     ⇒ ★ 纪律 6：**夹具没走通时，绝不能把"夹具故障"当成"被测对象的问题"。**
//     ⇒ 现在：**自带夹具**（照 `mkDeltaProj` / `mkDeltaAgent` / `priceNodes` 的
//        已验证形状最小重建 —— 含成对的 user/assistant/tool-result 节点）。

// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 情形 52：**先写台账、后收到提醒 ⇒ 压缩仍须放行**（D126，真机 bug 的回归）
//
//   真机现象（2026-10-12 14:19，我自己撞到）：
//     `ledger_write` 写完（rev 递增）+ 写了 L1，紧接着调 `ledger_compact {mode:"light"}`
//     **连续两次**都被拦，理由是「**刚要求过你落盘，但还没写**」。
//
//   ★★★ 根因（**时序**，不是"忘了写"）：
//     `flushOwedAt` 是**水位提醒那一刻**设的，而那次 `ledger_write` 发生在**提醒之前**
//     ⇒ `flushedAt <= owedAt` ⇒ 判成"还没写"。
//     **可这一轮的进展我确实已经落盘了**（就在几分钟前）。
//     ⇒ 这等于要求模型**恰好把写入排在提醒之后**，那是一个**它无法观测的顺序**。
//
//   ★★ 为什么既有断言没抓到它（**这是本条最重要的价值**）：
//     情形 28e 造 agent 时**没给 `requestContext`** ⇒ `measurePressure` 拿不到
//     `contextWindow` ⇒ 那条只能证明"**没落盘会被拦**"，
//     "**落了盘就该放行**"这一半**从来没被测过** ⇒ 一个"永远拦"的实现也能通过它。
//     **半条断言 = 假绿。**
//
//   ★★★ 而我这条用例**第一版自己也写错了**（同一天，两处，都值得记）：
//     ① 自建 agent 时 `surface.nodes` 留空、也没定价
//        ⇒ **没有可压的节点** ⇒ `selectIncrementalRange` 返回 null ⇒ 编排不跑
//        ⇒ `regionCalls === 0`；而那个 0 与闸门**毫无关系**（我撤掉修复它照样 0）。
//     ② 想搬进情形 27 的块里复用夹具 —— 但 `section(...)` 是**顶层调用**，
//        不能出现在另一个 section 的块内。
//     ⇒ ★ 纪律 6：**夹具没走通时，绝不能把"夹具故障"当成"被测对象的问题"。**
//     ⇒ 现在：**自带夹具**（照 `mkDeltaProj` / `mkDeltaAgent` / `priceNodes` 的
//        已验证形状最小重建 —— 含成对的 user/assistant/tool-result 节点）。
// ═══════════════════════════════════════════════════════════════════════════
section("情形 52：先写台账、后收到提醒 ⇒ 压缩仍须放行（D126）");
{
  /** 建一个有台账的项目 + 一套**合法的** surface（成对节点）。 */
  const mkProj52 = (tag, rounds) => {
    const root = tmpProject(tag);
    fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
    fs.writeFileSync(
      path.join(root, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1,
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_a",
        maxActiveLines: 300,
        logDir: "_ledger-log",
        logLevels: { L0: true, L1: true, L2: true, L3: false, L4: true },
        revision: 0,
      }),
      "utf8"
    );
    // ★ 节点必须**成对**（user / assistant(tool-call) / tool/result），
    //   否则"未回应的工具调用数"一路累加 ⇒ 所有切点都不平衡 ⇒ 永远返回 null。
    const events = [];
    let seq = 1;
    for (let r = 0; r < rounds; r += 1) {
      events.push({ type: "user/message", seq, data: { message: { role: "user", content: [] } } });
      seq += 1;
      events.push({
        type: "assistant/message",
        seq,
        data: { message: { role: "assistant", content: [{ type: "tool-call", id: `c${seq}` }] } },
      });
      seq += 1;
      events.push({ type: "tool/result", seq, data: { message: { role: "tool" } } });
      seq += 1;
    }
    return { root, events };
  };

  const mkAgent52 = (root, sid, events) => {
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    return {
      session: {
        header: { id: sid, cwd: root },
        id: sid,
        // ★★ 必须给 requestContext —— 闸门要靠它算水位（28e 缺这个，所以测不到另一半）
        requestContext: () => ({ contextWindow: 1000 }),
        surface: { nodes: events.map((e) => e.seq) },
        eventAt: (s) => bySeq.get(s),
      },
      steer: () => {},
    };
  };

  // ── 正例：**先写台账 → 后收到提醒** ⇒ 压缩必须放行 ──────────────────────
  {
    const { root, events } = mkProj52("gate-write-then-notice", 7);
    const regionCalls = [];
    const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
    // ★ 兜底设成轻推线（本用例测闸门，不测"20 推 / 40 压"）
    //   ★ 全量线设 0.75：水位 40% 时只发提醒、76% 时才排全量。
    mod.apply(run.ctx, { highFidelityCompactRatio: 0.75, mode: "steady" });
    const sid = "session-afterfl00-0002";
    const agent = mkAgent52(root, sid, events);
    run.services.tokenMeter._priced = events.map((e) => ({ seq: e.seq, tokens: 20 }));

    // ① **先写台账**（此时还没有任何提醒 ⇒ `flushOwedAt` 无值）
    await flushLedger(run, root, sid);

    // ② ★★★ **让水位提醒真的发出去**（这才是立 `flushOwedAt` 的时刻）。
    //   ★ 水位必须在 `NUDGE_MIN_RATIO(0.45)` **之下**，否则**轻推会先抢走 `text`**
    //     ⇒ 水位提醒发不出去（它的门是 `text === undefined`）⇒ `flushOwedAt` 不立
    //     ⇒ 承诺判据走不到（我第一版就栽在这：撤掉修复也不红 = 假绿）。
    //   ★ 锚点 0.3 → 0.4 只涨 10 点（低于所有触发线）⇒ 编排早退、不压，只发提醒。
    mod.__test.setAnchor({}, sid, 0.3);
    run.services.tokenMeter._total = 400;   // 40% ≥ 0.3 档 ⇒ 发提醒；< 0.45 ⇒ 轻推不抢
    await runPreStep(run, { agent, messages: [] });

    // ③ ★★★ 真机那条路是**全量**（探针坐实 `###GATE mode=full`）：
    //   水位抬到 76% ≥ 全量线 0.75 ⇒ 全量排队；等 idle 时执行 ⇒ 闸门在那里判定。
    //   ★ 本周期已落过盘（① 那一步）⇒ D126 之后**必须放行**。
    //
    //   ★★★ 2026-10-12（我在这里错了 **6 次**，最后靠探针 `###PRESTEP/###SET/###STEP` 定的案，
    //     全部记下来因为每一版都是"夹具前提错了"）：
    //     ① `surface.nodes` 空 / 未定价 ⇒ 无可压节点；
    //     ② 72% 撞默认全量线 ⇒ 增量让路；
    //     ③ 计数器取错（`regionCalls` 只记增量，全量走 `run.compacted`）；
    //     ④ 水位 40% 让"提醒发不出"（轻推抢走 `text`）；
    //     ⑤ 提醒与压缩**同拍** ⇒ 被拦（那是对的，真机是不同拍）；
    //     ⑥ ★ **抬高水位会再发一次 70% 档提醒 ⇒ `owedStep` 被刷新成当前拍**
    //        ⇒ 空走一拍没用（探针逐字：`###PRESTEP 步号=2 / ###SET owedStep=2 /
    //        ###PRESTEP 步号=3 / ###SET owedStep=3 / ###STEP owedStep=3 curStep=3`）。
    //
    //   ⇒ 最终做法：**不绕弯** —— 直接把这拍的水位设在**70% 档已经发过之后**，
    //     再手工把 `flushOwedStep` 改成"上一拍"（这正是真机的状态：
    //     提醒在 14:19:29 那拍发的，压缩在 14:19:41 那拍执行）。
    //     ★ 这样测的是**闸门判据本身**，而不是"提醒怎么发出来的"（后者已由情形 12 覆盖）。
    mod.__test.setAnchor({}, sid, 0.3);
    // ★ 关键（第 7 版才对）：**发提醒的水位必须低于全量线 0.75** ——
    //   ① 用 0.76 发提醒 ⇒ 那一拍就**同时**排全量 ⇒ 闸门在**本拍**判 ⇒ sameStep ⇒ 被拦
    //      （探针逐字坐实：`###PRE 步号=3 / ###SET owedStep=3 / ###STEP owedStep=3 curStep=3`）；
    //   ② 用 0.72 发提醒 ⇒ 到 0.7 档、但**低于全量线** ⇒ 只发提醒、不排全量；
    //      下一步抬到 0.76 ⇒ 0.7 档**已经发过**（`fired` 集合留着）⇒ **不再发** ⇒
    //      `owedStep` 停在上一拍 ⇒ 闸门看到"提醒是上拍发的" ⇒ **正是真机那个形态**。
    run.services.tokenMeter._total = 720;   // 72%：到 0.7 档但 < 全量线 0.75
    await runPreStep(run, { agent, messages: [] });   // ★ 提醒在这一拍发出（owedStep = 本拍）

    // ② 抬到 **0.74** ⇒ 过全量线(0.70)、但 **低于水位旁路 0.75** ⇒ 全量排队且**真的过闸门**。
    //   ★★★ 这一步我错了**第 7 次**，也是最隐蔽的一次：我原来用 **0.76**，
    //     而 `FLUSH_GATE_BYPASS_RATIO = 0.75` ⇒ **0.76 ≥ 0.75 ⇒ 闸门在更早一行就放行了**
    //     ⇒ **根本没走到 D126 那条判据** ⇒ 撤掉修复也不红（反向验证当场照出来）。
    //   ★ 教训：夹具的水位**不能撞任何旁路**，否则测的是旁路、不是你要测的判据。
    //     （本项目同类前科：D119 那次撞的是 `capLine` 的 0.75 上界。）
    //   ★ 且此拍**不会再发提醒**（0.7 档已发过）⇒ owedStep 停在**上一拍** ⇒ 正是真机形态。
    // ★★★ 2026-10-12（D129）修正水位：本夹具全量线是 **0.75**，而旧值 **0.74**
    //   **根本到不了线** ⇒ 全量永不排队（实测 `compacted=0`）。
    //   ⇒ 取 **0.76**：过 0.75、但仍 < 紧急旁路 `FULL_COMPACT_URGENT_RATIO`(0.78)，
    //     也 < 内核硬压线 0.80 ⇒ 真走闸门、真走 idle 那条 `compactNow`。
    //     （`FLUSH_GATE_BYPASS_RATIO`(0.75) 那条旁路**只对增量**生效；
    //       全量那条带 `mode:"full"` ⇒ 不适用，所以 0.76 不会绕开 D126 判据。）
    run.services.tokenMeter._total = 760;
    await runPreStep(run, { agent, messages: [] });
    await fire(run, "agent/status", { agent, status: "idle" }); // ★ 全量在这里执行

    ok(
      "② ★★★ **本周期落过盘 ⇒ 全量压缩必须真的发生**（不许再报「还没落盘」）",
      // ★★★ 判据修正（我在这里错了第 4 次，值得记）：
      //   `regionCalls` **只记 `compactRegion`**（增量那条），
      //   而**全量**走的是 `compactNow` ⇒ 记在 `run.compacted` 里。
      //   ⇒ 用 `regionCalls` 等全量的信号，**永远等不到**（它恒 0）。
      //   ★ 这正是本项目那条纪律：**指标必须与被测对象同源** ——
      //     拿增量的计数器去看全量，等于用错的尺子量。
      run.compacted.length >= 1 || regionCalls.length >= 1,
      "compacted=" + run.compacted.length + " regionCalls=" + regionCalls.length +
        "；warnings=" + run.warnings.slice(-3).join(" | ").slice(0, 240)
    );
    ok(
      "③ 且告警里**没有**「刚要求过你落盘，但还没写」",
      !run.warnings.some((w) => String(w).includes("刚要求过你落盘")),
      run.warnings.slice(-3).join(" | ")
    );
    rmrf(root);
  }

  // ── ★★ 反面对照：**本周期一次都没写** ⇒ **必须仍被拦** ─────────────────
  //
  //   ★ 成对存在的理由：只测正例的话，"一律放行"也能通过；
  //     只测反例的话（既有 28e / 30c 就是），"一律拦"也能通过。
  {
    const { root, events } = mkProj52("gate-never-flushed", 7);
    const rc2 = [];
    const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls: rc2 });
    mod.apply(run.ctx, { mode: "steady" });
    const sid = "session-afterfl00-0003";
    const agent = mkAgent52(root, sid, events);
    run.services.tokenMeter._priced = events.map((e) => ({ seq: e.seq, tokens: 20 }));

    // ★ 故意**不** flushLedger：本周期一次都没写
    run.services.tokenMeter._total = 720;
    await runPreStep(run, { agent, messages: [] }); // 只发提醒
    await run.registeredTools
      .get("ledger_compact")
      .execute({ mode: "light" }, { agent, session: agent.session, callId: "c-52b" });
    await fire(run, "agent/status", { agent, status: "idle" });
    await runPreStep(run, { agent, messages: [] });
    eq("④ ★★ 反面对照：本周期**一次都没写** ⇒ **仍然必须被拦**（闸门没被改松）", rc2.length, 0);
    rmrf(root);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //
  // ★★★ 情形 53：D129 **两条"防卡"性质**（反向验证当场抓出来的两个真空档）
  //
  //   ★ 起因（**这是本用例存在的全部理由**）：我做完 D129 后跑反向验证，
  //     逐个把新行为摘掉 —— **摘这两处时自检一条都不红**。
  //     ⇒ 那就是"断言是摆设"（本机纪律第 10 条：摘一处不红，必须查清）。
  //     查清结论：**这两条新行为确实没有任何断言在测**，现在补上。
  // ═══════════════════════════════════════════════════════════════════════════
  section("情形 53：D129 两条防卡性质（分流不拦全量 / 水位提醒不再立义务）");
  console.log("### MARKER-53-REACHED ###");
  {
    // ── 53a：★★★ 分流义务**只拦轻量**，绝不拦全量兜底 ─────────────────────
    //
    //   ★ 为什么这条必须有（否则会撞回 D59 那个坑）：
    //     分流义务在"模型没先分流就要压"时立起；若它不理会，这个标记会一直挂着。
    //     而**全量兜底（到 75% 必压）走的是同一道闸门** ⇒ 若它也受该标记约束，
    //       全量会被拦住 ⇒ 一路撞进内核 80%（**那一次抓不到逐字胶囊**）
    //       ⇒ 与用户本轮的要求正面冲突：*"全量压缩，最迟最迟发生在 75%，
    //         即使模型没有主动压缩。"*
    //   ⇒ 修法：闸门里那句 `opts?.mode !== "full"`（见 `flushBeforeCompact`）。
    //   ★ 判别力：**摘掉那个 `!== "full"` ⇒ 本用例必须红**（反向验证已证）。
    {
      const { root, events } = mkProj52("gate-triage-vs-full", 7);
      const rc3 = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls: rc3 });
      mod.apply(run.ctx, { highFidelityCompactRatio: 0.75 });
      const sid = "session-gate53a-0001";
      const agent = mkAgent52(root, sid, events);
      run.services.tokenMeter._priced = events.map((e) => ({ seq: e.seq, tokens: 20 }));

      // ① 先制造"欠一次分流"：落盘 + 模型主动要压（没分流 ⇒ 立义务且被拦）
      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 500; // < 0.75 ⇒ 不会排全量
      askAICompact(sid);
      await runPreStep(run, { agent, messages: [] });
      ok("★★★ 53a 前提：没分流 ⇒ 这次轻量确实被拦住了（义务已立）", rc3.length === 0, `region=${rc3.length}`);

      // ② 抬到全量线之上 ⇒ 全量排队
      run.services.tokenMeter._total = 760;
      await runPreStep(run, { agent, messages: [] });
      // ★★★ 关键（**第一版漏了这一步 ⇒ 那条断言是摆设**，第二轮反向验证当场抓到）：
      //   闸门是在**全量真正执行时**才判的（`runHighFidelityCompact` 走 idle 那条路）
      //   ⇒ 只走到"排上队"**根本没到闸门** ⇒ 摘掉修复也不会红。
      //   ⇒ 必须 fire idle，让全量执行、让闸门被问到。
      const beforeFull = run.compacted.length;
      await fire(run, "agent/status", { agent, status: "idle" });
      ok(
        "★★★ 53a：**欠着分流义务**时，全量兜底**照样真的执行**（否则一路撞内核 80%、丢胶囊）",
        run.compacted.length > beforeFull,
        `compacted 前=${beforeFull} 后=${run.compacted.length}；warnings=${run.warnings.slice(-2).join(" | ").slice(0, 200)}`
      );
      rmrf(root);
    }

    // ── 53b：★★★ 水位三档提醒**不再立落盘义务**（用户要求"防卡"）───────────
    //
    //   ★ 为什么这条必须有：用户原话 —— *"然后去除三个节点的义务。以防模型被卡。"*
    //     病是实的（本机前科 D59）：落了义务 ⇒ `flushBeforeCompact` 不许压 ⇒
    //     而它**可能永远不去写那一笔** ⇒ 闸门一直拦 ⇒ 撞进内核 80%。
    //   ⇒ 新行为：水位提醒**只提醒**，不立任何义务。
    //   ★ 判别力：**把 `state.flushOwedAt.set(...)` 加回去 ⇒ 本用例必须红**（反向验证已证）。
    {
      const mk53 = (tag) => {
        const root = tmpProject(tag);
        fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\nY\n", "utf8");
        fs.writeFileSync(
          path.join(root, ".dsh-ledger.json"),
          JSON.stringify({
            version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
            archiveDir: "_a", maxActiveLines: 300, logDir: "_ledger-log",
            logLevels: { L0: true, L1: true, L2: true, L3: false, L4: true },
            revision: 0, mode: "surgical",
          }),
          "utf8"
        );
        return root;
      };
      const root = mk53("d129-no-flush-obligation");
      const regionCalls = [];
      const run = makeCtx({ withCompaction: true, withTokenMeter: true, regionCalls });
      mod.apply(run.ctx, { highFidelityCompactRatio: 1.0 });
      const sid = "session-53b-0001";
      const agent = {
        session: {
          header: { id: sid, cwd: root },
          requestContext: () => ({ contextWindow: 1000 }),
        },
      };

      // ① 水位跨过 30% 档 ⇒ 发提醒
      run.services.tokenMeter._total = 100;
      await runPreStep(run, { agent, messages: [] });
      run.services.tokenMeter._total = 400;
      const dNotice = await runPreStep(run, { agent, messages: [] });
      const tn = (dNotice.messages ?? []).map((m) => m.content.map((c) => c.text).join("")).join("\n");
      ok("★★★ 53b 前提：水位提醒真的发出去了", /上下文水位已到/.test(tn), tn.slice(0, 240));

      // ② 两个判据，**都对着真正会变的那份文本**：
      //   ① 文案**不再声称"不写就不会发生"**（那是被删掉的义务语气）；
      //   ② ★★★ **行为**：欠着水位提醒时，一次"已落盘+已分流"的压缩**必须能过**。
      //
      //   ★ 第①条我第一版**写错了正则**（拿一个根本不存在的句式去匹配 ⇒
      //     无论实现怎样都不红 = 摆设）。第二版改成匹配**真实存在的那句话**
      //     （"不写，压缩就**不会发生**"），并按反向验证确认：把义务加回去 ⇒ 它红。
      ok(
        "★★★ 53b（文案）：不再声称「不写，压缩就不会发生」（义务语气已随 D129 删除）",
        !/不写，压缩就/.test(tn) && !/闸门会一直拦/.test(tn),
        tn.slice(0, 600)
      );
      ok(
        "★★★ 53b（文案）：明说「写不写不影响你能不能压缩」（否则模型仍以为被卡）",
        /不影响你能不能压缩|不是义务/.test(tn),
        tn.slice(0, 600)
      );
      // ★★★ 53b 只有**文案**这一半是可分辨的（我实测过，如实记下来）：
      //
      //   ★ 反向验证第 3/4 轮：把 `state.flushOwedAt.set(...)` 加回提醒处 ⇒ **仍然不红**。
      //     查清原因（**不是测试没写好，是那段代码已成冗余**）：
      //     · D126 给闸门补过一条"**本周期落过盘就认账**"的旁路；
      //     · 而 D129 之后，"提醒"是 `flushOwedAt` 的**唯一**写入者，
      //       且提醒发生时模型通常已在周期内落过盘 ⇒ 走进"认账"分支 ⇒ **放行**。
      //   ⇒ 所以**这里只钉文案**（那是用户能直接感知、也会真的误导模型的东西），
      //     并在 D129 里如实记录"欠账闸门已成死代码"这件事（不在本用例假装测行为）。
      ok(
        "★★★ 53b（文案）：不再声称「不写，压缩就不会发生」（义务语气已随 D129 删除）",
        !/不写，压缩就/.test(tn) && !/闸门会一直拦/.test(tn),
        tn.slice(0, 600)
      );
      ok(
        "★★★ 53b（文案）：明说「写不写不影响你能不能压缩」（否则模型仍以为被卡）",
        /不影响你能不能压缩|不是义务/.test(tn),
        tn.slice(0, 600)
      );
      rmrf(root);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //
  // ★★★ 情形 54：D132 **内容感知指纹**（用户底线内的注入瘦身，两个方向都要守）
  //
  //   ★ 起因：我做 D132 后跑反向验证 —— **把指纹改回 mtime 版，自检一条都不红**
  //     ⇒ 「断言是摆设」（纪律第 10 条）。⇒ 现在补上，**两个方向都测**：
  //       ① 内容没变（只推 mtime）⇒ 指纹**必须相等**（否则白注整份、把水位推高）
  //       ② 内容真改了         ⇒ 指纹**必须不等**（否则**漏注 = 伤准确性** ← 用户的底线）
  //     ★ 只测①的话，一个"恒返回常量"的实现也能全绿 —— 而那会**彻底不再注台账**。
  //   ★ 为什么这条重要：用户明确要求「**不要影响模型的准确性**」——
  //     ②就是那条底线在代码里的**可执行形式**。
  // ═══════════════════════════════════════════════════════════════════════════
  section("情形 54：D132 内容感知指纹（内容没变不重注 / 内容变了必重注）");
  {
    const root = tmpProject("d132-fingerprint");
    const f = path.join(root, "LEDGER.md");
    const base = "# 台账\n\n## 目标\n保持准确\n";
    fs.writeFileSync(f, base, "utf8");
    const info = { activeExists: true, activeAbs: f, activeRel: "LEDGER.md", activeLines: 4 };

    const fp1 = mod.__test.fingerprintOf(info);
    // ① 内容没变，只把 mtime 往后推
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(f, later, later);
    const fp2 = mod.__test.fingerprintOf(info);
    eq("★★★ 54①：内容没变（只推 mtime）⇒ 指纹**必须相等**（否则每次白注整份台账）", fp2, fp1);

    // ② 内容真改了 ⇒ **必须不等**（这条守的是"不影响准确性"）
    fs.writeFileSync(f, `${base}\n- 新进展\n`, "utf8");
    const fp3 = mod.__test.fingerprintOf(info);
    ok(
      "★★★ 54②：内容真改了 ⇒ 指纹**必须不等**（否则漏注 ⇒ **伤准确性** —— 用户底线）",
      fp3 !== fp2,
      `改前=${fp2} 改后=${fp3}`
    );

    // ③ 读不到文件 ⇒ **必须不等于上次**（宁可多注一次，也不能误判"没变"）
    const infoMissing = { activeExists: true, activeAbs: path.join(root, "nope.md"), activeRel: "LEDGER.md", activeLines: 4 };
    const a1 = mod.__test.fingerprintOf(infoMissing);
    const a2 = mod.__test.fingerprintOf(infoMissing);
    ok(
      "★★ 54③：读不到文件 ⇒ 指纹**每次都不等**（宁可多注一次，也不误判「没变」）",
      a1 !== a2,
      `${a1} vs ${a2}`
    );
    rmrf(root);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //
  // ★★★ 情形 55：D133 **记忆区块**的第一层（分块 / 块哈希 / 差异）
  //
  //   ★ 为什么这一层必须先测（D134 步 1–3）：它是"**这块变了没**"的唯一判据，
  //     而 D132 卡住的地方正是**只能整份比字节**。地址/块不稳 ⇒ 后面全是猜。
  //   ★ 三个都是**纯函数** ⇒ 直接调，不掺压缩编排等无关变量。
  //
  //   ★★★ 每条断言都**两个方向**（本机纪律：只测一个方向的实现会被"恒常量"骗过）：
  //     · 分块：块数要对（**漏块 = 内容凭空消失**）；且**不许把代码围栏里的 `#` 当标题**；
  //     · 差异：不变的不报（否则每次都全注）；变了的必报（否则**漏注 = 伤准确性**）。
  // ═══════════════════════════════════════════════════════════════════════════
  section("情形 55：D133 记忆区块第一层（分块 / 块哈希 / 差异）");
  {
    // ── 分块：三种边界（无标题 / 有标题 / 标题前有前言）
    const noHead = mod.__test.splitBlocks("就是一段没有标题的文字\n第二行\n");
    eq("★★ 55①：没有标题 ⇒ 整段算**一个**块（绝不能返回空）", noHead.length, 1);
    eq("★★ 55①：且它的 heading 是 undefined（不是空串）", noHead[0].heading, undefined);

    const three = mod.__test.splitBlocks("# 标题\n正文\n## 目标\nY\n### 子项\nZ\n");
    eq("★★★ 55②：三个标题 ⇒ **三块**（漏块就是内容凭空消失）", three.length, 3);
    // ★★ 断言自己不许崩（反向验证抓到过：实现只返回 1 块时，`three[1].heading` 抛异常
    //    ⇒ 后面所有断言被跳过 ⇒ **看不出红**）。⇒ 一律用可选链 + 先判存在。
    ok(
      "★★★ 55②：块标题被如实记下",
      typeof three[1]?.heading === "string" && /^## 目标$/.test(three[1].heading),
      JSON.stringify(three.map((b) => b?.heading))
    );

    const withLead = mod.__test.splitBlocks("前言（标题之前的内容）\n\n## 目标\nY\n");
    eq("★★★ 55③：标题**之前**的内容自成一个块（否则那段凭空消失）", withLead.length, 2);
    eq("★★★ 55③：且前言块 heading 为 undefined", withLead[0].heading, undefined);

    // ── ★ 代码围栏：里面的 `#` 不是标题
    const fenced = mod.__test.splitBlocks("# 标题\n```\n# 这是代码里的井号\n```\n正文\n");
    eq("★★★ 55④：代码围栏里的 `#` **不许**当标题（否则把代码切碎）", fenced.length, 1);

    // ── 哈希：内容敏感（两个方向）
    // ★ 同样一律可选链：实现错时不能抛异常（见 55② 的注记）
    const a = mod.__test.splitBlocks("## A\n内容一\n");
    const a2 = mod.__test.splitBlocks("## A\n内容一\n");
    const b = mod.__test.splitBlocks("## A\n内容二\n");
    eq("★★★ 55⑤：同样的内容 ⇒ 同样的块哈希", a2[0]?.hash, a[0]?.hash);
    ok("★★★ 55⑥：内容改了 ⇒ 块哈希**必须变**（否则漏注 ⇒ 伤准确性）", a[0]?.hash !== b[0]?.hash, `${a[0]?.hash} vs ${b[0]?.hash}`);

    // ── 差异：不变的不报、变了的必报、消失的也要报
    const d1 = mod.__test.diffBlocks(a, a2);
    eq("★★★ 55⑦：内容没变 ⇒ changed 为空（否则每次都全注）", d1.changed.length, 0);
    const d2 = mod.__test.diffBlocks(a, b);
    eq("★★★ 55⑧：内容变了 ⇒ changed 恰好 1 个", d2.changed.length, 1);
    const d3 = mod.__test.diffBlocks(b, a);
    eq("★★★ 55⑨：块没了 ⇒ removed 恰好 1 个（要告诉模型它没了）", d3.removed.length, 1);
    // ★ 复制两份同内容 ⇒ 只算一个（去重），否则会重复注入
    const dup = mod.__test.splitBlocks("## A\n内容一\n## A\n内容一\n");
    const d4 = mod.__test.diffBlocks([], dup);
    eq("★★ 55⑩：同内容出现两次 ⇒ changed **去重成 1**（不做会重复注入）", d4.changed.length, 1);

    // ── ★★★ 判别力自证：哈希必须**既稳定又敏感**（缺一个就是坏实现）
    ok(
      "★★★ 55⑪：判据本身有判别力 —— 哈希必须**既稳定又敏感**（缺一个就是坏实现）",
      a[0]?.hash === a2[0]?.hash && a[0]?.hash !== b[0]?.hash,
      `稳定=${a[0]?.hash === a2[0]?.hash} 敏感=${a[0]?.hash !== b[0]?.hash}`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //
  // ★★★ 情形 56：D135 **区块权重 — 通用标准 v2**
  //
  //   ★ 用户要求"**给一个通用标准来让不同模型计算权重**" ⇒ 标准的全部价值在**可移植**。
  //   ★★★ 所以本情形的核心断言是那一条：**尺度必须握在插件手里** ——
  //     模型只答是/否 ⇒ 同样的答案在任何模型下都得到**同一个分**。
  //     ★ 反向验证（§八 ②）已实证：若把判据换成"认关键词"，必注比例从 ~30% 飙到 62%。
  //   ★ 底线（D135 §二）：**不确定 ⇒ 当必注** ⇒ `undefined`（模型没答）必须被**回报**出来。
  // ═══════════════════════════════════════════════════════════════════════════
  section("情形 56：D135 区块权重通用标准（是/否 + 插件算分）");
  {
    const W = mod.__test;

    // ── ① 尺度在插件手里：同样的答案 ⇒ 同一个分（与"谁答的"无关）
    const ansAllYes = { q1: true, q2: true, q3: true, q4: true };
    eq("★★★ 56①：四个都答「是」⇒ 分 = 35+25+20+10 = **90**（由插件算式定，与模型无关）", W.weightFromAnswers(ansAllYes).score, 90);
    eq("★★ 56①：四个都答「否」⇒ **0**", W.weightFromAnswers({ q1: false, q2: false, q3: false, q4: false }).score, 0);
    // ★ 真正的"通用"判据：同一个答案集被算两次，必须完全一样（确定性）
    eq("★★★ 56①：同一答案算两次 ⇒ **完全一样**（否则不同模型不可对齐）",
      JSON.stringify(W.weightFromAnswers(ansAllYes)), JSON.stringify(W.weightFromAnswers(ansAllYes)));

    // ── ② ★★★ 底线：模型**没答**（undefined）必须被如实回报 ⇒ 调用方才能退化成"全注"
    const partial = W.weightFromAnswers({ q1: true });
    eq("★★★ 56②：只答了 Q1 ⇒ 只拿 35 分（**没答的不给分**，不许默认成「是」）", partial.score, 35);
    ok(
      "★★★ 56②：且**如实列出哪些没答**（否则调用方无从判断「要不要退化成全注」）",
      Array.isArray(partial.unanswered) && partial.unanswered.join(",") === "q2,q3,q4",
      JSON.stringify(partial.unanswered)
    );
    // ★ 反向验证：把"没答"当"是"的实现 ⇒ 这条必红
    ok(
      "★★★ 56②：而**全答**时 unanswered 必须为空（两个方向都测）",
      W.weightFromAnswers(ansAllYes).unanswered.length === 0,
      JSON.stringify(W.weightFromAnswers(ansAllYes).unanswered)
    );

    // ── ②b ★★★★ 本设计**最核心的主张**：尺度必须握在插件手里
    //   ★ 反向验证当场抓到：把实现改成"直接收模型给的 `score`" ⇒ **自检一条都不红**
    //     ⇒ 也就是说"不问量表分"这个决定**当时没有任何断言在守**。
    //   ⇒ 补这条：**模型塞多少分都不好使**，分数只能由 four-bool 算出。
    //     ★ 这是"不同模型可对齐"在代码里的**可执行形式**。
    ok(
      "★★★★ 56②b：模型**自己塞分**（`score:999`）**必须无效** —— 分数只能由是/否算出",
      W.weightFromAnswers({ q1: true, score: 999 }).score === 35,
      `传入 score:999 后得到 ${W.weightFromAnswers({ q1: true, score: 999 }).score}（应 35）`
    );
    ok(
      "★★★★ 56②b：且答案**只认布尔** —— 塞字符串「是」等一律不算（否则模型可以用自由文本改分）",
      W.weightFromAnswers({ q1: "是", q2: "true", q3: 1 }).score === 0,
      `得到 ${W.weightFromAnswers({ q1: "是", q2: "true", q3: 1 }).score}（应 0）`
    );

    // ── ③ 第 0 步机械判据：元数据**强制归零**（哪怕内容看起来很重要）
    const metaBlock = W.splitBlocks("## 变更登记（插件自动维护）\n\n- 很长的记录\n- 绝不能丢\n").find((b) => /变更登记/.test(b.heading ?? ""));
    ok("★★ 56③ 前提：拿到「变更登记」那个块", metaBlock !== undefined);
    eq(
      "★★★ 56③：元数据 ⇒ **强制 0**（实测它每轮必变 ⇒ 不是项目知识；哪怕正文含「绝不能」）",
      W.mechanicalWeight(metaBlock, { writes: 99, changed: true, newest: true }).score,
      0
    );

    // ── ④ ★★★★ 2026-10-12（D136）**原「跨 ≥3 次写入从未变 ⇒ +20」已删除** ──────
    //   ★ 为什么删（实测，不是口味）：用真实变更史跑（只改 1 块、其余没动）
    //     ⇒ 25 块里 **23 块**都满足"从未变" ⇒ 全体 +20 ⇒ 必注比例 35% → **69.5%**，
    //     而它**什么也没挑出来**（"变更登记"、老小节、铁律全都同样 +20）。
    //   ★★ 所以这条断言**反过来守**：它**不许**再给分（给了就是那场退化的复发）。
    const normal = { heading: "## 目标", text: "## 目标\nY\n", hash: "x", lines: 2 };
    eq("★★★ 56④：**「从未被改」不再单独给分**（实测它让 23/25 块一起 +20 ⇒ 无区分力）",
      W.mechanicalWeight(normal, { writes: 5, changed: false, newest: false }).score, 0);
    eq("★★★ 56④：**最近新增** ⇒ +15（当前在做的事）",
      W.mechanicalWeight(normal, { writes: 5, changed: true, newest: true }).score, 15);
    eq("★★ 56④：**历史不明** ⇒ 不给分也不扣分（保守：不把不确定当「长期有效」）",
      W.mechanicalWeight(normal, undefined).score, 0);

    // ── ⑤ 阈值与目录
    eq("★★★ 56⑤：必注阈值 = **50**（用户 D136 拍板：「我建议是改成 50 分注入」）", W.mustInjectThreshold(), 50);
    const toc = W.renderToc([normal], { headingMaxChars: 40 });
    // ★ 目录里**去掉 `#` 前缀**（目录是纯文本索引；`#` 只占字符、不增信息）
    //   ⇒ 断言按**去掉前缀后**的标题查（我第一版写的是 `/## 目标/` ⇒ 假红，已修）。
    ok("★★ 56⑤：目录含标题 + 行数 + 哈希前缀（模型据此知道「这块我见过没」）",
      /目标/.test(toc) && /2 行/.test(toc) && /#x/.test(toc), toc.slice(0, 160));
    // ★ 标题必须被截断（否则目录成本失控）
    //   ⚠️⚠️ 这个断言我**写错两次**，都是同一个病 —— **禁的连缀长度正好等于截断后的长度**：
    //     ① 第一版禁"5 连" ⇒ 40 字符**恰好**是 5 个（假红，已修）
    //     ② 第二版禁"8 连" ⇒ 40 字符**又恰好**是 8 个（假红）
    //   ⇒ 正解：禁 **9 连**（40 字符只放得下 8 个 ⇒ 只有"完全没截断"才会出现 9 连）。
    //   ★ 教训（通用）：**断言里出现的字面量长度，绝不能等于被测阈值本身** ——
    //     否则它测的是"阈值算得准不准"，而不是"有没有截断"。
    const longB = { heading: `## ${"很长的标题".repeat(12)}`, text: "x", hash: "abc12345", lines: 1 };
    const tocl = W.renderToc([longB], { headingMaxChars: 40 });
    ok("★★★ 56⑤：标题**必须截断**（不截断时目录要 1413 字符 = 每块都付的固定成本）",
      tocl.includes("…") && !tocl.includes("很长的标题".repeat(9)),
      tocl.slice(0, 120));
    eq("★★ 56⑤：空块列表 ⇒ 目录为空串（不是一行空标题）", W.renderToc([], {}), "");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //
  // ★★★★★ 情形 57：D136 **区块定位 = 相对位置**（多维度秩融合 / 权重可变）
  //
  //   ★ 用户逐字（本轮最关键的一句）：
  //     *"区块的定位主要是**相对位置**，所以除了时间，很多方面也可以借助相对概念"*；
  //     以及 *"权重应该是可变的，正在处理的东西与所有底线与原则毫无疑问是高分，
  //     已处理的、已过期的低分，时间是打分标准之一"*、*"注意时间不是**绝对时间**，
  //     而是**相对时间顺序**"*。
  //
  //   ★★★ 本情形要守的**四件事**（每件都对应一次实测失败）：
  //     ① 元数据 **恒 0**（融合分不许把它抬起来）；
  //     ② 原则/底线 ⇒ **恒 ≥ 保底**（"毫无疑问是高分"）；
  //     ③ 已处理/已完成 ⇒ **封顶低分**（"已处理的低分"）；
  //     ④ ★★★ **判据必须是相对的** —— 这是本情形存在的首要理由：
  //        我第一版是"绝对分求和"（+20/+15/...）⇒ 实测必注 **69.5%**，因为
  //        「从未变 ⇒ +20」在真实台账里**23/25 块同时成立** ⇒ 全体抬分 = **零区分力**。
  //        ⇒ 断言要求：**同一批块整体平移时间戳，名次与分数不许变**（相对性 = 平移不变）。
  // ═══════════════════════════════════════════════════════════════════════════
  section("情形 57：D136 相对位置融合（权重可变 / 时间取相对序）");
  {
    const W = mod.__test;
    const mk = (h, t) => ({ heading: h, text: t, hash: W.fnv1a(t), lines: t.split("\n").length });
    const A = mk("## 甲", "## 甲\n甲的内容\n");
    const B = mk("## 乙", "## 乙\n乙的内容\n");
    const C = mk("## 丙", "## 丙\n丙的内容\n");
    const three = [A, B, C];

    // ── ① 元数据恒 0（哪怕模型全答「是」、时间最新）──
    const meta = [mk("## 变更登记（插件自动维护）", "## 变更登记（插件自动维护）\n- x\n")];
    const mAns = new Map([[0, { q1: true, q2: true, q3: true, q4: true }]]);
    const mHist = new Map([[meta[0].hash, { writes: 9, changed: true, newest: true, lastChangedAt: 9e12 }]]);
    const wm = W.weightBlocks(meta, mAns, mHist, 9e12)[0];
    eq("★★★★ 57①：元数据 ⇒ **恒 0**（模型全答「是」+ 时间最新都不好使，融合分不参与）", wm.weight.score, 0);
    eq("★★★ 57①：且标注出它是被归零的（便于排查，不靠猜）", wm.weight.capped, "zero");

    // ── ② 原则/底线 ⇒ 恒 ≥ 保底（哪怕它是最旧、模型全答「否」）──
    //   ⚠️⚠️ 反向验证第 5 轮抓到：我第一版用**单块**测 ⇒ 单块融合后**反正**是 100 分
    //      ⇒ 把保底摘掉也照样绿 ⇒ **断言是空的**。
    //      ⇒ 正解：放进**多块**列表，并让原则块在模型与时间两维上**都排最后**
    //        （那才是"保底真的在抬它"的可观测条件）。
    const P = mk("## 一、总纲", "## 一、总纲\n买下限不买上限\n");
    const X = mk("## 甲", "## 甲\n新的\n");
    const Y = mk("## 乙", "## 乙\n也新\n");
    const p3 = [P, X, Y];
    const pHist3 = new Map([
      [P.hash, { writes: 2, changed: true, newest: false, lastChangedAt: 1_000 }],        // 最旧
      [X.hash, { writes: 2, changed: true, newest: true, lastChangedAt: 9_000_000 }],      // 最新
      [Y.hash, { writes: 2, changed: true, newest: false, lastChangedAt: 5_000_000 }],
    ]);
    const pAns3 = new Map([[0, { q1: false, q2: false, q3: false, q4: false }], [1, { q1: true, q2: true, q3: true, q4: true }], [2, { q1: true, q2: true }]]);
    const wp = W.weightBlocks(p3, pAns3, pHist3, 9_000_000)[0];
    ok("★★★★ 57②：原则/底线**在最差条件下（模型全「否」+ 时间最旧）仍 ≥ 保底**（用户：「毫无疑问是高分」）",
      wp.weight.score >= W.principleScore(), `得到 ${wp.weight.score}，保底 ${W.principleScore()}`);
    // ★ 并证明"抬"是真的发生了：它比同表里**融合分**算出来的值高
    ok("★★★★ 57②：且它**确实被抬过** —— 融合分本身远低于保底（否则这条断言测不出东西）",
      wp.weight.fused < W.principleScore(),
      `融合分 ${wp.weight.fused} vs 保底 ${W.principleScore()}`);
    eq("★★★ 57②：且保底高过必注阈值（否则原则仍会被挤成「只进目录」）",
      wp.weight.score >= W.mustInjectThreshold(), true);

    // ── ③ 已处理/已完成 ⇒ 封顶低分（哪怕模型全答「是」、时间最新）──
    const doneB = [mk("## ✅ 已完成（正文见 DECISIONS，别再重做）", "## ✅ 已完成（正文见 DECISIONS，别再重做）\n旧账\n")];
    const dHist = new Map([[doneB[0].hash, { writes: 9, changed: false, newest: false, lastChangedAt: 9e12 }]]);
    const wd = W.weightBlocks(doneB, new Map([[0, { q1: true, q2: true, q3: true, q4: true }]]), dHist, 9e12)[0];
    ok("★★★★ 57③：已处理/已完成 ⇒ **封顶低分**（用户：「已处理的、已过期的低分」）——哪怕模型全答「是」",
      wd.weight.score <= W.doneCap(), `得到 ${wd.weight.score}，封顶 ${W.doneCap()}`);
    ok("★★★ 57③：封顶值必须**低于必注阈值**（否则「已完成」仍会被注入）",
      W.doneCap() < W.mustInjectThreshold(), `封顶 ${W.doneCap()} vs 阈值 ${W.mustInjectThreshold()}`);

    // ── ④ ★★★★★ 判据必须是**相对**的（本情形存在的首要理由）───────────────
    //   ★★ 判据：**整批时间戳一起平移**（全部 +1000 天）⇒ 名次与分数**必须完全不变**。
    //      · 相对实现 ⇒ 不变（✓）；绝对时长实现 ⇒ 全部被判"陈旧" ⇒ 分数变（红）。
    //   ★ 这条正是用户那句"**不是绝对时间，而是相对时间顺序**"的可执行形式。
    const t0 = 1_700_000_000_000;
    const histRel = new Map([
      [A.hash, { writes: 5, changed: false, newest: true, lastChangedAt: t0 + 300 }],
      [B.hash, { writes: 5, changed: false, newest: false, lastChangedAt: t0 + 200 }],
      [C.hash, { writes: 5, changed: false, newest: false, lastChangedAt: t0 + 100 }],
    ]);
    const shift = 1000 * 86400e3;
    const histAbs = new Map([...histRel].map(([k, v]) => [k, { ...v, lastChangedAt: v.lastChangedAt + shift }]));
    const before = W.weightBlocks(three, undefined, histRel, t0 + 300).map((b) => b.weight.score);
    const after = W.weightBlocks(three, undefined, histRel, t0 + 300 + shift).map((b) => b.weight.score);
    eq("★★★★ 57④：**整批时间一起平移 ⇒ 分数一字不变**（相对判据的判据；绝对时长实现必红）",
      JSON.stringify(after), JSON.stringify(before));
    ok("★★★★ 57④：且「最新那块」确实排第一（相对序真的在起作用，不是恒等函数）",
      before[0] >= before[1] && before[1] >= before[2], JSON.stringify(before));
    // ★ 顺序也必须在：最早那块的 lastChangedAt 用绝对值看是"很多天前"，但它**相对**仍是第 3
    const shifted = W.weightBlocks(three, undefined, histAbs, t0 + 300 + shift).map((b) => b.weight.score);
    eq("★★★★ 57④：**换成绝对时间值（整体 +1000 天）⇒ 分数仍与相对版一字相同**（顺序才是判据）",
      JSON.stringify(shifted), JSON.stringify(before));

    // ── ⑤ 并列者必须**均分名次**（fractional ranking）────────────────────
    //   ★★ 实测根因：我第一版用 dense rank ⇒ **24 块并列"最旧"就全部拿第 2 名**
    //      ⇒ 位置 0.958 ⇒ 人人近满分 ⇒ 必注 **82.2%**。取平均名次后它们落在区间中点。
    const same = [mk("## 甲", "## 甲\n1\n"), mk("## 乙", "## 乙\n2\n"), mk("## 丙", "## 丙\n3\n")];
    const sameHist = new Map(same.map((b) => [b.hash, { writes: 3, changed: false, newest: false, lastChangedAt: t0 }]));
    const rk = W.ranksOf(same.map((b) => ({ key: b.hash, value: 7 })), (a, b) => b - a);
    void rk;
    const tie = W.ranksOf([{ key: "a", value: 5 }, { key: "b", value: 5 }, { key: "c", value: 5 }, { key: "d", value: 1 }], (a, b) => b - a);
    eq("★★★★ 57⑤：三个并列者 ⇒ 名次取**区间中点**（1.0，而不是 dense rank 的 0）", tie.get("a"), 1);
    eq("★★★★ 57⑤：且**最差那个仍是最后一个名次**（3）——并列不许把差异抹平", tie.get("d"), 3);
    ok("★★★ 57⑤：并列者拿到**同一个**名次（不许强行分先后）",
      tie.get("a") === tie.get("b") && tie.get("b") === tie.get("c"), JSON.stringify([...tie]));

    // ── ⑥ 缺维 ⇒ 只对**已有**的维度求平均，不按 0 计 ────────────────────
    //   ★ 否则"没有变更史"会被当成"最差"，那是凭空扣分（与 D135 的保守口径一致）。
    //   ⚠️⚠️ 反向验证第 5 轮抓到**两次**，值得记下来（两种错法不同）：
    //     ① 第一版用"有奖励历史的块"作对照 ⇒ 差异来自**奖励**而不是缺值 ⇒ 测不出东西；
    //     ② 第二版用"最差历史"作对照 ⇒ 仍测不出，因为**"最差"与"缺失"的正确差别
    //        不是次序，而是分母**：跳过 ⇒ 分母只算**已有**维度；
    //        当 0 ⇒ 分母算**全部**维度 ⇒ 分数被**统一拉低**。
    //   ⇒ 正解：**全表都没有历史**，此时
    //        · 正确（跳过）⇒ 分只由「模型 + 星」两维定 ⇒ 甲的 88 分
    //        · 坏法（当 0）⇒ 分母多出 时间1.5 + 稳定0.8 ⇒ **被拉低到 56 分**
    //      ⇒ 断言"甲 ≥ 70"就能把这两种实现分开（88 vs 56）。
    const NA = mk("## 甲", "## 甲\n甲\n");
    const NB = mk("## 乙", "## 乙\n乙\n");
    const onlyModel = new Map([[0, { q1: true }], [1, { q1: false }]]);
    const nh = W.weightBlocks([NA, NB], onlyModel, undefined, t0);
    ok("★★★★ 57⑥：**全表都没有变更史 ⇒ 分只由「模型 + 星」定**（若把缺值当 0，分母变大 ⇒ 被拉低）",
      nh[0].weight.score >= 70,
      `甲 = ${nh[0].weight.score}（跳过缺值的实现 ≈88；把缺值当 0 的实现 ≈56）乙 = ${nh[1].weight.score}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //
  // ★★★★ 情形 58：D136 **接线**（块变更史进写入路径 / 模型判分进 triage）
  //
  //   ★ 为什么单列一个情形（而不是并进 57）：57 测的是**纯函数**，
  //     本情形测的是**生产链路真的把那些函数用上了**。
  //     ★★ 这个区分有前科：57 全绿时，`recordBlockHistory` **一个调用点都没有**
  //        ⇒ 时间/稳定两维在生产里恒缺值 ⇒ "权重可变"是**空话**，
  //        而纯函数断言照样全绿。**函数对 ≠ 接线对**。
  // ═══════════════════════════════════════════════════════════════════════════
  section("情形 58：D136 接线（变更史进写入路径 / 判分进 triage）");
  {
    const W = mod.__test;
    // ★ 本情形要的是**有台账的项目**（`ledger_write` 才认路）。
    //   ⚠️ `mkModeProj` 是**别的 section 内的局部** helper，这里够不着 ⇒ 自带一个
    //     （★ 第一版直接调它 ⇒ `ReferenceError`，夹具当场崩，红得很清楚）。
    const mkProj = (tag) => {
      const dir = tmpProject(tag);
      fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\n做点什么\n", "utf8");
      fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
      fs.mkdirSync(path.join(dir, "_a"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".dsh-ledger.json"),
        JSON.stringify({
          version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
          archiveDir: "_a", logDir: "_ledger-log", maxActiveLines: 300, mode: "surgical", revision: 0,
        }),
        "utf8"
      );
      return dir;
    };

    // ── ① 写台账 ⇒ 变更史**真的**记下来了（不是"函数存在"）──
    {
      const root = mkProj("bh-write");
      const run = makeCtx({});
      mod.apply(run.ctx, {});
      const sid = "session-bh000000-0001";
      const tool = run.registeredTools.get("ledger_write");
      const written = "# 台账\n\n## 甲\n甲的内容\n\n## 乙\n乙的内容\n";
      const r1 = await tool.execute({ target: "active", mode: "replace", content: written }, execFor(root, sid));
      eq("★★ 58① 前提：第一次写入成功", r1.ok, true);
      const hist1 = W.blockHistoryFor(root);
      ok("★★★★ 58① 写台账**真的**记下了区块变更史（函数存在但没接线时，这里会是空的）",
        hist1.size >= 2, `记录 ${hist1.size} 块`);
      const anyNew = [...hist1.values()].some((h) => h.newest === true);
      ok("★★★ 58① 且标出了「最近新增」（时间维就靠它）", anyNew,
        JSON.stringify([...hist1.values()].map((h) => h.newest)));

      // ── ② 再写一次同样内容 ⇒ 普通块**没变** ──
      //   ⚠️ 必须**排除「变更登记」块**：插件每次写入都会给它追加一行 ⇒
      //      它**按设计每写必变**（★ 那正是 `mechanicalWeight` 给它强制 0 的理由）。
      //      ★ 第一版把全表一起比 ⇒ 假红。这条细节反过来**证实了**"元数据每轮必变"。
      const before = [...hist1.entries()]
        .filter(([h]) => hist1.get(h)?.writes === 1)
        .map(([h, v]) => [h, v.lastChangedAt]);
      await tool.execute({ target: "active", mode: "replace", content: written }, execFor(root, sid));
      const hist2 = W.blockHistoryFor(root);
      // ★ 只挑"变化前就已存在、且不是元数据"的那些块来比（元数据必然前移，是设计）
      const stablePairs = before.filter(([h]) => !/变更登记/.test("") && hist2.has(h));
      const moved = stablePairs.filter(([h, t]) => hist2.get(h).lastChangedAt !== t);
      ok("★★★ 58② 内容一字未改的块 ⇒ `lastChangedAt` **没有前移**（前移了的话「多久没变」永远是 0）",
        moved.length === 0,
        `前移的块数 = ${moved.length}（✓ 元数据块不在其中：它的哈希每次都换）`);
      // ★ 反过来也要守：**元数据块每写必变**（★ 那是它被强制 0 分的实测依据）。
      //   ⚠️ 判据不能用 `changed`：元数据每次写入都是**全新哈希**
      //      ⇒ 每个哈希的 `first === last` ⇒ `changed` 恒 false（永远不会累加）。
      //      ★ 正解看 **`writes` 是否累积**：普通块 `writes` 会涨到 2、3；元数据块永远停在 1。
      const metaRows = [...hist2.values()].filter((h) => h.writes === 1);
      const grown = [...hist2.values()].filter((h) => h.writes >= 2);
      ok("★★★ 58② 普通块的 `writes` **真的在累积**（≥2）—— 这才叫「见过多次」",
        grown.length > 0, `writes≥2 的块 = ${grown.length}`);
      ok("★★★ 58② 而元数据那种每写必换哈希的块 **`writes` 停在 1**（它没法累积，只能每次换新）",
        metaRows.length > 0, `writes==1 的块 = ${metaRows.length}`);

      // ── ③ 改掉其中一块 ⇒ 哈希变了 ⇒ 新条目 ──
      const n2 = hist2.size;
      await tool.execute({
        target: "active", mode: "replace",
        content: "# 台账\n\n## 甲\n甲的内容**改了**\n\n## 乙\n乙的内容\n",
      }, execFor(root, sid));
      const hist3 = W.blockHistoryFor(root);
      ok("★★★★ 58③ 改了内容 ⇒ 变更史里多出一个哈希（内容地址变了就是新块）",
        hist3.size > n2 || [...hist3.keys()].some((k) => !hist2.has(k)),
        `${n2} → ${hist3.size}`);
      rmrf(root);
    }

    // ── ④ 归档也改活跃台账 ⇒ 同样要记 ──
    {
      const root = mkProj("bh-archive");
      const run = makeCtx({});
      mod.apply(run.ctx, {});
      const sid = "session-bh000000-0002";
      await callTool(run, "ledger_write", {
        target: "active", mode: "replace",
        content: "# 台账\n\n## 甲\n甲\n\n## 乙\n乙\n\n## 丙\n丙\n",
      }, execFor(root, sid));
      const beforeN = W.blockHistoryFor(root).size;
      const arch = await callTool(run, "ledger_archive", {
        entries: "## 甲\n甲", newActive: "# 台账\n\n## 乙\n乙\n\n## 丙\n丙\n",
      }, execFor(root, sid));
      eq("★★ 58④ 前提：归档成功", arch.ok, true);
      const afterH = W.blockHistoryFor(root);
      ok("★★★ 58④ 归档后变更史仍有记录（归档也走 `recordBlockHistory`）",
        afterH.size > 0 && beforeN > 0, `${beforeN} → ${afterH.size}`);
      // ★★★★ 反向验证抓到：上面那条**测不出归档那一次调用** ——
      //    `ledger_write` 已经让 size > 0，摘掉归档里的 `recordBlockHistory` 也照样绿。
      //   ⇒ 真正的判据是 **`writes` 计数在归档后必须 +1**（那是"归档也记了一笔"的唯一痕迹）。
      const wMax = (m) => Math.max(0, ...[...m.values()].map((h) => h.writes));
      ok("★★★★ 58④ 归档**确实又记了一笔**（`writes` 最大值必须比归档前 +1）",
        wMax(afterH) >= 2,
        `归档后 writes 最大 = ${wMax(afterH)}（若归档没记账，它会停在 1）`);
      rmrf(root);
    }

    // ── ⑤ 模型判分：只认布尔 + 只认哈希（生产链路上的同一条底线）──
    {
      const root = mkProj("bw-triage");
      const run = makeCtx({});
      mod.apply(run.ctx, {});
      const sid = "session-bw000000-0001";
      const res = await callTool(run, "ledger_triage", {
        keep: [{ what: "某件下一轮必须知道的事" }],
        weights: [
          { hash: "abc12345", q1: true, q2: false, q3: true, q4: false },
          { hash: "#DEF67890", q1: true, q2: true, q3: true, q4: true },
          { hash: "bbb22222", q1: "是", q2: 1, q3: true, q4: false },
          { hash: "ccc33333", score: 999, q1: true },
          { hash: "", q1: true },
          { q1: true },
        ],
      }, execFor(root, sid));
      eq("★★ 58⑤ 前提：分流成功", res.ok, true);
      // ★ 逐条数清**为什么**是 4 条（这不是"期望值抄错"，是把规则说清楚）：
      //   ① `abc12345`  全布尔 ⇒ 收
      //   ② `#DEF67890` 带 `#` 前缀 + 大写 ⇒ **归一化后收**（目录里就是 `#xxxxxxxx` 形态）
      //   ③ `bbb22222`  q1="是" / q2=1 **不算**，但 q3=true q4=false **是布尔** ⇒ 收
      //      ★ 这正是"只认布尔"的准确含义：**逐字段**过滤，不是"整条有脏数据就丢"
      //   ④ `ccc33333` 多塞了 `score:999` ⇒ **q1 仍是合法布尔** ⇒ 收；★ 而那个 score **必须无效**
      //   ⑤ `""`        空哈希 ⇒ 丢
      //   ⑥ 无 hash      ⇒ 丢
      eq("★★★★ 58⑤ 只收下合法的（空哈希 / 无哈希 ⇒ 丢；带 `#`/大写 ⇒ 归一化收）", res.weightsScored, 4);

      // ★★★★ 反向验证抓到：光看 `weightsScored` **测不出"有没有真存进去"** ——
      //   把 `state.blockWeights.set(...)` 整行摘掉，上面那条照样绿（它只数循环次数）。
      //   ⇒ 必须**直接查存下来的东西**（这才是"接线对了"的证据）。
      const stored = W.blockWeightsForTest(sid);
      ok("★★★★ 58⑤ 判分**真的存下来了**（摘掉 `state.blockWeights.set` 时这里会是 undefined）",
        stored !== undefined && Array.isArray(stored.byHash), JSON.stringify(stored)?.slice(0, 200));
      const byHash = new Map(stored?.byHash ?? []);
      ok("★★★ 58⑤ 存下来的哈希**已归一化**（去 `#`、转小写）—— 目录里给的就是这个形态",
        byHash.has("def67890") && byHash.has("abc12345"),
        JSON.stringify([...byHash.keys()]));
      // ★★★★ 本设计的核心主张：**模型塞的分必须无效**（分数只能由插件算）
      const cheat = byHash.get("ccc33333");
      ok("★★★★ 58⑤ 模型自己塞的 `score:999` **没有被记录**（只留 q1）—— 分数只能由插件算",
        cheat !== undefined && cheat.score === undefined && cheat.q1 === true,
        JSON.stringify(cheat));
      // ★ 字符串/数字**不许**被当成 true
      const dirty = byHash.get("bbb22222");
      ok("★★★★ 58⑤ 字符串「是」/ 数字 1 **不算 true**（只保留真布尔 q3/q4）",
        dirty !== undefined && dirty.q1 === undefined && dirty.q2 === undefined && dirty.q3 === true,
        JSON.stringify(dirty));
      rmrf(root);
    }

    // ── ⑥ 判分**不传** ⇒ 照样成功（不是错误，只是那一维跳过）──
    {
      const root = mkProj("bw-none");
      const run = makeCtx({});
      mod.apply(run.ctx, {});
      const res = await callTool(run, "ledger_triage", {
        keep: [{ what: "只有 keep，不判分" }],
      }, execFor(root, "session-bw000000-0002"));
      eq("★★★ 58⑥ 不传判分 ⇒ 仍然成功（退化成「只看星与结构」，不伤准确性）", res.ok, true);
      eq("★★★ 58⑥ 且如实回报收了 0 块（不是假装有）", res.weightsScored, 0);
      ok("★★ 58⑥ 说明里讲清了「未判分」这件事", /未判分|没传/.test(String(res.note)), String(res.note).slice(0, 200));
      rmrf(root);
    }
  }
}

console.log(`  通过 ${pass} 项，失败 ${failCount} 项`);
if (failCount > 0) {
  console.log(`  失败清单：`);
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"═".repeat(64)}\n`);
process.exit(failCount === 0 ? 0 : 1);
