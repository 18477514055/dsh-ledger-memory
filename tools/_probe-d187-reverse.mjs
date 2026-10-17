/**
 * ★★★★★ 反向验证（D187）：**让 `ledger_init` 真的去创建 PRINCIPLES.md ⇒ 断言必须见红。**
 *
 * ★ 这里守的是**本项目最硬的那条结构性承诺**（D180）：
 *   「模型**根本没有**写入根本原则的路径」。
 *   `ledger_init` 一旦能创建它，模型就多了一条绕开授权闸门的入口 ——
 *   那不是"少了一道闸门"，是**整条保证失效**。
 *
 * ★ 两个方向：
 *   A. **给 init 加一条写 principles 的路径**（模拟"好心人顺手加个 initialPrinciples"）⇒
 *      期望：77① （文件绝不被创建）**立刻见红**。
 *   B. **把 goals 的创建也拆掉**（模拟"顺手统一成只登记"）⇒
 *      期望：77③ **见红**（goals 本就该能创建 —— 两者权限**刻意不同**）。
 *      ★ B 是**负向对照**：它证明 77① 的"红"确实来自"原则被创建"，
 *        而不是"所有创建都红"这种噪声。
 *
 * ★ 纪律：**还原进 finally + process.on("exit") 兜底**（D183 那次崩在还原之前的教训）。
 *
 * 跑法：node tools/_probe-d187-reverse.mjs
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

/**
 * ★★★★ 尺子修正（这一步我**当场栽过一次，必须留档**）：
 *   第一版这三处判据写的是 `/77⑦\b/`、`/77③\b/`、`/77⑧\b/` —— **全部匹配不到**。
 *   根因：`\b` 的语义是"**`\w`（ASCII 字母数字下划线）与非 `\w` 的交界**"，
 *   而 `⑦ / ③ / ⑧` 是**圈号字符**、**不属于 `\w`**
 *   ⇒ `⑦` 后面**不存在** `\w→非\w` 的边界 ⇒ 正则恒 false。
 *   ★ 实测（我当场跑的）：`/77⑦\b/.test("  FAIL  ★★★★★ 77⑦ x") === false`，
 *     去掉 `\b` 才为 true。
 * ⇒ 正解：**去掉 `\b`**，并且为免 `③` 假命中 `③b`，改成"**圈号后不是 `b`**"。
 *   ★ 这是本项目"尺子错"的第 26 次 —— 而它骗人的方式与 D184 那条一模一样：
 *     **看起来在测，其实永远判假**。
 * ⚠️ 必须定义在**最上面**（我第一次放到了用它的地方后面 ⇒ `Cannot access 'reOf'
 *    before initialization` —— `const` 的 TDZ，又是一个"取法错"）。
 */
const reOf = (circ, caso = "77") => new RegExp(`${caso}${circ}(?!b)`);

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
  const lines = out.split("\n");
  const red = lines.filter((l) => /^\s*FAIL/.test(l)).map((l) => l.trim());
  console.log(`--- ${label}：红 ${red.length} 条 ---`);
  for (const r of red.slice(0, 6)) console.log("   " + r.slice(0, 150));
  for (const x of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + x.trim());
  try {
    fs.writeFileSync(path.join(os.tmpdir(), `d187-reverse-${label}.txt`), out);
  } catch {}
  return red;
}

function experiment(label, mutate) {
  try {
    const next = mutate(origText);
    if (next === origText) {
      console.log(`▶ ${label}：★ 变换没改到东西（锚点漂了）⇒ 跳过，计一次失败`);
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

// ── A. 让 init **真的去创建** PRINCIPLES.md（两种坏法，各自都要见红）──────────
//
//   ★★★ 第一轮我只测了 A1，结果红的是 **77②b** 而不是 77① —— 这不是失败，
//     是**探针自己不够全面**：A1 只覆盖"靠 `initialPrinciples` 参数创建"，
//     而**更根本的坏法**是 A2（只要给了 `principles` 就建文件）。
//     ⇒ 两种都必须测，否则"那条承诺有牙"这句话就只对一半坏法成立。
{
  // ── A1：靠 `initialPrinciples` 创建 ⇒ 77②b 应当红 ──
  const needleA =
    "      // ── ★★★★ 根本原则：**只登记路径，一个字都不写** ────────────────────────";
  const n = origText.split(needleA).length - 1;
  console.log(`▶ A1 锚点命中 ${n} 次（应为 1）`);
  if (n !== 1) {
    console.log("   定位失败 ⇒ 跳过\n");
    failures += 1;
  } else {
    const patchA =
      "      // D187-A1: 退化版 —— 靠 initialPrinciples 顺手把 principles 建出来\n" +
      "      if (principles !== \"\" && typeof args?.initialPrinciples === \"string\" && args.initialPrinciples !== \"\") {\n" +
      "        const pAbsA = path.resolve(root, principles);\n" +
      "        if (!fs.existsSync(pAbsA)) { ensureDir(path.dirname(pAbsA)); fs.writeFileSync(pAbsA, args.initialPrinciples, \"utf8\"); written.push(principles); }\n" +
      "      }\n" +
      "      // ── ★★★★ 根本原则：**只登记路径，一个字都不写** ────────────────────────";
    const red = experiment("A1-init-creates-principles-via-arg", (s) => s.replace(needleA, patchA));
    const hit = red.some((l) => reOf("②b").test(l));
    console.log(`   ⇒ 77②b（强传 initialPrinciples 也不许创建）见红：${hit ? "✅" : "❌ 那条承诺是摆设"}`);
    if (!hit) failures += 1;
    console.log("");
  }

  // ── A2：**只要给了 `principles` 就建文件** ⇒ 77① 应当红（更根本的那种坏法）──
  {
    const needleA2 = "      if (principles !== \"\") {\n        const pAbs = path.resolve(root, principles);";
    const n2 = origText.split(needleA2).length - 1;
    console.log(`▶ A2 锚点命中 ${n2} 次（应为 1）`);
    if (n2 !== 1) {
      console.log("   定位失败 ⇒ 跳过\n");
      failures += 1;
    } else {
      const patchA2 =
        "      if (principles !== \"\") {\n" +
        "        const pAbs = path.resolve(root, principles);\n" +
        "        // D187-A2: 退化版 —— 登记时顺手创建（这正是要防的根本坏法）\n" +
        "        if (!fs.existsSync(pAbs)) { ensureDir(path.dirname(pAbs)); fs.writeFileSync(pAbs, \"# 原则\\n\", \"utf8\"); written.push(principles); }";
      const red = experiment("A2-init-creates-principles-always", (s) => s.replace(needleA2, patchA2));
      const hit = red.some((l) => reOf("①").test(l));
      console.log(`   ⇒ 77①（登记 principles 后文件绝不被创建）见红：${hit ? "✅" : "❌ 那条承诺是摆设"}`);
      if (!hit) failures += 1;
      console.log("");
    }
  }
}

{
  const needleB = "      if (goals !== \"\" && typeof args?.initialGoals === \"string\" && args.initialGoals !== \"\") {";
  const n = origText.split(needleB).length - 1;
  console.log(`▶ B 锚点命中 ${n} 次（应为 1）`);
  if (n !== 1) {
    console.log("   定位失败 ⇒ 跳过\n");
    failures += 1;
  } else {
    const red = experiment("B-goals-not-created", (s) =>
      s.replace(needleB, "      if (false && goals !== \"\" && typeof args?.initialGoals === \"string\") { /* D187-B */")
    );
    const hit = red.some((l) => reOf("③").test(l));
    console.log(`   ⇒ 77③（goals 应可创建）见红：${hit ? "✅ 负向对照成立（A 的红不是噪声）" : "❌"}`);
    if (!hit) failures += 1;
    console.log("");
  }
}

// ── C. D188 之一：把 `gitignore` 退回无条件赋值 ⇒ 77⑦ 应当红 ────────────────
{
  const needleC = "        ...(ignoreResult === undefined ? {} : { gitignore: ignoreResult }),";
  const n = origText.split(needleC).length - 1;
  console.log(`▶ C 锚点命中 ${n} 次（应为 1）`);
  if (n !== 1) {
    console.log("   定位失败 ⇒ 跳过\n");
    failures += 1;
  } else {
    const red = experiment("C-gitignore-undefined", (s) =>
      s.replace(needleC, "        gitignore: ignoreResult, /* D188-C: 退回无条件赋值 */")
    );
    const hit = red.some((l) => reOf("⑦").test(l));
    console.log(`   ⇒ 77⑦（返回值不许有 undefined）见红：${hit ? "✅" : "❌"}`);
    if (!hit) failures += 1;
    console.log("");
  }
}

// ── D. D188 之二：把 maxActiveLines 退回无条件覆盖 ⇒ 77⑧ 应当红 ──────────────
{
  const needleD =
    "        Number.isFinite(args?.maxActiveLines) && args.maxActiveLines > 0\n" +
    "          ? Math.floor(args.maxActiveLines)\n" +
    "          : Number.isFinite(prevForLimit.maxActiveLines) && prevForLimit.maxActiveLines > 0\n" +
    "            ? Math.floor(prevForLimit.maxActiveLines)\n" +
    "            : currentSettings().maxActiveLines;";
  const n = origText.split(needleD).length - 1;
  console.log(`▶ D 锚点命中 ${n} 次（应为 1）`);
  if (n !== 1) {
    console.log("   定位失败（锚点漂了）⇒ 跳过\n");
    failures += 1;
  } else {
    const red = experiment("D-maxlines-overwritten", (s) =>
      s.replace(
        needleD,
        "        Number.isFinite(args?.maxActiveLines) && args.maxActiveLines > 0\n" +
          "          ? Math.floor(args.maxActiveLines)\n" +
          "          : currentSettings().maxActiveLines; /* D188-D: 退回无条件覆盖 */"
      )
    );
    const hit = red.some((l) => reOf("⑧").test(l));
    console.log(`   ⇒ 77⑧（重复 init 不许改已有上限）见红：${hit ? "✅" : "❌"}`);
    if (!hit) failures += 1;
    console.log("");
  }
}

// ── E. D189：把 `writePrinciples` 的"缺 relPath 就回落"拆掉 ⇒ 78④ 应当红 ──────
{
  const needleE = "  if (relPath === undefined) {\n    relPath = DEFAULT_PRINCIPLES_NAME;";
  const n = origText.split(needleE).length - 1;
  console.log(`▶ E 锚点命中 ${n} 次（应为 1）`);
  if (n !== 1) {
    console.log("   定位失败 ⇒ 跳过\n");
    failures += 1;
  } else {
    // ★ 退化版：直接 return（就是修之前的"拦错人"行为）。
    const red = experiment("E-principles-no-fallback", (s) =>
      s.replace(
        needleE,
        "  if (relPath === undefined) {\n    return { ok: false, reason: \"D189-E: 退回「文件不存在就拒」\", refused: true };\n  }\n  if (false) {\n    relPath = DEFAULT_PRINCIPLES_NAME;"
      )
    );
    const hit = red.some((l) => reOf("④", "78").test(l));
    console.log(`   ⇒ 78④（带授权写入能建立 PRINCIPLES.md）见红：${hit ? "✅" : "❌"}`);
    if (!hit) failures += 1;
    console.log("");
  }
}

// ── F. D189 双保险：把**内层**（writePrinciples 里那条）拆掉 ⇒ 78③ **不该**红 ──
//
//   ★★★ 这一条的结果**一开始被我误读成"修复没牙"**，查清后是**另一回事**，必须留档：
//     `ledger_write` 里**另有一条独立的`authorizedBy` 闸门**（`lib/index.js:11810`），
//     而 78③ 走的是**那条** ⇒ 拆掉内层那条，78③ **仍然绿是对的**。
//   ⇒ 这是**有意为之的纵深防御**（两道闸门，任一道都能拦住"无授权写入"），
//     **不是冗余**、也不是"没牙"。
//   ★ 正解：判据应当断言**"两道闸门至少有一道在"**，而不是"拆掉某一特定那道就红"。
//     ⇒ 本情形改成：把**两条**都拆掉，78③ 才应当红（那才证明这条承诺真的被守住了）。
{
  const needleF1 = "  if (relPath === undefined && String(authorizedBy ?? \"\").trim() === \"\") {";
  const needleF2 =
    "    const authorizedBy = typeof args?.authorizedBy === \"string\" ? args.authorizedBy.trim() : \"\";\n" +
    "    if (authorizedBy === \"\") {";
  const n1 = origText.split(needleF1).length - 1;
  const n2 = origText.split(needleF2).length - 1;
  console.log(`▶ F 锚点命中 内层=${n1} 外层=${n2}（两者都应为 1）`);
  if (n1 !== 1 || n2 !== 1) {
    console.log("   定位失败 ⇒ 跳过\n");
    failures += 1;
  } else {
    const red = experiment("F-both-guards-removed", (s) =>
      s
        .replace(needleF1, "  if (false && String(authorizedBy ?? \"\").trim() === \"\") { /* D189-F1 */")
        .replace(needleF2, "    const authorizedBy = typeof args?.authorizedBy === \"string\" ? args.authorizedBy.trim() : \"\";\n    if (false && authorizedBy === \"\") { /* D189-F2 */")
    );
    const hit = red.some((l) => reOf("③", "78").test(l));
    console.log(
      `   ⇒ 78③（无授权仍必须被拒）见红：${hit ? "✅" : "❌"}　` +
        `★ 两道闸门全拆才红 ⇒ 证明"无授权不许写"确实被守住（纵深防御）`
    );
    if (!hit) failures += 1;
    console.log("");
  }
}

fs.writeFileSync(LIB, original);
done = true;
const restored = sha(fs.readFileSync(LIB));
console.log(`③ 已还原。sha256=${restored}`);
console.log(`   ${restored === origSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌（必须手工处理）"}`);
if (restored !== origSha) failures += 1;

console.log(
  failures === 0
    ? "\n⇒ ★★★ 结论：D187 的两条权限区分**都有牙** —— " +
        "给 init 加写 principles 的路径 ⇒ 77① 见红；拆掉 goals 的创建 ⇒ 77③ 见红（负向对照）✅"
    : `\n⇒ ★★ 有 ${failures} 处没通过，必须人工核对 ❌`
);
process.exit(failures === 0 ? 0 : 1);
