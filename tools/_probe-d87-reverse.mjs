/**
 * ★★★ 反向验证（纪律第 10 条）：摘到能看见红。
 * 针对 D87 修复（**全量压缩后也更新锚点**）。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const FILE = "lib/index.js";
const orig = fs.readFileSync(FILE, "utf8");
const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
console.log(`原文件 sha256(前16) = ${h(orig)}`);

const CASES = [
  {
    tag: "① 摘掉「全量后更新锚点」",
    from: `  try {
    const afterFull = measurePressure(ctx, agent);
    if (afterFull !== undefined) setAnchor(state, key, afterFull.ratio);
  } catch {
    /* 量不到就不动锚点（宁可保持旧值，也不要写一个猜的） */
  }`,
    to: `  /* 反向验证：全量后不更新锚点（恢复成 D86 的缺陷） */`,
    expect: "47",
  },
];

let allRed = true;
for (const c of CASES) {
  if (!orig.includes(c.from)) {
    console.log(`\n✗ ${c.tag}：**锚点没找到** ⇒ 本次反向验证无效（不等于通过）`);
    allRed = false;
    continue;
  }
  fs.writeFileSync(FILE, orig.replace(c.from, c.to));
  let out = "";
  try {
    out = execFileSync(process.execPath, ["tools/selftest.mjs"], { encoding: "utf8" });
  } catch (e) {
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  const m = out.match(/通过 (\d+) 项，失败 (\d+) 项/);
  const idx = out.indexOf("失败清单：");
  const failed = idx === -1 ? "" : out.slice(idx);
  const hit = failed.includes(c.expect);
  console.log(`\n${c.tag}  ⇒ 通过 ${m?.[1] ?? "?"} / 失败 ${m?.[2] ?? "?"}`);
  console.log(`  期望红（含「${c.expect}」）：${hit ? "✔ 确实红了" : "✗ **没红** ⇒ 断言太弱"}`);
  if (hit) console.log(`  （失败清单里出现：${failed.split("\n").filter((l) => l.includes(c.expect)).slice(0, 2).join(" / ")}）`);
  if (!hit) allRed = false;
}
fs.writeFileSync(FILE, orig);
console.log(`\n已恢复。sha256(前16) = ${h(fs.readFileSync(FILE, "utf8"))}（应等于 ${h(orig)}）`);
console.log(allRed ? "\n★★★ 变红 ⇒ 断言有判别力。" : "\n⚠ 没红 ⇒ 不许当成通过。");
