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
/** ★ D221：数口径时必须看**整个 `lib/`**（拆分后 `SETTING_SPECS` 住在 `defs.js`）。 */
const LIB_DIR = path.join(path.resolve(import.meta.dirname, ".."), "lib");
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
  /**
   * ★★★★★ 2026-10-16（D221）：**宿主请求授权上下文**。
   *
   * ★ 为什么必须补进夹具（这不是为了"让测试变绿"）：
   *   原来这个夹具**没有** `connection` —— 它模拟的正是"宿主没提供授权上下文"
   *   那个情形。而 D221 之后那种情形**必须被拒**（fail closed）
   *   ⇒ 夹具的前提与真实产品环境不符，全绿就是假绿（纪律 8）。
   *   ★ 真实 Web 宿主里 `connection` **一直在**（`dsh-client-connection` 是官方
   *     Web 组合的固定成员）⇒ 夹具必须按真实形态补上它。
   *
   * ★ 形状照活内核 `cordis_inspect` 给出的真实契约：
   *   `requestRejection(request): 401 | 403 | undefined`
   *   —— 逐字 *"Apply Connection's Host/Origin checks and browser authentication
   *      to another Web route."*
   */
  connection: {
    /** 由每个用例改这个变量，模拟"放行 / 401 / 403"。 */
    requestRejection: () => currentRejection,
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
/** ★ 当前这一次请求的授权判定结果（`undefined` = 放行）。 */
let currentRejection = undefined;
/** ★ 闸门被调用过几次（断言"真的走了闸门"）。 */
let rejectionCalls = 0;
services.connection.requestRejection = () => {
  rejectionCalls += 1;
  return currentRejection;
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
    // ★★★ 2026-10-12（D124）：这条断言原来**写死 13** —— D115 加 deltaFallbackPoints 之后
    //   实际已是 **14**，而它没人同步 ⇒ **这条探针漂了很久没人发现**（自检全绿）。
    //   ⇒ 根治：**从宿主源码数**（与情形 43 那条口径断言同一个做法），不写死。
    //     ★ 这样以后加/删设置项**不必改这里**，它自己会跟上。
    //   ★★ 这是 D122 那条教训的**第三处实例**（前两处：台账 §7 表、头部 D 范围）：
    //      「把期望值写死在别处」⇒ 数字漂了没人管。**凡口径必有单一真源。**
    //
    // ★★★★★ 2026-10-16（D221）就地修：**这行原来读的是 `lib/index.js` 一个文件** ——
    //   而 D216/D217 拆分之后 `SETTING_SPECS` 住在 **`lib/defs.js`** 里
    //   ⇒ 它数出来恒为 **0**，这条断言**自拆分起就一直失败**（而自检全绿，没人看见）。
    //   ★ 修法与自检 `readLibSource()` 同口径：**整个 `lib/` 按文件名排序拼接** ——
    //     拆成几个文件都看得见（本项目纪律：判据的输入必须是"被测对象自己产生的那部分"）。
    const libNames = fs.readdirSync(LIB_DIR).filter((n) => n.endsWith(".js")).sort();
    const libSrcForCount = libNames.map((n) => fs.readFileSync(path.join(LIB_DIR, n), "utf8")).join("\n");
    const ssStart = libSrcForCount.indexOf("const SETTING_SPECS = [");
    const ssEnd = libSrcForCount.indexOf("\\n];", ssStart);
    const settingKeyCount = [
      ...libSrcForCount
        .slice(ssStart, ssEnd < 0 ? ssStart + 40000 : ssEnd)
        .matchAll(/\n\s{2}\{\s*\n\s{4}key:\s*"([A-Za-z]+)"/g),
    ].length;
    eq2(
      "★ 真 HTTP：回报的设置项数量 = 宿主实际声明的 " + settingKeyCount + " 项（从源码数，不写死）",
      j.specs?.length,
      settingKeyCount
    );
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

  // ⑤ ★★★★★ D221：**真 HTTP 层的授权边界**（DSH STORE 审核员指出的唯一阻塞）
  //
  //   ★ 为什么这一节必须走**真 HTTP**而不是进程内调 handler：
  //     审核员的原话是 *"`/dsh-ledger-memory-settings/config.json` 的 POST 直接进入
  //     `saveSettings` … 注册包装和 handler 中未建立调用者授权边界"* ——
  //     他点的是**这条 HTTP 路由本身**。进程内直接调业务函数**绕过它**，
  //     照样全绿（本项目纪律：**"文件存在/函数能跑"不构成"路由受保护"的证据**）。
  {
    const before = rejectionCalls;
    // ⑤-a 未授权 GET ⇒ 401，且**拿不到**设置
    currentRejection = 401;
    {
      const r = await fetch(BASE + ROUTE);
      const j = await r.json().catch(() => ({}));
      ok("★★★★★ 真 HTTP：未授权 GET ⇒ 401", r.status === 401, String(r.status));
      ok("★★★★★ 真 HTTP：且**拿不到设置正文**", j.settings === undefined, JSON.stringify(j).slice(0, 160));
    }
    // ⑤-b 跨站/非同源 ⇒ 403（原样透传，不是一律 401）
    currentRejection = 403;
    {
      const r = await fetch(BASE + ROUTE);
      ok("★★★★ 真 HTTP：非同源 ⇒ 403", r.status === 403, String(r.status));
    }
    // ⑤-c 未授权 POST ⇒ 401，且**一个字都没落盘**
    currentRejection = 401;
    {
      const editsBefore = editCount;
      const r = await fetch(BASE + ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: { turnEndOffer: false } }),
      });
      ok("★★★★★ 真 HTTP：未授权 POST ⇒ 401", r.status === 401, String(r.status));
      eq2("★★★★★ 真 HTTP：且**一个字都没落盘**", editCount, editsBefore);
    }
    // ⑤-d 放行路径仍然可用（别把面板修坏）
    currentRejection = undefined;
    {
      const r = await fetch(BASE + ROUTE);
      const j = await r.json().catch(() => ({}));
      ok("★★★★★ 真 HTTP：授权通过 ⇒ 照常 200（闸门没把面板修坏）", r.status === 200, String(r.status));
      ok("★★★★ 真 HTTP：且设置真的送出来了", j.settings !== undefined, JSON.stringify(j).slice(0, 120));
    }
    ok(
      "★★★ 真 HTTP：这几轮**真的都过了闸门**（不是碰巧没走它）",
      // ★ ⑤ 这一节共 4 次请求（401 GET / 403 GET / 401 POST / 放行 GET）
      //   ⇒ 闸门至少要被调用 4 次。写 ≥4 而不是"等于 4"，是为了以后再加用例时
      //     这条**只变宽不变脆**（写死上限会在加用例时假红，那正是上面那条踩过的坑）。
      rejectionCalls - before >= 4,
      `闸门调用次数增量 = ${rejectionCalls - before}（期望 ≥ 4）`
    );
  }
} finally {
  server.close();
}

function eq2(label, a, b) {
  ok(label, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

console.log(`\n${fail === 0 ? "全部通过" : `失败 ${fail} 项`}`);
process.exit(fail === 0 ? 0 : 1);
