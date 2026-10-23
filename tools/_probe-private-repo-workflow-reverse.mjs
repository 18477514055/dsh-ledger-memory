#!/usr/bin/env node
/**
 * ★★★ 反向验证：`_probe-private-repo-workflow.mjs` 的每一条断言**真的能红**吗？（D314）
 *
 * ★ 为什么必须有这一份：
 *   上一份探针第一版就是"14 PASS / 5 FAIL"，其中"钩子拦下公开库"那条**一直是绿的**，
 *   而它绿的原因是 **`sh` 不在 PATH ⇒ ENOENT ⇒ 退出码 1** —— 跟钩子一点关系都没有。
 *   ⇒ 判据：**「返回非 0」不等于「被测对象拒绝了」**。
 *   ⇒ 所以这份反向验证的重点不是"把钩子删掉会不会红"（那当然会），
 *     而是**每一条断言各自的理由**都能被单独打红。
 *
 * ★ 本探针的隔离纪律（照本项目踩过的坑）：
 *   ① **绝不在生产仓库上破坏配置** —— 每个场景都在 `mkdtemp` 里造一个**假仓库**
 *      （真的 `git init` + 真的 pre-push），跑真探针，看它红；
 *   ② **探针本体必须是"能参数化的"** —— 否则测不了别的仓库。
 *      ⇒ 本次给探针加了 `--root <dir>`，默认仍是本仓库（对日常使用零影响）；
 *   ③ 每个场景都要先断言"破坏真的注入了"（否则红得没道理，是假红）——
 *      正是 D312 那次的 B0 自检。
 *
 * 跑法：node tools/_probe-private-repo-workflow-reverse.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PROBE = path.join(HERE, "_probe-private-repo-workflow.mjs");
const GIT = "git";

let pass = 0;
let fail = 0;
const fails = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    fails.push(name);
    console.log(`  ❌ ${name}${detail === undefined ? "" : `\n       → ${detail}`}`);
  }
}

function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout ?? 180_000,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    return { code: 0, out: out ?? "", err: "" };
  } catch (e) {
    return {
      code: typeof e.status === "number" ? e.status : 1,
      out: (e.stdout ?? "").toString(),
      err: (e.stderr ?? "").toString(),
    };
  }
}

function mkdtemp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `d314-rev-${tag}-`));
}

/**
 * 造一个**最小可跑的假仓库**：git init + 一个假源码文件 + 真的 pre-push。
 * ★ 刻意不复制本项目 497 个文件 —— 那些与本节要测的东西无关，只会拖慢并制造噪音。
 */
function makeFakeRepo(tag, { withHook = true, pushDefault = "private", hookBody } = {}) {
  const dir = mkdtemp(tag);
  run(GIT, ["init", "-q", "-b", "main"], { cwd: dir });
  run(GIT, ["config", "user.email", "probe@example.invalid"], { cwd: dir });
  run(GIT, ["config", "user.name", "probe"], { cwd: dir });
  run(GIT, ["remote", "add", "origin", "https://github.com/18477514055/dsh-ledger-memory.git"], { cwd: dir });
  run(GIT, ["remote", "add", "private", "https://github.com/18477514055/dsh-ledger-memory-private.git"], { cwd: dir });
  if (pushDefault !== null) run(GIT, ["config", "remote.pushDefault", pushDefault], { cwd: dir });

  // 至少 60 个假源码文件（探针有一条 "文件数 > 50" 的断言）
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  for (let i = 0; i < 60; i++) {
    fs.writeFileSync(path.join(dir, "lib", `f${i}.js`), `// ${i}\n`, "utf8");
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }), "utf8");
  run(GIT, ["add", "--", "lib", "package.json"], { cwd: dir });
  run(GIT, ["commit", "-q", "-m", "init"], { cwd: dir });

  // ★ 建出 `refs/remotes/private/main` —— 等价于"已经 push 过私有库一次"。
  //   探针 ⑤ 读的是这个本地跟踪引用（不联网）；不建它探针会如实 SKIP 整节 ⑤。
  run(GIT, ["update-ref", "refs/remotes/private/main", "HEAD"], { cwd: dir });

  if (withHook) {
    fs.mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
    const body =
      hookBody === undefined
        ? fs.readFileSync(path.join(ROOT, ".git", "hooks", "pre-push"), "utf8")
        : hookBody;
    fs.writeFileSync(path.join(dir, ".git", "hooks", "pre-push"), body, "utf8");
  }
  return dir;
}

/** 跑探针（指向假仓库），返回 {code, out}。 */
function runProbe(root) {
  return run("node", [PROBE, "--root", root], { cwd: ROOT, timeout: 180_000 });
}

console.log("══════════════════════════════════════════════════════════════");
console.log(" 反向验证：发布分级探针的每条断言都能被单独打红吗（D314）");
console.log("══════════════════════════════════════════════════════════════");

// ────────────────────────────────────────────────────────────────
console.log("\n① 基线：没破坏时探针该是绿的（否则下面的红都不算数）");
{
  const dir = makeFakeRepo("base");
  const r = runProbe(dir);
  ok("基线全绿（假仓库照原样搭好 ⇒ 探针通过）", r.code === 0, `exit=${r.code}\n${(r.out + r.err).slice(-600)}`);
}

// ────────────────────────────────────────────────────────────────
console.log("\n② 摘掉 pre-push ⇒ 必须红，且红在「钩子」那几条上");
{
  const dir = makeFakeRepo("nohook", { withHook: false });
  ok("前提：钩子确实不存在", !fs.existsSync(path.join(dir, ".git", "hooks", "pre-push")));
  const r = runProbe(dir);
  ok("★ 摘掉钩子后探针变红", r.code !== 0, `exit=${r.code}`);
  ok(
    "★ 并且红的是「钩子文件存在」这条断言（不是别的）",
    /❌ 钩子文件存在/.test(r.out),
    r.out.split("\n").filter((l) => l.startsWith("  ❌")).slice(0, 6).join(" | "),
  );
}

// ────────────────────────────────────────────────────────────────
console.log("\n③ 把 pushDefault 改成 origin ⇒ 必须红，且红在「默认远端」上");
{
  const dir = makeFakeRepo("pushdef", { pushDefault: "origin" });
  const pd = run(GIT, ["config", "--get", "remote.pushDefault"], { cwd: dir });
  ok("前提：pushDefault 真的改成了 origin", pd.out.trim() === "origin", pd.out.trim());
  const r = runProbe(dir);
  ok("★ 改成 origin 后探针变红", r.code !== 0, `exit=${r.code}`);
  ok(
    "★ 并且红的是「pushDefault = private」这条",
    /❌ remote\.pushDefault = private/.test(r.out),
    r.out.split("\n").filter((l) => l.startsWith("  ❌")).slice(0, 6).join(" | "),
  );
}

// ────────────────────────────────────────────────────────────────
console.log("\n④ 把钩子换成「永远放行」⇒ 必须红（这是最关键的一条反向）");
{
  // ★ 这条测的是：探针不是靠"钩子文件存在"交差的，它真看放行/拦截行为。
  const dir = makeFakeRepo("nolimit", { hookBody: "#!/bin/sh\nexit 0\n" });
  const hookText = fs.readFileSync(path.join(dir, ".git", "hooks", "pre-push"), "utf8");
  ok("前提：钩子确实是「永远 exit 0」", hookText.includes("exit 0") && !hookText.includes("公开仓库"));
  const r = runProbe(dir);
  ok("★ 钩子永远放行 ⇒ 探针变红", r.code !== 0, `exit=${r.code}`);
  ok(
    "★ 并且红在「钩子拦下公开库」这条",
    /❌ ★ 钩子拦下公开库/.test(r.out),
    r.out.split("\n").filter((l) => l.startsWith("  ❌")).slice(0, 6).join(" | "),
  );
}

// ────────────────────────────────────────────────────────────────
console.log("\n⑤ 把钩子换成「永远拦截」⇒ 必须红（证明它不只看得见「红」，也看得见「过不去」）");
{
  // ★ 对称的那一半：只剩"拦"没有"放"，机制就是死锁。上一版探针在这一点上是瞎的。
  const dir = makeFakeRepo("alwaysblock", { hookBody: "#!/bin/sh\necho 拦下了：公开仓库\nexit 1\n" });
  const r = runProbe(dir);
  ok("★ 钩子永远拦截 ⇒ 探针变红", r.code !== 0, `exit=${r.code}`);
  ok(
    "★ 并且红在「私有库放行」这条（死锁会被发现）",
    /❌ 私有库放行/.test(r.out),
    r.out.split("\n").filter((l) => l.startsWith("  ❌")).slice(0, 8).join(" | "),
  );
}

// ────────────────────────────────────────────────────────────────
console.log("\n⑥ 私有库里塞进记忆面文件 ⇒ 必须红（「没漏」这条断言真的在看内容）");
{
  const dir = makeFakeRepo("leak");
  // 故意把台账与决策卡提交进假仓库 —— 这正是要防的那种泄露
  fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n- 私有内容\n", "utf8");
  fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "decisions", "D1.md"), "# D1\n", "utf8");
  run(GIT, ["add", "--", "LEDGER.md", "decisions"], { cwd: dir });
  run(GIT, ["commit", "-q", "-m", "leak"], { cwd: dir });
  // ★ 把"已推过的私有库"也更新到这次泄露的提交 —— 否则探针读到的是旧的干净提交，红不了。
  run(GIT, ["update-ref", "refs/remotes/private/main", "HEAD"], { cwd: dir });

  const lsTree = run(GIT, ["ls-tree", "-r", "HEAD", "--name-only"], { cwd: dir });
  ok("前提：记忆面真的进了假仓库的提交", /LEDGER\.md/.test(lsTree.out) && /decisions\/D1\.md/.test(lsTree.out));

  const r = runProbe(dir);
  ok("★ 私有库带记忆面 ⇒ 探针变红", r.code !== 0, `exit=${r.code}`);
  ok(
    "★ 并且红在「记忆面一份都没带出去」这条",
    /❌ ★★★ 记忆面一份都没带出去/.test(r.out),
    r.out.split("\n").filter((l) => l.startsWith("  ❌")).slice(0, 8).join(" | "),
  );
}

// ────────────────────────────────────────────────────────────────
console.log("\n⑦ 拿掉「私有库跟踪引用」⇒ ⑤ 要 SKIP，且 SKIP 必须**出现在结论里**（不许假装全绿）");
{
  // ★ 这条守的是"如实跳过"。本探针第一版就栽在这上面：
  //   只数 PASS 行 ⇒ SKIP 与 PASS 长得一样 ⇒ 报"全过"。
  //   ⇒ 判据：**「全过」这个词只许在真的什么都没跳过时出现。**
  const dir = makeFakeRepo("noref");
  run(GIT, ["update-ref", "-d", "refs/remotes/private/main"], { cwd: dir });
  const hasRef = run(GIT, ["rev-parse", "--verify", "--quiet", "refs/remotes/private/main"], { cwd: dir });
  ok("前提：跟踪引用真的删掉了", hasRef.code !== 0 || hasRef.out.trim() === "", hasRef.out.trim());

  const r = runProbe(dir);
  ok("★ ⑤ 如实 SKIP（有 ⑤ 那一节的 SKIP 字样）", /⑤ 私有库内容[\s\S]{0,400}SKIP/.test(r.out), r.out.slice(-700));
  ok(
    "★★ 结论里明说「不算全绿」/列入跳过清单（不是一句「全部通过」了事）",
    /不算全绿/.test(r.out) && /⑤ 私有库内容/.test(r.out.split("─").pop() ?? ""),
    r.out.split("\n").slice(-8).join(" | "),
  );
}

// ────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(62));
if (fail === 0) {
  console.log(`✅ 反向验证通过：${pass} PASS / 0 FAIL —— 七种破坏全部看见红。`);
  process.exit(0);
} else {
  console.log(`❌ ${pass} PASS / ${fail} FAIL`);
  for (const f of fails) console.log(`   · ${f}`);
  process.exit(1);
}
