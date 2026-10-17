/**
 * ★★★★★ 反向验证（D173/D174）：把「压缩合同」退回 **D129 那套（无条件旧文案）**
 * ⇒ 情形 70 必须变红。
 *
 * ★ 为什么必须做（纪律 10 —— 本项目最硬的一条，已栽过多次）：
 *   D174 的修复**恰好就是在改"模型看到的那段文本"**，而新断言也是在读同一段文本。
 *   ⇒ 这里天然存在"我改了什么就断言什么"的危险 —— 断言可能只是**复述我的改动**，
 *     而不是真的在约束被测对象。
 *   ⇒ 唯一能区分两者的办法：**把实现退回去，看它红不红**（摘不到红 = 断言是摆设）。
 *
 * ★ 本次"退回"的选法（刻意**不是**逐字还原，而是还原**架构**）：
 *   把"按 `incrementalCompact` 分支"换成"**永远给旧那套**"——
 *   这正是 D173 描述的那个偏离（代码改了、合同没改）的**最小复现**。
 *   ⇒ 若情形 70 在这么退之后仍然绿，那就说明程序 70 **根本没在管架构一致性**。
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
console.log(`⓪ 备份 sha256=${origSha.slice(0, 16)}… (${original.length} B)`);

let s = original.toString("utf8");

// ── 摘点①：主注入的「压缩策略合同」——把分支判据强制成"永远旧那套" ──────────
const NEEDLE1 = `      (currentSettings().incrementalCompact === true
        ? // ── 分支 A：增量（分段）压缩**开着** —— 即 D129 那套（现已非默认）──────────`;
const n1 = s.split(NEEDLE1).length - 1;
console.log(`① 合同分支判据命中 ${n1} 次（应为 1）`);

// ── 摘点②：`ledger_compact` 工具描述的中性说明（退回"推荐 light"）───────────
const NEEDLE2 =
  `      "★ WHICH mode is routine depends on the plugin's current configuration — the injected "`;
const n2 = s.split(NEEDLE2).length - 1;
console.log(`② 工具描述中性句命中 ${n2} 次（应为 1）`);

if (n1 !== 1 || n2 !== 1) {
  console.log("★ 定位失败（锚点漂了）⇒ 不改动，退出。★ 这本身就是一条有用的信号：锚点必须重取。");
  process.exit(1);
}

// 退化①：把 `=== true` 改成 `!== undefined` 之外的最简形态 ——
//   直接写死 `false` ⇒ 永远走"分支 B"？不：我们要退回的是**旧架构**，
//   即 D173 那个病 —— **合同永远是 D129 那套**。而分支 A 正是 D129 文本。
//   ⇒ 所以把判据写死成 `true`（永远走分支 A = D129 旧合同）。
s = s.replace(
  NEEDLE1,
  `      (true /* ★反向验证 D174：强制永远走 D129 旧合同 */
        ? // ── 分支 A：增量（分段）压缩**开着** —— 即 D129 那套（现已非默认）──────────`
);

// 退化②：工具描述退回"推荐 light"的那句原文（D174 删掉的那句）。
s = s.replace(
  NEEDLE2,
  `      "★ mode=\\"light\\" is PREFERRED while working — use it whenever the context grows. " +`
);

fs.writeFileSync(LIB, s);
console.log(`   已写入退化版 sha256=${sha(fs.readFileSync(LIB)).slice(0, 16)}…`);

console.log(`\n=========== 自检（退回旧合同之后）===========`);
let out = "";
try {
  out = execFileSync(process.execPath, [SELFTEST], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
}
const lines = out.split("\n");
const red = lines.filter((l) => /^\s*FAIL/.test(l));
console.log(`--- 红：${red.length} 条 ---`);
for (const r of red.slice(0, 20)) console.log("   " + r.trim().slice(0, 150));
for (const x of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + x.trim());
fs.writeFileSync(path.join(os.tmpdir(), "d174-reverse-out.txt"), out);

// ★ 无条件还原（无论上面发生什么）
fs.writeFileSync(LIB, original);
const restored = sha(fs.readFileSync(LIB));
console.log(`\n④ 已还原。sha256=${restored}`);
console.log(`   ${restored === origSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌（必须手工处理）"}`);
console.log(
  red.length > 0
    ? "\n⇒ ★ 结论：退回 D129 旧合同后**确实见红** ⇒ 情形 70 真的在管「合同与架构一致」✅"
    : "\n⇒ ★★ 结论：退回后仍全绿 ⇒ ★★★ 情形 70 是摆设，必须重写"
);
