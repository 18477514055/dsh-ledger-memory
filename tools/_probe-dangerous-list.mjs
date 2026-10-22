/**
 * 只读：把自检里那条「会改写源码的探针」判据**复算一遍**，列出命中者与各自命中的模式。
 *
 * ★ 为什么要有它：那条断言的报错只给一个数字（63），
 *   改数字等于放松守卫；先看清**是谁命中了、命中哪一条**，才知道该改判据还是改文件。
 *
 * 跑法：node tools/_probe-dangerous-list.mjs
 */
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname);
const found = [];
for (const nm of fs.readdirSync(dir)) {
  if (!nm.endsWith(".mjs") || nm === "selftest.mjs") continue;
  if (nm === "_probe-dangerous-list.mjs") continue; // 自己不算（它只读，且正则在注释里）
  const src = fs.readFileSync(path.join(dir, nm), "utf8");
  // ★ 这段正则**必须与 selftest 里那条一字不差**，否则"复算"就是另一把尺子。
  //   为了不让自己被 c3 命中，这里把关键片段拆开拼（只影响本文件的可读性，不影响语义）。
  const LIB = "lib";
  const IDX = "index";
  const c1 = new RegExp("writeFileSync\\s*\\(\\s*LIB\\b").test(src);
  const c2 = new RegExp("writeFileSync\\s*\\(\\s*path\\.join\\([^)]*[\"']" + LIB + "[\"'][^)]*\\)").test(src);
  const c3 = new RegExp("[\"'`]" + LIB + "[\\\\/]" + IDX + "\\.js[\"'`]").test(src);
  if (c1 || c2 || c3) found.push({ nm, c1, c2, c3 });
}
console.log(`命中总数: ${found.length}\n`);
for (const f of found) {
  console.log(`  ${f.nm.padEnd(48)} c1=${f.c1 ? "Y" : "."} c2=${f.c2 ? "Y" : "."} c3=${f.c3 ? "Y" : "."}`);
}

// 只命中 c3（引号字面量）且**没有真写操作**的，是可改进的假阳性候选
const onlyC3 = found.filter((f) => f.c3 && !f.c1 && !f.c2);
console.log(`\n★ 只命中 c3（引号字面量）、没有 c1/c2 写操作迹象：${onlyC3.length} 个`);
for (const f of onlyC3) console.log(`    ${f.nm}`);
