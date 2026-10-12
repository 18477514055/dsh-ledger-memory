/**
 * ★★★ 发布前预检：**本地打出来的 tgz 里到底有没有今天的修复**。
 *
 * 这正是第 34 节的教训 —— "发出去了" ≠ "发的是修好的那版"。
 * 所以**打包后、发布前**先解包核对，而不是发完再回读（回读是第二道防线）。
 * ★ 标志物必须**独一无二**（第 34 节教训②：`ifRevision` 早就存在，不能当标志）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tgz = process.argv[2];
if (tgz === undefined) { console.log("用法: node tools/_probe-pack-check.mjs <tgz>"); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "packcheck-"));
fs.copyFileSync(tgz, path.join(tmp, "p.tgz"));
execFileSync("tar", ["-xzf", path.join(tmp, "p.tgz"), "-C", tmp], { stdio: "pipe" });

const pkg = path.join(tmp, "package");
const files = [];
(function walk(d, rel) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) walk(path.join(d, e.name), r);
    else files.push(r);
  }
})(pkg, "");
console.log(`═══ ${tgz} ═══`);
console.log(`包内文件 ${files.length} 个：`);
files.forEach((f) => console.log(`  ${f}`));

const libSrc = fs.readFileSync(path.join(pkg, "lib", "index.js"), "utf8");
const localSrc = fs.readFileSync("lib/index.js", "utf8");
const pj = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8"));

console.log(`\n版本 = ${pj.version}`);

// 每个修复用**独一无二**的标志物
// ★★ 我第一版标志物写错了三处，全是"标志物不精确"这个病（第 34 节教训②的复发）：
//   ① `"nodeSum > 0 ?"` —— 源码里是**跨行**写的（`nodeSum > 0\n ? Math.max(…)`）⇒ 匹配不上；
//   ② 拿 `keepRatio` 当"D62 旧算式已移除" —— **错**：它是**有意保留的兜底分支**
//      （注释原文「量不到节点时就退回旧口径」）⇒ 它**应该**在，不该判为"未移除"；
//   ③ 把自检里的标志物塞进 `lib/index.js` 去找 ⇒ 当然找不到（它在 tools/selftest.mjs 里）。
//   ⇒ 标志物必须**既能选对文件、又能对上真实写法**。现已逐条核对源码后重写。
const marks = [
  ["D62 口径修复（在 nodes 尺度上算保留量）", "Math.max(1, Math.floor(nodeSum - removeRatio * pressure.window))"],
  ["D62 兜底分支保留（量不到节点时退回旧口径）", "量不到节点时就退回旧口径"],
  ["A2 内容指纹幂等", "batch:${bodySha}"],
  ["A2 内容不变量", "既不在新台账、也不在 entries 里"],
  ["A2 ifRevision 拒绝", "stale: true"],
  ["A3 保留扩展字段", "hadPrevManifest"],
  ["D61 胶囊落盘", "capsules.json"],
];
console.log("\n═══ 修复标志物（全部应在 lib/index.js 里）═══");
let allOk = true;
for (const [name, key] of marks) {
  const inPkg = libSrc.includes(key);
  const inLocal = localSrc.includes(key);
  const okk = inPkg === true && inLocal === true;
  if (!okk) allOk = false;
  console.log(`  ${okk ? "✓" : "✗"} ${name}：包内=${inPkg} 本地=${inLocal}`);
}
// ★★★ 2026-10-12（D145）：**自检已不进包**（用户拍板：「用户确实不需要跑我们的质检，
//   出 bug 了直接推送 issue 给我就可以了」）⇒ 这里**不能再假设包里有 `tools/selftest.mjs`**。
//   ★ 实测：不改这一行的后果是**探针自己崩**（`ENOENT ... package/tools/selftest.mjs`）——
//     而那是"探针坏了"，不是"包坏了"。★ 两者必须分清（纪律 6：夹具故障 ≠ 被测对象有问题）。
//
//   ★★ 判据改成**双向**：包里有它 ⇒ 必须与本地逐字节相同；
//     包里没有它 ⇒ **必须确认是有意排除**（`files` 里整个 `tools/` 都不在）。
//     ⇒ 这样"漏发了"与"有意排除"仍然分得开。
const pkgToolsDir = path.join(pkg, "tools");
const pkgHasSelftest = fs.existsSync(path.join(pkgToolsDir, "selftest.mjs"));
const localTestSrc = fs.readFileSync("tools/selftest.mjs", "utf8");
const pjFiles = pj.files ?? [];
const toolsWhollyExcluded = !pjFiles.some((f) => f === "tools" || String(f).startsWith("tools/"));

if (pkgHasSelftest) {
  const testSrc = fs.readFileSync(path.join(pkgToolsDir, "selftest.mjs"), "utf8");
  const selfTestMark = "口径：工具数 = 14";
  const stOk = testSrc.includes(selfTestMark) && localTestSrc.includes(selfTestMark);
  if (!stOk) allOk = false;
  console.log(`  ${stOk ? "✓" : "✗"} 口径自检（在 tools/selftest.mjs 里）`);
  console.log("\n═══ 与本地工作树 ═══");
  console.log(`  lib/index.js 逐字节相同: ${libSrc === localSrc ? "★ 是" : "✗ 否"}`);
  console.log(`  tools/selftest.mjs 逐字节相同: ${testSrc === localTestSrc ? "★ 是" : "✗ 否"}`);
  if (libSrc !== localSrc || testSrc !== localTestSrc) allOk = false;
} else {
  // ★ 包里没有自检 ⇒ 只有"整个 tools/ 都被有意排除"才算对。
  if (!toolsWhollyExcluded) allOk = false;
  console.log(
    `  ${toolsWhollyExcluded ? "✓" : "✗"} 自检**不在包里**，且 ` +
      `${toolsWhollyExcluded ? "已确认是有意排除整个 tools/" : "但 files 里仍有 tools/ 条目 ⇒ 半坏状态"}`
  );
  console.log("\n═══ 与本地工作树 ═══");
  console.log(`  lib/index.js 逐字节相同: ${libSrc === localSrc ? "★ 是" : "✗ 否"}`);
  console.log(`  tools/selftest.mjs 不进包（设计如此，跳过比对）`);
  if (libSrc !== localSrc) allOk = false;
}

console.log(`\n═══ DSH STORE 的单文件上限（256 KiB）═══`);
for (const f of files) {
  const size = fs.statSync(path.join(pkg, f)).size;
  const over = size > 262144;
  if (over) allOk = false;
  console.log(`  ${over ? "✗" : "✓"} ${size.toString().padStart(8)} B  ${f}${over ? "  ← 超 262144" : ""}`);
}

console.log(`\n⇒ 预检${allOk ? " **通过**，可以发布" : " **未通过**，不要发布"}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(allOk ? 0 : 1);
