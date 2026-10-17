/**
 * ★★★★★ 反向验证（D200）：**情形 86 那条守卫，真的看得见红吗？**
 *
 * ★ 为什么非做不可（本机纪律 10）：*"反向验证必须摘到能看见红为止"* ——
 *   一个恒绿的守卫**证明不了任何东西**。而本轮**第一版守卫恰恰就是恒绿的**：
 *   它找"汉字紧挨 `\b`"，而真 bug 的形状是 `(?:决策|决定|D\d+)\b` —— `\b` 前面是 **`)`**
 *   ⇒ **在坏版本上照样报 0**。★ 是这条反向验证把它抓出来的。
 *
 * ★ 做法：把 `lib/index.js` 里那条正则**真的退回坏版本**，跑情形 86，断言它**必须红**；
 *   再还原、断言**必须绿**。全程不碰别的东西。
 * ★ 安全：① 先备份原文件到内存；② `finally` 里**无条件还原**；③ 还原后**校验**（好版特征在）。
 *
 * 跑法：node tools/_probe-d200-wordb-guard-reverse.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib", "index.js");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
let bad = 0;
const check = (ok, label, detail) => {
  if (!ok) bad++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
};

const GOOD = "re: /^#{2,4}\\s*(?:决策|决定|D\\d+(?![\\dA-Za-z]))/m";
const BAD = "re: /^#{2,4}\\s*(?:决策|决定|D\\d+)\\b/m";

/** 跑一次自检，返回 { ok, section86Fails }。 */
function runSelftest() {
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, "tools", "selftest.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // 自检红时 exit 1 ⇒ 输出在 stdout 上（仍是我们要读的）
    out = String(e?.stdout ?? "");
  }
  // ★ 只挑**情形 86 自己那几行**的 FAIL —— 别的口径断言红不红与本条无关。
  const fails = out
    .split("\n")
    .filter((l) => l.includes("FAIL") && /\b86[①②③④]/.test(l))
    .map((l) => l.trim());
  return { allGreen: /通过 \d+ 项，失败 0 项/.test(out), fails };
}

const original = fs.readFileSync(LIB, "utf8");
check(original.includes(GOOD), "前提：原文件里是**修好的**那条正则（否则下面测的不是同一个东西）");
check(!original.includes(BAD), "前提：原文件里**没有**坏形状（否则说明已经退化了）");

try {
  bar("方向 A（修好的版本）：情形 86 必须**全绿**");
  {
    const r = runSelftest();
    check(r.fails.length === 0, "修好的版本上，情形 86 **没有 FAIL**", r.fails.length === 0 ? "干净" : r.fails.join(" | "));
  }

  bar("方向 B（★关键：退回**坏版本**）：情形 86 必须**当场变红**");
  {
    const patched = original.replace(GOOD, BAD);
    check(patched !== original, "替换确实生效（否则这一整段是空验证）");
    fs.writeFileSync(LIB, patched, "utf8");
    const r = runSelftest();
    console.log("  ── 坏版本上，情形 86 报出来的 FAIL ──");
    for (const f of r.fails) console.log(`    · ${f}`);
    check(r.fails.length > 0, "★★★★ 坏版本上**确实有 FAIL**（守卫看得见红）", `${r.fails.length} 条`);
    // ★ 精确到"哪一条"：静态那条必须红（它是主判据）
    check(
      r.fails.some((f) => f.includes("86①")),
      "★★★★★ 且**静态那条（86①）**在坏版本上红 —— 正是它要拦的那种写法",
      r.fails.some((f) => f.includes("86①")) ? "红" : "**没红（守卫没长牙）**"
    );
    // ★ 行为那条也该红（中文写法认不出来）
    check(
      r.fails.some((f) => f.includes("86②")),
      "★★★★ 且**行为那条（86②）**也红（中文写法的散落决策一个都认不出）",
      r.fails.some((f) => f.includes("86②")) ? "红" : "**没红**"
    );
  }
} finally {
  bar("还原：无条件写回原文件，并**校验**还原成功");
  fs.writeFileSync(LIB, original, "utf8");
  const back = fs.readFileSync(LIB, "utf8");
  check(back === original, "★ 逐字节还原成功（与原文件完全相同）");
  check(back.includes(GOOD) && !back.includes(BAD), "★ 且确认落回的是**修好的**那一版");
  const r = runSelftest();
  check(r.fails.length === 0, "★ 还原后情形 86 重新变绿（证明确实只有那一处被动过）");
}

bar(`结  论：${bad === 0 ? "反向验证通过（守卫两方向都见红/绿）" : `${bad} 条不符合预期`}`);
console.log("  ★ 通过意味着：情形 86 那条守卫**不是恒绿的** —— 坏写法真的会被判红。");
console.log("  ★★ 而这正是本轮最重要的一课：**第一版守卫是恒绿的，是这条反向验证把它抓出来的。**");
