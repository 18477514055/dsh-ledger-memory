/**
 * ★★★ 只读探针：billion 到底靠**什么条件**决定"推不推"？
 *
 * ★ 已排除的：
 *   · `frequency` / `iterationThreshold` —— **全库只有 config 定义，无使用**（死配置）
 *   · 所以"常态"**不是**按轮次推。
 *
 * ★ 那么只剩一种可能：它的**增量门很小**（growthFloor = 50000 ≈ 5% 窗口）
 *   + **区间下限 0.45**（一进 45% 就进入"可推区间"）
 *   ⇒ ★ **它的"常态"是"门槛低"造成的，不是"机制不同"**。
 *
 * ★ 本支要把 `:1763` 那三行（第一个"要不要推"的判定）**逐字读出来**验证。
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
const cz = idx.get("../node_modules/acp-kernel/src/compress.ts");
console.log("=== 决定 nudge 的完整段落（1690–1830）===");
for (let k = 1689; k < 1830 && k < cz.length; k += 1) console.log(`${String(k + 1).padStart(5)} │ ${cz[k]}`);
