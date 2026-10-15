// ═══════════════════════════════════════════════════════════════════════════
// D216 · 用**官方目录**实测：这 4 个 permission 信号是不是"人人都过不去"的墙
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么要问这个（它决定策略）：
//   官方白名单把 6 个信号**全设为 false（一律不允许）**，而我们的插件**必然**用到
//   文件 I/O、命令、凭证 ⇒ 若"命中 = 永不可上架"，那自动通道**对我们结构性关闭**，
//   继续优化就没意义了（该转策略）。
//   ★ 但 `dshstore-automate.mjs:392-403` 的 `reviewableReasons` **明确列了这 5 条**
//     ⇒ 官方文档口径是"**可转人工审核**"，不是"硬伤"。
//   ⇒ **不许凭这两条就下结论**，去看**真实的目录数据**：approved 的条目长什么样。
//
// 用法：node tools/_probe-d216-catalog-landscape.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

const REPO = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const DIR = path.join(REPO, "_store-research");

const catalog = JSON.parse(fs.readFileSync(path.join(DIR, "catalog-index.json"), "utf8"));
const entries = Array.isArray(catalog.entries) ? catalog.entries : [];

console.log(`官方目录条目总数 = ${entries.length}\n`);

// ── ① 状态分布 ─────────────────────────────────────────────────────────────
const byStatus = {};
for (const e of entries) byStatus[e.status ?? "(无)"] = (byStatus[e.status ?? "(无)"] ?? 0) + 1;
console.log("── ① status 分布 ──");
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(14)} ${String(v).padStart(4)}  (${((v / entries.length) * 100).toFixed(1)}%)`);
}

// ── ② updatePolicy 分布（×status）─────────────────────────────────────────
console.log("\n── ② updatePolicy × status ──");
const cross = {};
for (const e of entries) {
  const k = `${e.updatePolicy ?? "(无)"} / ${e.status ?? "(无)"}`;
  cross[k] = (cross[k] ?? 0) + 1;
}
for (const [k, v] of Object.entries(cross).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(34)} ${String(v).padStart(4)}`);
}

// ── ③ approved 的条目，他们的 statusReason 是否含 permission signal？───────
console.log("\n── ③ reasons 里出现各类关键词的条目数（全表）──");
const KEYWORDS = [
  "DSH compatibility is not explicitly declared",
  "files permission signal",
  "network permission signal",
  "commands permission signal",
  "credentials permission signal",
  "nativeOrExecutableArtifacts permission signal",
  "protectedDsh permission signal",
  "largest file",
  "scan is incomplete",
  "lifecycle scripts",
  "dependencies",
];
for (const kw of KEYWORDS) {
  let n = 0;
  for (const e of entries) if (String(e.statusReason ?? "").includes(kw)) n += 1;
  console.log(`  ${String(n).padStart(4)}  ${kw}`);
}

// ── ④ ★ 关键：有没有 approved 的条目？他们把 reasons 清空了？──────────────
console.log("\n── ④ approved 条目（正常上架）──────────────────");
const approved = entries.filter((e) => e.status === "approved");
console.log(`  共 ${approved.length} 个`);
for (const e of approved.slice(0, 12)) {
  console.log(`    · ${e.id}  policy=${e.updatePolicy ?? "?"}  reason=${e.statusReason === undefined ? "(无：已通过)" : String(e.statusReason).slice(0, 80)}`);
}

// ── ⑤ ★★ 决定性：有没有**非 default（无 CLI/网络）**的 approved 条目，含文件/命令信号？
console.log("\n── ⑤ 命中 permission 信号却仍在上架的（有 ⇒ 说明不是硬墙）──");
const signalHits = entries.filter((e) => /permission signal/.test(String(e.statusReason ?? "")));
console.log(`  状态 reason 里含 "permission signal" 的条目：${signalHits.length} 个`);
const byStat = {};
for (const e of signalHits) byStat[e.status ?? "(无)"] = (byStat[e.status ?? "(无)"] ?? 0) + 1;
console.log(`  它们的状态分布：${JSON.stringify(byStat)}`);

// ── ⑥ 看我们自己那条 ───────────────────────────────────────────────────────
console.log("\n── ⑥ 我们自己那条（从 our-entry.json 读）──");
const ours = JSON.parse(fs.readFileSync(path.join(DIR, "our-entry.json"), "utf8"));
console.log(`  id=${ours.id}  status=${ours.status}  policy=${ours.updatePolicy}  version=${ours.version}`);
console.log(`  statusReason=${String(ours.statusReason).slice(0, 300)}`);
const mine = entries.find((e) => e.id === ours.id);
if (mine !== undefined) {
  console.log(`  ★ 目录**线上**那条：status=${mine.status}  policy=${mine.updatePolicy}`);
  console.log(`    statusReason=${String(mine.statusReason).slice(0, 300)}`);
} else {
  console.log("  ★ 目录里找不到我们那条（our-entry.json 是当时的快照）。");
}

// ── ⑦ 抽样：reason 只有"可转人工"那几条的条目，最终什么状态 ────────────────
console.log("\n── ⑦ 抽样：reason 只含 reviewable 类（兼容性/信号）的条目 ──");
const REVIEWABLE = [
  "DSH compatibility is not explicitly declared",
  "Node.js compatibility is not explicitly declared",
  "install lifecycle scripts are present:",
  "runtime or optional dependencies require a separate supply-chain review",
  "bundled dependencies are not eligible for automatic approval",
  "permission signal",
];
let onlyReviewable = 0;
const samples = [];
for (const e of entries) {
  const r = String(e.statusReason ?? "");
  if (r === "") continue;
  // statusReason 形如 "Automatic policy blocked installation: A; B; C"
  const body = r.replace(/^Automatic policy blocked installation:\s*/, "");
  const parts = body.split(";").map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0) continue;
  const allReviewable = parts.every((p) => REVIEWABLE.some((k) => p.includes(k) || p.startsWith(k)));
  if (allReviewable) {
    onlyReviewable += 1;
    if (samples.length < 10) samples.push({ id: e.id, status: e.status, policy: e.updatePolicy, n: parts.length, first: parts[0] });
  }
}
console.log(`  只含 reviewable 类原因的条目：${onlyReviewable} 个`);
for (const s of samples) {
  console.log(`    · ${s.id}  status=${s.status}  policy=${s.policy}  (${s.n} 条，首条：${s.first.slice(0, 60)})`);
}
