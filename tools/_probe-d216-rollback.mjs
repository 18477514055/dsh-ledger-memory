// ═══════════════════════════════════════════════════════════════════════════
// D216 · 从备份回滚（**默认只预览，`--apply` 才动手**）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 用户原话（逐字）：*"第三点就是你在拆分前，我的建议是先备份再拆分。要有回滚的能力。"*
//
// ★★★ 三条硬纪律（本脚本就是照它们写的）：
//   ① **默认 dry-run** —— 不传 `--apply` 只打印"会做什么"，一个字节都不改。
//      （"会打断用户当前工作的不可逆操作不许无人值守执行"。）
//   ② **回滚自己也要可回滚**：真回滚**之前**，先把"当前状态"再拍一张快照
//      （复用 `_probe-d216-backup.mjs`）⇒ 回滚错了还能再回来。
//   ③ **用副本自己的哈希判据**，不信文件名、不信时间戳
//      （`manifest.json` 是备份时逐文件算的 sha256）。
//
// ★★ 为什么回滚不是"复制回去"这么简单：
//   · 拆分**会新增文件**（新模块）⇒ 单靠"覆盖"会留下**不属于旧版的多余模块**，
//     那会让 `lib/` 里同时存在新旧两份实现（比拆坏更糟）。
//   ⇒ 所以回滚必须**先删掉"副本里没有、而当前有"的那部分**，
//     但**只能删在受管范围里**的（`lib/`、`tools/` 之类），**绝不整树清空**
//     —— 因为台账/日志在这些操作之后可能又长出了新内容（那是要留的）。
//
// 用法：
//   node tools/_probe-d216-rollback.mjs <备份目录>            # 预览
//   node tools/_probe-d216-rollback.mjs <备份目录> --apply    # 真回滚
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const SRC = process.cwd();

/** ★ 回滚只碰这些子树 —— 其余（台账/日志/归档/交接单）**一律不动**。 */
const MANAGED = ["lib", "tools", "cordis.patch.yml", "package.json", "README.md", "LICENSE", ".gitignore"];

const backupDir = process.argv[2];
const APPLY = process.argv.includes("--apply");

if (backupDir === undefined) {
  console.error("用法：node tools/_probe-d216-rollback.mjs <备份目录> [--apply]");
  process.exit(2);
}
const ABS = path.resolve(backupDir);
const manifestFile = path.join(ABS, "manifest.json");
if (!fs.existsSync(manifestFile)) {
  console.error(`❌ 备份目录里没有 manifest.json：${manifestFile}`);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function isManaged(rel) {
  return MANAGED.some((m) => rel === m || rel.startsWith(m + "/"));
}

/** 备份侧：按 manifest 取（**并回读校验**，防止备份自己坏了还拿去回滚）。 */
const backupFiles = new Map();
const badBackup = [];
for (const [rel, meta] of Object.entries(manifest.files)) {
  const p = path.join(ABS, rel);
  if (!fs.existsSync(p)) {
    badBackup.push(`缺失 ${rel}`);
    continue;
  }
  const h = sha256(p);
  if (h !== meta.sha256) badBackup.push(`备份自身哈希不符 ${rel}`);
  else backupFiles.set(rel, meta);
}
if (badBackup.length > 0) {
  console.error("❌ 备份本身不完整/已损坏，拒绝回滚：");
  for (const b of badBackup.slice(0, 20)) console.error("  " + b);
  process.exit(1);
}
console.log(`备份校验：${backupFiles.size} 个文件 sha256 全部相符 ✅`);
console.log(`备份时间：${manifest.createdAt} · git HEAD ${manifest.git?.head ?? "?"}`);

/** 当前侧：只扫受管范围。 */
function scanManaged(root) {
  const out = new Map();
  for (const m of MANAGED) {
    const full = path.join(root, m);
    if (!fs.existsSync(full)) continue;
    const st = fs.lstatSync(full);
    if (st.isFile()) {
      out.set(m, sha256(full));
    } else if (st.isDirectory()) {
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          const s = fs.lstatSync(p);
          if (s.isDirectory()) walk(p);
          else if (s.isFile()) {
            const rel = path.relative(root, p).split(path.sep).join("/");
            out.set(rel, sha256(p));
          }
        }
      };
      walk(full);
    }
  }
  return out;
}

const cur = scanManaged(SRC);
const toRestore = [];
const toDelete = [];
for (const [rel, meta] of backupFiles) {
  if (!isManaged(rel)) continue;
  if (cur.get(rel) !== meta.sha256) toRestore.push(rel);
}
for (const rel of cur.keys()) {
  if (!backupFiles.has(rel)) toDelete.push(rel);
}

console.log("");
console.log("── 差异（只列受管范围：lib/ tools/ 等）──────────");
console.log(`要恢复成备份版本的：${toRestore.length} 个`);
for (const r of toRestore.slice(0, 40)) console.log("  ~ " + r);
if (toRestore.length > 40) console.log(`  … 共 ${toRestore.length} 个`);
console.log(`要从当前删掉（备份里没有）：${toDelete.length} 个`);
for (const r of toDelete.slice(0, 40)) console.log("  - " + r);
if (toDelete.length > 40) console.log(`  … 共 ${toDelete.length} 个`);

if (!APPLY) {
  console.log("");
  console.log("★ 这是预览 —— 什么都没改。要真回滚请加 --apply。");
  process.exit(0);
}

// ── ② 先给"当前状态"拍一张（回滚自己也要可回滚）────────────────────────────
console.log("");
console.log("回滚前先给当前状态拍快照（回滚本身可回滚）…");
try {
  execFileSync(process.execPath, [path.join(SRC, "tools", "_probe-d216-backup.mjs"), "回滚前"], {
    cwd: SRC,
    stdio: "inherit",
  });
} catch (e) {
  console.error(`❌ 回滚前快照失败，已中止（不拿一个不可逆的回滚去赌）：${e.message}`);
  process.exit(1);
}

// ── ③ 动手 ────────────────────────────────────────────────────────────────
for (const rel of toRestore) {
  const from = path.join(ABS, rel);
  const to = path.join(SRC, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  const h = sha256(to);
  if (h !== backupFiles.get(rel).sha256) {
    console.error(`❌ 恢复后哈希不符（已中止）：${rel}`);
    process.exit(1);
  }
}
for (const rel of toDelete) {
  fs.rmSync(path.join(SRC, rel), { force: true });
}

console.log("");
console.log(`✅ 回滚完成：恢复 ${toRestore.length} · 删除 ${toDelete.length}`);
console.log("★ 台账 / 日志 / 归档 / 交接单 / 决策卡片**都没被碰**（不在受管范围内）。");
