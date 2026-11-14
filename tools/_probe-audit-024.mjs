import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

// ★ 本机适配（D378）：报告原稿用 `await import(path.join(targetDir, "lib/…"))`，
//   在 Windows 上直接抛 ERR_UNSUPPORTED_ESM_URL_SCHEME（绝对路径必须先转 file:// URL）。
//   这是**夹具问题，不是被测对象的问题**（纪律 6）。
const targetDir = path.resolve(process.argv[2] || process.cwd());
const imp = (rel) => import(pathToFileURL(path.join(targetDir, rel)).href);
const initToolMod = await imp("lib/init-tool.js");
const fpMod = await imp("lib/fingerprint.js");
const cardOpsMod = await imp("lib/card-ops.js");
const part2Mod = await imp("lib/part2.js");
const part2ToolsMod = await imp("lib/part2-tools.js");
const part3Mod = await imp("lib/part3.js");
const part4Mod = await imp("lib/part4.js");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const initTool = initToolMod.defineInitTool();
const goalsTool = part2ToolsMod.defineGoalsTool();
const lessonsTool = part2ToolsMod.defineLessonsTool();

async function runTool(tool, root, args) {
  try {
    return await tool.execute({ ...args, root }, { cwd: root });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

const results = [];
async function check(id, title, fn) {
  try {
    const detail = await fn();
    results.push({ id, title, status: "PASS", detail });
  } catch (err) {
    results.push({ id, title, status: "FAIL", detail: err && err.message ? err.message : String(err) });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// F-01a & F-01b
await check("F-01a", "ledger_init 在已有 V3 项目上重跑（未重传 memoryRoot）启用新角色时，文件应建在 memoryRoot 内且回执 layout 应保持 v3", async () => {
  const root = mkTmp("dsh-f01a-");
  const r1 = await runTool(initTool, root, {
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
  });
  assert(r1.ok === true, `r1 should succeed: ${r1.error}`);
  const memRootName = r1.memoryRoot;
  const r2 = await runTool(initTool, root, {
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
    journal: "JOURNAL.md",
  });
  assert(r2.ok === true, `r2 should succeed: ${r2.error}`);
  const leakedJournalInRoot = fs.existsSync(path.join(root, "JOURNAL.md"));
  const journalInMemRoot = fs.existsSync(path.join(root, memRootName, "JOURNAL.md"));
  const infoAfter = part2Mod.inspect(root);
  assert(!leakedJournalInRoot, `JOURNAL.md leaked into source root ${root} instead of ${memRootName}!`);
  assert(journalInMemRoot, `JOURNAL.md was not created inside memoryRoot ${memRootName}!`);
  assert(infoAfter.journalRel === "JOURNAL.md" && fs.existsSync(path.join(infoAfter.memoryBase, infoAfter.journalRel)),
    "inspect(root).journalRel should resolve inside memoryBase after enabling journal");
  assert(r2.protocol?.layout === "v3" && r2.memoryRoot === memRootName, `r2 layout/memoryRoot mismatch`);
  return `memRoot=${memRootName}, journalInMemRoot=${journalInMemRoot}, protocol.layout=${r2.protocol?.layout}`;
});

await check("F-01b", "ledger_init 在已有项目上显式传 layout:'v3' 重跑时，应按文档承诺赋予或保留 v3 memoryRoot", async () => {
  const root = mkTmp("dsh-f01b-");
  await runTool(initTool, root, {
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
    layout: "flat",
  });
  const r2 = await runTool(initTool, root, {
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
    layout: "v3",
  });
  assert(r2.ok === true && r2.protocol?.layout === "v3" && typeof r2.memoryRoot === "string" && r2.memoryRoot.length > 0,
    `layout:'v3' on existing project expected protocol.layout==='v3' & memoryRoot, got layout=${r2.protocol?.layout}, memoryRoot=${r2.memoryRoot}`);
  return `r2.protocol.layout=${r2.protocol?.layout}, r2.memoryRoot=${r2.memoryRoot}`;
});

// F-02a & F-02b
await check("F-02a", "已有项目上通过同时传 active:'PRINCIPLES.md' 与 principles:'DUMMY.md' 不得绕过原则文件保护", async () => {
  const root = mkTmp("dsh-f02a-");
  const r1 = await runTool(initTool, root, {
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
  });
  fs.writeFileSync(path.join(root, r1.memoryRoot, "PRINCIPLES.md"), "# 根本原则\n\n- 严禁覆写\n", "utf8");
  const r2 = await runTool(initTool, root, {
    active: "PRINCIPLES.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
    principles: "DUMMY.md",
    memoryRoot: r1.memoryRoot,
  });
  assert(r2.ok === false, `Expected r2.ok === false when hijacking PRINCIPLES.md as active, but got ok=${r2.ok}`);
  return `Blocked with error: ${r2.error}`;
});

await check("F-02b", "全新项目磁盘已有 PRINCIPLES.md 时，同时传 active:'PRINCIPLES.md' 与 principles:'DUMMY.md' 不得绕过保护", async () => {
  const root = mkTmp("dsh-f02b-");
  fs.writeFileSync(path.join(root, "PRINCIPLES.md"), "# 原则\n\n- 严禁篡改\n", "utf8");
  const r1 = await runTool(initTool, root, {
    active: "PRINCIPLES.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
    principles: "DUMMY.md",
    layout: "flat",
  });
  assert(r1.ok === false, `Expected r1.ok === false when hijacking pre-existing PRINCIPLES.md on brand-new flat project, got ok=${r1.ok}`);
  return `Blocked with error: ${r1.error}`;
});

// F-03a & F-03b
await check("F-03a", "首行非空行即为代码围栏（```）时，applyFingerprint3 / verifySeal / strip 应保持幂等且校验通过", async () => {
  const proj = fpMod.ensureProjectId({}).projectId;
  const raw = "```js\nconsole.log('hello');\n```\n\n## 正文标题\n- 条目 A\n";
  const id = { project: proj, kind: "active", key: "-" };
  const stamped1 = fpMod.applyFingerprint3(raw, id).text;
  const seal1 = fpMod.verifySeal(stamped1);
  assert(seal1.ok === true, `First verifySeal failed: ${seal1.reason}`);
  const stamped2 = fpMod.applyFingerprint3(stamped1, id).text;
  assert(stamped2 === stamped1, "applyFingerprint3 is not idempotent when first line is a code fence");
  const stripped = fpMod.applyFingerprint3(stamped1, id, { strip: true }).text;
  assert(!stripped.includes("<!--dsh-id:"), `strip:true failed to remove inline carrier`);
  return `seal1.ok=${seal1.ok}, idempotent=${stamped2 === stamped1}`;
});

await check("F-03b", "正文含未闭合代码围栏或混合围栏（``` 内含 ~~~）时，applyFingerprint3 / verifySeal / strip 应正常工作且不堆叠尾部 link 载体", async () => {
  const proj = fpMod.ensureProjectId({}).projectId;
  const rawUnclosed = "# 标题\n\n- 正常记录\n```js\nconst x = 1;\n";
  const id = { project: proj, kind: "active", key: "-" };
  const stamped1 = fpMod.applyFingerprint3(rawUnclosed, id).text;
  const seal1 = fpMod.verifySeal(stamped1);
  assert(seal1.ok === true, `verifySeal on unclosed fence content failed: ${seal1.reason}`);
  const r3 = fpMod.readFingerprint3(stamped1);
  assert(r3.ok === true && r3.sources.length === 3, `Expected 3 sources on unclosed fence content`);
  const stamped2 = fpMod.applyFingerprint3(stamped1, id).text;
  assert(stamped2 === stamped1, "Repeated applyFingerprint3 stacked duplicate [dsh-fp-link]");
  const stripped = fpMod.applyFingerprint3(stamped1, id, { strip: true }).text;
  assert(!stripped.includes("[dsh-fp-link]:"), "strip:true left [dsh-fp-link] behind");
  const rawMixed = `# 标题\n\n\`\`\`markdown\n~~~\n<!--dsh-id:${proj}:fake-key-->\n\`\`\`\n`;
  const stampedMixed = fpMod.applyFingerprint3(rawMixed, id).text;
  const r3Mixed = fpMod.readFingerprint3(stampedMixed);
  assert(r3Mixed.ok === true, `readFingerprint3 on mixed fence failed: ${r3Mixed.reason}`);
  return `unclosedSeal=${seal1.ok}, sources=${r3.sources.length}, mixedOk=${r3Mixed.ok}`;
});

// F-04a & F-04b
await check("F-04a", "renderBlockInjection 的 fullChars/上限判断及 sliceEntryByKey 的行号定位应基于剥离三载体指纹后的正文", async () => {
  const root = mkTmp("dsh-f04a-");
  await runTool(initTool, root, {
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
    layout: "flat",
  });
  const pid = fpMod.projectOf(root);
  const cleanLedger = "# 项目记忆台账 (LEDGER)\n\n## 当前进度\n- 正在审计模块\n\n## 待办事项\n- 修复缺陷\n";
  const stampedLedger = fpMod.applyFingerprint3(cleanLedger, { kind: "active", project: pid, key: "-" }).text;
  fs.writeFileSync(path.join(root, "LEDGER.md"), stampedLedger, "utf8");
  const cleanDec = "# 关键决策\n\n## D1 · 第一条决策\n- 结论：通过\n";
  const stampedDec = fpMod.applyFingerprint3(cleanDec, { kind: "decisions", project: pid, key: "-" }).text;
  fs.writeFileSync(path.join(root, "DECISIONS.md"), stampedDec, "utf8");

  const info = part2Mod.inspect(root);
  const blockInj = part3Mod.renderBlockInjection(info, { afterCompaction: false });
  assert(blockInj.stats.fullChars === cleanLedger.replace(/\s+$/, "").length || blockInj.stats.fullChars === cleanLedger.length,
    `renderBlockInjection stats.fullChars (${blockInj.stats.fullChars}) included 3-carrier fingerprint overhead`);
  const entryD1 = cardOpsMod.readEntryUnified(root, info, "decisions", "D1");
  assert(entryD1.startLine === 3, `sliceEntryByKey startLine expected 3, got ${entryD1.startLine}`);
  return `fullChars=${blockInj.stats.fullChars}, D1.startLine=${entryD1.startLine}`;
});

await check("F-04b", "单文件 readKindRaw、listCards.chars、detectMigration.lines、writeLedger.chars 均应基于去指纹后的正文统计", async () => {
  const root = mkTmp("dsh-f04b-");
  await runTool(initTool, root, {
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
    goals: "GOALS.md",
    layout: "flat",
  });
  await runTool(goalsTool, root, { op: "upsert", id: "g1", title: "测试目标", parent: "-", status: "root" });
  const info = part2Mod.inspect(root);
  const rawGoals = cardOpsMod.readKindRaw(root, info, "goals");
  assert(!rawGoals.raw.includes("dsh-fp-front:") && !rawGoals.raw.includes("[dsh-fp-link]:"),
    "readKindRaw in single-file mode leaked 3-carrier fingerprint!");

  const pid = fpMod.projectOf(root);
  const cleanBody = "# 项目记忆台账 (LEDGER)\n\n## 当前进度\n- 测试条目 1";
  fs.writeFileSync(path.join(root, "LEDGER.md"), fpMod.applyFingerprint3(cleanBody, { kind: "active", project: pid, key: "-" }).text, "utf8");
  const wr = part4Mod.writeLedger(root, { target: "active", mode: "replace", content: cleanBody });
  const rawDiskAfterWrite = fs.readFileSync(path.join(root, "LEDGER.md"), "utf8");
  const cleanDiskAfterWrite = fpMod.applyFingerprint3(rawDiskAfterWrite, undefined, { strip: true }).text;
  assert(wr.chars < rawDiskAfterWrite.length && Math.abs(wr.chars - cleanDiskAfterWrite.length) <= 1,
    `writeLedger returned chars=${wr.chars} (raw stamped=${rawDiskAfterWrite.length}), expected clean length=${cleanDiskAfterWrite.length}!`);

  const mig = part4Mod.detectMigration(root);
  const activeDetail = (mig.files || []).find((d) => d.role === "active");
  const expectedLines = cleanDiskAfterWrite.split(/\r?\n/).length;
  assert(activeDetail && activeDetail.lines === expectedLines,
    `detectMigration active lines=${activeDetail?.lines}, expected stripped lines=${expectedLines}`);

  const cardBody = "## D1 · 决策卡\n- 结论：A";
  cardOpsMod.writeCard(root, "decisions", "D1", cardBody, { kind: "decisions", project: pid });
  const listed = cardOpsMod.listCards(root, "decisions");
  assert(listed.length === 1 && listed[0].chars === cardBody.length,
    `listCards[0].chars=${listed[0]?.chars} included fingerprint overhead, expected ${cardBody.length}`);
  return `writeLedger.chars=${wr.chars}, detectMigration.lines=${activeDetail.lines}, listCards.chars=${listed[0].chars}`;
});

// F-05
await check("F-05", "repairConformance 在权威清单写入失败时不得提前改写镜像，且卡片索引标题应为『# 索引 · 关键决策』", async () => {
  const root = mkTmp("dsh-f05-");
  const rInit = await runTool(initTool, root, {
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
  });
  const memRootAbs = path.join(root, rInit.memoryRoot);
  const decDir = path.join(memRootAbs, "decisions");
  for (const f of fs.readdirSync(decDir)) fs.unlinkSync(path.join(decDir, f));
  fs.writeFileSync(path.join(memRootAbs, "DECISIONS.md"), "# 关键决策\n\n## D1 · 测试决策\n- 内容\n", "utf8");
  part4Mod.repairConformance(root, { apply: true });
  const idxContent = fs.readFileSync(path.join(decDir, "INDEX.md"), "utf8");
  assert(idxContent.includes("# 索引 · 关键决策"), `Expected '# 索引 · 关键决策', got: ${idxContent.split("\n")[0]}`);

  const rootMf = path.join(root, ".dsh-ledger.json");
  const mirrorMf = path.join(memRootAbs, ".dsh-ledger.json");
  const mfObj = JSON.parse(fs.readFileSync(rootMf, "utf8"));
  delete mfObj.revision;
  const backupMf = path.join(root, "real-manifest.json");
  fs.writeFileSync(backupMf, JSON.stringify(mfObj, null, 2) + "\n", "utf8");
  fs.unlinkSync(rootMf);
  fs.symlinkSync(backupMf, rootMf);
  fs.unlinkSync(mirrorMf);

  const rep = part4Mod.repairConformance(root, { apply: true });
  assert(rep.ok === false && !fs.existsSync(mirrorMf), "repairConformance prematurely wrote mirror .dsh-ledger.json!");
  return `indexTitle=${idxContent.split("\n")[0]}, mirrorNotPrematurelyWritten=${!fs.existsSync(mirrorMf)}`;
});

// F-06
await check("F-06", "单文件模式下 ledger_goals / ledger_lessons(op:'add') 应回显 backup 字段，且 writeLedger / archiveLedger 应以当前项目权威身份盖章", async () => {
  const root = mkTmp("dsh-f06-");
  await runTool(initTool, root, {
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
    goals: "GOALS.md",
    lessons: "LESSONS.md",
    layout: "flat",
  });
  const gRes = await runTool(goalsTool, root, { op: "upsert", id: "g1", title: "测试目标", parent: "-", status: "root" });
  assert(typeof gRes.backup === "string" || gRes.backupFailed !== undefined, "Single-file ledger_goals omitted backup receipt");
  const lRes = await runTool(lessonsTool, root, {
    op: "add", type: "教训", kind: "守卫错", title: "备份回执漏传", symptom: "无 backup 字段", cause: "丢弃返回值", fix: "透传返回值",
  });
  assert(typeof lRes.backup === "string" || lRes.backupFailed !== undefined, "Single-file ledger_lessons omitted backup receipt");

  const activeAbs = path.join(root, "LEDGER.md");
  const foreignProj = fpMod.ensureProjectId({}).projectId;
  fs.writeFileSync(activeAbs, fpMod.applyFingerprint3("# 台账\n\n- 旧内容\n", { project: foreignProj, kind: "decisions", key: "wrong-key" }).text, "utf8");
  part4Mod.writeLedger(root, { target: "active", mode: "append", content: "- 新增内容\n" });
  const afterR3 = fpMod.readFingerprint3(fs.readFileSync(activeAbs, "utf8"));
  const expectedProj = fpMod.projectOf(root);
  assert(afterR3.id?.project === expectedProj && afterR3.id?.kind === "active" && afterR3.id?.key === "-",
    `writeLedger preserved stale/foreign fingerprint id ${JSON.stringify(afterR3.id)}`);
  return `goals.backup=${Boolean(gRes.backup)}, lessons.backup=${Boolean(lRes.backup)}, active.id=${JSON.stringify(afterR3.id)}`;
});

console.log(JSON.stringify(results, null, 2));
process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
