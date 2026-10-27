// ★ 014 修复后的**复验探针**（口径已按第一版踩到的 5 处尺子错重新写过）。
//
// 为什么要有这一份，而不是直接删掉第一版里那 6 条 FAIL：
//   第一版探针有 5 处**自己的口径错**（见 D335 §四）：
//     ① `^section(` 锚行首，而真实调用缩进了 2 个空格 ⇒ 判"没调用"（冤枉）
//     ② `if (id === "")` 搜全文件，命中了**更早的 lessons 工具** ⇒ 判"校验在前"（假 PASS）
//     ③ `existsSync→renameSync` 限 400 字符窗，实际隔着 6 行注释 ⇒ 假 PASS
//     ④ `text === undefined &&` 取后 300 字符窗，而 `!silentBecauseDecided` 在外层同一 if 里、窗口外 ⇒ 冤枉
//     ⑤ `if (op === "rm")` 搜全文件，命中 lessons 的 rm ⇒ 看错函数
//   ⇒ **断言过期/口径错时，改守法而不是删断言**（D333 的判据）。
//
// 本文件的口径纪律：
//   · 源码文本类判据：**先锚定"在哪个函数体内"**，再在体内搜；
//   · 缩进无关的判据：一律 `^\s*` 而不 `^`；
//   · 行序类判据：**比行号**，不比"中间隔多少字符"；
//   · 行为类判据：**真调用**那个函数，看返回值 —— 不读源码猜。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = (n) => pathToFileURL(path.join(ROOT, "lib", n)).href;
const src = (n) => fs.readFileSync(path.join(ROOT, "lib", n), "utf8");

let pass = 0,
  fail = 0;
const ok = (t, c, extra = "") => {
  if (c) {
    pass++;
    console.log(`  PASS  ${t}`);
  } else {
    fail++;
    console.log(`  FAIL  ${t}${extra ? `\n        ↳ ${extra}` : ""}`);
  }
};

/** 切出某个函数体（从 `export function NAME` 到下一个顶层 `export function` / 文件尾）。 */
function fnBody(name) {
  const files = fs.readdirSync(path.join(ROOT, "lib")).filter((n) => n.endsWith(".js"));
  for (const f of files) {
    const t = src(f);
    const i = t.indexOf(`export function ${name}`);
    if (i < 0) continue;
    const rest = t.slice(i + 10);
    const m = /\nexport (?:function|const|let|class) /.exec(rest);
    const body = m ? rest.slice(0, m.index) : rest;
    return { file: f, body, offset: i };
  }
  return null;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d335-verify-"));
console.log(`夹具：${tmp}\n`);

// ══════════════════════════════════════════════════════════
console.log("═══ F-01（跨卷目录搬迁 / 坏清单 / 悬空链接）═══");
{
  const b = fnBody("moveAcrossVolumes");
  const hasLstat = b && /lstatSync/.test(b.body);
  const hasDir = b && /isDirectory\(\)/.test(b.body);
  ok("F-01① moveAcrossVolumes 有 lstat + isDirectory 分支（不再对目录 readFileSync）", hasLstat && hasDir, b ? `见 lib/${b.file}#moveAcrossVolumes` : "找不到函数");

  // ★★★ 尺子错第 43 处（修正）：上面那条只核"字面量在不在"——**数得到 ≠ 还在用**（尺子错第 19 条同型）。
  //   反向验证时我把 `if (st.isDirectory())` 改成 `if (false && st.isDirectory())`，
  //   字面量仍在 ⇒ 断言照样绿 ⇒ **漏检**。
  //   ⇒ 改成**行为判据**：目录分支必须真的调 `copyDirVerified`，且该分支必须排在 `readFileSync(fromAbs)` **之前**。
  const callsCopyDir = b && /copyDirVerified\(\s*fromAbs\s*,\s*toAbs\s*\)/.test(b.body);
  const dirBeforeRead = b ? b.body.indexOf("st.isDirectory()") >= 0 && b.body.indexOf("st.isDirectory()") < b.body.indexOf("readFileSync(fromAbs)") : false;
  // ★★★ 尺子错第 45 处（修正）：文本判据在这里有**结构性盲区** ——
  //   把 `if (st.isDirectory())` 短路成 `if (false && …)` 之后，
  //   `copyDirVerified(fromAbs, toAbs)` 这行**仍然留在源码里**（只是永不执行），
  //   任何静态判据都看不见差别。⇒ 必须**真跑一次**。
  //   ★ 判据升级：**能跑的就别只读** —— 只有执行才能区分"写着"与"在用"。
  const bRoot = path.join(tmp, "f01x");
  fs.mkdirSync(bRoot, { recursive: true });
  const dirSrc = path.join(bRoot, "asDir");
  fs.mkdirSync(path.join(dirSrc, "inner"), { recursive: true });
  fs.writeFileSync(path.join(dirSrc, "a.txt"), "AAA");
  fs.writeFileSync(path.join(dirSrc, "inner", "b.txt"), "BBB");
  const dirDst = path.join(bRoot, "movedDir");
  const { moveAcrossVolumes } = await import(LIB("base.js"));
  let mv = null;
  try {
    mv = moveAcrossVolumes(dirSrc, dirDst);
  } catch (e) {
    mv = { ok: false, reason: `抛了异常：${String((e && e.message) || e)}` };
  }
  const dstOk =
    fs.existsSync(path.join(dirDst, "a.txt")) &&
    fs.readFileSync(path.join(dirDst, "a.txt"), "utf8") === "AAA" &&
    fs.existsSync(path.join(dirDst, "inner", "b.txt")) &&
    fs.readFileSync(path.join(dirDst, "inner", "b.txt"), "utf8") === "BBB";
  console.log(`        真搬一个目录：返回值=${JSON.stringify(mv)} · 目标内容齐全=${dstOk}`);
  // ★★★ 尺子错第 46 处（修正）：上面那次真调用走的是 **`how:"rename"`**（同卷），
  //   **根本没进 EXDEV 分支** ⇒ 它测的不是 F-01① 说的那条路。
  //   ⇒ 判据：**行为判据必须真的走到被测那条分支**，否则"跑通了"照样什么都没证明。
  //   本机有两个卷（C: 与 D:）⇒ 用**真跨卷**触发 EXDEV：C 建 → D 搬。
  const cRoot = fs.mkdtempSync("C:\\d335exdev-");
  const dRoot = fs.mkdtempSync("D:\\d335exdev-");
  try {
    const xSrc = path.join(cRoot, "asDir");
    fs.mkdirSync(path.join(xSrc, "inner"), { recursive: true });
    fs.writeFileSync(path.join(xSrc, "a.txt"), "AAA");
    fs.writeFileSync(path.join(xSrc, "inner", "b.txt"), "BBB");
    const xDst = path.join(dRoot, "movedDir");
    let mvx = null;
    try {
      mvx = moveAcrossVolumes(xSrc, xDst);
    } catch (e) {
      mvx = { ok: false, reason: `抛了异常：${String((e && e.message) || e)}` };
    }
    const xOk =
      fs.existsSync(path.join(xDst, "a.txt")) &&
      fs.readFileSync(path.join(xDst, "a.txt"), "utf8") === "AAA" &&
      fs.existsSync(path.join(xDst, "inner", "b.txt")) &&
      fs.readFileSync(path.join(xDst, "inner", "b.txt"), "utf8") === "BBB";
    const srcGone = !fs.existsSync(xSrc);
    console.log(`        真跨卷（C:→D:）：返回值=${JSON.stringify(mvx)} · 目标齐全=${xOk} · 源已删=${srcGone}`);
    ok(
      "F-01①d 真跨卷搬**目录**走 copy 分支、不抛 EISDIR、内容逐字节到位且删源",
      mvx !== null && mvx.ok === true && mvx.how === "copy" && xOk && srcGone,
      JSON.stringify(mvx),
    );
  } finally {
    try {
      fs.rmSync(cRoot, { recursive: true, force: true });
      fs.rmSync(dRoot, { recursive: true, force: true });
    } catch {}
  }

  const p7 = fnBody("migrateToV3");
  const hasBroken = p7 && /manifestBroken/.test(p7.body);
  ok("F-01② 坏清单有 manifestBroken 分支（不误报『没有清单』）", !!hasBroken);

  // 行序判据：lstatSync(memAbs) 必须在 renameSync(partialAbs, memAbs) **之前**
  const lines = src("part7.js").split("\n");
  let lstatLine = -1,
    renameLine = -1;
  for (let n = 0; n < lines.length; n++) {
    if (lstatLine < 0 && /lstatSync\(\s*memAbs\s*\)/.test(lines[n])) lstatLine = n + 1;
    if (renameLine < 0 && /renameSync\(\s*partialAbs\s*,\s*memAbs\s*\)/.test(lines[n])) renameLine = n + 1;
  }
  ok(
    "F-01③ 悬空链接：lstatSync(memAbs) 在 renameSync 之前",
    lstatLine > 0 && renameLine > 0 && lstatLine < renameLine,
    `lstat @${lstatLine} · rename @${renameLine}`,
  );
}

// ══════════════════════════════════════════════════════════
console.log("\n═══ F-02（卡片自根 / 核心记忆保护 / 归档限域）═══");
{
  const { cardDirIsSafe, isSafeCardKey, listCards, writeCard, removeCard } = await import(LIB("card-ops.js"));
  const root = path.join(tmp, "f02");
  fs.mkdirSync(root, { recursive: true });
  const ORIG = "# 根本原则\n\n- 用户定的，模型不许改\n";
  for (const n of ["LEDGER.md", "PRINCIPLES.md", "SECURITY.md", "JOURNAL.md"]) fs.writeFileSync(path.join(root, n), ORIG);

  ok('F-02① cardDirIsSafe 拒绝 "."', cardDirIsSafe(root, ".").ok !== true);
  ok("F-02①b isSafeCardKey 拒绝 SECURITY", isSafeCardKey("SECURITY") !== true);
  ok("F-02① listCards 不把核心记忆当卡片", listCards(root, ".").length === 0, `实际 ${JSON.stringify(listCards(root, "."))}`);

  writeCard(root, ".", "PRINCIPLES", "# 覆盖\n");
  ok("F-02② writeCard 不能覆盖 PRINCIPLES.md", fs.readFileSync(path.join(root, "PRINCIPLES.md"), "utf8") === ORIG);
  removeCard(root, ".", "PRINCIPLES");
  ok("F-02② removeCard 不能删除 PRINCIPLES.md", fs.existsSync(path.join(root, "PRINCIPLES.md")));

  const p4 = src("part4.js");
  const anchor = p4.indexOf("const rel = typeof args?.archiveFile");
  const seg = anchor >= 0 ? p4.slice(anchor, anchor + 1600) : "";
  ok("F-02③ archiveFile 被限制在归档目录内", /isUnderReal\(\s*dir\s*,\s*file\s*\)/.test(seg));
}

// ══════════════════════════════════════════════════════════
console.log("\n═══ F-03（目标树：清单污染 / 树根提升 / 多跳环 / rm 边界）═══");
{
  const g = fnBody("defineGoalsTool");
  ok("F-03① registerGoalsInManifest 在 id 校验之后", !!g && g.body.indexOf("registerGoalsInManifest(") > g.body.indexOf('if (id === "")'), g ? "见 defineGoalsTool 体内" : "找不到函数");
  ok("F-03①b 单文件 rm 有 isUnderReal 守卫", !!g && /isUnderReal\(\s*mBaseG\s*,\s*abs\s*\)/.test(g.body));
  ok("F-03③ 有多跳祖先环检测（visited）", !!g && /visited/.test(g.body));

  // F-03② 用源码里的真实判据核：显式 "-" 必须落到 null，而不是 existing.parent
  const sim = g ? /rawParent\s*===\s*undefined\s*\|\|\s*rawParent\s*===\s*null/.test(g.body) && /trimmedParent\s*===\s*""/.test(g.body) : false;
  ok('F-03② 显式 parent:"-" 落为 null（不再回退 existing.parent）', sim, "靠「未传 parent」与「显式传根标记」两组条件分开判");
}

// ══════════════════════════════════════════════════════════
console.log("\n═══ F-04（静默守卫 / 坏清单保护 / repair 补 active / modeSource / compactCounts）═══");
{
  const idx = src("index.js");
  // ★★★ 尺子错第 42 处（修正）：`text === undefined &&` 在 index.js 里**有两处**
  //   （第 1 处属增量压缩：`enableDelta && text === undefined && !forcedLight …`；
  //     第 2 处才是 014 修的 70% 全量分支）。
  //   第一版用 `indexOf` 只拿到第 1 处 ⇒ 判「没修」⇒ **冤枉**。
  //   ⇒ 判据：**核"某模式出现处"时，别假设只有一处** —— 穷举全部，再问"该改的那一处改没改"。
  const sites = [];
  let cursor = -1;
  while ((cursor = idx.indexOf("text === undefined &&", cursor + 1)) >= 0) {
    const open = idx.lastIndexOf("if (", cursor);
    const close = idx.indexOf(") {", cursor);
    sites.push({ at: cursor, cond: open >= 0 && close > cursor ? idx.slice(open, close) : "" });
  }
  const withSilent = sites.filter((s) => /silentBecauseDecided/.test(s.cond));
  console.log(`        找到 ${sites.length} 处 \`text === undefined &&\`；其中带 silentBecauseDecided 的 ${withSilent.length} 处`);
  ok(
    "F-04① 70% 自造分支判了 silentBecauseDecided",
    withSilent.length >= 1,
    `共 ${sites.length} 处，无一含 silentBecauseDecided ⇒ 用户说「不要台账」仍被强令写台账`,
  );

  const p3 = src("part3.js");
  const occ = fnBody("offerConformChoice");
  ok("F-04② 清单读不出时不裸写覆盖", !!occ && !/readManifest\([^)]*\)\s*\?\?\s*\{\}/.test(occ.body));

  const rp = fnBody("repairConformance");
  ok("F-04③ repairConformance 补写 active", !!rp && /nextManifest\.active\s*=/.test(rp.body));

  const st = fnBody("defineStatusTool");
  ok("F-04③b modeSource 尊重 settingPrecedence", !!st && /precedenceFromManifest/.test(st.body));

  const { compactCountsOf } = await import(LIB("part5.js"));
  let threw = null;
  try {
    compactCountsOf(undefined, "sid");
  } catch (e) {
    threw = String((e && e.message) || e);
  }
  ok("F-04④ compactCountsOf 对空 state 不抛", threw === null, threw ?? "");
}

// ══════════════════════════════════════════════════════════
console.log("\n═══ F-05（根目录稿 / ./ 前缀与自定义角色）═══");
{
  const ms = fnBody("memorySurfaces");
  const pushSeg = ms ? ms.body.slice(ms.body.indexOf("const push ="), ms.body.indexOf("const push =") + 900) : "";
  // 口径：允许 rel==="" **仅当** label 是"根目录稿"（即条件是复合的，不是无条件 return）
  const unconditional = /if\s*\(\s*typeof rel !== "string"\s*\|\|\s*rel === ""\s*\)\s*return/.test(pushSeg);
  ok('F-05①「根目录稿」(rel==="") 不被无条件丢弃', !!ms && !unconditional, "push() 的判据必须放行 label==='根目录稿'");

  const dt = fnBody("detectTrackedMemory");
  ok("F-05② detectTrackedMemory 剥除 ./ 前缀", !!dt && /replace\(\s*\/\^\(\?:\\\.\\\/\)\+\//.test(dt.body));
}

// ══════════════════════════════════════════════════════════
console.log("\n═══ F-06（扩展面板删除确认）═══");
{
  const c = src("client.js");
  // 首次点击那一处：op:"delete", id: x.id（**不带** confirm）
  const firstClick = /send\(\s*\{\s*op:\s*"delete"\s*,\s*id:\s*x\.id\s*\}\s*,\s*"已删除。"/.test(c);
  const confirmBtn = /send\(\s*\{\s*op:\s*"delete"\s*,\s*id:\s*pending\.id\s*,\s*confirm:\s*true\s*\}/.test(c);
  ok("F-06① 首次点删除不带 confirm:true", firstClick, "列表里的删除按钮必须让服务端自己判 needConfirm");
  ok("F-06①b 二次确认按钮才带 confirm:true", confirmBtn, "确认条上那一处**应该**带");
  ok("F-06② needConfirm 回显真扩展名", !/name:\s*r\?\.usage\?\.detail/.test(c));
}

// ══════════════════════════════════════════════════════════
console.log("\n═══ F-07（来源映射 / 情形 127 的 section）═══");
{
  const { hfSourceShort } = await import(LIB("part1.js"));
  const r = hfSourceShort("auto:midturn");
  ok('F-07① hfSourceShort("auto:midturn") 映射为中文', typeof r === "string" && !r.includes("auto:midturn"), `得到 ${JSON.stringify(r)}`);

  const st = src("../tools/selftest.mjs");
  // 口径：允许缩进 —— `^\s*section\(` 而不是 `^section\(`
  const has127 = /^\s*section\("情形 127/m.test(st);
  const has128 = /^\s*section\("情形 128/m.test(st);
  ok('F-07② 情形 127 真调了 section()（允许缩进）', has127);
  ok("F-07②b 情形 128 真调了 section()", has128);
}

console.log(`\nPROBE-COMPLETE  ${pass} PASS / ${fail} FAIL`);
