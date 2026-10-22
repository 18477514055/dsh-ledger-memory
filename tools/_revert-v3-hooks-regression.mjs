/**
 * 一次性脚本：还原 `_inject-v3-hooks-regression.mjs` 注入的回归。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const target = path.join(HERE, "..", "lib", "part2.js");
const src = fs.readFileSync(target, "utf8");

const needle = "  if (false && existing !== undefined && !existing.includes(MARK)) { // ★ 故意注入的回归：不再检查签名";
const repl = "  if (existing !== undefined && !existing.includes(MARK)) {";

const count = src.split(needle).length - 1;
if (count !== 1) {
  console.log(`REVERT FAILED: 期望唯一命中注入痕迹，实际 ${count} 处`);
  process.exit(1);
}
fs.writeFileSync(target, src.replace(needle, repl), "utf8");
console.log("REGRESSION REVERTED: 签名检查已恢复");
