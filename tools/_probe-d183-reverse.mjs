/**
 * ★★★★★ 反向验证（D183）：摘掉"流水"的三条**语义承诺** ⇒ 断言必须变红。
 *
 * ★ 为什么必须做（纪律 10）：D183 的三条承诺**每一条都极易被后人顺手改掉**，
 *   而且改完之后**语法都对、大多数断言仍绿**：
 *   ① **默认 append** —— 最省事的写法是 `mode = args?.mode ?? "replace"`（全局一个默认）
 *      ⇒ 一次普通写入就静默抹掉全部历史（那正是 **A1 那个坑**）；
 *   ② **不注入** —— 后人可能"顺手"把 JOURNAL 也并进注入（觉得"多给点信息没坏处"）
 *      ⇒ 64% 的历史又回来了，D183 的全部收益当场归零；
 *   ③ **审计 kind 独立** —— 判据白名单很容易只列前面那两个
 *      （★ 这个**真实发生过**：76④ 写完当场见红，才发现 `appendAudit` 的白名单漏了它）。
 *
 * ★ 三次摘除，各自独立跑一轮自检；每次**无条件还原** + sha256 逐字节校验。
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
  fs.writeFileSync(path.join(os.tmpdir(), `d183-reverse-${label}.txt`), out);
  return red;
}

/**
 * ★★ 本轮我在这里**真栽了一次**（值得留档）：`red.some(expectRe)` —— `.some()` 要的是
 *   **函数**，我传了正则字面量 ⇒ `TypeError: object is not a function`
 *   ⇒ 探针**在还原之前崩掉** ⇒ **源码被留在退化版上**（实测 `sha256` 与备份不符）。
 *   ⇒ 两条修法，缺一不可：
 *     ① 判据改成谓词 `(l) => re.test(l)`；
 *     ② **还原搬进 `finally`** —— 探针自己崩了也必须还原（纪律：破坏性脚本的第一要件是"退出也还原"）。
 */
function attempt(label, needle, replacer, expectRe) {
  const n = origText.split(needle).length - 1;
  console.log(`▶ ${label}：锚点命中 ${n} 次（应为 1）`);
  if (n !== 1) {
    console.log("   定位失败（锚点漂了）⇒ 跳过。★ 这本身也是有用信号。");
    failures += 1;
    return;
  }
  try {
    fs.writeFileSync(LIB, origText.replace(needle, replacer));
    console.log(`   已写入退化版 sha256=${sha(fs.readFileSync(LIB)).slice(0, 16)}…`);
    const red = runSelftest(label);
    const hit = red.some((l) => expectRe.test(l));
    console.log(hit ? "   ⇒ ★ 确实见红 ✅\n" : "   ⇒ ★★ 没红 ⇒ 那条承诺是摆设 ❌\n");
    if (!hit) failures += 1;
  } finally {
    // ★★ 无条件还原（**即使上面抛异常**）—— 这是本次踩到的坑的直接修法。
    fs.writeFileSync(LIB, original);
    const same = sha(fs.readFileSync(LIB)) === origSha;
    console.log(`   [还原] sha256=${sha(fs.readFileSync(LIB)).slice(0, 16)}… ${same ? "✅" : "❌ 不一致！"}`);
    if (!same) failures += 1;
  }
}

// ═══ 摘 A：把「流水默认 append」退回**全局 replace 默认** ═══════════════════════
attempt(
  "A-journal-not-append",
  'const mode = explicitMode ?? (target === "decisions" || target === "journal" ? "append" : "replace");',
  'const mode = explicitMode ?? (target === "decisions" ? "append" : "replace"); // D183-A: 流水退回 replace',
  /76①/
);

// ═══ 摘 B：把流水**也注进注入**（模拟后人"顺手多给点信息"）══════════════════════
attempt(
  "B-journal-injected",
  "  return renderInjectionBody(info, pending, biOpts) + goalsBlock + idxBlock;",
  "  let __j = '';\n" +
    "  try {\n" +
    "    if (typeof info.journalRel === 'string' && info.journalRel !== '') {\n" +
    "      __j = '\\n' + (readTextSafe(path.resolve(info.projectRoot, info.journalRel)) ?? '');\n" +
    "    }\n" +
    "  } catch {}\n" +
    "  return renderInjectionBody(info, pending, biOpts) + goalsBlock + idxBlock + __j; // D183-B: 流水被注入",
  /76②/
);

// ═══ 摘 C：把审计 kind 白名单退回**只认前两个**（就是 76④ 抓到的那个缺口）══════
attempt(
  "C-journal-audit-kind",
  "    rec.kind === AUDIT_KIND_PRINCIPLE ||\n    rec.kind === AUDIT_KIND_GOALS ||\n    rec.kind === AUDIT_KIND_JOURNAL",
  "    rec.kind === AUDIT_KIND_PRINCIPLE ||\n    rec.kind === AUDIT_KIND_GOALS // D183-C: 漏掉 journal",
  /76④/
);

// ═══ 无条件还原 + 逐字节校验 ═════════════════════════════════════════════════
fs.writeFileSync(LIB, original);
const restored = sha(fs.readFileSync(LIB));
console.log(`③ 已还原。sha256=${restored}`);
console.log(`   ${restored === origSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌（必须手工处理）"}`);
if (restored !== origSha) failures += 1;

console.log(
  failures === 0
    ? "\n⇒ ★★★ 结论：三条承诺**各自都有牙** —— 摘掉任一条都能看见红 ✅"
    : `\n⇒ ★★ 有 ${failures} 处没通过，必须人工核对 ❌`
);
process.exit(failures === 0 ? 0 : 1);
