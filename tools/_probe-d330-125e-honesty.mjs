/**
 * _probe-d330-125e-honesty.mjs —— D330 补丁里 `125⑤` 这条断言**名实是否相符**
 *
 * ★ 起因：我复核 F-05 时发现一个可疑处。
 *   补丁把 `ledger_init` 里建卡片目录那段改成：
 *       for (const [dirRel, initRaw, kindKey] of [...]) {
 *         if (dirRel === "") continue;          ← 没给 decisionsDir 就直接跳过
 *         ...
 *         if (initRaw 非空 && listCards(...)===0) { splitIntoCardParts / writeCard }
 *       }
 *   而 `125⑤` 的**断言名叫**「默认 V3 ledger_init 将 initialDecisions 同步落入 decisions/ 卡片目录，
 *   且生来即为合规」，可它 `execute()` 的参数里**只给了 initialDecisions，没给 decisionsDir**。
 *
 * ★ 要回答的问题（用行为，不读注释）：
 *   ① 125⑤ 的调用形状下，决策记忆到底住在哪？是卡片目录还是单文件？
 *   ② 它的 `conf.verdict==="ok"` 是因为"切卡真发生了"，还是因为走了单文件模式？
 *   ③ 显式给 decisionsDir 时，切卡是否真的发生？（证明 ① 不是环境问题）
 *
 * ★★ 夹具纪律（本案第 3 次踩）：**V3 的记忆基准不是项目根** ——
 *   `memoryBaseOf(info, root)` 会返回 `<root>/<name>-ledger-memory/`。
 *   所以"文件在哪"必须问 `memoryBaseOf`，**不能拿 root 直接拼**
 *   （我第一版就是这么错的：去看 `root/decisions` 当然不存在 ⇒ 假红 3 条）。
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
  return { agent: { session: { header: { cwd: root, id: sid } } } };
}

const T2 = await import(pathToFileURL(SRC.part2).href);
const T4 = await import(pathToFileURL(SRC.part4).href);

/** ★ 唯一正确的"决策记忆住哪"取法：问 inspect + memoryBaseOf。 */
function decisionHome(root) {
  const info = T2.inspect(root);
  const base = T2.memoryBaseOf(info, root);
  const m = info.manifest ?? {};
  const decDirRel = typeof m.decisionsDir === "string" ? m.decisionsDir : undefined;
  const decFileRel = typeof m.decisions === "string" ? m.decisions : undefined;
  const dirAbs = decDirRel === undefined ? undefined : path.resolve(base, decDirRel);
  const fileAbs = decFileRel === undefined ? undefined : path.resolve(base, decFileRel);
  const cards =
    dirAbs !== undefined && fs.existsSync(dirAbs)
      ? fs.readdirSync(dirAbs).filter((n) => /\.md$/i.test(n) && !/^INDEX\.md$/i.test(n))
      : [];
  return { info, base, decDirRel, decFileRel, dirAbs, fileAbs, cards };
}

const INIT_DECISIONS = "# 关键决策\n\n## D1 · 初始架构拍板\n- 选定 V3 卡片化\n";

// ══════════════════════════════════════════════════════════════════════════
// ① 125⑤ 原样调用（只给 initialDecisions，**不给** decisionsDir）
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ① 125⑤ 原样调用（不给 decisionsDir）═══");
{
  const root = mk("d330h-125e-");
  const initRes = await T4.defineInitTool().execute(
    {
      root,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_archive",
      initialDecisions: INIT_DECISIONS,
    },
    execFor(root, "session-d330h125e-0000-4000-8000-000000000001")
  );
  const readRes = await T4.defineReadTool().execute(
    { root, target: "decisions", entry: "D1" },
    execFor(root, "session-d330h125e-0000-4000-8000-000000000001")
  );
  const h = decisionHome(root);
  const conf = T2.conformanceOf(h.info);

  console.log(`      init.ok=${initRes.ok}`);
  console.log(`      memoryBase=${h.base}`);
  console.log(`      清单 decisionsDir=${JSON.stringify(h.decDirRel)} decisions=${JSON.stringify(h.decFileRel)}`);
  console.log(`      read.found=${readRes.found}`);
  console.log(`      conf.verdict=${conf.verdict} reasons=${JSON.stringify(conf.reasons)}`);
  console.log(`      卡片目录存在=${h.dirAbs !== undefined && fs.existsSync(h.dirAbs)} 卡片数=${h.cards.length}`);
  console.log(`      单文件存在=${h.fileAbs !== undefined && fs.existsSync(h.fileAbs)}`);

  ok(
    "① a ★★★ 125⑤ 声称「同步落入 decisions/ 卡片目录」，但它没给 decisionsDir ⇒ 该目录压根不该存在",
    !(h.dirAbs !== undefined && fs.existsSync(h.dirAbs)),
    `dirExists=${h.dirAbs !== undefined && fs.existsSync(h.dirAbs)}`
  );
  ok(
    "① b ★★★ 它判 ok 走的是**单文件模式**（decisionsDir 未登记）",
    h.decDirRel === undefined && h.info.decisionsRel !== undefined,
    `decisionsDir=${JSON.stringify(h.decDirRel)} decisionsRel=${JSON.stringify(h.info.decisionsRel)}`
  );
  ok(
    "① c 因此这条断言**没有测到它名字里声称的那件事**（切卡落目录）",
    h.info.decisionsRel !== undefined && h.dirAbs === undefined,
    "名字说有卡落目录，实际走单文件 ⇒ 名实不符"
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ② 显式给 decisionsDir ⇒ 切卡是否真的发生（正向对照）
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ② 显式给 decisionsDir ⇒ 切卡真的会发生吗 ═══");
{
  const root = mk("d330h-card-");
  const initRes = await T4.defineInitTool().execute(
    {
      root,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_archive",
      decisionsDir: "decisions",
      initialDecisions: INIT_DECISIONS,
    },
    execFor(root, "session-d330h125e-0000-4000-8000-000000000002")
  );
  const h = decisionHome(root);
  const conf = T2.conformanceOf(h.info);
  console.log(`      init.ok=${initRes.ok} reason=${String(initRes.reason ?? "")}`);
  console.log(`      decisionsDir=${JSON.stringify(h.decDirRel)}`);
  console.log(`      卡片目录=${h.dirAbs} 存在=${h.dirAbs !== undefined && fs.existsSync(h.dirAbs)}`);
  console.log(`      卡片=${JSON.stringify(h.cards)}`);
  console.log(`      conf.verdict=${conf.verdict} reasons=${JSON.stringify(conf.reasons)}`);

  ok("② a 卡片目录建出来了", h.dirAbs !== undefined && fs.existsSync(h.dirAbs), `${h.dirAbs}`);
  ok("② b ★★★ 真切出了 D1 这张卡", h.cards.length > 0, JSON.stringify(h.cards));
  ok(
    "② c 卡里真有内容（不是空壳）",
    h.cards.length > 0 &&
      fs.readFileSync(path.join(h.dirAbs, h.cards[0]), "utf8").includes("初始架构拍板"),
    h.cards.length > 0
      ? fs.readFileSync(path.join(h.dirAbs, h.cards[0]), "utf8").slice(0, 60).replace(/\n/g, "\\n")
      : ""
  );
  ok("② d 卡片模式下仍判合规", conf.verdict === "ok", `verdict=${conf.verdict} reasons=${JSON.stringify(conf.reasons)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 卡片模式 + 把卡删空 ⇒ conformanceOf 必须变红（守四条硬约束）
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ③ 卡片模式 + 把卡删空 ⇒ conformanceOf 必须变红 ═══");
{
  const root = mk("d330h-empty-");
  const r0 = await T4.defineInitTool().execute(
    {
      root,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_archive",
      decisionsDir: "decisions",
      initialDecisions: INIT_DECISIONS,
    },
    execFor(root, "session-d330h125e-0000-4000-8000-000000000003")
  );
  ok("③ 0 夹具 init 成功", r0.ok === true, `reason=${String(r0.reason ?? "")}`);

  const h = decisionHome(root);
  const confBefore = T2.conformanceOf(h.info);
  ok(
    "③ 0b 夹具：建好即合规（有基线）",
    confBefore.verdict === "ok",
    `verdict=${confBefore.verdict} reasons=${JSON.stringify(confBefore.reasons)}`
  );

  for (const n of h.cards) fs.rmSync(path.join(h.dirAbs, n), { force: true });
  if (h.fileAbs !== undefined) fs.rmSync(h.fileAbs, { force: true });

  const h2 = decisionHome(root);
  const confAfter = T2.conformanceOf(h2.info);
  console.log(`      删空后 cards=${h2.cards.length} verdict=${confAfter.verdict}`);
  console.log(`      reasons=${JSON.stringify(confAfter.reasons)}`);
  ok(
    "③ a ★★★ 卡片目录空 + 无遗留单文件 ⇒ 必须判不合格（四条硬约束不许被放宽）",
    confAfter.verdict !== "ok",
    `verdict=${confAfter.verdict}`
  );
  ok(
    "③ b 理由里必须点名「决策卡 / 卡片目录」",
    confAfter.reasons.some((x) => /决策卡|卡片目录/.test(String(x))),
    JSON.stringify(confAfter.reasons)
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
