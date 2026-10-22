#!/usr/bin/env node
/**
 * 反向验证注入：把 `ledgerPathOf` **退回**成"只看项目根"（即修复前的行为）。
 *
 * ★ 要验的命题：**迁移后守卫会静默失效**。
 *   ⇒ 退回后 `_probe-d297-ledger-path.mjs` 的 ②a/②c 与 ③b/③c **必须报红**。
 *   ★ 如果退回后它照样全绿，说明我的修法**根本没被探针测到**（D295/L50 那个病）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, "selftest.mjs");
const MARK = "// [INJECTED:d297-path-regression]";

const src = fs.readFileSync(TARGET, "utf8");
if (src.includes(MARK)) {
  console.log("已经注入过了，跳过。");
  process.exit(0);
}

// 把"跟着清单走"的逻辑换回"只看项目根"
const NEEDLE = `  const memRoot = typeof manifest?.memoryRoot === "string" && manifest.memoryRoot !== "" ? manifest.memoryRoot : "";
  return memRoot === "" ? path.join(PROJECT_ROOT, active) : path.join(PROJECT_ROOT, memRoot, active);`;

const PATCHED = `  ${MARK} 故意无视 memoryRoot，只认项目根（反向验证）
  void active;
  return path.join(PROJECT_ROOT, "LEDGER.md");`;

if (!src.includes(NEEDLE)) {
  console.error("✗ 找不到注入点 —— ledgerPathOf 可能已被改过。");
  process.exit(1);
}

fs.writeFileSync(TARGET, src.replace(NEEDLE, PATCHED), "utf8");
console.log("✓ 已注入：ledgerPathOf 退回成只看项目根。");
console.log("  下一步：跑 node tools/_probe-d297-ledger-path.mjs，②a/②c/③b/③c 应当报红。");
