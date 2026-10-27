// D330：数 section 口径（避开 node -e 的中文引号坑，写成文件跑）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "tools", "selftest.mjs"), "utf8");

// 行首（允许缩进）的 section( 调用；排除函数定义 `function section(`
const all = (src.match(/^\s*section\(/gm) ?? []).length;
const numbered = (src.match(/^\s*section\("情形 /gm) ?? []).length;

console.log(`section( 调用总数（行首、可缩进）：${all}`);
console.log(`其中带编号 `+"`section(\"情形 N\")`"+`：${numbered}`);
console.log("（台账口径应等于这两个数）");
console.log("PROBE-COMPLETE");
