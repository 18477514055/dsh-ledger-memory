/**
 * 一次性脚本：反向验证用 —— 把 `git init` 的默认值**改回旧写法**（`!== false`）。
 *
 * ★ 判据（本项目纪律 10）：**必须摘到能看见红为止**。
 *   改回旧写法后，`_probe-v3-gitinit-explicit.mjs` 的第 ① 组必须报红
 *   （默认会 init ⇒ 磁盘上冒出 `.git`）。
 *
 * ★ 这个脚本**会改生产代码**，用完必须跑 `_revert-v3-gitinit-regression.mjs`。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const target = path.join(HERE, "..", "lib", "part4.js");
const src = fs.readFileSync(target, "utf8");

const needle = "      const wantsGitInit = args?.gitInit === true;";
const repl = "      const wantsGitInit = args?.gitInit !== false; // ★ 故意注入的回归：旧写法（默认 init）";

const count = src.split(needle).length - 1;
if (count !== 1) {
  console.log(`PATCH FAILED: 期望唯一命中，实际 ${count} 处`);
  process.exit(1);
}
fs.writeFileSync(target, src.replace(needle, repl), "utf8");
console.log("REGRESSION INJECTED: gitInit 默认值 → 旧写法 !== false（默认会 init）");
