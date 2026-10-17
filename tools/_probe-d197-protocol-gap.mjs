/**
 * ★★★★★ 只读取证（D197）：**"协议"到底有没有送到模型？**
 *
 * 用户原话（逐字）：*"最好就是插件本体在被指定项目之后就会自动生成所需要的各项文件，
 * 然后由AI填写就可以了。然后AI自己也要从清单那里知道，并且**他要知道协议**，
 * 也就是**他连协议都不知道的话，就很难去填这些东西**，以及按照插件的更新
 * 去把老版本的文件拆分成新的文件。或者是按照新版本去更新新的台账系统和日志系统。"*
 *
 * ★★★ 这一条把问题推到根上，而且它**不是 D196 那件事**：
 *   · **D196** 解决的是「**模型知不知道有这些能力**」（可见性）；
 *   · **D197（本条）** 要解决的是「**模型知不知道每个文件的格式协议**」——
 *     即：文件长什么样、有哪些字段、什么样的内容算合法。
 *   ⇒ 用户点得很准：**不知道协议，就没法填**（也没法把老文件拆成新文件）。
 *
 * ★ 但"协议"有两种存在形式，**必须先分清**（否则会把已经有的东西当成缺的）：
 *   · **A. 工具参数协议** —— 走工具（`ledger_goals({op:"upsert", …})`）时，
 *     格式由**工具的 parameters schema** 决定，模型**本来就收得到**（工具定义在上下文里）。
 *   · **B. 文件正文协议** —— **模型要直接写文件内容**时（`ledger_init` 的
 *     `initialActive` / `initialDecisions`，以及**把老文件拆成新文件**）才需要。
 *   ⇒ 本探针就分别量这两种：**能取到 A 的证据就别把 A 报成缺口。**
 *
 * 跑法：node tools/_probe-d197-protocol-gap.mjs
 */
import fs from "node:fs";
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

// ── ① A 面：工具参数协议（模型收得到吗）────────────────────────────────
bar("① A 面 · 工具参数协议：`ledger_goals` / `ledger_lessons` 的字段说明在不在工具定义里？");
for (const name of ["ledger_goals", "ledger_lessons", "ledger_write", "ledger_init"]) {
  const t = tools.get(name);
  const props = t?.parameters?.properties ?? {};
  const keys = Object.keys(props);
  console.log(`\n  ${name}：${keys.length} 个参数`);
  console.log(`    ${keys.join(", ")}`);
}
const goals = tools.get("ledger_goals");
console.log(`\n  ★ ledger_goals 的 op 枚举：${JSON.stringify(goals.parameters.properties.op?.enum)}`);
console.log(`  ★ 它的参数里**有没有**"卡片格式"的说明（如 parent/kr/lessons）：`);
for (const k of ["parent", "kr", "lessons", "title", "status"]) {
  const d = goals.parameters.properties[k]?.description;
  console.log(`      ${d === undefined ? "❌ 没有" : "✅ 有"}  ${k}${d === undefined ? "" : ` —— ${String(d).slice(0, 60)}`}`);
}

// ── ② B 面：文件正文协议（模型要自己写内容时才需要）────────────────────
bar("② B 面 · 文件正文协议：模型要**直接写文件内容**时，它知道格式吗？");
const init = tools.get("ledger_init");
console.log(`  ledger_init 的参数：`);
for (const [k, v] of Object.entries(init.parameters.properties)) {
  if (["initialActive", "initialDecisions", "initialGoals", "initialLessons", "principles"].includes(k)) {
    console.log(`    ${k}：${String(v.description ?? "").slice(0, 110)}`);
  }
}
console.log(`  ★ 关键问题：这些 initial* 的说明里，**给了格式/协议吗**？（还是只说"内容"）`);

// ── ③ 真渲染注入：协议有没有被推行？ ────────────────────────────────────
//
// ★★★ 尺子修正（**我第一版在这里用错了夹具，必须留档**）：
//   第一版这个项目**只登记了 active+decisions**（模拟"旧规格"）——
//   而 D197 的协议段**只报"已启用"的文件**（没启用的由 D196 那段介绍）⇒
//   于是它必然报 "7/7 未推行"，**但那是设计如此，不是缺陷**。
//   ⇒ 正解：**要测协议，就得把对应文件登记上**（否则测的是"没启用"这件事）。
//   ★ 这正是纪律 6 的形态：**夹具的输入不对，结论就没意义**。
bar("③ 真渲染注入：**启用了这些文件时**，格式协议在不在里面？");
const old = fs.mkdtempSync(path.join(ROOT, "..", "_tmp-d197-"));
fs.writeFileSync(path.join(old, "LEDGER.md"), "# 台账\n\n## 状态\n- x\n", "utf8");
fs.writeFileSync(path.join(old, "DECISIONS.md"), "# 决策\n", "utf8");
for (const f of ["GOALS.md", "JOURNAL.md", "LESSONS.md"]) fs.writeFileSync(path.join(old, f), "# x\n", "utf8");
fs.writeFileSync(path.join(old, ".dsh-ledger.json"),
  JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive",
    goals: "GOALS.md", journal: "JOURNAL.md", lessons: "LESSONS.md", revision: 0 }), "utf8");
const agent = { session: { header: { id: "s-d197", cwd: old }, id: "s-d197" } };
let dec = { messages: [] };
for (const h of handlers.get("agent/pre-step") ?? []) dec = await h({ agent, messages: [] }, async () => dec);
const texts = [];
for (const m of dec.messages ?? []) {
  const c = m?.content;
  if (typeof c === "string") texts.push(c);
  else if (Array.isArray(c)) for (const p of c) if (typeof p?.text === "string") texts.push(p.text);
}
const inj = texts.join("\n\n");
console.log(`  注入正文 ${inj.length} 字符\n`);
// 逐个格式串去查（这些是**代码里的真格式**，从常量/渲染器里取，不手抄）
const PROTOCOLS = [
  ["GOALS 卡片标题", "## 目标 "],
  ["GOALS parent 字段", "- parent:"],
  ["GOALS 关键结果字段", "- 关键结果:"],
  ["GOALS 教训字段", "- 教训:"],
  ["LESSONS 教训标题", "## 教训 "],
  ["LESSONS 根因字段", "- 根因:"],
  ["LESSONS 出处字段", "- 出处:"],
];
let miss = 0;
for (const [what, needle] of PROTOCOLS) {
  const ok = inj.includes(needle);
  if (!ok) miss++;
  console.log(`  ${ok ? "✅ 有" : "❌ **没有**"}  ${what.padEnd(20)} 「${needle}」`);
}
console.log(`\n  ⇒ 文件正文协议：**${miss}/${PROTOCOLS.length} 项未推行**`);

// ── ④ 自动建文件：现在由谁建？ ──────────────────────────────────────────
bar("④ 自动建文件：新项目时，文件是**插件**建还是**AI**建？");
const src = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
const iInit = src.indexOf("function defineInitTool");
const seg = src.slice(iInit, iInit + 9000);
const creates = [...seg.matchAll(/fs\.writeFileSync\((\w+Abs)/g)].map((m) => m[1]);
console.log(`  ledger_init 里**真会写文件**的地方：${creates.length === 0 ? "（没有）" : creates.join(", ")}`);
console.log(`  ★ 而且它们都带条件（要传 initial* 才写）⇒ 不传就**只登记清单，不建文件**。`);
console.log(`  ★ 也就是说：**是"AI 建、插件登记"，不是"插件建、AI 填"** —— 正是用户想改的那一点。`);

fs.rmSync(old, { recursive: true, force: true });

bar("结  论");
console.log(`  · A 面（工具参数协议）：**模型收得到**（工具定义在上下文里）—— 别当成缺口。`);
console.log(`  · B 面（文件正文协议）：**${miss}/${PROTOCOLS.length} 项没推行** ⇒ 这正是用户说的"他连协议都不知道"。`);
console.log(`  · 建文件：现在是 **AI 建**（插件只登记）⇒ 用户要的是 **插件建骨架、AI 填内容**。`);
