#!/usr/bin/env node
/**
 * 只读探针：**看穿三份「用户原话-完整存档.md」到底是什么关系**，再决定怎么合并。
 *
 * ★★★ 为什么必须先侦查再动手（本项目的硬规矩）：
 *   根目录那份（泄露物）与记忆目录那份（真数据）**不能直接互相覆盖** ——
 *   一盖就丢一类数据，而这两个文件装的都是**不可重放的用户原话**（D79：reasoning + 用户原话
 *   ≈33% 搬走就没了）。所以先回答三个问题：
 *     ① 三份各自的期间桶（week3 / week4）与体量；
 *     ② 根目录那份的每一行，**是否都已存在于**记忆目录那份（子集 ⇒ 可直接丢）；
 *     ③ 记忆目录那份的每一行，是否存在于根目录那份（反向包含 ⇒ 根那份有独占内容）。
 *
 * ★ 判据：**"内容重叠"要按行比，不按字节比** —— 字节比只能说"不一样"，
 *   说不出"哪些是多出来的"。而这次真正要回答的正是后者。
 *
 * ★ 只读：本探针**不写、不改、不删**任何文件。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const MEM = path.join(PROJECT, "10.项目台账-ledger-memory");
const NAME = "用户原话-完整存档.md";

const targets = [
  ["根·week3（泄露物）", path.join(PROJECT, "_ledger-archive", "2026-10", "week3", NAME)],
  ["根·week4（泄露物）", path.join(PROJECT, "_ledger-archive", "2026-10", "week4", NAME)],
  ["记忆·week3（真数据）", path.join(MEM, "_ledger-archive", "2026-10", "week3", NAME)],
  ["记忆·week4（真数据）", path.join(MEM, "_ledger-archive", "2026-10", "week4", NAME)],
];

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);
const info = [];
for (const [label, p] of targets) {
  if (!fs.existsSync(p)) {
    info.push({ label, p, exists: false });
    continue;
  }
  const buf = fs.readFileSync(p);
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  // 只收**条目行**（`- <时间> (user…) …`）作为比对单位：标题/说明行不算数据
  const entries = lines.filter((l) => /^-\s+\d{4}-\d{2}-\d{2}/.test(l));
  const head = lines.filter((l) => l.trim() !== "").slice(0, 2);
  const tail = lines.filter((l) => l.trim() !== "").slice(-2);
  info.push({
    label,
    p,
    exists: true,
    bytes: buf.length,
    lines: lines.length,
    entries: entries.length,
    sha: sha(buf),
    head,
    tail,
    entrySet: new Set(entries),
    mtime: fs.statSync(p).mtime.toISOString(),
  });
}

console.log("═".repeat(78));
console.log("三份「用户原话-完整存档.md」关系探查（只读）");
console.log("═".repeat(78));
for (const t of info) {
  if (!t.exists) {
    console.log(`\n【${t.label}】不存在：${t.p}`);
    continue;
  }
  console.log(`\n【${t.label}】`);
  console.log(`  ${t.bytes} B · ${t.lines} 行 · **条目 ${t.entries} 条** · sha ${t.sha}`);
  console.log(`  mtime ${t.mtime}`);
  console.log(`  首：${(t.head[0] ?? "").slice(0, 90)}`);
  console.log(`  尾：${(t.tail[t.tail.length - 1] ?? "").slice(0, 90)}`);
}

// ── 逐对做「条目集合」的双向差 ───────────────────────────────────────────
const live = info.filter((t) => t.exists === true);
console.log("\n" + "─".repeat(78));
console.log("条目集合双向差（A 有而 B 没有的条数）");
console.log("─".repeat(78));
for (let i = 0; i < live.length; i += 1) {
  for (let j = 0; j < live.length; j += 1) {
    if (i === j) continue;
    const a = live[i];
    const b = live[j];
    let onlyA = 0;
    for (const e of a.entrySet) if (!b.entrySet.has(e)) onlyA += 1;
    console.log(`  ${a.label} 有 / ${b.label} 没有：${onlyA} 条（共 ${a.entries}）`);
  }
}

// ── 关键判断：根目录那两份能不能直接丢 ──────────────────────────────────
console.log("\n" + "─".repeat(78));
console.log("★ 关键判断：根目录那份是不是记忆目录的**子集**");
console.log("─".repeat(78));
const memAll = new Set();
for (const t of live) if (t.label.startsWith("记忆")) for (const e of t.entrySet) memAll.add(e);
for (const t of live) {
  if (!t.label.startsWith("根")) continue;
  let orphan = 0;
  const samples = [];
  for (const e of t.entrySet) {
    if (!memAll.has(e)) {
      orphan += 1;
      if (samples.length < 3) samples.push(e.slice(0, 100));
    }
  }
  console.log(`  ${t.label}：${t.entries} 条中，记忆目录**没有**的 = **${orphan}** 条`);
  for (const s of samples) console.log(`     独占样例：${s}`);
  console.log(
    orphan === 0
      ? "    ⇒ 全是重复 ⇒ **可以直接删**（一行数据都不会丢）"
      : "    ⇒ **有独占内容 ⇒ 必须先并进记忆目录，绝不能直接删**"
  );
}
console.log("\n（本探针没有写任何东西。）");
