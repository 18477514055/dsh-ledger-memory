/**
 * _tidy-d332-imports2.mjs —— 整理 import + 补 node 内置，**不做静态猜**
 *
 * ★ 我上一版栽在哪（第 7 处尺子错，记下来）：
 *   我想"静态扫出所有自由标识符"，可实现体里有**大量英文散文**（工具描述、注释里的
 *   `This / You / Never / requires` …）⇒ 一次报出 **284 个"未解决"**，其中真缺的只有 8 个。
 *   ★ 判据：**"扫出可疑"不是"找出缺失"** —— 静态扫描在含自然语言的文件上信噪比极低。
 *
 * ★ 正确做法：**让运行时告诉我**。注释掉可疑 import → 真跑 → 只信 `X is not defined`。
 *   这也是本项目一贯的纪律：**能实测就别推断**。
 *
 * 本脚本做两件事：
 *   ① 合并整理已有的 import（同模块多条 → 一条），**一个名字都不删**
 *   ② 补上 node 内置（`path`）——这个用"实现体里有没有 `path.` 用法"判定，是硬判据
 */
import fs from "node:fs";
import path from "node:path";

const NEW = path.resolve("lib/part2-tools.js");
let text = fs.readFileSync(NEW, "utf8");
const tmp = process.env.TEMP ?? ".";
fs.writeFileSync(path.join(tmp, `part2-tools-before-tidy2-${Date.now()}.js`), text, "utf8");

// ── 1. 解析现有 import ────────────────────────────────────────────────────
const importRe = /^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm;
const matches = [...text.matchAll(importRe)];
const firstIdx = matches[0].index;
const lastEnd = matches[matches.length - 1].index + matches[matches.length - 1][0].length;

const defaultImports = new Map();
const namedImports = new Map();

for (const m of matches) {
  const stripped = m[0].replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const spec = /from\s+["']([^"']+)["']/.exec(stripped)?.[1];
  if (spec === undefined) continue;
  const beforeFrom = stripped.slice(0, stripped.indexOf("from"));
  // 默认导入（`import X from` / `import X, {…} from`）
  const def = /^import\s+([A-Za-z_$][\w$]*)\s*(,|$)/.exec(beforeFrom.trim());
  if (def !== null) defaultImports.set(def[1], spec);
  // 命名导入
  const brace = /\{([\s\S]*?)\}/.exec(stripped);
  if (brace !== null) {
    if (!namedImports.has(spec)) namedImports.set(spec, new Set());
    for (const raw of brace[1].split(",")) {
      const nm = raw.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) namedImports.get(spec).add(nm);
    }
  }
}

// ── 2. 补 node 内置：**用硬判据**（实现体里有没有 `path.xxx` / `fs.xxx` 用法） ──
const bodyText = text.slice(lastEnd);
const NODE_BUILTINS = [
  { name: "path", spec: "node:path", usage: /\bpath\.(?:join|resolve|dirname|basename|relative|isAbsolute|sep|extname|normalize)\b/ },
  { name: "fs", spec: "node:fs", usage: /\bfs\.(?:existsSync|readFileSync|writeFileSync|mkdirSync|readdirSync|statSync|lstatSync|rmSync|copyFileSync|unlinkSync|renameSync)\b/ },
  { name: "os", spec: "node:os", usage: /\bos\.(?:tmpdir|homedir|platform)\b/ },
];
for (const b of NODE_BUILTINS) {
  if (b.usage.test(bodyText) && !defaultImports.has(b.name)) {
    defaultImports.set(b.name, b.spec);
    console.log(`  补 node 内置：${b.name} ← ${b.spec}（实现体里确有 ${b.name}. 用法）`);
  }
}

// ── 3. 重写 import 区（**一个名字都不删**，只合并） ─────────────────────────
const out = [];
out.push("// ── node 内置 ───────────────────────────────────────────────────────────────");
for (const [n, spec] of [...defaultImports.entries()].sort()) out.push(`import ${n} from "${spec}";`);
out.push("");
out.push("// ── 项目内模块（`part2.js` 是**反向**依赖：拿 inspect / renderGoalTree 等实现）──────");
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
  if (names.length <= 4) out.push(`import { ${names.join(", ")} } from "${spec}";`);
  else {
    out.push(`import {`);
    for (const n of names) out.push(`  ${n},`);
    out.push(`} from "${spec}";`);
  }
}

const newBlock = out.join("\n") + "\n";
const tidy = text.slice(0, firstIdx) + newBlock + text.slice(lastEnd);
fs.writeFileSync(NEW, tidy, "utf8");

console.log(`\n═══ 整理结果 ═══`);
console.log(`  import 语句：${matches.length} → ${out.filter((l) => l.startsWith("import ")).length} 条`);
console.log(`  默认导入：${[...defaultImports.entries()].map(([k, v]) => `${k}←${v}`).join(", ") || "（无）"}`);
for (const spec of specs) console.log(`  ${spec}：${[...namedImports.get(spec)].sort().join(", ")}`);
console.log(`  part2-tools.js = ${Buffer.byteLength(tidy, "utf8")} B`);
console.log("\nPROBE-COMPLETE");
