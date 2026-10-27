/**
 * _cut-f07-logcollector.mjs —— D323：把 `createLogCollector`（part3，15,566 B，零本地依赖）搬出去。
 *
 * ★ 为什么挑它：量尺显示它是 part3 里**唯一「零本地依赖 + 万字节级」**的块。
 *   零本地依赖 = 它不调用 part3 里任何别的函数 ⇒ 不会造出 part3 ↔ 新模块的环。
 *
 * ★★ 判据：**逐字复制，不重写**。脚本不生成实现代码，只切片 + 拼 import 头 + 原地留转发。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "lib", "part3.js");
const OUT = path.join(ROOT, "lib", "log-collector.js");

const lines = fs.readFileSync(SRC, "utf8").split("\n");

// 定位起止（用**内容**定位，不用硬编码行号 —— 行号会漂）
const startIdx = lines.findIndex((l) => /^export function createLogCollector\(/.test(l));
if (startIdx < 0) {
  console.error("🔴 找不到 createLogCollector");
  process.exit(1);
}
// 结束：下一个顶层声明
let endIdx = startIdx + 1;
while (endIdx < lines.length && !/^(?:export )?(?:async )?function \w+|^(?:export )?const \w+\s*=/.test(lines[endIdx])) {
  endIdx++;
}
const block = lines.slice(startIdx, endIdx);
const blockText = block.join("\n");

console.log(`createLogCollector: 原文 L${startIdx + 1}–L${endIdx}，${Buffer.byteLength(blockText)} B`);

// 安全闸：块内不许出现 part3 的其他顶层函数名（那些会造环）
const PART3_NAMES = [
  "headOf",
  "flushBeforeCompact",
  "hardMaintenanceGateOn",
  "measurePressure",
  "shouldHandleSession",
  "writeMidTurnDiag",
  "renderInjectionBody",
  "renderPressureNotice",
  "pullTurnEndObligation",
  "rootFromExec",
  "renderResult",
  "isSubagentSession",
  "isLiveRootAgent",
];
const leaked = PART3_NAMES.filter((n) => new RegExp(`\\b${n}\\s*\\(`).test(blockText));
if (leaked.length > 0) {
  console.error(`🔴 块内调用了 part3 的函数：${leaked.join(", ")} —— 会造环，停止`);
  process.exit(1);
}

// 找出块内用到的**被 import 的名字**（决定新文件的 import 头）
const importedNames = new Set();
for (const l of lines) {
  const m = /^import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/.exec(l);
  if (m) for (const x of m[1].split(",")) {
    const t = x.trim().split(/\s+as\s+/).pop().trim();
    if (t) importedNames.add(t);
  }
}
const usedImported = [...importedNames].filter((n) => new RegExp(`\\b${n}\\b`).test(blockText));
// 找出它们各自来自哪个模块
const originOf = new Map();
for (const l of lines) {
  const m = /^import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/.exec(l);
  if (!m) continue;
  for (const x of m[1].split(",")) {
    const t = x.trim().split(/\s+as\s+/).pop().trim();
    if (t && usedImported.includes(t) && !originOf.has(t)) originOf.set(t, m[2]);
  }
}
const byModule = new Map();
for (const [n, from] of originOf) {
  if (!byModule.has(from)) byModule.set(from, []);
  byModule.get(from).push(n);
}
console.log("\n新文件需要的 import：");
for (const [from, ns] of byModule) console.log(`  ${from}: ${ns.sort().join(", ")}`);

// 需要 node 内建吗
const needsFs = /\bfs\./.test(blockText);
const needsPath = /\bpath\./.test(blockText);
console.log(`  node:fs=${needsFs}  node:path=${needsPath}`);

const header = `/**
 * log-collector.js —— 活动日志采集器（L0–L4）
 *
 * ★★★ 2026-10-25（D323 · 005 报告 F-07）：**从 \`part3.js\` 整块搬出**。
 *   判据：\`part3.js\` 已到 258,991 B / 262,144 B（**剩 3,153 B**），与 \`part2.js\`
 *   同属"贴线"状态。报告只点了 part2，但"贴线"是**结构问题**，不是单点问题。
 *
 * ★ 为什么挑这一段：量尺（\`tools/_measure-f07-e.mjs\`）显示它是 part3 里
 *   **唯一「零本地依赖 + 万字节级」**的块 —— 它不调用 part3 的任何其他函数
 *   ⇒ 搬走**不会**造出 part3 ↔ 新模块的环。
 *
 * ★★ 搬家方式：**逐字复制，不重写**（正文与原 L${startIdx + 1}–L${endIdx} 逐字相同）。
 * ★★ 调用面**零改动**：part3 原位置留 \`export { createLogCollector } from "./log-collector.js";\`。
 */
${needsFs ? 'import fs from "node:fs";' : ""}
${needsPath ? 'import path from "node:path";' : ""}
${[...byModule.entries()].map(([from, ns]) => `import { ${ns.sort().join(", ")} } from "${from}";`).join("\n")}

`;

const newFile = `${header}${blockText}\n`;
fs.writeFileSync(OUT, newFile, "utf8");
console.log(`\n✅ 写 ${OUT}（${Buffer.byteLength(newFile)} B）`);

// part3 原地换成转发
const reexport = [
  "// ★★★ 2026-10-25（D323 · 005 F-07）：`createLogCollector` 的实现已搬到 `log-collector.js`。",
  "//   为什么搬：`part3.js` 贴到 262,144 B 硬上限（剩 3,153 B），任何后续改动都会撞线。",
  "//   为什么这里留转发：**搬实现可以，改调用面不行**（D307/D318/D319）——",
  "//   `index.js` 与 `tools/` 里那些 `from \"./part3.js\"` 一个字都不用改。",
  'export { createLogCollector } from "./log-collector.js";',
].join("\n");

const rebuilt = [...lines.slice(0, startIdx), reexport, ...lines.slice(endIdx)].join("\n");
fs.writeFileSync(SRC, rebuilt, "utf8");
const CAP = 262144;
console.log(`✅ part3.js = ${Buffer.byteLength(rebuilt)} B（余 ${CAP - Buffer.byteLength(rebuilt)} B）`);
