/**
 * _probe-gemini004-findings.mjs —— D317：Gemini 审查 004 的 P1/P2 回归守卫
 *
 * 用户指令（逐字）：*"接收Gemini004报告"* —— 已核实，不是照抄报告。
 *
 * ── 本探针覆盖 5 条（报告编号 → 本文件的断言）──────────────────────────
 *   F-01① `writePrinciples`    越界时必须拒绝，不许写进源码根
 *   F-01② `archiveEvictedUserMessage` 同上
 *   F-01③ `ledger_index(op:"write")`  同上（返回 wrote:false）
 *   F-01④ `writeMidTurnDiag`   同上（静默不写）
 *   F-02    `archiveEvictedUserMessage` 必须做真实路径校验（`archiveDir` 穿越/符号链接）
 *   F-04    `v3-conformance.js` 的 SECURITY.md 检查必须用 `isUnderReal`（符号链接不能算合规）
 *
 * ★★ 判据：**每条都要能在"摘掉修复"之后变红**。见 `_reverse-verify-gemini004.mjs`。
 * ★ 与 D316/GAP-01 的关系：那是同一族病的第一次（10 处入口），这是漏掉的 4 处。
 *   ⇒ 教训：**"同一隐患在所有入口同一种处置"这条纪律，必须靠"逐入口清点"来执行，
 *     靠"我记得加了"一定会漏。** 本探针就是那次清点的产物。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve("lib");
const P2 = await import(pathToFileURL(path.join(ROOT, "part2.js")).href);
const V3 = await import(pathToFileURL(path.join(ROOT, "v3-conformance.js")).href);
const BASE = await import(pathToFileURL(path.join(ROOT, "base.js")).href);

const results = [];
const ok = (c, label, detail) => results.push({ c, label, detail });

function mktemp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `g004-${tag}-`));
}

// 造一个"memoryRoot 越界"的项目：.dsh-ledger.json 指向项目外
function badProject(tag) {
  const root = mktemp(tag);
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify({ active: "LEDGER.md", memoryRoot: "../../outside-untrusted" }),
    "utf8"
  );
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
  return root;
}

// 造一个"archiveDir 穿越"的项目（memoryRoot 合法，只有归档目录越界）
function traverseProject(tag, archiveDir) {
  const root = mktemp(tag);
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify({ active: "LEDGER.md", memoryRoot: "mem", archiveDir }),
    "utf8"
  );
  fs.mkdirSync(path.join(root, "mem"), { recursive: true });
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
  return root;
}

// ── 先在项目外铺一层"若越界就会落到这里"的哨兵目录
const sentinelParent = mktemp("sentinel");

// ═══ F-01①：writePrinciples 越界必须拒绝 ═══
{
  const root = badProject("f01a");
  let r;
  try {
    r = P2.writePrinciples(root, { content: "# 原则\n", mode: "replace", authorizedBy: "test" });
  } catch (e) {
    r = { ok: false, reason: `throw: ${e.message}` };
  }
  const leaked = fs.existsSync(path.join(root, "PRINCIPLES.md"));
  ok(r && r.ok === false, "F-01① writePrinciples 越界时被拒绝（ok:false）", `ok=${r && r.ok}`);
  ok(!leaked, "F-01① 源码根**没有**出现 PRINCIPLES.md", leaked ? "🔴 写进去了" : "没写");
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══ F-01② + F-02：archiveEvictedUserMessage 越界 / 穿越必须拒绝 ═══
{
  // 场景 A：memoryRoot 越界
  const root = badProject("f01b");
  const info = P2.inspect(root);
  const r = P2.archiveEvictedUserMessage(root, info, { text: "用户敏感原话" }, "sid00001");
  const anyArchive = fs.existsSync(path.join(root, "_ledger-archive"));
  ok(r === false, "F-01② memoryRoot 越界时 archiveEvictedUserMessage 返回 false", `returned=${r}`);
  // ★ 我第一版这里写成 `!anyArchive && !leakedFile`，而 detail 却印「没建」——
  //   **判据与它自己的说明自相矛盾**（说明说没建，判据却要求"也没建"成立才算过）。
  //   正确判据只有一条：**源码根下不许出现归档目录**。
  ok(!anyArchive, "F-01② 源码根**没有**出现 _ledger-archive", anyArchive ? "🔴 建出来了" : "没建");
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // 场景 B：archiveDir 用 ../ 穿越（memoryRoot 合法）
  const root = traverseProject("f02a", "../../escaped-outside-dir");
  const escapeTarget = path.resolve(root, "../../escaped-outside-dir");
  const existedBefore = fs.existsSync(escapeTarget);
  const info = P2.inspect(root);
  let r;
  try {
    r = P2.archiveEvictedUserMessage(root, info, { text: "用户原话" }, "sid00002");
  } catch (e) {
    r = `throw:${e.message}`;
  }
  const existAfter = fs.existsSync(escapeTarget);
  ok(r === false, "F-02 archiveDir 用 `../` 穿越时被拒绝", `returned=${r}`);
  ok(existedBefore || !existAfter, "F-02 项目外**没有**被递归建出目录", existAfter ? "🔴 建出了" : "没建");
  if (existAfter && !existedBefore) fs.rmSync(escapeTarget, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══ F-01③：ledger_index(op:"write") 越界必须返回 wrote:false ═══
//   ★ 这里直接检查源码里那个守卫存在且有结构（真调工具需要完整 state，成本高且易碎）
{
  const src = fs.readFileSync(path.join(ROOT, "part4.js"), "utf8");
  // ★ 我第一版用 `indexOf('if (args?.op === "write")')` 定位，但那段 4 行注释 + memBase 赋值
  //   在**我要切的那一段之前**，所以 `slice(-900, +200)` 切歪了 ⇒ 假红（detail 却印「命中」）。
  //   ⇒ 改成**锚函数名 + 取到函数尾**，不再靠猜偏移。
  const fnStart = src.indexOf("export function defineIndexTool(");
  const fnEnd = src.indexOf("\nexport function ", fnStart + 10);
  const seg = src.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 6000);
  ok(/refuseIfMemoryRootUnsafe\(info\)/.test(seg), "F-01③ ledger_index 写分支前有 refuseIfMemoryRootUnsafe", "在 defineIndexTool 函数体内");
  ok(/args\?\.op === "write" && unsafeIdx !== undefined/.test(src), "F-01③ 越界时该分支返回 wrote:false（不是照写）", "命中");
}

// ═══ F-01④：writeMidTurnDiag 越界必须不写 ═══
{
  const src = fs.readFileSync(path.join(ROOT, "part3.js"), "utf8");
  const i = src.indexOf("function writeMidTurnDiag(");
  const seg = src.slice(i, i + 1400);
  ok(/refuseIfMemoryRootUnsafe\(infoD\)/.test(seg), "F-01④ writeMidTurnDiag 有 refuseIfMemoryRootUnsafe 守卫", "命中");
  ok(/if \(refuseIfMemoryRootUnsafe\(infoD\) !== undefined\) return;/.test(seg), "F-01④ 越界时直接 return（不写诊断文件）", "命中");
}

// ═══ F-02：必须**真的**做 isUnderReal 校验（不是只靠 refuseIfMemoryRootUnsafe）═══
{
  const src = fs.readFileSync(path.join(ROOT, "part2.js"), "utf8");
  const i = src.indexOf("export function archiveEvictedUserMessage(");
  const seg = src.slice(i, i + 2200);
  ok(/isUnderReal\(memBase,\s*file\)\.ok !== true/.test(seg), "F-02 落盘前有 isUnderReal(memBase, file) 校验", "命中");
  ok(/path\.resolve\(memBase, \.\.\.relFile\.split/.test(seg), "F-02 用 path.resolve 而不是裸 path.join（join 不会归约 `..`）", "命中");
}

// ═══ F-04：v3-conformance.js 的 SECURITY.md 检查用 isUnderReal ═══
{
  const src = fs.readFileSync(path.join(ROOT, "v3-conformance.js"), "utf8");
  ok(!/isUnder\(mBaseV3/.test(src), "F-04 不再有词法 isUnder(mBaseV3, …)", "已移除");
  ok(/isUnderReal\(mBaseV3, secAbs\)\.ok === true/.test(src), "F-04 SECURITY.md 检查走 isUnderReal", "命中");
  // ★ 关键：必须真的 import 进来（D307 那个坑：用了却没 import ⇒ ReferenceError）
  ok(/import \{[^}]*isUnderReal[^}]*\} from "\.\/base\.js"/.test(src), "F-04 isUnderReal 真的 import 了（不是只在注释里）", "命中");
  // ★ 且不能因为改这个而把 verifyManifestMirror 的 import 弄丢（我犯过）
  ok(/import \{ verifyManifestMirror \} from "\.\/manifest-mirror\.js"/.test(src), "F-04 没有误删 verifyManifestMirror 的 import（我犯过一次）", "命中");
}

// ═══ F-04 真机行为：**词法 vs 真实路径**在 junction 上必须给出不同答案 ═══
//   ★ 第一次我拿"文件级符号链接"做夹具 ⇒ Windows 无权限 ⇒ 跑不通 ⇒ 我把那条**当成记录放过去了**。
//     那是本项目明确禁止的「夹具没跑通就当通过」。
//   ⇒ 改用 **目录 junction**（Windows 普通用户可建，实测 realpathSync 会解析出去）+ 让目标落在
//     `mem/sub/SECURITY.md` 这种**多层**位置 ⇒ 词法与真实路径判定**真的分叉**。
//   ★ 但 `v3ConformanceGaps` 的 SECURITY.md 路径是固定的 `mem/SECURITY.md`（单层），
//     没法让 junction 出现在它中间。⇒ 所以这里**直接测那两把尺子**，并**同时**断言合规侧用的是后者。
//     判据：**只要 isUnder 与 isUnderReal 在这条路径上结论不同，而合规代码用 isUnderReal，
//     那么"外部链接会被拒"就是被证明的** —— 不依赖具体文件的摆放形状。
{
  const base = mktemp("f04a");
  const outside = mktemp("f04b");
  fs.writeFileSync(path.join(outside, "SECURITY.md"), "# 外部安全原则\n", "utf8");
  fs.mkdirSync(path.join(base, "mem"), { recursive: true });
  let junctionOk = false;
  try {
    fs.symlinkSync(outside, path.join(base, "mem", "sub"), "junction");
    junctionOk = true;
  } catch {
    junctionOk = false;
  }
  if (!junctionOk) {
    ok(false, "F-04 真机：junction 夹具", "🔴 本机建不出 junction ⇒ 这一条**未验证**（不许当通过）");
  } else {
    const cand = path.join(base, "mem", "sub", "SECURITY.md");
    const lex = BASE.isUnder(path.join(base, "mem"), cand);
    const real = BASE.isUnderReal(path.join(base, "mem"), cand);
    ok(lex === true, "F-04 真机：词法 isUnder 会把 junction 内的外部路径判成「在内」", `isUnder=${lex}`);
    ok(real.ok === false, "F-04 真机：isUnderReal 认出它真实落在外（ok:false）", `ok=${real.ok}`);
    ok(
      lex === true && real.ok === false,
      "F-04 ★ 两把尺子**结论相反** ⇒ 换尺子这件事确实改变了判定（不是等价改写）",
      "词法 true / 真实 false"
    );
  }
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

fs.rmSync(sentinelParent, { recursive: true, force: true });

// ── 汇总
let pass = 0;
let fail = 0;
for (const r of results) {
  console.log(`  ${r.c ? "PASS" : "FAIL"}  ${r.label}  —— ${r.detail}`);
  if (r.c) pass++;
  else fail++;
}
console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail ? 1 : 0);
