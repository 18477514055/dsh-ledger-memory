#!/usr/bin/env node
/**
 * 反向验证注入（D299）：**把"扩展不能碰核心记忆"这条拆掉**。
 *
 * ★ 要验的命题：探针 ②e / ⑤9 那两条「核心记忆逐字节不变」是**真的有牙**的。
 *   注入方式：让创建扩展时**顺手往核心 `LEDGER.md` 追加一行**（模拟"实现走偏"的典型形态：
 *   把扩展存储与核心存储混用）。若探针照样全绿，说明那两条断言是摆设。
 *
 * ★ 同时注入第二处：把**原则型的写保护摘掉**（`protect === true` 那个分支）。
 *   ⇒ ③11 必须报红。这条验的是"保护是代码，不是文案"。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, "..", "lib", "part8.js");
const MARK = "// [INJECTED:d299-core-touch-regression]";

const src = fs.readFileSync(TARGET, "utf8");
if (src.includes(MARK)) {
  console.log("已经注入过了，跳过。");
  process.exit(0);
}

// 注入点①：createExtension 成功返回之前，往核心 LEDGER.md 追加一行
const NEEDLE1 = `  return {
    ok: true,
    created: entry,
    storagePath: path.relative(fallbackRoot, dirAbs),`;

const PATCHED1 = `  ${MARK} 故意"顺手"改核心台账（反向验证：扩展绝不能碰基础协议）
  try {
    const realRoot = info?.projectRoot ?? fallbackRoot;
    const mb = memoryBaseOf(info, realRoot);
    fs.appendFileSync(path.join(mb, "LEDGER.md"), "\\n- 扩展偷偷改的一行\\n", "utf8");
  } catch { /* 忽略 */ }
  return {
    ok: true,
    created: entry,
    storagePath: path.relative(fallbackRoot, dirAbs),`;

// 注入点②：摘掉原则型写保护
const NEEDLE2 = `  if (mode.protect === true) {
    return {
      ok: false,
      reason:
        \`扩展「\${entry.name}」是**根本原则型** —— 它继承了原则文件的权限规则，\` +
        "**模型不能直接写**。要改它，必须由用户明确授权（与核心 \`PRINCIPLES.md\` 同一套规矩）。",
      protected: true,
    };
  }`;

const PATCHED2 = `  ${MARK} 原则型保护被摘掉（反向验证）
  if (false) {
    return { ok: false, reason: "unreachable", protected: true };
  }`;

if (!src.includes(NEEDLE1)) {
  console.error("✗ 找不到注入点①（createExtension 的 return）");
  process.exit(1);
}
if (!src.includes(NEEDLE2)) {
  console.error("✗ 找不到注入点②（原则型保护）");
  process.exit(1);
}

let out = src.replace(NEEDLE1, PATCHED1);
out = out.replace(NEEDLE2, PATCHED2);
fs.writeFileSync(TARGET, out, "utf8");
console.log("✓ 已注入两处：① 扩展顺手改核心台账 ② 原则型写保护被摘掉");
console.log("  下一步：跑 node tools/_probe-d299-extension.mjs，②e/⑤9 与 ③11 应当报红。");
