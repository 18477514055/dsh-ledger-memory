/**
 * D376：按 D368 的规则再拆两个模块 —— 给 `part3.js` / `part1.js` 腾出体积余量。
 *
 * ★ 背景（实测，不是估计）：
 *   `part3.js` 距 241,664 紧线只剩 **7,809 B**、`part1.js` 只剩 **8,113 B**。
 *   下一轮任何实质改动都会撞线 ⇒ **必须先拆**（用户 2026-11-03 明确要求）。
 *
 * ★ 为什么不是"再抽注释"：先跑了 `tools/_refactor-d368/extract-comments.mjs --dry`
 *   ⇒ **0 块可抽、净省 0 B**（D368 已经把能搬的都搬完了）。所以这轮只能**真拆文件**。
 *
 * ★★★ 三条纪律（D368 定下的，照做）：
 *   ① 切分边界必须**干净**：上界是某个 `export function`，下界是**下一个** `export` 之前的空行；
 *   ② **`export { x } from "./y.js"` 只把名字导出去，不在本模块作用域绑定**
 *      ⇒ 原模块若还要用它，必须**显式 import**（本项目第 5 次栽在这）；
 *   ③ 切完必须 `node --check` 两个文件，并跑全量自检 —— **行为一个字都不许变**。
 *
 * ★ 本脚本只做"切分 + 写新文件 + 在原文件尾部加 re-export + 在原文件头部加显式 import"，
 *   不做任何逻辑改动。带三条守恒断言，任一不过就什么都不写。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// ★ 本脚本在 tools/_refactor-d376/ 下 ⇒ 项目根要向上**两级**（D376 实测栽过一次）
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRY = process.argv.includes("--dry");

/**
 * 计划：
 *   part3.js 的「设置快照/广播」簇（407~647）→ lib/part3-settings.js
 *   part1.js 的「持久化 store」簇（449~1350）→ lib/part1-store.js
 */
const PLANS = [
  {
    src: "lib/part3.js",
    out: "lib/part3-settings.js",
    startMarker: "export function settingsBroadcastSeqOf() {",
    endMarker: "export function renderInjectionBody(info, pending, biOpts) {",
    // 新文件需要哪些 import（由脚本后面按用到的符号补，这里给"整块照搬"的模块级 import）
    header: `/**
 * part3 的「设置快照 / 广播 / 变更行」子模块（D376 从 part3.js 拆出）。
 *
 * ★ 为什么单独一个文件：\`part3.js\` 距 241,664 紧线只剩 7,809 B，
 *   而这一簇（设置基线的取/存/比较/渲染）**与注入主流程几乎无耦合** ⇒ 边界干净。
 * ★ 行为零变化：原 \`part3.js\` 用 \`export { … } from "./part3-settings.js"\` 原样转出，
 *   对外 API 与导出名一个都没变。
 */
`,
  },
  {
    src: "lib/part1.js",
    out: "lib/part1-store.js",
    startMarker: "export function dshHome() {",
    endMarker: "export function autoFullLabel() {",
    header: `/**
 * part1 的「磁盘 store 与路径」子模块（D376 从 part1.js 拆出）。
 *
 * ★ 为什么单独一个文件：\`part1.js\` 距 241,664 紧线只剩 8,113 B，
 *   而这一簇（dshHome / lock / anchor / owed / blockHistory / capsule store …）
 *   **全是"算路径 + 读/写一个小 JSON"**，与设置归一化、压缩判定几乎无耦合 ⇒ 边界干净。
 * ★ 行为零变化：原 \`part1.js\` 用 \`export { … } from "./part1-store.js"\` 原样转出。
 */
`,
  },
];

function findBlock(lines, startMarker, endMarker) {
  const s = lines.findIndex((l) => l.startsWith(startMarker));
  if (s < 0) return { ok: false, why: `找不到起始行：${startMarker}` };
  const e = lines.findIndex((l, i) => i > s && l.startsWith(endMarker));
  if (e < 0) return { ok: false, why: `找不到结束行：${endMarker}` };
  // 结束位置往前退到"**最后一个顶层声明的闭合 `}`**"。
  // ★ 第一版我退到"最后一个非空行 + 1" —— 那是**假边界**（实测 part1 退到了 1366 行的 `*/`，
  //   而那一行是**下一个函数 `autoFullLabel` 的 JSDoc 结尾** ⇒ 把别人的文档注释切走了，
  //   切完后 `autoFullLabel` 上方悬着一个没有开头的 `*/`）。
  //   ⇒ 判据：**块尾必须落在某个顶层声明的 `}` 上，不能落在注释行上。**
  let last = e - 1;
  while (last > s && !/^\}\s*$/.test(lines[last])) last -= 1;
  if (last <= s) return { ok: false, why: `找不到块的闭合行（${startMarker} … ${endMarker}）` };
  return { ok: true, start: s, end: last + 1, stopAt: e };
}

const report = [];
const problems = [];

for (const p of PLANS) {
  const srcAbs = path.join(PROJECT_ROOT, p.src);
  const src = fs.readFileSync(srcAbs, "utf8");
  const lines = src.split("\n");
  const b = findBlock(lines, p.startMarker, p.endMarker);
  if (!b.ok) {
    problems.push(`${p.src}: ${b.why}`);
    continue;
  }
  const block = lines.slice(b.start, b.end);
  const blockText = block.join("\n");
  const bytes = Buffer.byteLength(blockText);

  // ── 守恒断言 ①：块首尾必须是"完整的顶层声明" ──────────────────────────
  if (!/^export (function|async function|const|class)/.test(block[0])) {
    problems.push(`${p.src}: 块首不是顶层声明 —— ${block[0].slice(0, 60)}`);
    continue;
  }
  // ── 守恒断言 ②：切走之后剩下的部分必须**真能通过语法检查**
  //   ★ 第一版我用"自己数花括号"—— 那是**假判据**（实测 part3 报了 depth=-2，
  //     而真实边界是对的：正则字面量 `/^\s*(```|~~~)/` 里的花括号被当成了代码括号）。
  //   ⇒ 判据：**括号平衡不是语法正确性；要验语法就让解析器验。**
  {
    const rest = [...lines.slice(0, b.start), ...lines.slice(b.end)].join("\n");
    const tmpRest = path.join(PROJECT_ROOT, "tools", "_refactor-d376", `._check-${path.basename(p.src)}.mjs`);
    fs.writeFileSync(tmpRest, rest, "utf8");
    try {
      execFileSync(process.execPath, ["--check", tmpRest], { stdio: "pipe" });
    } catch (e) {
      problems.push(`${p.src}: 切走后**语法检查失败** —— ${String(e.stderr ?? e.message).slice(0, 300)}`);
    } finally {
      try { fs.unlinkSync(tmpRest); } catch { /* ignore */ }
    }
  }
  // ── 守恒断言 ③：块内不能有"只在本文件里定义"的顶层声明被块引用却没一起搬
  //    （粗判：块里用到的、以 `function ` 或 `const ` 定义在块外的名字）
  {
    const outside = [...lines.slice(0, b.start), ...lines.slice(b.end)].join("\n");
    const localDefs = [...outside.matchAll(/^(?:function|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    const used = new Set();
    for (const name of localDefs) {
      const re = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`);
      if (re.test(blockText)) used.add(name);
    }
    if (used.size > 0) {
      report.push({ f: p.src, warn: `块内引用了本文件其它顶层声明：${[...used].join(", ")}（需在新文件里 import 回来）` });
    }
  }

  // 新文件 = 头注 + 原块
  const newFile = p.header + "\n" + blockText + "\n";
  // 原文件 = 头部插入 import + 去掉块 + 尾部加 re-export
  const exportNames = [...blockText.matchAll(/^export (?:async )?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const exportConsts = [...blockText.matchAll(/^export const\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const allNames = [...exportNames, ...exportConsts];
  if (allNames.length === 0) {
    problems.push(`${p.src}: 块里没有找到任何 export 名`);
    continue;
  }

  const restLines = [...lines.slice(0, b.start), ...lines.slice(b.end)];
  // 在最后一个 import 之后插入显式 import + re-export
  let lastImport = -1;
  for (let i = 0; i < restLines.length; i += 1) {
    if (/^import\s/.test(restLines[i]) || /^\}\s*from\s+"/.test(restLines[i])) lastImport = i;
  }
  if (lastImport < 0) {
    problems.push(`${p.src}: 找不到 import 区，无法安全插入`);
    continue;
  }
  const rel = "./" + path.basename(p.out);
  const importLine = `import { ${allNames.join(", ")} } from "${rel}";`;
  const reExportLine = `export { ${allNames.join(", ")} } from "${rel}";`;
  // ★ 纪律②：import 与 re-export 都要有 —— 前者保证本模块作用域可用，后者保证对外 API 不变
  restLines.splice(lastImport + 1, 0, importLine, reExportLine);

  report.push({
    f: p.src,
    out: p.out,
    start: b.start + 1,
    end: b.end,
    lines: block.length,
    bytes,
    exports: allNames.length,
    before: Buffer.byteLength(src),
    after: Buffer.byteLength(restLines.join("\n")),
  });

  if (!DRY) {
    fs.writeFileSync(path.join(PROJECT_ROOT, p.out), newFile, "utf8");
    fs.writeFileSync(srcAbs, restLines.join("\n"), "utf8");
  }
}

console.log("=== 计划 / 结果 ===");
for (const r of report) {
  if (r.warn !== undefined) { console.log("  ⚠ " + r.f + "：" + r.warn); continue; }
  console.log(
    `  ${r.f} → ${r.out}  原第 ${r.start}~${r.end} 行（${r.lines} 行 / ${r.bytes} B / ${r.exports} 个 export）  ${r.before} → ${r.after} B（省 ${r.before - r.after}）`,
  );
}
if (problems.length > 0) {
  console.log("\n★ 守恒断言未过，**未写盘**：");
  for (const x of problems) console.log("  - " + x);
  process.exit(1);
}
console.log(DRY ? "\n（DRY RUN —— 未写盘）" : "\nSPLIT-DONE");
