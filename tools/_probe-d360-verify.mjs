// _probe-d360-verify.mjs —— 逐项核实 Gemini 016 的七项，**不照抄报告**
//
// 判据：每条都要**构造出它会漏的输入**，看它是真缺陷还是假警报。
// ★ 纪律 22：要证明一条缺陷存在，必须构造**真能触发它**的输入。
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

const mk = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `d360-${tag}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };

/** 造一个带 projectId 的 V3 项目 */
function mkV3(tag, opts) {
  const root = mk(tag);
  const memName = opts?.memName ?? `${path.basename(root)}-ledger-memory`;
  const mem = path.join(root, memName);
  fs.mkdirSync(mem, { recursive: true });
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(mem, "lessons"), { recursive: true });
  fs.mkdirSync(path.join(mem, "goals"), { recursive: true });
  fs.mkdirSync(path.join(mem, "_arch"), { recursive: true });
  const manifest = {
    version: 1, protocolVersion: 3,
    active: "LEDGER.md", archiveDir: "_arch", logDir: "_ledger-log",
    decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals",
    maxActiveLines: 400, revision: 0,
    projectId: "0123456789abcdef",
    memoryRoot: memName,
  };
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(mem, ".dsh-ledger.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# 台账\n\n## 目标\n测试\n", "utf8");
  return { root, mem, memName };
}

console.log("═══ F-01：readEntryUnified 硬编码 \"decisions\" ═══");
{
  // ① 源码里是不是真硬编码
  //   ★ 尺子错（我自己犯的第 68 次）：第一版正则 `readCardByFingerprint\(root,\s*info,\s*([^,]+),` 会
  //     **先匹配到函数定义** `function readCardByFingerprint(root, info, kind, entry)`
  //     ⇒ 抓到的是形参 `kind` ⇒ 判"没有硬编码"（假阴性）。
  //   ★ 正解：**排除定义行**，只认前面不是 `function ` 的那些（情形 43 的老坑：别把定义当调用）。
  const src = fs.readFileSync(path.join(ROOT, "lib", "card-ops.js"), "utf8");
  const callLines = src.split("\n").filter((l) => /readCardByFingerprint\(/.test(l) && !/function\s+readCardByFingerprint/.test(l));
  console.log(`  调用点共 ${callLines.length} 行：`);
  for (const l of callLines) console.log(`    | ${l.trim()}`);
  const hardcoded = callLines.filter((l) => /readCardByFingerprint\([^)]*"decisions"/.test(l));
  ok("① 存在硬编码 \"decisions\" 的调用点（真缺陷）", hardcoded.length > 0, JSON.stringify(callLines));
  ok("① fingerprintMismatchOf 签名里**没有** wantKind 参数（未校验 kind）",
    /function fingerprintMismatchOf\(memBase, dirRel, entry, text, root\)/.test(src));

  // ② 行为验证：把 lessons 卡改名，看能不能按指纹找回
  const { root, mem } = mkV3("f01");
  // 手写一张带三载体指纹的 lessons 卡
  const body = "## 教训 L1 · 尺子错\n\n- 标题: 测试\n- 根因: 测试\n";
  const withFp = fp.applyFingerprint3(body, { kind: "lessons", project: "0123456789abcdef", key: "L1" });
  fs.writeFileSync(path.join(mem, "lessons", "renamed-xyz.md"), withFp.text, "utf8");
  const info = part2.inspect(root);
  const r = cardOps.readEntryUnified(root, info, "lessons", "L1");
  ok("② lessons 卡改名后**按指纹找不回**（F-01 真缺陷的行为证据）",
    r === undefined || r.found === false, JSON.stringify(r)?.slice(0, 300));
  // 同样的文件放到 decisions 目录，看 decisions 通道能不能找到（证明是 kind 写死）
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  const decBody = fp.applyFingerprint3("## D1 · 测试\n\n正文\n", { kind: "decisions", project: "0123456789abcdef", key: "D1" });
  fs.writeFileSync(path.join(mem, "decisions", "renamed-dec.md"), decBody.text, "utf8");
  const r2 = cardOps.readEntryUnified(root, info, "decisions", "D1");
  ok("② 但 decisions 通道**能**找回（说明就是 kind 写死）", r2 !== undefined && r2.found !== false, JSON.stringify(r2)?.slice(0, 200));
  rm(root);
}

console.log("\n═══ F-02：三载体指纹击穿标题提取 ═══");
{
  const { root, mem } = mkV3("f02");
  const body = "## 教训 L2 · 守卫错\n\n- 标题: 甲\n- 根因: 乙\n";
  const withFp = fp.applyFingerprint3(body, { kind: "lessons", project: "0123456789abcdef", key: "L2" });
  console.log("  —— 带指纹的卡片前 3 行 ——");
  console.log(withFp.text.split("\n").slice(0, 4).map((l) => "    | " + l).join("\n"));
  fs.writeFileSync(path.join(mem, "lessons", "L2.md"), withFp.text, "utf8");

  const info = part2.inspect(root);
  // renderCardToc
  //   ★ 尺子错（第 69 次）：真签名是 `renderCardToc(root, dirRel, limit, label)`，
  //     而卡片住在 **memoryBase** 下（V3）⇒ 必须传 mem，不是 root。
  //     我第一版传 root ⇒ count:0 ⇒ 拿"空目录"去判"标题有没有退化"，那是假绿/假红。
  const toc = cardOps.renderCardToc(mem, "lessons");
  const tocText = JSON.stringify(toc);
  console.log("  —— renderCardToc 输出 ——");
  console.log("    " + tocText.slice(0, 400));
  ok("① 目录里的标题**没有退化成 \"---\"**",
    !tocText.includes('"title":"---"'), tocText.slice(0, 400));
  ok("① 目录里的标题**是「教训 L2」**", tocText.includes("教训 L2"), tocText.slice(0, 400));

  // ledger_read 的 heading
  const r = cardOps.readEntryUnified(root, info, "lessons", "L2");
  console.log("  —— readEntryUnified.heading ——");
  console.log("    " + JSON.stringify(r?.heading));
  ok("② ledger_read 的 heading **不是 \"---\"**", r !== undefined && r.heading !== "---" && r.heading !== undefined, JSON.stringify(r?.heading));
  ok("② heading **不含行内信标**", r !== undefined && !String(r.heading ?? "").includes("dsh-id"), JSON.stringify(r?.heading));

  // parseLessonEntries 的 kind 污染
  const raw = fs.readFileSync(path.join(mem, "lessons", "L2.md"), "utf8");
  const entries = part2.parseLessonEntries(raw);
  console.log("  —— parseLessonEntries 结果 ——");
  console.log("    " + JSON.stringify(entries?.map?.((e) => ({ kind: e.kind, id: e.id })) ?? entries).slice(0, 400));
  const firstKind = entries?.[0]?.kind ?? entries?.entries?.[0]?.kind;
  ok("③ kind **不被 <!--dsh-id:…--> 污染**", typeof firstKind === "string" && !firstKind.includes("dsh-id") && !firstKind.includes("<!--"), String(firstKind));

  rm(root);
}

console.log("\n═══ F-02 补充：代码块围栏内的伪标题会不会被误切 ═══");
{
  const raw = [
    "## 教训 L3 · 尺子错",
    "",
    "- 标题: 甲",
    "",
    "```md",
    "## 教训 L99 · 示例标题（不该被当卡片）",
    "```",
    "",
    "## 教训 L4 · 守卫错",
    "",
    "- 标题: 乙",
    "",
  ].join("\n");
  const entries = part2.parseLessonEntries(raw);
  const ids = (entries?.map?.((e) => e.id) ?? entries?.entries?.map?.((e) => e.id) ?? []).map(String);
  console.log("  解析出的 id =", JSON.stringify(ids));
  ok("④ 围栏内的 L99 **不被当成条目**", !ids.includes("L99"), JSON.stringify(ids));
  ok("④ 围栏外的 L3 / L4 **都在**", ids.includes("L3") && ids.includes("L4"), JSON.stringify(ids));
}

console.log("\n═══ F-02 补充：projectOf 硬编码私有目录名 ═══");
{
  const { root, mem, memName } = mkV3("f02p");
  console.log(`  临时项目名 = ${path.basename(root)}，记忆目录 = ${memName}`);
  const p1 = fp.projectOf(root);
  const p2 = fp.projectOf(mem);
  console.log(`  projectOf(项目根) = ${p1}   projectOf(记忆根) = ${p2}`);
  ok("⑤ projectOf(项目根) 在**非 10.项目台账**目录上也能读到 projectId", p1 === "0123456789abcdef", String(p1));
  ok("⑤ projectOf(记忆根) 也能读到（父级反查 / 镜像）", p2 === "0123456789abcdef", String(p2));
  rm(root);
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
