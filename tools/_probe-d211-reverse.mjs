/**
 * 反向验证（D211）—— 把这一轮的两处修复**逐处摘掉**，看自检到底红不红。
 *
 * ★★★ 纪律第 10 条：**反向验证必须摘到"能看见红"为止** —— 摘一处不红，
 *   要么断言太弱、要么修复冗余，两种都要查清。
 * ★★ 纪律 **L34**（我自己踩过）：反向脚本**自己写坏**（语法错 ⇒ 自检崩）
 *   与"全绿"在 FAIL 计数上**完全一样** ⇒ 每一轮都必须**断言自检真跑完了**
 *   （`通过 N 项` 解析不出来 ⇒ 判"脚本坏了"，不是"没红"）。
 *
 * 跑法：node tools/_probe-d211-reverse.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "lib", "index.js");
const SELFTEST = path.join(HERE, "selftest.mjs");

const backup = fs.readFileSync(LIB, "utf8");

function runSelftest() {
  const r = spawnSync(process.execPath, [SELFTEST], {
    cwd: path.join(HERE, ".."),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const m = /通过\s+(\d+)\s+项，失败\s+(\d+)\s+项/.exec(out);
  const passN = m === null ? -1 : Number(m[1]);
  const failN = m === null ? -1 : Number(m[2]);
  const failed = out
    .split("\n")
    .filter((l) => /^\s+FAIL\s/.test(l))
    .map((l) => l.trim());
  return { passN, failN, failed, ran: m !== null };
}

function patchOne(label, oldStr, newStr) {
  if (!backup.includes(oldStr)) {
    console.log(`  ✗ 摘除点找不到 —— 反向验证**无效**（脚本该修）：${label}`);
    return false;
  }
  fs.writeFileSync(LIB, backup.replace(oldStr, newStr), "utf8");
  return true;
}

let allOk = true;
function check(label) {
  const r = runSelftest();
  if (!r.ran) {
    console.log("  ✗✗ **自检没跑完**（脚本把它改坏了）—— 这不是「没红」，是**无效验证**");
    allOk = false;
    return r;
  }
  const red = r.failN > 0;
  console.log(`  ${red ? "✅ 见红" : "★★ 没红 ⇒ 断言太弱或修复冗余"} ｜ 通过=${r.passN} 失败=${r.failN}`);
  if (red) console.log(`      红的：${r.failed.slice(0, 3).join(" ｜ ")}`);
  if (!red) allOk = false;
  return r;
}

console.log("════════ D211 反向验证：摘掉修复，自检该红吗？ ════════\n");

console.log("【基线】不改任何东西：");
{
  const r = runSelftest();
  console.log(`  ${r.ran && r.failN === 0 ? "✅ 全绿" : "★★ 基线就不干净！"} ｜ 通过=${r.passN} 失败=${r.failN}`);
  if (!r.ran || r.failN !== 0) allOk = false;
}

// ── 摘除点 ①：**基线键不带 sid**（= 退回 D210 的"按项目根共享"）───────────────
console.log("\n【摘除点 ①】基线键退回「只按项目根」（同项目第二个对话就收不到）：");
if (
  patchOne(
    "per-conversation-baseline",
    `  const sid = info?.sid === undefined || info.sid === null ? "" : String(info.sid);
  return sid === "" ? root : \`\${root}\\u0000\${sid}\`;`,
    `  return root;`
  )
) {
  check("baseline-not-per-conversation");
}

// ── 摘除点 ②：**广播序号不进指纹**（按钮按了也没用）──────────────────────────
console.log("\n【摘除点 ②】广播序号不再参与指纹（面板按钮变成空按钮）：");
if (
  patchOne(
    "broadcast-in-fingerprint",
    "  const broadcastTag = `b${settingsBroadcastSeqOf()}`;",
    '  const broadcastTag = "b0";'
  )
) {
  check("broadcast-not-in-fingerprint");
}

// ── 恢复现场 ────────────────────────────────────────────────────────────────
fs.writeFileSync(LIB, backup, "utf8");
console.log("\n【恢复】已把 lib/index.js 还原。");
const back = runSelftest();
console.log(`  还原后：通过=${back.passN} 失败=${back.failN} ⇒ ${back.ran && back.failN === 0 ? "✅ 干净" : "★★ 没还原干净！"}`);
if (!back.ran || back.failN !== 0) allOk = false;

console.log(`\n${allOk ? "★★★ 反向验证通过：两处修复都摘得见红。" : "★★ 反向验证**有问题**，见上面。"}`);
process.exitCode = allOk ? 0 : 1;
