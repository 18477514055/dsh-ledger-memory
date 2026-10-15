// ═══════════════════════════════════════════════════════════════════════════
// D216 · 拆分的**完整性证明**：没有丢代码、没有改代码（纯搬家）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么这是**最关键**的一条判据（比"自检全绿"更重要）：
//   自检绿的**只覆盖它测到的路径**。若生成器**静默漏掉一条声明**，而那条声明
//   恰好在自检没走到的分支里 ⇒ **照样全绿**（纪律 11：记录存在 ≠ 记录准确；
//   纪律 2：判据的输入必须是被测对象自己产生的）。
//   ⇒ 必须**静态**证明：原文件的每一条顶层声明，都能在拆分后的文件里**逐字节**找到
//     （唯一允许的差异是行首多一个 `export `）。
//
// 判据：
//   ① 原文件 467 条声明的**名字集合** ⊆ 拆分后的全部名字集合（无丢失）
//   ② 每条声明的**正文**（去掉行首 `export ` 前缀后）**逐字节相同**（无篡改）
//   ③ 拆分的总字节 ≈ 原文件 + import/export 行（增量合理，且能解释）
//
// 用法：node tools/_probe-d216-completeness.mjs [原文件备份目录]
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const REPO = process.cwd();
const args = process.argv.slice(2);

// 原文件从哪来：优先用参数给的备份目录，否则从 git HEAD 取
let original = null;
let originNote = "";
if (args[0] && fs.existsSync(path.join(args[0], "lib", "index.js"))) {
  original = fs.readFileSync(path.join(args[0], "lib", "index.js"), "utf8");
  originNote = args[0];
} else {
  // 从最近一次备份目录里取（`_插件备份/…`）
  const backupRoot = path.resolve(REPO, "..", "..", "_插件备份", path.basename(REPO));
  if (fs.existsSync(backupRoot)) {
    const dirs = fs
      .readdirSync(backupRoot)
      .filter((d) => fs.existsSync(path.join(backupRoot, d, "lib", "index.js")))
      .sort();
    if (dirs.length > 0) {
      const last = path.join(backupRoot, dirs[dirs.length - 1]);
      original = fs.readFileSync(path.join(last, "lib", "index.js"), "utf8");
      originNote = last;
    }
  }
  if (original === null) {
    // 退路：git HEAD 的版本（注意：HEAD 是**旧**版，可能与拆分时的工作区不同）
    try {
      original = execFileSync("git", ["show", "HEAD:lib/index.js"], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });
      originNote = "git HEAD（⚠ 可能是旧版，不一定是拆分那一刻的工作区）";
    } catch {
      original = null;
    }
  }
}
if (original === null) {
  console.error("❌ 找不到原文件（既没有可用备份，也取不到 git HEAD）");
  process.exit(2);
}
console.log(`原文件来源：${originNote}`);
console.log(`原文件大小：${Buffer.byteLength(original, "utf8")} B\n`);

/** 抽顶层声明（第 0 列 + 模式）。返回 {name, kind, text}（text 已去掉行首 `export `）。 */
function declsOf(text) {
  const lines = text.split("\n");
  const re = /^(export\s+)?(async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (m !== null) starts.push({ line: i + 1, kind: m[3], name: m[4] });
  }
  const out = [];
  for (let k = 0; k < starts.length; k += 1) {
    const s = starts[k];
    const next = k + 1 < starts.length ? starts[k + 1].line : lines.length + 1;
    let end = next - 1;
    while (end > s.line && lines[end - 1].trim() === "") end -= 1;
    let body = lines.slice(s.line - 1, end).join("\n");
    // 去掉**行首**的 `export `（只去第一行的，且只去一次）
    body = body.replace(/^export\s+/, "");
    out.push({ ...s, body });
  }
  return out;
}

const origDecls = declsOf(original);
const origMap = new Map(origDecls.map((d) => [d.name, d]));

// 拆分后的全部模块
const libDir = path.join(REPO, "lib");
const modFiles = fs.readdirSync(libDir).filter((f) => f.endsWith(".js") && f !== "client.js");
const splitText = modFiles.map((f) => fs.readFileSync(path.join(libDir, f), "utf8")).join("\n");
// ★★★★★ 2026-10-15（D216 修补）：这里原来写的是 `if (!splitDecls.has(d.name)) set(…)`
//   —— **第一个赢**。拼接顺序里 `index.js` 排在 `part6.js` 前面 ⇒
//   `apply` 的**重复副本**被**静默忽略** ⇒ 这条判据证明了"467 条一条不丢"，
//   却**完全看不见"多出来一份 apply"**（那份一路进了 v1.2.0 的发布包）。
//   ⇒ 改成**保留全部出现点**，另立一条"跨文件重复"的判据（见 ④）。
//   ★ 纪律 2 的同型复发：判据必须覆盖**两个方向**（丢了 / 多了），只核一边 = 半边瞎。
const splitDecls = new Map();
const splitAll = []; // ★ 全部出现点（含跨文件重复），供 ④ 判重
for (const f of modFiles) {
  const t = fs.readFileSync(path.join(libDir, f), "utf8");
  for (const d of declsOf(t)) {
    splitAll.push({ ...d, file: f });
    if (!splitDecls.has(d.name)) splitDecls.set(d.name, { ...d, file: f });
  }
}

console.log(`原文件顶层声明：${origDecls.length} 条`);
console.log(`拆分后顶层声明：${splitDecls.size} 条（${modFiles.length} 个模块）\n`);

// ── ① 无丢失 ───────────────────────────────────────────────────────────────
const missing = [];
for (const d of origDecls) if (!splitDecls.has(d.name)) missing.push(d.name);
console.log(`① 丢失的声明：${missing.length} 条`);
for (const m of missing.slice(0, 25)) console.log(`     ⛔ ${m}`);

// ── ② 逐字节相同（去 export 后）─────────────────────────────────────────────
const diff = [];
for (const d of origDecls) {
  const s = splitDecls.get(d.name);
  if (s === undefined) continue;
  // 归一化：去掉可能多出来的 `export `（splitDecls 已去）、并把连续空行折叠
  const norm = (x) => x.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (norm(d.body) !== norm(s.body)) {
    diff.push({ name: d.name, file: s.file, origLen: d.body.length, splitLen: s.body.length });
  }
}
console.log(`\n② 正文不一致的声明：${diff.length} 条`);
for (const d of diff.slice(0, 25)) {
  console.log(`     ⛔ ${d.name}（${d.file}）原 ${d.origLen} 字符 vs 拆后 ${d.splitLen} 字符`);
}
// ★★ 2026-10-15（D216 修补）：**读这条输出前先看这一句** ——
//   本判据比的是"原文件 vs **当下工作区**"。若你传的原件是**拆分那一刻**的备份，
//   而此后又有**有意的**文案/隐私改动，那些改动**会**被算进"正文不一致"。
//   ★ 判别法（别凭印象）：用 `tools/_probe-d216-diff5.mjs` 把不同的行**逐字打出来**，
//     看它们是不是"自己刚改的那些"。
//   ★ 实测（2026-10-15 20:4x）：对 `2026-10-15-181611-拆分实施前` 跑出 **5 条**，
//     逐字核对后**全部是有意改动**：4 处隐私清理（删掉会话号 ×2 / 本机用户名的路径 /
//     一个真实用户名）+ 1 处 D221 文案（`LEDGER_SUBCOMMANDS` 的「四档→五档」与 mode 标签）。
//     ⇒ **不是拆分损坏**（丢失 0 / 多余 0 才是本判据要守的东西）。
//   ⚠️ **本条注释本身踩过一次坑（留档）**：第一版我把那几个真值**逐字写进了这里**，
//     而 `tools/` 在公开仓库里 ⇒ 等于**为了解释"隐私清理"而又泄露一次**
//     （被 `_probe-d216-privacy.mjs` 当场抓到）。⇒ **反例一律写占位，不写真值。**
//   ⇒ 想要一条"纯搬家"的干净对照，请传**拆分刚完成、尚未做任何编辑**的那份备份。

// ── ③ 增量解释 ─────────────────────────────────────────────────────────────
const origBytes = Buffer.byteLength(original, "utf8");
const splitBytes = modFiles.reduce((a, f) => a + fs.statSync(path.join(libDir, f)).size, 0);
const importLines = modFiles.reduce(
  (a, f) => a + (fs.readFileSync(path.join(libDir, f), "utf8").match(/^import .*$/gm) ?? []).length,
  0
);
console.log(`\n③ 字节：原 ${origBytes} → 拆后 ${splitBytes}（+${splitBytes - origBytes}）`);
console.log(`    拆分后共 ${importLines} 行 import（每行约 40~90 B ⇒ 合计约 ${importLines * 60} B 属于新增）`);

// ── ④ ★★★ 新增（D216 修补）：**多出来的声明** —— 原来缺的就是这个方向 ────────
//
// 判据：同一个名字出现在**两个不同的模块文件**里 ⇒ 重复声明。
//   ★ 这正是当初漏掉的那半边：① 只问"原文件的都在吗"（丢了没有），
//     **从不问"拆出来的都在原文件里吗"（多了没有）**。
//   ★ 2026-10-15 实测：`apply` 同时出现在 `index.js` 与 `part6.js`，
//     而本判据当时是绿的 —— 那份副本进了 v1.2.0 的 npm 包。
const byName2 = new Map();
for (const d of splitAll) {
  if (!byName2.has(d.name)) byName2.set(d.name, []);
  byName2.get(d.name).push(d.file);
}
const dupAcross = [...byName2.entries()].filter(([, fs_]) => new Set(fs_).size > 1);
console.log(`\n④ ★ 跨模块重复的声明：${dupAcross.length} 个（这一条是 2026-10-15 补上的）`);
for (const [nm, fs_] of dupAcross) {
  console.log(`     ⛔ ${nm} —— ${[...new Set(fs_)].join(" / ")}`);
  // 尽最大努力指出"多余的那一份"在哪个文件（及其字节数），便于处置
  for (const f of new Set(fs_)) {
    const d = splitAll.find((x) => x.name === nm && x.file === f);
    console.log(`          ${f}（该声明 ${Buffer.byteLength(d.body, "utf8")} B）`);
  }
}
if (dupAcross.length === 0) console.log("     ✅ 无（每个名字只属于一个模块）");

const bad = missing.length + diff.length + dupAcross.length;
console.log(
  `\n${bad === 0 ? "✅" : "⛔"} 结论：` +
    (bad === 0
      ? "**纯搬家** —— 无丢失、无篡改、**无多余**（两个方向都核过了）"
      : `${bad} 处问题（丢失 ${missing.length} · 篡改 ${diff.length} · 多余 ${dupAcross.length}）`)
);
if (bad > 0) process.exitCode = 1;
