/**
 * ★★★ 反向验证（纪律第 10 条）：**摘掉 D88 的兜底，必须看得见红**。
 *
 * 被验对象：情形 30x（兜底生效 / 不连环重压 / 让路优先）。
 * 做法：把判据①改回**旧写法**（只有锚点那一条，没有兜底线）：
 *   新：`if (!forced && !byAnchor && !byCap) { … return 不压 … }`
 *   旧：`if (!forced && since < trigger) { … return 不压 … }`
 * 跑自检，确认 30x 那几条变红；然后**逐字节还原**并核 sha256。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIB = path.join(ROOT, "lib", "index.js");
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

const original = fs.readFileSync(LIB);
const H0 = sha(original);
console.log(`原文件 sha256(前16) = ${H0}`);

const NEW = "  if (!forced && !byAnchor && !byCap) {";
const OLD = "  if (!forced && since < trigger) {";
let src = original.toString("utf8");
if (!src.includes(NEW)) throw new Error("找不到新判据 —— 先别下结论，去 read 一遍");
src = src.replace(NEW, OLD);
// ★ 同时把 `byAnchor`/`byCap`/`capLine`/`minGrowth` 的**计算**留着（避免 unused 报错），
//   但它们不再参与判断 ⇒ 等价于"回到旧行为"。
if (src === original.toString("utf8")) throw new Error("替换没生效");
fs.writeFileSync(LIB, src, "utf8");
console.log(`已抹掉兜底判据，sha256(前16) = ${sha(fs.readFileSync(LIB))}\n`);

let out = "", code = 0;
try {
  out = execFileSync(process.execPath, [path.join(ROOT, "tools", "selftest.mjs")], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  code = e.status ?? 1;
  out = String(e.stdout ?? "") + String(e.stderr ?? "");
}

fs.writeFileSync(LIB, original);
const H1 = sha(fs.readFileSync(LIB));
console.log(`已还原，sha256(前16) = ${H1}  ${H1 === H0 ? "✅ 逐字节一致" : "❌ 不一致！"}`);

const total = /通过 (\d+) 项，失败 (\d+) 项/.exec(out);
const fails = [...out.matchAll(/^\s+FAIL\s+(.+)$/gm)].map((m) => m[1].trim());
console.log(`\n自检退出码 = ${code}`);
console.log(`汇总：${total === null ? "（没读到汇总行）" : `通过 ${total[1]}，失败 ${total[2]}`}`);
console.log(`\n摘掉兜底后出现的 FAIL：`);
if (fails.length === 0) console.log("  ★★★ 一条红都没有 —— 断言太弱！");
else for (const f of fails) console.log(`  · ${f.slice(0, 110)}`);

// ★ 判据：30x①（兜底生效）必须红。
const hit = fails.some((f) => f.includes("30x①"));
const pass = hit && H1 === H0;
console.log(`\n${pass ? "✅ 反向验证通过（抹掉兜底后 30x① 确实变红，文件逐字节还原）" : "❌ 反向验证未通过"}`);
process.exit(pass ? 0 : 1);
