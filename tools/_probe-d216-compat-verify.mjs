// ═══════════════════════════════════════════════════════════════════════════
// D216 · 用**官方解析器**验证刚补的 `dsh.compatibility`（写错键会直接抛 TypeError）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么要专门验：
//   `catalog.mjs:145-166` 的 `declaredDshReleaseCompatibility` 对**不认识的键**
//   直接 `throw new TypeError(...is not a supported DSH release key)`，
//   对**非 compatible/incompatible/unknown 的值**同样抛错。
//   ⇒ 键写错**不是被忽略**，是**当场炸** —— 那会变成一条新的 blocked 理由。
//   ★ 而且它与"下架"那条机制相连：**最新 3 个 DSH 版本里至少 1 个 compatible**，
//     否则 `status: unlisted`（`catalog-compatibility-policy.mjs:140`）。
//   ⇒ 这两件事都必须**用官方的函数**验，不能靠看 JSON 顺眼。
//
// 用法：node tools/_probe-d216-compat-verify.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import {
  dshReleaseVersion,
  dshReleaseCompatibility,
  dshVersionCompatibility,
  DSH_RC_RELEASES,
  DSH_OPERATIONS,
} from "../_store-research/catalog.mjs";

const REPO = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

const declared = manifest?.dsh?.compatibility ?? {};
console.log("═══ ① 声明是否被官方读法读到（复刻 `check-plugin-submission.mjs:216-236`）═══");
const peerRanges = Object.entries(manifest.peerDependencies ?? {})
  .filter(([name]) => name.startsWith("@deepseek-ai/dsh-"))
  .map(([, range]) => range);
const uniquePeerRanges = [...new Set(peerRanges)];
const inferred = {
  dsh: typeof declared.dsh === "string" ? declared.dsh : uniquePeerRanges.length === 1 ? uniquePeerRanges[0] : null,
  dshReleases: Object.hasOwn(declared, "dshReleases") ? declared.dshReleases : {},
  dshOperations: Object.hasOwn(declared, "dshOperations") ? declared.dshOperations : {},
  node: typeof manifest.engines?.node === "string" ? manifest.engines.node : null,
  profiles: [...new Set([...(Array.isArray(declared.profiles) ? declared.profiles : []), ...(manifest?.dsh?.client?.platform === "web" ? ["web"] : [])])],
};
console.log(`  compatibility.dsh      = ${JSON.stringify(inferred.dsh)}`);
console.log(`  dshReleases 键数        = ${Object.keys(inferred.dshReleases).length}`);
console.log(`  dshOperations 键数      = ${Object.keys(inferred.dshOperations).length}`);
console.log(`  node                   = ${JSON.stringify(inferred.node)}`);
console.log(`  profiles               = ${JSON.stringify(inferred.profiles)}`);

// ── ② ★ 官方解析器：每个键都必须是"受支持的 release key" ────────────────────
console.log("\n═══ ② 逐个键过官方 `dshReleaseVersion`（不认识 ⇒ null，官方会抛 TypeError）═══");
let badKeys = 0;
for (const k of Object.keys(inferred.dshReleases)) {
  const v = dshReleaseVersion(k);
  if (v === null) {
    console.log(`  ⛔ ${k}  → null（**不受支持**，官方会抛 TypeError）`);
    badKeys += 1;
  }
}
console.log(`  不受支持的键：${badKeys} 个${badKeys === 0 ? " ✅" : ""}`);

// ── ③ 值必须是三选一 ───────────────────────────────────────────────────────
console.log("\n═══ ③ 值域检查（只许 compatible / incompatible / unknown）═══");
let badVals = 0;
for (const [k, v] of Object.entries(inferred.dshReleases)) {
  if (!["compatible", "incompatible", "unknown"].includes(v)) {
    console.log(`  ⛔ ${k} = ${JSON.stringify(v)}（非法）`);
    badVals += 1;
  }
}
console.log(`  非法值：${badVals} 个${badVals === 0 ? " ✅" : ""}`);

// ── ④ ★★★ 下架那条机制：最新 3 版里至少 1 个 compatible ────────────────────
//
//   ★ 官方"最新 3 版"的**权威在 npm registry**（`compatibility.registryUrl`），
//     而那个文件（`dsh-release-policy.mjs`）**不在我们下载的材料里**。
//   ⇒ 用**真实目录数据**反推窗口：32/32 的 approved 条目都在 `0.2.0-rc.2` 上有记录
//     （而更新的 `0.2.1-alpha.3` 一个都没有）⇒ 窗口很可能含 `0.2.0-rc.2`。
//   ★ 这里把**所有能查到的最新几版**都验一遍，看我们是否至少有一个 compatible。
console.log("\n═══ ④ 兼容性推算（用官方 `dshReleaseCompatibility`，按我们声明的范围）═══");
const fromRange = dshReleaseCompatibility(inferred.dsh, DSH_RC_RELEASES);
console.log(`  由范围 ${JSON.stringify(inferred.dsh)} 推出的（DSH_RC_RELEASES ${DSH_RC_RELEASES.length} 个）：`);
for (const [k, v] of Object.entries(fromRange)) {
  console.log(`     ${k.padEnd(18)} ${v}`);
}

// 关键几版：官方 npm 上最新的 3 个 = 0.2.0-rc.2 / 0.2.1-alpha.1 / 0.2.1-alpha.2 / 0.2.1-alpha.3（候选）
const CANDIDATE_WINDOW = ["0.2.1-alpha.3", "0.2.1-alpha.2", "0.2.1-alpha.1", "0.2.0-rc.2", "0.2.0-rc.1"];
console.log("\n  按**可能的窗口**逐个判（用官方 `dshVersionCompatibility` 判我们声明的范围）：");
let compatibleInWindow = 0;
for (const release of CANDIDATE_WINDOW) {
  const declaredStatus = inferred.dshReleases[release];
  const byRange = dshVersionCompatibility(inferred.dsh, release);
  const mark = declaredStatus === "compatible" ? "★ 我们声明了 compatible" : "";
  if (declaredStatus === "compatible") compatibleInWindow += 1;
  console.log(`     ${release.padEnd(18)} 我们声明=${String(declaredStatus ?? "(未声明)").padEnd(12)} 范围判定=${byRange}  ${mark}`);
}
console.log(`\n  可能窗口里我们声明 compatible 的：${compatibleInWindow} 个`);
console.log(`  ★ 官方要求 ≥ ${1} 个（` + "`requiredCompatibleReleases: 1`" + `）⇒ ${compatibleInWindow >= 1 ? "✅ 满足" : "⛔ **不满足 ⇒ 会被 unlisted**"}`);

// ── ⑤ 用官方函数**整体跑一遍** `declaredDshReleaseCompatibility` 的等价校验 ──
//   （它是 `catalog.mjs` 内部函数，不导出 ⇒ 用同样输入走 `dshVersionCompatibility` 逐个核）
console.log("\n═══ ⑤ 我们声明的 compatible 是否经得起范围自洽 ═══");
for (const [k, v] of Object.entries(inferred.dshReleases)) {
  if (v !== "compatible") continue;
  const ver = dshReleaseVersion(k);
  if (ver === null) continue;
  const byRange = dshVersionCompatibility(inferred.dsh, ver);
  if (byRange === "incompatible") {
    console.log(`  ⛔ ${k}：声明 compatible，但范围 ${inferred.dsh} **判定 incompatible** ⇒ 自相矛盾（人工审核会质疑）`);
  }
}
console.log("  （上面没列出 ⇒ 无自相矛盾 ✅）");

// ── ⑥ dshOperations 的键与值 ──────────────────────────────────────────────
console.log("\n═══ ⑥ dshOperations 检查（键须受支持；四操作各须 passed/failed/unknown）═══");
for (const [k, ops] of Object.entries(inferred.dshOperations)) {
  const ver = dshReleaseVersion(k);
  if (ver === null) console.log(`  ⛔ ${k}：不受支持的键`);
  for (const op of DSH_OPERATIONS) {
    const v = ops?.[op];
    if (!["passed", "failed", "unknown"].includes(v)) console.log(`  ⛔ ${k}.${op} = ${JSON.stringify(v)}（非法）`);
  }
}
console.log("  （上面没列出 ⇒ 合法 ✅）");

const ok = badKeys === 0 && badVals === 0 && compatibleInWindow >= 1;
console.log(`\n${ok ? "✅" : "⛔"} 结论：dsh.compatibility ${ok ? "形态与键值都对，且满足下架机制" : "有问题，看上面"}`);
if (!ok) process.exitCode = 1;
