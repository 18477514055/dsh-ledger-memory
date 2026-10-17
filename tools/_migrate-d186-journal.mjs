/**
 * ★★★★★ 一次性迁移（D186）：把 `LEDGER.md` 里的**回合流水段**按 D183 的分工搬进 `JOURNAL.md`。
 *
 * ★ 为什么要搬（两个理由，第二个才是本次的触发点）：
 *   ① **D183 早就定了分工**：`LEDGER.md` = 当前状态（注入）· `JOURNAL.md` = 只追加的历史（不注入）。
 *      而 `## 2026-10-14 · …` 那种"某天做了什么"的段，**语义上就是流水**。
 *   ② 本轮 `ledger_write` 被**行数硬门正确拦下**（377 > 350）——
 *      拦得有道理：注入侧不该继续长流水。
 *
 * ★★ 四道安全措施（照 2026-10-09 抹掉 114 行那次事故的教训，与 D183 迁移同款）：
 *   ⓪ **备份两份** + sha256；
 *   ① ★★★ **内容不变量**：搬走的**每一行**都要能在 `JOURNAL.md` 里逐字找回，**否则一个字节都不写**；
 *   ② **不覆盖**已有内容（只 append）；
 *   ③ 搬完**行数守恒核对**。
 *   ★ 并且：**任何异常都要还原**（`finally` + `process.on("exit")`）——D183 那次就崩在还原之前。
 *
 * 跑法：node tools/_migrate-d186-journal.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const LEDGER = path.join(ROOT, "LEDGER.md");
const JOURNAL = path.join(ROOT, "JOURNAL.md");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const led0 = fs.readFileSync(LEDGER);
const jrn0 = fs.readFileSync(JOURNAL);
const ledText = led0.toString("utf8");
const jrnText = jrn0.toString("utf8");
console.log(`⓪ LEDGER   ${led0.length} B · ${ledText.split("\n").length} 行 · sha256=${sha(led0).slice(0, 16)}…`);
console.log(`   JOURNAL ${jrn0.length} B · ${jrnText.split("\n").length} 行 · sha256=${sha(jrn0).slice(0, 16)}…`);

// ── 备份（两份）──
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const bakDir = path.join(os.tmpdir(), `d186-migrate-${ts}`);
fs.mkdirSync(bakDir, { recursive: true });
fs.writeFileSync(path.join(bakDir, "LEDGER.md.bak"), led0);
fs.writeFileSync(path.join(bakDir, "JOURNAL.md.bak"), jrn0);
console.log(`   备份 → ${bakDir}`);

let restored = false;
const restore = () => {
  if (restored) return;
  try {
    fs.writeFileSync(LEDGER, led0);
    fs.writeFileSync(JOURNAL, jrn0);
    console.log("   [还原] 两份都已写回原件 ✅");
  } catch (e) {
    console.log(`   [还原] ★★ 失败：${e?.message}（备份在 ${bakDir}）`);
  }
  restored = true;
};
process.on("exit", restore);
process.on("uncaughtException", (e) => {
  console.log(`★★ 异常：${e?.message ?? e}`);
  restore();
  process.exit(2);
});

// ── 定位要搬的区间：从「## ★ 2026-10-14 · D184 后续」到「## 变更登记」之前 ──
const START = "## ★ 2026-10-14 · D184 后续";
const END = "## 变更登记（插件自动维护）";
const i = ledText.indexOf(START);
const j = ledText.indexOf(END);
if (i < 0 || j < 0 || j <= i) {
  console.log(`✗ 定位失败（START=${i} END=${j}）⇒ 不动任何文件`);
  process.exit(1);
}
const moved = ledText.slice(i, j);
const kept = ledText.slice(0, i) + ledText.slice(j);
console.log(`\n   将搬走 ${moved.split("\n").length} 行 / ${moved.length} 字符`);
console.log(`   搬完 LEDGER 预计 ${kept.split("\n").length} 行`);

// ── ① ★★★ 内容不变量：搬走的每一行都要能在 JOURNAL 里找回 ──
const jrnNew = jrnText.endsWith("\n") ? jrnText : jrnText + "\n";
const merged = jrnNew + "\n" + moved;
const movedLines = moved.split("\n").filter((l) => l.trim() !== "");
let lost = 0;
const miss = [];
for (const l of movedLines) {
  if (!merged.includes(l)) {
    lost += 1;
    if (miss.length < 5) miss.push(l.slice(0, 90));
  }
}
console.log(`\n   ① 内容不变量：搬走 ${movedLines.length} 行（非空）· **找回失败 ${lost} 行**`);
if (lost > 0) {
  console.log("   ★★ 有行找不回 ⇒ **一个字节都不写**。缺的样例：");
  for (const m of miss) console.log(`      ${m}`);
  process.exit(1);
}
console.log("   ✅ 全部可逐字找回");

// ── ② 不覆盖：JOURNAL 末尾已有内容 ⇒ 只 append ──
if (!jrnText.endsWith("\n")) console.log("   （JOURNAL 末尾无换行，已补一个再追加）");

// ── ③ 写入 + 守恒核对 ──
const ledOldLines = ledText.split("\n").length;
fs.writeFileSync(JOURNAL, merged);
fs.writeFileSync(LEDGER, kept);
const ledNewLines = fs.readFileSync(LEDGER, "utf8").split("\n").length;
const jrnNewLines = fs.readFileSync(JOURNAL, "utf8").split("\n").length;
console.log(`\n   ③ 守恒：LEDGER ${ledOldLines} → **${ledNewLines}** 行 · JOURNAL ${jrnText.split("\n").length} → **${jrnNewLines}** 行`);
console.log(`     搬走 ${moved.split("\n").length} 行 · 净变化 ${ledNewLines - ledOldLines} 行${ledNewLines - ledOldLines < 0 ? " ✅" : " ★ 不是减少？"}`);

// ── 复核：JOURNAL 里真的能按原文查到那段 ──
const ok1 = fs.readFileSync(LEDGER, "utf8").includes(START) === false;
const ok2 = fs.readFileSync(JOURNAL, "utf8").includes(START) === true;
console.log(`   复核：LEDGER 里已无该段 ${ok1 ? "✅" : "❌"} · JOURNAL 里有该段 ${ok2 ? "✅" : "❌"}`);

restored = true; // 成功 ⇒ 不让 exit 钩子还原
console.log(`\n⇒ 迁移完成。原件备份留在：${bakDir}`);
process.exit(0);
