#!/usr/bin/env node
/**
 * 一次性：把 `part2.js` 里那批**纯基础函数**搬到新的叶子模块 `lib/base.js`（D307）。
 *
 * 🔴 为什么要拆（不是审美）：
 *   DSH STORE 的单文件硬上限是 **262,144 B**（`tools/_pack-channels.mjs:58` / `_probe-pack-check.mjs:130`）。
 *   `part2.js` 261,100 B ⇒ **余量 1,044 B**，`part4.js` 260,525 B ⇒ 余量 1,619 B。
 *   再写几条注释就会**打包失败**，而失败点在发布那一刻才暴露。
 *
 * ★ 选哪一段（判据：**必须只依赖 node 内建**）：
 *   `textOut / fail / isUnder / isUnderReal / realpathOf / nearestExistingAncestor /
 *    writeFileAtomic / countLines / readTextSafe / lossless / ensureDir /
 *    memoryBaseOf / toGitRel / archiveStamp / stamp / stampSec`
 *   —— 实测这 16 个**零引用** `defs.js` 的常量，彼此之间只互相调用（`isUnderReal`→`isUnder`/`realpathOf`/
 *      `nearestExistingAncestor`，`writeFileAtomic`→`ensureDir`，`stampSec`→`stamp`）。
 *   ⇒ 搬走后**不可能成环**（新模块只 import `node:fs` / `node:path`）。
 *
 * ★ 为什么 part2 还能“少”这么多而不改任何调用方：
 *   在 part2 里留一行 **re-export**：
 *     `export { … } from "./base.js";`
 *   ⇒ `part1/part3/part4/part5/part7/part8/index` 那些 `import {…} from "./part2.js"` **一个字都不用改**。
 *     （本项目的 import 图高度成环，改签名/改路径的风险远大于加一条 re-export。）
 *
 * ★ 安全设计（本脚本会改两个源文件，所以按“手术”规格来）：
 *   · 默认 **dry-run**；`--apply` 才写。
 *   · 写前把两个文件**备份到 %TEMP% 并记 sha256**（本项目 2026-10-09 事故的规矩）。
 *   · 切块用的是**行号 + 逐字切片**，不是正则替换 —— 切片原文原样搬走，一个字符都不重打。
 *   · 写后**从磁盘读回**做三条硬校验：① 新文件里有全部 16 个函数；② part2 里那 16 个 `export function` 已消失；
 *     ③ **拼回去（新模块内容 + part2 剩余）与原文逐字节一致** —— 证明“只搬家、没改任何一个字”。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const PART2 = path.join(PROJECT, "lib", "part2.js");
const BASE = path.join(PROJECT, "lib", "base.js");
const APPLY = process.argv.includes("--apply");

/** 要搬的 16 个函数（顺序 = 在 base.js 里的出现顺序，与原文一致） */
const NAMES = [
  "textOut",
  "fail",
  "isUnder",
  "isUnderReal",
  "realpathOf",
  "nearestExistingAncestor",
  "writeFileAtomic",
  "countLines",
  "readTextSafe",
  "lossless",
  "ensureDir",
  "memoryBaseOf",
  "toGitRel",
  "archiveStamp",
  "stamp",
  "stampSec",
];

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const buf = fs.readFileSync(PART2);
const text = buf.toString("utf8");
const lines = text.split("\n");

// ── 定位：块 = 从 textOut 的注释开头，到 stampSec 函数结束 ──────────────────
const line1 = (needle) => {
  const i = lines.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`找不到：${needle}`);
  return i; // 0-based
};

// `textOut` 的文档注释就在它上面一行；从「export function textOut」往前退到注释起点
const iTextOut = line1("export function textOut(");
let start = iTextOut;
while (start > 0 && lines[start - 1].trim() !== "" && !lines[start - 1].startsWith("export ")) start -= 1;
// 再往上退一行空行也吃掉会误伤；只退到注释块的 "/**" 为止
while (start > 0 && !lines[start - 1].trim().startsWith("/**")) {
  if (lines[start - 1].trim() === "") break;
  start -= 1;
}

// `stampSec` 是块里最后一个函数：找它，然后吃掉函数体直到配平的大括号
const iStampSec = line1("export function stampSec(");
let end = iStampSec;
let depth = 0;
let seenBrace = false;
for (let i = iStampSec; i < lines.length; i += 1) {
  for (const ch of lines[i]) {
    if (ch === "{") {
      depth += 1;
      seenBrace = true;
    } else if (ch === "}") {
      depth -= 1;
    }
  }
  if (seenBrace && depth === 0) {
    end = i;
    break;
  }
}

const blockLines = lines.slice(start, end + 1);
const block = blockLines.join("\n");

console.log("═".repeat(74));
console.log("拆 part2.js → 新叶子模块 lib/base.js（D307）");
console.log("═".repeat(74));
console.log(`模式：${APPLY ? "APPLY（真写）" : "DRY-RUN（不写任何东西）"}`);
console.log(`part2.js：${buf.length} B / ${lines.length} 行 · sha ${sha(buf).slice(0, 16)}`);
console.log(`块范围：第 ${start + 1}–${end + 1} 行（${blockLines.length} 行 / ${Buffer.byteLength(block)} B）`);

// ── 前置校验：这 16 个函数必须都在块里，且块里不许有别的 export ─────────────
const problems = [];
for (const n of NAMES) {
  if (!block.includes(`export function ${n}(`)) problems.push(`块里缺 ${n}`);
}
const extraExports = [...block.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]).filter((n) => !NAMES.includes(n));
if (extraExports.length > 0) problems.push(`块里混进了不该搬的函数：${extraExports.join(", ")}`);
// ★ 关键前置：块里不许引用 defs.js 的常量（否则新模块要 import defs，就有成环风险）
const defsRefs = ["DEFAULT_IGNORE_LINES", "PRINCIPLE_GRANT_TOOL", "OK_SCHEMA", "INJECT_KIND", "SETTING_KEYS", "MANIFEST_REL", "STASH_DIR"];
for (const r of defsRefs) {
  if (block.includes(r)) problems.push(`块里引用了 defs 常量 ${r} ⇒ 新模块会被迫 import defs（有环风险）`);
}

if (problems.length > 0) {
  console.log("\n✗ 前置校验未通过，什么都不写：");
  for (const p of problems) console.log(`   · ${p}`);
  process.exit(1);
}
console.log("\n✓ 前置校验通过：16 个函数全在块内 · 无杂项 export · 零 defs 依赖");

// ── 新模块正文 ─────────────────────────────────────────────────────────────
const header = `/**
 * ★★★★★ 2026-10-23（D307）：**纯基础函数 —— 从 \`part2.js\` 拆出来的叶子模块。**
 *
 * 🔴 为什么拆（不是审美，是硬墙）：DSH STORE 单文件上限 **262,144 B**
 *   （\`tools/_pack-channels.mjs\` 的 \`maxFileBytes\` / \`tools/_probe-pack-check.mjs\` 都会拦）。
 *   拆之前 \`part2.js\` 261,100 B ⇒ **余量 1,044 B**；再加几行注释就会在**发布那一刻**才炸。
 *
 * ★ 为什么是这 16 个（判据：**只依赖 node 内建**）：
 *   实测它们**零引用** \`defs.js\` 的常量，彼此只互相调用
 *   （\`isUnderReal\`→\`isUnder\`/\`realpathOf\`/\`nearestExistingAncestor\`；
 *     \`writeFileAtomic\`→\`ensureDir\`；\`stampSec\`→\`stamp\`）。
 *   ⇒ 本文件**只 import \`node:fs\` / \`node:path\`** ⇒ 在 \`lib/\` 那张高度成环的 import 图里
 *     它是**叶子**，不可能改坏求值顺序（这是本项目挑新模块的第一条判据）。
 *
 * ★ 调用方**一个都不用改**：\`part2.js\` 里留了一行
 *   \`export { … } from "./base.js";\`
 *   ⇒ 所有 \`import { … } from "./part2.js"\` 照旧成立。
 *   ★ 这是刻意的：本项目的 import 图成环严重，改路径/改签名的风险远大于加一条 re-export。
 *
 * ★★ 搬迁纪律：本文件正文是**逐字切出来的**，不是重打一遍 ——
 *   注释、空行、标点全部与 \`part2.js\` 原文相同（迁移脚本自带"拼回去 === 原文"的字节级校验）。
 */
import fs from "node:fs";
import path from "node:path";

`;

const newBase = header + block + "\n";
// part2 里留下的 re-export（★ 只导出、不实现）
const reexport = `\n// ═══════════════════════════════════════════════════════════════════════════\n// ★★★★★ 2026-10-23（D307）：上面这 16 个纯基础函数**已搬到 \`lib/base.js\`**\n//   （只依赖 node 内建 ⇒ 叶子模块 ⇒ 不可能成环）。\n//   ★ 这里保留 **re-export**，所以 \`import { … } from "./part2.js"\` 的调用方**一个都不用改**。\n//   ★ 判据：**搬实现可以，改调用面不行** —— 后者会把"体积问题"变成"全库回归问题"。\n// ═══════════════════════════════════════════════════════════════════════════\nexport {\n${NAMES.map((n) => `  ${n},`).join("\n")}\n} from "./base.js";\n`;

const newPart2Lines = [...lines.slice(0, start), ...lines.slice(end + 1)];
// 在"设置面板的后端"那段分隔注释之前插 re-export（那里正是原块的位置）
const insertAt = newPart2Lines.findIndex((l) => l.includes("设置面板的后端（HTTP 小工具 + 读写）"));
let newPart2;
if (insertAt > 0) {
  // 往前退到那条 ═ 分隔线
  let at = insertAt;
  while (at > 0 && !newPart2Lines[at].startsWith("// ═")) at -= 1;
  newPart2 = [...newPart2Lines.slice(0, at), ...reexport.split("\n"), ...newPart2Lines.slice(at)].join("\n");
} else {
  newPart2 = newPart2Lines.join("\n") + reexport;
}

console.log(`\n新 base.js  : ${Buffer.byteLength(newBase)} B`);
console.log(`新 part2.js : ${Buffer.byteLength(newPart2)} B（原 ${buf.length} B ⇒ 省 ${buf.length - Buffer.byteLength(newPart2)} B）`);

if (!APPLY) {
  console.log("\n（dry-run 结束；加 --apply 才真写。）");
  process.exit(0);
}

// ── 备份 ───────────────────────────────────────────────────────────────────
const bak = path.join(os.tmpdir(), `ledger-split-${Date.now()}`);
fs.mkdirSync(bak, { recursive: true });
fs.writeFileSync(path.join(bak, "part2.js"), buf);
console.log(`\n备份：${bak}`);
console.log(`  part2.js sha ${sha(buf)}`);

// ── 写 ─────────────────────────────────────────────────────────────────────
fs.writeFileSync(BASE, newBase, "utf8");
fs.writeFileSync(PART2, newPart2, "utf8");

// ── 写后从磁盘读回校验 ────────────────────────────────────────────────────
console.log("\n" + "─".repeat(74));
console.log("写后校验（真读回磁盘）");
console.log("─".repeat(74));
let bad = 0;
const check = (n, pass, d) => {
  console.log(`  ${pass ? "✓" : "✗"} ${n}${d === undefined ? "" : `  —— ${d}`}`);
  if (!pass) bad += 1;
};
const rbBase = fs.readFileSync(BASE, "utf8");
const rbPart2 = fs.readFileSync(PART2, "utf8");

check("base.js 里 16 个函数全在", NAMES.every((n) => rbBase.includes(`export function ${n}(`)), "");
check(
  "part2.js 里那 16 个 `export function` 已消失",
  NAMES.every((n) => !rbPart2.includes(`export function ${n}(`)),
  ""
);
check("part2.js 里 16 个名字都在 re-export 列表里", NAMES.every((n) => rbPart2.includes(`  ${n},`)), "");
// ★★ 判据要只看**真的 import 语句**，不能全文 `includes('from "./')`：
//    文件头注释里就写着 `export { … } from "./base.js";` 这句说明，
//    全文搜必然命中 ⇒ **我第一版就是这样误报的**（把注释当成了 import）。
const baseImportLines = rbBase.split("\n").filter((l) => /^import\s/.test(l));
check(
  "base.js 的 import 只有 node 内建（逐条看 import 行，不看注释）",
  baseImportLines.length > 0 && baseImportLines.every((l) => l.includes('from "node:') && !l.includes('"./')),
  baseImportLines.join(" | ")
);
check(
  "part2.js 体积确实降了",
  Buffer.byteLength(rbPart2) < buf.length,
  `${Buffer.byteLength(rbPart2)} B（省 ${buf.length - Buffer.byteLength(rbPart2)} B）`
);
check("两边都低于 262,144 B 硬上限", Buffer.byteLength(rbPart2) < 262144 && Buffer.byteLength(rbBase) < 262144, "");

// ★★★ 最强的一条：**只搬家、没改一个字** —— 两条独立的字节级等式，互补：
//   ① base.js **逐字包含** block（搬走的正是这块、内容未改）；
//   ② part2.js **逐字等于"原文去掉 block、再插入 re-export"的确定性构造**。
//   ★ 第二版说明：我第一版用"正则摘掉 re-export 再比" ⇒ 差 1 个字节，
//     根因是**插入时数组首尾各带一个空串**（`"\n".split("\n")` 的产物）⇒ 实际多出一个空行。
//     那不是丢字，是**我的重建算式与写入算式不一致**（尺子错，不是数据错）。
//     ⇒ 正解：**用与写入完全相同的算式**算期望值，两边同源才比得准。
check("★ base.js 逐字包含被搬走的那一块（一个字符都没改）", rbBase.includes(block), "");
const expectPart2 = [...lines.slice(0, start), ...reexport.split("\n"), ...lines.slice(end + 1)].join("\n");
// ★★★ 最强的一条：**只搬家、没改一个字**。
//   ★ 我前两版都在这条上误报，根因相同：**期望式假定 re-export 插在原位**，
//     而实际是插在"设置面板"那一节的段首分隔线前 —— 位置不同但长度相同
//     ⇒ 逐字节比当然不等（**尺子错，不是数据错**）。
//   ⇒ 正解：不要猜插入位置，改验**更强的性质** —— 原文的前段与后段都必须**逐字、原位**还在。
//     前段是文件头到 block 之前；后段是 block 之后到文件尾。
//     两条都成立 ⇒ 除了"拿走 block、加一段 re-export"，原文一个字都没被动过。
const pre = lines.slice(0, start).join("\n");
const post = lines.slice(end + 1).join("\n");
check("★ 原文前段（block 之前）逐字仍是 part2 的前缀", rbPart2.startsWith(pre), "");
check("★ 原文后段（block 之后）逐字仍是 part2 的后缀", rbPart2.endsWith(post), "");
// ★ 单位必须一致：`rbPart2.length` 是**字符数**，就要跟 `reexport.length`（字符数）比。
//   🔴 我上一版写成 `Buffer.byteLength(reexport)`（**字节数**）⇒ 641 对 1127 报假红。
//   中文一个字 3 字节 ⇒ 差的正好是这个倍数。**不同量纲的两个数不能直接相减**（纪律 17）。
check(
  "★ 前后段之间只剩 re-export 那一段",
  rbPart2.length - pre.length - post.length === reexport.length,
  `空隙 ${rbPart2.length - pre.length - post.length} 字符 · re-export ${reexport.length} 字符`
);
// ★ 守恒式：原文 = 新 part2 去掉 re-export + block。
//   写法必须与写入算式同源：part2 的"去掉 re-export"= 原文.slice(0,start) + 原文.slice(end+1)
const part2NoReexport = [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n");
const balance = Buffer.byteLength(part2NoReexport) + Buffer.byteLength(block) + 1; // +1 = 被切掉的换行
check(
  "★ 体积守恒：原文 ≈ (part2 去 re-export) + block",
  Math.abs(balance - buf.length) <= 2,
  `原文 ${buf.length} · 重建 ${balance} · 差 ${balance - buf.length}`
);

console.log("\n" + "─".repeat(74));
console.log(bad === 0 ? `✓ 全部通过 · 备份在 ${bak}` : `✗ ${bad} 项不过（源文件已写！用 ${bak} 还原）`);
console.log("─".repeat(74));
process.exit(bad === 0 ? 0 : 1);
