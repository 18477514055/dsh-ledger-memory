// D228 · 只读实测：**没有交接文件夹时，问题记录会落到哪**？
// ★ 用户问的（逐字）："在没有我们目前这个对话交接文件夹的情况下，那个留下一份问题记录的工具
//   会把这个报告落到哪里去？"
// ★ 判据：**真调 inspect()**（唯一出口），不看注释、不猜。
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

// 把 lib/ 拼成可 import 的入口（与 selftest 同法）
const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const t = mod.__test ?? mod.default?.__test;
if (t === undefined) { console.log("★ 取不到 __test，换法复核"); process.exit(2); }

const info = t.inspect(ROOT);
console.log("═══ 本项目（会话 cwd）实测 ═══");
console.log("  projectRoot   =", ROOT);
console.log("  isGitRepo     =", info.isGitRepo);
console.log("  containerWorkspace =", info.containerWorkspace);
console.log("  notesRel      =", info.notesRel);
console.log("  notesAbs      =", info.notesAbs);
console.log("  notesSource   =", info.notesSource);

console.log("\n═══ 落点判定 ═══");
if (info.notesAbs === undefined) {
  console.log("  ⇒ ❌ `notesAbs` 未解析出 ⇒ `ledger_note` 会直接拒绝（ok:false）");
} else {
  console.log("  ⇒ 会落到：", info.notesAbs);
  console.log("  ⇒ 目录存在吗：", fs.existsSync(info.notesAbs) ? "存在" : "**不存在**（写入时 ensureDir 会建）");
}

// 三档逻辑复述（与源码 3678-3712 对齐）
console.log("\n═══ 源码里的三档（part2.js:3678-3712）═══");
console.log("  ① 清单里登记了 notesDir ⇒ 用登记值（notesSource=manifest）");
console.log("  ② 没登记 ⇒ 只在候选名里找**已存在**的目录（notesSource=guess）：");
console.log("     ", ["60-对话记录与交接/对话总结", "60-对话记录与交接", "对话总结", "_问题记录", "_notes"].join(" / "));
console.log("  ③ 连候选目录都没有 ⇒ 用默认名 `" + "60-对话记录与交接/对话总结" + "`（notesSource=default）");
console.log("     ★ 这一档**会在写入时新建目录**（ensureDir）—— 不是拒绝。");

// 关键边界：项目根 vs 工作区根
console.log("\n═══ 关键边界 ═══");
console.log("  ★ 只在 **不是 Git 仓库**时才解析问题记录目录；");
console.log("     真项目里 `ledger_note` **直接拒绝**并让你改用 ledger_write（part4.js:3261）。");
console.log("  ★ 基准是**工作区根**（findWorkspaceRoot），不是会话 cwd ——");
console.log("     往上找会在**有 .git 的地方停**。");
