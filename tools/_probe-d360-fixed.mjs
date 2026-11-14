// _probe-d360-fixed.mjs —— 016 七项**修复后**的守卫（断言反过来写：修好了才绿）
//
// ★ 为什么另写一份而不是改上面那两个：那两个是**缺陷取证器**（断言"缺陷存在"），
//   它们的价值在"证明报告没说错"那一刻。修好之后它们**必须变红**（否则就是断言过期，D323 #21）。
//   ⇒ 取证器保留原样（当作历史证据），守卫另写一份 —— 这才是正确分工。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LIB = (n) => "file:///" + path.join(ROOT, "lib", n).replace(/\\/g, "/");

const fp = await import(LIB("fingerprint.js"));
const cardOps = await import(LIB("card-ops.js"));
const part2 = await import(LIB("part2.js"));

let pass = 0, fail = 0;
const ok = (t, c, extra) => {
  if (c) { pass++; console.log(`  PASS  ${t}`); }
  else { fail++; console.log(`  FAIL  ${t}${extra === undefined ? "" : `\n        ${String(extra).slice(0, 500)}`}`); }
};
const mk = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `d360f-${t}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function mkV3(tag) {
  const root = mk(tag);
  const memName = `${path.basename(root)}-ledger-memory`;
  const mem = path.join(root, memName);
  for (const d of ["decisions", "lessons", "goals", "_arch"]) fs.mkdirSync(path.join(mem, d), { recursive: true });
  const mf = { version: 1, protocolVersion: 3, active: "LEDGER.md", archiveDir: "_arch", logDir: "_ledger-log",
    decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals",
    maxActiveLines: 400, revision: 0, projectId: "0123456789abcdef", memoryRoot: memName };
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify(mf, null, 2), "utf8");
  fs.writeFileSync(path.join(mem, ".dsh-ledger.json"), JSON.stringify(mf, null, 2), "utf8");
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# 台账\n\n## 目标\n测试\n", "utf8");
  return { root, mem };
}

console.log("═══ F-01 守卫：lessons / goals 改名后**能**按指纹找回 ═══");
{
  const src = read("lib/card-ops.js");
  const calls = src.split("\n").filter((l) => /readCardByFingerprint\(/.test(l) && !/function\s+readCardByFingerprint/.test(l));
  ok("① 调用点第 3 参是 `kind`，不再是字面量 \"decisions\"",
    calls.length > 0 && calls.every((l) => !/"decisions"/.test(l)), JSON.stringify(calls));
  ok("① fingerprintMismatchOf 现在**有** wantKind 参数", /function fingerprintMismatchOf\([^)]*wantKind/.test(src));

  const { root, mem } = mkV3("f01");
  for (const [dir, kind, key, body] of [
    ["lessons", "lessons", "L1", "## 教训 L1 · 尺子错\n\n- 标题: 甲\n- 根因: 乙\n"],
    ["goals", "goals", "g1", "## 目标 g1 · active\n\n- parent: -\n- title: 丙\n"],
  ]) {
    const w = fp.applyFingerprint3(body, { kind, project: "0123456789abcdef", key });
    fs.writeFileSync(path.join(mem, dir, `renamed-${key}.md`), w.text, "utf8");
    const info = part2.inspect(root);
    const r = cardOps.readEntryUnified(root, info, kind, key);
    ok(`② ${kind} 卡改名后**能**找回（resolvedBy=fingerprint）`,
      r !== undefined && r.found === true, JSON.stringify(r)?.slice(0, 260));
    ok(`② ${kind} 找回时**明说名字已变**（actualRel 指向真实位置）`,
      r !== undefined && typeof r.actualRel === "string" && r.actualRel.includes("renamed"), String(r?.actualRel));
  }

  // ③ kind 不符必须拒绝（跨类污染）
  const w2 = fp.applyFingerprint3("## 教训 L7 · 其他\n\n- 标题: x\n", { kind: "lessons", project: "0123456789abcdef", key: "L7" });
  fs.writeFileSync(path.join(mem, "decisions", "L7.md"), w2.text, "utf8");
  const info2 = part2.inspect(root);
  const r3 = cardOps.readEntryUnified(root, info2, "decisions", "L7");
  ok("③ 把 lessons 卡放进 decisions 目录 ⇒ **按 decisions 读必须拒绝**",
    r3 === undefined || r3.found === false, JSON.stringify(r3)?.slice(0, 300));
  rm(root);
}

console.log("\n═══ F-02 守卫：三载体指纹不再击穿标题/解析器 ═══");
{
  const { root, mem } = mkV3("f02");
  const w = fp.applyFingerprint3("## 教训 L2 · 守卫错\n\n- 标题: 甲\n- 根因: 乙\n",
    { kind: "lessons", project: "0123456789abcdef", key: "L2" });
  fs.writeFileSync(path.join(mem, "lessons", "L2.md"), w.text, "utf8");

  const toc = cardOps.renderCardToc(mem, "lessons");
  const titles = (toc.cards ?? []).map((c) => c.title);
  ok("① 目录标题**不是** \"---\"", titles.length > 0 && titles.every((t) => t !== "---"), JSON.stringify(titles));
  ok("① 目录标题**不含**行内信标", titles.every((t) => !t.includes("dsh-id")), JSON.stringify(titles));

  const info = part2.inspect(root);
  const r = cardOps.readEntryUnified(root, info, "lessons", "L2");
  ok("② ledger_read heading **不是** \"---\"", r?.heading !== "---" && typeof r?.heading === "string", String(r?.heading));
  ok("② heading **不含**信标", !String(r?.heading ?? "").includes("dsh-id"), String(r?.heading));

  const entries = part2.parseLessonEntries(fs.readFileSync(path.join(mem, "lessons", "L2.md"), "utf8"));
  const kinds = (entries ?? []).map((e) => e.kind);
  ok("③ kind **不被**信标污染", kinds.length > 0 && kinds.every((k) => !String(k).includes("dsh-id") && !String(k).includes("<!--")), JSON.stringify(kinds));

  // ④ 代码块围栏
  const raw = ["## 教训 L3 · 尺子错", "", "- 标题: 甲", "", "```md",
    "## 教训 L99 · 示例（不该被当卡片）", "```", "", "## 教训 L4 · 守卫错", "", "- 标题: 乙", ""].join("\n");
  const ids = (part2.parseLessonEntries(raw) ?? []).map((e) => String(e.id));
  ok("④ 围栏内 L99 **不被切出来**", !ids.includes("L99"), JSON.stringify(ids));
  ok("④ 围栏外 L3 / L4 **都在**", ids.includes("L3") && ids.includes("L4"), JSON.stringify(ids));

  // ⑤ projectOf 在任意目录名上都能读到（含记忆根反查）
  ok("⑤ projectOf(项目根) 读到 projectId", fp.projectOf(root) === "0123456789abcdef", String(fp.projectOf(root)));
  ok("⑤ projectOf(记忆根) 也读到", fp.projectOf(mem) === "0123456789abcdef", String(fp.projectOf(mem)));
  rm(root);
}

console.log("\n═══ F-03 守卫：matchedRoot 透传 + 跨平台盘符归一化 ═══");
{
  const src = read("lib/settings-http.js");
  const calls = src.split("\n").filter((l) => /(createExtension|updateExtension|deleteExtension)\(/.test(l) && !/function\s/.test(l));
  console.log("  调用点：");
  for (const l of calls) console.log(`    | ${l.trim()}`);
  ok("① 三个写操作**都传 matchedRoot**（不再传原始 root）",
    calls.length >= 3 && calls.every((l) => /matchedRoot/.test(l)), JSON.stringify(calls));
  const nm = /const normPath = \(p\) => \{[\s\S]{0,900}?\n\s*\};/.exec(src)?.[0] ?? "";
  console.log("  normPath：");
  console.log(nm.split("\n").map((l) => "    | " + l).join("\n").slice(0, 1000));
  ok("② normPath 对盘符路径**无条件**归一化（不再只在 win32/darwin）",
    /win32/.test(nm) && /test\(/.test(nm), nm.slice(0, 400));
}

console.log("\n═══ F-04 守卫：130② 不再写 PROJECT_ROOT ═══");
{
  const src = read("tools/selftest.mjs");
  ok("① 全文**不再有** `root: PROJECT_ROOT` 的 noteTool 调用", !/root:\s*PROJECT_ROOT/.test(src));
  ok("① 改成在临时目录里造 .git", /tmpGit130|mkdtempSync/.test(src) && /mkdirSync\([^)]*"\.git"/.test(src));
}

console.log("\n═══ F-05 守卫：符号链接纵深 ═══");
{
  const pure = read("lib/pure-ops.js"), mir = read("lib/manifest-mirror.js"), p2 = read("lib/part2.js"), co = read("lib/card-ops.js");
  ok("① mergeGitignore 有 isSymbolicLink 拦截", /isSymbolicLink/.test(pure));
  ok("① writeManifestSynced 有 isSymbolicLink 拦截", /isSymbolicLink/.test(mir));
  ok("② 候选目录探测改用 lstatSync（不跟随链接）", /lstatSync/.test(p2));
  ok("③ gateDir 增加 realpath 自根拦截", /realpathOf/.test(p2));
  ok("③ cardDirIsSafe 增加 realpath 自根拦截", /realpathOf/.test(co));
}

console.log("\n═══ F-06 守卫：ExtensionsPage 闭包依赖 ═══");
{
  const src = read("lib/client.js");
  const i = src.indexOf("ExtensionsPage");
  const seg = src.slice(i, i + 26000);
  ok("① 依赖数组含 view.data", /\[\s*root\s*,\s*load\s*,\s*view\.data/.test(seg), "");
  // ★ 2026-10-29（D362）：这条原来咬字面量 `p.root === (cur?.root ?? root)`。
  //   018 补丁把逻辑提成 `const effectiveRoot = cur?.root ?? root;` 再用它匹配 ——
  //   **行为完全一致、且更好读**，字面量却变了 ⇒ 探针假红（「断言也会过期」第 2 次）。
  //   判据改成**看它有没有真的用 cur 兜底 root**，而不是看它写成什么样。
  ok(
    "① 匹配项目时用 cur?.root 兜底（按行为判，不咬字面量）",
    /cur\?\.root\s*\?\?\s*root/.test(seg) && /p\.root === (?:effectiveRoot|\(cur\?\.root \?\? root\))/.test(seg),
    "",
  );
}

console.log("\n═══ F-07 守卫：.gitignore 与探针去硬编码 ═══");
{
  const gi = read(".gitignore");
  ok("① 有 `tools/_p*.txt` 通配", gi.includes("tools/_p*.txt"));
  ok("① 有 `tools/_msg-*.txt`", gi.includes("_msg-*"));
  ok("① 有 `tools/*.legacy`", /tools\/\*\.legacy/.test(gi));
  const probe = read("tools/_probe-d358-scope.mjs");
  ok("② 探针**不再硬编码**本机绝对路径", !probe.includes('"D:\\\\Deepseek工作区'));
  ok("② 探针用 import.meta.url 解析仓库根", /import\.meta\.url/.test(probe));
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
