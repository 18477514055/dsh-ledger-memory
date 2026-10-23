#!/usr/bin/env node
/**
 * 反向验证 D302：**注入里的 SECURITY.md 指针必须核对文件是否存在**。
 *
 * ★ 要证明的三条（缺一不算，纪律 10）：
 *   ① V3 且文件**不存在** ⇒ 注入里**不能**出现 `SECURITY.md` 那句话（原来无条件出现 ⇒ 这是修的那个洞）；
 *   ② V3 且文件**存在** ⇒ 必须出现（且带对路径）—— 否则等于把功能删掉了；
 *   ③ V2 ⇒ 一个字都不能有（向后兼容，V2 下注入必须逐字不变）。
 *   ④ 反向：把修复摘掉 ⇒ ① 必须**变红**。
 *
 * ★ 只 import 纯函数 `renderInjectionBody`，不建仓库、不碰真实工作区。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const PART3 = path.join(PROJECT, "lib", "part3.js");
const PART7 = path.join(PROJECT, "lib", "part7.js");

const { inspect } = await import(pathToFileURL(path.join(PROJECT, "lib", "part2.js")).href);
const { renderInjectionBody } = await import(pathToFileURL(PART3).href);
const { writeSecurityMd } = await import(pathToFileURL(PART7).href);

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail === undefined ? "" : `  —— ${detail}`}`);
};

function makeFixture(kind, withSecurity) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ledger-secptr-${kind}-`));
  const manifest = { version: 1, active: "LEDGER.md", archiveDir: "_ledger-archive" };
  if (kind === "v3") manifest.memoryRoot = "mem-ledger-memory";
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# t\n\n- 一条\n", "utf8");
  if (kind === "v3") {
    const mem = path.join(root, "mem-ledger-memory");
    fs.mkdirSync(path.join(mem, "_ledger-archive"), { recursive: true });
    if (withSecurity) writeSecurityMd(mem);
  }
  return root;
}

const say = (root) => renderInjectionBody(inspect(root), undefined, {});

console.log("═".repeat(74));
console.log("反向验证 D302：SECURITY.md 指针必须核对文件存在性");
console.log("═".repeat(74));

// ① V3 无文件 ⇒ 不该出现
const noFile = makeFixture("v3", false);
const t1 = say(noFile);
ok("① 基线前提：夹具里确实**没有** SECURITY.md", !fs.existsSync(path.join(noFile, "mem-ledger-memory", "SECURITY.md")), "");
ok("① V3 无文件 ⇒ 注入里**不出现** SECURITY.md 指针（这就是修掉的洞）", !t1.includes("SECURITY.md"), t1.includes("SECURITY.md") ? "仍然出现了！" : "");

// ② V3 有文件 ⇒ 必须出现
const withFile = makeFixture("v3", true);
const t2 = say(withFile);
ok("② V3 有文件 ⇒ 注入里**出现**指针", t2.includes("SECURITY.md"), "");
ok("② 指针里带对的路径 `mem-ledger-memory/SECURITY.md`", t2.includes("mem-ledger-memory/SECURITY.md"), "");

// ③ V2 ⇒ 一个字都没有
const v2 = makeFixture("v2", false);
const t3 = say(v2);
ok("③ V2 ⇒ 注入里一个字都没有（向后兼容逐字不变）", !t3.includes("SECURITY.md"), "");

// ④ 反向：摘掉修复 ⇒ ① 必须变红
const src = fs.readFileSync(PART3, "utf8");
const NEEDLE = "const secLine = secExists";
if (!src.includes(NEEDLE)) {
  ok("④ 反向验证的前置：源码里有 `secExists` 判断", false, "找不到 ⇒ 本探针前提不成立");
} else {
  // 把 `secExists` 强制成"有 memoryRoot 就算存在"= 旧的坏行为
  const patched = src.replace(
    "  const secLine = secExists",
    "  const secLine = (typeof secRel === \"string\" && secRel !== \"\") /* 反向验证：旧的无条件行为 */"
  );
  try {
    fs.writeFileSync(PART3, patched, "utf8");
    const m2 = await import(`${pathToFileURL(PART3).href}?t=${Date.now()}`);
    const t4 = m2.renderInjectionBody(inspect(makeFixture("v3", false)), undefined, {});
    ok("④ 反向（摘掉核对）：V3 无文件时**又**出现指针 ⇒ 断言能看见红", t4.includes("SECURITY.md"), t4.includes("SECURITY.md") ? "如预期出现了" : "没出现（假绿）");
  } finally {
    fs.writeFileSync(PART3, src, "utf8");
    console.log(`  （源码已还原 ${Buffer.byteLength(fs.readFileSync(PART3))} B）`);
  }
  ok("④ 还原后与原件逐字相同", fs.readFileSync(PART3, "utf8") === src, "");
}

const bad = results.filter((r) => r.pass !== true).length;
console.log("\n" + "─".repeat(74));
console.log(`${results.length - bad} PASS / ${bad} FAIL`);
console.log("─".repeat(74));
process.exit(bad === 0 ? 0 : 1);
