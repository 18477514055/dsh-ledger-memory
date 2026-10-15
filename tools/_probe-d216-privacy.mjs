// ═══════════════════════════════════════════════════════════════════════════
// D216 · **发布前的隐私体检** —— 扫"将被公开的东西"里有没有本机专有信息
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 用户指令（逐字）：*"你可以提交一轮试试看，不过**别包含我们的准确信息**。"*
// ⇒ 判据：**要公开的范围到底有哪些**，不是"我觉得"，而是：
//    ① git 已跟踪的 154 个文件（会被 push 到 PUBLIC 仓库）；
//    ② npm 打包会带走的（`files` 白名单：lib/ + cordis.patch.yml + README.md）；
//    ③ 提交信息（commit message）本身。
//   ★ 三者**都可能泄露** —— 本探针逐个扫，并**分别报**（因为 ① 与 ② 的范围差很大：
//     `tools/` 有 147 个文件在 ① 里，但**不在** ② 里）。
//
// ★ 为什么必须**自己扫**而不是目测：本项目的历史里真有会话号 `a5dd`、
//   本机用户名 `24239`、真实盘符路径 —— 它们**混在注释里**，目测必漏（纪律 9 同型）。
//
// 用法：node tools/_probe-d216-privacy.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = process.cwd();

// ── 敏感模式（按"本机专有"定义，不是按"看起来敏感"）─────────────────────────
const PATTERNS = [
  ["会话编号 a5dd", /a5dd/i],
  ["本机用户名 24239", /24239/],
  ["真实盘符 D:\\Deepseek工作区", /D:\\Deepseek|D:\/Deepseek/],
  ["真实姓名 陈黛华", /陈黛华/],
  ["Windows 用户目录 C:\\Users\\<name>", /[A-Za-z]:\\Users\\[^\\\/\s"']+/],
  ["邮箱地址", /[\w.+-]+@[\w-]+\.[\w.]+/],
  ["npm token 字样", /npm_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}/],
  ["本地 home 硬编码", /C:\\Users\\24239/],
];

function scanFile(f) {
  let text;
  try {
    text = fs.readFileSync(path.join(REPO, f), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const [name, re] of PATTERNS) {
    const m = text.match(re);
    if (m !== null) out.push({ name, sample: String(m[0]).slice(0, 60) });
  }
  return out;
}

// ── ① 范围：git 已跟踪的文件（会被 push）────────────────────────────────────
const tracked = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 })
  .trim()
  .split("\n")
  .filter(Boolean);

// ── ② 范围：npm 包面（files 白名单展开）─────────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const shipped = [];
for (const entry of manifest.files ?? []) {
  const p = path.join(REPO, entry);
  if (!fs.existsSync(p)) continue;
  if (fs.statSync(p).isFile()) shipped.push(entry);
  else {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const q = path.join(d, e.name);
        if (e.isDirectory()) walk(q);
        else shipped.push(path.relative(REPO, q).split(path.sep).join("/"));
      }
    };
    walk(p);
  }
}
// package.json 自己通常也会进包（npm 默认带）
if (!shipped.includes("package.json")) shipped.push("package.json");

console.log(`═══ ① git 已跟踪（会被 push 到 PUBLIC 仓库）：${tracked.length} 个文件 ═══`);
const trackHits = [];
for (const f of tracked) {
  const h = scanFile(f);
  if (h.length) trackHits.push({ f, h });
}
if (trackHits.length === 0) console.log("  ✅ 未发现本机专有信息");
for (const { f, h } of trackHits) {
  console.log(`  ⚠ ${f}`);
  for (const x of h) console.log(`        ${x.name} —— 例：${x.sample}`);
}

console.log(`\n═══ ② npm 包面（files 白名单）：${shipped.length} 个文件 ═══`);
for (const f of shipped) console.log(`  ${f}`);
const shipHits = [];
for (const f of shipped) {
  const h = scanFile(f);
  if (h.length) shipHits.push({ f, h });
}
if (shipHits.length === 0) console.log("  ✅ 未发现本机专有信息");
for (const { f, h } of shipHits) {
  console.log(`  ⚠ ${f}`);
  for (const x of h) console.log(`        ${x.name} —— 例：${x.sample}`);
}

// ── ③ 提交信息（commit message 也会公开）────────────────────────────────────
console.log("\n═══ ③ 待提交的改动里，commit message 会写什么？（还没写，先看现状）═══");
console.log(`  当前 HEAD：${execFileSync("git", ["log", "-1", "--oneline"], { cwd: REPO, encoding: "utf8" }).trim()}`);
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean).length;
console.log(`  未提交条目：${dirty} 个（提交信息里**不要**写会话号/本机路径）`);

// ── ④ README（对外的那份）里有没有本机路径 ─────────────────────────────────
console.log("\n═══ ④ README（对外版）逐条看本机路径 ═══");
const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
const localPathHits = [...readme.matchAll(/[A-Z]:\\[^\s`)'"]+/g)].map((m) => m[0]);
console.log(`  含 Windows 绝对路径：${localPathHits.length} 处`);
for (const x of [...new Set(localPathHits)].slice(0, 15)) console.log(`      ${x}`);
const gPathHits = [...readme.matchAll(/[A-Z]:\/(?:[^\s`)'"]+)/g)].map((m) => m[0]);
if (gPathHits.length) {
  console.log(`  含正斜杠盘符路径：${gPathHits.length} 处`);
  for (const x of [...new Set(gPathHits)].slice(0, 10)) console.log(`      ${x}`);
}

console.log("\n═══ 结论 ═══");
const total = trackHits.length + shipHits.length;
if (total === 0) {
  console.log("✅ 两个范围都没扫到本机专有信息 ⇒ 可以进入发布流程。");
} else {
  console.log(`⚠ 有 ${trackHits.length} 个**已跟踪**文件 / ${shipHits.length} 个**包内**文件含本机信息。`);
  console.log("★ 注意：① 与 ② 要**分开处理** ——");
  console.log("   · 包内（②）会被每个用户下载 ⇒ **必须先清**；");
  console.log("   · 已跟踪但不进包（①，比如 tools/）会公开在 GitHub 上 ⇒ 也要清，但可以后处理。");
}
