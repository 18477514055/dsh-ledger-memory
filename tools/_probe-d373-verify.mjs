#!/usr/bin/env node
/**
 * D373 取证器：逐条核实 `docs/3.8flash实地跑/004.md` 的 5 项发现（F-01 ~ F-05；F-06 是架构分析）。
 *
 * ★★★ 断言一律写成「**缺陷不应该存在**」⇒ 跑在**未修**代码上会 FAIL，跑在**已修**代码上才全绿。
 *
 * ★★★★ 本轮的**核心判据**（继承 D372）：**「报告说某处漏判」≠「那处真的能被走到」。**
 *   每一项都要回答两个问题：
 *     ① 修前代码**真的**会出错吗？（可达性）
 *     ② 补丁那行**真的**改变了什么吗？（是不是 no-op / 冗余）
 *   答不上第 ② 问的，只能记 KNOWN 或判定为「报告虚报」，**绝不写 PASS 冒充修好了**。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let pass = 0;
let fail = 0;
const rows = [];
const ok = (title, cond, detail) => {
  if (cond) { pass += 1; rows.push(`PASS  ${title}${detail === undefined ? "" : ` — ${String(detail).slice(0, 220)}`}`); }
  else { fail += 1; rows.push(`FAIL  ${title}${detail === undefined ? "" : ` — ${String(detail).slice(0, 220)}`}`); }
};
const known = (title, detail) => { rows.push(`KNOWN ${title}${detail === undefined ? "" : ` — ${String(detail).slice(0, 220)}`}`); };
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), tag));

const GIT = "C:\\Program Files\\Git\\cmd\\git.exe";
const git = (cwd, args, allowFail = false) => {
  try { return { ok: true, out: execFileSync(GIT, args, { cwd, encoding: "utf8" }) }; }
  catch (e) { if (allowFail) return { ok: false, err: String(e?.stderr ?? e?.message ?? e).split("\n")[0] }; throw e; }
};

const fp = await import("../lib/fingerprint.js");
const defs = await import("../lib/defs.js");
const base = await import("../lib/base.js");
const part2 = await import("../lib/part2.js");
const part4 = await import("../lib/part4.js");
const initTool = await import("../lib/init-tool.js");
const execFor = (r, sid) => ({ agent: { session: { header: { id: sid, cwd: r } } } });

async function initProject(root, layout, sid) {
  await initTool.defineInitTool().execute(
    { root, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", layout },
    execFor(root, sid),
  );
  return part2.inspect(root);
}

// ═══════════════════════════════════════════════════════════════════
// F-01（P1）identityOfPath 单例比对不归一化前导 ./ ⇒ 单例被降级成 custom
// ═══════════════════════════════════════════════════════════════════
{
  const info = { memoryBase: "C:/repo/mem", activeRel: "./LEDGER.md" };
  const id = fp.identityOfPath(info, "C:/repo/mem/LEDGER.md");
  ok(
    "F-01a activeRel=./LEDGER.md 时 identityOfPath 仍识别为 active 单例（不是 custom）",
    id !== undefined && id.kind === "active" && id.key === "-",
    JSON.stringify(id),
  );

  // ★★★ 可达性：真项目里手改清单能不能造出来（不能只凭构造对象）
  const root = tmp("f01-");
  try {
    const info2 = await initProject(root, "v3", "s-d373-f01");
    const manPath = path.join(root, ".dsh-ledger.json");
    const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
    man.active = "./LEDGER.md";
    fs.writeFileSync(manPath, JSON.stringify(man, null, 2) + "\n", "utf8");
    const info3 = part2.inspect(root);
    const mb = info3.memoryBase ?? info3.memBase;
    const ledAbs = path.join(mb, "LEDGER.md");
    const id3 = fp.identityOfPath(info3, ledAbs);
    ok(
      "F-01b ★可达性：真项目里把清单改成 active=./LEDGER.md 后，identityOfPath 仍认它是 active",
      id3 !== undefined && id3.kind === "active",
      `activeRel=${JSON.stringify(info3.activeRel)} → ${JSON.stringify(id3)}`,
    );
    // ★ 反向：正常形态（不带 ./）必须仍然认对
    const man2 = JSON.parse(fs.readFileSync(manPath, "utf8"));
    man2.active = "LEDGER.md";
    fs.writeFileSync(manPath, JSON.stringify(man2, null, 2) + "\n", "utf8");
    const info4 = part2.inspect(root);
    const id4 = fp.identityOfPath(info4, path.join(info4.memoryBase ?? info4.memBase, "LEDGER.md"));
    ok("F-01c ★反向：不带 ./ 的正常形态仍认 active（放宽没放过头）", id4 !== undefined && id4.kind === "active", JSON.stringify(id4));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════
// F-02（P1）DEFAULT_IGNORE_LINES 遗漏 extensions
// ═══════════════════════════════════════════════════════════════════
{
  ok("F-02a DEFAULT_IGNORE_LINES 含 /extensions/", defs.DEFAULT_IGNORE_LINES.includes("/extensions/"), JSON.stringify(defs.DEFAULT_IGNORE_LINES.slice(-6)));
  ok("F-02b DEFAULT_IGNORE_LINES 含裸 extensions（单文件形态兜底）", defs.DEFAULT_IGNORE_LINES.includes("extensions"), "");

  // ★★★ 可达性：真跑 flat 布局的 init，看它写进 .gitignore 的到底有没有 extensions
  const root = tmp("f02-");
  try {
    await initProject(root, "flat", "s-d373-f02");
    const gi = path.join(root, ".gitignore");
    const text = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
    ok("F-02c ★可达性：flat 布局 init 真的把 /extensions/ 写进了 .gitignore", text.includes("/extensions/"), text.split("\n").slice(-6).join(" | "));
    ok("F-02d ★可达性：flat 布局 init 真的把裸 extensions 写进了 .gitignore", /^extensions$/m.test(text), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════
// F-03（P2）log-collector 暂存路径缺 memoryRoot 前缀
//
// ★★★★★ 本项的判据必须分两层，否则会得出错误结论：
//   ① `toGitRel(root, abs)` 在 **V3** 下确实产出带前缀的路径（补丁改的是这个）
//   ② **但** V3 下 `shouldAutoStage().allow === false` ⇒ `gitAdd` 那一支**压根不执行**
//   ⇒ 报告描述的"V3 下 git add 报 pathspec 错"这条**路径走不到**。
//     补丁那行在 V3 下是**不可达分支里的防御性加固**（无害、有意义，但不是可达缺陷的修复）。
// ═══════════════════════════════════════════════════════════════════
{
  const lc = fs.readFileSync(path.join(process.cwd(), "lib", "log-collector.js"), "utf8");
  ok("F-03a log-collector 把 written 的路径过一遍 toGitRel（不再是裸 fileRel）", lc.includes("written.push(toGitRel(b.root, abs))"), lc.split("\n").find((l) => l.includes("written.push")));

  ok("F-03b toGitRel 对 V3 记忆子目录文件产出带 memoryRoot 前缀的仓库相对路径", (() => {
    const r = base.toGitRel("C:/repo", "C:/repo/repo-ledger-memory/_ledger-log/a.md");
    return r === "repo-ledger-memory/_ledger-log/a.md";
  })(), JSON.stringify(base.toGitRel("C:/repo", "C:/repo/repo-ledger-memory/_ledger-log/a.md")));

  // ★★★ 可达性：V3 真 git 仓库里，那一支到底执行不执行
  const root = tmp("f03-");
  try {
    const info = await initProject(root, "v3", "s-d373-f03");
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "t@t.t"]);
    git(root, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(root, "README.md"), "# t\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "init"]);
    const info2 = part2.inspect(root);
    const stage = part2.shouldAutoStage(info2);
    // ★ 这一条**期望 allow === false** —— 它就是"F-03 走不到"的证明，所以它绿不代表修好了，
    //   而代表"报告描述的那条路不存在"。因此这一条结论写 KNOWN，不计入修复证据。
    known(
      "F-03c ★可达性判定：V3 真 git 仓库下 shouldAutoStage.allow 的值（false ⇒ 报告说的 git add 路径不可达）",
      `allow=${stage.allow} reason=${String(stage.reason).slice(0, 60)}`,
    );
    ok("F-03d V3 形态下 memBase 与 projectRoot 不同（这才让 toGitRel 有意义）",
      path.resolve(info2.memoryBase ?? info2.memBase) !== path.resolve(root), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════
// F-04（P2）card-ops 的 fingerprintMismatchOf 漏判「损坏」
//
// ★★★★★ 与 D372 的 F-05 同型：`readFingerprint3` 唯一的 corrupt 出口文案
//   恒含「自证位」⇒ 旧判据 `includes("自证位")` 本来就把「损坏」整类拦住了。
//   ⇒ 补丁那行是**冗余防御**，不是可达缺陷的修复。本条记 KNOWN。
// ═══════════════════════════════════════════════════════════════════
{
  const co = fs.readFileSync(path.join(process.cwd(), "lib", "card-ops.js"), "utf8");
  const hasCorrupt = co.includes('String(p.reason).includes("损坏")');
  ok("F-04a card-ops 的 fingerprintMismatchOf 已含「损坏」判定（结构与全库对齐）", hasCorrupt, "");

  const root = tmp("f04-");
  try {
    const decDir = path.join(root, "decisions");
    fs.mkdirSync(decDir, { recursive: true });
    fs.writeFileSync(
      path.join(decDir, "D100.md"),
      ["---", "dsh-fp-front: corrupt-not-a-real-fingerprint", "---", "# D100", "", "正文", ""].join("\n"),
      "utf8",
    );
    const cardOps = await import("../lib/card-ops.js");
    const info = { root, memBase: root, decisionsDir: "decisions", decisionsRel: "DECISIONS.md" };
    const res = cardOps.readEntryUnified(root, info, "decisions", "D100");
    // 说明：这条修前修后都绿（因为「自证位」已覆盖），所以**不是修复证据**，只登记现状。
    known(
      "F-04b 损坏卡片被 readEntryUnified 拒绝（修前修后都绿 ⇒ 不是修复证据）",
      `found=${res?.found} reason=${String(res?.reason ?? "").slice(0, 80)}`,
    );
    ok("F-04c ★可达性判据：损坏类 reason 恒含「自证位」⇒ 旧判据本来就拦得住（F-04 不可达）",
      res?.found === false && String(res?.reason).includes("自证位"),
      String(res?.reason ?? "").slice(0, 100));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════
// F-05（P2）repairConformance 原子写失败抛异常
//
// ★★★ Windows 上 chmod 挡不住 writeFileAtomic ⇒ **本机造不出写失败**。
//   ⇒ 只能核"源码形状已经改成结构化返回"，并**明确标注未测到**（绝不写 PASS 冒充验过）。
// ═══════════════════════════════════════════════════════════════════
{
  const p4 = fs.readFileSync(path.join(process.cwd(), "lib", "part4.js"), "utf8");
  const noThrow = !/if \(_wGi\.ok !== true\) throw fail\(/.test(p4);
  const structured = /if \(_wGi\.ok !== true\) return \{ ok: false, reason: "repairConformance:/.test(p4);
  ok("F-05a repairConformance 的 .gitignore 写失败分支已不再 throw", noThrow, "");
  ok("F-05b 该分支返回结构化 { ok:false, reason }", structured, "");

  // ★ 真跑一次正常路径，确认没把正常功能弄坏
  const root = tmp("f05-");
  try {
    await initProject(root, "flat", "s-d373-f05");
    const gi = path.join(root, ".gitignore");
    const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
    fs.writeFileSync(gi, cur + "\nLEDGER.md\n!LEDGER.md\n", "utf8");
    let res;
    let threw;
    try { res = part4.repairConformance(root, { apply: true }); } catch (e) { threw = String(e?.message ?? e); }
    ok("F-05c ★反向：正常路径下 repairConformance 不抛异常且返回结构化结果", threw === undefined && typeof res?.ok === "boolean", threw ?? JSON.stringify({ ok: res?.ok, applied: res?.applied }));
    known(
      "F-05d 写失败分支**本机未测到**（Windows 上 chmod 444 挡不住 writeFileAtomic）",
      "只能核源码形状；若要真测须在只读挂载或受限账户下跑",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log(rows.join("\n"));
console.log("─".repeat(74));
console.log(`合计：PASS ${pass} · FAIL ${fail}`);
console.log("PROBE-COMPLETE");
process.exit(0);
