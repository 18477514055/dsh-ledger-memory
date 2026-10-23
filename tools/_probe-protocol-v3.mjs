#!/usr/bin/env node
/**
 * 反向验证 D308（阶段二）：**代次体系升到第 3 代**。
 *
 * ★ 要证明的六条：
 *   ① `PROTOCOL_VERSION === 3`，且 `PROTOCOL_REQUIREMENTS` 里有 `since: 3`；
 *   ② **`since:3` 那条 `mechanical === false`** —— 这是最重要的一条（否则复现 D272「登记了但看不见」）；
 *   ③ 逐代递进正确：`{}`→1 · v2 键→2 · **再加 memoryRoot→3**；
 *   ④ `ledger_init` **给新项目传 memoryRoot ⇒ 盖章第 3 代**（不是 2）；
 *   ⑤ `ledger_init` **不传 memoryRoot ⇒ 仍是第 2 代**（不虚报）；
 *   ⑥ 升级指引**按实际缺的那几条给**：缺第 3 代时文案里必须有 `ledger_migrate`/`memoryRoot`，
 *      而不是只有"卡片化"那段（否则模型照做永远升不到 3）。
 *
 * ★ 第 ⑥ 条是本轮新加的：原文案只讲卡片化 ⇒ **3 代缺口的指引是错的**（会让人永远在原地打转）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const LIB = path.join(PROJECT, "lib");

const defs = await import(pathToFileURL(path.join(LIB, "defs.js")).href);
const part4 = await import(pathToFileURL(path.join(LIB, "part4.js")).href);

const results = [];
const ok = (n, pass, d) => {
  results.push({ n, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${n}${d === undefined ? "" : `  —— ${d}`}`);
};

console.log("═".repeat(76));
console.log("反向验证 D308：协议代次升到第 3 代");
console.log("═".repeat(76));

// ── ① 常量与要求表 ─────────────────────────────────────────────────────────
ok("① PROTOCOL_VERSION === 3", defs.PROTOCOL_VERSION === 3, String(defs.PROTOCOL_VERSION));
const g3 = defs.PROTOCOL_REQUIREMENTS.filter((r) => r.since === 3);
ok("① 有 since:3 的要求", g3.length === 1, `条数 ${g3.length}`);
ok("① since:3 的键是 memoryRoot", g3[0]?.keys?.length === 1 && g3[0].keys[0] === "memoryRoot", JSON.stringify(g3[0]?.keys));

// ── ② **最重要**：mechanical 必须 false ───────────────────────────────────
ok(
  "② ★★★ since:3 的 mechanical === false（禁止「只补键就声称升级」—— 那就是 D272 的坑）",
  g3[0]?.mechanical === false,
  String(g3[0]?.mechanical)
);
ok("② 它带 label 与 why（给用户看的话要能说清为什么值得升）", typeof g3[0]?.label === "string" && typeof g3[0]?.why === "string", "");

// ── ③ 逐代递进 ─────────────────────────────────────────────────────────────
const V2KEYS = { decisionsDir: "d", lessonsDir: "l", goalsDir: "g", logDir: "x" };
ok("③ 空清单 ⇒ 第 1 代", defs.satisfiedProtocolVersion({}) === 1, String(defs.satisfiedProtocolVersion({})));
ok("③ 只有 v2 键 ⇒ 第 2 代", defs.satisfiedProtocolVersion(V2KEYS) === 2, String(defs.satisfiedProtocolVersion(V2KEYS)));
ok("③ v2 键 + memoryRoot ⇒ **第 3 代**", defs.satisfiedProtocolVersion({ ...V2KEYS, memoryRoot: "m" }) === 3, String(defs.satisfiedProtocolVersion({ ...V2KEYS, memoryRoot: "m" })));
ok(
  "③ 只有 memoryRoot、缺 v2 键 ⇒ **不许跳到 3**（代次是连续的）",
  defs.satisfiedProtocolVersion({ memoryRoot: "m" }) === 1,
  String(defs.satisfiedProtocolVersion({ memoryRoot: "m" }))
);

// ── ④⑤ ledger_init 盖章 ────────────────────────────────────────────────────
function mk() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ledger-p3-"));
}
const tool = part4.defineInitTool();

// ④ 新项目 + memoryRoot ⇒ 第 3 代
const A = mk();
const rA = await tool.execute(
  {
    root: A,
    active: "LEDGER.md",
    // ★ 必填三件套：`active` / `decisions` / `archiveDir`（**空串会被拒**）。
    //   我第一版漏了 `decisions`、第二版漏了 `archiveDir` ⇒ **夹具没走通**，
    //   不是被测对象的问题（纪律 6：夹具故障不能当成缺陷）。补齐三件。
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
    decisionsDir: "decisions",
    lessonsDir: "lessons",
    goalsDir: "goals",
    logDir: "_ledger-log",
    memoryRoot: "mem-ledger-memory",
  },
  {}
);
const mA = JSON.parse(fs.readFileSync(path.join(A, ".dsh-ledger.json"), "utf8"));
ok("④ 传 memoryRoot 的新项目 ⇒ 清单 protocolVersion === 3", mA.protocolVersion === 3, String(mA.protocolVersion));
ok("④ 且回执说 builtGeneration === 3", rA?.protocol?.builtGeneration === 3, String(rA?.protocol?.builtGeneration));
ok("④ 且回执里没有 stillMissing（已经到当前代）", rA?.protocol?.stillMissing === undefined, JSON.stringify(rA?.protocol?.stillMissing ?? null));

// ⑤ 不传 memoryRoot ⇒ 仍是第 2 代（不虚报）
const B = mk();
const rB = await tool.execute(
  {
    root: B,
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
    decisionsDir: "decisions",
    lessonsDir: "lessons",
    goalsDir: "goals",
    logDir: "_ledger-log",
  },
  {}
);
const mB = JSON.parse(fs.readFileSync(path.join(B, ".dsh-ledger.json"), "utf8"));
ok("⑤ 不传 memoryRoot ⇒ 清单仍是 2（**不虚报第 3 代**）", mB.protocolVersion === 2, String(mB.protocolVersion));
ok("⑤ 且回执如实列出去缺口（含第 3 代那条）", Array.isArray(rB?.protocol?.stillMissing) && rB.protocol.stillMissing.length >= 1, JSON.stringify(rB?.protocol?.stillMissing));

// ── ⑥ 升级指引必须按"实际缺的那几条"给 ────────────────────────────────────
const howB = rB?.protocol?.howToUpgrade ?? "";
ok("⑥ ★ 缺第 3 代时，指引里必须提到 `memoryRoot`", howB.includes("memoryRoot"), howB.slice(0, 80) + "…");
ok("⑥ ★ 且必须提到 `ledger_migrate`（老项目唯一的正路）", howB.includes("ledger_migrate"), "");
ok(
  "⑥ ★ 且必须说清「直接补键会让内容消失」这个后果（否则别人以为补个键就完事）",
  howB.includes("消失"),
  ""
);
// 反向：只缺日志分片的项目，指引里**不该**长篇讲第 3 代（免得误导）
const C = mk();
const rC = await tool.execute(
  { root: C, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals", memoryRoot: "mem-ledger-memory" },
  {}
);
const howC = rC?.protocol?.howToUpgrade ?? "";
ok("⑥ 对照：已到第 3 代但缺 logDir ⇒ 指引只讲日志分片，不讲搬迁", !howC.includes("ledger_migrate") && howC.includes("logDir"), howC.slice(0, 90) + "…");

const bad = results.filter((r) => r.pass !== true).length;
console.log("\n" + "─".repeat(76));
console.log(`${results.length - bad} PASS / ${bad} FAIL`);
console.log("─".repeat(76));
process.exit(bad === 0 ? 0 : 1);
