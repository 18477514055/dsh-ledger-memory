// D327：009 报 2272 / 1 SKIP，我这边 2287 / 2 SKIP —— 到底是「跑另一份快照」还是「环境不同」？
//
// ★ 它自己的 §5 写了：「新增 124①–124⑤，全量运行 PASS 2272 · SKIP 1 · FAIL 0
//   （唯一 1 条 SKIP 为 114⑤，因**干净源码包不含本项目自身的 decisions/ 记忆目录**而按预期跳过）」
//
// ★ 我在本工作区跑是 2287 / 2 SKIP，SKIP 的是 **122①/122②**（Windows 建不了 symlink）。
// ⇒ 两个变量同时不同：
//   ① 它没有 decisions/ ⇒ 114⑤ 会 SKIP（我这边 PASS）
//   ② 它能建 symlink（Linux）⇒ 122①/122② 会真跑（我这边 SKIP）
// ★ 判据：**造一个"干净包"副本**（不含 decisions/、不含 _ledger-*），看数字是否落到 2272/1。
//   落到 ⇒ 是环境差异（不是快照差异），它的数字**可解释**；
//   落不到 ⇒ 它跑的是另一份代码（Gemini 003 同型）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const d = fs.mkdtempSync(path.join(os.tmpdir(), "d327-clean-"));

// 只搬发布包会带的东西 + 自检需要的东西
fs.cpSync(path.join(ROOT, "lib"), path.join(d, "lib"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "package.json"), path.join(d, "package.json"));
// ★★★ 尺子错 #47（本轮自己撞的）：第一版只搬了 `selftest.mjs`，
//   而 selftest 里有大量 `await import("../tools/_probe-*.mjs")` / `_reverse-verify-*.mjs`
//   ⇒ **整个 tools/ 目录都要搬**。只搬一个 ⇒ 中途 ENOENT 崩溃 ⇒ 得到 1954/0 这种
//   「PASS 不少、FAIL 为 0、exit=1」的怪数字 —— 正是「夹具没走通 ≠ 被测对象有问题」。
fs.cpSync(path.join(ROOT, "tools"), path.join(d, "tools"), { recursive: true });
// ★ 发布包里还有这些顶层文件，selftest 会真读它们（缺一个就 ENOENT 崩溃）
for (const f of ["README.md", "LICENSE", "cordis.patch.yml"]) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(d, f));
}
// 有 decisions/ 才能让 114⑤ 真跑；这里**故意不搬**（模拟 009 说的"干净源码包"）

const r = spawnSync(process.execPath, ["tools/selftest.mjs"], { cwd: d, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
const lines = out.split(/\r?\n/);
const pass = lines.filter((l) => /^\s*PASS\s/.test(l));
const skip = lines.filter((l) => /^\s*SKIP\s/.test(l));
const fail = lines.filter((l) => /^\s*FAIL\s/.test(l));

console.log("═══ 干净包副本（无 decisions/、无 _ledger-*）═══");
console.log("exit = " + r.status);
console.log("PASS = " + pass.length + "　SKIP = " + skip.length + "　FAIL = " + fail.length);
console.log("");
console.log("SKIP 明细：");
for (const l of skip) console.log("  " + l.trim().slice(0, 150));
console.log("");
if (fail.length > 0) {
  console.log("FAIL 明细（前 8 条）：");
  for (const l of fail.slice(0, 8)) console.log("  " + l.trim().slice(0, 150));
  console.log("");
}
// ★ 崩溃必须**如实打出来**：exit≠0 且 FAIL=0 ⇒ 这不是"检出"，是"没跑完"（D324 教训）。
if (r.status !== 0 && fail.length === 0) {
  console.log("⚠ exit=" + r.status + " 但 FAIL=0 ⇒ **崩溃，不是检出**。最后 12 行：");
  for (const l of lines.slice(-12)) console.log("  " + l.slice(0, 200));
  console.log("");
}
console.log("对照：");
console.log("  009 报   PASS 2272 / SKIP 1（唯一 SKIP = 114⑤）");
console.log("  本工作区 PASS 2287 / SKIP 2（SKIP = 122①/122②）");
console.log("  干净副本 PASS " + pass.length + " / SKIP " + skip.length);
console.log("");
const hit = pass.length === 2272 && skip.length === 1;
console.log(hit ? "⇒ ★ 落在 2272/1：**与 009 完全一致** ⇒ 它的数字是**环境差异**造成的，不是快照不同。" : "⇒ ✗ 没落到 2272/1 ⇒ 需要继续查（可能它跑的是另一份代码）。");
fs.rmSync(d, { recursive: true, force: true });
console.log("PROBE-COMPLETE");
