/**
 * ★★★★★ 反向验证（D194）：**把"经验"/"教训"的两条新保证各摘一处 ⇒ 情形 82 必须见红。**
 *
 * ★ 纪律 10：反向验证必须摘到**能看见红**为止。
 *
 * ★ 本探针守两条独立保证：
 *   A. **经验必须有出处**（`source` 必填）⇒ 摘掉那道检查 ⇒ 82① 红。
 *      ★ 这条最重：没有出处的经验会被后人当成"已查明的机制"照做、且**不验证**。
 *   B. **读得懂旧格式**（`## 教训 L1 · …`）⇒ 让解析器只认新格式 ⇒ 82④ 红。
 *      ★ 这条守的是"改口径不许让存量条目消失"。
 *
 * ★ 还原进 finally + process.on("exit") 兜底（D183 的教训）。
 * ★ 锚点**整行照抄源码**（D193 那次我凭印象手打，多写一个反斜杠 ⇒ 锚点命中 0 次）。
 *
 * 跑法：node tools/_probe-d194-reverse.mjs
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

/** 判据正则：圈号后不是 `b`（`\b` 在圈号后恒 false —— L1 的教训）。 */
const reOf = (circ) => new RegExp(`82${circ}(?!b)`);

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
// A. 摘掉"经验必须有出处"那道检查 ⇒ 82① 必须红
{
  const needle = '        if (type === "经验" && source === "") {';
  const red = experiment(
    "A-experience-needs-no-source",
    (s) => s.replace(needle, '        if (false) { /* D194-A: 退化版 —— 经验不要出处也收 */'),
    [needle]
  );
  const hit = red.some((l) => reOf("①").test(l));
  console.log(`   ⇒ 82①（经验不给 source ⇒ 被拒）见红：${hit ? "✅" : "❌ 那条保证是摆设"}`);
  if (!hit) failures += 1;
  console.log("");
}

// ═══════════════════════════════════════════════════════════════════════════
// B. 让解析器**只认新格式**（丢掉 `教训` 那半个 alternation）⇒ 82④ 必须红
//
//   ★ 模拟"改口径时忘了兼容存量"这个最常见的错法。
//   ⚠️ 注意锚点要**整行照抄**（含行首缩进与结尾）。
{
  const needle = "  const re = /^##\\s*(经验|教训)\\s+(\\S+)\\s*(?:[·|]\\s*([^\\n]*))?$/gm;";
  const red = experiment(
    "B-parser-drops-old-format",
    (s) =>
      s.replace(
        needle,
        "  const re = /^##\\s*(?:经验)\\s+(\\S+)\\s*(?:[·|]\\s*([^\\n]*))?$/gm; /* D194-B: 退化版 —— 只认「经验」，旧「教训」读不出来 */"
      ),
    [needle]
  );
  const hit = red.some((l) => reOf("④").test(l));
  console.log(`   ⇒ 82④（老格式仍被读出来）见红：${hit ? "✅" : "❌ 兼容性那条是摆设"}`);
  if (!hit) failures += 1;
  console.log("");
}

// ═══════════════════════════════════════════════════════════════════════════
done = true;
const same = sha(fs.readFileSync(LIB)) === origSha;
console.log("═".repeat(78));
console.log(`源  码：${same ? "✅ 逐字节还原" : "❌ 与备份不一致（立刻手工恢复！）"}`);
console.log(`结  论：${failures === 0 ? "✅ 两个方向**全部见红** ⇒ 情形 82 的断言有牙" : `❌ ${failures} 项未达预期`}`);
process.exit(failures === 0 && same ? 0 : 1);
