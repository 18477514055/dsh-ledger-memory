#!/usr/bin/env node
/**
 * V3 迁移前备份：把记忆文件**全量复制**到 `%TEMP%`，并**逐文件记 sha256**。
 *
 * ★ 为什么不在项目里备份：那会污染工作区，而且迁移器会把备份也当成记忆搬走。
 * ★ 为什么必须记 sha256：判据是「备份里有」之前先比哈希 ——
 *   备份只保证「那一刻的字节」，不保证「我以为的内容」（2026-10-19 那次事故）。
 * ★ 用 Node 不用 PowerShell：数行数/算哈希 PowerShell 会漏；且中文路径要注意编码。
 *
 * 产出：`%TEMP%\dsh-v3-backup-<stamp>\` 下的完整副本 + `_backup-manifest.json`（相对路径 → {size, sha256}）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.argv[2];
if (!ROOT) {
  console.error("用法：node _backup-before-v3.mjs <项目根>");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const DEST = path.join(os.tmpdir(), `dsh-v3-backup-${stamp}`);

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, ".dsh-ledger.json"), "utf8"));

// ★ 与迁移器**用同一份清单**决定搬什么（否则"备份了什么"与"搬了什么"会不一致）。
const rels = [];
const pushRel = (v) => {
  if (typeof v === "string" && v !== "" && !rels.includes(v)) rels.push(v);
};
for (const k of [
  "active",
  "decisions",
  "decisionsDir",
  "journal",
  "goals",
  "goalsDir",
  "lessons",
  "lessonsDir",
  "principles",
  "archiveDir",
  "logDir",
  "handoffDir",
]) {
  pushRel(manifest[k]);
}
// 迁移器里 `STASH_DIR` 是硬编码的 `_stash`
pushRel("_stash");
pushRel("_handoff");

const existing = rels.filter((r) => fs.existsSync(path.join(ROOT, r)));
console.log(`要备份 ${existing.length} 项：`);
for (const r of existing) console.log(`  · ${r}`);

const hashOf = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const files = new Map(); // rel → {size, sha256}
const copyInto = (rel) => {
  const from = path.join(ROOT, rel);
  const to = path.join(DEST, rel);
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) copyInto(`${rel}/${e.name}`);
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    files.set(rel, { size: st.size, sha256: hashOf(from) });
  }
};

fs.mkdirSync(DEST, { recursive: true });
for (const r of existing) copyInto(r);

// ★ 校验：复制出来的每一份都要与源逐字节相同（不是只看数量）。
const problems = [];
for (const [rel, meta] of files) {
  const p = path.join(DEST, rel);
  if (!fs.existsSync(p)) {
    problems.push(`缺：${rel}`);
    continue;
  }
  const st = fs.statSync(p);
  if (st.size !== meta.size) {
    problems.push(`大小不符：${rel}`);
    continue;
  }
  if (hashOf(p) !== meta.sha256) problems.push(`内容不符：${rel}`);
}

const totalBytes = [...files.values()].reduce((s, m) => s + m.size, 0);
fs.writeFileSync(
  path.join(DEST, "_backup-manifest.json"),
  `${JSON.stringify(
    {
      source: ROOT,
      takenAt: new Date().toISOString(),
      manifestSnapshot: manifest,
      fileCount: files.size,
      totalBytes,
      files: Object.fromEntries(files),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log("");
console.log(`备份目录：${DEST}`);
console.log(`文件数：${files.size}  总字节：${totalBytes}（${(totalBytes / 1048576).toFixed(2)} MB）`);
console.log(`逐文件校验：${problems.length === 0 ? "全过 ✓" : `❌ ${problems.length} 项不符`}`);
if (problems.length > 0) {
  for (const p of problems.slice(0, 20)) console.log(`  ${p}`);
  process.exit(1);
}
