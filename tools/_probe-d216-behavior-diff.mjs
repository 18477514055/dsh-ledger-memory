// ═══════════════════════════════════════════════════════════════════════════
// D216 · 拆分前后**行为对照**：同一输入下，注入/状态是否一致
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么需要它：自检情形 3 报「期望注入 1 条、实际 0 条」——
//   那是**行为差异**，不是语法/import 问题。要点：
//     · 拆分**不该**改变任何行为（它是纯搬家）；
//     · 若行为变了，必须找到**确切的机制**，不许用"改断言让它过"来收场。
//
// ★ 本探针的做法：**同一个假 ctx、同一份假项目目录**，分别加载"原文件"与"拆分入口"，
//   跑 pre-step，把两侧的**可观测结果**摊在一起比。
//
// 用法：node tools/_probe-d216-behavior-diff.mjs <拆分目录>
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SPLIT = process.argv[2];
if (!SPLIT) {
  console.error("用法：node tools/_probe-d216-behavior-diff.mjs <拆分目录>");
  process.exit(2);
}
const ROOT = process.cwd();

/** 造一个"已初始化"的假项目（与自检情形 3 用的形状一致）。 */
function mkProject(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `d216-beh-${tag}-`));
  fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n做一个东西\n", "utf8");
  fs.writeFileSync(
    path.join(dir, ".dsh-ledger.json"),
    JSON.stringify(
      {
        version: 1,
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_ledger-archive",
        maxActiveLines: 150,
        createdAt: "2026-01-01 00:00",
        updatedAt: "2026-01-01 00:00",
      },
      null,
      2
    ),
    "utf8"
  );
  return dir;
}

/** 最小假 ctx（够 pre-step 走通即可）。★ 捕获 warn —— 注入失败会被 handler 静默吞掉。 */
function mkCtx(warns) {
  const registered = new Map();
  const hooks = new Map();
  const ctx = {
    logger: {
      info() {},
      warn(...a) {
        warns.push(a.map((x) => String(x)).join(" "));
      },
      error(...a) {
        warns.push("[error] " + a.map((x) => String(x)).join(" "));
      },
    },
    get(n) {
      if (n === "tools") return { register: (t) => registered.set(t.name, t) };
      return undefined;
    },
    on(ev, fn) {
      if (!hooks.has(ev)) hooks.set(ev, []);
      hooks.get(ev).push(fn);
    },
    inject(names, cb) {
      cb({});
    },
    effect(fn) {
      return fn();
    },
  };
  return { ctx, registered, hooks };
}

/** 跑一次 pre-step，返回 decision（含 messages 条数）+ 捕获的 warn。 */
async function preStep(mod, projectRoot, sid) {
  const warns = [];
  const run = mkCtx(warns);
  mod.apply(run.ctx, {});
  const agent = { session: { header: { id: sid, cwd: projectRoot } } };
  const fns = run.hooks.get("agent/pre-step") ?? [];
  let decision = { messages: [] };
  for (const fn of fns) {
    // ★★★ 真实签名是 `(payload, next)` —— `next()` 返回"到目前为止的决定"。
    //   我第一版只传了 payload ⇒ 两侧都抛 `TypeError: next is not a function`
    //   ⇒ ★ 那是**夹具故障**（纪律 6），差点被误读成"拆分导致的差异"。
    //   ⇒ 与 `selftest.mjs:586-593` 的 `runPreStep` 用**同一形状**。
    decision = await fn({ agent, messages: decision.messages ?? [] }, async () => decision);
  }
  return { decision, warns };
}

const results = [];
function report(label, a, b) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  results.push({ label, same, a, b });
  console.log(`${same ? "✅" : "❌"} ${label}\n     原文件: ${JSON.stringify(a)}\n     拆分后: ${JSON.stringify(b)}`);
}

// ── 加载两侧 ───────────────────────────────────────────────────────────────
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "d216-beh-home-"));
const original = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const split = await import(pathToFileURL(path.join(SPLIT, "lib", "index.js")).href);

// ── 导出面 ─────────────────────────────────────────────────────────────────
report("导出 name", original.name, split.name);
report("导出 inject", original.inject, split.inject);
report("导出 apply 类型", typeof original.apply, typeof split.apply);
report("导出 Config 类型", typeof original.Config, typeof split.Config);
report("__test 键数", Object.keys(original.__test ?? {}).length, Object.keys(split.__test ?? {}).length);
{
  const a = Object.keys(original.__test ?? {}).sort();
  const b = Object.keys(split.__test ?? {}).sort();
  const missing = a.filter((x) => !b.includes(x));
  const extra = b.filter((x) => !a.includes(x));
  report("__test 键集合一致", { missing, extra }, { missing: [], extra: [] });
}

// ── 行为：pre-step ─────────────────────────────────────────────────────────
for (const [tag, mod] of [
  ["原文件", original],
  ["拆分后", split],
]) {
  const dir = mkProject(tag === "原文件" ? "orig" : "split");
  try {
    const { decision: d, warns } = await preStep(mod, dir, `sid-${tag}`);
    console.log(`\n[${tag}] pre-step ⇒ messages ${d.messages.length} 条`);
    if (warns.length > 0) console.log(`        ⚠ 捕获的 warn（${warns.length} 条）：`);
    for (const w of warns.slice(0, 6)) console.log(`          ${w.slice(0, 300)}`);
    if (d.messages.length > 0) {
      const t = d.messages[0]?.content?.[0]?.text ?? "";
      console.log(`        含「做一个东西」=${t.includes("做一个东西")} 含「台账约定」=${t.includes("台账约定")} 长度=${t.length}`);
    }
    results.push({ label: `pre-step 条数（${tag}）`, n: d.messages.length });
    results.push({ label: `warn 条数（${tag}）`, n: warns.length });
  } catch (e) {
    console.log(`\n[${tag}] ❌ 抛错：${e.constructor.name}: ${String(e.message).split("\n")[0]}`);
    results.push({ label: `pre-step（${tag}）抛错`, err: String(e.message).split("\n")[0] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const a = results.find((r) => r.label === "pre-step 条数（原文件）");
const b = results.find((r) => r.label === "pre-step 条数（拆分后）");
if (a && b) report("★ pre-step 注入条数一致", a.n, b.n);
{
  const wa = results.find((r) => r.label === "warn 条数（原文件）");
  const wb = results.find((r) => r.label === "warn 条数（拆分后）");
  if (wa && wb) report("★ 捕获的 warn 条数一致", wa.n, wb.n);
}

const bad = results.filter((r) => r.same === false || r.err !== undefined);
console.log(`\n不一致项：${bad.length} / ${results.length}`);
