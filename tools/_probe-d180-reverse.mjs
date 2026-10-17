/**
 * ★★★★★ 反向验证（D180）：摘掉「根本原则的授权守卫」⇒ 断言必须变红。
 *
 * ★ 为什么必须做（纪律 10）：本轮的核心承诺是「**没有授权绝对不能写**」。
 *   而这条守卫的实现是一个**字符串判空**（`authorizedBy === ""`）——
 *   它**极易被后人"顺手放宽"**（例如为了省事改成"总是允许"），
 *   而**全文仍然语法正确、绝大多数断言仍然绿**。
 *   ⇒ 只有反向验证能证明「73① 真的在拦」。
 *
 * ★ 摘法（一次一处理由同前）：把授权检查改成**恒不拒绝**（= 退回"模型能自己写"的旧世界）
 *   ⇒ 情形 73①（模型不带授权 ⇒ 被拒）与 73①b（文件没被创建）**必须红**。
 *
 * ★ 探针**无条件还原**并逐字节校验（sha256）。
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
console.log(`⓪ 备份 sha256=${origSha.slice(0, 16)}… (${original.length} B)`);

let s = original.toString("utf8");

// ── 摘点：把授权判据改成"永远视为已授权"（= 模型可自己写）────────────────
const NEEDLE = `    const authorizedBy = typeof args?.authorizedBy === "string" ? args.authorizedBy.trim() : "";
    if (authorizedBy === "") {`;
const n = s.split(NEEDLE).length - 1;
console.log(`① 授权判据命中 ${n} 次（应为 1）`);
if (n !== 1) {
  console.log("★ 定位失败（锚点漂了）⇒ 不改动，退出。★ 这本身也是有用信号。");
  process.exit(1);
}

s = s.replace(
  NEEDLE,
  `    const authorizedBy = typeof args?.authorizedBy === "string" ? args.authorizedBy.trim() : "";
    if (false /* ★反向验证 D180：摘掉授权守卫（模型可自己写） */) {`
);
fs.writeFileSync(LIB, s);
console.log(`   已写入退化版 sha256=${sha(fs.readFileSync(LIB)).slice(0, 16)}…`);

console.log(`\n=========== 自检（授权守卫摘掉之后）===========`);
let out = "";
try {
  out = execFileSync(process.execPath, [SELFTEST], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
}
const lines = out.split("\n");
const red = lines.filter((l) => /^\s*FAIL/.test(l));
console.log(`--- 红：${red.length} 条 ---`);
for (const r of red.slice(0, 20)) console.log("   " + r.trim().slice(0, 150));
for (const x of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + x.trim());
fs.writeFileSync(path.join(os.tmpdir(), "d180-reverse-out.txt"), out);

// ★ 无条件还原
fs.writeFileSync(LIB, original);
const restored = sha(fs.readFileSync(LIB));
console.log(`\n④ 已还原。sha256=${restored}`);
console.log(`   ${restored === origSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌（必须手工处理）"}`);
const guardRed = red.some((l) => /73①/.test(l));
console.log(
  guardRed
    ? "\n⇒ ★ 结论：摘掉授权守卫后**确实见红** ⇒ 「没有授权绝对不能写」真的有牙 ✅"
    : "\n⇒ ★★ 结论：摘掉后仍全绿 ⇒ ★★★ 那道守卫是摆设，必须重写"
);
