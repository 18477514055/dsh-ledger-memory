/**
 * ★★★ 只读探针：billion-context 的「模型主动压缩」**真实机制**。
 *
 * ★ 为什么必须先核（纪律 9/12）：用户的要求是"像 billion-context 一样由模型主动调用"。
 *   而记忆库里有一条关键数字：「约 **96%** 的 nudge（1212/1266）因可压缩量或增量不足而
 *   **自我压制**，仅 **54** 次真正注入」—— "nudge"（轻推）这个词暗示：
 *   ★ 它**不是**"模型自由裁量"，而是**插件按时机注入一句提示、模型再决定要不要调工具**。
 *   ⇒ 这两者差别巨大（前者无需判据，后者判据仍在插件手里）⇒ **必须读源码定论**。
 *
 * ★ 要抽三样：
 *   ① `acp-kernel/src/config.ts` 的 nudge 段（阈值真值）
 *   ② nudge 是怎么"推"给模型的（注入文本 / 工具描述）
 *   ③ 模型调的那个工具长什么样（它是 `compact` 工具还是别的）
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
console.log(`源文件 ${idx.size} 个\n`);

// ── ① 找出与 nudge / compress 有关的源文件 ──────────────────────────────
console.log("=== 源文件清单（含 nudge / compress / tool 的）===");
for (const [k, lines] of idx) {
  if (/nudge|compress|compact/i.test(k)) console.log(`  ${k}  (${lines.length} 行)`);
}

// ── ② nudge 的注入文本：搜关键词 ────────────────────────────────────────
console.log("\n=== 搜「nudge 是怎么推给模型的」===");
const PATTERNS = [
  { name: "注入文本（提到 compress/compact 的英文句子）", re: /(?:you (?:should|may|can)|consider|recommend)[^"'`\n]{0,120}(?:compress|compact)/i },
  { name: "nudge 字段名", re: /\bnudge[A-Za-z]*\b/ },
  { name: "growthRatio / growthFloor / growthCap", re: /growth(?:Ratio|Floor|Cap)\b/ },
  { name: "minPressureBenefit", re: /minPressureBenefit/ },
  { name: "maxContextLimitPct", re: /maxContextLimitPct/ },
];
for (const p of PATTERNS) {
  const hits = [];
  for (const [k, lines] of idx) {
    lines.forEach((t, i) => {
      if (p.re.test(t)) hits.push(`${k}:${i + 1}  ${t.trim().slice(0, 150)}`);
    });
  }
  console.log(`\n--- ${p.name}（${hits.length} 处，示前 12）---`);
  for (const h of hits.slice(0, 12)) console.log("  " + h);
}
