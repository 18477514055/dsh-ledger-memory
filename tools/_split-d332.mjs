/**
 * _split-d332.mjs —— 把 `part2.js` 里的四个 `define*Tool` **原样搬到 `part2-tools.js`**
 *
 * ★★★ 铁则（D307/D318/D319/D323/D326/D328 一贯口径）：
 *   **搬实现可以，改调用面不行。**
 *   ⇒ 在 `part2.js` 原位留 `export { … } from "./part2-tools.js"`，
 *     这样 `index.js` 等所有调用方**一个字都不用改**。
 *
 * ★ 为什么选这四个（数据说话，`_measure-d332-part2-clusters.mjs`）：
 *   - 合计 36,053 B（是 part2 的 15%）
 *   - 在 part2 内部被引用的次数 = **0**（只有 index.js 调它们）
 *   - 依赖 18 个名字**全是导出的函数声明** ⇒ 反向 import 安全、无 TDZ
 *
 * ★ 本脚本只做搬运，**不改任何一行实现体**（逐字节搬）。搬完立刻用哈希核一遍。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const P2 = path.resolve("lib/part2.js");
const NEW = path.resolve("lib/part2-tools.js");

const TARGETS = [
  "definePrinciplesAccessTool",
  "defineProposePrincipleTool",
  "defineLessonsTool",
  "defineGoalsTool",
];

const DEP_IMPORTS = {
  // 从 part2.js 反向 import 的 18 个依赖
  part2: [
    "buildGoalTree", "goalAgeOf", "goalStampMs", "goalTimeScope", "goalWeightBasis",
    "idPrefixOfType", "inspect", "kindsOfType", "parseGoalCards", "parseLessonEntries",
    "proposePrinciple", "recordGoalsChange", "registerGoalsInManifest", "renderGoalCard",
    "renderGoalTree", "renderLessonEntry", "upsertGoalCard", "writePrinciples",
  ],
};

const origText = fs.readFileSync(P2, "utf8");
const origLines = origText.split(/\r?\n/);
const beforeBytes = Buffer.byteLength(origText, "utf8");
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

// ── 备份 ───────────────────────────────────────────────────────────────────
const tmp = process.env.TEMP ?? ".";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const bak = path.join(tmp, `part2-before-d332-${stamp}.js`);
fs.writeFileSync(bak, origText, "utf8");
console.log(`备份：${bak}`);
console.log(`part2.js 原 ${beforeBytes} B / ${origLines.length} 行 · sha16=${sha(origText)}`);

// ── 1. 抓四个函数的完整体（大括号配平） ────────────────────────────────────
function grabFunction(name, lines) {
  const startIdx = lines.findIndex((l) => new RegExp(`^export\\s+function\\s+${name}\\b`).test(l));
  if (startIdx < 0) return null;
  let depth = 0, started = false;
  for (let i = startIdx; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth += 1; started = true; }
      else if (ch === "}") depth -= 1;
    }
    if (started && depth === 0) {
      return { start: startIdx, end: i + 1, body: lines.slice(startIdx, i + 1).join("\n") };
    }
  }
  return null;
}

const grabbed = [];
for (const t of TARGETS) {
  const g = grabFunction(t, origLines);
  if (g === null) {
    console.log(`🔴 抓不到 ${t} ⇒ 中止，不写任何文件`);
    process.exit(1);
  }
  grabbed.push({ name: t, ...g });
  console.log(`  抓取 ${t.padEnd(30)} 行 ${g.start + 1}~${g.end}  ${Buffer.byteLength(g.body, "utf8")} B`);
}

// ── 2. 也抓走紧邻它们的**前置注释块**（保持可读性，注释跟着实现走） ──────────
//   规则：从 start 往上，只要上一行是注释/空行且属于同一个注释块，就一起搬。
function extendUpward(lines, start) {
  let s = start;
  while (s > 0) {
    const prev = lines[s - 1];
    if (/^\s*(\/\/|\*|\/\*)/.test(prev) || prev.trim() === "") {
      // 遇到空行就停（空行是段落分隔）
      if (prev.trim() === "") break;
      s -= 1;
    } else break;
  }
  return s;
}
for (const g of grabbed) {
  const up = extendUpward(origLines, g.start);
  if (up !== g.start) {
    g.start = up;
    g.body = origLines.slice(g.start, g.end).join("\n");
    console.log(`  ${g.name} 连同上方 ${g.end - g.start} 行注释一起搬`);
  }
}

// ── 3. 逐字节校验：搬出去的每一段必须**原样**出现在原文里 ────────────────────
for (const g of grabbed) {
  if (!origText.includes(g.body)) {
    console.log(`🔴 ${g.name} 的抓取块在原文里找不到逐字匹配 ⇒ 中止（防手抖）`);
    process.exit(1);
  }
}
console.log(`  ✅ 四段全部与原文**逐字匹配**`);

// ── 4. 生成新模块 ─────────────────────────────────────────────────────────
const header = `/**
 * part2-tools.js —— 四个 \`ledger_*\` 工具的**定义体**（从 \`part2.js\` 原样搬出）
 *
 * ★ 为什么单独一个模块（D332）：\`part2.js\` 撞上了它自己 20 KB 的安全余量红线
 *   （241,272 B，距 241,664 只剩 392 B）。挑出来的是**最干净的一簇**：
 *   - 四个 \`define*Tool\` 合计 **36,053 B**
 *   - 它们在 \`part2.js\` 内部被引用 **0 次**（只有 \`index.js\` 调它们）
 *   - 依赖 18 个名字**全是导出的函数声明** ⇒ 反向 import 安全、无 TDZ 风险
 *
 * ★★ **调用面一个字都没改**：\`part2.js\` 原位留了
 *   \`export { defineGoalsTool, … } from "./part2-tools.js"\`
 *   ⇒ \`index.js\` 仍从 \`./part2.js\` import，行为完全不变。
 *
 * ★★★ **实现体是逐字节搬过来的**，没有重写、没有"顺手优化"。
 *   （判据：搬之前用 \`origText.includes(body)\` 校验过每一段。）
 *
 * ★ 关于循环依赖（这里**是**双向的，但合法）：
 *   \`part2-tools\` → import \`part2\`（拿 inspect 等 18 个）
 *   \`part2\`       → export…from \`part2-tools\`（转发四个 tool）
 *   ESM 允许这种环，**前提是顶层不求值**。已实测确认：四个 tool 体内没有 IIFE、
 *   没有顶层 await、没有顶层 new，18 个依赖也全是函数声明（提升）。
 *   ⇒ 调用发生在模块求值完成之后，拿到的永远是真身。
 */
import {
${DEP_IMPORTS.part2.map((n) => `  ${n},`).join("\n")}
} from "./part2.js";

`;

// ★ 别塞没用到的 import（`pathToFileURL` 只是我写抬头时的草稿残留，删掉）

const bodyText = grabbed.map((g) => g.body).join("\n\n");
const newText = header + bodyText + "\n";

fs.writeFileSync(NEW, newText, "utf8");
console.log(`\n新模块 part2-tools.js = ${Buffer.byteLength(newText, "utf8")} B / ${newText.split(/\r?\n/).length} 行`);

// ── 5. 从 part2.js 删掉那四段（**从后往前删**，避免行号漂移） ───────────────
const sortedDesc = [...grabbed].sort((a, b) => b.start - a.start);
let newLines = [...origLines];
for (const g of sortedDesc) {
  newLines.splice(g.start, g.end - g.start);
  console.log(`  删除 ${g.name.padEnd(30)} 行 ${g.start + 1}~${g.end}`);
}

// ── 6. 在 part2.js 里补上转发导出（放在文件末尾，附说明） ───────────────────
const forward = `
// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 2026-10-26（D332）：四个 \`define*Tool\` 已搬到 \`part2-tools.js\`
//
//   ★ 为什么：\`part2.js\` 撞上 20 KB 安全余量红线（241,272 B，距 241,664 只剩 392 B）。
//     012 那份补丁为了腾余量**删了 5 行注释**——那是消费注释，不是改结构；
//     用户 2026-10-26 拍板「先手动拆分吧，否则没地方加补丁」⇒ 走真拆。
//
//   ★★ **调用面一个字都没改**：这里用 \`export … from\` 转发，
//     \`index.js\` 仍然 \`from "./part2.js"\` import 这四个 tool，行为完全不变。
//     （判据：\`_probe-d323-f07-split.mjs\` 的 F-07② 就是在守这条——"9 个入口全部转发"。）
//
//   ★ 搬出去的实现体是**逐字节原样**的，没有重写：搬之前用
//     \`origText.includes(body)\` 逐段校验过。
// ═══════════════════════════════════════════════════════════════════════════
export {
  defineGoalsTool,
  defineLessonsTool,
  definePrinciplesAccessTool,
  defineProposePrincipleTool,
} from "./part2-tools.js";
`;

const finalText = newLines.join("\n").replace(/\s*$/, "\n") + forward;
fs.writeFileSync(P2, finalText, "utf8");

const afterBytes = Buffer.byteLength(finalText, "utf8");
console.log(`\n═══ 结果 ═══`);
console.log(`  part2.js       ${beforeBytes} B → ${afterBytes} B（净减 ${beforeBytes - afterBytes}）`);
console.log(`  part2-tools.js ${Buffer.byteLength(newText, "utf8")} B（新增）`);
console.log(`  part2.js 距 241,664 红线 = ${241664 - afterBytes} B（改前只有 392）`);
console.log(`  part2.js 距 262,144 硬限 = ${262144 - afterBytes} B`);
console.log(`  sha16: ${sha(origText)} → ${sha(finalText)}`);
console.log("\nDONE");
