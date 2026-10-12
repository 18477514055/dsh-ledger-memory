/**
 * ★★★ 只读探针：billion-context 的 **nudge 全文**（真正发给模型的那段话）。
 *
 * ★ 为什么这条能回答用户的问题（"billion 能让模型经常调工具，我们怎么不行"）：
 *   我上一条的结论是"模型不主动，得靠插件催"。而 billion **确实**让模型调了 24 次。
 *   ⇒ 差别**不在模型**，在**催的方式**。
 *   ★ 本支把它的 nudge 全文与工具描述抽出来，与我们的注入文案**逐句对照**。
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

// ① prompts.ts —— compressPhilosophy（**进系统提示 + 每条 nudge**）
const pm = idx.get("../node_modules/acp-kernel/src/prompts.ts");
console.log("═".repeat(94));
console.log("【① prompts.ts 全文 —— compressPhilosophy 是它反复强调的那句】");
console.log("═".repeat(94));
if (pm !== undefined) for (let k = 0; k < Math.min(80, pm.length); k += 1) console.log(`${String(k + 1).padStart(4)} │ ${pm[k]}`);

// ② nudge-text.ts 的渲染函数（真正拼出来的那段话）
const nt = idx.get("../node_modules/acp-kernel/src/nudge-text.ts");
console.log("\n" + "═".repeat(94));
console.log("【② nudge-text.ts 渲染段（180–309）】");
console.log("═".repeat(94));
if (nt !== undefined) for (let k = 179; k < Math.min(309, nt.length); k += 1) console.log(`${String(k + 1).padStart(4)} │ ${nt[k]}`);
