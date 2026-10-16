// D221 · 复算自检情形 60 ② 的 stripBlock，看到底把哪一段吃掉了
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(HERE, "..", "lib");
const names = fs.readdirSync(dir).filter((n) => n.endsWith(".js")).sort();
console.log("文件顺序：", names.join(", "));

const src = names.map((n) => fs.readFileSync(path.join(dir, n), "utf8")).join("\n");

for (const mark of ["const SETTING_SPECS = [", "const SETTING_GROUPS = [", "function settingDefaults() {"]) {
  // 找出**每个文件**里的出现位置，看清是哪个文件
  let acc = 0;
  for (const n of names) {
    const t = fs.readFileSync(path.join(dir, n), "utf8");
    const i = t.indexOf(mark);
    if (i >= 0) console.log(`  "${mark}" 出现在 ${n}（文件内偏移 ${i}）`);
    acc += t.length + 1;
  }
  if (src.indexOf(mark) < 0) console.log(`  "${mark}" 在拼接后**找不到**`);
}

const stripBlock = (s, startMark, endMark) => {
  const a = s.indexOf(startMark);
  if (a < 0) return s;
  const b = s.indexOf(endMark, a);
  return b < 0 ? s : s.slice(0, a) + s.slice(b);
};
let body = src;
body = stripBlock(body, "const SETTING_SPECS = [", "const SETTING_GROUPS = [");
console.log(`\n第一次剥离后长度：${body.length}（原 ${src.length}）`);
body = stripBlock(body, "function settingDefaults() {", "\nfunction ");
console.log(`第二次剥离后长度：${body.length}`);

const keys = ["weightPrincipleScore", "weightDoneCap", "shadowedIndexMax", "capsuleStoreSessions", "blockHistoryMax"];
console.log("\n★ 剥离后这些键还在不在：");
for (const k of keys) {
  const re = new RegExp("\\b" + k + "\\b");
  const hit = re.test(body);
  // 原始源码里在哪个文件命中
  const where = names.filter((n) => re.test(fs.readFileSync(path.join(dir, n), "utf8")));
  console.log(`  ${k.padEnd(22)} 剥离后=${hit}  原始出现在：${where.join(", ") || "(无)"}`);
}

// 看第二次剥离到底吃了哪一段
const a2 = src.indexOf("function settingDefaults() {");
const b2 = src.indexOf("\nfunction ", a2);
console.log(`\n★ 第二次剥离的区间：[${a2}, ${b2})，共 ${b2 - a2} 字符`);
console.log("★ 被剥掉那一段的开头 200 字：");
console.log(JSON.stringify(src.slice(a2, a2 + 200)));
console.log("★ 被剥掉那一段的结尾 200 字：");
console.log(JSON.stringify(src.slice(Math.max(a2, b2 - 200), b2)));
