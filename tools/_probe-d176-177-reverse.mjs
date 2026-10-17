/**
 * ★★★★★ 反向验证（D176/D177）：把两处新修复**摘掉** ⇒ 断言必须变红。
 *
 * ★ 为什么必须做（纪律 10 —— 本项目最硬的一条，已栽多次）：
 *   这次的两条修复都很"轻"（一个判据函数 + 一段文案），**轻修复最容易写出空断言** ——
 *   因为"摘掉它"和"留着它"在大多数路径上表现一样。
 *   ⇒ 唯一能证明断言有牙的办法：**真把它摘掉，看它红不红**。
 *
 * ★ 本次摘两处（各自独立）：
 *   ① **D176 子代理豁免**：把 `shouldHandleSession()` 改成恒 `true`
 *      （= 退回"子代理照样被管"的旧行为）⇒ 情形 71① / 71②b 必须红。
 *   ② **D177 主动回想**：把那段回想文案整块去掉
 *      （= 退回"压缩后不回想"的旧行为）⇒ 情形 72① / ② / ③ 必须红。
 *
 * ★ 探针**无条件还原**，并逐字节校验（sha256）。
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

// ── 摘点①：D176 豁免 —— 让 `shouldHandleSession` 恒真 ─────────────────────
const N1 = `function shouldHandleSession(agentOrSession) {
  return !isSubagentSession(agentOrSession);
}`;
const n1 = s.split(N1).length - 1;
console.log(`① D176 豁免函数命中 ${n1} 次（应为 1）`);

// ── 摘点②：D177 主动回想 —— 去掉整段标题（拿掉"先做一次「主动回想」"这个锚）──
const N2 = `"\\n## ★ 先做一次「主动回想」（压缩刚发生，这是你要做的第一件事）\\n\\n" +`;
const n2 = s.split(N2).length - 1;
console.log(`② D177 回想标题命中 ${n2} 次（应为 1）`);

if (n1 !== 1 || n2 !== 1) {
  console.log("★ 定位失败（锚点漂了）⇒ 不改动，退出。★ 这本身也是有用信号：锚点必须重取。");
  process.exit(1);
}

s = s.replace(N1, `function shouldHandleSession(agentOrSession) {
  return true; /* ★反向验证 D176：摘掉豁免（子代理照样被管） */
}`);
s = s.replace(N2, `"\\n## （反向验证 D177：主动回想已被摘掉）\\n\\n" +`);
fs.writeFileSync(LIB, s);
console.log(`   已写入退化版 sha256=${sha(fs.readFileSync(LIB)).slice(0, 16)}…`);

console.log(`\n=========== 自检（两处修复都摘掉之后）===========`);
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
fs.writeFileSync(path.join(os.tmpdir(), "d176-177-reverse-out.txt"), out);

// ★ 无条件还原
fs.writeFileSync(LIB, original);
const restored = sha(fs.readFileSync(LIB));
console.log(`\n④ 已还原。sha256=${restored}`);
console.log(`   ${restored === origSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌（必须手工处理）"}`);
const d176red = red.some((l) => /71[①②]/.test(l));
const d177red = red.some((l) => /72[①②③]/.test(l));
console.log(`\n⇒ D176 豁免：${d176red ? "★ 见到红 ✅" : "★★★ 没红 ⇒ 断言是摆设"}`);
console.log(`⇒ D177 回想：${d177red ? "★ 见到红 ✅" : "★★★ 没红 ⇒ 断言是摆设"}`);
