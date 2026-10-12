/**
 * ★★★ 判一处**分歧**（报告 02 卷 vs 我的子代理），只看一手证据。
 *
 * 分歧：报告 02 卷 §2.2 说这些名字在 dist 里"搜不到"⇒ 标 [未证实]：
 *   `nudgeMaxContextLimitPct(0.70)` / `growthRatio 0.05` / `growthFloor 50000`
 *   并说 `0.05` 是 `OUTPUT_CLAMP_MARGIN_PCT`（输出预算预留，与压缩触发无关）。
 *
 * 可能两者都对：**minify 会把 local const 改名/内联**，所以 dist/index.js 里搜不到，
 * 但 `dist/index.js.map` 的 `sourcesContent` 存着**原始 TS 源码**。
 *
 * ⇒ 本探针直接从 sourcemap 解出 sourcesContent，在那个**原始 TS 文本**里搜，
 *   并把命中处**上下文原样打印**。这是唯一能一次判掉的办法。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const B = path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", "billion-context.bak-0.1.179");
const MAP = path.join(B, "dist", "index.js.map");

const map = JSON.parse(fs.readFileSync(MAP, "utf8"));
const { sources = [], sourcesContent = [] } = map;
console.log("═".repeat(90));
console.log(`sourcemap: ${sources.length} 个 sources，其中带 sourcesContent 的 ${sourcesContent.filter(Boolean).length} 个`);
console.log("═".repeat(90));

// 只留带内容的，拼成 (文件, 行号, 行文本) 三元组，便于报"文件:行号"
const files = [];
for (let i = 0; i < sources.length; i += 1) {
  const content = sourcesContent[i];
  if (typeof content !== "string" || content === "") continue;
  files.push({ name: sources[i], lines: content.split("\n") });
}
console.log(`参与搜索：${files.length} 个有内容的源文件\n`);

const search = (needle) => {
  const hits = [];
  for (const f of files) {
    for (let ln = 0; ln < f.lines.length; ln += 1) {
      if (f.lines[ln].includes(needle)) hits.push({ file: f.name, line: ln + 1, text: f.lines[ln] });
    }
  }
  return hits;
};

const NAMES = [
  "nudgeMaxContextLimitPct",
  "growthRatio",
  "growthFloor",
  "resolveAdaptiveGrowth",
  "EMERGENCY_NUDGE_ESCALATION_PCT",
  "NUDGE_DEFAULT",
  "OUTPUT_CLAMP_MARGIN_PCT",
  "nudgeGrowthTokens",
  "minPressureBenefitTokens",
];

for (const n of NAMES) {
  const hits = search(n);
  console.log("─".repeat(90));
  console.log(`【${n}】 命中 ${hits.length} 处`);
  if (hits.length === 0) { console.log("   （原始 TS 里也没有 ⇒ 这个名字不存在）"); continue; }
  for (const h of hits.slice(0, 4)) {
    console.log(`   ${h.file}:${h.line}`);
    console.log(`     ${h.text.trim().slice(0, 190)}`);
    // 打印紧随其后的 3 行，看默认值
    const f = files.find((x) => x.name === h.file);
    for (let k = h.line; k < Math.min(h.line + 3, f.lines.length); k += 1) {
      const t = f.lines[k].trim();
      if (t !== "") console.log(`       + ${t.slice(0, 190)}`);
    }
  }
}

// ── 决定性一问：压缩触发里那个"增长门"的真实默认值是多少 ──────────────────
console.log("\n" + "═".repeat(90));
console.log("★ 决定性：growthRatio / growthFloor 的**默认值定义处**");
console.log("═".repeat(90));
for (const n of ["growthRatio", "growthFloor"]) {
  const hits = search(n);
  for (const h of hits) {
    const f = files.find((x) => x.name === h.file);
    const lo = Math.max(0, h.line - 6), hi = Math.min(f.lines.length, h.line + 5);
    console.log(`\n── ${n} @ ${h.file}:${h.line} 上下文 ──`);
    for (let k = lo; k < hi; k += 1) {
      const mark = k + 1 === h.line ? ">>" : "  ";
      console.log(`${String(k + 1).padStart(5)} ${mark} ${f.lines[k].slice(0, 170)}`);
    }
  }
}
