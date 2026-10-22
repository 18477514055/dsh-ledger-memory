#!/usr/bin/env node
/**
 * 反向验证注入（D298）：把落盘基准从 `memoryBase` **退回项目根**。
 *
 * ★ 要验的命题就是那个真缺陷本身：**V3 项目里日志会写回项目根**。
 *   ⇒ 退回后 `_probe-d298-log-base.mjs` 的 ②b/②c 必须报红。
 *   ★ 若它照样全绿，说明我的修复根本没被探针测到（D295/L50 那个病）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, "..", "lib", "part3.js");
const MARK = "// [INJECTED:d298-log-base-regression]";

const src = fs.readFileSync(TARGET, "utf8");
if (src.includes(MARK)) {
  console.log("已经注入过了，跳过。");
  process.exit(0);
}

const NEEDLE = `          const base = typeof b.memBase === "string" && b.memBase !== "" ? b.memBase : b.root;`;

const PATCHED = `          ${MARK} 故意忽略 memBase，退回项目根（反向验证）
          const base = b.root;`;

if (!src.includes(NEEDLE)) {
  console.error("✗ 找不到注入点 —— part3.js 的落盘基准可能已被改过。");
  process.exit(1);
}

fs.writeFileSync(TARGET, src.replace(NEEDLE, PATCHED), "utf8");
console.log("✓ 已注入：日志落盘基准退回项目根。");
console.log("  下一步：跑 node tools/_probe-d298-log-base.mjs，②b/②c 应当报红。");
