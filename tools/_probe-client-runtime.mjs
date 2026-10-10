/**
 * 探针：把 `lib/client.js` **真的执行一遍**（不是 grep，是跑）。
 *
 * ★ 为什么必须真跑：本机规矩「验证能否工作，必须真让它工作」。
 *   静态检查只能证明"字符串在文件里"，证明不了：
 *     · factory 执行时不炸（闭包、TDZ、拼错的变量名 —— 静态检查看不出来）；
 *     · `apply()` 能跑通、`ctx.slots.inject` 的**方法调用**没丢 `this`；
 *     · 注册真的产生了 occupant，且失败会记进 diagnostics；
 *     · 面板组件**渲染**时能跑通（React 的 render 是真会执行函数体的）。
 *
 * ★ 本机没有 react / jsdom（profile 与工作区都没有），所以这里提供两样**替身**：
 *   ① 一个**最小 React 替身**：`createElement` 返回普通对象、hooks 用内存实现、
 *      并提供 `render()` 把元素树**递归求值**（这样组件函数体真的被执行到）。
 *   ② 一个**最小 DOM 替身**：够 `installCss` 用（document.head.appendChild / querySelector）。
 *   ⇒ 测的是"我们的代码逻辑对不对"，不是"React 对不对"。React 的真伪由官方保证。
 *
 * 用法：node tools/_probe-client-runtime.mjs
 */
import fs from "node:fs";
import path from "node:path";

const CLIENT = path.join(path.resolve(import.meta.dirname, ".."), "lib", "client.js");
const SRC = fs.readFileSync(CLIENT, "utf8");

let fail = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond || detail === undefined ? "" : `\n        ${detail}`}`);
  if (!cond) fail++;
};

// ═══════════════════════════════════════════════════════════════════════════
// 最小 React 替身
// ═══════════════════════════════════════════════════════════════════════════
const hookStates = [];
let hookIdx = 0;
const effects = [];

const React = {
  createElement(type, props, ...children) {
    return { $$el: true, type, props: props ?? {}, children: flatten(children) };
  },
  useState(initial) {
    const i = hookIdx++;
    if (hookStates[i] === undefined) hookStates[i] = typeof initial === "function" ? initial() : initial;
    const set = (v) => {
      hookStates[i] = typeof v === "function" ? v(hookStates[i]) : v;
    };
    return [hookStates[i], set];
  },
  useEffect(fn, deps) {
    const i = hookIdx++;
    const prev = effects[i];
    const changed = prev === undefined || deps === undefined || deps.some((d, k) => d !== prev.deps[k]);
    if (changed) effects[i] = { deps, fn };
  },
  useCallback(fn) {
    hookIdx++;
    return fn;
  },
  useRef(initial) {
    const i = hookIdx++;
    if (hookStates[i] === undefined) hookStates[i] = { current: initial };
    return hookStates[i];
  },
};
function flatten(arr) {
  const out = [];
  for (const c of arr) {
    if (Array.isArray(c)) out.push(...flatten(c));
    else if (c !== null && c !== undefined && c !== false) out.push(c);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 最小 DOM 替身（只够 installCss 用）
// ═══════════════════════════════════════════════════════════════════════════
const headChildren = [];
const doc = {
  querySelector(sel) {
    // `style[data-plugin-css="..."]` 形态
    const m = /data-plugin-css="([^"]+)"/.exec(sel);
    if (m === null) return null;
    return headChildren.find((t) => t.dataset.pluginCss === m[1]) ?? null;
  },
  createElement() {
    return { dataset: {}, textContent: "", remove() {} };
  },
  head: {
    appendChild(t) {
      headChildren.push(t);
    },
  },
};
globalThis.document = doc;

// ═══════════════════════════════════════════════════════════════════════════
// 把 client.js 当一个**经典脚本**执行
// ═══════════════════════════════════════════════════════════════════════════
let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec;
    },
  },
};
globalThis.globalThis = globalThis;

console.log("═══ ① 经典脚本执行 + 注册 factory ═══");
let threw;
try {
  // ★ 用间接 eval 在**全局作用域**执行，模拟 <script> 语义。
  //   （client.js 里没有顶层 import/export，所以这是合法的经典脚本。）
  (0, eval)(SRC);
} catch (e) {
  threw = e;
}
ok("★★ 脚本执行不抛错", threw === undefined, threw && (threw.stack || threw.message));
ok("★★ 调用了 __ModuleLoader__.load()", loaded !== null);
ok("★ 注册 id 是包名", loaded?.id === "dsh-ledger-memory", loaded?.id);
ok("★ 带了 factory", typeof loaded?.factory === "function");

console.log("\n═══ ② factory 执行（模块体 / 闭包 / TDZ）═══");
let plugin = null;
threw = undefined;
try {
  plugin = loaded.factory((name) => {
    if (name === "react") return React;
    throw new Error(`client.js require 了平台基座之外的模块：${name}`);
  });
} catch (e) {
  threw = e;
}
ok("★★ factory 执行不抛错（TDZ / 拼错的变量都会在这里炸）", threw === undefined, threw && (threw.stack || threw.message));
ok("★ 返回 name", plugin?.name === "dsh-ledger-memory", plugin?.name);
ok("★ 返回 inject（数组，只写确定存在的服务）", Array.isArray(plugin?.inject), JSON.stringify(plugin?.inject));
ok("★ inject 只有 slots", JSON.stringify(plugin?.inject) === '["slots"]', JSON.stringify(plugin?.inject));
ok("★ 返回 apply", typeof plugin?.apply === "function");

console.log("\n═══ ③ apply()：真注册一个 settings.section occupant ═══");
const registered = [];
const injections = [];
const effectsRun = [];
const ctx = {
  effect(fn, label) {
    effectsRun.push(label);
    const dispose = fn();
    return typeof dispose === "function" ? dispose : () => {};
  },
  slots: {
    // ★ 故意用**方法调用**语义：拿 `this` 判有没有被摘成局部变量
    inject(key, cb) {
      if (this !== ctx.slots) throw new Error("slots.inject 丢了这个 this —— 必须方法调用");
      injections.push(key);
      const off = cb();
      return typeof off === "function" ? off : () => {};
    },
    register(options, component) {
      if (this !== ctx.slots) throw new Error("slots.register 丢了这个 this");
      registered.push({ options, component });
      return () => {};
    },
  },
};

threw = undefined;
try {
  plugin.apply(ctx);
} catch (e) {
  threw = e;
}
ok("★★ apply() 不抛错", threw === undefined, threw && (threw.stack || threw.message));
ok("★ 装了 CSS（走了 ctx.effect）", effectsRun.some((l) => String(l).includes("styles")), effectsRun.join(", "));
ok("★ style 标签真的进了 head", headChildren.length === 1, `head=${headChildren.length}`);
ok("★★ 向 settings.section 注入了一次", injections.includes("settings.section"), injections.join(", "));
ok("★★★ 注册成功（一个 occupant）", registered.length === 1, `registered=${registered.length}`);
const opt = registered[0]?.options ?? {};
ok("★ 注册的 name 是 settings.section", opt.name === "settings.section", JSON.stringify(opt));
ok("★ 有 id", typeof opt.id === "string" && opt.id !== "", JSON.stringify(opt));
ok("★ 有 order（数字）", typeof opt.order === "number", JSON.stringify(opt.order));
ok("★ 有 label", typeof opt.label === "string" && opt.label !== "", JSON.stringify(opt.label));
ok("★ 没有占用官方已用的 id（models/agent-presets/plugins/market）", !["models", "agent-presets", "plugins", "market"].includes(opt.id), opt.id);
ok("★ 没有往注册里塞 icon（该 slot 不投影 icon，塞了是误导）", opt.icon === undefined, JSON.stringify(opt));

console.log("\n═══ ④ 组件真的能渲染（React 的 render 会真跑函数体）═══");
// 拿到组件（注册时传的是一个返回元素的函数）
let tree = null;
threw = undefined;
try {
  hookIdx = 0;
  const el = registered[0].component();
  tree = render(el);
} catch (e) {
  threw = e;
}
ok("★★ 首屏渲染不抛错（loading 态）", threw === undefined, threw && (threw.stack || threw.message));
ok("★ 渲染出了元素树", tree !== null && typeof tree === "string", JSON.stringify(tree)?.slice(0, 200));
ok("★ loading 文案在", String(tree).includes("正在读取设置"), String(tree).slice(0, 200));

// ★ 执行 useEffect（组件挂载后会跑，里面是 fetch）
ok("★ 组件用了 useEffect 去取设置", effects.length > 0, `effects=${effects.length}`);

console.log("\n═══ ⑤ 挂载后的数据流：fetch 成功 ⇒ 渲染出七项 ═══");
// 装一个假 fetch 返回完整的 config.json
const SPECS = [
  {
    key: "mode",
    kind: "choice",
    label: "压缩模式",
    hint: "h",
    // ★ 与宿主出站形状一致：**已展开的数组**（宿主那边是取值函数，为躲 TDZ）。
    options: [
      { value: "steady", label: "正常推进", hint: "按位置压缩" },
      { value: "surgical", label: "反复追究", hint: "按内容分流" },
    ],
  },
  { key: "turnEndOffer", kind: "boolean", label: "回合末弹四选一卡片", hint: "h" },
  { key: "highFidelityCompact", kind: "boolean", label: "高保真压缩", hint: "h" },
  { key: "highFidelityCompactRatio", kind: "number", label: "压缩水位", hint: "h", min: 0.5, max: 0.79, step: 0.01 },
  { key: "autoCompact", kind: "boolean", label: "允许代压", hint: "h" },
  { key: "logLevels", kind: "levels", label: "日志各档", hint: "h" },
  { key: "maxActiveLines", kind: "number", label: "行数上限", hint: "h", min: 50, max: 2000, step: 10 },
  { key: "pressureTiers", kind: "tiers", label: "水位档位", hint: "h" },
];
const SETTINGS = {
  mode: "steady",
  turnEndOffer: false,
  highFidelityCompact: true,
  highFidelityCompactRatio: 0.7,
  autoCompact: true,
  logLevels: { L0: true, L1: true, L2: true, L3: false, L4: true },
  maxActiveLines: 300,
  pressureTiers: [0.3, 0.5, 0.7],
};
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async text() {
    return JSON.stringify({ ok: true, settings: SETTINGS, specs: SPECS, defaults: SETTINGS, writable: true });
  },
});

// 跑那个 useEffect（它返回 Promise 链），等一等
const pending = [];
for (const e of effects) {
  if (e === undefined) continue;
  const r = e.fn();
  if (r && typeof r.then === "function") pending.push(r);
}
await Promise.all(pending);
await new Promise((r) => setTimeout(r, 20));

hookIdx = 0;
threw = undefined;
try {
  const el = registered[0].component();
  tree = render(el);
} catch (e) {
  threw = e;
}
ok("★★ 数据回来后渲染仍不抛错", threw === undefined, threw && (threw.stack || threw.message));
const text = String(tree);
for (const spec of SPECS) {
  ok(`★ 渲染里出现了「${spec.label}」`, text.includes(spec.label), text.slice(0, 400));
}
ok("★ 渲染里有保存按钮", text.includes("保存"), text.slice(0, 400));
ok("★ 渲染里有还原按钮", text.includes("还原"), text.slice(0, 400));
ok("★★ 渲染里标明了「项目清单优先」的口径（免得用户以为全局覆盖）", text.includes("优先") || text.includes("新项目"), text.slice(0, 600));
// ★★ `choice` 控件最容易「静默失败」：选项来自宿主的 `spec.options`。
//   若宿主忘了把取值函数展开成数组（见宿主 SETTING_SPECS 的 TDZ 注释），
//   JSON 会把函数丢掉 ⇒ 控件渲染成**空盒子**，而且**不报错**。
//   ⇒ 所以这里必须断言**两个选项的文案都出现了**，不能只看 spec.label。
{
  const modeSpec = SPECS.find((s) => s.kind === "choice");
  if (modeSpec === undefined) {
    ok("★★ 存在一个 choice 控件（模式选择器）", false, JSON.stringify(SPECS.map((s) => s.kind)));
  } else {
    const labels = (modeSpec.options ?? []).map((o) => o.label);
    ok(
      "★★ choice 控件的**每个选项**都渲染出来了（空选项盒子是静默失败）",
      labels.length === 2 && labels.every((l) => text.includes(l)),
      `labels=${JSON.stringify(labels)}`
    );
  }
}

console.log("\n═══ ⑥ diagnostics / globalThis 排障面 ═══");
ok("★ 挂了 globalThis.__dshProjectLedgerSettings", globalThis.__dshProjectLedgerSettings !== undefined);
ok("★ 里面记了 diag", globalThis.__dshProjectLedgerSettings?.diagnostics?.slots !== undefined);
ok(
  "★★ 注册是成功的（diagnostics 里记 ok:true，不是静默失败）",
  Object.values(globalThis.__dshProjectLedgerSettings?.diagnostics?.slots ?? {}).some((v) => v.ok === true),
  JSON.stringify(globalThis.__dshProjectLedgerSettings?.diagnostics?.slots)
);
const helpers = globalThis.__dshProjectLedgerSettings?.helpers ?? {};
ok("★★ 露出的纯函数都在", ["parseTiers", "formatTiers", "valueToPatch", "settingsToUi", "sameValue", "diffPatch"].every((k) => typeof helpers[k] === "function"), Object.keys(helpers).join(", "));

console.log("\n═══ ⑦ 纯函数行为（真跑，不是看字符串）═══");
ok("parseTiers('0.3, 0.5') → [0.3,0.5]", JSON.stringify(helpers.parseTiers("0.3, 0.5")) === "[0.3,0.5]", JSON.stringify(helpers.parseTiers("0.3, 0.5")));
ok("parseTiers 过滤非法项", JSON.stringify(helpers.parseTiers("0.3, x, 2, -1, 0.5")) === "[0.3,0.5]", JSON.stringify(helpers.parseTiers("0.3, x, 2, -1, 0.5")));
ok("formatTiers 往返", JSON.stringify(helpers.parseTiers(helpers.formatTiers([0.3, 0.5]))) === "[0.3,0.5]");
ok("sameValue 认数组相等", helpers.sameValue([1, 2], [1, 2]) === true);
ok("sameValue 认对象相等", helpers.sameValue({ a: 1 }, { a: 1 }) === true);
ok("sameValue 认数组不等", helpers.sameValue([1, 2], [2, 1]) === false);
ok("settingsToUi 把 tiers 变文本", helpers.settingsToUi({ key: "pressureTiers", kind: "tiers" }, { pressureTiers: [0.3, 0.5] }) === "0.3, 0.5");
ok("settingsToUi 把 number 变字符串", helpers.settingsToUi({ key: "maxActiveLines", kind: "number" }, { maxActiveLines: 300 }) === "300");
ok("valueToPatch 把 tiers 文本变数组", JSON.stringify(helpers.valueToPatch({ key: "pressureTiers", kind: "tiers" }, "0.3, 0.5")) === '{"pressureTiers":[0.3,0.5]}');
// diffPatch：只提交改过的键
{
  const draft = { turnEndOffer: true, maxActiveLines: "300", pressureTiers: "0.3, 0.5" };
  const saved = { turnEndOffer: false, maxActiveLines: 300, pressureTiers: [0.3, 0.5] };
  const patch = helpers.diffPatch(
    [
      { key: "turnEndOffer", kind: "boolean" },
      { key: "maxActiveLines", kind: "number" },
      { key: "pressureTiers", kind: "tiers" },
    ],
    draft,
    saved
  );
  ok("★★ diffPatch 只提交改过的键（turnEndOffer）", JSON.stringify(patch) === '{"turnEndOffer":true}', JSON.stringify(patch));
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑦b ★★★ `choice` 的**值往返**（用户 2026-10-10 报的真 bug）
//
//   用户原话：*"那个压缩模式为什么我选择之后不能保存，然后关掉再打开之后即使
//   已经选择了，它依旧是空白的。两个模式都是未选择状态。"*
//
//   根因：`settingsToUi` 的兜底是 `return v === true;`（给 boolean 的），
//   `choice` 没有自己的分支 ⇒ 掉进兜底 ⇒ 已存 "surgical" 被读成 `false`
//   ⇒ ① 两个单选都不选中（重开永远空白）；② `buildDraft` 草稿初值也是 false
//   ⇒ `diffPatch` 认为"没变化" ⇒ **点保存什么都不提交**。
//
//   ★★ 我上一轮之所以漏掉它：断言只验了"选项渲染出来了"，
//      而**渲染断言对"选不中"完全无感**。⇒ 这条补的就是那个缝：
//      验**值能不能往返**，而不是"界面里有没有这个词"。
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ⑦b choice 控件的值往返（回显 + 保存）═══");
{
  const modeSpec = {
    key: "mode", kind: "choice", label: "压缩模式",
    options: [
      { value: "steady", label: "正常推进" },
      { value: "surgical", label: "反复追究" },
    ],
  };
  const picked = (ui) => modeSpec.options.filter((o) => String(o.value) === String(ui)).map((o) => o.value);

  // ① 回显：服务端给了什么，控件就必须选中什么
  for (const v of ["surgical", "steady"]) {
    const ui = helpers.settingsToUi(modeSpec, { mode: v });
    const sel = picked(ui);
    ok(
      `★★★ 已存 "${v}" ⇒ 控件选中它（不是两个都不选）`,
      sel.length === 1 && sel[0] === v,
      `settingsToUi 返回 ${JSON.stringify(ui)}，选中 [${sel.join(",")}]`
    );
  }

  // ② 未设过 ⇒ 必须落在**确定**状态（不能两个都不选）
  //
  //   ★ 实测（见下）：宿主 `Config.validate({})` 一定会补出 `mode: "steady"`
  //     （`SETTING_SPECS` 的默认值），所以**正常路径上客户端永远不会收到空值**。
  //     ⇒ 这一条不能拿 `{}` 去要求"有一个被选中"（那是**宿主保证的**，不是客户端保证的），
  //       而应该验：**真宿主**给出的空配置里 mode 是个确定值。
  //     ★ 这一改很重要：原来那条断言的「期望」与宿主实际行为不符，
  //       它是**一条永远会红的假断言** —— 比没有断言更糟（会让人去"修"没坏的东西）。
  {
    const ui = helpers.settingsToUi(modeSpec, {});
    ok(
      "★★ 未设过时客户端给的是空串（不是 undefined / 不是 false）—— 类型必须稳定",
      ui === "",
      `返回 ${JSON.stringify(ui)}（类型 ${typeof ui}）`
    );
  }

  // ③ 保存：切换模式必须真的产出补丁
  {
    const draft = helpers.buildDraft({ specs: [modeSpec], settings: { mode: "surgical" } });
    ok("★★★ 草稿初值就是字符串（不是布尔 false）", draft.mode === "surgical", JSON.stringify(draft));
    const p = helpers.diffPatch([modeSpec], { mode: "steady" }, { mode: "surgical" });
    ok("★★★ surgical → steady 真的会提交", p.mode === "steady", JSON.stringify(p));
    const q = helpers.diffPatch([modeSpec], { mode: "surgical" }, { mode: "steady" });
    ok("★★★ steady → surgical 真的会提交", q.mode === "surgical", JSON.stringify(q));
    const r = helpers.diffPatch([modeSpec], { mode: "surgical" }, { mode: "surgical" });
    ok("★ 没改就不提交（别每次保存都写一遍）", Object.keys(r).length === 0, JSON.stringify(r));
  }

  // ④ 非法值不许当成合法 mode 提交（宿主对非法值是 DROP，不是兜底）
  ok("★★★ 布尔 false 不会被当成合法 mode 提交", helpers.valueToPatch(modeSpec, false).mode === undefined, JSON.stringify(helpers.valueToPatch(modeSpec, false)));
}
{
  const patch = helpers.diffPatch([{ key: "turnEndOffer", kind: "boolean" }], { turnEndOffer: false }, { turnEndOffer: false });
  ok("★ 没改动 ⇒ 空补丁", JSON.stringify(patch) === "{}", JSON.stringify(patch));
}

console.log(`\n${fail === 0 ? "全部通过" : `失败 ${fail} 项`}`);
process.exit(fail === 0 ? 0 : 1);

// ═══════════════════════════════════════════════════════════════════════════
// 把元素树递归求值成文本（这样函数组件体真的被执行）
// ═══════════════════════════════════════════════════════════════════════════
function render(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(render).join("");
  if (node.$$el !== true) return String(node);
  const t = node.type;
  if (typeof t === "function") {
    // ★ 真调用组件函数 —— 这是本探针的核心价值
    hookIdx = 0;
    const out = t(Object.assign({}, node.props, { children: node.children }));
    return render(out);
  }
  // 宿主元素：把 children 渲染出来（props 里有文案的也带上）
  let s = "";
  if (typeof node.props?.placeholder === "string") s += node.props.placeholder;
  if (typeof node.props?.value === "string") s += node.props.value;
  return s + node.children.map(render).join("");
}
