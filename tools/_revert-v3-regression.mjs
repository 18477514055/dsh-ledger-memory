/**
 * 一次性脚本：把 `_inject-v3-regression.mjs` 注入的那处故意回归**还原**。
 *
 * ★ 与注入脚本成对存在：本项目纪律要求反向验证后必须能把工作区复原，
 *   且复原动作本身也要可验证（跑完再跑探针必须转绿）。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const target = path.join(HERE, "..", "lib", "part2.js");
const src = fs.readFileSync(target, "utf8");

const needle = "  const memBase = root; // ★ 故意注入的回归：应为 memoryBaseOf(info, root)";
const repl = "  const memBase = memoryBaseOf(info, root);";

const count = src.split(needle).length - 1;
if (count !== 1) {
  console.log(`REVERT FAILED: 期望唯一命中注入痕迹，实际 ${count} 处（可能本来就没注入）`);
  process.exit(1);
}
fs.writeFileSync(target, src.replace(needle, repl), "utf8");
console.log("REGRESSION REVERTED: writePrinciples 的 memBase 已恢复为 memoryBaseOf(info, root)");
