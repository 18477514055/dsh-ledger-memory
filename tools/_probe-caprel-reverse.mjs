/**
 * ★★★ 反向验证（纪律第 10 条）：摘掉阶段 1 的 `capRel`，必须看得见红。
 *
 * 摘法：把 `recordShadowedIndex` 里存 `capRel` 的那一段去掉
 *   ⇒ 45④①（存下了）与 45④②（渲染带路径）必须红。
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

const NEEDLE = `      ...(typeof extra?.capRel === "string" && extra.capRel !== ""
        ? { capRel: extra.capRel }
        : {}),`;
if (!original.toString("utf8").includes(NEEDLE)) throw new Error("找不到存 capRel 那段 —— 先 read 确认");
let src = original.toString("utf8").replace(NEEDLE, "");
if (src === original.toString("utf8")) throw new Error("替换没生效");
fs.writeFileSync(LIB, src, "utf8");
console.log(`已摘掉存 capRel，sha256(前16) = ${sha(fs.readFileSync(LIB))}\n`);

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
console.log(`\n摘掉后出现的 FAIL：`);
if (fails.length === 0) console.log("  ★★★ 一条红都没有 —— 断言太弱！");
else for (const f of fails) console.log(`  · ${f.slice(0, 120)}`);

const hit = fails.filter((f) => f.includes("45④")).length;
const pass = hit >= 2 && H1 === H0;
console.log(`\n${pass ? `✅ 反向验证通过（45④ 有 ${hit} 条红，文件逐字节还原）` : `❌ 未通过（45④ 只红 ${hit} 条）`}`);
process.exit(pass ? 0 : 1);
