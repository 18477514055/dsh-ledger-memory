/**
 * ★★★★★ 反向验证（D182）：摘掉索引的两条**用户明说的承诺** ⇒ 断言必须变红。
 *
 * ★ 为什么必须做（纪律 10）：D182 的两条承诺**都极易被后人顺手改回去**：
 *   ① **只追加不删** —— 原实现就是 `list.length = idxMax`（尾部截断），
 *      看起来"更省"、更像"有界就该这样"，**很容易被当成好主意加回来**；
 *   ② **指向官方的保存** —— 很容易被改成"直接把路径拼出来"（不做存在性校验），
 *      省一次 `existsSync`，而后果是**指针指不到东西**（伤「可回溯」）。
 *   ⇒ 这两条**语法上都对**、大多数断言仍绿 ⇒ 只有反向验证能证明它们有牙。
 *
 * ★ 两次摘除，各自独立跑一轮自检：
 *   摘 A ⇒ 期望 **75③ / 75③b** 红（只追加被破坏）
 *   摘 B ⇒ 期望 **75②**（文件不存在时仍返回路径）红
 *
 * ★ 无条件还原 + sha256 逐字节校验（两次摘除都在同一份 original 上做）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const PLUGIN = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const LIB = path.join(PLUGIN, "lib", "index.js");
const SELFTEST = path.join(PLUGIN, "tools", "selftest.mjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const original = fs.readFileSync(LIB);
const origSha = sha(original);
const origText = original.toString("utf8");
let failures = 0;

console.log(`⓪ 备份 sha256=${origSha.slice(0, 16)}… (${original.length} B)\n`);

function runSelftest(label) {
  let out = "";
  try {
    out = execFileSync(process.execPath, [SELFTEST], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
  }
  const lines = out.split("\n");
  const red = lines.filter((l) => /^\s*FAIL/.test(l));
  console.log(`--- ${label}：红 ${red.length} 条 ---`);
  for (const r of red.slice(0, 12)) console.log("   " + r.trim().slice(0, 150));
  for (const x of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + x.trim());
  fs.writeFileSync(path.join(os.tmpdir(), `d182-reverse-${label}.txt`), out);
  return red;
}

// ═══ 摘 A：把「只追加」改回**尾部截断**（就是修复前那个写法）═══════════════
{
  const NEEDLE = "      state.shadowedIndex.set(key, list);\n      // ★★★ 2026-10-13（D160）";
  const n = origText.split(NEEDLE).length - 1;
  console.log(`① 摘 A：只追加那一处命中 ${n} 次（应为 1）`);
  if (n !== 1) {
    console.log("★ 定位失败（锚点漂了）⇒ 跳过摘 A。★ 这本身也是有用信号。");
    failures += 1;
  } else {
    const degraded = origText.replace(
      NEEDLE,
      "      { const _m = numOf(\"shadowedIndexMax\", SHADOWED_INDEX_MAX); if (list.length > _m) list.length = _m; }\n" +
        "      state.shadowedIndex.set(key, list);\n      // ★反向验证 D182-A：把「只追加」退回尾部截断\n      // ★★★ 2026-10-13（D160）"
    );
    fs.writeFileSync(LIB, degraded);
    console.log(`   已写入退化版 sha256=${sha(fs.readFileSync(LIB)).slice(0, 16)}…`);
    const red = runSelftest("A-append-only-removed");
    const hit = red.some((l) => /75③/.test(l));
    console.log(hit ? "\n   ⇒ ★ 75③ 确实见红 ✅\n" : "\n   ⇒ ★★ 75③ 没红 ⇒ 那条断言是摆设 ❌\n");
    if (!hit) failures += 1;
    fs.writeFileSync(LIB, original); // 还原
  }
}

// ═══ 摘 B：官方路径**不做存在性校验**（直接拼、永远返回）═══════════════════
{
  const NEEDLE = "      if (fs.existsSync(file)) return file;\n    }\n    return undefined;";
  const n = origText.split(NEEDLE).length - 1;
  console.log(`② 摘 B：官方路径存在性校验那一处命中 ${n} 次（应为 1）`);
  if (n !== 1) {
    console.log("★ 定位失败（锚点漂了）⇒ 跳过摘 B。★ 这本身也是有用信号。");
    failures += 1;
  } else {
    const degraded = origText.replace(
      NEEDLE,
      "      return file; // ★反向验证 D182-B：不再校验「它真的在」\n    }\n    return undefined;"
    );
    fs.writeFileSync(LIB, degraded);
    console.log(`   已写入退化版 sha256=${sha(fs.readFileSync(LIB)).slice(0, 16)}…`);
    const red = runSelftest("B-no-exists-check");
    const hit = red.some((l) => /75②/.test(l));
    console.log(hit ? "\n   ⇒ ★ 75② 确实见红 ✅\n" : "\n   ⇒ ★★ 75② 没红 ⇒ 那条断言是摆设 ❌\n");
    if (!hit) failures += 1;
    fs.writeFileSync(LIB, original); // 还原
  }
}

// ═══ 无条件还原 + 逐字节校验 ═══════════════════════════════════════════════
fs.writeFileSync(LIB, original);
const restored = sha(fs.readFileSync(LIB));
console.log(`③ 已还原。sha256=${restored}`);
console.log(`   ${restored === origSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌（必须手工处理）"}`);
if (restored !== origSha) failures += 1;

console.log(
  failures === 0
    ? "\n⇒ ★★★ 结论：两条承诺**各自都有牙** —— 摘掉任一条都能看见红 ✅"
    : `\n⇒ ★★ 有 ${failures} 处没通过，必须人工核对 ❌`
);
process.exit(failures === 0 ? 0 : 1);
