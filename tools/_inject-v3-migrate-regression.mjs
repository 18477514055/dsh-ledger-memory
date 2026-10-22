/**
 * 一次性脚本：反向验证用 —— 让 `migrateToV3()` **跳过校验直接改名**。
 *
 * ★ 要证明的是：**"校验不过就不改名"这条真的能被看见**。
 *   去掉校验后，一个"复制坏了"的场景会一路推进到改清单 —— 那时旧结构已经不可用。
 *   ⇒ 探针必须报红。
 *
 * ★ 会改生产代码，用完跑 `_revert-v3-migrate-regression.mjs`。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const target = path.join(HERE, "..", "lib", "part7.js");
const src = fs.readFileSync(target, "utf8");

const needle = "  if (problems.length > 0) {";
const repl = "  if (false && problems.length > 0) { // ★ 故意注入的回归：跳过校验";

const count = src.split(needle).length - 1;
if (count !== 1) {
  console.log(`PATCH FAILED: 期望唯一命中，实际 ${count} 处`);
  process.exit(1);
}
fs.writeFileSync(target, src.replace(needle, repl), "utf8");
console.log("REGRESSION INJECTED: 跳过校验直接改名");
