#!/usr/bin/env node
/** 还原 `_inject-v3-tool-entry-regression.mjs` 注入的回归。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TARGET = path.join(ROOT, "lib", "part4.js");
const MARK = "// [INJECTED:v3-tool-entry-regression]";

const src = fs.readFileSync(TARGET, "utf8");
if (!src.includes(MARK)) {
  console.log("没有注入痕迹，无需还原。");
  process.exit(0);
}

const PATCHED = `      ${MARK} 故意让 op:"v3" 走不到迁移器（反向验证）`;
const RESTORED = `      if (args?.op === "v3") {
        return migrateToV3(root, { apply: args?.apply === true });
      }`;

if (!src.includes(PATCHED)) {
  console.error("✗ 找到标记但找不到注入后的代码块。");
  process.exit(1);
}

fs.writeFileSync(TARGET, src.replace(PATCHED, RESTORED), "utf8");
console.log("✓ 已还原 op:\"v3\" 接线。");
