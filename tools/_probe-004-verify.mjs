/**
 * ★★★ 只读：核实「只读测试员 004」报告里的**可证伪断言**。
 *
 * 004 是一份来自**从未接触过本项目**的模型的报告。它的价值全在于断言是否成立，
 * 所以我不采信、也不否定，只**逐条复算**。本探针查四件事：
 *
 *   ① `DECISIONS.md` 的 `## D<n>` 编号缺口 —— 004 声称缺 D44/D48/D56/D58/D59。
 *   ② 「台账/归档里引用的 D 编号是否都有正文」—— 004 的 §四-3，也是最可行动的一条。
 *   ③ D61 端到端是否**真的已闭合** —— 004 声称 `05:31:01` 那条原话
 *      已经出现在 `2026-10-11-155039-fada.md` 里，据此建议结掉 §10-4。
 *   ④ L4 / 胶囊 / 归档 / stash 的条数（004 报 38 / 7 / 19 / 2）。
 *
 * ★ 只读。★ 不 import 任何 @deepseek-ai/*。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ★★ 2026-10-15（D216）：原来硬编码本机绝对路径 ⇒ ① 会公开在仓库上；
//   ② 别人 clone 下来必然跑不了（假失败）。⇒ 改成**从本文件位置推**（跨机器都对）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(p, "utf8");
const exists = (p) => fs.existsSync(p);

console.log("═".repeat(74));
console.log("① DECISIONS.md 的 `## D<n>` 编号（004 声称缺 D44/D48/D56/D58/D59）");
console.log("═".repeat(74));
const decLines = read(path.join(ROOT, "DECISIONS.md")).split(/\r?\n/);
const headingNums = [];
const headingAt = new Map();
decLines.forEach((line, i) => {
  const m = /^##\s+D(\d+)\b/.exec(line);
  if (m !== null) {
    const n = Number(m[1]);
    headingNums.push(n);
    if (!headingAt.has(n)) headingAt.set(n, i + 1);
  }
});
const maxN = Math.max(...headingNums);
const gaps = [];
for (let n = 1; n <= maxN; n += 1) if (!headingAt.has(n)) gaps.push(n);
console.log(`  DECISIONS.md 共 ${decLines.length} 行`);
console.log(`  带 \`## D<n>\` 的标题 ${headingNums.length} 个，最大编号 D${maxN}`);
console.log(`  ★ 编号缺口：${gaps.map((n) => "D" + n).join(" ") || "（无）"}`);
const claimed = [44, 48, 56, 58, 59];
const ok1 = claimed.every((n) => gaps.includes(n)) && gaps.length === claimed.length;
console.log(`  ⇒ 004 的该项断言：${ok1 ? "✔ 成立（且缺口正好是这 5 个）" : "✘ 不成立，实测缺口=" + JSON.stringify(gaps)}`);

console.log("\n" + "═".repeat(74));
console.log("② 引用完整性：台账 + 归档里引用的 D 编号，是否都有正文");
console.log("═".repeat(74));
const cited = new Set();
const citedBy = new Map();
const collect = (label, text) => {
  for (const m of text.matchAll(/\bD(\d{1,3})\b/g)) {
    const n = Number(m[1]);
    cited.add(n);
    if (!citedBy.has(n)) citedBy.set(n, new Set());
    citedBy.get(n).add(label);
  }
};
collect("LEDGER.md", read(path.join(ROOT, "LEDGER.md")));
const archDir = path.join(ROOT, "_ledger-archive");
const archFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else archFiles.push(p);
  }
})(archDir);
for (const f of archFiles) collect(path.basename(f), read(f));
collect("_stash", (function () {
  const d = path.join(ROOT, "_stash");
  if (!exists(d)) return "";
  let t = "";
  (function w(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) w(q); else t += read(q);
    }
  })(d);
  return t;
})());

const dangling = [...cited].filter((n) => !headingAt.has(n)).sort((a, b) => a - b);
console.log(`  台账/归档/stash 共引用 ${cited.size} 个不同编号：D${Math.min(...cited)}~D${Math.max(...cited)}`);
console.log(`  ★ 其中有正文的 ${cited.size - dangling.length} 个，**断链** ${dangling.length} 个：`);
for (const n of dangling) {
  console.log(`     D${n}  ← 被引用于：${[...citedBy.get(n)].join(" · ")}`);
}
console.log(`  ⇒ 004 的「D58 断链」：${dangling.includes(58) ? "✔ 成立" : "✘ 不成立"}`);
console.log(`  ⇒ 004 提的断言（引用必达）若真加上，会当场红 ${dangling.length} 条`);

console.log("\n" + "═".repeat(74));
console.log("③ D61 端到端是否已闭合（004 的核心正面发现）");
console.log("═".repeat(74));
const capDir = path.join(ROOT, "_ledger-log/2026-10/week2/capsules");
const caps = fs.existsSync(capDir) ? fs.readdirSync(capDir).sort() : [];
console.log(`  胶囊 ${caps.length} 份：`);
for (const c of caps) {
  const p = path.join(capDir, c);
  const t = read(p);
  const has0531 = t.includes("05:31:01");
  const st = fs.statSync(p);
  console.log(`     ${c}  ${String(st.size).padStart(6)}B  ${new Date(st.mtimeMs).toLocaleString("sv-SE")}` +
    `  含「05:31:01」：${has0531 ? "★ 是" : "否"}`);
}
// 逐份找「用户原话」小节里出现的原话
const QUOTE = "已重启，检查一下，然后看截图";
let hitFiles = [];
for (const c of caps) {
  const t = read(path.join(capDir, c));
  if (t.includes(QUOTE)) hitFiles.push(c);
}
console.log(`\n  「${QUOTE}」出现在：${hitFiles.length ? hitFiles.join(" · ") : "（无）"}`);
console.log(`  ⇒ 004 的「D61 已闭合」：${hitFiles.length ? "✔ 有产物支持（见下"+"：需再验进程边界）" : "✘ 不成立"}`);

console.log("\n" + "═".repeat(74));
console.log("④ 条数复算（004 报 L4=38 · 胶囊=7 · 归档=19 · stash=2）");
console.log("═".repeat(74));
const l4 = path.join(ROOT, "_ledger-log/2026-10/week2/L4-user-messages.md");
const l4Lines = exists(l4) ? read(l4).split(/\r?\n/) : [];
const l4Entries = l4Lines.filter((l) => /^\s*-\s+\S/.test(l)).length;
let stashCount = 0;
(function w(p) {
  if (!exists(p)) return;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    if (e.isDirectory()) w(q); else stashCount += 1;
  }
})(path.join(ROOT, "_stash"));
console.log(`  L4 文件 ${l4Lines.length} 行 · 条目 ${l4Entries} 条（004 报 38 —— ★ 本会话又追加了，故现值更大）`);
console.log(`  胶囊 ${caps.length} 份（004 报 7）`);
console.log(`  归档 ${archFiles.length} 份（004 报 19）`);
console.log(`  stash ${stashCount} 份（004 报 2）`);

console.log("\n" + "═".repeat(74));
console.log("⑤ B7：compactionCounts 是否真的只有内存（004 报全零）");
console.log("═".repeat(74));
const pd = path.join(os.homedir(), ".dsh", "plugin-data", "dsh-ledger-memory");
console.log(`  plugin-data 目录：${exists(pd) ? fs.readdirSync(pd).join(", ") : "（不存在）"}`);
const hasCounter = exists(pd) && fs.readdirSync(pd).some((f) => /count|compact/i.test(f));
console.log(`  ★ 有没有把计数落盘的文件：${hasCounter ? "有（需细看）" : "**没有** ⇒ 004 的 B7 判断成立"}`);
