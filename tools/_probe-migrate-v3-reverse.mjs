#!/usr/bin/env node
/**
 * 反向验证：把 D301 的三个收口**逐个摘掉**，确认探针**能看见红**（纪律 10）。
 *
 * ★★★ 为什么必须单独跑一遍：正向 19 条全绿**不等于**断言有效。
 *   本项目已经栽过两次"摘掉修复仍然全绿"（假绿），根因都是**判据没打在被测行为上**。
 *   ⇒ 每一次修复都必须有一次"摘掉 → 变红 → 装回 → 变绿"的闭环。
 *
 * ★ 做法：读 `part7.js` 原文 → 逐条替换成"未修复"写法 → **子进程**跑正向探针
 *   → 记录退出码与失败条目 → 还原（finally 里，且**校验字节相同**）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const PART7 = path.join(PROJECT, "lib", "part7.js");
const FORWARD = path.join(HERE, "_probe-migrate-v3-security.mjs");

const original = fs.readFileSync(PART7);
const src = original.toString("utf8");

/** 三个要摘掉的收口：{name, find, replace} */
const CUTS = [
  {
    name: "① mergeGitignore（迁移不配 .gitignore）",
    find: "    ignoreResult = mergeGitignore(projectRoot, [...DEFAULT_IGNORE_LINES, ...v3Lines]);",
    replace: "    ignoreResult = undefined; // 反向验证：故意不配 ignore",
  },
  {
    name: "② writeSecurityMd（迁移不建 SECURITY.md）",
    find: "    securityWritten = writeSecurityMd(memAbs);",
    replace: "    securityWritten = false; // 反向验证：故意不建 SECURITY.md",
  },
  {
    name: "③ detectTrackedMemory（迁移不查已追踪）",
    find: "  const trackedCheck = detectTrackedMemory(projectRoot);",
    replace: "  const trackedCheck = { ok: true, tracked: [] }; // 反向验证：故意不查",
  },
];

const runForward = () => {
  const r = spawnSync(process.execPath, [FORWARD], { encoding: "utf8", cwd: PROJECT });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const fails = out
    .split("\n")
    .filter((l) => l.trim().startsWith("✗"))
    .map((l) => l.trim().slice(0, 96));
  return { code: r.status, fails };
};

console.log("═".repeat(76));
console.log("反向验证：逐个摘掉 D301 的三个收口，确认探针能看见红");
console.log("═".repeat(76));

// 先确立基线：未改动时必须是全绿
const base = runForward();
console.log(`\n【基线】未改动：exit=${base.code} · 失败 ${base.fails.length} 条`);
if (base.code !== 0) {
  console.log("  ✗ 基线自己就是红的 ⇒ 本反向验证没有意义（先修正向探针）");
  for (const f of base.fails) console.log(`     ${f}`);
  process.exit(1);
}
console.log("  ✓ 基线全绿 ⇒ 可以开始逐个摘");

let allCaught = true;
for (const cut of CUTS) {
  if (!src.includes(cut.find)) {
    console.log(`\n【${cut.name}】✗ 找不到要摘的那一行 —— 本项无法验证（判据与代码不同源）`);
    allCaught = false;
    continue;
  }
  const patched = src.replace(cut.find, cut.replace);
  try {
    fs.writeFileSync(PART7, patched, "utf8");
    const got = runForward();
    const caught = got.code !== 0 && got.fails.length > 0;
    console.log(`\n【${cut.name}】摘掉后 exit=${got.code} · 失败 ${got.fails.length} 条 ${caught ? "⇒ ✓ 变红了" : "⇒ ✗ **仍然全绿（假绿！）**"}`);
    for (const f of got.fails.slice(0, 6)) console.log(`     ${f}`);
    if (!caught) allCaught = false;
  } finally {
    fs.writeFileSync(PART7, src, "utf8");
  }
}

// 还原校验（按字节）
const restored = fs.readFileSync(PART7);
const same = restored.equals(original);
console.log(`\n【还原】part7.js 与原件字节相同：${same ? "✓" : "✗"}  (${restored.length} B)`);

const final = runForward();
console.log(`【末态】再跑一次正向：exit=${final.code} · 失败 ${final.fails.length} 条 ${final.code === 0 ? "✓ 全绿" : "✗"}`);

const verdict = allCaught && same && final.code === 0;
console.log("\n" + "─".repeat(76));
console.log(verdict ? "✓ 三个收口全部「摘掉能变红、装回能变绿」⇒ 断言有效" : "✗ 有收口摘掉后看不见红 ⇒ 断言无效，必须重写判据");
console.log("─".repeat(76));
process.exit(verdict ? 0 : 1);
