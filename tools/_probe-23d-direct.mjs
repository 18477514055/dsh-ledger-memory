/**
 * ★★★ 情形 23d 的**直接验证**（不绕 pre-step 全链路）：
 *   **没有注入的那一步，全量会不会排队？**
 *
 * ★ 为什么不用 selftest 的全链路夹具：那个夹具要把"真的没有注入"造出来，
 *   而实测发现**很难** —— 三个耦合：
 *     ① `PRESSURE_TIERS=[0.3,0.5,0.7]`（水位跨档就发提醒，提醒本身是注入）
 *     ② `highFidelityCompactRatio` 被 `normalizeSettings` **夹在 [0.5,0.79]**
 *        ⇒ 全量线**必然 ≥ 第一档** ⇒ "过线但一档没跨"**数学上不存在**
 *     ③ 落盘会改台账 ⇒ 指纹变 ⇒ 紧接一步必重注全文
 *   我为此耗了约 8 轮（纪律第 6 条：**夹具没走通时先怀疑夹具**）。
 *
 * ⇒ 换成**直接判据**：只问一个可证伪的问题 ——
 *   **当 `text` 为空、而水位 ≥ 全量线时，那段探针会不会把它撑起来、并真的排进队列？**
 *   做法：复用插件的**真实 handler**（`agent/pre-step`），但用一个**只读的** ctx，
 *   并在调用前后读 `hfCompactAfterTurn`（经 `ledger_status` 或直接观察 `compacted`）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "d23d-home-"));
process.env.DSH_HOME = HOME;
const mod = await import(pathToFileURL(path.resolve("lib/index.js")).href + "?x=" + Date.now());

const root = fs.mkdtempSync(path.join(os.tmpdir(), "d23d-proj-"));
fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n- x\n", "utf8");
fs.writeFileSync(path.join(root, "DECISIONS.md"), "# 决策\n", "utf8");
fs.writeFileSync(
  path.join(root, ".dsh-ledger.json"),
  JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a", logDir: "_l", maxActiveLines: 300, revision: 0 }),
  "utf8"
);

const handlers = new Map();
const tools = new Map();
const compacted = [];
const svc = {
  tokenMeter: { _total: 0, measure() { return { totalTokens: this._total, nodes: [] }; } },
  compaction: {
    async compactNow() { compacted.push("now"); return { ok: true }; },
    async compactRegion() { compacted.push("region"); return { ok: true }; },
  },
  userQuestions: { ask: () => {} },
  tokenMeterOk: true,
};
const ctx = {
  on: (n, h) => { if (!handlers.has(n)) handlers.set(n, []); handlers.get(n).push(h); },
  logger: { warn: () => {}, info: () => {} },
  get: (n) => svc[n],
  inject: (deps, fn) => { try { fn(ctx); } catch { /* 可选服务 */ } },
  tools: { register: (t) => { tools.set(t.name, t); return () => {}; } },
  commands: { register: () => () => {} },
};
mod.apply(ctx, {});

const sid = "session-23d-direct";
const agent = {
  session: {
    header: { id: sid, cwd: root },
    id: sid,
    requestContext: () => ({ contextWindow: 1000 }),
    surface: { nodes: [] },
    eventAt: () => undefined,
    log: [],
  },
  steer: () => {},
};
const preStep = async (messages = []) => {
  let d = { messages };
  for (const h of handlers.get("agent/pre-step") ?? []) d = await h({ agent, messages }, async () => d);
  return d;
};
const textOf = (d) => (d.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");

console.log("═".repeat(92));
console.log("直接验证：**无注入 + 水位过全量线** ⇒ 全量该不该排队");
console.log("═".repeat(92));
const LINE = 0.7; // 默认全量线
console.log(`  全量线（默认）= ${LINE} · 提醒档 = [0.3, 0.5, 0.7]`);

// ── A. 先造出"档位提醒都发完 + 指纹已立"的状态 ─────────────────────────────
svc.tokenMeter._total = 750;
const a1 = await preStep([]);
console.log(`\n  A. 第 1 步（水位 75%）→ 注入 ${textOf(a1).length} 字符（提醒/台账，正常）`);

// 落盘 + idle（消费队列），再把落盘引起的重注吃掉
const w = tools.get("ledger_write");
if (w !== undefined) {
  await w.execute({ target: "active", mode: "replace", content: "# 台账\n\n- 落盘\n" }, { agent, session: agent.session, callId: "c1" });
}
for (const h of handlers.get("agent/status") ?? []) await h({ agent, status: "idle" });
const a2 = await preStep([]);
console.log(`  B. 第 2 步（吃掉落盘重注）→ 注入 ${textOf(a2).length} 字符`);

// ── C. 现在这一步：水位仍 0.75、什么都不变 ⇒ 期望"真的没有常规注入" ────────
const before = compacted.length;
const c = await preStep([]);
const t = textOf(c);
const hasLedger = /belong to THIS conversation's working directory/.test(t);
const hasTier = /上下文水位已到/.test(t);
const hasSelfStart = /本插件注意到水位已到/.test(t);
const hasQueued = /即将执行一次高保真压缩/.test(t);
console.log(`\n  C. 第 3 步（水位仍 75%、什么都不变）：`);
console.log(`     注入长度 ${t.length} 字符`);
console.log(`     含台账全文 = ${hasLedger} · 含档位提醒 = ${hasTier}`);
console.log(`     ★ 含「本插件自己起了一次」= ${hasSelfStart}`);
console.log(`     ★ 含「即将执行一次高保真压缩」= ${hasQueued}`);
console.log(`     注入首 120 字：${t.replace(/\s+/g, " ").slice(0, 120)}`);

console.log("\n" + "═".repeat(92));
console.log("结论");
console.log("═".repeat(92));
if (!hasLedger && !hasTier) {
  console.log("  ✅ 真的造出了「**无常规注入**」那一步。");
  console.log(`     ⇒ 自造注入 = ${hasSelfStart ? "✅ 有（修复生效）" : "❌ 无（修复没生效）"}`);
  console.log(`     ⇒ 排队宣告 = ${hasQueued ? "✅ 有（真走到排队）" : "❌ 无"}`);
} else {
  console.log("  ⚠️ 这一步**仍有**常规注入（台账/提醒）⇒ 本验证**未能造出目标场景**。");
  console.log("     ⇒ 按纪律第 6 条：**夹具没走通，不下关于被测对象的结论**。");
  console.log("     ⇒ 已如实记录：这一条在没有更好的造法之前，**保持未验证**。");
}
console.log(`\n  （补偿性证据）本轮 idle 段共压过 ${compacted.length} 次：${compacted.join(", ")}`);
