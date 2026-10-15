// ═══════════════════════════════════════════════════════════════════════════
// D216 · **拆分可行性的最小实验**（在 %TEMP% 里做，绝不碰真源码）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么必须先做这个实验（本项目纪律 8：**夹具前提错了，全绿就是假绿**）：
//   实测整个 `lib/index.js` 是**一个大环**（213 声明 / 82.5%）⇒ "按依赖分层拆"根本做不到。
//   于是整个拆分**只剩一条路**：靠 ESM 的这条语义 ——
//     **`function` 声明在"模块实例化"阶段就初始化（提升），`const`/`let`/`class` 不是。**
//   ⇒ 若它为真：环里只要"顶层只读对方的函数"，就能安全互引。
//   ⇒ 若它为假：拆分方案当场作废，必须换路。
//   ★ **这种"整件事押在一条语义上"的判断，绝不许凭记忆下结论。**
//
// 四组实验（每组都要有**明确的期望**，其中 B/E 是**负对照** —— 它们必须失败）：
//   A 正：环里 A 的顶层 const 读 B 的**函数** ⇒ **应当成功**
//   B 负：环里 A 的顶层 const 读 B 的**const** ⇒ **应当 TDZ 报错**（证明 A 的成功不是巧合）
//   C 正：环里双方只在**函数体内**互调 ⇒ 应当成功
//   D 负：给 import 进来的 `let` 赋值 ⇒ **应当 TypeError**（ESM 禁止）
//
// 用法：node tools/_probe-d216-esm-mechanism.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "d216-esm-"));
const results = [];

function write(name, text) {
  fs.writeFileSync(path.join(DIR, name), text, "utf8");
}

function run(entry, args = []) {
  try {
    const out = execFileSync(process.execPath, [path.join(DIR, entry), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? "").trim(), err: String(e.stderr ?? e.message).trim() };
  }
}

function check(name, cond, detail) {
  results.push({ name, ok: cond, detail });
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? " —— " + detail : ""}`);
}

// ── 实验 A：环里，顶层 const 读**对方的函数**（期望成功）────────────────────
write(
  "a.mjs",
  `import { fb } from "./b.mjs";
export const A = { call: fb };          // ★ 顶层立刻读对方**函数**
export function fa() { return "fa"; }
`
);
write(
  "b.mjs",
  `import { fa } from "./a.mjs";
export const B = { call: fa };          // ★ 顶层立刻读对方**函数**
export function fb() { return "fb"; }
`
);
write("entry-a.mjs", `import { A } from "./a.mjs";\nimport { B } from "./b.mjs";\nconsole.log(A.call(), B.call());\n`);
{
  const r = run("entry-a.mjs");
  check(
    "A 正对照：环里顶层 const 读对方的 **function** ⇒ 成功",
    r.ok && r.out.includes("fb") && r.out.includes("fa"),
    r.ok ? `输出「${r.out}」` : `失败：${r.err.split("\n")[0]}`
  );
}

// ── 实验 B：环里，顶层 const 读**对方的 const**（负对照：期望 TDZ 报错）──────
write(
  "c.mjs",
  `import { K } from "./d.mjs";
export const C = { k: K };              // ★ 顶层读对方 **const** ⇒ 期望炸
export const CK = "ck";
`
);
write(
  "d.mjs",
  `import { CK } from "./c.mjs";
export const D = { k: CK };             // ★ 同上
export const K = "k";
`
);
write("entry-b.mjs", `import { C } from "./c.mjs";\nconsole.log("不应该到这里", C);\n`);
{
  const r = run("entry-b.mjs");
  const isTdz = /before initialization|Cannot access/.test(r.err ?? "");
  check(
    "B 负对照：环里顶层 const 读对方的 **const** ⇒ 必须 TDZ 报错（证明 A 不是巧合）",
    !r.ok && isTdz,
    r.ok ? "⚠ 竟然成功了 —— 说明我对语义的理解有误，方案必须重估" : (isTdz ? "如期 TDZ" : `失败但不是 TDZ：${(r.err ?? "").split("\n")[0]}`)
  );
}

// ── 实验 C：环里双方只在**函数体内**互调（期望成功）─────────────────────────
write("e.mjs", `import { fd } from "./f.mjs";\nexport function fe() { return "e+" + fd(); }\n`);
write("f.mjs", `import { fe } from "./e.mjs";\nexport function fd() { return "d"; }\nexport function fd2() { return fe(); }\n`);
write("entry-c.mjs", `import { fe } from "./e.mjs";\nimport { fd2 } from "./f.mjs";\nconsole.log(fe(), fd2());\n`);
{
  const r = run("entry-c.mjs");
  check("C 正对照：环里只在**函数体**里互调 ⇒ 成功", r.ok && r.out.includes("e+d"), r.ok ? `输出「${r.out}」` : `失败：${r.err.split("\n")[0]}`);
}

// ── 实验 D：给 import 进来的 `let` 赋值（负对照：期望 TypeError）──────────────
write("g.mjs", `export let counter = 0;\nexport function bump() { counter += 1; }   // ★ 在**自己模块内**改 ⇒ 合法\n`);
write("h.mjs", `import { counter, bump } from "./g.mjs";\nexport function tryAssign() { counter = 99; }  // ★ 给 import 的绑定赋值 ⇒ 期望 TypeError\nexport function ok() { bump(); return counter; }\n`);
write("entry-d.mjs", `import { tryAssign, ok } from "./h.mjs";\nconsole.log("自己模块内改：", ok());\ntry { tryAssign(); console.log("居然能赋值！"); } catch (e) { console.log("按预期抛错：", e.constructor.name); }\n`);
{
  const r = run("entry-d.mjs");
  check(
    "D 负对照：给 **import 进来的 `let`** 赋值 ⇒ 必须 TypeError（自己模块内改则合法）",
    r.ok && r.out.includes("自己模块内改： 1") && r.out.includes("TypeError"),
    r.ok ? r.out.replace(/\n/g, " | ") : `失败：${r.err.split("\n")[0]}`
  );
}

// ── 实验 E：`export { X } from "./m.js"` 的**中转导出**（期望成功）───────────
write("i.mjs", `export const __test = { hello: () => "from-i" };\nexport function helper() { return "h"; }\n`);
write("j.mjs", `export { __test } from "./i.mjs";\nimport { helper } from "./i.mjs";\nexport const J = helper();\n`);
write("entry-e.mjs", `import { __test } from "./j.mjs";\nconsole.log(typeof __test.hello, __test.hello());\n`);
{
  const r = run("entry-e.mjs");
  check("E 入口模块可**中转导出**被搬走的 `__test`（selftest 靠这个）", r.ok && r.out.includes("from-i"), r.ok ? `输出「${r.out}」` : `失败：${r.err.split("\n")[0]}`);
}

fs.rmSync(DIR, { recursive: true, force: true });
const bad = results.filter((r) => !r.ok);
console.log(`\n结果：通过 ${results.length - bad.length} / ${results.length}`);
if (bad.length > 0) {
  console.log("★ 机制与预期不符 ⇒ **拆分方案必须重估**，不许硬上。");
  process.exitCode = 1;
} else {
  console.log("✅ 机制确认：**环里顶层只读函数是安全的**；const 互读会炸；import 的 let 不能赋值。");
  console.log("   ⇒ 拆分路线：把函数按主题分模块（允许环），4 个可变 let 与其**改它的函数同模块**。");
}
