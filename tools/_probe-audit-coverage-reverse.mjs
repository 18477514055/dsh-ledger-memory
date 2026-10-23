#!/usr/bin/env node
/**
 * 反向验证 D309：**审计器的覆盖率不是假绿**。
 *
 * ★ 为什么必须做：这一轮把 `UNCOVERED 5 / COND-MISSING 6` 一次性变成了 `0 / 0`，
 *   覆盖 20/20、47 PASS / 0 FAIL。**这种"突然全绿"最可疑** —— 本项目栽过不止一次
 *   （摘掉修复仍全绿 = 断言没打在被测行为上）。
 *   ⇒ 必须证明：**把覆盖手段摘掉，它真的会变红**。
 *
 * ★ 三种摘法（对应三种"绿"的来源）：
 *   ① 把 2.6 节那次独立探针调用**摘掉** ⇒ 那 5 个工具必须重新变回 UNCOVERED（而不是静静消失）；
 *   ② 把 exec 的 `session` **摘掉** ⇒ 那几个依赖会话的工具必须重新变 COND-MISSING；
 *   ③ 把 `fakeState` 里新补的字段**摘掉一个** ⇒ 对应用例必须重新变 FAIL（而不是被吞）。
 *
 * ★ 做法：读源码 → 逐条改一处 → 跑审计器（子进程）→ 记录输出 → finally 还原（按字节校验）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.join(HERE, "_audit-v3-tools2.mjs");
const original = fs.readFileSync(AUDIT);
const src = original.toString("utf8");

const run = () => {
  const r = spawnSync(process.execPath, [AUDIT], { encoding: "utf8", cwd: HERE });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = out.match(/结果：PASS (\d+) \/ FAIL (\d+) \/ COND-MISSING (\d+) \/ UNCOVERED (\d+)/);
  return {
    code: r.status,
    pass: m ? Number(m[1]) : -1,
    fail: m ? Number(m[2]) : -1,
    cond: m ? Number(m[3]) : -1,
    unc: m ? Number(m[4]) : -1,
    out,
  };
};

const results = [];
const ok = (n, pass, d) => {
  results.push({ n, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${n}${d === undefined ? "" : `  —— ${d}`}`);
};

console.log("═".repeat(76));
console.log("反向验证 D309：覆盖率「全绿」是不是假绿");
console.log("═".repeat(76));

// ── 基线：未改时必须全绿 ────────────────────────────────────────────────────
const base = run();
console.log(`\n【基线】未改动：PASS ${base.pass} / FAIL ${base.fail} / COND ${base.cond} / UNCOVERED ${base.unc}`);
if (base.code !== 0 || base.unc !== 0 || base.cond !== 0) {
  console.log("  ✗ 基线自己就不是全绿 ⇒ 本反向验证没有意义（先修正向）");
  process.exit(1);
}
console.log("  ✓ 基线全绿（20/20 覆盖、0 未测、0 条件缺失）⇒ 可以开始逐条摘");

// ── ① 摘掉 2.6 节的独立探针调用 ─────────────────────────────────────────────
const CUT1 = `  const r = spawnSync(process.execPath, [probe], { encoding: "utf8", cwd: HERE });`;
if (!src.includes(CUT1)) {
  ok("① 前置：找得到 2.6 节的探针调用", false, "找不到 ⇒ 判据与实现不同源");
} else {
  try {
    // 把子进程调用换成一个必然失败的假结果（不执行探针）
    fs.writeFileSync(
      AUDIT,
      src.replace(CUT1, `  const r = { status: 1, stdout: "", stderr: "反向验证：故意不跑探针" };`),
      "utf8"
    );
    const got = run();
    const caught = got.fail > 0 || got.unc > 0;
    ok(
      "① 摘掉独立探针 ⇒ 那 5 个工具**重新可见为问题**（变红），不会静静变绿",
      caught,
      `PASS ${got.pass} / FAIL ${got.fail} / UNCOVERED ${got.unc}`
    );
  } finally {
    fs.writeFileSync(AUDIT, src, "utf8");
  }
}

// ── ② 摘掉 exec 里的 session ───────────────────────────────────────────────
const CUT2 = `            header: { id: \`audit-\${tag}-\${name}\`, cwd: proj.dir },`;
if (!src.includes(CUT2)) {
  ok("② 前置：找得到 exec 里的 session.header", false, "找不到 ⇒ 判据与实现不同源");
} else {
  try {
    fs.writeFileSync(AUDIT, src.replace(CUT2, `            header: undefined,`), "utf8");
    const got = run();
    const caught = got.cond > 0 || got.fail > 0;
    ok(
      "② 摘掉 exec 的会话 ⇒ 依赖会话的工具**重新变回 COND-MISSING 或 FAIL**（不是继续绿）",
      caught,
      `PASS ${got.pass} / FAIL ${got.fail} / COND ${got.cond}`
    );
  } finally {
    fs.writeFileSync(AUDIT, src, "utf8");
  }
}

// ── ③ 摘掉 fakeState 里一个新补的字段（triageKeep）────────────────────────
const CUT3 = `    triageKeep: new Map(),`;
if (!src.includes(CUT3)) {
  ok("③ 前置：找得到 fakeState 里的 triageKeep", false, "找不到 ⇒ 判据与实现不同源");
} else {
  try {
    fs.writeFileSync(AUDIT, src.replace(CUT3, `    // triageKeep 被反向验证摘掉了`), "utf8");
    const got = run();
    const caught = got.fail > 0;
    ok(
      "③ 摘掉 fakeState 的 triageKeep ⇒ ledger_triage 用例**重新变红**（夹具缺字段会被看见）",
      caught,
      `PASS ${got.pass} / FAIL ${got.fail}`
    );
  } finally {
    fs.writeFileSync(AUDIT, src, "utf8");
  }
}

// ── 还原校验（按字节）+ 末态 ───────────────────────────────────────────────
const restored = fs.readFileSync(AUDIT);
ok("★ 还原后与原件**逐字节相同**", restored.equals(original), `${restored.length} B`);
const final = run();
ok("★ 末态复跑仍全绿（还原没有引入偏差）", final.code === 0 && final.unc === 0 && final.cond === 0, `PASS ${final.pass} / FAIL ${final.fail}`);

const bad = results.filter((r) => r.pass !== true).length;
console.log("\n" + "─".repeat(76));
console.log(`${results.length - bad} PASS / ${bad} FAIL`);
console.log(bad === 0 ? "✓ 三种摘法都能看见红 ⇒ 这个「全绿」不是假绿" : "✗ 有摘法看不见红 ⇒ 断言无效");
console.log("─".repeat(76));
process.exit(bad === 0 ? 0 : 1);
