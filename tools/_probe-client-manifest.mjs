/**
 * 探针：用**内核自己的解析算法**复算"平台能不能找到我们的客户端半边"。
 *
 * ★ 为什么不用 HTTP 打一下就好：本机那个 web 端口要鉴权（401），而且**跑着的内核
 *   还是改动前的构建**（profile 里的 bundle 列表在启动时读一次）——
 *   打端口只能测到旧状态。所以这里改测**确定性的那一半**：
 *   把 `dsh-client-modules/lib/index.js` 里那段解析逻辑**照抄**过来跑一遍。
 *
 *   这不是"猜平台会怎么做"，而是"平台的判据是什么，我们就按它验"：
 *     `dsh-client-modules/lib/index.js:713-719` 逐字：
 *       const decl = parseDshClient(packageName, dsh?.client);
 *       if (decl === undefined || decl.platform !== "web") return null;   // 不认
 *       const clientRel = clientExportOf(packageName, pkg.exports);
 *       if (clientRel === undefined) throw "…declares dsh.client but exports no ./client bundle";
 *       clientPath = join(dirname(pkgPath), clientRel);
 *   外加校验器本身（`:63-68`）：
 *       dsh.client 必须是对象、platform 必须是 string、
 *       inject/external 必须是字符串数组、immediately 必须是 boolean。
 *
 * 用法：node tools/_probe-client-manifest.mjs
 */
import fs from "node:fs";
import path from "node:path";

const PKG_DIR = path.resolve(import.meta.dirname, "..");

let fail = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond || detail === undefined ? "" : `\n        ${detail}`}`);
  if (!cond) fail++;
};

// ── ① 复刻 `parseDshClient` 的校验（内核 `:39-70`）────────────────────────
function optionalStringArray(pkgName, field, value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`client-modules: ${pkgName} ${field} must be a string array`);
  }
  return [...value];
}
function parseDshClient(pkgName, value) {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
  }
  if (typeof value.platform !== "string") {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
  }
  const inject = optionalStringArray(pkgName, "dsh.client.inject", value.inject);
  const external = optionalStringArray(pkgName, "dsh.client.external", value.external);
  if (value.immediately !== undefined && typeof value.immediately !== "boolean") {
    throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
  }
  return {
    platform: value.platform,
    ...(inject === undefined ? {} : { inject }),
    ...(external === undefined ? {} : { external }),
    ...(value.immediately === undefined ? {} : { immediately: value.immediately }),
  };
}

// ── ② 复刻 `clientExportOf`（从 `exports` 里找 `./client`）────────────────
function clientExportOf(pkgName, exports) {
  const entry = exports?.["./client"];
  if (entry === undefined) return undefined;
  if (typeof entry === "string") return entry;
  // 条件导出：取 default / import
  if (entry !== null && typeof entry === "object") {
    if (typeof entry.default === "string") return entry.default;
    if (typeof entry.import === "string") return entry.import;
  }
  return undefined;
}

console.log("═══ 复算：平台会不会认出本插件的客户端半边 ═══");
const pkgPath = path.join(PKG_DIR, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

let decl;
let threw;
try {
  decl = parseDshClient(pkg.name, pkg.dsh?.client);
} catch (e) {
  threw = e;
}
ok("dsh.client 通过内核的形状校验（:63-68）", threw === undefined, threw && threw.message);
ok("★ 声明了 dsh.client", decl !== undefined, JSON.stringify(pkg.dsh));
ok('★ platform === "web"（不是别的值就会被跳过）', decl?.platform === "web", decl?.platform);

const rel = clientExportOf(pkg.name, pkg.exports);
ok('★ exports 里有 "./client"', rel !== undefined, JSON.stringify(pkg.exports));
ok("★ 指向 lib/client.js", rel === "./lib/client.js", String(rel));

const clientPath = rel === undefined ? undefined : path.join(path.dirname(pkgPath), rel);
ok("★★ 解析出的 clientPath 真实存在（:723 join 之后要能读到）", clientPath !== undefined && fs.existsSync(clientPath), String(clientPath));

// ── ③ 内容层面的最低要求 ─────────────────────────────────────────────────
if (clientPath !== undefined && fs.existsSync(clientPath)) {
  const src = fs.readFileSync(clientPath, "utf8");
  ok("★ 不是空文件", src.length > 1000, `${src.length} 字节`);
  ok("★★ 用平台的 __ModuleLoader__.load 注册（内核 `:69` 的惰性 CJS 协议）", src.includes("window.__ModuleLoader__.load("));
  ok("★ 注册 id 是包名", src.includes(`id: "${pkg.name}"`));
  ok("★ 没有顶层 export（那不是经典脚本）", !/^\s*export\s/m.test(src));
  ok("★ 没有顶层 import", !/^\s*import\s/m.test(src));
  // 它只 require 平台基座里的词
  const reqs = new Set([...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]));
  ok("★ 只 require 平台基座里的词（react）", [...reqs].every((r) => r === "react"), [...reqs].join(", "));
}

// ── ④ 与另两个已知能工作的客户端插件对比（证明尺子对）──────────────────
console.log("\n═══ 尺子校验：同样复算另两个**已在跑**的客户端插件 ═══");
for (const other of [
  // ★ 这两个是"本机另外两个已在跑的客户端插件"，用作**尺子校验**（证明本探针的复算算法对）。
  //   它们是**本机布局**，不是本插件的约定 ⇒ 公开仓库里换成可配置的下拉：
  //   设 DSH_LIBLIBAI_DIR / DSH_DSHMARKET_DIR，或让脚本自己找 profile 下的 node_modules。
  process.env.DSH_LIBLIBAI_DIR ?? path.join(path.resolve(import.meta.dirname, "..", ".."), "9.liblibai"),
  process.env.DSH_DSHMARKET_DIR ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "profiles", "desktop", "node_modules", "dshmarket"),
]) {
  const p = path.join(other, "package.json");
  if (!fs.existsSync(p)) {
    console.log(`  SKIP  ${other}（不存在）`);
    continue;
  }
  const o = JSON.parse(fs.readFileSync(p, "utf8"));
  let d;
  try {
    d = parseDshClient(o.name, o.dsh?.client);
  } catch (e) {
    console.log(`  FAIL  ${o.name}: ${e.message}`);
    fail++;
    continue;
  }
  const orel = clientExportOf(o.name, o.exports);
  const opath = orel === undefined ? undefined : path.join(path.dirname(p), orel);
  const exists = opath !== undefined && fs.existsSync(opath);
  console.log(`  ${d?.platform === "web" && exists ? "PASS" : "FAIL"}  ${o.name}  platform=${d?.platform}  client=${orel}  exists=${exists}`);
  if (!(d?.platform === "web" && exists)) fail++;
}

console.log(`\n${fail === 0 ? "全部通过" : `失败 ${fail} 项`}`);
process.exit(fail === 0 ? 0 : 1);
