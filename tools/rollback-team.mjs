#!/usr/bin/env node
/**
 * ★★★★★ 一键回滚 —— 把项目恢复到「团队功能开工前」的状态。
 *
 * ★ 为什么必须有它（用户 2026-10-19 亲口要求）：
 *   "这次是一次机制大改，要保证他们能够正常回滚，同时把我们整个项目进行备份。"
 *   ⇒ **备份不算数，能回滚才算数。** 本项目纪律：回滚方案必须被真实验证过。
 *
 * ★ 两道保险，任选其一：
 *   ① **--from-backup** 从逐字节备份目录整棵覆盖回来（最彻底，连未跟踪文件一起）
 *   ② **--from-tag**    用 git 把跟踪文件退回到 `backup-before-team-l1` 标签
 *
 * ★★ 默认 **只做 dry-run**（列出会动什么，不写任何文件）。要真回滚必须显式 `--apply`。
 *    这与本项目 `ledger_conform` / `ledger_migrate` 的一贯做法一致：
 *    **会改动别人项目/工作区的动作，必须先给人看清再动手。**
 *
 * 用法：
 *   node tools/rollback-team.mjs                         # 看看会动什么（安全）
 *   node tools/rollback-team.mjs --from-backup --apply   # 从备份整棵恢复
 *   node tools/rollback-team.mjs --from-tag --apply      # 从 git tag 恢复
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __DIR = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__DIR, "..");
const BACKUP_DIR =
  process.env.ROLLBACK_BACKUP ??
  "D:/Deepseek工作区/20-DSH插件/04-其余插件/_备份-项目台账-20261019-213417";
const TAG = "backup-before-team-l1";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const fromBackup = argv.includes("--from-backup");
const fromTag = argv.includes("--from-tag");

if (!fromBackup && !fromTag) {
  console.log("请指定恢复来源之一：");
  console.log("  --from-backup   从备份目录整棵恢复：" + BACKUP_DIR);
  console.log("  --from-tag      从 git 标签恢复：" + TAG);
  console.log("\n（现在是 dry-run 模式，加 --apply 才真的写）");
  process.exit(2);
}

/**
 * ★★ 绝不动 `.git/` —— 它由 `--from-tag` 那条路管，用文件覆盖去改 git 内部
 *    会把仓库搞成半坏状态（index / objects 对不上）。
 */
const SKIP_TOP = new Set([".git", "node_modules"]);

function walk(d, base, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    const rel = path.relative(base, p);
    if (e.isDirectory()) {
      if (path.dirname(rel) === "." && SKIP_TOP.has(e.name)) continue;
      walk(p, base, out);
    } else out.push(rel);
  }
  return out;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// ── 方式 ②：git tag ────────────────────────────────────────────────────────
if (fromTag) {
  const st = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
  console.log("当前工作区改动行数：" + (st === "" ? 0 : st.split("\n").length));
  console.log("\n将会执行（--apply 时）：");
  console.log("  git checkout " + TAG + " -- lib tools");
  console.log("  git reset                # 把恢复出来的内容留在工作区，不自动提交");
  console.log("\n★ 注意：git 只恢复**已跟踪**文件；新增的未跟踪文件不会被动。");
  if (!apply) {
    console.log("\n[dry-run] 没有写任何东西。加 --apply 执行。");
    process.exit(0);
  }
  execFileSync("git", ["checkout", TAG, "--", "lib", "tools"], { cwd: ROOT, stdio: "inherit" });
  execFileSync("git", ["reset"], { cwd: ROOT, stdio: "inherit" });
  console.log("\n✅ 已从 tag " + TAG + " 恢复 lib/ 与 tools/");
  process.exit(0);
}

// ── 方式 ①：备份目录 ───────────────────────────────────────────────────────
if (!fs.existsSync(BACKUP_DIR)) {
  console.error("✗ 备份目录不存在：" + BACKUP_DIR);
  console.error("  用 ROLLBACK_BACKUP=<路径> 指定别的备份。");
  process.exit(1);
}

const srcFiles = walk(BACKUP_DIR, BACKUP_DIR).sort();
console.log("备份目录：" + BACKUP_DIR);
console.log("备份内文件数：" + srcFiles.length);

// 先核对：备份与当前磁盘，哪些文件**不一样**（这就是回滚要动的范围）
const differ = [];
const missing = [];
for (const rel of srcFiles) {
  const dst = path.join(ROOT, rel);
  if (!fs.existsSync(dst)) {
    missing.push(rel);
    continue;
  }
  if (sha256(dst) !== sha256(path.join(BACKUP_DIR, rel))) differ.push(rel);
}

// 当前有、备份里没有的（= 本轮新产生的文件，回滚时应当移除才能"干净回去"）
const curFiles = walk(ROOT, ROOT).sort();
const extra = curFiles.filter((f) => !srcFiles.includes(f));

console.log("\n需要覆盖（内容不同）：" + differ.length);
differ.slice(0, 25).forEach((f) => console.log("  ~ " + f));
if (differ.length > 25) console.log("  …共 " + differ.length + " 个");

console.log("\n备份有、当前缺（需要补回）：" + missing.length);
missing.slice(0, 25).forEach((f) => console.log("  + " + f));
if (missing.length > 25) console.log("  …共 " + missing.length + " 个");

console.log("\n本轮新增、备份里没有（回滚时会被移走）：" + extra.length);
extra.slice(0, 25).forEach((f) => console.log("  - " + f));
if (extra.length > 25) console.log("  …共 " + extra.length + " 个");

if (!apply) {
  console.log("\n[dry-run] 没有写任何东西。加 --apply 执行（会先再存一份「回滚前快照」）。");
  process.exit(0);
}

// 真回滚前，先把**当前状态**再存一份 —— 回滚本身也可能是误操作
const preDir = path.join(ROOT, "..", `_回滚前快照-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(preDir, { recursive: true });
for (const rel of curFiles) {
  const dst = path.join(preDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), dst);
}
console.log("\n已先把当前状态存到：" + preDir);

for (const rel of extra) {
  try {
    fs.unlinkSync(path.join(ROOT, rel));
    console.log("  - " + rel);
  } catch (e) {
    console.log("  ! 删不掉 " + rel + "：" + e.message);
  }
}
for (const rel of srcFiles) {
  const dst = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(BACKUP_DIR, rel), dst);
}
console.log("\n✅ 已从备份整棵恢复（" + srcFiles.length + " 个文件）");
