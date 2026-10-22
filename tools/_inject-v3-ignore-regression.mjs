/**
 * 一次性脚本：反向验证用 —— 让 `memoryRootIgnoreLines()` 直接返回空数组。
 *
 * ★ 判据（纪律 10）：`_probe-v3-ignore-v3dir.mjs` 的 ④ 那两条**必须**报红。
 *   ★ 特别是"任意新文件名也被挡住"那条 —— 它才是"设计上正确"的判据；
 *     若摘掉后**它仍然绿**，说明那条断言其实是靠"同名递归"通过的（假绿），必须重写。
 *
 * ★ 会改生产代码，用完跑 `_revert-v3-ignore-regression.mjs`。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const target = path.join(HERE, "..", "lib", "part2.js");
const src = fs.readFileSync(target, "utf8");

const needle = '  const raw = typeof info?.memoryRoot === "string" ? info.memoryRoot.trim() : "";';
const repl = "  return []; // ★ 故意注入的回归：假装 V3 规则不存在\n" + needle;

const count = src.split(needle).length - 1;
if (count !== 1) {
  console.log(`PATCH FAILED: 期望唯一命中，实际 ${count} 处`);
  process.exit(1);
}
fs.writeFileSync(target, src.replace(needle, repl), "utf8");
console.log("REGRESSION INJECTED: memoryRootIgnoreLines 直接返回 []");
