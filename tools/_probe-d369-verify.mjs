#!/usr/bin/env node
/**
 * D369 取证器：逐条核实 `docs/Gemini静态审查021.md` 的 5 大类 / 10 个子项。
 *
 * ★★★ 断言一律写成「**缺陷不应该存在**」⇒ 跑在**未修**代码上会大面积 FAIL（这就是"报告属实"的证据），
 *   跑在**已修**代码上才全绿。★ 基线红数必须写进决策卡。
 *
 * ★★★★ 报告自称基线 `PASS 2346 · SKIP 1`，而本机实测是 `2359 / 5 SKIP` —— **数字不可信**，
 *   一律以本机实测为准；但结论必须逐条真调验证。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
const rows = [];
const ok = (title, cond, detail) => {
  if (cond) {
    pass += 1;
    rows.push(`PASS  ${title}${detail === undefined ? "" : ` — ${detail}`}`);
  } else {
    fail += 1;
    rows.push(`FAIL  ${title}${detail === undefined ? "" : ` — ${detail}`}`);
  }
};
const PID = "0123456789abcdef";
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `d369-${tag}-`));

const fp = await import("../lib/fingerprint.js");
const part2 = await import("../lib/part2.js");
const part4 = await import("../lib/part4.js");
const part8 = await import("../lib/part8.js");
const cardOps = await import("../lib/card-ops.js");
const mirror = await import("../lib/manifest-mirror.js");

function mkProject(tag, manifestOverride) {
  const root = tmp(tag);
  const man = {
    version: 3,
    memoryRoot: "proj-ledger-memory",
    projectId: PID,
    active: "LEDGER.md",
    journal: "JOURNAL.md",
    archiveDir: "_ledger-archive",
    ...manifestOverride,
  };
  const t = JSON.stringify(man, null, 2) + "\n";
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), t, "utf8");
  const mem = path.join(root, man.memoryRoot);
  try {
    fs.mkdirSync(mem, { recursive: true });
  } catch { /* 忽略 */ }
  return { root, mem, man };
}

// ═══════════════════════════════════════════════════════════════════
// F-01：memoryRoot / 文件角色自根（`.`）绕过 + 符号链接镜像欺骗
// ═══════════════════════════════════════════════════════════════════
{
  // F-01a-1：memoryRoot: "." 不得被 inspect 当成合法 V3 记忆根
  const { root, mem } = mkProject("f01a1", { memoryRoot: "." });
  const info = part2.inspect(root);
  const mr = info?.memoryRoot;
  ok("F-01a-1 inspect() 不接受 memoryRoot '.' 作为合法记忆根", mr !== ".", `memoryRoot=${JSON.stringify(mr)}`);

  // F-01a-2：memoryRootIgnoreLines(".") 不得返回 /./（会忽略整个仓库）
  const lines = part2.memoryRootIgnoreLines(info);
  const hasDotSlash = Array.isArray(lines) && lines.some((l) => l === "/./" || l === "/./" || /^\/\.\/$/.test(l));
  ok("F-01a-2 memoryRootIgnoreLines 不产出 '/./'（那会忽略整个仓库）", !hasDotSlash, JSON.stringify(lines));
  fs.rmSync(root, { recursive: true, force: true });
}

{
  // F-01a-3：manifestMirrorPath(".") 不得指向项目根本身
  const { root, mem } = mkProject("f01a3", { memoryRoot: "." });
  const p = mirror.manifestMirrorPath(root, { memoryRoot: "." });
  const isRootManifest = p !== undefined && path.resolve(p) === path.resolve(root, ".dsh-ledger.json");
  ok("F-01a-3 manifestMirrorPath('.') 不指向项目根权威清单自身", !isRootManifest, `mirror=${String(p)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

{
  // F-01a-4：清理前缀 ././ 与拒绝 "." 段
  const p2 = mirror.manifestMirrorPath("/proj", { memoryRoot: "././" });
  ok("F-01a-4 manifestMirrorPath('././') 被拒（多重 ./ 前缀）", p2 === undefined, String(p2));
}

{
  // F-01b：文件角色 active='.' 必须被**明确拒绝**
  // ★★★★★ 判据修正（本轮第一版假绿）：上一版我给的条件是 `res.ok === false || res.threw` ——
  //   而它"失败"的真实原因是 **EPERM: 不能 rename 一个目录**，**不是自根校验**。
  //   ⇒ 那是**意外的拦截**，不是被守住的拦截（尺子错：把"碰巧错了"当成"被拦住了"）。
  //   ★ 判据：必须带 `refused`（明确拒绝）或 reason 里说明"自根/不能当文件"，
  //     **不接受**"写盘时 EPERM"这种下游偶然失败。
  const { root, mem } = mkProject("f01b", { active: "." });
  let res;
  try {
    res = await part4.writeLedger(root, { target: "active", mode: "append", content: "- x\n", force: true }, { agent: undefined }, undefined);
  } catch (e) {
    res = { threw: String(e?.message ?? e) };
  }
  const explicitlyRefused =
    res?.ok === false &&
    res?.nothingWritten === true &&
    /self-root-forbidden/.test(String(res?.reason ?? ""));
  ok("F-01b 文件角色 active='.' 被**明确拒绝**（不是靠 EPERM 意外挡住）", explicitlyRefused, JSON.stringify(res)?.slice(0, 200));
  // 顺带记一条：inspect 把 activeRel 原样保留成 "."，这就是根因所在
  const infoDot = part2.inspect(root);
  ok("F-01b-2 inspect() 不把 activeRel 保留成 '.'", infoDot?.activeRel !== ".", `activeRel=${JSON.stringify(infoDot?.activeRel)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

{
  // F-01c：verifyManifestMirror 必须拦下指向根清单的符号链接镜像
  const { root, mem } = mkProject("f01c");
  const rootManifest = path.join(root, ".dsh-ledger.json");
  const mirrorPath = path.join(mem, ".dsh-ledger.json");
  let symOk = false;
  try {
    fs.symlinkSync(rootManifest, mirrorPath);
    symOk = true;
  } catch {
    symOk = false;
  }
  if (!symOk) {
    rows.push("INFO  F-01c 符号链接镜像：本机建不了 symlink ⇒ 本条**未测到**（不得写 PASS）");
  } else {
    const manifest = JSON.parse(fs.readFileSync(rootManifest, "utf8"));
    const v = mirror.verifyManifestMirror(root, manifest);
    const unsafe = v?.state !== "in-sync";
    ok("F-01c 指向根清单的符号链接镜像不被当作 in-sync", unsafe, `state=${JSON.stringify(v?.state)}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
// F-02：verifySeal 二次剥离误判 + 多载体 seal 失步
// ═══════════════════════════════════════════════════════════════════
{
  // F-02a：正文以 --- 开头且含另一条 --- 分隔线的文件，盖章后 verifySeal 必须 ok
  //
  // ★★★★★ 夹具修正（本轮第四个坑，也是同一个病）：第一版我用
  //   `"---\ntitle: 我的笔记\n---\n\n正文第一段\n\n---\n\n第二段\n"` ——
  //   **实测 strip 之后它以 `---` 开头、但二次剥离结果与一次剥离相同** ⇒ 测不出缺陷。
  //   原因：盖章时行内信标被插到第一条 `---` 之后，改变了剥离出的正文形状。
  //   ⇒ 换成实测**真会命中**的 `"---\nx\n---\ny\n"`（strip 后仍以 --- 开头且二次剥离会变）。
  //   ★ 判据：**先离线证明"这个夹具在旧代码上会红"，再拿它当守卫** ——
  //     否则全绿只能证明"这条路径没被走到"，不能证明修复有效。
  const body = "---\nx\n---\ny\n";
  const stamped = fp.applyFingerprint3(body, { kind: "active", project: PID, key: "-" }).text;
  const r3 = fp.readFingerprint3(stamped, {});
  const vs = fp.verifySeal(stamped, r3);
  ok("F-02a 正文以 --- 开头且含分隔线的文件，盖章后 verifySeal 仍 ok", vs.ok === true, JSON.stringify(vs));
}

{
  // F-02b：多个载体的 seal 不一致时必须报错（篡改文末 link 载体的 seal）
  const body = "# 流水\n\n- 一条\n";
  const stamped = fp.applyFingerprint3(body, { kind: "journal", project: PID, key: "-" }).text;
  const lines = stamped.split("\n");
  const idx = lines.findIndex((l) => l.startsWith("[dsh-fp-link]:"));
  let tampered = stamped;
  let didTamper = false;
  if (idx >= 0) {
    lines[idx] = lines[idx].replace(/seal=[0-9a-f]{8}/, "seal=deadbeef");
    tampered = lines.join("\n");
    didTamper = lines[idx] !== stamped.split("\n")[idx];
  }
  if (!didTamper) {
    rows.push("INFO  F-02b 找不到 [dsh-fp-link] 行 ⇒ 本条未测到");
  } else {
    const r3 = fp.readFingerprint3(tampered, {});
    const vs = fp.verifySeal(tampered, r3);
    ok("F-02b 文末 link 载体的 seal 被篡改后 verifySeal 必须报错", vs.ok === false, JSON.stringify(vs));
  }
}

// ═══════════════════════════════════════════════════════════════════
// F-03：仅行内信标时单文件写删崩溃 + GOALS/LESSONS 的 key 口径
// ═══════════════════════════════════════════════════════════════════
{
  // F-03a：只有行内信标的 PRINCIPLES.md，writePrinciples 不得抛异常
  const { root, mem } = mkProject("f03a", { principles: "PRINCIPLES.md" });
  const inlineOnly = "# 根本原则\n\n- 原则一 <!--dsh-id:" + PID + ":--->\n";
  fs.writeFileSync(path.join(mem, "PRINCIPLES.md"), inlineOnly, "utf8");
  let res;
  try {
    res = part2.writePrinciples(root, { content: "- 原则二\n", mode: "append" });
  } catch (e) {
    res = { threw: String(e?.message ?? e) };
  }
  ok("F-03a 仅行内信标的文件 writePrinciples 不抛异常", res?.threw === undefined, JSON.stringify(res)?.slice(0, 180));
}

{
  // F-03a-2：只有行内信标的 LEDGER.md，writeLedger 不得抛异常
  const { root, mem } = mkProject("f03a2");
  const inlineOnly = "# 台账\n\n- 条目A <!--dsh-id:" + PID + ":--->\n";
  fs.writeFileSync(path.join(mem, "LEDGER.md"), inlineOnly, "utf8");
  let res;
  try {
    res = await part4.writeLedger(root, { target: "active", mode: "append", content: "- 条目B\n", force: true }, { agent: undefined }, undefined);
  } catch (e) {
    res = { threw: String(e?.message ?? e) };
  }
  ok("F-03a-2 仅行内信标的台账 writeLedger 不抛异常", res?.threw === undefined, JSON.stringify(res)?.slice(0, 180));
}

{
  // F-03b：单文件 GOALS.md 首次盖章的 key 必须是 "-"（与 identityOfPath 一致）
  const { root, mem } = mkProject("f03b", { goals: "GOALS.md" });
  const gTool = (await import("../lib/part2-tools.js")).defineGoalsTool();
  const exec = { agent: { session: { header: { cwd: root, id: "s-f03b" } } } };
  let threw;
  try {
    await gTool.execute({ op: "upsert", id: "g1", title: "目标一", status: "root" }, exec);
  } catch (e) {
    threw = String(e?.message ?? e);
  }
  const goalsAbs = path.join(mem, "GOALS.md");
  let key = "(missing)";
  if (fs.existsSync(goalsAbs)) {
    const r3 = fp.readFingerprint3(fs.readFileSync(goalsAbs, "utf8"), {});
    key = r3?.id?.key;
  }
  ok("F-03b 单文件 GOALS.md 的指纹 key 是 '-'（与 identityOfPath 一致）", key === "-", `key=${JSON.stringify(key)} threw=${threw ?? "no"}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
// F-04：key="-" 单例冒充卡片 + conformanceOf 卡片计数失真
// ═══════════════════════════════════════════════════════════════════
{
  // F-04a：带 key="-" 的单例指纹文件冒充卡片 D1 时必须被拒
  //
  // ★★★★★ 判据修正（本轮第三个假红，也是最值钱的一条）：
  //   第一版我测的是 **底层 `readCard`** —— 它只负责"按文件名读字节"，本来就不做身份校验。
  //   真正的守门人是**工具层**：`part4.defineReadTool` 在 `readCard` 之后调
  //   `fingerprintMismatchOf`，命中就返回 `{ok:true, found:false, reason:...}`。
  //   ⇒ **在错误的层级测"身份校验"，测出来的红/绿都不算数。**
  //   ★ 判据：测**调用方真正走的那个入口**（工具 execute），不是它内部的一层 helper。
  const root = tmp("f04a");
  const dir = path.join(root, "decisions");
  fs.mkdirSync(dir, { recursive: true });
  const man = {
    version: 3,
    memoryRoot: ".",
    projectId: PID,
    active: "LEDGER.md",
    journal: "JOURNAL.md",
    decisionsDir: "decisions",
    archiveDir: "_a",
  };
  const manText = JSON.stringify(man, null, 2) + "\n";
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), manText, "utf8");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
  fs.writeFileSync(path.join(root, "JOURNAL.md"), "# 流水\n", "utf8");
  const fake = fp.applyFingerprint3("# 伪卡片\n\n- x\n", { kind: "decisions", project: PID, key: "-" }).text;
  fs.writeFileSync(path.join(dir, "D1.md"), fake, "utf8");

  const readTool = part4.defineReadTool();
  const exec = { agent: { session: { header: { cwd: root, id: "s-f04a" } } } };
  let out;
  try {
    out = await readTool.execute({ target: "decisions", entry: "D1" }, exec);
  } catch (e) {
    out = { threw: String(e?.message ?? e) };
  }
  // 拒绝的形态：found:false，且 reason 提到 key 不符（或整体不是 ok）
  const rejected =
    out?.threw !== undefined ||
    out?.found === false ||
    out?.ok === false ||
    (typeof out?.reason === "string" && /key=|不符|冒充/.test(out.reason));
  ok("F-04a key='-' 的单例指纹文件不能冒充卡片 D1（工具层读取必须拒）", rejected === true, JSON.stringify(out)?.slice(0, 220));
  fs.rmSync(root, { recursive: true, force: true });
}

{
  // F-04b：decisions/ 只有 README.md（0 张真卡）而单文件 DECISIONS.md 仍有未迁移决策时，
  //        conformanceOf **必须报出"单文件未迁移"这个问题**，而不能因为 README.md 被算成 1 张卡就闭嘴。
  //
  // ★★★★★ 判据修正（本轮第二版假绿）：第一版我把条件写成 `conf.verdict !== "ok"` ——
  //   而它"不是 ok"的真实原因是**缺 SECURITY.md / .gitignore 没覆盖记忆目录**，
  //   跟卡片计数**毫无关系**。⇒ 那是拿别的原因冒充本条修复（尺子错第 20 条同型）。
  // ★ 判据：只看**与卡片计数直接相关**的那部分输出（reasons / needsAI / notes 里有没有提未迁移单文件），
  //   并且要证明 `listCards` 与 `conformanceOf` 的口径一致。
  const root = tmp("f04b");
  const memName = "proj-ledger-memory";
  const mem = path.join(root, memName);
  fs.mkdirSync(mem, { recursive: true });
  const man = {
    version: 3,
    memoryRoot: memName,
    projectId: PID,
    active: "LEDGER.md",
    journal: "JOURNAL.md",
    decisionsDir: "decisions",
    lessonsDir: "lessons",
    goalsDir: "goals",
    archiveDir: "_ledger-archive",
    logDir: "_ledger-log",
    revision: 0,
  };
  const manText = JSON.stringify(man, null, 2) + "\n";
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), manText, "utf8");
  fs.writeFileSync(path.join(mem, ".dsh-ledger.json"), manText, "utf8");
  // ★ 把 SECURITY.md 与 .gitignore 都补齐，**排除掉那两个无关的干扰原因**
  fs.writeFileSync(path.join(mem, "SECURITY.md"), "# 安全\n", "utf8");
  fs.writeFileSync(path.join(root, ".gitignore"), `/${memName}/\n`, "utf8");
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# 台账\n", "utf8");
  fs.writeFileSync(path.join(mem, "JOURNAL.md"), "# 流水\n", "utf8");
  fs.writeFileSync(path.join(mem, "DECISIONS.md"), "# 决策\n\n## D1 · 一\n- a\n", "utf8");
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(mem, "decisions", "README.md"), "# 说明\n", "utf8");
  for (const d of ["lessons", "goals", "_ledger-archive", "_ledger-log"]) fs.mkdirSync(path.join(mem, d), { recursive: true });

  const info2 = part2.inspect(root);
  const conf = part2.conformanceOf(info2, root);
  const cards = cardOps.listCards(root, "decisions").length;
  const blob = JSON.stringify(conf);
  const mentionsUnmigrated = /未迁移|单文件|single-?file|unmigrated/i.test(blob);

  // ① 真卡数必须是 0（README.md 不算卡）
  ok("F-04b-1 decisions/ 里只有 README.md ⇒ listCards 返回 0 张卡", cards === 0, `cards=${cards}`);
  // ② conformanceOf 必须把"单文件还有未迁移决策"说出来，不许因 README 被算成卡而闭嘴
  ok("F-04b-2 conformanceOf 报出「单文件仍有未迁移决策」", mentionsUnmigrated, `verdict=${JSON.stringify(conf.verdict)}`);
  // ③ 更硬的一条：verdict 不能是 ok（0 张卡 + 有未迁移内容，绝不可能是 ok）
  ok("F-04b-3 该形态下 verdict 不得为 ok", conf?.verdict !== "ok", `verdict=${JSON.stringify(conf?.verdict)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
// F-05：part8 空模板误判 + 卡片模式丢指纹
// ═══════════════════════════════════════════════════════════════════
{
  // F-05a：stampDir 盖章后、未填内容的单文件扩展不得被误判 hasContent:true
  const { root, mem } = mkProject("f05a");
  const info = part2.inspect(root);
  const c = part8.createExtension(info, root, { name: "ext1", description: "d", mode: "journal" });
  const extId = c?.created?.id ?? "ext1";
  // 给扩展目录盖章（模拟 stampDir 已铺过指纹）
  fp.stampDir(root, (rel) => {
    const id = fp.identityOfPath(part2.inspect(root), path.join(root, rel));
    return id ? { ...id, project: PID } : undefined;
  });
  const list = part8.listExtensions(part2.inspect(root), root);
  const ext = (list?.extensions ?? []).find((e) => e.id === extId);
  const hasContent = ext?.usage?.hasContent;
  ok("F-05a 盖章后未填内容的单文件扩展 hasContent 必须为 false", hasContent === false, `hasContent=${JSON.stringify(hasContent)} detail=${JSON.stringify(ext?.usage?.detail)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(rows.join("\n"));
console.log("─".repeat(72));
console.log(`合计：PASS ${pass} · FAIL ${fail}`);
console.log("PROBE-COMPLETE");
process.exit(0);
