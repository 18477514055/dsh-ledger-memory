// 复刻 selftest.mjs:8567-8598 的自发现判据，**逐字照抄那 5 条**，数出真实值。
// ★ 为什么单独写：`DANGEROUS_EXPECTED` 是硬编码的 75，而我本轮新增了几个探针 ⇒ 必然漂移。
//   ★ 判据（台账已记）：**这个数不许靠推理，必须让自检自己数出来**。
//   本脚本只是把那段逻辑搬出来单跑，省得为改一个数字去跑整份自检。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolsDir = path.join(ROOT, "tools");

const found = [];
for (const nm of fs.readdirSync(toolsDir)) {
  if (!nm.endsWith(".mjs") || nm === "selftest.mjs") continue;
  const src = fs.readFileSync(path.join(toolsDir, nm), "utf8");
  // ↓↓↓ 与 selftest.mjs:8574-8594 逐字一致 ↓↓↓
  const writesLib =
    /writeFileSync\s*\(\s*LIB\b/.test(src) ||
    /writeFileSync\s*\(\s*path\.join\([^)]*"lib"[^)]*\)/.test(src) ||
    /["'`]lib[\\/]index\.js["'`]/.test(src) ||
    /writeFileSync\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*[^)]*"lib[\\/][^"]+"/.test(src) ||
    /path\.join\([^)]*"lib[\\/][^"]+"/.test(src);
  if (writesLib) found.push(nm);
}

const EXPECTED = 75;
console.log(`扫到 ${found.length} 个；selftest 里硬编码 DANGEROUS_EXPECTED = ${EXPECTED}`);
console.log(`差 ${found.length - EXPECTED}（正 = 需要把常量调大）\n`);

// 本轮新增的（用于判断是不是我自己的锅）
const mine = [
  "_probe-d334-cardhome.mjs",
  "_fix-d334-cardmove.mjs",
  "_probe-d334-f02-fingerprint.mjs",
  "_probe-d335-014-repro.mjs",
  "_probe-d335-014-repro2.mjs",
  "_probe-d335-014-copy-run.mjs",
  "_diag-d335-countfix.mjs",
  "_probe-d335-014-verify.mjs",
  "_reverse-verify-d335.mjs",
];
console.log("=== 本轮我新增/改过的脚本，是否被扫进来 ===");
for (const m of mine) console.log(`  ${found.includes(m) ? "✓ 计入" : "· 未计入"}  ${m}`);

console.log("\n=== 全部被扫到的（按名排序）===");
for (const n of found.sort()) console.log(`  ${n}`);
console.log(`\nPROBE-COMPLETE  共 ${found.length} 个`);
