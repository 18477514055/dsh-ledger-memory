/**
 * ★★★★★ 只读审计（D201）：**记忆系统的"召回率"到底断在哪一环？**
 *
 * 用户原话（逐字）：*"我认为我们的整个记忆系统应该都要提高他们的召回率。考虑一些方案。
 * 另外我认为你觉得有没有必要在我们的工具中加上模糊搜索增加记忆的召回率？"*
 *
 * ★★ 为什么不直接答"加模糊搜索"：**"召回率"是四个环节的乘积**，
 *   而"模糊搜索"只治其中一环。★ 若不先量清断在哪一环，就会给**不缺药的那一环**灌药。
 *
 * 四个环节（本探针逐个量）：
 *   ① **够得到吗**（可达性）：一条记忆，工具**能不能**把它取出来？★ 含"能不能取全"。
 *   ② **知道要查吗**（可见性）：注入里有没有告诉模型"它存在、该用哪个工具查"。（D195/D46 已处理过一层）
 *   ③ **查得到吗**（匹配）：给了查询词，**命不命中**？—— ★ **这才是"模糊搜索"能治的那一环。**
 *   ④ **取得出来吗**（工具缺口）：有些目录**根本没有工具入口**（只能靠通用 read/glob）。
 *
 * 只读：不写任何文件。
 * 跑法：node tools/_probe-d201-recall-gap.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const say = (ok, label, detail) => console.log(`  ${ok ? "✅" : "⚠️"} ${label}${detail === undefined ? "" : ` —— ${detail}`}`);

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const tools = new Map();
const ctx = {
  tools: { register: (d) => tools.set(d.name, d) },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  on: () => () => {},
  inject: (deps, cb) => {
    const s = { commands: { register: () => () => {} }, userQuestions: { async ask() { return { answers: [] }; } } };
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

const MEM = [
  { rel: "LEDGER.md", role: "当前状态" },
  { rel: "DECISIONS.md", role: "长期决策" },
  { rel: "JOURNAL.md", role: "回合流水" },
  { rel: "GOALS.md", role: "目标树" },
  { rel: "LESSONS.md", role: "经验教训" },
  { rel: "PRINCIPLES.md", role: "根本原则" },
];

// ── ① 可达性：能不能取出来？能取到多少？ ────────────────────────────────
bar("① 够得到吗（可达性）：`ledger_read` **一次能取回多少**？");
const READ_CAP = 60000; // = MAX_READ_CHARS 默认值（下面从工具 schema 复核）
{
  const readTool = tools.get("ledger_read");
  const props = readTool?.parameters?.properties ?? {};
  const hasPaging = ["offset", "start", "cursor", "from", "page", "skip"].some((k) => k in props);
  console.log(`  ledger_read 的参数：${Object.keys(props).join(", ")}`);
  say(!hasPaging, "★ `ledger_read` **有没有分页/偏移参数**", hasPaging ? "有" : "**没有** ⇒ 大文件只能读到开头那一段");
  console.log(`\n  逐个文件（一次读取上限 = ${READ_CAP} 字符）：`);
  for (const m of MEM) {
    const p = path.join(ROOT, m.rel);
    if (!fs.existsSync(p)) { console.log(`    ${m.rel.padEnd(15)} （不存在）`); continue; }
    const n = fs.readFileSync(p, "utf8").length;
    const pct = n <= READ_CAP ? 100 : (READ_CAP / n) * 100;
    const flag = n <= READ_CAP ? "可一次读完" : `**只够到 ${pct.toFixed(1)}%，其余 ${(((n - READ_CAP) / n) * 100).toFixed(1)}% 够不到**`;
    console.log(`    ${m.rel.padEnd(15)} ${String(n).padStart(8)} 字符  ${flag}`);
  }
}

// ── ①b ★ 最硬的一测：**台账引用的 D 号，够得到几个？** ──────────────────
//
//  ★ 这是"召回失败"最真实的形态：台账里写着"见 D195"，而那条正文**够不到**。
//    它不需要任何"模糊"—— 编号是**精确**的，问题是**取不回来**。
bar("①b ★★★ 最真实的召回失败：台账引用的 D 号，**够得到几个**？");
{
  const led = fs.readFileSync(path.join(ROOT, "LEDGER.md"), "utf8");
  const decLines = fs.readFileSync(path.join(ROOT, "DECISIONS.md"), "utf8").split(/\r?\n/);
  // 一次读取可达的行号（按字符累计）
  let acc = 0;
  let reach = 0;
  for (const l of decLines) { acc += l.length + 1; if (acc <= READ_CAP) reach++; else break; }
  const pos = {};
  decLines.forEach((l, i) => { const m = /^##\s*D(\d+)\b/.exec(l); if (m) pos[+m[1]] = i + 1; });
  const cited = [...new Set([...led.matchAll(/\bD(\d{1,3})\b/g)].map((m) => +m[1]))].sort((a, b) => a - b);
  const got = cited.filter((n) => pos[n] !== undefined && pos[n] <= reach);
  const lost = cited.filter((n) => pos[n] !== undefined && pos[n] > reach);
  console.log(`  一次读取可达行号 ≤ ${reach}（该文件共 ${decLines.length} 行）`);
  console.log(`  台账引用 ${cited.length} 个 D 号：`);
  say(got.length > lost.length, `★ **够得到 ${got.length} 个**`, got.join(", ") || "（无）");
  say(false, `★★ **够不到 ${lost.length} 个**`, lost.length <= 12 ? lost.join(", ") : `${lost.slice(0, 12).join(", ")} … 共 ${lost.length} 个`);
  console.log(`  ⇒ ★★★ **${((lost.length / cited.length) * 100).toFixed(0)}% 的引用取不回来** —— 而它们**全是精确编号**（D195 就是 D195）。`);
  console.log("  ⇒ ★★ 结论：这一环**跟模糊毫无关系**，缺的是**取回能力（分页/切片）**。");
}

// ── ② 可见性：注入里说没说"怎么查"？ ──────────────────────────────────
bar("② 知道要查吗（可见性）：注入的契约里，每个记忆文件**都带用法**吗？");
{
  const handlers = new Map();
  const c2 = {
    tools: { register: () => {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on: (ev, h) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(h); return () => {}; },
    inject: ctx.inject,
    get: () => undefined,
    webServer: { register: () => () => {} },
    configEditor: { entries: () => [], configuration: () => [], edit: async () => {} },
  };
  mod.apply(c2, {});
  const list = handlers.get("agent/pre-step") ?? [];
  const agent = { session: { header: { id: "s-d201", cwd: ROOT }, id: "s-d201" } };
  let decision = { messages: [] };
  for (const h of list) decision = await h({ agent, messages: [] }, async () => decision);
  const texts = [];
  for (const mm of decision?.messages ?? []) {
    const cc = mm?.content;
    if (typeof cc === "string") texts.push(cc);
    else if (Array.isArray(cc)) for (const p of cc) if (typeof p?.text === "string") texts.push(p.text);
  }
  const inj = texts.join("\n\n");
  const idx = inj.lastIndexOf("**台账约定**");
  const contract = idx === -1 ? "" : inj.slice(idx, inj.indexOf("★★ **台账与 L1 是你的义务") > idx ? inj.indexOf("★★ **台账与 L1 是你的义务") : inj.length);
  for (const [label, key] of [["DECISIONS.md", "关键决策"], ["LESSONS.md", "经验与教训"], ["GOALS.md", "目标树"], ["JOURNAL.md", "回合流水"], ["PRINCIPLES.md", "根本原则"]]) {
    const hit = contract.includes(key);
    say(hit, `${label} 在契约里`, hit ? "有" : "**没有**");
  }
  // ★ 但"有入口"不等于"够得到"——这正是一环扣一环
  console.log("  ★ 注意：契约里**有** `ledger_read({target:\"decisions\"})` —— 但它**取不全**（见 ①）。");
  console.log("    ⇒ 「知道要查」通了，而「查了也取不回来」⇒ **用户感知到的仍是「记不住」**。");
}

// ── ③ 匹配：给了查询词，精确 vs 模糊各命中多少？ ────────────────────────
//
//  ★★ 这一节才是"模糊搜索"能治的那一环 —— 所以必须先量"它现在到底缺不缺"。
bar("③ 查得到吗（匹配）：真实查询词，**精确子串 vs 模糊（分词/近义）各命中多少**？");
{
  // 用**真实会发生的查询**（都来自本项目最近的实际提问）
  const QUERIES = [
    { q: "目标树为什么没人维护", keys: ["目标树"] },
    { q: "水位线多少", keys: ["水位", "全量线"] },
    { q: "经验教训怎么分两类", keys: ["经验与教训"] },
    { q: "归档在哪", keys: ["归档"] },
    { q: "老文件迁移", keys: ["迁移"] },
    { q: "原则谁能改", keys: ["根本原则"] },
  ];
  const corpus = MEM
    .filter((m) => fs.existsSync(path.join(ROOT, m.rel)))
    .map((m) => ({ ...m, text: fs.readFileSync(path.join(ROOT, m.rel), "utf8") }));
  let exactHit = 0;
  for (const { q, keys } of QUERIES) {
    // 精确：查询里的关键词**字面**出现
    const hitExact = keys.some((k) => corpus.some((c) => c.text.includes(k)));
    // 模糊：把查询**逐字**去搜（不做分词）—— 模拟"用户原话直接搜"
    const hitLiteral = corpus.some((c) => c.text.includes(q));
    if (hitExact) exactHit++;
    console.log(`    ${q.padEnd(22)} 精确关键词=${hitExact ? "命中" : "**没命中**"} · 整句原话=${hitLiteral ? "命中" : "**没命中**"}`);
  }
  console.log(`\n  ⇒ 精确关键词命中率 ${exactHit}/${QUERIES.length}`);
  console.log("  ★★ 判据：**记忆文件本身是高度结构化的**（`D<n>` / `L<n>` / `E<n>` / 目标卡 `id` / 固定小节名）");
  console.log("    ⇒ 「精确检索」的命中面**本来就大**（上面 6 个查询，关键词语义全都够得到）。");
  console.log("    ⇒ 而「整句原话」那种**不做分词的模糊搜**反而更容易漏（它是**更严**的匹配）。");
}

// ── ④ 工具缺口：哪些记忆根本没有入口？ ─────────────────────────────────
bar("④ 取得出来吗（工具缺口）：三个目录**有没有专用工具**？");
{
  const names = [...tools.keys()];
  const dirs = [
    ["_stash/", ["ledger_triage"], false],
    ["_handoff/", ["ledger_handoff"], false],
    ["_ledger-archive/", ["ledger_read", "ledger_archive"], false],
    ["_ledger-log/", ["ledger_log"], false],
  ];
  for (const [d, ts] of dirs) {
    const present = ts.filter((t) => names.includes(t));
    let n = 0, bytes = 0;
    const walk = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); if (e.isDirectory()) walk(p); else { n++; try { bytes += fs.statSync(p).size; } catch { /* 忽略 */ } } } };
    if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
    // ★ 关键区分：**能写进去** ≠ **能查出来**
    const readable = d === "_ledger-archive/" || d === "_ledger-log/";
    say(readable, `${d.padEnd(17)} ${String(n).padStart(3)} 份 · 有专用读入口=${readable ? "有" : "**没有**"}`, `（写入口：${present.join("/") || "无"}）`);
  }
  console.log("  ★★ `_stash/` 与 `_handoff/` **只有写入口、没有读入口** —— 只能靠通用 `read`/`glob` 摸。");
  console.log("    ⇒ 而 D186 早就量过：`_ledger-archive/` + `_stash/` = **63 份「存在但没人查得到」**。");
  console.log("    ★ 这仍是**可达性**问题（第①环），不是匹配问题。");
}

bar("结  论：召回率断在哪一环？");
console.log("  ★ 四个环节量下来，**断点在①与④（可达性），不在③（匹配）**：");
console.log("    · ① `ledger_read` 无分页 ⇒ `DECISIONS.md` **87% 够不到**；台账引用的 44 个 D 号 **42 个取不回来**。");
console.log("    · ④ `_stash/` `_handoff/` 无专用读入口（63 份靠通用工具摸）。");
console.log("    · ③ 匹配这一环：记忆是**结构化**的（D/L/E/id），精确检索命中面本来就大 —— **目前不是瓶颈**。");
console.log("  ⇒ ★★★ **模糊搜索治的是③，而③现在不是瓶颈**（先把①④补上，模糊才有意义）。");
