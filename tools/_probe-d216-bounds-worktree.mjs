// ═══════════════════════════════════════════════════════════════════════════
// D216 · 量**工作区**（而不是 git ref）的官方包面 —— 拆分后必须真量它
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么需要这个变体（`_probe-d213-store-bounds.mjs` 不够用）：
//   那个探针量的是 **git ref**（HEAD / 某个 commit）。而**拆分刚做完时，改动还在工作区、
//   没 commit** ⇒ 量 HEAD 得到的是**旧版**（851635 B 那个）⇒ **会误报"仍然超限"**。
//   ★ 而真要发布的是**工作区的内容**（打包时 `npm pack` 读的就是它）。
//   ⇒ 判据必须能量工作区；这个探针就是补上那一半。
//
// ★ 关键：**仍然调官方那个函数**（`packageSourceSurface`），不许自己重写口径
//   —— 那条纪律在 `_probe-d213-store-bounds.mjs` 顶部已经写明（我手搓过两次、两次量错）。
//
// 跑法：node tools/_probe-d216-bounds-worktree.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { packageSourceSurface, SCANNABLE_SOURCE } from "../_store-research/package-source-surface.mjs";

const REPO = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const POLICY = path.join(REPO, "_store-research", "automation-policy.json");
const bounds = JSON.parse(fs.readFileSync(POLICY, "utf8")).sourceBounds;

/** 走**工作区**（不跟随联接 —— 用 lstatSync），喂成官方要的形状。 */
function treeOfWorktree() {
  const tree = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      // ★ 跳过 `.git`（官方也只认 files 白名单里的，但 .git 里文件极多，先省掉）
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      const st = fs.lstatSync(p);
      const rel = path.relative(REPO, p).split(path.sep).join("/");
      if (st.isSymbolicLink()) continue; // 联接不跟随（AGENTS.md §七）
      if (st.isDirectory()) {
        tree.push({ mode: "40000", type: "tree", sha: "", size: 0, path: rel });
        walk(p);
      } else if (st.isFile()) {
        tree.push({ mode: "100644", type: "blob", sha: "", size: st.size, path: rel });
      }
    }
  };
  walk(REPO);
  return { tree, truncated: false };
}

const tree = treeOfWorktree();
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const surface = packageSourceSurface(manifest, tree, "");
const runtimeFiles = surface.entries.filter(
  (it) => it.type === "blob" && it.mode !== "120000" && SCANNABLE_SOURCE.test(it.relativePath)
);
const sizes = runtimeFiles.map((it) => it.size);
const total = sizes.reduce((a, b) => a + b, 0);
const largest = Math.max(0, ...sizes);

console.log("──── 工作区（**这才是要发布的东西**）────");
console.log(`  files 白名单      = ${JSON.stringify(manifest.files)}`);
console.log(`  包面条目数        = ${surface.entries.length}   （上限 ${bounds.maxTreeEntries}）`);
console.log(`  可扫源码文件数    = ${runtimeFiles.length}   （上限 ${bounds.maxRuntimeFiles}）`);
console.log(`  可扫源码合计      = ${total} B   （上限 ${bounds.maxTotalRuntimeBytes}）`);
console.log(`  最大单文件        = ${largest} B   （上限 ${bounds.maxFileBytes}）`);
console.log("  逐条：");
for (const it of runtimeFiles.sort((a, b) => b.size - a.size)) {
  const flag = it.size > bounds.maxFileBytes ? "  ⛔ 超单文件上限" : "";
  console.log(`      ${String(it.size).padStart(8)} B  ${it.relativePath}${flag}`);
}

const bad = [];
if (largest > bounds.maxFileBytes) bad.push(`单文件超限（${largest} > ${bounds.maxFileBytes}）`);
if (runtimeFiles.length > bounds.maxRuntimeFiles) bad.push(`文件数超限`);
if (total > bounds.maxTotalRuntimeBytes) bad.push(`总量超限`);
if (surface.entries.length > bounds.maxTreeEntries) bad.push(`条目数超限`);

console.log("");
if (bad.length === 0) {
  console.log("✅ 四条上限**全部通过** ⇒ ②（largest file）已解掉。");
} else {
  console.log(`⛔ 仍卡在：${bad.join(" / ")}`);
  process.exitCode = 1;
}

// 顺带把"拆分后的 lib 清单"列出来（给人看模块数）
const libFiles = fs
  .readdirSync(path.join(REPO, "lib"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ f, size: fs.statSync(path.join(REPO, "lib", f)).size }))
  .sort((a, b) => b.size - a.size);
console.log(`\nlib/ 共 ${libFiles.length} 个 .js：`);
for (const x of libFiles) console.log(`  ${String(x.size).padStart(8)} B  lib/${x.f}`);
