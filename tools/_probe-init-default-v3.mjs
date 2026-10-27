/**
 * ★★★★★ 只读行为探针：**新项目默认生第三代**（用户第 10/11 点，2026-10-24 拍板）
 *
 * 用户原话（逐字）：
 *   *"然后如果是一个新的指定的项目的话，那么当模型或者用户选择把台账初始化之后
 *     （或者锁定到某个文件夹），文件夹中立刻会初始化出一个子文件夹…
 *     然后最好是第三代的，而不是前面那几代的。"*
 *   *"然后初始的话默认三代现在立刻马上去做。"*
 *
 * ★ 必须验的**四条**（只验第一条就是个骗人的绿）：
 *   ① 全新项目、什么都不传 ⇒ **第 3 代**：子目录建出来、卡片三目录 + 日志都在、合规
 *   ② 全新项目 + `layout:"flat"` ⇒ **退回 V2**，且不报错
 *   ③ 既有 V2 项目重跑 init ⇒ **不许被偷偷升级**（这是最危险的边界）
 *   ④ 回执必须**说清**建成了第几代、目录在哪、想退回该传什么
 *
 * ★ 全部真调 `ledger_init` 的 execute，不 grep 代码。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "initv3-"));
process.env.DSH_HOME = path.join(fixture, "home");

const part4 = await import(pathToFileURL(path.join(ROOT, "lib", "part4.js")).href);
const part2 = await import(pathToFileURL(path.join(ROOT, "lib", "part2.js")).href);
// ★ 判"是不是 outdated"的正确尺子：`protocolGapOf(manifest).outdated`
//   （★ 我第一版写成了 `info.protocolVersion === 3` —— 那个字段根本不存在，属尺子错：
//     拿一个**不存在的属性**去比，undefined===3 恒假 ⇒ 稳定地报红，而不是被测对象有问题。）
const defs = await import(pathToFileURL(path.join(ROOT, "lib", "defs.js")).href);

let pass = 0, fail = 0;
const ok = (l, c, d = "") => { if (c) { pass++; console.log(`  PASS ${l}`); } else { fail++; console.log(`  FAIL ${l}${d ? " :: " + d : ""}`); } };

const tool = part4.defineInitTool();
const mkProj = (name, withGit) => {
  const p = path.join(fixture, name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "README.md"), "# plain\n", "utf8");
  if (withGit) fs.mkdirSync(path.join(p, ".git"), { recursive: true });
  return p;
};
const call = async (root, args) => {
  try {
    return { res: await tool.execute({ active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", ...args, root }, {}) };
  } catch (e) {
    return { err: String(e?.message ?? e) };
  }
};

// ── ① 全新项目，什么都不传 ⇒ 第 3 代
console.log("═══ ① 全新项目 + 不传 layout/memoryRoot ═══");
{
  const p = mkProj("brand-new");
  const r = await call(p, {});
  if (r.err) { console.log(`  抛错: ${r.err}`); }
  const man = part2.readManifest(p) ?? {};
  const info = part2.inspect(p);
  console.log(`  memoryRoot = ${JSON.stringify(man.memoryRoot)}`);
  console.log(`  protocolVersion = ${man.protocolVersion}`);
  console.log(`  decisionsDir/lessonsDir/goalsDir = ${JSON.stringify([man.decisionsDir, man.lessonsDir, man.goalsDir])}`);
  console.log(`  logDir = ${JSON.stringify(man.logDir)}`);
  ok("① 默认建成第 3 代（memoryRoot 有值）", typeof man.memoryRoot === "string" && man.memoryRoot !== "", JSON.stringify(man.memoryRoot));
  ok("①b 目录名 = <项目名>-ledger-memory", man.memoryRoot === "brand-new-ledger-memory", String(man.memoryRoot));
  ok("①c 子目录真的建出来了", fs.existsSync(path.join(p, "brand-new-ledger-memory")));
  ok("①d protocolVersion = 3", man.protocolVersion === 3, String(man.protocolVersion));
  ok("①e 卡片三目录已登记", typeof man.decisionsDir === "string" && typeof man.lessonsDir === "string" && typeof man.goalsDir === "string");
  ok("①f 日志目录已登记", typeof man.logDir === "string" && man.logDir !== "");
  // ★ 正确尺子：protocolGapOf（不是 info.protocolVersion —— 那个字段不存在）
  const gap = defs.protocolGapOf(man);
  console.log(`  protocolGapOf = ${JSON.stringify({ current: gap.currentVersion, outdated: gap.outdated, missing: gap.missing })}`);
  ok("①g 建成后**不是** outdated（生而在最新代）", gap.outdated === false, JSON.stringify(gap));
}

// ── ② 显式 flat ⇒ 退回 V2
console.log("\n═══ ② 全新项目 + layout:\"flat\" ═══");
{
  const p = mkProj("flat-one");
  const r = await call(p, { layout: "flat" });
  if (r.err) { console.log(`  抛错: ${r.err}`); }
  const man = part2.readManifest(p) ?? {};
  console.log(`  memoryRoot = ${JSON.stringify(man.memoryRoot)}`);
  ok("② flat ⇒ 不建 memoryRoot（V2 布局）", man.memoryRoot === undefined, JSON.stringify(man.memoryRoot));
  ok("②b flat 不报错", r.err === undefined, r.err);
  ok("②c flat 下台账文件落在项目根", fs.existsSync(path.join(p, "LEDGER.md")));
  ok("②d flat 下**没有**多出子目录", !fs.existsSync(path.join(p, "flat-one-ledger-memory")));
}

// ── ③ 既有 V2 项目重跑 init ⇒ 不许偷升
console.log("\n═══ ③ 既有 V2 项目重跑 init（最危险边界）═══");
{
  const p = mkProj("existing-v2");
  // 先建一个 V2 项目（flat）
  await call(p, { layout: "flat" });
  const before = part2.readManifest(p) ?? {};
  ok("③ 前置：它现在是 V2", before.memoryRoot === undefined, JSON.stringify(before.memoryRoot));
  // 再重跑一次，**什么都不传**
  const r2 = await call(p, {});
  const after = part2.readManifest(p) ?? {};
  console.log(`  重跑后 memoryRoot = ${JSON.stringify(after.memoryRoot)}`);
  ok("③b 重跑 init **不许**把既有 V2 偷偷升成 V3", after.memoryRoot === undefined, JSON.stringify(after.memoryRoot));
  ok("③c 重跑不报错", r2.err === undefined, r2.err);
}

// ── ④ 回执要说清
console.log("\n═══ ④ 回执是否说清「第几代 / 目录在哪 / 怎么退回」 ═══");
{
  const p = mkProj("receipt-one");
  const r = await call(p, {});
  const txt = JSON.stringify(r.res ?? {});
  const hasGen = /第\s*3\s*代|第三代|generation 3|V3/i.test(txt);
  const hasDir = /receipt-one-ledger-memory/.test(txt);
  const hasFlat = /flat/i.test(txt);
  console.log(`  回执含代次: ${hasGen} · 含目录名: ${hasDir} · 含 flat 退路: ${hasFlat}`);
  if (!hasGen) console.log(`  回执片段: ${txt.slice(0, 400)}`);
  ok("④ 回执说明建成了第几代", hasGen);
  ok("④b 回执给出记忆目录名", hasDir);
  ok("④c 回执说明想退回旧布局该传什么", hasFlat);
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
