/**
 * 验证：自检中途**抛错**时，`process.on("exit")` 兜底是否真的把临时目录清扫掉。
 *
 * ★ 为什么要验它：收尾那段清扫只在正常跑完时执行。我这轮就因为一个小错
 *   （`_busy of undefined`）在中途抛出，结果 %TEMP% 里留下 3 个 `ledger-*`。
 *   而"干净跑一遍 0 残留"这个自检**发现不了**它 —— 出错的运行根本没走到收尾。
 *   ⇒ 加完兜底必须**让它真崩一次**看结果（本机规矩：验证能否工作，必须真让它工作）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";

const HERE = path.resolve(import.meta.dirname, "..");
const SRC = path.join(HERE, "tools", "selftest.mjs");
const TMP = path.join(HERE, "tools", "_tmp-crash-leak-test.mjs");

const leftovers = () =>
  fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("ledger-"));

// 先清干净，好让读数只反映这一次
for (const d of leftovers()) {
  try {
    fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
console.log(`起点残留 = ${leftovers().length}`);

// 造一份"跑到第一个临时项目就抛错"的副本
const src = fs.readFileSync(SRC, "utf8");
const marker = 'const root = tmpProject("fresh");';
if (!src.includes(marker)) {
  console.log("FAIL  找不到插入点（源码可能与预期不同）");
  process.exit(2);
}
fs.writeFileSync(TMP, src.replace(marker, `${marker}\n  throw new Error("intentional-crash-for-leak-test");`), "utf8");

let code = 0;
let verdict = 1;
try {
  const r = spawnSync(process.execPath, [TMP], { cwd: HERE, encoding: "utf8" });
  code = r.status ?? 0;
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  console.log(`崩溃副本退出码 = ${code}（非 0 才对）`);
  console.log(`  崩溃信息含 intentional-crash = ${out.includes("intentional-crash-for-leak-test")}`);

  // ★ 关键读数
  const after = leftovers();
  console.log(`\n${code !== 0 && after.length === 0 ? "PASS" : "FAIL"}  崩溃后残留 = ${after.length}（应为 0）`);
  if (after.length > 0) console.log("   留下：" + after.join(", "));
  verdict = code !== 0 && after.length === 0 ? 0 : 1;
} finally {
  try {
    fs.rmSync(TMP, { force: true });
  } catch {
    /* ignore */
  }
}
// ⚠️ `process.exit()` **必须放在 finally 之外**（2026-10-09 自查发现）：
//   Node 里 `process.exit()` 会**立刻**终止，**不执行未跑的 finally**
//   ⇒ 原来写在 try 里的那版**每次都会把这个临时副本留下来**。
//   ★ 讽刺的是：这个探针存在的意义正是"验证收尾清理真的跑得到" ——
//     而它自己的收尾清理**从没跑过**。同一个 bug 形状，出现在抓它的尺子上。
process.exit(verdict);
