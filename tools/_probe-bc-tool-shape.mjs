/**
 * ★★★ 只读探针 ③：billion-context **给模型的那个工具**长什么样 + 它到底谁定时机。
 *
 * ★ 已定论的部分：
 *   · `nudge.maxContextLimitPct 0.75` / `minContextLimitPct 0.45`（**硬阈值**）
 *   · `growthFloor = growthCap = 50000`（增量门）
 *   · nudge 文本自称 "efficiency nudge to compress early… not an overflow warning"
 *   ⇒ **时机是插件算的**，nudge 只是"提醒模型动手"。
 *
 * ★ 本支要补最后一块：**模型手上那个工具**是什么形状（它是不是可以"任何时候随便压"）。
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
const dump = (key, from, to, title) => {
  const lines = idx.get(key);
  console.log("\n" + "═".repeat(94));
  console.log(`【${title}】${key}  行 ${from}–${to}`);
  console.log("═".repeat(94));
  if (lines === undefined) {
    console.log("  （不在 map 里）");
    return;
  }
  for (let k = from - 1; k < Math.min(to, lines.length); k += 1) console.log(`${String(k + 1).padStart(5)} │ ${lines[k]}`);
};

// 工具定义：找 name/description/inputSchema
const src = idx.get("../src/compress-tool.ts");
if (src !== undefined) {
  console.log("\n=== src/compress-tool.ts 里工具名的定义 ===");
  src.forEach((t, i) => {
    if (/name:\s*["'`]/.test(t) || /description:\s*["'`]/.test(t) || /inputSchema|parameters\s*:/.test(t)) {
      console.log(`${String(i + 1).padStart(5)} │ ${t.trim().slice(0, 160)}`);
    }
  });
}
dump("../src/compress-tool.ts", 1, 60, "③ 模型用的压缩工具（开头）");

// 顺带：把"谁决定时机"的判据函数名摆出来
console.log("\n=== compress.ts 里做决定的函数名（证明时机是算出来的）===");
const cz = idx.get("../node_modules/acp-kernel/src/compress.ts");
if (cz !== undefined) {
  cz.forEach((t, i) => {
    if (/^(?:export )?(?:function|const) \w*(?:[Nn]udge|[Ss]hould|resolve|decide|gate)\w*/.test(t.trim())) {
      console.log(`${String(i + 1).padStart(5)} │ ${t.trim().slice(0, 140)}`);
    }
  });
}
