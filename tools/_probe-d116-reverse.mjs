/**
 * ★★★ 反向验证（D116）：把「压累计增量的一半」（动态）退回**固定 `deltaRemovePoints`**
 * ⇒ 断言必须变红。
 *
 * ★ 为什么必须做（纪律 10）：我刚把两条断言**改成适配新语义**
 *   （`目标 18 点`、`end=10`）。★ "改了断言去适配"最危险 —— 很可能变成
 *   "我改了什么就断言什么"，那它就不再是被测对象的约束了。
 *   ⇒ 唯一能区分"真在测"与"跟着改"的办法：**把实现退回去，看它红不红**。
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
const origSha = sha(original);
fs.writeFileSync(path.join(os.tmpdir(), "d116-reverse-lib.js"), original);
console.log(`⓪ 备份 sha256=${origSha.slice(0, 16)}…`);

let s = original.toString("utf8");
const NEEDLE = "  const removePoints = Math.max(1, Math.min(removeDynamic, removeBase * 2));";
const n = s.split(NEEDLE).length - 1;
console.log(`① 摘点命中 ${n} 次（应为 1）`);
if (n !== 1) {
  console.log("★ 定位失败 ⇒ 不改动，退出");
  process.exit(1);
}
// 退回"固定 = deltaRemovePoints"（= D116 之前的行为）
s = s.replace(NEEDLE, "  const removePoints = removeBase; /* ★反向验证：退回固定值 */");
fs.writeFileSync(LIB, s);
console.log(`   已写入退化版 sha256=${sha(fs.readFileSync(LIB)).slice(0, 16)}…`);

console.log(`\n=========== 自检（退回固定值之后）===========`);
let out = "";
try {
  out = execFileSync(process.execPath, [SELFTEST], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
}
const lines = out.split("\n");
const red = lines.filter((l) => /^\s*FAIL/.test(l));
console.log(`--- 红：${red.length} 条 ---`);
for (const r of red.slice(0, 16)) console.log("   " + r.trim().slice(0, 155));
for (const x of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + x.trim());
fs.writeFileSync(path.join(os.tmpdir(), "d116-reverse-out.txt"), out);

// ★ 无条件还原
fs.writeFileSync(LIB, original);
const restored = sha(fs.readFileSync(LIB));
console.log(`\n④ 已还原。sha256=${restored}`);
console.log(`   ${restored === origSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌"}`);
console.log(
  red.length > 0
    ? "\n⇒ ★ 结论：退回固定值后**确实见红** ⇒ 那两条断言真的在测「动态一半」✅"
    : "\n⇒ ★★ 结论：退回后仍全绿 ⇒ ★★★ 那两条断言是**跟着我改的**，必须重写"
);
