#!/usr/bin/env node
/**
 * V3 迁移**干跑**：只出计划，**一个字节都不写**。
 *
 * ★ 走的是**工具入口**（`ledger_migrate({op:"v3"})`），不是直接调 lib 函数 ——
 *   因为用户最终点的是工具，**要验的也是那条路**（D296 的教训：函数写对了 ≠ 工具调得到它）。
 * ★ 干跑前后各拍一次目录快照（相对路径 → 大小），**必须完全一致**才算"真的没写"。
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.argv[2];
if (!ROOT) {
  console.error("用法：node _probe-v3-dryrun.mjs <项目根>");
  process.exit(1);
}

const { defineMigrateTool } = await import(
  pathToFileURL(path.join(ROOT, "lib", "part4.js")).href
);

/** 目录快照（只记相对路径 + 大小，够判"写没写"）。 */
function snapshot(dir, skip) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).split(path.sep).join("/");
      if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
      if (e.isDirectory()) walk(p);
      else out.set(rel, fs.statSync(p).size);
    }
  };
  walk(dir);
  return out;
}

// 跳过 node_modules 与 .git（它们不是记忆，也不该被搬）
const SKIP = ["node_modules", ".git", "_dist"];

const before = snapshot(ROOT, SKIP);
const tool = defineMigrateTool();
const r = await tool.execute({ op: "v3", root: ROOT }, {});
const after = snapshot(ROOT, SKIP);

const same = before.size === after.size && [...before].every(([k, v]) => after.get(k) === v);

console.log("══════════════ 迁移计划（干跑）══════════════");
console.log(`ok        : ${r.ok}`);
console.log(`dryRun    : ${r.dryRun}`);
console.log(`目标目录  : ${r.plan?.target}`);
console.log(`搬移项数  : ${r.plan?.moves?.length}`);
console.log("");
for (const m of r.plan?.moves ?? []) {
  const from = path.join(ROOT, m.from);
  const st = fs.statSync(from);
  let detail = "";
  if (st.isDirectory()) {
    let n = 0;
    const cnt = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) cnt(p);
        else n += 1;
      }
    };
    cnt(from);
    detail = `（目录 · ${n} 个文件）`;
  } else {
    detail = `（文件 · ${st.size} 字节）`;
  }
  console.log(`  ${m.from}  →  ${m.to}  ${detail}`);
}
console.log("");
console.log("────────────────────────────────────────────");
console.log(`快照：前 ${before.size} 个文件 → 后 ${after.size} 个`);
console.log(`判定：干跑${same ? "**一个字节都没写** ✓" : "**写了东西** ❌"}`);
if (!same) {
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  console.log(`  新增：${added.slice(0, 10).join(", ")}`);
  console.log(`  消失：${removed.slice(0, 10).join(", ")}`);
  process.exit(1);
}
console.log(`\n明细：${r.note}`);
