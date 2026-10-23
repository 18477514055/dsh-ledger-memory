#!/usr/bin/env node
/**
 * 反向验证 **V2 → V3 迁移的三个安全收口**（审计员 010 阶段一 / D301）。
 *
 * ★★★ 要验的三条（每一条都对应 010 报的一个真缺口，一条都不能少）：
 *   ① `mergeGitignore` —— 迁移后记忆子目录**真的**被 Git 忽略（不是"写了规则"，是 `git check-ignore` 命中）；
 *   ② `SECURITY.md` —— 迁移后记忆目录里**真的有**这份文件，且**幂等**（再迁一次不覆盖）；
 *   ③ `detectTrackedMemory` —— 旧记忆**已被 Git 跟踪**时，回执里**必须**出现 `trackedWarning`（不是静默放行）。
 *   ④ 附带：清单里的 `autoGitAdd` 迁移后为 `false`。
 *
 * ★★★ 判据（纪律 10：看不见红的断言不是断言）：
 *   每条都要有一个**能变红**的对照组 —— 这里用「迁移前」的状态当对照：
 *     迁移前 `check-ignore` **不命中**、`SECURITY.md` **不存在**、`autoGitAdd` 为 `true`。
 *     若迁移前就已经是"想要的样子"，那这条验证什么都没证明。
 *
 * ★ 全程在 `os.tmpdir()` 的一次性目录里跑（**含真 `git init`**），不碰真实工作区。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const PART7 = path.join(PROJECT, "lib", "part7.js");
const { migrateToV3 } = await import(pathToFileURL(PART7).href);

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail === undefined ? "" : `  —— ${detail}`}`);
};

const run = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

/** 造一个 V2 夹具（有真 git 仓库、有旧记忆文件、autoGitAdd:true） */
function makeV2Fixture({ trackMemory }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-v3mig-"));
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify(
      {
        version: 1,
        protocolVersion: 2,
        active: "LEDGER.md",
        archiveDir: "_ledger-archive",
        logDir: "_ledger-log",
        autoGitAdd: true,
        decisionsDir: "decisions",
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n- 旧内容\n", "utf8");
  fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });
  fs.writeFileSync(path.join(root, "_ledger-archive", "old.md"), "# 旧归档\n", "utf8");
  fs.mkdirSync(path.join(root, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(root, "decisions", "D1.md"), "# D1\n", "utf8");
  fs.mkdirSync(path.join(root, "_ledger-log"), { recursive: true });
  fs.writeFileSync(path.join(root, "_ledger-log", "L1.md"), "# L1\n", "utf8");
  // 源码文件（不该被忽略，也不该被当记忆）
  fs.writeFileSync(path.join(root, "index.js"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, ".gitignore"), "# 用户自己的规则\nnode_modules/\n", "utf8");

  run(root, ["init", "-q"]);
  run(root, ["config", "user.email", "probe@local"]);
  run(root, ["config", "user.name", "probe"]);
  run(root, ["add", "--", "index.js", ".gitignore", ".dsh-ledger.json"]);
  if (trackMemory) {
    // ★ 刻意把记忆**已经 add 进索引**，模拟 010 说的"已追踪"情形
    run(root, ["add", "-f", "--", "LEDGER.md", "decisions", "_ledger-archive", "_ledger-log"]);
    run(root, ["commit", "-q", "-m", "旧提交：记忆被带进去了"]);
  } else {
    run(root, ["commit", "-q", "-m", "只有源码"]);
  }
  return root;
}

console.log("═".repeat(76));
console.log("反向验证：V2 → V3 迁移的三个安全收口（D301 / 010 阶段一）");
console.log("═".repeat(76));

// ═══ 夹具 A：旧记忆**没**被跟踪 ⇒ 正常迁移 ═══════════════════════════════
console.log("\n【夹具 A】旧记忆未被 Git 跟踪（正常路径）");
const A = makeV2Fixture({ trackMemory: false });
const memDirA = path.join(A, "ledger-v3mig", "");
const manifestA = JSON.parse(fs.readFileSync(path.join(A, ".dsh-ledger.json"), "utf8"));
ok("A0 迁移前：autoGitAdd === true（对照组的起点）", manifestA.autoGitAdd === true, String(manifestA.autoGitAdd));
const preIgnore = run(A, ["check-ignore", "-q", "LEDGER.md"]);
ok("A0 迁移前：LEDGER.md **不**被忽略（对照组）", preIgnore.code !== 0, `check-ignore exit=${preIgnore.code}`);
ok("A0 迁移前：记忆目录里没有 SECURITY.md（对照组）", !fs.existsSync(path.join(A, "SECURITY.md")), "");

const rA = migrateToV3(A, { apply: true });
const memNameA = rA.targetDir;
const memAbsA = path.join(A, memNameA);
ok("A1 迁移成功且清单已改", rA.ok === true && rA.manifestUpdated === true, `ok=${rA.ok} target=${memNameA}`);
ok("A2 回执里带 gitignore 结果（做了就得看得见）", rA.gitignore !== undefined, `added=${(rA.gitignore?.added ?? []).length} 条`);
// ★★★ A3 的判据必须用**一个不在 DEFAULT_IGNORE_LINES 里的文件名**：
//   🔴 我第一版拿 `${memName}/LEDGER.md` 当判据 —— 那是**假绿**：
//     `.gitignore` 里有一条裸 `LEDGER.md`（无斜杠 ⇒ 任意深度匹配），
//     所以即使**完全不加** `/memoryRoot/` 那条规则，这个路径**照样命中**。
//     ⇒ 判据要问的是"**整目录**被挡"，不是"已知名字被挡"。
//       ★ 用 `SECURITY.md` 与一个随机新名字，两者都不在任何忽略表里。
const probeName = `__probe-not-in-ignore-list-${process.pid}.md`;
fs.writeFileSync(path.join(memAbsA, probeName), "probe\n", "utf8");
ok(
  "A3 记忆**整目录**被忽略（用不在忽略表里的新文件名验，才不是假绿）",
  run(A, ["check-ignore", "-q", `${memNameA}/${probeName}`]).code === 0 &&
    run(A, ["check-ignore", "-q", `${memNameA}/SECURITY.md`]).code === 0,
  `${probeName} + SECURITY.md`
);
ok(
  "A3b 反向对照：项目根的随机新文件**不该**被忽略",
  run(A, ["check-ignore", "-q", `root-${probeName}`]).code !== 0,
  "根上同名文件不命中 ⇒ 说明 A3 测的是目录规则，不是通配误伤"
);
ok(
  "A4 记忆目录里**真的**有 SECURITY.md 且非空",
  fs.existsSync(path.join(memAbsA, "SECURITY.md")) && fs.statSync(path.join(memAbsA, "SECURITY.md")).size > 500,
  `size=${fs.existsSync(path.join(memAbsA, "SECURITY.md")) ? fs.statSync(path.join(memAbsA, "SECURITY.md")).size : 0}`
);
ok("A5 回执里 securityMdWritten === true", rA.securityMdWritten === true, String(rA.securityMdWritten));
const manifestA2 = JSON.parse(fs.readFileSync(path.join(A, ".dsh-ledger.json"), "utf8"));
ok("A6 迁移后 autoGitAdd 落成 false", manifestA2.autoGitAdd === false, String(manifestA2.autoGitAdd));
ok("A7 迁移后 memoryRoot 已登记", manifestA2.memoryRoot === memNameA, String(manifestA2.memoryRoot));
ok(
  "A8 用户自己的 .gitignore 规则**没被覆盖**",
  fs.readFileSync(path.join(A, ".gitignore"), "utf8").includes("node_modules/"),
  ""
);
ok(
  "A9 记忆文件已搬进子目录（旧位置已清空）",
  fs.existsSync(path.join(memAbsA, "LEDGER.md")) && !fs.existsSync(path.join(A, "LEDGER.md")),
  ""
);

// 幂等：再迁一次（此时已是 V3 ⇒ 早退），SECURITY.md 不应被覆盖
const secBefore = fs.readFileSync(path.join(memAbsA, "SECURITY.md"), "utf8");
const rA2 = migrateToV3(A, { apply: true });
ok("A10 已 V3 的项目再迁 ⇒ 明确早退（不重复搬）", rA2.ok === false && rA2.alreadyV3 === true, rA2.reason?.slice(0, 40));
ok("A11 SECURITY.md 未被二次覆盖（幂等）", fs.readFileSync(path.join(memAbsA, "SECURITY.md"), "utf8") === secBefore, "");

// ═══ 夹具 B：旧记忆**已被** Git 跟踪 ⇒ 必须报警 ═════════════════════════
console.log("\n【夹具 B】旧记忆已被 Git 跟踪（010 说的「静默放行」情形）");
const B = makeV2Fixture({ trackMemory: true });
const rB0 = migrateToV3(B, {}); // 干跑
ok(
  "B1 干跑阶段**就把风险摊开**（不等到 apply 才说）",
  rB0.dryRun === true && rB0.trackedWarning !== undefined,
  rB0.trackedWarning === undefined ? "（没有 trackedWarning ⇒ 干跑看不见风险）" : `count=${rB0.trackedWarning.count}`
);
const rB = migrateToV3(B, { apply: true });
ok("B2 迁移仍然成功（如实报警**不阻断**迁移）", rB.ok === true, `ok=${rB.ok}`);
ok(
  "B3 apply 回执里有 trackedWarning（不再静默放行）",
  rB.trackedWarning !== undefined && rB.trackedWarning.count > 0,
  rB.trackedWarning === undefined ? "（缺失！）" : `count=${rB.trackedWarning.count}`
);
ok(
  "B4 报警里带处理方案（只说「有风险」等于没说）",
  typeof rB.trackedWarning?.advice === "string" && rB.trackedWarning.advice.length > 20,
  ""
);

const bad = results.filter((r) => r.pass !== true).length;
console.log("\n" + "─".repeat(76));
console.log(`${results.length - bad} PASS / ${bad} FAIL`);
console.log("─".repeat(76));
process.exit(bad === 0 ? 0 : 1);
