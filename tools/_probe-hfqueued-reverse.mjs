/**
 * ★★★ 反向验证探针：把 `!hfQueued` 摘掉，看**到底哪几条用例变红**，并查清**为什么**。
 *
 * ★ 要验证的假设（来自 D105 §五的"诚实边界"）：
 *   "当初摘掉 `!hfQueued` 会把 6 条增量用例打红、regionCalls 停在 0"
 *   ⇒ 但**那 6 条用例的夹具里可能根本没有 idle 事件** ⇒ 队列永不被消费
 *      ⇒ 增量每一步都让路 ⇒ regionCalls 停在 0 = **夹具缺 idle 造成的假红**。
 *
 * ★ 做法（绝不原地改真源）：
 *   ① 读 lib/index.js 原文，备份到 %TEMP% 并记 sha256
 *   ② 把 `&& !hfQueued` 去掉，写回
 *   ③ 跑 selftest，抓"红"的那些用例名
 *   ④ ★ **无条件从备份还原**，并用 sha256 校验逐字节一致
 *
 * ★ 判据（纪律 2）：红/绿由 selftest **自己**输出，我不解释、不推测。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const PLUGIN = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const LIB = path.join(PLUGIN, "lib", "index.js");
const SELFTEST = path.join(PLUGIN, "tools", "selftest.mjs");
const BACKUP = path.join(os.tmpdir(), "hfqueued-backup-index.js");

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const original = fs.readFileSync(LIB);
const originalSha = sha(original);
fs.writeFileSync(BACKUP, original);
console.log(`① 已备份 lib/index.js → ${BACKUP}`);
console.log(`   原 sha256 = ${originalSha}`);
console.log(`   字节数   = ${original.length}`);

// 目标：`const hfQueued = ...` 与 `&& !hfQueued` 两处
const src = original.toString("utf8");
const NEEDLE = "&& !hfQueued";
const count = src.split(NEEDLE).length - 1;
console.log(`\n② 目标串 ${JSON.stringify(NEEDLE)} 出现 ${count} 次`);

if (count !== 1) {
  console.log("   ★ 不是恰好 1 次 ⇒ 不做改动（避免误伤），直接退出并保证还原。");
} else {
  const patched = src.replace(NEEDLE, "&& true /* ★探针：摘掉 !hfQueued */");
  fs.writeFileSync(LIB, patched);
  const patchedSha = sha(fs.readFileSync(LIB));
  console.log(`   已写入补丁；新 sha256 = ${patchedSha}`);
  console.log(`   （与原不同的文件：${patchedSha !== originalSha}）`);
}

/** 跑 selftest，返回 {pass, fail, red:[]}。 */
function runSelftest(label) {
  console.log(`\n=========== 跑自检（${label}）===========`);
  let out = "";
  try {
    out = execFileSync(process.execPath, [SELFTEST], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
  }
  const lines = out.split("\n");
  // 抓"红"的：形如 `FAIL ...` / `✗ ...` / `not ok ...` —— 三种都收，不猜是哪一种
  const red = lines.filter((l) => /^\s*(FAIL|✗|not ok|✘)/i.test(l) || /^\s*\[红\]/.test(l));
  const summary = lines.filter((l) => /\d+\s*(passed|通过)/i.test(l) || /失败|failed/i.test(l)).slice(-6);
  console.log("--- 摘要行 ---");
  for (const s of summary) console.log("   " + s.trim());
  console.log(`--- 判为红的行：${red.length} 条 ---`);
  for (const r of red.slice(0, 40)) console.log("   " + r.trim().slice(0, 200));
  return { out, red, summary };
}

try {
  const r = runSelftest("摘掉 !hfQueued 之后");
  // 把原始输出落盘，便于人工核对（不注入上下文）
  const dump = path.join(os.tmpdir(), "hfqueued-selftest-output.txt");
  fs.writeFileSync(dump, r.out);
  console.log(`\n（完整输出已落盘：${dump}，${r.out.length} 字符）`);
} finally {
  // ★★ 无条件还原 + 校验
  fs.writeFileSync(LIB, original);
  const restored = fs.readFileSync(LIB);
  const restoredSha = sha(restored);
  console.log(`\n④ 已从备份还原。`);
  console.log(`   还原后 sha256 = ${restoredSha}`);
  console.log(`   ${restoredSha === originalSha ? "★ 逐字节一致 ✅" : "★★★ 不一致，必须手工处理 ❌"}`);
  console.log(`   字节数 = ${restored.length}（原 ${original.length}）`);
}
