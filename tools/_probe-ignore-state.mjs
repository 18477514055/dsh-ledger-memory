#!/usr/bin/env node
/**
 * D317 · GPT 审查 002 的 F05 —— `.gitignore` 通配反选的反向验证
 *
 * ★ 为什么必须有这一份：F05 的根因是**两套判据分叉**（检测认 `*` 通配、修复只比字面名）
 *   ⇒ 表现是"检测说可修、执行什么都不做"。要证它真修好了，必须同时验两件事：
 *     ① `ignoreStateOf` 自己的结论对不对（含 `*` 通配、通配反选）；
 *     ② `repairConformance` 在那些场景下**真的动手了**（changed / actions 非空，且末尾真压回忽略行）。
 *   ★ 只验 ① 会漏掉"两侧还是没共用"；只验 ② 会漏掉"匹配器本身算错了"。
 *
 * ★★ 另外用 `git check-ignore` 做**交叉验证** —— 那是 ignore 语义的**真源**。
 *   但它**只在这个探针里用**，不进产品代码：产品里要 git 在场就太脆
 *   （用户可能没有 git、可能在裸目录里），那会让"体检"因为环境而失败。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT = path.resolve(process.cwd());
const vc = await import("../lib/v3-conformance.js");
const part4 = await import("../lib/part4.js");
const part2 = await import("../lib/part2.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail === undefined ? "" : "  — " + detail)); }
};

const MEM = "mem-memory";
const IGNORE_LINE = "/" + MEM + "/";
// ★ 本文件里凡是需要在字符串中写"星号 + 斜杠"的地方都拆开拼，避免与块注释结束标记冲突
const STAR = "*";
const SLASH = "/";

console.log("═══ ① ignoreStateOf 的四种输入（含通配与通配反选）═══");
{
  // a) 完全没有规则
  let r = vc.ignoreStateOf(MEM, "");
  ok("a 空 .gitignore ⇒ ignored = null（没有任何规则命中）", r.ignored === null, String(r.ignored));

  // b) 直接命中
  r = vc.ignoreStateOf(MEM, IGNORE_LINE + "\n");
  ok("b 有 /mem-memory/ ⇒ ignored = true", r.ignored === true, String(r.ignored));

  // c) 先忽略、后被字面反选
  r = vc.ignoreStateOf(MEM, IGNORE_LINE + "\n!" + MEM + "/\n");
  ok("c 后跟 !mem-memory/ ⇒ ignored = false（最后一条赢）", r.ignored === false, String(r.ignored));

  // d) ★ 通配反选：/mem-memory/ 之后跟一行 "!" + 星号 + 斜杠
  const starNeg = "!" + STAR + SLASH;
  r = vc.ignoreStateOf(MEM, IGNORE_LINE + "\n" + starNeg + "\n");
  ok(
    "d ★ 通配反选（感叹号 + 星号斜杠）⇒ ignored = false（这是 F05 的核心场景）",
    r.ignored === false,
    "ignored=" + String(r.ignored) + " hits=" + JSON.stringify(r.hits.map((h) => h.line)),
  );

  // e) 通配命中：/ *-ledger-memory / 这种
  r = vc.ignoreStateOf("proj-ledger-memory", "/" + STAR + "-ledger-memory/\n");
  ok("e 通配命中 `*-ledger-memory` ⇒ ignored = true", r.ignored === true, String(r.ignored));

  // f) 顺序反过来：先通配反选、再忽略 ⇒ 最后一条是忽略 ⇒ true
  r = vc.ignoreStateOf(MEM, starNeg + "\n" + IGNORE_LINE + "\n");
  ok("f 顺序反过来（最后一条是忽略行）⇒ ignored = true", r.ignored === true, String(r.ignored));
}

console.log("\n═══ ② 用 git check-ignore 交叉验证（ignore 语义的真源）═══");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ign-xcheck-"));
  try {
    const g = spawnSync("git", ["init", "-q"], { cwd: tmp, encoding: "utf8" });
    if (g.status !== 0) {
      console.log("  SKIP  git 不在 PATH 上 ⇒ 交叉验证跳过（**不算全绿**：这一项没被验到）");
    } else {
      const cases = [
        { name: "直接忽略", gi: IGNORE_LINE + "\n", expectIgnored: true },
        { name: "字面反选", gi: IGNORE_LINE + "\n!" + MEM + "/\n", expectIgnored: false },
        { name: "★ 通配反选", gi: IGNORE_LINE + "\n!" + STAR + SLASH + "\n", expectIgnored: false },
      ];
      for (const c of cases) {
        fs.mkdirSync(path.join(tmp, MEM), { recursive: true });
        fs.writeFileSync(path.join(tmp, MEM, "probe.txt"), "x\n", "utf8");
        fs.writeFileSync(path.join(tmp, ".gitignore"), c.gi, "utf8");
        const mine = vc.ignoreStateOf(MEM, c.gi).ignored === true;
        const ci = spawnSync("git", ["check-ignore", "-q", MEM + "/probe.txt"], { cwd: tmp, encoding: "utf8" });
        const gitSays = ci.status === 0;
        ok(
          `② ${c.name}：我的判据(${mine}) 与 git check-ignore(${gitSays}) 一致`,
          mine === gitSays,
          "git exit=" + ci.status + "  gitignore=" + JSON.stringify(c.gi),
        );
        ok(
          `② ${c.name}：且结论符合预期（${c.expectIgnored}）`,
          gitSays === c.expectIgnored,
          "gitSays=" + gitSays,
        );
      }
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ }
  }
}

console.log("\n═══ ③ repairConformance 在通配反选下**真的动手**（F05 的正面证据）═══");
{
  const cases = [
    { name: "字面反选", gi: IGNORE_LINE + "\n!" + MEM + "/\n" },
    { name: "★ 通配反选", gi: IGNORE_LINE + "\n!" + STAR + SLASH + "\n" },
  ];
  for (const c of cases) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ign-repair-"));
    try {
      fs.mkdirSync(path.join(tmp, MEM), { recursive: true });
      fs.writeFileSync(path.join(tmp, MEM, "LEDGER.md"), "# 台账\n", "utf8");
      const mf = {
        version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_ledger-archive", logDir: "_ledger-log",
        memoryRoot: MEM, maxActiveLines: 300, revision: 0, protocolVersion: 3,
      };
      fs.writeFileSync(path.join(tmp, ".dsh-ledger.json"), JSON.stringify(mf, null, 2) + "\n", "utf8");
      fs.writeFileSync(path.join(tmp, MEM, ".dsh-ledger.json"), JSON.stringify(mf, null, 2) + "\n", "utf8");
      fs.writeFileSync(path.join(tmp, ".gitignore"), c.gi, "utf8");

      const res = part4.repairConformance(tmp, { apply: true });
      const after = fs.readFileSync(path.join(tmp, ".gitignore"), "utf8");
      const st = vc.ignoreStateOf(MEM, after);

      ok(
        `③ ${c.name}：apply 后忽略**真生效**（ignored === true）`,
        st.ignored === true,
        "after=" + JSON.stringify(after.split("\n").slice(-4)),
      );
      ok(`③ ${c.name}：changed === true（不许再回 changed:false）`, res.changed === true, JSON.stringify({ changed: res.changed }));
      ok(`③ ${c.name}：actions 里如实说了干了什么`, res.actions.some((a) => /反选|压回/.test(a)), JSON.stringify(res.actions));
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 同上 */ }
    }
  }
}

console.log("\n═══ ④ 反向自证：把修复摘掉必须变红 ═══");
{
  // 拿一个"检测说可修"的场景，故意不调 repairConformance，只验"不修就还是没生效"
  const gi = IGNORE_LINE + "\n!" + STAR + SLASH + "\n";
  const st = vc.ignoreStateOf(MEM, gi);
  ok(
    "④ 不修的情况下 ignored !== true（证明上面的 ③ 不是空判据）",
    st.ignored !== true,
    "ignored=" + String(st.ignored),
  );
}

console.log("\n═══ 汇总 ═══");
console.log("  PASS " + pass + " / FAIL " + fail + "（共 " + (pass + fail) + " 条）");
if (fail > 0) process.exit(1);
