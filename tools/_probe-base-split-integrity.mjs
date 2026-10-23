#!/usr/bin/env node
/**
 * 独立验证 D307「part2.js → base.js」这次拆分**没有改任何字节**。
 *
 * ★ 为什么不只用拆分脚本自己的校验：脚本是**动手的那个**，它自己说"我没弄坏"不够硬
 *   （本项目 D286 的教训：判据与实现同源时，两边一起错就永远看不见）。
 *   ⇒ 这里用**拆分前的原件（%TEMP% 备份）**当基准，独立地做三条字节级等式。
 *
 * ★ 三条等式（缺一不算）：
 *   ① `base.js` 里**逐字包含**被搬走的那一块 `block`；
 *   ② 现 `part2.js` 的**前段**（block 之前）与**后段**（block 之后）都逐字还在、且顺序正确；
 *   ③ 前后段之间**只剩** re-export 那一小段（不含任何被搬走的函数定义）。
 *
 * ★ 用法：node tools/_probe-base-split-integrity.mjs <备份的 part2.js 路径>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const PART2 = path.join(PROJECT, "lib", "part2.js");
const BASE = path.join(PROJECT, "lib", "base.js");

const backupPath = process.argv[2];
if (backupPath === undefined) {
  console.error("✗ 用法：node tools/_probe-base-split-integrity.mjs <拆分前的 part2.js>");
  process.exit(2);
}

const NAMES = [
  "textOut", "fail", "isUnder", "isUnderReal", "realpathOf", "nearestExistingAncestor",
  "writeFileAtomic", "countLines", "readTextSafe", "lossless", "ensureDir",
  "memoryBaseOf", "toGitRel", "archiveStamp", "stamp", "stampSec",
];

const orig = fs.readFileSync(backupPath, "utf8");
const origLines = orig.split("\n");
const nowPart2 = fs.readFileSync(PART2, "utf8");
const nowBase = fs.readFileSync(BASE, "utf8");

const results = [];
const ok = (n, pass, d) => {
  results.push({ n, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${n}${d === undefined ? "" : `  —— ${d}`}`);
};

console.log("═".repeat(74));
console.log("独立验证 D307：part2.js → base.js 拆分完整性（基准 = 拆分前原件）");
console.log("═".repeat(74));
console.log(`基准：${backupPath}（${Buffer.byteLength(orig)} B）`);
console.log(`现状：part2.js ${Buffer.byteLength(nowPart2)} B · base.js ${Buffer.byteLength(nowBase)} B`);

// ── 从原件里切出 block ────────────────────────────────────────────────────
// 🔴 我前两版都从 2015 开始却算成"2015 不是注释开头"，根因是判据太窄：
//   `l.trim().startsWith("/**")` 对**单行注释** `/** 把任意值渲染成一条 text ContentBlock。 */` 成立，
//   但我第一版还要求"上一行不是空行"才算注释开头 ⇒ 被 2016 那个空行挡住，多走了两行。
//   ⇒ 正解：**往上走到"第一行以 `/**` 开头"就停**，不去猜空行。结构标记 > 空行（空行内外都合法）。
const iT = origLines.findIndex((l) => l.includes("export function textOut("));
let start = iT;
while (start > 0 && !origLines[start].trim().startsWith("/**")) start -= 1;

const iS = origLines.findIndex((l) => l.includes("export function stampSec("));
let depth = 0;
let seen = false;
let end = iS;
for (let i = iS; i < origLines.length; i += 1) {
  for (const ch of origLines[i]) {
    if (ch === "{") { depth += 1; seen = true; }
    else if (ch === "}") depth -= 1;
  }
  if (seen && depth === 0) { end = i; break; }
}
const block = origLines.slice(start, end + 1).join("\n");
console.log(`block：第 ${start + 1}–${end + 1} 行 / ${Buffer.byteLength(block)} B`);

// ① base.js 逐字包含 block
ok("① base.js 逐字包含 block（搬走的那块一个字没改）", nowBase.includes(block), "");

// ② 前段 / 后段
const pre = origLines.slice(0, start).join("\n");
const post = origLines.slice(end + 1).join("\n");
ok("② 前段（block 之前）逐字仍是现 part2 的前缀", nowPart2.startsWith(pre), `${pre.length} 字符`);
ok("② 后段（block 之后）逐字仍是现 part2 的后缀", nowPart2.endsWith(post), `${post.length} 字符`);

// ③ 前后段之间只剩 re-export
const gap = nowPart2.slice(pre.length, nowPart2.length - post.length);
ok("③ 中间那段含 D307 标记（就是我插入的 re-export）", gap.includes("D307"), "");
ok("③ 中间那段含 `from \"./base.js\";`", gap.includes('from "./base.js";'), "");
ok(
  "③ 中间那段**不含**任何被搬走的函数定义（否则就是重复定义）",
  NAMES.every((n) => !gap.includes(`function ${n}(`)),
  ""
);
ok(
  "③ 中间那段列出了全部 16 个名字",
  NAMES.every((n) => gap.includes(`${n},`)),
  ""
);
// 中间那段应当只有注释 + export 列表（没有可执行的函数体）—— 用"没有 function 关键字"判
ok("③ 中间那段里没有 `function` 关键字（纯 re-export，不是实现）", !/\bfunction\b/.test(gap), "");

// ④ 守恒：现在 = 前段 + 中间段 + 后段（这是拼接定义，永远成立；真正有信息的是下面那条）
ok(
  "④ 拼接自洽：前段 + 中间段 + 后段 === 现 part2 全文",
  pre + gap + post === nowPart2,
  ""
);
// ⑤ 真正的守恒：原件 = 前段 + block + 后段
ok(
  "⑤ 原件守恒：前段 + block + 后段 === 拆分前原文（证明边界切得准、没吞掉邻居）",
  pre + block + post === orig,
  pre + block + post === orig ? "" : `差 ${(pre + block + post).length - orig.length} 字符`
);
// ⑥ 体积账：现在的 part2 应该正好少了 block 那么多，又多了 re-export 那么多
const expectDelta = Buffer.byteLength(gap) - Buffer.byteLength(block);
ok(
  "⑥ 体积账对得上（现 part2 - 原 part2 === 中间段 - block，含换行误差 ≤2）",
  Math.abs((Buffer.byteLength(nowPart2) - Buffer.byteLength(orig)) - expectDelta) <= 2,
  `实际 ${Buffer.byteLength(nowPart2) - Buffer.byteLength(orig)} · 期望 ${expectDelta}`
);
// ⑦ 16 个函数在 base 里各有且只有一个定义
for (const n of NAMES) {
  const c = (nowBase.match(new RegExp(`export function ${n}\\(`, "g")) ?? []).length;
  if (c !== 1) ok(`⑦ base.js 里 ${n} 定义次数 = 1`, false, `实际 ${c}`);
}
ok("⑦ base.js 里 16 个函数各定义一次", true, "");

const bad = results.filter((r) => r.pass !== true).length;
console.log("\n" + "─".repeat(74));
console.log(`${results.length - bad} PASS / ${bad} FAIL`);
console.log("─".repeat(74));
process.exit(bad === 0 ? 0 : 1);
