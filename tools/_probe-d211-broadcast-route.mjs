/**
 * 探针（D211 之三）—— **面板那颗按钮的 HTTP 路由真的能工作吗？**
 *
 * ★★★ 为什么必须单独验（纪律：**"文件存在/模块可解析"不构成"能用"的证据**）：
 *   我加了一条 `POST /<prefix>/broadcast.json`。上面那些探针都是**在进程内直接调函数**
 *   ——它们**绕过了 HTTP 层**。若路由其实没注册上，或 handler 签名不对，
 *   那些断言**照样全绿**，而真机上那颗按钮按下去**毫无反应**。
 *   ⇒ 所以这里走**真路由**（`webServer.register` 的 handler + 假 req/res）。
 *
 * 跑法：node tools/_probe-d211-broadcast-route.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "lib", "index.js");

const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "probe-d211c-home-"));
process.env.DSH_HOME = SANDBOX_HOME;

const routes = new Map();
const handlers = new Map();
const services = {
  webServer: {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  },
  configEditor: {
    entries: () => [],
    configuration: () => [],
  },
  /**
   * ★★★★★ 2026-10-16（D221）：**宿主请求授权上下文**。
   *
   * ★ 为什么必须补进夹具：D221 之后，**取不到 `connection` 的面板请求一律被拒**
   *   （fail closed —— 这正是审核员指出的那个毛病本身）。
   *   原夹具没有它 ⇒ 它模拟的是"宿主没给授权上下文"，与真实 Web 宿主不符
   *   （真实里 `dsh-client-connection` 一直在）⇒ 全绿就是假绿（纪律 8）。
   * ★ 形状照活内核 `cordis_inspect` 的真实契约：`requestRejection(req): 401|403|undefined`。
   */
  connection: {
    requestRejection: () => currentRejection,
  },
};
/** ★ 放行 = `undefined`；由下面那个专门的反向验证段改成 `401` 再改回来。 */
let currentRejection = undefined;
const ctx = {
  tools: { register: () => () => {} },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  on(ev, fn) {
    const l = handlers.get(ev) ?? [];
    l.push(fn);
    handlers.set(ev, l);
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

const m = await import(pathToFileURL(ENTRY).href);
try {
  m.apply(ctx, {});
} catch (e) {
  console.log("★ 探针没跑起来（apply 抛错）—— 夹具故障，不是结论：");
  console.log(String(e && e.stack ? e.stack : e));
  process.exit(2);
}

/** 打一条真路由（假 req/res，与自检 `callRoute` 同形状）。 */
async function call(pathName, method = "GET") {
  const h = routes.get(pathName);
  if (h === undefined) return { status: 0, body: undefined, missing: true };
  const chunks = [];
  const req = { method, on(ev, cb) { if (ev === "end") cb(); return req; }, destroy() {} };
  const res = {
    statusCode: 0,
    headers: null,
    writeHead(s, hh) { this.statusCode = s; this.headers = hh; },
    end(t) { chunks.push(t ?? ""); },
  };
  await h(req, res);
  const text = chunks.join("");
  let body;
  try { body = text === "" ? undefined : JSON.parse(text); } catch { body = undefined; }
  return { status: res.statusCode, body, raw: text };
}

const PREFIX = "/dsh-ledger-memory-settings";
console.log("════════ D211c 探针：面板「推送到所有对话」的 HTTP 路由 ════════");
console.log(`已注册的路由（${routes.size} 条）：${[...routes.keys()].join("  ")}\n`);

const r1 = await call(`${PREFIX}/broadcast.json`, "POST");
console.log("【POST /broadcast.json】");
console.log(`  HTTP ${r1.status}｜ok=${r1.body?.ok}｜seq=${r1.body?.seq}`);
console.log(`  回执文字：${String(r1.body?.text ?? "(无)").split("\n")[0]}`);

const r2 = await call(`${PREFIX}/broadcast.json`, "POST");
console.log(`\n  再按一次 ⇒ seq=${r2.body?.seq}（期望递增：${r1.body?.seq} → ${r2.body?.seq}）`);

const r3 = await call(`${PREFIX}/broadcast.json`, "GET");
console.log(`\n【GET /broadcast.json】（应当拒绝，只接受 POST）`);
console.log(`  HTTP ${r3.status}｜ok=${r3.body?.ok}｜error=${r3.body?.error}`);

const seqRoute = m.__test.settingsBroadcastSeqOf();
console.log(`\n  序号是否真的被推进了：settingsBroadcastSeqOf() = ${seqRoute}`);

// ★★★★★ D221：**未授权的 broadcast 必须被拒，且不许推进序号**。
//   审核员点名了这条路由：*"`/broadcast.json` 也会修改广播状态"*
//   ⇒ 只读断言证明不了它，必须真的打一条被拒的请求、再看序号有没有动。
console.log("\n【反向验证：把它当作未授权请求再打一次】");
const seqBeforeDenied = m.__test.settingsBroadcastSeqOf();
currentRejection = 401;
const denied = await call(`${PREFIX}/broadcast.json`, "POST");
const seqAfterDenied = m.__test.settingsBroadcastSeqOf();
console.log(`  未授权 POST ⇒ HTTP ${denied.status}｜ok=${denied.body?.ok}`);
console.log(`  序号：${seqBeforeDenied} → ${seqAfterDenied}`);
currentRejection = undefined;
const ok5 = denied.status === 401 && seqAfterDenied === seqBeforeDenied;

console.log("\n════════ 结论 ════════");
const ok1 = r1.status === 200 && r1.body?.ok === true && typeof r1.body?.seq === "number";
const ok2 = r2.body?.seq === r1.body?.seq + 1;
const ok3 = r3.status === 405 && r3.body?.ok === false;
const ok4 = seqRoute === r2.body?.seq;
console.log(`  ① 路由存在且 POST 成功 ......... ${ok1}`);
console.log(`  ② 每次按都递增（不是恒 1） ..... ${ok2}`);
console.log(`  ③ GET 被拒（405，不乱改状态）... ${ok3}`);
console.log(`  ④ 进程内序号 == 路由回报的序号 . ${ok4}`);
console.log(`  ⑤ 未授权 ⇒ 401 且序号不动 ...... ${ok5}（D221 授权边界）`);
console.log("");
if (ok1 && ok2 && ok3 && ok4 && ok5) {
  console.log("★★★ 按钮**端到端可用**：面板点一下 ⇒ 序号 +1 ⇒ 指纹变 ⇒ 每个对话下一步重注快照。");
  console.log("★★★ 且**只有已授权**的请求能推动它（D221：闸门包在路由外面）。");
} else {
  console.log("★★ 有环节没通 —— 见上面五条，别当成「按钮做好了」。");
  process.exitCode = 1;
}

fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
