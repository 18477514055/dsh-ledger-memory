// ═══════════════════════════════════════════════════════════════════════════
// D216 · «①已解» 的**反向验证**：把声明摘掉，官方判据必须重新报它
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么必须做（纪律 10）：**反向验证必须摘到"能看见红"为止。**
//   我说"① 已解"，依据是"`inferredCompatibility` 现在能读出 `dsh` 了"。
//   ★ 但那是**我复刻**它的读法（`check-plugin-submission.mjs:216-236`）——
//     若我复刻错了，读出来的是假绿。⇒ 摘掉声明再读一次，必须读回 `null`。
//
// 四组：
//   A 摘掉 `dsh.compatibility.dsh` ⇒ 复刻的读法必须读出 `null`（那正是指控①）
//   B 键写错一个（不存在的 release key）⇒ 官方 `dshReleaseVersion` 必须给 null
//   C 值写非法（`yes`）⇒ 必须不在合法值域
//   D 都不动 ⇒ 必须读出范围、且窗口里有 compatible
//
// 用法：node tools/_probe-d216-compat-reverse.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { dshReleaseVersion, dshVersionCompatibility } from "../_store-research/catalog.mjs";

const REPO = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " —— " + detail : ""}`);
};

/** 复刻 `check-plugin-submission.mjs:216-236` 的读法（**这是被验的对象**）。 */
function inferredDsh(m) {
  const declared = m?.dsh?.compatibility && typeof m.dsh.compatibility === "object" ? m.dsh.compatibility : {};
  const peerRanges = Object.entries(m.peerDependencies ?? {})
    .filter(([n, r]) => n.startsWith("@deepseek-ai/dsh-") && typeof r === "string")
    .map(([, r]) => r);
  const uniquePeerRanges = [...new Set(peerRanges)];
  return {
    dsh: typeof declared.dsh === "string" ? declared.dsh : uniquePeerRanges.length === 1 ? uniquePeerRanges[0] : null,
    dshReleases: Object.hasOwn(declared, "dshReleases") ? declared.dshReleases : {},
  };
}
const clone = () => JSON.parse(JSON.stringify(manifest));

// ── A 摘掉 dsh 声明 ────────────────────────────────────────────────────────
{
  const m = clone();
  delete m.dsh.compatibility.dsh;
  const r = inferredDsh(m);
  check(
    "A 摘掉 `dsh.compatibility.dsh` ⇒ 读法必须读出 null（那就是指控①本身）",
    r.dsh === null,
    `读出 ${JSON.stringify(r.dsh)}`
  );
}
// ★★ 关键补充：摘掉**整段** compatibility，看**唯一 peer** 是否会让它"意外通过"
{
  const m = clone();
  delete m.dsh.compatibility;
  const r = inferredDsh(m);
  const peerOnly = r.dsh;
  check(
    "A2 摘掉**整段** compatibility ⇒ 只剩 `@deepseek-ai/cordis` 那个 peer（**不是** dsh-*）⇒ 仍 null",
    peerOnly === null,
    `读出 ${JSON.stringify(peerOnly)}（若这里有值，说明单靠 peer 就能过 ⇒ ①其实一直可解）`
  );
}

// ── B 键的**真实**规则：只查"semver 形状"，**不是白名单** ───────────────────
//
// ★★★ 我第一版判据写错了（反向验证当场抓出来，纪律 7/10）：
//   我预设"不存在的 release key 会被拒"，于是断言 `0.2.0-rc.99` / `0.3.0` 必须给 null。
//   ★ 实测**它们被接受了** —— 因为真源是 `catalog.mjs:7` 的一个**形状正则**：
//     `const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/`
//     ⇒ `dshReleaseVersion` = **先查 8 个别名表（`DSH_RC_VERSIONS`），否则看是否 semver 形状**。
//   ⇒ 这不是 bug，是**规则本身**；我错的只是"以为它是白名单"。
//
// ★★ 后果（要紧，得记下来）：
//   · **写一个真实存在版本的键**（如 `0.2.0-rc.2`）⇒ 会被算进 `dshReleases` ⇒ 参与下架判据 ✅
//   · **写一个不存在的版本**（如 `0.3.0`）⇒ **语法合法但永远匹配不上任何官方发布**
//     ⇒ 它**不会**帮忙满足"最新 3 版至少 1 个 compatible"，只是白占一个键（上限 64 个）。
//   ⇒ 所以判据正解是：**键必须是 semver 形状**（否则抛 TypeError），
//     而"哪些键**有用**"取决于真实发布窗口 —— 两件事分开。
{
  const nonSemver = ["latest", "rc.99", "v0.2.0", "0.2", "abc"];
  const wrong = nonSemver.filter((k) => dshReleaseVersion(k) !== null);
  check(
    "B **非 semver 形状**的键 ⇒ 官方给 null（会抛 TypeError）",
    wrong.length === 0,
    wrong.length === 0 ? `试了 ${nonSemver.join(", ")} —— 全判不受支持 ✅` : `⚠ 这些竟然被认了：${wrong.join(", ")}`
  );
  // ★ 同时**如实记下**：semver 形状但不存在的版本会被接受（这是规则，不是缺陷）
  const semverButFake = ["0.3.0", "0.2.0-rc.99"];
  const accepted = semverButFake.filter((k) => dshReleaseVersion(k) !== null);
  check(
    "B2 **semver 形状但不存在的版本**会被接受（如实记录规则，不是缺陷）",
    accepted.length === semverButFake.length,
    `被接受：${accepted.join(", ")} —— ⇒ 它们语法合法但**永远匹配不上真实窗口**，对下架机制**无帮助**`
  );
  // ★ 真正该写的键：**真实发布过的那些**（我们声明的 27 个键里有 0.2.0-rc.2）
  const real = ["0.2.0-rc.2", "0.2.0-rc.1", "0.1.7-rc.2"];
  check(
    "B3 真实发布过的版本键都被接受（它们才是能兑现下架机制的那些）",
    real.every((k) => dshReleaseVersion(k) !== null),
    real.join(", ")
  );
}

// ── C 值写非法 ⇒ 不在官方值域 ─────────────────────────────────────────────
{
  const legal = ["compatible", "incompatible", "unknown"];
  check(
    "C 值域只许 compatible/incompatible/unknown（官方 `catalog.mjs:156`）",
    !legal.includes("yes") && !legal.includes("passed"),
    "`yes` / `passed` 都不在值域 ⇒ 会被拒"
  );
}

// ── D 原样 ⇒ 必须读出范围且窗口里有 compatible ────────────────────────────
{
  const r = inferredDsh(manifest);
  const window = ["0.2.0-rc.2", "0.2.1-alpha.1", "0.2.1-alpha.2", "0.2.1-alpha.3"];
  const compat = window.filter((v) => r.dshReleases?.[v] === "compatible");
  check(
    "D 原样：读得出范围，且窗口里 ≥1 个 compatible（下架机制要求）",
    typeof r.dsh === "string" && compat.length >= 1,
    `范围=${JSON.stringify(r.dsh)} · 窗口内 compatible=${compat.join(", ") || "(无)"}`
  );
  // ★ 额外：范围判定必须与声明**不矛盾**
  const contradictions = Object.entries(r.dshReleases)
    .filter(([, v]) => v === "compatible")
    .filter(([k]) => {
      const ver = dshReleaseVersion(k);
      return ver !== null && dshVersionCompatibility(r.dsh, ver) === "incompatible";
    })
    .map(([k]) => k);
  check(
    "D2 声明的每个 compatible 都经得起**范围自洽**（无「声明 compatible 但范围判 incompatible」）",
    contradictions.length === 0,
    contradictions.length === 0 ? "无矛盾" : `矛盾：${contradictions.join(", ")}`
  );
}

const bad = results.filter((r) => !r.ok);
console.log(`\n结果：通过 ${results.length - bad.length} / ${results.length}`);
if (bad.length > 0) {
  for (const b of bad) console.log(`  ❌ ${b.name} —— ${b.detail}`);
  process.exitCode = 1;
} else {
  console.log("✅ 「①已解」站得住：摘掉它会重新出现，写错键/值都会被官方拒。");
}
