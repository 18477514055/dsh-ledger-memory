/**
 * ★★★ 反向验证：把 `busy` 判据**退回旧版**（只认文本正则）⇒ 新断言必须变红。
 *
 * ★ 为什么必须做（纪律 10）：**摘一处不红，要么断言太弱、要么修复冗余。**
 *   我新加了 18 条断言，若摘掉修复后**依然全绿**，那它们就是**空转**（本月已栽两次）。
 *
 * ★ 做法（绝不原地改真源）：
 *   ① 备份 lib/index.js + sha256
 *   ② 把「code 优先」那段摘掉（只留旧正则，且去掉我新补的两个关键词）
 *   ③ 跑自检，抓红的用例名
 *   ④ ★ 无条件还原 + sha256 校验逐字节一致
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const PLUGIN = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const LIB = path.join(PLUGIN, "lib", "index.js");
const SELFTEST = path.join(PLUGIN, "tools", "selftest.mjs");
const BACKUP = path.join(os.tmpdir(), "busy-reverse-backup-index.js");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const original = fs.readFileSync(LIB);
const originalSha = sha(original);
fs.writeFileSync(BACKUP, original);
console.log(`① 备份 → ${BACKUP}`);
console.log(`   原 sha256 = ${originalSha}`);

let src = original.toString("utf8");

// 摘点 ①：把「code 优先」拿掉，只留**旧的**文本正则（且不含我新补的两个词）
const NEW_JUDGE_START = "  const codeBusy = r.errorCode === \"busy\";";
const NEW_JUDGE_END = "  const busy = codeBusy || textBusy;";
const iStart = src.indexOf(NEW_JUDGE_START);
const iEnd = src.indexOf(NEW_JUDGE_END);
console.log(`\n② 摘点定位：start=${iStart} end=${iEnd}`);

if (iStart === -1 || iEnd === -1) {
  console.log("   ★ 定位失败 ⇒ 不改动，直接退出（保证还原）");
} else {
  const OLD_JUDGE =
    "  const busy = /busy|open turn|已有活跃|not idle|already has active work/i.test(reason);";
  src = src.slice(0, iStart) + OLD_JUDGE + "\n" + src.slice(iEnd + NEW_JUDGE_END.length);
  // 摘点 ②：catch 里不再带 code 出去（复刻"丢掉结构化字段"的原始病灶）
  const CATCH_NEEDLE = "      ...(code === undefined ? {} : { errorCode: code }),";
  const before = src.split(CATCH_NEEDLE).length - 1;
  src = src.split(CATCH_NEEDLE).join("      /* ★反向验证：已摘掉 errorCode */");
  console.log(`   摘点②（catch 不再带 errorCode）：命中 ${before} 次`);
  fs.writeFileSync(LIB, src);
  console.log(`   已写入退化版；新 sha256 = ${sha(fs.readFileSync(LIB))}`);
}

function runSelftest(label) {
  console.log(`\n=========== 自检（${label}）===========`);
  let out = "";
  try {
    out = execFileSync(process.execPath, [SELFTEST], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
  }
  const lines = out.split("\n");
  const red = lines.filter((l) => /^\s*FAIL/.test(l));
  console.log(`--- 红：${red.length} 条 ---`);
  for (const r of red.slice(0, 40)) console.log("   " + r.trim().slice(0, 170));
  const sum = lines.filter((l) => /通过 \d+ 项/.test(l));
  for (const s of sum) console.log("   " + s.trim());
  const dump = path.join(os.tmpdir(), "busy-reverse-output.txt");
  fs.writeFileSync(dump, out);
  console.log(`   （完整输出：${dump}）`);
  return red;
}

try {
  runSelftest("把 busy 判据退回旧版之后");
} finally {
  fs.writeFileSync(LIB, original);
  const restoredSha = sha(fs.readFileSync(LIB));
  console.log(`\n④ 已从备份还原。`);
  console.log(`   还原后 sha256 = ${restoredSha}`);
  console.log(`   ${restoredSha === originalSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌"}`);
}
