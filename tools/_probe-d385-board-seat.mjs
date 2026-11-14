/**
 * ★★★★ 只读探针（D385）：**看板的两个注册到底有没有真的发生**。
 *
 * 为什么要它：座位连续两版"看不见且不报错"，第三版查明是
 * **注册代码写在了 `apply(ctx)` 之外**（工厂体顶层）⇒ `ctx` 不是插件上下文 ⇒
 * 抛错被 `try/catch` 吞掉。这种缺陷**运行时零报错**，只有槽位快照能看出来；
 * 而槽位快照要人肉去查 ⇒ 立一个离线判据。
 *
 * 判据（全部可证伪）：
 *   ① 工厂体求值阶段**不许**有任何 `ctx.slots.*` 调用（老写法会在这里就注册/抛错）
 *   ② `apply(ctx)` 之后，必须真的注册了三样：
 *        `settings.section` / id=project-ledger
 *        `main`            / key=ledger-board
 *        `sidebar.panellist` / id=ledger-board
 *   ③ 第二参数必须是**组件函数**（v2 的 `()=>null` 也能过 ②，但座位渲染成空）
 *   ④ 不许记下失败痕迹（`globalThis.__dshProjectLedgerBoard.ok === true`）
 *
 * ★ 沙箱说明：本探针**不 import 任何 DSH 包**，只用 `node:vm` + 最小桩
 *   （react / document / window），所以它能离线跑，也不会污染真实界面。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const FILE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(import.meta.dirname, "..", "lib", "client.js");
const src = fs.readFileSync(FILE, "utf8");

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${extra === undefined ? "" : " → " + extra}`); }
};

// ── 最小 React 桩（本文件只 require("react")，且全用手搓 createElement）──
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: "F",
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useRef: (v) => ({ current: v }),
  useContext: () => ({}),
  createContext: (v) => ({ Provider: "P", _v: v }),
};

// ── 记录器 ──
const regs = [];
const disposers = [];
const evalPhaseCalls = [];
let captured;

const makeCtx = (label) => ({
  label,
  slots: {
    inject(key, cb) {
      if (label === "eval") evalPhaseCalls.push(["inject", key]);
      const off = cb();
      if (typeof off === "function") disposers.push(off);
      return () => {};
    },
    register(opts, comp) {
      if (label === "eval") evalPhaseCalls.push(["register", opts && (opts.id || opts.key)]);
      regs.push({ at: label, opts, comp });
      return () => {};
    },
  },
  effect(fn) {
    try { const off = fn(); if (typeof off === "function") disposers.push(off); } catch {}
    return () => {};
  },
  get() { return undefined; },
  inject() {},
  logger: { warn: (m) => console.log(`     [ctx.logger.warn] ${m}`) },
  emit() {},
});

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async () => { throw new Error("探针里不发网络请求"); },
  URL,
  JSON,
  Date,
  Math,
  require: (name) => {
    if (name === "react") return react;
    throw new Error(`探针不提供模块：${name}`);
  },
  document: {
    getElementById: () => null,
    createElement: () => ({ id: "", textContent: "", appendChild: () => {}, style: {} }),
    head: { appendChild: () => {} },
    documentElement: { appendChild: () => {} },
    body: { appendChild: () => {} },
    addEventListener: () => {},
  },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.__ModuleLoader__ = {
  load: ({ id, factory }) => { captured = { id, factory }; },
};

const ctxObj = vm.createContext(sandbox);
try {
  vm.runInContext(src, ctxObj, { filename: "lib/client.js" });
} catch (e) {
  console.log(`  FAIL  客户端脚本求值就抛了：${e && e.message}`);
  fail += 1;
}

console.log(`\n模块 id = ${captured ? captured.id : "(没捕获到)"}`);
ok("① 脚本里存在 __ModuleLoader__.load", captured !== undefined);
ok("① id 必须等于包名 dsh-ledger-memory", captured?.id === "dsh-ledger-memory", String(captured?.id));

// ── 工厂体求值（老写法会在这里就注册/抛错）──
//   ★ 工厂的**第一个参数是 require**（平台既定签名：`factory: require => {...}`），
//     不是 ctx —— 这也正是"注册写在工厂体顶层"必然拿不到插件 ctx 的原因。
let plugin;
try {
  plugin = captured.factory((name) => {
    if (name === "react") return react;
    throw new Error(`探针不提供模块：${name}`);
  });
} catch (e) {
  console.log(`  FAIL  工厂体求值抛错：${e && e.message}`);
  fail += 1;
}
ok("① 工厂体阶段**不许**碰 ctx.slots（注册必须在 apply 里）", evalPhaseCalls.length === 0, JSON.stringify(evalPhaseCalls));
ok("① 工厂体必须返回 { name, inject, apply }", !!plugin && typeof plugin.apply === "function" && Array.isArray(plugin.inject));

// ── 真正 apply ──
if (plugin && typeof plugin.apply === "function") {
  try {
    plugin.apply(makeCtx("apply"));
  } catch (e) {
    console.log(`  FAIL  apply(ctx) 抛错：${e && e.message}`);
    fail += 1;
  }
}
const find = (slot, keyName, keyVal) =>
  regs.find((r) => r.opts?.name === slot && r.opts?.[keyName] === keyVal);

const sec = find("settings.section", "id", "project-ledger");
ok("② 注册了 settings.section / project-ledger", sec !== undefined);
ok("② 注册了 main / ledger-board", find("main", "key", "ledger-board") !== undefined);
const seat = find("sidebar.panellist", "id", "ledger-board");
ok("② 注册了 sidebar.panellist / ledger-board", seat !== undefined);

ok(
  "③ 座位第二参数是**组件函数**（v2 传 ()=>null 也能过 ②，但渲染成空）",
  seat !== undefined && typeof seat.comp === "function" && seat.comp.length >= 0,
  seat === undefined ? "没注册到" : typeof seat.comp
);
// v2 那个坑：返回 null 的组件。这里只拦"函数体只有 return null"这一种最典型形态。
if (seat !== undefined && typeof seat.comp === "function" && /^\s*\(?[^)]*\)?\s*=>\s*null\s*$/.test(String(seat.comp))) {
  ok("③ 座位组件不是 `=> null`", false, "它就是个空组件");
} else {
  ok("③ 座位组件不是 `=> null`", true);
}

const trace = sandbox.globalThis.__dshProjectLedgerBoard;
ok("④ 成功痕迹 ok === true", trace?.ok === true, JSON.stringify(trace ?? null));

console.log(`\n合计：PASS ${pass} · FAIL ${fail}`);
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
