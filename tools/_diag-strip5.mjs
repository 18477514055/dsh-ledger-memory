// 查：喂到 L2005（含声明）时 isUnderReal 为何不在输出里 —— 看该段原文与输出。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const selfSrc = fs.readFileSync(path.join(ROOT, "tools", "selftest.mjs"), "utf8");
function grab(name) {
  const i = selfSrc.indexOf(`function ${name}(`);
  let j = selfSrc.indexOf("{", i);
  let depth = 0;
  for (; j < selfSrc.length; j++) {
    if (selfSrc[j] === "{") depth++;
    else if (selfSrc[j] === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  return selfSrc.slice(i, j);
}
const strip = new Function(
  `${grab("needsValueAfter")}\n${grab("stripCommentsAndLiterals")}\nreturn stripCommentsAndLiterals;`
)();

const p2 = fs.readFileSync(path.join(ROOT, "lib", "part2.js"), "utf8");
const lines = p2.split("\n");

const lineNo = lines.findIndex((l) => l.includes("export function isUnderReal")) + 1;
const upto = lines.slice(0, lineNo).join("\n");
console.log(`原文最后一行（L${lineNo}）: ${JSON.stringify(lines[lineNo - 1])}`);
const out = strip(upto);
console.log(`\n剥后长度 ${out.length} / 原文 ${upto.length}`);
console.log(`剥后是否含 "isUnderReal": ${out.includes("isUnderReal")}`);
console.log(`剥后是否含 "export function": ${out.includes("export function")}`);
console.log(`\n剥后最后 300 字符:\n${JSON.stringify(out.slice(-300))}`);
