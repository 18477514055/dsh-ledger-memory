/**
 * 探针（V3 阶段 2 · 最后一刀 D294）：**Git hooks 真能挡住"把记忆提交进去"吗？**
 *
 * ★★★ 为什么要先测再写：`pre-commit` 是**唯一**能在"提交那一刻"拦一道的钩子，
 *   但它有三个容易踩空的地方，全部必须实测：
 *
 *   ① **它默认不执行** —— `.git/hooks/*.sample` 是模板，去掉 `.sample` 还要**可执行位**（Linux/macOS）。
 *   ② **`git commit --no-verify` 直接跳过** —— 它**不是安全边界**，只是"提醒"。
 *   ③ **`core.hooksPath` 可以整体改道** —— 用户/别的工具配了就绕过。
 *
 *   ⇒ 若我在文档里把它说成"防护"，那是**过度承诺**。
 *     正确的定位是：**"拦住走正常流程的人"**，并**如实写明它拦不住什么**。
 *
 * ★ 判据：
 *   · **能拦**：正常 `git commit` 被 hooks 挡下（退出码非 0，且记忆文件**没进** commit）。
 *   · **拦不住**：`git commit --no-verify` 能过（这条**必须**验，否则我们不知道边界在哪）。
 *
 * 本探针**只读 + 一次性临时目录**，不碰任何真实项目。
 *
 * 跑法：node tools/_probe-v3-hooks.mjs
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

/** 造一个已 init 的仓库（hooks 只能在仓库里装）。 */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3hook-"));
  if (git(dir, ["init"]).code !== 0) return undefined;
  git(dir, ["config", "user.email", "probe@example.invalid"]);
  git(dir, ["config", "user.name", "probe"]);
  fs.writeFileSync(path.join(dir, "index.js"), "console.log(1);\n", "utf8");
  git(dir, ["add", "--", "index.js"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

console.log("── ① 安装函数：必须**默认不装**，只有显式传才装 ──");
{
  if (!hasGit) {
    console.log("  SKIP  git 不可用");
  } else {
    ok("① 安装函数已导出", typeof part2.installPreCommitHook === "function", typeof part2.installPreCommitHook);

    if (typeof part2.installPreCommitHook === "function") {
      const dir = makeRepo();
      const hookPath = path.join(dir, ".git", "hooks", "pre-commit");

      // ★★★ 最重要的一条：**默认不装**
      const r0 = part2.installPreCommitHook(dir);
      ok(
        "① ★★★★ 不传 enabled ⇒ **不装**（默认 off，用户拍板）",
        r0?.installed === false && !fs.existsSync(hookPath),
        JSON.stringify(r0),
      );

      // ★ 显式装
      const r1 = part2.installPreCommitHook(dir, { enabled: true });
      ok("① ★★ 显式 enabled:true ⇒ 真的装了", r1?.installed === true && fs.existsSync(hookPath), JSON.stringify(r1));
      if (fs.existsSync(hookPath)) {
        const body = fs.readFileSync(hookPath, "utf8");
        ok("① hook 里提到记忆/ledger（内容可读）", /记忆|ledger/i.test(body), body.slice(0, 80));
        ok("① ★ hook 里**点名了** `--no-verify` 能绕过（不假装是安全边界）", /no-verify/.test(body), body.slice(0, 300));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log("\n── ② 真的能拦住吗：正常 `git commit` 必须被挡下 ──");
{
  if (!hasGit || typeof part2.installPreCommitHook !== "function") {
    console.log("  SKIP  git 不可用或函数未导出");
  } else {
    const dir = makeRepo();
    part2.installPreCommitHook(dir, { enabled: true });
    // ★ 造"已经暂存了记忆文件"的状态 —— 这正是 hooks 要拦的那一刻
    fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n私有内容\n", "utf8");
    git(dir, ["add", "-f", "--", "LEDGER.md"]); // -f 强制（模拟"有人绕过 ignore 了"）
    const staged = git(dir, ["diff", "--cached", "--name-only"]).out;
    ok("② 夹具成立：LEDGER.md 已在暂存区", staged.includes("LEDGER.md"), staged);

    const c = git(dir, ["commit", "-m", "should be blocked"]);
    ok("② ★★★★ 正常 commit **被挡下**（退出码非 0）", c.code !== 0, `code=${c.code} err=${c.err.slice(0, 200)}`);

    // ★ 而且它**真的没进历史**
    const log = git(dir, ["log", "--oneline"]).out;
    ok("② ★★★ 那次 commit **没有**进历史（HEAD 仍是 init）", !log.includes("should be blocked"), log);

    // ═══ ③ 边界：`--no-verify` 必须能过（我们**不许**假装拦得住）═══
    const c2 = git(dir, ["commit", "--no-verify", "-m", "bypassed on purpose"]);
    ok(
      "③ ★★★★ `--no-verify` **能绕过** —— 这是必须承认的边界，不是 bug",
      c2.code === 0,
      `code=${c2.code}（若这里是 0 就对了：说明我们没把 hooks 吹成安全边界）`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n── ④ 卸载：必须能干净摘掉（不装也得能卸）──");
{
  if (!hasGit || typeof part2.installPreCommitHook !== "function") {
    console.log("  SKIP");
  } else {
    const dir = makeRepo();
    const hookPath = path.join(dir, ".git", "hooks", "pre-commit");
    part2.installPreCommitHook(dir, { enabled: true });
    ok("④ 已装上", fs.existsSync(hookPath));
    const r = part2.installPreCommitHook(dir, { enabled: false });
    ok("④ ★★ enabled:false ⇒ 真的卸掉了", r?.installed === false && !fs.existsSync(hookPath), JSON.stringify(r));
    // ★ 重复卸载不许报错（幂等）
    const r2 = part2.installPreCommitHook(dir, { enabled: false });
    ok("④ ★ 重复卸载是幂等的（不报错）", r2?.installed === false, JSON.stringify(r2));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n── ⑤ 非 git 目录：必须如实说装不了 ──");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3hook-no-"));
  if (typeof part2.installPreCommitHook === "function") {
    const r = part2.installPreCommitHook(dir, { enabled: true });
    ok("⑤ ★★ 非 git 目录 ⇒ 不装，且说清原因", r?.installed === false && typeof r?.reason === "string", JSON.stringify(r));
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n── ⑥ 别人的钩子：**绝对不许覆盖、也不许删** ──");
{
  if (!hasGit || typeof part2.installPreCommitHook !== "function") {
    console.log("  SKIP");
  } else {
    const dir = makeRepo();
    const hookPath = path.join(dir, ".git", "hooks", "pre-commit");
    const foreignBody = "#!/bin/sh\n# 用户自己写的检查\necho mine\n";
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, foreignBody, "utf8");

    // ★ 安装必须**拒绝**，且**原文件一字不改**
    const r1 = part2.installPreCommitHook(dir, { enabled: true });
    ok("⑥ ★★★★ 已有别人的钩子 ⇒ 拒绝安装（不覆盖）", r1?.installed === false && r1?.foreign === true, JSON.stringify(r1));
    ok("⑥ ★★★★ 用户原文件**一个字节都没被改**", fs.readFileSync(hookPath, "utf8") === foreignBody, fs.readFileSync(hookPath, "utf8").slice(0, 80));

    // ★ 卸载也必须**拒绝**（不能把别人的删掉）
    const r2 = part2.installPreCommitHook(dir, { enabled: false });
    ok("⑥ ★★★★ 卸载时也拒绝动别人的钩子", r2?.foreign === true, JSON.stringify(r2));
    ok("⑥ ★★★★ 卸载后用户原文件**仍然在**", fs.existsSync(hookPath) && fs.readFileSync(hookPath, "utf8") === foreignBody);

    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
