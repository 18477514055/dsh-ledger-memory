/**
 * 把活跃台账里那几节**已被 decisions/ 卡片永久保存**的旧摘要移入归档，腾出行数。
 * ★ 这正是"归档的意义"（用户原话）：正文在卡片里，台账只留指针。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ledgerPath = path.join(ROOT, "LEDGER.md");

const lines = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/);
const findHead = (re, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l));

// 要移走的段：D198–D199 / D200–D202 / D203 / D204–D205（正文全在 decisions/ 的卡里）
const startD198 = findHead(/^## ★★ 2026-10-14 · D198/);
const startD206 = findHead(/^## ★★ 2026-10-14 · D206/);
if (startD198 < 0 || startD206 < 0 || startD206 <= startD198) {
  console.log(`❌ 锚点不对：startD198=${startD198} startD206=${startD206}`);
  process.exit(1);
}
const moved = lines.slice(startD198, startD206);
console.log(`准备移出 ${moved.length} 行（第 ${startD198 + 1}–${startD206} 行）`);
console.log(`首行：${moved[0]}`);
console.log(`末行：${moved[moved.length - 1]}`);

// 归档（只追加，不覆盖）
const dst = path.join(ROOT, "_ledger-archive", "2026-10", "week2", "2026-10-14-台账§-D198-D205摘要（已由decisions卡片永久保存）.md");
if (fs.existsSync(dst)) {
  console.log(`⚠️ 归档目标已存在，跳过写入：${dst}`);
} else {
  fs.writeFileSync(
    dst,
    "# 归档：台账 §D198–D205 摘要（2026-10-14 移出）\n\n" +
      "> 从活跃台账移出（**只为腾行数**）。★ 正文全部在 `decisions/` 的卡片里：\n" +
      "> `D198`–`D208` 各有 `decisions/D<n>.md` ⇒ 用 `ledger_read({target:\"decisions\", entry:\"D198\"})` 取。\n" +
      "> 本文件是当时的**摘要表**（移出的是描述，不是信息）。\n\n" +
      moved.join("\n") +
      "\n",
    "utf8"
  );
  console.log(`✅ 已归档 ${moved.length} 行 -> ${path.relative(ROOT, dst)}`);
}

// 台账里换成一段指针
const pointer = [
  "## ★★ 2026-10-14 · D198–D205 摘要 —— **已移入归档**",
  "",
  "> ★ **2026-10-14（D208）**：这一节（D198–D205 的摘要表）**整体移入归档**：",
  "> `_ledger-archive/2026-10/week2/2026-10-14-台账§-D198-D205摘要（已由decisions卡片永久保存）.md`。",
  "> ★ 为什么能移：**它们的正文全在 `decisions/` 的卡片里**（各有 `decisions/D198.md` 等）。",
  "> ⇒ 需要时用 `ledger_read({target:\"decisions\", entry:\"D198\"})` 取。",
  "",
];
const next = [...lines.slice(0, startD198), ...pointer, ...lines.slice(startD206)];
fs.writeFileSync(ledgerPath, next.join("\n"), "utf8");
console.log(`✅ 台账：${lines.length} 行 → ${next.length} 行`);
