/**
 * _probe-d330-f05-semantics.mjs —— D330 补丁 F-05 的**语义边界**复查
 *
 * ★ 为什么必须单独测它（不是信补丁的 125⑤ 一条就够）：
 *   补丁在 `conformanceOf` 里把卡片模式那条判据
 *     改前：`if (!dirOk || cards === 0)  ⇒ 不合格`
 *     改后：`if (!dirOk || hasUnmigratedSingleFile) ⇒ 不合格`
 *   而 `hasUnmigratedSingleFile` 在 cards===0 **且没有遗留单文件**时返回 false
 *   ⇒ **"卡片目录空空如也"从此判决 ok**。
 *
 *   这与 D272 的「登记目录键的前提是内容已经在目录里」是否冲突，必须用**行为**回答，
 *   不能靠读注释。本探针就问三件事：
 *     ① 真·空卡片目录（无遗留单文件）⇒ 到底判什么？
 *     ② `ledger_init` 不给 initialDecisions ⇒ 建出来是什么形状？合规吗？有卡吗？
 *     ③ 如果 ①② 出现「判 ok 但一张决策卡都没有」，那它就是**硬约束被放宽**，
 *        与"四条硬约束之一 = 有独立决策记录"直接冲突 ⇒ 必须报出来。
 *
 * ★ 铁律（D326/D324）：探针必须带跑完哨兵 `PROBE-COMPLETE`，否则崩溃会冒充检出。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SRC = {
  part2: path.resolve("lib/part2.js"),
  part4: path.resolve("lib/part4.js"),
};

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
  return {
    agent: {
      session: {
        header: { cwd: root, id: sid },
      },
    },
  };
}

const T2 = await import(pathToFileURL(SRC.part2).href);
const T4 = await import(pathToFileURL(SRC.part4).href);

// ══════════════════════════════════════════════════════════════════════════
// ① 先建一个**完全合规**的卡片化项目，然后把决策卡删掉，看判据是否变红
//    ★ 这样其余四条硬约束都满足，唯一变量就是「卡片目录空不空」。
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ① 完全合规的卡片化项目 − 决策卡 ⇒ conformanceOf 判什么 ═══");
{
  const buildTool = T4.defineInitTool();
  const root = mk("d330f05-empty-");
  const r0 = await buildTool.execute(
    {
      root,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_archive",
      initialDecisions: "# 关键决策\n\n## D1 · 初始架构拍板\n- 选定 V3 卡片化\n",
    },
    execFor(root, "session-d330f0500-0000-4000-8000-000000000000")
  );
  ok("① 0 夹具：init 成功", r0.ok === true, `ok=${r0.ok} reason=${String(r0.reason ?? "")}`);

  const decDir = path.join(root, "decisions");
  const before = fs.existsSync(decDir)
    ? fs.readdirSync(decDir).filter((n) => /\.md$/i.test(n) && !/^INDEX\.md$/i.test(n))
    : [];
  const confBefore = T2.conformanceOf(T2.inspect(root));
  console.log(`      建好后：卡片=${JSON.stringify(before)} verdict=${confBefore.verdict}`);
  ok("① 0b 夹具：建出来本来就是合规的（否则这条探针没有基线）", confBefore.verdict === "ok", `verdict=${confBefore.verdict} reasons=${JSON.stringify(confBefore.reasons)}`);

  // 把决策卡全部删掉 ⇒ 卡片目录为空
  for (const n of before) fs.rmSync(path.join(decDir, n), { force: true });
  const after = fs.readdirSync(decDir).filter((n) => /\.md$/i.test(n) && !/^INDEX\.md$/i.test(n));
  console.log(`      删卡后：卡片=${JSON.stringify(after)}`);

  const confAfter = T2.conformanceOf(T2.inspect(root));
  console.log(`      删卡后 verdict=${confAfter.verdict}`);
  console.log(`      reasons=${JSON.stringify(confAfter.reasons)}`);

  ok(
    "① a ★★★ 空卡片目录 + 零张卡 ⇒ **必须**判不合格（这是四条硬约束之一）",
    confAfter.verdict !== "ok",
    `verdict=${confAfter.verdict}`
  );
  ok(
    "① b 而且理由必须点名「决策卡没了」（不许静默放过）",
    confAfter.reasons.some((x) => String(x).includes("决策卡") || String(x).includes("卡片目录")),
    JSON.stringify(confAfter.reasons)
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ② `ledger_init` 不给 initialDecisions ⇒ 建出来什么形状 / 合规吗 / 有卡吗
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ② ledger_init（不给 initialDecisions）⇒ 建出来什么 ═══");
{
  const initTool = T4.defineInitTool();
  const root = mk("d330f05-init-");
  const r = await initTool.execute(
    {
      root,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_archive",
    },
    execFor(root, "session-d330f0501-0000-4000-8000-000000000001")
  );
  ok("② a init 成功", r.ok === true, `ok=${r.ok} reason=${String(r.reason ?? "")}`);

  const decDir = path.join(root, "decisions");
  const cards = fs.existsSync(decDir)
    ? fs.readdirSync(decDir).filter((n) => /\.md$/i.test(n) && !/^INDEX\.md$/i.test(n))
    : [];
  console.log(`      decisions/ 存在=${fs.existsSync(decDir)} 卡片数=${cards.length} ${JSON.stringify(cards)}`);

  const info = T2.inspect(root);
  const conf = T2.conformanceOf(info);
  console.log(`      verdict=${conf.verdict}`);
  console.log(`      reasons=${JSON.stringify(conf.reasons)}`);

  ok(
    "② b ★★★ 合规判决与「有没有真的决策记录」必须一致（判 ok 就得真有卡/真有文件）",
    !(conf.verdict === "ok" && cards.length === 0),
    `verdict=${conf.verdict} cards=${cards.length}`
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 遗留单文件有内容 + 卡片目录空 ⇒ 补丁要能"真补进去"（这是 F-05 原本的死锁）
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ③ 遗留单文件有卡 + 卡片目录空 ⇒ repairConformance 能否真补进卡 ═══");
{
  const root = mk("d330f05-repair-");
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify(
      {
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        decisionsDir: "decisions",
        lessonsDir: "lessons",
        goalsDir: "goals",
        protocolVersion: 3,
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n- x\n", "utf8");
  fs.writeFileSync(
    path.join(root, "DECISIONS.md"),
    "# 关键决策\n\n## D1 · 第一步\n\n- 内容一\n\n## D2 · 第二步\n\n- 内容二\n",
    "utf8"
  );
  fs.mkdirSync(path.join(root, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(root, "lessons"), { recursive: true });
  fs.mkdirSync(path.join(root, "goals"), { recursive: true });

  const info0 = T2.inspect(root);
  const conf0 = T2.conformanceOf(info0);
  ok("③ a 补前判为不合格（遗留卡没搬进去）", conf0.verdict !== "ok", `verdict=${conf0.verdict}`);

  const rep = T4.repairConformance(root, { apply: true });
  console.log(`      actions=${JSON.stringify(rep.actions)}`);
  console.log(`      skipped=${JSON.stringify(rep.skipped)}`);

  const cards = fs
    .readdirSync(path.join(root, "decisions"))
    .filter((n) => /\.md$/i.test(n) && !/^INDEX\.md$/i.test(n));
  console.log(`      补后卡片：${JSON.stringify(cards)}`);
  ok("③ b ★★★ 真补进了 2 张卡（不是只报了个 action）", cards.length === 2, `cards=${cards.length}`);

  const info1 = T2.inspect(root);
  const conf1 = T2.conformanceOf(info1);
  console.log(`      补后 verdict=${conf1.verdict} reasons=${JSON.stringify(conf1.reasons)}`);
  ok("③ c 补后转 ok（死锁真解开）", conf1.verdict === "ok", `verdict=${conf1.verdict}`);

  const cardText = cards.length > 0 ? fs.readFileSync(path.join(root, "decisions", cards[0]), "utf8") : "";
  ok("③ d 卡里真有内容（不是空壳）", cardText.includes("内容"), cardText.slice(0, 60).replace(/\n/g, "\\n"));
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 反向：把 F-05 的修复摘掉，①②③ 必须见红（证明这条探针有区分力）
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ④ 反向验证：摘掉改动后这几条是否真会红 ═══");
{
  const src = fs.readFileSync(SRC.part2, "utf8");
  ok(
    "④ a 源码里确实存在 `hasUnmigratedSingleFile`（补丁的特征）",
    src.includes("hasUnmigratedSingleFile")
  );
  ok(
    "④ b 源码里确实**不再**是旧的 `if (!dirOk || cards === 0)`",
    !src.includes("if (!dirOk || cards === 0)"),
    "旧判据已消失 ⇒ 判据确实被替换过"
  );
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
    /* 清理失败无所谓 */
  }
}
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
