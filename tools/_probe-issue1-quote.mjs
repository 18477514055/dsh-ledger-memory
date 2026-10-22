// 边角验证：登记区**后面还有一段引用块**时，不能被静默吃掉。
// 这是我改 `>` 跳过规则时自己发现的一个"同一个病换形状"的陷阱。
import { splitChangeRegister, withChangeRegister } from "../lib/part1.js";

const REG = "## 变更登记（插件自动维护）";
const line = (t) => `- ${t} (append) [a5dd] +1 行 → 100 行 · revision→1`;

const text =
  `# Ledger\n\n## A 段\n\nA 正文。\n\n${REG}\n\n> 说明第一行\n> 说明第二行\n\n${line("2026-10-20 10:00:00")}\n` +
  `\n## B 段\n\n> 这是正文里的引用块，不是登记区的说明。\n\nB 正文。\n`;

const sp = splitChangeRegister(text);
console.log("── 登记区后面跟一段引用块 ──");
console.log(`body 含「A 正文」          = ${sp.body.includes("A 正文")}  （期望 true）`);
console.log(`body 含「> 这是正文里的引用块」= ${sp.body.includes("> 这是正文里的引用块")}  （期望 true）`);
console.log(`body 含「B 正文」          = ${sp.body.includes("B 正文")}  （期望 true）`);
console.log(`body 含「> 说明第一行」     = ${sp.body.includes("> 说明第一行")}  （期望 false）`);
console.log(`entries 条数               = ${sp.entries.length}  （期望 1）`);

const out = withChangeRegister(text, line("2026-10-20 12:00:00"), "", 12);
console.log(`\nwithChangeRegister 后：`);
console.log(`  含引用块 = ${out.includes("> 这是正文里的引用块")}  （期望 true）`);
console.log(`  含 B 正文 = ${out.includes("B 正文")}  （期望 true）`);
console.log(`  登记区只有一份 = ${out.split(REG).length - 1 === 1}`);

const allOk =
  sp.body.includes("A 正文") &&
  sp.body.includes("> 这是正文里的引用块") &&
  sp.body.includes("B 正文") &&
  !sp.body.includes("> 说明第一行") &&
  sp.entries.length === 1 &&
  out.includes("> 这是正文里的引用块") &&
  out.includes("B 正文");
console.log(`\n${allOk ? "✅ 全部符合" : "❌ 有不符合项"}`);
