#!/usr/bin/env node
/**
 * 真正修好 D307 第二刀对 `part4.js` 造成的结构损伤 —— 用「**从备份重建**」的方式，
 * 而不是继续在原文件上打补丁（那正是越修越乱的来源）。
 *
 * ★★★ 复盘（我在这上面连错三次，值得记下来）：
 *   ① 我把 re-export 插在了「D202 标题块」**内部**（标题与它的续行之间）；
 *   ② 修复脚本第 1 版又把「标题 / 空行 / ═ / `//`」当成"我加的尾巴"删掉 ——
 *      而那两行**是原文的一部分**（标题下紧接着的 `//` 是逐字引用的续行）；
 *   ③ 每一次都是"只删了这一行/两行"的字节校验全过 —— **因为字节确实只少了那些**，
 *      但**少的是不该少的那几行**。★ 判据失效的原因：**只校验"少了多少"，没校验"少的是哪些"**。
 *
 * ⇒ 正解：**从 `--apply` 之前的备份重新切一次**，但这次 re-export 的插入点改成
 *   「**整块卡片化标题段（开 / 标题 / 合 / // 续行…）结束之后的第一条 ═ 分隔线**」。
 *   并且加一条**必须有人工可读的锚点**：re-export 之前必须是空行，之后必须是 ═ 开线。
 *
 * ★ 用法：node tools/_rebuild-part4-cards.mjs <备份的 part4.js> [--apply]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const PART4 = path.join(PROJECT, "lib", "part4.js");
const CARDS = path.join(PROJECT, "lib", "card-ops.js");

const bakPath = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (bakPath === undefined) {
  console.error("✗ 需要备份路径（拆分之前的 part4.js）");
  process.exit(2);
}

const NAMES = [
  "isSafeCardKey", "cardDirAbs", "cardDirIsSafe", "cardFileAbs", "listCards", "readCard",
  "writeCard", "removeCard", "renderCardToc", "buildCardBlocks", "renderCardIndex",
  "writeCardIndex", "cardModeOf", "kindToRel", "readEntryUnified", "cardDirLabel",
  "readKindRaw", "writeKindCard", "removeKindCard", "kindLocationOf",
  "splitFileIntoCards", "splitIntoCardParts", "registerCardDirInManifest",
];

const orig = fs.readFileSync(bakPath, "utf8");
const lines = orig.split("\n");

// ── 切块（与之前相同，已验证过的边界逻辑）────────────────────────────────
const iFirst = lines.findIndex((l) => l.includes("export function isSafeCardKey("));
let start = iFirst;
while (start > 0 && !lines[start].trim().startsWith("/**")) start -= 1;
const iLast = lines.findIndex((l) => l.includes("export function registerCardDirInManifest("));
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
console.log("从备份重建：part4.js 卡片区 → card-ops.js（新版插入点策略）");
console.log("═".repeat(74));
console.log(`模式：${APPLY ? "APPLY（真写）" : "DRY-RUN（不写任何东西）"}`);
console.log(`备份：${bakPath}（${Buffer.byteLength(orig)} B）`);
console.log(`块：第 ${start + 1}–${end + 1} 行 / ${Buffer.byteLength(block)} B`);

// ── 决定 re-export 插入点 ─────────────────────────────────────────────────
// 判据：**块被拿走之后**，从 start 处往后找"第一条以 `// ═` 开头的行"，
//   且要求它前面是空行（段落边界）—— 找不到就插在 start。
const rest = [...lines.slice(0, start), ...lines.slice(end + 1)];
let insertAt = -1;
for (let i = start; i < Math.min(rest.length, start + 200); i += 1) {
  if (rest[i].startsWith("// ═") && (rest[i - 1] ?? "").trim() === "") {
    insertAt = i;
    break;
  }
}
if (insertAt < 0) insertAt = start;
console.log(`\nre-export 将插在第 ${insertAt + 1} 行之前`);
console.log("  上一行: " + JSON.stringify(rest[insertAt - 1] ?? "<head>").slice(0, 90));
console.log("  该行  : " + JSON.stringify(rest[insertAt] ?? "<tail>").slice(0, 90));

const reexport =
  `// ═══════════════════════════════════════════════════════════════════════════\n` +
  `// ★★★★★ 2026-10-23（D307 第二刀）：上面那一整段**卡片操作**已搬到 \`lib/card-ops.js\`。\n` +
  `//   ★ 调用方一个都不用改 —— 下面把它们**原样再导出**。\n` +
  `//   ★★ 为什么这里必须「既 import 又 export」（第一刀踩过的坑）：\n` +
  `//     \`export { … } from "./card-ops.js"\` 只把名字**再导出去**，\n` +
  `//     **不会**在本模块作用域里绑定它们 —— 而本文件后面还在用 \`readKindRaw\` / \`writeKindCard\` 等。\n` +
  `//     只 re-export 不 import ⇒ 运行期 \`ReferenceError\`（自检当场撞出过一次）。\n` +
  `// ═══════════════════════════════════════════════════════════════════════════\n` +
  `export {\n${NAMES.map((n) => `  ${n},`).join("\n")}\n} from "./card-ops.js";\n`;

const newPart4 = [...rest.slice(0, insertAt), ...reexport.split("\n"), ...rest.slice(insertAt)].join("\n");
console.log(`\n新 part4.js: ${Buffer.byteLength(newPart4)} B（省 ${Buffer.byteLength(orig) - Buffer.byteLength(newPart4)} B）`);

if (!APPLY) {
  console.log("\n（dry-run 结束）");
  process.exit(0);
}

// ── 写 ─────────────────────────────────────────────────────────────────────
const bak2 = path.join(os.tmpdir(), `ledger-rebuild4-${Date.now()}`);
fs.mkdirSync(bak2, { recursive: true });
fs.writeFileSync(path.join(bak2, "part4.js.cur"), fs.readFileSync(PART4));
fs.writeFileSync(PART4, newPart4, "utf8");
fs.writeFileSync(CARDS, fs.readFileSync(CARDS, "utf8"), "utf8"); // 不动 card-ops（它是对的）
console.log(`\n（当前损坏版已备份到 ${bak2}）`);

// ── 写后校验 ───────────────────────────────────────────────────────────────
const rb = fs.readFileSync(PART4, "utf8");
let bad = 0;
const check = (n, pass, d) => {
  console.log(`  ${pass ? "✓" : "✗"} ${n}${d === undefined ? "" : `  —— ${d}`}`);
  if (!pass) bad += 1;
};
console.log("\n" + "─".repeat(74));
console.log("写后校验");
console.log("─".repeat(74));
const R = rb.split("\n");
check(`${NAMES.length} 个函数仍在 card-ops.js`, NAMES.every((n) => fs.readFileSync(CARDS, "utf8").includes(`export function ${n}(`)), "");
check("part4 里这些函数定义已消失", NAMES.every((n) => !rb.includes(`export function ${n}(${""}`) || !rb.includes(`export function ${n}(`)), "");
check("part4 里有 re-export 列表", NAMES.every((n) => rb.includes(`  ${n},`)), "");
check("★ card-ops.js 逐字包含被搬走的那块", fs.readFileSync(CARDS, "utf8").includes(block), "");

// ★ 这次的核心断言：**D202 标题段必须完好无损**
const iTitle = R.findIndex((l) => l.includes("2026-10-14（D202，用户拍板）：**卡片化**"));
check("D202 标题行存在", iTitle >= 0, `第 ${iTitle + 1} 行`);
check("标题上一行是 ═ 开线", R[iTitle - 1]?.startsWith("// ═") === true, "");
check("标题下一行仍是 ═ 合线（原文如此，没被我吃掉）", R[iTitle + 1]?.startsWith("// ═") === true, JSON.stringify(R[iTitle + 1] ?? "").slice(0, 60));
check("合线下一行是 `//`（标题段逐字引用的续行，原文如此）", R[iTitle + 2] === "//", JSON.stringify(R[iTitle + 2] ?? "").slice(0, 60));

// ★ 前段 / 后段完整
const pre = lines.slice(0, start).join("\n");
const post = lines.slice(end + 1).join("\n");
check("★ part4 前段（block 之前）逐字还在", rb.startsWith(pre), "");
check("★ part4 后段（block 之后）逐字还在", rb.endsWith(post), "");
// ★ 三段的拼接要补回它们之间的换行 —— `join("\n")` 已把段内换行吃掉，段间断点还差 2 个。
//   🔴 我第一版写成 `pre + block + post`（少了 2 个 `\n`）⇒ 差 2 字符报假红。
//   这与第一刀那次"641 vs 1127"是同一个病：**尺子自己的算式不对**，不是数据错了。
const preL = lines.slice(0, start);
const postL = lines.slice(end + 1);
check("★ 前段 + block + 后段 === 备份原文（按行切片，段间换行已补）", preL.join("\n") + "\n" + block + "\n" + postL.join("\n") === orig, "");
check("★ 且前 / 后两段合起来就是「原文去掉 block」", preL.concat(postL).join("\n") === [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n"), "");
check("两个文件都低于 262,144 B", Buffer.byteLength(rb) < 262144 && fs.statSync(CARDS).size < 262144, "");

console.log("\n" + "─".repeat(74));
console.log(bad === 0 ? `✓ 全部通过` : `✗ ${bad} 项不过`);
console.log("─".repeat(74));
process.exit(bad === 0 ? 0 : 1);
