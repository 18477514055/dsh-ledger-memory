// 用 selftest 里**真正的** stripCommentsAndLiterals 验证它不再被字面量骗到。
// ★ 直接从 selftest.mjs 里把函数源码抠出来 eval —— 避免"又抄一份"导致诊断与实物分叉。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const selfPath = path.join(ROOT, "tools", "selftest.mjs");
const selfSrc = fs.readFileSync(selfPath, "utf8");

// 抠出两个函数（stripCommentsAndLiterals 与 needsValueAfter）
const start = selfSrc.indexOf("function stripCommentsAndLiterals");
const end = selfSrc.indexOf("/** `/` 前面是这些字符时");
if (start < 0 || end < 0) throw new Error(`定位失败 start=${start} end=${end}`);
const fn1 = selfSrc.slice(start, end);

const nvStart = selfSrc.indexOf("function needsValueAfter");
const nvEnd = selfSrc.indexOf("}", selfSrc.indexOf("return \"(,=:[!&|?{};+-*%~^<>\".includes(ch)", nvStart)) + 1;
const fn2 = selfSrc.slice(nvStart, nvEnd);

const factory = new Function(`${fn2}\n${fn1}\nreturn stripCommentsAndLiterals;`);
const strip = factory();

// ── 夹具自检：必须能证明它扛得住"字面量里的块注释结束符" ──────────────
const tricky = `
const a = 1;
// 一条普通注释
const re = /^[^0-9]*/;   // ← 这里的尾部两字符就是块注释结束符
function after() {}
const s = "字符串里的 /* 不该算注释";
function after2() {}
`;
const out = strip(tricky);
console.log("=== 夹具：含字面量结束符 + 字符串里的 /* ===");
console.log("  after 保住:", out.includes("function after"));
console.log("  after2 保住:", out.includes("function after2"));
console.log("  普通注释被剥:", !out.includes("一条普通注释"));

// ── 真实对象：part2.js ────────────────────────────────────────────────
const p2 = fs.readFileSync(path.join(ROOT, "lib", "part2.js"), "utf8");
const code = strip(p2);
const names = ["authorizeRequest", "assertAuthorized", "writeFileAtomic", "isUnderReal"];
console.log("\n=== part2.js 真实扫描 ===");
let bad = 0;
for (const n of names) {
  const re = new RegExp(`export\\s+function\\s+${n}\\s*\\(`);
  const ok = re.test(code);
  if (!ok) bad++;
  console.log(`  ${n}: ${ok ? "OK" : "**丢了**"}`);
}
const origCount = [...p2.matchAll(/export\s+function\s+(\w+)/g)].length;
const keptCount = [...code.matchAll(/export\s+function\s+(\w+)/g)].length;
console.log(`  export function：原文 ${origCount} / 剥后 ${keptCount}`);
if (origCount !== keptCount) bad++;
console.log(bad === 0 ? "\n✅ 新的 strip 正确" : `\n❌ ${bad} 处问题`);
process.exitCode = bad === 0 ? 0 : 1;
