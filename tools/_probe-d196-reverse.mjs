/**
 * ★★★★★ 反向验证（D196）：**把"升级通道"逐处摘掉 ⇒ 情形 84 必须见红。**
 *
 * ★ 纪律 10：反向验证必须摘到**能看见红**为止。
 *
 * ★ 本探针守两条独立保证：
 *   A. **未启用的能力必须被推行**（否则旧项目永远升不上来）⇒ 摘掉那一段 ⇒ 84① 红。
 *   B. ★★★ **清单绝不能写进用户项目**（用户的硬约束）⇒
 *      把落盘路径改到项目里 ⇒ 84③ 红。
 *      ★ 这条是**约束**不是功能：写错地方 = 污染别人的项目（本机红线）。
 *
 * ★ 还原进 finally + process.on("exit") 兜底（D183 的教训）。
 *
 * 跑法：node tools/_probe-d196-reverse.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib", "index.js");
const SELFTEST = path.join(ROOT, "tools", "selftest.mjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const reOf = (circ) => new RegExp(`84${circ}(?!b)`);

const original = fs.readFileSync(LIB);
const origSha = sha(original);
const origText = original.toString("utf8");
let failures = 0;
let done = false;

function restoreHard() {
  if (done) return;
  try {
    fs.writeFileSync(LIB, original);
  } catch {}
}
process.on("exit", restoreHard);
process.on("uncaughtException", (e) => {
  console.log(`★★ 探针异常：${e?.message ?? e}`);
  restoreHard();
  process.exit(2);
});

console.log(`⓪ 备份 sha256=${origSha.slice(0, 16)}… (${original.length} B)\n`);

function runSelftest(label) {
  let out = "";
  try {
    out = execFileSync(process.execPath, [SELFTEST], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
  }
  const red = out.split("\n").filter((l) => /^\s*FAIL/.test(l)).map((l) => l.trim());
  console.log(`--- ${label}：红 ${red.length} 条 ---`);
  for (const r of red.slice(0, 8)) console.log("   " + r.slice(0, 150));
  for (const x of out.split("\n").filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + x.trim());
  return red;
}

function experiment(label, mutate, needles) {
  for (const nd of needles) {
    const n = origText.split(nd).length - 1;
    if (n !== 1) {
      console.log(`▶ ${label}：★ 锚点命中 ${n} 次（应为 1）⇒ 定位失败，计一次失败\n   「${nd.slice(0, 80)}」`);
      failures += 1;
      return [];
    }
  }
  try {
    const next = mutate(origText);
    if (next === origText) {
      console.log(`▶ ${label}：★ 变换没改到东西 ⇒ 跳过，计一次失败\n`);
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

// ═══════════════════════════════════════════════════════════════════════════
// A. 摘掉"未启用能力的推行" ⇒ 84① 必须红
{
  const needle = "      renderUnenabledCapabilities(info) +";
  const red = experiment(
    "A-no-upgrade-channel",
    (s) => s.replace(needle, "      \"\" + /* D196-A: 退化版 —— 不再推行未启用的能力 */"),
    [needle]
  );
  const hit = red.some((l) => reOf("①").test(l));
  console.log(`   ⇒ 84①（未启用的能力必须被推行）见红：${hit ? "✅" : "❌ 升级通道那条保证是空的"}`);
  if (!hit) failures += 1;
  console.log("");
}

// ═══════════════════════════════════════════════════════════════════════════
// B. ★★★ 把清单写进**用户项目** ⇒ 84③ / 84③b 必须红（用户的硬约束）
//
//   ★★★★ **本实验当场留下了一份"污染物"，这件事本身就是本判据的证据**：
//     退化版把 `capabilities.json` 写进 `process.cwd()`（= 本项目目录）——
//     而探针**只还原了源码、没清掉它写的文件** ⇒ 项目根多出一个不属于它的文件。
//     那正是用户明确禁止的："**不要把文件混杂到别人项目的文件里面**"。
//   ⇒ 修法两条（都要）：
//     ① 实验后**删掉它可能写下的 `capabilities.json`**（本探针自己收拾干净）；
//     ② 如实报告"发现了污染物并已清理"，不静默。
//   ★ 判据：**一个会污染用户项目的探针，本身就是隐患** —— 与"会改写源码的探针"同一类。
{
  const needle = "function capabilityStorePath() {\n  return path.join(path.dirname(lockStorePath()), CAPABILITY_STORE_FILE);\n}";
  const strayPath = path.join(ROOT, "capabilities.json");
  let red = [];
  try {
    red = experiment(
      "B-manifest-into-user-project",
      (s) =>
        s.replace(
          needle,
          "function capabilityStorePath() {\n  // D196-B: 退化版 —— 混进别人的项目（正是用户明确禁止的）\n  return path.join(process.cwd(), CAPABILITY_STORE_FILE);\n}"
        ),
      [needle]
    );
  } finally {
    // ★ 收拾污染物（无论实验成败都做）
    if (fs.existsSync(strayPath)) {
      fs.rmSync(strayPath, { force: true });
      console.log(`   [清理] 退化的落点把 ${strayPath} 写进了**本项目** ⇒ 已删除` +
        `（★ 这正好证明用户的约束不是多余的）\n`);
    }
  }
  const hit = red.some((l) => reOf("③").test(l)) || red.some((l) => reOf("③b").test(l));
  console.log(`   ⇒ 84③/84③b（清单绝不写进用户项目）见红：${hit ? "✅ 硬约束有牙" : "❌ 那条约束是摆设"}`);
  if (!hit) failures += 1;
  console.log("");
}

// ═══════════════════════════════════════════════════════════════════════════
done = true;
const same = sha(fs.readFileSync(LIB)) === origSha;
console.log("═".repeat(78));
console.log(`源  码：${same ? "✅ 逐字节还原" : "❌ 与备份不一致（立刻手工恢复！）"}`);
console.log(`结  论：${failures === 0 ? "✅ 两个方向**全部见红** ⇒ 情形 84 的断言有牙" : `❌ ${failures} 项未达预期`}`);
process.exit(failures === 0 && same ? 0 : 1);
