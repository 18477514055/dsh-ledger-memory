/**
 * D376 补丁三：把 `blockInjectionEnabled` / `fileAnchorEnabled` 加进 part3.js 的
 * import 与 re-export 列表（它们已被搬到 part3-settings.js）。
 *
 * ★ 纪律（D368 定下、本轮再次确认）：
 *   `export { x } from "./y.js"` 只把名字**导出**，**不在本模块作用域绑定**
 *   ⇒ part3.js 内部若还要调用它们，**必须显式 import**。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const F = path.join(PROJECT_ROOT, "lib", "part3.js");
const ADD = ["blockInjectionEnabled", "fileAnchorEnabled"];

const text = fs.readFileSync(F, "utf8");
const lines = text.split("\n");

let importIdx = -1;
let reExportIdx = -1;
for (let i = 0; i < lines.length; i += 1) {
  if (/^import\s*\{.*\}\s*from\s+"\.\/part3-settings\.js";?\s*$/.test(lines[i])) importIdx = i;
  if (/^export\s*\{.*\}\s*from\s+"\.\/part3-settings\.js";?\s*$/.test(lines[i])) reExportIdx = i;
}
if (importIdx < 0 || reExportIdx < 0) {
  console.error("找不到 part3-settings 的 import / re-export 行");
  process.exit(1);
}

function addNames(line, names) {
  const m = /^(\s*(?:import|export)\s*\{)([\s\S]*?)(\}\s*from\s*"[^"]+";?\s*)$/.exec(line);
  if (!m) return null;
  const existing = m[2]
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const merged = [...existing];
  for (const n of names) if (!merged.includes(n)) merged.push(n);
  return `${m[1]} ${merged.join(", ")} ${m[3]}`;
}

const newImport = addNames(lines[importIdx], ADD);
const newReExport = addNames(lines[reExportIdx], ADD);
if (newImport === null || newReExport === null) {
  console.error("行格式不匹配，无法安全追加");
  process.exit(1);
}
lines[importIdx] = newImport;
lines[reExportIdx] = newReExport;

// 守恒断言：两行都必须真的含这两个名字
const problems = [];
for (const n of ADD) {
  if (!lines[importIdx].includes(n)) problems.push(`import 行缺 ${n}`);
  if (!lines[reExportIdx].includes(n)) problems.push(`re-export 行缺 ${n}`);
}
if (problems.length > 0) {
  console.error("★ 未写盘：");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

fs.writeFileSync(F, lines.join("\n"), "utf8");
console.log("已把 " + ADD.join(" / ") + " 加进 part3.js 的 import 与 re-export");
console.log("  import 行长度:", lines[importIdx].length);
console.log("  re-export 行长度:", lines[reExportIdx].length);
