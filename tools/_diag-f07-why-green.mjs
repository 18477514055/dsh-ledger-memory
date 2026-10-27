/** _diag-f07-why-green.mjs —— 为什么扫描器把漏绑的 setActiveSettings 报成绿？必须先查清尺子。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = fs.readFileSync(path.join(ROOT, "lib", "settings-http.js"), "utf8");
const lines = text.split("\n");

console.log("=== L640-650 原文 ===");
for (let i = 639; i < 650; i++) console.log((i + 1).toString().padStart(5), JSON.stringify(lines[i]));

// local 是怎么把 setActiveSettings 收进去的？
const local = new Set();
const hits = [];
for (let i = 0; i < lines.length; i++) {
  for (const m of lines[i].matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    if (m[1] === "setActiveSettings") hits.push(["decl-regex", i + 1, lines[i].trim()]);
    local.add(m[1]);
  }
  for (const m of lines[i].matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const p of m[1].split(",")) {
      const t = p.trim().split(/[=:\s]/)[0];
      if (t === "setActiveSettings") hits.push(["arrow-param", i + 1, lines[i].trim()]);
      if (t) local.add(t);
    }
  }
  for (const m of lines[i].matchAll(/function\s+\w+\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(",")) {
      const t = p.trim().split(/[=:\s]/)[0];
      if (t === "setActiveSettings") hits.push(["func-param", i + 1, lines[i].trim()]);
      if (t) local.add(t);
    }
  }
  for (const m of lines[i].matchAll(/catch\s*\(\s*(\w+)/g)) {
    if (m[1] === "setActiveSettings") hits.push(["catch-param", i + 1, lines[i].trim()]);
    local.add(m[1]);
  }
}
console.log("\n=== setActiveSettings 被当作 local 的来源 ===");
console.log(hits.length ? hits : "(没有 —— 那它不是 local 收进来的)");
console.log("local.has(setActiveSettings) =", local.has("setActiveSettings"));

// 那些含 "setActiveSettings" 的声明正则匹配，看它到底匹配到了什么
console.log("\n=== 含 setActiveSettings 的行，用声明正则去匹配看抓到谁 ===");
for (let i = 0; i < lines.length; i++) {
  if (!/setActiveSettings/.test(lines[i])) continue;
  const m = /(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(lines[i]);
  console.log(`  L${i + 1}: ${JSON.stringify(lines[i])}  => 抓到 ${m ? m[1] : "(无)"}`);
}
