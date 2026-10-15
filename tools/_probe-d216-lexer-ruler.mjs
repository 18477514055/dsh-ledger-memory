// 尺子自证：词法器能不能在 part4.js 里抓到 CHECKPOINT_TOOL？（正则版漏了它）
import fs from "node:fs";
import path from "node:path";
import { codeOnly, refsIn } from "./_d216-lexer.mjs";

const splitDir = process.argv[2];
if (!splitDir) {
  console.error("用法：node tools/_probe-d216-lexer-ruler.mjs <拆分目录>");
  process.exit(2);
}
const libDir = path.join(splitDir, "lib");
const files = fs.readdirSync(libDir).filter((f) => f.endsWith(".js") && f !== "client.js");

// 收集全部顶层名
const declRe = /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/m;
const allNames = [];
for (const f of files) {
  const t = fs.readFileSync(path.join(libDir, f), "utf8");
  for (const line of t.split("\n")) {
    const m = declRe.exec(line);
    if (m) allNames.push(m[1]);
  }
}

console.log(`顶层名 ${allNames.length} 个\n`);

// ★ 关键用例：part4.js 里的 CHECKPOINT_TOOL（正则版漏报的那一处）
const target = path.join(libDir, "part4.js");
const text = fs.readFileSync(target, "utf8");
console.log("=== 目标：part4.js 里的 CHECKPOINT_TOOL ===");
const found = refsIn(text, ["CHECKPOINT_TOOL"], "_none_");
console.log(`词法器判「part4.js 引用了 CHECKPOINT_TOOL」= ${found.includes("CHECKPOINT_TOOL")}`);
{
  // 对照：旧正则版（复现它）
  const strip = (t) =>
    t
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/`(?:\\.|[^`\\])*`/g, "T")
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
      .replace(/\.\.\./g, " ");
  const old = /(?<![\w$.])CHECKPOINT_TOOL(?![\w$])/.test(strip(text));
  console.log(`旧正则版判 = ${old}  ← 期望 false（它就是漏报的原因）`);
}

// 逐文件比对两把尺子
console.log("\n=== 逐文件：词法器 vs 旧正则（只列不一致）===");
let diffCount = 0;
for (const f of files.sort()) {
  const t = fs.readFileSync(path.join(libDir, f), "utf8");
  const mine = new Set();
  for (const line of t.split("\n")) {
    const m = declRe.exec(line);
    if (m) mine.add(m[1]);
  }
  const self = f.replace(/\.js$/, "");
  const lexRefs = refsIn(t, allNames, self);
  const strip = (x) =>
    x
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/`(?:\\.|[^`\\])*`/g, "T")
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
      .replace(/\.\.\./g, " ");
  const st = strip(t);
  const oldRefs = [];
  for (const n of allNames) {
    if (n === self) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![\\w$.])${esc}(?![\\w$])`).test(st)) oldRefs.push(n);
  }
  const onlyLex = lexRefs.filter((n) => !oldRefs.includes(n));
  const onlyOld = oldRefs.filter((n) => !lexRefs.includes(n));
  if (onlyLex.length || onlyOld.length) {
    diffCount += 1;
    console.log(`  ${f}`);
    if (onlyLex.length) console.log(`    词法器多找到（正则漏报的）：${onlyLex.join(", ")}`);
    if (onlyOld.length) console.log(`    正则多找到：${onlyOld.join(", ")}`);
  }
}
console.log(`\n不一致文件数：${diffCount}`);
