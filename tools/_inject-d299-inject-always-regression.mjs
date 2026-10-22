#!/usr/bin/env node
/**
 * 反向验证注入（D299 注入侧）：把「只在 inject 打开时才附内容」这个判断摘掉。
 *
 * ★ 要验的命题：**②h / ③a 那两条「未开注入就不推内容」是真的有牙的**。
 *   注入方式：把 `if (e.inject === true && exists)` 改成 `if (exists)`
 *   （= 不管开没开，都把内容塞进去 —— 典型的"多推一点又不会死"的走偏）。
 *   ⇒ ③a 必须报红；④b（总量有界）也应跟着红。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, "..", "lib", "part8.js");
const MARK = "// [INJECTED:d299-inject-always-regression]";

const src = fs.readFileSync(TARGET, "utf8");
if (src.includes(MARK)) {
  console.log("已经注入过了，跳过。");
  process.exit(0);
}

const NEEDLE = `    if (e.inject === true && exists) {`;
const PATCHED = `    ${MARK} 不管 inject 开关，一律附内容（反向验证）
    if (exists) {`;

if (!src.includes(NEEDLE)) {
  console.error("✗ 找不到注入点（inject 判断）。");
  process.exit(1);
}

fs.writeFileSync(TARGET, src.replace(NEEDLE, PATCHED), "utf8");
console.log("✓ 已注入：不管 inject 开关，一律附内容。");
console.log("  下一步：跑 node tools/_probe-d299-extension-inject.mjs，③a 应当报红。");
