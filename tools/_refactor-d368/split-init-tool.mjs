/**
 * D368 切分：把 `defineInitTool`（84,486 B / 1,259 行）从 `lib/part4.js` 搬到 `lib/init-tool.js`。
 *
 * ★ 为什么挑它：
 *   ① 它是 part4 里**最大的一块**，占 34.8%；
 *   ② 它**零模块级声明依赖**（只吃 48 个 import 绑定）⇒ 可以原样搬，不需要搬变量；
 *   ③ 边界干净：上界是 `export function defineInitTool`，下界是空行 + 下一个 export 的文档注释。
 *
 * ★ 判据（本项目拆模块的固定动作，前四次都栽在第一条）：
 *   ① **re-export 不等于本模块可用** —— part4 里若还有人调 `defineInitTool`，必须**显式 import**；
 *   ② 搬完 `node --check` 两个文件都必须过；
 *   ③ 自检里**读 part4 源码文本**的断言会假红 ⇒ 必须把新模块并进它的读取面。
 */
import fs from "node:fs";
import path from "node:path";

const P4 = "lib/part4.js";
const OUT = "lib/init-tool.js";

const src = fs.readFileSync(P4, "utf8");
const lines = src.split("\n");

// ── 定位边界 ─────────────────────────────────────────────────────────
const sIdx = lines.findIndex((l) => l.startsWith("export function defineInitTool("));
if (sIdx < 0) throw new Error("找不到 export function defineInitTool");
// 上界：函数上方那一段 `/** … */` 文档注释（从 sIdx 往上，遇到非注释/非空行停）
let docStart = sIdx;
while (docStart > 0 && /^\s*(\*|\/\*\*|\*\/)/.test(lines[docStart - 1])) docStart -= 1;
// 下界：函数体结束（第一处顶格 `}`）
let eIdx = -1;
for (let i = sIdx; i < lines.length; i += 1) {
  if (lines[i] === "}") { eIdx = i; break; }
}
if (eIdx < 0) throw new Error("找不到 defineInitTool 的结束大括号");

const fnText = lines.slice(docStart, eIdx + 1).join("\n");
console.log(`搬走范围：第 ${docStart + 1} ~ ${eIdx + 1} 行，${eIdx - docStart + 1} 行，${Buffer.byteLength(fnText, "utf8")} B`);

// ── 检查 part4 里还有没有别处调 defineInitTool ──────────────────────
const rest = [...lines.slice(0, docStart), ...lines.slice(eIdx + 1)].join("\n");
const callSites = [...rest.matchAll(/defineInitTool\s*\(/g)].length;
console.log(`part4 剩余部分引用 defineInitTool 的次数：${callSites}`);

// ═══════════════════════════════════════════════════════════════════════
// 生成 lib/init-tool.js
// ═══════════════════════════════════════════════════════════════════════
const header = `/**
 * ledger_init 工具的定义 —— 从 \`part4.js\` 拆出来（D368）。
 *
 * ★ 为什么单独一个文件（不是审美）：
 *   \`part4.js\` 在 D367 之后 **242,971 B > 241,664 紧线**（DSH STORE 单文件硬上限 262,144）。
 *   本项目自检里那条注释写得对：**接近上限时应当拆文件，而不是把注释删到刚好压线**。
 *
 * ★ 为什么挑这一块：
 *   ① 它是 part4 里最大的一块（84,486 B ≈ 34.8%）；
 *   ② **零模块级声明依赖** —— 它只吃 import 绑定，不碰 part4 里的任何局部变量
 *      ⇒ 可以**原样搬**，不需要连带搬状态（这是最不容易搬错的一类）。
 *
 * ★★★ 拆模块的固定坑（本项目前四次都栽在同一处）：
 *   **re-export 只把名字导出去，不会在本模块作用域绑定它。**
 *   所以 \`part4.js\` 若还要调 \`defineInitTool\`，必须**显式再 import 一次** —— 见那边的注释。
 */

`;

// 只带它真正用到的 import —— 从 part4 的 import 语句里按名字筛
const part4Imports = lines.slice(0, docStart).filter((l) => /^import\s/.test(l));
// 收集依赖名（复用依赖分析结果：48 个）
const NEEDED = [
  "DEFAULT_IGNORE_LINES", "MANIFEST_REL", "OK_SCHEMA", "PROTOCOL_REQUIREMENTS", "PROTOCOL_VERSION",
  "ROOT_PARAM", "bumpRevision", "cardDirLabel", "cardModeOf", "clearProjectCache", "currentSettings",
  "defaultLogLevels", "ensureDir", "ensureProjectId", "fail", "git", "gitAdd", "inspect",
  "isAbsoluteAnywhere", "isUnder", "isUnderReal", "listCards", "lossless", "manifestRevision",
  "memoryRootIgnoreLines", "mergeGitignore", "migrateToV3", "name", "parseLevels", "path",
  "precedenceIsProject", "precedenceValue", "readManifest", "renderResult", "rootFromExec",
  "satisfiedProtocolVersion", "shouldAutoStage", "skeletonOf", "splitIntoCardParts",
  "stageOutcomeOf", "stamp", "syncManifestMirror", "toGitRel", "writeCard", "writeCardIndex",
  "writeFileAtomic", "writeSecurityMd", "fs",
];

// 按 import 源分组重建
const bySrc = new Map();
for (const line of part4Imports) {
  const m = /^import\s+([\s\S]*?)\s+from\s+"([^"]+)";$/.exec(line.trim());
  if (m === null) continue;
  const [, spec, from] = m;
  const names = new Set();
  const brace = /\{([\s\S]*?)\}/.exec(spec);
  if (brace) {
    for (const p of brace[1].split(",")) {
      const t = p.trim();
      if (t === "") continue;
      const asM = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(t);
      names.add(asM ? asM[2] : t);
    }
  }
  const defM = /^([\w$]+)\s*(?:,|$)/.exec(spec.trim());
  if (defM && !spec.trim().startsWith("{")) names.add(defM[1]);
  if (!bySrc.has(from)) bySrc.set(from, new Set());
  for (const n of names) bySrc.get(from).add(n);
}

const importLines = [];
let missing = [];
for (const n of NEEDED) {
  let found = false;
  for (const [, names] of bySrc) if (names.has(n)) { found = true; break; }
  if (!found) missing.push(n);
}
for (const [from, names] of bySrc) {
  const mine = NEEDED.filter((n) => names.has(n));
  if (mine.length === 0) continue;
  // 默认导入（fs / path）单独处理
  if (from.startsWith("node:") && mine.some((n) => n === "fs" || n === "path")) {
    for (const d of mine.filter((n) => n === "fs" || n === "path")) importLines.push(`import ${d} from "${from}";`);
    const named = mine.filter((n) => n !== "fs" && n !== "path");
    if (named.length > 0) importLines.push(`import { ${named.join(", ")} } from "${from}";`);
  } else {
    importLines.push(`import { ${mine.join(", ")} } from "${from}";`);
  }
}
if (missing.length > 0) console.log(`⚠ 这些依赖在 part4 的 import 里找不到：${missing.join(" ")}`);

const out = `${header}${importLines.join("\n")}\n\n${fnText}\n`;
fs.writeFileSync(OUT, out, "utf8");
console.log(`\n已写 ${OUT}：${Buffer.byteLength(out, "utf8")} B`);

// ═══════════════════════════════════════════════════════════════════════
// 改写 part4.js：删掉这一段，改成显式 import
// ═══════════════════════════════════════════════════════════════════════
const newLines = [...lines.slice(0, docStart), ...lines.slice(eIdx + 1)];
let newP4 = newLines.join("\n");

// 在 card-ops 那条 import 语句之后插入 init-tool 的 import
const anchor = 'export { sliceEntryByKey, entryTocOf } from "./card-ops.js";';
if (!newP4.includes(anchor)) throw new Error("找不到插入锚点");
newP4 = newP4.replace(
  anchor,
  `${anchor}

// ★★★★ 2026-10-30（D368）：\`defineInitTool\` 已搬到 \`lib/init-tool.js\`（part4 超紧线）。
//   🔴 **必须显式 import，不许只 re-export** —— 这是本项目拆模块栽过四次的同一个坑：
//     \`export { defineInitTool } from "./init-tool.js";\` 只把名字**导出去**，
//     **不会**在本模块作用域绑定它；而 \`index.js\` 若经由 part4 取它，就必须这里有真绑定。
//   ★ 本次实测 \`callSites=${callSites}\` —— part4 内部没有别处调它，但 re-export 仍需保留
//     给外部调用方（\`index.js\` / 自检都按名字从这里取）。
import { defineInitTool } from "./init-tool.js";
export { defineInitTool } from "./init-tool.js";`,
);

fs.writeFileSync(P4, newP4, "utf8");
console.log(`已改写 ${P4}：${Buffer.byteLength(newP4, "utf8")} B（原 ${Buffer.byteLength(src, "utf8")} B）`);
console.log("SPLIT-DONE");
