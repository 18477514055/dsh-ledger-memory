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
    const CSS_ID = PLUGIN_ID + "/client.css";

    /** 水位档位那个文本输入框的提示（与宿主默认值一致）。 */
    const TIERS_PLACEHOLDER = "0.3, 0.5, 0.7";

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
  height: 100%; max-height: 100%; min-height: 0;
  padding: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 20px;
  container-type: inline-size;
}
/* 「未加载 / 只读」等无分页态：不占满高度，按内容自然排布。 */
.pl-settings--plain { height: auto; padding: 4px 2px 18px; gap: 14px; }

/* ── ① 头部：分页标签 ──────────────────────────────────────────────────
   ★ 未选中态「透明 + 细描边」而非实心底色。旧写法给 bg-layer-1，在深色主题下
     是一块深色方块，读起来像按钮压在黑布上（2026-10-18 用户原话）。
     选中态才使用品牌色实心 —— 那是「当前页」应有的视觉权重。 */
.pl-settings__tabs {
  flex: none; display: flex; gap: 4px; align-items: center;
  padding: 4px 2px 12px; overflow-x: auto; scrollbar-width: thin;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.pl-settings__tab {
  flex: none; display: inline-flex; align-items: center; gap: 6px;
  min-height: 30px; padding: 5px 12px;
  font: inherit; font-size: 12.5px; white-space: nowrap; cursor: pointer;
  background: transparent;
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px;
  transition: color .15s, border-color .15s, background-color .15s;
}
.pl-settings__tab:hover {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-secondary, var(--dsw-alias-border-l1));
}
.pl-settings__tab:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px;
}
.pl-settings__tab--on {
  background: var(--dsw-alias-brand-primary); color: #ffffff;
  border-color: transparent; font-weight: 600;
}
/* 条目计数角标：中性底，不抢标签本身的视觉权重。 */
.pl-settings__tab-badge {
  flex: none; min-width: 16px; padding: 0 5px;
  font-size: 10.5px; font-weight: 500; line-height: 16px; text-align: center;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary)));
}
/* 选中态里角标压在品牌色上：改用半透明白，避免叠色发脏。 */
.pl-settings__tab--on .pl-settings__tab-badge {
  background: rgba(255, 255, 255, .26); color: #ffffff;
}

/* ── ② 中部：唯一的滚动容器 ────────────────────────────────────────────
   flex:1 + min-height:0 才能真的滚（D256）。底栏因此不需要 sticky。 */
.pl-settings__scroll {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 14px 2px 18px;
  display: flex; flex-direction: column; gap: 14px;
}
.pl-settings__intro {
  max-width: 720px; padding: 10px 12px;
  font-size: 12.5px; line-height: 19px;
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
  font-size: 13px; font-weight: 600; line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.pl-settings__card-hint {
  font-size: 11.5px; line-height: 17px;
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

.pl-settings__main { flex: 1 1 240px; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.pl-settings__label-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pl-settings__label {
  font-size: 13px; font-weight: 500; line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
/* hint 折叠：超过两行省略，展开后完整显示。 */
.pl-settings__hint {
  font-size: 11.5px; line-height: 17px;
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
  font: inherit; font-size: 11.5px; line-height: 17px; cursor: pointer;
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
  font-size: 10px; font-weight: 500; line-height: 16px;
  background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary)));
  border: 1px solid var(--dsw-alias-border-l2);
}
.pl-settings__scope-warn {
  margin-top: 4px; padding: 6px 10px; border-radius: 8px;
  font-size: 11.5px; line-height: 17px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
  border-left: 3px solid var(--dsw-alias-state-warn-primary);
}

/* ── 控件 ────────────────────────────────────────────────────────────── */
.pl-settings__ctl { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
.pl-settings__ctl-wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.pl-settings__range {
  font-size: 10.5px; line-height: 15px; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary)));
  font-variant-numeric: tabular-nums;
}
.pl-settings__levels { display: flex; flex-wrap: wrap; gap: 12px; padding-top: 2px; }
.pl-settings__lvl {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary);
}
.pl-settings__num {
  width: 112px; box-sizing: border-box; padding: 5px 9px;
  font: inherit; font-size: 12.5px; border-radius: 8px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
}
.pl-settings__num:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0;
  border-color: transparent;
}
.pl-settings__num:disabled { opacity: .55; cursor: not-allowed; }
.pl-settings__num--wide { width: 176px; }

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
.pl-settings__choice-label { font-size: 12.5px; line-height: 19px; color: var(--dsw-alias-label-primary); }
.pl-settings__choice-hint {
  font-size: 11.5px; line-height: 17px;
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
.pl-settings__bar-msg { flex: none; padding: 0 2px 8px; font-size: 12px; line-height: 18px; }
/* 推送按钮推到最右端，与左侧三键在视觉上分开（它原来挤在同一行，像浮窗）。 */
.pl-settings__btn--push { margin-left: auto; }

.pl-settings__btn {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 32px; padding: 6px 16px;
  font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer;
  border-radius: 8px;
  background: var(--dsw-alias-brand-primary); color: #ffffff;
  border: 1px solid transparent;
  transition: opacity .15s, border-color .15s;
}
.pl-settings__btn:hover:not(:disabled) { opacity: .88; }
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

.pl-settings__msg { font-size: 12px; line-height: 18px; }
.pl-settings__msg--ok { color: var(--dsw-alias-state-success-primary); }
.pl-settings__msg--err { color: var(--dsw-alias-state-error-primary); }
.pl-settings__msg--warn { color: var(--dsw-alias-state-warn-primary); }
/* 中性提示块：画了背景，因此必须同时显式指定 color。 */
.pl-settings__note {
  padding: 10px 12px; border-radius: 10px;
  font-size: 12px; line-height: 18px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
  border: 1px solid var(--dsw-alias-border-l1);
}
.pl-settings__mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

/* ── 响应式：按容器宽度，不按视口宽度 ────────────────────────────────
   面板宽度由设置侧栏决定，与浏览器窗口不是一回事。 */
@container (max-width: 560px) {
  .pl-settings__main { flex: 1 1 100%; }
  .pl-settings__ctl { flex: 1 1 100%; justify-content: flex-start; }
  .pl-settings__ctl-wrap { align-items: flex-start; }
  .pl-settings__num, .pl-settings__num--wide { width: 100%; max-width: 220px; }
}
@container (max-width: 400px) {
  .pl-settings__row { padding: 10px 11px; }
  .pl-settings__card-head { padding: 10px 11px; }
  .pl-settings__tab { padding: 5px 9px; font-size: 12px; }
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
      // 短说明：一行放得下，不折叠。
      if (text.length <= HINT_FOLD_CHARS) {
        return h("div", { className: "pl-settings__hint" }, h("span", { className: "pl-settings__hint-text" }, text));
      }
      return h(
        "div",
        { className: "pl-settings__hint" + (open ? " pl-settings__hint--open" : "") },
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
        { className: "pl-settings__scope-warn" },
        "本项以项目清单为准，每个项目使用自身 .dsh-ledger.json 中的取值。" +
          "实际生效值见每回合注入的「当前设置」快照。"
      );
    }

    /**
     * 一行设置项：左侧「标签 + 说明」，右侧控件。
     *
     * ★ 相邻行之间的分隔线由 CSS 的 `.row + .row` 提供，行自身不画边框 ——
     *   这样一组 42 项只会出现一张卡片的轮廓，而不是 42 圈并级边框。
     */
    function Row(props) {
      const cls =
        "pl-settings__row" +
        (props.stack === true ? " pl-settings__row--stack" : "") +
        (props.emphasis === true ? " pl-settings__row--emphasis" : "");
      return h(
        "div",
        { className: cls },
        h(
          "div",
          { className: "pl-settings__main" },
          h(
            "div",
            { className: "pl-settings__label-line" },
            h("span", { className: "pl-settings__label" }, props.label),
            h(ScopeTag, { scopeNote: props.scopeNote, projectFirst: props.projectFirst })
          ),
          props.hint ? h(Hint, { text: props.hint }) : null,
          h(ScopeNote, { scopeNote: props.scopeNote, projectFirst: props.projectFirst })
        ),
        h("div", { className: "pl-settings__ctl" }, props.children)
      );
    }

    /** 布尔行。 */
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
          h("input", {
            key: "c",
            type: "checkbox",
            checked: value === true,
            disabled: disabled === true,
            "aria-label": spec.label,
            onChange: (e) => onChange(e.target.checked),
          }),
        ]
      );
    }

    /**
     * 数字行：右侧带单位，下方带合法范围。
     * 范围直接显示在输入框下面，使「能填多少」一眼可见，而不必去读说明文字。
     */
    function NumberRow(props) {
      const { spec, value, onChange, disabled } = props;
      const hasRange = typeof spec.min === "number" && typeof spec.max === "number";
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
          h("div", { key: "w", className: "pl-settings__ctl-wrap" }, [
            h("input", {
              key: "n",
              className: "pl-settings__num",
              type: "number",
              value: value,
              min: spec.min,
              max: spec.max,
              step: spec.step,
              disabled: disabled === true,
              "aria-label": spec.label,
              onChange: (e) => onChange(e.target.value),
            }),
            h(
              "span",
              { key: "r", className: "pl-settings__range" },
              (hasRange ? `${spec.min} – ${spec.max}` : "") +
                (spec.unit ? `${hasRange ? " · " : ""}${spec.unit}` : "")
            ),
          ]),
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
        },
        h(
          "div",
          { className: "pl-settings__main" },
          h(
            "div",
            { className: "pl-settings__label-line" },
            h("span", { className: "pl-settings__label" }, spec.label),
            h(ScopeTag, { scopeNote: spec.scopeNote, projectFirst: props.projectFirst })
          ),
          spec.hint ? h(Hint, { text: spec.hint }) : null,
          h(ScopeNote, { scopeNote: spec.scopeNote, projectFirst: props.projectFirst })
        ),
        h(
          "div",
          { className: "pl-settings__levels", role: "group", "aria-label": spec.label },
          levels.map((k) =>
            h(
              "label",
              { key: k, className: "pl-settings__lvl" },
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
      const declared = Array.isArray(data.groups) ? data.groups : [];

      const meta = new Map();
      const declaredOrder = [];
      for (const g of declared) {
        if (g !== null && typeof g === "object" && typeof g.key === "string") {
          meta.set(g.key, g);
          if (!declaredOrder.includes(g.key)) declaredOrder.push(g.key);
        }
      }

      // ① 按 group 归集
      const byGroup = new Map();
      for (const spec of specs) {
        const g = typeof spec.group === "string" && spec.group !== "" ? spec.group : "__other";
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(spec);
      }

      // ② 顺序以 groups 的声明顺序为准，而不是 specs 里谁先出现。
      //    「打算让它这样显示」这一意图表达在 SETTING_GROUPS 里，
      //    而 SETTING_SPECS 中相关几项的排列顺序并不代表设计意图。
      //    未在 groups 里声明的组（宿主旧版 / 兜底 __other）追加到末尾，
      //    保持它们在 specs 里首次出现的相对顺序 —— 不丢项。
      const order = [];
      for (const g of declaredOrder) if (byGroup.has(g)) order.push(g);
      for (const g of byGroup.keys()) if (!order.includes(g)) order.push(g);

      const titleOf = (g) => {
        const m = meta.get(g);
        if (m !== undefined && typeof m.label === "string" && m.label !== "") return m.label;
        return g === "__other" ? "其他" : g;
      };
      const hintOf = (g) => {
        const m = meta.get(g);
        return m !== undefined && typeof m.hint === "string" ? m.hint : undefined;
      };

      return order.map((g) => ({
        key: g,
        title: titleOf(g),
        hint: hintOf(g),
        specs: byGroup.get(g) ?? [],
      }));
    }

    /** 只渲染一页。一次只画一页，视觉长度降到 1/N。 */
    function renderPage(page, draft, setDraft, disabled, projectFirst) {
      if (page === undefined || page === null) return null;
      return h(
        "div",
        { key: page.key, className: "pl-settings__card", role: "tabpanel" },
        h(
          "div",
          { className: "pl-settings__card-head" },
          h("span", { className: "pl-settings__card-title" }, page.title),
          page.hint ? h("span", { className: "pl-settings__card-hint" }, page.hint) : null
        ),
        h(
          "div",
          { className: "pl-settings__card-body" },
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
