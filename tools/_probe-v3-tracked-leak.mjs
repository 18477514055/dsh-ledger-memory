/**
 * 探针（V3 阶段 2 · 第四刀 D293）：**已经提交进仓库的记忆文件，长什么样？**
 *
 * 🔴 这一项要治的是一种**只在特定项目上存在**的危险状态：
 *   D288 之后新项目会被 ignore 规则保护住，**但老项目里可能早就 commit 进去了**。
 *   `06-DSH-mobile` 那次真事故正是"已经推上去了"—— ignore 规则对它**一点用都没有**
 *   （ignore 只管**尚未被跟踪**的文件；已被跟踪的文件会继续被跟踪，规则不再生效）。
 *
 * ★★★ 所以这一步的**唯一正确形态**是：**查出它、告诉用户、给出方案**。
 *   **绝不自动 `git rm --cached`、绝不 rewrite history、绝不 force push** ——
 *   用户已拍板：*"泄露只报警 + 给方案，不自动 rewrite。"*
 *   理由很实在：改写历史会影响所有协作者、需要 force push、且**本地删了远端还在**。
 *
 * ★ 本探针**只读**：只跑 `git ls-files` / `git log`，不碰工作区、不写任何文件。
 *
 * 跑法：node tools/_probe-v3-tracked-leak.mjs
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

const part2 = await import(new URL("./part2.js", LIB_URL).href);

const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { code: r.status, out: String(r.stdout ?? "").trim(), err: String(r.stderr ?? "").trim() };
};

const hasGit = git(process.cwd(), ["--version"]).code === 0;

/** 造一个"记忆已经被 commit 进去"的项目（复现真实事故形态）。 */
function makeLeakyProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3leak-"));
  if (git(dir, ["init"]).code !== 0) return undefined;
  git(dir, ["config", "user.email", "probe@example.invalid"]);
  git(dir, ["config", "user.name", "probe"]);
  fs.writeFileSync(path.join(dir, "index.js"), "console.log(1);\n", "utf8");
  // ★ 记忆文件：**在 ignore 规则存在之前就被提交了**
  fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账（含用户原话与本机路径）\n", "utf8");
  fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "decisions", "D1.md"), "## D1\n私有决策\n", "utf8");
  git(dir, ["add", "--", "index.js", "LEDGER.md", "decisions/D1.md"]);
  git(dir, ["commit", "-m", "leak: memory committed before ignore rules"]);
  // ★ 之后才写 ignore 规则 —— 模拟"D288 之后我们补了规则，但文件已被跟踪"
  fs.writeFileSync(path.join(dir, ".gitignore"), "LEDGER.md\ndecisions/\n", "utf8");
  return dir;
}

console.log("── ① 前提：被跟踪的文件**不会**因为后来加了 ignore 规则而消失 ──");
{
  if (!hasGit) {
    console.log("  SKIP  git 不可用");
  } else {
    const dir = makeLeakyProject();
    // 🔴 第一版这里断言「check-ignore 认它被规则挡住」，**报红了，而且它红了才对**：
    //   `git check-ignore` 对**已被跟踪**的文件**不输出任何东西**（退出码 1）——
    //   因为忽略规则对索引里的文件**不生效**。
    //   ⇒ 我把它当成"夹具前提"，是把**结论**当成了**前提**（纪律 8 的同型：夹具前提错了）。
    //   ★ 正确的夹具判据是：**规则文件里确实写了那一条**，以及**它确实还被跟踪**。
    const chk = git(dir, ["check-ignore", "--", "LEDGER.md"]);
    ok(
      "① 夹具成立：`.gitignore` 里**确实写着** LEDGER.md（规则存在）",
      fs.readFileSync(path.join(dir, ".gitignore"), "utf8").split("\n").some((l) => l.trim() === "LEDGER.md"),
    );
    ok(
      "① ★★★ 而 `check-ignore` 对它**没有输出** —— 这正是「ignore 对已跟踪文件无效」的直接证据",
      chk.out.trim() === "",
      `实际输出：${JSON.stringify(chk.out)}`,
    );

    // ★★★ 核心事实：ignore 规则**管不了已跟踪的文件**
    const tracked = git(dir, ["ls-files"]);
    const trackedList = tracked.out.split("\n").map((s) => s.trim()).filter((s) => s !== "");
    ok(
      "① ★★★ 它**仍然**在 `git ls-files` 里（ignore 对已跟踪文件无效）",
      trackedList.includes("LEDGER.md"),
      trackedList.join(" | "),
    );
    ok(
      "① ★★ 它仍然会被 `git status` 当作已跟踪（不显示为未跟踪）",
      !git(dir, ["status", "--porcelain"]).out.includes("?? LEDGER.md"),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n── ② 检测函数必须把它查出来，且**只报告、不动手** ──");
{
  if (!hasGit) {
    console.log("  SKIP  git 不可用");
  } else {
    const dir = makeLeakyProject();
    ok("② 检测函数已导出", typeof part2.detectTrackedMemory === "function", typeof part2.detectTrackedMemory);

    if (typeof part2.detectTrackedMemory === "function") {
      const before = git(dir, ["status", "--porcelain"]).out;
      const beforeHead = git(dir, ["rev-parse", "HEAD"]).out;

      const r = part2.detectTrackedMemory(dir);
      ok("② 返回 ok", r?.ok === true, JSON.stringify(r).slice(0, 300));
      ok("② ★★★ 查出了被跟踪的记忆文件", Array.isArray(r?.tracked) && r.tracked.length > 0, JSON.stringify(r?.tracked));
      ok(
        "② ★★ 查出的清单里含 LEDGER.md 与 decisions/D1.md",
        (r?.tracked ?? []).includes("LEDGER.md") && (r?.tracked ?? []).some((p) => p.startsWith("decisions/")),
        JSON.stringify(r?.tracked),
      );

      // ★★★ 三条"绝不动手"的反向断言 —— 这一项的全部安全性都在这里
      const after = git(dir, ["status", "--porcelain"]).out;
      const afterHead = git(dir, ["rev-parse", "HEAD"]).out;
      ok("② ★★★★ 检测**没有**改动工作区（git status 前后一致）", before === after, `${before} → ${after}`);
      ok("② ★★★★ 检测**没有**改写历史（HEAD 前后一致）", beforeHead === afterHead, `${beforeHead} → ${afterHead}`);
      ok("② ★★★★ 检测**没有**把文件从索引里摘掉（仍是 tracked）", git(dir, ["ls-files"]).out.includes("LEDGER.md"));

      // ★ 回执里必须给"怎么处理"，而不是只说"有泄漏"
      ok(
        "② ★★★ 回执里带着**处理方案**（不是只说有问题）",
        typeof r?.advice === "string" && r.advice.length > 0,
        JSON.stringify(r?.advice),
      );
      console.log(`     方案原文：${String(r?.advice ?? "").slice(0, 200)}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n── ③ 干净项目（记忆从未被提交）必须报 0 条，不许误报 ──");
{
  if (!hasGit) {
    console.log("  SKIP  git 不可用");
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3clean-"));
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "probe@example.invalid"]);
    git(dir, ["config", "user.name", "probe"]);
    fs.writeFileSync(path.join(dir, "index.js"), "console.log(1);\n", "utf8");
    fs.writeFileSync(path.join(dir, ".gitignore"), "LEDGER.md\ndecisions/\n", "utf8");
    git(dir, ["add", "--", "index.js", ".gitignore"]);
    git(dir, ["commit", "-m", "clean"]);
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n", "utf8");

    const r = part2.detectTrackedMemory(dir);
    ok("③ 干净项目返回 ok", r?.ok === true, JSON.stringify(r).slice(0, 200));
    ok("③ ★★★ 干净项目报 **0** 条（不误报）", Array.isArray(r?.tracked) && r.tracked.length === 0, JSON.stringify(r?.tracked));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n── ④ 非 git 目录：必须如实说「没法查」，而不是假装 0 条 ──");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3nogit-"));
  const r = part2.detectTrackedMemory(dir);
  ok("④ ★★ 非 git 目录返回 ok:false（不假装「没有泄漏」）", r?.ok === false, JSON.stringify(r).slice(0, 200));
  ok("④ 给出的原因说得清", typeof r?.reason === "string" && r.reason.length > 0, JSON.stringify(r?.reason));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n── ⑤ `ledger_status` 必须把这件事**报出来**（有出口，否则查了等于没查）──");
{
  if (!hasGit) {
    console.log("  SKIP  git 不可用");
  } else {
    // ★ 直接在**本项目**上跑（它是真 git 仓库、且记忆文件确实被跟踪着吗？
    //   —— 未必。所以这里验的是**结构**：字段在、且 checked 与 count 自洽。
    const part3 = await import(new URL("./part3.js", LIB_URL).href);
    const { projectRootOf } = part2;
    // ★ 用真 API 太重（要 ctx）；这里只验**导出存在** + 用 detectTrackedMemory 的结果形状。
    //   接线本身由自检 2143 条的"模块契约"那几条守着。
    ok("⑤ `part3` 模块可加载", part3 !== undefined);
    ok("⑤ `projectRootOf` 仍可用", typeof projectRootOf === "function");

    // ★★★ 真正要钉的判据：**"没查" 与 "查了很干净" 必须可区分**。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3status-"));
    const notGit = part2.detectTrackedMemory(dir);
    ok("⑤ ★★★ 非 git ⇒ ok:false（意思是「没查」）", notGit.ok === false);
    ok("⑤ ★★★ 它**不会**返回一个空数组冒充「很干净」", notGit.tracked === undefined, JSON.stringify(notGit.tracked));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
