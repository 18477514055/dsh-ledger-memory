/**
 * 只读探针（D193 尺子修正用）：**81④ 那条否定式判据的匹配面到底该多宽？**
 *
 * 起因：`_probe-d193-reverse.mjs` 的 D 方向把 propose 的描述改回
 *   `"... you MUST call `" + CHECKPOINT_TOOL + "` so the user can authorize ..."`
 * —— 用的是**常量** `CHECKPOINT_TOOL`，而 81④ 只找字面量 `ledger_checkpoint`
 * ⇒ **摘了不红**（D 方向没能证伪 81④）。
 * ★ 这与 `LESSONS.md` L2 **同型**：匹配面太窄 ⇒ 判据对某类坏法**天生看不见**。
 *
 * ★★ 但在把匹配面放宽之前，**必须先在真实代码上试**：放宽后会不会**误报**
 * （真实源码里有没有别处 `CHECKPOINT_TOOL` 附近出现 "authoriz"）。
 * 这正是"先证明尺子对，再报结论"。
 *
 * 跑法：node tools/_probe-d193-ruler-width.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

function stripComments(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) {
        if (s[i] === "\n") out += "\n";
        i++;
      }
      i++;
    } else out += ch;
  }
  return out;
}

const raw = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
const code = stripComments(raw);
const lines = code.split("\n");

const bar = (s) => console.log(`\n${"═".repeat(76)}\n${s}\n${"═".repeat(76)}`);

// ── ① 现状：真实代码里两个 token 各出现在哪些**代码行**上 ────────────────
bar("① 真实代码（剥注释后）里两个 token 的代码行");
for (const tok of ["ledger_checkpoint", "CHECKPOINT_TOOL"]) {
  const hits = [];
  lines.forEach((l, i) => {
    if (l.includes(tok)) hits.push({ ln: i + 1, text: l.trim() });
  });
  console.log(`\n  ${tok}：出现 ${hits.length} 条代码行`);
  for (const h of hits) console.log(`    L${h.ln}: ${h.text.slice(0, 120)}`);
}

// ── ② 判据候选：各自的命中情况 ─────────────────────────────────────────
bar("② 三种匹配面在**当前（已修）代码**上的表现（都应为 false，否则误报）");
const cands = [
  ["窄（现状）：只认字面量", /ledger_checkpoint[\s\S]{0,240}?authoriz/i],
  ["宽：认字面量 **或** 常量", /(?:ledger_checkpoint|CHECKPOINT_TOOL)[\s\S]{0,240}?authoriz/i],
  ["最宽：认任一 token，窗口内出现 authorize/authorization", /(?:ledger_checkpoint|CHECKPOINT_TOOL)[\s\S]{0,300}?authoriz/i],
];
for (const [name, re] of cands) {
  const m = code.match(re);
  console.log(`  ${name}\n    ⇒ ${m === null ? "false ✅（当前代码没有死指引）" : `**true ❌ 误报**：${JSON.stringify(m[0].slice(0, 160))}`}`);
}

// ── ③ 关键：把"退化版"合成出来，看每种判据**能不能看见** ───────────────
bar("③ 退化版（模拟 reverse 探针 D 方向）—— 每种判据是否见红");
const DEGEN_LINE =
  '      "After calling this, you MUST call `" + CHECKPOINT_TOOL + "` so the user can authorize the proposal. " +';
console.log(`  退化行：${DEGEN_LINE.trim().slice(0, 110)}`);
const degen = code.replace(
  '      "`/ledger principles approve <id>` (to approve; approving needs no id to take the latest). " +',
  DEGEN_LINE
);
console.log(`  合成是否真的改到了：${degen !== code ? "✅ 是" : "❌ 否（锚点漂了）"}`);
if (degen === code) {
  console.log("  ⚠️ 锚点没命中 ⇒ 这一节说明不了问题（先修锚点）。");
} else {
  for (const [name, re] of cands) {
    const m = degen.match(re);
    console.log(`  ${name}\n    ⇒ ${m === null ? "false ❌ **看不见退化**" : "**true ✅ 见红**"}`);
  }
}

bar("结  论");
console.log("  判据要能看见**两种写法**（字面量 + 常量）—— 否则那类坏法天生不可见。");
console.log("  ★ 但同时要确认它在**当前代码**上是 false（上表 ②）—— 否则是把误报当成了修复。");
