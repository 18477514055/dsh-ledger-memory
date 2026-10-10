/** 探针：直接跑首轮注入，把被吞掉的异常挖出来。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENTRY = path.join(path.resolve(import.meta.dirname, ".."), "lib", "index.js");
const mod = await import(new URL(`file:///${ENTRY.replace(/\\/g, "/")}`).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-dbg-"));

// 极简假 ctx
const handlers = new Map();
const warnings = [];
const services = { tools: { register: () => () => {} } };
const ctx = {
  tools: services.tools,
  logger: { warn: (m) => { warnings.push(String(m)); console.log("  [warn] " + m); }, info() {}, error() {} },
  on(e, h) { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); return () => {}; },
  inject() { return undefined; },
  get: (k) => services[k],
};

mod.apply(ctx, {});

const agent = { session: { header: { id: "session-dbg0001-0001", cwd: dir }, id: "session-dbg0001-0001" } };
const decision = { messages: [] };
const list = handlers.get("agent/pre-step") ?? [];
console.log(`pre-step handlers = ${list.length}`);
for (const h of list) {
  try {
    const r = await h({ agent, messages: [] }, async () => decision);
    console.log("  返回 messages 数 = " + ((r?.messages ?? []).length));
  } catch (e) {
    console.log("  ★ 抛了：" + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n     ") : String(e)));
  }
}

console.log("\nwarnings:");
for (const w of warnings) console.log("  - " + w);

fs.rmSync(dir, { recursive: true, force: true });
