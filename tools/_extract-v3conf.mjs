#!/usr/bin/env node
/**
 * 把段从 part2.js 里抽进 lib/v3-conformance.js（一次性脚本）。
 * ★ 用 Node 文件 + 反引号模板，**不在 `node -e` 里拼引号**（本项目栽过约 30 次）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ★ 必须用 fileURLToPath —— `new URL().pathname` 在含中文的路径上会给出 %XX 编码
//   （我第一版就是这么错的：ENOENT ... %E5%B7%A5%E4%BD%9C）。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "..");
const PART2 = path.join(PROJECT, "lib", "part2.js");
const OUT = path.join(PROJECT, "lib", "v3-conformance.js");

const s = fs.readFileSync(PART2, "utf8");
const START = "  // ── ★★★★★ 2026-10-23（D310，审计员010 F-07 实锤）：**V3 核心机制专项体检**";
const END = "  // ── 以下都**只提示、不影响判定** ─";
const a = s.indexOf(START);
const b = s.indexOf(END);
if (a < 0 || b < 0 || b <= a) throw new Error(`定位失败：a=${a} b=${b}`);

let block = s.slice(a, b);
// ── 把块内对 info.xxx 的引用改成局部别名（本文件不 import partN）──────
block = block.replace(/\binfo\.projectRoot\b/g, "projectRoot");
block = block.replace(/\binfo\.manifest\b/g, "manifest");
block = block.replace(/\binfo\.memoryRoot\b/g, "memoryRoot");
block = block.replace(/\binfo\.unsafePaths\b/g, "unsafePaths");
block = block.replace(/memoryBaseOf\(info, projectRoot\)/g, "deps.memoryBaseOf(info, projectRoot)");
block = block.replace(/verifyManifestMirror\(projectRoot, manifest, mtext\)/g, "verifyManifestMirror(projectRoot, manifest, mtext)");
// 去掉块首那行 ── 标题（新文件的文档头里有完整说明）
block = block.replace(/^  \/\/ ── [^\n]*\n/, "");
// 去掉块尾的收尾 `  }`（原来是 `if (...) { ... }` 的右括号，新函数不需要）
block = block.replace(/\n?  \}\s*$/, "\n");

const header = `/**
 * ★★★★★ 2026-10-23（D310，审计员010 第二份报告 F-07 实锤）：**V3 核心机制的合规体检**。
 *
 * 从 \`part2.js\` 的 \`conformanceOf\` 里**抽出来**（两个理由都成立）：
 *   ① \`part2.js\` 只剩 **3512 B** 余量（硬上限 262,144 B）—— 这段 4.5KB 塞不下；
 *   ② 更重要的是**语义**：这一整块回答的是「第 3 代的四项保障在不在」，
 *      与 \`conformanceOf\` 里那一大堆「V2 登记资产在不在」本来就不是一回事。
 *
 * 🔴 抽出来之前它压根不存在 —— 实测四条**全绿**：删掉 SECURITY.md / 清空 .gitignore /
 *   把镜像改 stale / 让清单路径越界，\`verdict\` 都还是 \`ok\`、\`reasons\` 都还是空。
 *   ⇒ 合规检查号称"体检医生"，可这四项正是**数据泄露风险**所在。
 *
 * ★ 它是**叶子模块**（只依赖 node 内建 + manifest-mirror）⇒ 不改 \`lib/\` 那张成环 import 图的求值顺序。
 * ★ 返回 \`{reasons, fixable}\`：调用方并进自己的数组。
 *   **故意不返回 \`needsAI\`** —— 这四项全都能机械修补（建文件 / 补一行 / 重写镜像 / 改键），
 *   按本项目纪律该进 \`fixable\`；进了 \`needsAI\` 就把「补个文件」报成「要 AI 决定」。
 */

import fs from "node:fs";
import path from "node:path";
import { verifyManifestMirror } from "./manifest-mirror.js";

/**
 * @param {object} info \`inspect()\` 的结果
 * @param {{memoryBaseOf:(info:object, fallback:string)=>string}} deps 注入项（避免本模块 import partN）
 * @returns {{reasons:string[], fixable:string[]}}
 */
export function v3ConformanceGaps(info, deps) {
  const reasons = [];
  const fixable = [];
  const projectRoot = info.projectRoot;
  const memoryRoot = info.memoryRoot;
  const manifest = info.manifest;
  const unsafePaths = info.unsafePaths;
`;

fs.writeFileSync(OUT, `${header}${block}  return { reasons, fixable };\n}\n`, "utf8");
console.log(`已写 ${OUT}（${fs.statSync(OUT).size} B）`);
console.log("—— 去掉块之后 part2.js 会少 4487 B ——");
