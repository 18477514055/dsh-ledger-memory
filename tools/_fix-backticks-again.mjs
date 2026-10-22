// 第二次踩同一个坑：CSS 模板字符串的注释里又写了成对反引号 ⇒ 字符串提前结束。
// 这次是自检 27r（客户端半边必须能被 JS 解析）在**第一次**跑之前就撞上了 —— 说明那条守卫有用。
//
// 判据：只动 `const CSS = \` … \`;` 这一段内部，把成对反引号换成「」，并**报告每一处**。
import fs from "node:fs";

const P = "lib/client.js";
const lines = fs.readFileSync(P, "utf8").split("\n");
const BT = String.fromCharCode(96);

let startLine = -1, endLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (/^\s*const CSS\s*=\s*/.test(lines[i]) && lines[i].includes(BT)) { startLine = i; break; }
}
if (startLine < 0) throw new Error("找不到 const CSS = `");
for (let i = startLine + 1; i < lines.length; i++) {
  if (/^\s*`\s*;?\s*$/.test(lines[i])) { endLine = i; break; }
}
if (endLine < 0) throw new Error("找不到收尾");
console.log(`CSS 模板串：第 ${startLine + 1} → ${endLine + 1} 行`);

let changed = 0;
const touched = [];
for (let i = startLine + 1; i < endLine; i++) {
  const l = lines[i];
  if (!l.includes(BT)) continue;
  let next = l, guard = 0, pairs = 0;
  while (next.includes(BT) && guard++ < 100) {
    const a = next.indexOf(BT);
    const b = next.indexOf(BT, a + 1);
    if (b < 0) { next = next.slice(0, a) + next.slice(a + 1); break; }
    next = next.slice(0, a) + "「" + next.slice(a + 1, b) + "」" + next.slice(b + 1);
    pairs++;
  }
  if (next !== l) {
    console.log(`  L${i + 1}: 替换 ${pairs} 对 → ${next.trim().slice(0, 90)}`);
    lines[i] = next;
    changed++;
    touched.push(i + 1);
  }
}

const out = lines.join("\n");
fs.writeFileSync(P, out, "utf8");
const rest = out.split("\n").slice(startLine + 1, endLine).join("\n").split(BT).length - 1;
console.log(`\n改了 ${changed} 行（${touched.join(", ")}）；模板串内剩余反引号：${rest}`);
