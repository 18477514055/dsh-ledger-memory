/**
 * ★★★ 反向验证（纪律第 10 条）：把兜底线改回**旧写法**（低于全量线），必须看得见红。
 *
 * 旧写法：`capLine = min(全量线, 内核线) − 5` ⇒ 用户设 0.75 时 = **0.70**（低于全量线）
 *   ⇒ 水位一进 [0.70, 0.75) 增量就抢跑 ⇒ **全量被永久饿死**。
 * 新写法：`capLine = min(内核线 − 5, 全量线)` ⇒ = 0.75（不低于全量线）⇒ 让路先命中。
 *
 * 期望：改回旧写法后 **30x①**（增量不许抢）变红。
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

const NEW = `  const capLine = Math.min(
    KERNEL_HARD_COMPACT_RATIO - DELTA_TRIGGER_CAP_MARGIN_POINTS / 100,
    settings.highFidelityCompactRatio
  );`;
const OLD = `  const capRatio = Math.min(settings.highFidelityCompactRatio, KERNEL_HARD_COMPACT_RATIO);
  const capLine = Math.max(0, capRatio - DELTA_TRIGGER_CAP_MARGIN_POINTS / 100);`;
let src = original.toString("utf8");
if (!src.includes(NEW)) throw new Error("找不到新写法 —— 先 read 确认");
src = src.replace(NEW, OLD);
if (src === original.toString("utf8")) throw new Error("替换没生效");
fs.writeFileSync(LIB, src, "utf8");
console.log(`已改回旧写法（兜底线低于全量线），sha256(前16) = ${sha(fs.readFileSync(LIB))}\n`);

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
console.log(`\n改回旧写法后出现的 FAIL：`);
if (fails.length === 0) console.log("  ★★★ 一条红都没有 —— 断言太弱！");
else for (const f of fails) console.log(`  · ${f.slice(0, 120)}`);

const hit = fails.some((f) => f.includes("30x①"));
const pass = hit && H1 === H0;
console.log(`\n${pass ? "✅ 反向验证通过（旧写法下 30x① 变红 = 那个回归确实被抓住）" : "❌ 反向验证未通过"}`);
process.exit(pass ? 0 : 1);
