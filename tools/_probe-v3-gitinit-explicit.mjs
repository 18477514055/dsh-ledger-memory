/**
 * 探针（V3 阶段 2 · 第二刀 D291）：**`git init` 真的必须显式了吗？**
 *
 * ★★★ 这条探针要证明三件事，缺一不可：
 *   ① **默认不 init** —— 不传 `gitInit` ⇒ 磁盘上**没有** `.git`；
 *   ② **回执如实说** —— 不能只是静默不做事（用户的感受必须对得上）；
 *   ③ **显式才 init** —— 传 `gitInit: true` ⇒ 真的建了。
 *
 * ★★ 为什么 ③ 不可省：如果只验 ①（"默认不建"），那么"**这个功能整个坏掉**"也能让它全绿
 *   —— 一个永远不 init 的实现同样满足 ①。**必须有正向对照。**
 *
 * 跑法：node tools/_probe-v3-gitinit-explicit.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
const LIB = path.join(HERE, "..", "lib");
const LIB_URL = `file://${LIB.replace(/\\/g, "/")}/`;

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra === undefined ? "" : `  ← ${extra}`}`);
  }
};

const part4 = await import(new URL("./part4.js", LIB_URL).href);

const gitOk = (() => {
  const r = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  return r.status === 0;
})();

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3init-"));
}

async function runInit(dir, extra) {
  return part4.defineInitTool().execute(
    {
      root: dir,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_ledger-archive",
      initialActive: "# 台账\n",
      initialDecisions: "# 决策\n",
      gitignore: false, // ★ 刻意关掉：本探针只测 git init，别让 ignore 干扰
      ...extra,
    },
    { agent: { session: { header: { id: "probe" } }, cwd: dir } },
  );
}

console.log("── ① 默认**不** init：不传 gitInit ⇒ 没有 .git，且回执说清了 ──");
{
  if (!gitOk) {
    console.log("  SKIP  git 不可用");
  } else {
    const dir = makeDir();
    const r = await runInit(dir, {});
    ok("① init 本身成功（台账照建，不受影响）", r?.ok === true, JSON.stringify(r).slice(0, 300));
    ok("① ★★ 磁盘上**没有** .git（默认不建仓库）", !fs.existsSync(path.join(dir, ".git")));
    ok("① ★ 回执里 gitInit 不为 true", r?.gitInit !== true, JSON.stringify(r?.gitInit));
    ok(
      "① ★★★ 回执**明确说了**「默认不建仓库、要建请显式」",
      Array.isArray(r?.notes) && r.notes.some((n) => /默认不建仓库/.test(String(n))),
      JSON.stringify(r?.notes),
    );
    // ★ 但台账本身必须照常建好 —— 不 init 不等于不干活
    ok("① 台账文件照常写出", fs.existsSync(path.join(dir, "LEDGER.md")));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n── ② 显式 `gitInit: true` ⇒ 真的建了仓库（正向对照）──");
{
  if (!gitOk) {
    console.log("  SKIP  git 不可用");
  } else {
    const dir = makeDir();
    const r = await runInit(dir, { gitInit: true });
    ok("② init 成功", r?.ok === true, JSON.stringify(r).slice(0, 300));
    ok("② ★★★ 显式要求后，`.git` **真的**建出来了", fs.existsSync(path.join(dir, ".git")));
    ok("② ★★ 回执如实报 `gitInit: true`", r?.gitInit === true, JSON.stringify(r?.gitInit));
    ok(
      "② ★ 回执里点明了这是**你显式要求**的",
      Array.isArray(r?.notes) && r.notes.some((n) => /你显式要求/.test(String(n))),
      JSON.stringify(r?.notes),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n── ③ 已是仓库时不重复 init，也不误报「默认不建」──");
{
  if (!gitOk) {
    console.log("  SKIP  git 不可用");
  } else {
    const dir = makeDir();
    spawnSync("git", ["init"], { cwd: dir, encoding: "utf8", windowsHide: true });
    ok("③ 夹具：先手动建好仓库", fs.existsSync(path.join(dir, ".git")));
    const r = await runInit(dir, {});
    ok("③ init 成功", r?.ok === true, JSON.stringify(r).slice(0, 300));
    ok("③ ★★ 已经是仓库时**不重复** init", r?.gitInit !== true, JSON.stringify(r?.gitInit));
    // ★ 关键：这种情况**不该**出现"默认不建仓库"那句 —— 那会让用户莫名其妙
    ok(
      "③ ★★★ 已是仓库时**不**提示「默认不建仓库」（按情况说话，不是无脑念一遍）",
      !(Array.isArray(r?.notes) && r.notes.some((n) => /默认不建仓库/.test(String(n)))),
      JSON.stringify(r?.notes),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
