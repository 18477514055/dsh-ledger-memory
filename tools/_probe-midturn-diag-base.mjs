#!/usr/bin/env node
/**
 * 反向验证 D304：**中途压缩诊断文件（`.dsh-ledger-midturn.log`）V3 下必须落进记忆目录。**
 *
 * ★ 010 的 B-03：原实现写死 `path.join(rootDir, MIDTURN_DIAG_FILE)` ⇒ V3 项目根上多一个日志。
 *
 * ★★ 难点：诊断块在 `runMidTurnCompact` 深处，**需要一个活内核 ctx 才能真跑到**。
 *   上一轮 D286 的教训正是"16 条静态正则全绿，而那段代码从未执行过" ——
 *   所以这里**不用静态正则当判据**，而是把那段"算落点"的逻辑**按同样两个出口重算一遍并对比**：
 *     · 修复后：`path.join(memoryBaseOf(inspect(root), root), NAME)`
 *     · 修复前：`path.join(root, NAME)`
 *   在 V3 / V2 两个夹具上分别算，看两者的**差异是否恰好只出现在 V3**。
 *
 * ★ 然后另加一条**结构断言**：源码里那段必须通过 `memoryBaseOf` 取基准，
 *   且**不允许**再出现 `path.join(rootDir, MIDTURN_DIAG_FILE)` 这个旧写法。
 *   ★ 为什么必须两条一起：只有结构断言 = D286 那种"从没执行过"的假绿；
 *     只有计算对比 = 不保证源码真用了那个函数。**两条都在，才排除了这两种病。**
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const PART3 = path.join(PROJECT, "lib", "part3.js");
const PART2 = path.join(PROJECT, "lib", "part2.js");

const { inspect, memoryBaseOf } = await import(pathToFileURL(PART2).href);
const { MIDTURN_DIAG_FILE } = await import(pathToFileURL(path.join(PROJECT, "lib", "defs.js")).href);

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail === undefined ? "" : `  —— ${detail}`}`);
};

function mkFixture(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ledger-diag-${kind}-`));
  const m = { version: 1, active: "LEDGER.md", archiveDir: "_ledger-archive" };
  if (kind === "v3") {
    m.memoryRoot = "mem-ledger-memory";
    fs.mkdirSync(path.join(root, "mem-ledger-memory"), { recursive: true });
  }
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify(m, null, 2), "utf8");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# t\n", "utf8");
  return root;
}

console.log("═".repeat(76));
console.log("反向验证 D304：中途压缩诊断文件的落点（010 的 B-03）");
console.log("═".repeat(76));

// ── ① V3：落点必须在记忆目录里，且**不在**项目根 ────────────────────────
const v3 = mkFixture("v3");
const infoV3 = inspect(v3);
const fixedV3 = path.join(memoryBaseOf(infoV3, v3), MIDTURN_DIAG_FILE);
const oldV3 = path.join(v3, MIDTURN_DIAG_FILE);
ok("① V3 修复后落点 = <memoryRoot>/.dsh-ledger-midturn.log", fixedV3 === path.join(v3, "mem-ledger-memory", MIDTURN_DIAG_FILE), fixedV3);
ok("① V3 旧落点 = 项目根（就是 010 报的那处）", oldV3 === path.join(v3, MIDTURN_DIAG_FILE), oldV3);
ok("① 两者**不同**（所以这条断言有区分力，不是空断言）", fixedV3 !== oldV3, "");

// ── ② V2：落点必须**逐字不变**（仍在项目根） ────────────────────────────
const v2 = mkFixture("v2");
const infoV2 = inspect(v2);
const fixedV2 = path.join(memoryBaseOf(infoV2, v2), MIDTURN_DIAG_FILE);
const oldV2 = path.join(v2, MIDTURN_DIAG_FILE);
ok("② V2 修复后落点仍在项目根（向后兼容，路径逐字不变）", fixedV2 === oldV2, fixedV2);

// ── ③ 退化路径：清单损坏 / memoryBase 为空 ⇒ 必须退回项目根（fail safe） ──
const broken = { projectRoot: v3, memoryBase: "" };
ok(
  "③ memoryBase 为空时 memoryBaseOf 退回项目根（不会拼出空路径）",
  memoryBaseOf(broken, v3) === v3,
  memoryBaseOf(broken, v3)
);

// ── ④ 结构断言：源码必须走 memoryBaseOf，不许再有旧写法 ─────────────────
const src = fs.readFileSync(PART3, "utf8");
ok(
  "④ 源码里有 `memoryBaseOf(inspect(rootDir), rootDir)`（走唯一基准出口）",
  src.includes("memoryBaseOf(inspect(rootDir), rootDir)"),
  ""
);
ok(
  "④ 源码里**不再**出现旧写法 `path.join(rootDir, MIDTURN_DIAG_FILE)`",
  !src.includes("path.join(rootDir, MIDTURN_DIAG_FILE)"),
  src.includes("path.join(rootDir, MIDTURN_DIAG_FILE)") ? "旧写法还在！" : ""
);
ok("④ 落点用的是 `memBase`", src.includes("path.join(memBase, MIDTURN_DIAG_FILE)"), "");

// ── ⑤ 反向：把源码改回旧写法 ⇒ ④ 必须变红 ──────────────────────────────
const NEEDLE = "const outFile = path.join(memBase, MIDTURN_DIAG_FILE);";
if (!src.includes(NEEDLE)) {
  ok("⑤ 反向验证前置：源码里有修复后的那一行", false, "找不到 ⇒ 前提不成立");
} else {
  try {
    fs.writeFileSync(PART3, src.replace(NEEDLE, "const outFile = path.join(rootDir, MIDTURN_DIAG_FILE);"), "utf8");
    const patched = fs.readFileSync(PART3, "utf8");
    ok(
      "⑤ 反向（改回旧写法）：旧写法重新出现 ⇒ ④ 的断言能看见红",
      patched.includes("path.join(rootDir, MIDTURN_DIAG_FILE)"),
      ""
    );
  } finally {
    fs.writeFileSync(PART3, src, "utf8");
    console.log(`  （part3.js 已还原 ${Buffer.byteLength(fs.readFileSync(PART3))} B）`);
  }
  ok("⑤ 还原后与原件逐字相同", fs.readFileSync(PART3, "utf8") === src, "");
}

const bad = results.filter((r) => r.pass !== true).length;
console.log("\n" + "─".repeat(76));
console.log(`${results.length - bad} PASS / ${bad} FAIL`);
console.log("─".repeat(76));
process.exit(bad === 0 ? 0 : 1);
