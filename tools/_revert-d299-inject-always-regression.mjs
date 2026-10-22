#!/usr/bin/env node
/** 还原 `_inject-d299-inject-always-regression.mjs`。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, "..", "lib", "part8.js");
const MARK = "// [INJECTED:d299-inject-always-regression]";

const src = fs.readFileSync(TARGET, "utf8");
if (!src.includes(MARK)) {
  console.log("没有注入痕迹，无需还原。");
  process.exit(0);
}

const PATCHED = `    ${MARK} 不管 inject 开关，一律附内容（反向验证）
    if (exists) {`;
const RESTORED = `    if (e.inject === true && exists) {`;

if (!src.includes(PATCHED)) {
  console.error("✗ 找不到注入后的片段。");
  process.exit(1);
}

fs.writeFileSync(TARGET, src.replace(PATCHED, RESTORED), "utf8");
console.log("✓ 已还原 inject 判断。");
