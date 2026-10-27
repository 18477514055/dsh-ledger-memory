/**
 * ★★★★★ 只读行为探针：用户第 13 点 —— **"什么都不做"之后是不是真的一声不吭**
 *
 * 用户原话（逐字）：
 *   "然后如果选择了只作为一个问题记录的话（或者是选择什么都不做），
 *    那么我们这个插件将不会向模型发送任何东西"
 *
 * ★★ 判据必须**两向**都测，只测一边就是一个骗人的绿：
 *   · **已定论**（用户选了 note / none）⇒ 常规注入 / 压缩后重注 / 水位提醒 **全部为空**
 *   · **未定论**（全新项目，还没问过）⇒ **仍然要发**（那是用户的第 10/11 点：
 *     "对这个目录问一句要不要建台账"）—— 若这一向也静默，我就把该问的那一次砍掉了
 *
 * ★ 还要测：**有台账**的项目照旧正常发送（别把它一起静默了）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "silence-"));
process.env.DSH_HOME = path.join(fixture, "home");

const part3 = await import(pathToFileURL(path.join(ROOT, "lib", "part3.js")).href);
const { inspect } = await import(pathToFileURL(path.join(ROOT, "lib", "part2.js")).href);

let pass = 0, fail = 0;
const ok = (l, c, d = "") => { if (c) { pass++; console.log(`  PASS ${l}`); } else { fail++; console.log(`  FAIL ${l}${d ? " :: " + d : ""}`); } };

const mkProject = (name, withLedger) => {
  const p = path.join(fixture, name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "README.md"), "# plain\n", "utf8");
  if (withLedger) {
    fs.writeFileSync(path.join(p, "LEDGER.md"), "# ledger\n");
    fs.writeFileSync(path.join(p, ".dsh-ledger.json"), JSON.stringify({ active: "LEDGER.md", revision: 1 }));
  }
  return p;
};

const pressure = { ratio: 0.72, total: 720000, window: 1000000 };

// ── 对照组：有台账 ⇒ 必须照旧发送（防止我把主路径一起静默）
console.log("═══ 对照组：有台账的项目 ═══");
{
  const p = mkProject("with-ledger", true);
  const info = inspect(p);
  const inj = part3.renderInjection(info, undefined) ?? "";
  ok("有台账 ⇒ 常规注入非空（主路径没被误伤）", inj.trim() !== "", `${inj.length} 字符`);
  ok("有台账 ⇒ silentBecauseDecided 为假", part3.silentBecauseDecided(info) === false);
}

// ── 未定论：无台账、也没问过 ⇒ **仍要发**（第 10/11 点）
console.log("\n═══ 未定论：无台账且没问过 ═══");
{
  const p = mkProject("undecided", false);
  const info = inspect(p);
  const inj = part3.renderInjection(info, undefined) ?? "";
  ok("未定论 ⇒ 仍要发（要问「要不要建台账」）", inj.trim() !== "", `${inj.length} 字符`);
  ok("未定论 ⇒ silentBecauseDecided 为假", part3.silentBecauseDecided(info) === false);
  const pn = part3.renderPressureNotice(info, pressure, 0.7) ?? "";
  ok("未定论 ⇒ 水位提醒仍要发", pn.trim() !== "", `${pn.length} 字符`);
}

// ── 已定论：用户选了"问题记录 / 什么都不做" ⇒ 三处全静默
console.log("\n═══ 已定论：用户选了 note / none ═══");
{
  const p = mkProject("decided", false);
  const info = inspect(p);
  part3.markProjectDecided(info.projectRoot);   // 模拟用户选了 note / none

  ok("已定论 ⇒ silentBecauseDecided 为真", part3.silentBecauseDecided(info) === true);

  const inj = part3.renderInjection(info, undefined) ?? "";
  ok("已定论 ⇒ 常规注入为空（原来 582 字符）", inj.trim() === "", `${inj.length} 字符`);

  const inj2 = part3.renderInjection(info, undefined, { capsule: "CAPSULE-SENTINEL" }) ?? "";
  ok("已定论 ⇒ 压缩后重注为空（原来 1675 字符）", inj2.trim() === "", `${inj2.length} 字符`);

  // 水位提醒本身是纯渲染函数，静默由 index.js 调用方守（这里验那个纯函数判据）
  ok("已定论 ⇒ 水位提醒的调用方会被这道判据挡住", part3.silentBecauseDecided(info) === true);
}

// ── 反向：把定论清空 ⇒ 必须恢复发送（证明不是永久静默）
console.log("\n═══ 反向：清空定论 ⇒ 恢复发送 ═══");
{
  part3.clearDecidedProjectsForTest();
  const p = mkProject("decided-again", false);
  const info = inspect(p);
  ok("清空后 ⇒ 不再静默", part3.silentBecauseDecided(info) === false);
  const inj = part3.renderInjection(info, undefined) ?? "";
  ok("清空后 ⇒ 注入恢复非空", inj.trim() !== "", `${inj.length} 字符`);
}

// ── 边界：有台账时**即使**被 mark 过也不静默（台账优先）
console.log("\n═══ 边界：有台账 + 曾标过 decided ⇒ 仍要注入 ═══");
{
  const p = mkProject("both", true);
  const info = inspect(p);
  part3.markProjectDecided(info.projectRoot);
  ok("有台账时 decided 标记不得压过台账", part3.silentBecauseDecided(info) === false);
  const inj = part3.renderInjection(info, undefined) ?? "";
  ok("有台账时仍正常注入", inj.trim() !== "", `${inj.length} 字符`);
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
