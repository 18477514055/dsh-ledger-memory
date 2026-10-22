#!/usr/bin/env node
/** 还原 `_inject-d297-path-regression.mjs` 注入的回归。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, "selftest.mjs");
const MARK = "// [INJECTED:d297-path-regression]";

const src = fs.readFileSync(TARGET, "utf8");
if (!src.includes(MARK)) {
  console.log("没有注入痕迹，无需还原。");
  process.exit(0);
}

const PATCHED = `  ${MARK} 故意无视 memoryRoot，只认项目根（反向验证）
  void active;
  return path.join(PROJECT_ROOT, "LEDGER.md");`;

const RESTORED = `  const memRoot = typeof manifest?.memoryRoot === "string" && manifest.memoryRoot !== "" ? manifest.memoryRoot : "";
  return memRoot === "" ? path.join(PROJECT_ROOT, active) : path.join(PROJECT_ROOT, memRoot, active);`;

if (!src.includes(PATCHED)) {
  console.error("✗ 找到标记但找不到注入后的代码块。");
  process.exit(1);
}

fs.writeFileSync(TARGET, src.replace(PATCHED, RESTORED), "utf8");
console.log("✓ 已还原 ledgerPathOf。");
