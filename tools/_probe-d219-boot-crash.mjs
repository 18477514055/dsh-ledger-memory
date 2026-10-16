// D219 · 崩溃归因的**独立复核** + 我们插件有没有「同一类」隐患
// ═══════════════════════════════════════════════════════════════════════════
// ★ 用户报「整机 web boot 崩溃」，已有他人写的根因记录（指向 persona-forge）。
//   本探针**不照抄那份结论**，而是自己取证两件事：
//     ① 崩溃日志里到底点名了谁（原文，不转述）；
//     ② **我们自己**的客户端 inject 是不是合法服务名 ——
//        ★ 因为 persona-forge 栽的正是"inject 写了页面侧不存在的服务名"，
//          而「别的插件有没有同类病」比「别人有没有病」更该查。
//
// ★ 判据（关键）：内核读的是 **bundle 实际 return 的 inject**，不是 package.json 的
//   `dsh.client.inject`（后者是包名空间，形状完全不同）。
//   所以要比对的是：`return { …, inject: [...] }` 里的字面量 ∈ 官方页面侧 provide 的服务名集合。
//
// 用法：node tools/_probe-d219-boot-crash.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

// ★ 隐私（D221）：**绝不把真实用户名写进 tools/**（它是 PUBLIC 的）。
//   路径按环境变量拼 ⇒ 任何人的机器上都能解析，且源码里没有本机专有信息。
const ASAR = path.join(
  process.env.LOCALAPPDATA ?? "",
  "Programs", "DeepSeek Harness", "resources", "app.asar"
);
const CRASH_DIR = path.join(process.env.APPDATA ?? "", "@deepseek-ai", "dsh-desktop", "logs");
const OUR_CLIENT = path.join(process.cwd(), "lib", "client.js");

// ── ① 崩溃日志原文（若存在）─────────────────────────────────────────────────
console.log("═══ ① 崩溃日志原文（今天那两份）═══");
let crashNamed = new Set();
if (fs.existsSync(CRASH_DIR)) {
  const logs = fs
    .readdirSync(CRASH_DIR)
    .filter((n) => n.startsWith("crash-") && n.includes("web-boot"))
    .sort()
    .slice(-3);
  for (const n of logs) {
    const t = fs.readFileSync(path.join(CRASH_DIR, n), "utf8");
    const m = /Error: web boot: (\d+) entry did not activate\n([\s\S]*?)(?:\n\n|$)/.exec(t);
    console.log(`\n  ── ${n} ──`);
    if (m) {
      console.log(`     ${m[0].split("\n").slice(0, 3).join("\n     ")}`);
      // 收集被点名的 entry（形如 `name: pending (waiting for service: X)`）
      for (const line of m[2].split("\n")) {
        const e = /^\s*([\w@/.-]+):\s*pending\s*\(waiting for service:\s*([\w.-]+)\)/.exec(line);
        if (e) crashNamed.add(`${e[1]}  →  缺服务 ${e[2]}`);
      }
    } else {
      console.log("     （没有 web boot 失败行）");
    }
  }
} else {
  console.log("  （找不到崩溃日志目录）");
}
console.log(`\n  ★ 被点名的插件：${crashNamed.size === 0 ? "（无）" : [...crashNamed].join(" ; ")}`);

// ── ② 官方页面侧 provide 的服务名全集（正向对照）────────────────────────────
//
// ★ 为什么要"从 app.asar 抽全部官方客户端包再扫 provide"：
//   不这么做就只能靠猜 —— 而猜错服务名的代价是**整机前端起不来**。
console.log("\n═══ ② 官方页面侧 provide 的服务名全集 ═══");
const fd = fs.openSync(ASAR, "r");
let services = new Set();
let scanned = 0;
try {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  const tree = JSON.parse(jsonBuf.toString("utf8"));

  const files = [];
  const walk = (node, p) => {
    for (const [name, v] of Object.entries(node.files ?? {})) {
      const full = `${p}/${name}`;
      if (v.files) walk(v, full);
      else files.push({ full, node: v });
    }
  };
  walk(tree, "dsh");

  const readEntry = (node) => {
    if (node.offset === undefined) return null;
    const off = 16 + jsonLen + Number(node.offset);
    const buf = Buffer.alloc(Number(node.size));
    fs.readSync(fd, buf, 0, buf.length, off);
    return buf.toString("utf8");
  };

  for (const f of files) {
    if (!/\.(?:js|mjs|cjs)$/.test(f.full)) continue;
    const text = readEntry(f.node);
    if (text === null) continue;
    scanned += 1;
    // provide('x') / provide("x") —— 官方页面侧注册服务的地方
    for (const m of text.matchAll(/\bprovide\s*\(\s*['"]([\w@/.-]+)['"]/g)) services.add(m[1]);
  }
} finally {
  fs.closeSync(fd);
}
console.log(`  扫了 ${scanned} 个官方 js 文件 ⇒ 服务名 ${services.size} 个`);
console.log(`  ${[...services].sort().join(", ")}`);

// ── ③ ★★★ 我们插件：bundle 实际 return 的 inject 是不是合法服务名 ───────────
//
// ★★★★★ 2026-10-15 22:5x **判据错了一次，留档**：
//   本探针第一版**只扫 app.asar 里 `provide('x')` 的字符串字面量**，得出 26 个服务名，
//   然后报「我们的 `slots` 不存在 ⇒ 隐患」。★ 但**我们的插件此刻正在运行**
//   （它的面板就挂在界面上）⇒ 按纪律 7「结论与已手工验证的事实冲突时，先怀疑尺子」去查，
//   发现：**活内核自己的客户端服务目录里 `slots` 是真实服务**
//   （`cordis_inspect_query(platform:"client", provider:"Service")` 逐字返回
//     `key: "slots"` —— "cordis Service layer of the slot system"）。
//   ⇒ **错在取法**：`provide(...)` 不是注册客户服务的唯一形态，静态扫字面量**漏**了真源。
//   ⇒ 正解：**以活内核的服务目录为权威**（它是运行时的真值），静态扫描只能当粗筛。
//
// ⇒ 下面保留静态扫描（当作**粗筛/交叉参照**），但**结论以传入的权威服务名为准**。
const AUTHORITATIVE_SERVICES = (process.env.DSH_CLIENT_SERVICES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

console.log("\n═══ ③ 我们插件的客户端 inject 校验（本轮的**重点**）═══");
const ourSrc = fs.readFileSync(OUR_CLIENT, "utf8");
// 目标形状：`const inject = ["slots"];` 或 `inject: [...]`
const ourInjects = new Set();
for (const m of ourSrc.matchAll(/(?:const\s+inject\s*=\s*|inject\s*:\s*)\[([^\]]*)\]/g)) {
  for (const raw of m[1].split(",")) {
    const s = raw.trim().replace(/^["']|["']$/g, "");
    if (s !== "") ourInjects.add(s);
  }
}
// package.json 里声明的那一份（记录「内核不读它，但也要看清形状」）
const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
const declared = pkg.dsh?.client?.inject ?? [];

console.log(`  bundle 实际 return 的 inject：${ourInjects.size === 0 ? "（无）" : [...ourInjects].join(", ")}`);
console.log(`  package.json 声明的 inject ：${declared.join(", ")}`);

// 用**权威清单**判定（没有权威清单时才退回静态粗筛，并明确标注可信度）
const authoritative = AUTHORITATIVE_SERVICES.length > 0 ? new Set(AUTHORITATIVE_SERVICES) : services;
const usingAuth = AUTHORITATIVE_SERVICES.length > 0;
console.log(
  `  判定依据：${usingAuth ? "★ 活内核的客户端服务目录（权威，运行时真值）" : "⚠ 静态粗筛（app.asar 里 provide 的字面量）—— 只在拿不到活内核时才用"}` +
    ` ｜ 服务名 ${authoritative.size} 个`
);

let bad = 0;
for (const s of ourInjects) {
  const ok = authoritative.has(s);
  if (!ok) bad += 1;
  console.log(`    ${ok ? "✅" : "⛔"} 「${s}」${ok ? "是真实客户端服务" : "**不在服务目录里** ⇒ 会导致整机 web boot 失败！"}`);
}
if (ourInjects.size === 0) console.log("    ✅ 不 inject 任何服务 ⇒ 不可能因为服务名不存在而 pending");

// package.json 那一份只提示形状（内核不读它）——但若它与 bundle 一致且合法，更放心
console.log("\n  ★ 备注：内核读的是 **bundle return 的 inject**；package.json 的");
console.log("    `dsh.client.inject` 是**包名空间**，形状不同、也不被内核使用。");
console.log(`    我们写的是 ${JSON.stringify(declared)} —— 与 bundle 里的 ${JSON.stringify([...ourInjects])} 不同，`);
console.log("    ★ 但**不构成缺陷**（与 dsh-tavern 同一形态：它 package.json 写包名、bundle 返回真实服务名，照跑不误）。");

console.log("\n═══ 结论 ═══");
console.log(`  ① 崩溃日志点名：${[...crashNamed].join(" ; ") || "（未能从日志提取）"}`);
console.log(`  ② 我们插件的 inject 非法服务名数：**${bad}**`);
console.log(bad === 0 ? "  ⇒ ✅ 本次崩溃与我们无关，且我们**不存在**这一类隐患。" : "  ⇒ ⛔ 我们也有同类隐患，必须修！");
if (bad > 0) process.exitCode = 1;
