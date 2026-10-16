// D221 · 用**自检自己那三条模式**独立复算「会改写源码的探针」数
// ★ 为什么不能照抄我上一版随手写的模式：那是我自己的尺子，与自检的不是同一把
//   ⇒ 两个数不一致时该做的是**对齐到被测对象自己的判据**，不是让被测对象迁就我。
// 用法：node tools/_probe-d221-dangerous-count.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.join(HERE, "..", "tools");

const found = [];
for (const nm of fs.readdirSync(toolsDir)) {
  if (!nm.endsWith(".mjs") || nm === "selftest.mjs") continue;
  const src = fs.readFileSync(path.join(toolsDir, nm), "utf8");
  const writesLib =
    /writeFileSync\s*\(\s*LIB\b/.test(src) ||
    /writeFileSync\s*\(\s*path\.join\([^)]*"lib"[^)]*\)/.test(src) ||
    /["'`]lib[\\/]index\.js["'`]/.test(src);
  if (writesLib) found.push(nm);
}

console.log("═══ 独立复算（照自检那三条模式）═══");
console.log(`  命中数 = ${found.length}`);
console.log(`  其中含 d221 的：${found.filter((n) => n.includes("d221")).join(", ") || "(无)"}`);
console.log("");
for (const f of found) console.log("    " + f);
