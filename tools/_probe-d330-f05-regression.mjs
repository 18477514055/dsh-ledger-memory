/**
 * _probe-d330-f05-regression.mjs —— 坐实：011 补丁的 F-05 修复**放宽了一条硬约束**
 *
 * ★ 已确认的事实（`_probe-d330-125e-honesty.mjs` ③）：
 *   卡片模式 + `decisions/` 目录在但**一张卡都没有** + 遗留单文件也不存在
 *   ⇒ 补丁之后 `conformanceOf` 判 **ok / reasons=[]**（零条不合格理由）。
 *   而补丁之前那条判据是 `if (!dirOk || cards === 0)` ⇒ **必判不合格**。
 *
 * ★ 本探针要回答三件事（都要能证伪）：
 *   ① 这个放宽**确实是补丁引入的**，不是本来就那样 —— 用 `git show HEAD:lib/part2.js`
 *      取补丁前的原文，在一次性副本上跑同一场景，看它当时是不是红。
 *   ② `ledger_init` 建完但**没给 initialDecisions** 的项目，是不是也判 ok（同样是"零决策记录"）。
 *   ③ 自检里**有没有**任何一条断言守着"空卡片目录必须不合格" ——
 *      如果没有，这次放宽就是**静默的**（没人会红）。
 *
 * ★ 这个方法（把 HEAD 版本落到临时目录再 import）值得记：
 *   它能让"补丁前 / 补丁后"两个版本在**同一份夹具**上对跑，而不是靠读 diff 猜。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

const T2 = await import(pathToFileURL(path.resolve("lib/part2.js")).href);
const T4 = await import(pathToFileURL(path.resolve("lib/part4.js")).href);

const INIT_DECISIONS = "# 关键决策\n\n## D1 · 初始架构拍板\n- 选定 V3 卡片化\n";

function decisionHome(root, T) {
  const info = T.inspect(root);
  const base = T.memoryBaseOf(info, root);
  const m = info.manifest ?? {};
  const decDirRel = typeof m.decisionsDir === "string" ? m.decisionsDir : undefined;
  const dirAbs = decDirRel === undefined ? undefined : path.resolve(base, decDirRel);
  const cards =
    dirAbs !== undefined && fs.existsSync(dirAbs)
      ? fs.readdirSync(dirAbs).filter((n) => /\.md$/i.test(n) && !/^INDEX\.md$/i.test(n))
      : [];
  return { info, base, decDirRel, dirAbs, cards };
}

// ══════════════════════════════════════════════════════════════════════════
// ① 现版（打补丁后）：卡片目录空 ⇒ 判什么
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ① 现版（011 补丁已打）：卡片目录空 + 无遗留单文件 ═══");
const SCEN = (() => {
  const root = mk("d330reg-now-");
  return T4.defineInitTool()
    .execute(
      {
        root,
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_archive",
        decisionsDir: "decisions",
        initialDecisions: INIT_DECISIONS,
      },
      execFor(root, "session-d330reg-0000-4000-8000-000000000001")
    )
    .then(() => root);
})();
const rootNow = await SCEN;
{
  const h = decisionHome(rootNow, T2);
  // 清空：删卡 + 删遗留单文件 ⇒ "零决策记录"
  for (const n of h.cards) fs.rmSync(path.join(h.dirAbs, n), { force: true });
  const base = h.base;
  for (const cand of ["DECISIONS.md"]) {
    const a = path.resolve(base, cand);
    if (fs.existsSync(a)) fs.rmSync(a, { force: true });
  }
  const h2 = decisionHome(rootNow, T2);
  const conf = T2.conformanceOf(h2.info);
  console.log(`      卡片数=${h2.cards.length} verdict=${conf.verdict} reasons=${JSON.stringify(conf.reasons)}`);
  ok(
    "① a ★★★ 现版：零决策记录却判 ok ⇒ 硬约束被放宽（这是 011 补丁引入的）",
    conf.verdict === "ok",
    `verdict=${conf.verdict}（期望 ok —— 用来证明它确实放宽了）`
  );
  ok(
    "① b 而且 reasons 是空的 ⇒ **零告警**，调用方无从察觉",
    Array.isArray(conf.reasons) && conf.reasons.length === 0,
    JSON.stringify(conf.reasons)
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ② 补丁前（HEAD 版本）：同一场景判什么 —— 证明放宽是补丁引入的
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ② 补丁前（git HEAD 的 lib/part2.js）：同一场景 ═══");
{
  // 把 HEAD 的 lib/ 整套落到临时目录（part2 依赖同目录的兄弟模块）
  const stage = mk("d330reg-head-");
  const libDir = path.join(stage, "lib");
  fs.mkdirSync(libDir, { recursive: true });
  const files = fs.readdirSync(path.resolve("lib")).filter((n) => n.endsWith(".js"));
  for (const n of files) {
    const headText = execFileSync("git", ["show", `HEAD:lib/${n}`], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_PROXY: "github.com" },
    });
    fs.writeFileSync(path.join(libDir, n), headText, "utf8");
  }
  fs.writeFileSync(path.join(stage, "package.json"), '{"type":"module"}\n', "utf8");

  const OLD2 = await import(pathToFileURL(path.join(libDir, "part2.js")).href);
  const OLD4 = await import(pathToFileURL(path.join(libDir, "part4.js")).href);

  const root = mk("d330reg-old-");
  await OLD4.defineInitTool().execute(
    {
      root,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_archive",
      decisionsDir: "decisions",
      initialDecisions: INIT_DECISIONS,
    },
    execFor(root, "session-d330reg-0000-4000-8000-000000000002")
  );
  const h = decisionHome(root, OLD2);
  console.log(`      补丁前 init 后卡片=${JSON.stringify(h.cards)}`);
  const confBefore = OLD2.conformanceOf(h.info);
  console.log(`      ★ 补丁前（有卡）verdict=${confBefore.verdict} reasons=${JSON.stringify(confBefore.reasons)}`);

  // 同一场景：清空
  for (const n of h.cards) {
    if (h.dirAbs !== undefined) fs.rmSync(path.join(h.dirAbs, n), { force: true });
  }
  for (const cand of ["DECISIONS.md"]) {
    const a = path.resolve(h.base, cand);
    if (fs.existsSync(a)) fs.rmSync(a, { force: true });
  }
  const h2 = decisionHome(root, OLD2);
  const conf = OLD2.conformanceOf(h2.info);
  console.log(`      补丁前（清空后）卡片数=${h2.cards.length} verdict=${conf.verdict}`);
  console.log(`      reasons=${JSON.stringify(conf.reasons)}`);

  ok(
    "② a ★★★ 补丁前：零决策记录 ⇒ **判不合格**（这就是被放宽掉的那条硬约束）",
    conf.verdict !== "ok",
    `verdict=${conf.verdict}`
  );
  ok(
    "② b 补丁前理由点名了「卡片目录里一张决策卡都没有」",
    conf.reasons.some((x) => /决策卡|卡片目录/.test(String(x))),
    JSON.stringify(conf.reasons)
  );
  ok(
    "② c ★★★ 两版行为不同 ⇒ 放宽确由 011 补丁引入（补丁前红 / 补丁后绿）",
    conf.verdict !== "ok" &&
      T2.conformanceOf(decisionHome(rootNow, T2).info).verdict === "ok",
    `补丁前=${conf.verdict} 补丁后=ok`
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 自检里有没有断言守着"空卡片目录必须不合格"（判它是不是静默放宽）
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ③ 自检是否守着这条 —— 判定「静默放宽」还是「有守卫」═══");
{
  const st = fs.readFileSync(path.resolve("tools/selftest.mjs"), "utf8");
  // 找"卡片目录 + 空 / 零张卡"这类断言的痕迹
  const patterns = [
    /一张决策卡都没有/g,
    /cards === 0/g,
    /卡片目录[^\n]{0,40}空/g,
  ];
  const hits = [];
  for (const re of patterns) {
    const m = st.match(re);
    if (m !== null) hits.push(`${re} ×${m.length}`);
  }
  console.log(`      selftest 里的相关字样：${hits.length === 0 ? "（无）" : hits.join(" · ")}`);

  // 更硬：源码里那条被删掉的判据文本，在 selftest 里有没有对应的"反向断言"
  const hasOldCond = st.includes("if (!dirOk || cards === 0)");
  console.log(`      selftest 里是否还引用旧判据文本：${hasOldCond}`);

  ok(
    "③ a ★★★ 自检里**没有**任何断言守着「卡片目录零张卡必须判不合格」⇒ 这次放宽是静默的",
    hits.length === 0 && hasOldCond === false,
    `hits=${hits.length} oldCond=${hasOldCond}`
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
    /* 无所谓 */
  }
}
console.log("PROBE-COMPLETE");
process.exit(0);
