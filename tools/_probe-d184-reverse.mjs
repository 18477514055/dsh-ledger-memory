/**
 * ★★★★★ 反向验证（D184）：**把 `isMust` 写回那个坏写法 ⇒ 断言必须当场见红。**
 *
 * ★ 为什么这一轮的反向验证特别重要（比平时更要紧）：
 *   被修的那条守卫**本身就是假的** —— 旧判据是**静态正则**，而**坏代码正好满足它**。
 *   ⇒ 单纯"摘掉修复看红不红"不够，必须**同时证明**：
 *     ① **新判据（结构 + 行为）在坏版本下见红** —— 说明修复有牙；
 *     ② ★★★ **旧判据（静态正则）在坏版本下仍然绿** —— 说明它**当初就是假绿**，
 *        那才是这条 bug 能活好几天的真正原因。
 *   ② 是这一次反向验证的**主要证据**：它把"守卫为什么失效"也变成可复现的。
 *
 * ★ 三个方向：
 *   A. **退回坏写法**（`? false :` 串联 `||`）⇒ 期望：结构断言红 **且** 行为断言红。
 *      ★ 并且：**旧静态正则在同一个坏版本上是绿的**（现场复现"假绿"）。
 *   B. **只在压缩后不注**（改成 `afterCompaction === true ? false : …`）——
 *      与 A 不同的坏法，验证行为断言不依赖某一种具体写法。
 *   C. **把必注阈值调成不可达**（`weightMustInject: 9999`）⇒ 行为断言仍应绿
 *      （因为压缩后**不靠权重**判）—— ★ 这是一条**负向对照**：
 *      它证明行为断言的"红"确实来自"压缩后忘注"，而不是别的噪声。
 *
 * ★★ 纪律：**还原进 finally**（上一轮 D183 的探针就是崩在还原之前 ⇒ 把源码留在退化版上）。
 *   本轮再加一层：`process.on("exit")` 兜底还原。
 *
 * 跑法：node tools/_probe-d184-reverse.mjs
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
let restoredOnce = false;

/** ★ 兜底：无论怎么退出，都把源码写回原件（D183 那次崩在还原之前的教训）。 */
function restoreHard() {
  if (restoredOnce) return;
  try {
    fs.writeFileSync(LIB, original);
  } catch {}
}
process.on("exit", restoreHard);
process.on("uncaughtException", (e) => {
  console.log(`★★ 探针自身异常：${e?.message ?? e}`);
  restoreHard();
  process.exit(2);
});

console.log(`⓪ 备份 sha256=${origSha.slice(0, 16)}… (${original.length} B)\n`);

function runSelftest(label) {
  let out = "";
  try {
    out = execFileSync(process.execPath, [SELFTEST], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
  }
  const lines = out.split("\n");
  const red = lines.filter((l) => /^\s*FAIL/.test(l)).map((l) => l.trim());
  console.log(`--- ${label}：红 ${red.length} 条 ---`);
  for (const r of red.slice(0, 8)) console.log("   " + r.slice(0, 160));
  for (const x of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + x.trim());
  try {
    fs.writeFileSync(path.join(os.tmpdir(), `d184-reverse-${label}.txt`), out);
  } catch {}
  return red;
}

/**
 * 写入一个退化版、跑自检、**无论成败都还原**。
 * @param {(s:string)=>string} mutate 对源码做变换（返回新文本）
 */
function experiment(label, mutate) {
  try {
    const next = mutate(origText);
    if (next === origText) {
      console.log(`▶ ${label}：★ 变换没有改到任何东西（锚点漂了）⇒ 跳过，计一次失败`);
      failures += 1;
      return [];
    }
    fs.writeFileSync(LIB, next);
    console.log(`▶ ${label}：已写入退化版 sha256=${sha(fs.readFileSync(LIB)).slice(0, 16)}…`);
    return runSelftest(label);
  } finally {
    fs.writeFileSync(LIB, original);
    const same = sha(fs.readFileSync(LIB)) === origSha;
    console.log(`   [还原] ${same ? "✅ 逐字节一致" : "❌ 不一致！"}\n`);
    if (!same) failures += 1;
  }
}

// ── A. 退回那个坏写法（`||` 与 `?:` 串联，就是 D184 的真凶）──────────────────
const goodIsMust =
  "    const isMust =\n" +
  "      // ★ 安全绳 ②：压缩后一律重注（不靠权重判）—— **全部块**，含元数据那种\n" +
  "      afterCompaction === true\n" +
  "        ? true\n" +
  "        : // ★ 硬规则：元数据恒 0 ⇒ 永远只进目录（它就是\"变更登记\"那种）\n" +
  "          w.capped === \"zero\"\n" +
  "          ? false\n" +
  "          : // ★ 四条\"必注\"的充分条件\n" +
  "            w.score >= numOf(\"weightMustInject\", WEIGHT_MUST_INJECT) ||";
const badIsMust =
  "    const isMust =\n" +
  "      afterCompaction === true ||\n" +
  "      w.capped === \"zero\"\n" +
  "        ? false\n" +
  "        : w.score >= numOf(\"weightMustInject\", WEIGHT_MUST_INJECT) ||";

{
  const n = origText.split(goodIsMust).length - 1;
  console.log(`▶ A 锚点命中 ${n} 次（应为 1）`);
  if (n !== 1) {
    console.log("   定位失败 ⇒ 跳过。★ 这本身也是有用信号（说明源码已不是我以为的形状）\n");
    failures += 1;
  } else {
    const red = experiment("A-bad-precedence", (s) => s.replace(goodIsMust, badIsMust));
    const structHit = red.some((l) => /安全绳②（结构）/.test(l));
    const behavHit = red.some((l) => /安全绳②（行为）/.test(l));
    console.log(`   ⇒ 结构断言见红：${structHit ? "✅" : "❌"} · 行为断言见红：${behavHit ? "✅" : "❌"}`);
    // ★★★ 同时复现"旧判据当时是绿的"—— 那条静态正则对**坏代码**是否判为通过？
    const staticRe = /afterCompaction === true\s*\|\|/;
    const wouldOldPass = staticRe.test(badIsMust);
    console.log(
      `   ⇒ ★★★ 旧（静态正则）判据对这个坏版本＝**${wouldOldPass ? "绿（通过）" : "红"}**` +
        `　${wouldOldPass ? "← 这就是它**当初是假绿**的直接证据" : ""}`
    );
    if (!wouldOldPass) {
      console.log("   ★★ 与预期不符：旧守卫本该被坏代码满足 ⇒ 我对它的理解有误，必须重查");
      failures += 1;
    }
    if (!structHit || !behavHit) failures += 1;
    console.log("");
  }
}

// ── B. 另一种坏法：**压缩后一律不注**（`? true :` → `? false :`）──────────────
//   ★ 为什么要这一条：A 是把两支用 `||` 串起来（**优先级**错），
//     B 是**优先级对了但结论反了**（`? false`）。两种坏法都必须能被同一个行为断言抓住 ——
//     否则那条断言就只是"防某一种写法"，换个写法它又哑了（正是静态正则当初的病）。
{
  const needleB = "      afterCompaction === true\n        ? true\n        :";
  const n = origText.split(needleB).length - 1;
  console.log(`▶ B 锚点命中 ${n} 次（应为 1）`);
  if (n !== 1) {
    console.log("   定位失败 ⇒ 跳过\n");
    failures += 1;
  } else {
    const red = experiment("B-compaction-never", (s) =>
      s.replace(needleB, "      afterCompaction === true\n        ? false\n        : /* D184-B: 压缩后也不注 */")
    );
    const behavHit = red.some((l) => /安全绳②（行为）/.test(l));
    console.log(`   ⇒ 行为断言见红：${behavHit ? "✅" : "❌（换一种坏法它就哑了 ⇒ 断言太窄）"}`);
    if (!behavHit) failures += 1;
    console.log("");
  }
}

// ── C. 负向对照：把必注阈值调到不可达 ⇒ **压缩后仍应给正文**（行为断言不该红）──
{
  const red = experiment("C-threshold-unreachable", (s) =>
    s.replace("const WEIGHT_MUST_INJECT = 50;", "const WEIGHT_MUST_INJECT = 99999;")
  );
  const behavHit = red.some((l) => /安全绳②（行为）/.test(l));
  console.log(
    `   ⇒ 阈值调到不可达时，行为断言${behavHit ? "★ 红了 ⇒ 说明它其实依赖权重判，不是「压缩后必注」（需查）" : "仍绿 ✅ ⇒ 证明它的「红」确实来自「压缩后忘注」"}\n`
  );
  if (behavHit) failures += 1;
}

// ═══ 无条件还原 + 逐字节校验 ═════════════════════════════════════════════════
fs.writeFileSync(LIB, original);
restoredOnce = true;
const restored = sha(fs.readFileSync(LIB));
console.log(`③ 已还原。sha256=${restored}`);
console.log(`   ${restored === origSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌（必须手工处理）"}`);
if (restored !== origSha) failures += 1;

console.log(
  failures === 0
    ? "\n⇒ ★★★ 结论：D184 的修复**有牙**（结构 + 行为两条都见红），" +
        "且**旧静态正则对坏代码是绿的** ⇒ 假绿成因已可复现 ✅"
    : `\n⇒ ★★ 有 ${failures} 处没通过，必须人工核对 ❌`
);
process.exit(failures === 0 ? 0 : 1);
