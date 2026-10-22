/**
 * 探针（V3 阶段 2 · 第三刀 D292）：**V3 项目的记忆目录到底有没有被 ignore 挡住？**
 *
 * 🔴 这条探针要暴露的，是**阶段 1 与阶段 2 之间真正的缝**：
 *
 *   `DEFAULT_IGNORE_LINES` 是一张**固定列表**，里面是 `LEDGER.md` / `decisions/` / `_ledger-archive/` …
 *   —— 那些是 **V2 形态**（记忆直接摊在项目根）。
 *
 *   而 V3 把记忆搬进了 **`<项目名>-ledger-memory/`**，那个目录名**带项目名**，
 *   **不可能写死在一张常量列表里**。
 *
 *   ⇒ 结果：一个 V3 项目建好之后，记忆全部住在 `xxx-ledger-memory/LEDGER.md` 等位置，
 *     而 gitignore 里**没有任何一条规则指向它** ⇒ **整个记忆目录完全不在保护范围内**。
 *
 * ★★★ 危险程度：这比 V2 时代更糟 —— V2 至少还有 19 条规则挡着；
 *   V3 项目如果照现状建出来，**记忆目录等于完全裸奔**，而回执会显示"已写入 ignore 规则"（假的安全感）。
 *
 * ★ 判据（先说清怎么算成立）：
 *   · **成立（缺口存在）**：V3 项目 init 之后，`git check-ignore` **没有**挡住记忆目录里的文件。
 *   · **不成立（已经好了）**：它被挡住了。
 *
 * 跑法：node tools/_probe-v3-ignore-v3dir.mjs
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

console.log("── ① 先看清事实：固定列表里到底有没有「带项目名的目录」这种动态规则 ──");
{
  const lines = defs.DEFAULT_IGNORE_LINES ?? [];
  // ★★ 第一版这里被注释行误伤了：`/ledger-memory/i` 命中了标题里那句
  //   `# ── dsh-ledger-memory：记忆文件默认不进版本库 ──` —— **注释不是规则**。
  //   ⇒ 纪律 2：判据的输入必须是「被测对象自己」（真规则），不是描述它的文字。
  const rules = lines.filter((l) => l !== "" && !l.trim().startsWith("#"));
  const looksV3 = rules.filter((l) => /ledger-memory/i.test(l));
  ok(
    "① 真规则里**没有** `*-ledger-memory/` 这类动态条目（缺口前提成立）",
    looksV3.length === 0,
    `意外发现：${looksV3.join(" | ")}`,
  );
  console.log(`     真正的规则条目（${rules.length} 条）：${rules.join(" ")}`);
}

console.log("\n── ② 核心：建一个 V3 项目，看记忆目录有没有被 ignore 挡住 ──");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3ign-"));
  if (git(dir, ["init"]).code !== 0) {
    console.log("  SKIP  git 不可用");
  } else {
    git(dir, ["config", "user.email", "probe@example.invalid"]);
    git(dir, ["config", "user.name", "probe"]);
    fs.writeFileSync(path.join(dir, "index.js"), "console.log(1);\n", "utf8");
    git(dir, ["add", "--", "index.js"]);
    git(dir, ["commit", "-m", "init"]);

    const memDir = `${path.basename(dir)}-ledger-memory`;
    const r = await part4.defineInitTool().execute(
      {
        root: dir,
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_ledger-archive",
        logDir: "_ledger-log",
        decisionsDir: "decisions",
        memoryRoot: memDir,
        initialActive: "# 台账\n",
        initialDecisions: "# 决策\n",
        gitignore: true,
        gitInit: false,
      },
      { agent: { session: { header: { id: "probe" } }, cwd: dir } },
    );
    ok("② init 成功", r?.ok === true, JSON.stringify(r).slice(0, 300));

    const memAbs = path.join(dir, memDir);
    ok("② 记忆目录真的建出来了", fs.existsSync(memAbs), memAbs);
    ok("② 记忆台账在目录里", fs.existsSync(path.join(memAbs, "LEDGER.md")));

    // ★★★ 核心：git 认不认它被忽略
    const chk = git(dir, ["check-ignore", "--", `${memDir}/LEDGER.md`, `${memDir}/decisions`]);
    const ignored = chk.out.split("\n").filter((x) => x.trim() !== "");
    ok(
      "② ★★★ V3 记忆目录里的文件**被 git ignore 挡住**（阶段 1+2 之间那道缝）",
      ignored.length >= 2,
      `check-ignore 只挡到 ${ignored.length} 条：${chk.out || "(空)"}`,
    );

    // ★ 顺带：git status 里能不能看见记忆文件（能看见 = 裸奔）
    const st = git(dir, ["status", "--porcelain", "--untracked-files=all"]);
    const visible = st.out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes(memDir));
    ok(
      "② ★★ `git status` 里**看不见**记忆文件（看不见才说明被挡住了）",
      visible.length === 0,
      visible.slice(0, 8).join(" | "),
    );

    // ═══════════════════════════════════════════════════════════════════════
    // ③ ★★★★★ **真正该验的那条**：逐个位置点名，不许靠"恰好同名"蒙对
    //
    //   ★ 我一开始的判断是「V3 目录没被规则覆盖」——**实测推翻了它**：
    //     `.gitignore` 里的 `LEDGER.md` 这种**无斜杠模式是递归的**，
    //     会匹配**任意层级**下的同名文件 ⇒ V3 子目录里的 LEDGER.md 恰好被挡住。
    //     （`git check-ignore -v` 的输出证明了这一点：`.gitignore:1:LEDGER.md`）
    //
    //   ★★ 但"恰好被挡住"不等于"设计上安全"。必须验的是：
    //     **记忆目录里每一类东西都被挡住**，而不是只有那些与 V2 同名的。
    //     特别要验**不会与 V2 同名**的那些：胶囊、分流、日志分片、审计流水。
    // ═══════════════════════════════════════════════════════════════════════
    const spots = [
      ["台账", `${memDir}/LEDGER.md`],
      ["决策卡", `${memDir}/decisions/D1.md`],
      ["归档", `${memDir}/_ledger-archive/2026-10/week3/x.md`],
      ["日志（分片名，V3 才有）", `${memDir}/_ledger-log/2026-10/week3/L1-turns-002.md`],
      ["胶囊（V3 才有）", `${memDir}/_ledger-log/2026-10/week3/capsules/2026-10-21-120000-abcd.md`],
      ["分流（V3 才有）", `${memDir}/_stash/2026-10/week3/2026-10-21-120000-abcd.md`],
      ["交接单", `${memDir}/_handoff/2026-10-21-1200-x.md`],
      ["清单", `${memDir}/.dsh-ledger.json`],
      ["目标树", `${memDir}/GOALS.md`],
      ["原则", `${memDir}/PRINCIPLES.md`],
      ["流水", `${memDir}/JOURNAL.md`],
      ["日志目录本身", `${memDir}/_ledger-log`],
    ];
    const notIgnored = [];
    for (const [label, rel] of spots) {
      const c = git(dir, ["check-ignore", "--", rel]);
      if (!c.out.split("\n").some((x) => x.trim() === rel)) notIgnored.push(`${label}(${rel})`);
    }
    ok(
      "③ ★★★★ 记忆目录里**每一类**都被挡住（含 V3 才有的胶囊/分流/日志分片）",
      notIgnored.length === 0,
      `没被挡住的：${notIgnored.join(" · ")}`,
    );
    console.log(`     逐项点名 ${spots.length} 处，未被挡住 ${notIgnored.length} 处`);

    // ═══════════════════════════════════════════════════════════════════════
    // ④ ★★★★★ **按语义的规则必须存在，且能挡住任意文件名**
    //
    //   ③ 全绿**不足以证明安全** —— 它是靠"记忆目录里的文件恰好与 V2 同名"撑着的。
    //   ⇒ 这一条要验的是：**即便文件名与 V2 完全不同，也必须被挡住**。
    //     这是"设计上正确"与"恰好正确"的分界。
    // ═══════════════════════════════════════════════════════════════════════
    const gi = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    const wantRule = `/${memDir}/`;
    ok(
      "④ ★★★★ `.gitignore` 里出现了**按语义**的目录规则 `/<记忆目录>/`",
      gi.split("\n").some((l) => l.trim() === wantRule),
      `期望 ${wantRule}；实际含 ledger-memory 的行：${gi.split("\n").filter((l) => l.includes("ledger-memory")).join(" | ") || "(无)"}`,
    );

    // ★ 关键：**一个与 V2 完全不同的文件名**也必须被挡住。
    //   若只靠"同名递归匹配"，下面这个一定会漏 —— 而漏了不报错，只是不再被挡。
    const alien = `${memDir}/_extensions/whatever-不会与V2同名.json`;
    const cAlien = git(dir, ["check-ignore", "--", alien]);
    ok(
      "④ ★★★★ **任意新文件名**也被挡住（不依赖「与 V2 同名」这个巧合）",
      cAlien.out.split("\n").some((x) => x.trim() === alien),
      `check-ignore 没挡住：${alien}`,
    );

    // ★ 反向：**项目根**上的同名目录不许被这条规则误伤（前导 `/` 的意义）
    //   —— 只锚项目根下那个记忆目录，别把用户自己 `src/ledger-memory/` 也挡了。
    const otherDir = path.join(dir, "src", memDir);
    fs.mkdirSync(otherDir, { recursive: true });
    const otherRel = `src/${memDir}/keep.js`;
    fs.writeFileSync(path.join(dir, "src", memDir, "keep.js"), "x", "utf8");
    const cOther = git(dir, ["check-ignore", "--", otherRel]);
    ok(
      "④ ★★ 前导 `/` 生效：别的子目录下的同名目录**不被误伤**",
      !cOther.out.split("\n").some((x) => x.trim() === otherRel),
      `被误伤了：${otherRel}`,
    );

    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
