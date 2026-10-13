// ★★★★ _probe-d171-reverse.mjs —— 反向验证：情形 30e 的「增量让路」断言**有没有判别力**？
//
//   怀疑（来自读代码）：让路分支的外层门是
//       if (!forced && settings.incrementalCompact === true && …)
//   而 `incrementalCompact` 的**默认值是 false**（lib/index.js L170）。
//   情形 30e 的 `mod.apply(run.ctx, { })` 传的是空配置 ⇒ 那道门**根本不开**
//   ⇒ `runIncrementalCompact` 也许**一次都没被调用** ⇒ `regionCalls===0` 是**平凡成立**，
//     与"让路"无关 ⇒ 判据没有判别力（假绿）。
//
//   判据（决定性的）：**把「让路」整块摘掉**。
//     · 若 30e 是靠让路才绿的 ⇒ 摘掉后增量照压 ⇒ regionCalls=1 ⇒ **必须变红**；
//     · 若绿不变 ⇒ 那条断言压根没走到让路这条路上 ⇒ **它是假绿**。
//
//   ★ 纪律 10：反向验证必须摘到"能看见红"为止 —— 不红就要查清是断言太弱还是修复冗余。
//
//   全程：备份 → 单点变异 → 跑自检 → 逐字节还原（sha256 必须完全一致）。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

const PROJ = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const LIB = path.join(PROJ, "lib", "index.js");
const SUM_LABEL = "水位已到全量线 ⇒ 增量**让路**";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function runSelftest() {
  const r = spawnSync(process.execPath, [path.join(PROJ, "tools", "selftest.mjs")], {
    cwd: PROJ,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const m = /通过 (\d+) 项，失败 (\d+) 项/.exec(out);
  // 30e 那条断言的结果
  const line = out.split("\n").find((l) => l.includes(SUM_LABEL)) ?? "";
  const verdict = /\bPASS\b/.test(line) ? "PASS" : /\bFAIL\b/.test(line) ? "FAIL" : "??";
  return { pass: m ? Number(m[1]) : NaN, fail: m ? Number(m[2]) : NaN, verdict, line: line.trim() };
}

const orig = fs.readFileSync(LIB);
const origSum = sha(orig);
console.log("原 lib/index.js sha256 =", origSum, "bytes =", orig.length);

// ── 变异：让「让路」不再返回 ⇒ 增量照压 ────────────────────────────────
//   只动那一处 `return { … yieldedToFull: true … }`，改成不返回。
const NEEDLE = "        return {\n          ok: false,\n          compacted: false,\n          reason: `水位 ${(pressure.ratio * 100).toFixed(1)}% 已到全量线 ${Math.round(hfLine * 100)}% ⇒ 增量让路，交给全量高保真`,\n          yieldedToFull: true,\n        };";
if (!orig.toString("utf8").includes(NEEDLE)) {
  console.log("★ 找不到变异点（让路 return 块）—— 先 grep 核对，别猜。");
  process.exit(2);
}

const mutated = Buffer.from(
  orig.toString("utf8").replace(NEEDLE, "        /* _probe-d171 变异：不再让路 */"),
  "utf8",
);

const results = [];
try {
  // 基线
  console.log("\n── 基线（未变异）──");
  const base = runSelftest();
  console.log("   ", JSON.stringify(base));
  results.push({ name: "基线", ...base });

  // 变异
  fs.writeFileSync(LIB, mutated, "utf8");
  const nowSum = sha(fs.readFileSync(LIB));
  console.log("\n── 变异后（让路被摘掉）──  sha256 =", nowSum);
  const mut = runSelftest();
  console.log("   ", JSON.stringify(mut));
  results.push({ name: "让路被摘掉", ...mut });
} finally {
  // ★ 无论成败都还原
  fs.writeFileSync(LIB, orig);
  const backSum = sha(fs.readFileSync(LIB));
  console.log("\n── 还原 ── sha256 =", backSum, backSum === origSum ? "✅ 逐字节一致" : "❌ 不一致！");
}

console.log("\n════════ 结论 ════════");
const base = results[0], mut = results[1];
console.log("基线 30e：", base.verdict, "| 总", base.pass, "/", base.fail);
console.log("变异 30e：", mut.verdict, "| 总", mut.pass, "/", mut.fail);
if (base.verdict === "PASS" && mut.verdict === "PASS") {
  console.log("★★★ 摘掉「让路」而 30e **仍绿** ⇒ 那条断言**没有判别力**（假绿）——");
  console.log("    它没走到让路这条路上（极可能是 incrementalCompact 默认 false ⇒ 门就没开）。");
} else if (mut.verdict === "FAIL") {
  console.log("✅ 摘掉「让路」⇒ 30e 变红 ⇒ 断言有判别力，测的确实是让路。");
} else {
  console.log("?? 结果不符合预期，需人工看：", JSON.stringify(results));
}
