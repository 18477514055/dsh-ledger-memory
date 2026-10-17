/**
 * 探针（D213 修正）—— **用官方自己的函数量我们的包面**。
 *
 * ★ 为什么必须用官方函数：我手搓过两次 glob，**两次都量错了集合**：
 *   ① 第一次量**工作目录**（把被 .gitignore 的 `_ledger-archive`/`_ledger-log` 也算进去）；
 *   ② 第二次量**被 git 跟踪的整棵树**（把 `tools/` 147 个探针也算进去）。
 *   ★★ 官方真正的口径是 `packageSourceSurface(manifest, tree)` 的 **`surface.entries`**
 *      —— 它**只取 `package.json` 的 `files` 白名单内的文件**（现在 = lib + cordis.patch.yml + README.md）。
 *   ⇒ **判据要直接调官方那个函数**，不许自己重写一遍"我以为的口径"。
 *
 * ★ 本探针**自带一次尺子校验**：拿 commit `81ff044`（官方 statusReason 里那个）复算，
 *   必须得到 **950,915 / 528,066** 两个数与官方原文**逐位相同** —— 不一致就说明我连函数都调错了。
 *
 * 跑法：node tools/_probe-d213-store-bounds.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { packageSourceSurface, SCANNABLE_SOURCE } from "../_store-research/package-source-surface.mjs";

const REPO = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const POLICY = path.join(REPO, "_store-research", "automation-policy.json");
const bounds = JSON.parse(fs.readFileSync(POLICY, "utf8")).sourceBounds;

/** 把某个 git ref 的树，喂成官方要的形状：{ tree: [{path,type,mode,size}], truncated: false } */
function treeOf(ref) {
  // git ls-tree -r -l <ref>  →  "<mode> <type> <sha> <size>\t<path>"
  const out = execFileSync("git", ["ls-tree", "-r", "-l", ref], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });
  const tree = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const m = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\s+(-|\d+)\t(.*)$/.exec(line);
    if (m === null) continue;
    tree.push({ mode: m[1], type: m[2], sha: m[3], size: m[4] === "-" ? 0 : Number(m[4]), path: m[5] });
  }
  return { tree, truncated: false };
}

function measure(ref, label) {
  const tree = treeOf(ref);
  const manifest = JSON.parse(execFileSync("git", ["show", `${ref}:package.json`], { cwd: REPO, encoding: "utf8" }));
  const surface = packageSourceSurface(manifest, tree, "");
  const runtimeFiles = surface.entries.filter(
    (it) => it.type === "blob" && it.mode !== "120000" && SCANNABLE_SOURCE.test(it.relativePath)
  );
  const sizes = runtimeFiles.map((it) => it.size);
  const total = sizes.reduce((a, b) => a + b, 0);
  const largest = Math.max(0, ...sizes);

  console.log(`──── ${label}（${ref.slice(0, 8)}）────`);
  console.log(`  files 白名单      = ${JSON.stringify(manifest.files)}`);
  console.log(`  包面 kind         = ${surface.kind}`);
  console.log(`  包面条目数        = ${surface.packageEntries}   （上限 ${bounds.maxTreeEntries}）`);
  console.log(`  可扫源码文件数    = ${runtimeFiles.length}   （上限 ${bounds.maxRuntimeFiles}）`);
  console.log(`  可扫源码合计      = ${total} B   （上限 ${bounds.maxTotalRuntimeBytes}）`);
  console.log(`  最大单文件        = ${largest} B   （上限 ${bounds.maxFileBytes}）`);
  console.log(`  逐条：`);
  for (const it of runtimeFiles.sort((a, b) => b.size - a.size)) {
    console.log(`     ${String(it.size).padStart(9)} B  ${it.relativePath}`);
  }
  const bad = [];
  if (!(runtimeFiles.length > 0 && runtimeFiles.length <= bounds.maxRuntimeFiles)) bad.push("文件数超限");
  if (!sizes.every((s) => s <= bounds.maxFileBytes)) bad.push("单文件超限");
  if (!(total <= bounds.maxTotalRuntimeBytes)) bad.push("总量超限");
  if (surface.packageEntries > bounds.maxTreeEntries) bad.push("包面条目超限");
  console.log(`  ⇒ ${bad.length === 0 ? "✅ 全部在界内" : "⛔ 超限项：" + bad.join(" · ")}`);
  console.log("");
  return { total, largest, count: runtimeFiles.length, bad, packageEntries: surface.packageEntries };
}

console.log("════════ D213 修正：用官方函数量包面 ════════\n");
console.log(`官方上限（automation-policy.json）：maxFileBytes ${bounds.maxFileBytes} · maxTotalRuntimeBytes ${bounds.maxTotalRuntimeBytes} · maxRuntimeFiles ${bounds.maxRuntimeFiles} · maxTreeEntries ${bounds.maxTreeEntries}\n`);

// ① 尺子校验：必须复现官方 statusReason 里的两个数
const ruler = measure("81ff044ababdf85c6ad2131f73d047a663b158c3", "尺子校验：官方判过的那一版（v1.1.0）");
const officialTotal = 950915;
const officialLargest = 528066;
const rulerOk = ruler.total === officialTotal && ruler.largest === officialLargest;
console.log(`★★ 尺子校验：官方 statusReason 写的是 ${officialTotal} / ${officialLargest}`);
console.log(`   我复算得到                                  ${ruler.total} / ${ruler.largest}`);
console.log(`   ⇒ ${rulerOk ? "✅ 逐位相同 —— 尺子对了，可以用它量别的" : "⛔ 对不上 ⇒ 尺子还没对，下面的数都不许信"}\n`);
if (!rulerOk) process.exit(1);

// ② 当前 HEAD
const now = measure("HEAD", "当前 HEAD");

console.log("════════ 结论 ════════");
console.log(`  官方书面判决（our-entry.json）当时的数：950,915 / 528,066（v1.1.0）`);
console.log(`  当前 HEAD：                            ${now.total} / ${now.largest}`);
console.log(`  ⇒ ${now.bad.length === 0 ? "✅ 现在能过" : "⛔ 仍卡在：" + now.bad.join(" · ")}`);
console.log(`  ★ 单文件那一条：528,066 → ${now.largest}（${now.largest > 528066 ? "变差" : "改善"}）`);
console.log(`  ★ 总量那一条：950,915 → ${now.total}（上限 ${bounds.maxTotalRuntimeBytes}）`);
