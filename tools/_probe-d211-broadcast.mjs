/**
 * 探针（D211）—— **"同项目、多个对话"时，变更提醒到底谁能收到？**
 *
 * ★★★ 为什么必须写这个探针（不是读代码猜）：
 *   用户问："模型每回合获得的设置清单……可否保证那个对话读到我们的改动，而不会被忽略。"
 *   我一读代码就起疑：D210 的变更基线 `settingsBaselines` 是**模块级 Map，按 projectRoot 存**
 *   —— 而**一个进程里所有对话共用同一个插件实例**。
 *   ⇒ 若真是按"项目根"共享，那么：**同一个项目的第二个对话永远看不到"设置刚改过"**
 *     （第一个对话渲染时就"消费"掉了）。★ 那**正是用户担心的那件事**。
 *
 * ★ 判据（本探针要回答的两个问题，都不许凭推理）：
 *   ① 同一项目、两个会话，改一次设置 ⇒ **两个会话是不是都能看到"刚改过"**？
 *   ② 重启（= 新模块实例）之后 ⇒ 改过的设置**还会不会被提一次**？
 *
 * 跑法：node tools/_probe-d211-broadcast.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "lib", "index.js");

const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "probe-d211-home-"));
process.env.DSH_HOME = SANDBOX_HOME;

/** 与自检同一形状的最小假 ctx（够跑到 `agent/pre-step`；可选服务走 ctx.get 兜底）。 */
function makeCtx() {
  const handlers = new Map();
  const services = {
    tokenMeter: {
      _total: 0,
      _window: 1000000,
      measure() {
        return { totalTokens: this._total, nodes: [] };
      },
    },
  };
  const declared = new Set(["tools"]);
  const ctx = {
    tools: { register: () => () => {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(ev, fn) {
      const list = handlers.get(ev) ?? [];
      list.push(fn);
      handlers.set(ev, list);
      return () => {};
    },
    inject(deps, cb) {
      for (const d of deps) if (!(d in services)) return undefined;
      for (const d of deps) declared.add(d);
      const scope = Object.create(ctx);
      for (const d of deps) scope[d] = services[d];
      return cb(scope);
    },
    get(key) {
      return services[key];
    },
  };
  return { ctx, handlers, services };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "probe-d211-proj-"));
fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 一、状态\n\n- 夹具。\n", "utf8");
fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });
fs.writeFileSync(
  path.join(root, ".dsh-ledger.json"),
  JSON.stringify(
    { version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", maxActiveLines: 350, revision: 0 },
    null,
    2
  ),
  "utf8"
);

const mkAgent = (sid) => ({
  session: { header: { id: sid, cwd: root }, requestContext: () => ({ contextWindow: 1000000 }) },
});

const textOf = (d) =>
  (d.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? "").join("")).join("\n");

/** 拿一个新的模块实例（`?v=` 让它绕过 ESM 缓存）—— 这就是「重启」的忠实模拟。 */
async function freshModule(tag) {
  const url = pathToFileURL(ENTRY).href + `?v=${tag}`;
  const m = await import(url);
  const run = makeCtx();
  m.apply(run.ctx, tag === "restart" ? { capsuleMaxChars: 12345 } : {});
  return { mod: m, run };
}

async function preStepOf(run, agent) {
  const list = run.handlers.get("agent/pre-step") ?? [];
  if (list.length === 0) {
    console.log("★ 探针没跑起来：没有 agent/pre-step handler（夹具故障，不是结论）");
    process.exit(2);
  }
  let decision = { messages: [] };
  for (const h of list) decision = await h({ agent, messages: [] }, async () => decision);
  return decision;
}

const NEWVAL = 12345;
console.log("════════ D211 探针：同项目多对话 / 重启，谁能收到变更提醒？ ════════");
console.log(`项目根（两个会话共用）= ${root}\n`);

// ═══ 问题 ①：同一项目、两个对话**都已经在跑** ══════════════════════════════
//   ★★★ 夹具要点（我第一版写错了、差点把自己的实现判成坏的）：
//     **两个对话都必须先渲染过一次**（各自立起基线），然后才改设置 ——
//     那才是"两个对话都已经在干活，这时改了标准"的真实场景。
//     若 B 在改动前从未渲染过，它的第一轮本来就是**「初识」（首轮不标）**，
//     那时看不到「刚改过」是**设计如此**，不是缺陷（纪律 8：夹具前提错了，结论就是假的）。
console.log("【①】同一项目 · 两个对话都已经在跑（各自先渲染一次）");
const inst = await freshModule("main");
const mod = inst.mod;
const A = mkAgent("sess-A");
const B = mkAgent("sess-B");

const a1 = textOf(await preStepOf(inst.run, A));
const b1 = textOf(await preStepOf(inst.run, B));
console.log(`  会话 A 首轮：${a1.length} 字符｜含「刚改过」=${/设置刚改过/.test(a1)}（期望 false —— 初识）`);
console.log(`  会话 B 首轮：${b1.length} 字符｜含「刚改过」=${/设置刚改过/.test(b1)}（期望 false —— 初识）`);

// ★ 只改设置，台账一字不动（走真机面板那条路 —— 绝不是重跑 apply()）
mod.__test.setActiveSettings(mod.__test.settingsOf({ capsuleMaxChars: NEWVAL }));

const a2 = textOf(await preStepOf(inst.run, A));
const b2 = textOf(await preStepOf(inst.run, B));
console.log(`\n  ★ 改设置之后（A 先渲染、B 后渲染）：`);
console.log(`  会话 A：${a2.length} 字符｜含新值=${a2.includes(String(NEWVAL))}｜含「刚改过」=${/设置刚改过/.test(a2)}`);
console.log(`  会话 B：${b2.length} 字符｜含新值=${b2.includes(String(NEWVAL))}｜含「刚改过」=${/设置刚改过/.test(b2)}`);
console.log("");

// ═══ 问题 ②：重启（新模块实例）之后 ═══════════════════════════════════════
console.log("【②】重启之后（新模块实例；配置里那个 12345 还在，因为它已落盘）");
const inst2 = await freshModule("restart");
const C = mkAgent("sess-C-after-restart");
const c1 = textOf(await preStepOf(inst2.run, C));
console.log(`  会话 C 重启后第 1 步：注入了 ${c1.length} 字符`);
console.log(`    含新值 ${NEWVAL} ........................... ${c1.includes(String(NEWVAL))}`);
console.log(`    含「设置刚改过」........................... ${/设置刚改过/.test(c1)}`);
console.log("    ★ 重启后基线是空的 ⇒ 各对话重新从「初识」开始，报的是**当前真值**（这正是要的）。");
console.log("");

// ═══ 结论 ══════════════════════════════════════════════════════════════════
const aSaw = /设置刚改过/.test(a2);
const bSaw = /设置刚改过/.test(b2);
console.log("════════ 结论 ════════");
console.log(`  ① 改一次设置：会话 A 看到「刚改过」=${aSaw} ；会话 B 看到「刚改过」=${bSaw}`);
if (aSaw && bSaw) {
  console.log("  ★★★ **修好了**：两个会话**各自**都收到了「设置刚改过」。");
  console.log("      基线现在按「项目根 + 对话 id」存 ⇒ 每个对话各报一次，不再互相消费。");
} else if (aSaw && !bSaw) {
  console.log("  ★★★ **缺口仍在**：会话 B 收不到 ⇒ 基线还是共享的。");
  process.exitCode = 1;
} else {
  console.log("  ☆ 与预期不符，逐条看上面。");
  process.exitCode = 1;
}
console.log("");
console.log(`  ② 重启后：会话 C 含新值=${c1.includes(String(NEWVAL))}，含「刚改过」=${/设置刚改过/.test(c1)}`);

// ═══ ③：面板按钮（广播）—— 这才是用户要的"主动注入" ═══════════════════════
console.log("");
console.log("【③】面板那颗「推送到所有对话」按钮（= 把广播序号 +1）");
// ★ 关键：广播序号是**模块级**的 ⇒ 必须用**同一个实例**（`inst2.mod`）来按，
//   否则按的是另一个实例的计数器、而被测的 `run2` 看的是它自己的那个（夹具会骗人）。
const preBtn = textOf(await preStepOf(inst2.run, C));
console.log(`  按按钮**之前**：会话 C 注入了 ${preBtn.length} 字符（期望 0 —— 刚看过，没变化）`);
const seq = inst2.mod.__test.bumpSettingsBroadcast();
const postBtn = textOf(await preStepOf(inst2.run, C));
console.log(`  按下按钮（序号 → ${seq}）之后：会话 C 注入了 ${postBtn.length} 字符`);
console.log(`    含「⚙️ 当前设置」快照 .................... ${/当前设置/.test(postBtn)}`);
const btnWorks = preBtn.length === 0 && postBtn.length > 0 && /当前设置/.test(postBtn);
console.log("");
if (btnWorks) {
  console.log("  ★★★ **按钮成立**：什么都没变的情况下，按一下 ⇒ **下一个回合必然重注快照**。");
  console.log("      ⇒ 这就是用户要的『主动向每个对话注入，保证它读到』。");
} else {
  console.log("  ☆ 按钮没按预期起作用 —— 看上面两行（before 应为 0、after 应 >0 且含快照）。");
  process.exitCode = 1;
}
console.log("");

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
