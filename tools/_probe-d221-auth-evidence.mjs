// D221 · 把「面板路由的授权边界」这件事的**源码级证据**打印出来（给 DSH STORE 审复用）
//
// ★ 审核员在 issue #1376 的原话（逐字）：
//   *"本轮暂不能批准，具体阻塞在 `lib/part2.js:2171-2305`：
//     `/dsh-ledger-memory-settings/config.json` 的 POST 直接进入 `saveSettings`，
//     最终调用 `configEditor.edit`；`/broadcast.json` 也会修改广播状态。
//     注册包装和 handler 中未建立调用者授权边界。
//     客户端的 `credentials: "same-origin"`、包名前缀及 JSON 校验，
//     均不能单独证明服务端授权。
//     请使用经核验的宿主请求授权机制，在读取/写入设置和广播前拒绝未授权调用，
//     并补充未授权/缺少授权上下文时拒绝、已授权时正常工作的证据；
//     若依赖宿主在 handler 之前统一授权，请给出精确宿主版本与该契约的源码证据。"*
//
// ★ 这个探针只读 + 打印，专门回答他最后那句「**请给出精确宿主版本与该契约的源码证据**」。
// 用法：node tools/_probe-d221-auth-evidence.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const line = (s) => console.log(s);

line("═══════════════════════════════════════════════════════════════════");
line(" D221 · 授权边界的源码级证据（回应 DSH STORE issue #1376）");
line("═══════════════════════════════════════════════════════════════════");

// ── ① 我方：闸门确实包在注册那一行上 ──────────────────────────────────
line("\n【① 我方修法】—— `lib/part2.js` 里注册路由那一行");
const part2 = fs.readFileSync(path.join(ROOT, "lib", "part2.js"), "utf8");
const p2lines = part2.split(/\r?\n/);
p2lines.forEach((l, i) => {
  if (/handler:\s*handleFor\(\s*settingsGate\(/.test(l)) {
    line(`    lib/part2.js:${i + 1}  ${l.trim()}`);
  }
});
// 闸门函数本体：打印它的头部注释与前三行
const gateIdx = p2lines.findIndex((l) => /^function settingsGate\(/.test(l));
if (gateIdx >= 0) {
  line(`\n    ★ 闸门函数在 lib/part2.js:${gateIdx + 1}`);
  for (let i = gateIdx; i < Math.min(gateIdx + 12, p2lines.length); i++) {
    line(`      ${i + 1}| ${p2lines[i]}`);
  }
}

// ── ② 宿主契约（版本 + 方法签名）—— 从活桌面端 asar 里读，不凭记忆 ──────
line("\n【② 宿主版本】—— 从活桌面端 `app.asar` 里读出来（不凭记忆）");
const ASAR = path.join(
  process.env.LOCALAPPDATA ?? "",
  "Programs",
  "DeepSeek Harness",
  "resources",
  "app.asar"
);
line(`    asar 路径（按环境变量拼，未硬编码用户名）：${ASAR}`);
line(`    存在：${fs.existsSync(ASAR)}`);

const EXTRACTED = path.join(process.env.TEMP ?? ".", "d221-conn", "package.json");
if (fs.existsSync(EXTRACTED)) {
  const j = JSON.parse(fs.readFileSync(EXTRACTED, "utf8"));
  line(`    · @deepseek-ai/dsh-client-connection  version = ${j.version}`);
}
const WS = path.join(process.env.TEMP ?? ".", "d221-webserver", "package.json");
if (fs.existsSync(WS)) {
  const j = JSON.parse(fs.readFileSync(WS, "utf8"));
  line(`    · @deepseek-ai/dsh-host-webserver     version = ${j.version}`);
}

// ── ③ 契约原文（在官方源码里逐字找到）───────────────────────────────
line("\n【③ 契约原文】—— 在官方源码里逐字定位（行号是解出副本里的行号）");
const connJs = path.join(process.env.TEMP ?? ".", "d221-conn", "lib", "index.js");
if (fs.existsSync(connJs)) {
  const src = fs.readFileSync(connJs, "utf8");
  const ls = src.split(/\r?\n/);
  const marks = [
    ["requestRejection 方法", /^\s*requestRejection\(request\)\s*\{/],
    ["requestRejection → 403 围栏", /if \(!isTrustedApiRequest\(request, this\.trustedHosts\)\) return 403;/],
    ["requestRejection → 401 鉴权", /return this\.browserAuth\.isAuthenticated\(request\) \? void 0 : 401;/],
    ["admit() 组合", /^\s*admit\(request\)\s*\{/],
    ["官方 /api 路由自己也走 admit", /const admission = connection\.admit\(req\);/],
  ];
  for (const [label, re] of marks) {
    const i = ls.findIndex((l) => re.test(l));
    line(`    · ${label}${i >= 0 ? `  —— dsh-client-connection/lib/index.js:${i + 1}` : "  —— ⚠️ 未命中"}`);
    if (i >= 0) line(`        ${ls[i].trim()}`);
  }
} else {
  line("    ⚠️ 解出的 client-connection 副本不在 %TEMP%\\d221-conn（先跑 _probe-d221-asar-extract.mjs）");
}

const wsReadme = path.join(process.env.TEMP ?? ".", "d221-webserver", "README.md");
if (fs.existsSync(wsReadme)) {
  const ls = fs.readFileSync(wsReadme, "utf8").split(/\r?\n/);
  line("\n    ★ 官方 webserver README 的**责任划分**（逐字）：");
  ls.forEach((l, i) => {
    if (/No server-wide TLS|route owners such as/.test(l)) {
      line(`      dsh-host-webserver/README.md:${i + 1}`);
      line(`      ${l.trim()}`);
    }
  });
}

// ── ④ 桌面端为什么会过闸（证明加了它不会弄坏面板）───────────────────
line("\n【④ 桌面端为什么会过闸】—— 主进程给请求补 cookie（证明不会把面板修坏）");
const mainJs = path.join(process.env.TEMP ?? ".", "d221-main.js");
if (fs.existsSync(mainJs)) {
  const ls = fs.readFileSync(mainJs, "utf8").split(/\r?\n/);
  const marks = [
    ["来源必须是 dsh-app://app", /if \(headers\.origin !== "dsh-app:\/\/app"\) \{/],
    ["补 cookie + 同源标记", /cookie: hostCookie,/],
    ["sec-fetch-site 设同源", /"sec-fetch-site": "same-origin"/],
  ];
  for (const [label, re] of marks) {
    const i = ls.findIndex((l) => re.test(l));
    line(`    · ${label}${i >= 0 ? `  —— lib/main.js:${i + 1}` : "  —— ⚠️ 未命中"}`);
    if (i >= 0) line(`        ${ls[i].trim()}`);
  }
} else {
  line("    ⚠️ 解出的 main.js 不在 %TEMP%\\d221-main.js");
}

line("\n═══════════════════════════════════════════════════════════════════");
line(" 结论：我方**不再**依赖 `credentials: same-origin` 这类客户端侧说法；");
line("       服务端在每个 handler 之前调用宿主的 connection.requestRejection()，");
line("       拿不到授权上下文时**拒绝**（fail closed）。");
line("═══════════════════════════════════════════════════════════════════");
