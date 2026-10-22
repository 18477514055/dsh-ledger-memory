// 验证 declaresFunction 的思路对真实源码成立。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "lib", "part2.js"), "utf8");

function declaresFunction(text, name) {
  const re = new RegExp("^export\\s+(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
  return re.test(text);
}

const names = ["authorizeRequest", "assertAuthorized", "writeFileAtomic", "isUnderReal", "findDeFactoLedger"];
let bad = 0;
for (const n of names) {
  const got = declaresFunction(src, n);
  if (!got) bad++;
  console.log(`  ${got ? "PASS" : "FAIL"}  ${n}`);
}

// 与"原文里的 export function 总数"对账（这是最强的一致性检查）
const total = [...src.matchAll(/^export\s+function\s+(\w+)/gm)].length;
console.log(`\n^export function 总数（行首锚定）= ${total}`);
console.log(bad === 0 ? "✅ 全部命中" : `❌ ${bad} 个未命中`);
process.exitCode = bad ? 1 : 0;
