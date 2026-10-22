#!/usr/bin/env node
/**
 * ★★★★★ 在**一次性副本**上完整跑一遍迁移，并验证「能不能退回去」（D297 的第三件前置）。
 *
 * 🔴 为什么必须在副本上验（这是硬纪律，不是谨慎）：
 *   2026-10-19 那次，我为证明"回滚真能用"，在**生产工作区**里污染文件后跑 `--from-backup --apply`。
 *   回滚**确实生效** —— 但它也把这轮刚写的接线一起抹掉了，因为"回滚"的语义就是"回到那一刻"。
 *   ⇒ **验回滚绝不可以在生产树上做。它会把你要验的东西本身删掉。**
 *
 * 本脚本做四件事：
 *   ① 把记忆文件（清单登记的那些）复制到临时目录
 *   ② 在副本上 **真跑一次迁移（apply:true）**
 *   ③ 校验迁移结果：目标目录在、文件数/哈希对得上、清单写了 memoryRoot、旧位置已清空
 *   ④ **模拟回滚**：按备份清单把文件搬回原位置、清掉 memoryRoot，再校验"回到原样"
 *
 * ★ 全程不碰生产树：`ROOT` 指向的是**副本**。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REAL = process.argv[2];
if (!REAL) {
  console.error("用法：node _probe-v3-migrate-oncopy.mjs <真实项目根>");
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

// ── ① 造副本 ───────────────────────────────────────────────────────────────
const COPY = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3-copy-"));
const mf = JSON.parse(fs.readFileSync(path.join(REAL, ".dsh-ledger.json"), "utf8"));

const rels = [];
for (const k of ["active","decisions","decisionsDir","journal","goals","goalsDir","lessons","lessonsDir","principles","archiveDir","logDir","handoffDir"]) {
  if (typeof mf[k] === "string" && mf[k] !== "" && !rels.includes(mf[k])) rels.push(mf[k]);
}
rels.push("_stash", "_handoff");

const copyInto = (rel) => {
  const from = path.join(REAL, rel);
  const to = path.join(COPY, rel);
  if (!fs.existsSync(from)) return;
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) copyInto(`${rel}/${e.name}`);
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
};

fs.mkdirSync(COPY, { recursive: true });
fs.copyFileSync(path.join(REAL, ".dsh-ledger.json"), path.join(COPY, ".dsh-ledger.json"));
for (const r of rels) copyInto(r);

/** 相对路径 → sha256（只对文件）。 */
const hashAll = (root) => {
  const out = new Map();
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) walk(`${rel}/${e.name}`);
    } else out.set(rel, hashOf(abs));
  };
  for (const r of rels) walk(r);
  return out;
};

const before = hashAll(COPY);
ok("①a 副本已建好，且里面有文件", before.size > 0, `${before.size} 个文件`);

// 把副本里的插件代码指过去（迁移器要从 lib 里 import）
// ★ 直接 import 真实仓库的 lib —— 迁移器操作的是传入的 projectRoot，与它自己住哪无关。
const { migrateToV3 } = await import(
  pathToFileURL(path.join(REAL, "lib", "part7.js")).href
);

// ── ② 真跑迁移 ─────────────────────────────────────────────────────────────
const r = migrateToV3(COPY, { apply: true });
ok("②a 迁移返回 ok", r.ok === true, JSON.stringify(r).slice(0, 300));
ok("②b 报出目标目录", typeof r.targetDir === "string" && r.targetDir !== "", String(r.targetDir));

const memAbs = path.join(COPY, r.targetDir ?? "");
ok("②c 目标目录真的存在", fs.existsSync(memAbs));

// ── ③ 校验迁移结果 ─────────────────────────────────────────────────────────
const mfAfter = JSON.parse(fs.readFileSync(path.join(COPY, ".dsh-ledger.json"), "utf8"));
ok("③a 清单写入了 memoryRoot", mfAfter.memoryRoot === r.targetDir, JSON.stringify(mfAfter.memoryRoot));
ok("③b 清单其它字段没被动过（active 不变）", mfAfter.active === mf.active, `${mf.active} → ${mfAfter.active}`);
ok("③c 清单里没有留下旧位置残留键", mfAfter.decisionsDir === mf.decisionsDir);

// 逐个文件比对：原来有的，现在都应当在 memoryRoot 下且哈希一致
let missing = 0;
let mismatch = 0;
for (const [rel, h] of before) {
  const p = path.join(memAbs, rel);
  if (!fs.existsSync(p)) {
    missing += 1;
    continue;
  }
  if (hashOf(p) !== h) mismatch += 1;
}
ok("③d 每个文件都搬到了新位置（没有丢）", missing === 0, `缺 ${missing} 个`);
ok("③e 每个文件内容逐字节相同（没有坏）", mismatch === 0, `不符 ${mismatch} 个`);

// 旧位置应当已经空掉（被搬到 _retired）
let leftAtRoot = 0;
for (const rel of rels) {
  if (fs.existsSync(path.join(COPY, rel))) leftAtRoot += 1;
}
ok("③f 旧位置已清空（不留下第二个权威源）", leftAtRoot === 0, `还剩 ${leftAtRoot} 项`);
ok("③g 旧文件被搬到 _retired 而不是删掉", typeof r.retiredTo === "string" && fs.existsSync(r.retiredTo), String(r.retiredTo));

// ── ④ 模拟回滚 ─────────────────────────────────────────────────────────────
//
// ★ 回滚的语义 = "回到迁移前那一刻"。这里手工做，正是为了确认它**可行**：
//   ① 把 memoryRoot 下的文件搬回原相对位置
//   ② 清单去掉 memoryRoot
//   ③ 重新算哈希，必须与迁移前**完全一致**
const nextMf = { ...mfAfter };
delete nextMf.memoryRoot;
fs.writeFileSync(path.join(COPY, ".dsh-ledger.json"), `${JSON.stringify(nextMf, null, 2)}\n`, "utf8");

const moveBack = (rel) => {
  const from = path.join(memAbs, rel);
  const to = path.join(COPY, rel);
  if (!fs.existsSync(from)) return;
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) moveBack(`${rel}/${e.name}`);
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }
};
for (const rel of rels) moveBack(rel);

const afterRollback = hashAll(COPY);
let rbMissing = 0;
let rbMismatch = 0;
for (const [rel, h] of before) {
  const abs = path.join(COPY, rel);
  if (!fs.existsSync(abs)) {
    rbMissing += 1;
    continue;
  }
  if (hashOf(abs) !== h) rbMismatch += 1;
}
ok("④a 回滚后每个文件都回来了", rbMissing === 0, `缺 ${rbMissing}`);
ok("④b 回滚后每个文件内容逐字节相同", rbMismatch === 0, `不符 ${rbMismatch}`);
ok(
  "④c 回滚后清单里没有 memoryRoot（回到 V2 形态）",
  JSON.parse(fs.readFileSync(path.join(COPY, ".dsh-ledger.json"), "utf8")).memoryRoot === undefined,
);

console.log("");
console.log(`副本目录（留作证据）：${COPY}`);
console.log("════════════════════════════════════════════════════════════════");
console.log(`v3-migrate-oncopy 探针：${pass} PASS / ${fail} FAIL`);
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
