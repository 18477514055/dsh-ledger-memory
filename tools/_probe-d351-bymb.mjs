// _probe-d351-bymb.mjs —— 改名会坏在哪：把"靠名字"的依赖点全找出来
// ★ 判据：凡是对 LEDGER.md / decisions / lessons / memoryRoot 等**字面量**的依赖，
//   改名后都会失联。这里不猜，直接 grep 源码数出来。
import fs from "node:fs";
import path from "node:path";

const LIB = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账\\lib";
const files = fs.readdirSync(LIB).filter((f) => f.endsWith(".js"));

// 那些"身份名"——一旦被用户改掉，所有硬编码都失联
const IDENTIFIERS = [
  "LEDGER.md", "JOURNAL.md", "PRINCIPLES.md", "GOALS.md",
  "DECISIONS.md", "LESSONS.md",
  "decisions", "lessons", "goals",
  "_ledger-archive", "_ledger-log", "_stash", "_handoff",
  ".dsh-ledger.json",
];

console.log("=== 各文件里对「身份名」的字面量依赖次数 ===");
const totals = new Map();
for (const id of IDENTIFIERS) totals.set(id, 0);

for (const f of files) {
  const p = path.join(LIB, f);
  const src = fs.readFileSync(p, "utf8");
  const hits = [];
  for (const id of IDENTIFIERS) {
    // 数"作为字符串字面量出现"的次数（带引号）
    const re = new RegExp(`["'\`]${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`, "g");
    const m = src.match(re);
    const n = m ? m.length : 0;
    if (n > 0) {
      hits.push(`${id}:${n}`);
      totals.set(id, totals.get(id) + n);
    }
  }
  if (hits.length) console.log(`  ${f.padEnd(22)} ${hits.join("  ")}`);
}

console.log("\n=== 合计（字面量出现次数）===");
for (const [id, n] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
  if (n > 0) console.log(`  ${id.padEnd(22)} ${n}`);
}

// ── 关键：清单里的键是"可配置"的，但代码里有没有 fallback 到字面量？ ──
console.log("\n=== 清单键 vs 代码里的默认值 ===");
const manifestKeys = ["active", "journal", "principles", "decisionsDir", "lessonsDir", "goalsDir", "memoryRoot", "archiveDir", "logDir"];
for (const k of manifestKeys) {
  let defCount = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(LIB, f), "utf8");
    // 找 code 里形如 "LEDGER.md" 直接作为默认值的地方
  }
  console.log(`  ${k}`);
}

// ── 更重要的是：卡片文件名 = 编号，编号变了卡片还能找到吗 ──
console.log("\n=== 卡片寻址方式 ===");
const cardOps = fs.readFileSync(path.join(LIB, "card-ops.js"), "utf8");
const idxSamples = cardOps.match(/D\$?\{?[^,\n]{0,40}\.md/g);
console.log("card-ops.js 里 .md 相关模式样本:", (idxSamples ?? []).slice(0, 6));

// 找"按文件名取卡"的写法
const nameBased = cardOps.match(/path\.join\([^)]*\)/g) ?? [];
console.log(`card-ops.js 里 path.join 调用 ${nameBased.length} 处`);
console.log("样本:", nameBased.slice(0, 8));

console.log("\nPROBE-COMPLETE");
