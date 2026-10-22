/**
 * 探针（V3 阶段 2 · 第二步）：**`autoGitAdd` 这个开关还有存在意义吗？**
 *
 * ★★★ 背景 —— 上一支探针（`_probe-v3-stage-gate.mjs`）已经证明的事实：
 *   有 D288 的 ignore 规则在，`autoGitAdd: true` **一个记忆文件都加不进暂存区**
 *   （`git status` 里只有 `.gitignore`）。而拿掉规则后立刻能加进去 —— 所以那不是"没接通"。
 *
 * ⇒ 由此产生一个必须**实测**而不是**推断**的问题：
 *   **把默认值从 true 改成 false，行为上到底有没有区别？**
 *
 *   如果答案是"没有区别"（因为规则已经全挡住了），那改默认值就是**纯粹的口径统一**，
 *   而不是"关掉一个危险功能" —— 这两件事在文档里必须说清，不能含糊地写"已加固"。
 *   如果答案是"有区别"，那说明还有某些路径**没被规则覆盖**，那才是真漏洞。
 *
 * ★ 判据：
 *   · **A 组**（`autoGitAdd` 不传 ⇒ 默认 true）与 **B 组**（`autoGitAdd: false`）
 *     在**同一个仓库状态下**跑，`git status` 必须**完全一致**。
 *   · 若不一致 ⇒ 列出差异，并据此判断"默认值"是否还有实际效果。
 *
 * 跑法：node tools/_probe-v3-autogitadd-default.mjs
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

const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { code: r.status, out: String(r.stdout ?? "").trim() };
};

function makeGitProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3aga-"));
  if (git(dir, ["init"]).code !== 0) return undefined;
  git(dir, ["config", "user.email", "probe@example.invalid"]);
  git(dir, ["config", "user.name", "probe"]);
  fs.writeFileSync(path.join(dir, "index.js"), "console.log(1);\n", "utf8");
  git(dir, ["add", "--", "index.js"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

/** 跑一次 init，返回 status 的规范化快照。 */
async function initAndSnapshot({ autoGitAdd }) {
  const dir = makeGitProject();
  if (dir === undefined) return undefined;
  const args = {
    root: dir,
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
    logDir: "_ledger-log",
    decisionsDir: "decisions",
    initialActive: "# 台账\n",
    initialDecisions: "# 决策\n",
    gitignore: true,
    gitInit: false,
  };
  if (autoGitAdd !== undefined) args.autoGitAdd = autoGitAdd;
  const r = await part4.defineInitTool().execute(args, {
    agent: { session: { header: { id: "probe" } }, cwd: dir },
  });
  // ★ 读**磁盘真象**，不信回执 —— 回执本身正是被测对象之一。
  const st = git(dir, ["status", "--porcelain"]);
  const files = st.out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .sort();
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: r?.ok === true, files, staged: r?.staged };
}

console.log("── ① 默认值（不传 autoGitAdd）与显式 false 的**真实差别** ──");
{
  const a = await initAndSnapshot({});
  const b = await initAndSnapshot({ autoGitAdd: false });
  if (a === undefined || b === undefined) {
    console.log("  SKIP  git 不可用");
  } else {
    ok("① 两次 init 都成功", a.ok && b.ok, `a=${a.ok} b=${b.ok}`);
    console.log(`     默认值的 git status：${a.files.length === 0 ? "(空)" : a.files.join(" | ")}`);
    console.log(`     显式 false 的 git status：${b.files.length === 0 ? "(空)" : b.files.join(" | ")}`);

    // ★★★ 这条断言我第一版写反了，就地更正 —— **不要假设"规则挡住了 ⇒ 开关就没用了"**。
    //   实测：默认值会把 `.gitignore` **stage 成 A**，而 `false` 让它停在 `??`。
    //   ⇒ 所以 `autoGitAdd` **仍然有实际效果**，只是效果**只落在 `.gitignore` 上**
    //     （记忆文件全被规则挡住了，一个都没进）。
    //
    //   ★ 判据：**差别只许出现在 `.gitignore` 这一处**。
    //     若哪天记忆文件开始进暂存区，这条就会红 —— 那才是真漏了。
    const aOnly = a.files.filter((f) => !b.files.includes(f));
    const bOnly = b.files.filter((f) => !a.files.includes(f));
    const nonGitignoreDiff = [...aOnly, ...bOnly].filter((f) => !/\.gitignore$/.test(f));
    ok(
      "① ★★★ 两组之间**唯一**的差别是 `.gitignore`（记忆文件一个都没进）",
      nonGitignoreDiff.length === 0,
      nonGitignoreDiff.join(" | "),
    );
    ok(
      "① ★★ 默认值确实 stage 了 `.gitignore`（`A`），显式 false 没有（`??`）⇒ 开关**仍有实际效果**",
      a.files.some((f) => /^A\s+\.gitignore$/.test(f)) && b.files.some((f) => /^\?\?\s+\.gitignore$/.test(f)),
      `a=${JSON.stringify(a.files)} b=${JSON.stringify(b.files)}`,
    );
  }
}

console.log("\n── ② 显式 true 时：到底加进了什么？──");
{
  const a = await initAndSnapshot({ autoGitAdd: true });
  if (a === undefined) {
    console.log("  SKIP  git 不可用");
  } else {
    console.log(`     git status：${a.files.length === 0 ? "(空)" : a.files.join(" | ")}`);
    // ★ 唯一可能被加进去的是 .gitignore 本身（它不是记忆内容，是保护性配置）
    const unexpected = a.files.filter((f) => !/\.gitignore$/.test(f));
    ok(
      "② ★★★ `autoGitAdd: true` 时，除 `.gitignore` 外**没有任何**文件进暂存区",
      unexpected.length === 0,
      unexpected.join(" | "),
    );
    ok("② ★★ `.gitignore` **确实**被加进去了（保护性配置可以被追踪）", a.files.some((f) => /^A\s+\.gitignore$/.test(f)), a.files.join(" | "));
    // ★★★ 回执必须如实：这次**真的**加进去了 `.gitignore` ⇒ `staged` 应为 true。
    //   🔴 第一版这里判红，根因是 `stageOutcomeOf` 判据写反了（`r.staged` 在成功分支根本不存在）。
    //     ⇒ 已修：改成"`wanted` 减掉 `skipped` 之后还有剩"才是真加进去了。
    ok("② ★★ 回执如实报 `staged: true`（因为这次真的加进去了东西）", a.staged === true, JSON.stringify(a.staged));
  }
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
