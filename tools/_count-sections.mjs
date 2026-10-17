/**
 * 只读小工具：数出 `tools/selftest.mjs` 里 `section(` 的两个口径数字。
 * ★ 为什么单独放一个文件而不是 `node -e`：中文正则经 PowerShell 传参会被**编码毁掉**
 *   （本机老坑：PowerShell 对含中文的命令行参数处理不可靠）⇒ 写进文件最稳。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const p = path.join(HERE, "selftest.mjs");
const t = fs.readFileSync(p, "utf8");

// ★★ 第一版我这里写的是 `^section\(`（**顶格**），数出 69；而自检自己用的是 `^\s*section\(`
//   （**允许缩进**）⇒ 差的那 11 个正是**缩进在块里的** section。★ 这又是"尺子与自检不是同一把"——
//   纪律：**口径数字要数与自检完全相同的那个模式**，否则我"同步"的是另一个数。
const sectionCalls = [...t.matchAll(/^\s*section\(/gm)].length;
const numbered = [...t.matchAll(/^\s*section\("情形\s*[0-9]/gm)].length;
// 顺带数"会改写源码的探针"（与情形 43 同一判据）
const toolCountLiteral = [...t.matchAll(/\["(ledger_[a-z_]+)"/g)].length;

console.log(`section 调用数   = ${sectionCalls}`);
console.log(`带编号「情形 N」 = ${numbered}`);
console.log(`（字面量工具数   = ${toolCountLiteral}）`);
