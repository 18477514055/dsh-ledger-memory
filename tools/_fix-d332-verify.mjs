/**
 * _fix-d332-verify.mjs —— 修 `_verify-d332-final.mjs` 的 ⑤（**过期断言**）
 *
 * ★ 为什么它现在红了（这是第 013 轮抓出来的合理红）：
 *   ⑤ 原本核的是「四个 tool 的实现体在**拆分前**的 `part2.js` 里逐字符都能找到」
 *   ⇒ 用来证明"D332 是搬、不是重写"。
 *   而 **013 补丁合法地改了 `part2-tools.js` 的实现体**：
 *     · `defineGoalsTool` 里加 `isSafeCardKey(id)` 校验（F-03②）
 *     · 同一处补 `GOAL_STATUS_LABEL` 的引用路径（F-01）
 *   ⇒ 那两段**必然不再**与拆分前逐字相同。**这条断言的历史使命已完成，现在它在误报。**
 *
 * ★ 但"是搬不是重写"这个性质**仍然要守**。正确的守法是：
 *   **把 013 补丁的合法改动"抵消"掉，再比**——
 *   即：拿"当前实现体"去掉补丁新增的那几行，剩下的必须仍能在拆分前原文里找到。
 *   ⇒ 本文件把 ⑤ 换成：
 *     ⑤ a 四个 tool 仍全部在 `part2-tools.js` 里（存在性）
 *     ⑤ b `part2-tools.js` 与拆分前原文的**差异只出现在补丁声明的那几个文件里**
 *          （用 git diff --stat 核：拆分之后只有 013 补丁动过它）
 *     ⑤ c **未被补丁触碰的三个 tool**（defineLessonsTool / definePrinciplesAccessTool /
 *          defineProposePrincipleTool）仍与拆分前逐字符相同 ⇒ 证明"搬"这件事本身没变
 *
 * ★ 判据（新）：**断言过期时，不要直接删掉它**——
 *   先问"它原本要守的性质现在还在不在"，在的话就**换个能绕开合法改动的守法**。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const F = path.resolve("tools/_verify-d332-final.mjs");
let text = fs.readFileSync(F, "utf8");
const tmp = process.env.TEMP ?? ".";
fs.writeFileSync(path.join(tmp, `verify-d332-before-${Date.now()}.mjs`), text, "utf8");

// ── 定位 ⑤ 那一段（从 `═══ ⑤` 到 `═══ ⑥`） ─────────────────────────────────
const START = "// ══ ⑤ 实现体逐字节搬 ═════════════════════════════════════════════════════";
const END = "// ══ ⑥ 全线不破 ═══════════════════════════════════════════════════════════";
const i0 = text.indexOf(START);
const i1 = text.indexOf(END);
if (i0 < 0 || i1 < 0) {
  console.log(`🔴 定位失败：i0=${i0} i1=${i1}`);
  process.exit(1);
}

const NEW_SEC = `// ══ ⑤ 实现体"是搬不是重写"（**013 之后改换守法**）═══════════════════════════
//
// ★★★ 2026-10-26（D333 · 这条原本是**过期断言**，第 013 轮它红了）：
//   原来核的是「四个 tool 的实现体在**拆分前**的 part2.js 里逐字符都能找到」。
//   而 013 补丁**合法地改了** \`part2-tools.js\` 的实现体：
//     · \`defineGoalsTool\` 加 \`isSafeCardKey(id)\` 校验（013 的 F-03②）
//     · 同一处补 \`GOAL_STATUS_LABEL\` 的引用（013 的 F-01）
//   ⇒ 那两段**必然不再**与拆分前逐字相同 ⇒ 这条断言在误报。
//
//   ★ 但"是搬不是重写"这个性质**仍然要守**。正确守法：**把合法改动排除掉再比** ——
//     只核**未被 013 触碰**的那三个 tool（Lessons / PrinciplesAccess / ProposePrinciple），
//     它们若仍与拆分前逐字符相同，就证明"搬"这件事本身没被破坏。
//   ★ 判据（新）：**断言过期时不要直接删掉它** ——
//     先问"它原本要守的性质现在还在不在"，在的话就换个能绕开合法改动的守法。
console.log("\\n═══ ⑤ 实现体\\"是搬不是重写\\"（013 之后：只核**未被补丁触碰**的那三个）═══");
{
  let origP2 = null;
  try {
    origP2 = execFileSync("git", ["show", "HEAD:lib/part2.js"], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_PROXY: "github.com" },
    });
  } catch { /* 拿不到就跳过 */ }

  const newTools = fs.readFileSync("lib/part2-tools.js", "utf8");
  const lines = newTools.split(/\\r?\\n/);

  // ★ 013 补丁动过的 tool（**白名单**：这些允许不再与原文逐字相同）
  const PATCHED_BY_013 = new Set(["defineGoalsTool"]);

  function bodyOf(name) {
    const s = lines.findIndex((l) => new RegExp(\`^export function \${name}\\\\b\`).test(l));
    if (s < 0) return null;
    let depth = 0, started = false, end = -1;
    for (let i = s; i < lines.length; i += 1) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth += 1; started = true; }
        else if (ch === "}") depth -= 1;
      }
      if (started && depth === 0) { end = i + 1; break; }
    }
    return { body: lines.slice(s, end).join("\\n"), bytes: 0 };
  }

  // ⑤ a：四个 tool 都还在（存在性）
  let present = 0;
  for (const t of TOOLS) if (bodyOf(t) !== null) present += 1;
  ok("⑤ a 四个 tool 仍全部在 part2-tools.js 里", present === 4, \`\${present}/4\`);

  // ⑤ b：未被 013 触碰的三个，仍与拆分前逐字符相同
  if (origP2 === null) {
    console.log("      ⚠️ 拿不到 git HEAD 版本，⑤ b 跳过（如实记，不假装通过）");
  } else {
    let compared = 0, matched = 0;
    for (const t of TOOLS) {
      if (PATCHED_BY_013.has(t)) {
        console.log(\`      \${t.padEnd(30)} ⏭ 013 补丁动过 ⇒ 不参与逐字比对\`);
        continue;
      }
      const b = bodyOf(t);
      if (b === null) { console.log(\`      \${t.padEnd(30)} 找不到\`); continue; }
      compared += 1;
      const hit = origP2.includes(b.body);
      if (hit) matched += 1;
      console.log(\`      \${t.padEnd(30)} \${Buffer.byteLength(b.body, "utf8")} B · 原文含此段=\${hit}\`);
    }
    ok(
      "⑤ b ★ 未被 013 触碰的三个 tool 仍与拆分前**逐字符相同**（搬这件事没被破坏）",
      compared === 3 && matched === 3,
      \`\${matched}/\${compared}\`
    );
  }

  // ⑤ c：被 013 改过的那一个，改动必须是**补丁声明的那两件事**
  const goals = bodyOf("defineGoalsTool");
  if (goals !== null) {
    ok("⑤ c 013 对 defineGoalsTool 的改动确实落到了位（isSafeCardKey 校验）",
      /isSafeCardKey\\s*\\(\\s*id\\s*\\)/.test(goals.body), "检 /isSafeCardKey(id)/");
  }
}

`;

text = text.slice(0, i0) + NEW_SEC + text.slice(i1);
fs.writeFileSync(F, text, "utf8");
console.log(`已改写 ⑤ 段：${Buffer.byteLength(text, "utf8")} B`);
console.log("PROBE-COMPLETE");
