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
// 自检文件单独查（它在 tools/selftest.mjs 里，不在 lib/index.js）
const testSrc = fs.readFileSync(path.join(pkg, "tools", "selftest.mjs"), "utf8");
const selfTestMark = "口径：工具数 = 14";
const stOk = testSrc.includes(selfTestMark) && fs.readFileSync("tools/selftest.mjs", "utf8").includes(selfTestMark);
if (!stOk) allOk = false;
console.log(`  ${stOk ? "✓" : "✗"} 口径自检（在 tools/selftest.mjs 里）`);

console.log("\n═══ 与本地工作树 ═══");
console.log(`  lib/index.js 逐字节相同: ${libSrc === localSrc ? "★ 是" : "✗ 否"}`);
console.log(`  tools/selftest.mjs 逐字节相同: ${testSrc === fs.readFileSync("tools/selftest.mjs", "utf8") ? "★ 是" : "✗ 否"}`);

console.log(`\n⇒ 预检${allOk && libSrc === localSrc ? " **通过**，可以发布" : " **未通过**，不要发布"}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(allOk && libSrc === localSrc ? 0 : 1);
