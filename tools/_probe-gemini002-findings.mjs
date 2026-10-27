#!/usr/bin/env node
/**
 * Gemini 静态审查 002（v1.6.2）发现的**反向验证**（D316）
 *
 * 纪律：每条先能看见红（先证"当前代码确实会错"，才有资格说"修好了"）。
 * ★ 与 001 那份的区别：这一份几乎全部是**我上一轮修 F-01/F-02 时自己引入的回归** ——
 *   所以它不是"别人的意见"，是"我的修法漏在哪"。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECT = path.resolve(process.cwd());
const lib = (n) => path.join(PROJECT, "lib", n);
const SRC = {
  part5: fs.readFileSync(lib("part5.js"), "utf8"),
  part3: fs.readFileSync(lib("part3.js"), "utf8"),
  base: fs.readFileSync(lib("base.js"), "utf8"),
  part2: fs.readFileSync(lib("part2.js"), "utf8"),
  part4: fs.readFileSync(lib("part4.js"), "utf8"),
  // ★★★ 2026-10-26（D328）：`defineNoteTool` / `defineHandoffTool` / `defineLockTool`
  //   已**整块搬出** `part4.js` → `workspace-tools.js`（给 part4 腾容量）。
  //   ⇒ 原来在 `part4` 里 grep `defineHandoffTool` 会**假红**（GAP-01c 当场变红）。
  //   ★ 判据（与上文那条 D323 注释同源）：**跟着实现走，不跟文件走** ——
  //     要核的是「那个函数里有没有接线」，不是「它在哪个文件里」。
  workspaceTools: fs.readFileSync(lib("workspace-tools.js"), "utf8"),
  // ★★★ 2026-10-26（D332）：四个 `define*Tool`（含 `ledger_goals` / `ledger_lessons`）已
  //   **整块搬出** `part2.js` → `part2-tools.js`（给 part2 的 392 B 余量腾空间）。
  //   ⇒ GAP-01c/d/e 那三条原来只读 `part2.js` ⇒ 搬家后**假红**（实测 4 条）。
  //   ★ 判据同上一条注释（D328）：**跟着实现走，不跟文件走** ——
  //     要核的是「那个函数里有没有接线」，不是「它在哪个文件里」。
  part2Tools: fs.readFileSync(lib("part2-tools.js"), "utf8"),
  part8: fs.readFileSync(lib("part8.js"), "utf8"),
  pkg: fs.readFileSync(path.join(PROJECT, "package.json"), "utf8"),
};
// ★★★ 2026-10-25（D323 · 005 F-07）：这条守卫的实现已从 `part3.js` 搬到 `log-collector.js`
//   （`createLogCollector` 整块搬走）。原来硬编码查 part3 ⇒ 搬家后假红。
//   ★★ 顺带查出一个**更早的错**：`flushLogBuffer` 这个名字**在代码里根本不存在** ——
//     它是当年写这条判据时的**误称**（那段代码是 `createLogCollector` 里的一个内联闭包，
//     没有独立函数名）。旧判据因为查的是 `isUnderReal(base, abs).ok` 这个**特征串**，
//     恰好还能命中，所以那个错名一直没暴露。
//   ⇒ 现在的判据：**在"含 createLogCollector 的那份文件"里找特征串**；
//     找不到就说清是"搬家搬丢了"，而不是含糊地报红。
const LIBDIR = path.join(PROJECT, "lib");
const findCollectorSrc = () => {
  const hits = [];
  for (const f of fs.readdirSync(LIBDIR)) {
    if (!f.endsWith(".js")) continue;
    const t = fs.readFileSync(path.join(LIBDIR, f), "utf8");
    if (/export function createLogCollector\s*\(/.test(t)) hits.push({ file: f, text: t });
  }
  return hits;
};

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail === undefined ? "" : "  — " + detail}`); }
};

// 剥注释（保留行结构），用于静态扫描
function stripComments(src) {
  let out = "";
  let i = 0, n = src.length;
  let inBlock = false, inLine = false, inStr = null;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (inBlock) { if (c === "*" && c2 === "/") { inBlock = false; i += 2; out += "  "; } else { out += c === "\n" ? "\n" : " "; i++; } continue; }
    if (inLine) { if (c === "\n") { inLine = false; out += "\n"; } else out += " "; i++; continue; }
    if (inStr) {
      if (c === "\\") { out += "  "; i += 2; continue; }
      if (c === inStr) { inStr = null; } out += c; i++; continue;
    }
    if (c === "/" && c2 === "*") { inBlock = true; i += 2; out += "  "; continue; }
    if (c === "/" && c2 === "/") { inLine = true; i += 2; out += "  "; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

// 找出所有 isUnderReal(...) 调用，返回 {line, hasOk, isDeclOrAssign}
function scanIsUnderReal(src, file) {
  const clean = stripComments(src);
  const lines = clean.split(/\r?\n/);
  const bad = [];
  let total = 0, withOk = 0;
  lines.forEach((ln, i) => {
    let idx = 0;
    while ((idx = ln.indexOf("isUnderReal(", idx)) >= 0) {
      // 跳过函数定义本身 `export function isUnderReal(root, target)`
      if (/function\s+$/.test(ln.slice(Math.max(0, idx - 20), idx))) { idx += 11; continue; }
      let d = 0, j = idx + "isUnderReal".length;
      for (; j < ln.length; j++) { if (ln[j] === "(") d++; else if (ln[j] === ")") { d--; if (d === 0) break; } }
      const after = ln.slice(j + 1);
      const before = ln.slice(0, idx);
      total++;
      if (/^\s*\.\s*ok\b/.test(after)) { withOk++; idx = j + 1; continue; }
      // 赋值/声明形式（const r = ... ; const chk = ...）是合法的
      if (/=\s*$/.test(before.trimEnd())) { withOk++; idx = j + 1; continue; }
      bad.push({ file, line: i + 1, text: ln.trim().slice(0, 130) });
      idx = j + 1;
    }
  });
  return { total, withOk, bad };
}

console.log("═══ NEW-01 · 所有 isUnderReal 调用必须判 `.ok`（对象恒真陷阱）═══");
{
  let all = { total: 0, withOk: 0, bad: [] };
  for (const [k, v] of Object.entries(SRC)) {
    if (k === "pkg") continue;
    const r = scanIsUnderReal(v, k + ".js");
    all.total += r.total; all.withOk += r.withOk; all.bad.push(...r.bad);
  }
  console.log(`    扫描：共 ${all.total} 处 isUnderReal 调用，其中 ${all.withOk} 处已正确判 .ok`);
  ok(
    "NEW-01a ★ 全库没有「isUnderReal(...) 直接当布尔用」的调用",
    all.bad.length === 0,
    all.bad.map((b) => `${b.file}:${b.line} ${b.text}`).join(" | "),
  );
  // 反向自证：判据真的能看见红 —— 拿一个假样本喂进去
  const fake = "if (!isUnderReal(a, b)) { boom(); }";
  const fakeR = scanIsUnderReal(fake, "fake");
  ok(
    "NEW-01b ★ 自证：把 `.ok` 去掉，上面那条判据**确实会红**（不是空判据）",
    fakeR.bad.length === 1,
    JSON.stringify(fakeR.bad),
  );
  // 细到那两处（首轮 001 未覆盖、002 抓到的）
  ok(
    "NEW-01c part5.js 的 ledger_log_write 守卫已带 .ok",
    /isUnderReal\(memBase,\s*abs\)\s*\.ok/.test(SRC.part5),
    "在 part5.js 里找不到 isUnderReal(memBase, abs).ok",
  );
  {
    const hits = findCollectorSrc();
    ok(
      "NEW-01d ★ 日志采集的路径守卫已带 .ok（**跟随 createLogCollector 所在模块**，不硬编码文件名）",
      hits.length > 0 && hits.some((h) => /isUnderReal\(base,\s*abs\)\s*\.ok/.test(h.text)),
      hits.length === 0
        ? "🔴 没有任何 lib 文件里有 createLogCollector（搬家搬丢了）"
        : `查的是 ${hits.map((h) => h.file).join(" + ")}`,
    );
  }
}

console.log("\n═══ NEW-02 · description 必须含「N 种模式」且等于代码真值 ═══");
{
  const pkg = JSON.parse(SRC.pkg);
  const desc = String(pkg.description ?? "");
  const m = [...desc.matchAll(/([0-9]+|[一二三四五六七八九]) 种模式/g)];
  ok("NEW-02a description 里**确实**写了「N 种模式」（否则 A1b 成空判据）", m.length > 0, desc.slice(0, 80));
  // ★ 代码真值必须**问代码本身**，不许用正则去猜它的写法 ——
  //   `EXT_MODE_KEYS = Object.freeze(Object.keys(EXT_MODES))` 这种派生式，正则会算出 0 个。
  //   这正是「尺子要量被测对象本身」那条纪律。
  const p8 = await import("./../lib/part8.js");
  const want = Array.isArray(p8.EXT_MODE_KEYS) ? p8.EXT_MODE_KEYS.length : NaN;
  const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const toNum = (s) => (/^\d+$/.test(s) ? Number(s) : s === "十" ? 10 : cn[s] ?? NaN);
  console.log(`    代码真值：EXT_MODE_KEYS.length = ${want}（${JSON.stringify(p8.EXT_MODE_KEYS)}）`);
  ok(
    `NEW-02b description 里的模式数等于代码真值 ${want}`,
    Number.isFinite(want) && m.length > 0 && m.every((x) => toNum(x[1]) === want),
    `desc=${JSON.stringify(m.map((x) => x[1]))} want=${want}`,
  );
  ok("NEW-02c description 仍在 300 字以内", desc.length <= 300, `长度 ${desc.length}`);
}

console.log("\n═══ GAP-01 · memoryRoot 越界时**所有**写记忆的入口都必须拒绝 ═══");
{
  // ① 统一判据函数存在
  ok("GAP-01a base.js 里存在统一判据 refuseIfMemoryRootUnsafe", /export function refuseIfMemoryRootUnsafe/.test(SRC.base));
  ok("GAP-01b 它只认 field===\"memoryRoot\"（别的越界字段不误伤）", /field === "memoryRoot"/.test(SRC.base));

  // ② 各写入口都调了它
  const sites = [
    ["part4.js writeLedger", SRC.part4, /writeLedger[\s\S]{0,4000}?(?:memRootUnsafe\s*=\s*unsafe\.find|refuseIfMemoryRootUnsafe\(info)/],
    ["part4.js archiveLedger", SRC.part4, /export function archiveLedger\([\s\S]{0,600}?refuseIfMemoryRootUnsafe/],
    ["workspace-tools.js ledger_handoff", SRC.workspaceTools, /defineHandoffTool[\s\S]{0,3000}?refuseIfMemoryRootUnsafe/],
    ["part5.js writeLog (ledger_log_write)", SRC.part5, /export function writeLog\([\s\S]{0,400}?refuseIfMemoryRootUnsafe/],
    // ★ 这两个用**精确成对形状**判：只判"出现过 refuseIfMemoryRootUnsafe" 会把
    //   import / re-export 那两次也判成绿（空判据）—— 而它们跟"接线"无关。
    //   ★★★ 2026-10-26（D332）：实现已搬到 `part2-tools.js` ⇒ 源改成 `SRC.part2Tools`
    //   （**判据本身一个字没改**，只换了"去哪儿找"——同 D328/D323 那条"跟着实现走"）。
    ["part2-tools.js ledger_goals 写侧", SRC.part2Tools, /!==\s*"tree"\)\s*\{\s*\n\s*const unsafeMem = refuseIfMemoryRootUnsafe\(info/],
    ["part2-tools.js ledger_lessons 写侧", SRC.part2Tools, /!==\s*"list"\)\s*\{\s*\n\s*const unsafeMem = refuseIfMemoryRootUnsafe\(info/],
    ["part8.js createExtension", SRC.part8, /export function createExtension\([\s\S]{0,300}?refuseUnsafeMem/],
    ["part8.js updateExtension", SRC.part8, /export function updateExtension\([\s\S]{0,300}?refuseUnsafeMem/],
    ["part8.js deleteExtension", SRC.part8, /export function deleteExtension\([\s\S]{0,400}?refuseUnsafeMem/],
    ["part8.js writeExtension", SRC.part8, /export function writeExtension\([\s\S]{0,300}?refuseUnsafeMem/],
  ];
  for (const [name, src, re] of sites) ok(`GAP-01c ${name} 已接线`, re.test(src));

  // ③ 读侧不许跟着被拒（否则「清单配错」= 整个功能不可用）
  //   ★ D332：同上，源换成 `SRC.part2Tools`（实现已搬家）。
  ok("GAP-01d ledger_goals 的 `tree`（只读）**没有**被拒（读侧宽容）", /args\?\.op\s*\?\?\s*""\)\s*!==\s*"tree"/.test(SRC.part2Tools));
  ok("GAP-01e ledger_lessons 的 `list`（只读）**没有**被拒（读侧宽容）", /args\?\.op\s*\?\?\s*""\)\s*!==\s*"list"/.test(SRC.part2Tools));
  ok("GAP-01f part8 的 listExtensions / readExtension 未接 refuseUnsafeMem（读侧宽容）", !/export function listExtensions\([\s\S]{0,200}?refuseUnsafeMem/.test(SRC.part8));
}

console.log("\n═══ GAP-02 · .gitignore 末尾有 `!<memoryRoot>/` 时 conform 仍能修 ═══");
{
  // ★ 这一条不是扫源码，而是**真造一个反选场景跑一遍** ——
  //   因为"代码里有没有那个分支"证明不了"它到底会不会追加行"（空判据的典型）。
  const { repairConformance } = await import("./../lib/part4.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gem002-gap02-"));
  let detail = "";
  try {
    const memDir = "mem-memory";
    fs.mkdirSync(path.join(tmp, memDir), { recursive: true });
    fs.writeFileSync(path.join(tmp, memDir, "LEDGER.md"), "# 台账\n\n- 初始\n", "utf8");
    const manifest = {
      version: 1,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      lessons: "LESSONS.md",
      goals: "GOALS.md",
      archiveDir: "_ledger-archive",
      logDir: "_ledger-log",
      memoryRoot: memDir,
      maxActiveLines: 300,
      revision: 0,
      protocolVersion: 3,
    };
    fs.writeFileSync(path.join(tmp, ".dsh-ledger.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(tmp, memDir, ".dsh-ledger.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    // ★ 关键夹具：忽略行**存在**，但后面被 `!` 反选掉了
    fs.writeFileSync(path.join(tmp, ".gitignore"), `/${memDir}/\n!${memDir}/\n`, "utf8");

    const before = fs.readFileSync(path.join(tmp, ".gitignore"), "utf8");
    const res = repairConformance(tmp, { apply: true });
    const after = fs.readFileSync(path.join(tmp, ".gitignore"), "utf8");

    // 判据：末尾必须再出现一次忽略行（把反选压回去）
    const lines = after.replace(/\r\n/g, "\n").split("\n").map((x) => x.trim());
    let lastState;
    for (const t of lines) {
      if (t === "" || t.startsWith("#")) continue;
      const isNeg = t.startsWith("!");
      const body = (isNeg ? t.slice(1) : t).replace(/^\/+/, "").replace(/\/+$/, "");
      if (body === memDir) lastState = isNeg ? "neg" : "ignore";
    }
    detail = `before=${JSON.stringify(before.split("\n"))} after_tail=${JSON.stringify(lines.slice(-4))} lastState=${lastState}`;
    ok("GAP-02a ★ 反选行之后，apply 会补追加忽略行（最后一条匹配变成 ignore）", lastState === "ignore", detail);
    ok("GAP-02b 且回执里如实说了「做了这件事」（不是悄悄改文件）", res.actions.some((a) => /反选/.test(a)), JSON.stringify(res.actions));
    ok("GAP-02c 且 changed 为 true（不许再回 changed:false, actions:[]）", res.changed === true, JSON.stringify({ changed: res.changed }));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ }
  }
}

console.log("\n═══ 汇总 ═══");
console.log(`  PASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条）`);
if (fail > 0) process.exit(1);
