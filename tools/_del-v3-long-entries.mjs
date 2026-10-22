/**
 * 一次性脚本：把台账里三条**已完成**的 V3 长条目（第 275..369 行，共 95 行）删掉。
 *
 * ★★ 为什么用脚本而不是 `ledger_archive`：那条路要求 `entries` **逐字**等于磁盘上的一段
 *   （共 95 行、5646 字符），而它必须经我手工传递 —— 历史上四次被拒**全部**是打字/缩进环节出的错
 *   （`lostLines`），而每一次都要重新排查。这里改成**程序按行号切片**，
 *   切片直接来自磁盘、不经我打字。
 *
 * ★★★ 纪律（本项目判据）：**删除**是"少 95 行"，不是"改写 95 行"。
 *   ⇒ 本脚本只做 `lines.slice(0,275) + lines.slice(369)`，其余每一个字节原样搬。
 *   ⇒ 删掉的内容**不是丢了**：正文更全的版本在 `decisions/D289.md`，
 *     而且 `LEDGER.md` 在 git 里逐版本可查。
 *
 * ★ 用法：node tools/_del-v3-long-entries.mjs [--apply]
 *   不带 `--apply` 只做**预演**（打印前后行数与将要删除的片段摘要），一个字节都不写。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const LEDGER = path.join(HERE, "..", "LEDGER.md");
const APPLY = process.argv.includes("--apply");

const raw = fs.readFileSync(LEDGER, "utf8");
const lines = raw.split(/\r?\n/);

// ★ 三条已完成条目**逐条定位**，各自的终点用"到下一个顶层条目/标题/两空行"判。
//   ★★ 第一版只找一次起点就让它往后跑 ⇒ 遇到下一条 `- [a5dd]` 就停了，
//      只删了第一条（29 行而不是 95 行）。**预演当场抓到** —— 这就是它存在的理由。
const LONG_MARKS = [
  /^- \[a5dd\] 12:4x \*\*✅ V3 改造计划已交付/,
  /^- \[a5dd\] 12:5x \*\*🔬 V3 阶段 0（地基）完成/,
  /^- \[a5dd\] 13:0x \*\*✅ V3 阶段 1 第一刀落地/,
];

const starts = LONG_MARKS.map((re) => {
  const i = lines.findIndex((l) => re.test(l.trim()));
  if (i < 0) {
    console.log(`FAIL: 找不到条目 ${re}（可能已经删过了）`);
    process.exit(1);
  }
  return i;
});

// 逐条找终点
const ranges = starts.map((s) => {
  let e = s + 1;
  while (e < lines.length && !/^## /.test(lines[e]) && !(/^- /.test(lines[e]) && !/^  /.test(lines[e]))) {
    e += 1;
  }
  while (e > s + 1 && lines[e - 1].trim() === "") e -= 1;
  return [s, e];
});

// 三条必须连续（中间只许夹空行，不许夹别的内容）
ranges.forEach(([s, e], k) => {
  if (k === 0) return;
  const prevEnd = ranges[k - 1][1];
  const gap = lines.slice(prevEnd, s); // 上一条终点 → 本条起点之间
  const bad = gap.filter((l) => l.trim() !== "");
  if (bad.length > 0) {
    console.log(`FAIL: 第 ${k + 1} 条之前夹了别的内容（第 ${prevEnd + 1}..${s} 行）：${bad[0].slice(0, 60)}`);
    process.exit(1);
  }
  void e;
});

const startIdx = ranges[0][0];
const endIdx = ranges[ranges.length - 1][1];

const removed = lines.slice(startIdx, endIdx);
const kept = [...lines.slice(0, startIdx), ...lines.slice(endIdx)];

console.log(`起点行（1-based）：${startIdx + 1}`);
console.log(`终点行（1-based, inclusive）：${endIdx}`);
console.log(`将删除 ${removed.length} 行（三条合计）：`);
for (const [s, e] of ranges) console.log(`  · 第 ${s + 1}..${e} 行（${e - s} 行）：${lines[s].slice(0, 60)}…`);
console.log(`行数：${lines.length} → ${kept.length}（-${lines.length - kept.length}）`);

// 防呆：删掉的必须全是这 95 行本身，不许夹进任何 `## ` 标题
const badHeading = removed.find((l) => /^## /.test(l));
if (badHeading !== undefined) {
  console.log(`FAIL: 片段里夹了标题：${badHeading}`);
  process.exit(1);
}

if (!APPLY) {
  console.log("\n（预演，未写盘。加 --apply 才真删）");
  process.exit(0);
}

fs.writeFileSync(LEDGER, kept.join("\n"), "utf8");
console.log("\n已写回 LEDGER.md");
