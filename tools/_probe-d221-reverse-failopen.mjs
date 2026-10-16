// D221 · 反向验证 B：把「取不到授权上下文 ⇒ 拒绝（fail closed）」改成「⇒ 放行」
// 期望：只有 27s④ 那三条见红（其余 1720 项仍绿）——证明那条断言**真的守着 fail-closed**。
// 用法：node tools/_probe-d221-reverse-failopen.mjs [--restore]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, "..", "lib", "part2.js");
const BAK = path.join(process.env.TEMP ?? ".", "part2-before-reverse-b.js");

if (process.argv.includes("--restore")) {
  fs.copyFileSync(BAK, TARGET);
  console.log("已还原 part2.js");
  process.exit(0);
}

const src = fs.readFileSync(TARGET, "utf8");
const MARK = "if (connection === undefined || typeof connection.requestRejection !== ";
const idx = src.indexOf(MARK);
if (idx < 0) {
  console.error("★ 没找到 fail-closed 分支 —— 夹具故障，不是结论");
  process.exit(2);
}
const start = src.lastIndexOf("    if (", idx);
const endMark = "    let rejection;";
const end = src.indexOf(endMark, start);
if (start < 0 || end < 0) {
  console.error("★ 没定位到那个 if 块 —— 夹具故障");
  process.exit(2);
}

fs.writeFileSync(BAK, src);
const replacement =
  "    if (connection === undefined || typeof connection.requestRejection !== \"function\") {\n" +
  "      return handler(req, res);\n" +
  "    }\n";
fs.writeFileSync(TARGET, src.slice(0, start) + replacement + src.slice(end));
console.log("已把 fail-closed 改成 fail-open（取不到 connection 即放行）");
