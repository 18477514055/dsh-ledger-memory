// ═══════════════════════════════════════════════════════════════════════════
// D216 · 回滚器的**反向验证**（在隔离副本上真跑，不碰真源）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么必须做（AGENTS.md 第四条第三款）：
//   *"回滚方案必须被**真实验证过**，不能只是'写了一个回滚脚本'。"*
//   ★ 本项目自己也栽过同型：**"配了就该跑"不是证据，要有可查计数器**。
//
// ★ 判据（全部要在隔离副本上真做出来）：
//   ① 改坏一个受管文件 ⇒ 预览必须报出它 ⇒ `--apply` 后**哈希回到备份值**；
//   ② 新增一个"拆分才会有的"多余模块 ⇒ `--apply` 后**它被删掉**
//      （否则 `lib/` 里会同时躺着新旧两份实现 —— 那比不拆更糟）；
//   ③ **台账 / 日志 / 归档 / 决策卡片必须一字未动**（它们不在受管范围内）；
//   ④ 回滚**之前**自动拍的那张"回滚前"快照**真的落盘了**（回滚本身可回滚）。
//
// 用法：node tools/_probe-d216-reverse.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const SRC = process.cwd();
const LATEST = path.resolve(SRC, "..", "..", "_插件备份", path.basename(SRC));
if (!fs.existsSync(LATEST)) {
  console.error(`❌ 还没做过备份：${LATEST}（先跑 _probe-d216-backup.mjs）`);
  process.exit(2);
}
const backups = fs
  .readdirSync(LATEST)
  .filter((d) => fs.existsSync(path.join(LATEST, d, "manifest.json")))
  .sort();
const BACKUP = path.join(LATEST, backups[backups.length - 1]);
console.log(`用这份备份做验证：${BACKUP}`);

// ── 隔离副本 ───────────────────────────────────────────────────────────────
const SANDBOX = path.resolve(SRC, "..", "_回滚自测", "子树");
fs.rmSync(path.resolve(SRC, "..", "_回滚自测"), { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
fs.cpSync(SRC, SANDBOX, { recursive: true, force: true, dereference: false });
console.log(`隔离副本：${SANDBOX}`);

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail === undefined ? "" : " —— " + detail}`);
};

// ── ① 改坏受管文件 + ② 新增多余模块 + ③ 动一下台账 ────────────────────────
const victim = path.join(SANDBOX, "lib", "index.js");
const goodHash = sha(victim);
fs.appendFileSync(victim, "\n// ★ 反向验证：故意改坏的一行\n", "utf8");
const brokenHash = sha(victim);
check("① 前置：受管文件确实被改坏了", brokenHash !== goodHash, `sha 变了`);

const extra = path.join(SANDBOX, "lib", "extra-module.mjs");
fs.writeFileSync(extra, "export const leftover = 1;\n", "utf8");
check("② 前置：确实多了一个'拆分才会有'的模块", fs.existsSync(extra), "lib/extra-module.mjs");

const ledger = path.join(SANDBOX, "LEDGER.md");
const ledgerHash = fs.existsSync(ledger) ? sha(ledger) : undefined;
const logDir = path.join(SANDBOX, "_ledger-log");
function dirHash(d) {
  if (!fs.existsSync(d)) return "";
  const out = [];
  const walk = (x) => {
    for (const e of fs.readdirSync(x, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(x, e.name);
      if (fs.lstatSync(p).isDirectory()) walk(p);
      else out.push(path.relative(d, p) + ":" + sha(p));
    }
  };
  walk(d);
  return out.join("|");
}
const logHash = dirHash(logDir);
const decisionsHash = dirHash(path.join(SANDBOX, "decisions"));

// ── ④ 预览（必须报出差异，且**一个字节都不改**）──────────────────────────
const rollbackScript = path.join(SRC, "tools", "_probe-d216-rollback.mjs");
let previewOut;
try {
  previewOut = execFileSync(process.execPath, [rollbackScript, BACKUP], {
    cwd: SANDBOX,
    encoding: "utf8",
  });
} catch (e) {
  check("④ 预览能跑通", false, String(e.message).slice(0, 200));
  previewOut = "";
}
check("④ 预览报出了被改坏的文件", previewOut.includes("lib/index.js"), undefined);
check("④ 预览报出了多余模块", previewOut.includes("extra-module.mjs"), undefined);
check("④ 预览**没有**改动任何东西", sha(victim) === brokenHash && fs.existsSync(extra), "预览后仍是坏的");

// ── ⑤ 真回滚 ──────────────────────────────────────────────────────────────
let applyOut;
try {
  applyOut = execFileSync(process.execPath, [rollbackScript, BACKUP, "--apply"], {
    cwd: SANDBOX,
    encoding: "utf8",
  });
  console.log("\n───── 回滚输出 ─────");
  console.log(applyOut.trim());
  console.log("────────────────────\n");
} catch (e) {
  check("⑤ 回滚能跑通", false, String(e.message).slice(0, 300));
  applyOut = "";
}
check("⑤ 受管文件哈希回到备份值", sha(victim) === goodHash, sha(victim).slice(0, 12) + " vs " + goodHash.slice(0, 12));
check("⑤ 多余模块被删掉（不会新旧并存）", !fs.existsSync(extra));

// ── ⑥ 台账 / 日志 / 决策卡片必须一字未动 ──────────────────────────────────
check("⑥ LEDGER.md 一字未动", (fs.existsSync(ledger) ? sha(ledger) : undefined) === ledgerHash);
check("⑥ _ledger-log/ 一字未动", dirHash(logDir) === logHash);
check("⑥ decisions/ 一字未动", dirHash(path.join(SANDBOX, "decisions")) === decisionsHash);

// ── ⑦ "回滚前"快照真的落盘了（回滚本身可回滚）─────────────────────────────
const sandboxBackups = path.resolve(SANDBOX, "..", "..", "_插件备份", path.basename(SANDBOX));
const hasPreRollback = fs.existsSync(sandboxBackups)
  ? fs.readdirSync(sandboxBackups).some((d) => d.includes("回滚前"))
  : false;
check("⑦ 回滚前自动拍了快照（回滚本身可回滚）", hasPreRollback, sandboxBackups);

// ── 收尾：清掉自测目录（含它自己在 _插件备份 里的产物）─────────────────────
fs.rmSync(path.resolve(SRC, "..", "_回滚自测"), { recursive: true, force: true });
fs.rmSync(sandboxBackups, { recursive: true, force: true });
const strayRoot = path.resolve(SANDBOX, "..", "..", "_插件备份");
if (fs.existsSync(strayRoot) && fs.readdirSync(strayRoot).length === 0) fs.rmSync(strayRoot, { recursive: true, force: true });
console.log("（自测目录已清理）");

const bad = results.filter((r) => !r.ok);
console.log("");
console.log(`结果：通过 ${results.length - bad.length} / ${results.length}`);
if (bad.length > 0) {
  for (const b of bad) console.log("  ❌ " + b.name + (b.detail ? " —— " + b.detail : ""));
  process.exitCode = 1;
} else {
  console.log("✅ 备份 → 回滚 这条链**真跑通过**（不是'写了个脚本'）。");
}
