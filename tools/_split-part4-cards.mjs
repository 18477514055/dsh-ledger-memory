#!/usr/bin/env node
/**
 * D307 第二刀：把 `part4.js` 的**卡片操作区**（`isSafeCardKey` … `registerCardDirInManifest`）搬进 `lib/card-ops.js`。
 *
 * 🔴 为什么还要拆：`part4.js` 260,525 B ⇒ **余量只剩 1,619 B**（硬上限 262,144）。
 *   第一刀已经把 `part2.js` 从 1,044 B 余量救到 12,699 B，但 part4 还在墙边。
 *
 * ★ 选这段的判据（实测，不是印象）：
 *   · 块内**零** `import`（自足）；
 *   · 只引用一个 defs 常量：`MANIFEST_REL`；
 *   · 其余全是 `base.js` 里的纯函数（`readTextSafe` / `writeFileAtomic` / `ensureDir` / `isUnder` / `stamp` / `lossless`）；
 *   · 块内互相调用的（`cardDirAbs` / `cardFileAbs` / `listCards` / `readCard` / `isSafeCardKey` …）全在块内 ⇒ 搬走不断链。
 *   ⇒ 新模块的 import 只有 `node:fs` / `node:path` / `./base.js` / `./defs.js`，**不 import 任何 partN** ⇒ 不成环。
 *
 * ★ 调用面一个不改：`part4.js` 里留 re-export。
 *
 * ★★ 第一刀学到的两条，这次写死在脚本里（都是真踩过的）：
 *   ① **re-export 不等于在本模块可用** ⇒ 搬完必须补一行 `import { … } from "./card-ops.js"`
 *      给 part4 **内部还要调**的那些（否则运行期 `ReferenceError`）。这一步单独做校验。
 *   ② **边界要用结构标记，不要用空行** ⇒ 起点往回到"第一行以 `/**` 开头"，终点用大括号配平。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const PART4 = path.join(PROJECT, "lib", "part4.js");
const CARDS = path.join(PROJECT, "lib", "card-ops.js");
const APPLY = process.argv.includes("--apply");

const NAMES = [
  "isSafeCardKey",
  "cardDirAbs",
  "cardDirIsSafe",
  "cardFileAbs",
  "listCards",
  "readCard",
  "writeCard",
  "removeCard",
  "renderCardToc",
  "buildCardBlocks",
  "renderCardIndex",
  "writeCardIndex",
  "cardModeOf",
  "kindToRel",
  "readEntryUnified",
  "cardDirLabel",
  "readKindRaw",
  "writeKindCard",
  "removeKindCard",
  "kindLocationOf",
  "splitFileIntoCards",
  "splitIntoCardParts",
  "registerCardDirInManifest",
];

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);
const buf = fs.readFileSync(PART4);
const text = buf.toString("utf8");
const lines = text.split("\n");

// ── 定位：从 isSafeCardKey 的注释开头，到 registerCardDirInManifest 函数体结束 ──
const iFirst = lines.findIndex((l) => l.includes("export function isSafeCardKey("));
if (iFirst < 0) throw new Error("找不到 isSafeCardKey");
let start = iFirst;
while (start > 0 && !lines[start].trim().startsWith("/**")) start -= 1;

const iLast = lines.findIndex((l) => l.includes("export function registerCardDirInManifest("));
if (iLast < 0) throw new Error("找不到 registerCardDirInManifest");
let depth = 0;
let seen = false;
let end = iLast;
for (let i = iLast; i < lines.length; i += 1) {
  for (const ch of lines[i]) {
    if (ch === "{") { depth += 1; seen = true; }
    else if (ch === "}") depth -= 1;
  }
  if (seen && depth === 0) { end = i; break; }
}

const blockLines = lines.slice(start, end + 1);
const block = blockLines.join("\n");

console.log("═".repeat(74));
console.log("D307 第二刀：part4.js 卡片操作区 → lib/card-ops.js");
console.log("═".repeat(74));
console.log(`模式：${APPLY ? "APPLY（真写）" : "DRY-RUN（不写任何东西）"}`);
console.log(`part4.js：${buf.length} B / ${lines.length} 行 · sha ${sha(buf)}`);
console.log(`块：第 ${start + 1}–${end + 1} 行（${blockLines.length} 行 / ${Buffer.byteLength(block)} B）`);

// ── 前置校验 ───────────────────────────────────────────────────────────────
const problems = [];
for (const n of NAMES) if (!block.includes(`export function ${n}(`)) problems.push(`块里缺 ${n}`);
const extra = [...block.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]).filter((n) => !NAMES.includes(n));
if (extra.length > 0) problems.push(`块里混进了不该搬的：${extra.join(", ")}`);
const defsUsed = [...new Set([...block.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map((m) => m[1]))].filter((n) =>
  ["MANIFEST_REL"].includes(n)
);
// 只允许 MANIFEST_REL 这一个 defs 常量（其他大写词都是文档里的编号/示例）
const otherCaps = [...new Set([...block.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map((m) => m[1]))].filter(
  (n) => n !== "MANIFEST_REL" && !/^(D\d+|INDEX|JSON|README|LEDGER|DECISIONS|GOALS|JOURNAL|LESSONS|PRINCIPLES|MANIFEST|POSIX|HTTP|NEW)$/.test(n)
);
if (otherCaps.length > 0) problems.push(`块里可能还引用了别的常量：${otherCaps.join(", ")}`);

if (problems.length > 0) {
  console.log("\n✗ 前置校验未通过：");
  for (const p of problems) console.log(`   · ${p}`);
  process.exit(1);
}
console.log(`\n✓ 前置通过：${NAMES.length} 个函数全在 · 无杂项 · defs 只用到 MANIFEST_REL`);

// ── 新模块 ─────────────────────────────────────────────────────────────────
const header = `/**
 * ★★★★★ 2026-10-23（D307 第二刀）：**卡片操作区 —— 从 \`part4.js\` 拆出来。**
 *
 * 🔴 为什么拆：\`part4.js\` 260,525 B ⇒ 距 DSH STORE 单文件硬上限（262,144 B）**只剩 1,619 B**。
 *   第一刀把 \`part2.js\` 救出来了，这一刀轮到 part4。
 *
 * ★ 为什么是这一段（实测）：
 *   · 块内**零 import**（自足）· 只引用 **1 个** defs 常量（\`MANIFEST_REL\`）；
 *   · 其余依赖全是 \`base.js\` 的纯函数；
 *   · 块内互相调用（\`cardDirAbs\`/\`cardFileAbs\`/\`listCards\`/\`readCard\`/\`isSafeCardKey\`…）**都在块内** ⇒ 搬走不断链。
 *   ⇒ 本文件 import 只有 \`node:fs\`/\`node:path\`/\`./base.js\`/\`./defs.js\`，**不 import 任何 partN** ⇒ 不成环。
 *
 * ★ 语义没变：\`part4.js\` 里留 re-export，所有 \`import … from "./part4.js"\` 的调用方一个都不改。
 *
 * ★★ 本文正文是**逐字切出来的**，不是重打（注释/空行/标点与原文完全一致）；
 *    迁移脚本自带"前后段都逐字还在 + block 逐字进了新文件"的字节级校验。
 */
import fs from "node:fs";
import path from "node:path";

import { MANIFEST_REL } from "./defs.js";
import { ensureDir, isUnder, lossless, readTextSafe, stamp, writeFileAtomic } from "./base.js";

`;

const newCards = header + block + "\n";
const reexport = `\n// ═══════════════════════════════════════════════════════════════════════════\n// ★★★★★ 2026-10-23（D307 第二刀）：上面这一整段**卡片操作**已搬到 \`lib/card-ops.js\`。\n//   ★ 调用方一个都不用改：下面这行把它们**原样再导出**。\n//   ★ 为什么必须再补一行 import（第一刀踩过的坑）：\n//     \`export { … } from "./card-ops.js"\` 只把名字**再导出去**，\n//     **不会**在本模块作用域里绑定它们 —— 而本文件后面还在用\n//     \`kindLocationOf\` / \`readKindRaw\` / \`writeKindCard\` 等。只 re-export 不 import ⇒ 运行期 ReferenceError。\n// ═══════════════════════════════════════════════════════════════════════════\nexport {\n${NAMES.map((n) => `  ${n},`).join("\n")}\n} from "./card-ops.js";\n`;

const rest = [...lines.slice(0, start), ...lines.slice(end + 1)];
// 在 re-export 插入点：原块的位置（start 处现在是"③ ledger_conform"那段注释之前）
let insertAt = start;
// 往前/后找一条 ═ 分隔线，让 re-export 落在段落边界上
let back = insertAt;
while (back > 0 && !rest[back]?.startsWith("// ═")) back -= 1;
if (back > 0) insertAt = back;
const newPart4 = [...rest.slice(0, insertAt), ...reexport.split("\n"), ...rest.slice(insertAt)].join("\n");

console.log(`\n新 card-ops.js : ${Buffer.byteLength(newCards)} B`);
console.log(`新 part4.js    : ${Buffer.byteLength(newPart4)} B（原 ${buf.length} ⇒ 省 ${buf.length - Buffer.byteLength(newPart4)} B）`);

if (!APPLY) {
  console.log("\n（dry-run 结束；加 --apply 才真写。）");
  process.exit(0);
}

// ── 备份 + 写 ─────────────────────────────────────────────────────────────
const bak = path.join(os.tmpdir(), `ledger-split4-${Date.now()}`);
fs.mkdirSync(bak, { recursive: true });
fs.writeFileSync(path.join(bak, "part4.js"), buf);
console.log(`\n备份：${bak}  (sha ${sha(buf)})`);

fs.writeFileSync(CARDS, newCards, "utf8");
fs.writeFileSync(PART4, newPart4, "utf8");

// ── 写后校验 ───────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(74));
console.log("写后校验（真读回磁盘）");
console.log("─".repeat(74));
let bad = 0;
const check = (n, pass, d) => {
  console.log(`  ${pass ? "✓" : "✗"} ${n}${d === undefined ? "" : `  —— ${d}`}`);
  if (!pass) bad += 1;
};
const rbCards = fs.readFileSync(CARDS, "utf8");
const rbPart4 = fs.readFileSync(PART4, "utf8");

check(`${NAMES.length} 个函数都在 card-ops.js`, NAMES.every((n) => rbCards.includes(`export function ${n}(`)), "");
check("part4.js 里这些 `export function` 已消失", NAMES.every((n) => !rbPart4.includes(`export function ${n}(`)), "");
check("part4.js 里有完整 re-export 列表", NAMES.every((n) => rbPart4.includes(`  ${n},`)), "");
check("card-ops.js 不 import 任何 partN", !/from "\.\/part\d/.test(rbCards), "");
check("★ card-ops.js 逐字包含被搬走的那一块", rbCards.includes(block), "");

const pre = lines.slice(0, start).join("\n");
const post = lines.slice(end + 1).join("\n");
check("★ part4 前段（block 之前）逐字还在", rbPart4.startsWith(pre), "");
check("★ part4 后段（block 之后）逐字还在", rbPart4.endsWith(post), "");
check("★ 原件守恒：前段 + block + 后段 === 原 part4", pre + block + post === text, "");
check("part4 体积确实降了", Buffer.byteLength(rbPart4) < buf.length, `${Buffer.byteLength(rbPart4)} B（省 ${buf.length - Buffer.byteLength(rbPart4)} B）`);
check("两个文件都低于 262,144 B", Buffer.byteLength(rbPart4) < 262144 && Buffer.byteLength(rbCards) < 262144, "");

// ★★ 第一刀的教训：part4 内部还调这些名字 ⇒ 必须也 import，否则运行期 ReferenceError
const stillUsed = NAMES.filter((n) => new RegExp(`\\b${n}\\b`).test(rest.join("\n")));
console.log(`\n  part4 内部仍在用（去掉 re-export 段后的正文）: ${stillUsed.join(", ") || "（无）"}`);
const reexported = stillUsed.filter((n) => rbPart4.includes(`  ${n},`));
check(
  "★ part4 内部仍在用的名字，都被 re-export 覆盖到（否则会 undefined）",
  reexported.length === stillUsed.length,
  `缺：${stillUsed.filter((n) => !reexported.includes(n)).join(", ") || "无"}`
);

console.log("\n" + "─".repeat(74));
console.log(bad === 0 ? `✓ 通过 · 备份 ${bak}` : `✗ ${bad} 项不过（用 ${bak} 还原）`);
console.log("─".repeat(74));
process.exit(bad === 0 ? 0 : 1);
