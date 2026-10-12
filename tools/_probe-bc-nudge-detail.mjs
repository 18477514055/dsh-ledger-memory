/**
 * ★★★ 只读探针 ②：把 billion-context 的 **nudge 机制**逐段抽出来。
 *
 * ★ 要定论的一件事（用户要求"像 billion-context 一样由模型主动调用"）：
 *   **时机由谁定？** 是模型自由裁量，还是插件按阈值"轻推"、模型再决定调不调工具？
 *   ★ 第一支探针已经指向后者（`nudge-text.ts:31` 自称 "efficiency nudge… not an overflow warning"）。
 *   ⇒ 本支读三处原文：
 *     ① `nudge-text.ts` 开头（那句推给模型的话到底说什么、带哪些数）
 *     ② `compress.ts` 的三段门（什么条件下**才允许**推）
 *     ③ `src/compress-tool.ts`（模型调的那个工具长什么样）
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

dump("../node_modules/acp-kernel/src/nudge-text.ts", 1, 70, "① nudge 文本说什么");
dump("../node_modules/acp-kernel/src/config.ts", 1, 30, "①b nudge 默认配置");
dump("../node_modules/acp-kernel/src/compress.ts", 1750, 1870, "② 三段门：什么条件下才允许推");
