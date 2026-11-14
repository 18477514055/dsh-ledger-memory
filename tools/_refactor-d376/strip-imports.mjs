/**
 * 把拆出去的新文件恢复到「只有头注 + 块」的状态，好让 fix-imports 重新干净地跑一遍。
 * ★ 只删**顶部的** import 行（头注之后、第一个 `export` 之前），不碰函数体。
 */
import fs from "node:fs";

for (const f of ["lib/part1-store.js", "lib/part3-settings.js"]) {
  const text = fs.readFileSync(f, "utf8");
  const lines = text.split("\n");
  const out = [];
  let seenExport = false;
  for (const l of lines) {
    if (!seenExport && /^export /.test(l)) seenExport = true;
    const isTopImport = !seenExport && /^import\s+.*from\s+"[^"]+";?\s*$/.test(l);
    if (isTopImport) continue;
    out.push(l);
  }
  fs.writeFileSync(f, out.join("\n"), "utf8");
  console.log(f, "去顶部 import 后", out.length, "行");
}
