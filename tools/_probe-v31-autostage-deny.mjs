#!/usr/bin/env node
/**
 * 探针：V3 任务书 §3.1 —— **自动暂存必须默认关闭，且不能被旧配置重新打开**。
 *
 * ★★★ 这个探针守的是任务书里两句逐字要求：
 *   ① *"第三代默认关闭自动暂存。"*
 *   ② *"私有记忆模式下，不能通过第二代遗留的 `autoGitAdd: true` 意外重新开启自动暂存。"*
 *
 * ★ 为什么必须**真建仓库**来测（不能只测函数返回值）：
 *   这条规矩的失效形态是"**文件真的进了暂存区**"。只断言 `shouldAutoStage().allow === false`
 *   只能证明判据返回了对的值，证明不了"没有别的地方绕过它去 stage"。
 *   ⇒ 所以这里在 %TEMP% 里建**真 git 仓库**，跑真 `gitAdd`，再用 `git status` 看**索引实况**。
 *   ★ 这正是本项目纪律 8 的反面用法：夹具要**尽量接近真实**，结论才可信。
 *
 * ★ 用法：node tools/_probe-v31-autostage-deny.mjs
 *   退出码 0 = 全过。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const { shouldAutoStage, gitAdd, inspect } = await import(
  "file:///" + path.join(ROOT, "lib", "part2.js").replace(/\\/g, "/")
);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log("  PASS  " + name);
  } else {
    fail += 1;
    console.log("  FAIL  " + name + (detail === undefined ? "" : "  —— " + detail));
  }
};

const sh = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** 建一个真 git 仓库；manifest 由调用方给。 */
function makeRepo(tag, manifest, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-stage-" + tag + "-"));
  sh(dir, "init", "-q");
  sh(dir, "config", "user.email", "t@example.invalid");
  sh(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, ".dsh-ledger.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const [rel, body] of Object.entries(files || {})) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  // 先提交一次，让仓库有 HEAD（否则 git status 全是 untracked，看不出"暂存"与否）
  sh(dir, "add", "--", ".dsh-ledger.json");
  sh(dir, "commit", "-q", "-m", "base");
  return dir;
}

const stagedList = (dir) =>
  sh(dir, "diff", "--cached", "--name-only")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

console.log("═══ ① V3 项目：清单里写 autoGitAdd:true —— 必须仍然拒绝 ═══");
{
  const dir = makeRepo("v3", {
    version: 1,
    protocolVersion: 3,
    active: "LEDGER.md",
    archiveDir: "_ledger-archive",
    memoryRoot: "proj-ledger-memory",
    // ★★★ 这就是 §3.1 第二条要堵的东西：二代遗留的 true
    autoGitAdd: true,
  }, {
    "proj-ledger-memory/LEDGER.md": "# 台账\n- 秘密内容\n",
    "proj-ledger-memory/decisions/D1.md": "# D1\n",
  });

  const info = inspect(dir);
  const g = shouldAutoStage(info);
  ok("V3 + autoGitAdd:true ⇒ shouldAutoStage 必须拒绝", g.allow === false, JSON.stringify(g));
  ok("V3 拒绝理由必须点明「清单不能重新开启」", /autoGitAdd/.test(g.reason) && /不能重新开启/.test(g.reason), g.reason);
  ok("V3 被标记为 v3:true", g.v3 === true);

  // 真跑 gitAdd：记忆路径必须被**拒绝**（不是"被 ignore 挡住"，是 §3.1 拒绝）
  const r = gitAdd(dir, ["proj-ledger-memory/LEDGER.md"]);
  ok("gitAdd(记忆路径) 必须 ok:false", r.ok === false, JSON.stringify(r));
  ok("gitAdd 必须把它列进 refused", Array.isArray(r.refused) && r.refused.length === 1, JSON.stringify(r.refused));

  const st = stagedList(dir);
  ok("★ 索引实况：暂存区里必须**一个记忆文件都没有**", st.length === 0, "staged=" + JSON.stringify(st));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n═══ ② V2 项目（记忆就在项目根）：保持原有行为，不许被误伤 ═══");
{
  const dir = makeRepo("v2on", {
    version: 1,
    protocolVersion: 2,
    active: "LEDGER.md",
    archiveDir: "_ledger-archive",
    autoGitAdd: true,
  }, { "LEDGER.md": "# 台账\n" });

  const info = inspect(dir);
  const g = shouldAutoStage(info);
  ok("V2 + autoGitAdd:true ⇒ 允许（不改变既有项目行为）", g.allow === true, JSON.stringify(g));
  ok("V2 不应被标成 v3", g.v3 === undefined);

  const r = gitAdd(dir, ["LEDGER.md"]);
  ok("V2 的 gitAdd 不会把 LEDGER.md 当「私有记忆」拒绝", !Array.isArray(r.refused), JSON.stringify(r.refused));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n═══ ③ V2 项目 + autoGitAdd:false ⇒ 拒绝（旧开关仍然有效）═══");
{
  const dir = makeRepo("v2off", {
    version: 1,
    protocolVersion: 2,
    active: "LEDGER.md",
    archiveDir: "_ledger-archive",
    autoGitAdd: false,
  }, { "LEDGER.md": "# 台账\n" });
  const g = shouldAutoStage(inspect(dir));
  ok("V2 + autoGitAdd:false ⇒ 拒绝", g.allow === false, JSON.stringify(g));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n═══ ④ 不是 git 仓库 ⇒ 拒绝（没有 .git 就不该尝试 stage）═══");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-stage-nogit-"));
  fs.writeFileSync(
    path.join(dir, ".dsh-ledger.json"),
    JSON.stringify({ version: 1, active: "LEDGER.md", archiveDir: "_ledger-archive", autoGitAdd: true }) + "\n"
  );
  const g = shouldAutoStage(inspect(dir));
  ok("没有 .git ⇒ 拒绝，理由说「不是 git 仓库」", g.allow === false && /git 仓库/.test(g.reason), JSON.stringify(g));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n═══ ⑤ 混合路径：只加非记忆的，记忆的如实拒绝 ═══");
{
  const dir = makeRepo("mix", {
    version: 1,
    protocolVersion: 3,
    active: "LEDGER.md",
    archiveDir: "_ledger-archive",
    memoryRoot: "proj-ledger-memory",
    autoGitAdd: true,
  }, {
    "proj-ledger-memory/LEDGER.md": "# 台账\n",
    "normal.txt": "hello\n",
  });
  const r = gitAdd(dir, ["proj-ledger-memory/LEDGER.md", "normal.txt"]);
  ok("混合调用 ⇒ 记忆的那条进 refused", Array.isArray(r.refused) && r.refused.includes("proj-ledger-memory/LEDGER.md"), JSON.stringify(r.refused));
  const st = stagedList(dir);
  ok("★ 索引实况：只有 normal.txt 被暂存，记忆文件没有", st.length === 1 && st[0] === "normal.txt", "staged=" + JSON.stringify(st));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n" + "═".repeat(60));
console.log(`结果：PASS ${pass} · FAIL ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
