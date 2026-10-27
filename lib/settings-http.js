/**
 * settings-http.js —— 设置面板的后端（HTTP 小工具 + 读写 + 扩展记忆路由）
 *
 * ★★★ 2026-10-25（D323 · 005 报告 F-07）：**从 `part2.js` 整块搬出**，目的是给它腾出容量。
 *   报告实测 `part2.js` 已到 **261,202 B / 262,144 B（剩 942 B）**，任何后续改动都会撞硬上限。
 *   搬走这一段（约 28730 B）后余量回到安全区。
 *
 * ★★ 搬家方式（判据）：**逐字复制，不重写**。
 *   本文件正文与 `part2.js` 原 L2181–L2804 **逐字相同**，只在顶部加了这段 import 头与说明。
 *   ⇒ 行为等价性不需要重新论证，它读的就是原来那些字节。
 *
 * ★★ 调用面**零改动**：`part2.js` 原位置留了一行
 *   `export { … } from "./settings-http.js";`
 *   ⇒ `index.js` 与 `tools/` 里那些 `from "./part2.js"` 的 import 一个字都不用改。
 *   （D307/D318/D319 同一做法：**搬实现可以，改调用面不行**。）
 *
 * ★ 依赖方向：本文件只依赖 defs / part1 / part3 / part8 与 part2 的三个纯函数，
 *   **不被任何 lib 模块反向依赖**（只有 part2 转发导出它）⇒ 不新增依赖环。
 */
import fs from "node:fs";
import path from "node:path";

import {
  SETTINGS_PREFIX,
  SETTING_GROUPS,
  SETTING_SPECS,
  bumpSettingsBroadcast,
  name,
  setActiveSettings,
} from "./defs.js";
// ★★★ 2026-10-25（D323）：`setActiveSettings` 是**补上的**，而且**第一次补还放错了模块**：
//   我猜它在 `part1.js`（因为它跟 currentSettings 像一对），实际它在 `defs.js:1016`。
//   ⇒ 语法层立刻报 `does not provide an export named 'setActiveSettings'` ——
//     **这次是"猜出处"被当场抓住**，比运行时被 catch 吞掉好得多。
//   ★ 判据：**报错说"哪个模块没有这个导出"时，别改用法，去 grep 真正的出处。**
import { currentSettings, normalizeSettings, panelUnitsOf, settingDefaults, settingsOf } from "./part1.js";
import { settingsBroadcastSeqOf } from "./part3.js";
import {
  EXT_MODES,
  EXT_MODE_KEYS,
  createExtension,
  deleteExtension,
  listExtensions,
  updateExtension,
} from "./part8.js";
import { inspect, parseLevels, projectRootOf } from "./part2.js";

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
    // ★★★★ 2026-10-26（D329 · F-02）：**出站一律换回面板单位**。
    //   ★ 为什么这是必须的、而不只是"更好看"：`specs` 里带着 `min/max`（面板单位，
    //     `triageOwedMaxAgeMs` 是 1~240 分钟），而这里原来发出去的是**内部毫秒** 1,200,000
    //     ⇒ 滑块的 range 是 1~240、值却是 1,200,000，数字框又写了 `max=240`
    //     ⇒ 面板**显示一个它自己都装不下的数**，用户一按保存就被夹成 240（4 小时）。
    //   ⇒ 内部面（`currentSettings()`）继续用内部单位；**跨过 HTTP 边界就是面板单位**。
    settings: panelUnitsOf(currentSettings()),
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
    // ★ 同理（D329）：「恢复默认」把这份填进草稿，再经 `valueToPatch` 提交 ——
    //   若这里是内部毫秒，按一次「恢复默认」等于把这项放大 60000 倍。
    defaults: panelUnitsOf(settingDefaults()),
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
    // ★★★ 2026-10-26（D329）：这份同样要换回**面板单位** —— 它才是面板实际显示的那份，
    //   `settingsOf` 走的是 `normalizeSettings`，出来的仍是内部毫秒。
    out.settings = panelUnitsOf(settingsOf(hit.entry?.options?.config ?? hit.current ?? {}));
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
  const routeDisposers = [];
  const reg = (p, handler) => {
    try {
      const dispose = scope.webServer.register({
        kind: "exact",
        path: SETTINGS_PREFIX + p,
        // ★ D221：先过授权闸门，再进业务 handler（`handleFor` 在最外层兜异常）。
        handler: handleFor(settingsGate(scope, handler)),
      });
      registered.push(SETTINGS_PREFIX + p);
      if (typeof dispose === "function") routeDisposers.push(dispose);
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
      const normPath = (p) => {
        if (typeof p !== "string" || p === "") return "";
        const resolved = path.resolve(p);
        return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
      };
      const targetNorm = normPath(root);
      const matchedRoot = allowed.roots.find((r) => normPath(r) === targetNorm);
      // ★★ 允许名单之外一律拒绝 —— 这是"面板不能当通用文件读写口"的那条线。
      if (matchedRoot === undefined) {
        sendJson(res, 403, { ok: false, error: "这个项目不在当前可配置的名单里（面板只允许活跃会话的项目根）。" });
        return;
      }
      let info;
      try {
        info = inspect(matchedRoot);
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
            mode: body?.mode,
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

  const dispose = () => {
    while (routeDisposers.length > 0) {
      const fn = routeDisposers.pop();
      try { fn(); } catch {}
    }
  };
  return { registered, failures, dispose };
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
    //
    // ★★★★★ 2026-10-26（D329 · F-02）：这里原来写的是
    //   `normalizeSettings({ ...currentSettings(), ...patch })` —— **一个真 bug**。
    //   `currentSettings()` 是**内部基本单位**（`triageOwedMaxAgeMs` = 1,200,000 毫秒），
    //   而 `patch` 来自面板、是**面板单位**（20 分钟）。两个尺子并进一个对象再交给
    //   `normalizeSettings` ⇒ 那个 1,200,000 被当成"1,200,000 分钟"按 `max:240` 夹成 240
    //   ⇒ 再 `×60000` ⇒ **20 分钟变 4 小时**。
    //   ★ 最毒的是触发条件：用户**改的可以是任何一个别的设置**，甚至这一项一个字都没提。
    //   ⇒ 修法：合并前先把当前值**换回面板单位**，让整份对象只有一把尺子。
    // ★ 只转换 `currentSettings()`（内部单位）—— `patch` **本来就是面板单位**，
    //   再除一次 scale 就会把 20 变成 0.0003（我第一版正是这么写的，探针当场抓到）。
    const check = normalizeSettings({ ...panelUnitsOf(currentSettings()), ...patch });
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
      // ★★★★ 2026-10-26（D329 · F-02）：回给面板的**也是面板单位**。
      //   面板拿这份去刷新 `view.data.settings` 与 `draft`（见 client `onSave`），
      //   若这里给内部毫秒，保存成功那一刻面板就显示 1,200,000，用户再保存一次就是 240。
      //   ⇒ 与 `deriveSettingsView` 用同一个出口，两处不存在分叉。
      settings: panelUnitsOf(check.value),
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

