#!/usr/bin/env node
/**
 * 安装本地 Git 钩子与默认推送目标（D315 · F-07①）。
 *
 * ★ 为什么需要它：`.git/hooks/*` **不会随仓库分发** —— 从远端 clone 出来的环境里没有它，
 *   而反向探针（以及"改动的第一道闸"）都依赖它存在。
 *   ⇒ 钩子模板入库（`tools/pre-push.hook.sh`），这里负责安装。
 *
 * 做的事（**幂等**，跑几次都一样）：
 *   ① `remote.pushDefault = private`（若 private 远端存在）
 *   ② 把 `tools/pre-push.hook.sh` 拷到 `.git/hooks/pre-push` 并置可执行位
 *   ③ 如实报告每一步的结果（不静默）
 *
 * 用法：node tools/install-hooks.mjs [--check]
 *   `--check` 只检查不安装（退出码 0 = 都装好了；1 = 有缺）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_ONLY = process.argv.includes("--check");
const GIT = "git";

function run(args, cwd = ROOT) {
  try {
    return { ok: true, out: execFileSync(GIT, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e) {
    return { ok: false, out: ((e.stderr ?? "") + (e.stdout ?? "")).toString().trim() };
  }
}

const hasGit = fs.existsSync(path.join(ROOT, ".git"));
if (!hasGit) {
  console.log("这个目录不是 git 仓库（或没有 .git）⇒ 无需安装钩子。");
  process.exit(CHECK_ONLY ? 0 : 0);
}

const template = path.join(ROOT, "tools", "pre-push.hook.sh");
const hookAbs = path.join(ROOT, ".git", "hooks", "pre-push");
let problems = 0;

// ① pushDefault
const remotes = run(["remote"]);
const hasPrivate = remotes.ok && remotes.out.split("\n").some((l) => l.trim() === "private");
const pd = run(["config", "--get", "remote.pushDefault"]);
if (!hasPrivate) {
  console.log("= 没有 `private` 远端 ⇒ 跳过 pushDefault（本仓库未启用发布分级）");
} else if (pd.out === "private") {
  console.log("✓ remote.pushDefault = private");
} else if (CHECK_ONLY) {
  console.log(`✗ remote.pushDefault = ${pd.out || "(未设)"}，应为 private`);
  problems++;
} else {
  run(["config", "remote.pushDefault", "private"]);
  console.log("+ 已设置 remote.pushDefault = private");
}

// ② 钩子
if (!fs.existsSync(template)) {
  console.log(`✗ 钩子模板不存在：${template}`);
  problems++;
} else if (fs.existsSync(hookAbs)) {
  const same = fs.readFileSync(hookAbs, "utf8") === fs.readFileSync(template, "utf8");
  console.log(same ? "✓ .git/hooks/pre-push 与模板一致" : "= .git/hooks/pre-push 存在但内容与模板不同（保留现有，不动它）");
} else if (CHECK_ONLY) {
  console.log("✗ .git/hooks/pre-push 不存在");
  problems++;
} else {
  fs.mkdirSync(path.dirname(hookAbs), { recursive: true });
  fs.copyFileSync(template, hookAbs);
  try { fs.chmodSync(hookAbs, 0o755); } catch { /* Windows 上无意义 */ }
  console.log("+ 已安装 .git/hooks/pre-push");
}

if (CHECK_ONLY) {
  console.log(problems === 0 ? "\n检查结果：都已就绪。" : `\n检查结果：${problems} 项缺失（跑 node tools/install-hooks.mjs 安装）。`);
  process.exit(problems === 0 ? 0 : 1);
}
