// 找出 package.json 里 description 那行的**精确内容**（为什么 edit 匹配不上）
import fs from "node:fs";
const t = fs.readFileSync("package.json", "utf8");
const lines = t.split("\n");
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i].includes('"description"')) {
    console.log(`行号 ${i + 1}`);
    console.log("JSON.stringify 形式：");
    console.log(JSON.stringify(lines[i]));
    console.log(`长度 ${lines[i].length}`);
    // 找可疑的非 ASCII 字符
    const odd = [...lines[i]].filter((c) => c.charCodeAt(0) > 0x7f);
    console.log(`非 ASCII 字符 ${odd.length} 个：${[...new Set(odd)].join("")}`);
    // 检查是否含不易察觉的空白
    const spaces = [...lines[i]].filter((c) => c === "\u00a0" || c === "\u3000" || c === "\u200b");
    console.log(`可疑空白（NBSP/全角空格/零宽）${spaces.length} 个`);
  }
}
