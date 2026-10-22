/**
 * 一次性脚本：还原 `_inject-v3-gitinit-regression.mjs` 注入的回归。
 * ★ 还原后必须重跑探针转绿，且与备份 sha256 相同。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const target = path.join(HERE, "..", "lib", "part4.js");
const src = fs.readFileSync(target, "utf8");

const needle = "      const wantsGitInit = args?.gitInit !== false; // ★ 故意注入的回归：旧写法（默认 init）";
const repl = "      const wantsGitInit = args?.gitInit === true;";

const count = src.split(needle).length - 1;
if (count !== 1) {
  console.log(`REVERT FAILED: 期望唯一命中注入痕迹，实际 ${count} 处（可能本来就没注入）`);
  process.exit(1);
}
fs.writeFileSync(target, src.replace(needle, repl), "utf8");
console.log("REGRESSION REVERTED: gitInit 默认值已恢复为 === true");
