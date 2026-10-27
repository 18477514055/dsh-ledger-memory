/**
 * _tidy-d332-imports.mjs —— 把 `part2-tools.js` 的 import **合并整理**，并补上 node 内置模块
 *
 * ★ 为什么必须整理（不只是好看）：
 *   补依赖脚本是逐轮追加的 ⇒ 同一个模块被拆成好几行（`./defs.js` 出现 4 次、`./part4.js` 3 次、
 *   `./part3.js` 2 次、`./base.js` 2 次）。功能上没错，但：
 *   ① 读的人无法一眼看出这个模块究竟依赖谁；
 *   ② **重复 import 语句**在 ESM 里合法，但会掩盖"到底哪一个才是真的来源"。
 *
 * ★ 这次还漏了 node 内置模块（`path`）——因为我的补依赖脚本只会从 part2 的**符号表**里找，
 *   而 `import path from "node:path"` 是**默认导入**（不是命名导入），没进那张表。
 *   ★ 判据：**默认导入 / 命名空间导入（`import fs from` / `import * as x`）与命名导入是两张表，必须分别扫。**
 */
import fs from "node:fs";
import path from "node:path";

const NEW = path.resolve("lib/part2-tools.js");
let text = fs.readFileSync(NEW, "utf8");
const tmp = process.env.TEMP ?? ".";
fs.writeFileSync(path.join(tmp, `part2-tools-before-tidy-${Date.now()}.js`), text, "utf8");

// ── 1. 找到 import 区（第一个 import 到最后一个 import 结束） ────────────────
const importRe = /^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm;
const matches = [...text.matchAll(importRe)];
if (matches.length === 0) { console.log("🔴 没找到 import ⇒ 停"); process.exit(1); }

const firstIdx = matches[0].index;
const lastEnd = matches[matches.length - 1].index + matches[matches.length - 1][0].length;

// ── 2. 解析每一条 import：默认导入 / 命名导入 / 来源 ─────────────────────────
const defaultImports = new Map(); // name -> spec
const namedImports = new Map();   // spec -> Set(names)

for (const m of matches) {
  const stmt = m[0];
  const stripped = stmt.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const spec = /from\s+["']([^"']+)["']/.exec(stripped)?.[1];
  if (spec === undefined) continue;

  // 默认导入：`import X from "..."`
  const def = /^import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/.exec(stripped);
  if (def !== null && !/\{/.test(stripped.slice(0, stripped.indexOf("from")))) {
    defaultImports.set(def[1], spec);
  }

  // 命名导入：`import { a, b } from "..."`
  const brace = /\{([\s\S]*?)\}/.exec(stripped);
  if (brace !== null) {
    if (!namedImports.has(spec)) namedImports.set(spec, new Set());
    for (const raw of brace[1].split(",")) {
      const nm = raw.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) namedImports.get(spec).add(nm);
    }
  }
}

console.log("═══ 整理前 ═══");
console.log(`  import 语句 ${matches.length} 条`);
console.log(`  默认导入 ${defaultImports.size} 个：${[...defaultImports.entries()].map(([k, v]) => `${k}←${v}`).join(", ") || "（无）"}`);
console.log(`  命名导入来源 ${namedImports.size} 个模块`);
for (const [spec, set] of namedImports) console.log(`    ${spec}：${[...set].sort().join(", ")}`);

// ── 3. ★ 扫实现体里用到的**自由标识符**，判断还缺哪些（node 内置是重点） ────
const bodyStart = lastEnd;
const body = text.slice(bodyStart);
const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** 把已知名字全部剔掉，剩下的"裸标识符"可疑就是没导入的。 */
const known = new Set([...defaultImports.keys()]);
for (const set of namedImports.values()) for (const n of set) known.add(n);

// JS 关键字/全局白名单（避免误报）
const BUILTIN = new Set([
  "undefined", "null", "true", "false", "this", "typeof", "instanceof", "in", "of", "new",
  "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "try", "catch", "finally", "throw", "function", "const", "let", "var", "class", "async",
  "await", "yield", "delete", "void", "with", "debugger", "export", "import", "default",
  "Array", "Object", "String", "Number", "Boolean", "Math", "JSON", "Date", "RegExp",
  "Error", "TypeError", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "BigInt",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "console", "process",
  "Buffer", "URL", "URLSearchParams", "Intl", "Reflect", "Proxy", "globalThis",
  "arguments", "require", "module", "exports", "constructor", "prototype",
  // 本文件自己声明的四个 tool
  ...["definePrinciplesAccessTool", "defineProposePrincipleTool", "defineLessonsTool", "defineGoalsTool"],
]);

// 抓"看似标识符"的 token（排除属性访问 `.x` 与方法名 `x:`）
const candidates = new Set();
for (const m of codeOnly.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
  const n = m[1];
  if (BUILTIN.has(n) || known.has(n)) continue;
  candidates.add(n);
}

// 本地声明（函数内 const/let/function 参数等）也算已知 —— 用宽松判据：出现过 `const X` / `let X` / `function X` / 参数位置
const localDeclared = new Set();
for (const m of codeOnly.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) localDeclared.add(m[1]);
for (const m of codeOnly.matchAll(/\(([^)]*)\)\s*=>/g)) {
  for (const p of m[1].split(",")) {
    const nm = p.split("=")[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(nm)) localDeclared.add(nm);
  }
}
for (const m of codeOnly.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) {
  for (const p of m[1].split(",")) {
    const nm = p.split("=")[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(nm)) localDeclared.add(nm);
  }
}

const suspect = [...candidates].filter((n) => !localDeclared.has(n));

// node 内置的候选（按名字猜模块，再核对 part2 里怎么导的）
const P2 = fs.readFileSync(path.resolve("lib/part2.js"), "utf8");
const builtinMap = new Map();
for (const m of P2.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+["'](node:[^"']+)["'];/gm)) {
  builtinMap.set(m[1], m[2]);
}

console.log("\n═══ 可疑的未导入标识符（需判定）═══");
const needDefault = new Map();
const trulyMissing = [];
for (const n of suspect.sort()) {
  if (builtinMap.has(n)) {
    needDefault.set(n, builtinMap.get(n));
    console.log(`  ${n.padEnd(24)} ← node 内置（part2 里是默认导入，来自 ${builtinMap.get(n)}）`);
  } else {
    trulyMissing.push(n);
    console.log(`  ${n.padEnd(24)} 🔴 仍未解决`);
  }
}

// ── 4. 重写 import 区 ─────────────────────────────────────────────────────
const lines = [];
lines.push(`// ── node 内置 ───────────────────────────────────────────────────────────────`);
for (const [n, spec] of [...needDefault.entries()].sort()) {
  lines.push(`import ${n} from "${spec}";`);
}
if (needDefault.size === 0) lines.push(`// （无）`);
lines.push(``);
lines.push(`// ── 项目内模块 ─────────────────────────────────────────────────────────────────`);
const ORDER = ["./part2.js", "./base.js", "./defs.js", "./part1.js", "./part3.js", "./part4.js"];
const specs = [...namedImports.keys()].sort((a, b) => {
  const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a.localeCompare(b);
});
for (const spec of specs) {
  const names = [...namedImports.get(spec)].sort();
  if (names.length <= 4) {
    lines.push(`import { ${names.join(", ")} } from "${spec}";`);
  } else {
    lines.push(`import {`);
    for (const n of names) lines.push(`  ${n},`);
    lines.push(`} from "${spec}";`);
  }
}

const newImportBlock = lines.join("\n") + "\n";
const tidy = text.slice(0, firstIdx) + newImportBlock + text.slice(lastEnd);

fs.writeFileSync(NEW, tidy, "utf8");
console.log(`\n═══ 整理后 ═══`);
console.log(`  import 语句 ${lines.filter((l) => l.startsWith("import ")).length} 条`);
console.log(`  part2-tools.js = ${Buffer.byteLength(tidy, "utf8")} B`);
if (trulyMissing.length > 0) {
  console.log(`\n🔴 还有 ${trulyMissing.length} 个未解决：${trulyMissing.join(", ")}`);
  process.exit(1);
}
console.log("\nPROBE-COMPLETE");
