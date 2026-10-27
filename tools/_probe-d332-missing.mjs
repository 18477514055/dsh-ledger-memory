/**
 * _probe-d332-missing.mjs —— 找出新模块 `part2-tools.js` **真正缺的符号**
 *
 * ★ 起因（我的漏检，值得记）：
 *   拆分前我只扫了「函数体里引用了哪些 **part2 顶层名字**」，
 *   而 `GOAL_STATUSES` / `ROOT_PARAM` / `PRINCIPLE_AUTH_TTL_MS` / `LESSON_KINDS` 这些
 *   **不是 part2 自己声明的**——它们是 part2 从 `defs.js` 等**别处 import 进来**的。
 *   ⇒ 我的依赖清单只覆盖了"part2 自产的"，漏掉了"part2 转手的"。
 *
 * ★★★ 判据（新）：**搬模块时，依赖清单必须按「标识符」扫，不能按「谁声明的」扫。**
 *   正确做法：拿函数体里出现的**所有自由标识符**，逐个问"在新模块里它从哪来"。
 *
 * ★ 本探针不做推断，直接**真跑**每个 tool，把 `ReferenceError: X is not defined`
 *   里的 X 收集起来——这是运行时给的真答案，比静态猜硬。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const TOOLS = ["defineGoalsTool", "defineLessonsTool", "definePrinciplesAccessTool", "defineProposePrincipleTool"];

const P2 = await import(pathToFileURL(path.resolve("lib/part2.js")).href);

console.log("═══ 真跑每个 tool，收集 ReferenceError 里缺的符号 ═══");
const missing = new Set();
for (const t of TOOLS) {
  const fn = P2[t];
  try {
    fn();
    console.log(`  ${t.padEnd(30)} ✅ 不抛`);
  } catch (e) {
    const m = /^(\w+) is not defined$/.exec(e.message);
    console.log(`  ${t.padEnd(30)} ❌ ${e.message}`);
    if (m) missing.add(m[1]);
  }
}

// ★ 一次只暴露一个缺失符号（JS 执行到第一个 ReferenceError 就停），所以要多轮
console.log("\n═══ 多轮补齐（一直跑到不再出现 is not defined）═══");
const t2 = path.resolve("lib/part2-tools.js");
let round = 0;
const MAX = 12;
while (round < MAX) {
  round += 1;
  const mod = await import(pathToFileURL(t2).href + `?r=${round}`);
  const again = new Set();
  for (const name of TOOLS) {
    const fn = mod[name];
    try {
      fn();
    } catch (e) {
      const m = /^(\w+) is not defined$/.exec(e.message);
      if (m) again.add(m[1]);
    }
  }
  if (again.size === 0) { console.log(`  第 ${round} 轮：不再缺符号 ✅`); break; }
  console.log(`  第 ${round} 轮缺：${[...again].join(", ")}`);
  for (const n of again) missing.add(n);
  break; // 一次只修一轮，修完再跑本脚本
}

console.log(`\n═══ 共发现缺 ${missing.size} 个符号 ═══`);
for (const n of [...missing].sort()) console.log(`  ${n}`);

// ── 查它们各自在 part2.js 里从哪来 ────────────────────────────────────────
console.log(`\n═══ 这些符号在 part2.js 里的来源 ═══`);
const p2text = fs.readFileSync(path.resolve("lib/part2.js"), "utf8");
const p2lines = p2text.split(/\r?\n/);
for (const n of [...missing].sort()) {
  // ① 是不是 part2 自己声明的？
  const own = p2lines.findIndex((l) => new RegExp(`^(export\\s+)?(async\\s+)?(function|const|let)\\s+${n}\\b`).test(l));
  if (own >= 0) { console.log(`  ${n.padEnd(28)} ← **part2 自己声明**（第 ${own + 1} 行）`); continue; }
  // ② 是不是从某个模块 import 进来的？扫 import 块
  let found = null;
  for (let i = 0; i < Math.min(p2lines.length, 60); i += 1) {
    if (!/^import\s/.test(p2lines[i])) continue;
    // 收集这条 import 覆盖的行（可能多行）
    let j = i;
    let chunk = p2lines[i];
    while (!/from\s+["'][^"']+["']\s*;?\s*$/.test(chunk) && j + 1 < Math.min(p2lines.length, 60)) {
      j += 1;
      chunk += "\n" + p2lines[j];
    }
    if (new RegExp(`\\b${n}\\b`).test(chunk)) {
      const from = /from\s+["']([^"']+)["']/.exec(chunk)?.[1];
      found = { from, line: i + 1 };
      break;
    }
    i = j;
  }
  if (found) console.log(`  ${n.padEnd(28)} ← import 自 **${found.from}**（part2 第 ${found.line} 行）`);
  else console.log(`  ${n.padEnd(28)} 🔴 找不到来源（需人工查）`);
}

console.log("\nPROBE-COMPLETE");
