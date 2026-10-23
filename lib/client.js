/**
 * dsh-ledger-memory —— 客户端半边（浏览器里跑的那一半）
 * ============================================================================
 *
 * 形态：**经典脚本**，不是 ESM。
 *   ★ 不能出现顶层 `export` —— 浏览器半边靠 `window.__ModuleLoader__.load()`
 *     注册（平台既定的加载协议）。参照本工作区另一个已验证插件的 `lib/client.js`。
 *
 * ★★ 四条硬约束（本工作区踩过真实事故，改代码前先读）：
 *
 *   ① `id` **必须等于包名**（`dsh-ledger-memory`）。
 *      与 `package.json` 的 `name`、`cordis.patch.yml` 的 `id`/`name`、
 *      `lib/index.js` 的 `export const name` 一共四处身份位，漏改一处就是加载不上。
 *
 *   ② `require()` 只用**平台共享模块表里的词**。
 *      本文件**只 `require("react")`** —— 与那个插件同一个策略：
 *      少引一个词就少一个"装了但界面全空"的失败模式，全部用
 *      `React.createElement` 手搓。
 *      ⚠️ 那条策略有**实证依据**：`dshmarket` 在渲染前专门检查
 *        `REQUIRED_PRIMITIVES`（Menu/DisclosureRow/Tooltip/Toast）在不在，
 *        注释逐字写着 —— 缺一个就会 *"rendering would throw and blank the whole
 *        settings dialog"*（**把整个设置弹窗弄白**）。
 *      ⇒ 我们不引任何 UI 组件库，从根上没有这个失败模式。
 *
 *   ③ `ctx.slots.inject(key, cb)` **必须是方法调用**（摘成局部变量会丢 `this`），
 *      且 `cb` 的返回值是卸载函数。注册失败**必须记进 diagnostics + globalThis**，
 *      不许静默吞 —— 否则现象是"bundle 加载了、界面一个挂载点都没有、还不报错"。
 *
 *   ④ **CSS 只引用真实存在的 `--dsw-*` 变量**（本文件用的每一个都用
 *      `cordis_inspect_query(Theme)` 核过），且**自己画背景的元素必须同时显式定
 *      `color`**，不许靠 `inherit` —— 浅色主题下 `inherit` 拿到近黑文字，
 *      压在自己给的深色背景上就看不见了（`7.模型路由` 2026-09-25 真实事故）。
 *
 * ── 这个面板挂哪、为什么挂这 ──────────────────────────────────────────────
 *   挂 `settings.section`：`kind: "list"`、`scope: "root"`、`replaceRisk: "none"`
 *   ⇒ **纯新增**，不遮蔽官方 UI。设置导航里出现独立一页（与插件市场同一种做法）。
 *   ★ 该 slot 只投影 `id` / `order` / `label` **三个字段、没有 `icon`**
 *     （`dshmarket` 源码注释逐字：*"a registrant has no icon to pass … Every
 *     third-party section therefore wears the gear, the market included."*）
 *     ⇒ 市场是用 MutationObserver 改官方 DOM 硬塞图标的。**我们不学那个**（脆，
 *       而且官方一改选择器就失效）。⭐ 但**用中文加括号标出身份**，见 LABEL。
 *
 * ── 数据从哪来 ────────────────────────────────────────────────────────────
 *   面板**不自建存储**：读写都打到宿主半边开的两段路由（`webServer.register`，
 *   前缀 `/dsh-ledger-memory-settings`）。宿主那边用官方 `configEditor.edit()`
 *   落盘 ⇒ 唯一真源是 Loader entry 的 `config`，与内核实际在用的那份是同一个。
 */

window.__ModuleLoader__.load({
  id: "dsh-ledger-memory",
  factory: (require) => {
    "use strict";

    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    // ───────────────────────────────────────────────────────────────────────
    // 常量
    // ───────────────────────────────────────────────────────────────────────
    const PLUGIN_ID = "dsh-ledger-memory";
    const SLOT = "settings.section";
    /** 导航项 id。★ 必须与官方已占用的 id 不同（已占：models / agent-presets / plugins / market）。 */
    const SECTION_ID = "project-ledger";
    /** 排在世界之后（市场是 40）。越小越靠上。 */
    const SECTION_ORDER = 45;
    /**
     * 导航里的名字。
     * ★ 括号里那半句是**故意的**：这个 slot 没有 `icon` 字段，第三方分区全都顶着
     *   官方的齿轮图标（见文件头）。加一句"台账"让人一眼知道这是哪个插件，
     *   而不必去猜那个齿轮是什么。
     */
    const LABEL = "项目台账（台账 / 压缩 / 日志）";
    const API_BASE = "/" + PLUGIN_ID + "-settings";
    const API_CONFIG = API_BASE + "/config.json";
    // ★ 2026-10-15（D211）：把「⚙️ 当前设置」推送到每个对话的下一条回复。
    const API_BROADCAST = API_BASE + "/broadcast.json";
    // ★ 2026-10-21（1.5.0）：自定义扩展记忆的读写入口（与设置同一道授权闸门）。
    const API_EXTENSIONS = API_BASE + "/extensions.json";
    const CSS_ID = PLUGIN_ID + "/client.css";

    /** 水位档位那个文本输入框的提示（与宿主默认值一致）。 */
    const TIERS_PLACEHOLDER = "0.3, 0.5, 0.7";

    /**
     * ★★★★★ 2026-10-21（用户拍板）：**顶层只留四个标签页**。
     *
     * 用户原话（逐字）：
     *   *"设置面板现在太臃肿了，我的想法是有些参数根本没有暴露给用户的必要，
     *     只有那些明确会影响用户体验，并且有调整必要的才放出来"*
     *   *"最好就是顶层的那些按键能精简到四个"*
     *
     * ★★★ 设计判据（**只有一条**）：**这一项会不会改变用户看到的行为？**
     *   · 会 ⇒ 放进「常规」或「注入」；
     *   · 只在排障 / 自检 / 极端调优时才动 ⇒ 进「高级」；
     *   · 连排障都不该让人碰 ⇒ 进 `HIDDEN_KEYS`（不渲染，但仍然生效）。
     *
     * ★★ 为什么用"显式名单 + 兜底进高级"而不是给 43 个 spec 逐个加字段：
     *   逐项加字段要改 43 处，改漏一处那一项就**凭空消失**（本项目最怕的形态）。
     *   这里「高级」用 `rest: true` **兜住所有没被点名的项** ⇒ **结构上不可能丢项**。
     *
     * ⚠️ 客户端到这里才第一次"认得"设置项的 key。★ 这是**故意**的、也是
     *   `情形 50 ③`（客户端不认任何 key）唯一的例外 —— 那条断言守的是
     *   "分组与渲染由宿主驱动"，这里改的是**收纳**（哪些露出来），不是渲染逻辑。
     *   ⇒ 自检里已把那条断言的**判定范围收窄到"控件渲染"**，见 `情形 50 ③` 的注释。
     */
    const PANEL_TABS = [
      {
        key: "general",
        title: "常规",
        hint: "日常真正会调的那几项。其余都能用，不必动。",
        keys: ["highFidelityCompactRatio", "settingPrecedence", "autoCompact", "midTurnCompact", "maxActiveLines", "turnEndOffer"],
      },
      {
        key: "inject",
        title: "注入",
        hint: "决定模型每一回合会看到多少、看到什么。",
        keys: ["blockInjection", "fileAnchor", "maxReadChars", "capsuleMaxChars"],
      },
      {
        key: "extensions",
        title: "扩展记忆",
        hint: "按项目管理你自己的记忆单元（Boss 机制、术语表、约定…）。",
        kind: "extensions",
      },
      { key: "advanced", title: "高级", hint: "排障与极端调优用。改错了会变吵、变慢。", rest: true },
    ];

    /**
     * **不渲染**的设置项（仍然生效，只是面板上不给入口）。
     *
     * ★ 判据：**排障专用 / 只在开发者本人才有意义**。
     * ★★ 它们不是"删掉了" —— `SETTING_KEYS` 里仍在，配置文件写了照样生效，
     *   只是面板不再占一行。要临时调，改 `cordis.patch.yml` 或项目清单。
     * ⚠️ 自检里有断言：这个名单里的每一项**必须真实存在于** `SETTING_SPECS`，
     *   否则就是打错字导致"以为藏了、其实还在露"或者"藏了个不存在的"。
     */
    const HIDDEN_KEYS = ["diagFile", "mode"];

    // 诊断：与那个插件同款。挂到 globalThis 供排障与自检读。
    const diagnostics = { slots: {}, errors: [], at: null };

    function recordSlot(id, ok, message) {
      diagnostics.slots[id] = ok ? { ok: true } : { ok: false, message: String(message || "") };
      if (!ok) diagnostics.errors.push(id + ": " + String(message || ""));
    }

    function safeRegister(ctx, options, component) {
      try {
        const d = ctx.slots.register(options, component);
        recordSlot(options.id || options.key || "(unnamed)", true);
        return typeof d === "function" ? d : () => {};
      } catch (e) {
        recordSlot(options.id || options.key || "(unnamed)", false, e && e.message ? e.message : String(e));
        return () => {};
      }
    }

    function errText(e) {
      if (e === undefined || e === null) return "未知错误";
      if (typeof e === "string") return e;
      if (e.message) return e.message;
      try {
        return JSON.stringify(e);
      } catch {
        return String(e);
      }
    }

    // ───────────────────────────────────────────────────────────────────────
    // 纯函数（露给自检钉死；不依赖 DOM、不依赖 React）
    // ───────────────────────────────────────────────────────────────────────

    /**
     * 把"0.3, 0.5, 0.7"解析成 `[0.3, 0.5, 0.7]`。
     *
     * ★ 为什么用文本框而不是几个数字输入框：档位是**可变长**的（可以只要一档、
     *   也可以四档），固定几个框反而要处理"空着的那几个算不算"。
     * ★ 非法项**丢掉**而不是报错：用户打字打到一半（"0.3,"）不该让界面报红。
     *   解析结果的去重与排序交给宿主（它那边是权威，会再归一化一遍）。
     */
    function parseTiers(text) {
      if (typeof text !== "string") return [];
      return text
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0 && n < 1);
    }

    /** 把档位数组变回可编辑的文本。 */
    function formatTiers(arr) {
      if (!Array.isArray(arr)) return "";
      return arr.filter((n) => Number.isFinite(n)).join(", ");
    }

    /**
     * 按控件类型，把"界面上的值"变成"要提交的补丁"。
     *
     * ★ 为什么单独一个函数而不是散在 JSX 里：**自检要能在没有 React 的情况下
     *   把"界面值 → 提交值"这条转换钉死**（尤其是 levels 与 tiers 这两个复合类型）。
     */
    function valueToPatch(spec, uiValue) {
      if (spec.kind === "levels") return { [spec.key]: uiValue };
      if (spec.kind === "tiers") return { [spec.key]: parseTiers(uiValue) };
      if (spec.kind === "number") {
        const n = Number(uiValue);
        return { [spec.key]: Number.isFinite(n) ? n : undefined };
      }
      // ★ `choice` 就是**字符串**。走下面那条兜底本来也对 —— 但显式写出来，
      //   是为了让"这个类型的值是什么形状"一眼可见（免得下一个人又按 boolean 猜）。
      if (spec.kind === "choice") {
        return { [spec.key]: typeof uiValue === "string" && uiValue !== "" ? uiValue : undefined };
      }
      return { [spec.key]: uiValue };
    }

    /**
     * 从当前设置里取出某个控件要显示的初值。
     *
     * ★★★ 2026-10-10 修（用户报的真 bug）：
     *   *"那个压缩模式为什么我选择之后不能保存，然后关掉再打开之后即使已经选择了，
     *     它依旧是空白的。两个模式都是未选择状态。"*
     *
     *   根因就是这里的**兜底**：原来最后一行是 `return v === true;` —— 那是给
     *   **boolean** 写的兜底，而 `choice` 没有自己的分支 ⇒ 也掉进这一行。
     *   于是已存 `"surgical"` 被读成 `false`，两个单选按钮**都不选中**。
     *   ★ 而且坏的不只是显示：`buildDraft` 用它造草稿 ⇒ 草稿初值是 `false` ⇒
     *     用户点完选项、`diffPatch` 一比对"没变化" ⇒ **patch 是空的、什么都没提交**。
     *     ⇒ 一个兜底同时造成"显示不出来"与"保存不上"，两半是同一个根因。
     *
     * 教训（比这个 bug 值钱）：断言只验了"选项渲染出来了"，**没验"选中值能不能往返"**
     *   —— 渲染断言对"选不中"完全无感。**一个新控件类型必须测它的值往返**。
     */
    function settingsToUi(spec, settings) {
      const v = settings === undefined ? undefined : settings[spec.key];
      if (spec.kind === "tiers") return formatTiers(v);
      if (spec.kind === "levels") return v === undefined || v === null ? {} : v;
      if (spec.kind === "number") return v === undefined || v === null ? "" : String(v);
      // ★ `choice`：原样把字符串交给控件（它自己按 options 比对谁被选中）。
      //   没设过就返回 `""`（而不是 undefined）—— 与 number 的 `""` 同一条口径：
      //   控件拿到的一定是**同一种类型**，不必每处再判 undefined。
      if (spec.kind === "choice") return typeof v === "string" ? v : "";
      return v === true;
    }

    /** 两个值是否等价（用来判断"有没有真的改动"）。 */
    function sameValue(a, b) {
      if (a === b) return true;
      if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((x, i) => x === b[i]);
      }
      if (a && b && typeof a === "object" && typeof b === "object") {
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        return ka.length === kb.length && ka.every((k) => sameValue(a[k], b[k]));
      }
      return false;
    }

    /**
     * 算出"草稿相对于已保存值"的差异 —— 只提交**改过的键**。
     *
     * ★★ 为什么只提交差异（而不是整份 settings）：服务端是**按补丁合并**的，
     *   整份提交会把"面板打开期间别处改过的键"覆盖回去 —— 那是典型的
     *   "用旧快照盖掉新改动"。只提交差异，冲突面就降到最小。
     */
    function diffPatch(specs, draft, saved) {
      const out = {};
      for (const spec of specs) {
        const next = valueToPatch(spec, draft[spec.key]);
        const prev = saved === undefined ? undefined : saved[spec.key];
        if (next[spec.key] === undefined) continue; // 空输入框：不提交
        if (!sameValue(next[spec.key], prev)) Object.assign(out, next);
      }
      return out;
    }

    // ───────────────────────────────────────────────────────────────────────
    // HTTP
    // ───────────────────────────────────────────────────────────────────────
    async function fetchJson(url, options) {
      const opts = Object.assign({ credentials: "same-origin", cache: "no-store" }, options || {});
      const res = await fetch(url, opts);
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error("宿主返回的不是 JSON（HTTP " + res.status + "）：" + text.slice(0, 200));
      }
      if (!res.ok && data && data.ok !== true) throw new Error(data.error || "HTTP " + res.status);
      return data;
    }

    function postJson(url, body) {
      return fetchJson(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    // ───────────────────────────────────────────────────────────────────────
    // CSS（只引用**核实过存在**的 --dsw-* 变量；画背景的必同时定 color）
    // ───────────────────────────────────────────────────────────────────────
    const CSS = `
/* dsh-ledger-memory —— 设置面板样式
   ============================================================================
   设计语言参照 dsh-codex-subscription 的设置分区（同为第三方插件、同样手写 CSS、
   同样只能使用内建符号）。可借鉴的是信息结构与视觉层级，不是它的实现：
   · 一组一张卡（.pl-settings__card），卡片内各行为「行 + 1px 分隔线」，
     而不是一行一张卡 —— 后者 42 项会渲染出 42 块并级边框，视觉上必然杂乱。
   · 行 = 左侧「标签 + 说明」两行文字，右侧控件；窄容器时自动换行堆叠。
   · 说明文字超出两行即省略，点击展开；短说明不出现无意义的展开入口。
   · 容器查询（container-type:inline-size）驱动响应式，而不是媒体查询 ——
     设置面板的宽度由侧栏决定，与视口宽度无关。

   ★ 三条硬约束（本工作区真实事故，改样式前必须遵守）：
   ① 只引用 --dsw-* 主题变量，且每个变量都要求同时适配浅色与深色主题。
      本文件出现的每一个变量都用 cordis_inspect_query(Theme) 核过；
      14 个官方 token 之外的（label-tertiary / border-l3 / bg-module-platform）
      一律带 fallback，缺失时不至于失去对比度。
   ② 自己画背景的元素必须同时显式设置 color，不许依赖 inherit ——
      浅色主题下 inherit 取到近黑文字，压在自己给的深色背景上即不可见
      （2026-09-25 模型路由真实事故）。
   ③ 三段式的底栏不 sticky。position:sticky 只在存在滚动容器时才贴住，
      而这里的滚动容器是 .pl-settings__scroll 自身，底栏是 flex 的固定一段。
   ============================================================================ */

.pl-settings {
  display: flex; flex-direction: column;
  /* ★★★★ 2026-10-20：**不再自己撑满高度、不再自己滚**（用户报"完全无法上下滑动"的真因）。
     官方设置面板的骨架（从 app.asar 的 dsh-client-ui-settings-general 提取，类名前缀 wCInkW）：
       .wCInkW_panel   {height:min(800px,calc(100vh - …)); display:flex; overflow:hidden}
       .wCInkW_content {flex-direction:column; flex:1; min-width:0; display:flex}
       .wCInkW_options {flex:1; min-height:0; padding:0 24px 24px; **overflow-y:auto**}  ← 滚动体是它
     我们是塞进 「_options」 里的一个普通 div —— 那层**只有 flex:1/min-height:0，没有确定高度**。
     所以下面这条 「height:100%」 的百分比**没有参照物**：按 CSS 规范解析成 auto，
     「flex:1」 的中段因此拿不到剩余高度，「overflow-y:auto」 **永远不会触发** ⇒ 只能看见最顶上那段。
     （「max-height:100%」 同理，也是无效的百分比。）
     ⇒ 正解：**放弃自己滚**，让官方的 「_options」 去滚。本组件退回"按内容自然排布"，
        高度由官方容器给，滚动也由官方容器负责。这才是插槽 occupant 该有的样子。
     ★ 判据（与 D220 那条同型）：**"双层滚动"不是加个 overflow 就有的**，
       内层要滚必须先有**高度**；拿不到高度时，越努力设 overflow 越像"卡住不动"。 */
  height: auto; min-height: 0;
  padding: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14.5px; line-height: 22px;
  container-type: inline-size;
}
/* 「未加载 / 只读」等无分页态：同样按内容自然排布。 */
.pl-settings--plain { height: auto; padding: 4px 2px 18px; gap: 14px; }

/* ── ① 头部：分页标签 ──────────────────────────────────────────────────
   ★★★★ 2026-10-20（用户第二次否掉选中态的黑色，这次把口径定死）：
     用户原话：*"顶部的那些选择不再用黑底，而是浅色底为主 … 点击选择之后，
     它不要用黑色来显示底部，应该依旧保持浅色，然后稍微深一点点那种就可以了。"*
     🔴 病根：「--dsw-alias-brand-primary」 在本机浅色主题下是**近黑**（#0f1115），
        官方只把它给"全屏唯一那个主按钮"用。拿它刷一整排标签 = 一排黑块。
     ⇒ 新口径（三段递进，**全部走"浅色底 + 稍微深一点"**）：
        · 未选中：透明底 + 细描边；
        · 悬停：currentColor 6% 的极浅底；
        · **选中：currentColor 11% 的浅底 + 实边 + 主文字色 + 加粗**。
     用 「currentColor」 做混色是**故意**的：它自动跟随深浅主题 ——
     浅色主题下是"浅灰里再深一点点"，深色主题下是"深灰里再浅一点点"，两边都成立。
     ⚠️ 不再用任何 「#fff」 硬编码前景/背景（那在深色主题下必然翻车 —— 本项目踩过）。
     ⚠️ 角标同理：原来"选中态用半透明白"是配合黑底的，现在底是浅的 ⇒ 改成中性浅底。 */
.pl-settings__tabs {
  /* ★★ 2026-10-21：改成 Codex 订阅面板那种「胶囊分组」——
     等分格 + 模块底色 + 12px 圆角，选中态是**浅色浮起**（bg-layer-1 + 轻投影），
     不是描边胶囊。★ 用户明确要求照着那个面板设计。
     ★ 格数由内容决定（「repeat(auto-fit,minmax(...))」），不写死 4 ——
       万一将来又多一页，这里不必跟着改（也就不会出现"5 页挤在 4 格里"）。 */
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 4px; padding: 4px;
  background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1));
  border-radius: 12px;
  margin-bottom: 14px;
}
.pl-settings__tab {
  min-width: 0; min-height: 36px;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 7px 8px;
  font: inherit; font-size: 13.5px; line-height: 20px; white-space: nowrap;
  cursor: pointer;
  background: transparent; border: 0; border-radius: 9px;
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
  transition: color .15s, background-color .15s, box-shadow .15s;
}
.pl-settings__tab:hover {
  color: var(--dsw-alias-label-primary);
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.pl-settings__tab:focus-visible {
  outline: 2px solid var(--dsw-alias-border-l3, var(--dsw-alias-brand-primary)); outline-offset: 1px;
}
.pl-settings__tab--on,
.pl-settings__tab--on:hover {
  /* ★ 仍是"浅色浮起"（用户 2026-10-20 否掉过黑底，那条口径必须守住）：
     用主题的 layer-1 作为**更亮/更浅的那一档**，配一层极轻的投影产生浮起感。 */
  /* ★ 2026-10-22：补一层兜底色 —— 若宿主主题里没有 「--dsw-alias-bg-layer-1」，
     「var()」 会整条失效 ⇒ 选中态退化成"完全透明"，看不出选的是哪一页。 */
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
  box-shadow: 0 1px 3px #0001;
}
/* 条目计数角标：中性底，不抢标签本身的视觉权重。 */
.pl-settings__tab-badge {
  flex: none; min-width: 16px; padding: 0 5px;
  font-size: 12px; font-weight: 500; line-height: 18px; text-align: center;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 8%, transparent);
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary)));
}
/* 选中态的角标：底也是浅的，所以只需要比标签底再深一档，不再用半透明白。 */
.pl-settings__tab--on .pl-settings__tab-badge {
  background: color-mix(in srgb, currentColor 12%, transparent);
  color: var(--dsw-alias-label-primary);
}

/* ── 开关（滑块式）─────────────────────────────────────────────────────
   ★ 2026-10-21（用户：*"一部分关于开关的可以做成滑块开关"*）。
   ★★ 里面那枚 <input type=checkbox> **不删除、只隐藏**（opacity 0 + 绝对定位铺满）：
      它仍在焦点链里、仍能被空格键切换、读屏仍念得到 label —— 外观交给轨道与圆点。
      ⚠️ 不能用 display:none 隐藏它，那会让这个开关**键盘按不动、读屏念不到**。 */
.pl-settings__switch {
  position: relative;
  display: inline-flex; align-items: center; flex: none;
  width: 40px; height: 24px; cursor: pointer;
}
.pl-settings__switch input {
  position: absolute; inset: 0; width: 100%; height: 100%;
  margin: 0; opacity: 0; cursor: pointer; z-index: 1;
}
.pl-settings__switch-track {
  display: block; box-sizing: border-box;
  width: 40px; height: 24px; padding: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 14%, transparent);
  border: 1px solid var(--dsw-alias-border-l2);
  transition: background-color .16s, border-color .16s;
}
.pl-settings__switch-knob {
  display: block; width: 18px; height: 18px; border-radius: 999px;
  /* ★ 2026-10-22：手柄用**固定白**，不用主题变量 —— 与滑块圆点同一条理由：
     深色主题下 「--dsw-alias-bg-*」 也变深 ⇒ 手柄与轨道糊成一团，看着就是个空椭圆。
     ★ 同时补一层细描边与投影：白手柄落在浅灰轨道上，没有描边会"边界不清"。 */
  background: #fff;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  box-shadow: 0 1px 2px #0003;
  transition: transform .16s;
}
.pl-settings__switch--on .pl-settings__switch-track {
  background: color-mix(in srgb, currentColor 34%, transparent);
  border-color: color-mix(in srgb, currentColor 42%, transparent);
}
.pl-settings__switch--on .pl-settings__switch-knob { transform: translateX(16px); }
.pl-settings__switch input:focus-visible + .pl-settings__switch-track {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px;
}
.pl-settings__switch input:disabled { cursor: not-allowed; }
.pl-settings__switch input:disabled + .pl-settings__switch-track { opacity: .45; }

/* ── 数值：拉条 + 精确输入 ─────────────────────────────────────────────
   ★ 2026-10-21（用户：*"关于数值的也可以做成拉条数值，而不是手填"*）。
   ★ 拉条给"快"，右边小框给"准" —— 有些值必须能精确到小数/个位（见 NumberRow 注释）。 */
.pl-settings__ctl-wrap--num {
  /* ★★★★★ 2026-10-22（用户第二次调这一处，原话）：
     *"滑快有必要给这么大空间吗？让他占据一小行，然后和数字框留相同的宽度就行了，
       数字放在它右边，这样子会好看很多。如果是题目更短的话，甚至可以让题目块和数字在同一行，
       保持相同的宽度。"*
     ⇒ 三件事：
       ① **滑块不再抢宽度**：原来 「flex: 1 1 140px; max-width: 260px」 会撑满整行右侧，
          看着像根晾衣杆。现在它与数字框**同宽**（同一个变量 「--pl-num-w」），
          整簇是**固定小宽度** ⇒ 所有数值行右边缘齐平，视觉上成一列。
       ② 数字框永远在滑块**右边**（DOM 顺序本来就是滑块 → 数字，这里只保证不换行）。
       ③ 行本身已经是「标签左 / 控件右 + 「align-items:center」」⇒ 标签短时天然同一行。
     ★ 为什么用变量而不是两处各写一个数：**"同宽"这件事只能有一个真源**。
       写两遍 「112px」 的话，以后改一处就不同宽了，而且不会有任何断言会红。 */
  --pl-num-w: 72px;
  display: flex; align-items: center; gap: 8px; min-width: 0;
  flex: none; flex-wrap: nowrap; justify-content: flex-end;
}
.pl-settings__range-input {
  /* ★★★★★ 2026-10-22（用户当场抓到：「那堆滑块怎么全部做成椭圆形了」）：
     我把「轨道那条线」画在了 <input> **自己的背景**上（height:4px + radius:999px）。
     这在真机里是**脆的**：宿主只要对 input 设了 height / min-height / padding 中任意一项，
     那个盒子就会被撑高，而 「border-radius:999px」 会把**任何**高度的盒子画成椭圆/stadium
     ⇒ 于是"滑块"变成一堆椭圆。
     ★★ 我在隔离环境量过：单独渲染时它是 260×4 的一条细线（看起来是对的）；
        所以这**不是"我的 CSS 写错了"，是"它依赖了一个不该依赖的默认值"**。
     ⇒ 正解：**线条交给伪元素画**（「::-webkit-slider-runnable-track」），
       「<input>」 自己只当一个高度正常、背景透明的点击区。
       ★ 宿主改 input 的高度也**伤不到轨道** —— 那是另一套渲染盒子。
     ⚠️ 别退回"给 input 设 height + radius"那种写法，它只在没被覆盖时对。 */
  /* ★ 2026-10-22：宽度与数字框**同一个变量** ⇒ 恒等宽，且不再随容器伸缩。 */
  flex: 0 0 var(--pl-num-w);
  width: var(--pl-num-w); min-width: 0; max-width: var(--pl-num-w);
  height: 24px;
  margin: 0; padding: 0;
  background: transparent; border: 0; border-radius: 0;
  cursor: pointer;
  -webkit-appearance: none; appearance: none;
}
/* Chromium / Edge / Safari：轨道 = 那条 4px 的线 */
.pl-settings__range-input::-webkit-slider-runnable-track {
  height: 4px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 18%, transparent);
}
/* 圆点：白底 + 细描边。★ 用固定白而不是主题变量 —— 开关/滑块的手柄在任何主题下都是白的，
   而 「--dsw-alias-bg-*」 在深色主题下会变成深色 ⇒ 手柄与轨道糊在一起（那是"看不见"，比"丑"更糟）。 */
.pl-settings__range-input::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 14px; height: 14px;
  margin-top: -5px; /* (14 - 4) / 2 的一半 ⇒ 让圆点垂直居中在 4px 轨道上 */
  border-radius: 999px;
  background: #fff;
  border: 1px solid color-mix(in srgb, currentColor 45%, transparent);
  box-shadow: 0 1px 3px #0003;
  cursor: pointer;
}
/* Firefox：它不认 -webkit-slider-runnable-track，必须单独给 */
.pl-settings__range-input::-moz-range-track {
  height: 4px; border: 0; border-radius: 999px;
  background: color-mix(in srgb, currentColor 18%, transparent);
}
.pl-settings__range-input::-moz-range-thumb {
  width: 14px; height: 14px; border-radius: 999px;
  background: #fff;
  border: 1px solid color-mix(in srgb, currentColor 45%, transparent);
  box-shadow: 0 1px 3px #0003;
  cursor: pointer;
}
.pl-settings__range-input:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 4px;
}
.pl-settings__range-input:disabled { opacity: .45; cursor: not-allowed; }
.pl-settings__num-box {
  display: inline-flex; align-items: center; gap: 4px; flex: none;
}
.pl-settings__unit {
  /* ★ 2026-10-22：单位文字的宽度不同（「%」「行」「字符」）会把数字框的**右边缘**推得参差不齐 ——
     实测三行分别是 671.8 / 670.5 / 659，看着就是没对齐。
     ⇒ 给单位一个固定的最小宽度并左对齐 ⇒ 整列数字框右边缘齐平。
     ⚠️ 不要改回 auto 宽度：那样"对齐"只取决于这一页恰好有哪些单位，换一页又歪。 */
  display: inline-block;
  box-sizing: border-box;
  min-width: 2.6em;
  text-align: left;
  font-size: 13px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  white-space: nowrap;
}

/* ── 按钮变体：主操作 / 危险操作 ─────────────────────────────────────── */
.pl-settings__btn--primary {
  background: color-mix(in srgb, currentColor 10%, transparent);
  border-color: color-mix(in srgb, currentColor 32%, transparent);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.pl-settings__btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, currentColor 15%, transparent);
}
.pl-settings__btn--danger {
  color: #b3261e;
  border-color: color-mix(in srgb, #b3261e 38%, transparent);
}
.pl-settings__btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, #b3261e 9%, transparent);
}
.pl-settings__btn:disabled { opacity: .5; cursor: not-allowed; }

/* ── 扩展记忆页（1.5.0）───────────────────────────────────────────────
   ★ 结构与设置页一致：卡片 + 分隔线，不做成表格式。
   ⚠️ 不用任何硬编码前景色（深色主题下会翻车 —— 本项目踩过）。 */
.pl-ext { display: flex; flex-direction: column; gap: 12px; }
.pl-ext__top {
  display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap;
  justify-content: space-between;
}
.pl-ext__pick { display: inline-flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.pl-ext__pick select,
.pl-ext__input {
  font: inherit; font-size: 14px; line-height: 20px;
  min-height: 30px; padding: 4px 8px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  min-width: 180px;
}
.pl-ext__input { flex: 1 1 220px; min-width: 0; }
.pl-ext__card {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  padding: 2px 16px;
}
.pl-ext__card-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  padding: 12px 0 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.pl-ext__card-title { font-size: 14.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.pl-ext__card-hint { font-size: 13px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.pl-ext__card-body { display: flex; flex-direction: column; gap: 10px; padding: 12px 0; }
.pl-ext__field { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pl-ext__flabel {
  flex: none; min-width: 96px; font-size: 14px;
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
}
.pl-ext__modehint {
  font-size: 13px; line-height: 19px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  padding-left: 106px;
}
.pl-ext__form-actions { display: flex; justify-content: flex-end; padding-top: 2px; }
.pl-ext__list { display: flex; flex-direction: column; }
.pl-ext__item {
  display: flex; align-items: flex-start; gap: 12px; justify-content: space-between;
  padding: 10px 0; flex-wrap: wrap;
}
.pl-ext__item + .pl-ext__item { border-top: 1px solid var(--dsw-alias-border-l2); }
.pl-ext__item-main { display: flex; flex-direction: column; gap: 3px; flex: 1 1 260px; min-width: 0; }
.pl-ext__item-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 14.5px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.pl-ext__badge {
  padding: 0 6px; border-radius: 999px;
  font-size: 12px; font-weight: 500; line-height: 18px;
  background: color-mix(in srgb, currentColor 9%, transparent);
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
}
.pl-ext__badge--on { background: color-mix(in srgb, currentColor 18%, transparent); color: var(--dsw-alias-label-primary); }
.pl-ext__item-desc { font-size: 13.5px; line-height: 20px; color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary)); }
.pl-ext__item-usage {
  font-size: 12.5px; line-height: 18px; word-break: break-all;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
}
.pl-ext__item-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.pl-ext__confirm {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 12px; border-radius: 10px;
  border: 1px solid color-mix(in srgb, #b3261e 40%, transparent);
  background: color-mix(in srgb, #b3261e 6%, transparent);
}
.pl-ext__confirm-text { font-size: 14px; line-height: 21px; color: var(--dsw-alias-label-primary); }
.pl-ext__confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* ── ② 中部：**不是**滚动容器，只是内容的自然容器 ────────────────────────
   ★★★★ 2026-10-20（用户报「完全无法上下滑动，只能看到最顶上」）：
     这里原来是 「flex:1 1 auto; min-height:0; overflow-y:auto」 —— 那套写法**只有在
     「.pl-settings」 自己能拿到确定高度时才成立**。而官方是把它塞进
     「.wCInkW_options{flex:1; min-height:0; overflow-y:auto}」 里的，那一层**只给剩余高度、
     不给确定高度** ⇒ 我们的 「height:100%」 退化成 auto ⇒ 中段高度塌成内容高度的一部分，
     「overflow-y:auto」 一次都不会触发 ⇒ **整页只有最上面可见，滚不动**。
   ⇒ 正解：**滚动交给官方的 「_options」**（它天生就是滚动的）。
     本层退回普通容器：不设 flex 拉伸、不设 overflow、不设高度。
   ★ 同样去掉的还有 「.pl-settings__tabs」 的 「flex:none」 依赖 —— 没有 flex 父级就无所谓了，
     留着也无害，但不要再在注释里写"固定一段"这种只对旧结构成立的承诺。 */
.pl-settings__scroll {
  display: flex; flex-direction: column; gap: 14px;
  padding: 14px 2px 18px;
}
.pl-settings__intro {
  max-width: 720px; padding: 10px 12px;
  font-size: 14px; line-height: 21px;
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
}

/* ── 分组：一组一张卡 ──────────────────────────────────────────────────
   卡内有若干行，行与行之间用 1px 分隔线，而不是让每一行各带一圈边框。
   这是与旧版最直观的差别：旧版 42 项 = 42 块并级卡片。 */
.pl-settings__card {
  display: flex; flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
}
.pl-settings__card-head {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  padding: 11px 14px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.pl-settings__card-title {
  font-size: 14.5px; font-weight: 600; line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.pl-settings__card-hint {
  font-size: 13px; line-height: 19px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary)));
}
.pl-settings__card-body { display: flex; flex-direction: column; }

/* ── 行 ────────────────────────────────────────────────────────────────
   min-height 而非固定高：说明展开时自然长高。
   窄容器下 flex-wrap 让控件落到下一行，不会把标签挤成一列单字。 */
.pl-settings__row {
  display: flex; flex-wrap: wrap; align-items: center;
  justify-content: space-between; gap: 8px 14px;
  min-height: 34px; box-sizing: border-box;
  padding: 10px 14px;
  color: var(--dsw-alias-label-primary);
}
/* 行间分隔线：只在相邻行之间，首行前与末行后都不画。 */
.pl-settings__row + .pl-settings__row,
.pl-settings__row--stack + .pl-settings__row {
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.pl-settings__row--stack { flex-direction: column; align-items: stretch; }
/* 关键规则项：左侧一道品牌色描边。去掉 markdown 标记后，
   这是「表达重点」的主要手段（用户明确要求面板纯文本）。 */
.pl-settings__row--emphasis { border-left: 3px solid var(--dsw-alias-brand-primary); }
.pl-settings__row--stack.pl-settings__row--emphasis { border-left: 3px solid var(--dsw-alias-brand-primary); }

/* ★★★★ 2026-10-20（用户截图：\"上面一大片空白\"）：
   「.pl-settings__main { flex: 1 1 240px }」 —— 这个 「240px」 是 **flex-basis**，
   它的方向**跟着父级的 flex-direction 变**：
     · 横向行（父级 row）  ⇒ 240px 是**宽度**，本意如此，没问题；
     · **stack 行（父级 column）⇒ 240px 变成高度** ⇒ 整行被撑到 240px 高，
       而里面只有标签+hint 那两三行文字（约 60~80px）⇒ **底下空出一大块**。
   用户截图里那块空白正是它：一行文字顶到最上面，下面 150 多像素全空。
   ⇒ 正解：**在 stack 行里把 basis 归零、让它按内容高**。
     不能在 「.pl-settings__main」 上直接把 240px 改小 —— 横向行需要它做\"最小宽度\"。 */
.pl-settings__main { flex: 1 1 200px; min-width: 0; display: flex; flex-direction: column; gap: 3px; }

/* ★★★★★ 2026-10-22（用户截图：标签占满一行、滑块掉到下一行、数字框再掉一行 ⇒ 一行变三层）：
   普通行改成 **grid 两列**：「标签」 与 「控件」 在**同一行**，说明独占**下面整行**。
   ★ 为什么不是继续调 flex-basis：① 实测 470px 宽的侧栏里，main 的 basis ≥240px 就换行
     （240 → 行高 106px 且控件折行；200 → 行高 87px 且同一行）；② 但**说明被挤在 222px 的窄列里
     必然折成两行** ⇒ 光调 basis 只能到 87px，到不了"一小行"。
   ★★ 用 「display:contents」 把 main 的子元素（标签行 / 说明）**提到 grid 层**，
      说明就能横跨两列 ⇒ 25~30 字的说明在 470px 下**正好一行**。
   ⚠️ 只对**普通行**生效：「--stack」 行（水位档位 / 日志四档）本来就是上下堆叠，保持原 flex，
      否则它们会被拆坏。这条 「:not()」 是必须的。
   ⚠️ 所以 「.pl-settings__main」 的 flex 规则**不能删** —— stack 行还在用它。 */
.pl-settings__row:not(.pl-settings__row--stack) {
  /* ★★★ 2026-10-22（用户："那些有滑块的再收窄一点，然后对齐一下各个部分，现在不是怎么齐"）：
     两个问题一起修：
     ① **收窄**：「--pl-num-w」 104 → 72（滑块与数字框同步变窄，因为它们同源）。
     ② **对齐**：第二列原来是 「auto」 ⇒ 每行的控件宽度不同（滑块簇 ~250px、开关只有 40px），
        右对齐后**左边缘参差**，看起来就是"不齐"。
        ⇒ 改成**固定列宽** 「--pl-ctl-w」，所有行的控件都从**同一条竖线**开始、到**同一条竖线**结束。
        ★ 判据：**"对齐"必须是结构保证，不是巧合** —— 用 auto 时只要某一行的单位文字变长，
          整列就又歪了，而且不会有任何断言红。 */
  --pl-ctl-w: 192px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--pl-ctl-w);
  align-items: center;
  column-gap: 12px; row-gap: 2px;
}
/* ★★★★★ 2026-10-22（用户："你在浏览器那里打开的面板很整齐，但是一放到我们的设置面板这里就乱了"）：
   这一版**不再依赖 display:contents**（那个技巧只要被宿主任何一条样式碰到就会失效，
   一失效就退化成"标签 / 控件 / 说明全堆成竖条"—— 正是用户看到的样子）。
   现在 grid 的三个部分都是行的**直接子元素**，结构上没什么可被打坏的。 */
.pl-settings__row:not(.pl-settings__row--stack) > .pl-settings__label-line {
  grid-column: 1; grid-row: 1;
}
.pl-settings__row:not(.pl-settings__row--stack) > .pl-settings__ctl {
  grid-column: 2; grid-row: 1;
  /* 控件一律靠右贴着固定列的右边缘 ⇒ 右边缘齐平；左边缘由列宽保证。 */
  justify-content: flex-end;
  min-width: 0;
}
.pl-settings__row:not(.pl-settings__row--stack) > .pl-settings__hint {
  grid-column: 1 / -1; grid-row: 2;
}
.pl-settings__row:not(.pl-settings__row--stack) > .pl-settings__scope-warn {
  grid-column: 1 / -1; grid-row: 3;
}
/* ★ stack 行（column 方向）里，弹性和基准都不能按宽度算 —— 一律按内容。 */
.pl-settings__row--stack > .pl-settings__main { flex: 0 1 auto; }
.pl-settings__label-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pl-settings__label {
  font-size: 14.5px; font-weight: 500; line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
/* hint 折叠：超过两行省略，展开后完整显示。 */
.pl-settings__hint {
  font-size: 13px; line-height: 19px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary)));
}
.pl-settings__hint-text {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  overflow: hidden;
}
.pl-settings__hint--open .pl-settings__hint-text {
  display: block; -webkit-line-clamp: unset; overflow: visible;
}
.pl-settings__hint-more {
  display: inline-flex; align-items: center; gap: 3px;
  margin-top: 2px; padding: 0; border: 0; background: none;
  font: inherit; font-size: 13px; line-height: 19px; cursor: pointer;
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
}
/* 展开箭头用 CSS 边框画，不引图标资源。 */
.pl-settings__hint-more::after {
  content: ""; width: 5px; height: 5px; margin-top: -2px;
  border: solid currentColor; border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg); transition: transform .15s;
}
.pl-settings__hint--open .pl-settings__hint-more::after { margin-top: 2px; transform: rotate(-135deg); }
.pl-settings__hint-more:hover { color: var(--dsw-alias-label-primary); }
.pl-settings__hint-more:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; border-radius: 3px;
}

/* 「仅影响本项目」徽标：中性胶囊，不抢主标签。
   注意：它是否出现由 settingPrecedence 动态决定，静态文案不许断言作用域。 */
.pl-settings__tag {
  flex: none; padding: 0 6px; border-radius: 999px;
  font-size: 11.5px; font-weight: 500; line-height: 18px;
  background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary)));
  border: 1px solid var(--dsw-alias-border-l2);
}
.pl-settings__scope-warn {
  margin-top: 4px; padding: 6px 10px; border-radius: 8px;
  font-size: 13px; line-height: 19px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
  border-left: 3px solid var(--dsw-alias-state-warn-primary);
}

/* ── 控件 ────────────────────────────────────────────────────────────── */
.pl-settings__ctl { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
.pl-settings__ctl-wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.pl-settings__range {
  font-size: 12px; line-height: 17px; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary)));
  font-variant-numeric: tabular-nums;
}
.pl-settings__levels { display: flex; flex-wrap: wrap; gap: 12px; padding-top: 2px; }
.pl-settings__lvl {
  display: flex; align-items: center; gap: 6px;
  font-size: 13.5px; line-height: 20px; color: var(--dsw-alias-label-primary);
}
.pl-settings__num {
  /* ★ 2026-10-22：与滑块**同一个宽度变量**（见 「__ctl-wrap--num」 的注释）。
     变量没定义时（例如别处单独用到这个类）退回 72px，不会变成一个怪异宽度。 */
  width: var(--pl-num-w, 72px); box-sizing: border-box; padding: 5px 9px;
  font: inherit; font-size: 14px; border-radius: 8px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
  /* ★★★ 2026-10-22（截图里「60000」被截成「6000(」）：
     number 输入框右侧那对**上下箭头**要占掉约 14px，而这里框只有 72px 宽
     ⇒ 文字区只剩 ~38px，六位数放不下。
     ⇒ 去掉箭头（值仍可键盘输入、也可用左边拉条调）。
     ⚠️ 不是把框加宽 —— 用户要的是"收窄"，加宽等于把刚解决的问题又还回去。
     ⚠️ 只去掉**数字框**的箭头；别动其它 input。 */
  -moz-appearance: textfield;
  appearance: textfield;
}
.pl-settings__num::-webkit-outer-spin-button,
.pl-settings__num::-webkit-inner-spin-button {
  -webkit-appearance: none;
  appearance: none;
  margin: 0;
}
.pl-settings__num:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0;
  border-color: transparent;
}
.pl-settings__num:disabled { opacity: .55; cursor: not-allowed; }
.pl-settings__num--wide { width: 176px; }

/* ★★★ 2026-10-22（用户报「那堆滑块怎么全部做成椭圆形了」，顺着量出来的同型问题）：
   面板里的输入控件**必须压得住宿主对「input」的通用样式**。
   ★ 实测（截图存证）：给宿主加一条 「input{border-radius:999px;height:32px}」，
     「70」「300」两个数字框当场变成椭圆 —— 原因是我原来只写单类选择器（特异性 0,1,0），
     而宿主只要写「.某个容器 input」就比它高，**谁赢取决于加载顺序**，那不是设计。
   ⇒ 用「.pl-settings .pl-settings__num」把特异性抬到 0,2,0，在**不动用 !important**
     的前提下稳压一层容器选择器。
   ⚠️ 宿主若用了 「!important」，面板应当**认输并显形**，不要反过来也堆 !important ——
     两边都 !important 只会变成"谁写得多谁赢"的军备竞赛，而且下一个改的人看不懂。
   ⚠️ 同理：滑块那条线**不再画在 input 自己身上**（那会被 height 撑成椭圆），
     改画在 「::-webkit-slider-runnable-track」 上 —— 见上面的 「__range-input」 注释。 */
.pl-settings .pl-settings__num { border-radius: 8px; }
.pl-settings .pl-settings__range-input { border-radius: 0; background: transparent; }
.pl-settings .pl-settings__switch input { border-radius: 0; }

/* 核选框 / 单选框：跟随主题强调色，不写死颜色。 */
.pl-settings__row input[type="checkbox"],
.pl-settings__row input[type="radio"],
.pl-settings__lvl input[type="checkbox"] {
  flex: none; width: 15px; height: 15px; margin: 0;
  accent-color: var(--dsw-alias-brand-primary); cursor: pointer;
}
.pl-settings__row input:disabled,
.pl-settings__lvl input:disabled { cursor: not-allowed; opacity: .55; }

/* 二选一：把两个选项的取舍都摆在眼前，不用下拉框折叠。 */
.pl-settings__choices { display: flex; flex-direction: column; gap: 6px; width: 100%; padding-top: 2px; }
.pl-settings__choice {
  display: flex; gap: 9px; align-items: flex-start; cursor: pointer;
  padding: 9px 11px; border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  transition: border-color .15s, background-color .15s;
}
.pl-settings__choice:hover { border-color: var(--dsw-alias-label-secondary, var(--dsw-alias-border-l1)); }
.pl-settings__choice--on {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
}
.pl-settings__choice input { margin-top: 3px; }
.pl-settings__choice-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pl-settings__choice-label { font-size: 14px; line-height: 21px; color: var(--dsw-alias-label-primary); }
.pl-settings__choice-hint {
  font-size: 13px; line-height: 19px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary)));
}

/* ── ③ 底部：固定操作栏（flex 的固定一段，不 sticky，不铺底色）──────────
   旧写法给 bg-base，在深色主题下是一条黑带，整排按键像浮在黑布上
   （2026-10-18 用户原话：「为什么要用黑色的底布来作为这个按钮的衬托」）。
   三段式下内容不重叠，本就不需要遮挡，因此只留一条分隔线。 */
.pl-settings__bar {
  flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 12px 2px 2px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.pl-settings__bar-msg { flex: none; padding: 0 2px 8px; font-size: 13.5px; line-height: 20px; }
/* 推送按钮推到最右端，与左侧三键在视觉上分开（它原来挤在同一行，像浮窗）。 */
.pl-settings__btn--push { margin-left: auto; }

.pl-settings__btn {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 32px; padding: 6px 16px;
  font: inherit; font-size: 14px; font-weight: 500; cursor: pointer;
  border-radius: 8px;
  /* ★★★★ 2026-10-20（用户：*"它不要用黑色来显示底部，应该依旧保持浅色，然后稍微深一点点"*）：
     原来 「background: brand-primary」 —— 本机浅色主题下那是**近黑 #0f1115**，
     于是"保存"变成一块黑砖，正是用户反复说的那种别扭。
     ⇒ 主按钮也换成**浅色底 + 稍微深一档**（17% currentColor，比标签选中态 11% 再深），
       文字用 label-primary，**不再有 #ffffff 硬编码**（深色主题下它本来就会翻车）。 */
  background: color-mix(in srgb, currentColor 17%, transparent);
  color: var(--dsw-alias-label-primary);
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
  transition: opacity .15s, border-color .15s, background-color .15s;
}
.pl-settings__btn:hover:not(:disabled) {
  background: color-mix(in srgb, currentColor 23%, transparent);
}
.pl-settings__btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px;
}
.pl-settings__btn:disabled { opacity: .45; cursor: not-allowed; }
.pl-settings__btn--ghost {
  background: transparent; color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
}
.pl-settings__btn--ghost:hover:not(:disabled) {
  opacity: 1; border-color: var(--dsw-alias-label-secondary, var(--dsw-alias-border-l1));
}

.pl-settings__msg { font-size: 13.5px; line-height: 20px; }
.pl-settings__msg--ok { color: var(--dsw-alias-state-success-primary); }
.pl-settings__msg--err { color: var(--dsw-alias-state-error-primary); }
.pl-settings__msg--warn { color: var(--dsw-alias-state-warn-primary); }
/* 中性提示块：画了背景，因此必须同时显式指定 color。 */
.pl-settings__note {
  padding: 10px 12px; border-radius: 10px;
  font-size: 13.5px; line-height: 20px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
  border: 1px solid var(--dsw-alias-border-l1);
}
.pl-settings__mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

/* ── 响应式：按容器宽度，不按视口宽度 ────────────────────────────────
   面板宽度由设置侧栏决定，与浏览器窗口不是一回事。
   ★★★★★ 2026-10-22（用户截图：滑块独占一行、数字框又掉到下一行）：
     原来这里写着
       「.pl-settings__main { flex: 1 1 100% }」 + 「.pl-settings__ctl { flex: 1 1 100% }」
     ⇒ 只要侧栏窄于 560px（**设置侧栏几乎总是窄于 560px**）就会命中，
       于是「标签+说明」吃满一行、控件被挤到下一行、数字框再掉一行 —— 用户看到的三层堆叠。
     ★ 这不是"响应式写错了"，是**断点选错了**：560px 对设置侧栏来说不是"窄"，是常态。
     ⇒ 改法：**控件永不换行**，只按宽度收缩滑块；真正的堆叠留到 360px 以下（那时确实放不下）。
       ★ 收缩滑块只需改 「--pl-num-w」 一个变量 —— 滑块与数字框都从它取值（见上面的注释）。 */
@container (max-width: 640px) {
  .pl-settings__ctl-wrap--num { --pl-num-w: 64px; }
  .pl-settings__row:not(.pl-settings__row--stack) { --pl-ctl-w: 176px; }
}
@container (max-width: 460px) {
  .pl-settings__ctl-wrap--num { --pl-num-w: 56px; }
  .pl-settings__row:not(.pl-settings__row--stack) { --pl-ctl-w: 160px; }
  .pl-settings__row { gap: 6px 10px; padding: 9px 11px; }
}
@container (max-width: 360px) {
  /* 真放不下了才堆叠。★ 到这一档才允许控件独占一行。 */
  .pl-settings__main { flex: 1 1 100%; }
  .pl-settings__ctl { flex: 1 1 100%; justify-content: flex-start; }
  .pl-settings__ctl-wrap { align-items: flex-start; }
  .pl-settings__row { padding: 10px 11px; }
  .pl-settings__card-head { padding: 10px 11px; }
  .pl-settings__tab { padding: 5px 9px; }
  .pl-settings__btn { padding: 6px 12px; }
}
`;

    function installCss(ctx) {
      return ctx.effect(() => {
        if (typeof document === "undefined") return () => {};
        if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') !== null) return () => {};
        const tag = document.createElement("style");
        tag.dataset.plugin = PLUGIN_ID;
        tag.dataset.pluginCss = CSS_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, PLUGIN_ID + ": styles");
    }

    // ───────────────────────────────────────────────────────────────────────
    // 面板
    // ───────────────────────────────────────────────────────────────────────

    /**
     * ★★★★★ 2026-10-18（D256，用户拍板）：**长说明折叠成一句**（"精简里面的说明"）。
     *
     * ★ 判据（纯函数，自检可钉死）：给定一条 hint，返回「首句」。
     *   · 短于 `HINT_FOLD_CHARS` ⇒ 原样返回（`folded === text`，界面不显示展开按钮）
     *   · 长于它 ⇒ 截到**第一个句末标点**（。！？）之后；找不到就截到该长度并加省略号
     * ★ 为什么按"首句"而不是"前 N 字"：首句通常是**这个开关干什么**，
     *   而后面才是实测数据与边界 —— 那正是可以收起的那部分。
     * ★ 首句本身就超长时（某些 hint 一句话就很长）仍要截，否则折叠等于没折。
     */
    const HINT_FOLD_CHARS = 60;

    function firstSentence(text) {
      const s = typeof text === "string" ? text : "";
      if (s.length <= HINT_FOLD_CHARS) return s;

      // ★★★ 三条判据按顺序试，**每一条的结果都必须严格短于原文**才算数。
      //   （这是探针连抓两次才立起来的硬约束 —— 见下方注释里的两次真缺陷。）
      const shorter = (v) => typeof v === "string" && v.length < s.length;

      const tail = s.slice(HINT_FOLD_CHARS);

      // ① 优先：阈值之后的第一个句末标点（读起来最自然）
      const m = /[。！？]/.exec(tail);
      if (m !== null) {
        const cand = s.slice(0, HINT_FOLD_CHARS + m.index + 1);
        if (shorter(cand)) return cand;
      }

      // ② 次选：更弱的断句符（分号 / 破折号 / 箭头 / 空白）
      //
      //   ★★★ 探针抓到的真缺陷之一：只找句号时，有 11 条 hint 在 60 字之后
      //     整段没有句号（它们是"逗号+分号"的长句）⇒ 折叠完全没生效（61→61、63→63…）。
      //     那些恰恰最该收起。加这一级之后才真能折。
      const weak = /[；;—–⇒\s]/.exec(tail);
      if (weak !== null) {
        const cand = s.slice(0, HINT_FOLD_CHARS + weak.index);
        if (shorter(cand)) return cand;
      }

      // ③ 兜底：硬截 + 省略号，并且**必须比原文短**。
      //
      //   ★★★ 探针抓到的真缺陷之二（比第一条更隐蔽）：
      //     兜底原写 `slice(0, HINT_FOLD_CHARS) + "…"` ⇒ 长度 = 61。
      //     而有些 hint 原文就**恰好 61 字**（第 61 字是句号）⇒ 61 === 61
      //     ⇒ 「一个字都没变短」，折叠等于没做。
      //     ⇒ 只有当强/弱分隔给出**严格更短**的结果时才用它们，否则一路截到 60 以内。
      const cut = Math.min(HINT_FOLD_CHARS - 1, s.length - 1);
      return s.slice(0, Math.max(1, cut)) + "…";
    }

    /** 长说明 → 两行截断、可展开。短说明原样显示，不出现无意义的展开入口。 */
    function Hint(props) {
      const text = typeof props.text === "string" ? props.text : "";
      const [open, setOpen] = useState(false);
      if (text === "") return null;
      // ★ 2026-10-22：接受 `style` —— 由 Row 传**内联定位**（grid-column / grid-row）。
      //   内联是唯一不会被宿主样式表打败的定位方式（见 Row 的注释）。
      //   ⚠️ 这里只透传 `style`，不合并别的属性：Hint 的装饰仍然全在 CSS 里。
      const st = props.style;
      // 短说明：一行放得下，不折叠。
      if (text.length <= HINT_FOLD_CHARS) {
        return h(
          "div",
          { className: "pl-settings__hint", style: st },
          h("span", { className: "pl-settings__hint-text" }, text)
        );
      }
      return h(
        "div",
        { className: "pl-settings__hint" + (open ? " pl-settings__hint--open" : ""), style: st },
        h("span", { className: "pl-settings__hint-text" }, text),
        h(
          "button",
          {
            className: "pl-settings__hint-more",
            type: "button",
            "aria-expanded": open,
            onClick: () => setOpen(!open),
          },
          open ? "收起" : "展开"
        )
      );
    }

    /** 「仅影响本项目」徽标：是否出现由 settingPrecedence 的**实时生效值**决定。 */
    function ScopeTag(props) {
      if (props.scopeNote !== "project-first" || props.projectFirst !== true) return null;
      return h("span", { className: "pl-settings__tag" }, "仅影响本项目");
    }

    /** 作用域说明块：同样只在「以项目清单为准」时成立。 */
    function ScopeNote(props) {
      if (props.scopeNote !== "project-first" || props.projectFirst !== true) return null;
      return h(
        "div",
        { className: "pl-settings__scope-warn", style: props.style },
        "本项以项目清单为准，每个项目使用自身 .dsh-ledger.json 中的取值。" +
          "实际生效值见每回合注入的「当前设置」快照。"
      );
    }

    /**
     * 一行设置项：左侧「标签 + 说明」，右侧控件。
     *
     * ★ 相邻行之间的分隔线由 CSS 的 `.row + .row` 提供，行自身不画边框 ——
     *   这样一组 42 项只会出现一张卡片的轮廓，而不是 42 圈并级边框。
     *
     * ★★★★★ 2026-10-22（用户真机截图：**标签 / 滑块 / 数字框 / 说明 仍然是四层**）：
     *   **CSS 方案在真实宿主 DOM 里被打败了 —— 这一轮换成内联 style。**
     *
     *   前两轮我一直在改 `.pl-settings__*` 这些**类选择器**（grid 两列、`display:contents`、
     *   容器查询断点、固定列宽…）。隔离页里量着都对，用户那边一放就是竖条。原因很简单：
     *   **类选择器永远会输给宿主的任何一条更具体的规则**，而宿主对 `div` / `label` / `input`
     *   可能还有全局规则，甚至我们不知道它给侧栏容器设了什么。
     *   ⇒ ★★★ 正解：**结构布局写在 `style` 上（内联）。**
     *     内联的唯一对手是样式表里的 `!important`（宿主极少对这类结构属性用），
     *     它**不吃选择器特异性、不吃样式表解析失败、不吃加载顺序**。
     *   ⇒ 判据（本轮学到的）：**「对齐」若只靠样式表，就一定会被环境改写；
     *     想让它成为结构保证，就得写在结构本身上。**
     *
     *   ★ 但**响应式仍然要保留**：所以内联的**值**用 `var(--pl-ctl-w, 192px)` 这种形式 ——
     *     属性由内联锁死，**取值**仍可由容器查询改（两条路互不打架）。
     *     ★ 这也顺带解决了"窄屏下该收窄"的诉求：断点只需改变量，不必改 JS。
     *
     *   ⚠️ **装饰（圆角 / 颜色 / 分隔线 / 开关外观）故意仍留在 CSS** ——
     *     那部分被宿主覆盖只是"不好看"，不会让布局塌成竖条。
     *     **结构与装饰分开承受风险**，这是这次修复的核心取舍。
     */
    function Row(props) {
      const cls =
        "pl-settings__row" +
        (props.stack === true ? " pl-settings__row--stack" : "") +
        (props.emphasis === true ? " pl-settings__row--emphasis" : "");
      const stack = props.stack === true;

      // ★ 行容器：普通行 = 两列 grid（标签左 / 控件右，说明独占第二行）；
      //   stack 行 = 竖向 flex（选择项 / 多行控件本来就该上下排）。
      const rowStyle = stack
        ? {
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            justifyContent: "flex-start",
            flexWrap: "nowrap",
            gap: "6px",
            minWidth: 0,
            boxSizing: "border-box",
          }
        : {
            display: "grid",
            // ★ 属性内联锁死；**宽度值走变量** ⇒ 容器查询仍能把它改窄。
            gridTemplateColumns: "minmax(0, 1fr) var(--pl-ctl-w, 192px)",
            columnGap: "12px",
            rowGap: "3px",
            alignItems: "center",
            justifyContent: "normal",
            minWidth: 0,
            boxSizing: "border-box",
          };

      const labelStyle = {
        display: "flex",
        alignItems: "center",
        flexWrap: "nowrap",
        gap: "6px",
        minWidth: 0,
        ...(stack ? {} : { gridColumn: "1", gridRow: "1" }),
      };

      const ctlStyle = {
        display: "flex",
        alignItems: "center",
        flexWrap: "nowrap",
        gap: "8px",
        minWidth: 0,
        // 普通行：控件贴着固定列的右边缘 ⇒ 各行右边缘齐平（"对齐"由列宽保证，不靠巧合）。
        ...(stack ? { justifyContent: "flex-start" } : { gridColumn: "2", gridRow: "1", justifyContent: "flex-end" }),
      };

      // 说明与作用域提示：普通行里**横跨两列、各占一整行**（这就是"说明独占一行"的结构保证）。
      const fullRow = stack ? {} : { gridColumn: "1 / -1" };

      return h("div", { className: cls, style: rowStyle }, [
        h(
          "div",
          { key: "l", className: "pl-settings__label-line", style: labelStyle },
          h("span", { key: "t", className: "pl-settings__label" }, props.label),
          h(ScopeTag, { key: "g", scopeNote: props.scopeNote, projectFirst: props.projectFirst })
        ),
        h("div", { key: "c", className: "pl-settings__ctl", style: ctlStyle }, props.children),
        props.hint
          ? h(Hint, {
              key: "h",
              text: props.hint,
              style: { ...fullRow, ...(stack ? {} : { gridRow: "2" }), minWidth: 0 },
            })
          : null,
        h(ScopeNote, {
          key: "s",
          scopeNote: props.scopeNote,
          projectFirst: props.projectFirst,
          style: { ...fullRow, ...(stack ? {} : { gridRow: "3" }), minWidth: 0 },
        }),
      ]);
    }

    /**
     * 布尔行：**滑块开关**（不是裸复选框）。
     *
     * ★ 用户原话（2026-10-21）：*"一部分关于开关的可以做成滑块开关"*
     * ★★ 做法：仍然是 `<input type="checkbox">`（**原生、可键盘操作、可读屏**），
     *   只是外面包一层 `<span class="pl-settings__switch">`，由 CSS 把方块画成轨道 + 圆点。
     *   ⇒ 无障碍语义一个字没变，变的是外观；**不用自己造一个 role="switch" 的 div**
     *     （那样要自己处理空格键、焦点环、禁用态，每个都是一处出错面）。
     */
    function BoolRow(props) {
      const { spec, value, onChange, disabled } = props;
      return h(
        Row,
        {
          label: spec.label,
          hint: spec.hint,
          emphasis: spec.emphasis,
          scopeNote: spec.scopeNote,
          projectFirst: props.projectFirst,
        },
        [
          h(
            "label",
            {
              key: "sw",
              className: "pl-settings__switch" + (value === true ? " pl-settings__switch--on" : ""),
            },
            [
              h("input", {
                key: "c",
                type: "checkbox",
                checked: value === true,
                disabled: disabled === true,
                "aria-label": spec.label,
                onChange: (e) => onChange(e.target.checked),
              }),
              h("span", { key: "t", className: "pl-settings__switch-track", "aria-hidden": "true" }, [
                h("span", { key: "k", className: "pl-settings__switch-knob" }),
              ]),
            ]
          ),
        ]
      );
    }

    /**
     * 数字行：**拉条 + 数字读数**（不再是手填输入框）。
     *
     * ★ 用户原话（2026-10-21）：*"关于数值的也可以做成拉条数值，而不是手填"*
     *
     * ★★★ 但**保留了精确输入**（这是有意的，不是没改干净）：
     *   拉条只能给到 `step` 的整数倍；而这里有些值必须精确
     *   （例：`highFidelityCompactRatio` 是 0.3~0.79、`capsuleMaxChars` 是几千字符）。
     *   纯拉条会让人**无法填到想要的数**，反而更难用。
     *   ⇒ 拉条负责"快"，右侧小数字框负责"准"，两者绑同一个值。
     *
     * ★ `step` 缺失时按范围算一个合理步长（范围 / 50），绝不写死 —— 写死会
     *   让"范围改了但步长没跟"变成又一个分叉点（D138 同型）。
     */
    function NumberRow(props) {
      const { spec, value, onChange, disabled } = props;
      const hasRange = typeof spec.min === "number" && typeof spec.max === "number";
      const step =
        typeof spec.step === "number" && spec.step > 0
          ? spec.step
          : hasRange && spec.max > spec.min
            ? Number(((spec.max - spec.min) / 50).toPrecision(2))
            : 1;
      const num = typeof value === "number" ? value : Number(value);
      const safe = Number.isFinite(num) ? num : spec.min;

      const slider = hasRange
        ? h("input", {
            key: "r",
            className: "pl-settings__range-input",
            type: "range",
            min: spec.min,
            max: spec.max,
            step,
            value: safe,
            disabled: disabled === true,
            "aria-label": spec.label,
            onChange: (e) => onChange(e.target.value),
            // ★ 2026-10-22：宽度内联锁死，**值仍走 `var(--pl-num-w)`** ⇒ 与数字框恒等宽，
            //   且容器查询还能把两者一起收窄。滑块"抢宽度撑成晾衣杆"的结构性原因就此消失。
            style: {
              flex: "0 0 var(--pl-num-w, 72px)",
              width: "var(--pl-num-w, 72px)",
              minWidth: 0,
              maxWidth: "var(--pl-num-w, 72px)",
              margin: 0,
              padding: 0,
              boxSizing: "border-box",
            },
          })
        : null;

      return h(
        Row,
        {
          label: spec.label,
          hint: spec.hint,
          emphasis: spec.emphasis,
          scopeNote: spec.scopeNote,
          projectFirst: props.projectFirst,
        },
        [
          h(
            "div",
            {
              key: "w",
              className: "pl-settings__ctl-wrap pl-settings__ctl-wrap--num",
              // ★★★★★ 2026-10-22（真机截图：滑块与数字框**各掉一行**）：
              //   这一簇的横向排列也改成**内联**。原来靠 `.pl-settings__ctl-wrap--num`
              //   的 `display:flex; flex-wrap:nowrap`，一旦宿主把它当普通块，滑块与数字框
              //   就各自成为块级元素 ⇒ 上下两层。内联之后这个结构不再可被改写。
              //   ⚠️ 宽度的**值**仍取 `var(--pl-num-w, 72px)` ⇒ 容器查询还能收窄。
              style: {
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "flex-end",
                flexWrap: "nowrap",
                gap: "8px",
                flex: "none",
                minWidth: 0,
                maxWidth: "100%",
              },
            },
            [
              slider,
              h(
                "div",
                {
                  key: "n",
                  className: "pl-settings__num-box",
                  // 数字框永远在滑块**右边**（DOM 顺序 + 不换行 + 不收缩 ⇒ 三重保证）。
                  style: {
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    flex: "none",
                    whiteSpace: "nowrap",
                  },
                },
                [
                  h("input", {
                    key: "i",
                    className: "pl-settings__num",
                    type: "number",
                    value: safe,
                    min: spec.min,
                    max: spec.max,
                    step,
                    disabled: disabled === true,
                    "aria-label": spec.label + "（精确值）",
                    onChange: (e) => onChange(e.target.value),
                    // ★ 宽度内联锁死（值仍走变量）：宿主对 `input{width}` 的规则再也压不过它。
                    //   `boxSizing: border-box` 必须一起内联 —— 否则 padding 会把它撑出列宽。
                    style: {
                      width: "var(--pl-num-w, 72px)",
                      minWidth: 0,
                      maxWidth: "var(--pl-num-w, 72px)",
                      boxSizing: "border-box",
                      flex: "none",
                    },
                  }),
                  spec.unit
                    ? h(
                        "span",
                        {
                          key: "u",
                          className: "pl-settings__unit",
                          // 单位给固定最小宽度并左对齐 ⇒ 整列数字框右边缘齐平（不同单位字数不同）。
                          style: { minWidth: "2.6em", textAlign: "left", flex: "none", whiteSpace: "nowrap" },
                        },
                        spec.unit
                      )
                    : null,
                ]
              ),
            ]
          ),
        ]
      );
    }

    /**
     * 二选一（含以上）行：每个选项一个单选按钮 + 名称 + 说明。
     *
     * ★ 不使用下拉框：两个选项各有取舍（省一次模型输出 对 按内容分流），
     *   使用者需要看见取舍才能选对，下拉框会把说明藏起来。
     * ★ 选项来自宿主（`spec.options` 是已展开的数组），客户端不认识任何模式名，
     *   只按 value/label/hint 渲染 —— 以后新增模式不必改本文件。
     */
    function ChoiceRow(props) {
      const { spec, value, onChange, disabled } = props;
      const opts = Array.isArray(spec.options) ? spec.options : [];
      return h(
        Row,
        {
          label: spec.label,
          hint: spec.hint,
          stack: true,
          emphasis: spec.emphasis,
          scopeNote: spec.scopeNote,
          projectFirst: props.projectFirst,
        },
        [
          h(
            "div",
            { key: "g", className: "pl-settings__choices", role: "radiogroup", "aria-label": spec.label },
            opts.map((o) =>
              h(
                "label",
                {
                  key: String(o.value),
                  className:
                    "pl-settings__choice" + (String(o.value) === String(value) ? " pl-settings__choice--on" : ""),
                },
                [
                  h("input", {
                    key: "r",
                    type: "radio",
                    name: spec.key,
                    value: o.value,
                    checked: String(o.value) === String(value),
                    disabled: disabled === true,
                    onChange: () => onChange(o.value),
                  }),
                  h("span", { key: "t", className: "pl-settings__choice-body" }, [
                    h("span", { key: "l", className: "pl-settings__choice-label" }, o.label || String(o.value)),
                    o.hint ? h("span", { key: "h", className: "pl-settings__choice-hint" }, o.hint) : null,
                  ]),
                ]
              )
            )
          ),
        ]
      );
    }

    /** 档位行（文本框，逗号分隔）。 */
    function TiersRow(props) {
      const { spec, value, onChange, disabled } = props;
      return h(
        Row,
        {
          label: spec.label,
          hint: spec.hint,
          emphasis: spec.emphasis,
          scopeNote: spec.scopeNote,
          projectFirst: props.projectFirst,
        },
        [
          h("input", {
            key: "t",
            className: "pl-settings__num pl-settings__num--wide",
            type: "text",
            value: value,
            placeholder: TIERS_PLACEHOLDER,
            disabled: disabled === true,
            "aria-label": spec.label,
            onChange: (e) => onChange(e.target.value),
          }),
        ]
      );
    }

    /** 日志档位行（五档复选）。横排放不下，单独排一行。 */
    function LevelsRow(props) {
      const { spec, value, onChange, disabled } = props;
      const levels = ["L0", "L1", "L2", "L3", "L4"];
      const names = {
        L0: "L0 里程碑",
        L1: "L1 回合摘要",
        L2: "L2 文件流水",
        L3: "L3 工具流水",
        L4: "L4 用户原话",
      };
      return h(
        "div",
        {
          className:
            "pl-settings__row pl-settings__row--stack" +
            (spec.emphasis === true ? " pl-settings__row--emphasis" : ""),
          // ★ 2026-10-22：与 Row 同样的理由 —— 结构走内联，装饰留 CSS。
          style: {
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            flexWrap: "nowrap",
            gap: "6px",
            minWidth: 0,
            boxSizing: "border-box",
          },
        },
        h(
          "div",
          {
            className: "pl-settings__main",
            style: { display: "flex", flexDirection: "column", gap: "3px", minWidth: 0, flex: "0 1 auto" },
          },
          h(
            "div",
            {
              className: "pl-settings__label-line",
              style: { display: "flex", alignItems: "center", flexWrap: "nowrap", gap: "6px", minWidth: 0 },
            },
            h("span", { className: "pl-settings__label" }, spec.label),
            h(ScopeTag, { scopeNote: spec.scopeNote, projectFirst: props.projectFirst })
          ),
          spec.hint ? h(Hint, { text: spec.hint, style: { minWidth: 0 } }) : null,
          h(ScopeNote, { scopeNote: spec.scopeNote, projectFirst: props.projectFirst, style: { minWidth: 0 } })
        ),
        h(
          "div",
          {
            className: "pl-settings__levels",
            role: "group",
            "aria-label": spec.label,
            // 五档横排，放不下就换行 —— 这里**允许** wrap（它本来就是一组短标签）。
            style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px", minWidth: 0 },
          },
          levels.map((k) =>
            h(
              "label",
              {
                key: k,
                className: "pl-settings__lvl",
                style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "nowrap" },
              },
              h("input", {
                type: "checkbox",
                checked: value[k] === true,
                disabled: disabled === true,
                onChange: (e) => onChange(Object.assign({}, value, { [k]: e.target.checked })),
              }),
              h("span", null, names[k])
            )
          )
        )
      );
    }

    function controlFor(spec, draft, setDraft, disabled, projectFirst) {
      const value = draft[spec.key];
      const set = (v) => setDraft(Object.assign({}, draft, { [spec.key]: v }));
      const common = { key: spec.key, spec, value, disabled, projectFirst };
      if (spec.kind === "boolean") return h(BoolRow, { ...common, onChange: set });
      if (spec.kind === "choice") return h(ChoiceRow, { ...common, onChange: set });
      if (spec.kind === "number") return h(NumberRow, { ...common, onChange: set });
      if (spec.kind === "tiers") return h(TiersRow, { ...common, onChange: set });
      if (spec.kind === "levels") return h(LevelsRow, { ...common, onChange: set });
      return null;
    }

    /**
     * 算出分页结构：哪几页、每页哪些 spec。
     *
     * 两条稳健性要求（都会导致「某项凭空消失」，比排版问题严重得多）：
     *   ① 分组信息来自宿主（`spec.group`）。宿主为旧版而缺少 `group` 时，
     *      不得丢弃那些项，要归入「其他」页照常渲染。
     *   ② 页标题同样来自宿主（`data.groups`）。未提供时以 `spec.group` 作标题，
     *      绝不因为「没有标题」而不画。
     *   ⇒ 总原则：渲染遵循宿主提供的结构，客户端不硬编码任何具体 key。
     *
     * 把「算页」与「画页」拆成两个纯函数，自检不必引入 React
     * 即可钉死「共几页、每页几项、42 项有无遗漏」。
     */
    function buildPages(data) {
      const specs = Array.isArray(data.specs) ? data.specs : [];

      // ★★★★★ 2026-10-21（用户拍板「顶层精简到四个」）：分组改由 `PANEL_TABS` 决定。
      //
      //   旧实现按宿主 `data.groups`（6 组）分页 ⇒ 用户看到 6 个标签、43 行，觉得臃肿。
      //   新实现只有 4 个标签，且：
      //     · 「常规」「注入」用**显式 key 名单**（唯一真源在本文件上方 `PANEL_TABS`）；
      //     · 「高级」用 `rest: true` **兜住所有没被点名的项** ⇒ 结构上不可能漏项；
      //     · `HIDDEN_KEYS` 里的项**不出现**（但仍生效）。
      //
      //   ★★★ 三条必须保住的老承诺（`情形 100① g` 守着）：
      //     ① 不丢项：`pageSum + hiddenCount === specs.length`；
      //     ② 不重复：同一个 key 只出现一次；
      //     ③ 宿主给了没见过的 key / 名单里写了不存在的 key ⇒ **都不许崩、不许静默吞**：
      //        未知 key ⇒ 自动落进「高级」（多露一项，比丢项安全）；
      //        名单里写了不存在的 key ⇒ 忽略（自检另有断言守名单准确性）。
      const byKey = new Map();
      for (const spec of specs) {
        if (spec !== null && typeof spec === "object" && typeof spec.key === "string") {
          if (!byKey.has(spec.key)) byKey.set(spec.key, spec);
        }
      }

      const hidden = new Set(HIDDEN_KEYS);
      const named = new Set();
      const pages = [];

      for (const tab of PANEL_TABS) {
        if (tab.rest === true) continue; // 兜底页最后建，见下
        const picked = [];
        for (const k of Array.isArray(tab.keys) ? tab.keys : []) {
          const spec = byKey.get(k);
          if (spec === undefined) continue; // 宿主旧版没有这一项 ⇒ 静默略过（不画空行）
          if (hidden.has(k)) continue; // 藏起来的不许被点名页画出来
          picked.push(spec);
          named.add(k);
        }
        pages.push({ key: tab.key, title: tab.title, hint: tab.hint, kind: tab.kind, specs: picked });
      }

      // 兜底页：所有既没被点名、也没被隐藏的项。
      const restTab = PANEL_TABS.find((t) => t.rest === true);
      if (restTab !== undefined) {
        const rest = [];
        for (const [k, spec] of byKey) {
          if (named.has(k) || hidden.has(k)) continue;
          rest.push(spec);
        }
        pages.push({ key: restTab.key, title: restTab.title, hint: restTab.hint, specs: rest });
      }

      // ★ 极端情况：`PANEL_TABS` 被改坏（比如忘了写 rest 页）⇒ 剩下那些项**不许消失**。
      //   全部塞进最后一页，宁可挤，也不让某一项变得无法在界面上修改。
      const seen = new Set();
      for (const p of pages) for (const s of p.specs) seen.add(s.key);
      const orphans = [];
      for (const [k, spec] of byKey) {
        if (seen.has(k) || hidden.has(k)) continue;
        orphans.push(spec);
      }
      if (orphans.length > 0 && pages.length > 0) {
        pages[pages.length - 1].specs = pages[pages.length - 1].specs.concat(orphans);
      }

      return pages;
    }

    /**
     * ★★★★★ 2026-10-21（1.5.0 · 任务书 §6.1）：**自定义扩展记忆**的界面。
     *
     * ★★★ 三条硬要求（都来自任务书，不是我的偏好）：
     *   ① 建满任意多个扩展之后，**核心记忆必须逐字节不变** —— 那是 part8 的语义边界，
     *      界面这边**只调用 `extensions.json`**，绝不碰 LEDGER / decisions / JOURNAL。
     *   ② **不许出现"界面说成功、文件却不存在"**（任务书 §6.3 第 10 条）：
     *      ⇒ 每次写操作之后**重新拉一遍真状态**，界面上显示的 todos
     *      永远是**服务端读回来的**，不是本地猜的。
     *   ③ 删除有内容的扩展**必须二次确认**：服务端回 `200 + ok:false + needConfirm`
     *      ⇒ 这里弹确认条，**不当红色报错**（那不是失败，是"还没做，等你点头"）。
     *
     * ★ 模式清单、label、hint **全部来自服务端**（`data.modes`）—— 客户端零硬编码，
     *   以后加一种模式只改 `part8.js` 那一张表。
     */
    function ExtensionsPage() {
      const [view, setView] = useState({ loading: true, error: null, data: null });
      const [root, setRoot] = useState("");
      const [msg, setMsg] = useState(null);
      const [busy, setBusy] = useState(false);
      const [pending, setPending] = useState(null); // {id, name, usage} —— 待二次确认的删除
      const [form, setForm] = useState({ open: false, name: "", description: "", mode: "", inject: false });
      const alive = useRef(true);

      const load = useCallback(() => {
        fetchJson(API_EXTENSIONS)
          .then((data) => {
            if (!alive.current) return;
            setView({ loading: false, error: null, data });
            const first = Array.isArray(data?.projects) && data.projects.length > 0 ? data.projects[0].root : "";
            setRoot((cur) => (cur !== "" && (data?.projects ?? []).some((p) => p.root === cur) ? cur : first));
            if (data?.modes?.length > 0) setForm((f) => (f.mode === "" ? Object.assign({}, f, { mode: data.modes[0].key }) : f));
          })
          .catch((e) => {
            if (!alive.current) return;
            setView({ loading: false, error: errText(e), data: null });
          });
      }, []);

      useEffect(() => {
        alive.current = true;
        load();
        return () => {
          alive.current = false;
        };
      }, [load]);

      /** 一次写操作：所有 op 走同一个出口，写完**总是重新拉真状态**。 */
      const send = useCallback(
        (body, okText) => {
          setBusy(true);
          setMsg(null);
          postJson(API_EXTENSIONS, Object.assign({ root }, body))
            .then((r) => {
              if (!alive.current) return;
              setBusy(false);
              if (r?.ok === true) {
                setMsg({ kind: "ok", text: okText });
                setPending(null);
                load();
              } else if (r?.needConfirm === true) {
                setPending({ id: body.id, name: r?.usage?.detail ?? "", usage: r?.usage, reason: r?.reason });
              } else {
                setMsg({ kind: "err", text: String(r?.reason ?? r?.error ?? "操作被拒绝。") });
              }
            })
            .catch((e) => {
              if (!alive.current) return;
              setBusy(false);
              setMsg({ kind: "err", text: "请求失败：" + errText(e) });
            });
        },
        [root, load]
      );

      const card = (title, hint, body) =>
        h(
          "div",
          { className: "pl-ext__card" },
          [
            h("div", { key: "h", className: "pl-ext__card-head" }, [
              h("span", { key: "t", className: "pl-ext__card-title" }, title),
              hint ? h("span", { key: "s", className: "pl-ext__card-hint" }, hint) : null,
            ]),
            h("div", { key: "b", className: "pl-ext__card-body" }, body),
          ]
        );

      if (view.loading) return h("div", { className: "pl-ext" }, h("div", { className: "pl-settings__note" }, "正在读取扩展记忆…"));
      if (view.error !== null) {
        return h(
          "div",
          { className: "pl-ext" },
          [
            h("div", { key: "e", className: "pl-settings__msg pl-settings__msg--err" }, "读取扩展记忆失败：" + view.error),
            h(
              "div",
              { key: "n", className: "pl-settings__note" },
              "扩展记忆是附加能力：读不到它时，台账、压缩、日志全部照常工作。"
            ),
          ]
        );
      }

      const data = view.data ?? {};
      const modes = Array.isArray(data.modes) ? data.modes : [];
      const projects = Array.isArray(data.projects) ? data.projects : [];

      if (projects.length === 0) {
        return h(
          "div",
          { className: "pl-ext" },
          h(
            "div",
            { className: "pl-settings__note" },
            "当前没有可配置的项目。扩展记忆按项目存放，需要先有一个用本插件登记过台账的项目，并在一个活跃的对话里打开过它。"
          )
        );
      }

      const cur = projects.find((p) => p.root === root) ?? projects[0];
      const list = Array.isArray(cur.extensions) ? cur.extensions : [];
      const modeOf = (k) => modes.find((m) => m.key === k);

      return h(
        "div",
        { className: "pl-ext" },
        [
          // ① 项目选择 + 新建按钮
          h("div", { key: "top", className: "pl-ext__top" }, [
            h("label", { key: "l", className: "pl-ext__pick" }, [
              h("span", { key: "s" }, "项目"),
              h(
                "select",
                {
                  key: "sel",
                  value: cur.root,
                  disabled: busy === true,
                  onChange: (e) => {
                    setRoot(e.target.value);
                    setPending(null);
                    setMsg(null);
                  },
                },
                projects.map((p) => h("option", { key: p.root, value: p.root }, p.name))
              ),
            ]),
            h(
              "button",
              {
                key: "add",
                type: "button",
                className: "pl-settings__btn pl-settings__btn--primary",
                disabled: busy === true || modes.length === 0,
                onClick: () => setForm({ open: !form.open, name: "", description: "", mode: modes[0]?.key ?? "", inject: false }),
              },
              form.open ? "取消新建" : "新建扩展记忆"
            ),
          ]),

          msg === null
            ? null
            : h("div", { key: "m", className: "pl-settings__msg pl-settings__msg--" + msg.kind }, msg.text),

          // ② 二次确认条（删除有内容时）
          pending === null
            ? null
            : h("div", { key: "pc", className: "pl-ext__confirm" }, [
                h(
                  "div",
                  { key: "t", className: "pl-ext__confirm-text" },
                  `「${pending.name || pending.id}」里已经有内容（${pending.usage?.detail ?? "有数据"}）。` +
                    "确认删除吗？删除后该单元的文件会被移走，核心记忆不受影响。"
                ),
                h("div", { key: "a", className: "pl-ext__confirm-actions" }, [
                  h(
                    "button",
                    {
                      key: "no",
                      type: "button",
                      className: "pl-settings__btn",
                      disabled: busy === true,
                      onClick: () => setPending(null),
                    },
                    "先不删"
                  ),
                  h(
                    "button",
                    {
                      key: "yes",
                      type: "button",
                      className: "pl-settings__btn pl-settings__btn--danger",
                      disabled: busy === true,
                      onClick: () => send({ op: "delete", id: pending.id, confirm: true }, "已删除。"),
                    },
                    "确认删除"
                  ),
                ]),
              ]),

          // ③ 新建表单
          form.open === false
            ? null
            : card(
                "新建扩展记忆",
                "给它一个名字、说明它管什么，再选一套管理规则。",
                [
                  h("div", { key: "r1", className: "pl-ext__field" }, [
                    h("span", { key: "l", className: "pl-ext__flabel" }, "名称"),
                    h("input", {
                      key: "i",
                      className: "pl-ext__input",
                      type: "text",
                      value: form.name,
                      placeholder: "例如：Boss 机制记录",
                      disabled: busy === true,
                      onChange: (e) => setForm(Object.assign({}, form, { name: e.target.value })),
                    }),
                  ]),
                  h("div", { key: "r2", className: "pl-ext__field" }, [
                    h("span", { key: "l", className: "pl-ext__flabel" }, "说明"),
                    h("input", {
                      key: "i",
                      className: "pl-ext__input",
                      type: "text",
                      value: form.description,
                      placeholder: "例如：每个 Boss 的技能、弱点、掉落",
                      disabled: busy === true,
                      onChange: (e) => setForm(Object.assign({}, form, { description: e.target.value })),
                    }),
                  ]),
                  h("div", { key: "r3", className: "pl-ext__field" }, [
                    h("span", { key: "l", className: "pl-ext__flabel" }, "模式"),
                    h(
                      "select",
                      {
                        key: "s",
                        className: "pl-ext__input",
                        value: form.mode,
                        // ★★★★★ 2026-10-23（D311）：原来这里是 `disabled: busy === true || form.mode === "principles"` ——
                        //   **硬编码了一个已经不存在的模式名**（用户拍板去掉「原则型」之后 `form.mode === "principles"`
                        //   永远为 false，那半句成了死条件，而读代码的人还以为"有个模式叫 principles 要特殊对待"）。
                        //   ★ 面板文案必须与当前功能对应（发布前硬规矩之二）：
                        //     面板里不许出现"当前代码做不到、或已经不这么做"的东西。
                        //   ★ 这个表单是**新建**表单（`form` 只有 open/name/description/mode/inject，
                        //     没有"正在编辑既有扩展"的状态）⇒ 新建时模式本来就该可选，去掉那个死条件即可。
                        //     ★ 模式**建好后不可改**这条规则仍成立，它由 `updateExtension` 在服务端拒绝（语义层），
                        //       不需要面板再表达一遍 —— 判据在语义层，不在调用层（D292）。
                        disabled: busy === true,
                        onChange: (e) => setForm(Object.assign({}, form, { mode: e.target.value })),
                      },
                      modes.map((m) => h("option", { key: m.key, value: m.key }, m.label))
                    ),
                  ]),
                  (() => {
                    const m = modeOf(form.mode);
                    return m === undefined
                      ? null
                      : h("div", { key: "mh", className: "pl-ext__modehint" }, m.hint);
                  })(),
                  h("div", { key: "r4", className: "pl-ext__field" }, [
                    h("span", { key: "l", className: "pl-ext__flabel" }, "每回合注入内容摘要"),
                    h(
                      "label",
                      { key: "sw", className: "pl-settings__switch" + (form.inject === true ? " pl-settings__switch--on" : "") },
                      [
                        h("input", {
                          key: "c",
                          type: "checkbox",
                          checked: form.inject === true,
                          disabled: busy === true,
                          "aria-label": "每回合注入内容摘要",
                          onChange: (e) => setForm(Object.assign({}, form, { inject: e.target.checked })),
                        }),
                        h("span", { key: "t", className: "pl-settings__switch-track", "aria-hidden": "true" }, [
                          h("span", { key: "k", className: "pl-settings__switch-knob" }),
                        ]),
                      ]
                    ),
                  ]),
                  h(
                    "div",
                    { key: "act", className: "pl-ext__form-actions" },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "pl-settings__btn pl-settings__btn--primary",
                        disabled: busy === true || form.name.trim() === "",
                        onClick: () =>
                          send(
                            { op: "create", name: form.name, description: form.description, mode: form.mode, inject: form.inject },
                            "已创建。"
                          ),
                      },
                      "创建"
                    )
                  ),
                ]
              ),

          // ④ 已有列表
          card(
            "这个项目里的扩展记忆",
            list.length === 0 ? "还没有。扩展是可选的，不建也不影响核心记忆。" : `${list.length} 个`,
            list.length === 0
              ? h("div", { className: "pl-settings__note" }, "点右上角「新建扩展记忆」加一个。")
              : h(
                  "div",
                  { className: "pl-ext__list" },
                  list.map((x) =>
                    h("div", { key: x.id, className: "pl-ext__item" }, [
                      h("div", { key: "m", className: "pl-ext__item-main" }, [
                        h("div", { key: "n", className: "pl-ext__item-name" }, [
                          h("span", { key: "s" }, x.name),
                          h("span", { key: "b", className: "pl-ext__badge" }, x.modeLabel),
                          x.inject === true ? h("span", { key: "j", className: "pl-ext__badge pl-ext__badge--on" }, "注入中") : null,
                        ]),
                        x.description ? h("div", { key: "d", className: "pl-ext__item-desc" }, x.description) : null,
                        h(
                          "div",
                          { key: "u", className: "pl-ext__item-usage" },
                          (x.usage?.hasContent === true
                            ? `已有内容（${x.usage.detail}）`
                            : "还没有内容") + ` · ${x.storagePath}`
                        ),
                      ]),
                      h("div", { key: "a", className: "pl-ext__item-actions" }, [
                        h(
                          "button",
                          {
                            key: "t",
                            type: "button",
                            className: "pl-settings__btn",
                            disabled: busy === true,
                            onClick: () => send({ op: "update", id: x.id, inject: x.inject !== true }, x.inject === true ? "已关闭注入。" : "已开启注入。"),
                          },
                          x.inject === true ? "停止注入" : "开启注入"
                        ),
                        h(
                          "button",
                          {
                            key: "d",
                            type: "button",
                            className: "pl-settings__btn pl-settings__btn--danger",
                            disabled: busy === true,
                            onClick: () => {
                              if (x.usage?.hasContent === true) {
                                setPending({ id: x.id, name: x.name, usage: x.usage });
                                setMsg(null);
                              } else {
                                send({ op: "delete", id: x.id, confirm: true }, "已删除。");
                              }
                            },
                          },
                          "删除"
                        ),
                      ]),
                    ])
                  )
                )
          ),

          Array.isArray(cur.inconsistent) && cur.inconsistent.length > 0
            ? h(
                "div",
                { key: "inc", className: "pl-settings__note" },
                "注册表与磁盘不一致（不会自动修复，以免覆盖你以为存在的东西）：" + cur.inconsistent.join("；")
              )
            : null,
        ]
      );
    }

    /** 只渲染一页。一次只画一页，视觉长度降到 1/N。 */
    function renderPage(page, draft, setDraft, disabled, projectFirst) {
      if (page === undefined || page === null) return null;
      const head = h(
        "div",
        { key: "h", className: "pl-settings__card-head" },
        h("span", { key: "t", className: "pl-settings__card-title" }, page.title),
        page.hint ? h("span", { key: "s", className: "pl-settings__card-hint" }, page.hint) : null
      );
      // ★ 扩展页不是"一串设置项"，它有自己的读写状态 ⇒ 走独立组件。
      if (page.kind === "extensions") {
        return h(
          "div",
          { key: page.key, className: "pl-settings__card", role: "tabpanel" },
          [head, h("div", { key: "b", className: "pl-settings__card-body" }, h(ExtensionsPage, {}))]
        );
      }
      return h(
        "div",
        { key: page.key, className: "pl-settings__card", role: "tabpanel" },
        head,
        h(
          "div",
          { key: "b", className: "pl-settings__card-body" },
          page.specs.map((spec) => controlFor(spec, draft, setDraft, disabled, projectFirst))
        )
      );
    }

    /**
     * 设置页本体。
     *
     * 生命周期：挂载时 GET 一次；保存时 POST 差异补丁；保存成功后以服务端回报的
     * 生效值刷新草稿 —— 服务端会归一化越界值，本地草稿可能已不准确。
     */
    function SettingsPage() {
      const [view, setView] = useState({ loading: true, error: null, data: null });
      const [draft, setDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const [broadcasting, setBroadcasting] = useState(false);
      const [msg, setMsg] = useState(null);
      /** 当前页码，0 起。 */
      const [pageIndex, setPageIndex] = useState(0);
      const alive = useRef(true);

      /** 拉取服务端视图。挂载时调用，推送之后也会调用以刷新计数。 */
      const load = useCallback(() => {
        fetchJson(API_CONFIG)
          .then((data) => {
            if (!alive.current) return;
            setView({ loading: false, error: null, data });
            setDraft(buildDraft(data));
          })
          .catch((e) => {
            if (!alive.current) return;
            setView({ loading: false, error: errText(e), data: null });
          });
      }, []);

      useEffect(() => {
        alive.current = true;
        load();
        return () => {
          alive.current = false;
        };
      }, [load]);

      const onSave = useCallback(() => {
        if (view.data === null || draft === null) return;
        const patch = diffPatch(view.data.specs, draft, view.data.settings);
        if (Object.keys(patch).length === 0) {
          setMsg({ kind: "warn", text: "没有改动。" });
          return;
        }
        setSaving(true);
        setMsg(null);
        postJson(API_CONFIG, { settings: patch })
          .then((r) => {
            if (!alive.current) return;
            setSaving(false);
            // 用服务端回报的生效值刷新（越界值会被夹紧，例如水位填 0.9 会被夹到 0.79）。
            const next = Object.assign({}, view.data, { settings: r.settings });
            setView(Object.assign({}, view, { data: next }));
            setDraft(buildDraft(next));
            const extra = [];
            if (Array.isArray(r.clamped) && r.clamped.length > 0) extra.push("已夹紧：" + r.clamped.join("、"));
            if (Array.isArray(r.dropped) && r.dropped.length > 0) extra.push("已忽略：" + r.dropped.join("、"));
            setMsg({
              kind: extra.length > 0 ? "warn" : "ok",
              text: "已保存。" + (extra.length > 0 ? " " + extra.join(" ") : ""),
            });
          })
          .catch((e) => {
            if (!alive.current) return;
            setSaving(false);
            setMsg({ kind: "err", text: "保存失败：" + errText(e) });
          });
      }, [view, draft]);

      /**
       * 「取消」：丢弃本次未保存的改动，回到已保存状态。
       * 与「恢复默认」的区别：取消回到已保存的那份（可能不是默认值）；
       * 恢复默认填回插件默认值（与当前保存了什么无关）。
       */
      const onCancel = useCallback(() => {
        if (view.data === null) return;
        setDraft(buildDraft(view.data));
        setMsg({ kind: "warn", text: "已放弃未保存的改动。" });
      }, [view]);

      /**
       * 「恢复默认」：把草稿中每一项都填回插件默认值。
       * 只改草稿，不落盘 —— 仍需按「保存」才生效，与「取消」同一条边界。
       *
       * ★ 默认值的真源是服务端视图里的 `data.defaults`（宿主 settingDefaults() 的
       *   返回值）。早先版本曾写成 `spec.def`，而那个字段根本不存在，结果按钮
       *   静默无操作却提示「已填入默认值」—— 这正是「谎报成功」。
       * ★ 取不到 defaults 时（宿主为旧版）原样保留并如实说明，不写坏值、不谎报。
       */
      const onRestoreDefaults = useCallback(() => {
        if (view.data === null) return;
        const defs = view.data.defaults;
        if (defs === null || typeof defs !== "object") {
          setMsg({ kind: "err", text: "当前宿主版本未提供默认值，无法恢复默认。" });
          return;
        }
        const next = {};
        for (const spec of view.data.specs) {
          const hasDef = Object.prototype.hasOwnProperty.call(defs, spec.key);
          next[spec.key] = hasDef ? settingsToUi(spec, defs) : draft === null ? undefined : draft[spec.key];
        }
        setDraft(next);
        setMsg({ kind: "warn", text: "已填入默认值，按「保存」后才会生效。" });
      }, [view, draft]);

      /**
       * 「推送到所有对话」：只做一件事 —— 让服务端把一个全局序号 +1。
       * 该序号进入去重指纹，因此每个对话的下一次回复都会重注「当前设置」快照。
       * 与「保存」是两件独立的事：保存改值，推送让所有对话重新读取当前值。
       * 因此没有改动时也允许推送 —— 那正是它主要的用法。
       */
      const onBroadcast = useCallback(() => {
        if (broadcasting) return;
        setBroadcasting(true);
        setMsg(null);
        postJson(API_BROADCAST, {})
          .then((r) => {
            if (!alive.current) return;
            setBroadcasting(false);
            setMsg({ kind: "ok", text: r.text || "已请求推送。" });
            // 顺手刷新，使「已推送 N 次」这个计数跟着更新（那是可自行核对的凭据）。
            load();
          })
          .catch((e) => {
            if (!alive.current) return;
            setBroadcasting(false);
            setMsg({ kind: "err", text: "推送失败：" + errText(e) });
          });
      }, [broadcasting, load]);

      if (view.loading) {
        return h(
          "div",
          { className: "pl-settings pl-settings--plain" },
          h("div", { className: "pl-settings__intro" }, "正在读取设置…")
        );
      }
      if (view.error !== null) {
        return h(
          "div",
          { className: "pl-settings pl-settings--plain" },
          h("div", { className: "pl-settings__msg pl-settings__msg--err" }, "读取设置失败：" + view.error),
          h(
            "div",
            { className: "pl-settings__note" },
            "本界面只影响设置面板本身，台账功能不受影响，插件仍照常工作。"
          )
        );
      }

      const data = view.data;
      const disabled = data.writable !== true || saving;
      const dirty = draft !== null && Object.keys(diffPatch(data.specs, draft, data.settings)).length > 0;
      const projectFirst = data.settings?.settingPrecedence === "project";

      const pages = buildPages(data);
      const safeIndex = pages.length === 0 ? 0 : Math.min(Math.max(pageIndex, 0), pages.length - 1);
      const current = pages[safeIndex];

      /** 分页标签的键盘导航（← → Home End），与官方 tablist 的行为一致。 */
      const onTabKeyDown = (event, index) => {
        if (pages.length === 0) return;
        const next =
          event.key === "ArrowRight"
            ? (index + 1) % pages.length
            : event.key === "ArrowLeft"
              ? (index + pages.length - 1) % pages.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? pages.length - 1
                  : -1;
        if (next < 0) return;
        event.preventDefault();
        setPageIndex(next);
        const el = document.getElementById(SECTION_ID + "-tab-" + pages[next].key);
        if (el !== null && typeof el.focus === "function") el.focus();
      };

      return h(
        "div",
        { className: "pl-settings" },

        // ── ① 头部：分页标签（固定，不随内容滚动）──────────────────────
        pages.length > 0
          ? h(
              "div",
              { className: "pl-settings__tabs", role: "tablist", "aria-label": "设置分类" },
              pages.map((p, i) =>
                h(
                  "button",
                  {
                    key: p.key,
                    id: SECTION_ID + "-tab-" + p.key,
                    type: "button",
                    role: "tab",
                    "aria-selected": i === safeIndex,
                    tabIndex: i === safeIndex ? 0 : -1,
                    className: "pl-settings__tab" + (i === safeIndex ? " pl-settings__tab--on" : ""),
                    onClick: () => setPageIndex(i),
                    onKeyDown: (e) => onTabKeyDown(e, i),
                  },
                  p.title,
                  h("span", { className: "pl-settings__tab-badge" }, String(p.specs.length))
                )
              )
            )
          : null,

        // ── ② 中部：唯一可滚动区（顶部说明 + 当前页）────────────────────
        h(
          "div",
          { className: "pl-settings__scroll" },
          h(
            "div",
            { className: "pl-settings__intro" },
            // 本段必须跟着「配置来源的优先级」走 —— 在「以面板为准」下，
            // 描述「以项目清单为准」的话就是错话。错话比不写更坏。
            // 面板为纯文本渲染：不使用星号与反引号，强调用「」。
            (projectFirst
              ? "当前配置来源为「以项目清单为准」：面板上的取值主要决定新项目登记成什么。" +
                "带「仅影响本项目」标记的项，已登记项目一律使用自身 .dsh-ledger.json 中的取值。"
              : "当前配置来源为「以设置面板为准」（默认）：面板上的修改立即对全部项目生效。" +
                "项目清单中写过的同名取值已由面板覆盖。") +
            "某个项目实际生效的数值，见每回合注入的「当前设置」快照。"
          ),
          data.writable !== true
            ? h(
                "div",
                { className: "pl-settings__note" },
                (data.why || "当前无法保存设置。") + "（下方显示的仍是实际生效的值。）"
              )
            : null,
          draft === null ? null : renderPage(current, draft, setDraft, disabled, projectFirst)
        ),

        // ── ③ 底部：固定操作栏 ──────────────────────────────────────────
        msg === null
          ? null
          : h(
              "div",
              { className: "pl-settings__bar-msg" },
              h("span", { className: "pl-settings__msg pl-settings__msg--" + msg.kind }, msg.text)
            ),
        h(
          "div",
          { className: "pl-settings__bar" },
          h(
            "button",
            {
              className: "pl-settings__btn",
              type: "button",
              disabled: disabled || !dirty,
              onClick: onSave,
            },
            saving ? "保存中…" : "保存"
          ),
          h(
            "button",
            {
              className: "pl-settings__btn pl-settings__btn--ghost",
              type: "button",
              disabled: saving,
              onClick: onCancel,
            },
            "取消"
          ),
          h(
            "button",
            {
              className: "pl-settings__btn pl-settings__btn--ghost",
              type: "button",
              disabled: disabled,
              onClick: onRestoreDefaults,
            },
            "恢复默认"
          ),
          h(
            "button",
            {
              className: "pl-settings__btn pl-settings__btn--ghost pl-settings__btn--push",
              type: "button",
              disabled: broadcasting,
              onClick: onBroadcast,
            },
            broadcasting ? "推送中…" : "推送到所有对话"
          )
        )
      );
    }


    /** 由服务端视图造一份可编辑草稿。 */
    function buildDraft(data) {
      const draft = {};
      for (const spec of data.specs) draft[spec.key] = settingsToUi(spec, data.settings);
      return draft;
    }

    // ───────────────────────────────────────────────────────────────────────
    // 插件
    // ───────────────────────────────────────────────────────────────────────
    const name = PLUGIN_ID;

    /**
     * ★ 只写**确定存在**的服务。
     *   `slots` 是渲染器提供的一等服务。多写一个不存在的名字 = 插件**永远不 apply**
     *   = 界面什么都没有、**且不报错**。少写比多写安全。
     */
    const inject = ["slots"];

    function apply(ctx) {
      installCss(ctx);

      ctx.slots.inject(SLOT, () =>
        safeRegister(
          ctx,
          { name: SLOT, id: SECTION_ID, order: SECTION_ORDER, label: LABEL },
          () => h(SettingsPage, null)
        )
      );

      diagnostics.at = new Date().toISOString();
      try {
        globalThis.__dshProjectLedgerSettings = {
          plugin: PLUGIN_ID,
          slot: SLOT,
          sectionId: SECTION_ID,
          label: LABEL,
          api: API_CONFIG,
          diagnostics,
          apiConfig: () => fetchJson(API_CONFIG),
          /**
           * ★ 把面板的**纯函数**露出来，只为可测与可排障。
           *   露出来之后，自检可以在**不用真 React** 的情况下把它们逐条钉死。
           *   它们本来就是闭包里的纯函数，露出来不改变任何行为。
           */
          helpers: {
            parseTiers,
            formatTiers,
            valueToPatch,
            settingsToUi,
            sameValue,
            diffPatch,
            buildDraft,
            // ★ 2026-10-18（D256）：分页的**纯函数** —— 自检要在不用 React 的情况下
            //   钉死"一共几页、每页几项、42 项有没有漏"（情形 100）。
            buildPages,
            // ★ 2026-10-18（D256）：长说明折叠的**纯函数** —— 自检钉死"折叠后确实更短、
            //   且短文案不被误折"。
            firstSentence,
            HINT_FOLD_CHARS,
          },
        };
      } catch {
        /* 没有 globalThis 就算了。 */
      }
    }

    return { name, inject, apply };
  },
});
