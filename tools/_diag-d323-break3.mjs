/** _diag-d323-break3.mjs —— 查清"破坏 3 没变红"是夹具没命中，还是判据太弱。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "lib", "settings-http.js"), "utf8");

const at = src.indexOf("export function saveSettings");
const seg = src.slice(at, at + 2000);

console.log("=== saveSettings 里 assertAuthorized 与 .edit( 的位置 ===");
console.log("  assertAuthorized 绝对位置:", src.indexOf("assertAuthorized", at));
console.log("  .edit( 绝对位置:", src.indexOf(".edit(", at));

// 我的替换正则命中了吗？
const lineRe = /^\s*const verdict = assertAuthorized\(scope, req\);\s*$/m;
const m = lineRe.exec(seg);
console.log("\n=== 夹具正则命中 saveSettings 段里的自查行? ===");
console.log("  ", m ? JSON.stringify(m[0]) : "🔴 没命中");

// 整个文件里有几处这种行
const all = [...src.matchAll(/^\s*const verdict = assertAuthorized\(scope, req\);\s*$/gm)];
console.log(`\n全文匹配 ${all.length} 处：`);
for (const x of all) {
  // 算它属于哪个函数
  const before = src.slice(0, x.index);
  const fn = [...before.matchAll(/^export function (\w+)/gm)].pop();
  console.log(`   pos=${x.index}  在 ${fn ? fn[1] : "?"} 里`);
}
