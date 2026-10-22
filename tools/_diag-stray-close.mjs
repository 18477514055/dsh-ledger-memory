// 找出"多余的 */"在哪一行（即某个 */ 前面没有对应的 /*）。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const p2 = fs.readFileSync(path.join(ROOT, "lib", "part2.js"), "utf8");
const lines = p2.split("\n");

let depth = 0;
let openAt = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  let j = 0;
  while (j < l.length) {
    if (l[j] === "/" && l[j + 1] === "*") {
      depth++;
      openAt.push(i + 1);
      j += 2;
      continue;
    }
    if (l[j] === "*" && l[j + 1] === "/") {
      if (depth === 0) {
        console.log(`🔴 多余的 */ 在第 ${i + 1} 行：`);
        console.log("    " + l.trim().slice(0, 160));
      }
      depth = Math.max(0, depth - 1);
      if (depth === 0) openAt = [];
      j += 2;
      continue;
    }
    j += 1;
  }
}
console.log(`\n结束 depth=${depth}`);
