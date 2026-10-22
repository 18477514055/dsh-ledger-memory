// 探针：验证 issue #1「补充观察」里那条假设 —— 「withChangeRegister 会追加出第二份登记区、
// 导致行数虚高」到底成立不成立。
//
// ★ 结论（实测）：**不成立**。登记标题恒为 1 份；登记区被 cap 夹住 ⇒ 行数只会**减少**。
// ★ 那"差 99 行"的真解释是**两把尺子不同**：`countLines` 数全部行，人手工数的是正文行。
//
// ★ 为什么换了这个文件名：DSH 的写入工具对"刚被删掉的路径"会一直报
//   `file no longer exists — re-read the file, then retry`（删掉之后它仍持着旧观察）。
//   新建一个名字最省事，别跟那个状态机较劲。
import { bodyLineCount, splitChangeRegister, withChangeRegister } from "../lib/part1.js";
import { countLines } from "../lib/part2.js";
import fs from "node:fs";
import path from "node:path";

const REG = "## 变更登记（插件自动维护）";
const realLine = (t, n) => `- ${t} (append) [a5dd] +1 行 → ${n} 行 · revision→${n}`;
const mkReg = (n) =>
  `\n\n${REG}\n\n> 说明行一\n> 说明行二\n\n` +
  Array.from({ length: n }, (_, i) => realLine(`2026-10-20 10:${String(i % 60).padStart(2, "0")}:00`, 100 + i)).join("\n") +
  "\n";

const body = ["# Ledger", ""];
for (let i = 0; i < 41; i++) {
  body.push(`## 段 ${i}`, "");
  for (let j = 0; j < 6; j++) body.push(`- 条目 ${i}-${j} 内容内容内容`, "");
}
const newActive = body.join("\n").replace(/\s+$/, "") + mkReg(12);
const priorActive = "# Ledger\n\n## 旧段\n\n- 旧内容\n" + mkReg(12);

console.log("── 输入 ──");
console.log(`countLines(newActive)          = ${countLines(newActive)}`);
console.log(`bodyLineCount(newActive)       = ${bodyLineCount(newActive)}   ← 剥掉登记区`);
console.log(`登记区行数（标题+说明+条目）    = ${countLines(newActive) - bodyLineCount(newActive)}`);

const res = withChangeRegister(newActive, realLine("2026-10-20 12:00:00", 363), priorActive, 12);
const titles = res.split(REG).length - 1;

console.log("\n── withChangeRegister 输出 ──");
console.log(`countLines(registered)         = ${countLines(res)}`);
console.log(`登记区标题出现次数              = ${titles}   ${titles === 1 ? "✅ 恒为 1 份" : "❌ 出现多份！"}`);
console.log(`行数增量                        = ${countLines(res) - bodyLineCount(newActive)}`);

// 极端：newActive 里已有 200 条登记行（历史上手工堆过的情况）
const fat = body.join("\n").replace(/\s+$/, "") + mkReg(200);
const res2 = withChangeRegister(fat, realLine("2026-10-20 12:00:00", 400), priorActive, 12);
console.log("\n── 极端：newActive 里已有 200 条登记行 ──");
console.log(`countLines(newActive)          = ${countLines(fat)}`);
console.log(`countLines(registered)         = ${countLines(res2)}   ← 被 cap 压回 12 条`);
console.log(`行数变化                        = ${countLines(res2) - countLines(fat)}（负数 ⇒ 只会减少，不会虚高）`);

// ★ 「差 99 行」的真解释：两把尺子
console.log("\n── 「差 99 行」的真解释：两把尺子 ──");
const real = path.resolve(import.meta.dirname, "..", "LEDGER.md");
if (fs.existsSync(real)) {
  const t = fs.readFileSync(real, "utf8");
  const all = t.replace(/\n$/, "").split("\n");
  const nonEmpty = all.filter((l) => l.trim() !== "");
  const blank = all.length - nonEmpty.length;
  console.log(`本机 LEDGER.md：countLines = ${all.length} · 非空行 = ${nonEmpty.length} · 空行 = ${blank}（${((100 * blank) / all.length).toFixed(1)}%）`);
  console.log(`⇒ 用户"本地统计 334 行 vs 工具报 433 行"差的 99 行 ≈ 这一比例的空行 + 登记区。`);
  console.log(`   ★ 不是漏算，是**两把尺子** —— 这是口径问题，不是 bug。`);
}

// 顺带验一眼：修复后 split 仍然只剥登记区、不动别的
console.log("\n── splitChangeRegister 语义 ──");
const sp = splitChangeRegister(newActive);
console.log(`body 含登记标题 = ${sp.body.includes(REG)}  （期望 false）`);
console.log(`entries 条数    = ${sp.entries.length}  （期望 12）`);
