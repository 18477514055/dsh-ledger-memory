/**
 * 一次性脚本：反向验证用 —— 往 `lib/part2.js` 注**一处**故意的回归。
 *
 * ★ 为什么需要它：本项目纪律「反向验证必须摘到能看见红为止」。
 *   探针全绿只证明"没发现错"，不证明"能发现错"。
 *   ⇒ 故意把 `writePrinciples` 的基准从 `memBase` 改回 `root`，
 *     看 `_probe-v3-e2e.mjs` 的 ④ 那组是否**当场报红**。
 *
 * ★ 这个脚本**会改生产代码**，用完必须跑 `_revert-v3-regression.mjs` 还原。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const target = path.join(HERE, "..", "lib", "part2.js");
const src = fs.readFileSync(target, "utf8");

// 锚一处**唯一**形态：writePrinciples 里的基准取值（第 57 行那一处）
const needle = "  const memBase = memoryBaseOf(info, root);";
const repl = "  const memBase = root; // ★ 故意注入的回归：应为 memoryBaseOf(info, root)";

const count = src.split(needle).length - 1;
if (count !== 1) {
  console.log(`PATCH FAILED: 期望唯一命中，实际 ${count} 处`);
  process.exit(1);
}
fs.writeFileSync(target, src.replace(needle, repl), "utf8");
console.log("REGRESSION INJECTED: writePrinciples 的 memBase → root");
