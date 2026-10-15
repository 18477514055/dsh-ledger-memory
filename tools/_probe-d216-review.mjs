// ═══════════════════════════════════════════════════════════════════════════
// D216 · **用官方函数预跑固定源扫描**（`reviewFixedSource` + 三个信号函数）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★★ 为什么必须自己先跑（不许等官方告诉我们）：
//   `fixed-source-review.mjs:34` 的扫描**只有 `canScan` 为真才跑**；而
//   `canScan = filesWithinBounds && bytesWithinBounds && tree.truncated===false && packageEntries<=maxTreeEntries`
//   ⇒ **拆分前 largest file 超限 ⇒ canScan=false ⇒ 扫描从未运行过** ⇒
//     官方上次给我们的 ③④（scan incomplete / capability signals unknown）**就是这个原因**。
//   ⇒ 现在拆完了 ⇒ **canScan 首次为真** ⇒ 官方第一次真扫**可能扫出全新信号**。
//   ★ 这与本项目那条纪律一致：**"配了就该跑"不是证据** —— 必须自己先量出来。
//
// ★ 本探针**直接调官方那几个函数**（`fixed-source-review.mjs` 的 `reviewFixedSource`
//   与 `automation-source-policy.mjs` 的三个信号函数），不重写它们的判据
//   （D213 已经栽过"手搓 glob 两次量错集合"）。
//
// 用法：node tools/_probe-d216-review.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { reviewFixedSource } from "../_store-research/fixed-source-review.mjs";
import { permissionSignals, dshInterfaceSignals, localModuleEvidence } from "../_store-research/automation-source-policy.mjs";
import { packageSourceSurface, SCANNABLE_SOURCE, NATIVE_ARTIFACT } from "../_store-research/package-source-surface.mjs";

const REPO = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const POLICY = JSON.parse(fs.readFileSync(path.join(REPO, "_store-research", "automation-policy.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

/** 走工作区（不跟随联接），喂成官方要的 tree 形状。 */
function treeOfWorktree() {
  const tree = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      const st = fs.lstatSync(p);
      const rel = path.relative(REPO, p).split(path.sep).join("/");
      if (st.isSymbolicLink()) continue;
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

// ── readSource：官方签名是 `(path, maxBytes) => string` ─────────────────────
const readSource = async (p, maxBytes) => {
  const abs = path.join(REPO, p);
  const st = fs.statSync(abs);
  if (st.size > maxBytes) return undefined; // 官方会据此报"字节不符"
  return fs.readFileSync(abs, "utf8");
};

// ── 假 candidate（够 `isGeneratedSelfManagerRegistryData` 判否即可）─────────
const candidate = {
  id: manifest.name,
  repositoryUrl: manifest.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, ""),
  installPath: "",
};

console.log("═══ 用官方 `reviewFixedSource` 预跑（工作区）═══\n");
const result = await reviewFixedSource(candidate, manifest, tree, POLICY, readSource);

console.log(`scanComplete = ${result.scanComplete}`);
console.log(`filesScanned = ${result.filesScanned} / ${result.runtimeFiles}`);
console.log(`runtimeBytes = ${result.runtimeBytes}`);
console.log(`scope        = ${JSON.stringify(result.scope)}\n`);

console.log("── 信号（`Object.fromEntries`：`null` = 没扫到所以未知）──");
for (const [k, v] of Object.entries(result.signals)) {
  const mark = v === true ? "⛔ 命中（不允许）" : v === false ? "✅ 未命中" : "⚠ 未知（未扫描）";
  console.log(`  ${k.padEnd(30)} = ${JSON.stringify(v)}  ${mark}`);
}
console.log(`\nreviewSignals = ${JSON.stringify(result.reviewSignals)}`);

console.log(`\n── reasons（${result.reasons.length} 条）──`);
for (const r of result.reasons) console.log(`  · ${r}`);

// ── 逐文件摊开：**哪个文件命中了哪个信号**（这样才知道能不能改）─────────────
console.log("\n═══ 逐文件信号明细（scanComplete 才可能为空）═══");
const surface = packageSourceSurface(manifest, tree, "");
const runtimeFiles = surface.entries.filter(
  (it) => it.type === "blob" && it.mode !== "120000" && SCANNABLE_SOURCE.test(it.relativePath)
);
const hitFiles = [];
for (const it of runtimeFiles.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))) {
  const src = fs.readFileSync(path.join(REPO, it.relativePath), "utf8");
  const sig = permissionSignals(src, it.relativePath);
  const iface = dshInterfaceSignals(src, it.relativePath);
  const mods = localModuleEvidence(src, it.relativePath);
  const hits = Object.entries(sig).filter(([, v]) => v === true).map(([k]) => k);
  if (hits.length || iface.toolViewExtension || mods.dynamic) {
    hitFiles.push({ file: it.relativePath, hits, toolView: iface.toolViewExtension, dynamic: mods.dynamic });
    console.log(`  ⛔ ${it.relativePath}`);
    if (hits.length) console.log(`       信号：${hits.join(", ")}`);
    if (iface.toolViewExtension) console.log("       toolViewExtension");
    if (mods.dynamic) console.log("       dynamicModuleLoading");
  } else {
    console.log(`  ✅ ${it.relativePath}`);
  }
}

console.log("\n═══ 结论 ═══");
if (result.scanComplete && result.reasons.length === 0) {
  console.log("✅ 扫描完成且**零 reasons** ⇒ ②③④ 三条全部解掉。");
} else if (result.scanComplete) {
  console.log(`⚠ 扫描**完成了**（②③④ 已解），但出现 ${result.reasons.length} 条新 reason —— 下面这些是真问题：`);
  for (const r of result.reasons) console.log(`   · ${r}`);
} else {
  console.log("⛔ 扫描仍未完成（canScan 还是假）—— 那说明还有别的 bound 没过。");
}
console.log(`\n命中信号的文件：${hitFiles.length} 个`);
