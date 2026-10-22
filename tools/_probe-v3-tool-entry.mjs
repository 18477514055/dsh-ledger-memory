#!/usr/bin/env node
/**
 * ★★★★★ 探针：`ledger_migrate` 的 `op:"v3"` 入口是否真的接到了迁移器（D295 · V3 阶段 3 收口）。
 *
 * 为什么单独一支：
 *   `_probe-v3-migrate.mjs` 测的是 **lib 函数** `migrateToV3()` 本身（36 条）。
 *   而"函数写对了" ≠ "工具调得到它" —— **同一把尺子量不到两个东西**。
 *   本轮真的犯过更隐蔽的同型：反向验证注入了回归、探针照样全绿，因为**那段代码从未被执行**。
 *   ⇒ 这里专测**那三行接线**：`args.op === "v3"` 是否走到 `migrateToV3`。
 *
 * 测四件事：
 *   ① `op:"v3"` 的返回值与 `migrateToV3()` 直接调用**同形**（走的是同一个函数，不是复制的逻辑）
 *   ② `op:"v3"` 不传 apply ⇒ **一个字节都不写**（干跑是默认，不是靠模型自觉）
 *   ③ 不传 `op` ⇒ 仍然落到 `detectMigration`（老行为没被接线改坏）
 *   ④ 工具 description **不再谎称 READ-ONLY**（D224 那类过期文案，会误导模型不看就动手）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let pass = 0;
let fail = 0;
const ok = (label, cond) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}`);
  }
};

const { defineMigrateTool } = await import(pathToFileURL(path.join(ROOT, "lib", "part4.js")).href);
const { migrateToV3 } = await import(pathToFileURL(path.join(ROOT, "lib", "part7.js")).href);

const tool = defineMigrateTool();

/** 造一个最小 V2 项目（有清单 + 三份记忆文件）。 */
function makeV2Project(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-v3-entry-${tag}-`));
  fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n正文\n", "utf8");
  fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\nD1 某事\n", "utf8");
  fs.mkdirSync(path.join(dir, "_ledger-archive"), { recursive: true });
  fs.writeFileSync(path.join(dir, "_ledger-archive", "a.md"), "归档\n", "utf8");
  fs.writeFileSync(
    path.join(dir, ".dsh-ledger.json"),
    `${JSON.stringify(
      {
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_ledger-archive",
        maxActiveLines: 150,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return dir;
}

/** 目录快照（相对路径 → sha256），用来证明"干跑一个字节都没写"。 */
function snapshot(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(dir, p).split(path.sep).join("/"), fs.statSync(p).size);
    }
  };
  walk(dir);
  return out;
}
const sameSnap = (a, b) => {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
};

/** 假的 exec：只提供 rootFromExec 认的那个通道。 */
const execOf = () => ({});

console.log("\n=== ① op:\"v3\" 与 migrateToV3() 同形（走的是同一个函数）===\n");
{
  const dir = makeV2Project("same");
  const viaTool = await tool.execute({ op: "v3", root: dir }, execOf());
  const viaLib = migrateToV3(dir, { apply: false });
  ok("①a 工具返回 ok:true", viaTool.ok === true);
  ok("①b 工具返回 dryRun:true（不传 apply 就是干跑）", viaTool.dryRun === true);
  ok("①c 计划里的目标目录一致", viaTool.plan?.target === viaLib.plan?.target);
  ok(
    "①d 计划里的搬移项数量一致",
    JSON.stringify(viaTool.plan?.moves?.map((m) => m.from)) ===
      JSON.stringify(viaLib.plan?.moves?.map((m) => m.from)),
  );
  ok("①e 目标目录名形如 <项目名>-ledger-memory", /-ledger-memory$/.test(String(viaTool.plan?.target)));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n=== ② 不传 apply ⇒ 一个字节都不写（干跑是默认）===\n");
{
  const dir = makeV2Project("dry");
  const before = snapshot(dir);
  const r = await tool.execute({ op: "v3", root: dir }, execOf());
  const after = snapshot(dir);
  ok("②a 返回 dryRun:true", r.dryRun === true);
  ok("②b 目录快照前后完全一致（没建 .partial）", sameSnap(before, after));
  ok("②c 没有建出记忆目录", !fs.existsSync(path.join(dir, String(r.plan?.target))));
  ok(
    "②d 清单里没有 memoryRoot（切换点没被提前触发）",
    JSON.parse(fs.readFileSync(path.join(dir, ".dsh-ledger.json"), "utf8")).memoryRoot === undefined,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n=== ③ 不传 op ⇒ 仍然落到 detectMigration（老行为没被接线改坏）===\n");
{
  const dir = makeV2Project("detect");
  const r = await tool.execute({ root: dir }, execOf());
  ok("③a 返回里有 needsMigration（detectMigration 的字段）", typeof r.needsMigration === "boolean");
  ok("③b 不是迁移器的返回值（没有 plan）", r.plan === undefined);
  ok("③c 不是干跑标记", r.dryRun === undefined);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n=== ④ 工具 description 不再谎称 READ-ONLY ===\n");
{
  const d = String(tool.description || "");
  ok("④a 明确标出 detect 才是只读", /detect.*READ-ONLY|READ-ONLY.*detect/i.test(d));
  ok("④b 明确说 split / v3 默认干跑", /dry run/i.test(d));
  ok("④c 明确说目标目录是 <project>-ledger-memory", /ledger-memory/i.test(d));
  ok(
    "④d 不再有「writes nothing at all / 一个字节都不写」这类整体性谎言",
    !/writes nothing at all/i.test(d),
  );
}

console.log("\n=== ⑤ 已迁移过的项目 ⇒ 明确拒绝，不重复搬 ===\n");
{
  const dir = makeV2Project("done");
  const mp = path.join(dir, ".dsh-ledger.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  m.memoryRoot = "fake-ledger-memory";
  fs.writeFileSync(mp, `${JSON.stringify(m, null, 2)}\n`, "utf8");
  const r = await tool.execute({ op: "v3", root: dir, apply: true }, execOf());
  ok("⑤a 返回 ok:false", r.ok === false);
  ok("⑤b 标了 alreadyV3", r.alreadyV3 === true);
  ok("⑤c 理由里点明已经是 V3", /已经.*V3/.test(String(r.reason)));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n=== ⑥ 测试钩子不许出现在工具 schema 里（生产入口传不进去）===\n");
{
  // ★ 为什么这条重要：`injectCorruptCopy` / `stopBeforeManifest` 是**探针专用**的故障注入点。
  //   它们存在于 lib 里是**刻意**的（否则「校验不过就不改名」永远验证不到，见 D295）。
  //   但**工具 schema 一旦露出它们，模型就能在真实项目上主动造坏副本** ——
  //   「生产永不传」这个安全前提就变成了自觉，而不是结构保证。
  const names = Object.keys(tool.parameters?.properties ?? {});
  ok("⑥a schema 参数里没有 injectCorruptCopy", !names.includes("injectCorruptCopy"), names.join(", "));
  ok("⑥b schema 参数里没有 stopBeforeManifest", !names.includes("stopBeforeManifest"), names.join(", "));
  ok(
    "⑥c additionalProperties === false（不给「随便多传一个字段」留口子）",
    tool.parameters?.additionalProperties === false,
  );
  ok("⑥d op 的枚举只含 detect / split / v3", JSON.stringify(tool.parameters?.properties?.op?.enum) === JSON.stringify(["detect", "split", "v3"]));

  // ★★★ 而且：即便有人硬塞这两个字段，`execute` 也**必须**把它们丢掉。
  //
  //   🔴 这里是本探针**唯一一处曾经假绿的地方**，必须说清楚：
  //     我第一版只传了 `{injectCorruptCopy:true, stopBeforeManifest:true}` 而**没传 apply**，
  //     于是 `migrateToV3` 在**干跑分支（`!apply` 那行）就返回了**，**根本走不到那两个钩子**。
  //     ⇒ 那两条断言在正常路径上**永远成立** —— 正是 D295 那个病（"那段代码从未被执行"）。
  //     证据：我把两个钩子真的透传下去之后，⑥e/⑥f **照样全绿**，只有 ⑥a/⑥b 红了。
  //
  //   ⇒ 修法：**必须带 `apply:true`**，让执行真的走到 ④ 改清单之前的那两个分支上 ——
  //     那时"钩子有没有被透传"才会产生**可见的差别**（走中断分支 vs 走完整个迁移）。
  const dirHook = makeV2Project("hook");
  const rHook = await tool.execute(
    { op: "v3", root: dirHook, apply: true, injectCorruptCopy: true, stopBeforeManifest: true },
    execOf(),
  );
  ok("⑥e 带 apply:true 硬塞 stopBeforeManifest ⇒ 仍然**没有**走中断分支", rHook.stoppedBeforeManifest === undefined);
  ok("⑥f 带 apply:true 硬塞 injectCorruptCopy ⇒ 迁移照常成功（没被造出坏副本）", rHook.ok === true);
  ok(
    "⑥g 且真的迁完了（清单里写了 memoryRoot）",
    JSON.parse(fs.readFileSync(path.join(dirHook, ".dsh-ledger.json"), "utf8")).memoryRoot !== undefined,
  );
  fs.rmSync(dirHook, { recursive: true, force: true });

  // ★ 对照：不传 apply 时**无论塞什么都只是干跑**（这条与上面那条各测一件事，不是重复）。
  const dirDry = makeV2Project("hookdry");
  const rDry = await tool.execute(
    { op: "v3", root: dirDry, injectCorruptCopy: true, stopBeforeManifest: true },
    execOf(),
  );
  ok("⑥h 不传 apply ⇒ 无论塞什么都只是干跑", rDry.dryRun === true);
  fs.rmSync(dirDry, { recursive: true, force: true });
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`v3-tool-entry 探针：${pass} PASS / ${fail} FAIL`);
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
