// _probe-d353-bounds.mjs —— 指纹的**能力边界**：到底什么情况下会认不出
// ★ 用户三问：
//   ① 各种软件/程序修改会不会破坏指纹？
//   ② 主动把整个文章删掉，还能认出身份吗？
//   ③ 这套身份系统能覆盖整个台账记忆体系吗？
// ★ 本探针只做一件事：**把破坏场景逐个真跑一遍**，看哪些活、哪些死。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  newProjectId, applyFingerprint, parseFingerprint, verifySeal,
  scanBlind, discoverProject,
} from "../lib/fingerprint.js";

const PROJ = newProjectId();
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e === undefined ? "" : "  ← " + e}`); } };
const eq = (n, a, b) => ok(n, a === b, `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-bounds-"));
const mk = (name, body, kind = "active", key = "-") => {
  const abs = path.join(tmpRoot, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, applyFingerprint(body, { kind, project: PROJ, key }).text, "utf8");
  return abs;
};

// ══════════════════════════════════════════════════════════
console.log("=== A. 常见编辑器/工具行为 —— 哪些能保留指纹 ===");
{
  const base = mk("a1.md", "# 标题\n\n正文\n");

  const cases = [
    ["原样（不出手）", (t) => t],
    ["去掉行尾空白 + 统一换行（多数格式化器）", (t) => t.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n")],
    ["在文件末尾追加内容", (t) => t + "\n新加一段\n"],
    ["在中间插入内容", (t) => t.replace("正文", "正文\n插入一行")],
    ["整体缩进（加两个空格）", (t) => t.split("\n").map((l) => "  " + l).join("\n")],
    ["改成 CRLF 换行（Windows 记事本/Word 转换）", (t) => t.replace(/\n/g, "\r\n")],
    ["重新排版：标题降级 / 列表改写", (t) => t.replace("# 标题", "## 标题").replace("正文", "- 正文")],
    ["加 UTF-8 BOM", (t) => "\uFEFF" + t],
    ["去掉所有空行", (t) => t.split("\n").filter((l) => l.trim() !== "").join("\n")],
    ["首尾加前后言（导出工具常见）", (t) => "<!-- generated -->\n" + t + "\n<!-- end -->\n"],
  ];

  for (const [name, fn] of cases) {
    const t = fs.readFileSync(base, "utf8");
    const out = fn(t);
    const p = parseFingerprint(out);
    const found = p.ok === true;
    console.log(`  ${found ? "✅" : "❌"} ${name}`);
    if (found) {
      // 身份是否仍然正确
      const idOk = p.fp.project === PROJ && p.fp.kind === "active";
      if (!idOk) console.log(`      ⚠ 身份字段变了: ${JSON.stringify(p.fp)}`);
    }
  }

  // ★★★ 关键破坏场景：会 strip HTML 注释的工具
  console.log("\n  --- 会「吃掉 HTML 注释」的工具（这是真危险）---");
  const stripComment = (t) => t.replace(/<!--[\s\S]*?-->/g, "");
  {
    const t = fs.readFileSync(base, "utf8");
    const out = stripComment(t);
    const p = parseFingerprint(out);
    eq("★★★ 剥离 HTML 注释的工具 ⇒ 指纹被吃掉", p.ok, false);
    console.log(`      ⇒ 这是**真实存在的风险**：某些 Markdown linter / 导出器 / 富文本转换会清注释`);
  }
  // Markdown → HTML → Markdown 往返
  console.log("\n  --- Markdown→HTML→Markdown 往返（Typora 导出、邮件粘贴常见）---");
  {
    const t = fs.readFileSync(base, "utf8");
    // 粗模拟：HTML 注释在 Markdown 渲染里不显示 ⇒ 往返会丢
    const roundTrip = t.replace(/<!--[\s\S]*?-->/g, "").replace(/^# /gm, "").trim();
    const p = parseFingerprint(roundTrip);
    eq("★★★ 富文本往返 ⇒ 指纹丢失", p.ok, false);
  }
}

// ══════════════════════════════════════════════════════════
console.log("\n=== B. ★★★★★ 用户第二问：把整个文章删掉，还认得出吗 ===");
{
  const base = mk("b1.md", "# 很重要的一份台账\n\n这里是全部内容\n");
  eq("删之前：认得出", parseFingerprint(fs.readFileSync(base, "utf8")).ok, true);

  // ① 清空全部内容
  fs.writeFileSync(base, "", "utf8");
  eq("★ 清空为 0 字节 ⇒ 认不出", parseFingerprint(fs.readFileSync(base, "utf8")).ok, false);
  console.log("      （这是必然的：指纹就写在文件里，内容没了指纹也没了）");

  // ② 只保留指纹行（"保留壳"）
  fs.writeFileSync(base, applyFingerprint("", { kind: "active", project: PROJ, key: "-" }).text, "utf8");
  const p2 = parseFingerprint(fs.readFileSync(base, "utf8"));
  eq("★★ 只留指纹行（壳还在）⇒ 认得出", p2.ok, true);
  eq("★★ 且身份正确", p2.fp.project, PROJ);

  // ③ 部分删除：删掉正文一半
  const half = mk("b2.md", "# 台账\n第一段\n第二段\n第三段\n");
  fs.writeFileSync(half, applyFingerprint("# 台账\n第一段\n", { kind: "active", project: PROJ, key: "-" }).text, "utf8");
  eq("★★ 删掉一半正文 ⇒ 仍认得出（指纹没动）", parseFingerprint(fs.readFileSync(half, "utf8")).ok, true);

  // ④ ★ 关键：删掉全部内容后，还能从**别处**认回它是谁吗？
  console.log("\n  --- 内容全删后，靠什么还能知道「这里本该有什么」---");
  const mem = path.join(tmpRoot, "mem");
  fs.mkdirSync(mem, { recursive: true });
  // 清单里记着"应该有 active / journal"
  const manifest = { projectId: PROJ, expect: { active: "LEDGER.md", journal: "JOURNAL.md" } };
  fs.writeFileSync(path.join(mem, ".dsh-ledger.json"), JSON.stringify(manifest, null, 2), "utf8");
  // active 有内容+指纹，journal 被清空
  fs.writeFileSync(path.join(mem, "LEDGER.md"), applyFingerprint("内容\n", { kind: "active", project: PROJ, key: "-" }).text, "utf8");
  fs.writeFileSync(path.join(mem, "JOURNAL.md"), "", "utf8");

  const scan = scanBlind(mem, { project: PROJ });
  eq("★ 清空的那个文件**不在扫描结果里**", (scan.byKind.get("journal") ?? []).length, 0);
  console.log("      ⇒ 结论：**内容全删 = 身份不可恢复**（只能靠清单/文件名说'这里本该有 journal'，");
  console.log("         但不能证明'这个空文件就是它'）");
}

// ══════════════════════════════════════════════════════════
console.log("\n=== C. 另一个边界：清单 .dsh-ledger.json 能加指纹吗 ===");
{
  const json = JSON.stringify({ a: 1 }, null, 2);
  const withFp = applyFingerprint(json, { kind: "manifest", project: PROJ, key: "-" }).text;
  console.log("  加指纹后的内容前 80 字符:", JSON.stringify(withFp.slice(0, 80)));
  let parseable = true;
  try { JSON.parse(withFp); } catch { parseable = false; }
  eq("★★★ 加了指纹的 JSON **仍能被 JSON.parse**", parseable, true);
  console.log("      ⇒ 因为 HTML 注释不是合法 JSON，所以上面必然失败；");
  console.log("         但请注意：我们**不往 JSON 里加指纹**（下面诚实说明）");
}

// ══════════════════════════════════════════════════════════
console.log("\n=== D. 覆盖度：台账记忆体系现在的全部文件类型 ===");
{
  const MEM = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账\\10.项目台账-ledger-memory";
  const kinds = [
    ["LEDGER.md", "active", "单文件"],
    ["JOURNAL.md", "journal", "单文件"],
    ["PRINCIPLES.md", "principles", "单文件"],
    ["SECURITY.md", "security", "单文件"],
    ["decisions/", "decisions", "卡片"],
    ["lessons/", "lessons", "卡片"],
    ["goals/", "goals", "卡片"],
    ["_handoff/", "handoff", "卡片/单文件"],
    ["_stash/", "stash", "碎片"],
    ["_ledger-archive/", "archive", "归档"],
    ["_ledger-log/", "log", "日志"],
    ["extensions/", "extension", "扩展记忆"],
    [".dsh-ledger.json", "manifest", "★ 清单（JSON，不能加注释）"],
  ];
  let exist = 0, missing = 0;
  for (const [rel, kind, note] of kinds) {
    const abs = path.join(MEM, rel);
    const has = fs.existsSync(abs);
    if (has) exist++; else missing++;
    console.log(`  ${has ? "✅" : "—"} ${rel.padEnd(20)} kind=${kind.padEnd(12)} ${note}`);
  }
  console.log(`\n  存在 ${exist} 项 · 不存在 ${missing} 项`);
  eq("★ 需要覆盖的类别数", kinds.length, 13);

  // 统计各目录文件数（真实）
  const countMd = (d) => {
    let n = 0;
    const walk = (p) => {
      let es; try { es = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const q = path.join(p, e.name);
        if (e.isDirectory()) walk(q);
        else if (e.name.endsWith(".md")) n++;
      }
    };
    walk(path.join(MEM, d));
    return n;
  };
  console.log("\n  各目录 .md 文件数（真实）：");
  for (const d of ["decisions", "lessons", "goals", "_handoff", "_stash", "_ledger-archive", "_ledger-log", "extensions"]) {
    console.log(`    ${d.padEnd(18)} ${countMd(d)}`);
  }
}

// ══════════════════════════════════════════════════════════
console.log("\n=== E. 一个绕过指纹缺失的办法：靠清单「期望表」报缺 ===");
{
  // 演示：清单记期望，文件被清空 ⇒ 能报"缺失"，但报不出"身份"
  const mem = path.join(tmpRoot, "mem2");
  fs.mkdirSync(mem, { recursive: true });
  const expect = { active: "LEDGER.md", journal: "JOURNAL.md", principles: "PRINCIPLES.md" };
  fs.writeFileSync(path.join(mem, ".dsh-ledger.json"), JSON.stringify({ projectId: PROJ, expect }, null, 2), "utf8");
  fs.writeFileSync(path.join(mem, "LEDGER.md"), applyFingerprint("有\n", { kind: "active", project: PROJ, key: "-" }).text, "utf8");
  // journal 与 principles 都被清空
  fs.writeFileSync(path.join(mem, "JOURNAL.md"), "", "utf8");
  fs.writeFileSync(path.join(mem, "PRINCIPLES.md"), "", "utf8");

  const scan = scanBlind(mem, { project: PROJ });
  const found = new Set(scan.byKind.keys());
  const missingKinds = Object.keys(expect).filter((k) => !found.has(k));
  eq("★★ 清单期望表能报出「缺哪几类」", missingKinds.sort().join(","), "journal,principles");
  console.log(`      ⇒ 但只能报**类别缺失**，不能确认「那个空文件就是它」`);
  console.log(`      ⇒ 这是**"存在性"与"同一性"的分界**，必须对用户讲清`);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail !== 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
