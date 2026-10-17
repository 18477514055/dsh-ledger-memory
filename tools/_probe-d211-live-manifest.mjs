/**
 * 探针（D211 之二）—— **改了项目清单，旧对话下一次说话时能不能立刻跟上？**
 *
 * ★★★ 为什么这是关键事实（用户在问的就是它）：
 *   面板上我写了「⚠ 只影响新项目」的那些项（`scopeNote: "project-first"`）——
 *   用户问："**不能对旧的对话生效吗？有没有方案让他在旧的对话也随时更新？**"
 *
 *   ★ 代码上我读到：`agent/pre-step` 里头**每一步**都调 `inspect(root)`，
 *     而 `inspect()` 每一步都**现读** `.dsh-ledger.json`（`readManifest`）。
 *     ⇒ 若真是这样，那么**改清单 = 下一次说话就生效**，**不必重启、不必新对话**。
 *   ★★ 但"我读到"不算证据（纪律 9：函数名+行号最容易凭印象编）⇒ **真跑一遍**。
 *
 * ★ 判据（要回答的唯一问题）：
 *   在**同一个会话、同一个进程**里，**只改项目清单文件**（不重启、不调 apply），
 *   **下一步注入里的生效值会不会跟着变**？
 *
 * 跑法：node tools/_probe-d211-live-manifest.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "lib", "index.js");

const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "probe-d211b-home-"));
process.env.DSH_HOME = SANDBOX_HOME;

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "probe-d211b-proj-"));
const MANIFEST = path.join(root, ".dsh-ledger.json");
fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 一、状态\n\n- 夹具。\n", "utf8");
fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });

/** 写清单（就是"改一个 project-first 项"这个动作）。 */
function writeManifest(maxActiveLines) {
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        version: 1,
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_ledger-archive",
        maxActiveLines,
        revision: 0,
      },
      null,
      2
    ),
    "utf8"
  );
}
writeManifest(350);

const mod = (await import(pathToFileURL(ENTRY).href)).default ?? (await import(pathToFileURL(ENTRY).href));
const m = await import(pathToFileURL(ENTRY).href);
const run = makeCtx();
m.apply(run.ctx, {});

const agent = {
  session: { header: { id: "sess-live", cwd: root }, requestContext: () => ({ contextWindow: 1000000 }) },
};

async function preStep() {
  const list = run.handlers.get("agent/pre-step") ?? [];
  if (list.length === 0) {
    console.log("★ 探针没跑起来：没有 agent/pre-step handler（夹具故障，不是结论）");
    process.exit(2);
  }
  let decision = { messages: [] };
  for (const h of list) decision = await h({ agent, messages: [] }, async () => decision);
  return (decision.messages ?? [])
    .map((x) => (x.content ?? []).map((c) => c.text ?? "").join(""))
    .join("\n");
}

/** 从注入里把「活跃台账上限」那一行抠出来（那是最能一眼看懂的生效值）。 */
const upperLine = (t) => (t.split("\n").find((l) => l.includes("活跃台账上限")) ?? "(没有这一行)").trim();

console.log("════════ D211b 探针：改项目清单，旧对话能立刻跟上吗？ ════════");
console.log(`项目根 = ${root}`);
console.log(`清单文件 = ${MANIFEST}\n`);

const t1 = await preStep();
console.log("【第 1 步】清单里 maxActiveLines = 350");
console.log(`  注入那一行：${upperLine(t1)}`);

// ★★★ 关键动作：**只改清单文件**。不重启、不 apply、不碰设置面板。
writeManifest(400);
console.log("\n  ★ 动作：把 `.dsh-ledger.json` 里的 maxActiveLines 改成 **400**（只改文件）");

const t2 = await preStep();
console.log("\n【第 2 步】同一个会话、同一个进程，清单现在是 400");
console.log(`  注入那一行：${upperLine(t2)}`);

const sawNew = upperLine(t2).includes("400");
const sawOld = upperLine(t2).includes("350");
console.log("\n════════ 结论 ════════");
console.log(`  第 2 步读到新值 400 ？ ${sawNew}`);
console.log(`  第 2 步还停留在旧值 350 ？ ${sawOld}`);
console.log("");
if (sawNew) {
  console.log("★★★ **项目清单是每回合现读的** ⇒ 改它 = **下一次说话就生效**，");
  console.log("     **不必重启、不必开新对话**。");
  console.log("  ⇒ 所以『只影响新项目』这句话**只对设置面板成立**（面板写的是插件级=新项目默认值），");
  console.log("     **对项目清单不成立** —— 清单里的值是活的。");
  console.log("  ⇒ 用户要的『让旧对话也随时更新』**已经有机制了，缺的只是一个入口去写它**。");
} else {
  console.log("☆ 没跟上 ⇒ 清单不是现读的（那要另找方案）。逐条看上面。");
}

// ★ 顺带验证：同一个"活值"是否对**另一个会话**也立刻成立（Q1 的姊妹问题）
const agent2 = {
  session: { header: { id: "sess-live-2", cwd: root }, requestContext: () => ({ contextWindow: 1000000 }) },
};
let d2 = { messages: [] };
for (const h of run.handlers.get("agent/pre-step") ?? []) d2 = await h({ agent: agent2, messages: [] }, async () => d2);
const t3 = (d2.messages ?? []).map((x) => (x.content ?? []).map((c) => c.text ?? "").join("")).join("\n");
console.log(`\n  ★ 旁证：**另一个会话**（首次说话）读到的那一行：${upperLine(t3)}`);

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
