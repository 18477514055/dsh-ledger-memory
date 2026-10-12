/** 只读自检：找出「反引号个数为奇数」的行（写文件时被改坏的那种）。 */
import fs from "node:fs";

const files = process.argv.slice(2);
for (const f of files) {
  const s = fs.readFileSync(f, "utf8");
  const lines = s.split("\n");
  console.log("=== " + f + "  lines=" + lines.length);
  const B = String.fromCharCode(96);
  let bad = 0;
  lines.forEach((L, i) => {
    let n = 0;
    for (const c of L) if (c === B) n++;
    if (n % 2 === 1) {
      bad++;
      console.log("  ODD[" + (i + 1) + "]: " + JSON.stringify(L.slice(0, 100)));
    }
  });
  console.log("  odd lines = " + bad);
}
