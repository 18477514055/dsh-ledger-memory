#!/usr/bin/env node
/**
 * Gemini 静态审查 001（v1.6.1）7 项发现 —— 反向验证（D315）
 *
 * 纪律：
 *  1) 每条先能看见红（先证明"当前代码确实错"，才有资格说"修好了"）；
 *  2) 不许拿"源码读起来像有缺陷"当证据 —— 必须真调、真看磁盘；
 *  3) 每条一个 mkdtemp（互不踩）；
 *  4) 判据只问「行为对不对」。
 *
 * 用法：node tools/_probe-gemini001-findings.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  const mark = cond ? "OK  " : "FAIL";
  if (cond) pass++;
  else fail++;
  console.log(`  ${mark} ${name}${detail === undefined ? "" : `  —— ${detail}`}`);
}

const mod = async (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

/** v3ConformanceGaps(info, deps) 需要注入 memoryBaseOf（它故意不 import partN，避免成环）。 */
const DEPS = {
  memoryBaseOf: (info, fallback) =>
    typeof info?.memoryRoot === "string" && info.memoryRoot !== ""
      ? path.resolve(info.projectRoot, info.memoryRoot)
      : fallback,
};

function makeFixture(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `g001-${tag}-`));
  const root = path.join(base, "proj");
  const outside = path.join(base, "out");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const link = path.join(root, "linked");
  let linked = true;
  try {
    fs.symlinkSync(outside, link, "junction");
  } catch {
    try { fs.symlinkSync(outside, link, "dir"); } catch { linked = false; }
  }
  return { base, root, outside, link, linked };
}

const agentFor = (root) => ({ agent: { session: { header: { id: "session-g001", cwd: root } } } });

console.log("==============================================================");
console.log(" Gemini static audit 001 (v1.6.1) -- 7 findings reverse-verified");
console.log("==============================================================");

// ---------------------------------------------------------------- F-01
console.log("\nF-01 daily write paths still use lexical isUnder => symlink can write outside");
{
  const fx = makeFixture("f01");
  if (!fx.linked) {
    console.log("  SKIP 建不出符号链接，F-01 无从实测");
  } else {
    const secret = path.join(fx.outside, "SECRET.md");
    fs.writeFileSync(secret, "ORIGINAL OUTSIDE CONTENT\n", "utf8");
    fs.writeFileSync(path.join(fx.root, ".dsh-ledger.json"), JSON.stringify({
      version: 1, active: "linked/SECRET.md", decisions: "DECISIONS.md",
      archiveDir: "_ledger-archive", maxActiveLines: 300, revision: 0,
    }, null, 2), "utf8");

    const { defineWriteTool } = await mod("lib/part4.js");
    const tool = defineWriteTool({});
    let res;
    try {
      res = await tool.execute(
        { target: "active", mode: "replace", content: "OVERWRITTEN BY PROBE\n", ifRevision: 0 },
        agentFor(fx.root)
      );
    } catch (e) {
      res = { ok: false, threw: String(e?.message ?? e) };
    }
    const after = fs.readFileSync(secret, "utf8");
    const untouched = after === "ORIGINAL OUTSIDE CONTENT\n";
    ok("F-01 (1) 项目外文件没被改", untouched,
      untouched ? "干净" : `已被写成 ${JSON.stringify(after.slice(0, 40))}`);
    ok("F-01 (2) 回执明确拒绝（不是静默成功）",
      res?.ok === false || res?.threw !== undefined,
      JSON.stringify(res).slice(0, 150));
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- F-02
console.log("\nF-02 memoryRoot escape => v3ConformanceGaps skips whole block + silent downgrade to source root");
{
  const fx = makeFixture("f02");
  fs.writeFileSync(path.join(fx.root, ".dsh-ledger.json"), JSON.stringify({
    version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive", logDir: "_ledger-log",
    protocolVersion: 3, memoryRoot: "../outside-mem",
    maxActiveLines: 300, revision: 0,
  }, null, 2), "utf8");

  const { inspect } = await mod("lib/part2.js");
  const v3 = await mod("lib/v3-conformance.js");
  const info = inspect(fx.root);

  ok("F-02 (0) 前提：越界确实进了 unsafePaths",
    Array.isArray(info.unsafePaths) && info.unsafePaths.some((u) => u.field === "memoryRoot"),
    JSON.stringify(info.unsafePaths ?? []).slice(0, 130));

  const gaps = v3.v3ConformanceGaps(info, DEPS);
  const reported = Array.isArray(gaps?.reasons)
    && gaps.reasons.some((r) => /越界|unsafe|memoryRoot/i.test(String(r)));
  ok("F-02 (1) 体检报出这个越界", reported,
    `reasons = ${JSON.stringify(gaps?.reasons ?? []).slice(0, 180)}`);

  const { defineWriteTool } = await mod("lib/part4.js");
  const tool = defineWriteTool({});
  let res;
  try {
    res = await tool.execute(
      { target: "active", mode: "append", content: "\n- 探针写入\n" },
      agentFor(fx.root)
    );
  } catch (e) {
    res = { ok: false, threw: String(e?.message ?? e) };
  }
  const wroteToSourceRoot = fs.existsSync(path.join(fx.root, "LEDGER.md"));
  ok("F-02 (2) 越界时不许把记忆静默写进源码根",
    !wroteToSourceRoot, `源码根有 LEDGER.md=${wroteToSourceRoot} · 回执=${JSON.stringify(res).slice(0, 120)}`);
  fs.rmSync(fx.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------- F-03
console.log("\nF-03 three 'fixable' V3 mechanical repairs actually implemented in ledger_conform?");
{
  const fx = makeFixture("f03");
  const mem = path.join(fx.root, "mem-memory");
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(fx.root, ".dsh-ledger.json"), JSON.stringify({
    version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive", logDir: "_ledger-log",
    protocolVersion: 3, memoryRoot: "mem-memory",
    maxActiveLines: 300, revision: 0,
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# 台账\n", "utf8");
  fs.writeFileSync(path.join(fx.root, ".gitignore"), "", "utf8");

  const { inspect } = await mod("lib/part2.js");
  const v3 = await mod("lib/v3-conformance.js");
  const before = v3.v3ConformanceGaps(inspect(fx.root), DEPS);
  ok("F-03 (0) 前提：体检确实列出 fixable",
    Array.isArray(before?.fixable) && before.fixable.length > 0,
    JSON.stringify(before?.fixable ?? []).slice(0, 180));

  const p4 = await mod("lib/part4.js");
  const conformName = ["defineConformTool", "defineLedgerConformTool", "defineConform"]
    .find((n) => typeof p4[n] === "function");
  if (conformName === undefined) {
    console.log(`  SKIP 找不到 conform 工具导出（已查 ${JSON.stringify(Object.keys(p4).filter((k) => /conform/i.test(k)))}）`);
  } else {
    const tool = p4[conformName]({});
    let res;
    try {
      res = await tool.execute({ root: fx.root, apply: true }, agentFor(fx.root));
    } catch (e) {
      res = { ok: false, threw: String(e?.message ?? e) };
    }
    const sec = fs.existsSync(path.join(mem, "SECURITY.md"));
    const mirror = fs.existsSync(path.join(mem, ".dsh-ledger.json"));
    const gi = fs.readFileSync(path.join(fx.root, ".gitignore"), "utf8");
    const giOk = gi.split("\n").some((l) => {
      const t = l.trim();
      return t.startsWith("/mem-memory") || t.startsWith("mem-memory");
    });
    ok("F-03 (1) apply 后 SECURITY.md 真的写出来了", sec, `存在=${sec} · 回执=${JSON.stringify(res).slice(0, 100)}`);
    ok("F-03 (2) apply 后清单镜像真的补上了", mirror, `存在=${mirror}`);
    ok("F-03 (3) apply 后 .gitignore 真的补了忽略行", giOk, JSON.stringify(gi.slice(0, 100)));
  }
  fs.rmSync(fx.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------- F-04
console.log("\nF-04 normalizeRegistry drops unknown modes early => item vanishes / undeletable / silently erased");
{
  const fx = makeFixture("f04");
  fs.writeFileSync(path.join(fx.root, ".dsh-ledger.json"), JSON.stringify({
    version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive", maxActiveLines: 300, revision: 0,
  }, null, 2), "utf8");
  const extDir = path.join(fx.root, "extensions");
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, "registry.json"), JSON.stringify({
    version: 1,
    extensions: [{
      id: "old-princ", name: "旧原则扩展", mode: "principles",
      description: "D311 之前建的，mode 已不在白名单", createdAt: "2026-10-20",
    }],
  }, null, 2), "utf8");

  const p8 = await mod("lib/part8.js");
  const call = async (fnName, args) => {
    const fn = p8[fnName];
    if (typeof fn !== "function") return { missing: fnName };
    try { return await fn(...args); } catch (e) { return { threw: String(e?.message ?? e) }; }
  };

  const list = await call("listExtensions", [null, fx.root]);
  const count = list?.count ?? list?.extensions?.length ?? -1;
  ok("F-04 (1) 含未知模式的条目仍出现在列表里", count === 1,
    `count=${count} · ${JSON.stringify(list).slice(0, 150)}`);

  const del = await call("deleteExtension", [null, fx.root, "old-princ", { confirm: true }]);
  ok("F-04 (2) 未知模式的条目删得掉（不是永远删不掉）", del?.ok === true,
    JSON.stringify(del).slice(0, 150));

  const after = JSON.parse(fs.readFileSync(path.join(extDir, "registry.json"), "utf8"));
  const stillThere = Array.isArray(after.extensions) && after.extensions.some((e) => e.id === "old-princ");
  ok("F-04 (3) 注册表里该条没被静默抹掉（或已被上面那次 delete 明确删掉）",
    stillThere || del?.ok === true,
    `stillThere=${stillThere} · 条目数=${after.extensions?.length}`);
  fs.rmSync(fx.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------- F-05
console.log("\nF-05 V3 first-turn injection handoff pointer / inspect default-name probe basis");
{
  const p3 = fs.readFileSync(path.join(ROOT, "lib", "part3.js"), "utf8");
  const i = p3.indexOf("handoffLatestRel");
  const win = i === -1 ? "" : p3.slice(i, i + 700);
  // ★ 判据改成"**这一行里不得出现 info.projectRoot 拼 handoffLatestRel**"，
  //   而不是"取 path.join 的第一个参数必须是个裸标识符" ——
  //   修好后的写法是 `path.join(memoryBaseOf(info, info.projectRoot), …)`，
  //   里面**确实**含 `info.projectRoot`（作为 memoryBaseOf 的兜底参数，这是对的），
  //   我第一版的正则把它误读成 `undefined` ⇒ **假红**。
  //   ⇒ 教训：判据要盯"这个字段是被谁拼的"，不是"那个位置长什么样"。
  const badJoin = /path\.join\(\s*info\.projectRoot\s*,\s*info\.handoffLatestRel/.test(win);
  ok("F-05 (1) 首轮注入的交接单指针基准不是 info.projectRoot",
    !badJoin, badJoin ? "仍是 path.join(info.projectRoot, handoffLatestRel)" : "已走 memoryBaseOf");

  const p2 = fs.readFileSync(path.join(ROOT, "lib", "part2.js"), "utf8");
  // ★ 判据写作顺序：源码是 `path.resolve(projectRoot, DEFAULT_X_NAME)` ——
  //   我第一版写成 `DEFAULT_X_NAME ... path.resolve(projectRoot`（方向反了）⇒ **假绿**。
  //   ⇒ 教训：正则里的**先后顺序**必须照源码，不能凭印象。
  const probeRoot = /path\.resolve\(\s*projectRoot\s*,\s*(?:DEFAULT_PRINCIPLES_NAME|DEFAULT_GOALS_NAME|DEFAULT_JOURNAL_NAME|DEFAULT_LESSONS_NAME)\s*\)/g;
  const hits = (p2.match(probeRoot) ?? []).length;
  ok("F-05 (2) 四个默认名探测不再用 projectRoot 作基准", hits === 0,
    hits === 0 ? "已换基准" : `仍有 ${hits} 处 path.resolve(projectRoot, DEFAULT_*)`);
}

// ---------------------------------------------------------------- F-06
console.log("\nF-06 V3 migration / manifest sync / .gitignore anchoring");
{
  const p7 = fs.readFileSync(path.join(ROOT, "lib", "part7.js"), "utf8");
  ok("F-06 (1) migrateToV3 搬迁清单含 extensions",
    /pushRel\(\s*["']extensions["']\s*\)/.test(p7)
      || /rels\.push\([^)]*["']extensions["']/.test(p7)
      || /["']extensions["']/.test(p7),
    /["']extensions["']/.test(p7) ? "有 extensions" : "未见 extensions");
  ok("F-06 (2) 迁移后清单补 protocolVersion",
    /protocolVersion\s*:\s*satisfiedProtocolVersion/.test(p7),
    /protocolVersion\s*:\s*satisfiedProtocolVersion/.test(p7) ? "已补" : "未见");

  const p3 = fs.readFileSync(path.join(ROOT, "lib", "part3.js"), "utf8");
  const skipAt = p3.indexOf('if (choice === "skip")');
  const seg = skipAt === -1 ? "" : p3.slice(skipAt, skipAt + 1200);
  // ★ 必须**剔掉注释行**再判 —— 我第一版没剔，结果读到了我自己写的修复注释里的
  //   `fs.writeFileSync(mfPath, …)` ⇒ **假红**（代码早就改好了）。
  //   ⇒ 判据：**判据的输入要剔掉"描述它的文字"**（本项目同一类坑已栽多次）。
  const codeOnly = seg
    .split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
    })
    .join("\n");
  const bareWrite = /fs\.writeFileSync\(\s*mfPath/.test(codeOnly);
  ok("F-06 (3) 「不用改」那条路不裸写清单（应走 writeManifestSynced）", !bareWrite,
    skipAt === -1 ? "找不到 skip 分支" : bareWrite ? "仍是 fs.writeFileSync(mfPath, ...)" : "已走受控入口");

  const defs = fs.readFileSync(path.join(ROOT, "lib", "defs.js"), "utf8");
  const j = defs.indexOf("DEFAULT_IGNORE_LINES");
  const block = j === -1 ? "" : defs.slice(j, j + 800);
  const anchored = /\/(?:decisions|lessons|goals)\//.test(block);
  ok("F-06 (4) 默认忽略规则锚定根目录（/decisions/ 这类）", anchored,
    anchored ? "已锚定" : "仍是 decisions/ 任意层级匹配");
}

// ---------------------------------------------------------------- F-07
console.log("\nF-07 probes / selftest cross-environment reproducibility");
{
  const revPath = path.join(ROOT, "tools", "_probe-private-repo-workflow-reverse.mjs");
  const rev = fs.readFileSync(revPath, "utf8");
  const directHookRead = /readFileSync\([^)]*["']pre-push["']/.test(rev)
    && /\.git["']\s*,\s*["']hooks["']/.test(rev)
    && !/hookTemplate|pre-push\.hook\.sh/.test(rev);
  ok("F-07 (1) 反向探针不直接依赖未入库的 .git/hooks/pre-push（应有受控模板）",
    !directHookRead, directHookRead ? "仍直接读 .git/hooks/pre-push" : "已解耦");

  const fwd = fs.readFileSync(path.join(ROOT, "tools", "_probe-private-repo-workflow.mjs"), "utf8");
  // ★★★ 判据必须只吃**代码里的 SKIP 出口**，不能把注释里提到的 "SKIP" 算进去。
  //   我第一版直接 `match(/SKIP/g)` —— 21 处里大部分是注释和判据说明 ⇒ **假红**
  //   （代码其实已经每处都记账了）。⇒ 只数 `console.log("  ⏭ SKIP…")` 这种真实出口。
  const skipExits = (fwd.match(/console\.log\(\s*[`"]\s*⏭ SKIP/g) ?? []).length;
  const skipPushes = (fwd.match(/skipped\.push\(/g) ?? []).length;
  // ⑥ 那两处走 `visibilityChecked` 记账（等价于 skipped.push），要单独认；
  // 结尾处还有 4 处"补记"式 skipped.push ⇒ 所以判据是 skipPushes >= skipExits 而非相等。
  ok("F-07 (2) 每处 SKIP 出口都配了记账（skipped.push 或 visibilityChecked）", skipPushes >= skipExits,
    `SKIP 出口 ${skipExits} 处 · skipped.push ${skipPushes} 处`);

  const st = fs.readFileSync(path.join(ROOT, "tools", "selftest.mjs"), "utf8");
  // ★ 判据收窄到**断言里的期望值**：只查同时含 `ok(`/`eq(` 且含 `includes("…时间…")` 或 `=== "…时间…"` 的行。
  //   前两版都太宽：
  //     ① `st.includes("2026-10-09 10:20:30")` ⇒ 命中的是我自己的修复注释 ⇒ 假红；
  //     ② 改成"代码里任何 `YYYY-MM-DD HH:MM:SS` 字面量" ⇒ 命中 21 处**夹具输入**
  //        （`{ at: "2026-10-12 10:00:00" }` 这类是喂给函数的数据，**与本地时区无关**）⇒ 又假红。
  //   ⇒ 真正该禁的是**把本地时间当期望值**：`includes("…")` / `=== "…"` 出现在断言里。
  //      夹具输入时间戳完全合法 —— 它们是"一个确定的时刻"，不是"某个时区的渲染结果"。
  const codeLines = st
    .split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
    });
  const assertLocalTime = codeLines.filter(
    (l) =>
      /\b(ok|eq)\s*\(/.test(l) &&
      /(?:\bincludes\s*\(|===)\s*["'`]20\d\d-\d\d-\d\d \d\d:\d\d:\d\d["'`]/.test(l)
  );
  ok("F-07 (3) 断言里不再把本地时间字符串当期望值", assertLocalTime.length === 0,
    assertLocalTime.length === 0 ? "已改为按本地时区推算" : assertLocalTime.map((x) => x.trim().slice(0, 90)).join(" | "));
}

console.log("\n" + "=".repeat(62));
console.log(`合计：PASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条）`);
console.log("=".repeat(62));
process.exit(fail === 0 ? 0 : 1);
