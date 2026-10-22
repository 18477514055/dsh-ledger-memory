import fs from "node:fs";
const P = "lib/client.js";
const lines = fs.readFileSync(P,"utf8").split("\n");
// 只在 CSS 模板内部（308..894）把注释行里的反引号换成「」
let changed = 0;
for (let i=307; i<893; i++){
  if (!lines[i].includes("`")) continue;
  // 不碰模板本身的开始/结束
  if (lines[i].includes("const CSS = `")) continue;
  if (/^\s*`;?\s*$/.test(lines[i])) continue;
  lines[i] = lines[i].replace(/`/g, "「").replace(/「「/g,"「");
  // 成对的第二个反引号已统一成「，视觉上略怪但语法安全；改成闭合」
  changed++;
}
// 把连续的 「...「 里的后一个改成 」
for (let i=307; i<893; i++){
  const m = lines[i].match(/「([^「」]*)「/);
  if (m) lines[i] = lines[i].replace(/「([^「」]*)「/, "「$1」");
}
fs.writeFileSync(P, lines.join("\n"), "utf8");
console.log("处理行数:", changed);
