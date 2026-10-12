/**
 * ★★★ exp3：再验一条 —— `gate-counts`（原红名单里的「增量压缩真的跑了」）。
 *
 * ★ 为什么还要再验一条：exp2 只在 **37i-3** 上证明了"补 idle + 再涨 20 点 ⇒ 增量恢复"。
 *   剩下 6 条红**形状相同**，但"形状相同"是**推断**，不是证据。
 *   ★★ 我这一小时刚栽过一次"观察为真、解释为假"（exp1）⇒ 不再靠推断下结论。
 *
 * ★ 本用例的特殊之处（要顺便查清）：它在 **0.72** 就跑了一步 ——
 *   而全量线默认 **0.70** ⇒ 那一步就会**排上全量**（0.72 ≥ 0.70）。
 *   ⇒ 摘掉 `!hfQueued` 后，它之后每一步都让路 ⇒ `regionCalls` 恒 0。
 *   ★ 若补 idle（消费掉全量）后能恢复 ⇒ 与 37i-3 同因：
 *     **夹具不派 idle** ⇒ 队列永不清空 ⇒ 让路判据永久成立。
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
const sha = (b) => crypto.createHash("crypto-hash").update(b).digest("hex");
const h = (b) => crypto.createHash("sha256").update(b).digest("hex");

const libOriginal = fs.readFileSync(LIB);
const stOriginal = fs.readFileSync(SELFTEST);
const libSha = h(libOriginal);
const stSha = h(stOriginal);
fs.writeFileSync(path.join(TMP, "exp3-lib.js"), libOriginal);
fs.writeFileSync(path.join(TMP, "exp3-selftest.mjs"), stOriginal);
console.log(`① 备份 lib=${libSha.slice(0, 12)}… · selftest=${stSha.slice(0, 12)}…`);

const libNeedle = "&& oursDone !== true && !hfQueued";
console.log(`② lib 摘 !hfQueued 命中 ${libOriginal.toString("utf8").split(libNeedle).length - 1} 次`);
fs.writeFileSync(LIB, libOriginal.toString("utf8").replace(libNeedle, "&& oursDone !== true"));

// 在 gate-counts 的最后一步**之前**插一次 idle（消费掉排队的全量）
let stSrc = stOriginal.toString("utf8");
const ANCHOR = `      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 740;
      await runPreStep(run, { agent, messages: [] });
      ok("★★ 增量压缩真的跑了（否则计数无从谈起）", regionCalls.length >= 1, \`regionCalls=\${regionCalls.length}\`);`;
const PATCHED = `      await flushLedger(run, root, sid);
      // ★★★ 实验：先派一次 idle，把 0.72 那步排上的全量真的执行掉。
      for (const hh of run.handlers.get("agent/status") ?? []) await hh({ agent, status: "idle" });
      console.log("        [实验] idle 后：全量=" + run.compacted.length + " regionCalls=" + regionCalls.length);
      // ★★ 再**涨 20 点**跨过触发线（exp1 的教训：全量成功后锚点被重置，
      //   水位不涨则"本来就不该压"——那是正确行为，不是被让路卡死）。
      await flushLedger(run, root, sid);
      run.services.tokenMeter._total = 760;
      await runPreStep(run, { agent, messages: [] });
      console.log("        [实验] 再涨 20 点后 regionCalls=" + regionCalls.length);
      ok("★★ 增量压缩真的跑了（否则计数无从谈起）", regionCalls.length >= 1, \`regionCalls=\${regionCalls.length}\`);`;

const n2 = stSrc.split(ANCHOR).length - 1;
console.log(`   selftest 摘点命中 ${n2} 次`);
if (n2 === 1) fs.writeFileSync(SELFTEST, stSrc.replace(ANCHOR, PATCHED));

try {
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
  for (const r of red.slice(0, 12)) console.log("   " + r.trim().slice(0, 150));
  for (const s of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + s.trim());
} finally {
  fs.writeFileSync(LIB, libOriginal);
  fs.writeFileSync(SELFTEST, stOriginal);
  console.log(`\n④ 已还原。lib ${h(fs.readFileSync(LIB)) === libSha ? "★一致 ✅" : "★★★不一致 ❌"}` +
    ` · selftest ${h(fs.readFileSync(SELFTEST)) === stSha ? "★一致 ✅" : "★★★不一致 ❌"}`);
}
