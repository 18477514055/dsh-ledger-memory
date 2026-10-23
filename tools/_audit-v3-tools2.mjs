#!/usr/bin/env node
/**
 * ★★★★★ 全工具 V3 兼容性审计 v2（用户 2026-10-23：「很多工具不是三台协议」）。
 *
 * ── 为什么有 v2（v1 的教训，别丢）──────────────────────────────────
 *   `_audit-v3-tools.mjs` 只测了 **12 个无参可装配**的工具，**10 个带 state/ctx 的根本没测**。
 *   ⇒ 用户当场指出「很多工具不是三台协议」。**覆盖率本身就是结论的一部分。**
 *   ★ 判据：**"我测过的都过了" ≠ "全部过了"** —— 必须先把**全集**列出来，再逐个交代死活，
 *     没测的要**明确标 UNCOVERED**，不许留白（留白读起来像通过）。
 *
 * ── 本版怎么提高覆盖 ────────────────────────────────────────────────
 *   带 state/ctx 的工具**不伪造假 ctx**（那会犯纪律 6：夹具错了全绿就是假绿），
 *   而是走两条**真路径**：
 *     ① **静态路径基准分析**：找出该工具的 execute 体里每一个"记忆路径拼接点"，
 *        判断它用的是 `root`（项目根）还是 `memoryBaseOf/info.xxxAbs`（记忆基准）。
 *        ★ 这一步**能量全部工具**，因为它读的是源码里真实的拼接表达式。
 *     ② **动态真实调用**：能装配的真跑（V2/V3 双夹具），不能装配的**明确标 UNCOVERED 并写原因**。
 *
 * 跑法：node tools/_audit-v3-tools2.mjs [--verbose]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const VERBOSE = process.argv.includes("--verbose");
const P = (f) => pathToFileURL(path.join(ROOT, "lib", f)).href;

let pass = 0;
let fail = 0;
let uncovered = 0;
const failures = [];
const gaps = [];

const ok = (label, cond, detail) => {
  if (cond) {
    pass += 1;
    if (VERBOSE) console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail === undefined ? "" : ` — ${detail}`}`);
    console.log(`  FAIL  ${label}${detail === undefined ? "" : `\n          ${detail}`}`);
  }
};
const unc = (label, why) => {
  uncovered += 1;
  gaps.push(`${label} — ${why}`);
  if (VERBOSE) console.log(`  UNCOVERED  ${label}（${why}）`);
};
/** ★ 三态里的第三态：**工具明确说"条件不具备"** ⇒ 夹具局限，单独计数，不混进 pass/fail。 */
let condMissing = 0;
const conds = [];
const sk = (label, why) => {
  condMissing += 1;
  conds.push(`${label} — ${why}`);
  if (VERBOSE) console.log(`  COND-MISSING  ${label}（${why}）`);
};

// ═══════════════════════════════════════════════════════════════════
// 0. 全集：从 index.js 的工具注册表里读出**全部**工具名与定义函数
// ═══════════════════════════════════════════════════════════════════
const indexSrc = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
const regBlock = indexSrc.slice(indexSrc.indexOf("TOOL_DEFS") >= 0 ? indexSrc.indexOf("TOOL_DEFS") : 0);
const regPairs = [...indexSrc.matchAll(/\["(ledger_[a-z_]+)",\s*([^\]]+)\]/g)].map((m) => ({
  name: m[1],
  factory: m[2].trim(),
}));
console.log("═".repeat(78));
console.log(`全工具 V3 兼容性审计 v2 · 注册表工具数 = ${regPairs.length}`);
console.log("═".repeat(78));

// ═══════════════════════════════════════════════════════════════════
// 1. 静态：每个工具定义函数体里的"记忆路径拼接点"用的是哪个基准
// ═══════════════════════════════════════════════════════════════════
//
// ★ 判据（这里最容易错，写清）：
//   · `root` / `projectRoot` 是**项目根** —— 只有**清单 / .git / .gitignore / docs / notes** 该用它；
//   · 记忆（台账 / 归档 / 日志 / 卡片 / 胶囊 / 交接 / stash / 扩展）**必须**走 `memoryBase`。
//   · 所以把 `root` 用在**记忆类相对路径**上 = 缺陷。
//
// 怎么判"记忆类"：看被拼的那个相对路径变量名是不是来自 info 的记忆字段
// （activeRel / archiveRel / logRel / decisionsDir / lessonsDir / goalsDir / handoffRel / capsul…），
// 或者拼接点旁边就写着 memoryBase 却没用它。

const MEMORY_REL_KEYS = [
  "activeRel", "archiveRel", "logRel", "decisionsDir", "lessonsDir", "goalsDir",
  "handoffRel", "journalRel", "principlesRel", "lessonsRel", "goalsRel",
];
const memKeyAlt = MEMORY_REL_KEYS.join("|");

const libFiles = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js"));
const srcOf = new Map(libFiles.map((f) => [f, fs.readFileSync(path.join(ROOT, "lib", f), "utf8").split("\n")]));

/** 找 `path.X(root, <memKey>)` 或 `toGitRel(root, …)` 这类可疑点。 */
const SUSPECT = new RegExp(
  `(?:path\\.(?:join|resolve)|toGitRel|path\\.relative)\\(\\s*(?:root|projectRoot)\\s*,\\s*(?:[^)]*)?(?:${memKeyAlt})`
);
const suspects = [];
for (const [f, lines] of srcOf) {
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return; // 注释不算
    if (SUSPECT.test(line)) suspects.push({ file: f, line: i + 1, text: line.trim() });
  });
}
console.log(`\n─── 1. 静态：把项目根用在记忆类相对路径上的可疑点 ───`);
console.log(`   命中 ${suspects.length} 处`);
for (const s of suspects) console.log(`   ${s.file}:${s.line}  ${s.text.slice(0, 120)}`);
ok(
  "静态：没有把项目根用在记忆类相对路径上",
  suspects.length === 0,
  suspects.map((s) => `${s.file}:${s.line}`).join(" · ")
);

// ═══════════════════════════════════════════════════════════════════
// 2. 动态：能装配的工具在真 V2/V3 项目上跑，看文件落哪
// ═══════════════════════════════════════════════════════════════════
const part2 = await import(P("part2.js"));
const part4 = await import(P("part4.js"));
const part5 = await import(P("part5.js"));
const part8tool = await import(P("part8tool.js"));

const MEM_DIR = "mem-ledger-memory";

/** 最小可用的 fake state —— ★ 只放**真有默认值**的 Map，绝不伪造业务行为。 */
function fakeState() {
  return {
    compactFailures: new Map(),
    capsuleSnapshot: new Map(),
    hfSource: new Map(),
    compactCounts: new Map(),
    hfCompacted: new Map(),
    hfCompactAfterTurn: new Map(),
    flushedAt: new Map(),
    lastCompactCycleAt: new Map(),
    flushBlocked: new Map(),
    triageBlocked: new Map(),
    anchors: new Map(),
    reinject: new Map(),
    settingsBaselines: new Map(),
    // ★★★★★ 2026-10-23（D309）：**补全 state 里真正用到的 Map**。
    //
    //   🔴 病（本轮补 exec 之后当场暴露）：`ledger_triage` 报
    //     `Cannot read properties of undefined (reading 'get')`、
    //     `ledger_propose_principle` 报 `… (reading 'principleProposals')`。
    //     根因**不是工具坏了**，是这个假 state **缺了它们真正要用的 Map**
    //     ⇒ 工具在**夹具缺字段**的地方崩，而那会被三态判据读成"真缺陷"。
    //
    //   ★ 怎么定这一批字段（不是猜）：把 `lib/part{1..8,8tool}.js` 里所有
    //     `state.<name>.{get,set,has,delete}(` 扫一遍，与这里已有的做**差集**。
    //     实测代码用到 32 个、原来只有 13 个 ⇒ **缺 19 个**。全部补齐。
    //
    //   ★ 判据（这条值得记）：**"假对象"也必须遵守真契约** ——
    //     少一个字段，报出来的是"工具崩了"，而实际是"你没给它该有的东西"。
    autoOfferPending: new Map(),
    blockWeights: new Map(),
    capsuleHydrated: new Set(),
    compactAfterTurn: new Map(),
    conformAsked: new Set(),
    deltaForce: new Map(),
    deltaNudged: new Map(),
    deltaYieldSince: new Map(),
    ledgerTouched: new Map(),
    midTurnDbg: new Map(),
    pending: new Map(),
    principleGrants: new Map(),
    principleProposals: new Map(),
    projectAsked: new Set(),
    shadowedIndex: new Map(),
    skipAutoOffer: new Set(),
    triageAt: new Map(),
    triageKeep: new Map(),
    triageOwedAt: new Map(),
    turnCompact: new Map(),
    turnEndPullSpent: new Map(),
    turnObligation: new Map(),
  };
}

const mkProject = async (tag, v3) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `audit2-${tag}-`));
  const init = part4.defineInitTool();
  // ★ 两个夹具都配齐 logDir + 卡片三键 —— 否则日志/索引类工具会因"条件缺失"跑不动，
  //   而那会被误读成"工具坏了"（v2 第一版就栽在这，9 条红全是夹具没给条件）。
  const args = {
    root: d,
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
    decisionsDir: "decisions",
    lessonsDir: "lessons",
    goalsDir: "goals",
    logDir: "_ledger-log",
    ...(v3 ? { memoryRoot: MEM_DIR } : {}),
  };
  await init.execute(args, {});
  const mem = v3 ? path.join(d, MEM_DIR) : d;
  // 塞一点真实内容，让读取类工具有东西可读
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# 台账\n\n- 起点\n", "utf8");
  return { dir: d, mem, v3 };
};

const listFiles = (base) => {
  const out = [];
  const walk = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name === ".git") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(base, p).split(path.sep).join("/"));
    }
  };
  walk(base);
  return out.sort();
};

console.log("\n─── 2. 动态：能装配的工具真跑（V2 / V3 双夹具）───");

const v3p = await mkProject("v3", true);
const v2p = await mkProject("v2", false);

// 逐个工具交代：要么真跑，要么明确 UNCOVERED
const coverage = [];

async function tryTool(name, factory, stateNeeded) {
  const mod = factory ?? "";
  const state = stateNeeded ? fakeState() : undefined;
  try {
    let tool;
    if (name === "ledger_init") tool = part4.defineInitTool();
    else if (name === "ledger_read") tool = part4.defineReadTool();
    else if (name === "ledger_conform") tool = part4.defineConformTool();
    else if (name === "ledger_migrate") tool = part4.defineMigrateTool();
    else if (name === "ledger_index") tool = part4.defineIndexTool();
    else if (name === "ledger_note") tool = part4.defineNoteTool();
    else if (name === "ledger_handoff") tool = part4.defineHandoffTool();
    else if (name === "ledger_lock") tool = part4.defineLockTool();
    else if (name === "ledger_log") tool = part5.defineLogTool();
    else if (name === "ledger_goals") tool = part2.defineGoalsTool();
    else if (name === "ledger_lessons") tool = part2.defineLessonsTool();
    // ★★★★★ 2026-10-23（D309）：**原来这里没传 `state`** —— 而 `defineProposePrincipleTool(state)`
    //   的第一个形参就是 state，它在 `state.principleProposals.get(...)` 上崩。
    //   🔴 报出来的形状是「工具抛异常 ⇒ 真缺陷」，而实际是**探针自己少传了一个参数**
    //     （纪律 6 的另一个面：夹具/装配没走通，不能算被测对象的账）。
    //   ★ 判据：**构造器的形参表就是契约**，`tryTool` 给每一个都按契约喂。
    else if (name === "ledger_propose_principle") tool = part2.defineProposePrincipleTool(state);
    else if (name === "ledger_write") tool = part4.defineWriteTool(state);
    else if (name === "ledger_archive") tool = part4.defineArchiveTool(state);
    else if (name === "ledger_triage") tool = part5.defineTriageTool(state);
    else if (name === "ledger_recall") tool = part5.defineRecallTool(state);
    else if (name === "ledger_log_write") tool = part5.defineLogWriteTool(state);
    else if (name === "ledger_extension") tool = part8tool.defineExtensionTool(state);
    else return null;
    return tool;
  } catch {
    return null;
  }
}

// ★ 逐工具的最小真实调用。
//
// ★★★ 2026-10-23 修正（这次差点又犯纪律 6）：
//   上一版把 `ok=false` 一律算 FAIL，于是 9 条红全是**夹具没给条件**，不是工具缺陷：
//     · ledger_log / ledger_log_write → "还没有启用活动日志"（夹具没传 logDir）
//     · ledger_lock / ledger_propose_principle → "拿不到会话编号"（探针里没有 agent）
//     · ledger_index → "没有卡片目录"（夹具是单文件模式）
//     · ledger_recall → "没有可读的会话"（没有 eventAt）
//   ⇒ 判据改成三态：
//     `pass` = 真跑通且落点正确；
//     `skip` = **工具明确说"条件不具备"**（`ok:false` 且 reason 命中预置的"条件缺失"模式）
//              —— 这是**夹具的局限**，如实记为 SKIP，**绝不算缺陷、也不算通过**；
//     `fail` = 抛异常，或 `ok:false` 但**不是**条件缺失（那才是真错）。
const COND_MISSING = /还没有启用活动日志|拿不到会话|拿不到本会话|没有卡片目录|没有可读的会话|先 ledger_init|还没有登记台账/;

// ★★★★★ 2026-10-23（D309）：这 5 个工具**改由第 2.6 节的独立一次性目录探针真跑**。
//   它们不进这张表的原因不是"测不了"，是**这张表的夹具是共用的**，而它们会改夹具
//   （init 重建目录 / write 改正文 / archive 移条目）⇒ 会把别的用例踩成假红（纪律 6）。
//   ⇒ 在这里显式列出来，主循环**跳过**它们，交给 2.6 节。
const DEFERRED_TO_PROBE = new Set(["ledger_status", "ledger_init", "ledger_write", "ledger_archive", "ledger_compact"]);

const CALLS = {
  ledger_read: { args: { target: "active" }, ro: true },
  ledger_conform: { args: {}, ro: true },
  ledger_migrate: { args: { op: "detect" }, ro: true },
  ledger_index: { args: { op: "show", kind: "decisions" }, ro: true },
  // ★ 这两个夹具里补上 logDir 才跑得动 —— 但夹具已按 v3/v2 分别建，这里只标预期
  ledger_log: { args: { view: "timeline", limit: 5 }, ro: true },
  ledger_goals: { args: { op: "tree" }, ro: true },
  ledger_lessons: { args: { op: "list" }, ro: true },
  ledger_recall: { args: { mode: "index", from: 1, to: 5 }, ro: true },
  ledger_extension: { args: { op: "list" }, ro: true },
  ledger_triage: { args: { keep: [{ what: "审计占位" }] }, ro: false },
  ledger_log_write: { args: { title: "审计占位" }, ro: false },
  ledger_handoff: { args: { title: "审计占位", did: "x" }, ro: false },
  ledger_note: { args: { title: "审计占位", problem: "x", kind: "其他" }, ro: false, base: "project" },
  ledger_propose_principle: { args: { op: "add", text: "审计占位", reason: "x" }, ro: false },
  ledger_lock: { args: {}, ro: true },
};

for (const { name } of regPairs) {
  // ★ D309：会改共用夹具的那 5 个 ⇒ 交给 2.6 节的独立探针，这里**不记 UNCOVERED**
  //   （记了就会与 2.6 节自相矛盾：一边说已真跑覆盖、一边还在"明确未测"清单里）。
  if (DEFERRED_TO_PROBE.has(name)) continue;
  const call = CALLS[name];
  if (call === undefined) {
    unc(name, "没有安全的自动化调用（需要活内核 ctx / 会破坏夹具 / 需人工判定）");
    continue;
  }
  // ★ D309：`ledger_propose_principle` 也必须拿到 state（它的形参第一位就是它）。
  const needsState = ["ledger_triage", "ledger_log_write", "ledger_recall", "ledger_extension", "ledger_propose_principle"].includes(name);
  const tool = await tryTool(name, null, needsState);
  if (tool === null || typeof tool.execute !== "function") {
    unc(name, "装配失败（构造器签名需要 ctx/capsule，无法在探针里给出可信替身）");
    continue;
  }
  for (const [proj, tag] of [[v3p, "V3"], [v2p, "V2"]]) {
    const before = new Set(listFiles(proj.dir));
    try {
      // ★★★★★ 2026-10-23（D309）：给 exec 一个**符合契约的会话形状**。
      //
      //   🔴 原来是 `tool.execute({ root: proj.dir, ...call.args }, {})` —— **空 exec**。
      //     于是 6 条 COND-MISSING 全在喊「拿不到会话编号 / 拿不到本会话 id / 没有可读的会话」：
      //       · `ledger_lock` / `ledger_propose_principle` 要 `exec.agent.session.header.id`
      //       · `ledger_recall` 还要 `session.eventAt`
      //     ★ 那不是工具不可测，是**夹具没按契约喂参**（纪律 6：夹具没走通不能当成被测对象的问题）。
      //
      //   ⇒ 现在按 `projectRootOf(agent)` 真读的那几个字段给上（`part2.js:3657`）：
      //     `agent.session.header.{id,cwd}`。`eventAt` 给个空实现 —— 它返回 0 条事件，
      //     `ledger_recall` 会如实报"没有可读的会话"或"范围为空"，**那正是要断言的降级行为**。
      const exec = {
        agent: {
          session: {
            header: { id: `audit-${tag}-${name}`, cwd: proj.dir },
            eventAt: () => undefined,
            log: [],
          },
        },
      };
      const r = await tool.execute({ root: proj.dir, ...call.args }, exec);
      const after = listFiles(proj.dir);
      const made = after.filter((f) => !before.has(f));

      // ★ 三态判定（见 CALLS 上方那段说明）
      if (r?.ok === false && COND_MISSING.test(String(r?.reason ?? ""))) {
        // 工具明确说"条件不具备" ⇒ 夹具局限，如实记 SKIP
        sk(`${tag} ${name}（条件缺失）`, String(r.reason).slice(0, 60));
        continue;
      }
      // ★ 判据：新建的文件必须落在**该工具的基准**下。
      //   · `base:"project"`（如 ledger_note —— 用户明确"项目自己的文档，永远在项目根"）⇒ 不许进记忆子目录
      //   · 其余（记忆类）⇒ V3 必须落在 memDir 下；V2 项目根即记忆基准，天然成立
      const base = call.base ?? "memory";
      const wrong = call.ro
        ? [] // 只读工具不该新建文件
        : made.filter((f) => {
            if (base === "project") return f.startsWith(MEM_DIR + "/"); // 进了记忆子目录 = 错
            return tag === "V3" ? !f.startsWith(MEM_DIR + "/") : false;
          });
      ok(
        `${tag} ${name} ${call.ro ? "只读不写盘" : `新文件落在${base === "project" ? "项目根" : "记忆基准"}`}`,
        r?.ok !== false && wrong.length === 0,
        `ok=${r?.ok} reason=${JSON.stringify(String(r?.reason ?? "").slice(0, 120))} 新建=${JSON.stringify(made)} 越界=${JSON.stringify(wrong)}`
      );
      coverage.push(`${name}@${tag}`);
    } catch (e) {
      ok(`${tag} ${name} 不抛异常`, false, String(e?.message ?? e).slice(0, 160));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 2.5 面覆盖：记忆面地图里「该有的面」一个都不许少
// ═══════════════════════════════════════════════════════════════════
//
// ★ 为什么单独一节（这一节是本轮真缺陷的守卫）：
//   原来 `memorySurfaces` 读的 4 个字段（notesDir / docsDir / handoffDir / archiveDir）
//   **在 `inspect()` 里根本不存在**，而 `push()` 对 `undefined` **静默跳过**
//   ⇒ 四个面从来没进过榜，**一个探针都没红**。
//   ★ 判据的教训：**只验"表里有条目"不够，必须验"该有的面都在、且基准对"。**
console.log("\n─── 2.5 记忆面地图：面覆盖与基准 ───");
const part6 = await import(P("part6.js"));
{
  const info = part2.inspect(v3p.dir);
  const surf = part6.memorySurfaces(info);
  const got = new Map(surf.map((s) => [s.label, s]));
  console.log(`   面数 = ${surf.length}`);
  for (const s of surf) {
    console.log(`     ${String(s.base).padEnd(8)} ${String(s.rel).padEnd(24)} ${s.label}`);
  }
  // 该有的面（label → 期望基准）
  //
  // ★★★ 2026-10-23 修正：**「问题报告」这一面按项目形态定，不能一刀切要求它存在。**
  //   `inspect()` 在 `isGitRepo === true` 时把 `notesRel/notesAbs` 一律置 undefined
  //   （`notesSource:"none"`）—— 那是**既有设计**：Git 项目不是"工作区"，
  //   `ledger_note` 会明确拒绝并让改用 `ledger_write`（`part4.js:4228-4235`）。
  //   ⇒ 判据必须是：**Git 项目 ⇒ 允许它缺席；非 Git ⇒ 必须存在且基准为 project。**
  //     ★ 第一版一刀切要求 8 个面全在 ⇒ 在真项目（本项目就是 Git）上会假红。
  const EXPECT = [
    ["内部文档", "project"],
    ["交接单", "memory"],
    ["分流细节", "memory"],
    ["归档", "memory"],
    ["决策卡", "memory"],
    ["经验与教训", "memory"],
    ["目标树", "memory"],
  ];
  // 「问题报告」单独判：跟着 isGitRepo 走
  {
    const s = got.get("问题报告");
    if (info.isGitRepo === true) {
      ok(
        "面「问题报告」在 Git 项目里**允许缺席**（notesRel 设计上就是 none）",
        s === undefined || s.base === "project",
        s === undefined ? "缺席（符合设计）" : `存在且 base=${s.base}`
      );
    } else {
      ok(
        "面「问题报告」在非 Git 项目里存在且基准 = project",
        s !== undefined && s.base === "project",
        s === undefined ? "面不存在" : `base=${s.base}`
      );
    }
  }
  ok(`面覆盖：其余 ${EXPECT.length} 个面全部出现在榜上`, EXPECT.every(([l]) => got.has(l)), `缺：${EXPECT.filter(([l]) => !got.has(l)).map(([l]) => l).join(" / ") || "无"}`);
  for (const [label, want] of EXPECT) {
    const s = got.get(label);
    ok(`面「${label}」基准 = ${want}`, s !== undefined && s.base === want, s === undefined ? "面不存在" : `实际=${s.base}`);
  }
}
// ═══════════════════════════════════════════════════════════════════
// 2.6 「会改夹具」的那 5 个工具 —— 交给**独立的一次性目录探针**去真跑
// ═══════════════════════════════════════════════════════════════════
//
// ★★★★★ 2026-10-23（D309）：这 5 个工具长期挂 UNCOVERED，理由是
//   **"需要活内核 ctx / 会破坏夹具 / 需人工判定"**。逐条查过，**只有第 2 条是真的**：
//     · `ledger_status`  只吃 root；取不到 ctx 时它**如实报 `compaction.reachable:false`** ⇒ 能测；
//     · `ledger_init`    会**重建目录** ⇒ 与共用夹具的其他用例互相踩；
//     · `ledger_write`   会**改台账正文** ⇒ 同上；
//     · `ledger_archive` 会**移走条目 + 追加变更登记** ⇒ 同上；
//     · `ledger_compact` 需要真 ctx，但**"取不到服务时明确拒绝"本身就是要测的行为**。
//
//   ⇒ 正解**不是**把它们塞进上面那张共用夹具的 `CALLS` 表（那会把别的用例踩坏，然后一堆假红
//     —— 正是纪律 6），而是**另起一次性目录**跑，由 `tools/_probe-uncovered-tools.mjs` 负责
//     （每个工具一个 `mkdtemp`，跑完就删）。
//
//   ★ 判据（这条值得记）：**"能不能测"常常不是工具的问题，是夹具隔离没做对。**
//     我把"共用一个夹具"误当成了"不可测"，于是这 5 个工具白挂了两轮。
{
  const { spawnSync } = await import("node:child_process");
  console.log("\n─── 2.6 会改夹具的 5 个工具（独立一次性目录真跑）───");
  const probe = path.join(HERE, "_probe-uncovered-tools.mjs");
  const r = spawnSync(process.execPath, [probe], { encoding: "utf8", cwd: HERE });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = out.match(/(\d+) PASS \/ (\d+) FAIL/);
  const probePass = m === null ? 0 : Number(m[1]);
  const probeFail = m === null ? -1 : Number(m[2]);
  const ran = (idx) => out.includes(`【${idx}】`);

  ok(
    "2.6 ★★ 5 个「会改夹具」的工具由独立一次性目录探针**真跑**（不是标 UNCOVERED 了事）",
    r.status === 0 && probeFail === 0 && probePass >= 30,
    `probe exit=${r.status} · ${probePass} PASS / ${probeFail} FAIL`
  );
  for (const [name, idx] of [
    ["ledger_status", "1"],
    ["ledger_write", "2"],
    ["ledger_archive", "3"],
    ["ledger_compact", "4"],
    ["ledger_init", "5"],
  ]) {
    ok(`2.6 工具 ${name} 已被真跑覆盖（探针第 ${idx} 节有断言）`, ran(idx), ran(idx) ? "" : "探针输出里没有这一节");
    // ★ 只在这条真跑过之后才计入覆盖率 —— 不许提前记（那正是"留白读作通过"）
    if (r.status === 0 && probeFail === 0) coverage.push(`${name}@probe`);
  }
  if (r.status !== 0) {
    for (const line of out.split("\n").filter((l) => l.trim().startsWith("✗")).slice(0, 10)) {
      console.log("      " + line.trim());
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 3. 覆盖率交代（★ 这一节本身就是为了防止"我测过的都过了"）
// ═══════════════════════════════════════════════════════════════════
console.log("\n─── 3. 覆盖率 ───");
const coveredNames = new Set(coverage.map((c) => c.split("@")[0]));
console.log(`   注册表工具 ${regPairs.length} 个 · 真跑覆盖 ${coveredNames.size} 个 · 未覆盖 ${uncovered} 个 · 条件缺失 ${condMissing} 个`);
ok(
  `覆盖率：全部 ${regPairs.length} 个工具都有交代（真跑 / 条件缺失 / UNCOVERED 三选一）`,
  coveredNames.size + uncovered + condMissing >= regPairs.length,
  `覆盖 ${coveredNames.size} + 未覆盖 ${uncovered} + 条件缺失 ${condMissing} < 总数 ${regPairs.length}`
);

// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(78));
console.log(`结果：PASS ${pass} / FAIL ${fail} / COND-MISSING ${condMissing} / UNCOVERED ${uncovered}`);
if (failures.length > 0) {
  console.log("\nFAIL 明细（真缺陷）：");
  for (const f of failures) console.log("  ✗ " + f);
}
if (conds.length > 0) {
  console.log("\nCOND-MISSING（工具说条件不具备 ⇒ 夹具局限，不算缺陷也不算通过）：");
  for (const c of conds) console.log("  ~ " + c);
}
if (gaps.length > 0) {
  console.log("\nUNCOVERED（明确未测，不读作通过）：");
  for (const g of gaps) console.log("  · " + g);
}
console.log("═".repeat(78));

for (const p of [v3p, v2p]) {
  try {
    fs.rmSync(p.dir, { recursive: true, force: true });
  } catch {
    /* 清不掉就留着 */
  }
}
process.exit(fail > 0 ? 1 : 0);
