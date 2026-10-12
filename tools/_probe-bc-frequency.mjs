/**
 * ★★★ 只读探针：billion-context 的 **nudge 频率机制** —— "让压缩成为常态"靠什么？
 *
 * ★ 关键线索（读它的默认配置时看到的三个数）：
 *     · `maxContextLimitPct: 0.75`   ← 上限：到这就"该压了"
 *     · `minContextLimitPct: 0.45`   ← ★**下限**：过了这条线就进入"可推区间"
 *     · `frequency: 5`               ← ★★ 这个是什么的频率？
 *     · `iterationThreshold: 15`     ← ★★ 迭代阈值？
 *     · `growthFloor = growthCap = 50000`（增量门 ≈5%）
 *
 * ★ 我们的设计**只有"增量门"**（涨 20 点才轻推）—— **没有"频率"这个概念**。
 *   如果 billion 的"常态"来自 `frequency`（按**回合数**推，而不是按涨幅），
 *   那就说明：**"到节点"这件事它用"轮次"近似，而我们用"涨幅"近似** ——
 *   两者差别巨大（涨幅可能很久不动，而轮次一直在走）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const B = path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", "billion-context.bak-0.1.179");
const map = JSON.parse(fs.readFileSync(path.join(B, "dist", "index.js.map"), "utf8"));
const idx = new Map();
for (let i = 0; i < map.sources.length; i += 1) {
  if (typeof map.sourcesContent[i] === "string") idx.set(map.sources[i], map.sourcesContent[i].split("\n"));
}

console.log("=== frequency / iterationThreshold 的**全部出现处** ===");
for (const [k, lines] of idx) {
  lines.forEach((t, i) => {
    if (/\bfrequency\b|iterationThreshold/.test(t) && !/^\s*\*/.test(t)) {
      console.log(`  ${k}:${i + 1}  ${t.trim().slice(0, 165)}`);
    }
  });
}

console.log("\n=== 相关门函数 resolveAdaptiveGrowth 全文（看它怎么组合这些数）===");
const cz = idx.get("../node_modules/acp-kernel/src/compress.ts");
if (cz !== undefined) {
  // 找 resolveAdaptiveGrowth / resolveMinPressureBenefit 的定义
  cz.forEach((t, i) => {
    if (/function resolveAdaptiveGrowth|function resolveMinPressureBenefit|function shouldNudge|const shouldNudge/.test(t)) {
      console.log(`\n--- 定义在 :${i + 1} ---`);
      for (let k = i; k < Math.min(i + 26, cz.length); k += 1) console.log(`${String(k + 1).padStart(5)} │ ${cz[k]}`);
    }
  });
}
