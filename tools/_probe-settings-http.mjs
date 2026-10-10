/**
 * 探针：宿主那两段设置路由**过一遍真的 HTTP 栈**（不是假 req/res）。
 *
 * ★ 为什么还要这一层：自检里的 `callRoute` 用的是手搓的 req/res ——
 *   它验的是"handler 逻辑对不对"，验不到"接进官方 `webServer` 之后对不对"
 *   （`kind: "exact"` 的匹配、真实 req 是流、真实 res 的 writeHead/end 契约）。
 *   本机规矩：能真跑就真跑。
 *
 * 做法：起一个**最小的真 HTTP 服务器**，把插件注册的路由挂上去
 * （用与内核相同形状的注册契约：`{kind, path, handler}`，exact 匹配），
 * 然后用 `fetch` 打它。
 *
 * 用法：node tools/_probe-settings-http.mjs
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let fail = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond || detail === undefined ? "" : `\n        ${detail}`}`);
  if (!cond) fail++;
};

const ENTRY = path.join(path.resolve(import.meta.dirname, ".."), "lib", "index.js");
const mod = await import(new URL(`file:///${ENTRY.replace(/\\/g, "/").replace(/#/g, "%23")}`).href);

// ── 最小假 ctx（够 apply 跑起来并注册路由）───────────────────────────────
const routes = new Map();
const fakeEntry = { options: { id: "dsh-ledger-memory", name: "dsh-ledger-memory", config: {} } };
/**
 * ★ 上层的值**必须非空** —— 否则"实现有没有误并 inherited"测不出来。
 *   内核 README 警告：完整配置覆盖会在 profile 层**固定其当前原始值**。
 */
const fakeInherited = { fromUpperLayer: "upper", highFidelityCompactRatio: 0.65 };
let editCount = 0;

const services = {
  tools: { register: () => () => {} },
  commands: { register: () => () => {} },
  webServer: {
    register(route) {
      if (route.kind !== "exact") throw new Error(`只支持 exact，收到 ${route.kind}`);
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  },
  configEditor: {
    entries: () => [fakeEntry],
    configuration: () => [{ entry: fakeEntry, inherited: fakeInherited, override: fakeEntry.options.config }],
    async edit(entry, change) {
      // ★ 与内核 `dsh-config-editor/lib/index.js:78-80` 同形：current 与 inherited **都传**。
      const current = entry.options.config ?? {};
      const next = change(current, fakeInherited);
      editCount++;
      entry.options.config = next;
    },
  },
};
const handlers = new Map();
const ctx = {
  tools: services.tools,
  logger: { warn() {}, info() {}, error() {} },
  on(e, h) {
    if (!handlers.has(e)) handlers.set(e, []);
    handlers.get(e).push(h);
    return () => {};
  },
  inject(deps, cb) {
    for (const d of deps) if (!(d in services)) return undefined;
    const scope = Object.create(ctx);
    for (const d of deps) scope[d] = services[d];
    return cb(scope);
  },
  get: (k) => services[k],
};

mod.apply(ctx, {});
ok("插件注册了设置路由", routes.size >= 1, [...routes.keys()].join(", "));
const ROUTE = [...routes.keys()][0];

// ── 起真 HTTP 服务器：按 exact 匹配把请求转给那个 handler ────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const h = routes.get(url.pathname);
  if (h === undefined) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "no route" }));
    return;
  }
  // ★ 与内核一样的调用形态：handler 是 `handleFor(handler)` 包过的。
  const r = h(req, res);
  if (r && typeof r.catch === "function") r.catch(() => {});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;
console.log(`  （真服务器起在 ${BASE}，路由 ${ROUTE}）`);

try {
  // ① GET
  {
    const r = await fetch(BASE + ROUTE);
    const j = await r.json();
    ok("★ 真 HTTP：GET 状态 200", r.status === 200, String(r.status));
    ok("★ 真 HTTP：content-type 是 JSON", /application\/json/.test(r.headers.get("content-type") ?? ""), r.headers.get("content-type"));
    ok("★ 真 HTTP：cache-control 是 no-store", /no-store/.test(r.headers.get("cache-control") ?? ""), r.headers.get("cache-control"));
    // ★ 2026-10-10：加了 `mode`（两个模式）⇒ 12 项变 13 项。
    eq2("★ 真 HTTP：回报了十三项元数据（含模式与增量压缩）", j.specs?.length, 13);
    // ★★ 同样经真 HTTP 验一遍 `mode.options` 是**数组**：宿主那边它是取值函数
    //    （躲 TDZ），出站前没展开的话 JSON 会把它丢掉 ⇒ 面板上选择器是空的、
    //   而且**不报错**。自检里已有一条，这里再从 HTTP 这一层验一次。
    eq2(
      "★★ 真 HTTP：mode 的 options 是已展开的数组（不是被 JSON 丢掉的函数）",
      Array.isArray(j.specs?.find((s) => s.key === "mode")?.options),
      true
    );
    eq2("★ 真 HTTP：可写", j.writable, true);
    eq2("★ 真 HTTP：默认行数上限 300", j.defaults?.maxActiveLines, 300);
    eq2("★ 真 HTTP：默认变更登记条数 12", j.defaults?.changeRegisterMax, 12);
  }
  // ② POST 合法
  {
    fakeEntry.options.config = { keepMe: "x" };
    const r = await fetch(BASE + ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { turnEndOffer: true } }),
    });
    const j = await r.json();
    ok("★ 真 HTTP：POST 状态 200", r.status === 200, String(r.status));
    eq2("★ 真 HTTP：调了 configEditor.edit", editCount, 1);
    eq2("★ 真 HTTP：改到了那一行", fakeEntry.options.config.turnEndOffer, true);
    eq2("★★ 真 HTTP：别的字段没被抹掉", fakeEntry.options.config.keepMe, "x");
    eq2("★★★ 真 HTTP：上层的值**没被钉进** profile 层", fakeEntry.options.config.fromUpperLayer, undefined);
    eq2("★ 真 HTTP：回报生效值", j.settings?.turnEndOffer, true);
  }
  // ③ POST 非法 JSON ⇒ 400
  {
    const r = await fetch(BASE + ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ 坏 JSON",
    });
    ok("★ 真 HTTP：坏 JSON ⇒ 400", r.status === 400, String(r.status));
    eq2("★ 真 HTTP：坏 JSON 不落盘", editCount, 1);
  }
  // ④ 不存在的路径 ⇒ 404（确认这条路由是 exact 而不是吞掉一切）
  {
    const r = await fetch(BASE + "/dsh-ledger-memory-settings/nope.json");
    ok("★ 真 HTTP：邻近路径 404（exact 语义，不吞）", r.status === 404, String(r.status));
  }
} finally {
  server.close();
}

function eq2(label, a, b) {
  ok(label, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

console.log(`\n${fail === 0 ? "全部通过" : `失败 ${fail} 项`}`);
process.exit(fail === 0 ? 0 : 1);
