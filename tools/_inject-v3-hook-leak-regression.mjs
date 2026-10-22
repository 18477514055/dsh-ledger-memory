#!/usr/bin/env node
/**
 * 反向验证注入（⑥ 组专用）：把两个测试钩子**加进工具 schema**。
 *
 * ★ 为什么这条必须单独验：⑥a/⑥b 现在是绿的，但那种绿有**两种可能**：
 *   · 确实有个约束在挡（好）；
 *   · 或者我**本来就没往 schema 里写**（那 ⑥a 测的是空气 —— D295 那个病）。
 *   ⇒ 只有把它加进去、看它红，才能区分这两种。
 *
 * ★ 同时注入 ⑥e/⑥f 的反面：让 execute 真的把测试钩子透传下去。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TARGET = path.join(ROOT, "lib", "part4.js");
const MARK = "// [INJECTED:v3-hook-leak-regression]";

const src = fs.readFileSync(TARGET, "utf8");
if (src.includes(MARK)) {
  console.log("已经注入过了，跳过。");
  process.exit(0);
}

// ① 往 schema 里塞两个测试钩子参数。
const SCHEMA_NEEDLE = `        apply: {
          type: "boolean",
          description: "For op:\\"split\\" / op:\\"v3\\": default false = dry run (writes nothing). Set true to actually perform the change.",
        },`;

const SCHEMA_PATCHED = `${SCHEMA_NEEDLE}
        ${MARK} 故意把探针专用的故障注入点暴露到工具 schema（反向验证）
        injectCorruptCopy: { type: "boolean" },
        stopBeforeManifest: { type: "boolean" },`;

// ② 让 execute 透传测试钩子（不再"只挑 args.apply"）。
const EXEC_NEEDLE = `      if (args?.op === "v3") {
        return migrateToV3(root, { apply: args?.apply === true });
      }`;

const EXEC_PATCHED = `      if (args?.op === "v3") {
        return migrateToV3(root, {
          apply: args?.apply === true,
          injectCorruptCopy: args?.injectCorruptCopy === true,
          stopBeforeManifest: args?.stopBeforeManifest === true,
        });
      }`;

if (!src.includes(SCHEMA_NEEDLE)) {
  console.error("✗ 找不到 schema 注入点。");
  process.exit(1);
}
if (!src.includes(EXEC_NEEDLE)) {
  console.error("✗ 找不到 execute 注入点。");
  process.exit(1);
}

let out = src.replace(SCHEMA_NEEDLE, SCHEMA_PATCHED);
out = out.replace(EXEC_NEEDLE, EXEC_PATCHED);
fs.writeFileSync(TARGET, out, "utf8");
console.log("✓ 已注入：测试钩子进了 schema，且 execute 会透传它们。");
console.log("  下一步：跑 node tools/_probe-v3-tool-entry.mjs，⑥ 组应当报红。");
