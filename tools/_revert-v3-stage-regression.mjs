/**
 * 一次性脚本：还原 `_inject-v3-stage-regression.mjs` 注入的那处回归。
 * ★ 与注入脚本成对存在；还原后必须重跑探针转绿，且与备份 sha256 相同。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const target = path.join(HERE, "..", "lib", "part4.js");
const src = fs.readFileSync(target, "utf8");

const needle =
  "        staging = { staged: r.ok === true, stagedPaths: [], stagedSkipped: [], stagedNote: undefined }; // ★ 故意注入的回归：旧写法\n        staged = staging.staged;";
const repl = "        staging = stageOutcomeOf(r, wanted);\n        staged = staging.staged;";

const count = src.split(needle).length - 1;
if (count !== 1) {
  console.log(`REVERT FAILED: 期望唯一命中注入痕迹，实际 ${count} 处（可能本来就没注入）`);
  process.exit(1);
}
fs.writeFileSync(target, src.replace(needle, repl), "utf8");
console.log("REGRESSION REVERTED: ledger_init 的 stageOutcomeOf 已恢复");
