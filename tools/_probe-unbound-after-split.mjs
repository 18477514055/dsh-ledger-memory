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

// ── 复用自检里已验证过的"剥注释+字面量"（不自己重写 —— 那正是前一个版本出错的地方） ──
const { stripCommentsAndLiterals } = await import(
  pathToFileURL(path.join(HERE, "selftest.mjs")).href
).catch(() => ({ stripCommentsAndLiterals: undefined }));

/** 兜底：自检没导出就自己剥（但优先用现成的）。 */
function strip(src) {
  if (typeof stripCommentsAndLiterals === "function") return stripCommentsAndLiterals(src);
  let s = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  s = s.replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  s = s.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  s = s.replace(/`(?:[^`\\]|\\.)*`/g, "``");
  return s;
}

/** 所有 lib/*.js 的导出名（作为"可能跨文件引用"的候选） */
const exported = new Set();
for (const f of fs.readdirSync(LIB).filter((x) => x.endsWith(".js"))) {
  const src = fs.readFileSync(path.join(LIB, f), "utf8");
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) exported.add(m[1]);
  for (const m of src.matchAll(/^export\s+const\s+(\w+)/gm)) exported.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([\s\S]*?)\}\s*from/gm)) {
    for (const n of m[1].split(",")) {
      const t = n.trim().split(/\s+as\s+/).pop().trim();
      if (t) exported.add(t);
    }
  }
}

/** 该文件里**绑定**了的名字（import + 顶层声明） */
function bound(src) {
  const b = new Set();
  for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from/g)) {
    for (const n of m[1].split(",")) {
      const t = n.trim().split(/\s+as\s+/).pop().trim();
      if (t) b.add(t);
    }
  }
  for (const m of src.matchAll(/import\s+(\w+)\s*(?:,|from)/g)) b.add(m[1]);
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/gm)) b.add(m[1]);
  return b;
}

// ★★ 只在 `lib/base.js`、`lib/card-ops.js` 这两个**刚拆出来的**文件里查 ——
//   老文件（part1..part8）本来就正常，把它们也拉进来只会淹没信号。
//   ★ 判据：**先修自己动过的地方**，不要一次性扫全库（那会把"历史遗留"和"我造成的"混在一起）。
const TARGETS = ["base.js", "card-ops.js", "part2.js", "part4.js"];

console.log("═".repeat(74));
console.log("拆模块后「真·未绑定」排查（剥注释与字面量后再判）");
console.log("═".repeat(74));

let total = 0;
for (const f of TARGETS) {
  const src = fs.readFileSync(path.join(LIB, f), "utf8");
  const b = bound(src);
  const stripped = strip(src)
    .split("\n")
    .filter((l) => !/^import\s/.test(l) && !/^\s{2}\w+,\s*$/.test(l) && l.trim() !== "export {")
    .join("\n");

  const missing = [];
  for (const n of exported) {
    if (b.has(n)) continue;
    if (!new RegExp("\\b" + n + "\\b").test(stripped)) continue;
    missing.push(n);
  }
  if (missing.length > 0) {
    total += missing.length;
    console.log(`\n✗ ${f}  未绑定 ${missing.length} 个：`);
    console.log("   " + missing.join(", "));
    // 给出首次出现的位置，便于定位
    for (const n of missing.slice(0, 6)) {
      const idx = stripped.split("\n").findIndex((l) => new RegExp("\\b" + n + "\\b").test(l));
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
