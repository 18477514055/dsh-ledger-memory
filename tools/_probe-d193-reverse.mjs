/**
 * ★★★★★ 反向验证（D193）：**把新接的那条路逐处摘掉 ⇒ 情形 81 的断言必须见红。**
 *
 * ★ 纪律 10：**反向验证必须摘到"能看见红"为止** —— 摘一处不红，要么断言太弱、
 *   要么修复冗余，两种都要查清。
 *
 * ★ 本探针守的是 D193 的**三条**独立保证（各自必须能被单独摘红）：
 *   A. **e2e**：`approve` 真的走 `applyPrincipleProposal` 落盘 ⇒ 摘掉那次调用 ⇒ 81①c 红。
 *   B. **确认不是摆设**：只有点了"写入"才写 ⇒ 把判据改成"永远算批准" ⇒ 81②a 红。
 *   C. ★★★ **批准只在命令层**：工具层绝不能有批准入口 ⇒
 *      给工具表**加一个** `ledger_approve` ⇒ 81③ 红。
 *      ★ 这是**最重的一条**：模型若能自己批准自己，整条守卫归零。
 *   D. **文案不再指向死路** ⇒ 把 propose 的描述改回
 *      "you MUST call ledger_checkpoint … to authorize" ⇒ 81④ 红。
 *
 * ★★ 教训沿用（D183）：**还原进 finally + process.on("exit") 兜底** ——
 *   探针崩在还原之前会把源码留在退化版。
 *
 * 跑法：node tools/_probe-d193-reverse.mjs
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

/** 判据正则：圈号后不是 `b`（防 `①` 假命中 `①b`）。★ `\b` 在圈号后恒 false（第 26 次尺子错的教训）。 */
const reOf = (circ) => new RegExp(`81${circ}(?!b)`);

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
  for (const r of red.slice(0, 6)) console.log("   " + r.slice(0, 150));
  for (const x of out.split("\n").filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + x.trim());
  return red;
}

function experiment(label, mutate, needles) {
  // ★ 先证"锚点真的命中了"（否则会静默地"测了个没改动的源码"⇒ 假绿）。
  for (const nd of needles) {
    const n = origText.split(nd).length - 1;
    if (n !== 1) {
      console.log(`▶ ${label}：★ 锚点命中 ${n} 次（应为 1）⇒ 定位失败，计一次失败\n   「${nd.slice(0, 70)}…」`);
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
// A. 摘掉"approve 真的去写盘"那一步 ⇒ 81①c 必须红
{
  const needle = "      const r = applyPrincipleProposal(root, state, sid, p.id, \"user-command-approve\", invocation);";
  const red = experiment(
    "A-approve-does-not-write",
    (s) => s.replace(needle, "      const r = { ok: true, relPath: \"(退化版：不写盘)\", mode: \"append\", lines: 0 }; /* D193-A */"),
    [needle]
  );
  const hit = red.some((l) => reOf("①c").test(l));
  console.log(`   ⇒ 81①c（approve ⇒ 那段原则真的落进文件）见红：${hit ? "✅" : "❌ 那条承诺是摆设"}`);
  if (!hit) failures += 1;
  console.log("");
}

// ═══════════════════════════════════════════════════════════════════════════
// B. 把"必须点写入"改成"永远算批准" ⇒ 81②a 必须红（确认成了摆设）
{
  const needle = "      if (!picked.includes(\"写入\")) {";
  const red = experiment(
    "B-confirm-is-a-rubber-stamp",
    (s) => s.replace(needle, "      if (false) { /* D193-B: 退化版 —— 取消也照写 */"),
    [needle]
  );
  const hit = red.some((l) => reOf("②a").test(l));
  console.log(`   ⇒ 81②a（点「取消」⇒ 一个字节都不写）见红：${hit ? "✅" : "❌"}`);
  if (!hit) failures += 1;
  console.log("");
}

// ═══════════════════════════════════════════════════════════════════════════
// C. ★★★ 给工具层加一个"批准"入口 ⇒ 81③ 必须红
//
//   ★ 这是 D193 的**地基**：模型若能自己批准自己的提议，守卫当场归零。
//   ★ 故意做成"最像好心的那种坏法" —— 加一个语义很好的工具名。
{
  const needle = "    [\"ledger_lessons\", defineLessonsTool],";
  const red = experiment(
    "C-approval-tool-appears",
    (s) =>
      s.replace(
        needle,
        "    [\"ledger_approve_principle\", () => ({ name: \"ledger_approve_principle\", description: \"D193-C 退化版\", parameters: { type: \"object\", properties: {} }, output: { schema: OK_SCHEMA, render: renderResult }, async execute() { return { ok: true }; } })],\n" +
          needle
      ),
    [needle]
  );
  const hit = red.some((l) => reOf("③").test(l));
  console.log(`   ⇒ 81③（工具表里不许有批准入口）见红：${hit ? "✅ 地基有牙" : "❌ 那条保证是摆设"}`);
  if (!hit) failures += 1;
  console.log("");
}

// ═══════════════════════════════════════════════════════════════════════════
// D. 把 propose 的文案改回"去调 ledger_checkpoint" ⇒ 81④ 必须红
//
//   ★ 守的是"文案不许再指向一个不存在的机制"（D193 的根因之一）。
{
  // ★★ 尺子修正（我第一版在这里**自己写错了一个字符**，记下来）：
  //   锚点原来写的是 `"...\"\\`/ledger principles approve <id>\\` ..."` ——
  //   在**双引号字符串**里 `\\`` 解析成 **反斜杠 + 反引号**两个字符，
  //   而源码里那个位置是**裸反引号**（模板串的定界符就在字符串里，不需要转义）
  //   ⇒ 锚点命中 0 次 ⇒ 探针报"定位失败"。
  //   ★ 这正是纪律 9 那类错（"看着最硬，却最容易凭印象编"）的**变体**：
  //     我凭印象给反引号加了转义 ⇒ 字面串跟源码差一个字符 ⇒ 差一个字符就查不出来。
  //   ⇒ 正解：**反引号在双引号字符串里直接写**（下面这一行现在是逐字节照抄源码的）。
  const needle = "      \"`/ledger principles approve <id>` (to approve; approving needs no id to take the latest). \" +";
  const red = experiment(
    "D-text-points-back-to-dead-path",
    (s) =>
      s.replace(
        needle,
        "      \"After calling this, you MUST call `\" + CHECKPOINT_TOOL + \"` so the user can authorize the proposal. \" + /* D193-D 退化版 */"
      ),
    [needle]
  );
  const hit = red.some((l) => reOf("④").test(l));
  console.log(`   ⇒ 81④（现行文案不再指引去调 checkpoint 批准）见红：${hit ? "✅" : "❌"}`);
  if (!hit) failures += 1;
  console.log("");
}

// ═══════════════════════════════════════════════════════════════════════════
done = true;
const same = sha(fs.readFileSync(LIB)) === origSha;
console.log("═".repeat(78));
console.log(`源  码：${same ? "✅ 逐字节还原" : "❌ 与备份不一致（立刻手工恢复！）"}`);
console.log(`结  论：${failures === 0 ? "✅ 四个方向**全部见红** ⇒ 情形 81 的断言有牙" : `❌ ${failures} 项未达预期`}`);
process.exit(failures === 0 && same ? 0 : 1);
