/**
 * 反向验证（D210）—— **把修复逐处摘掉，看自检到底红不红**。
 *
 * ★★★ 项目纪律第 10 条：**反向验证必须摘到"能看见红"为止** ——
 *   摘一处不红，要么断言太弱、要么修复冗余，两种都要查清。
 *
 * ★★ 更要紧的是纪律 **L34**（我自己踩过的）：
 *   反向验证脚本**自己写坏了**（删表达式留裸 `;` / 整行删致 `+` 悬空 ⇒ 语法坏）
 *   ⇒ 自检**崩了**，而"崩了"与"全绿"在 FAIL 计数上**完全一样**。
 *   ⇒ 所以下面每一轮都**断言自检真的跑完了**（解析「通过 N 项」；
 *     若 N 解析不出来 ⇒ 判"脚本坏了"，**不是**"没红"）。
 *
 * 跑法：node tools/_probe-d210-reverse.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "lib", "index.js");
const SELFTEST = path.join(HERE, "selftest.mjs");

const backup = fs.readFileSync(LIB, "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "probe-d210-rev-"));

/**
 * 跑一次自检，**如实回报**结果。
 * ★ 关键：`passN === -1` 意味着**没解析到「通过 N 项」** ⇒ 自检没跑完
 *   （多半是脚本把源码改坏了）⇒ 这时**不能**说"没红"，要说"脚本坏了"。
 */
function runSelftest(label) {
  const r = spawnSync(process.execPath, [SELFTEST], {
    cwd: path.join(HERE, ".."),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const m = /通过\s+(\d+)\s+项，失败\s+(\d+)\s+项/.exec(out);
  const passN = m === null ? -1 : Number(m[1]);
  const failN = m === null ? -1 : Number(m[2]);
  const failed = out
    .split("\n")
    .filter((l) => /^\s+FAIL\s/.test(l))
    .map((l) => l.trim());
  return { passN, failN, failed, ran: m !== null, label };
}

/** 把 `old` 换成 `new`；换不上就**当场报错**（绝不静默跳过）。 */
function patchOne(label, oldStr, newStr) {
  if (!backup.includes(oldStr)) {
    console.log(`  ✗ 摘除点找不到 —— 反向验证**无效**（脚本该修）：${label}`);
    return false;
  }
  fs.writeFileSync(LIB, backup.replace(oldStr, newStr), "utf8");
  return true;
}

let allOk = true;
function check(label, { mustRed = true } = {}) {
  const r = runSelftest(label);
  if (!r.ran) {
    console.log(`  ✗✗ **自检没跑完**（脚本把它改坏了）—— 这不是"没红"，是**无效验证**`);
    console.log(`      通过=${r.passN} 失败=${r.failN}`);
    allOk = false;
    return r;
  }
  const red = r.failN > 0;
  const verdict = mustRed ? (red ? "✅ 见红" : "★★ 没红 ⇒ 断言太弱或修复冗余") : red ? "★★ 不该红却红了" : "✅ 没红";
  console.log(`  ${verdict} ｜ 通过=${r.passN} 失败=${r.failN}`);
  if (red) console.log(`      红的：${r.failed.slice(0, 4).join(" ｜ ")}`);
  if (mustRed && !red) allOk = false;
  return r;
}

console.log("════════ D210 反向验证：摘掉修复，自检该红吗？ ════════\n");

// ── 基线：没改任何东西 ⇒ 必须全绿（否则后面看到的红分不清是谁造成的）──────
console.log("【基线】不改任何东西：");
check("baseline", { mustRed: false });

// ── 摘除点 ①：**指纹里的设置那一项**（本轮的真发现）──────────────────────────
//   ★ 这是最要紧的一处：摘掉它 ⇒ 89⑬② / ⑬③ 必须红。
console.log("\n【摘除点 ①】指纹不再吃「设置」（= 退回旧代码的行为）：");
if (patchOne("fp-settings", "const settingsTag = hashTextOf(JSON.stringify(settingsValuesOf(info)));", "const settingsTag = \"\";")) {
  check("no-settings-in-fingerprint");
}

// ── 摘除点 ②：**变更行不进快照**（渲染了但没接上）──────────────────────────
console.log("\n【摘除点 ②】变更行不再拼进快照（= 渲染了却没接上）：");
if (patchOne("change-line", "    changeLine +\n", "")) {
  check("no-change-line");
}

// ── 摘除点 ③：**渲染变成"会推进基线"**（退回我第一版的写法）──────────────────
//   ★ 这一处摘掉后，89⑬⑦（渲染纯读）与 ⑬⑧f 必须红。
console.log("\n【摘除点 ③】渲染顺手推进基线（= 退回「渲染即推进」的坏写法）：");
if (
  patchOne(
    "render-advances",
    "  const changeLine = renderSettingsChangeLine(settingsChangesOf(info));",
    "  const changeLine = renderSettingsChangeLine(settingsChangesOf(info));\n  commitSettingsBaseline(info);"
  )
) {
  check("render-advances-baseline");
}

// ── 摘除点 ④：**首轮不标的判据**摘掉（首轮也报"刚改过"）────────────────────
//   ★★★ 我第一版这里只把**注释**删了（`... return []; // ★ 首轮不标` → `... return [];`）
//     ⇒ 那是**假摘除**：代码行为一个字没变 ⇒ 当然"见红"个鬼 —— 它**报的是探针计数那条**
//       （每次都响的那条），我差点把它当成"89⑬① 被验证了"。
//     ★ 这正是纪律第 10 条说的"摘一处不红"，必须查清是**断言太弱**还是**修复冗余**；
//       这里两种都不是，是**我摘错了地方**（第三种：验证脚本自己无效）。
//   ⇒ 改成**真摘**：让 `prev === undefined` 时**照样**进比对循环
//     （于是首轮会把"从无到有"当成"变更"报出来）⇒ 89⑬① 必须红。
console.log("\n【摘除点 ④】摘掉「首轮不标」（首轮就报刚改过）：");
if (
  patchOne(
    "first-turn",
    "  if (prev === undefined) return []; // ★ 首轮不标（初识不是变更）\n  const out = [];\n  for (const key of SETTING_KEYS) {\n    if (prev[key] !== cur[key]) out.push({ key, from: prev[key] ?? \"(未设)\", to: cur[key] ?? \"(未设)\" });\n  }",
    "  const out = [];\n  for (const key of SETTING_KEYS) {\n    if (prev === undefined || prev[key] !== cur[key]) out.push({ key, from: prev?.[key] ?? \"(未设)\", to: cur[key] ?? \"(未设)\" });\n  }"
  )
) {
  check("first-turn-guard-removed");
}

// ── 摘除点 ⑤：**值的渲染**退回成裸 JSON（人读性丢失）──────────────────────
console.log("\n【摘除点 ⑤】值的渲染退回「裸 JSON.stringify」（不再是人读文字）：");
if (
  patchOne(
    "value-text",
    "  const spec = specOf(key);\n  if (spec?.kind === \"boolean\") return v === true ? \"开\" : v === false ? \"关\" : String(v);",
    "  return String(v);\n  // eslint-disable-next-line no-unreachable\n  const spec = specOf(key);\n  if (spec?.kind === \"boolean\") return v === true ? \"开\" : v === false ? \"关\" : String(v);"
  )
) {
  check("raw-value-text");
}

// ── 恢复现场 ────────────────────────────────────────────────────────────────
fs.writeFileSync(LIB, backup, "utf8");
console.log("\n【恢复】已把 lib/index.js 还原。");
const back = runSelftest("restored");
console.log(`  还原后：通过=${back.passN} 失败=${back.failN} ⇒ ${back.ran && back.failN === 0 ? "✅ 干净" : "★★ 没还原干净！"}`);
if (!back.ran || back.failN !== 0) allOk = false;

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${allOk ? "★★★ 反向验证通过：每一处修复都摘得见红。" : "★★ 反向验证**有问题**，见上面。"}`);
process.exitCode = allOk ? 0 : 1;
