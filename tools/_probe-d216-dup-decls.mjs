// ═══════════════════════════════════════════════════════════════════════════
// D216 · **拆分后的「重复声明」体检** —— 补上当初漏掉的那一个方向
// ═══════════════════════════════════════════════════════════════════════════
//
// ★★★ 为什么要有这个探针（这是一个**真发生过**的漏检，不是假设）：
//   拆分当时，我建的判据是 `_probe-d216-completeness.mjs` ——
//   它证明的是「**467 个声明，0 丢 / 0 改**」。
//   ★ 可它**只核了一个方向：丢没丢**。它**从不核另一个方向：有没有多出来**。
//   ⇒ 结果：`apply()` 被**同时**写进了 `lib/index.js` **和** `lib/part6.js`
//     （那个文件全文件只有 1 个声明，就是 `apply` 的副本，111,916 B），
//     **两个探针都看不见**，而它一路进了 v1.2.0 的 npm 包与 GitHub。
//
// ★ 这正是本项目纪律 2 的同型复发：
//   *「判据的输入必须是**被测对象自己**产生的那部分」* ——
//   而这里错得更细：**判据必须覆盖"两个方向"（丢了 / 多了），只核一边 = 半边瞎。**
//
// ★ 为什么「多了」也有害（不是洁癖）：
//   ① `tools/selftest.mjs` 的 `readLibSource()` 是**按目录拼接全部 lib/*.js** ——
//      `apply` 因此出现两次 ⇒ 任何"apply 接上了没有"的**静态**断言，
//      都可能被**那份陈旧副本**满足 ⇒ **改了 index.js 却不红 = 假绿**（纪律 8）。
//   ② 每个用户下载的包里白多 11 万字节。
//
// ★ 判据（怎么算"重复"）：
//   按**顶层声明的名字**去重 —— 同一个名字**出现在两个不同文件里** ⇒ 重复。
//   ★ 明确不算重复的两种情况（否则会误报一大堆）：
//     · `export { a, b } from "./x.js"` —— 那是**再导出**，不是声明；
//     · 同一个名字在**同一个文件**里出现两次（重载/覆盖）—— 那是另一个病，本探针不判。
//
// 用法：node tools/_probe-d216-dup-decls.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "lib");

/**
 * 从一个文件里抽出**顶层声明的名字**。
 *
 * ★ 只锚**行首**（`^` 且不缩进）—— 与 selftest「情形 43」那条被踩过两次的教训同源：
 *   不锚行首就会把**注释里提到的**、**函数体内缩进的**那些也算进来
 *   （当初数 `section(` 就连错两次）。判据只吃「被测对象自己」的那部分文本。
 */
function declNamesOf(text) {
  const out = new Map(); // name → 首次出现的行号
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // ★ 再导出**不算声明**（`export { a, b } from "./x.js";`）
    if (/^export\s*\{[^}]*\}\s*from\b/.test(l)) continue;

    let m;
    // function / async function / class
    if ((m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(l))) {
      if (!out.has(m[1])) out.set(m[1], i + 1);
      continue;
    }
    if ((m = /^(?:export\s+)?class\s+([A-Za-z0-9_$]+)/.exec(l))) {
      if (!out.has(m[1])) out.set(m[1], i + 1);
      continue;
    }
    // const / let / var（含解构）
    if ((m = /^(?:export\s+)?(?:const|let|var)\s+([\s\S]*)$/.exec(l))) {
      const rest = m[1].trim();
      if (rest.startsWith("{") || rest.startsWith("[")) {
        // 解构：取到配对的括号，把里面的标识符挑出来
        const open = rest[0];
        const close = open === "{" ? "}" : "]";
        const end = rest.indexOf(close);
        const inner = end < 0 ? rest.slice(1) : rest.slice(1, end);
        for (const part of inner.split(",")) {
          const nm = part.split(":")[0].split("=")[0].trim().replace(/^\.\.\./, "");
          if (/^[A-Za-z0-9_$]+$/.test(nm) && !out.has(nm)) out.set(nm, i + 1);
        }
        continue;
      }
      const nm = rest.split("=")[0].split(/[\s;[(]/)[0].trim();
      if (/^[A-Za-z0-9_$]+$/.test(nm) && !out.has(nm)) out.set(nm, i + 1);
      continue;
    }
  }
  return out;
}

const files = fs
  .readdirSync(LIB)
  .filter((n) => n.endsWith(".js"))
  .sort();

console.log(`═══ lib/ 顶层声明普查（${files.length} 个文件）═══\n`);

const byName = new Map(); // name → [{file, line}]
const perFile = [];
let total = 0;
for (const f of files) {
  const names = declNamesOf(fs.readFileSync(path.join(LIB, f), "utf8"));
  perFile.push({ f, n: names.size });
  total += names.size;
  for (const [nm, line] of names) {
    if (!byName.has(nm)) byName.set(nm, []);
    byName.get(nm).push({ file: f, line });
  }
}

for (const { f, n } of perFile) console.log(`  ${f.padEnd(14)} ${String(n).padStart(4)} 个顶层声明`);
console.log(`\n  ── 合计 ${total} 个「文件×声明」· 去重后 ${byName.size} 个唯一名字`);

// ── 判据：一个名字出现在 ≥2 个**不同**文件 ⇒ 重复声明 ────────────────────────
const dups = [...byName.entries()].filter(([, sites]) => new Set(sites.map((s) => s.file)).size > 1);

console.log("\n═══ 重复声明（同一名字跨两个以上文件）═══");
if (dups.length === 0) {
  console.log("  ✅ 没有跨文件的重复声明。");
} else {
  for (const [nm, sites] of dups.sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ⛔ ${nm}`);
    for (const s of sites) console.log(`        ${s.file}:${s.line}`);
  }
}

// ── 附：每个文件里「同一个名字出现两次」也报一下（另一个方向的病）─────────────
console.log("\n═══ 同名在两个文件里各出现几次（只列跨文件重复的，供定位）═══");
if (dups.length > 0) for (const [nm, sites] of dups) console.log(`  ${nm.padEnd(28)} ${sites.map((s) => `${s.file}:${s.line}`).join("  ")}`);

console.log("\n═══ 结论 ═══");
if (dups.length === 0) {
  console.log("✅ 顶层声明唯一 ⇒ 拆分没有产生「多出来的一份」。");
  process.exit(0);
} else {
  console.log(`⛔ 发现 ${dups.length} 个重复声明 ⇒ 拆分**多写了一份**（不是"丢了"那个方向的问题）。`);
  console.log("★ 处置顺序：① 先确认多出来的那份**有没有被 import**（没被 import 才是死代码）；");
  console.log("   ② 再确认它是不是**另一份的严格子集**；③ 两个都成立才删 —— 删完必须重跑自检。");
  process.exit(1);
}
