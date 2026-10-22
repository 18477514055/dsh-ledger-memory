/**
 * 一次性脚本：反向验证用 —— 让 `installPreCommitHook()` **不再检查签名标记**
 * （也就是"看见 pre-commit 就覆盖"）。
 *
 * ★ 判据：`_probe-v3-hooks.mjs` 的 ⑥ 那四条**必须**报红。
 *   特别是「用户原文件一个字节都没被改」与「卸载后原文件仍然在」——
 *   这两条是"不毁掉用户东西"的全部保证。
 *
 * ★ 会改生产代码，用完跑 `_revert-v3-hooks-regression.mjs`。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const target = path.join(HERE, "..", "lib", "part2.js");
const src = fs.readFileSync(target, "utf8");

const needle = "  if (existing !== undefined && !existing.includes(MARK)) {";
const repl = "  if (false && existing !== undefined && !existing.includes(MARK)) { // ★ 故意注入的回归：不再检查签名";

const count = src.split(needle).length - 1;
if (count !== 1) {
  console.log(`PATCH FAILED: 期望唯一命中，实际 ${count} 处`);
  process.exit(1);
}
fs.writeFileSync(target, src.replace(needle, repl), "utf8");
console.log("REGRESSION INJECTED: 不再检查签名 ⇒ 会覆盖别人的 pre-commit");
