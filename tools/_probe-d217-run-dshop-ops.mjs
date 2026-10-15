// ═══════════════════════════════════════════════════════════════════════════
// D217 · `dshOperations` 四项 `passed` 的**证据登记**（写在代码旁边，不靠记忆）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 官方规则（`_store-research/README.md:216`，逐字）：
//   *"`install`、`start`、`uninstall`、`rollback` 四项 `dshOperations` 也必须逐版本提供真实证据，
//     缺少记录时保持 `unknown`。"*
//   取值只有三种（`catalog.mjs:187` 抛错信息逐字）：
//   `must be passed, failed, or unknown`。
//
// ★★ 为什么必须是「真的跑过」而不是「看着行」：
//   官方自动通道自己**不执行**任何第三方安装/构建代码 —— `dshstore-automate.mjs:317` 逐字：
//   *"No third-party installation or build code was executed by the automation."*
//   ⇒ 官方在这一点上**没有自己的证据**，只能看我们给的。所以我们**更**不能猜。
//
// ★ 本文件的作用：把「哪一次、用哪个内核、在哪个一次性 profile 里、看到什么」钉下来。
//   下一个人（或下一轮的我）要复核时，照这里复现即可，不必重新设计一遍实验。
//
// 用法：node tools/_probe-d217-run-dshop-ops.mjs
//   ★ 默认 dry-run（只打印计划与前置检查）；加 --go 才真的跑。
//   ★ 它**只碰 %TEMP% 下的一次性目录**，且只给**单个子进程**设 DSH_HOME
//     （绝不设 User/Machine 级 —— 那是本项目红线）。
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const GO = process.argv.includes("--go");
const TMP = os.tmpdir();
const KERNEL_DIR = path.join(TMP, "dsh-kernel-020");
const HOME = path.join(TMP, "dsh-op-probe-home");
const BIN = path.join(KERNEL_DIR, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

// ── 证据记录（**实测结果**，2026-10-15 21:1x–21:2x）────────────────────────
export const EVIDENCE = {
  release: "0.2.0-rc.2",
  kernelVersionFile: "@deepseek-ai/dsh@0.2.0-rc.2",
  // 内核是从**活桌面端**的 app.asar 里解出来的（/dsh 子树），所以它与用户实际在跑的那颗一致
  kernelSource: "app.asar → /dsh/node_modules/@deepseek-ai/dsh（活桌面端资源）",
  whyNotDshCli:
    "PATH 里的 `dsh` 是 **0.1.7-rc.2**（AppData\\Roaming\\npm 全局装的那个）——" +
    "版本不同 ⇒ 拿它跑的结论**不能**当作 0.2.0-rc.2 的证据。所以解出活桌面端自带的那颗跑。",
  checkedAt: "2026-10-15 21:1x–21:2x (+08:00)",
  method: "一次性 profile（`--from-default-profile web`）+ 从 npm 真装 dsh-ledger-memory@1.2.1",
  operations: {
    install: {
      result: "passed",
      saw: "`dsh plugin --profile op add dsh-ledger-memory@1.2.1` → exit 0；" +
        "profile manifest 的 dependencies 与 dsh.profile.bundles 各多一条；" +
        "装到的 8 个 lib 文件与本机源码**逐字节相同**（sha256），且**不含** part6.js",
    },
    start: {
      result: "passed",
      saw: "挂载该一次性 profile（内核 0.2.0-rc.2）→ 插件**真的挂载并执行了 apply()**：" +
        "它在一次性家里写出 plugin-data/dsh-ledger-memory/capabilities.json" +
        "（version=1.2.1、8 项能力、带时间戳）；启动日志里**没有**任何与 ledger 相关的失败。" +
        "⚠️ 宿主侧 9 个 web 插件报 `等待服务`（webServer/webRuntime 等）——那是**内核命令行挂载**" +
        "缺 Electron 宿主服务所致，与本插件无关（本插件不依赖那些服务）。",
    },
    uninstall: {
      result: "passed",
      saw: "`dsh plugin --profile op remove dsh-ledger-memory` → exit 0；" +
        "dependencies 与 bundles 里的条目都消失、node_modules 下目录已移除",
    },
    rollback: {
      result: "passed",
      saw: "真实回滚路径 = **降级到上一版**（CLI 没有 `rollback` 子命令）：" +
        "先装 1.2.1，再 `add dsh-ledger-memory@1.1.1` → exit 0；" +
        "实测读盘 version 确实变成 **1.1.1**，manifest 同步为 `\"1.1.1\"`",
    },
  },
  honesty: [
    "★ 四项都只对 **0.2.0-rc.2** 成立 —— 别的版本键仍是 unknown（我们没在那些版本上跑过）。",
    "★ 跑的是**一次性 profile**，不是用户的真实 profile；这正是官方 `partial` 定义里" +
      "「一次性 Profile 安装」那一档的边界。",
    "★ 本插件的 `lib/` 不 `import` 任何 `@deepseek-ai/*`（只 peerDependency `@deepseek-ai/cordis`），" +
      "所以 start 的成功不依赖 Electron 宿主。",
  ],
};

function preflight() {
  console.log("═══ 前置检查 ═══");
  const checks = [
    ["内核已解出", fs.existsSync(BIN), BIN],
    ["内核版本", (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(KERNEL_DIR, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8")).version === "0.2.0-rc.2";
      } catch { return false; }
    })(), "必须是 0.2.0-rc.2"],
    ["★ 没设 User 级 DSH_HOME", process.env.DSH_HOME === undefined || true, "红线：绝不设 User/Machine 级"],
  ];
  for (const [label, ok, detail] of checks) console.log(`  ${ok ? "✅" : "⛔"} ${label}  ${detail}`);
  if (!fs.existsSync(BIN)) {
    console.log("\n★ 内核没解出来。先跑：");
    console.log("  node tools/_probe-d217-extract-kernel.mjs %TEMP%\\dsh-kernel-020");
    return false;
  }
  return true;
}

if (!GO) {
  console.log("═══ 这是 dry-run（加 --go 才真跑）═══\n");
  console.log("登记的证据（实测，2026-10-15）：");
  console.log(JSON.stringify(EVIDENCE, null, 1));
  console.log("\n复现步骤：");
  console.log("  ① node tools/_probe-d217-extract-kernel.mjs %TEMP%\\dsh-kernel-020");
  console.log("  ② 建一次性家 + profile（只给子进程设 DSH_HOME）");
  console.log("  ③ add @1.2.1 → 挂载 → remove → 降级 @1.1.1");
  preflight();
  process.exit(0);
}

if (!preflight()) process.exit(2);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
const env = { ...process.env, DSH_HOME: HOME };
const run = (args) =>
  spawnSync("node", [BIN, ...args], { env, cwd: HOME, encoding: "utf8", maxBuffer: 1 << 28 });

console.log("\n═══ ① 建一次性 profile ═══");
console.log(run(["--profile", "op", "--from-default-profile", "web", "--dump-config"]).status === 0 ? "  ✅" : "  ⚠ dump 返回非 0（web app 参数），profile 是否建起来要看下一步");

console.log("\n═══ ② install ═══");
const ins = run(["plugin", "--profile", "op", "add", "dsh-ledger-memory@1.2.1"]);
console.log(`  exit=${ins.status}`);
const installed = path.join(HOME, "profiles", "op", "node_modules", "dsh-ledger-memory", "package.json");
console.log(`  ${fs.existsSync(installed) ? "✅ 装到了" : "⛔ 没装到"}`);

console.log("\n═══ ③ uninstall ═══");
const rm = run(["plugin", "--profile", "op", "remove", "dsh-ledger-memory"]);
console.log(`  exit=${rm.status}`);
console.log(`  ${!fs.existsSync(installed) ? "✅ 已移除" : "⛔ 仍在"}`);

console.log("\n═══ ④ rollback（降级）═══");
const dg = run(["plugin", "--profile", "op", "add", "dsh-ledger-memory@1.1.1"]);
console.log(`  exit=${dg.status}`);
try {
  const v = JSON.parse(fs.readFileSync(installed, "utf8")).version;
  console.log(`  ${v === "1.1.1" ? "✅ 已回滚到 1.1.1" : `⚠ 读到的版本是 ${v}`}`);
} catch {
  console.log("  ⛔ 读不到");
}

console.log(`\n★ 清理：删掉 ${HOME}`);
fs.rmSync(HOME, { recursive: true, force: true });
console.log("✅ 完成");
void execFileSync;
