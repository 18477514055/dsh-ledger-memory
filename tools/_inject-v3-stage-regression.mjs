/**
 * 一次性脚本：反向验证用 —— 往 `lib/part4.js` 的 **`ledger_init`** 那一处注回归。
 *
 * ★★ 第一版注错了地方（注入 `writeLedger`），探针**照样全绿** —— 因为
 *   `_probe-v3-stage-gate.mjs` 只走 `ledger_init` 那条路。
 *   ⇒ **这正是"反向验证必须摘到能看见红为止"**：摘一处不红，说明
 *     ① 断言太弱，或 ② 摘错了地方。这次是 ②。**必须先确认探针覆盖哪条路，再决定注哪里。**
 *
 * ★ 这个脚本**会改生产代码**，用完必须跑 `_revert-v3-stage-regression.mjs`。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const target = path.join(HERE, "..", "lib", "part4.js");
const src = fs.readFileSync(target, "utf8");

// ledger_init 里那一处（特征：紧跟着 `staging = stageOutcomeOf(r, wanted);`）
const needle = "        staging = stageOutcomeOf(r, wanted);\n        staged = staging.staged;";
const repl =
  "        staging = { staged: r.ok === true, stagedPaths: [], stagedSkipped: [], stagedNote: undefined }; // ★ 故意注入的回归：旧写法\n        staged = staging.staged;";

const count = src.split(needle).length - 1;
if (count !== 1) {
  console.log(`PATCH FAILED: 期望唯一命中，实际 ${count} 处`);
  process.exit(1);
}
fs.writeFileSync(target, src.replace(needle, repl), "utf8");
console.log("REGRESSION INJECTED: ledger_init 的 stageOutcomeOf → 旧写法 {staged: r.ok}");
