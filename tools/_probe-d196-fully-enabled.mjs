/**
 * 只读取证（D196 之二）：**"全启用"时那一段到底是消失了、还是我夹具没启全？**
 *
 * ★ 情形 84② 报红（`注入里含「尚未启用」=true`）⇒ 两种可能，必须分清：
 *   ① **夹具错**：我以为"都启用了"，其实还有一项没启用 ⇒ 那一段**本来就该出现**（假红）；
 *   ② **实现错**：`renderUnenabledCapabilities` 在 `off.length === 0` 时**没返回空串**。
 * ★★ 纪律 6/8：**夹具没走通 ≠ 被测对象有问题**。先算清楚，别急着改实现。
 *
 * 跑法：node tools/_probe-d196-fully-enabled.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

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

// ── ① 直接问纯函数：**八项全给**时它返回什么？ ─────────────────────────────
bar("① 直接喂一个「全都登记了」的 info ⇒ 纯函数返回什么？");
const FULL_INFO = {
  activeRel: "LEDGER.md", decisionsRel: "DECISIONS.md", archiveRel: "_ledger-archive",
  logRel: "_ledger-log", goalsRel: "GOALS.md", journalRel: "JOURNAL.md",
  principlesRel: "PRINCIPLES.md", lessonsRel: "LESSONS.md",
};
const r = mod.__test.renderUnenabledCapabilities(FULL_INFO);
console.log(`  返回类型=${typeof r} 长度=${r.length}`);
console.log(`  返回内容=${JSON.stringify(r)}`);
console.log(`  ⇒ ${r === "" ? "★ 纯函数**正确**（全启用 ⇒ 空串）⇒ 问题在别处" : "★ 纯函数**没返回空串** ⇒ 实现在出错"}`);

// ── ② 那就问注入：全启用时，那一段是从哪冒出来的？ ────────────────────────
bar("② 全启用的**项目**：注入里「尚未启用」出现在哪个上下文？");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "d196-full-"));
fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 状态\n- x\n", "utf8");
fs.writeFileSync(path.join(root, "DECISIONS.md"), "# 决策\n", "utf8");
for (const f of ["GOALS.md", "JOURNAL.md", "PRINCIPLES.md", "LESSONS.md"]) fs.writeFileSync(path.join(root, f), "# x\n", "utf8");
fs.writeFileSync(
  path.join(root, ".dsh-ledger.json"),
  JSON.stringify({
    version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive",
    logDir: "_ledger-log", goals: "GOALS.md", journal: "JOURNAL.md",
    principles: "PRINCIPLES.md", lessons: "LESSONS.md", revision: 0,
  }),
  "utf8"
);
const agent = { session: { header: { id: "s-full", cwd: root }, id: "s-full" } };
let dec = { messages: [] };
for (const h of handlers.get("agent/pre-step") ?? []) dec = await h({ agent, messages: [] }, async () => dec);
const texts = [];
for (const m of dec.messages ?? []) {
  const c = m?.content;
  if (typeof c === "string") texts.push(c);
  else if (Array.isArray(c)) for (const p of c) if (typeof p?.text === "string") texts.push(p.text);
}
const inj = texts.join("\n\n");
let idx = inj.indexOf("尚未启用");
console.log(`  「尚未启用」出现位置：${idx}`);
while (idx !== -1) {
  console.log(`  ── 上下文 ──`);
  console.log(inj.slice(Math.max(0, idx - 260), idx + 120).split("\n").map((l) => "    " + l).join("\n"));
  idx = inj.indexOf("尚未启用", idx + 1);
}
fs.rmSync(root, { recursive: true, force: true });

bar("结  论");
console.log("  ★ 若 ① 返回空串 ⇒ 纯函数正确，「全启用时那一段消失」成立。");
console.log("  ★ 若 ① 非空 ⇒ 看它多报了哪几项，那就是 **key 与 info 字段名对不上**（D196 真栽过：");
console.log("     `archiveDir`/`logDir` 拼出 `archiveDirRel`/`logDirRel`，而 inspect 给的是 `archiveRel`/`logRel`）");
console.log("     —— 这类错**不报错**、只是静默多报，所以必须靠这条探针照出来。");
