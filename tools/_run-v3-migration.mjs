#!/usr/bin/env node
/**
 * ★★★★★ **真跑 V3 迁移**（在生产树上）。
 *
 * 这是唯一一次会移动真实记忆的操作。三件前置已全部做完（见 D297）：
 *   ① 全量备份 + 逐文件 sha256（`%TEMP%\dsh-v3-backup-*`）
 *   ② 干跑确认「一个字节都没写」
 *   ③ 在**一次性副本**上完整跑过一次迁移 + 回滚，逐字节一致
 *
 * ★ 走**工具入口**（`ledger_migrate({op:"v3", apply:true})`），不直接调 lib：
 *   用户点的是工具，验的是工具，真跑的也必须是工具那条路。
 *
 * ★ 跑完立刻自检 —— 因为迁移会改台账位置，**自检是最快发现"守卫失效"的尺子**。
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.argv[2];
if (!ROOT) {
  console.error("用法：node _run-v3-migration.mjs <项目根> && 确认参数");
  process.exit(1);
}
if (!process.argv.includes("--yes")) {
  console.error("拒绝执行：真跑必须显式加 --yes。");
  process.exit(1);
}

const mfBefore = JSON.parse(fs.readFileSync(path.join(ROOT, ".dsh-ledger.json"), "utf8"));
if (typeof mfBefore.memoryRoot === "string" && mfBefore.memoryRoot !== "") {
  console.error(`拒绝执行：清单里已经有 memoryRoot = ${mfBefore.memoryRoot}（已经是 V3）。`);
  process.exit(1);
}

console.log("══════════ 真跑 V3 迁移 ══════════");
console.log(`项目：${ROOT}`);
console.log(`迁移前：memoryRoot = ${JSON.stringify(mfBefore.memoryRoot)}（= V2）`);
console.log("");

const { defineMigrateTool } = await import(
  pathToFileURL(path.join(ROOT, "lib", "part4.js")).href
);
const tool = defineMigrateTool();
const r = await tool.execute({ op: "v3", root: ROOT, apply: true }, {});

console.log(`ok            : ${r.ok}`);
console.log(`targetDir     : ${r.targetDir}`);
console.log(`manifestUpdated: ${r.manifestUpdated}`);
console.log(`fileCount     : ${r.fileCount}`);
console.log(`retiredTo     : ${r.retiredTo ?? "（无）"}`);
if (r.retireFailed) console.log(`⚠️ retireFailed: ${r.retireFailed}`);
console.log(`note          : ${r.note ?? ""}`);

if (r.ok !== true) {
  console.error("\n❌ 迁移没有成功。请**不要**重跑，先看上面的 reason/problems。");
  process.exit(1);
}

const mfAfter = JSON.parse(fs.readFileSync(path.join(ROOT, ".dsh-ledger.json"), "utf8"));
console.log("");
console.log(`迁移后：memoryRoot = ${JSON.stringify(mfAfter.memoryRoot)}`);
console.log(`目标目录存在：${fs.existsSync(path.join(ROOT, mfAfter.memoryRoot))}`);
console.log("══════════════════════════════════");
