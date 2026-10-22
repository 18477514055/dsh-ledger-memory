/**
 * 端到端探针（D288）：**`ledger_init` 建出来的项目，记忆文件会不会被 git 收进去？**
 *
 * 🔴 这是用户 2026-10-21 报的那次真实事故的可执行版本：
 *   `06-DSH-mobile`（**public** 仓库）把 `decisions/` `lessons/` `goals/`
 *   `PRINCIPLES.md` `LESSONS.md` **真的提交并推送出去了**。
 *
 * ★ 本探针**真建一个 git 仓库**、真调 `ledger_init`、真跑 `git ls-files`，
 *   因为"文件里写了规则" ≠ "规则生效"（本项目 §0.2 那条纪律）。
 *
 * ★ 判据分三层：
 *   ① `ledger_init` 写出的 `.gitignore` 里**真的**有那几条规则（不是空壳标题）
 *   ② `git ls-files`（= 真被追踪的）里**一个记忆文件都没有**
 *   ③ `ledger_write` / `ledger_archive` 之后**仍然**没有（写操作会 git add）
 *
 * 跑法：node tools/_probe-gitignore-leak.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");

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

const GIT = process.env.DSH_GIT || "git";
const gitIn = (dir, args) =>
  execFileSync(GIT, ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const part4 = await import(new URL("./part4.js", `file://${LIB.replace(/\\/g, "/")}/`).href);
const part1 = await import(new URL("./part1.js", `file://${LIB.replace(/\\/g, "/")}/`).href);
const defs = await import(new URL("./defs.js", `file://${LIB.replace(/\\/g, "/")}/`).href);

defs.setActiveSettings({ ...part1.settingDefaults() });

// ── 造一个全新的空项目 + 真 git 仓库 ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-gitleak-"));
gitIn(dir, ["init", "-q"]);
gitIn(dir, ["config", "user.email", "probe@local"]);
gitIn(dir, ["config", "user.name", "probe"]);
fs.writeFileSync(path.join(dir, "README.md"), "# demo\n", "utf8");

console.log("── ① 真调 ledger_init（走 tool 层，与模型实际调用同一条路）──");
let initResult;
{
  // ★ 不用内部函数 —— `ledger_init` 的实现写在 `execute` 里（没有独立导出）。
  //   ⇒ 这里走**模型真正走的那条路**：拿 tool 定义 → 调 execute。
  //   ★ 这比调内部函数更可信：它连参数校验、默认值、gitignore 合并顺序一起验了。
  const tool = part4.defineInitTool();
  ok("① 拿到了 ledger_init 工具定义", tool.name === "ledger_init");

  const exec = {
    agent: { session: { header: { id: "probe-gitignore", cwd: dir } } },
    callId: "c1",
  };
  initResult = await tool.execute(
    {
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_ledger-archive",
      // ★ 第二代完整形态：卡片目录 + 所有记忆文件都建出来
      decisionsDir: "decisions",
      lessonsDir: "lessons",
      goalsDir: "goals",
      journal: "JOURNAL.md",
      principles: "PRINCIPLES.md",
      lessons: "LESSONS.md",
      goals: "GOALS.md",
      gitInit: false, // 仓库我们已经建好了
    },
    exec,
  );
  ok("① ledger_init 成功", initResult.ok === true, JSON.stringify(initResult).slice(0, 300));
}

console.log("\n── ② .gitignore 里**真的有**规则（不是空壳标题）──");
{
  const gi = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  const lines = gi.split(/\r?\n/).map((l) => l.trim());
  ok("② 文件存在且非空", lines.filter((l) => l !== "").length > 3, `只有 ${lines.length} 行`);
  for (const must of [
    "LEDGER.md",
    "DECISIONS.md",
    "JOURNAL.md",
    "PRINCIPLES.md",
    "LESSONS.md",
    "GOALS.md",
    ".dsh-ledger.json",
    "decisions/",
    "lessons/",
    "goals/",
    "_ledger-archive/",
    "_ledger-log/",
  ]) {
    ok(`② .gitignore 含 \`${must}\``, lines.includes(must));
  }
  // ★ 反向：文件里不许只有一行标题（那就是事故当时的形态）
  ok(
    "② 🔴 不是「只有一行标题」的空壳（事故当时的形态）",
    lines.filter((l) => l !== "" && !l.startsWith("#")).length > 5,
    `实际规则行数=${lines.filter((l) => l !== "" && !l.startsWith("#")).length}`,
  );
}

console.log("\n── ③ ★核心：git ls-files 里一个记忆文件都不许有 ──");
const lsFiles = () => gitIn(dir, ["ls-files"]).replace(/\r\n/g, "\n").split("\n").filter((l) => l !== "");
{
  const tracked = lsFiles();
  const leakPat =
    /^(LEDGER\.md|DECISIONS\.md|JOURNAL\.md|GOALS\.md|LESSONS\.md|PRINCIPLES\.md|\.dsh-ledger\.json)$|^(decisions|lessons|goals|_ledger-archive|_ledger-log|_stash|_handoff)\//;
  const leaked = tracked.filter((f) => leakPat.test(f));
  ok("③ 🔴 被追踪的文件里**没有**记忆文件", leaked.length === 0, `泄露了: ${leaked.join(", ")}`);
  // ★ 夹具自检：确实建出了那些文件（否则上面那条是空的、等于没测）
  const onDisk = [
    "LEDGER.md",
    "decisions",
    "lessons",
    "goals",
  ].filter((p) => fs.existsSync(path.join(dir, p)));
  ok("③ 夹具自检：磁盘上**确实**建出了记忆文件（否则上面那条是空转）", onDisk.length === 4, `只有 ${onDisk.join(",")}`);
  console.log(`        磁盘上有: ${onDisk.join(" / ")}`);
  console.log(`        git 追踪了 ${tracked.length} 个文件: ${tracked.slice(0, 8).join(", ")}`);
}

console.log("\n── ④ 写台账之后仍然不泄露（ledger_write 会 git add）──");
{
  const r = part4.writeLedger(dir, { target: "active", mode: "append", content: "- 探针写入的内容\n" });
  ok("④ ledger_write 成功", r.ok === true, JSON.stringify(r).slice(0, 200));
  const tracked = lsFiles();
  const leaked = tracked.filter((f) => /^LEDGER\.md$/.test(f));
  ok("④ 🔴 写完之后 LEDGER.md 仍未被追踪", leaked.length === 0, `泄露: ${leaked.join(",")}`);
  // ★ 回执必须说清"挡住了哪些"，不能默默吞掉
  console.log(`        staged 回执: ${JSON.stringify(r.staged)}`);
}

console.log("\n── ⑤ 归档之后仍然不泄露（ledger_archive 也 git add）──");
{
  const live = fs.readFileSync(path.join(dir, "LEDGER.md"), "utf8");
  // 取一行真实存在的正文来归档（新契约要求 entries 是原文里真实连续的一段）
  const cand = live
    .split(/\r?\n/)
    .find((l) => /^\s*[-*+]\s+\S/.test(l));
  ok("⑤ 夹具自检：台账里有一行可归档的真实内容", cand !== undefined);
  if (cand !== undefined) {
    const r = part4.archiveLedger(dir, {
      entries: `${cand}\n`,
      newActive: live.replace(`${cand}\n`, ""),
    });
    ok("⑤ ledger_archive 成功", r.ok === true, JSON.stringify(r).slice(0, 200));
    const tracked = lsFiles();
    const leaked = tracked.filter((f) => /^LEDGER\.md$|^_ledger-archive\//.test(f));
    ok("⑤ 🔴 归档之后台账与归档目录仍未被追踪", leaked.length === 0, `泄露: ${leaked.join(",")}`);
  }
}

console.log("\n── ⑥ 反向：用户**显式**要公开时，规则能被删掉（我们不锁死）──");
{
  // 用户把 LEDGER.md 那行从 .gitignore 删掉 ⇒ 它就该能被追踪
  const giPath = path.join(dir, ".gitignore");
  const lines = fs.readFileSync(giPath, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "LEDGER.md");
  fs.writeFileSync(giPath, lines.join("\n"), "utf8");
  gitIn(dir, ["add", "--", "LEDGER.md"]);
  const tracked = lsFiles();
  ok("⑥ 用户删掉规则后，LEDGER.md **可以**入库（默认挡 ≠ 永久锁死）", tracked.includes("LEDGER.md"));
}

// 清理
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
