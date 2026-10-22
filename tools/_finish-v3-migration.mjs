#!/usr/bin/env node
/**
 * 迁移后核对 + 手动完成 retire 那一步（跨盘 rename 失败）。
 *
 * ★ 为什么要手工做那一步：`fs.renameSync` **跨盘会报 EXDEV** ——
 *   项目在 D:，`_retired` 在 C:（`$DSH_HOME`）。迁移器用的就是 rename，所以失败了。
 *   ★★ 这是**迁移器的真实局限**，不是配置问题：只要项目与 DSH_HOME 不在同一个卷，就会撞上。
 *
 * ★ 顺序（一步都不能倒）：
 *   ① **先核对**：新目录里每个文件都与备份逐字节相同 ⇒ 才敢动旧文件
 *   ② **再把旧文件搬 `_retired`** —— 用「复制 + 删源」代替 rename（跨盘唯一可行的办法）
 *   ③ **最后核对**：项目根不再有记忆文件（只有一个权威源）
 *
 * 🔴 若 ① 有任何不符 ⇒ 立即停手，不搬任何东西。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.argv[2];
const BACKUP = process.argv[3];
if (!ROOT || !BACKUP) {
  console.error("用法：node _finish-v3-migration.mjs <项目根> <备份目录>");
  process.exit(1);
}

let pass = 0;
let fail = 0;
const ok = (label, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
};
const hashOf = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const mf = JSON.parse(fs.readFileSync(path.join(ROOT, ".dsh-ledger.json"), "utf8"));
const memAbs = path.join(ROOT, mf.memoryRoot);
const backupMf = JSON.parse(fs.readFileSync(path.join(BACKUP, "_backup-manifest.json"), "utf8"));

console.log("══════════ ① 核对：新目录 vs 备份（逐文件 sha256）══════════\n");

ok("①a 清单有 memoryRoot", typeof mf.memoryRoot === "string" && mf.memoryRoot !== "");
ok("①b 目标目录存在", fs.existsSync(memAbs), memAbs);

let missing = 0;
let mismatch = 0;
const missingList = [];
const mismatchList = [];
/**
 * ★★★ 2026-10-21（D297 真跑时撞到的真事）：**活动日志不可能是逐字节不变的**。
 *
 *   第一次核对报了「1 个不符」：`_ledger-log/2026-10/week3/L2-files-003.md`
 *   备份 92113 字节 → 新目录 94751 字节。
 *
 *   🔴 一查：**它是纯追加**（新内容完全以旧内容开头，多出来 2092 字符）——
 *      迁移本身在跑，而插件**正在往这份日志里写 L2 文件流水**（记录这次迁移动了哪些文件）。
 *      ⇒ **不是复制坏了，是"备份那一刻"与"核对那一刻"之间它 legitimately 又长了。**
 *
 *   ★ 判据：**活动日志允许纯追加，其余一律不许有任何差异。**
 *     这是「备份只保证那一刻的字节」那条纪律的具体落地 ——
 *     拿一个**会继续写的文件**去比"逐字节相同"，尺子本身就不对。
 *     ★★ 但**只放宽日志**：`LEDGER.md` / 决策卡 / 归档这些**不许**变 ——
 *       它们要是在迁移中变了，那才是真出事了。
 */
const APPEND_ONLY_PREFIX = "_ledger-log/";

for (const [rel, meta] of Object.entries(backupMf.files)) {
  const p = path.join(memAbs, rel);
  if (!fs.existsSync(p)) {
    missing += 1;
    if (missingList.length < 5) missingList.push(rel);
    continue;
  }
  const h = hashOf(p);
  if (h === meta.sha256) continue;

  // 唯一的例外：活动日志「纯追加」
  if (rel.startsWith(APPEND_ONLY_PREFIX)) {
    const oldText = fs.readFileSync(path.join(BACKUP, rel), "utf8");
    const newText = fs.readFileSync(p, "utf8");
    if (newText.startsWith(oldText)) continue; // 纯追加 ⇒ 可以
  }
  mismatch += 1;
  if (mismatchList.length < 5) mismatchList.push(rel);
}
ok(
  `①c 备份里 ${backupMf.fileCount} 个文件，新目录里一个不少`,
  missing === 0,
  missingList.join(", "),
);
ok(
  "①d 且内容一致（活动日志允许纯追加，其余逐字节相同）",
  mismatch === 0,
  mismatchList.join(", "),
);

if (missing > 0 || mismatch > 0) {
  console.log("\n❌ 核对未通过 ⇒ **不搬任何旧文件**。请先查清新目录缺了什么。");
  process.exit(1);
}

console.log("\n══════════ ② 把旧文件搬进 _retired（复制+删源，绕开跨盘）══════════\n");

const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const retiredRoot = path.join(home, "plugin-data", "dsh-ledger-memory", "_retired", path.basename(ROOT), stamp);

// 与备份同一份"要搬哪些"——直接用清单登记项
const rels = [];
for (const k of ["active","decisions","decisionsDir","journal","goals","goalsDir","lessons","lessonsDir","principles","archiveDir","logDir","handoffDir"]) {
  if (typeof mf[k] === "string" && mf[k] !== "" && !rels.includes(mf[k])) rels.push(mf[k]);
}
rels.push("_stash", "_handoff");

let moved = 0;
const moveByCopy = (rel) => {
  const from = path.join(ROOT, rel);
  const to = path.join(retiredRoot, rel);
  if (!fs.existsSync(from)) return;
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) moveByCopy(`${rel}/${e.name}`);
    // ★ 目录全搬完才删（删早了就没有回退余地）
    if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    // ★ 校验过再删源（跨盘：复制可能不完整）
    if (hashOf(to) === hashOf(from)) {
      fs.unlinkSync(from);
      moved += 1;
    }
  }
};

fs.mkdirSync(retiredRoot, { recursive: true });
for (const rel of rels) moveByCopy(rel);

console.log(`  搬走 ${moved} 个文件 → ${retiredRoot}`);

console.log("\n══════════ ③ 收尾核对：只有一个权威源 ══════════\n");

let left = 0;
const leftList = [];
for (const rel of rels) {
  if (fs.existsSync(path.join(ROOT, rel))) {
    left += 1;
    leftList.push(rel);
  }
}
ok("③a 项目根不再有记忆文件（唯一权威源）", left === 0, leftList.join(", "));
ok("③b _retired 里确实有东西", fs.existsSync(retiredRoot) && fs.readdirSync(retiredRoot).length > 0);
ok("③c 清单仍指向新目录", JSON.parse(fs.readFileSync(path.join(ROOT, ".dsh-ledger.json"), "utf8")).memoryRoot === mf.memoryRoot);

console.log("");
console.log(`_retired 路径：${retiredRoot}`);
console.log("════════════════════════════════════════════════════════════════");
console.log(`finish-v3 核对：${pass} PASS / ${fail} FAIL`);
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
