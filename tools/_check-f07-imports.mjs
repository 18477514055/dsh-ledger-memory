/**
 * _check-f07-imports.mjs —— 搬完之后**机械核对 import 头**：凡是用到却没绑定的名字，全列出来。
 *
 * ★ 为什么必须机器查：我第一版 import 头是**手写的**，漏了 `setActiveSettings`，
 *   而漏一个的后果是运行时 `ReferenceError` —— 被外层 `try/catch` 吞掉后表现为
 *   "保存成功却没有 settings 字段"。**看着像行为变了，其实是少了一个 import。**
 *   （本项目那条老规矩：**"函数名+行号"看起来最硬，却最容易凭印象编 —— 报之前必须核一次**。）
 *
 * ★★ 第一版扫描器报出 98 个假名字 —— 因为它把**字符串字面量**（`"application/json"`）、
 *   属性名（`.end`）、关键字都当成了标识符。判据错在"没先剥掉不是代码的部分"。
 *   ⇒ 现在先剥离 ①②字符串 ③注释 ④正则字面量，再扫标识符。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = process.argv[2] ?? "lib/settings-http.js";
const text = fs.readFileSync(path.join(ROOT, FILE), "utf8");
const lines = text.split("\n");

/** 剥离字符串 / 注释 / 正则，保留换行（行号仍对得上）。 */
function stripNonCode(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === q) {
          i++;
          break;
        }
        if (src[i] === "\n") out += "\n";
        i++;
      }
      out += " "; // 占位，避免两侧标识符粘连
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const code = stripNonCode(text);
const codeLines = code.split("\n");

// 收集 import 绑定的名字（★ 必须支持**多行 import**：
//   第一版只处理单行，于是 `import {\n A,\n B,\n} from "…"` 里的名字一个都没绑上 ⇒
//   它们全被报成"用到却没绑定"（11 个假警报）；而我为了让假警报消失把名字塞进 GLOBALS，
//   又反过来把真正漏绑的 `setActiveSettings` 一起吞掉 ⇒ **一次修尺子造成两个错**。
//   ⇒ 现在按"从 import 关键字起，到含 from 的那一行止"整段解析。）
const bound = new Set();
{
  const importRe = /import\s+(?:(\w+)\s*,\s*)?(?:\{([^}]*)\}|(\w+))?\s*from\s*["'][^"']+["']/g;
  let m;
  while ((m = importRe.exec(text)) !== null) {
    if (m[1]) bound.add(m[1]); // default import
    if (m[3]) bound.add(m[3]); // namespace/default 单名
    if (m[2]) {
      for (const x of m[2].split(",")) {
        const t = x.trim().split(/\s+as\s+/).pop().trim();
        if (t) bound.add(t);
      }
    }
  }
}

// 本文件自己声明的名字（顶层 + 参数 + 局部）
const local = new Set();
for (const l of codeLines) {
  for (const m of l.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  for (const m of l.matchAll(/function\s+\w+\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(",")) {
      const t = p.trim().split(/[=:\s]/)[0];
      if (t) local.add(t);
    }
  }
  for (const m of l.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const p of m[1].split(",")) {
      const t = p.trim().split(/[=:\s]/)[0];
      if (t) local.add(t);
    }
  }
  // catch (e)
  for (const m of l.matchAll(/catch\s*\(\s*(\w+)/g)) local.add(m[1]);
}

const GLOBALS = new Set(
  ("process console JSON Math Date String Number Boolean Object Array Promise RegExp Error Map Set Symbol BigInt " +
    "Buffer globalThis this super return function async await true false null undefined NaN Infinity typeof " +
    "instanceof in of new delete void setTimeout clearTimeout URL parseInt parseFloat isNaN encodeURIComponent " +
    "decodeURIComponent")
    .split(/\s+/)
);
// ★ GLOBALS **只放语言内建**。`fs` / `path` 之类必须真的由 import 绑上 ——
//   把它们算成"全局"会掩盖真正的漏 import（我就是这么把 setActiveSettings 放过去的）。
const KEYWORDS = new Set(
  ("import from export default const let var function class return if else for while do switch case break continue " +
    "try catch finally throw new typeof instanceof in of delete void this super async await yield")
    .split(/\s+/)
);

// ★★★ 2026-10-25（D323）：**状态机必须在「原文」上跑，不能在「剥离后」跑**。
//
//   🔴 我第一版在 stripNonCode 之后的文本上判 `from "…"` —— 但剥离已经把字符串清空，
//     `from "node:fs"` 变成了 `from  ;` ⇒ `/from\s*["']/` **永不命中** ⇒ `inImport`
//     **从 L20 起永久为 true** ⇒ 文件后半段**整段被跳过** ⇒ 漏绑的 `setActiveSettings`
//     永远不会被发现 ⇒ 报「✅ 全绿」。
//   ★ 这正是本项目纪律第 4 条：**剥离用的标记，绝不能出现在被剥离的内容里**。
//     "import 到哪结束"这个判据依赖引号，而引号正是被剥掉的东西。
//   ⇒ 现在：**原文**上跑状态机，只在"判断标识符是否被使用"时才用剥离后的文本。
const importRanges = []; // [startLine, endLine] 1-based
{
  let inImp = false;
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!inImp && /^\s*import\b/.test(l)) {
      inImp = true;
      start = i + 1;
    }
    if (inImp && /from\s*["'][^"']*["']/.test(l)) {
      importRanges.push([start, i + 1]);
      inImp = false;
    }
    // `import "x";` 形式的副作用 import
    if (inImp && /^\s*import\s*["'][^"']*["']\s*;?\s*$/.test(l)) {
      importRanges.push([start, i + 1]);
      inImp = false;
    }
  }
}
const inImportRange = (ln) => importRanges.some(([a, b]) => ln >= a && ln <= b);

const used = new Map();
for (let i = 0; i < codeLines.length; i++) {
  const ln = i + 1;
  if (inImportRange(ln)) continue; // 按**原文**行号跳过整段 import
  if (/^\s*export\s*\{/.test(codeLines[i])) continue;
  const raw = codeLines[i];
  for (const m of raw.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const id = m[0];
    if (KEYWORDS.has(id) || GLOBALS.has(id) || bound.has(id) || local.has(id)) continue;
    const idx = m.index;
    if (idx > 0 && raw[idx - 1] === ".") continue; // 属性名 a.b
    // ★ 对象字面量的键（`kind:` / `ok:`）不是变量引用
    const after = raw.slice(idx + id.length).trimStart();
    if (after.startsWith(":") && !after.startsWith("::")) continue;
    if (!used.has(id)) used.set(id, ln);
  }
}

const missing = [...used.entries()].sort((a, b) => a[1] - b[1]);
if (missing.length === 0) {
  console.log(`✅ ${FILE}：没有「用到却没绑定」的名字`);
} else {
  console.log(`🔴 ${FILE}：用到但**没有绑定**的名字（${missing.length}）：`);
  for (const [nm, ln] of missing) console.log(`   ${String(ln).padStart(5)}  ${nm}`);
}
process.exit(missing.length === 0 ? 0 : 1);
