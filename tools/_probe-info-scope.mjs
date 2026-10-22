/**
 * 探针：`runMidTurnCompact` 里的 `info` 到底有没有绑定？
 *
 * 🔴 病（2026-10-21 现场）：
 *   诊断块写的是 `const rootDir = info?.projectRoot;`（part3.js:3071），
 *   而 `runMidTurnCompact(ctx, state, agent, deps)` 的形参里**没有 info**，
 *   函数体内也**没有声明** ⇒ 这是一个**自由变量**。
 *   ⇒ 若模块作用域也没有 `info`，那一行必然抛 `ReferenceError`，
 *     而它外面是 `try { ... } catch {}`（part3.js:3080）⇒ **静默吞掉**。
 *   ⇒ 于是"诊断文件永远不出现"，而**所有静态断言照样全绿**。
 *
 * ★ 这正是「记录存在 ≠ 记录准确」的同型：**代码写了 ≠ 代码跑得到**。
 *
 * 本探针**不靠读源码猜**，分两层证明：
 *   ① 静态：算出 `info` 出现处所处的**函数作用域链**，看链上有没有同名绑定。
 *   ② 行为：在沙箱里真调 `runMidTurnCompact`（diagFile=true），看文件是否出现。
 *
 * 跑法：node tools/_probe-info-scope.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra === undefined ? "" : `  ← ${extra}`}`);
  }
};

const part3Path = path.join(LIB, "part3.js");
const src = fs.readFileSync(part3Path, "utf8");
const lines = src.split(/\r?\n/);

/**
 * 极简词法：把一行里的字符串/注释抹掉，只留会参与括号计数的字符。
 * ★ 不追求完备（不做模板字面量嵌套），够用即可 —— 并且**结果由行为层交叉验证**。
 */
function stripNoise(line, st) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (st.inBlock) {
      const e = line.indexOf("*/", i);
      if (e < 0) return out;
      st.inBlock = false;
      i = e + 2;
      continue;
    }
    if (line.startsWith("/*", i)) {
      st.inBlock = true;
      i += 2;
      continue;
    }
    if (line.startsWith("//", i)) break;
    const c = line[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i += 1;
      while (i < line.length) {
        if (line[i] === "\\") {
          i += 2;
          continue;
        }
        if (line[i] === q) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// ── ① 静态：算出每个 `info` 出现处的作用域链 ──
const infoHits = [];
const braceStack = []; // 每层记：进入时的行号
{
  const st = { inBlock: false };
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const clean = stripNoise(lines[i], st);
    // 先记本行出现（用本行开始前的深度）
    if (/\binfo\b/.test(clean) && !/^\s*\*/.test(lines[i])) {
      infoHits.push({ line: i + 1, depth, text: lines[i].trim() });
    }
    for (const c of clean) {
      if (c === "{") {
        braceStack.push(i + 1);
        depth += 1;
      } else if (c === "}") {
        braceStack.pop();
        depth -= 1;
      }
    }
  }
}

// 找出所有 `const/let/var info` 的声明行
const declLines = [];
for (let i = 0; i < lines.length; i++) {
  if (/(?:const|let|var)\s+info\b/.test(lines[i])) declLines.push(i + 1);
}

/**
 * 判断某个引用是否被某个声明覆盖：
 * 朴素判据 = 声明行号 < 引用行号，且两者之间**深度不回升到 0 以下**。
 * 这里我们用更保守也更贴近真相的办法：由**行为层**做最终裁决，
 * 静态层只负责把"看起来像自由变量"的引用挑出来。
 */
const runStart = lines.findIndex((l) => /^export async function runMidTurnCompact/.test(l)) + 1;
let runEnd = lines.length;
for (let i = runStart; i < lines.length; i++) {
  if (/^(export |function |const |let |var )/.test(lines[i])) {
    runEnd = i;
    break;
  }
}

const hit = infoHits.filter((h) => h.line >= runStart && h.line < runEnd);
ok(
  `① 定位到 runMidTurnCompact（${runStart}–${runEnd} 行）`,
  runStart > 0 && runEnd > runStart,
);

/**
 * ★ 修复后这两条的**立场变了**（这是有意改的，不是为了让断言变绿）：
 *   修复前：函数体内**有** `info` 引用、且**无** `info` 声明 ⇒ 自由变量 ⇒ 必抛。
 *   修复后：函数体内**不该再有** `info` 引用 —— 改成了 `projectRootOf(agent)`。
 *   ⇒ 所以断言要写成「**不许有自由变量 info**」，而不是「必须有」。
 *   ☠ 如果我保留旧断言，修复本身会让它变红 —— 那不是"发现新问题"，那是**断言在守旧行为**。
 */
/**
 * ★★★ 这里踩过一次「判据吃掉描述它的文字」（台账纪律 3 的同型复发）：
 *   直接 `/(const|let|var)\s+info\b/` 去全文匹配，会把**我写进注释里的解释**也算上
 *   —— 例如 `// 也没有任何 \`let/const info\` 声明` 和 `// 抛 ReferenceError: info is not defined`。
 *   ⇒ 判据必须**只吃代码行**：先剥掉注释，再匹配。
 */
function stripComment(line) {
  const i = line.indexOf("//");
  if (i < 0) return line;
  // 粗判：// 之前若引号数量为偶数，认为不在字符串里（这些行没有含 // 的字符串，够用）
  const before = line.slice(0, i);
  const quotes = (before.match(/["'`]/g) ?? []).length;
  return quotes % 2 === 0 ? before : line;
}

const insideDecls = [];
for (let i = runStart; i < runEnd; i++) {
  const codeOnly = stripComment(lines[i]);
  if (/(?:const|let|var)\s+info\b/.test(codeOnly)) insideDecls.push(i + 1);
}
ok(
  "① 函数体内**没有** `const/let/var info` 的**代码级**声明（注释里提到不算）",
  insideDecls.length === 0,
  `实际有 ${insideDecls.length} 处：${insideDecls.join(",")}`,
);

// 只统计**代码行**里的 info 引用（排除注释与 JSDoc）
const codeRefs = hit.filter(
  (h) => !h.text.startsWith("//") && !h.text.startsWith("*") && /\binfo\b/.test(h.text),
);
ok(
  "① 🔴 函数体内**不再有**代码级 `info` 引用（自由变量已清除）",
  codeRefs.length === 0,
  `仍有 ${codeRefs.length} 处：${codeRefs.map((c) => `${c.line}:${c.text.slice(0, 60)}`).join(" | ")}`,
);

// 正向断言：改用 projectRootOf(agent) 取根
ok(
  "① 诊断块改用 `projectRootOf(agent)` 取项目根（唯一出口）",
  /const\s+rootDir\s*=\s*projectRootOf\(agent\)/.test(src),
);

// 形参里没有 info
const sigLines = lines.slice(runStart - 1, runStart + 3).join(" ");
ok("① 形参 `(ctx, state, agent, deps)` 里没有 info（说明不是靠传参解决的）", !/\(\s*[^)]*\binfo\b/.test(sigLines));

// ── ② 行为：真调一次，看文件出不出现 ──
console.log("\n── ② 行为层：真调 runMidTurnCompact，diagFile=true ──");

const mod = await import(pathToFileURLSafe(part3Path));
function pathToFileURLSafe(p) {
  return new URL(`file://${p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1:")}`).href;
}

ok("② part3 能加载，且导出 runMidTurnCompact", typeof mod.runMidTurnCompact === "function");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-infoscope-"));
const diagPath = path.join(tmp, ".dsh-ledger-midturn.log");

// 造一个最小可见的调用环境：diagFile 打开 + 水位在线之上
//   ★ 我们不去 mock 整个内核，只用**真实模块**导出的设置与常量。
const defs = await import(new URL("./defs.js", `file://${LIB.replace(/\\/g, "/")}/`).href);
ok("② 能拿到 MIDTURN_DIAG_FILE 常量", typeof defs.MIDTURN_DIAG_FILE === "string");

/**
 * ★★★ 这一步是我第一版**漏掉的**，而且漏得很典型：
 *   默认 `midTurnCompact=false` ⇒ `runMidTurnCompact` 在第三行就 `return {act:"none", why:"off"}`
 *   ⇒ **诊断块根本没机会跑** ⇒ 我拿到的"文件不存在"其实证明不了任何事。
 *   ☠ 这与 D285 那条教训同型：**夹具没走通，不能把夹具故障当成被测对象的问题**（纪律 6）。
 */
const part1 = await import(new URL("./part1.js", `file://${LIB.replace(/\\/g, "/")}/`).href);
defs.setActiveSettings({
  ...part1.settingDefaults(), // 完整默认值（setActiveSettings 是**整份替换**，不给全就是残缺）
  midTurnCompact: true,
  diagFile: true,
  highFidelityCompactRatio: 0.1, // 把线压到 10%，让"当前水位"必然在线上
});
const nowSettings = part1.currentSettings();
ok(
  "② 设置已真正生效：midTurnCompact=true 且 diagFile=true",
  nowSettings.midTurnCompact === true && nowSettings.diagFile === true,
  `实际 midTurnCompact=${nowSettings.midTurnCompact} diagFile=${nowSettings.diagFile}`,
);

const fakeAgent = {
  session: { header: { id: "probe-session" } },
  // projectRootOf 读 session.header.cwd
};
fakeAgent.session.header.cwd = tmp;

const state = {
  turnCompact: new Map(),
  turnObligation: new Map(),
  midTurnDbg: new Map(),
  skipAutoOffer: new Set(),
};

let thrown;
let out;
try {
  out = await mod.runMidTurnCompact({ logger: { warn() {} } }, state, fakeAgent, {
    turn: 1,
    // ★★★ 关键：`runMidTurnCompact` 第 2989 行是
    //     `const pressure = deps?.pressure ?? measurePressure(ctx, agent);`
    //   ⇒ **它自己留了注入口**。我前两版没走这里，于是沙箱里量不到水位，
    //     返回 `why:"unmeasurable"` ⇒ **诊断块根本没机会跑** ⇒ 一切断言都证明不了任何事。
    //   ☠ 这已经是本轮**第三次**踩同一个坑：夹具没走通，却差点把结论当成"被测对象坏了"。
    pressure: { ratio: 0.95 },
    // 不给 runTurnCompact ⇒ 走到 gate 之后会停，但**诊断块在那之前**
  });
} catch (e) {
  thrown = e;
}

ok("② 调用本身不抛（它内部吞异常）", thrown === undefined, thrown?.message);
console.log(`        返回值：${JSON.stringify(out)}`);

/**
 * ★★★ 关键判据：文件到底有没有被写出来。
 *   - 修复前：`info` 是自由变量 ⇒ 诊断块抛 ReferenceError ⇒ 被 catch{} 吞 ⇒ **文件不存在**。
 *   - 修复后：只要 diagFile 真为 true 且走到了诊断块，文件就该出现。
 *
 * ☠ 上一版探针把"文件不存在"写成 PASS —— **那正是假绿的来源**：
 *   它把缺陷当成了证词（纪律 11 同型）。
 *   ⇒ 现在改成**双向**：修复前跑一次应 FAIL、修复后跑一次应 PASS。
 *     本文件现在的断言立场是「**通道必须通**」，所以它是**回归探针**。
 */
const diagExists = fs.existsSync(diagPath);
console.log(`        ${diagPath} exists = ${diagExists}`);

ok("② 诊断文件**被写出**（说明诊断块真的执行了）", diagExists);

if (diagExists) {
  const back = fs.readFileSync(diagPath, "utf8");
  console.log(`        内容：${back.trim().slice(0, 300)}`);
  ok("② 内容含 [midturn] 标记", back.includes("[midturn]"));
  ok("② 内容含 act= 与 why= 字段", /act=\w+/.test(back) && /why=[\w-]*/.test(back));
  ok("② 内容含 ratio= 水位", /ratio=[\d.?]+%/.test(back));
  ok("② 写在 temp 目录里（不是真实项目）", diagPath.startsWith(tmp));
} else {
  ok("② 内容含 [midturn] 标记", false, "文件不存在，后续断言无从谈起");
  ok("② 内容含 act= 与 why= 字段", false, "文件不存在");
  ok("② 内容含 ratio= 水位", false, "文件不存在");
  ok("② 写在 temp 目录里（不是真实项目）", false, "文件不存在");
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
