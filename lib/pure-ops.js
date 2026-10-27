/**
 * ★★★★★ 2026-10-25（D318）：**从 `part2.js` 拆出的纯函数族**（零外部依赖）。
 *
 * ── 为什么要拆 ─────────────────────────────────────────────────
 * Gemini 静态审查 004 的 F-07 指出 `lib/part3.js` 用到 **99.13%**（余 2,270 B）、
 * `lib/part2.js` **98.61%**（余 3,645 B）。而 F-03 / F-05 两条 P2 修复**正需要写进 part2**
 * ⇒ **装不下**。用户原话（逐字）：*"可以考虑进行拆分，但是要小心一点。"*
 *
 * ── 为什么拆这三个（不是随便挑的）────────────────────────────────
 * 判据：**只搬"搬出去不会新开依赖边"的块。**
 *   `lib/` 的 import 图本来就高度成环（`manifest-mirror.js:24-25` 自述过：新模块若 import
 *   任何 partN，就有把求值顺序改坏的风险，本项目栽过）。
 *   ⇒ 所以选块的标准不是"哪个大"，而是**哪个的跨模块依赖最少**。
 *   实测逐个统计后，这三个是 **内部依赖 0、跨 part 引用 0**：
 *     · `findDeFactoLedger`  只读目录 + 文件名正则
 *     · `mergeGitignore`     只读写 `.gitignore`
 *     · `stageOutcomeOf`     纯判据（比较 `r.ok` 与 `skipped`）
 *
 * ── 为什么是"搬实现 + 保 re-export"（照 D307 的先例）──────────────
 * D307 把 16 个纯基础函数搬到 `base.js` 时用的就是这一套：**实现搬走，`part2` 留 re-export**
 * ⇒ `import { … } from "./part2.js"` 的调用方**一个都不用改**。
 * ★ 判据（D307 原话）：**搬实现可以，改调用面不行** ——
 *   后者会把"体积问题"变成"全库回归问题"。
 *
 * ── 依赖面（这是它安全的原因）──────────────────────────────────
 * 只依赖 `node:fs` / `node:path` + `base.js` 的 `readTextSafe` / `countLines`。
 * `base.js` 是叶子模块（只依赖 node 内建）⇒ 本文件**不可能成环**。
 */

import fs from "node:fs";
import path from "node:path";

import { countLines, ensureDir, readTextSafe, writeFileAtomic } from "./base.js";

/** 项目根下"事实上就是台账"的文件（按名字认，不按内容猜）。 */
export function findDeFactoLedger(projectRoot) {
  const EXCLUDE = /^(readme|agents|claude|changelog|changes|license|handoff|交接|说明|index)\./i;
  let entries;
  try {
    entries = fs.readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/\.(md|markdown|txt)$/i.test(e.name)) continue;
    if (EXCLUDE.test(e.name)) continue;
    // 名字里要明确带"台账 / ledger / 进度 / 状态"这类词。
    if (!/(台账|ledger|进度|状态|status|progress)/i.test(e.name)) continue;
    let lines = 0;
    try {
      lines = countLines(readTextSafe(path.join(projectRoot, e.name)) ?? "");
    } catch {
      /* 读不到就当 0 行 */
    }
    return { name: e.name, lines };
  }
  return undefined;
}

/**
 * 把若干行并进 `.gitignore`。
 *
 * ★★★★ 2026-10-25（D318）搬移时**第二次**犯同一个错的留档：
 *   我第一版凭印象写成 `return { ok: true, added: n }` —— 而原文返回的是
 *   `{ changed, added: string[], path, created }`。**形状完全不同**：
 *     · `added` 我写成了数字，原文是**数组**（调用方会 `join("、")`）；
 *     · `changed` / `created` / `path` 三个字段我**整个漏了**。
 *   ⇒ 若就这么搬走，调用方读到 `undefined` 且**不报错**。
 *   ★ 这与 `stageOutcomeOf` 那次是同一个病：**"我看懂了所以重写一遍"**。
 *     本文件连续两次证明：**搬家必须逐字复制，不能重写。**
 *     （D316 已记过同型：替换函数而不读返回类型 ⇒ 造出比原缺陷更坏的东西。）
 */
export function mergeGitignore(projectRoot, lines) {
  const file = path.join(projectRoot, ".gitignore");
  const existing = readTextSafe(file);
  const had = existing === undefined ? "" : existing;
  const present = new Set(
    had
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((l) => l.trim())
  );
  const missing = lines.filter((l) => l !== "" && !present.has(l));
  if (existing !== undefined && missing.length === 0) {
    return { changed: false, added: [], path: file, created: false };
  }
  let next = had;
  if (next !== "" && !next.endsWith("\n")) next += "\n";
  if (missing.length > 0) {
    if (next !== "") next += "\n";
    next += "# 由 dsh-ledger-memory 追加\n";
    for (const l of missing) next += l + "\n";
  } else if (next === "") {
    next = "# 由 dsh-ledger-memory 创建\n";
  }
  ensureDir(path.dirname(file));
  const _w = writeFileAtomic(file, next);
  if (_w.ok !== true) throw new Error(String(_w.reason ?? "原子写失败"));
  return { changed: true, added: missing, path: file, created: existing === undefined };
}

/**
 * ★★★ 判"到底加进去没有"必须看两件事，缺一不可：
 *   ① `r.ok === true`（git add 没报错）；
 *   ② **确实有路径没被挡住** —— 也就是 `wanted` 减掉 `skipped` 之后还有剩。
 *
 *   🔴 第一版这里写的是 `r.staged?.length > 0`，**完全反了**。
 *     实测（`_probe-v3-autogitadd-default.mjs` 当场抓到）：
 *     `gitAdd()` **成功**时返回的是 `git()` 的原始结果 `{ok, code, stdout, stderr}`，
 *     **根本没有 `staged` 数组**；只有"全部被挡"那两个分支才返回 `staged: []`。
 *     ⇒ 于是"真的加进去了"被判成 false、"一个都没加"被判成 true —— 正好颠倒。
 *     ★ 这是本项目纪律第 16 条的同型（**按字段名猜形状**）：我以为返回里有 `staged`，
 *       而它只在失败分支存在。**写判据前必须先把返回值 dump 出来看形状。**
 *
 * ★★★★ 2026-10-25（D318）搬移时的教训，**必须留在这里**：
 *   我第一版凭印象把返回值写成 `{ok, staged: number, wanted, skipped, why}` ——
 *   **那是另一种形状**，而调用方读的是 `staged`（布尔）、`stagedPaths`、`stagedNote`。
 *   ⇒ 若就这么搬走，**类型悄悄变了、调用方全错，而且不报错**。
 *   ★ 判据：**搬函数必须逐字照抄返回值形状**；"我看懂了所以重写一遍"就是 D316 那个病
 *     （替换函数不读返回类型 ⇒ 造出比原缺陷更坏的东西）。
 */
export function stageOutcomeOf(r, wanted) {
  const wantedList = Array.isArray(wanted) ? wanted.filter((p) => typeof p === "string" && p !== "") : [];
  const skipped = Array.isArray(r?.skipped) ? r.skipped : [];
  const attempted = wantedList.filter((p) => !skipped.includes(p));
  const really = r?.ok === true && attempted.length > 0;

  return {
    staged: really,
    stagedPaths: really ? attempted : [],
    stagedSkipped: skipped,
    stagedNote:
      really
        ? skipped.length > 0
          ? `已 stage：${attempted.join("、")}；被 .gitignore 挡住（预期）：${skipped.join("、")}`
          : undefined
        : skipped.length > 0
          ? `全部被 .gitignore 挡住（预期行为）：${skipped.join("、")}`
          : r?.stderr || r?.error || r?.note || "git add 没有加进任何路径",
  };
}
