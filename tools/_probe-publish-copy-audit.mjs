#!/usr/bin/env node
/**
 * ★★★★★ 发布前**硬规矩完整审计**（D312）—— 补 D224 证明的两个缺口。
 *
 * 用户 2026-10-16 亲口定的两条硬规矩：
 *   ① **过期文案审计**：README / package.json description / **面板每条 label-hint** /
 *      **每回合注入文案** / 台账头部 / decisions / docs —— 逐一核对有没有"没跟上最新进度"的。
 *   ② **面板必须与当前功能对应**：不许留着"已被合并 / 已删除 / 已反转"的旧功能描述。
 *
 * 🔴 为什么需要这个新探针（`_probe-d216-docs-audit.mjs` 已经 16/16 全绿了）：
 *   D224 **证明那个探针不完整**：它漏掉的两整个面 —— ① 面板 UI 文案 ② 每回合注入的脚注 ——
 *   在它那里**全绿**，而实际有 7 处旧口径。
 *   ★ 本轮（D311 删掉「原则型」扩展模式）**又撞到一次同型**：
 *     `package.json` 的 description 里"新增自定义扩展记忆（**7 种模式**）"过时了，
 *     而 d216 探针 16/16 全绿、一个字都没报。
 *
 * ★★★ 所以本探针的判据**不是"人肉记住要看哪些地方"**，而是三条**结构化**的：
 *    A. **数量型口径**：凡是"N 个/N 种/N 项"的说法，必须等于**代码实际数出来的**那个 N。
 *    B. **已删功能型口径**：凡是被删掉/反转的功能名，**不许再出现在任何用户可见文案里**。
 *    C. **面板与能力对应**：面板上每个开关/数值项都必须**真有消费者**（读它的代码存在）。
 *   ★ 判据只吃"被测对象自己产生的文本"—— 代码注释**不算**（注释是给维护者的，不是用户可见文案）。
 *
 * 用法：node tools/_probe-publish-copy-audit.mjs [--verbose]
 * 退出码：0 全过 / 1 有红
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const VERBOSE = process.argv.includes("--verbose");

let pass = 0;
let fail = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) {
    pass += 1;
    if (VERBOSE) console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail === undefined ? "" : ` — ${detail}`}`);
    console.log(`  ✗ ${label}${detail === undefined ? "" : `\n      ${detail}`}`);
  }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`);

/** 去掉 JS 注释（保留字符串字面量）。★ 判据输入必须是"用户可见文案"，注释是文档不是文案。 */
function stripJsComments(s) {
  let out = "";
  let i = 0;
  let mode = "code"; // code | line | block | sq | dq | bt
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") { mode = "line"; i += 2; continue; }
      if (c === "/" && n === "*") { mode = "block"; i += 2; continue; }
      if (c === "'") { mode = "sq"; out += c; i += 1; continue; }
      if (c === '"') { mode = "dq"; out += c; i += 1; continue; }
      if (c === "`") { mode = "bt"; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (mode === "line") { if (c === "\n") { mode = "code"; out += c; } i += 1; continue; }
    if (mode === "block") { if (c === "*" && n === "/") { mode = "code"; i += 2; } else i += 1; continue; }
    if (mode === "sq") { out += c; if (c === "\\") { out += s[i + 1] ?? ""; i += 2; continue; } if (c === "'") mode = "code"; i += 1; continue; }
    if (mode === "dq") { out += c; if (c === "\\") { out += s[i + 1] ?? ""; i += 2; continue; } if (c === '"') mode = "code"; i += 1; continue; }
    if (mode === "bt") { out += c; if (c === "\\") { out += s[i + 1] ?? ""; i += 2; continue; } if (c === "`") mode = "code"; i += 1; continue; }
  }
  return out;
}

const LIB = path.join(ROOT, "lib");
const readLib = (f) => fs.readFileSync(path.join(LIB, f), "utf8");
const readLibCode = (f) => stripJsComments(readLib(f));

console.log("═".repeat(78));
console.log("发布前硬规矩完整审计（D312）—— 过期文案 + 面板与功能对应");
console.log("═".repeat(78));

// ═══════════════════════════════════════════════════════════════════════════
// 代码真值：全部"数字型口径"由代码自己数出来（不抄任何写死的期望值）
// ═══════════════════════════════════════════════════════════════════════════
const defs = await import(pathToFileURL(path.join(LIB, "defs.js")).href);
const part8 = await import(pathToFileURL(path.join(LIB, "part8.js")).href);

/** 工具总数：扫 part* 里 `name: "ledger_xxx"` 字面量 + 常量引用的工具。 */
function countTools() {
  const names = new Set();
  for (const f of fs.readdirSync(LIB).filter((n) => n.endsWith(".js"))) {
    const code = readLibCode(f);
    for (const m of code.matchAll(/name:\s*"((?:ledger|mcp)[a-z_]*)"/g)) names.add(m[1]);
    // 常量引用的工具名（PRINCIPLE_GRANT_TOOL / CHECKPOINT_TOOL）
    for (const m of code.matchAll(/name:\s*(PRINCIPLE_GRANT_TOOL|CHECKPOINT_TOOL)\b/g)) {
      names.add(m[1] === "PRINCIPLE_GRANT_TOOL" ? "ledger_principles_access" : "ledger_checkpoint");
    }
  }
  return names;
}
const toolNames = countTools();

/**
 * 子命令：**从真正的分派代码里数**，不抄任何写死的表。
 *
 * ★★★ 我第一版写的是"找 index.js 里的 `const SUBS = [...]`" —— **那个东西不存在**
 *   （`SUBS` 只出现在 `selftest.mjs:8947`，是**手抄的期望值**，正是"记录 ≠ 真值"的典型）。
 *   真源是 `part5.js` 的 `runLedgerSub()` 里那一串 `if (sub === "xxx")`。
 *   ⇒ 判据：**数"分发点"，不数"文档/测试里抄的那份表"。**
 */
function countSubs() {
  const p5 = readLibCode("part5.js");
  const i = p5.indexOf("export async function runLedgerSub");
  if (i < 0) return undefined;
  // 取到下一个顶层 export 为止
  const next = p5.indexOf("\nexport ", i + 10);
  const body = next < 0 ? p5.slice(i) : p5.slice(i, next);
  const subs = [...body.matchAll(/if\s*\(\s*sub\s*===\s*"([a-z]+)"/g)].map((m) => m[1]);
  // ★ 去重（同一个子命令可能在别处还有二次判定，如 principles 下的 pending/approve）
  return [...new Set(subs)];
}
const subs = countSubs();

/** 设置项数：SETTING_SPECS 里的 key。 */
function countSettings() {
  const src = readLibCode("defs.js");
  const i = src.indexOf("SETTING_SPECS");
  if (i < 0) return undefined;
  // 找到 SETTING_SPECS = [ ... ] 的收尾（按括号配平）
  let d = 0;
  let start = -1;
  let end = -1;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === "[") { if (d === 0) start = j; d += 1; }
    else if (src[j] === "]") { d -= 1; if (d === 0) { end = j + 1; break; } }
  }
  if (start < 0 || end < 0) return undefined;
  const body = src.slice(start, end);
  // 只数"顶层"的 key（形如 `{ key: "xxx",`）—— 嵌套的 options 里也有 key
  const keys = [...body.matchAll(/(?:^|\s)\{\s*key:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]);
  return [...new Set(keys)];
}
const settings = countSettings();

const modeKeys = part8.EXT_MODE_KEYS;

console.log(`\n代码真值：工具 ${toolNames.size} · 子命令 ${subs?.length} · 设置项 ${settings?.length} · 扩展模式 ${modeKeys.length}`);
ok("工具数 > 0（判据确实读到了代码）", toolNames.size > 0, String(toolNames.size));
ok("子命令表读到了（否则后面的口径断言是空的）", Array.isArray(subs) && subs.length > 0, JSON.stringify(subs));
ok("设置项表读到了（否则后面的口径断言是空的）", Array.isArray(settings) && settings.length > 0, String(settings?.length));

// ═══════════════════════════════════════════════════════════════════════════
// A. 数量型口径：凡是写了 "N 个/N 种/N 项" 的地方，N 必须等于代码真值
// ═══════════════════════════════════════════════════════════════════════════
section("A. 数量型口径（文档说的 N 必须等于代码数出来的 N）");

const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// 中文数字映射（README 里常用"二十二个工具"这种写法）
const CN = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnToNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  // 处理 十X / X十 / X十Y / 十
  if (s === "十") return 10;
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN[s[1]];
  if (/^[一二三四五六七八九]十$/.test(s)) return CN[s[0]] * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(s)) return CN[s[0]] * 10 + CN[s[2]];
  return CN[s];
}

// A1 扩展模式数：README + package.json description 都不许与 modeKeys.length 不符
{
  const want = modeKeys.length; // 6
  // README 里的「N 种模式」
  const readmeModes = [...README.matchAll(/([0-9]+|十[一二三四五六七八九]?|[一二三四五六七八九]十[一二三四五六七八九]?|[一二三四五六七八九]) 种模式/g)]
    .map((m) => ({ raw: m[1], n: cnToNum(m[1]), idx: m.index }));
  ok(
    `A1 README 里「N 种模式」全部等于代码真值 ${want}`,
    readmeModes.length > 0 && readmeModes.every((x) => x.n === want),
    readmeModes.length === 0 ? "⛔ README 里一处「N 种模式」都没找到（判据可能是空的）" : JSON.stringify(readmeModes)
  );
  // package.json description
  const pkgModes = [...String(PKG.description ?? "").matchAll(/([0-9]+|[一二三四五六七八九]) 种模式/g)]
    .map((m) => ({ raw: m[1], n: cnToNum(m[1]) }));
  ok(
    `A1b package.json description 里「N 种模式」等于代码真值 ${want}`,
    pkgModes.every((x) => x.n === want),
    JSON.stringify(pkgModes)
  );
  // ★ 自证：description 里**确实提到**了模式数（否则 A1b 是空判据 —— 删掉那句话它就永远绿）
  ok(
    "A1c 且 description 里**确实**写了模式数（删掉那句话不该让它变绿）",
    pkgModes.length > 0,
    pkgModes.length === 0 ? "⛔ description 里没有模式数 ⇒ A1b 成了空判据" : ""
  );
}

// A2 工具数 / 子命令数 / 设置项数：README 里凡是"N 个工具""N 条子命令""N 个设置项"
{
  const checks = [
    { name: "工具", want: toolNames.size, re: /([0-9]+|十[一二三四五六七八九]?|[一二三四五六七八九]十[一二三四五六七八九]?|[一二三四五六七八九]) 个工具/g },
    { name: "子命令", want: subs.length, re: /([0-9]+|十[一二三四五六七八九]?|[一二三四五六七八九]十[一二三四五六七八九]?|[一二三四五六七八九]) 个子?命令/g },
    { name: "设置项", want: settings.length, re: /([0-9]+|十[一二三四五六七八九]?|[一二三四五六七八九]十[一二三四五六七八九]?|[一二三四五六七八九]) 个设置项/g },
  ];
  for (const c of checks) {
    const hits = [...README.matchAll(c.re)].map((m) => ({ raw: m[1], n: cnToNum(m[1]) }));
    ok(
      `A2 README 里「N ${c.name}」全部等于代码真值 ${c.want}`,
      hits.every((x) => x.n === c.want),
      hits.length === 0 ? "（README 未写这个数，不判）" : JSON.stringify(hits)
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// B. 已删/已反转功能：这些词**不许**再出现在任何用户可见文案里
// ═══════════════════════════════════════════════════════════════════════════
section("B. 已删 / 已反转功能（不许再出现在用户可见文案里）");

/**
 * ★ 每一项都是**本仓库真发生过**的删除/反转（不是猜的），带出处：
 *   写成数据表，加新项只要加一行 —— 判据不必每次重写。
 */
const RETIRED_FEATURES = [
  {
    id: "extension-principles-mode",
    // D311（2026-10-23）：用户拍板去掉「原则型」扩展模式（7→6）
    bad: /原则型(?:扩展|记忆)?|principles\s*(?:模式|mode)|7\s*种模式/,
    why: "D311：原则型扩展模式已删除（6 种模式，无 protect 模式）",
    // ★ 允许出现在"解释它为什么没有"的上下文里（README 那段是**正确的**说明）
    allow: /为什么没有「原则型」|为什么没有「原则型」|原则只该有一个出处/,
  },
  {
    id: "two-compact-modes",
    // 更早：两种压缩模式已合并为一种（增量默认关）
    bad: /两种压缩模式/,
    why: "两种压缩模式已合并为一种（增量默认关）",
  },
  {
    id: "incremental-normal",
    bad: /增量(?:压缩)?(?:是|为)?(?:常态|默认开)/,
    why: "增量压缩默认已关，不是常态",
  },
];

/** 收集用户可见文案面：README + description + 面板（client.js 的字符串字面量）+ 注入文案（part3/part6） */
function userVisibleFaces() {
  const faces = [];
  faces.push({ name: "README.md", text: README });
  faces.push({ name: "package.json description", text: String(PKG.description ?? "") });
  // 面板：client.js 去掉注释后剩下的全部（里面剩下的中文基本都会渲染）
  faces.push({ name: "lib/client.js（面板文案，已剥注释）", text: readLibCode("client.js") });
  // 每回合注入：part3（renderInjectionBody 等）+ part6（记忆面地图）
  faces.push({ name: "lib/part3.js（注入文案，已剥注释）", text: readLibCode("part3.js") });
  faces.push({ name: "lib/part6.js（记忆面地图，已剥注释）", text: readLibCode("part6.js") });
  // 工具描述（模型看得见 = 用户可感知）
  for (const f of ["part4.js", "part8tool.js", "part3.js"]) {
    faces.push({ name: `lib/${f} 的工具描述`, text: readLibCode(f) });
  }
  // 设置项 label/hint（defs.js）
  faces.push({ name: "lib/defs.js 的 SETTING_SPECS 文案", text: readLibCode("defs.js") });
  return faces;
}

const faces = userVisibleFaces();
for (const feat of RETIRED_FEATURES) {
  const hits = [];
  for (const f of faces) {
    // 逐行扫，便于报出确切位置；允许 allow 的整行豁免
    const lines = f.text.split("\n");
    lines.forEach((l, i) => {
      if (feat.bad.test(l) && !(feat.allow !== undefined && feat.allow.test(l))) {
        hits.push(`${f.name}:${i + 1}  ${l.trim().slice(0, 100)}`);
      }
    });
  }
  ok(
    `B 「${feat.id}」不再出现（${feat.why}）`,
    hits.length === 0,
    hits.length === 0 ? "" : hits.slice(0, 6).join("\n      ")
  );
}

// B-b 反向自证：判据确实在扫这些面（否则 hits 恒空 = 假绿）
{
  const totalChars = faces.reduce((a, f) => a + f.text.length, 0);
  ok("B-b 判据真的扫到了文案面（否则上面的「无残留」是假绿）", faces.length >= 6 && totalChars > 100000, `${faces.length} 个面 / ${totalChars} 字符`);
}

// ═══════════════════════════════════════════════════════════════════════════
// C. 面板与功能对应：每个设置项都必须**真有消费者**
// ═══════════════════════════════════════════════════════════════════════════
section("C. 面板与功能对应（每个设置项必须真有消费者）");

/**
 * ★ 判据：对每个 setting key，在**非 defs.js** 的 lib 代码里找它的**读取点**。
 *   ★ 为什么排除 defs.js：那里是**声明**，不是消费；在声明文件里搜到它等于没搜。
 *
 * ★★★ 我第一版只认 `settings.<key>` / `.<key>` 那种点号读法 ⇒ 报了 21 个"没有消费者"，
 *   **而那 21 个全是假红**。真实读法有**至少五种**（本仓库实测，见下）：
 *     ① `currentSettings().blockInjection`           —— 直接点号
 *     ② `precedenceValue(info, "blockInjection")`    —— **字符串键**（最隐蔽）
 *     ③ `numOf("maxArchiveList", DEFAULT)`          —— 字符串键 + 取数值
 *     ④ `capsuleUserMsgMaxOf()` / `autoFullPct()`   —— 包在**取值函数**里
 *     ⑤ `SETTING_KEYS` / `PRECEDENCE_KEYS` 数组里     —— 只登记、由框架统一处理
 *   ⇒ 判据：**在"声明文件"之外，只要这个键以任何形式出现过（字面量即可），就算有消费者。**
 *     ★ 这条比"认出五种读法"更稳：多认一种读法就得改判据，而"字面量出现过"不会漏。
 *     ★ 代价：它**偏宽**（注释里提一句也算）。但我们要的是"没有空承诺开关"，
 *       宽松漏报的后果是"某个死开关没被发现"，而严格误报的后果是**每次都要人工排除假红**
 *       —— 后者会让这条守卫被关掉（那才是最坏的结果）。
 *       ★ 为了补回宽带来的漏，另有一条**反向**：`C-c` 检查"只在 defs.js 里出现的键"，
 *         那种才是真正可疑的（声明了但全库无人读）。它是**必须为 0** 的硬判据。
 */
{
  const consumerSrc = fs
    .readdirSync(LIB)
    .filter((n) => n.endsWith(".js") && n !== "defs.js")
    .map((n) => readLibCode(n))
    .join("\n");

  const noTrace = [];
  for (const k of settings) {
    // 字面量出现即可（字符串键 / 点号 / 数组登记 全覆盖）
    if (!consumerSrc.includes(k)) noTrace.push(k);
  }
  ok(
    `C 全部 ${settings.length} 个设置项的键名在 defs.js 之外**至少出现一次**（无空承诺开关）`,
    noTrace.length === 0,
    noTrace.length === 0 ? "" : `⛔ 全库无人提及：${noTrace.join(", ")}`
  );
  // ★ 自证：绝大多数应该能搜到 —— 若一个都搜不到，说明正则或输入坏了
  ok(
    "C-b 判据不是空转（能搜到的比例 > 80%）",
    (settings.length - noTrace.length) / settings.length > 0.8,
    `找到 ${settings.length - noTrace.length}/${settings.length}`
  );
  // ★★ C-c 真正的可疑项：**只在 defs.js 里声明、别处一个字都没提** —— 这才是死开关。
  //   上面的 C 已经等价于它（noTrace 就是"别处没出现"），这里保留为**显式命名**的判据，
  //   因为它承载的是"面板与功能对应"这条硬规矩本身，不该只作为一个副产品存在。
  ok(
    "C-c ★★★ 没有「只在 defs.js 声明、全库无人读」的死开关（面板与功能对应）",
    noTrace.length === 0,
    noTrace.join(", ")
  );
}

// C2 面板文案里的**数值默认值**必须与代码真值一致（防"面板说 70% 代码是 50%"）
//
// ★★★ 这一条我连错三次，每次都是同一个病，记下来：
//   ① 找 `defaultValue: N` / `def: N` —— **那些字段名不存在**；
//   ② 找 `DEFAULT_SETTINGS = {...}` / `defaults = {...}` —— **也不存在**；
//   ③ 找到真源 `settingDefaults()` 后，**静态正则只抽出 1 项**（`turnEndPull: 1`）——
//      因为绝大多数默认值是**常量引用**（`highFidelityCompactRatio: HIGH_FIDELITY_COMPACT_RATIO`），
//      **字面量里根本没有数字**。
//   ★ 根因是同一个：**我在"读文本"而不是"问代码"**。默认值是代码算出来的，
//     文本里写的是表达式 ⇒ **静态解析必然漏**。
//   ⇒ 正解：**真的 import 进来、调一次 `settingDefaults()`**，拿真值。
//     这才是"代码真值"的字面意思（与 A 段那些"数出来"的口径同一条纪律）。
{
  const part1 = await import(pathToFileURL(path.join(LIB, "part1.js")).href);
  let dv = undefined;
  try {
    dv = part1.settingDefaults();
  } catch (e) {
    dv = undefined;
    if (VERBOSE) console.log(`      （settingDefaults() 调用失败：${String(e?.message ?? e)}）`);
  }
  ok("C2 真的调到了 `settingDefaults()`（不是静态猜）", dv !== undefined && typeof dv === "object", String(typeof dv));

  if (dv !== undefined) {
    const numEntries = Object.entries(dv).filter(([, v]) => typeof v === "number");
    if (VERBOSE) {
      console.log(`      （数值默认值 ${numEntries.length} 项：${numEntries.map(([k, v]) => `${k}=${v}`).join(" · ")}）`);
    }
    ok(
      "C2b 拿到 ≥5 个数值型默认值（否则后面的核对是空的）",
      numEntries.length >= 5,
      `${numEntries.length} 项`
    );
    // ★ C2c：**每一个数值默认值的 key 都必须是 SETTING_SPECS 登记过的** ——
    //   否则就是一个"改不了也没人知道"的幽灵默认值。
    const ghost = numEntries.map(([k]) => k).filter((k) => !settings.includes(k));
    ok(
      "C2c 每个数值默认值都在 SETTING_SPECS 里登记过（无幽灵默认值）",
      ghost.length === 0,
      ghost.length === 0 ? "" : `⛔ 未登记：${ghost.join(", ")}`
    );
    // ★ C2d：用户最关心的那条 —— 全量压缩线的**真值**必须是 70%（用户 2026-10-19 拍板）。
    //   ★ 期望值从哪来？**从用户拍板的事实来**（这是设计常量，不是"抄实现"）。
    //     写成 0.7 而不是"抄 dv 里的值" —— 否则代码改成 0.5 它也绿，那这条判据就废了。
    const ratio = dv.highFidelityCompactRatio;
    ok(
      "C2d ★★★ 全量压缩线默认值 = 0.7（用户 2026-10-19 拍板；这是**期望值**不是抄实现）",
      typeof ratio === "number" && Math.abs(ratio - 0.7) < 1e-9,
      `实际 ${ratio}`
    );
    // ★ C2e：注入文案里印出来的那个百分比，必须等于这个真值
    {
      const wantPct = typeof ratio === "number" ? Math.round(ratio * 100) : undefined;
      const p3 = readLibCode("part3.js");
      const pctHits = [...p3.matchAll(/(\d+)%/g)].map((m) => Number(m[1]));
      // 只看"压缩线"上下文里的百分比（别的整数可能是别的东西）
      const lineHits = [...p3.matchAll(/全量压缩线[^\n]{0,60}?(\d+)%/g)].map((m) => Number(m[1]));
      if (VERBOSE) console.log(`      （注入文案里的全量压缩线百分比：${JSON.stringify(lineHits)}，全部百分比 ${JSON.stringify(pctHits.slice(0, 10))}）`);
      ok(
        `C2e 注入文案里的「全量压缩线 N%」与真值一致（真值 ${wantPct}%）`,
        lineHits.length > 0 ? lineHits.every((p) => p === wantPct) : true,
        lineHits.length === 0 ? "（注入文案未直接写百分比，不判）" : JSON.stringify(lineHits)
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// D. 注入文案里的"指针"必须真的指向存在的东西（D 系列的老坑）
// ═══════════════════════════════════════════════════════════════════════════
section("D. 注入文案里的指针指向真实存在（不许死指针）");

{
  // 注入文案里提到的记忆文件名/常量，必须真在 part3/part6/part7 里被用到
  const part3 = readLibCode("part3.js");
  const part6 = readLibCode("part6.js");
  // ① SECURITY.md 的指针：必须有存在性检查（D301 修过）
  ok(
    "D SECURITY.md 的注入指针带存在性检查（不是死指针，D301）",
    /SECURITY\.md[\s\S]{0,400}?existsSync|existsSync[\s\S]{0,400}?SECURITY\.md/.test(part3),
    "在 part3 里找 SECURITY.md 与 existsSync 同现"
  );
  // ② extensions/ 面只在目录真存在时才出现（D306）
  //
  //   ★★★ 锚点必须是 **`push(EXTENSIONS_DIR`**（那一次"真的往榜里加"的调用），
  //     而不是 `EXTENSIONS_DIR` 的**常量声明** —— 声明在文件顶部（part6:2691），
  //     而存在性判断在**函数体内**（part6:13921 附近）。
  //     我第一版锚声明处 ⇒ 附近 2000 字符里一个 existsSync 都没有 ⇒ **假红**。
  //     ⇒ 判据：**找"行为发生点"，不要找"名字出现的第一处"**（与纪律 9 同型）。
  {
    const i = part6.indexOf("push(EXTENSIONS_DIR");
    const near = i < 0 ? "" : part6.slice(Math.max(0, i - 1500), i + 200);
    ok(
      "D extensions/ 进记忆面地图带存在性判断（D306）",
      i >= 0 && /fs\.existsSync\s*\(/.test(near) && /EXTENSIONS_DIR/.test(near),
      i < 0 ? "⛔ part6 里找不到 push(EXTENSIONS_DIR" : `附近 1500 字符内有 existsSync=${/fs\.existsSync\s*\(/.test(near)}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(78));
console.log(`合计：${pass} PASS / ${fail} FAIL`);
if (fail > 0) {
  console.log("\n未通过：");
  for (const f of failures) console.log(`  ✗ ${f}`);
}
console.log(fail === 0 ? "✓ 发布前两条硬规矩：全过" : "⛔ 有红 —— 修完再发布");
console.log("═".repeat(78));
process.exit(fail === 0 ? 0 : 1);
