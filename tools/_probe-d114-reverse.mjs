/**
 * ★★★ 反向验证（D114）：把「AI 主动压必须过闸门」这个修复**退回去** ⇒ 新断言必须变红。
 *
 * ★ 要退的正是**真缺口本身**（不是随便挑一处）：
 *   消费旗子时不再看 `source`，一律当"人手动"⇒ `forcedLight = true` ⇒ `force: true`
 *   ⇒ AI 主动压**又**绕过落盘闸门（= 修复前的行为）。
 *
 * ★ 判据（纪律 10）：若退回后**仍然全绿** ⇒ 我那 9 条断言是**空转**的。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const PLUGIN = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const LIB = path.join(PLUGIN, "lib", "index.js");
const SELFTEST = path.join(PLUGIN, "tools", "selftest.mjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const original = fs.readFileSync(LIB);
const originalSha = sha(original);
const BACKUP = path.join(os.tmpdir(), "d114-reverse-lib.js");
fs.writeFileSync(BACKUP, original);
console.log(`① 备份 → ${BACKUP}\n   原 sha256 = ${originalSha}`);

let src = original.toString("utf8");
// 退回成"一律当人手动"（= 修复前：AI 也豁免闸门）
const NEEDLE = `            if (fr.source === "command") forcedLight = true;
            else toolRequestedLight = true;`;
const n = src.split(NEEDLE).length - 1;
console.log(`\n② 摘点命中 ${n} 次（应为 1）`);
if (n === 1) {
  src = src.replace(NEEDLE, `            forcedLight = true; /* ★反向验证：退回"一律当人手动" */`);
  fs.writeFileSync(LIB, src);
  console.log(`   已写入退化版；新 sha256 = ${sha(fs.readFileSync(LIB))}`);
}

console.log(`\n=========== 自检（退回修复之后）===========`);
let out = "";
try {
  out = execFileSync(process.execPath, [SELFTEST], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
}
const lines = out.split("\n");
const red = lines.filter((l) => /^\s*FAIL/.test(l));
console.log(`--- 红：${red.length} 条 ---`);
for (const r of red.slice(0, 20)) console.log("   " + r.trim().slice(0, 165));
for (const s of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + s.trim());
fs.writeFileSync(path.join(os.tmpdir(), "d114-reverse-output.txt"), out);

// ★ 无条件还原
fs.writeFileSync(LIB, original);
const restored = sha(fs.readFileSync(LIB));
console.log(`\n④ 已还原。还原后 sha256 = ${restored}`);
console.log(`   ${restored === originalSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌"}`);
console.log(
  red.length > 0
    ? "\n⇒ ★ 结论：退回修复后**确实见红** ⇒ 断言有效、修复承重 ✅"
    : "\n⇒ ★★ 结论：退回后仍然全绿 ⇒ ★★★ 断言是空转的，必须重写"
);
