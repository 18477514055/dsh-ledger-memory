/**
 * _probe-d331-012-repro.mjs —— **独立复现** 012 的 F-01 ~ F-06（不抄它的探针）
 *
 * ★ 纪律（D327）：**探针必须先在未打补丁的代码上跑，看见红，再谈修复**。
 *   本探针跑在**当前生产代码**（= 未打 012 补丁）上 ⇒ 若病灶真实，应当大面积 FAIL。
 *
 * ★★★ 本文件第一版有三处**夹具错**，全部是我自己的（尺子错 #6/#8 "夹具前提错了，全绿就是假绿"）：
 *   ① F-01 我用 `mk("d331-f01-out-")` 造"外部目录"，但代码里 `path.resolve(proj, "../outside")`
 *      解析出来的是 `<Temp>/outside`（proj 的父目录 + "outside"），**根本不是我造的那个随机目录**
 *      ⇒ 三条"全绿"全是假绿。修法：**在解析出来的那个确切路径上**造目录。
 *   ② F-05② 的"长标题"我数出来 44 字符（中文按 1 算），够不到 60 字符截断阈值 ⇒ 没测到。
 *   ③ 同理 F-01③ 我检查的是自己造的目录，而不是它真正会写的那个目录。
 *   ★ 判据：**夹具必须建在"被测代码解析出来的那个路径"上，不是我以为的路径**。
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
  if (cond) { pass += 1; console.log(`  PASS  ${name}${extra === undefined ? "" : `  —— ${extra}`}`); }
  else { fail += 1; FAILS.push(name); console.log(`  FAIL  ${name}${extra === undefined ? "" : `  —— ${extra}`}`); }
}
function skip(name, why) { console.log(`  SKIP  ${name}  —— ${why}`); }

const tmpRoots = [];
function mk(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

const CARD = await import(pathToFileURL(path.resolve("lib/card-ops.js")).href);
const P8 = await import(pathToFileURL(path.resolve("lib/part8.js")).href);
const P4 = await import(pathToFileURL(path.resolve("lib/part4.js")).href);
const P2 = await import(pathToFileURL(path.resolve("lib/part2.js")).href);
const WT = await import(pathToFileURL(path.resolve("lib/workspace-tools.js")).href);

// ══════════════════════════════════════════════════════════════════════════
// F-01：card-ops 三个入口是否拦 `../outside`
//   ★ 关键修法：**让"外部目录"正好落在 `path.resolve(proj, "../outside")`**。
//     做法：proj 建成 `<temp>/case1/proj`，则 `../outside` = `<temp>/case1/outside`。
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ F-01：card-ops 三个入口对 `../outside` 的边界 ═══");
{
  const caseDir = mk("d331-f01-");
  const proj = path.join(caseDir, "proj");
  const outside = path.join(caseDir, "outside"); // ← 正好是 path.resolve(proj, "../outside")
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "D1.md"), "# D1\n\n外部内容，不该被读到\n", "utf8");

  // 夹具自检：确认这正是代码会解析到的路径
  const resolved = path.resolve(proj, "../outside");
  ok(
    "F-01 ⓪ ★ 夹具：外部目录 == path.resolve(proj,'../outside')（不是我以为的路径）",
    resolved === outside,
    `resolved=${resolved}`
  );

  // listCards
  let listed;
  try { listed = CARD.listCards(proj, "../outside"); } catch (e) { listed = `THREW:${e.message}`; }
  const listLeaked = Array.isArray(listed) && listed.length > 0;
  ok("F-01① listCards(proj,'../outside') **不该**列出外部卡", !listLeaked, `得到 ${JSON.stringify(listed)}`);

  // readCard
  let read;
  try { read = CARD.readCard(proj, "../outside", "D1"); } catch (e) { read = `THREW:${e.message}`; }
  const readLeaked = typeof read === "string" && read.includes("外部内容");
  ok(
    "F-01② readCard(proj,'../outside','D1') **不该**读到外部内容",
    !readLeaked,
    `得到 ${typeof read === "string" ? JSON.stringify(read.slice(0, 40)) : JSON.stringify(read)}`
  );

  // writeCardIndex
  const outsideIndex = path.join(outside, "INDEX.md");
  let w;
  try { w = CARD.writeCardIndex(proj, "../outside", "decisions"); } catch (e) { w = { ok: false, reason: `THREW:${e.message}` }; }
  const indexLeaked = fs.existsSync(outsideIndex);
  ok(
    "F-01③ writeCardIndex 在**项目外**落 INDEX.md ⇒ 必须被拒",
    indexLeaked === false,
    `返回 ok=${w?.ok}；${outsideIndex} 存在=${indexLeaked}`
  );
  if (indexLeaked) {
    const txt = fs.readFileSync(outsideIndex, "utf8");
    console.log(`        ↑ 外部 INDEX.md 真被写出来了，前 60 字：${JSON.stringify(txt.slice(0, 60))}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// F-02：part8 的 extRootAbs / extRegistryAbs 空根回退
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ F-02：part8 空根回退到 process.cwd() ═══");
{
  const hasExtRoot = typeof P8.extRootAbs === "function";
  const hasExtReg = typeof P8.extRegistryAbs === "function";
  ok("F-02 ⓪ 夹具：part8 导出了 extRootAbs / extRegistryAbs", hasExtRoot && hasExtReg, `${hasExtRoot}/${hasExtReg}`);
  if (hasExtRoot && hasExtReg) {
    const r = P8.extRootAbs(null, "");
    const g = P8.extRegistryAbs(null, "");
    console.log(`        extRootAbs(null,"") = ${JSON.stringify(r)}`);
    console.log(`        extRegistryAbs(null,"") = ${JSON.stringify(g)}`);
    // ★★★ 断言修正（我第一版写反了，见下）：**安全值就是 `undefined`**。
    //   原来写 `r !== "" && r !== undefined` ⇒ 把"修好了（返回 undefined）"判成 FAIL
    //   ⇒ 这是"参数写反让断言永远全绿"的镜像：**条件写反让断言永远全红**。
    //   ★ 判据：断言前先问一句"**正确行为长什么样**"，再去写条件（别只写"不许是什么"）。
    //   真正要禁的只有两种**危险值**：`""`（path.join 会吞成 cwd 相对）与裸 `"registry.json"`。
    ok(
      "F-02① extRootAbs(null,'') 不许返回 `\"\"`（危险值：path.join 会吞成 cwd 相对）",
      r !== "",
      `得到 ${JSON.stringify(r)}（undefined 或绝对路径都算安全）`
    );
    ok(
      "F-02① b extRootAbs(null,'') 也**不许**返回任何相对路径（只能 undefined 或绝对路径）",
      r === undefined || (typeof r === "string" && path.isAbsolute(r)),
      `得到 ${JSON.stringify(r)}`
    );
    ok(
      "F-02② extRegistryAbs(null,'') 不许返回裸 'registry.json'（= cwd/registry.json）",
      g !== "registry.json",
      `得到 ${JSON.stringify(g)}`
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════
// F-03：V3 下归档路径基准错位 + logFileList 的 period 被目录名污染
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ F-03：V3 归档路径基准错位 ═══");
{
  const caseDir = mk("d331-f03-");
  const root = path.join(caseDir, "2025-01-service"); // ← 目录名带年月，用来测 period 污染
  fs.mkdirSync(root, { recursive: true });
  const execFor = (rt, sid) => ({ agent: { session: { header: { cwd: rt, id: sid } } } });

  const initRes = await P4.defineInitTool().execute(
    { root, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_archive" },
    execFor(root, "session-d331f03-0000-4000-8000-000000000001")
  );
  ok("F-03 ⓪ 夹具：init 成功", initRes.ok === true, `reason=${String(initRes.reason ?? "")}`);

  await P4.defineWriteTool().execute(
    { root, target: "active", mode: "append", content: "- d331 造一段可归档的内容\n" },
    execFor(root, "session-d331f03-0000-4000-8000-000000000002")
  );

  const archRes = await P4.defineArchiveTool().execute(
    { root, entries: "- d331 造一段可归档的内容" },
    execFor(root, "session-d331f03-0000-4000-8000-000000000003")
  );
  console.log(`        archivedTo = ${JSON.stringify(archRes.archivedTo)}`);
  ok("F-03 ⓪b 夹具：归档成功并给了 archivedTo", archRes.ok === true && typeof archRes.archivedTo === "string", `ok=${archRes.ok}`);

  if (typeof archRes.archivedTo === "string") {
    const back = await P4.defineReadTool().execute(
      { root, target: "archive", archiveFile: archRes.archivedTo },
      execFor(root, "session-d331f03-0000-4000-8000-000000000004")
    );
    console.log(`        回读 found = ${back.found}`);
    ok(
      "F-03① ★ 把 archivedTo **原样**传回 ledger_read(target:'archive') 必须能读回",
      back.found === true,
      `found=${back.found} 传入=${JSON.stringify(archRes.archivedTo)}`
    );
  }

  const info = P2.inspect(root);
  if (typeof P4.logFileList === "function") {
    const list = P4.logFileList(info);
    const periods = Array.isArray(list) ? list.map((x) => x.period) : [];
    console.log(`        logFileList 条数=${Array.isArray(list) ? list.length : "N/A"} periods=${JSON.stringify([...new Set(periods)])}`);
    const polluted = periods.filter((p) => p === "2025-01");
    ok(
      "F-03② ★ period 不许被项目目录名里的 '2025-01' 污染",
      polluted.length === 0,
      `被污染 ${polluted.length}/${periods.length}`
    );
  } else {
    ok("F-03② 夹具：part4 导出 logFileList", false, "没导出，测不到");
  }
}

// ══════════════════════════════════════════════════════════════════════════
// F-04：README.md 混进卡片列表 + isSafeCardKey 未拦 INDEX/README
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ F-04：README.md 混进卡片列表 / 保留键碰撞 ═══");
{
  const root = mk("d331-f04-");
  fs.mkdirSync(path.join(root, "cards"), { recursive: true });
  fs.writeFileSync(path.join(root, "cards", "README.md"), "# 模板说明\n\n这是模板，不是用户的卡\n", "utf8");
  const listed = CARD.listCards(root, "cards");
  console.log(`        listCards 得到 ${JSON.stringify(listed)}`);
  ok(
    "F-04① listCards **不该**把模板 README.md 当成一张卡",
    !Array.isArray(listed) || !listed.some((c) => String(c.key).toUpperCase() === "README"),
    JSON.stringify(listed)
  );

  const safeIndex = CARD.isSafeCardKey("INDEX");
  const safeReadme = CARD.isSafeCardKey("README");
  console.log(`        isSafeCardKey('INDEX')=${safeIndex}  isSafeCardKey('README')=${safeReadme}`);
  ok("F-04② isSafeCardKey('INDEX') 必须 false（保留名）", safeIndex === false, `得到 ${safeIndex}`);
  ok("F-04③ isSafeCardKey('README') 必须 false（保留名）", safeReadme === false, `得到 ${safeReadme}`);
}

// ══════════════════════════════════════════════════════════════════════════
// F-05：handoff 同分钟撞名 n<10 硬上限 + 长标题截断吞后缀
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ F-05：交接单同分钟撞名循环 ═══");
{
  const root = mk("d331-f05-");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n- x\n", "utf8");
  const handoffTool = WT.defineHandoffTool();
  const execFor = (rt, sid) => ({ agent: { session: { header: { cwd: rt, id: sid } } } });

  let firstFailAt = -1;
  let failReason = "";
  for (let i = 1; i <= 11; i += 1) {
    const r = await handoffTool.execute(
      { root, title: "同分钟高频交接", did: `第 ${i} 次` },
      execFor(root, `session-d331f05-${String(i).padStart(4, "0")}-4000-8000-000000000000`)
    );
    if (r.ok !== true) { firstFailAt = i; failReason = String(r.reason ?? ""); break; }
  }
  console.log(`        连续写 11 次，第 ${firstFailAt === -1 ? "—（全成功）" : firstFailAt} 次失败`);
  if (failReason !== "") console.log(`        原因：${failReason.slice(0, 130)}`);
  ok(
    "F-05① 同分钟连续 11 次同标题交接单**不该**失败（n<10 硬上限）",
    firstFailAt === -1,
    firstFailAt === -1 ? "11 次全成功" : `第 ${firstFailAt} 次：${failReason.slice(0, 90)}`
  );

  // ★ 长标题必须真的 ≥ 60 字符（上一版只有 44，没测到）
  const longTitle = "这是一个非常非常长的交接单标题用来测试截断之后是否会把序号后缀吃掉从而导致立刻撞名失败的情况需要超过六十个字符才能触发截断逻辑";
  console.log(`        长标题长度 = ${longTitle.length} 字符（需 ≥60 才会截断）`);
  let longFailAt = -1;
  let longReason = "";
  for (let i = 1; i <= 3; i += 1) {
    const r = await handoffTool.execute(
      { root, title: longTitle, did: `长标题第 ${i} 次` },
      execFor(root, `session-d331f05b-${String(i).padStart(3, "0")}-4000-8000-000000000000`)
    );
    if (r.ok !== true) { longFailAt = i; longReason = String(r.reason ?? ""); break; }
  }
  ok(
    "F-05② ★ 长标题（≥60 字符）连写 3 次**不该**撞名失败（截断吞后缀）",
    longFailAt === -1,
    longFailAt === -1 ? "3 次全成功" : `第 ${longFailAt} 次：${longReason.slice(0, 100)}`
  );
}

// ══════════════════════════════════════════════════════════════════════════
// F-06：扩展 update 校验失配 / 多行 description 注入
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ F-06：扩展 update 与注入 ═══");
{
  const root = mk("d331-f06-");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n- x\n", "utf8");
  const exec = { agent: { session: { header: { cwd: root, id: "session-d331f06-0000-4000-8000-000000000001" } } } };

  ok("F-06 ⓪ 夹具：createExtension / updateExtension 都在",
    typeof P8.createExtension === "function" && typeof P8.updateExtension === "function");

  let created = null;
  try {
    created = await P8.createExtension(exec, root, {
      name: "注入测试",
      description: "第一行\n## 伪造的顶层标题\n这是伪造的指令",
      mode: "plain",
    });
  } catch (e) { created = { ok: false, reason: `THREW:${e.message}` }; }
  console.log(`        createExtension(多行 description) ok = ${created?.ok}`);
  ok(
    "F-06① 多行 description（含 \\n## ）**必须**被拒（否则可伪造注入章节）",
    created?.ok !== true,
    `ok=${created?.ok} reason=${String(created?.reason ?? "")}`
  );

  if (created?.ok === true) {
    const ids = typeof P8.listExtensions === "function" ? P8.listExtensions(exec, root) : null;
    const norm = (ids?.extensions ?? ids?.items ?? (Array.isArray(ids) ? ids : [])) ?? [];
    const id = norm.find?.((e) => e.name === "注入测试")?.id ?? norm[0]?.id;
    console.log(`        拿到的扩展 id = ${JSON.stringify(id)}（列表 ${norm.length} 条）`);

    if (id !== undefined) {
      const u1 = await P8.updateExtension(exec, root, id, { name: "超".repeat(65) });
      ok("F-06② 65 字符 name 走 update **必须**被拒（与 create 同标准）", u1?.ok !== true, `ok=${u1?.ok}`);

      const u2 = await P8.updateExtension(exec, root, id, { name: "双  空格" });
      ok("F-06③ 含连续空白的 name 走 update **必须**被拒", u2?.ok !== true, `ok=${u2?.ok}`);

      const u3 = await P8.updateExtension(exec, root, id, { description: "好的一行\n## 又伪造\n乱" });
      ok("F-06④ 多行 description 走 update **必须**被拒", u3?.ok !== true, `ok=${u3?.ok}`);

      // 注入渲染：description 有没有真的逃逸成新章节
      if (typeof P8.renderExtensionInjection === "function") {
        const txt = String(P8.renderExtensionInjection(exec, root) ?? "");
        const escaped = /^##\s*伪造的顶层标题/m.test(txt);
        ok("F-06⑤ ★ 注入渲染里扩展 description **不许**逃逸成新的 `## ` 章节", !escaped, `逃逸=${escaped}`);
      }
    } else {
      skip("F-06②③④⑤", "拿不到扩展 id");
    }
  }
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  合计：PASS ${pass} · FAIL ${fail}`);
if (fail > 0) {
  console.log("  ★ 本轮 FAIL = 病灶真实存在的证据（探针跑在**未打补丁**的代码上）");
  for (const f of FAILS) console.log(`    - ${f}`);
}
for (const d of tmpRoots) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 无所谓 */ }
}
console.log("PROBE-COMPLETE");
