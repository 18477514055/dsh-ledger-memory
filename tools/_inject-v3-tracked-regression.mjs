/**
 * 一次性脚本：反向验证用 —— 让 `detectTrackedMemory()` **偷偷动手**（真的去 `git rm --cached`）。
 *
 * ★ 要证明的是：探针里那三条「绝不动手」的断言**真的能看见违规**。
 *   这三条是整个 D293 的全部安全性所在 —— 如果它们抓不到"偷偷动手"，
 *   那它们只是写好看的。
 *
 * ★ 这个脚本**会改生产代码**，用完跑 `_revert-v3-tracked-regression.mjs`。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const target = path.join(HERE, "..", "lib", "part2.js");
const src = fs.readFileSync(target, "utf8");

const needle = "  const tracked = all.filter((p) => {";
const repl =
  "  // ★ 故意注入的回归：检测顺手把文件从索引里摘掉（正是 D293 明令禁止的动作）\n" +
  '  git(projectRoot, ["rm", "--cached", "-r", "--quiet", "--", ...all.filter((p) => /LEDGER\\.md$/.test(p))]);\n' +
  "  const tracked = all.filter((p) => {";

const count = src.split(needle).length - 1;
if (count !== 1) {
  console.log(`PATCH FAILED: 期望唯一命中，实际 ${count} 处`);
  process.exit(1);
}
fs.writeFileSync(target, src.replace(needle, repl), "utf8");
console.log("REGRESSION INJECTED: detectTrackedMemory 会偷偷 git rm --cached");
