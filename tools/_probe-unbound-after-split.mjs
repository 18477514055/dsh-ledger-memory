#!/usr/bin/env node
/**
 * ★★★ 一次性把所有「拆模块后未绑定」的名字找出来 —— **用 `new Function` 做真绑定检查，不是正则猜**。
 *
 * 🔴 为什么重写（前面那个版本废了）：用"候选名单 + 正则找 `\bname\b`"来判定"是否使用了"，
 *   会把**注释里提到的名字**也算成使用 ⇒ 一次报了 174 处，几乎全是假阳性（`inject`/`name`/`apply`
 *   这种词在注释里到处都是）。
 *   ★ 判据（第四次栽在同一条线上）：**"出现了这个词" ≠ "用了这个绑定"。**
 *     要判"这个标识符是否被求值"，必须**看语法位置**（是否是表达式里的自由引用），正则做不到。
 *
 * ★ 正解：**真编译它**。
 *   把每个文件包进 `new Function(...候选名, 源码)` 里：
 *   · 若源码里有 `import/export`，`new Function` 会语法报错 ⇒ 不适用。
 *   ⇒ 改用**运行期代理**：`import` 每个模块（ESM 本来就会在**求值**时抛 `ReferenceError`，
 *     但函数体内的自由引用要**调用时**才抛 —— 这就是为什么逐个试错要跑那么久）。
 *
 * ⇒ 本探针改做**精确的静态绑定检查**：
 *   ① 只统计**出现在"表达式位置"**的候选名：用"去掉字符串/注释/正则字面量"之后的文本；
 *   ② 检查它是否在 import 名单 / 顶层声明里；
 *   ③ 关键是**剥离要干净** —— 本项目有现成的 `stripCommentsAndLiterals`，直接复用它（不要自己写）。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const LIB = path.join(PROJECT, "lib");

// ── 剥注释 + 字面量 ──────────────────────────────────────────────────────
//
// ★★★★★ 2026-10-24（D317）：手写状态机**第三次**栽在同一个地方 ⇒ 换成「正则 + 三项自证」。
//
//   病史（三次，同一个病：验证器自己不可靠）：
//     ① 第一版 await import 了 selftest.mjs —— 那个文件顶层会跑完整套自检再 process.exit()
//        ⇒ 本探针**一行自己的身体都没执行**，直接以别人的结果退出（D286 同型）。
//     ② 第二版改成手写状态机 —— 遇到「块注释里嵌着模板字面量」（注释里写某个函数名那种）
//        会漏配块注释的收尾 ⇒ **注释里的标识符被当成真代码** ⇒ 假阳性。
//        实测：它报 part1.js 有未绑定的 fingerprintOf，而那一行是**注释**里的。
//     ③ 同一个状态机还把**行号弄偏了**（挖空白时少算一个字符），报出来的行号对不上原文。
//   ★ 判据：**「看起来简单」的文本处理，手写十次会错三次。** JS 块注释**不嵌套**，
//     所以非贪婪正则就是完备解，不需要状态机。
//   ★ 但「用正则」也必须自证 —— 见下面的 stripSelfCheck：三条硬断言，缺一条就 exit 1。
function strip(src) {
  const keep = (m) => m.replace(/[^\n]/g, " ");
  let t = src;
  // ① 块注释（不嵌套）
  t = t.replace(/\/\*[\s\S]*?\*\//g, keep);
  // ② 行注释（要求前面不是冒号，免得吃掉 https:// 这类）
  t = t.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + keep(m.slice(p1.length)));
  // ③ 模板 / 双引号 / 单引号（整段挖空）。
  //    ★ 保守选择：模板里 ${} 的代码也一起挖掉 —— 那里极少出现要找的导出名，
  //      而**漏挖**会直接造假阳性；宁可保守。
  t = t.replace(/`(?:[^`\\]|\\.)*`/g, keep);
  t = t.replace(/"(?:[^"\\\n]|\\.)*"/g, keep);
  t = t.replace(/'(?:[^'\\\n]|\\.)*'/g, keep);
  return t;
}

// ── 剥法的三项自证（不通过就**立刻退出**，不许带着坏尺子往下跑）──────────
{
  const probeSrc = fs.readFileSync(new URL(import.meta.url), "utf8");
  const s = strip(probeSrc);
  const sameLineCount = s.split("\n").length === probeSrc.split("\n").length;
  // ② 已知在**注释里**的标识符必须被吃掉（正是这次栽的那一处）
  const commentedGone = !s.includes("fingerprintOf");
  // ③ 已知的**真代码**必须留着（否则剥多了，判据变哑巴）
  const realCodeKept = s.includes("export function strip") || s.includes("function strip(");
  if (!sameLineCount || !commentedGone || !realCodeKept) {
    console.error("⛔ 剥注释器自证失败 ⇒ 本探针的任何结论都不可信，直接退出：");
    console.error("   ① 行数一致 = " + sameLineCount);
    console.error("   ② 注释里的标识符已吃掉 = " + commentedGone);
    console.error("   ③ 真代码保留 = " + realCodeKept);
    process.exit(1);
  }
}

/** 所有 lib/*.js 的导出名（作为"可能跨文件引用"的候选） */
const exported = new Set();
// ★★★ 2026-10-23（D316）：**导入/导出块里允许写注释** —— 原来这里直接 `split(",")`
//   就把注释文本当成了名字，然后拿它去 `new RegExp("\\b" + n + "\\b")` ⇒
//   `Nothing to repeat` 直接崩。★ 判据：**解析"名字列表"之前先剥注释**，
//   否则只要有人在 `export { … }` 里写一行说明，这个探针就再也跑不动了（它不是判据红，是崩）。
const nameIn = (raw) =>
  raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .split(",")
    .map((n) => n.trim().split(/\s+as\s+/).pop().trim())
    .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));

for (const f of fs.readdirSync(LIB).filter((x) => x.endsWith(".js"))) {
  const src = fs.readFileSync(path.join(LIB, f), "utf8");
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) exported.add(m[1]);
  for (const m of src.matchAll(/^export\s+const\s+(\w+)/gm)) exported.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([\s\S]*?)\}\s*from/gm)) {
    for (const t of nameIn(m[1])) exported.add(t);
  }
}

/** 该文件里**绑定**了的名字（import + 顶层声明） */
function bound(src) {
  const b = new Set();
  for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from/g)) {
    for (const n of nameIn(m[1])) b.add(n);
  }
  for (const m of src.matchAll(/import\s+(\w+)\s*(?:,|from)/g)) b.add(m[1]);
  // ★★★ 2026-10-23（D316）：**允许行首缩进** —— 原来锚的是 `^`，于是函数体内的
  //   `  const apply = …` 不算"已绑定" ⇒ 报了第 1 个假阳性。
  //   ★ 判据：**"声明"不看缩进**。JS 里块内声明到处都是，锚行首等于只认顶层。
  for (const m of src.matchAll(/^[ \t]*(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/gm)) b.add(m[1]);
  // 函数参数也算绑定（`function f(root, args)` 里的 root/args 不该被当成未绑定）
  for (const m of src.matchAll(/(?:function\s+\w+|^\s*\w+\s*[:=]\s*(?:async\s*)?)\s*\(([^)]*)\)/gm)) {
    for (const p of m[1].split(",")) {
      const t = p.trim().split(/[=\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(t)) b.add(t);
    }
  }
  return b;
}

// ★★ 只在 `lib/base.js`、`lib/card-ops.js` 这两个**刚拆出来的**文件里查 ——
//   老文件（part1..part8）本来就正常，把它们也拉进来只会淹没信号。
//   ★ 判据：**先修自己动过的地方**，不要一次性扫全库（那会把"历史遗留"和"我造成的"混在一起）。
const TARGETS = fs
  .readdirSync(LIB)
  .filter((x) => x.endsWith(".js") && x !== "client.js")
  .sort();

console.log("═".repeat(74));
console.log("拆模块后「真·未绑定」排查（剥注释与字面量后再判）");
console.log("═".repeat(74));

let total = 0;
for (const f of TARGETS) {
  const src = fs.readFileSync(path.join(LIB, f), "utf8");
  const b = bound(src);
  const keepLines = (m) => m.replace(/[^\n]/g, " ");
  const stripped = strip(src)
    .replace(/\bimport\s*\{[\s\S]*?\}\s*from\s*[^;\n]+;?/g, keepLines)
    .replace(/\bexport\s*\{[\s\S]*?\}\s*from\s*[^;\n]+;?/g, keepLines)
    .split("\n")
    .filter((l) => !/^import\s/.test(l) && !/^\s{2}\w+,\s*$/.test(l) && l.trim() !== "export {")
    .join("\n");

  // ★★★ 2026-10-23（D316）：**「出现这个名字」≠「引用了这个变量」**。
  //   🔴 上一版用 `\bname\b` 判，于是 `e.name.endsWith("…")`、`const apply = …`、
  //     `{ inject: x.inject }` 全被当成"未绑定的引用" ⇒ 3 个假阳性。
  //       · `.name` 是**属性访问**，前面有点号；
  //       · `name:` 是**对象字面量的键**，后面跟冒号。
  //   两者都**不需要绑定**。判据必须排除它们，否则探针一开就永远红（假绿的反面：假红）。
  //   ★ 这也是本项目第 2 条纪律的同型：**判据的输入要认准"被测对象自己"的那部分**。
  const refRe = (n) => new RegExp(`(?<![.\\w$])${n}(?![\\w$])(?!\\s*:)`);
  const missing = [];
  for (const n of exported) {
    if (b.has(n)) continue;
    if (!refRe(n).test(stripped)) continue;
    missing.push(n);
  }
  if (missing.length > 0) {
    total += missing.length;
    console.log(`\n✗ ${f}  未绑定 ${missing.length} 个：`);
    console.log("   " + missing.join(", "));
    // 给出首次出现的位置，便于定位
    for (const n of missing.slice(0, 6)) {
      const idx = stripped.split("\n").findIndex((l) => refRe(n).test(l));
      console.log(`      ${n}  → 剥离后第 ${idx + 1} 行: ${stripped.split("\n")[idx]?.trim().slice(0, 70)}`);
    }
  } else {
    console.log(`✓ ${f}  无未绑定`);
  }
}

console.log("\n" + "─".repeat(74));
console.log(total === 0 ? "✓ 全部已绑定" : `✗ 合计 ${total} 处`);
console.log("─".repeat(74));
process.exit(total === 0 ? 0 : 1);
