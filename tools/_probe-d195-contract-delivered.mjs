/**
 * ★★★★★ 只读取证（D195 之二）：**走"真实注入"这条路，逐条确认契约真的送达了。**
 *
 * ★ 与 `_probe-d195-connectivity.mjs` 的分工：
 *   · 那个是**审计**（宽口径，逐维度扫，用来找缺口）；
 *   · 这个是**验收**（窄口径，只问一句：**这一轮修的那三行，真到达模型了吗**）。
 *
 * ★★★ 为什么必须**另有一条走真入口的验收**：本轮我**四次**把尺子写错
 *   （两次太窄、两次太宽 —— 详见探针注释与 `LESSONS.md`）。
 *   而所有错误的共同点都是：**用"源码里有没有那个词"代替"到达模型的那份文本里有没有"**。
 *   ⇒ 所以最终判据只用**真 `agent/pre-step` 渲染出来的注入正文**。
 *
 * 跑法：node tools/_probe-d195-contract-delivered.mjs
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
let bad = 0;
const chk = (label, cond, detail) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail === undefined ? "" : `\n      ${detail}`}`);
  if (!cond) bad++;
};

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const tools = new Map();
const handlers = new Map();
const ctx = {
  tools: { register: (d) => tools.set(d.name, d) },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  on: (ev, h) => {
    if (!handlers.has(ev)) handlers.set(ev, []);
    handlers.get(ev).push(h);
    return () => {};
  },
  inject: (deps, cb) => {
    const s = { commands: { register: () => () => {} }, userQuestions: { async ask() { return { answers: [] }; } } };
    for (const d of deps) if (!(d in s)) return undefined;
    const scope = Object.create(ctx);
    for (const d of deps) scope[d] = s[d];
    return cb(scope);
  },
  get: () => undefined,
};
mod.apply(ctx, {});

const agent = { session: { header: { id: "s-d195c", cwd: ROOT }, id: "s-d195c" } };
let dec = { messages: [] };
for (const h of handlers.get("agent/pre-step") ?? []) dec = await h({ agent, messages: [] }, async () => dec);
const texts = [];
for (const m of dec.messages ?? []) {
  const c = m?.content;
  if (typeof c === "string") texts.push(c);
  else if (Array.isArray(c)) for (const p of c) if (typeof p?.text === "string") texts.push(p.text);
}
const injected = texts.join("\n\n");
console.log(`真实注入正文：${injected.length} 字符\n`);

// 契约列表 = 「台账约定」到「★★ 台账与 L1 是你的义务」之间
const i0 = injected.lastIndexOf("**台账约定**");
const i1 = injected.indexOf("★★ **台账与 L1 是你的义务", i0);
const list = i0 >= 0 && i1 > i0 ? injected.slice(i0, i1) : "";
chk("能取到契约列表（真入口渲染出来的）", list.length > 200, `list=${list.length} 字符`);

// ① 三个被补上的文件：必须在**契约列表**里，各带各的用法
console.log("\n① 被补上的三项 —— 在契约列表里吗？带用法吗？");
const EXPECT = [
  ["PRINCIPLES.md", "根本原则", "ledger_propose_principle"],
  ["LESSONS.md", "经验与教训", "ledger_lessons"],
  ["JOURNAL.md", "回合流水", "journal"],
];
for (const [rel, title, usage] of EXPECT) {
  chk(`${rel} 列在契约里（带「${title}」）`, list.includes(title), list.includes(title) ? "" : list.slice(0, 200));
  chk(`${rel} 带了用法指引（提到 ${usage}）`, list.includes(usage), list.includes(usage) ? "" : `列表里找不到 ${usage}`);
}

// ② 原有的几项**不许被这次改动挤掉**（改一处把别处碰坏，是本项目的常见形态）
console.log("\n② 原有的几项还在吗（防「改了新的、碰坏旧的」）？");
for (const [what, key] of [
  ["LEDGER.md", "活跃台账"],
  ["DECISIONS.md", "关键决策"],
  ["GOALS.md", "目标树"],
  ["_ledger-log/", "活动日志"],
  ["_ledger-archive/", "归档目录"],
]) {
  chk(`${what} 仍在契约里`, list.includes(key), list.includes(key) ? "" : "**被挤掉了！**");
}

// ③ ★★★ 反向：契约里**提到的每个记忆文件**，都必须是**真的存在**的
//
//   ★ 守的是"文案说了一个不存在的东西"这一形态（D193 刚栽过：文案指向不存在的机制）。
console.log("\n③ 反向：契约提到的记忆文件，盘上真的存在吗？");
for (const [rel] of EXPECT) {
  const exists = fs.existsSync(path.join(ROOT, rel));
  chk(`${rel} 真的存在于项目根`, exists, exists ? "" : "**契约在说一个不存在的文件**");
}

console.log(`\n结  论：${bad === 0 ? "✅ 契约真的把这三项送达模型了" : `❌ ${bad} 项不通过`}`);
process.exit(bad === 0 ? 0 : 1);
