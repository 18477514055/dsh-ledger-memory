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
      return { [spec.key]: uiValue };
    }

    /** 从当前设置里取出某个控件要显示的初值。 */
    function settingsToUi(spec, settings) {
      const v = settings === undefined ? undefined : settings[spec.key];
      if (spec.kind === "tiers") return formatTiers(v);
      if (spec.kind === "levels") return v === undefined || v === null ? {} : v;
      if (spec.kind === "number") return v === undefined || v === null ? "" : String(v);
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
.pl-settings { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 18px; }
.pl-settings__intro { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.65; }
.pl-settings__row {
  display: flex; gap: 14px; align-items: flex-start;
  padding: 12px 14px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
}
.pl-settings__row--stack { flex-direction: column; gap: 8px; }
.pl-settings__main { flex: 1 1 auto; min-width: 0; }
.pl-settings__label { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.pl-settings__hint { margin-top: 4px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.pl-settings__ctl { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
.pl-settings__levels { display: flex; flex-wrap: wrap; gap: 12px; }
.pl-settings__lvl { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-primary); }
.pl-settings__num {
  width: 110px; padding: 5px 8px; font-size: 13px; font-family: inherit;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
}
.pl-settings__num--wide { width: 180px; }
.pl-settings__bar { display: flex; align-items: center; gap: 10px; padding-top: 4px; }
.pl-settings__btn {
  padding: 6px 16px; font-size: 13px; font-family: inherit; cursor: pointer;
  background: var(--dsw-alias-brand-primary); color: #ffffff;
  border: 1px solid transparent; border-radius: 6px;
}
.pl-settings__btn:disabled { opacity: .5; cursor: not-allowed; }
.pl-settings__btn--ghost {
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
}
.pl-settings__msg { font-size: 12px; line-height: 1.6; }
.pl-settings__msg--ok { color: var(--dsw-alias-state-success-primary); }
.pl-settings__msg--err { color: var(--dsw-alias-state-error-primary); }
.pl-settings__msg--warn { color: var(--dsw-alias-state-warn-primary); }
.pl-settings__note {
  padding: 10px 12px; font-size: 12px; line-height: 1.65;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
}
.pl-settings__mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
/* 二选一（模式）：把两个选项的**取舍**都摆在眼前，不下拉折叠 */
.pl-settings__choices { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.pl-settings__choice {
  display: flex; gap: 8px; align-items: flex-start; cursor: pointer;
  padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.pl-settings__choice--on {
  border-color: var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-bg-layer-2);
}
.pl-settings__choice input { margin-top: 2px; flex: none; }
.pl-settings__choice-body { display: flex; flex-direction: column; gap: 2px; }
.pl-settings__choice-label { font-size: 13px; color: var(--dsw-alias-label-primary); }
.pl-settings__choice-hint { font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
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

    /** 一行：左边标题 + 说明，右边控件。 */
    function Row(props) {
      return h(
        "div",
        { className: "pl-settings__row" + (props.stack === true ? " pl-settings__row--stack" : "") },
        h(
          "div",
          { className: "pl-settings__main" },
          h("div", { className: "pl-settings__label" }, props.label),
          props.hint ? h("div", { className: "pl-settings__hint" }, props.hint) : null
        ),
        h("div", { className: "pl-settings__ctl" }, props.children)
      );
    }

    /** 布尔行。 */
    function BoolRow(props) {
      const { spec, value, onChange, disabled } = props;
      return h(Row, { label: spec.label, hint: spec.hint }, [
        h("input", {
          key: "c",
          type: "checkbox",
          checked: value === true,
          disabled: disabled === true,
          onChange: (e) => onChange(e.target.checked),
        }),
      ]);
    }

    /** 数字行。 */
    function NumberRow(props) {
      const { spec, value, onChange, disabled } = props;
      return h(Row, { label: spec.label, hint: spec.hint }, [
        h("input", {
          key: "n",
          className: "pl-settings__num",
          type: "number",
          value: value,
          min: spec.min,
          max: spec.max,
          step: spec.step,
          disabled: disabled === true,
          onChange: (e) => onChange(e.target.value),
        }),
      ]);
    }

    /**
     * 二选一（含以上）行 —— 每个选项一个单选按钮 + 名字 + 说明。
     *
     * ★ 为什么不用下拉框：这一项的两个选项**各有各的取舍**（省一次模型输出 vs
     *   按内容分流），用户需要**看见取舍**才能选对。下拉框把说明藏起来了。
     * ★ 选项来自宿主（`spec.options` 是**已展开的数组** —— 宿主那边是取值函数，
     *   为躲 TDZ；见宿主 `SETTING_SPECS` 的注释）。客户端**不认识任何模式名**，
     *   只按 `value`/`label`/`hint` 渲染 ⇒ 以后加第三个模式**不用改本文件**。
     */
    function ChoiceRow(props) {
      const { spec, value, onChange, disabled } = props;
      const opts = Array.isArray(spec.options) ? spec.options : [];
      return h(Row, { label: spec.label, hint: spec.hint, stack: true }, [
        h(
          "div",
          { key: "g", className: "pl-settings__choices" },
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
      ]);
    }

    /** 档位行（文本框，逗号分隔）。 */
    function TiersRow(props) {
      const { spec, value, onChange, disabled } = props;
      return h(Row, { label: spec.label, hint: spec.hint }, [
        h("input", {
          key: "t",
          className: "pl-settings__num pl-settings__num--wide",
          type: "text",
          value: value,
          placeholder: TIERS_PLACEHOLDER,
          disabled: disabled === true,
          onChange: (e) => onChange(e.target.value),
        }),
      ]);
    }

    /** 日志档位行（五档复选）。单独排一行（横排放不下）。 */
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
        { className: "pl-settings__row pl-settings__row--stack" },
        h(
          "div",
          { className: "pl-settings__main" },
          h("div", { className: "pl-settings__label" }, spec.label),
          spec.hint ? h("div", { className: "pl-settings__hint" }, spec.hint) : null
        ),
        h(
          "div",
          { className: "pl-settings__levels" },
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

    function controlFor(spec, draft, setDraft, disabled) {
      const value = draft[spec.key];
      const set = (v) => setDraft(Object.assign({}, draft, { [spec.key]: v }));
      if (spec.kind === "boolean") return h(BoolRow, { key: spec.key, spec, value, onChange: set, disabled });
      if (spec.kind === "choice") return h(ChoiceRow, { key: spec.key, spec, value, onChange: set, disabled });
      if (spec.kind === "number") return h(NumberRow, { key: spec.key, spec, value, onChange: set, disabled });
      if (spec.kind === "tiers") return h(TiersRow, { key: spec.key, spec, value, onChange: set, disabled });
      if (spec.kind === "levels") return h(LevelsRow, { key: spec.key, spec, value, onChange: set, disabled });
      return null;
    }

    /**
     * 设置页本体。
     *
     * 生命周期：挂载时 GET 一次；保存时 POST 差异补丁；保存成功后用服务端回报的
     * **生效值**刷新草稿（不是用本地草稿 —— 服务端会归一化越界值，本地那份可能是错的）。
     */
    function SettingsPage() {
      const [view, setView] = useState({ loading: true, error: null, data: null });
      const [draft, setDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const [msg, setMsg] = useState(null);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
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
        return () => {
          alive.current = false;
        };
      }, []);

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
            // ★ 用**服务端回报的生效值**刷新，而不是本地草稿：越界值会被夹紧
            //   （例如水位填 0.9 → 服务端夹到 0.79），本地那份是错的。
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

      const onReset = useCallback(() => {
        if (view.data === null) return;
        setDraft(buildDraft(view.data));
        setMsg(null);
      }, [view]);

      if (view.loading) {
        return h("div", { className: "pl-settings" }, h("div", { className: "pl-settings__intro" }, "正在读取设置…"));
      }
      if (view.error !== null) {
        return h(
          "div",
          { className: "pl-settings" },
          h("div", { className: "pl-settings__msg pl-settings__msg--err" }, "读取设置失败：" + view.error),
          h(
            "div",
            { className: "pl-settings__note" },
            "这条界面只影响设置面板本身，**台账功能不受影响** —— 插件照常工作。"
          )
        );
      }

      const data = view.data;
      const disabled = data.writable !== true || saving;
      const dirty = draft !== null && Object.keys(diffPatch(data.specs, draft, data.settings)).length > 0;

      return h(
        "div",
        { className: "pl-settings" },
        h(
          "div",
          { className: "pl-settings__intro" },
          "这些是**插件级**默认设置。个别项目自己的选择（例如 .dsh-ledger.json 里的",
          h("span", { className: "pl-settings__mono" }, " maxActiveLines"),
          " 与 ",
          h("span", { className: "pl-settings__mono" }, "logLevels"),
          "）**优先于**这里的值 —— 这里管的是**新项目登记成什么**。"
        ),
        data.writable !== true
          ? h(
              "div",
              { className: "pl-settings__note" },
              "⚠ " + (data.why || "当前无法保存设置。") + "（下面显示的仍是实际生效的值。）"
            )
          : null,
        draft === null ? null : data.specs.map((spec) => controlFor(spec, draft, setDraft, disabled)),
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
              disabled: disabled || !dirty,
              onClick: onReset,
            },
            "还原"
          ),
          msg === null
            ? null
            : h("span", { className: "pl-settings__msg pl-settings__msg--" + msg.kind }, msg.text)
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
          helpers: { parseTiers, formatTiers, valueToPatch, settingsToUi, sameValue, diffPatch, buildDraft },
        };
      } catch {
        /* 没有 globalThis 就算了。 */
      }
    }

    return { name, inject, apply };
  },
});
