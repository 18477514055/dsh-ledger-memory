// _reverse-verify-d359.mjs —— 反向验证（纪律 10：必须摘到"能看见红"为止）
//
// ★ 要证的是：`_probe-d359-e2e.mjs` 那 8 条**真的依赖** D359 的接线，
//   而不是"随便怎样都绿"。
// ★ 做法：把 `lib/` **整份复制到 %TEMP%**（生产 lib 一字节不动），在副本上摘掉接线，
//   再对副本跑同一套断言。摘掉后必须**看见红**。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC_LIB = path.join(ROOT, "lib");

let pass = 0, fail = 0;
const ok = (t, c, extra) => {
  if (c) { pass++; console.log(`  PASS  ${t}`); }
  else { fail++; console.log(`  FAIL  ${t}${extra === undefined ? "" : `\n        ${String(extra).slice(0, 400)}`}`); }
};

/** 造一份 lib 副本；`mutate(rel, src)` 返回改后的源码（返回 undefined 表示不改） */
function copyLib(mutate) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "d359rev-"));
  const libDst = path.join(dst, "lib");
  fs.cpSync(SRC_LIB, libDst, { recursive: true });
  for (const f of fs.readdirSync(libDst)) {
    if (!f.endsWith(".js")) continue;
    const abs = path.join(libDst, f);
    const src = fs.readFileSync(abs, "utf8");
    const next = mutate(f, src);
    if (typeof next === "string" && next !== src) fs.writeFileSync(abs, next, "utf8");
  }
  return { root: dst, libDst };
}

/** 端到端跑一遍，返回重注正文 */
async function e2e(libDir) {
  const mod = await import("file:///" + path.join(libDir, "index.js").replace(/\\/g, "/"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d359proj-"));
  fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 目标\n做 D359\n", "utf8");
  fs.mkdirSync(path.join(dir, "_arch"), { recursive: true });
  fs.mkdirSync(path.join(dir, "_ledger-log", "2026-10", "week5"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".dsh-ledger.json"),
    JSON.stringify({ version: 1, active: "LEDGER.md", archiveDir: "_arch", logDir: "_ledger-log",
      logLevels: { L0: true, L1: true, L2: true, L3: false, L4: true }, maxActiveLines: 400, revision: 0 }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "_ledger-log", "2026-10", "week5", "L1-turns.md"),
    "# L1\n- 2026-10-29 00:10:00 (L1) 反向验证用的一条 ｜ 做了什么：写了它 ｜ 下一步：验它\n",
    "utf8"
  );

  const handlers = new Map();
  const ctx = {
    on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn); return () => {}; },
    effect(fn) { try { fn(); } catch { /* ignore */ } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    command() {}, inject() {},
    serviceFor() { return undefined; },
    tools: { register() { return () => {}; } },
    get(name) {
      if (name === "compaction") return { compactNow: async () => ({ ok: true }), requestContext: () => ({ contextWindow: 1_000_000, usedTokens: 700_000 }) };
      if (name === "tokenMeter") return { measure: () => ({ totalTokens: 700_000, nodes: 700_000 }) };
      return undefined;
    },
  };
  mod.apply(ctx, {});
  const sid = "session-rev-d359-0001";
  const agent = { session: { header: { id: sid, cwd: dir }, id: sid }, steer: () => {} };

  for (const h of handlers.get("session/event") ?? []) {
    await h({ id: sid, header: { id: sid, cwd: dir } }, {
      type: "user/message", time: Date.now(),
      data: { id: "m1", role: "user", content: [{ type: "text", text: "反向验证" }], source: { kind: "user" } },
    });
    await h({ id: sid, header: { id: sid, cwd: dir } }, { type: "compaction/start", time: Date.now(), data: { compactionId: "c1", turn: null } });
    await h({ id: sid, header: { id: sid, cwd: dir } }, { type: "compaction/end", time: Date.now(), data: { compactionId: "c1", turn: null } });
  }
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));

  let decision = { messages: [] };
  for (const h of handlers.get("agent/pre-step") ?? []) decision = await h({ agent, messages: [] }, async () => decision);
  const t = (decision?.messages ?? []).map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.text ?? "").join("") : String(m.content ?? ""))).join("\n");
  fs.rmSync(dir, { recursive: true, force: true });
  return t;
}

console.log("== 0. 未改动的副本：必须绿（否则下面的「红」不算数）==");
{
  const { root, libDst } = copyLib(() => undefined);
  const t = await e2e(libDst);
  ok("原样副本里「最近的工作」出现", t.includes("### 最近的工作"), `len=${t.length}`);
  ok("原样副本里带那条 L1", t.includes("反向验证用的一条"));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("\n== 1. 破坏 ①：把 renderRecentWork 的调用摘掉（模拟「没接线」）==");
{
  const { root, libDst } = copyLib((f, src) => {
    if (f !== "part2.js") return undefined;
    return src.replace("    renderRecentWork(info) +\n", "    \"\" +\n");
  });
  const t = await e2e(libDst);
  ok("★★ 摘掉后「最近的工作」必须消失（看见红）", !t.includes("### 最近的工作"), `len=${t.length}`);
  ok("★★ 且那条 L1 也不在（不是别处漏进来的）", !t.includes("反向验证用的一条"));
  ok("★ 但台账与胶囊仍在（只摘了这一处）", t.includes("高保真胶囊") || t.includes("项目台账"));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("\n== 2. 破坏 ②：只改「距今多久」为固定空串（模拟「有块但没时间」）==");
{
  const { root, libDst } = copyLib((f, src) => {
    if (f !== "part2.js") return undefined;
    return src.replace("const age = ageOf(e.at, now);", "const age = \"\";");
  });
  const t = await e2e(libDst);
  ok("★★ 块仍在（证明破坏点精准）", t.includes("### 最近的工作"));
  ok("★★ 但「距今多久」消失（看见红）", !/（(刚刚|\d+ 分钟前|\d+ 小时前|\d+ 天前)）/.test(t));
  ok("★ 时间戳本身仍在（那是 L1 自带的，不依赖 ageOf）", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(t));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("\n== 3. 破坏 ③：把倒序改成正序（模拟「最近的排最后」）==");
{
  const { root, libDst } = copyLib((f, src) => {
    if (f !== "part2.js") return undefined;
    return src.replace("entries.slice(-RECENT_WORK_MAX).reverse()", "entries.slice(0, RECENT_WORK_MAX)");
  });
  const t = await e2e(libDst);
  ok("★★ 块仍在", t.includes("### 最近的工作"));
  ok("★★ 但顺序不再是倒序（看见红）", t.indexOf("反向验证用的一条") >= 0);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
