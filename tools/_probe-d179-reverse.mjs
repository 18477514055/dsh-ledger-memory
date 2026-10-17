/**
 * ★★★★★ 反向验证（D179 硬门）：把硬门**摘掉** ⇒ 断言必须变红。
 *
 * ★ 为什么必须做（纪律 10）：
 *   硬门这次改的是**"放行/不放行"**这一个布尔量，而它连着三处判据 +
 *   两套文案。★ `hardMaintenanceGateOn()` 一旦写返（我第一版就写反了，
 *   见 D179 §三），**全文仍然语法正确、大部分断言仍然绿** ⇒ 只有反向验证能抓。
 *
 * ★ 摘法（**一次只摘一处**，否则分不清是哪一处红）：
 *   ① 让 `hardMaintenanceGateOn()` 恒 **false**（= 退回旧行为：到期放行）
 *      ⇒ 情形 37i-4 那条「硬门开 ⇒ 推过 20 分钟仍不放行」**必须红**。
 *   ② 再验**文案**：硬门开着时不该出现"超时放行"那类话 ⇒ 摘掉硬门文案分支必红。
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

// ── 摘点：让硬门恒 false（= 退回"到期放行"的旧行为）───────────────────────
const N1 = `function hardMaintenanceGateOn() {
  return currentSettings().hardMaintenanceGate === true;
}`;
const n1 = s.split(N1).length - 1;
console.log(`① 硬门函数命中 ${n1} 次（应为 1）`);

// ── 摘点②：硬门文案分支（恒 false 会让它消失）────────────────────────────
const N2 = `          (hardMaintenanceGateOn()
            ? "- ★★★ **【硬门】这一条不是建议，是压缩的前提条件 —— 不做完，压缩就不会发生。**\\n" +`;
const n2 = s.split(N2).length - 1;
console.log(`② 合同块强信息命中 ${n2} 次（应为 1）`);

if (n1 !== 1 || n2 !== 1) {
  console.log("★ 定位失败（锚点漂了）⇒ 不改动，退出。★ 这本身也是有用信号。");
  process.exit(1);
}

// ★ 只摘 ①（判据）——② 随 ① 一起消失（因为文案是 `hardMaintenanceGateOn()` 渲染的）。
s = s.replace(N1, `function hardMaintenanceGateOn() {
  return false; /* ★反向验证 D179：摘掉硬门（回到"到期放行"） */
}`);
fs.writeFileSync(LIB, s);
console.log(`   已写入退化版 sha256=${sha(fs.readFileSync(LIB)).slice(0, 16)}…`);

console.log(`\n=========== 自检（硬门摘掉之后）===========`);
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
fs.writeFileSync(path.join(os.tmpdir(), "d179-reverse-out.txt"), out);

// ★ 无条件还原
fs.writeFileSync(LIB, original);
const restored = sha(fs.readFileSync(LIB));
console.log(`\n④ 已还原。sha256=${restored}`);
console.log(`   ${restored === origSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌（必须手工处理）"}`);
const gateRed = red.some((l) => /硬门开（默认）/.test(l));
console.log(
  gateRed
    ? "\n⇒ ★ 结论：摘掉硬门后**确实见红** ⇒ 硬门断言真的有牙 ✅"
    : "\n⇒ ★★ 结论：摘掉后仍全绿 ⇒ ★★★ 硬门断言是摆设，必须重写"
);
