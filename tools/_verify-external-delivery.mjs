#!/usr/bin/env node
/**
 * 外发交付的**机械验收**器（只读）。
 *
 * ★ 为什么要有它：用户原话是"我的目标是测一下他的工作完成度，**不过你来验收**"。
 *   ⇒ 验收不能靠"我读一遍觉得差不多"，那正是本项目纪律反复批的那种尺子。
 *   这里把**能机械判的**全部判掉（编码 / 存在性 / 数字 / 逐字命中 / 泄露 / 红线），
 *   剩下"写得好不好"才交给人判断。
 *
 * ★ 它**只读**：不改交付物、不改工程源码、不跑 npm、不联网。
 *
 * ★★ 设计上的一条纪律：**判不了就说"无法判定"，绝不猜成通过或失败。**
 *   （本项目踩过：把"文件不存在"当成"功能默认关生效"的证据 ⇒ D286。）
 *
 * 用法：
 *   node tools/_verify-external-delivery.mjs docs/外发交付-阶段4收尾-20261022
 *   退出码 0 = 机械项全过；1 = 有硬伤。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const DIR = path.resolve(ROOT, process.argv[2] ?? "docs/外发交付-阶段4收尾-20261022");

let pass = 0;
let fail = 0;
let unknown = 0;
const ok = (n, c, d) => {
  if (c) {
    pass += 1;
    console.log("  PASS  " + n);
  } else {
    fail += 1;
    console.log("  FAIL  " + n + (d === undefined ? "" : "  —— " + d));
  }
};
const q = (n, why) => {
  unknown += 1;
  console.log("  ？？  " + n + "  —— " + why);
};

console.log("═".repeat(70));
console.log("外发交付机械验收");
console.log("交付目录：" + DIR);
console.log("═".repeat(70));

if (!fs.existsSync(DIR)) {
  console.error("✗ 交付目录不存在");
  process.exit(1);
}

const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const files = walk(DIR);
const rel = (p) => path.relative(DIR, p).replace(/\\/g, "/");
console.log(`文件数：${files.length}\n`);

// ── ① 必交文件是否齐 ──────────────────────────────────────────────────────
console.log("── ① 必交文件 ──");
const REQUIRED = [
  ["README-交付说明.md", "总入口"],
  ["A-SECURITY.md", "SECURITY.md 正文"],
  ["B-README.patch.md", "README 逐处补丁"],
  ["C-package.patch.md", "version + description"],
  ["D-验收命令清单.md", "合并后验收步骤"],
];
const names = files.map(rel);
for (const [f, why] of REQUIRED) {
  const hit = names.find((n) => n === f || n.endsWith("/" + f));
  ok(`必交文件 ${f}（${why}）`, hit !== undefined, "没找到");
}
// 可选但建议
for (const f of ["A-代码补丁.md", "C-其它版本位.md"]) {
  const hit = names.find((n) => n === f || n.endsWith("/" + f));
  if (hit === undefined) q(`${f}（可选）`, "未交 —— 需人判是否可接受");
  else ok(`${f}（可选但已交）`, true);
}

// ── ② 编码：所有 .md/.json 必须 UTF-8 无 BOM ──────────────────────────────
console.log("\n── ② 编码（UTF-8 无 BOM）──");
let bom = [];
for (const p of files.filter((p) => /\.(md|json|txt|mjs|js)$/i.test(p))) {
  const b = fs.readFileSync(p);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) bom.push(rel(p));
}
ok("没有任何交付文件带 BOM", bom.length === 0, bom.join(" · "));

// ── ③ 交付物里不许内嵌记忆原文（这是红线）──────────────────────────────
console.log("\n── ③ 是否泄露项目记忆原文 ──");
{
  const MEM = path.join(ROOT, "10.项目台账-ledger-memory");
  const probes = [];
  for (const f of ["LEDGER.md", "JOURNAL.md", "PRINCIPLES.md"].map((f) => path.join(MEM, f))) {
    if (!fs.existsSync(f)) continue;
    for (const l of fs.readFileSync(f, "utf8").split("\n")) {
      const s = l.trim();
      if (s.length >= 40 && !/^[#>|]/.test(s)) probes.push(s);
    }
  }
  const ddir = path.join(MEM, "decisions");
  if (fs.existsSync(ddir)) {
    for (const f of fs.readdirSync(ddir)) {
      for (const l of fs.readFileSync(path.join(ddir, f), "utf8").split("\n")) {
        const s = l.trim();
        if (s.length >= 50 && !/^[#>|-]/.test(s)) probes.push(s);
      }
    }
  }
  const uniq = [...new Set(probes)];
  if (uniq.length < 100) q("泄露检查", `记忆正文样本只有 ${uniq.length} 行，样本太少，结果不可信`);
  else {
    const leaked = [];
    for (const p of files) {
      const s = fs.readFileSync(p, "utf8");
      let n = 0;
      for (const pr of uniq) if (s.includes(pr)) n += 1;
      if (n >= 2) leaked.push(`${rel(p)}(${n}行)`);
    }
    ok(`交付物里没有内嵌记忆原文（样本 ${uniq.length} 行）`, leaked.length === 0, leaked.join(" · "));
  }
}

// ── ④ 三条红线：补丁里不许出现网络 / child_process / 读凭据 ──────────────
console.log("\n── ④ 三条红线（新增能力扫描）──");
{
  const RISK = [
    [/\bhttps?:\/\/(?!localhost|127\.0\.0\.1)/, "出现外部 URL"],
    [/\b(fetch|axios|got|node-fetch)\s*\(/, "出现网络请求"],
    [/\bchild_process\b|execSync|spawnSync|execFileSync/, "出现 child_process"],
    [/(API_KEY|SECRET|TOKEN|password)\s*[:=]\s*["'][^"']{8,}/i, "疑似硬编码凭据"],
  ];
  const hits = [];
  for (const p of files) {
    const s = fs.readFileSync(p, "utf8");
    for (const [re, why] of RISK) {
      if (re.test(s)) hits.push(`${rel(p)}: ${why}`);
    }
  }
  // 交付说明里"提到"这些词是允许的（例如它解释"不许用 child_process"）
  ok("补丁/正文里没有新增网络、child_process 或硬编码凭据", hits.length === 0, hits.slice(0, 6).join(" · "));
}

// ── ⑤ C 项：version 必须是 1.5.0，description ≤400 且含三件事 ─────────────
console.log("\n── ⑤ 版本号与 description ──");
{
  const f = files.find((p) => rel(p).endsWith("C-package.patch.md"));
  if (f === undefined) q("C 项内容", "文件未交，无法判定");
  else {
    const s = fs.readFileSync(f, "utf8");
    ok("C 项写明 version 改成 1.5.0", /1\.5\.0/.test(s));
    ok("C 项没有把 version 写成 1.4.0（阶段 3 才用 1.4.0）", !/version[^\n]{0,20}1\.4\.0/.test(s));
    // description：尽力抽取被引号包住的候选
    const cands = [...s.matchAll(/["「]([^"」\n]{80,600})["」]/g)].map((m) => m[1]);
    const desc = cands.sort((a, b) => b.length - a.length)[0];
    if (desc === undefined) q("description 长度 ≤400", "没抽到候选文本，需人判");
    else {
      ok(`description 长度 ≤400（实际 ${desc.length}）`, desc.length <= 400);
      ok("description 提到「记忆目录/子目录」", /记忆目录|ledger-memory|子目录/.test(desc));
      ok("description 提到「扩展记忆」", /扩展记忆/.test(desc));
      ok("description 提到「4 页/四页」面板", /4\s*页|四页/.test(desc));
    }
  }
}

// ── ⑥ A 项：SECURITY.md 必须覆盖 §3.6 的五条要点 ──────────────────────────
console.log("\n── ⑥ SECURITY.md 覆盖度（§3.6 五条 + 边界声明）──");
{
  const f = files.find((p) => rel(p).endsWith("A-SECURITY.md"));
  if (f === undefined) q("SECURITY.md 正文", "文件未交");
  else {
    const s = fs.readFileSync(f, "utf8");
    const POINTS = [
      [/内部|专用|记忆区|记忆目录/, "① 该目录为内部项目记忆区域"],
      [/敏感|用户原话|使用者原话|长期上下文/, "② 含长期上下文与可能的用户原话等敏感内容"],
      // ★ 第一版这里写成 `/a/.source + ".*" + /b/.source` —— 那拼出来是**字符串**，
      //   `re.test(s)` 会直接崩（字符串没有 .test）。必须写成**一个正则字面量**。
      [/(不得|不许|禁止|不要)[\s\S]{0,40}(公开|复制|提交|推送)/, "③ 不得自行公开/复制/提交/推送"],
      [/授权|许可|同意/, "④ 确需共享须用户明确授权"],
      [/源码|代码|提交/, "⑤ 项目源码的正常 Git 提交不应包含记忆数据"],
    ];
    for (const [re, label] of POINTS) ok(`SECURITY.md 覆盖 ${label}`, re.test(s));
    ok(
      "SECURITY.md 有「不是 Git 隔离的唯一实现」这类边界声明",
      /唯一|不是.{0,12}隔离|仅.{0,6}提示|不能.{0,10}保证/.test(s)
    );
    const lines = s.split("\n").length;
    ok(`SECURITY.md 长度在 30~80 行（实际 ${lines}）`, lines >= 30 && lines <= 80);
  }
}

// ── ⑦ B 项：每处「原文（逐字）」必须在基线 README 里恰好命中 1 次 ────────
console.log("\n── ⑦ README 补丁的锚点是否可定位 ──");
{
  const f = files.find((p) => rel(p).endsWith("B-README.patch.md"));
  const readme = path.join(ROOT, "README.md");
  if (f === undefined) q("B 项", "文件未交");
  else if (!fs.existsSync(readme)) q("B 项锚点校验", "基线 README.md 不存在");
  else {
    const base = fs.readFileSync(readme, "utf8");
    const s = fs.readFileSync(f, "utf8");
    // 抽取形如「原文（逐字）：xxx」后面的那一行
    const anchors = [];
    for (const line of s.split("\n")) {
      const m = /原文（逐字）[：:]\s*(.+)$/.exec(line.trim());
      if (m !== null) {
        let a = m[1].trim();
        // 去掉外层反引号包裹
        a = a.replace(/^`+|`+$/g, "").trim();
        if (a.length >= 4) anchors.push(a);
      }
    }
    if (anchors.length === 0) q("B 项锚点数量", "一处「原文（逐字）」都没抽到，需人判格式");
    else {
      const bad = [];
      for (const a of anchors) {
        const n = base.split(a).length - 1;
        if (n !== 1) bad.push(`「${a.slice(0, 30)}」命中 ${n} 次`);
      }
      ok(`B 项 ${anchors.length} 处锚点在基线里各命中恰好 1 次`, bad.length === 0, bad.slice(0, 5).join(" · "));
    }
  }
}

// ── ⑧ 交付说明里必须有「额外发现的过期点」与「不确定」两节 ───────────────
console.log("\n── ⑧ 交付说明的自省项 ──");
{
  const f = files.find((p) => rel(p).endsWith("README-交付说明.md"));
  if (f === undefined) q("交付说明", "文件未交");
  else {
    const s = fs.readFileSync(f, "utf8");
    ok("交付说明里有「额外发现」一节", /额外发现|另外发现/.test(s));
    ok("交付说明里有「不确定/风险」一节", /不确定|风险|拿不准/.test(s));
    ok("交付说明里有逐项状态表", /状态|完成|未做|部分/.test(s));
  }
}

console.log("\n" + "═".repeat(70));
console.log(`PASS ${pass} · FAIL ${fail} · 无法判定 ${unknown}`);
console.log("★ 「无法判定」不是通过也不是失败 —— 那些需要人看。");
console.log("═".repeat(70));
process.exitCode = fail === 0 ? 0 : 1;
