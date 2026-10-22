#!/usr/bin/env node
/** 还原 `_inject-v3-hook-leak-regression.mjs` 注入的回归。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TARGET = path.join(ROOT, "lib", "part4.js");
const MARK = "// [INJECTED:v3-hook-leak-regression]";

let src = fs.readFileSync(TARGET, "utf8");
if (!src.includes(MARK)) {
  console.log("没有注入痕迹，无需还原。");
  process.exit(0);
}

// ① 去掉 schema 里多出来的两行
const SCHEMA_BAD = `
        ${MARK} 故意把探针专用的故障注入点暴露到工具 schema（反向验证）
        injectCorruptCopy: { type: "boolean" },
        stopBeforeManifest: { type: "boolean" },`;
if (!src.includes(SCHEMA_BAD)) {
  console.error("✗ 找不到注入后的 schema 片段。");
  process.exit(1);
}
src = src.replace(SCHEMA_BAD, "");

// ② 还原 execute 透传
const EXEC_BAD = `      if (args?.op === "v3") {
        return migrateToV3(root, {
          apply: args?.apply === true,
          injectCorruptCopy: args?.injectCorruptCopy === true,
          stopBeforeManifest: args?.stopBeforeManifest === true,
        });
      }`;
const EXEC_GOOD = `      if (args?.op === "v3") {
        return migrateToV3(root, { apply: args?.apply === true });
      }`;
if (!src.includes(EXEC_BAD)) {
  console.error("✗ 找不到注入后的 execute 片段。");
  process.exit(1);
}
src = src.replace(EXEC_BAD, EXEC_GOOD);

fs.writeFileSync(TARGET, src, "utf8");
console.log("✓ 已还原：测试钩子不再出现在 schema，execute 也不再透传。");
