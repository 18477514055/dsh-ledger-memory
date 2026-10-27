/**
 * _verify-d332-final.mjs —— D332 拆分的**最终验收**（一把尺子，一次跑完）
 *
 * ★ 为什么不继续改 `_probe-d331-012-sizes.mjs`：
 *   那个探针的历史使命是「核 012 报告的体积表是否属实」——**已经完成**（当时 21/21 逐字节相符，
 *   结论已进 `decisions/D330.md` 与台账）。现在补丁都打进去了，再拿它去核"修复前"必然不符。
 *   ⇒ 硬改它去兼容两种口径，只会让**一条判据同时管两件事**，下次谁也读不懂。
 *   ★ 判据（新）：**探针一旦"历史使命"完成，就不要再给它加模式开关；另写一条干净的。**
 *
 * 本脚本核 D332 该核的六件事：
 *   ① 模块数 = 22（D332 拆出 `part2-tools.js`）
 *   ② `part2.js` 体积与余量（拆前 241,272 / 余 392 ⇒ 拆后应 ≥ 30 KB 余量）
 *   ③ `part2-tools.js` 存在、可解析、四个 tool 都能构造
 *   ④ **调用面没改**：`index.js` 仍从 `./part2.js` import 这四个 tool（不是从新模块）
 *   ⑤ **实现体逐字节搬**：四个 tool 的正文与新模块里的正文逐字相同（用哈希比）
 *   ⑥ 全部 22 个模块都不破 262,144 硬限与 253,952 安全线
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const HARD = 262144;
const SOFT = 253952;
const TIGHT = 241664;

let pass = 0, fail = 0;
const FAILS = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${extra ? `  —— ${extra}` : ""}`); }
  else { fail += 1; FAILS.push(name); console.log(`  FAIL  ${name}${extra ? `  —— ${extra}` : ""}`); }
}

const TOOLS = ["defineGoalsTool", "defineLessonsTool", "definePrinciplesAccessTool", "defineProposePrincipleTool"];

// ══ ① 模块数 ══════════════════════════════════════════════════════════════
console.log("\n═══ ① 模块数 ═══");
const libFiles = fs.readdirSync("lib").filter((n) => n.endsWith(".js")).sort();
console.log(`  ${libFiles.length} 个：${libFiles.join(", ")}`);
ok("D332 后模块数 = 22（含新拆出的 part2-tools.js）", libFiles.length === 22, `实际 ${libFiles.length}`);
ok("part2-tools.js 存在", libFiles.includes("part2-tools.js"));

// ══ ② part2.js 体积 ══════════════════════════════════════════════════════
console.log("\n═══ ② part2.js 体积与余量 ═══");
const p2b = fs.statSync("lib/part2.js").size;
const toolsB = fs.statSync("lib/part2-tools.js").size;
console.log(`  part2.js       = ${p2b} B（距 241,664 红线余 ${TIGHT - p2b}；距硬限余 ${HARD - p2b}）`);
console.log(`  part2-tools.js = ${toolsB} B（距硬限余 ${HARD - toolsB}）`);
ok("★ part2.js 距 241,664 红线余量 ≥ 30,000 B（拆前只有 392）", TIGHT - p2b >= 30000, `余 ${TIGHT - p2b} B`);
ok("part2-tools.js 自己也不破 8 KiB 安全线", toolsB <= SOFT, `${toolsB} B`);

// ══ ③ 新模块可解析 + 四个 tool 可构造 ═════════════════════════════════════
console.log("\n═══ ③ 新模块可用性 ═══");
let checkOk = true;
try { execFileSync(process.execPath, ["--check", "lib/part2-tools.js"], { stdio: "pipe" }); }
catch { checkOk = false; }
ok("part2-tools.js 语法通过 node --check", checkOk);

const P2 = await import(pathToFileURL(path.resolve("lib/part2.js")).href);
let constructOk = true;
const names = [];
for (const t of TOOLS) {
  try {
    const r = P2[t]();
    if (typeof r?.name !== "string") constructOk = false;
    names.push(r?.name);
  } catch (e) {
    constructOk = false;
    console.log(`      ${t} 抛：${e.message}`);
  }
}
ok("四个 tool 经 `part2.js` 构造后都返回合法 name", constructOk && names.length === 4, names.join(", "));

// ══ ④ 调用面没改 ═════════════════════════════════════════════════════════
console.log("\n═══ ④ 调用面：index.js 仍从 part2.js import 这四个 tool ═══");
const idx = fs.readFileSync("lib/index.js", "utf8");
const p2text = fs.readFileSync("lib/part2.js", "utf8");
for (const t of TOOLS) {
  // 在 index.js 的 import 行里，这个 tool 必须与 from "./part2.js" 同一条语句
  const importStmt = new RegExp(`import\\s*\\{[^}]*\\b${t}\\b[^}]*\\}\\s*from\\s*["']\\./part2\\.js["']`, "s");
  ok(`index.js 仍从 "./part2.js" import ${t}`, importStmt.test(idx));
}
// 且 part2.js 里必须有转发导出
for (const t of TOOLS) {
  const fwd = new RegExp(`export\\s*\\{[^}]*\\b${t}\\b[^}]*\\}\\s*from\\s*["']\\./part2-tools\\.js["']`, "s");
  ok(`part2.js 有转发导出 ${t}`, fwd.test(p2text));
}

// ══ ⑤ 实现体"是搬不是重写"（**013 之后改换守法**）═══════════════════════════
//
// ★★★ 2026-10-26（D333 · 这条原本是**过期断言**，第 013 轮它红了）：
//   原来核的是「四个 tool 的实现体在**拆分前**的 part2.js 里逐字符都能找到」。
//   而 013 补丁**合法地改了** `part2-tools.js` 的实现体：
//     · `defineGoalsTool` 加 `isSafeCardKey(id)` 校验（013 的 F-03②）
//     · 同一处补 `GOAL_STATUS_LABEL` 的引用（013 的 F-01）
//   ⇒ 那两段**必然不再**与拆分前逐字相同 ⇒ 这条断言在误报。
//
//   ★ 但"是搬不是重写"这个性质**仍然要守**。正确守法：**把合法改动排除掉再比** ——
//     只核**未被 013 触碰**的那三个 tool（Lessons / PrinciplesAccess / ProposePrinciple），
//     它们若仍与拆分前逐字符相同，就证明"搬"这件事本身没被破坏。
//   ★ 判据（新）：**断言过期时不要直接删掉它** ——
//     先问"它原本要守的性质现在还在不在"，在的话就换个能绕开合法改动的守法。
console.log("\n═══ ⑤ 实现体\"是搬不是重写\"（013 之后：只核**未被补丁触碰**的那三个）═══");
{
  let origP2 = null;
  // ★★★ 必须钉住**拆分前**那个 commit。用 `HEAD:` 是错的 ——
  //   D332 已把拆分结果提交 ⇒ `HEAD:lib/part2.js` **就是拆分后的 206,654 B**，
  //   里面根本没有四个 tool ⇒ 逐字比对必然 0/4（我这条断言因此误报了一轮）。
  //   ★ 判据：**核"历史状态"必须钉住那个历史 commit，不能用 HEAD** ——
  //     HEAD 会随着你自己的提交往后走，断言于是"自动过期"。
  const PRE_SPLIT = "abe13c9"; // D330 收尾（D332 的父提交；part2.js 241,515 B，含全部四个 tool）
  try {
    origP2 = execFileSync("git", ["show", `${PRE_SPLIT}:lib/part2.js`], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_PROXY: "github.com" },
    });
    console.log(`      原文取自 ${PRE_SPLIT}:lib/part2.js（${Buffer.byteLength(origP2, "utf8")} B）`);
  } catch { origP2 = null; }

  const newTools = fs.readFileSync("lib/part2-tools.js", "utf8");
  const lines = newTools.split(/\r?\n/);

  // ★ 013 补丁动过的 tool（**白名单**：这些允许不再与原文逐字相同）
  const PATCHED_BY_013 = new Set(["defineGoalsTool"]);

  function bodyOf(name) {
    const s = lines.findIndex((l) => new RegExp(`^export function ${name}\\b`).test(l));
    if (s < 0) return null;
    let depth = 0, started = false, end = -1;
    for (let i = s; i < lines.length; i += 1) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth += 1; started = true; }
        else if (ch === "}") depth -= 1;
      }
      if (started && depth === 0) { end = i + 1; break; }
    }
    return { body: lines.slice(s, end).join("\n"), bytes: 0 };
  }

  // ⑤ a：四个 tool 都还在（存在性）
  let present = 0;
  for (const t of TOOLS) if (bodyOf(t) !== null) present += 1;
  ok("⑤ a 四个 tool 仍全部在 part2-tools.js 里", present === 4, `${present}/4`);

  // ⑤ b：未被 013 触碰的三个，仍与拆分前逐字符相同
  if (origP2 === null) {
    console.log("      ⚠️ 拿不到 git HEAD 版本，⑤ b 跳过（如实记，不假装通过）");
  } else {
    let compared = 0, matched = 0;
    for (const t of TOOLS) {
      if (PATCHED_BY_013.has(t)) {
        console.log(`      ${t.padEnd(30)} ⏭ 013 补丁动过 ⇒ 不参与逐字比对`);
        continue;
      }
      const b = bodyOf(t);
      if (b === null) { console.log(`      ${t.padEnd(30)} 找不到`); continue; }
      compared += 1;
      const hit = origP2.includes(b.body);
      if (hit) matched += 1;
      console.log(`      ${t.padEnd(30)} ${Buffer.byteLength(b.body, "utf8")} B · 原文含此段=${hit}`);
    }
    ok(
      "⑤ b ★ 未被 013 触碰的三个 tool 仍与拆分前**逐字符相同**（搬这件事没被破坏）",
      compared === 3 && matched === 3,
      `${matched}/${compared}`
    );
  }

  // ⑤ c：被 013 改过的那一个，改动必须是**补丁声明的那两件事**
  const goals = bodyOf("defineGoalsTool");
  if (goals !== null) {
    ok("⑤ c 013 对 defineGoalsTool 的改动确实落到了位（isSafeCardKey 校验）",
      /isSafeCardKey\s*\(\s*id\s*\)/.test(goals.body), "检 /isSafeCardKey(id)/");
  }
}

// ══ ⑥ 全线不破 ═══════════════════════════════════════════════════════════
console.log("\n═══ ⑥ 22 个模块全员过线 ═══");
const rows = libFiles.map((n) => ({ n, b: fs.statSync(path.join("lib", n)).size })).sort((a, b) => b.b - a.b);
const overHard = rows.filter((r) => r.b > HARD);
const overSoft = rows.filter((r) => r.b > SOFT);
console.log(`  最重的 5 个：${rows.slice(0, 5).map((r) => `${r.n}=${r.b}`).join(" · ")}`);
ok("无模块超 262,144 硬限", overHard.length === 0, overHard.map((r) => r.n).join(",") || "全部合规");
ok("无模块超 253,952 安全线", overSoft.length === 0, overSoft.map((r) => r.n).join(",") || "全部合规");

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  合计：PASS ${pass} · FAIL ${fail}`);
if (fail > 0) { console.log("  失败项："); for (const f of FAILS) console.log(`    - ${f}`); }
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
