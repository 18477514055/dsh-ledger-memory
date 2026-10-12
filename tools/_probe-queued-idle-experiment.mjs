/**
 * ★★★ 决定性实验：那 7 条红用例，是「夹具没造 idle」还是「真设计」？
 *
 * ★ 待验假设（D105 §八 的诚实边界）：
 *   摘掉 `!hfQueued` 后增量停摆，**只是因为夹具从不派 idle** ——
 *   于是"排队里的全量"永不被执行 ⇒ `hfQueued` 永为真 ⇒ 增量永远让路。
 *   真机上 **idle 一定会来**（回合结束），全量执行完 `hfCompacted=true`、队列清空
 *   ⇒ 增量**立刻恢复**。
 *
 * ★ 怎么判（一次性同时改两处，跑完**双双还原 + sha256 校验**）：
 *   ① `lib`：去掉 `&& !hfQueued`（模拟"增量在该档让路"）
 *   ② `selftest`：给 37i-3 那个用例**补一次 idle**（模拟真机），再走一步看增量是否恢复
 *   ⇒ 若补 idle 后**转绿** ⇒ 证明是**夹具前提缺失**（纪律 6/8），不是设计被破坏。
 *   ⇒ 若补 idle 后**仍红** ⇒ 证明存在**真死锁**，那个 `!hfQueued` 不能动。
 *
 * ⚠️ 本探针会**改写两个源文件**，但 finally 里无条件还原并逐字节校验。
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
fs.writeFileSync(path.join(TMP, "exp-lib.js"), libOriginal);
fs.writeFileSync(path.join(TMP, "exp-selftest.mjs"), stOriginal);
console.log(`① 备份：lib sha256=${libSha.slice(0, 16)}… · selftest sha256=${stSha.slice(0, 16)}…`);

let libSrc = libOriginal.toString("utf8");
let stSrc = stOriginal.toString("utf8");

// ── ① lib：去掉 !hfQueued（增量在该档让路）─────────────────────────────
const NEEDLE = "&& oursDone !== true && !hfQueued";
const n1 = libSrc.split(NEEDLE).length - 1;
console.log(`\n② lib 摘点：命中 ${n1} 次`);
if (n1 === 1) {
  libSrc = libSrc.replace(NEEDLE, "&& oursDone !== true");
  fs.writeFileSync(LIB, libSrc);
}

// ── ② selftest：给 37i-3 补一次 idle（模拟真机回合结束）────────────────
//   定位 37i-3 里那句 `steady 下写了台账就能压`，在它**之前**插入 idle 消费。
const ANCHOR = `      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 740;
      await runPreStep(run, { agent, messages: [] });
      ok(
        "★★★ steady 下写了台账就能压（与 surgical 形成对照）",`;
const n2 = stSrc.split(ANCHOR).length - 1;
console.log(`   selftest 摘点：命中 ${n2} 次`);

const PATCHED = `      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 740;
      await runPreStep(run, { agent, messages: [] });
      // ★★★ 实验补丁：真机上 idle **一定会来**（回合结束）⇒ 让排队的全量执行。
      //   若掉 !hfQueued 之后增量仍能恢复 ⇒ 那 7 条红就是"夹具没造 idle"（前提缺失）。
      //   ★ 只用**本作用域里有**的 helper（上一版用了外层才有的 settle()，当场 ReferenceError
      //     把整段 aborted 掉 ⇒ 那一轮数据作废 —— 夹具故障绝不能当成被测对象的结论）。
      for (const h of run.handlers.get("agent/status") ?? []) await h({ agent, status: "idle" });
      console.log("        [实验] idle 已派发；全量执行数 = " + run.compacted.length);
      // 再来一步：此时全量已完成（hfCompacted=true、队列已空）⇒ 增量应当恢复。
      await flushLedger(run, root, sid);
      await runPreStep(run, { agent, messages: [] });
      console.log("        [实验] 该用例 regionCalls = " + regionCalls.length);
      ok(
        "★★★ steady 下写了台账就能压（与 surgical 形成对照）",`;

if (n2 === 1) {
  stSrc = stSrc.replace(ANCHOR, PATCHED);
  fs.writeFileSync(SELFTEST, stSrc);
}

console.log(`\n   lib 新 sha256      = ${sha(fs.readFileSync(LIB)).slice(0, 16)}…`);
console.log(`   selftest 新 sha256 = ${sha(fs.readFileSync(SELFTEST)).slice(0, 16)}…`);

try {
  console.log(`\n=========== 跑自检（去 !hfQueued + 补 idle）===========`);
  let out = "";
  try {
    out = execFileSync(process.execPath, [SELFTEST], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
  }
  const lines = out.split("\n");
  const red = lines.filter((l) => /^\s*FAIL/.test(l));
  const expLines = lines.filter((l) => /\[实验\]/.test(l));
  console.log(`--- 实验自报 ---`);
  for (const l of expLines) console.log("   " + l.trim());
  console.log(`--- 红：${red.length} 条 ---`);
  for (const r of red.slice(0, 20)) console.log("   " + r.trim().slice(0, 150));
  for (const s of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + s.trim());
  fs.writeFileSync(path.join(TMP, "exp-output.txt"), out);
} finally {
  fs.writeFileSync(LIB, libOriginal);
  fs.writeFileSync(SELFTEST, stOriginal);
  const a = sha(fs.readFileSync(LIB));
  const b = sha(fs.readFileSync(SELFTEST));
  console.log(`\n④ 已双双还原。`);
  console.log(`   lib      ${a === libSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌"}`);
  console.log(`   selftest ${b === stSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌"}`);
}
