/**
 * D368 · 锚点判据（**唯一真源** —— 抽取脚本必须 import 它，不许各写一份）
 *
 * ═══ 五版历史（每一版都是实测栽出来的，全部记在这里）═══
 * ① `检查器全文.includes(整行正文)` —— 漏。检查器存的是**带 `//` 的行首片段**。
 * ② `任一字面量 ⊂ 行 || 行 ⊂ 任一字面量` —— 太松。两万多条字面量 ⇒ 几乎全保护 ⇒ 搬不动。
 * ③ 字面量门槛 ≥10 中文字 —— 又漏。`"// ═══ 预检区结束"` 只有 5 个中文字。
 * ④ 用 `startsWith` 修方向 —— 仍漏，因为**字面量提取本身坏了**（见下）。
 * ⑤ ★★ 真根因（本轮最后才查出来）：**全文件扫引号会配错对**。
 *    用 `["'`]…["'`]` 这种正则在 900KB 的 selftest 上跑，前一个字符串的**收尾引号**
 *    会被当成后一个字符串的**起始引号** ⇒ 真实的
 *    `"// ★★★ D269（修 review F07）：**完整预检区**"` **根本没被抓出来**（实测 0 条）。
 *    ★ 判据：**"我提取了字面量" ≠ "我提取到了该有的字面量"** —— 得先验提取器的召回率。
 *
 * ═══ 本版规则（**不提取字面量**，直接量"检查器里有没有这一行的长前缀"）═══
 *   对每一行注释：取它 trim 后的**最长前缀**，若该前缀（长度 ≥ MIN_PREFIX）在检查器全文里出现
 *   ⇒ 这行是锚点 ⇒ 整块不可搬。
 *
 *   ★ 为什么这个稳：它绕开了"引号配对"这一整类错误；
 *     而检查器要定位源码文本，必然把那段的**行首**抄进自己的源码里（无论写成字面量还是别的）。
 *   ★ 为什么能容忍行尾差异：检查器通常只抄行首（`indexOf("// ★★★ D269…**完整预检区**")`），
 *     源码行后面还有 ` —— 下面任何一行都不许写盘。` ⇒ 前缀匹配天然处理这种差异。
 */
import fs from "node:fs";
import path from "node:path";

/** 前缀下限：太短会误伤（例如 `//` 或纯分隔线），16 个字符足以区分"定位用"与"泛泛提到"。 */
const MIN_PREFIX = 16;

export function loadCheckerText(rootDir) {
  const toolsDir = path.join(rootDir, "tools");
  const checkers = [
    path.join(toolsDir, "selftest.mjs"),
    ...fs
      .readdirSync(toolsDir)
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => path.join(toolsDir, f)),
  ];
  return checkers.map((f) => fs.readFileSync(f, "utf8")).join("\n");
}

/**
 * 判断一行注释是否是"被检查器搜索的锚点"。
 * @param {string} line 源码行（含 `//`）
 * @param {string} checkerText 检查器全文
 */
export function isAnchorLine(line, checkerText) {
  const t = String(line).trim();
  if (t.length < MIN_PREFIX) return false;
  if (!t.startsWith("//") && !t.startsWith("*")) return false;

  // 从长到短找最长前缀；找得到就说明检查器抄过这一行的一段
  for (let len = t.length; len >= MIN_PREFIX; len -= 1) {
    const prefix = t.slice(0, len);
    if (checkerText.includes(prefix)) return true;
  }
  return false;
}

/** 便捷封装：给一个 checkerText，返回 `(line) => boolean`。 */
export function makeIsAnchor(checkerText) {
  return (line) => isAnchorLine(line, checkerText);
}
