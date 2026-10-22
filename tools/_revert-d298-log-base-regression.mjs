#!/usr/bin/env node
/** 还原 `_inject-d298-log-base-regression.mjs` 注入的回归。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, "..", "lib", "part3.js");
const MARK = "// [INJECTED:d298-log-base-regression]";

const src = fs.readFileSync(TARGET, "utf8");
if (!src.includes(MARK)) {
  console.log("没有注入痕迹，无需还原。");
  process.exit(0);
}

const PATCHED = `          ${MARK} 故意忽略 memBase，退回项目根（反向验证）
          const base = b.root;`;

const RESTORED = `          const base = typeof b.memBase === "string" && b.memBase !== "" ? b.memBase : b.root;`;

if (!src.includes(PATCHED)) {
  console.error("✗ 找到标记但找不到注入后的代码块。");
  process.exit(1);
}

fs.writeFileSync(TARGET, src.replace(PATCHED, RESTORED), "utf8");
console.log("✓ 已还原落盘基准。");
