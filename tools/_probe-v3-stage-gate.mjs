/**
 * 探针（V3 阶段 2 · 第一步）：**`autoGitAdd` 现在到底还有没有在用？**
 *
 * ★★★ 为什么要先测这个（而不是直接改代码）：
 *   D288 把 `DEFAULT_IGNORE_LINES` 填成了 19 条（LEDGER.md / decisions / …全部忽略）。
 *   而 `gitAdd()` 在 D288 又加了"先 check-ignore，把被挡住的路径摘出去"的逻辑。
 *   ⇒ **两个修复撞在一起**：一边写入规则挡住记忆文件，另一边只见被挡就跳过。
 *     **合理怀疑：`autoGitAdd: true` 现在完全是空转** —— 每次都在 skip，
 *     但回执 `{ok:true, skipped:[...], note:"全部被 .gitignore 挡住"}` 看起来像成功。
 *
 *   ★ 若这个怀疑成立，那就是本项目最忌的那一类：
 *     **配置写着"开"，代码也在跑，回执是绿的，而实际上什么都没做。**
 *     （「记录存在 ≠ 记录准确」的同型；也是 D89 / 静默失败那条纪律的同型。）
 *
 * ★ 判据（先说清怎么算成立 / 不成立）：
 *   · **成立**：init 之后 `git status --porcelain` 里**没有** LEDGER.md 等记忆文件被暂存。
 *   · **不成立**：它们真的进了暂存区（那就说明 ignore 规则没生效）。
 *
 * ★ 本探针**只读 + 一次性临时目录**，不碰任何真实项目。
 *
 * 跑法：node tools/_probe-v3-stage-gate.mjs
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
const defs = await import(new URL("./defs.js", LIB_URL).href);

const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { code: r.status, out: String(r.stdout ?? "").trim(), err: String(r.stderr ?? "").trim() };
};

/** 造一个真 git 仓库（git 可用才行）。 */
function makeGitProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3stage-"));
  const g = git(dir, ["init"]);
  if (g.code !== 0) return undefined;
  git(dir, ["config", "user.email", "probe@example.invalid"]);
  git(dir, ["config", "user.name", "probe"]);
  // 先放一个真源码文件并提交，让仓库有 HEAD（否则 status 语义怪）
  fs.writeFileSync(path.join(dir, "index.js"), "console.log(1);\n", "utf8");
  git(dir, ["add", "--", "index.js"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

console.log("── ① 前提确认：DEFAULT_IGNORE_LINES 真的非空，且含记忆文件 ──");
{
  const lines = defs.DEFAULT_IGNORE_LINES ?? [];
  ok("① 不是空数组（D288 已填）", lines.length > 0, `长度=${lines.length}`);
  ok("① 含 LEDGER.md", lines.includes("LEDGER.md"));
  ok("① 含 decisions/", lines.includes("decisions/"));
  ok("① 含 .dsh-ledger.json", lines.includes(".dsh-ledger.json"));
}

console.log("\n── ② 核心假设：`autoGitAdd: true` 时，记忆文件**到底有没有**被 stage ──");
{
  const dir = makeGitProject();
  if (dir === undefined) {
    console.log("  SKIP  git 不可用，无法验证（这不算通过，也不算失败）");
  } else {
    const r = await part4.defineInitTool().execute(
      {
        root: dir,
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_ledger-archive",
        logDir: "_ledger-log",
        decisionsDir: "decisions",
        initialActive: "# 台账\n",
        initialDecisions: "# 决策\n",
        autoGitAdd: true, // ★ 显式要它 stage
        gitignore: true,
        gitInit: false,
      },
      { agent: { session: { header: { id: "probe" } }, cwd: dir } },
    );
    ok("② init 返回 ok", r?.ok === true, JSON.stringify(r).slice(0, 300));

    const st = git(dir, ["status", "--porcelain"]);
    const staged = st.out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");

    console.log(`     git status --porcelain：${staged.length === 0 ? "(空)" : ""}`);
    for (const l of staged.slice(0, 20)) console.log(`       ${l}`);

    const memoryStaged = staged.filter((l) => /LEDGER\.md|DECISIONS\.md|decisions\/|_ledger-archive|_ledger-log|\.dsh-ledger\.json/.test(l));
    ok(
      "② ★★★ 记忆文件**没有**被暂存（ignore 挡住了）",
      memoryStaged.length === 0,
      memoryStaged.join(" | "),
    );

    // ★ 同时确认 .gitignore 确实写进去了，且确实能挡住
    const gi = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    ok("② .gitignore 里有 LEDGER.md 规则", /^LEDGER\.md$/m.test(gi));
    const chk = git(dir, ["check-ignore", "--", "LEDGER.md", "decisions", ".dsh-ledger.json"]);
    ok(
      "② git check-ignore 确认三类记忆路径都被忽略",
      chk.out.split("\n").filter((x) => x.trim() !== "").length >= 3,
      chk.out,
    );

    // ★★★ 关键：init 的回执里**有没有如实说"我没 stage 任何东西"**
    //
    //   ★★ 第一版这里是错的（尺子错，当场改）：正则写成 `"staged":\s*(\[[^\]]*\]|"[^"]*")`
    //     —— 只匹配数组与字符串，而实际值是**布尔** `true`，所以永远报"(没有 staged 字段)"。
    //     这正是本项目纪律第 3 条：**取不到值先怀疑取法**。
    //   ⇒ 现在直接读对象，不猜形状（纪律 16：先 dump 再聚合）。
    ok("② 回执里真的有 staged 字段（不是 undefined）", r?.staged !== undefined, JSON.stringify(r?.staged));

    // ★★★★ **核心断言**：回执必须能回答「成功的是哪些」，不能只说"成功了"。
    //
    //   ★ 这里我第一版写错了，就地更正 —— 而且**错得有价值**：
    //     第一版断言"全部被挡住时 staged 不许为 true"。但它报了红，
    //     一查发现：`wanted` 里有 `.gitignore`，而它**不被自身规则挡住** ⇒ 它**真的进了暂存区**。
    //     ⇒ `staged: true` 在那里是**实话**，是**我的断言写错了**。
    //
    //   ★★ 但顺着它查出了一个**真问题**：回执只说 `staged: true`，
    //     不说"只成功了 `.gitignore` 一个" ⇒ 调用方读到会以为**记忆文件也进去了**。
    //     ⇒ 判据改成：**"成功"必须能回答「成功的是哪些」**（`stagedPaths`），否则它只是好看。
    const paths = Array.isArray(r?.stagedPaths) ? r.stagedPaths : [];
    const memoryPaths = paths.filter((p) => /LEDGER\.md|DECISIONS\.md|decisions|_ledger-archive|_ledger-log|\.dsh-ledger\.json/.test(p));
    ok(
      "② ★★★★ 记忆文件**没有**出现在 `stagedPaths` 里（回执不许让调用方误以为记忆进了暂存区）",
      memoryPaths.length === 0,
      `stagedPaths=${JSON.stringify(paths)}`,
    );
    if (r?.staged === true) {
      ok(
        "② ★★★ `staged: true` 时**必须**给出 `stagedPaths`（能回答「成功的是哪些」）",
        paths.length > 0,
        `staged=true 但 stagedPaths=${JSON.stringify(r?.stagedPaths)}`,
      );
      ok(
        "② ★★ 这次真的 stage 的只有 `.gitignore`（它是保护性配置，本来就该被追踪）",
        paths.length === 1 && /\.gitignore$/.test(paths[0]),
        JSON.stringify(paths),
      );
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n── ③ 反向对照：把 ignore 规则拿掉，同样的调用**必须**能看到 stage 成功 ──");
//
// ★★★ 这一条是整支探针的关键：**如果 ② 全绿而这里也全绿，那 ② 的绿是假绿**
//   （可能是 gitAdd 根本没被调用、或调用失败但被吞掉）。
//   判据：同一段代码在"没有 ignore 规则"时必须**真能**把文件加进暂存区。
//   能，才证明 ② 的红/绿来自 ignore 规则本身，而不是来自"这个功能压根没接上"。
{
  const dir = makeGitProject();
  if (dir === undefined) {
    console.log("  SKIP  git 不可用");
  } else {
    const r = await part4.defineInitTool().execute(
      {
        root: dir,
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_ledger-archive",
        logDir: "_ledger-log",
        initialActive: "# 台账\n",
        initialDecisions: "# 决策\n",
        autoGitAdd: true,
        gitignore: false, // ★ 不写 ignore 规则
        gitInit: false,
      },
      { agent: { session: { header: { id: "probe" } }, cwd: dir } },
    );
    ok("③ init 返回 ok", r?.ok === true, JSON.stringify(r).slice(0, 300));

    const st = git(dir, ["status", "--porcelain"]);
    const staged = st.out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    const memoryStaged = staged.filter((l) => /LEDGER\.md|DECISIONS\.md/.test(l));
    console.log(`     git status：${staged.length === 0 ? "(空)" : staged.join(" | ")}`);
    ok(
      "③ ★★ 没有 ignore 规则时，记忆文件**真的**被 stage 了 ⇒ ② 的绿不是假绿",
      memoryStaged.length > 0,
      "一个都没被 stage ⇒ 说明 autoGitAdd 这条路根本没接通，② 的结论不可信",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
