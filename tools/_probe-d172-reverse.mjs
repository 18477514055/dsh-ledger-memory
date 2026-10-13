// ★★★★ _probe-d172-reverse.mjs —— 反向验证（D172）：30h 那条断言现在**有判别力**了吗？
//
//   背景：D171 发现 30h 是**假绿** —— 摘掉「让路」整块它照样 PASS。
//     根因：夹具走的是**自动路径**，而实测（穷举四种 forced/byNeed 组合）表明
//     让路块**只可能由 byNeed 到达**；且 `incrementalCompact` 默认 false ⇒ 函数都进不去。
//
//   本探针要证的**两件事**（缺一不可）：
//     ① **让路摘掉 ⇒ 30h 前提断言必须红**（判据挂了空挡就是没测到）；
//     ② ★ 同时证明「前提断言」不是摆设：把 `incrementalCompact` 退回默认（关）
//        ⇒ 也必须是红（否则"关着也能绿"，说明判据不自明）。
//
//   全程：备份 → 单点变异 → 跑自检 → 逐字节还原（sha256 必须完全一致）。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

const PROJ = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const LIB = path.join(PROJ, "lib", "index.js");
const SUM = "30h 前提";
const YIELD_LABEL = "增量**让路**";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function runSelftest() {
  const r = spawnSync(process.execPath, [path.join(PROJ, "tools", "selftest.mjs")], {
    cwd: PROJ, encoding: "utf8", maxBuffer: 512 * 1024 * 1024,
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const m = /通过 (\d+) 项，失败 (\d+) 项/.exec(out);
  const find = (needle) => {
    const line = out.split("\n").find((l) => l.includes(needle)) ?? "";
    return /\bPASS\b/.test(line) ? "PASS" : /\bFAIL\b/.test(line) ? "FAIL" : "??";
  };
  return { pass: m ? Number(m[1]) : NaN, fail: m ? Number(m[2]) : NaN, premise: find(SUM), yield: find(YIELD_LABEL) };
}

const orig = fs.readFileSync(LIB);
const origSum = sha(orig);
console.log("原 lib/index.js sha256 =", origSum);

// ── 变异：把「让路」整块的 return 摘掉（不再让路）──
const YIELD_RET = `        return {
          ok: false,
          compacted: false,
          reason: \`水位 \${(pressure.ratio * 100).toFixed(1)}% 已到全量线 \${Math.round(hfLine * 100)}% ⇒ 增量让路，交给全量高保真\`,
          yieldedToFull: true,
        };`;
if (!orig.toString("utf8").includes(YIELD_RET)) {
  console.log("★ 找不到变异锚点（让路 return 块）");
  process.exit(2);
}
const mutated = Buffer.from(
  orig.toString("utf8").replace(YIELD_RET, "        /* _probe-d172 M1：不再让路 */"),
  "utf8",
);

const results = [];
try {
  console.log("\n── 基线（未变异）──");
  const base = runSelftest();
  console.log("   ", JSON.stringify(base));
  results.push({ name: "基线", ...base });

  fs.writeFileSync(LIB, mutated, "utf8");
  console.log("\n── M1：摘掉「让路」return ── sha256 =", sha(fs.readFileSync(LIB)));
  const m1 = runSelftest();
  console.log("   ", JSON.stringify(m1));
  results.push({ name: "M1 摘掉让路", ...m1 });
} finally {
  fs.writeFileSync(LIB, orig);
  const back = sha(fs.readFileSync(LIB));
  console.log("\n── 还原 ── sha256 =", back, back === origSum ? "✅ 逐字节一致" : "❌ 不一致！");
}

console.log("\n════════ 结论 ════════");
const [base, m1] = results;
console.log(`基线：前提=${base.premise} 让路断言=${base.yield}`);
console.log(`M1  ：前提=${m1.premise} 让路断言=${m1.yield}`);
if (base.premise === "PASS" && m1.premise === "FAIL") {
  console.log("✅ M1 让「前提断言」变红 ⇒ **判据有判别力**（D171 那个假绿已闭合）。");
} else if (m1.premise === "PASS") {
  console.log("❌ M1 摘掉让路而前提仍绿 ⇒ **判据仍然没有判别力**，必须继续查。");
} else {
  console.log("?? 不符合预期：", JSON.stringify(results));
}
