/** _diag-f07-bound.mjs —— 打印 bound 集合与 import 正则命中情况。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = fs.readFileSync(path.join(ROOT, "lib", "settings-http.js"), "utf8");

const re = /import\s+(?:(\w+)\s*,\s*)?(?:\{([^}]*)\}|(\w+))?\s*from\s*["'][^"']+["']/g;
let m;
let n = 0;
const bound = new Set();
while ((m = re.exec(text)) !== null) {
  n++;
  console.log(`match ${n}: default=${m[1] ?? "-"} names=${(m[2] ?? m[3] ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
  if (m[1]) bound.add(m[1]);
  if (m[3]) bound.add(m[3]);
  if (m[2]) for (const x of m[2].split(",")) {
    const t = x.trim().split(/\s+as\s+/).pop().trim();
    if (t) bound.add(t);
  }
}
console.log(`\nimport 命中 ${n} 条，bound 共 ${bound.size} 个名字`);
console.log("bound 里有 setActiveSettings 吗 =", bound.has("setActiveSettings"));
console.log("全文含 setActiveSettings（含注释）= ", text.includes("setActiveSettings"));

// 关键：数一下 import 头里到底有多少个名字被真正绑上
console.log("\nbound 排序后前 40：", [...bound].sort().slice(0, 40).join(", "));
