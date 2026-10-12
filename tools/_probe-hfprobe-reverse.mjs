/**
 * ★★★ 反向验证：把「全量探针」（水位到线就自造一句注入）**摘掉** ⇒ 30c-3 必须变红。
 *
 * ★ 为什么必须做（纪律 10）：我加了 4 条断言，若摘掉修复仍全绿，它们就是**空转**
 *   （本月已栽两次：D101 · D104）。★ 这一条尤其可疑 —— 因为"没有注入也该排队"
 *   在我第一版里**是绿的**（红的是"前提"），说明这个绿**来路不明**，必须验。
 *
 * ★ 做法：备份 + sha256 → 把探针整段禁用 → 跑自检 → ★ 无条件还原 + 校验。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const PLUGIN = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const LIB = path.join(PLUGIN, "lib", "index.js");
const SELFTEST = path.join(PLUGIN, "tools", "selftest.mjs");
const BACKUP = path.join(os.tmpdir(), "hfprobe-reverse-backup-index.js");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const original = fs.readFileSync(LIB);
const originalSha = sha(original);
fs.writeFileSync(BACKUP, original);
console.log(`① 备份 → ${BACKUP}`);
console.log(`   原 sha256 = ${originalSha}`);

let src = original.toString("utf8");

// 摘法：把探针的**条件**改成恒假（最小改动、且语法安全 —— 上次用 if(false) 包块导致语法错）。
//   用 `false &&` 换成 `true ||`… 不：直接把条件首项换成常量 false。
const NEEDLE = "          text === undefined &&\n          hfSettings.highFidelityCompact === true &&";
const hits = src.split(NEEDLE).length - 1;
console.log(`\n② 定位探针条件：命中 ${hits} 次`);

if (hits !== 1) {
  console.log("   ★ 不是恰好 1 次 ⇒ 不改动（避免误伤）");
} else {
  src = src.replace(NEEDLE, "          false &&\n          hfSettings.highFidelityCompact === true &&");
  fs.writeFileSync(LIB, src);
  console.log(`   已禁用探针；新 sha256 = ${sha(fs.readFileSync(LIB))}`);
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
  for (const r of red.slice(0, 20)) console.log("   " + r.trim().slice(0, 160));
  for (const s of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + s.trim());
  fs.writeFileSync(path.join(os.tmpdir(), "hfprobe-reverse-output.txt"), out);
  return red;
}

try {
  runSelftest("摘掉全量探针之后");
} finally {
  fs.writeFileSync(LIB, original);
  const restoredSha = sha(fs.readFileSync(LIB));
  console.log(`\n④ 已还原。还原后 sha256 = ${restoredSha}`);
  console.log(`   ${restoredSha === originalSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌"}`);
}
