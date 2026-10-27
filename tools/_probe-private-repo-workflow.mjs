#!/usr/bin/env node
/**
 * ★★★ 只读探针：**发布分级**这套机制真的在工作吗？（D314）
 *
 * 机制（用户 2026-10-23 定的）：
 *   所有改动**先推私有仓库**（`dsh-ledger-memory-private`）⇒ 用户用别的渠道审查 ⇒ 审查通过才上公开仓库。
 *
 * ★ 为什么值得一条专门的探针，而不是"我记住了"：
 *   公开仓库的 git 历史**推上去就永久在公网**（force-push 也删不掉别人的 clone / 镜像 / 缓存）。
 *   ⇒ 「推错远端」是**不可撤销**的那一类失误，而它最常见的形态只是"手滑多打了 origin"。
 *   ⇒ 靠自律挡不住；必须是**配置 + 钩子**挡住，并且**能看见它挡住了**。
 *
 * ★ 本探针的判据（照本项目纪律）：
 *   ① **判据只问「行为对不对」** —— 不看钩子源码里写了什么，只看"真推时放不放行"；
 *   ② **反向必须能看见红** —— 每次结论都要有一条"本该被拦"的对照；
 *   ③ **不凭印象** —— 远端 URL / pushDefault 全部从 `git config` 现读，不硬编码期望值为通过；
 *   ④ 私有库"不含记忆面"查的是**远端真实文件清单**（`git ls-tree private/main`），不是本地工作区。
 *
 * 跑法：node tools/_probe-private-repo-workflow.mjs
 *       node tools/_probe-private-repo-workflow.mjs --verbose
 *
 * ★ 它**只读**：不 push、不改配置、不改文件。唯一的外部动作是 `git push --dry-run`（不发数据）
 *   与一次 `gh api`（查私有库属性，失败则如实 SKIP）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(HERE, "..");
const VERBOSE = process.argv.includes("--verbose");

/**
 * ★ `--root <dir>`：把探针指向**另一个仓库**（默认就是本仓库）。
 *   加这个参数**只为反向验证服务** —— 破坏生产仓库的配置来证明"断言能红"是禁止的
 *   （本项目 2026-10-19 真栽过：为验回滚在生产工作区污染文件）。
 *   ⇒ 反向验证在 `mkdtemp` 造的假仓库上跑真探针，本仓库一行配置都不动。
 */
function parseRoot() {
  const i = process.argv.indexOf("--root");
  if (i < 0) return DEFAULT_ROOT;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.log("用法：node tools/_probe-private-repo-workflow.mjs [--root <仓库目录>] [--verbose]");
    process.exit(2);
  }
  return path.resolve(v);
}
const ROOT = parseRoot();

const PUBLIC_URL = "https://github.com/18477514055/dsh-ledger-memory.git";
const PRIVATE_URL = "https://github.com/18477514055/dsh-ledger-memory-private.git";
const HOOK = path.join(ROOT, ".git", "hooks", "pre-push");

/**
 * ★★★ 本机踩过的坑（第一版就踩了，留着当判据）：**`sh` 不在 PATH 上**。
 *   git 自带的 sh 在 `<git>/bin/sh.exe` 与 `<git>/usr/bin/sh.exe`，
 *   但 Node 的 `execFileSync("sh", …)` 找不到它 ⇒ `ENOENT` ⇒ **退出码 1**。
 *   ★ 而"钩子拦下公开库"这条断言恰好就是在等"退出码非 0" ⇒ **它会绿** —— 假绿。
 *   ⇒ 判据：**「返回非 0」不等于「被测对象拒绝了」** —— 必须同时看它**说了什么**。
 *     本探针因此加了一条 `shPath !== undefined` 的前置断言：找不到 sh 就整节 SKIP，绝不当通过。
 */
function findSh() {
  const candidates = [
    "C:/Program Files/Git/bin/sh.exe",
    "C:/Program Files/Git/usr/bin/sh.exe",
    "C:/Program Files (x86)/Git/bin/sh.exe",
    "/bin/sh",
    "/usr/bin/sh",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // 退路：让系统 PATH 找
  const probe = run("sh", ["-c", "echo ok"], { timeout: 10_000 });
  return probe.code === 0 ? "sh" : undefined;
}
const SH = findSh();

let pass = 0;
let fail = 0;
const fails = [];

/**
 * ★★★ SKIP 台账 —— **必须在开头就声明**。
 *   本项目栽过：只数 PASS 行 ⇒ 崩溃 / 跳过 / 全绿长得一模一样。
 *   ⇒ 判据：**「全部通过」这个词只许在 skipped 为空时出现。**
 */
const skipped = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${VERBOSE && detail !== undefined ? `  [${detail}]` : ""}`);
  } else {
    fail++;
    fails.push(name);
    console.log(`  ❌ ${name}${detail !== undefined ? `\n       → ${detail}` : ""}`);
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}
function head(t) {
  console.log(`\n${t}`);
}

/** 跑一条命令，返回 {code, out, err}；永不抛（探针不许因外部失败直接崩）。 */
function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout ?? 60_000,
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: opts.shell ?? false,
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

const GIT = "git";

console.log("══════════════════════════════════════════════════════════════");
console.log(" 发布分级探针：改动先进私有仓库，审查通过才上公开仓库（D314）");
console.log("══════════════════════════════════════════════════════════════");

// ────────────────────────────────────────────────────────────────
head("① 远端配置：两个远端都在，且各自指向对的地方");

const remotes = run(GIT, ["remote", "-v"]);
const remoteLines = remotes.out.split("\n").filter((l) => l.trim() !== "");
const fetchOf = (name) => {
  const m = remoteLines.find((l) => l.startsWith(name) && l.includes("(fetch)"));
  return m === undefined ? undefined : m.split(/\s+/)[1];
};

eq("origin（公开库）地址没被改动", fetchOf("origin"), PUBLIC_URL);
eq("private（私有库）地址正确，且是原名列加后缀", fetchOf("private"), PRIVATE_URL);

// ★ 判据：私有库名字必须是"原名 + 后缀"，不是换一个不相干的名字。
//   理由：审查时人要能一眼看出"这是同一个项目的另一份"，名字一变就得靠记忆。
const privName = (fetchOf("private") ?? "").replace(/\.git$/, "").split("/").pop();
const pubName = (fetchOf("origin") ?? "").replace(/\.git$/, "").split("/").pop();
ok(
  "私有库名 = 公开库名 + 后缀（-private）",
  privName === `${pubName}-private`,
  `私有=${privName} 公开=${pubName}`,
);

// ────────────────────────────────────────────────────────────────
head("② 默认走私有库：裸 `git push` 不该直达公网");

const pushDefault = run(GIT, ["config", "--get", "remote.pushDefault"]);
eq("remote.pushDefault = private（裸 push 默认落私有库）", pushDefault.out.trim(), "private");

// ★ 这一条是**反向对照**：如果默认是 origin，那么"忘了打远端名"就会直接发到公网。
//   所以它不是"顺便检查一下"，它是这套机制的地基。
ok(
  "★ 反向对照：默认远端**不是** origin（否则裸 push 就直发公网）",
  pushDefault.out.trim() !== "origin",
  `remote.pushDefault=${pushDefault.out.trim()}`,
);

const branchRemote = run(GIT, ["config", "--get", "branch.main.remote"]);
if (VERBOSE) console.log(`   （branch.main.remote = ${branchRemote.out.trim()}，上游跟踪用，不决定裸 push 去向）`);

// ────────────────────────────────────────────────────────────────
head("③ pre-push 钩子：真的拦得住「手滑推公开库」");

ok("钩子文件存在", fs.existsSync(HOOK), HOOK);
ok("钩子有可执行位 / 至少可读", fs.existsSync(HOOK) && fs.statSync(HOOK).size > 0);

/**
 * ★ 前置：**先证明"调用通道"本身是通的**，否则下面所有"退出码非 0"都可能是假的。
 *   这是本探针第一版踩到的坑（`sh` 不在 PATH ⇒ ENOENT ⇒ 退出码 1 ⇒ 假绿）。
 */
ok(
  "★★ 前置：找得到 sh（否则下面所有「退出码」都不可信）",
  SH !== undefined,
  SH === undefined ? "PATH 与 Git 自带路径都没找到 sh.exe" : SH,
);
if (SH === undefined) {
  console.log("  ⏭ ③④ 整节 SKIP：没有 sh 就无法执行钩子 —— 如实跳过，绝不当通过");
}

/**
 * ★ 直接调用钩子（不走 git）—— 快、确定、能把"放行/拦截"单独测出来。
 *   git 调用只用来证明"git 真的会执行它"（见 ④）。
 */
function runHook(remoteName, remoteUrl, env = {}) {
  if (SH === undefined) return { code: null, out: "", err: "no-sh" };
  return run(SH, [HOOK, remoteName, remoteUrl], { env, timeout: 20_000 });
}

if (SH !== undefined) {
const hOrigin = runHook("origin", PUBLIC_URL);
ok(
  "★ 钩子拦下公开库（退出码非 0）",
  hOrigin.code !== 0,
  `exit=${hOrigin.code}`,
);
ok(
  "拦截时说明了「这是公开仓库」与解锁办法",
  /公开仓库/.test(hOrigin.out + hOrigin.err) && /DSH_ALLOW_PUBLIC_PUSH/.test(hOrigin.out + hOrigin.err),
  (hOrigin.out + hOrigin.err).slice(0, 200),
);

const hPrivate = runHook("private", PRIVATE_URL);
eq("私有库放行（退出码 0，且不打印拦截话术）", hPrivate.code, 0);
ok("私有库放行时没有出现拦截话术", !/拦下了/.test(hPrivate.out + hPrivate.err), hPrivate.out.slice(0, 120));

// ★ 反向对照：显式解锁必须真的能放行 —— 否则这套机制就成了"永远推不了公开库"的死锁。
const hUnlocked = runHook("origin", PUBLIC_URL, { DSH_ALLOW_PUBLIC_PUSH: "1" });
eq("★ 反向对照：DSH_ALLOW_PUBLIC_PUSH=1 时放行公开库", hUnlocked.code, 0);
ok("解锁时明确回显「已显式解锁」（不是静默放行）", /已显式解锁/.test(hUnlocked.out), hUnlocked.out.slice(0, 160));

// ★ 第三种远端（既不是公开也不是私有）必须放行 —— 钩子只该管"这个项目的那一条边界"。
const hOther = runHook("backup", "https://example.invalid/some/other/repo.git");
eq("无关远端放行（钩子不越权管别的仓库）", hOther.code, 0);
} // end if (SH !== undefined)

// ────────────────────────────────────────────────────────────────
head("④ git 真的会执行这个钩子（不是只在我手调时生效）");

/**
 * ★★★ 这一节要 `git push --dry-run`，而 **dry-run 仍然要连远端**（只是不发对象）。
 *   ⇒ 本机实测：同一分钟内一次 `schannel: failed to receive handshake`、一次成功 ⇒ **随机**。
 *   ★★ 更要命的是**断网时它长得像"通过"**：连不上 ⇒ 退出码非 0 ⇒
 *      「被挡」那条断言是绿的（判据只有"退出码非 0"）；而「理由是不是钩子」那条才红。
 *   ⇒ 判据：**外部依赖不可用时必须 SKIP，不许让"连不上"冒充"被拦下"。**
 */
function isNetworkFailure(text) {
  return /schannel|SSL\/TLS|unable to access|Could not resolve|Failed to connect|Connection (refused|reset|timed out)|gnutls|The remote end hung up/i.test(
    text,
  );
}

/**
 * ★★★ 分支名**不能写死 `main`**（第二版栽的坑）：
 *   我原来写 `git push --dry-run origin main`。反向验证造的假仓库分支叫 `trunk` ⇒
 *   git 报 `src refspec main does not match any` ⇒ **退出码非 0** ⇒
 *   而"被挡"那条断言的判据正是"退出码非 0" ⇒ **它会绿**，跟钩子毫无关系。
 *   ⇒ 改成动态读当前分支，并**额外断言 refspec 本身是合法的**（否则下面全是假绿）。
 */
const curBranch = run(GIT, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
ok("前置：取得到当前分支名（否则 ④ 全节不可信）", curBranch !== "" && curBranch !== "HEAD", curBranch);

const dryOrigin = run(GIT, ["push", "--dry-run", "origin", curBranch], { timeout: 120_000 });
const dryOriginText = dryOrigin.out + dryOrigin.err;
if (isNetworkFailure(dryOriginText)) {
  console.log("  ⏭ SKIP：`git push --dry-run origin` 连不上远端（网络）—— 如实跳过");
  console.log("     ★ 断网时「退出码非 0」与「被钩子拦下」长得一模一样，绝不能算通过");
  console.log(`     ${dryOriginText.split("\n").filter((l) => l.trim() !== "").slice(0, 2).join(" / ").slice(0, 200)}`);
  skipped.push("④ 真实 git 调用路径（网络不可用）");
} else {
  ok(
    `\`git push --dry-run origin ${curBranch}\` 被挡（真实 git 调用路径）`,
    dryOrigin.code !== 0,
    `exit=${dryOrigin.code} · ${dryOriginText.slice(0, 200)}`,
  );
  ok(
    "★ 并且挡的理由就是钩子那条话术（不是权限/refspec 等别的原因）",
    /公开仓库/.test(dryOriginText),
    dryOriginText.slice(0, 200),
  );
  // ★ 明确排除"分支不存在"这一类假绿 —— 它会让上面两条同时成立却毫无意义。
  ok(
    "★★ 且**不是**因为 refspec 不存在才非 0（排除最常见的那种假绿）",
    !/src refspec .* does not match any/i.test(dryOriginText),
    dryOriginText.slice(0, 200),
  );
}

const dryPrivate = run(GIT, ["push", "--dry-run", "private", curBranch], { timeout: 120_000 });
const dryPrivateText = dryPrivate.out + dryPrivate.err;
if (isNetworkFailure(dryPrivateText)) {
  console.log("  ⏭ SKIP：`git push --dry-run private` 连不上远端（网络）—— 如实跳过");
  skipped.push("④ 私有库不误伤（网络不可用）");
} else {
  ok(
    `\`git push --dry-run private ${curBranch}\` 没被钩子拦（钩子不误伤私有库）`,
    !/拦下了/.test(dryPrivateText),
    dryPrivateText.slice(0, 200),
  );
  // ★ 与上面同型：这条也要排除"其实压根没推到那一步"的假绿。
  ok(
    "★★ 且不是 refspec 不存在造成的「看起来没被拦」",
    !/src refspec .* does not match any/i.test(dryPrivateText),
    dryPrivateText.slice(0, 200),
  );
}

// ────────────────────────────────────────────────────────────────
head("⑤ 私有库内容：同步到了，但**记忆面一份都没带出去**");

/**
 * ★★★ 这里第一版写的是 `git ls-remote private` —— **它要联外网**。
 *   实测：同一分钟内一次 `schannel: failed to receive handshake`、一次成功 ⇒ 探针会**随机 SKIP**。
 *   ⇒ 判据：**能本地确定的事，不要联网去问** —— 联网只让结论变得更不可靠，不会更可靠。
 *   ★ 改成读**本地远端跟踪引用** `refs/remotes/private/main`：
 *     `git push private main` 会顺手建它，内容就是"上次真的推上去的那个 commit"。
 *     它同样是**远端状态**（不是工作区），但是本地可读、零网络、结论稳定。
 */
const TRACKING_REF = `refs/remotes/private/${curBranch}`;
const tracking = run(GIT, ["rev-parse", "--verify", "--quiet", TRACKING_REF]);
if (tracking.code !== 0 || tracking.out.trim() === "") {
  console.log(`  ⏭ SKIP：本地没有 ${TRACKING_REF}（还没推过私有库）—— 如实跳过，不当通过`);
} else {
  const remoteSha = tracking.out.trim();
  const localSha = run(GIT, ["rev-parse", "HEAD"]).out.trim();
  eq(`私有库 ${TRACKING_REF} 与本地 HEAD 同一个 commit（推的是现在的代码）`, remoteSha, localSha);

  // ★ 判据：查的是**远端树上真实存在的文件**，不是本地 .gitignore 写了什么。
  //   .gitignore 只影响"下次 add 时会不会被带上"，不影响"已经推上去的有没有"。
  const tree = run(GIT, ["ls-tree", "-r", TRACKING_REF, "--name-only"]);
  if (tree.code !== 0) {
    console.log(`  ⏭ SKIP：读不到 ${TRACKING_REF} 的文件清单 —— ${tree.err.slice(0, 160)}`);
    // ★ 2026-10-23（D315 · Gemini 审查 001 的 F-07②）：**每一处 SKIP 都必须记进 `skipped`**。
    //   我这里原来只打印、没 push ⇒ 结论行会在"有跳过"的情况下说"全部通过"（骗人）。
    skipped.push("⑤ 私有库文件清单（读不到跟踪引用的 tree）");
  } else {
    const files = tree.out.split("\n").filter((l) => l !== "");
    ok("私有库确实有源码（而不是空仓库）", files.length > 50, `${files.length} 个文件`);

    const MEMORY_PATTERNS = [
      /^LEDGER\.md$/,
      /^JOURNAL\.md$/,
      /^PRINCIPLES\.md$/,
      /^GOALS\.md$/,
      /^LESSONS\.md$/,
      /^DECISIONS\.md$/,
      /^decisions\//,
      /^lessons\//,
      /^goals\//,
      /^docs\//,
      /^_ledger-log\//,
      /^_ledger-archive\//,
      /^_handoff\//,
      /^_stash\//,
      /^_store-research\//,
      /^\.dsh-ledger\.json$/,
      /-ledger-memory\//,
      /\.tgz$/,
    ];
    const leaked = files.filter((f) => MEMORY_PATTERNS.some((re) => re.test(f)));
    ok(
      "★★★ 记忆面一份都没带出去（台账/决策/日志/文档/存档/交接/stash）",
      leaked.length === 0,
      leaked.slice(0, 12).join(" · "),
    );

    // ★★★ 反向对照（第一版把这里写成了一段无意义代码，直接 TypeError 崩了 —— 记着）：
    //   上面"私有库干净"只有在**同一套规则认得出本机真实存在的记忆面**时才有意义。
    //   否则"没漏"可能只是"我的模式一个都匹配不上"——那是最典型的一种假绿。
    const localMemoryPaths = [
      "LEDGER.md",
      "JOURNAL.md",
      "PRINCIPLES.md",
      ".dsh-ledger.json",
      "decisions/D313.md",
      "lessons/L1.md",
      "docs/README.md",
      "_ledger-log/x.md",
      "_ledger-archive/x.md",
      "_handoff/x.md",
      "_stash/x.md",
      "10.项目台账-ledger-memory/LEDGER.md",
      "dsh-ledger-memory-1.6.0.tgz",
    ];
    const unmatched = localMemoryPaths.filter((p) => !MEMORY_PATTERNS.some((re) => re.test(p)));
    ok(
      "★ 反向对照：这些模式**认得出**记忆面（不是永远匹配不到）",
      unmatched.length === 0,
      `漏认：${unmatched.join(" · ")}`,
    );

    // ★ 第二条反向对照：本仓库（`--root` 指向的那个）确实有记忆面，才说明"干净"是个有意义的结果。
    //   ★ 用法上要允许仓库里根本没有记忆面（比如反向验证造的假仓库）⇒ 那种情况**如实 SKIP**，
    //     不假装通过，也不假装失败。
    const realMemoryOnDisk = [
      path.join(ROOT, "LEDGER.md"),
      path.join(ROOT, "JOURNAL.md"),
      path.join(ROOT, ".dsh-ledger.json"),
    ].filter((p) => fs.existsSync(p));
    const memoryDirsOnDisk = ["decisions", "docs", "_ledger-log", "_ledger-archive"].filter((d) =>
      fs.existsSync(path.join(ROOT, d)),
    );
    if (realMemoryOnDisk.length === 0 && memoryDirsOnDisk.length === 0) {
      console.log("  ⏭ SKIP：这个仓库本地没有任何记忆面（假仓库/空仓库）—— 「干净」无从谈起，如实跳过");
      // ★ 同上（F-07②）：SKIP 必须记账，否则结论行会假称"全部通过"。
      skipped.push("⑤ 反向对照（本仓库本地无记忆面）");
    } else {
      ok(
        "★ 反向对照：本仓库本地确有记忆面（「干净」才是个有意义的结果）",
        realMemoryOnDisk.length + memoryDirsOnDisk.length > 0,
        `文件 ${realMemoryOnDisk.length} 个 · 目录 ${memoryDirsOnDisk.length} 个`,
      );
    }
  }
}

// ────────────────────────────────────────────────────────────────
head("⑥ 私有库的可见性：真的只有 private（公开=审查失效）");

// ★ 这条要联网。**能本地确定的事不该联网**（⑤ 已经改成读本地跟踪引用），
//   但这条真的只能问 GitHub —— 所以它**如实 SKIP，且 SKIP 要在结论里被看见**。
const repoApi = run("gh", ["api", "repos/18477514055/dsh-ledger-memory-private"], { timeout: 120_000 });
let visibilityChecked = false;
if (repoApi.code !== 0) {
  console.log(`  ⏭ SKIP：gh api 取不到（网络/未登录）—— 如实跳过，不当通过`);
  console.log(`     ${(repoApi.err || "").slice(0, 160)}`);
} else {
  let meta = null;
  try {
    meta = JSON.parse(repoApi.out);
  } catch {
    meta = null;
  }
  if (meta === null) {
    console.log("  ⏭ SKIP：gh api 返回的不是 JSON");
  } else {
    eq("私有库 visibility = private", meta.visibility, "private");
    ok("private 布尔为 true", meta.private === true, String(meta.private));
    visibilityChecked = true;
  }
}

// ────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(62));
/**
 * ★★★ 结论行必须**如实**说出哪些节 SKIP 了。
 *   本项目栽过：只数 PASS 行 ⇒ 崩溃/跳过都长得像全绿。
 *   ⇒ 判据：**「全过」这个词只许在真的什么都没跳过时出现。**
 */
if (SH === undefined) skipped.push("③ 钩子执行（找不到 sh）");
if (!visibilityChecked) skipped.push("⑥ 私有库可见性（联网未取到）");
// ⑤ 的 SKIP 情况由它自己那节打印；这里按 tracking-ref 是否取到再补一条
if (run(GIT, ["rev-parse", "--verify", "--quiet", `refs/remotes/private/${curBranch}`]).code !== 0) {
  skipped.push("⑤ 私有库内容（本机还没有私有库跟踪引用）");
}

if (fail === 0) {
  if (skipped.length === 0) {
    console.log(`✅ 全部通过：${pass} PASS / 0 FAIL（无跳过）`);
    console.log("   发布分级生效：裸 push 进私有库，公开库必须显式解锁。");
  } else {
    console.log(`✅ 已跑过的全过：${pass} PASS / 0 FAIL —— 但有 ${skipped.length} 节 SKIP，**不算全绿**：`);
    for (const s of skipped) console.log(`   ⏭ ${s}`);
  }
  process.exit(0);
} else {
  console.log(`❌ ${pass} PASS / ${fail} FAIL`);
  for (const f of fails) console.log(`   · ${f}`);
  if (skipped.length > 0) for (const s of skipped) console.log(`   ⏭ ${s}`);
  process.exit(1);
}
