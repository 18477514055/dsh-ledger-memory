/**
 * D376 回退 part3 的拆分（保留 part1 的拆分）。
 *
 * ★ 为什么回退（用户 2026-11-03 拍板）：
 *   `part3-settings.js` 需要 `currentSettings` / `precedenceValue` / `precedenceIsProject` / `specOf`，
 *   这四个都在 `part1.js`；而 `part1.js` 又 `export { … } from "./part1-store.js"`。
 *   为它们再搬一次「设置取值」簇，改动面会继续变大 —— 而 part3 只值 14,422 B。
 *   ⇒ **收益不抵风险**：part1 已经把余量从 8,113 提到 60,778 B（核心问题已解决）。
 *
 * ★ 回退方式：**从 TEMP 备份还原 part3.js**（拆之前那一份），并删掉 part3-settings.js。
 *   ★ 判据：**回退必须用"拆之前的那一刻"的字节，不是靠反向操作拼回去。**
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BACKUP = path.join(os.tmpdir(), "part3.before.js");
const TARGET = path.join(PROJECT_ROOT, "lib", "part3.js");
const EXTRA = path.join(PROJECT_ROOT, "lib", "part3-settings.js");

if (!fs.existsSync(BACKUP)) {
  console.error("找不到拆前备份：" + BACKUP);
  process.exit(1);
}
const before = fs.readFileSync(BACKUP, "utf8");
const cur = fs.readFileSync(TARGET, "utf8");

// 守恒断言：备份里必须有 blockInjectionEnabled 与 settingsSnapshotLines（说明是完整的拆前版）
const problems = [];
for (const must of ["export function blockInjectionEnabled(", "export function settingsSnapshotLines(", "export function renderInjectionBody("]) {
  if (!before.includes(must)) problems.push(`备份里缺 ${must} —— 不是拆前那一版`);
}
// 备份里不该有 part3-settings 的 import（那是拆之后才有的）
if (/from "\.\/part3-settings\.js"/.test(before)) problems.push("备份里居然有 part3-settings 的引用 —— 备份拿错了");
if (problems.length > 0) {
  console.log("★ 守恒断言未过，未回退：");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}

fs.writeFileSync(TARGET, before, "utf8");
if (fs.existsSync(EXTRA)) fs.unlinkSync(EXTRA);

console.log("已回退 part3：");
console.log(`  part3.js  ${Buffer.byteLength(cur)} → ${Buffer.byteLength(before)} B`);
console.log(`  part3-settings.js 已删除`);
console.log("REVERT-DONE");
