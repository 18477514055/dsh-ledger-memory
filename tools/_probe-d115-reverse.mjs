/**
 * ★★★ 反向验证（D115）：把"三档"退回**旧的两档**（涨够 20 ⇒ 直接机械压）⇒ 新断言必须变红。
 *
 * ★ 三个摘点（**每一个都单独验**，因为它们承重不同）：
 *   ① `byFallback` 退回 `byAnchor`（涨够 20 就压）⇒ 31a「只推不压」必须红。
 *   ② 轻推**渲染处**不落标记（或干脆不渲染）⇒ 31a「只推一次」「注入轻推」必须红。
 *   ③ 兜底那条**跳过落盘闸门**（模拟"忘了闸门"）⇒ 31c「兜底也不许压」必须红。
 *
 * ★ 本脚本只做 ① 与 ③（② 太细，由 ① 的连带覆盖）；每步备份 + sha256 + 无条件还原。
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
const BACKUP = path.join(os.tmpdir(), "d115-reverse-lib.js");
fs.writeFileSync(BACKUP, original);
console.log(`⓪ 备份 → ${BACKUP}\n   原 sha256=${origSha.slice(0, 16)}…`);

function runSuite(label) {
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
  for (const r of red.slice(0, 14)) console.log("   " + r.trim().slice(0, 150));
  for (const s of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + s.trim());
  return red;
}

// ── 摘点①：`byFallback` 退回"涨够 20 就压"（= D115 之前的行为）───────────
{
  let s = original.toString("utf8");
  const NEEDLE = "  const byFallback = since >= fallback || byCap;";
  const n = s.split(NEEDLE).length - 1;
  console.log(`\n① 摘点命中 ${n} 次（应为 1）`);
  if (n === 1) {
    s = s.replace(NEEDLE, "  const byFallback = since >= trigger || byCap; /* ★反向验证：退回涨够20就压 */");
    fs.writeFileSync(LIB, s);
    console.log(`   已写入退化版 sha256=${sha(fs.readFileSync(LIB)).slice(0, 16)}…`);
    runSuite("① byFallback 退回「涨够 20 就压」");
  }
}

// 还原（为下一个摘点准备干净起点）
fs.writeFileSync(LIB, original);

// ── 摘点③：兜底**跳过**落盘闸门（模拟"忘了闸门"）────────────────────────
{
  let s = original.toString("utf8");
  const NEEDLE = "  if (!forced) {\n    const gate = flushBeforeCompact(state, key, projectInfo, { manual: false, ratio: pressure.ratio });";
  const n = s.split(NEEDLE).length - 1;
  console.log(`\n③ 摘点命中 ${n} 次（应为 1）`);
  if (n === 1) {
    s = s.replace(
      NEEDLE,
      "  if (!forced && !byFallback) { /* ★反向验证：兜底跳过落盘闸门 */\n    const gate = flushBeforeCompact(state, key, projectInfo, { manual: false, ratio: pressure.ratio });"
    );
    fs.writeFileSync(LIB, s);
    console.log(`   已写入退化版 sha256=${sha(fs.readFileSync(LIB)).slice(0, 16)}…`);
    runSuite("③ 兜底跳过落盘闸门");
  }
}

// ★ 无条件还原 + 校验
fs.writeFileSync(LIB, original);
const restored = sha(fs.readFileSync(LIB));
console.log(`\n④ 已还原。sha256=${restored}`);
console.log(`   ${restored === origSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌"}`);
