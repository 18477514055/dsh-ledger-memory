/**
 * ★★★ 诊断 31a/31c：**把每一步的注入文本逐字打出来**，不再靠猜。
 *
 * ★ 为什么要这样（纪律 3 / 6）：我已经改了两轮夹具都在猜"哪一步注入了什么"，
 *   而每次红的是**夹具**还是**代码**都说不清。⇒ 直接把每一拍的注入打印出来。
 *
 * ★ 复刻夹具：`makeCtx` / `mkDeltaProj` / `mkDeltaAgent` / `priceNodes` 都在 selftest 里，
 *   这里**自己搭一套最小的**（只复刻与本诊断有关的部分）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账\\lib\\index.js";
const mod = await import("file:///" + SRC.replace(/\\/g, "/"));

// ── 最小夹具（照抄 selftest 的 makeCtx 关键部分）────────────────────────
const tmpRoot = path.join(os.tmpdir(), "diag31-" + Date.now());
fs.mkdirSync(tmpRoot, { recursive: true });
const root = path.join(tmpRoot, "proj");
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 目标\nX\n", "utf8");
fs.writeFileSync(
  path.join(root, ".dsh-ledger.json"),
  JSON.stringify({
    version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a",
    maxActiveLines: 300, logDir: "_ledger-log",
    logLevels: { L0: true, L1: true, L2: true, L3: false, L4: true }, revision: 0,
  }),
  "utf8"
);

const handlers = new Map();
const registeredTools = new Map();
const services = {};
let preStepHandler;

const ctx = {
  on(name, cb) {
    if (!handlers.has(name)) handlers.set(name, []);
    handlers.get(name).push(cb);
    if (name === "agent/pre-step") preStepHandler = cb;
  },
  get(k) {
    return services[k];
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  effect(cb) {
    return cb();
  },
  plugin() {},
};
// ★ 严格代理：只要 inject 声明过的服务就放行
const strict = new Proxy(ctx, {
  get(t, p) {
    if (typeof p === "symbol") return Reflect.get(t, p);
    return Reflect.get(t, p);
  },
});

const regionCalls = [];
services.compaction = {
  async compactRegion(start, end) {
    regionCalls.push({ start, end });
    return { shadowedSeqs: [start, end], shadowedTokenCount: 10, summarySeq: 99 };
  },
  async compactNow() {
    return { shadowedSeqs: [1], shadowedTokenCount: 10, summarySeq: 2 };
  },
};
services.tokenMeter = {
  _total: 0,
  _priced: [],
  measure(session) {
    return { totalTokens: this._total, nodes: this._priced };
  },
  nodes() {
    return this._priced;
  },
};
services.agentPresets = {
  serviceFor(agent, name) {
    return agent === undefined ? undefined : services[name];
  },
  composedPreset: () => "standard",
};

mod.apply(strict, {});

// 造 agent：8 轮 user/assistant(tool-call)/tool/result
const events = [];
let seq = 1;
for (let r = 0; r < 8; r++) {
  events.push({ type: "user/message", seq, data: { message: { role: "user", content: [] } } });
  seq++;
  events.push({ type: "assistant/message", seq, data: { message: { role: "assistant", content: [{ type: "tool-call", id: "c" + seq }] } } });
  seq++;
  events.push({ type: "tool/result", seq, data: { message: { role: "tool" } } });
  seq++;
}
const bySeq = new Map(events.map((e) => [e.seq, e]));
const nodes = events.map((e) => e.seq);
const sid = "session-diag31-0001";
const agent = {
  session: {
    header: { id: sid, cwd: root },
    id: sid,
    requestContext: () => ({ contextWindow: 1000 }),
    surface: { nodes },
    eventAt: (s) => bySeq.get(s),
  },
  steer() {},
};
services.tokenMeter._priced = nodes.map((s) => ({ seq: s, tokens: 40 }));

// 落盘一次（触发台账全文注入）
const write = registeredTools.get("ledger_write");
if (write !== undefined) {
  await write.execute({ target: "active", mode: "append", content: "- x\n" }, { agent, session: agent.session, callId: "c1" });
}

mod.__test.setAnchor({}, sid, 0.10);

const runStep = async (label, total) => {
  services.tokenMeter._total = total;
  const d = await preStepHandler({ agent, messages: [] }, async () => ({}));
  const txt = (d?.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
  const won = /建议你按需压一次/.test(txt);
  const tier = /上下文水位已到/.test(txt);
  const ledgerFull = /项目台账事实|LEDGER/.test(txt);
  console.log(`\n【${label}】水位=${total}  regionCalls=${regionCalls.length}`);
  console.log(`   轻推=${won ? "★ 有" : "无"} · 水位提醒=${tier ? "有" : "无"} · 台账全文=${ledgerFull ? "有" : "无"}`);
  console.log(`   注入长度=${txt.length}  前 120 字：${JSON.stringify(txt.slice(0, 120))}`);
  if (won) {
    const i = txt.indexOf("建议你按需压一次");
    console.log(`   ★ 轻推原文：${JSON.stringify(txt.slice(Math.max(0, i - 60), i + 260))}`);
  }
  return txt;
};

await runStep("步1（水位 310，跨 30% 档）", 310);
await runStep("步2（水位仍 310 ⇒ 无常规注入）", 310);
await runStep("步3（水位 330）", 330);
await runStep("步4（水位仍 330）", 330);
await runStep("步5（水位 520 ⇒ 兜底 42 点）", 520);

fs.rmSync(tmpRoot, { recursive: true, force: true });
