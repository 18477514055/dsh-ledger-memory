#!/usr/bin/env node
/**
 * ★★★★★ 反向验证 GPT 静态审查 001 的 4 条 P1（D313）。
 *
 * 报告：`docs/GPT静态审查报告001.txt`，审计提交 6dcd05c（= v1.6.0 发布版）。
 *
 * ★★★ 本探针的纪律：
 *   ① **每条都要先能看见红**（先证明"当前代码确实坏"），才有资格说"修好了"；
 *   ② 不许拿"源码读起来像有缺陷"当证据 —— 必须真调、真看磁盘；
 *   ③ 每条一个 `mkdtemp`（互不踩）；
 *   ④ 判据只问「行为对不对」。
 *
 * ★ 特别声明：F03 / F04 针对的是**我 2026-10-23 当天写的代码**
 *   （`v3-conformance.js` 的 gitignore 匹配 / `card-ops.js` 的登记调用）。
 *   这两条能成立，说明"自己写的东西自己审"有盲区 —— 值得记。
 *
 * 用法：node tools/_probe-gpt001-findings.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "..");
const LIB = path.join(PROJECT, "lib");

const results = [];
const ok = (n, pass, d) => {
  results.push({ n, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${n}${d === undefined || d === "" ? "" : `  —— ${d}`}`);
};

const tmpDirs = [];
const mk = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `gpt001-${tag}-`));
  tmpDirs.push(d);
  return d;
};
const cleanup = () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
};

console.log("═".repeat(80));
console.log("反向验证：GPT 静态审查 001 的 4 条 P1（审计提交 6dcd05c / v1.6.0）");
console.log("═".repeat(80));

// ═══════════════════════════════════════════════════════════════════════════
// F03  .gitignore 的 `!` 否定规则被当成有效保护（假绿）
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【F03】gitignore：`!mem/`（取消忽略）被当成有效保护（P1）");
{
  const { v3ConformanceGaps } = await import(pathToFileURL(path.join(LIB, "v3-conformance.js")).href);
  const p2 = await import(pathToFileURL(path.join(LIB, "part2.js")).href);

  /** 造一个"除 gitignore 外全部合规"的 V3 项目。 */
  const makeHealthy = async (tag, gitignoreText) => {
    const root = mk(tag);
    const p4 = await import(pathToFileURL(path.join(LIB, "part4.js")).href);
    const r = await p4.defineInitTool().execute(
      {
        root,
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_ledger-archive",
        decisionsDir: "decisions",
        lessonsDir: "lessons",
        goalsDir: "goals",
        logDir: "_ledger-log",
        memoryRoot: "mem-memory",
      },
      {}
    );
    if (r?.ok !== true) throw new Error(`夹具没走通：${JSON.stringify(r).slice(0, 200)}`);
    const mem = path.join(root, "mem-memory");
    // 放一套最小卡片（让 baseline 合规）
    for (const i of [1, 2]) fs.writeFileSync(path.join(mem, "decisions", `D19${i}.md`), `# D19${i} · t\n\nx\n`, "utf8");
    fs.writeFileSync(path.join(mem, "lessons", "L1.md"), "# 教训 L1 · t\n\nx\n", "utf8");
    fs.writeFileSync(path.join(mem, "goals", "g1.md"), "# 目标 g1 · t\n\nx\n", "utf8");
    // 覆盖 gitignore
    if (gitignoreText !== undefined) fs.writeFileSync(path.join(root, ".gitignore"), gitignoreText, "utf8");
    return { root, mem };
  };

  // ① 基线：正确规则 `/mem-memory/` ⇒ 不该报 gitignore 问题
  {
    const { root } = await makeHealthy("f03-ok", "mem-memory/\n");
    const gaps = v3ConformanceGaps(p2.inspect(root), { memoryBaseOf: p2.memoryBaseOf });
    const mentionsGi = (gaps.reasons ?? []).some((r) => /gitignore|忽略/i.test(r));
    ok("F03-① 基线：写了 `mem-memory/` ⇒ **不**报 gitignore", !mentionsGi, JSON.stringify(gaps.reasons));
  }

  // ② ★ 核心：`!mem-memory/`（**取消忽略**）⇒ 必须报出来
  {
    const { root } = await makeHealthy("f03-neg", "!mem-memory/\n");
    // 先证"这条规则在 Git 里确实是取消忽略"（用真 git 验，不靠我的理解）
    let gitSaysIgnored;
    try {
      execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" });
      fs.writeFileSync(path.join(root, "mem-memory", "probe.txt"), "x", "utf8");
      // `git check-ignore` 退出码 0 = 被忽略；1 = 不被忽略
      try {
        execFileSync("git", ["check-ignore", "-q", "mem-memory/probe.txt"], { cwd: root, stdio: "pipe" });
        gitSaysIgnored = true;
      } catch {
        gitSaysIgnored = false;
      }
    } catch {
      gitSaysIgnored = undefined; // git 不可用
    }
    ok(
      "F03-② 夹具前提：`!mem-memory/` 在 Git 里**确实不被忽略**（用真 git 验）",
      gitSaysIgnored === false || gitSaysIgnored === undefined,
      gitSaysIgnored === undefined ? "（git 不可用，跳过前提验证）" : `git check-ignore 说被忽略=${gitSaysIgnored}`
    );

    const gaps = v3ConformanceGaps(p2.inspect(root), { memoryBaseOf: p2.memoryBaseOf });
    const mentionsGi = (gaps.reasons ?? []).some((r) => /gitignore|忽略/i.test(r));
    ok(
      "F03-② ★★★ `!mem-memory/`（取消忽略）⇒ 合规**必须**报出 gitignore 问题",
      mentionsGi,
      mentionsGi ? "已报出" : `⛔ 没报 ⇒ 假绿（reasons=${JSON.stringify(gaps.reasons)}）`
    );
  }

  // ③ 先忽略后否定（`mem-memory/` 然后 `!mem-memory/`）⇒ 净效果是不忽略 ⇒ 必须报
  {
    const { root } = await makeHealthy("f03-neg2", "mem-memory/\n!mem-memory/\n");
    const gaps = v3ConformanceGaps(p2.inspect(root), { memoryBaseOf: p2.memoryBaseOf });
    const mentionsGi = (gaps.reasons ?? []).some((r) => /gitignore|忽略/i.test(r));
    ok(
      "F03-③ ★ 后面一条 `!` 覆盖掉前面的忽略 ⇒ **必须**报出（顺序/覆盖关系）",
      mentionsGi,
      mentionsGi ? "已报出" : `⛔ 没报 ⇒ 只看"有没有那一行"是不够的（reasons=${JSON.stringify(gaps.reasons)}）`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F04  卡片迁移在清单登记失败时误报成功
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【F04】拆卡登记失败时仍返回 ok:true（P1）");
{
  const p4 = await import(pathToFileURL(path.join(LIB, "part4.js")).href);
  const p2 = await import(pathToFileURL(path.join(LIB, "part2.js")).href);

  // ★★★ 关键教训（我在这条上连错两次）：
  //   第一次把清单换成目录 ⇒ split 在**读清单**那步就失败（"没有登记单文件"），
  //   根本没走到登记环节 ⇒ F04-② 假红。
  //   ★ 根因：`splitFileIntoCards` 的 `mode.fileRel` 来自 `inspect(root)` —— **它要读清单**。
  //     把清单弄坏 ⇒ 它连"该迁谁"都不知道。
  //   ⇒ **正确的失败注入点**：让**清单可读**，但让**写清单**失败。
  //     手法：清单文件正常，但把**它的父目录**里的目标换成…… 不行（同名）。
  //   ⇒ 改用**直接调用底层函数**来验契约（这才是 F04 的实质）：
  //     ① `registerCardDirInManifest` 必须返回 `{ok:false}`（而不是静默）；
  //     ② `splitFileIntoCards` 必须**看那个返回值**（静态+行为双证）。
  //     ★ 为什么这样仍然有效：F04 的病**就在这两处之间**，我测的正是那个接缝。
  //       用 monkey-patch 拦截 `writeManifestSynced`？不 —— 那测的是我的补丁。
  //       正解：**让 writeManifestSynced 因文件系统原因失败**，而这可以做到：
  //       把清单路径的**临时文件前缀**变成不可写…… 在 Windows 上靠不住。
  //   ⇒ 最终采用：**把清单文件的父目录设成只读是不行的**；
  //     改用一个**必然失败**的清单状态：让 `.dsh-ledger.json` 变成一个**目录**，
  //     但**先**把 `info` 取好、**再**换成目录、**最后**直接调 `splitFileIntoCards(root, info, ...)`
  //     —— `info` 已经拿到（cardModeOf 有值），写盘时才会失败。**这就精确命中了 F04。**
  const root = mk("f04");
  {
    const r = await p4.defineInitTool().execute(
      {
        root, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive",
        decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals", logDir: "_ledger-log",
        memoryRoot: "mem-memory",
      },
      {}
    );
    if (r?.ok !== true) throw new Error(`F04 夹具没走通：${JSON.stringify(r).slice(0, 200)}`);
  }
  const mem = path.join(root, "mem-memory");
  const manAbs = path.join(root, ".dsh-ledger.json");

  // 做一个"未卡片化"的 V3 项目：删掉 decisionsDir，让 split 有活干
  const man0 = JSON.parse(fs.readFileSync(manAbs, "utf8"));
  const manNoCard = { ...man0 };
  delete manNoCard.decisionsDir;
  fs.writeFileSync(manAbs, `${JSON.stringify(manNoCard, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(mem, "DECISIONS.md"), "# 关键决策\n\n## D1 · 一\n\n正文一\n\n## D2 · 二\n\n正文二\n", "utf8");

  // ★ 先取 info（此时清单可读、cardModeOf 正常）
  const infoSnap = p2.inspect(root);
  // ★ 再把清单路径换成"非空目录"（rename 无法覆盖）
  const bakAbs = `${manAbs}.bak`;
  fs.renameSync(manAbs, bakAbs);
  fs.mkdirSync(manAbs);
  fs.writeFileSync(path.join(manAbs, "keep.txt"), "占位，让目录非空", "utf8");

  // ★ 直接调底层函数（info 是**换目录之前**取的那份 ⇒ cardModeOf 有值，写盘必失败）
  const co = await import(pathToFileURL(path.join(LIB, "card-ops.js")).href);
  const res = co.splitFileIntoCards(root, infoSnap, "decisions", { apply: true });

  // 还原（便于清理）
  try {
    fs.rmSync(manAbs, { recursive: true, force: true });
    fs.renameSync(bakAbs, manAbs);
  } catch { /* 清理用 */ }

  console.log(`       ↳ 回执：ok=${res?.ok} written=${res?.written} reason=${String(res?.reason ?? "").slice(0, 90)}`);
  ok(
    "F04 ★★★ 清单写入失败时，拆卡**不得**返回 ok:true（否则误报完整成功）",
    res?.ok !== true,
    res?.ok === true ? "⛔ 仍报 ok:true ⇒ 卡片写了但清单没登记，而调用方以为迁移完成" : "已如实报失败"
  );
  // ② 即使报失败，已写出的卡片应保留（不做未经确认的破坏性回滚）
  const cardsAfter = fs.existsSync(path.join(mem, "decisions"))
    ? fs.readdirSync(path.join(mem, "decisions")).filter((n) => /\.md$/i.test(n) && !/^INDEX\.md$/i.test(n))
    : [];
  ok(
    "F04-② 且已写出的卡片**保留**（不做未经确认的破坏性回滚）",
    cardsAfter.length > 0,
    `${cardsAfter.length} 张：${cardsAfter.join(",")}`
  );
  // ③ 原始单文件也应保留（它是迁移前快照）
  ok(
    "F04-③ 且原始单文件仍完整（迁移前快照不删）",
    fs.existsSync(path.join(mem, "DECISIONS.md")),
    path.join(mem, "DECISIONS.md")
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// F01  ledger_init 可通过符号链接写出记忆目录
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【F01】ledger_init 经符号链接写出记忆目录（P1）");
{
  const p4 = await import(pathToFileURL(path.join(LIB, "part4.js")).href);
  const root = mk("f01");
  const outside = mk("f01-outside"); // 项目外的真实目录
  fs.mkdirSync(path.join(root, "mem-memory"), { recursive: true });

  // 在 mem/ 里造一个指向项目外的符号链接
  let linked = false;
  try {
    fs.symlinkSync(outside, path.join(root, "mem-memory", "escape"), "junction");
    linked = true;
  } catch (e) {
    console.log(`       ↳ 符号链接建不出来（${String(e?.message ?? e).slice(0, 80)}）⇒ 本条如实标未测`);
  }

  if (!linked) {
    ok("F01 夹具：能在 mem/ 里建符号链接", false, "建不出来 ⇒ 本条无法判定，如实标未测");
  } else {
    const manAbs = path.join(root, ".dsh-ledger.json");
    fs.writeFileSync(
      manAbs,
      `${JSON.stringify({
        protocolVersion: 3, active: "LEDGER.md", decisions: "DECISIONS.md",
        archiveDir: "_ledger-archive", memoryRoot: "mem-memory", revision: 0,
      }, null, 2)}\n`,
      "utf8"
    );
    const init = p4.defineInitTool();
    // ★ `ledger_init` 的失败形态是 **throw**（`fail()` 造 Error）而不是 `{ok:false}` ——
    //   所以这里必须 try/catch。★ 我第一版只判 `res?.ok !== true` ⇒ 修复后它抛异常，
    //   整个探针崩掉（而不是记一条 PASS）。**判"拒绝"要看两种形态：返回值 与 抛异常。**
    let res;
    let threw;
    try {
      res = await init.execute(
        {
          root, active: "escape/LEDGER.md", decisions: "DECISIONS.md",
          archiveDir: "_ledger-archive", logDir: "_ledger-log", memoryRoot: "mem-memory",
        },
        {}
      );
    } catch (e) {
      threw = String(e?.message ?? e);
    }
    const escaped = fs.existsSync(path.join(outside, "LEDGER.md"));
    const rejected = res?.ok !== true;
    console.log(`       ↳ 回执 ok=${res?.ok} threw=${threw === undefined ? "否" : "是"}`);
    if (threw !== undefined) console.log(`       ↳ 拒绝理由：${threw.slice(0, 160)}`);
    console.log(`       ↳ 项目外 ${outside} 里出现 LEDGER.md = ${escaped}`);
    ok(
      "F01 ★★★ 经符号链接指向项目外时，ledger_init **必须拒绝**（返回值或抛异常都算）",
      rejected,
      rejected ? (threw === undefined ? "已拒绝（返回 ok:false）" : "已拒绝（抛异常）") : "⛔ 仍报 ok:true"
    );
    ok(
      "F01-② ★★★ 且**项目外不得产生文件**",
      !escaped,
      escaped ? `⛔ 已写出：${path.join(outside, "LEDGER.md")}` : "项目外干净"
    );
    // ★ F01-③：拒绝理由必须说清"是真实路径越界"（不能只说 ok:false）
    ok(
      "F01-③ 且拒绝理由说清了「真实路径越界」（不是含糊的失败）",
      threw !== undefined && /真实路径/.test(threw),
      threw === undefined ? "（返回 ok:false，无理由文本）" : ""
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F02  清单镜像经符号链接越界写入
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【F02】syncManifestMirror 经符号链接越界写（P1）");
{
  const mm = await import(pathToFileURL(path.join(LIB, "manifest-mirror.js")).href);
  const root = mk("f02");
  const outside = mk("f02-outside");

  let linked = false;
  try {
    fs.symlinkSync(outside, path.join(root, "linked"), "junction");
    linked = true;
  } catch (e) {
    console.log(`       ↳ 符号链接建不出来（${String(e?.message ?? e).slice(0, 80)}）⇒ 如实标未测`);
  }

  if (!linked) {
    ok("F02 夹具：能建符号链接", false, "建不出来 ⇒ 本条无法判定");
  } else {
    const manifest = { memoryRoot: "linked", active: "LEDGER.md", revision: 1 };
    const r = mm.syncManifestMirror(root, manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    const escapedFile = path.join(outside, ".dsh-ledger.json");
    const escaped = fs.existsSync(escapedFile);
    console.log(`       ↳ 回执：${JSON.stringify(r).slice(0, 140)}`);
    console.log(`       ↳ 项目外出现镜像 = ${escaped}`);
    ok(
      "F02 ★★★ 镜像目标经符号链接指向项目外时**必须拒绝**",
      r?.failed !== undefined || r?.skipped === true,
      r?.failed !== undefined ? `已报失败：${String(r.failed).slice(0, 80)}` : r?.skipped === true ? "已跳过" : "⛔ 返回正常同步结果"
    );
    ok(
      "F02-② ★★★ 且**项目外不得产生镜像文件**",
      !escaped,
      escaped ? `⛔ 已写出：${escapedFile}` : "项目外干净"
    );
  }
}

cleanup();
console.log("\n" + "═".repeat(80));
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`合计：PASS ${pass} / FAIL ${fail}（共 ${results.length} 条）`);
if (fail > 0) {
  console.log("\n未通过（= 缺陷仍存在，或修复后未达验收标准）：");
  for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.n}`);
}
console.log("═".repeat(80));
process.exit(fail === 0 ? 0 : 1);
