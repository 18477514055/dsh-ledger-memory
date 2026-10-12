/**
 * ★★★ exp4 · **对照组**：不摘 `!hfQueued`，只做"给夹具补 idle"这件事。
 *
 * ★ 为什么需要对照组（这是 exp2/exp3 结论能不能立住的关键）：
 *   exp2/exp3 都**同时**改了两件事（摘 lib 判据 + 给夹具补 idle）⇒
 *   我看到"变绿"，但**无法区分**绿是来自哪一处改动。
 *   ★ 严格的做法：**只改夹具**（补 idle），lib **原样不动** ⇒
 *     若这时也变绿 ⇒ 说明这些用例**本来就该有 idle**，是我当年的夹具漏了（纪律 6/8）；
 *     若这时仍红 ⇒ 说明"补 idle"这个变量**不足以**解释，必须先摘判据才有效。
 *
 * ★ 本组**不动 lib**，只给 selftest 的三处补 idle，然后全量跑一遍看总数。
 *   ★ 判据：若总数仍是 1060 绿（不多不少）⇒ 补 idle **不破坏任何现有断言**，
 *     即"这些用例本来就预期有 idle"这一前提**与现有断言自洽**。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const PLUGIN = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const SELFTEST = path.join(PLUGIN, "tools", "selftest.mjs");
const LIB = path.join(PLUGIN, "lib", "index.js");
const TMP = os.tmpdir();
const h = (b) => crypto.createHash("sha256").update(b).digest("hex");

const stOriginal = fs.readFileSync(SELFTEST);
const libOriginal = fs.readFileSync(LIB); // ★ 只读，用于校验"没动过"
const stSha = h(stOriginal);
const libSha = h(libOriginal);
console.log(`① 备份 selftest=${stSha.slice(0, 12)}… · lib 只读校验=${libSha.slice(0, 12)}…`);

let stSrc = stOriginal.toString("utf8");

// 只给 37i-3 补一次 idle（不动 lib）—— 看它是否**在 !hfQueued 完好时**也照样绿。
const ANCHOR = `      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 740;
      await runPreStep(run, { agent, messages: [] });
      ok(
        "★★★ steady 下写了台账就能压（与 surgical 形成对照）",`;
const PATCHED = `      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 740;
      await runPreStep(run, { agent, messages: [] });
      // ★ 对照组：只补一次 idle（lib 完全不动）⇒ 看现有断言是否仍全绿。
      for (const hh of run.handlers.get("agent/status") ?? []) await hh({ agent, status: "idle" });
      console.log("        [对照] idle 后 全量=" + run.compacted.length + " regionCalls=" + regionCalls.length);
      ok(
        "★★★ steady 下写了台账就能压（与 surgical 形成对照）",`;

const n = stSrc.split(ANCHOR).length - 1;
console.log(`② 摘点命中 ${n} 次`);
if (n === 1) fs.writeFileSync(SELFTEST, stSrc.replace(ANCHOR, PATCHED));

try {
  let out = "";
  try {
    out = execFileSync(process.execPath, [SELFTEST], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
  }
  const lines = out.split("\n");
  for (const l of lines.filter((x) => /\[对照\]/.test(x))) console.log("   " + l.trim());
  const red = lines.filter((l) => /^\s*FAIL/.test(l));
  console.log(`--- 红：${red.length} 条 ---`);
  for (const r of red.slice(0, 12)) console.log("   " + r.trim().slice(0, 150));
  for (const s of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + s.trim());
  console.log(
    red.length === 0
      ? "\n⇒ ★ 对照结论：只补 idle、lib 不动 ⇒ **全绿** ⇒ 「这些用例本来就该有 idle」与现有断言自洽。"
      : "\n⇒ ★ 对照结论：只补 idle 就红了 ⇒ 说明补 idle 本身改变了行为，不能当作纯夹具修补。"
  );
} finally {
  fs.writeFileSync(SELFTEST, stOriginal);
  console.log(`\n④ 已还原。`);
  console.log(`   selftest ${h(fs.readFileSync(SELFTEST)) === stSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌"}`);
  console.log(`   lib      ${h(fs.readFileSync(LIB)) === libSha ? "★ 全程未被改动 ✅" : "★★★ 被改动了 ❌"}`);
}
