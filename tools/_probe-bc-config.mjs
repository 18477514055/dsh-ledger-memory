/**
 * ★ 只读：把 acp-kernel 的 nudge 默认配置**整段**抽出来（判报告 02 卷与子代理的分歧 + 取真值）。
 *
 * 上一支探针已判定：`nudgeMaxContextLimitPct` 不存在（报告对），
 * 但 `growthRatio`/`growthFloor` 存在于 **原始 TS**（子代理对，报告只 grep 了 minified dist）。
 * ⇒ 本支把 `acp-kernel/src/config.ts` 的 nudge 段与 `compress.ts` 的判据段原样打印。
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
  console.log("\n" + "═".repeat(92));
  console.log(`【${title}】  ${key}  行 ${from}–${to}`);
  console.log("═".repeat(92));
  if (lines === undefined) { console.log("  （这个 source 不在 map 里）"); return; }
  for (let k = from - 1; k < Math.min(to, lines.length); k += 1) {
    console.log(`${String(k + 1).padStart(5)} │ ${lines[k]}`);
  }
};

// ① nudge 默认配置（真值所在）
dump("../node_modules/acp-kernel/src/config.ts", 1, 48, "acp-kernel 默认配置");

// ② 触发判据
dump("../node_modules/acp-kernel/src/compress.ts", 1610, 1700, "触发判据 resolveAdaptiveGrowth + 三段门");

// ③ 那个 0.05 到底是哪一个（判报告"属记混"那句）
console.log("\n" + "═".repeat(92));
console.log("【OUTPUT_CLAMP_MARGIN_PCT 在哪、值多少】");
console.log("═".repeat(92));
for (const [name, lines] of idx) {
  lines.forEach((t, i) => {
    if (t.includes("OUTPUT_CLAMP_MARGIN_PCT")) console.log(`  ${name}:${i + 1}  ${t.trim().slice(0, 170)}`);
  });
}
