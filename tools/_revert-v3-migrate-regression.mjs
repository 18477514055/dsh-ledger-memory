/**
 * 一次性脚本：还原 `_inject-v3-migrate-regression.mjs` 注入的回归。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const target = path.join(HERE, "..", "lib", "part7.js");
const src = fs.readFileSync(target, "utf8");

const needle = "  if (false && problems.length > 0) { // ★ 故意注入的回归：跳过校验";
const repl = "  if (problems.length > 0) {";

const count = src.split(needle).length - 1;
if (count !== 1) {
  console.log(`REVERT FAILED: 期望唯一命中注入痕迹，实际 ${count} 处`);
  process.exit(1);
}
fs.writeFileSync(target, src.replace(needle, repl), "utf8");
console.log("REGRESSION REVERTED: 校验已恢复");
