#!/usr/bin/env node
/**
 * 反向验证注入：把 `op:"v3"` 那段接线**摘掉**（改成永远不命中），
 * 看 `_probe-v3-tool-entry.mjs` 会不会报红。
 *
 * ★ 为什么必须做：本项目最重要的一条教训是
 *   **「摘一处不红 ≠ 断言够硬」**，也可能是那处代码根本没被执行。
 *   所以每次写完探针，都要反过来问一句：**把被测的东西拿掉，它红不红？**
 *
 * ★ 注入点选在**接线本身**（part4 里那三行），不是迁移器内部 ——
 *   因为本探针要测的就是"工具调得到它"。迁移器内部另有 `_probe-v3-migrate.mjs` 36 条在管。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TARGET = path.join(ROOT, "lib", "part4.js");
const MARK = "// [INJECTED:v3-tool-entry-regression]";

const src = fs.readFileSync(TARGET, "utf8");
if (src.includes(MARK)) {
  console.log("已经注入过了，跳过。");
  process.exit(0);
}

const NEEDLE = `      if (args?.op === "v3") {
        return migrateToV3(root, { apply: args?.apply === true });
      }`;

if (!src.includes(NEEDLE)) {
  console.error("✗ 找不到注入点 —— part4.js 里的 v3 接线可能已经被改过。");
  process.exit(1);
}

// 注入回归：op:"v3" 不再进迁移器，而是掉到 detectMigration。
const PATCHED = `      ${MARK} 故意让 op:"v3" 走不到迁移器（反向验证）`;

fs.writeFileSync(TARGET, src.replace(NEEDLE, PATCHED), "utf8");
console.log("✓ 已注入：op:\"v3\" 接线被摘掉，现在会掉到 detectMigration。");
console.log("  下一步：跑 node tools/_probe-v3-tool-entry.mjs，应当报红。");
