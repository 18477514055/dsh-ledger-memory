/**
 * ★★★ 修正版实验：全量执行完之后，增量**能不能恢复**？
 *
 * ★ 上一版为什么得出的结论**可能是假象**（我自己查出来的，不是别人指出）：
 *   我在补了 idle（全量执行完）之后**只走了一步、水位没变** ⇒ 没压是**对的**！
 *   因为 `runHighFidelityCompact` 成功后会 `setAnchor(压后水位)`（D87），
 *   ⇒ `since = 0` ⇒ 增量本来就不该触发（它要等涨够 `deltaTriggerPoints`）。
 *   ★ 所以我上一版报的"增量仍不恢复"**观察为真、解释为假** ——
 *     它量的是"水位没涨所以不压"，**不是**"被让路卡死"。
 *   ⇒ 要判"恢复没恢复"，必须**让它再涨 20 点**（跨过触发线）再看。
 *
 * ★ 本版正确设计：
 *   步A 水位 720（72%，≥ 全量线 0.7）⇒ 排队全量（旧路，靠提醒注入搭车）
 *   步B 水位 740 ⇒ 增量**在该档让路**（本实验已摘掉 !hfQueued）
 *   步C **派 idle** ⇒ 全量执行（`hfCompacted=true`、队列清空、锚点重置到 740）
 *   步D 水位 760（**再涨 20 点**，跨过触发线）⇒ ★ 增量**应当恢复**
 *   ⇒ 若 D 步压了 ⇒ `!hfQueued` **可以**去掉（真机上 idle 必来）
 *   ⇒ 若 D 步仍不压 ⇒ 存在真死锁，`!hfQueued` 不能动
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const PLUGIN = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const LIB = path.join(PLUGIN, "lib", "index.js");
const SELFTEST = path.join(PLUGIN, "tools", "selftest.mjs");
const TMP = os.tmpdir();
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const libOriginal = fs.readFileSync(LIB);
const stOriginal = fs.readFileSync(SELFTEST);
const libSha = sha(libOriginal);
const stSha = sha(stOriginal);
fs.writeFileSync(path.join(TMP, "exp2-lib.js"), libOriginal);
fs.writeFileSync(path.join(TMP, "exp2-selftest.mjs"), stOriginal);
console.log(`① 备份 sha256 lib=${libSha.slice(0, 12)}… · selftest=${stSha.slice(0, 12)}…`);

let libSrc = libOriginal.toString("utf8");

// ① lib：去掉 !hfQueued
const NEEDLE = "&& oursDone !== true && !hfQueued";
const n1 = libSrc.split(NEEDLE).length - 1;
console.log(`② lib 摘点命中 ${n1} 次`);
if (n1 === 1) {
  fs.writeFileSync(LIB, libSrc.replace(NEEDLE, "&& oursDone !== true"));
}

// ② selftest：在 37i-3 的断言**之前**插入 idle + 涨 20 点 + 再看
let stSrc = stOriginal.toString("utf8");
const ANCHOR = `      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 740;
      await runPreStep(run, { agent, messages: [] });
      ok(
        "★★★ steady 下写了台账就能压（与 surgical 形成对照）",`;

const PATCHED = `      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 740;
      await runPreStep(run, { agent, messages: [] });
      // ★★★ 实验（修正版）：真机上 idle 必来 ⇒ 让排队的全量真的执行。
      const beforeIdle = regionCalls.length;
      for (const h of run.handlers.get("agent/status") ?? []) await h({ agent, status: "idle" });
      console.log("        [实验] idle 后：全量执行数=" + run.compacted.length + " regionCalls=" + regionCalls.length);
      // ★★ 关键：再**涨 20 点**跨过触发线 —— 否则"没压"只是因为锚点刚被重置（D87），
      //   那是**正确行为**，不是被让路卡死。上一版就栽在这（观察真、解释假）。
      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 760;
      await runPreStep(run, { agent, messages: [] });
      console.log("        [实验] 再涨 20 点后 regionCalls=" + regionCalls.length + "（>beforeIdle 即恢复）");
      ok(
        "★★★ steady 下写了台账就能压（与 surgical 形成对照）",`;

const n2 = stSrc.split(ANCHOR).length - 1;
console.log(`   selftest 摘点命中 ${n2} 次`);
if (n2 === 1) {
  stSrc = stSrc.replace(ANCHOR, PATCHED);
  fs.writeFileSync(SELFTEST, stSrc);
}

try {
  console.log(`\n=========== 自检（去 !hfQueued + 正确实验）===========`);
  let out = "";
  try {
    out = execFileSync(process.execPath, [SELFTEST], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
  }
  const lines = out.split("\n");
  for (const l of lines.filter((x) => /\[实验\]/.test(x))) console.log("   " + l.trim());
  const red = lines.filter((l) => /^\s*FAIL/.test(l));
  console.log(`--- 红：${red.length} 条 ---`);
  for (const r of red.slice(0, 20)) console.log("   " + r.trim().slice(0, 150));
  for (const s of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + s.trim());
  fs.writeFileSync(path.join(TMP, "exp2-output.txt"), out);
} finally {
  fs.writeFileSync(LIB, libOriginal);
  fs.writeFileSync(SELFTEST, stOriginal);
  console.log(`\n④ 已双双还原。`);
  console.log(`   lib      ${sha(fs.readFileSync(LIB)) === libSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌"}`);
  console.log(`   selftest ${sha(fs.readFileSync(SELFTEST)) === stSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌"}`);
}
