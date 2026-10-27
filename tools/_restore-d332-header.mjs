/**
 * _restore-d332-header.mjs —— 把 `part2-tools.js` 的文件头说明**补回来**
 *
 * ★ 起因：`_repair-d332-imports.mjs` 用「往上吃连续注释行」定位头部，结果吃到了第 0 行
 *   （因为文件**开头就是**那段说明注释），于是 `header=""` ⇒ 大段说明被丢掉，
 *   只剩 import 区最上面那两句。功能没坏，但**丢掉的是"为什么这么拆"的理由**——
 *   那条恰恰是最该留的（下次谁动这个文件都得先知道循环依赖为什么合法）。
 *
 * ★ 判据（新）：**脚本改文件时，"顺带删掉的东西"必须显式校验过**——
 *   我这次只看到 `check exit=0` 就往下走了，头部丢了 20 多行说明是我事后读文件才发现的。
 */
import fs from "node:fs";
import path from "node:path";

const NEW = path.resolve("lib/part2-tools.js");
let text = fs.readFileSync(NEW, "utf8");
const tmp = process.env.TEMP ?? ".";
fs.writeFileSync(path.join(tmp, `part2-tools-before-header-${Date.now()}.js`), text, "utf8");

const HEADER = `/**
 * part2-tools.js —— 四个 \`ledger_*\` 工具的**定义体**（从 \`part2.js\` 原样搬出）
 *
 * ★ 为什么单独一个模块（D332）：\`part2.js\` 撞上了它自己 20 KB 的安全余量红线
 *   （241,272 B，距 241,664 只剩 **392 B**）。挑出来的是**最干净的一簇**：
 *   - 四个 \`define*Tool\` 合计 **约 36,000 B**
 *   - 它们在 \`part2.js\` 内部被引用 **0 次**（只有 \`index.js\` 调它们）
 *   - 依赖**全是函数声明** ⇒ 反向 import 安全、无 TDZ 风险
 *
 * ★★ **调用面一个字都没改**：\`part2.js\` 原位留了
 *   \`export { defineGoalsTool, … } from "./part2-tools.js"\`
 *   ⇒ \`index.js\` 仍从 \`./part2.js\` import，行为完全不变。
 *
 * ★★★ **实现体是逐字节搬过来的**，没有重写、没有"顺手优化"。
 *   （判据：搬之前用 \`origText.includes(body)\` 逐段校验过。）
 *
 * ★ 关于循环依赖（这里**是**双向的，但合法）：
 *   \`part2-tools\` → import \`part2\`（拿 inspect / renderGoalTree 等实现）
 *   \`part2\`       → export…from \`part2-tools\`（转发四个 tool）
 *   ESM 允许这种环，**前提是顶层不求值**。已实测确认：四个 tool 体内没有 IIFE、
 *   没有顶层 await、没有顶层 new；依赖里 const/let 为 **0 个**（全是函数声明，提升）。
 *   ⇒ 调用发生在模块求值完成之后，拿到的永远是真身。
 *
 * ★★★ 依赖清单是**求交集**得来的（不是静态扫英文散文猜的）：
 *   "实现体里出现的标识符" ∩ "part2 的符号表" ⇒ 44 个，一个不多一个不少。
 *   走这条路是因为：静态扫自由标识符会把工具描述里的 This / You / Never 全当符号，
 *   一次报出 **284 个假阳性**（真缺的只有 8 个）。★ 判据：**能求交集就别猜**。
 */
`;

// 去掉旧的（残缺）开头两句注释 + 空行，换上新 HEADER
const stripped = text.replace(/^\s*\n?\/\/[^\n]*\n(?:\/\/[^\n]*\n)*/g, "");
const rebuilt = HEADER + stripped.replace(/^\s*\n+/, "");

fs.writeFileSync(NEW, rebuilt, "utf8");
console.log(`补回文件头：${Buffer.byteLength(rebuilt, "utf8")} B / ${rebuilt.split(/\r?\n/).length} 行`);
console.log(`U+FFFD = ${(rebuilt.match(/\uFFFD/g) ?? []).length}`);
console.log("\nPROBE-COMPLETE");
