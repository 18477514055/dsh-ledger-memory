#!/usr/bin/env node
/**
 * 反向验证「审计员010第二份报告（占 011 号位）」的 8 条发现。
 *
 * ★★★ 本探针的纪律（照 D307/D309 的教训来）：
 *   ① **每条都要先能看见红** —— 先证明"当前代码下它确实坏"，才有资格说"修好了"；
 *   ② 不许拿"源码读起来像有缺陷"当证据 —— 必须**真调工具**、真看磁盘；
 *   ③ 每条一个 `mkdtemp` 一次性目录，跑完就删（不共用夹具 ⇒ 互不踩）；
 *   ④ 判据只问「行为对不对」，不问「代码长得像不像报告里那段」。
 *
 * 用法：node tools/_probe-audit011-findings.mjs
 * 退出码：0 = 全部符合预期（缺陷仍存在 / 已修好都算"符合预期"，看 EXPECT）
 *         1 = 有断言不符
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { fakeState } from "./_fake-state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const LIB = path.join(PROJECT, "lib");

const defs = await import(pathToFileURL(path.join(LIB, "defs.js")).href);
const part1 = await import(pathToFileURL(path.join(LIB, "part1.js")).href);
const part2 = await import(pathToFileURL(path.join(LIB, "part2.js")).href);
const part4 = await import(pathToFileURL(path.join(LIB, "part4.js")).href);

const results = [];
const ok = (n, pass, d) => {
  results.push({ n, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${n}${d === undefined || d === "" ? "" : `  —— ${d}`}`);
};

const tmpDirs = [];
function mk(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `audit011-${tag}-`));
  tmpDirs.push(d);
  return d;
}
function cleanup() {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
}

/** 建一个**真 V3 项目**：memoryRoot + 卡片化三类 + 日志 + 归档。 */
async function makeV3(tag, extra = {}) {
  const root = mk(tag);
  const r = await part4.defineInitTool().execute(
    {
      root,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_ledger-archive",
      decisionsDir: "decisions",
      lessonsDir: "lessons",
      goalsDir: "goals",
      logDir: "_ledger-log",
      memoryRoot: "mem-ledger-memory",
      ...extra,
    },
    {}
  );
  if (r?.ok !== true) throw new Error(`夹具没走通（纪律 6：这不是被测对象的问题）：${JSON.stringify(r).slice(0, 300)}`);
  const man = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8"));
  const mem = path.join(root, man.memoryRoot);
  return { root, mem, man, r };
}

/** 往某个 V3 项目里放一套**让它合规**的最小卡片集（否则 baseline 不是 ok，后面的对比全是假绿）。 */
function seedHealthy(mem) {
  for (const i of [1, 2]) {
    fs.writeFileSync(path.join(mem, "decisions", `D19${i}.md`), `# D19${i} · 第${i}条\n\n内容${i}\n`, "utf8");
  }
  fs.writeFileSync(path.join(mem, "lessons", "L1.md"), "# 教训 L1 · 一条\n\n内容\n", "utf8");
  fs.writeFileSync(path.join(mem, "goals", "g1.md"), "# 目标 g1 · 一个\n\n内容\n", "utf8");
}

/** 供工具用的 exec（照 `projectRootOf` 真读的字段给）。 */
function execAt(root) {
  return { agent: { session: { header: { id: "sess-audit011", cwd: root }, eventAt: () => new Date().toISOString() } } };
}

/**
 * ★★★ 合规判据**必须看 reasons 的具体文字**，不能只看 `verdict !== "OK"`。
 *   D307 的教训：`verdict` 变成 `upgradeable` 可能来自**完全无关**的原因（比如代次缺口、
 *   卡片目录空），那样"改 A 导致 B 变红"就是**假因果**。这里要求理由里出现指定关键词。
 */
function verdictMentions(c, re) {
  const all = [...(c?.reasons ?? []), ...(c?.fixable ?? []), ...(c?.needsAI ?? [])].join(" ｜ ");
  return re.test(all);
}

console.log("═".repeat(78));
console.log("反向验证：审计员010 第二份报告（011 号位）的 8 条发现");
console.log("═".repeat(78));

// ═══════════════════════════════════════════════════════════════════════════
// F-01  readEntryUnified 漏用记忆基准 ⇒ V3 下卡片按条读取全灭
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【F-01】readEntryUnified 漏用记忆基准（P0）");
{
  const { root, mem } = await makeV3("f01");
  // 往**记忆目录**里真写一张决策卡（用工具自己的写卡路径，保证形状合法）
  const cardAbs = path.join(mem, "decisions", "D195.md");
  fs.mkdirSync(path.dirname(cardAbs), { recursive: true });
  fs.writeFileSync(cardAbs, "# D195 · 测试决策标题\n\n正文内容 audit011。\n", "utf8");
  const cardExists = fs.existsSync(cardAbs);
  ok("F-01 夹具：卡片真写在**记忆目录**里", cardExists, cardAbs);

  const res = await part4.defineReadTool().execute({ target: "decisions", entry: "D195" }, execAt(root));
  ok(
    "F-01 ★ 按卡片读 D195 能读回来（found === true）",
    res?.found === true,
    `found=${res?.found} mode=${res?.mode} reason=${String(res?.reason ?? "").slice(0, 60)}`
  );
  if (res?.found === true) {
    ok("F-01 正文逐字正确", String(res.text).includes("正文内容 audit011"), String(res.text).slice(0, 40).replace(/\n/g, "\\n"));
    ok("F-01 path 指向记忆目录（不是项目根）", String(res.path).startsWith(mem), String(res.path));
  } else {
    // 修复前的形态：报告说 100% 回 found:false
    console.log("       ↳ 当前处于报告所述缺陷态（V3 下按卡片读必失败）");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-02  ledger_index 基准错误 ⇒ 扫描为 0 且写穿到项目根
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【F-02】ledger_index 基准错误（P0）");
{
  const { root, mem } = await makeV3("f02");
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(path.join(mem, "decisions", `D19${i}.md`), `# D19${i} · 第${i}条\n\n内容${i}\n`, "utf8");
  }
  const tool = part4.defineIndexTool();

  const ro = await tool.execute({ kind: "decisions" }, execAt(root));
  ok("F-02 ★ 只读：扫到的卡片数 > 0", Number(ro?.count) > 0, `count=${ro?.count} rows=${(ro?.rows ?? []).length}`);

  const wr = await tool.execute({ kind: "decisions", op: "write" }, execAt(root));
  const indexPath = wr?.indexPath === undefined ? undefined : String(wr.indexPath);
  ok("F-02 ★ 写盘：INDEX.md 落在**记忆目录**里", indexPath !== undefined && indexPath.startsWith(mem), String(indexPath));
  const rootIdx = path.join(root, "decisions", "INDEX.md");
  ok(
    "F-02 ★ 且**项目根**下没有被写穿出 decisions/INDEX.md",
    !fs.existsSync(rootIdx),
    fs.existsSync(rootIdx) ? `根目录被写穿：${rootIdx}` : "根目录下无此文件（正确）"
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// F-03  splitFileIntoCards 物理穿透 ⇒ 卡片写到项目根
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【F-03】splitFileIntoCards 物理穿透（P0）");
{
  const { root, mem } = await makeV3("f03");
  // 造一个**单文件模式**的 V3 项目（把 decisionsDir 从清单里去掉 = 未卡片化）
  const manAbs = path.join(root, ".dsh-ledger.json");
  const man = JSON.parse(fs.readFileSync(manAbs, "utf8"));
  const manNoCard = { ...man };
  delete manNoCard.decisionsDir;
  fs.writeFileSync(manAbs, `${JSON.stringify(manNoCard, null, 2)}\n`, "utf8");
  // 源单文件放在记忆目录
  fs.writeFileSync(
    path.join(mem, "DECISIONS.md"),
    "# 关键决策\n\n> 头\n\n## D1 · 第一条\n\n正文一\n\n## D2 · 第二条\n\n正文二\n",
    "utf8"
  );
  // ★ 用真实的 `ledger_migrate` 工具跑 split（不是直接调函数 —— 要走完整入口）
  const mig = part4.defineMigrateTool === undefined ? undefined : part4.defineMigrateTool();
  ok("F-03 夹具：有 ledger_migrate 工具可调", mig !== undefined, mig === undefined ? "defineMigrateTool 不在 part4" : "");
  if (mig !== undefined) {
    const res = await mig.execute({ op: "split", kind: "decisions", apply: true }, execAt(root));
    // ★ 断言的数字必须**拆开算**，不许拿"目录里几个 .md"混着数（INDEX.md 也算 .md ⇒ 3 而不是 2）。
    //   我第一版写成 `>0`，本该精确却写成模糊 ⇒ 那等于没断言。
    const names = (dir) =>
      fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /\.md$/i.test(n)) : [];
    const memNames = names(path.join(mem, "decisions"));
    const rootNames = names(path.join(root, "decisions"));
    const memCards = memNames.filter((n) => !/^INDEX\.md$/i.test(n));
    console.log(`       ↳ 回执 ok=${res?.ok} written=${res?.written} dir=${res?.dir}`);
    console.log(`       ↳ 记忆目录：${memNames.join(" | ") || "（空）"}`);
    ok(
      "F-03 ★ 拆出来的卡片**张数精确等于回执 written**，且落在记忆目录",
      res?.written === 2 && memCards.length === 2,
      `written=${res?.written} 记忆目录卡片=${memCards.length}（${memCards.join(",")}）`
    );
    ok("F-03 ★ 且 INDEX.md 也落在记忆目录", memNames.some((n) => /^INDEX\.md$/i.test(n)), memNames.join(","));
    ok(
      "F-03 ★ 且**项目根**没有任何卡片泄漏",
      rootNames.length === 0,
      rootNames.length === 0 ? "项目根 decisions/ 不存在或无文件（正确）" : `泄漏：${rootNames.join(",")}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-04  清单镜像 4 处盲区 + 裸写
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【F-04】清单镜像同步 4 处盲区（P1）");
{
  const { root, mem } = await makeV3("f04");
  const manAbs = path.join(root, ".dsh-ledger.json");
  const mirrorAbs = path.join(mem, ".dsh-ledger.json");
  const same = () =>
    fs.existsSync(mirrorAbs) && fs.readFileSync(manAbs, "utf8") === fs.readFileSync(mirrorAbs, "utf8");
  ok("F-04 夹具：刚 init 完，镜像与根清单一致", same(), same() ? "" : "镜像不存在或不等");

  // ① writeManifestMode（切压缩模式）
  //    ★ 合法值只有 `steady` / `surgical`（`defs.MODES`，已 grep 核实）。
  //      我第一版写了 `"replace"` ⇒ 工具如实回「不认识的模式」⇒ **那是夹具错，不是缺陷**。
  const info0 = part2.inspect(root);
  const wm = part1.writeManifestMode(root, info0, defs.MODE_SURGICAL);
  ok("F-04 writeManifestMode 返回 ok（合法模式 surgical）", wm?.ok === true, JSON.stringify(wm).slice(0, 80));
  ok("F-04 ① 切 mode 后**镜像仍与根一致**", same(), same() ? "" : "镜像 stale ← 盲区");

  // ② registerGoalsInManifest
  if (same()) {
    const info1 = part2.inspect(root);
    part2.registerGoalsInManifest(root, info1, "goals");
    ok("F-04 ② 登记 goals 后**镜像仍与根一致**", same(), same() ? "" : "镜像 stale ← 盲区");
  } else {
    ok("F-04 ② 登记 goals 后**镜像仍与根一致**", false, "上一步已 stale，无法继续判");
  }

  // ③ registerPrinciplesInManifest
  if (same()) {
    const info2 = part2.inspect(root);
    part2.registerPrinciplesInManifest(root, info2, "PRINCIPLES.md");
    ok("F-04 ③ 登记 principles 后**镜像仍与根一致**", same(), same() ? "" : "镜像 stale ← 盲区");
  } else {
    ok("F-04 ③ 登记 principles 后**镜像仍与根一致**", false, "前面已 stale");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-05  migrateToV3 跨卷 renameSync ⇒ EXDEV
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【F-05】migrateToV3 跨卷移动裸用 renameSync（P1）");
{
  // ★ 跨卷能不能测：本机 D: 与 C: 是两个卷。$DSH_HOME 在 C:，探针目录在 %TEMP%（通常 C:）。
  //   ⇒ 要复现 EXDEV，必须让**项目在 D 盘**而 **_retired 在 C 盘**。
  //   ★★ 但纪律：**不许在生产工作区里做破坏性试验**（D-2026-10-19 事故）。
  //   ⇒ 这里只在 D 盘造一个一次性目录，且只造"要搬的旧文件"，`_retired` 由代码自己算（C 盘）。
  const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const homeDrive = path.parse(HOME).root.toUpperCase();
  const tempDrive = path.parse(os.tmpdir()).root.toUpperCase();
  console.log(`       ↳ $DSH_HOME=${HOME}（${homeDrive}） · tmp=${os.tmpdir()}（${tempDrive}）`);

  // 找 D 盘可写的临时位置（不存在就算了 —— 拿不到就不许硬造结论）
  let dBase;
  for (const cand of ["D:\\", "D:\\Deepseek工作区"]) {
    try {
      if (fs.existsSync(cand)) {
        const t = fs.mkdtempSync(path.join(cand, "audit011-f05-"));
        dBase = t;
        break;
      }
    } catch { /* 不可写就换下一个 */ }
  }
  if (dBase === undefined) {
    ok("F-05 能造出 D 盘临时项目（跨卷前提）", false, "D 盘没有可写位置，本条无法判 ⇒ 如实标未测");
  } else {
    tmpDirs.push(dBase);
    const crossDevice = homeDrive !== path.parse(dBase).root.toUpperCase();
    ok("F-05 夹具：项目在 D 盘、_retired 在另一卷", crossDevice, `${path.parse(dBase).root} vs ${homeDrive}`);
    if (crossDevice) {
      // 造一个 V2 项目（有单文件记忆），然后用真 migrateToV3 往 V3 迁
      const mig = part4.defineMigrateTool === undefined ? undefined : part4.defineMigrateTool();
      // 先手工铺一个 V2 清单 + 记忆文件（migrateToV3 要能认出"旧文件"）
      const led = "# 台账\n\n内容\n";
      fs.writeFileSync(path.join(dBase, "LEDGER.md"), led, "utf8");
      fs.writeFileSync(path.join(dBase, "DECISIONS.md"), "## D1 · 一\n\n正文\n", "utf8");
      fs.writeFileSync(
        path.join(dBase, ".dsh-ledger.json"),
        `${JSON.stringify({
          protocolVersion: 2,
          active: "LEDGER.md",
          decisions: "DECISIONS.md",
          archiveDir: "_ledger-archive",
          decisionsDir: "decisions",
          lessonsDir: "lessons",
          goalsDir: "goals",
          logDir: "_ledger-log",
          revision: 1,
        }, null, 2)}\n`,
        "utf8"
      );
      // ★ 直接调底层函数（工具入口要用户确认，且这里要精确控制 apply）
      const r = await part7Migrate(dBase);
      console.log(`       ↳ 迁移回执：ok=${r?.ok} retireFailed=${String(r?.retireFailed ?? "无").slice(0, 120)}`);
      ok(
        "F-05 ★ 跨卷搬旧文件**不因 EXDEV 失败**（retireFailed 空）",
        r?.retireFailed === undefined,
        r?.retireFailed === undefined ? "旧文件已搬走" : `retireFailed=${String(r.retireFailed).slice(0, 100)}`
      );
      if (r?.retireFailed !== undefined) {
        // 报告说的严重后果：双权威源
        const bothExist = fs.existsSync(path.join(dBase, "DECISIONS.md"));
        console.log(`       ↳ 双权威源：项目根 DECISIONS.md 是否仍在 = ${bothExist}`);
      }
    }
  }
}

/** `migrateToV3(projectRoot, opts)` —— 真源在 `part7.js:116`（已 grep 核实，不猜）。 */
async function part7Migrate(root) {
  const m = await import(pathToFileURL(path.join(LIB, "part7.js")).href);
  if (typeof m.migrateToV3 !== "function") {
    throw new Error("找不到 migrateToV3 —— 探针自己的问题，不是被测对象");
  }
  return m.migrateToV3(root, { apply: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// F-06  根本原则型扩展无法被写入（机制死胡同）
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【F-06】原则型扩展无法被任何人写入（P1）");
{
  // ★★★★★ 2026-10-23（D311）：**这条已由用户拍板用"丙"解决** —— 去掉「原则型」扩展模式。
  //   ⇒ 原来那 4 条（"存在合法写入路径"/"面板有正文录入"/"有授权卡"）**已经不再适用**：
  //     那个模式不存在了，就没有"它的写入路径"这回事。
  //   ★ 判据：**当被问的东西被删掉时，"它修好了吗"这个问题本身失效。**
  //     继续留红会把"已决定不做"误报成"还有个活缺陷" —— 那是在报告里制造假工作。
  //   ⇒ 现在守的是**三件确定的事**：它真的没了 · 建不出来 · 写不了。
  const { root } = await makeV3("f06");
  const p8 = await import(pathToFileURL(path.join(LIB, "part8tool.js")).href);
  const p8core = await import(pathToFileURL(path.join(LIB, "part8.js")).href);
  const ext = p8.defineExtensionTool(fakeState());
  ok("F-06 夹具：有 ledger_extension 工具", ext !== undefined, "");

  // ① 模式枚举里没有 principles（D311 之后这是**正确状态**）
  ok(
    "F-06 ★★★ 模式枚举里**没有** principles（D311 已去掉；这是**正确状态**不是缺陷）",
    !p8core.EXT_MODE_KEYS.includes("principles"),
    JSON.stringify(p8core.EXT_MODE_KEYS)
  );

  // ② 想建它建不出来（明确被拒，而不是静默当成 plain）
  const cr = await ext.execute(
    { op: "create", id: "p-pr", name: "测试原则型", description: "审计用", mode: "principles" },
    execAt(root)
  );
  ok(
    "F-06 ★ 传 mode:\"principles\" 新建 ⇒ **明确被拒**，理由里列出合法模式",
    cr?.ok === false && /必须是这些之一/.test(String(cr?.reason)),
    `${cr?.ok} / ${String(cr?.reason ?? "").slice(0, 80)}`
  );

  // ③ 对一个不存在的扩展 write ⇒ 明确拒绝（不崩）
  const wr = await ext.execute({ op: "write", id: "p-pr", content: "x" }, execAt(root));
  ok("F-06 且对不存在的扩展 write ⇒ 明确拒绝（不抛异常）", wr?.ok === false, String(wr?.reason ?? "").slice(0, 60));

  console.log("       ↳ 结论：F-06 **已由 D311 闭环**（用户选丙：去掉该模式）—— 不是「未修」，是「经决定不做」。");
}

// ═══════════════════════════════════════════════════════════════════════════
// F-07  conformanceOf 对 V3 核心机制免检
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【F-07】conformanceOf 对 V3 核心机制免检（P1）");
{
  // ★★★ 判据必须做**差分**：先证明 baseline 是 ok（否则 `verdict !== ok` 可能来自
  //   完全无关的原因 —— 我第一版就栽在这里，四条全是假绿：唯一 reason 是"卡片目录空"）。
  const { root, mem } = await makeV3("f07");
  seedHealthy(mem);
  const c0 = part2.conformanceOf(part2.inspect(root));
  ok("F-07 ★ 夹具：健康 V3 项目 baseline 必须是 ok（差分前提）", c0?.verdict === "ok", `verdict=${c0?.verdict} reasons=${JSON.stringify(c0?.reasons)}`);

  if (c0?.verdict === "ok") {
    // ① 删 SECURITY.md
    const secPath = path.join(mem, "SECURITY.md");
    const secHad = fs.existsSync(secPath);
    ok("F-07 夹具：SECURITY.md 原来存在", secHad, secPath);
    if (secHad) fs.rmSync(secPath, { force: true });
    const c1 = part2.conformanceOf(part2.inspect(root));
    ok(
      "F-07 ① 删掉 SECURITY.md 后合规**应**报出（理由里要提 SECURITY）",
      c1?.verdict !== "ok" && verdictMentions(c1, /SECURITY|安全/i),
      `verdict=${c1?.verdict} reasons=${JSON.stringify(c1?.reasons)}`
    );
  }

  // ② 镜像 stale
  {
    const { root: r2, mem: m2 } = await makeV3("f07b");
    seedHealthy(m2);
    const b = part2.conformanceOf(part2.inspect(r2));
    ok("F-07 ② 夹具 baseline ok", b?.verdict === "ok", `verdict=${b?.verdict} reasons=${JSON.stringify(b?.reasons)}`);
    const manAbs = path.join(r2, ".dsh-ledger.json");
    const man = JSON.parse(fs.readFileSync(manAbs, "utf8"));
    fs.writeFileSync(manAbs, `${JSON.stringify({ ...man, revision: 999 }, null, 2)}\n`, "utf8");
    const mirrorAbs = path.join(m2, ".dsh-ledger.json");
    const mirrorRev = fs.existsSync(mirrorAbs) ? JSON.parse(fs.readFileSync(mirrorAbs, "utf8")).revision : "<无镜像>";
    ok("F-07 ② 夹具：镜像确实已经 stale", String(mirrorRev) !== "999", `镜像 revision=${mirrorRev} / 根=999`);
    const c2 = part2.conformanceOf(part2.inspect(r2));
    ok(
      "F-07 ② 镜像 stale 后合规**应**报出（理由里要提镜像/清单）",
      c2?.verdict !== "ok" && verdictMentions(c2, /镜像|mirror|清单/i),
      `verdict=${c2?.verdict} reasons=${JSON.stringify(c2?.reasons)}`
    );
  }

  // ③ 路径越界
  {
    const { root: r3, mem: m3 } = await makeV3("f07c");
    seedHealthy(m3);
    const manAbs = path.join(r3, ".dsh-ledger.json");
    const man = JSON.parse(fs.readFileSync(manAbs, "utf8"));
    const bad = { ...man, decisionsDir: "../outside" };
    fs.writeFileSync(manAbs, `${JSON.stringify(bad, null, 2)}\n`, "utf8");
    // ★ 夹具卫生：改完根清单要**同步镜像**，否则会多出一条"镜像不同步"的理由，
    //   把"越界"这一条淹掉 ⇒ 断言虽然过，但证据不纯（我第一版就是这样）。
    fs.writeFileSync(path.join(m3, ".dsh-ledger.json"), `${JSON.stringify(bad, null, 2)}\n`, "utf8");
    const info3 = part2.inspect(r3);
    const unsafe = (info3?.unsafePaths ?? []).length;
    ok("F-07 夹具：inspect 认出了越界路径", unsafe > 0, `unsafePaths=${JSON.stringify(info3?.unsafePaths)}`);
    const c3 = part2.conformanceOf(info3);
    const onlyAboutPath = !verdictMentions(c3, /镜像|gitignore|SECURITY/i);
    ok("F-07 ③ 夹具：理由里**只有路径问题**（不被别的干扰项淹掉）", onlyAboutPath, JSON.stringify(c3?.reasons));
    ok(
      "F-07 ③ 路径越界后合规**应**报出（理由里要提越界/路径）",
      c3?.verdict !== "ok" && verdictMentions(c3, /越界|逃出|路径/i),
      `verdict=${c3?.verdict} reasons=${JSON.stringify(c3?.reasons)}`
    );
  }

  // ④ .gitignore 缺记忆目录规则
  {
    const { root: r4, mem: m4 } = await makeV3("f07d");
    seedHealthy(m4);
    const b = part2.conformanceOf(part2.inspect(r4));
    ok("F-07 ④ 夹具 baseline ok", b?.verdict === "ok", `verdict=${b?.verdict}`);
    fs.writeFileSync(path.join(r4, ".gitignore"), "# 什么都没有\n", "utf8");
    const c4 = part2.conformanceOf(part2.inspect(r4));
    ok(
      "F-07 ④ .gitignore 缺记忆目录规则后合规**应**报出（理由里要提 gitignore）",
      c4?.verdict !== "ok" && verdictMentions(c4, /gitignore|忽略/i),
      `verdict=${c4?.verdict} reasons=${JSON.stringify(c4?.reasons)}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-08  ledger_status 不回显 protocolVersion
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【F-08】ledger_status 不回显 protocolVersion（P2）");
{
  const { root } = await makeV3("f08");
  const part3 = await import(pathToFileURL(path.join(LIB, "part3.js")).href);
  const st = part3.defineStatusTool({ get: () => undefined }, fakeState());
  const res = await st.execute({ root }, execAt(root));
  const keys = Object.keys(res ?? {});
  console.log(`       ↳ 回显字段：${keys.join(", ")}`);
  ok("F-08 ★ 回显里有 protocolVersion", "protocolVersion" in (res ?? {}), `值=${res?.protocolVersion}`);
  ok(
    "F-08 ★ 回显里有 effectiveVersion（有效代次）",
    "effectiveVersion" in (res ?? {}) || "effectiveProtocolVersion" in (res ?? {}),
    `值=${res?.effectiveVersion ?? res?.effectiveProtocolVersion}`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
cleanup();
console.log("\n" + "═".repeat(78));
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`合计：PASS ${pass} / FAIL ${fail}（共 ${results.length} 条）`);
if (fail > 0) {
  console.log("\n未通过：");
  for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.n}`);
}
console.log("═".repeat(78));
process.exit(fail === 0 ? 0 : 1);
