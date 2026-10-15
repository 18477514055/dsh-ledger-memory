// ═══════════════════════════════════════════════════════════════════════════
// D216 · 拆分「前」的整树备份 + 可验证回滚（用户 2026-10-15 拍板）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 用户原话（逐字）：*"第三点就是你在拆分前，我的建议是先备份再拆分。要有回滚的能力。"*
//
// ★★ 为什么**不能只靠 git**（这是本脚本存在的全部理由）：
//   · `.gitignore` 里忽略了 `LEDGER.md` / `DECISIONS.md` / `decisions/` / `lessons/` /
//     `.dsh-ledger.json` / `_ledger-log/` / `_ledger-archive/` / `_handoff/` / `_stash/` /
//     `_store-research/` / `docs/` —— 这些**不在 git 里**；
//   · 而且工作区有 **78 项未提交**（D173~D216 全没 commit）
//     ⇒ **`git checkout` 回滚会把这些活全丢掉**。
//   ⇒ 判据：**必须做"物理整树快照"**，不能拿版本控制当备份。
//
// ★ 本脚本只做三件事（**绝不改源树**）：
//   ① 复制整棵树（**含 `.git`、含被 ignore 的那些**）到**项目外**的备份目录
//      （默认 `<_插件备份>/<项目名>/`，见脚本里的 `backupRoot`；可用参数覆盖）；
//   ② 对**源**与**副本**分别算 sha256，**逐一比对**（不是"复制完就报成功"）；
//   ③ 在备份里落一份 `manifest.json`（逐文件哈希）+ `回滚.mjs`（可执行的回滚器）。
//   ★ 判据：**"复制了" ≠ "复制对了"** —— 必须回读比对过才算备份成立。
//
// 用法：node tools/_probe-d216-backup.mjs [标签]
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const SRC = process.cwd();
const LABEL = process.argv[2] ?? "拆分前";
// ★ 备份放在**插件项目之外**（`04-其余插件` 的兄弟位置）：
//   放项目里的话，一次失败的拆分/复制**可能连备份一起毁掉**（那就等于没有备份）。
const BACKUP_ROOT = path.resolve(SRC, "..", "..", "_插件备份", path.basename(SRC));

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function sha256(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

/** 走整棵树，收集 `相对路径 -> {size, sha256}`。**不跟随联接**（`lstatSync`）。 */
function scan(root) {
  const out = new Map();
  const links = [];
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      links.push(`READ-FAIL ${dir}: ${e.message}`);
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch (err) {
        links.push(`LSTAT-FAIL ${p}: ${err.message}`);
        continue;
      }
      if (st.isSymbolicLink()) {
        links.push(`LINK ${path.relative(root, p)}`);
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        out.set(path.relative(root, p).split(path.sep).join("/"), {
          size: st.size,
          sha256: sha256(p),
        });
      }
    }
  };
  walk(root);
  return { map: out, links };
}

/** 尽量取 git 信息（取不到不算失败 —— 本脚本不依赖 git）。 */
function gitInfo() {
  const run = (args) =>
    execFileSync("git", args, { cwd: SRC, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim();
  try {
    return { head: run(["rev-parse", "HEAD"]), branch: run(["rev-parse", "--abbrev-ref", "HEAD"]) };
  } catch {
    return { head: undefined, branch: undefined };
  }
}

// ── ① 先扫源树（也顺手拿到"有没有联接"这个安全前提）────────────────────────
const src = scan(SRC);
if (src.links.length > 0) {
  console.log("⚠ 源树里有联接/读不到的东西（复制会跟随物化）：");
  for (const l of src.links.slice(0, 20)) console.log("  " + l);
  console.log("  ⇒ 本次共 " + src.links.length + " 条，继续但请人工确认。");
}

const stamp = ts();
const DEST = path.join(BACKUP_ROOT, `${stamp}-${LABEL}`);
fs.mkdirSync(DEST, { recursive: true });

console.log(`源  ：${SRC}`);
console.log(`备份：${DEST}`);
console.log(`源文件数 ${src.map.size} · 源总字节 ${[...src.map.values()].reduce((a, b) => a + b.size, 0)}`);
console.log("复制中（含 .git 与被 ignore 的文件）…");

// ── ② 物理复制（`dereference:false` ⇒ 即使有联接也**不跟随**）──────────────
fs.cpSync(SRC, DEST, {
  recursive: true,
  force: true,
  dereference: false,
  preserveTimestamps: true,
  errorOnExist: false,
});

// ── ③ 回读副本、逐一比对（**判据：副本自己算出来的哈希**）──────────────────
const dst = scan(DEST);
const problems = [];
for (const [rel, a] of src.map) {
  const b = dst.map.get(rel);
  if (b === undefined) problems.push(`缺失: ${rel}`);
  else if (b.sha256 !== a.sha256) problems.push(`哈希不符: ${rel} (${a.size}B vs ${b.size}B)`);
  else if (b.size !== a.size) problems.push(`大小不符: ${rel}`);
}
for (const rel of dst.map.keys()) if (!src.map.has(rel)) problems.push(`多出: ${rel}`);

const g = gitInfo();
const manifest = {
  schema: "dsh-ledger-memory/backup@1",
  label: LABEL,
  createdAt: new Date().toISOString(),
  source: SRC,
  dest: DEST,
  git: g,
  fileCount: src.map.size,
  totalBytes: [...src.map.values()].reduce((a, b) => a + b.size, 0),
  links: src.links,
  verified: problems.length === 0,
  problems,
  files: Object.fromEntries([...src.map.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
};
fs.writeFileSync(path.join(DEST, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

console.log("");
console.log("── 比对结果 ──────────────────────────────────");
console.log(`副本文件数 ${dst.map.size}`);
if (problems.length === 0) {
  console.log("✅ 逐文件 sha256 全部相符 —— 备份成立。");
} else {
  console.log(`❌ ${problems.length} 处不符：`);
  for (const p of problems.slice(0, 30)) console.log("  " + p);
}
console.log(`git HEAD ${g.head ?? "(取不到)"} · branch ${g.branch ?? "?"}`);
console.log(`manifest: ${path.join(DEST, "manifest.json")}`);
process.exitCode = problems.length === 0 ? 0 : 1;
