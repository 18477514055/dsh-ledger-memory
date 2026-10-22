/**
 * 一次性脚本：还原 `_inject-v3-tracked-regression.mjs` 注入的回归。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const target = path.join(HERE, "..", "lib", "part2.js");
const src = fs.readFileSync(target, "utf8");

const needle =
  "  // ★ 故意注入的回归：检测顺手把文件从索引里摘掉（正是 D293 明令禁止的动作）\n" +
  '  git(projectRoot, ["rm", "--cached", "-r", "--quiet", "--", ...all.filter((p) => /LEDGER\\.md$/.test(p))]);\n';

const count = src.split(needle).length - 1;
if (count !== 1) {
  console.log(`REVERT FAILED: 期望唯一命中注入痕迹，实际 ${count} 处`);
  process.exit(1);
}
fs.writeFileSync(target, src.replace(needle, ""), "utf8");
console.log("REGRESSION REVERTED: detectTrackedMemory 已恢复为只读");
