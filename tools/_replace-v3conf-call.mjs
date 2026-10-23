#!/usr/bin/env node
/**
 * 用 `v3ConformanceGaps()` 的调用**替换** part2.js 里那段内联体检（一次性脚本）。
 *
 * ★ 为什么用脚本而不是 edit：要删的是一段 4487 字符、带大量反引号与正则的代码，
 *   `edit` 的 old_string 必须逐字相等 —— 而逐字手打这么长一段正是本项目
 *   "归档事故"（2026-10-20）的同一个病因。**让脚本按锚点切。**
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "..");
const PART2 = path.join(PROJECT, "lib", "part2.js");

// ① 留一份备份（字节相等，方便回滚）
const bak = path.join(process.env.TEMP ?? ".", `part2-before-v3conf-${Date.now()}.js`);
fs.writeFileSync(bak, fs.readFileSync(PART2));

let s = fs.readFileSync(PART2, "utf8");
const START = "  // ── ★★★★★ 2026-10-23（D310，审计员010 F-07 实锤）：**V3 核心机制专项体检**";
const END = "  // ── 以下都**只提示、不影响判定** ─";
const a = s.indexOf(START);
const b = s.indexOf(END);
if (a < 0 || b < 0 || b <= a) throw new Error(`定位失败：a=${a} b=${b}`);
const removed = s.slice(a, b);

const replacement = `  // ── ★★★★★ 2026-10-23（D310，审计员010 F-07 实锤）：**V3 核心机制专项体检** ──────
  //
  //   ★ 实现在 \`lib/v3-conformance.js\`（**叶子模块**，不成环）。
  //     抽出去的两个理由：① 本文件只剩 3512 B 余量（硬上限 262,144 B）；
  //     ② 语义上它回答的是"第 3 代的四项保障在不在"，与本函数里那一大堆
  //        "V2 登记资产在不在"本来就不是一回事。
  //   ★ 触发条件用 \`memoryRoot\` 有值 —— **不是** \`info.isV3\`（那个字段 inspect() 根本不返回，
  //     我第一版写成 \`info.isV3 === true\` ⇒ 恒假 ⇒ 四条断言全红，看着像"修了没用"）。
  {
    const gaps = v3ConformanceGaps(info, { memoryBaseOf });
    for (const r of gaps.reasons) reasons.push(r);
    for (const x of gaps.fixable) fixable.push(x);
  }

`;

s = s.slice(0, a) + replacement + s.slice(b);
fs.writeFileSync(PART2, s, "utf8");
console.log(`替换完成：删掉 ${removed.length} 字符，写入 ${replacement.length} 字符`);
console.log(`part2.js 现在 ${fs.statSync(PART2).size} B（硬上限 262144 B，余量 ${262144 - fs.statSync(PART2).size} B）`);
console.log(`备份：${bak}`);
