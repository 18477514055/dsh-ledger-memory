// ═══════════════════════════════════════════════════════════════════════════
// D216 · 问题②的反向验证：**义务提醒的硬门措辞**（63⑧）真的守得住吗？
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么必须做（本项目纪律 10）：
//   **反向验证必须摘到"能看见红"为止** —— 摘一处不红，要么断言太弱、要么修复冗余。
//
// ★ 摘除点设计（每一处都要有明确期望）：
//    A. 把硬门那一支**整段删掉**（只留 `else`）⇒ 63⑧ 必须红（硬门分支消失）。
//    B. 把 `else` 那一支的假话**挪到硬门分支里**（两句并存于硬门）⇒ 63⑧ 必须红。
//    C. **把 `else` 那一支的假话连同 `else` 一起删掉** ⇒ 这是**合法**改法吗？
//       ★ 不 —— 删掉 `else` 会让"硬门关"时无话可说（回退路不完整），但 63⑧ 只判"假话在硬门之后"，
//         而"假话不存在"时 `iFalse = -1 > iHard(false)` ⇒ **会红**。⇒ 期望**红**（正是它该有的保守）。
//
// 用法：node tools/_probe-d216-reverse.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const SRC = process.cwd();
const LIB = path.join(SRC, "lib", "index.js");
const SELFTEST = path.join(SRC, "tools", "selftest.mjs");
const original = fs.readFileSync(LIB, "utf8");
const sha = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
};
const origHash = sha(original);

/** 跑自检，返回 63⑧ 是 PASS 还是 FAIL（**必须确认自检真跑了** —— L34）。 */
function runSelftest() {
  // ★★★ 夹具坑（我当场踩的，纪律 6）：**自检"见红"时退出码是 1** ⇒ `execFileSync` 会
  //   **抛异常**，而抛出的对象里才有 `stdout`。第一版没接 ⇒ 三个摘除点全报"Command failed"，
  //   看起来像"跑挂了"，其实**正是我们要的红**（差一点把夹具故障当成结论）。
  let out = "";
  try {
    out = execFileSync(process.execPath, [SELFTEST], {
      cwd: SRC,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    out = String(e.stdout ?? "");
    if (out === "") {
      // ★ 真正的夹具故障：**连输出都没有**（多半是语法错 —— 那必须与"断言见红"分开报）
      throw Object.assign(new Error(String(e.stderr ?? e.message).slice(0, 200)), { noOutput: true });
    }
  }
  const total = /通过 (\d+) 项，失败 (\d+) 项/.exec(out);
  if (total === null) throw Object.assign(new Error("自检没有报出总数 ⇒ 它根本没跑起来"), { noOutput: true });
  const lines = out.split("\n").filter((l) => l.includes("63⑧"));
  return { pass: lines.some((l) => l.includes("PASS")), fail: lines.some((l) => l.includes("FAIL")), summary: total[0] };
}

const results = [];
function trial(name, mutate, expectRed) {
  let mutated;
  try {
    mutated = mutate(original);
  } catch (e) {
    results.push({ name, ok: false, detail: `变异体构造失败：${e.message}` });
    console.log(`❌ ${name} —— 变异体构造失败：${e.message}`);
    return;
  }
  if (mutated === original) {
    results.push({ name, ok: false, detail: "变异体与原文相同（摘除点没匹配上）" });
    console.log(`❌ ${name} —— 变异体与原文相同（摘除点没匹配上）`);
    return;
  }
  // ★★★ 先**单独确认变异体能解析**（纪律 6：夹具没走通时，绝不能把"夹具故障"
  //   当成"被测对象的问题"）。用 `--check` 只做语法检查，不执行。
  const tmp = path.join(os.tmpdir(), `d216mut-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(tmp, mutated, "utf8");
  try {
    execFileSync(process.execPath, ["--check", tmp], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    results.push({ name, ok: false, detail: `**夹具故障**：变异体语法不合法，自检根本跑不起来 —— ${String(e.stderr ?? e.message).slice(0, 140)}` });
    console.log(`❌ ${name} —— 夹具故障：变异体语法不合法（**这不是"断言见红"**）`);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 删不掉无所谓 */
    }
    return;
  }
  try {
    fs.writeFileSync(LIB, mutated, "utf8");
    const r = runSelftest();
    const wentRed = r.fail;
    const ok = wentRed === expectRed;
    results.push({ name, ok, detail: `63⑧ ${r.fail ? "红" : "绿"}（期望${expectRed ? "红" : "绿"}）· ${r.summary}` });
    console.log(`${ok ? "✅" : "❌"} ${name} —— 63⑧ ${r.fail ? "红" : "绿"}（期望${expectRed ? "红" : "绿"}）· ${r.summary}`);
  } catch (e) {
    const msg = String(e.message);
    // ★ 两条要**分开报**（纪律 6）：`noOutput` = **夹具故障**（多半语法错，自检没跑起来）；
    //   其余才是"跑挂了"。**绝不能把夹具故障算成"断言见红"**。
    const fixture = e.noOutput === true || /SyntaxError|Unexpected|missing \) /.test(msg);
    results.push({
      name,
      ok: false,
      detail: fixture ? `**夹具故障**（自检没跑起来）：${msg.slice(0, 140)}` : msg.slice(0, 200),
    });
    console.log(`❌ ${name} —— ${fixture ? "夹具故障（不是断言见红）" : "跑挂了"}：${msg.slice(0, 160)}`);
  } finally {
    fs.writeFileSync(LIB, original, "utf8");
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件删不掉无所谓 */
    }
  }
}

const HARD_BLOCK =
  '(hardMaintenanceGateOn()\n' +
  '                ? "★★★ **【硬门】这不是提醒，是压缩的前提条件：不做完，回合末那次压缩就不会发生。**\\n" +';
// ★ else 那一支的**首行**（用于定位三元的分支边界）。
const ELSE_HEAD = '                : "★ 它**不拦任何东西**：做完这些下一步照常；**没做也不会卡住压缩**。\\n");';

/** 三元表达式的完整结尾（`);` 之后紧跟 `text = text === undefined ? …`）。 */
const TAIL_ANCHOR = "text = text === undefined ? line.trimStart()";

// ── A. 硬门那一支整段删掉 ⇒ 只剩 else（语义上"硬门不再有专属文案"）─────────
//
//   ★ 怎么改才**语法合法**：`(cond ? A : B)` ⇒ 删掉 `cond ? A` 只留 `(B)`。
//     即把 `(hardMaintenanceGateOn()\n ? "…"` 替换成 `(`，让剩下的是 `(else的那一串)`。
//     ★ 注意 else 那一支**自己就以 `"…"` 结尾**，所以 `(` + `"…"` + `);` 是合法的。
trial(
  "A 摘除：硬门分支整段消失（只剩 else）",
  (s) => {
    const i = s.indexOf(HARD_BLOCK);
    if (i < 0) throw new Error("找不到硬门分支锚点");
    const j = s.indexOf(ELSE_HEAD, i);
    if (j < 0) throw new Error("找不到 else 首行锚点");
    // 保留 `(`，跳到 else 的字面量起点（`                : "` 之后）
    const litStart = s.indexOf('"', j);
    return s.slice(0, i) + "(" + s.slice(litStart);
  },
  true
);

// ── B. 把假话挪进硬门那一支（两句并存 ⇒ 自相矛盾复原）──────────────────────
trial(
  "B 把「不拦任何东西」塞进硬门分支（自相矛盾复原）",
  (s) => {
    const i = s.indexOf(HARD_BLOCK);
    if (i < 0) throw new Error("找不到硬门分支锚点");
    // 在硬门真值分支里插一句假话：把 `? "…\n" +` 换成 `? "…\n" + "★ 它**不拦任何东西**…\n" +`
    const hardFirst = s.indexOf('"', i);
    const hardLineEnd = s.indexOf("\\n\" +", hardFirst);
    if (hardLineEnd < 0) throw new Error("找不到硬门分支首行的结束");
    const insertAt = hardLineEnd + '\\n" +'.length;
    return (
      s.slice(0, insertAt) +
      ' "★ 它**不拦任何东西**：做完这些下一步照常；**没做也不会卡住压缩**。\\n" +' +
      s.slice(insertAt)
    );
  },
  true
);

// ── C. 把 else 那一支（回退路）整个删掉 ⇒ 硬门关时无文案 ────────────────────
//
//   ★ 语法合法改法：`(A ? X : Y)` ⇒ `(A ? X : "")`（保留三元，只清空 else）。
//     ★ 这样"假话字面量"不再存在 ⇒ `iFalse === -1` ⇒ 断言**必须红**
//       （63⑧ 的判据要求那句字面量**存在且在硬门之后** —— 这是刻意的保守：
//        回退路被清空同样是一种"措辞分叉被破坏"）。
trial(
  "C 摘除：else 分支（回退路）整段消失",
  (s) => {
    const j = s.indexOf(ELSE_HEAD);
    if (j < 0) throw new Error("找不到 else 首行锚点");
    return s.slice(0, j) + '                : "");' + s.slice(j + ELSE_HEAD.length);
  },
  true
);

console.log("");
// ★★ 还原必须**逐字节**回到原文（否则后续工作在一个被我改过的文件上）
const back = fs.readFileSync(LIB, "utf8");
if (sha(back) !== origHash) {
  console.log("❌❌ 严重：还原后哈希与原文不符！已在最后强制还原。");
  fs.writeFileSync(LIB, original, "utf8");
  results.push({ name: "还原完整性", ok: false, detail: "哈希不符" });
} else {
  console.log("✅ 还原完整性：lib/index.js 逐字节回到原文");
  results.push({ name: "还原完整性", ok: true, detail: sha(back) });
}

const bad = results.filter((r) => !r.ok);
console.log("");
console.log(`结果：通过 ${results.length - bad.length} / ${results.length}`);
if (bad.length > 0) {
  for (const b of bad) console.log(`  ❌ ${b.name} —— ${b.detail}`);
  process.exitCode = 1;
} else {
  console.log("✅ 63⑧ 不是摆设断言：三个摘除点**全部见红**。");
}
