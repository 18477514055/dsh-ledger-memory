#!/usr/bin/env node
// 公开库一键同步：把「按白名单构建的干净树」作为一个快照提交推到公开仓库。
//
//   node tools/public-sync.mjs                     # 预演：只构建+报告，不提交不推送
//   node tools/public-sync.mjs --apply             # 真做：构建 → 提交 → 闸门 → 推 origin/main
//   node tools/public-sync.mjs --apply --no-push   # 只提交到本地临时分支，不推送
//
// ★ 为什么不是「本地 main 直接 push」：本地历史里带着不能公开的提交内容，
//   推上去就永久在公网。所以公开库只接「干净树构成的快照提交」，其父 = 当前 origin/main
//   ⇒ 对公开库而言仍是**快进**（不是 force）。判据见 D393 / D391。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const GIT = "C:\\Program Files\\Git\\cmd\\git.exe";
const git = (cwd, ...a) =>
  execFileSync(GIT, a, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const gitRaw = (cwd, ...a) => execFileSync(GIT, a, { cwd, maxBuffer: 256 * 1024 * 1024 });

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const push = !args.includes("--no-push");

const originHead = git(repo, "rev-parse", "--short", "origin/main").trim();
console.log(`=== 公开库一键同步（${apply ? "真做" : "预演"}）===`);
console.log(`  origin/main 现在是 ${originHead}`);

// ① 构建干净树
const build = path.join(os.tmpdir(), `dsh-public-sync-${Date.now()}`);
console.log("  （下面先跑一遍清单判定）");
const judge = spawnSync(process.execPath, ["tools/public-tree.mjs", "--check"], {
  cwd: repo,
  encoding: "utf8",
});
process.stdout.write(judge.stdout.split("\n").slice(0, 10).join("\n") + "\n");
if (judge.status !== 0) {
  console.error(judge.stderr);
  process.exit(1);
}
const built = spawnSync(process.execPath, ["tools/public-tree.mjs", "--build", build], {
  cwd: repo,
  encoding: "utf8",
});
if (built.status !== 0) {
  console.error(built.stderr);
  process.exit(1);
}
const nFiles = Number((built.stdout.match(/写入\s+(\d+) 个文件/) ?? [])[1] ?? 0);
console.log(`  干净树：${build}（${nFiles} 个文件）`);
if (!nFiles) {
  console.error("构建出 0 个文件 —— 停下来，绝不拿空树去覆盖公开库。");
  process.exit(1);
}

if (!apply) {
  console.log("\n预演结束（没有提交、没有推送）。真做：加 --apply");
  process.exit(0);
}

// ② 在独立 worktree 里基于 origin/main 组装提交（不碰当前工作区）
const wt = path.join(os.tmpdir(), `dsh-public-wt-${Date.now()}`);
git(repo, "worktree", "add", "--detach", wt, "origin/main");
const cleanup = () => {
  try {
    git(repo, "worktree", "remove", "--force", wt);
    git(repo, "worktree", "prune");
  } catch {}
};
process.on("exit", cleanup);

// 清空工作区里的被跟踪文件，再把干净树铺进去
for (const p of git(wt, "ls-files", "-z").split("\0").filter(Boolean)) {
  try {
    fs.rmSync(path.join(wt, p), { force: true });
  } catch {}
}
for (const e of fs.readdirSync(build, { withFileTypes: true })) {
  fs.cpSync(path.join(build, e.name), path.join(wt, e.name), { recursive: true });
}
// ★ 必须带 -f：`git add -A` 会跳过被 .gitignore 命中的文件，而白名单里可能正好有
//   这类文件（实测两个 `*.legacy` 就这样静默丢了 ⇒ 干净树 733 个、提交树只有 731 个）。
//   这个 worktree 里只有刚铺进来的干净树，强制添加不会夹带别的东西。
git(wt, "add", "-A", "-f", "--", ".");
const stagedCount = git(wt, "ls-files", "-z").split("\0").filter(Boolean).length;
if (stagedCount !== nFiles) {
  console.error(`✗ 数量不符：构建 ${nFiles} 个，暂存 ${stagedCount} 个 —— 拒绝继续（会静默丢文件）。`);
  process.exit(1);
}
const staged = git(wt, "diff", "--cached", "--name-status").split("\n").filter(Boolean);
console.log(`\n=== 暂存差异（${staged.length} 行）===`);
for (const line of staged.slice(0, 12)) console.log(`  ${line}`);
if (staged.length > 12) console.log(`  …另有 ${staged.length - 12} 行`);

const msg = [
  `公开树同步（白名单 ${nFiles} 文件）`,
  "",
  `本地 HEAD: ${git(repo, "rev-parse", "--short", "HEAD").trim()}`,
  "由 tools/public-sync.mjs 按 .publicallow.json 构建；被内容判据挡下的文件不在树内。",
].join("\n");
git(wt, "commit", "-m", msg);
const newSha = git(wt, "rev-parse", "HEAD").trim();
console.log(`  新提交 ${newSha.slice(0, 7)}（父 = origin/main ${originHead}）`);

// ③ 闸门：推之前先扫这棵树（hook 里也会再扫一次）
const guard = spawnSync(process.execPath, ["tools/public-tree.mjs", "--guard", newSha], {
  cwd: repo,
  encoding: "utf8",
});
process.stdout.write((guard.stdout || "") + (guard.stderr || ""));
if (guard.status !== 0) {
  console.error("✗ 闸门没过，不推送。");
  process.exit(1);
}

if (!push) {
  console.log(`\n已提交但未推送（--no-push）。要推：git push origin ${newSha}:main`);
  process.exit(0);
}

// ④ 推送（公开库需要显式解锁）
console.log("\n=== 推送到 origin/main ===");
const p = spawnSync(GIT, ["push", "origin", `${newSha}:main`], {
  cwd: repo,
  encoding: "utf8",
  env: { ...process.env, DSH_ALLOW_PUBLIC_PUSH: "1" },
});
process.stdout.write((p.stdout || "") + (p.stderr || ""));
if (p.status !== 0) {
  console.error("✗ 推送失败（未重试 —— 失败也可能是服务端已生效，先用 git ls-remote 核对）");
  process.exit(p.status ?? 1);
}

// ⑤ 回读
git(repo, "fetch", "origin", "main");
const after = git(repo, "rev-parse", "--short", "origin/main").trim();
const want = newSha.slice(0, 7);
console.log(`\n=== 回读 ===`);
console.log(`  origin/main = ${after}（期望 ${want}） ${after === want ? "✓" : "✗"}`);
const diff = git(repo, "diff", "--stat", newSha, "origin/main").trim();
console.log(`  树上差异：${diff ? "有！\n" + diff : "无 ✓"}`);
