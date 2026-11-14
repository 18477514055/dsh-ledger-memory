// 验证 /_backup/ 忽略规则在 **V2 flat**（备份落在项目根）里真的生效。
// ★ 为什么要单独验 V2：本项目是 V3，整个记忆目录已被忽略 ⇒ `_backup/` 天然被盖住，
//   那条规则**在本项目里根本测不出来**。而 V2 项目（没有任何 memoryRoot）里，
//   备份会落在**项目根**的 `_backup/` ⇒ 那才是会泄露进版本库的场景。
//   ★ 判据：**在"本机恰好不会出问题"的地方验证一条兜底规则，等于没验。**
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const defs = await import("../lib/defs.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "igv2-"));
try {
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
} catch (e) {
  console.log("SKIP：git init 失败 ——", String(e.message).slice(0, 80));
  process.exit(0);
}
fs.writeFileSync(path.join(root, ".gitignore"), defs.DEFAULT_IGNORE_LINES.join("\n") + "\n", "utf8");
fs.mkdirSync(path.join(root, "_backup"), { recursive: true });
fs.writeFileSync(path.join(root, "_backup", "LEDGER.md.bak"), "# 旧台账（含用户原话）\n", "utf8");

let ignored = false;
let detail = "";
try {
  detail = execFileSync("git", ["check-ignore", "-v", "_backup/LEDGER.md.bak"], { cwd: root, encoding: "utf8" }).trim();
  ignored = true;
} catch {
  ignored = false;
}

console.log(`V2 flat 下 _backup/*.bak 被忽略：${ignored ? "是 ✓" : "否 ✗"}`);
if (detail) console.log(`  命中规则：${detail}`);
// ★ 对照：真实台账也必须被忽略（别为了这条把别的关掉）
let ledgerIgnored = false;
fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
try {
  execFileSync("git", ["check-ignore", "LEDGER.md"], { cwd: root, stdio: "ignore" });
  ledgerIgnored = true;
} catch {
  ledgerIgnored = false;
}
console.log(`对照：LEDGER.md 也被忽略：${ledgerIgnored ? "是 ✓" : "否 ✗"}`);
console.log(ignored && ledgerIgnored ? "IGNORE-OK" : "IGNORE-BAD");
fs.rmSync(root, { recursive: true, force: true });
process.exit(ignored && ledgerIgnored ? 0 : 1);
