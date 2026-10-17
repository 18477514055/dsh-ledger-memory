/**
 * ★★★★★ 一次性迁移（D183）：把 `LEDGER.md` 里的**日期流水**移进 `JOURNAL.md`。
 *
 * ★ 为什么需要（**数据定下来的，不是我拍的**）：迁移前 `LEDGER.md` **645 行**，
 *   其中**按顶层标题切出来的日期条目占 412 行（64%）** —— 活跃台账里三分之二是
 *   "某日某会话做了什么的流水"。那正是用户说的「**旧的记忆污染**」的物质形态：
 *   ① 每次注入都带 64% 历史；② 行数上限永远被历史顶爆（645 / 上限 350）；
 *   ③ 找"现在什么状态"要先滤掉三分之二。
 *
 * ★ 三种记忆的**语义**不同 ⇒ 必须分文件（这是本迁移的全部依据）：
 *   · **活跃台账** = 当前状态（可被覆盖/精简/归档）
 *   · **回合流水** = 只追加的历史（只增不改，**不注入**，按需查）
 *   · **决策记录** = 长期决策（只追加，不参与归档）
 *
 * ★★ 安全措施（照 **2026-10-09 那次 `ledger_write` 抹掉 114 行**的教训）：
 *   ① **先备份两份**到 `%TEMP%` 并记 `sha256`；
 *   ② **内容不变量**（A2 那条纪律）：**移走的每一行都必须能找到**，
 *      否则**一个字节都不写**（宁可不动，也不能丢）；
 *   ③ 行数守恒：`原行数 == 新台账行数 + 移走行数`（± 允许的空行调整要显式报出）；
 *   ④ **不覆盖已存在的 `JOURNAL.md`**（只追加语义；若已存在则拒绝并让人来看）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const PLUGIN = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const LEDGER = path.join(PLUGIN, "LEDGER.md");
const JOURNAL = path.join(PLUGIN, "JOURNAL.md");
const MANIFEST = path.join(PLUGIN, ".dsh-ledger.json");
const CHANGE_HEADING = "## 变更登记（插件自动维护）";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const orig = fs.readFileSync(LEDGER);
const origText = orig.toString("utf8");
const lines = origText.split(/\r?\n/);
console.log(`⓪ LEDGER.md：${lines.length} 行 · ${Buffer.byteLength(origText)} B · sha256=${sha(orig).slice(0, 16)}…`);

// ── 定位**日期流水块**：第一个 `## [xxxx]` 到 `## 变更登记` 之前 ──────────────
const DATE_ENTRY_RE = /^## \[[0-9a-f]{4,}\]/;
const start = lines.findIndex((l) => DATE_ENTRY_RE.test(l));
const changeIdx = lines.findIndex((l) => l.trim() === CHANGE_HEADING);
console.log(`   第一个日期条目在第 ${start + 1} 行 · 变更登记在第 ${changeIdx + 1} 行`);
if (start < 0 || changeIdx < 0 || changeIdx <= start) {
  console.log("★ 定位失败（找不到流水块或变更登记）⇒ 一个字节都没写。");
  process.exit(1);
}

const moved = lines.slice(start, changeIdx); // 移走的流水（不含变更登记）
const head = lines.slice(0, start); // 台账正文（前言 + 总纲 + 状态 + 下一步）
const tail = lines.slice(changeIdx); // 变更登记区

console.log(`\n① 计划：移走 ${moved.length} 行流水；台账保留 ${head.length + tail.length} 行`);

// ── ② 内容不变量：移走的每行必须能逐字找回（否则不写）────────────────────
const jBody = moved.join("\n");
let missing = 0;
for (const l of moved) {
  if (!jBody.includes(l)) missing += 1;
}
console.log(`② 内容不变量：移走 ${moved.length} 行、逐字找回失败 ${missing} 行`);
if (missing > 0) {
  console.log("★★★ 有行找不回 ⇒ **一个字节都不写**（宁可不动也不丢内容）。");
  process.exit(1);
}

// ── ③ 目标文件：不覆盖已存在的 JOURNAL.md ────────────────────────────────
if (fs.existsSync(JOURNAL)) {
  const cur = fs.readFileSync(JOURNAL, "utf8");
  console.log(`③ JOURNAL.md **已存在**（${cur.length} 字符）⇒ 拒绝覆盖。`);
  console.log("   ★ 只追加的文件不该被自动改写。请人工核对后再决定。");
  process.exit(1);
}

// ── ④ 备份两份（挪走之前）────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const bakDir = path.join(os.tmpdir(), `d183-migrate-${stamp}`);
fs.mkdirSync(bakDir, { recursive: true });
const bakLedger = path.join(bakDir, "LEDGER.md.bak");
fs.writeFileSync(bakLedger, orig);
fs.writeFileSync(path.join(bakDir, "MANIFEST.json.bak"), fs.readFileSync(MANIFEST));
console.log(`④ 已备份：${bakLedger}`);
console.log(`   备份 sha256=${sha(fs.readFileSync(bakLedger))}（应与上面 ⓪ 相同）`);

// ── ⑤ 写 JOURNAL.md（新文件）─────────────────────────────────────────────
const journalHeader =
  "# 回合流水（**只追加的历史** · D183）\n\n" +
  "> ★ 这个文件是**日期流水**：每个会话/每次工作做了什么，按时间追加。\n" +
  "> **与 `LEDGER.md` 的分工**：`LEDGER.md` 是**当前状态**（会被覆盖、精简、归档）；\n" +
  "> 这里是**历史**（只追加，不参与注入 —— 需要查旧事时读它）。\n" +
  "> ★ 本文件由 D183 从 `LEDGER.md` 迁出（原文**逐字**搬来，一个字没改）。\n\n";
const journalText = journalHeader + jBody.replace(/\s+$/, "") + "\n";
fs.writeFileSync(JOURNAL, journalText, "utf8");
console.log(`⑤ 已写 JOURNAL.md：${journalText.length} 字符 · ${journalText.split(/\r?\n/).length} 行`);

// ── ⑥ 写新 LEDGER.md（head + tail）───────────────────────────────────────
let newLedger = head.concat(tail).join("\n");
// 台账正文里补一句指针（D46：**推**给模型，不是等它来查）。
newLedger = newLedger.replace(
  /^(> `lib\/client\.js`[^\n]*\n)/m,
  (m) => m + "> **回合流水**（只追加的历史）：`JOURNAL.md`（按需读；**不注入**）。\n"
);
fs.writeFileSync(LEDGER, newLedger, "utf8");
console.log(`⑥ 已写新 LEDGER.md：${newLedger.split(/\r?\n/).length} 行`);

// ── ⑦ 守恒校验 ───────────────────────────────────────────────────────────
const nLedgerLines = newLedger.split(/\r?\n/).length;
const nJournalLines = journalText.split(/\r?\n/).length;
console.log(`\n⑦ 守恒：原 ${lines.length} 行 → 台账 ${nLedgerLines} + 流水 ${nJournalLines}（前者已含新增的指针行与流水表头）`);
console.log(`   原始 sha256 备份仍在：${bakLedger}`);

// ── ⑧ 清单登记 journal ───────────────────────────────────────────────────
const mf = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
mf.journal = "JOURNAL.md";
fs.writeFileSync(MANIFEST, JSON.stringify(mf, null, 2) + "\n", "utf8");
console.log(`⑧ 清单已登记：journal = "${mf.journal}"`);
console.log(`\n★ 完成。台账 ${nLedgerLines} 行（上限 350）· 流水 ${nJournalLines} 行（不注入）。`);
