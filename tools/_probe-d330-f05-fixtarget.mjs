/**
 * _probe-d330-f05-fixtarget.mjs —— 定下 F-05 放宽的**正确修法**，并验证它两端都对
 *
 * ★ 问题回顾（已坐实，`_probe-d330-f05-regression.mjs`）：
 *   011 补丁把 `conformanceOf` 卡片模式那条判据从
 *        `if (!dirOk || cards === 0)`             （补丁前：空目录 ⇒ 不合格）
 *   改成
 *        `if (!dirOk || hasUnmigratedSingleFile)`  （补丁后：空目录 ⇒ **ok**）
 *   目的是解开 F-05 那个死锁（`repairConformance` 不许建内容、`conformanceOf` 又不认空目录 ⇒ 永远修不好）。
 *
 * ★ 但补丁**顺手把四条硬约束之一放宽了**：卡片目录零张卡也判 ok。
 *   这与 D272「登记目录键的前提是内容已经在目录里」直接冲突 ——
 *   "合规"从此可以是一个**空壳**。
 *
 * ★ 正确的修法不是二选一，而是**把两件事分开**：
 *   · `conformanceOf`（判）：**仍然要求有卡** —— 硬约束不许松。
 *   · `repairConformance`（修）：**能力上必须能真补卡** —— 补丁已经做到了（`_probe-d330-125e-honesty` ②D1.md 真落盘）。
 *   ⇒ 死锁的真正成因是「修的能力缺失」，**不是「判太严」**。
 *     补丁补上了能力（对），却又顺手改了判据（错）。
 *
 * 本探针验证「只保留能力、把判据改回去」之后，两端是否都对：
 *   ① 空卡片目录 ⇒ 判不合格（硬约束回来了）
 *   ② 遗留单文件有卡 + 目录空 ⇒ `repairConformance(apply:true)` 真补进去 ⇒ 再判就 ok（死锁仍解开）
 *   ③ `ledger_init(initialDecisions + decisionsDir)` ⇒ 生来就有卡 ⇒ 判 ok（新项目不受影响）
 *
 * ★ 它**不修改生产代码** —— 只在临时副本上打这个候选改法，验证通过再决定要不要真改。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
let pass = 0;
let fail = 0;
const FAILS = [];
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}${extra === undefined ? "" : `  —— ${extra}`}`);
  } else {
    fail += 1;
    FAILS.push(name);
    console.log(`  FAIL  ${name}${extra === undefined ? "" : `  —— ${extra}`}`);
  }
}

const tmpRoots = [];
function mk(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
function execFor(root, sid) {
  return { agent: { session: { header: { cwd: root, id: sid } } } };
}

// ── 把当前 lib/ 整套复制到临时目录，在副本上打候选改法 ─────────────────────
const stage = mk("d330fix-");
const libDir = path.join(stage, "lib");
fs.mkdirSync(libDir, { recursive: true });
for (const n of fs.readdirSync(path.resolve("lib")).filter((x) => x.endsWith(".js"))) {
  fs.copyFileSync(path.resolve("lib", n), path.join(libDir, n));
}
fs.writeFileSync(path.join(stage, "package.json"), '{"type":"module"}\n', "utf8");

const PART2 = path.join(libDir, "part2.js");
const part2Text = fs.readFileSync(PART2, "utf8");

// 候选改法：把 `if (!dirOk || hasUnmigratedSingleFile)` 恢复成"也必须真有卡"
const OLDCOND = "if (!dirOk || hasUnmigratedSingleFile) {";
const NEWCOND = "if (!dirOk || cards === 0 || hasUnmigratedSingleFile) {";
if (!part2Text.includes(OLDCOND)) {
  console.log("夹具失败：找不到待改的那行（源码形状变了）—— 报 FAILED，不当成被测对象的问题");
  console.log("PROBE-FAILED");
  process.exit(1);
}
fs.writeFileSync(PART2, part2Text.replace(OLDCOND, NEWCOND), "utf8");

const T2 = await import(pathToFileURL(PART2).href);
const T4 = await import(pathToFileURL(path.join(libDir, "part4.js")).href);

function home(root) {
  const info = T2.inspect(root);
  const base = T2.memoryBaseOf(info, root);
  const m = info.manifest ?? {};
  const decDirRel = typeof m.decisionsDir === "string" ? m.decisionsDir : undefined;
  const dirAbs = decDirRel === undefined ? undefined : path.resolve(base, decDirRel);
  const cards =
    dirAbs !== undefined && fs.existsSync(dirAbs)
      ? fs.readdirSync(dirAbs).filter((n) => /\.md$/i.test(n) && !/^INDEX\.md$/i.test(n))
      : [];
  return { info, base, decDirRel, dirAbs, cards };
}

const INIT_DECISIONS = "# 关键决策\n\n## D1 · 初始架构拍板\n- 选定 V3 卡片化\n";

// ══════════════════════════════════════════════════════════════════════════
// ① 空卡片目录 ⇒ 判不合格（硬约束回来了）
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ① 候选改法：空卡片目录 ⇒ 必须判不合格 ═══");
{
  const root = mk("d330fix-empty-");
  await T4.defineInitTool().execute(
    {
      root,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_archive",
      decisionsDir: "decisions",
      initialDecisions: INIT_DECISIONS,
    },
    execFor(root, "session-d330fix-0000-4000-8000-000000000001")
  );
  const h = home(root);
  const before = T2.conformanceOf(h.info);
  ok("① 0 夹具：建好即合规", before.verdict === "ok", `verdict=${before.verdict}`);

  for (const n of h.cards) fs.rmSync(path.join(h.dirAbs, n), { force: true });
  fs.rmSync(path.resolve(h.base, "DECISIONS.md"), { force: true });

  const h2 = home(root);
  const conf = T2.conformanceOf(h2.info);
  console.log(`      卡片数=${h2.cards.length} verdict=${conf.verdict}`);
  console.log(`      reasons=${JSON.stringify(conf.reasons)}`);
  ok("① a ★★★ 零决策记录 ⇒ 判不合格（硬约束回来）", conf.verdict !== "ok", `verdict=${conf.verdict}`);
  ok(
    "① b 理由点名「卡片目录里一张决策卡都没有」",
    conf.reasons.some((x) => /决策卡|卡片目录/.test(String(x))),
    JSON.stringify(conf.reasons)
  );
  ok(
    "① c 而且它是**可修的**（fixable 里有补卡建议）",
    Array.isArray(conf.fixable) && conf.fixable.length > 0,
    JSON.stringify(conf.fixable)
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ② 遗留单文件有卡 + 目录空 ⇒ repairConformance 真补进去 ⇒ 转 ok（死锁仍解开）
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ② 候选改法：遗留单文件 + 空目录 ⇒ repair 真能补卡、补完转 ok ═══");
{
  const root = mk("d330fix-repair-");
  // 用老式清单：decisions 单文件 + decisionsDir 同时登记（这正是 F-05 的场景）
  const memBase = path.join(root, `${path.basename(root)}-ledger-memory`);
  fs.mkdirSync(memBase, { recursive: true });
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify(
      {
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        decisionsDir: "decisions",
        lessonsDir: "lessons",
        goalsDir: "goals",
        archiveDir: "_archive",
        memoryRoot: path.basename(memBase),
        protocolVersion: 3,
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(path.join(memBase, "LEDGER.md"), "# 台账\n\n- x\n", "utf8");
  fs.writeFileSync(
    path.join(memBase, "DECISIONS.md"),
    "# 关键决策\n\n## D1 · 第一步\n\n- 内容一\n\n## D2 · 第二步\n\n- 内容二\n",
    "utf8"
  );
  fs.mkdirSync(path.join(memBase, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(memBase, "lessons"), { recursive: true });
  fs.mkdirSync(path.join(memBase, "goals"), { recursive: true });
  fs.mkdirSync(path.join(memBase, "_archive"), { recursive: true });

  const h0 = home(root);
  const conf0 = T2.conformanceOf(h0.info);
  console.log(`      补前：卡片=${h0.cards.length} verdict=${conf0.verdict} reasons=${JSON.stringify(conf0.reasons)}`);
  ok("② a 补前判不合格（遗留卡没搬进去）", conf0.verdict !== "ok", `verdict=${conf0.verdict}`);

  const rep = T4.repairConformance(root, { apply: true });
  console.log(`      actions=${JSON.stringify(rep.actions)}`);
  console.log(`      skipped=${JSON.stringify(rep.skipped)}`);

  const h1 = home(root);
  console.log(`      补后：卡片=${JSON.stringify(h1.cards)}`);
  ok("② b ★★★ 真补进了 2 张卡", h1.cards.length === 2, `cards=${h1.cards.length}`);

  const conf1 = T2.conformanceOf(h1.info);
  console.log(`      补后 verdict=${conf1.verdict} reasons=${JSON.stringify(conf1.reasons)}`);
  ok("② c ★★★ 补后转 ok ⇒ 死锁仍然解开（这才是 F-05 真正要的）", conf1.verdict === "ok", `verdict=${conf1.verdict}`);

  const txt =
    h1.cards.length > 0 ? fs.readFileSync(path.join(h1.dirAbs, h1.cards[0]), "utf8") : "";
  ok("② d 卡里有真内容", txt.includes("内容"), txt.slice(0, 50).replace(/\n/g, "\\n"));
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 新项目 ledger_init ⇒ 生来有卡 ⇒ 判 ok（不误伤新项目）
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ③ 候选改法：新 init 的项目不受影响 ═══");
{
  const root = mk("d330fix-new-");
  const r = await T4.defineInitTool().execute(
    {
      root,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_archive",
      decisionsDir: "decisions",
      initialDecisions: INIT_DECISIONS,
    },
    execFor(root, "session-d330fix-0000-4000-8000-000000000003")
  );
  const h = home(root);
  const conf = T2.conformanceOf(h.info);
  console.log(`      init.ok=${r.ok} 卡片=${JSON.stringify(h.cards)} verdict=${conf.verdict}`);
  ok("③ a init 成功", r.ok === true, `reason=${String(r.reason ?? "")}`);
  ok("③ b ★★★ 生来有卡且判 ok（候选改法不误伤新项目）", h.cards.length > 0 && conf.verdict === "ok", `cards=${h.cards.length} verdict=${conf.verdict}`);
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  合计：PASS ${pass} · FAIL ${fail}`);
if (fail > 0) {
  console.log("  失败项：");
  for (const f of FAILS) console.log(`    - ${f}`);
}
for (const d of tmpRoots) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* 无所谓 */
  }
}
console.log("PROBE-COMPLETE");
process.exit(0);
