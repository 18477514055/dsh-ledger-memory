// ═══════════════════════════════════════════════════════════════════════════
// D216 · 拆分前的**精确**侦察：顶层声明边界 + 跨引用 + **急切依赖**（TDZ 风险）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么要自己写一个（不直接用 `_probe-d216-split-plan.mjs`）：
//   那个探针报的"字节"其实是 **UTF-16 字符数**（795455），真字节是 **1199787** —— 差 1.5 倍
//   （中文 3 字节/字符）⇒ ★ **尺子错，不能拿它装箱**（本项目纪律 7）。
//   本文件一律用 `Buffer.byteLength(…, "utf8")`。
//
// ★ 它回答三个问题（拆分必需的）：
//   ① 每个顶层声明占多少**真字节**（好装箱）；
//   ② 它引用了哪些**别的顶层符号**（好写 import）；
//   ③ ★★★ 它**在模块初始化时就求值**吗（急切依赖）—— 这决定 TDZ 会不会炸：
//      函数声明会提升 ⇒ 循环引用里也能安全调用；
//      **`const X = f()` 这类"顶层立刻求值"的，跨模块循环引用就会炸 TDZ**
//      （本文件把这类单独报出来，它们是拆分唯一真正的雷）。
//
// 用法：node tools/_probe-d216-decl-scan.mjs [--json]
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

const LIB = path.join(process.cwd(), "lib", "index.js");
const src = fs.readFileSync(LIB, "utf8");
const lines = src.split("\n");
const B = (a, b) => Buffer.byteLength(lines.slice(a - 1, b).join("\n"), "utf8");

/**
 * 粗略但够用的词法剥离：去掉注释与字符串/模板/正则，只留下**可判括号的骨架**。
 * ★ 为什么必须剥离：`"}"`、`"{"`、注释里的括号都会把栈搞乱（第一版没剥离 ⇒ 边界全错）。
 */
function skeleton(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  let prev = ""; // 上一个非空白字符（用来判 `/` 是除号还是正则）
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i += 1;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === q) {
          i += 1;
          break;
        }
        // 模板里的 ${…} 也算字符串，不判括号（够用：它们不跨语句边界）
        i += 1;
      }
      out += "S"; // 字符串占位（保持长度无关，只求括号正确）
      prev = "S";
      continue;
    }
    if (c === "/" && /[=(,:[!&|?{};+\-*%<>~^]/.test(prev) === true) {
      // 正则字面量
      i += 1;
      let inClass = false;
      while (i < n) {
        const d = text[i];
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          i += 1;
          break;
        } else if (d === "\n") break;
        i += 1;
      }
      out += "R";
      prev = "R";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

const skel = skeleton(src);
// ★ 骨架可能因剥离与原文长度不同 ⇒ 用**按行**的骨架来切行号。
const skelLines = skeleton(src).split("\n");

// ── 找出**顶层**声明的行号（骨架里花括号深度为 0 处）─────────────────────────
const depthOf = new Array(skelLines.length).fill(0);
let d = 0;
for (let i = 0; i < skelLines.length; i += 1) {
  depthOf[i] = d;
  for (const ch of skelLines[i]) {
    if (ch === "{") d += 1;
    else if (ch === "}") d -= 1;
  }
}
// 声明起点：depth===0 且形如 function/const/let/var/class/export
const declRe = /^(export\s+)?(async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
const starts = [];
for (let i = 0; i < lines.length; i += 1) {
  if (depthOf[i] !== 0) continue;
  const m = declRe.exec(lines[i]);
  if (m !== null) starts.push({ line: i + 1, kind: m[3], name: m[4] });
}

/** 声明结束行 = 下一个顶层声明之前，回溯到最后一个非空行。 */
const decls = [];
for (let k = 0; k < starts.length; k += 1) {
  const s = starts[k];
  const nextLine = k + 1 < starts.length ? starts[k + 1].line : lines.length + 1;
  // 从 nextLine-1 往回找最后一行属于"本声明"的（深度回到 0 之后）
  let end = nextLine - 1;
  // 若下一条声明前有注释，把注释归给下一条 —— 这里保守：只取到下一个声明前
  while (end > s.line && lines[end - 1].trim() === "") end -= 1;
  decls.push({ ...s, end, bytes: B(s.line, end) });
}

// ── 引用分析：某声明体里出现了哪些**别的**顶层符号名 ─────────────────────────
const names = new Set(decls.map((x) => x.name));
for (const rec of decls) {
  const body = lines.slice(rec.line - 1, rec.end).join("\n");
  const refs = new Set();
  for (const nm of names) {
    if (nm === rec.name) continue;
    // 词边界匹配（避开属性访问 `.name` 的多数情况，保守多报）
    const re = new RegExp(`(?<![\\w$.])${nm.replace(/[$]/g, "\\$")}\\b`, "g");
    if (re.test(body)) refs.add(nm);
  }
  rec.refs = [...refs];
}

// ── ★★★ 急切依赖：顶层初始化时就求值的声明 ──────────────────────────────────
//   判据：声明**不是函数/类**，且它的初始化表达式里**调用了**别的顶层符号。
//   （`const X = 5` 这种字面量不算；`const X = f()` / `const X = new Y()` / `const X = f(g())` 算。）
function eagerDeps(rec) {
  if (rec.kind === "function" || rec.kind === "class") return [];
  const body = lines.slice(rec.line - 1, rec.end).join("\n");
  // 去掉注释与字符串
  const noStr = body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  const out = [];
  for (const r of rec.refs) {
    if (new RegExp(`\\b${r.replace(/[$]/g, "\\$")}\\s*\\(`).test(noStr)) out.push(r);
  }
  return out;
}
for (const rec of decls) rec.eager = eagerDeps(rec);

const total = B(1, lines.length);
console.log(`文件：${LIB}`);
console.log(`真字节：${total}（上限 262144）· 行数 ${lines.length}`);
console.log(`顶层声明：${decls.length} 个\n`);

const byKind = {};
for (const r of decls) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
console.log("按种类：", JSON.stringify(byKind));

const eagerAll = decls.filter((r) => r.eager.length > 0);
console.log(`\n★ 急切求值的顶层声明（**拆分唯一真正的雷**）：${eagerAll.length} 个`);
for (const r of eagerAll) {
  console.log(`  L${r.line}-${r.end}  ${r.kind} ${r.name}  (${r.bytes} B)  ⇒ 初始化时调用: ${r.eager.join(", ")}`);
}

// ── 输出给"装箱"用的清单 ────────────────────────────────────────────────────
const outPath = path.join(process.cwd(), "tools", "_d216-decls.json");
fs.writeFileSync(outPath, JSON.stringify(decls, null, 1), "utf8");
console.log(`\n清单已写：${outPath}（${decls.length} 条，供装箱脚本读）`);
