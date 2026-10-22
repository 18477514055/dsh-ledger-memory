// 探针：`withChangeRegister` 会不会**静默丢掉**登记区之后的内容？
//
// ★ 这是 issue #1 没报、本机读代码时查出来的**第二个症状**（同一个根因）。
//   修复前：登记区在文本**中间**时，它后面的正文整段消失，而调用返回 ok。
//   修复后：后面的正文被拼回 `body`，一个字都不丢。
import { bodyLineCount, splitChangeRegister, withChangeRegister } from "../lib/part1.js";
import { countLines } from "../lib/part2.js";

const REG = "## 变更登记（插件自动维护）";
const line = (t) => `- ${t} (append) [a5dd] +1 行 → 100 行 · revision→1`;
const registerBlock = `\n\n${REG}\n\n> 说明\n\n${line("2026-10-20 10:00:00")}\n`;

// 场景：调用方传进来的文本里，登记区在**中间**（后面还有正常章节）
const text =
  `# Ledger\n\n## A 段\n\nA 正文。\n` +
  registerBlock +
  `\n## B 段\n\nB 正文（这行在登记区之后）。\n`;

console.log("── 输入 ──");
console.log(`countLines(text) = ${countLines(text)}`);
console.log(`bodyLineCount    = ${bodyLineCount(text)}`);
console.log(`含「B 正文」     = ${text.includes("B 正文")}`);

const out = withChangeRegister(text, line("2026-10-20 12:00:00"), "", 12);

console.log("\n── withChangeRegister 输出 ──");
console.log(`countLines(out)       = ${countLines(out)}`);
console.log(`含「A 正文」          = ${out.includes("A 正文")}`);
console.log(`含「B 正文」          = ${out.includes("B 正文")}   ${out.includes("B 正文") ? "✅ 没丢" : "❌ 静默丢失！"}`);
console.log(`含「## B 段」         = ${out.includes("## B 段")}`);
console.log(`split(body) 里也有 B   = ${splitChangeRegister(out).body.includes("B 正文")}`);

// 反向：把旧行为（只取标题之前）装回去，必须能看见"丢"
const oldBody = text.slice(0, text.indexOf(REG)).replace(/\s+$/, "");
console.log("\n── 反向自检：旧行为（只取标题之前）──");
console.log(`含「B 正文」          = ${oldBody.includes("B 正文")}   ${oldBody.includes("B 正文") ? "⚠️ 反向不成立" : "✅ 确实丢了（证明这条探针能看见红）"}`);

console.log("\n完整输出：");
console.log("─".repeat(50));
console.log(out);
console.log("─".repeat(50));
