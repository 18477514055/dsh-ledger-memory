// _probe-d359-e2e.mjs —— 端到端：真跑一次压缩，看重注里到底有没有「最近的工作」块
//
// ★ 为什么必须有这一条：单测 `renderRecentWork` 只证明"函数本身对"。
//   D356/D358 都栽过同一件事 —— **函数对、但没接进调用链**（`scanned=1` 但 `byKind` 空）。
//   ⇒ 必须走真链路：`mod.apply` → 压缩 → 压缩后的 pre-step 注入 → 在正文里找。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const mod = await import("file:///" + path.join(ROOT, "lib", "index.js").replace(/\\/g, "/"));

let pass = 0, fail = 0;
const ok = (t, c, extra) => {
  if (c) { pass++; console.log(`  PASS  ${t}`); }
  else { fail++; console.log(`  FAIL  ${t}${extra === undefined ? "" : `\n        ${String(extra).slice(0, 500)}`}`); }
};

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "d359e2e-"));
const rmrf = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };

function mkProject() {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\n做 D359\n", "utf8");
  fs.mkdirSync(path.join(dir, "_arch"), { recursive: true });
  fs.mkdirSync(path.join(dir, "_ledger-log", "2026-10", "week5"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".dsh-ledger.json"),
    JSON.stringify({
      version: 1,
      active: "LEDGER.md",
      archiveDir: "_arch",
      logDir: "_ledger-log",
      logLevels: { L0: true, L1: true, L2: true, L3: false, L4: true },
      maxActiveLines: 400,
      revision: 0,
    }),
    "utf8"
  );
  // 预置两条 L1（模拟"这一轮之前已经写过台账"）
  fs.writeFileSync(
    path.join(dir, "_ledger-log", "2026-10", "week5", "L1-turns.md"),
    "# L1 回合摘要 · _ledger-log\n" +
      "- 2026-10-29 00:10:00 (L1) 先把指纹模块的边界做成守卫 ｜ 要什么：只给台账文件加 ｜ 做了什么：写了 _probe-d358-scope 18/0 ｜ 下一步：接读路径\n" +
      "- 2026-10-29 00:20:00 (L1) 再把兜底接进 readEntryUnified ｜ 要什么：改名后能找回 ｜ 做了什么：_probe-d358-fallback 18/0 ｜ 下一步：跑自检\n",
    "utf8"
  );
  return dir;
}

function makeCtx(opts) {
  const handlers = new Map();
  const registeredTools = new Map();
  const compacted = [];
  const ctx = {
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
      return () => {};
    },
    effect(fn) { try { fn(); } catch { /* ignore */ } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    command() {},
    inject() {},
    serviceFor() { return undefined; },
    tools: { register(t) { registeredTools.set(t.name, t); return () => {}; } },
    get(name) {
      if (name === "compaction") {
        return {
          compactNow: async () => { compacted.push(1); return { ok: true }; },
          requestContext: () => ({ contextWindow: 1_000_000, usedTokens: 700_000 }),
        };
      }
      if (name === "tokenMeter") return { measure: () => ({ totalTokens: 700_000, nodes: 700_000 }) };
      return undefined;
    },
  };
  return { ctx, handlers, registeredTools, compacted, opts };
}

async function runPreStep(run, { agent, messages }) {
  // ★ 照抄 selftest 的调法（`tools/selftest.mjs:823-831`）：
  //   `agent/pre-step` 是 **waterfall** —— handler 签名是 `({agent,messages}, next)`，
  //   必须把 `next` 传进去，且它返回的是**整个 decision**（含 messages）。
  //   ★ 我第一次只传了一个参数 ⇒ `TypeError: next is not a function`（尺子错：没读签名）。
  const list = run.handlers.get("agent/pre-step") ?? [];
  let decision = { messages: messages ?? [] };
  for (const h of list) {
    decision = await h({ agent, messages: messages ?? [] }, async () => decision);
  }
  return decision;
}

const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0)); };

const root = mkProject();
const sid = "session-d359-aaaa-bbbb";
const run = makeCtx({});
mod.apply(run.ctx, {});
const agent = { session: { header: { id: sid, cwd: root }, id: sid }, steer: () => {} };

// 喂一条用户原话（让胶囊有料），再让台账落盘（压缩闸门要它）
for (const h of run.handlers.get("session/event") ?? []) {
  await h({ id: sid, header: { id: sid, cwd: root } }, {
    type: "user/message",
    time: Date.now(),
    data: { id: `m-${sid}`, role: "user", content: [{ type: "text", text: "把最近做过什么也注回来" }], source: { kind: "user" } },
  });
}

// 用 /ledger compact 命令当场压（最短路径）
console.log("== 端到端：压缩后重注 ==");
{
  const cmdHs = run.handlers.get("command") ?? [];
  // 直接走工具：ledger_compact 只排队，所以改用命令处理器的执行函数不可得；
  // 这里改走「真实压缩事件」路径 —— 让插件收到 compaction/end 之后重注。
  for (const h of run.handlers.get("session/event") ?? []) {
    await h({ id: sid, header: { id: sid, cwd: root } }, {
      type: "compaction/start", time: Date.now(), data: { compactionId: "c1", turn: null },
    });
  }
  for (const h of run.handlers.get("session/event") ?? []) {
    await h({ id: sid, header: { id: sid, cwd: root } }, {
      type: "compaction/end", time: Date.now(), data: { compactionId: "c1", turn: null },
    });
  }
  await settle();

  const d = await runPreStep(run, { agent, messages: [] });
  const t = (d?.messages ?? []).map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.text ?? "").join("") : String(m.content ?? ""))).join("\n");
  console.log(`  重注正文长度 = ${t.length} 字符`);

  ok("★ 重注里有「最近的工作」块", t.includes("### 最近的工作"), t.slice(0, 600));
  ok("★★ 里面真有我们预置的那两条 L1", t.includes("先把指纹模块的边界做成守卫") && t.includes("再把兜底接进 readEntryUnified"), t.slice(0, 2000));
  ok("★★ 每条带时间戳", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(t), t.slice(0, 800));
  ok("★ 带「距今多久」", /（(刚刚|\d+ 分钟前|\d+ 小时前|\d+ 天前)）/.test(t), t.slice(0, 800));
  ok("★ 明说「不要重做」", t.includes("不要重做"));
  ok("★ 同时仍有高保真胶囊（没把它挤掉）", t.includes("高保真胶囊"), t.slice(0, 400));
  ok("★ 台账也仍在（三样并存）", t.includes("LEDGER") || t.includes("项目台账"), t.slice(0, 400));

  // 位置：最近的工作必须在胶囊**那一节**之前
  // ★ 尺子错（#66，我自己的）：第一版拿 `高保真胶囊` 当锚 ⇒ 它在**题头**里也出现一次
  //   （"台账 + 高保真胶囊已重新注入"）⇒ 位置算到 676，比实际那一节还靠前。
  //   正解：锚**那一节的标题**（带 `## ` 前缀），不是任意一次提及。
  const iRecent = t.indexOf("### 最近的工作");
  const iCapsule = t.indexOf("## 高保真胶囊（**逐字**");
  ok("★ 顺序：最近的工作在胶囊那一节之前", iRecent >= 0 && iCapsule >= 0 && iRecent < iCapsule, `recent=${iRecent} capsule=${iCapsule}`);
}

rmrf(root);
console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
