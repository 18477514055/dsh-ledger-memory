/**
 * ★★★★★ 只读审计（D195）：**记忆体系"连通性"到底断在哪？**
 *
 * 用户原话（逐字）：*"下一个目标是让台账记忆系统活起来——之前只有 ledger 到 design 的索引与连接，
 * 我的一个想法是，让**有必要连起来的用索引和其他东西连起来**，让整个系统成为一个**有机整体**。"*
 *
 * ★ 判据：**"连起来"这句话必须落成可取证的东西**，不能靠感觉。本探针把"连通"拆成四个可查的维度：
 *   ① **可达性**（reachability）：每个记忆文件，模型有没有一条**工具路径**能读到它？
 *   ② **可见性**（visibility）：注入里有没有**告诉模型它存在**？（不可见的文件 = 不存在）
 *   ③ **可写性**：有内容进去的，有没有对应的写入口？
 *   ④ **互指**（cross-reference）：A 里提到 B 时，那个指向**真的能到达**吗（不是文字上的"见 xxx"）？
 *
 * ★★★ 为什么必须这样拆：D46 那条结论是"**恢复必须是推给模型的，不能是等模型来查**"。
 *   ⇒ 一个文件即使工具能读（①通），只要注入里没提它（②断），模型就**不知道该去读它** ⇒
 *     实际效果等于没有。**"能读到"与"知道要读"是两件事**（这正是本项目"记录存在≠可被用到"的形态）。
 *
 * 只读：只读文件与工具表，不写任何东西。
 * 跑法：node tools/_probe-d195-connectivity.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
let gaps = 0;

// ── 起一个假 ctx，把工具表拿全 ──────────────────────────────────────────
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
    const s = {
      commands: { register: () => () => {} },
      userQuestions: { async ask() { return { answers: [] }; } },
    };
    for (const d of deps) if (!(d in s)) return undefined;
    const scope = Object.create(ctx);
    for (const d of deps) scope[d] = s[d];
    return cb(scope);
  },
  get: () => undefined,
  webServer: { register: () => () => {} },
  configEditor: { entries: () => [], configuration: () => [], edit: async () => {} },
};
mod.apply(ctx, {});
const exec = { agent: { session: { header: { id: "s-d195", cwd: ROOT } } } };

// ── ① 可达性：每个记忆文件，用**工具**能不能读到 ────────────────────────
bar("① 可达性：模型有没有一条**工具路径**读到这个文件？");
const readTargets = ["active", "decisions", "principles", "journal", "manifest", "archive"];
const readTool = tools.get("ledger_read");
console.log(`  ledger_read 的 target 枚举：${JSON.stringify(readTargets)}`);
const ledgerReadEnum = readTool.parameters.properties.target.enum;
console.log(`  实际代码里的枚举    ：${JSON.stringify(ledgerReadEnum)}`);

const FILES = [
  { rel: "LEDGER.md", how: "ledger_read({target:'active'})", reach: ledgerReadEnum.includes("active") },
  { rel: "DECISIONS.md", how: "ledger_read({target:'decisions'})", reach: ledgerReadEnum.includes("decisions") },
  { rel: "PRINCIPLES.md", how: "ledger_read({target:'principles'})", reach: ledgerReadEnum.includes("principles") },
  { rel: "JOURNAL.md", how: "ledger_read({target:'journal'})", reach: ledgerReadEnum.includes("journal") },
  { rel: "GOALS.md", how: "ledger_goals({op:'tree'})", reach: tools.has("ledger_goals") },
  { rel: "LESSONS.md", how: "ledger_lessons({op:'list'})", reach: tools.has("ledger_lessons") },
];
for (const f of FILES) {
  const exists = fs.existsSync(path.join(ROOT, f.rel));
  const lines = exists ? fs.readFileSync(path.join(ROOT, f.rel), "utf8").split("\n").length : 0;
  const ok = exists && f.reach;
  if (!ok) gaps++;
  console.log(`  ${ok ? "✅" : "❌"} ${f.rel.padEnd(15)} 存在=${exists ? `是(${lines}行)` : "否"}  路径=${f.reach ? "有" : "**没有**"}  ${f.how}`);
}

// ── ② 可见性：**注入里**有没有告诉模型它存在？ ─────────────────────────
//
// ★★★ 这是"活起来"的关键：D46 说"恢复必须推行"。模型**只能**从注入里知道有什么文件。
//
// ★★★★ **尺子修正（我自己第一版在这里报了 4 个假红，必须留档）**：
//   第一版我去**源码**里搜 `"LEDGER.md"` 这样的**字面量** ⇒ LEDGER / DECISIONS / JOURNAL
//   全报"没提到"。**那是尺子错**（L2 / L13 同型：匹配面太窄）：注入尾巴里那些名字
//   是**变量插值**写的（`` `- 活跃台账：\`${info.activeRel}\`…` ``），源码里**根本没有那个字面量**。
//   ⇒ 正解：**渲染真实注入**再查（`runPreStep` 走真 `agent/pre-step` 瀑布），
//     而不是查"源码里有没有那个词"。**判据要吃"到达模型的那份文本"，不是"生产它的代码"。**
bar("② 可见性：**真实注入正文里**提到这个文件了吗？（没提 = 模型不知道它存在）");
const libSrc = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");

// 走真入口渲染一次注入（与情形 12/45/71 同一把尺子）
async function renderRealInjection() {
  const list = handlers.get("agent/pre-step") ?? [];
  const agent = { session: { header: { id: "s-d195-inj", cwd: ROOT }, id: "s-d195-inj" } };
  let decision = { messages: [] };
  for (const h of list) decision = await h({ agent, messages: [] }, async () => decision);
  const msgs = Array.isArray(decision?.messages) ? decision.messages : [];
  const texts = [];
  for (const m of msgs) {
    const c = m?.content;
    if (typeof c === "string") texts.push(c);
    else if (Array.isArray(c)) for (const p of c) if (typeof p?.text === "string") texts.push(p.text);
  }
  return texts.join("\n\n");
}
let injected = "";
try {
  injected = await renderRealInjection();
} catch (e) {
  console.log(`  ⚠️ 渲染真实注入失败：${String(e?.message ?? e)} ⇒ 退回查源码（结论要打折）`);
}
console.log(`  真实注入正文长度：${injected.length} 字符（${injected === "" ? "**空！尺子没取到**" : "取到了"}）`);
const VIS = [
  ["LEDGER.md", ["LEDGER.md", "活跃台账"]],
  ["DECISIONS.md", ["DECISIONS.md", "关键决策"]],
  ["PRINCIPLES.md", ["PRINCIPLES.md", "根本原则", "principles"]],
  ["JOURNAL.md", ["JOURNAL.md", "回合流水", "journal"]],
  ["GOALS.md", ["GOALS.md", "目标树", "ledger_goals"]],
  ["LESSONS.md", ["LESSONS.md", "经验与教训", "ledger_lessons"]],
  ["_ledger-archive/", ["_ledger-archive", "归档目录", "归档"]],
  ["_stash/", ["_stash"]],
  ["_handoff/", ["_handoff", "交接单"]],
];
for (const [label, keys] of VIS) {
  const hit = keys.find((k) => injected.includes(k));
  const ok = hit !== undefined;
  if (!ok) gaps++;
  console.log(`  ${ok ? "✅" : "❌"} ${label.padEnd(18)} ${ok ? `注入提到（命中「${hit}」）` : "**注入里没有**"}`);
}

// ── ②b ★★★★★ **结构契约**（插件自己写的那段）里列了哪些？ ────────────────
//
// ★★★★ 为什么必须把这一层单独摘出来（**我第二把尺子又错了一次，两把都留档**）：
//   ② 查的是"整份注入里有没有这个词" —— 而注入里**包含台账正文**，
//   正文是**模型自己写的**、自然会提到那些文件名 ⇒ 于是"全都命中"，
//   **看起来什么都连上了**。但那不是插件给的保证：正文换个写法，命中的词就没了。
//   ⇒ 真正决定"模型知不知道有这个文件、该怎么用"的，是**插件自己生成的那段结构契约**
//     （从「**台账约定**」开始的那一段，每回合固定送达）。**它才是"推行"的载体。**
//   ★ 这正是本项目那条纪律的又一次现形：**判据要吃"被测系统自己产生的那部分"**（纪律 2）。
{
  const idx = injected.lastIndexOf("**台账约定**");
  const contract = idx === -1 ? "" : injected.slice(idx);
  console.log(`\n  ── 结构契约（插件自己写的那段）长度：${contract.length} 字符 ──`);
  if (contract === "") {
    console.log("  ⚠️ 没找到「台账约定」段 ⇒ 拿不到契约文本（结论打折）");
  } else {
    console.log(`  契约开头：${JSON.stringify(contract.slice(0, 120))}`);

    // ★★★★★ **只取「契约列表」本身**（从「台账约定」到「★★ 台账与 L1 是你的义务」之前）。
    //   ★★★ 为什么必须切这么窄（**我的尺子第三次错在这里，值得留档**）：
    //     「台账约定」后面还跟着**目标树正文**与**压缩合同**；
    //     而目标树是**模型自己写的**，它在讲 D183 时顺口提了 `JOURNAL.md` ⇒
    //     于是 `JOURNAL.md` 被判成"契约里有" —— **假绿**。
    //   ⇒ 判据必须只吃**契约列表**那几行（插件的保证就在那几行），
    //     不吃"渲染结果里碰巧出现过这个词"（纪律 2：吃被测系统自己产生的那部分）。
    const listStart = contract.indexOf("**台账约定**");
    const listEnd = contract.indexOf("★★ **台账与 L1 是你的义务");
    const list = listEnd > listStart && listStart >= 0 ? contract.slice(listStart, listEnd) : contract;
    console.log(`  ── **契约列表**长度：${list.length} 字符（判据只吃这一段）──`);
    console.log("  ── 契约**列表**里逐项核对（这才是插件的保证）──");
    const CONTRACT_ITEMS = [
      ["LEDGER.md", ["活跃台账", "LEDGER.md"]],
      ["DECISIONS.md", ["关键决策", "DECISIONS.md"]],
      ["PRINCIPLES.md", ["根本原则", "PRINCIPLES.md"]],
      ["JOURNAL.md", ["回合流水", "JOURNAL.md"]],
      ["GOALS.md", ["目标树", "GOALS.md"]],
      ["LESSONS.md", ["经验与教训", "LESSONS.md"]],
      ["_ledger-log/", ["活动日志", "_ledger-log"]],
      ["_ledger-archive/", ["归档目录", "_ledger-archive"]],
    ];
    for (const [label, keys] of CONTRACT_ITEMS) {
      const hit = keys.find((k) => list.includes(k));
      const ok = hit !== undefined;
      if (!ok) gaps++;
      console.log(`    ${ok ? "✅" : "❌"} ${label.padEnd(18)} ${ok ? `提到「${hit}」` : "**契约里没有 ⇒ 模型不知道它存在**"}`);
    }

    // ★★★ 光"提到名字"还不够 —— 契约的价值在于**告诉模型该怎么用它**。
    //
    // ★★ 尺子范围（第四处修正，记下来）：**存在性**只吃那几行**列表**，
    //   而**用法**要吃**整段契约** —— 因为项目的写法就是"列表里给个名字，
    //   用法在紧随其后的段落里讲"（`DECISIONS.md` 正是如此：
    //   其用法在「用户在会话中定了架构/接口/协议…用 `ledger_write({target:"decisions"})`」那句里）。
    //   ⇒ 若把用法也限制在那几行里，会报一个**假红**（我自己刚撞上）。
    console.log("\n  ── 带没带「用法」（查整段契约；只列名字 ≈ 只说存在，没说怎么用）──");
    const USAGE = [
      ["LEDGER.md", ["ledger_write"]],
      ["DECISIONS.md", ["decisions"]],
      ["GOALS.md", ["ledger_goals"]],
      ["PRINCIPLES.md", ["ledger_propose_principle"]],
      ["LESSONS.md", ["ledger_lessons"]],
      ["JOURNAL.md", ["journal"]],
      ["_ledger-log/", ["ledger_log"]],
      ["_ledger-archive/", ["ledger_archive", "只追加"]],
    ];
    for (const [label, keys] of USAGE) {
      const hit = keys.find((k) => contract.includes(k));
      const ok = hit !== undefined;
      if (!ok) gaps++;
      console.log(`    ${ok ? "✅" : "❌"} ${label.padEnd(18)} ${ok ? "带了用法指引" : "**契约里没给它用法**"}`);
    }

    // ★ 把新接进来那几条**原样打出来**（人眼复核措辞是否可信、是否指对了工具）
    console.log("\n  ── 新接进来的三条，原样（人眼复核）──");
    for (const line of list.split("\n")) {
      if (line.includes("根本原则") || line.includes("经验与教训") || line.includes("回合流水")) {
        console.log(`    ${line}`);
      }
    }
  }
}

// ── ③ 可写性：有内容的文件，有没有写入口 ────────────────────────────────
bar("③ 可写性：每个文件有没有对应的写入口（工具 / 命令）？");
const WRITERS = [
  ["LEDGER.md", ["ledger_write"]],
  ["DECISIONS.md", ["ledger_write"]],
  ["JOURNAL.md", ["ledger_write"]],
  ["GOALS.md", ["ledger_goals"]],
  ["LESSONS.md", ["ledger_lessons"]],
  ["PRINCIPLES.md", ["ledger_propose_principle", "ledger_principles_access"]],
];
for (const [rel, ts] of WRITERS) {
  const ok = ts.some((t) => tools.has(t));
  if (!ok) gaps++;
  console.log(`  ${ok ? "✅" : "❌"} ${rel.padEnd(15)} 写入口：${ts.filter((t) => tools.has(t)).join(", ") || "**无**"}`);
}

// ── ④ 互指：台账里提到的 D<n> / 文件，能不能真的到达 ────────────────────
bar("④ 互指：`LEDGER.md` 里引用的每个 `D<n>` 在 `DECISIONS.md` 里真的有正文吗？");
{
  const ledger = fs.readFileSync(path.join(ROOT, "LEDGER.md"), "utf8");
  const dec = fs.readFileSync(path.join(ROOT, "DECISIONS.md"), "utf8");
  const cited = new Set([...ledger.matchAll(/\bD(\d{1,3})\b/g)].map((m) => Number(m[1])));
  const defined = new Set([...dec.matchAll(/^##\s*D(\d{1,3})\b/gm)].map((m) => Number(m[1])));
  const dangling = [...cited].filter((n) => !defined.has(n)).sort((a, b) => a - b);
  const maxD = Math.max(...defined);
  console.log(`  台账引用 ${cited.size} 个 D 号 · DECISIONS 定义 ${defined.size} 个（最大 D${maxD}）`);
  if (dangling.length === 0) {
    console.log(`  ✅ 没有断链（每个被引用的 D 号都有正文）`);
  } else {
    gaps++;
    console.log(`  ❌ 断链 ${dangling.length} 个：${dangling.map((n) => "D" + n).join(", ")}`);
  }
}

// ── ⑤ ★ 反向：有没有"存在但没人指得着"的文件 ────────────────────────────
//
//   这正是 D186 记下的那个真缺口：`_ledger-archive/` + `_stash/` = 63 份**无索引**。
bar("⑤ 反向：有没有「存在，但没有任何索引指得着」的东西？");
{
  const count = (d) => {
    const p = path.join(ROOT, d);
    if (!fs.existsSync(p)) return 0;
    let n = 0;
    const walk = (x) => {
      for (const e of fs.readdirSync(x, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(x, e.name));
        else n++;
      }
    };
    walk(p);
    return n;
  };
  const arc = count("_ledger-archive");
  const stash = count("_stash");
  console.log(`  _ledger-archive/ ${arc} 份 · _stash/ ${stash} 份 · _handoff/ ${count("_handoff")} 份`);
  // ★ 用**真实注入**判（不再用源码字面量 —— 见 ② 的尺子修正）
  const body = injected === "" ? libSrc : injected;
  const arcIndexed = body.includes("_ledger-archive") || body.includes("归档目录");
  const stashIndexed = body.includes("_stash");
  console.log(`  ${arcIndexed ? "✅" : "❌"} 归档：注入里给了查找路径吗？（${arc} 份在盘上）`);
  console.log(`  ${stashIndexed ? "✅" : "❌"} _stash：注入里提到了吗？（${stash} 份在盘上）`);
  if (!stashIndexed) gaps++;
}

bar(`结  论：共发现 ${gaps} 处"连通性"缺口`);
console.log("  ★ 这些不是「文件不存在」，而是「**模型够不着 / 不知道它存在**」。");
console.log("  ★ 按 D46 的判据：**能读到 ≠ 知道要读** ⇒ 可见性断了等于没有。");
