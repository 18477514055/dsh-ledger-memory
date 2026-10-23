#!/usr/bin/env node
/**
 * ★★★★★ D309：**把 5 个 UNCOVERED 工具真跑起来**。
 *
 * 🔴 为什么必须有这一轮：审计器里那 5 个工具长期标着
 *   **"没有安全的自动化调用（需要活内核 ctx / 会破坏夹具 / 需人工判定）"** —— 那是**未测**，
 *   而项目纪律是「**留白不许读作通过**」。发布前它们必须要么变成 PASS/FAIL，要么继续如实标未测。
 *
 * ★★★ 判据（这一轮唯一不能破的）：
 *   **不许用静态断言冒充"已覆盖"**（D286 的病：16 条静态正则全绿，而那段代码从没执行过）。
 *   ⇒ 本探针**只做一件事：`tool.execute(...)` 真调**，看返回什么。
 *
 * ★ 怎么在没有活内核的情况下真跑（不是模拟，是给它真需要的东西）：
 *   · `rootFromExec(exec, args)` 只认 `args.root`（绝对路径）或 `exec.agent.session.header.{id,cwd}`
 *     ⇒ 给一个 `{ agent: { session: { header: { id, cwd } } } }` 就够了，**这不是模拟内核，这是照契约喂参**。
 *   · `ledger_status` 的 `compaction` 那项确实需要真 ctx；取不到时它**如实报 `reachable:false`**
 *     —— 那是**被测行为本身**，正好要断言它（而不是绕过它）。
 *   · `ledger_compact` 同样：**没有 compaction 服务时它必须明确拒绝**，不许假装压过。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const LIB = path.join(PROJECT, "lib");

const part3 = await import(pathToFileURL(path.join(LIB, "part3.js")).href);
const part4 = await import(pathToFileURL(path.join(LIB, "part4.js")).href);
const part2 = await import(pathToFileURL(path.join(LIB, "part2.js")).href);

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail === undefined ? "" : `  —— ${detail}`}`);
};

/** 造一个 V2 夹具（最简单、最不容易因为夹具本身出错而误判） */
function mkFixture(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ledger-unc-${kind}-`));
  const m = { version: 1, protocolVersion: 2, active: "LEDGER.md", archiveDir: "_ledger-archive", revision: 3 };
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify(m, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n- 第一条\n", "utf8");
  fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });
  return root;
}

/** 契约形状的 exec（不是"假内核"，是把 rootFromExec 真正读的那几个字段给上） */
function mkExec(root, sid) {
  return { agent: { session: { header: { id: sid ?? "session-probe-unc", cwd: root } } } };
}

/** 最小 ctx：`get(name)` 一律返回 undefined ⇒ 各工具应如实降级而不是崩 */
function mkCtx() {
  return { get: () => undefined, logger: { warn() {}, info() {}, debug() {} } };
}

console.log("═".repeat(76));
console.log("D309：真跑 5 个 UNCOVERED 工具（不是静态检查）");
console.log("═".repeat(76));

// ══════════════════════════════════════════════════════════════════════════
// 1. ledger_status
// ══════════════════════════════════════════════════════════════════════════
console.log("\n【1】ledger_status");
{
  const root = mkFixture("status");
  const t = part3.defineStatusTool(mkCtx(), {});
  let r;
  try {
    r = await t.execute({ root }, mkExec(root));
    ok("1① execute 不抛、返回对象", r !== undefined && typeof r === "object", "");
    ok("1② ok === true", r?.ok === true, String(r?.ok));
    ok("1③ 报出 projectRoot（就是夹具根）", r?.projectRoot === root, String(r?.projectRoot));
    ok("1④ 报出 initialized === true（夹具真有台账）", r?.initialized === true, String(r?.initialized));
    ok("1⑤ 报出 activeLines（真数出来的）", typeof r?.activeLines === "number" && r.activeLines > 0, String(r?.activeLines));
    // ★ D305 新加的三个 V3 回显字段：真跑一次才敢说它生效
    ok("1⑥ 有 memoryRoot 字段（V2 ⇒ null）", r?.memoryRoot === null, JSON.stringify(r?.memoryRoot));
    ok("1⑦ 有 memoryBase 字段", typeof r?.memoryBase === "string" && r.memoryBase === root, String(r?.memoryBase));
    ok("1⑧ 有 isV3 字段（V2 ⇒ false）", r?.isV3 === false, String(r?.isV3));
    ok("1⑨ 有 manifestMirror 且 state === v2", r?.manifestMirror?.state === "v2", JSON.stringify(r?.manifestMirror ?? null));
    // ★ 关键：没有真 ctx 时，compaction 必须**如实说不可达**，不许假装
    ok(
      "1⑩ ★ 取不到 compaction 服务 ⇒ 如实报 reachable:false（不许假装可用）",
      r?.compaction?.reachable === false && typeof r.compaction.hint === "string",
      JSON.stringify(r?.compaction ?? null).slice(0, 90)
    );
    ok("1⑪ 返回值是 lossless JSON（无 undefined）", JSON.stringify(r) !== undefined && !JSON.stringify(r).includes("undefined"), "");
  } catch (e) {
    ok("1① execute 不抛、返回对象", false, `抛了：${e.message}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════════
// 2. ledger_write
// ══════════════════════════════════════════════════════════════════════════
console.log("\n【2】ledger_write");
{
  const root = mkFixture("write");
  const t = part4.defineWriteTool({});
  const before = fs.readFileSync(path.join(root, "LEDGER.md"), "utf8");
  let r;
  try {
    // ★ 显式 append（不传 mode 时 active 默认 replace —— 那是本项目的著名事故）
    r = await t.execute({ root, target: "active", mode: "append", content: "\n- 探针追加的一行\n" }, mkExec(root));
    ok("2① execute 不抛", r !== undefined, "");
    ok("2② ok === true", r?.ok === true, String(r?.ok));
    const after = fs.readFileSync(path.join(root, "LEDGER.md"), "utf8");
    ok("2③ ★ 文件真的被改了（不是只返回 ok）", after !== before, `前 ${before.length} 字 → 后 ${after.length} 字`);
    ok("2④ ★ 原有内容一个字节没丢（append 不是 replace）", after.startsWith(before.replace(/\s+$/, "")), "");
    ok("2⑤ 新内容真的进去了", after.includes("探针追加的一行"), "");
    ok("2⑥ 回执里有 changedBy（如实报改了几行）", typeof r?.changedBy === "number", String(r?.changedBy));
    ok("2⑦ 清单 revision 递增了", (() => {
      const m = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8"));
      return typeof m.revision === "number" && m.revision > 3;
    })(), "");
  } catch (e) {
    ok("2① execute 不抛", false, `抛了：${e.message}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════════
// 3. ledger_archive
// ══════════════════════════════════════════════════════════════════════════
console.log("\n【3】ledger_archive");
{
  const root = mkFixture("archive");
  const body =
    "# 台账\n\n" +
    Array.from({ length: 12 }, (_, i) => `- 条目 ${i + 1}：这是第 ${i + 1} 条记录，用来测试归档。`).join("\n") +
    "\n";
  fs.writeFileSync(path.join(root, "LEDGER.md"), body, "utf8");
  const t = part4.defineArchiveTool({});
  const SLICE = "- 条目 1：这是第 1 条记录，用来测试归档。\n- 条目 2：这是第 2 条记录，用来测试归档。";

  // ★★★ 我先前的断言写错了（不是缺陷）：`ledger_archive` **没有 dry-run 参数**。
  //   🔴 我第一版按 `ledger_conform` 的形状想当然，断言"干跑不写盘" —— 实测它写了归档。
  //   ★ 查源码坐实：`archiveLedger(root,args,exec)` 全文**没有** `apply` / `dryRun`，
  //     它的安全保证是另一条：**"先把所有会失败的事判完，一个字节都不写；再落盘"**（A2 修复）。
  //   ⇒ 判据改成**验它真正承诺的那条**：一次失败调用**绝不留归档文件**。
  console.log("      （注：本工具无 dry-run 参数 —— 断言改为验它真正承诺的「失败不写盘」）");

  // ① 失败路径：entries 不在原文里 ⇒ 必须拒绝，且**不留归档文件**
  let r1;
  try {
    r1 = await t.execute({ root, entries: "- 这句台账里根本没有\n", newActive: "# 台账\n" }, mkExec(root));
    ok("3① 非法 entries ⇒ 明确拒绝（ok:false + 理由）", r1?.ok === false && typeof r1.reason === "string", String(r1?.reason).slice(0, 70));
    const archDir = path.join(root, "_ledger-archive");
    const n = fs.existsSync(archDir) ? fs.readdirSync(archDir, { recursive: true }).length : 0;
    ok("3② ★★ 失败的调用**不留归档文件**（只追加的东西绝不能被失败路径污染）", n === 0, `归档目录里 ${n} 项`);
    ok("3③ 失败的调用**不改活跃台账**", fs.readFileSync(path.join(root, "LEDGER.md"), "utf8") === body, "");
  } catch (e) {
    ok("3① 非法 entries ⇒ 明确拒绝", false, `抛了：${e.message}`);
  }

  // ② 成功路径：合法切片 + 真 newActive ⇒ 归档真的写出来、台账真的变短
  const newActive = body.replace(SLICE, "").replace(/\n{3,}/g, "\n\n");
  let r2;
  try {
    r2 = await t.execute({ root, entries: SLICE, newActive, label: "探针归档" }, mkExec(root));
    ok("3④ 合法调用 ⇒ ok:true", r2?.ok === true, String(r2?.reason ?? r2?.ok));
    ok("3⑤ ★ 归档文件真的写出来了", (() => {
      const archDir = path.join(root, "_ledger-archive");
      if (!fs.existsSync(archDir)) return false;
      return fs.readdirSync(archDir, { recursive: true }).some((f) => String(f).includes("archive"));
    })(), "");
    ok("3⑥ ★★ 被归档的条目**真的从活跃台账里消失了**（这才是 newActive 生效的证据）",
      !fs.readFileSync(path.join(root, "LEDGER.md"), "utf8").includes("条目 1：这是第 1 条记录"),
      "");
    // ★★★ 我先前这条断言写错了（**不是缺陷**）：
    //   🔴 我断言"文件变短" —— 实测反而变长（168→381 字符）。
    //   ★ 查清了：`registered = withChangeRegister(newActive, …)`（`part4.js:2862`），
    //     即**在 newActive 之后追加一个「变更登记」区**（每次归档记一行，最多留 changeRegisterMax 条）。
    //     ⇒ 这是**设计要的**：归档是唯一会成批删条目的动作，必须留审计痕迹。
    //   ⇒ 判据改成验**语义**：被移走的条目真没了、登记区真记了这笔。**"文件长度"根本不是承诺**。
    ok("3⑥b ★ 追加了「变更登记」区并记下这次归档（成批删条目必须留痕）",
      (() => {
        const t = fs.readFileSync(path.join(root, "LEDGER.md"), "utf8");
        return t.includes("变更登记") && /\(archive\)/.test(t);
      })(),
      "");
    ok("3⑦ ★ 被移走的那两条**逐字**在归档里（不许改写）", (() => {
      const archDir = path.join(root, "_ledger-archive");
      const files = fs.readdirSync(archDir, { recursive: true }).filter((f) => String(f).includes("archive"));
      if (files.length === 0) return false;
      const p = path.join(archDir, String(files[0]));
      return fs.readFileSync(p, "utf8").includes(SLICE);
    })(), "");
    ok("3⑧ 回执里有 archivedSegment（可追溯切了哪几行）", r2?.archivedSegment !== undefined || r2?.lines !== undefined, JSON.stringify(r2).slice(0, 100));
  } catch (e) {
    ok("3④ 合法调用 ⇒ ok:true", false, `抛了：${e.message}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════════
// 4. ledger_compact
// ══════════════════════════════════════════════════════════════════════════
console.log("\n【4】ledger_compact");
{
  const root = mkFixture("compact");
  const t = part3.defineCompactTool(mkCtx(), {}, undefined);
  let r;
  try {
    r = await t.execute({ root }, mkExec(root));
    ok("4① execute 不抛（取不到服务也不许崩）", r !== undefined, "");
    // ★ 没有 compaction 服务时它必须明确拒绝或如实说"需要活内核"
    const saidNo =
      r?.ok === false ||
      r?.reachable === false ||
      (typeof r?.reason === "string" && /compaction|服务|活内核|不可达/i.test(r.reason)) ||
      (typeof r?.hint === "string" && r.hint.length > 0);
    ok("4② ★★ 取不到 compaction 服务 ⇒ **明确说不可用**（绝不假装压过）", saidNo === true, JSON.stringify(r).slice(0, 140));
  } catch (e) {
    // 抛错也算"明确拒绝"——但必须带可读理由
    ok("4① execute 不抛（取不到服务也不许崩）", false, `抛了：${e.message}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════════
// 5. ledger_init
// ══════════════════════════════════════════════════════════════════════════
console.log("\n【5】ledger_init");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-unc-init-"));
  const t = part4.defineInitTool();
  let r;
  try {
    r = await t.execute(
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
      },
      mkExec(root)
    );
    ok("5① execute 不抛", r !== undefined, "");
    ok("5② ok === true", r?.ok === true, String(r?.ok));
    ok("5③ ★ 清单真的写出来了（根，因为它是寻址器）", fs.existsSync(path.join(root, ".dsh-ledger.json")), "");
    // ★★★ 我先前把这条断言写错了（**不是缺陷**）：
    //   🔴 我按 V2 的直觉断言"`<root>/LEDGER.md` 存在" —— 但 V3 下 `activeAbs` 是
    //      `path.resolve(memRootAbs, active)`（`part4.js:1155`）⇒ 台账**本来就该在记忆目录里**。
    //   ★ 实测坐实（`init-check-*` 夹具）：root 下只有 `.dsh-ledger.json` / `.gitignore` / `mem-ledger-memory`，
    //     而记忆目录里有 `LEDGER.md` / `DECISIONS.md` / `decisions` / `lessons` / `goals` / `SECURITY.md` / `_ledger-archive` / `_ledger-log`。
    //   ⇒ 判据改成**验 V3 的承诺**：记忆文件在记忆目录内、且**项目根不留记忆文件**。
    const mem = path.join(root, "mem-ledger-memory");
    ok("5④ ★ 台账真的建出来了（**在记忆目录里** —— V3 的正确落点）", fs.existsSync(path.join(mem, "LEDGER.md")), "");
    ok("5④b ★★ 项目根**没有** LEDGER.md（V3 的隔离承诺）", !fs.existsSync(path.join(root, "LEDGER.md")), "");
    ok("5⑤ ★ 记忆目录真的建出来了", fs.existsSync(path.join(root, "mem-ledger-memory")), "");
    ok("5⑥ ★ SECURITY.md 真的建出来了（V3 必备）", fs.existsSync(path.join(root, "mem-ledger-memory", "SECURITY.md")), "");
    ok("5⑦ ★ 清单镜像真的建出来了（D303）", fs.existsSync(path.join(root, "mem-ledger-memory", ".dsh-ledger.json")), "");
    const m = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8"));
    ok("5⑧ 清单 protocolVersion === 3（D308）", m.protocolVersion === 3, String(m.protocolVersion));
    ok("5⑨ 清单 autoGitAdd === false（§3.1）", m.autoGitAdd === false, String(m.autoGitAdd));
    ok("5⑩ 回执如实报 memoryRoot", r?.memoryRoot === "mem-ledger-memory", String(r?.memoryRoot));
  } catch (e) {
    ok("5① execute 不抛", false, `抛了：${e.message}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

const bad = results.filter((r) => r.pass !== true).length;
console.log("\n" + "─".repeat(76));
console.log(`${results.length - bad} PASS / ${bad} FAIL`);
console.log("─".repeat(76));
process.exit(bad === 0 ? 0 : 1);
