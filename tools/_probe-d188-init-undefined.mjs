/**
 * ★★★★★ 只读取证（D188）：**`ledger_init` 的返回值里有 `undefined` ⇒ 活内核拒收**
 *
 * 真机现场（2026-10-14 01:05，**我本人调用的**）：
 *   `ledger_init({..., gitInit:false, gitignore:false})`
 *   ⇒ 内核回 **`Error: tool "ledger_init" returned invalid output: value is not lossless JSON`**
 *
 * ★ 怀疑：`ignoreResult` 在 `gitignore:false` 时是 `undefined`，
 *   而返回对象里写的是 `gitignore: ignoreResult`（**没有像 `staged` 那样做条件展开**）
 *   ⇒ 对象里出现 `undefined` 值 ⇒ **不是 lossless JSON** ⇒ DSH 拒收整个调用。
 *
 * ★ 判据：**直接调 `execute()`**，把返回对象的每个键的 `typeof` 打出来 ——
 *   ★ 为什么这条能证明：`JSON.stringify` 会**静默丢掉** `undefined`，
 *     所以我必须看**原始对象**，不能只看序列化结果（那正是"尺子"的选择问题）。
 *
 * ★★ 而这条**自检一定抓不到**：自检直接读 `r.ok`，从不喂给 DSH 的输出校验器
 *   ⇒ 典型的**假绿**（夹具绕过了真实的那一层）。这值得记一条纪律。
 *
 * 只读：只在临时目录里造项目，不碰本项目的任何文件。
 * 跑法：node tools/_probe-d188-init-undefined.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(HERE, "..", "lib", "index.js")).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d188-"));
fs.writeFileSync(path.join(tmp, "LEDGER.md"), "# 台账\n", "utf8");
fs.writeFileSync(path.join(tmp, "DECISIONS.md"), "# 决策\n", "utf8");

// ── 复刻自检里的假 ctx（严格模式：访问未声明服务立即抛）──
//   ★★ 第一版我漏了 `inject` ⇒ `apply()` 当场抛 `ctx.inject is not a function`。
//      那是**夹具故障**，绝不是被测对象的问题（纪律 6）——
//      正解是照自检的 `makeCtx` 补上（可选服务用官方的 `ctx.inject` 模式）。
const makeCtx = () => {
  const tools = new Map();
  const handlers = new Map();
  const ctx = {
    tools: {
      register: (t) => tools.set(t.name, t),
      get: (n) => tools.get(n),
    },
    on: (ev, h) => {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(h);
    },
    get: () => undefined,
    // ★ 官方形态：`inject(names, cb)` 把可选服务交回给回调；这里没有那些服务 ⇒ 不调 cb。
    inject: (_names, _cb) => ({ dispose() {} }),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  return { ctx, tools };
};

const run = makeCtx();
mod.apply(run.ctx, {});
const initTool = run.tools.get("ledger_init");

/** 找出返回对象里所有 `undefined` 值的键（★ 直看原始对象，不看序列化）。 */
function undefKeys(obj) {
  return Object.keys(obj).filter((k) => obj[k] === undefined);
}

for (const [label, args] of [
  ["A: gitignore:false（真机那次）", { active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a", gitInit: false, gitignore: false }],
  ["B: gitignore 省略（默认 true）", { active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a2", gitInit: false }],
  ["C: 带 goals（D187 新增路径）", { active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a3", goals: "GOALS.md", initialGoals: "# 目标\n", gitInit: false, gitignore: false }],
  ["D: 带 principles（真机那次用的参数）", { active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a4", goals: "GOALS.md", principles: "PRINCIPLES.md", gitInit: false, gitignore: false }],
]) {
  const sub = fs.mkdtempSync(path.join(os.tmpdir(), "d188-"));
  fs.writeFileSync(path.join(sub, "LEDGER.md"), "# 台账\n", "utf8");
  fs.writeFileSync(path.join(sub, "DECISIONS.md"), "# 决策\n", "utf8");
  const exec = { agent: { session: { header: { id: `s-${label.slice(0, 1)}`, cwd: sub } } } };
  let r;
  try {
    r = await initTool.execute(args, exec);
  } catch (e) {
    console.log(`\n${"═".repeat(74)}\n${label}\n${"═".repeat(74)}`);
    console.log(`  ✗ execute 抛错：${e?.message ?? e}`);
    continue;
  }
  const u = undefKeys(r);
  console.log(`\n${"═".repeat(74)}\n${label}\n${"═".repeat(74)}`);
  console.log(`  ok=${r.ok}`);
  console.log(`  ★ 值为 undefined 的键：${u.length === 0 ? "（无）" : u.join(", ")}`);
  if (u.length > 0) {
    console.log(`  ⇒ 这些键在 JSON 序列化后会**被静默丢掉**；`);
    console.log(`     而 DSH 的输出校验器要求 lossless JSON ⇒ **整个调用被拒**。`);
    console.log(`     实测序列化后还剩的键：${Object.keys(JSON.parse(JSON.stringify(r))).join(", ")}`);
  }
  // 无论上面如何，都把文件现状如实报出来（管线是"先写盘、后构造返回值"）
  const man = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(sub, ".dsh-ledger.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  console.log(`  清单：goals=${man?.goals} principles=${man?.principles}`);
}
console.log(`\n⇒ 临时目录（可自行清理）：${tmp}`);
