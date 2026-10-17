/**
 * 探针（D210）—— **设置改了，快照真的送得出去吗？**
 *
 * ★★★ 我为什么要写这个探针（而不是直接改代码）：
 *   我的 D210 设计里写着「**值变了 ⇒ 文本变了 ⇒ 指纹变了 ⇒ 必然注出去**」。
 *   写代码前我去读了 `fingerprintOf`（lib/index.js:19229-19247），发现它
 *   **只哈希台账文件的字节**（`info.activeAbs` 的内容），**根本不看设置**。
 *   ⇒ 那条推理看着严密，但它把"**渲染出来的文本**"与"**参与去重的指纹**"
 *     当成了同一个东西 —— 这正是本项目的第 26 次「尺子错」候选。
 *
 * ★ 判据（本探针要回答的**唯一**问题）：
 *   在同一个会话里，**第一步**注入过之后，**只改设置、不动台账**，
 *   **第二步**还会不会注入？如果不会 ⇒ 我的设计前提是假的 ⇒
 *   D210 光在渲染层加一行**永远送不出去**。
 *
 * ★ 做法（走**真** pre-step 瀑布，不是读源码）：
 *   ① 建一个项目 + 台账；起真 ctx；跑第一步 pre-step（拿到注入，记住它含快照）；
 *   ② **把台账文件碰都不碰**，只改插件设置里一个**会进快照的值**（capsuleMaxChars）；
 *   ③ 再跑一次 pre-step，看**有没有新注入**、新注入里有没有"新值"。
 *
 * 跑法：node tools/_probe-d210-delivery-gap.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "lib", "index.js");

const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "probe-d210-home-"));
process.env.DSH_HOME = SANDBOX_HOME;

const mod = await import(pathToFileURL(ENTRY).href);

/**
 * 最小但**够真**的假 ctx。
 *
 * ★★★ 我第一版这个夹具**漏了 `ctx.inject` 和 `ctx.get`**（还写成 `get: undefined`）
 *   ⇒ `apply()` 第 19402 行当场抛 `ctx.inject is not a function`。
 *   ★ 这**不是发现**，是**夹具故障** —— 项目纪律第 6 条：
 *     「夹具没走通时，绝不能把夹具故障当成被测对象的问题」。
 *   ⇒ 探针必须**显式区分**这两者（下面 apply 的 try/catch 就是干这个的）。
 *
 * ★ 服务只给**够跑到 `agent/pre-step`** 的那些；拿不到的返回 undefined
 *   （插件对可选服务全部是 `ctx.get(name)` + 兜底，不会因此抛错）。
 */
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
    // ★ 官方语义：依赖不在 ⇒ **不执行 cb、也不抛错**。
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), "probe-d210-proj-"));
const LEDGER = "# 台账\n\n## 一、状态\n\n- 现状：探针夹具。\n";
fs.writeFileSync(path.join(root, "LEDGER.md"), LEDGER, "utf8");
fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });
fs.writeFileSync(
  path.join(root, ".dsh-ledger.json"),
  JSON.stringify(
    {
      version: 1,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_ledger-archive",
      maxActiveLines: 350,
      revision: 0,
    },
    null,
    2
  ),
  "utf8"
);

const run = makeCtx();
try {
  mod.apply(run.ctx, {});
} catch (e) {
  console.log("★ 探针**没跑起来**（apply 抛错）—— 这不是结论，是夹具故障：");
  console.log(String(e && e.stack ? e.stack : e));
  process.exit(2);
}

const sid = "probe-d210-delivery";
const agent = {
  session: {
    header: { id: sid, cwd: root },
    requestContext: () => ({ contextWindow: 1000000 }),
  },
};

async function preStep(label) {
  const list = run.handlers.get("agent/pre-step") ?? [];
  if (list.length === 0) {
    console.log(`★ 探针**没跑起来**：没有 agent/pre-step handler（夹具故障，不是结论）`);
    process.exit(2);
  }
  let decision = { messages: [] };
  for (const h of list) {
    decision = await h({ agent, messages: [] }, async () => decision);
  }
  const text = (decision.messages ?? [])
    .map((m) => (m.content ?? []).map((c) => c.text ?? "").join(""))
    .join("\n");
  console.log(`\n──── ${label} ────`);
  console.log(`  注入条数 = ${(decision.messages ?? []).length}｜文本长度 = ${text.length}`);
  const hit = text.split("\n").find((l) => l.includes("胶囊")) ?? "(无胶囊行)";
  console.log(`  快照里的「胶囊」行 = ${hit.trim()}`);
  return { text, n: (decision.messages ?? []).length };
}

console.log("════════ D210 探针：设置改了，快照送得出去吗？ ════════");
console.log(`项目根 = ${root}`);
console.log(`台账文件（探针**全程不改它**）= ${LEDGER.length} 字符`);

const d1 = await preStep("第 1 步（初始）");
const saw1 = /当前设置/.test(d1.text);
const sawChange1 = /设置刚改过/.test(d1.text);
console.log(`  ⇒ 含「当前设置」快照 = ${saw1}`);
console.log(`  ⇒ **首轮**含「设置刚改过」= ${sawChange1}（期望 false —— 首轮是"初识"不是"变更"）`);

// ★★★ 先把**改动之前的**指纹取下来（我第一版把两次都放在改动之后取，
//   于是它们当然相等 —— 那是个**空断言**，什么都没证明）。
const fpBefore = mod.__test.fingerprintOf(mod.__test.inspect(root));
// ★ 同时算出**旧版指纹**（只哈希台账字节）用来做反事实对照：
//   旧版 = `activeRel|activeLines|台账哈希`。这里用与实现同源的算法重算一遍。
const ledgerText = fs.readFileSync(path.join(root, "LEDGER.md"), "utf8");
let hOld = 0x811c9dc5;
for (let i = 0; i < ledgerText.length; i += 1) {
  hOld ^= ledgerText.charCodeAt(i);
  hOld = Math.imul(hOld, 0x01000193) >>> 0;
}
const fpOldBefore = `LEDGER.md|5|${hOld.toString(16)}`;

// ★★ 关键动作：**只改设置，不碰台账**。
//   为了确保"改的这项真的进了快照渲染"，选 `capsuleMaxChars`（快照第 6 行就印它）。
const after = 12345;
// ★★★ 改法必须与**真机面板保存**走同一条路：`setActiveSettings(...)`
//   —— 而**绝不能**再调一次 `mod.apply()`！
//   ★ 我第一版就是 `mod.apply(run.ctx, {...})`，而 `apply()` 开头是
//     `const state = newState()` ⇒ **指纹记忆被清空** ⇒ 第二次当然重注，
//     于是探针报出一个**假反例**（"设置改了确实注出去了"）。
//   ★ 这正是纪律第 8 条：**夹具的前提错了，全绿就是假绿**
//     （这里是"假红" —— 方向相反，但同样是夹具在骗人）。
//   真机面板保存的路径见 lib/index.js:7932（`setActiveSettings(check.value)`）。
mod.__test.setActiveSettings(mod.__test.settingsOf({ capsuleMaxChars: after }));

// 渲染层此刻是否已反映新值
// ★★★ 这里**绝不能**调 `renderSettingsSnapshot`！它是**会推进基线**的那个函数
//   （`settingsChangesOf` 在里面）—— 我第一版就是调了它 ⇒ 变更行被**探针自己消费掉**
//   ⇒ 第二步当然没有「设置刚改过」（探针把要测的东西吃掉了）。
//   ★ 判据：**观测者不许改变被观测对象**。用**纯渲染**（`settingsSnapshotLines`，不碰基线）。
const renderedPure = mod.__test.settingsSnapshotLines(mod.__test.inspect(root)).join("\n");
const renderedNew = renderedPure.includes(String(after));

// 指纹对比（这次 before 是**改动之前**取的，才有意义）
const fpAfter = mod.__test.fingerprintOf(mod.__test.inspect(root));
const fpOldAfter = `LEDGER.md|5|${hOld.toString(16)}`; // 台账一字未动 ⇒ 旧版指纹必然相同

const d2 = await preStep("第 2 步（只改了设置，台账一字未动）");
// ★ 第 3 步：**什么都不改** ⇒ 应当**没有注入**（零噪声），更不许再报一次"刚改过"。
const d3 = await preStep("第 3 步（什么都不改）");
const sawNewValue = d2.text.includes(String(after));
const sawChange2 = /设置刚改过/.test(d2.text);
const sawChange3 = /设置刚改过/.test(d3.text);
const changeLine = (d2.text.split("\n").find((l) => l.includes("设置刚改过")) ?? "(没有这一行)").trim();

console.log("\n════════ 结论 ════════");
console.log("【A. 渲染层：设置变了，快照文字跟着变了吗？】");
console.log(`  改后渲染里含新值 ${after} ......... ${renderedNew}`);
console.log("");
console.log("【B. 旧指纹（只哈希台账字节）—— 反事实对照】");
console.log(`  改前 ${fpOldBefore}`);
console.log(`  改后 ${fpOldAfter}`);
console.log(`  ⇒ 相同吗？ ${fpOldBefore === fpOldAfter ? "★ 完全相同 ⇒ 旧代码会 skip ⇒ 一个字都不注" : "不同"}`);
console.log("");
console.log("【C. 新指纹（D210 把设置快照正文也纳进来了）】");
console.log(`  改前 ${fpBefore}`);
console.log(`  改后 ${fpAfter}`);
console.log(`  ⇒ 不同吗？ ${fpBefore !== fpAfter ? "✅ 不同 ⇒ 会重注" : "★ 相同 ⇒ 还是不会重注"}`);
console.log("");
console.log("【D. 真跑 pre-step 的实况】");
console.log(`  第 1 步注入含快照 ............. ${saw1}`);
console.log(`  第 2 步**有没有**注入 ......... ${d2.n > 0 ? `有（${d2.n} 条）` : "★ 没有（n=0）"}`);
console.log(`  第 2 步注入里有没有新值 ${after} . ${sawNewValue}`);
console.log(`  第 2 步顶出「设置刚改过」吗 ... ${sawChange2}`);
console.log(`  ↑ 那一行逐字：${changeLine}`);
console.log("");
console.log("【E. 零噪声：什么都不再改】");
console.log(`  第 3 步注入条数 ............... ${d3.n}（期望 0 —— 没变化就不许注入）`);
console.log(`  第 3 步还报「设置刚改过」吗 ... ${sawChange3}（期望 false —— 只说一次）`);
console.log("");

const defectProof = fpOldBefore === fpOldAfter && d2.n > 0 && fpBefore !== fpAfter;
const noiseOk = d3.n === 0 && !sawChange3;
if (defectProof) {
  console.log("★★★ 结论（三件事同时成立才算证明）：");
  console.log("  ① 旧指纹对'设置变了'**完全瞎**（两次完全相同）；");
  console.log("  ② 新指纹**能看见**它（两次不同）；");
  console.log("  ③ 真跑第二步**确实注进去了，而且带着新值**。");
  console.log("  ⇒ 我 D210 设计里「值变⇒必然注出去」**原本是假的**（①就是证据），");
  console.log("     修在指纹上之后才成立 —— 光在渲染层加一行**等于没加**。");
  console.log("");
  console.log(noiseOk
    ? "★★★ 并且**零噪声**成立：不再变化时第 3 步一条都不注入、也不重报（用户要的「不影响工作」）。"
    : "★★ 但**零噪声不成立**：见【E】，第 3 步还有注入/还在重报 ⇒ 得继续修。");
  if (!noiseOk) process.exitCode = 1;
} else if (d2.n === 0) {
  console.log("★★★ 缺陷**仍然成立**：修了指纹还是没注出去 ⇒ 要另找原因。");
  process.exitCode = 1;
} else if (!sawChange2) {
  console.log("☆ 注进去了、也带新值，但**没顶出「设置刚改过」那一行** ⇒ 变更检测没生效。");
  process.exitCode = 1;
} else {
  console.log("☆ 三件事没同时成立（①②③里有假）—— 逐条看上面，别急着下结论。");
  process.exitCode = 1;
}

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
