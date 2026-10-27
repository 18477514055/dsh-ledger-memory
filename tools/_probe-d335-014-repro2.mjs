// ★ 014 第二组独立复现：F-01 / F-02③ / F-03① / F-04①②③ / F-06。
//   第一组（_probe-d335-014-repro.mjs）已覆盖 F-02①②b / F-03②③ / F-05①② / F-07①② / F-04④。
//   ★ 本探针只读生产代码；夹具全在 %TEMP%。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = (n) => pathToFileURL(path.join(ROOT, "lib", n)).href;
const read = (n) => fs.readFileSync(path.join(ROOT, "lib", n), "utf8");

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d335-014b-"));

// ══════════════════════════════════════════════════════════════════
console.log("═══ F-01①：moveAcrossVolumes 的 EXDEV 分支能否搬目录（不只是文件） ═══");
{
  const src = read("base.js");
  const i = src.indexOf("function moveAcrossVolumes");
  const seg = i >= 0 ? src.slice(i, i + 4000) : "";
  const hasLstat = /lstatSync/.test(seg);
  const hasIsDir = /isDirectory\(\)/.test(seg);
  const hasReadFileInExdev = /EXDEV/.test(seg) && /readFileSync\(fromAbs\)/.test(seg);
  const hasRecursiveWalk = /readdirSync/.test(seg) && /recursive/.test(seg);
  console.log(`        EXDEV 分支里 readFileSync(fromAbs)？ ${hasReadFileInExdev}；有 lstat/isDirectory 分支？ ${hasLstat && hasIsDir}；有递归目录遍历？ ${hasRecursiveWalk}`);
  ok("F-01① moveAcrossVolumes 遇到目录不走 readFileSync（不抛 EISDIR）", !(hasReadFileInExdev && !hasIsDir), "目录直接 readFileSync ⇒ EISDIR ⇒ V3 迁移第⑥步所有旧记忆目录滞留源码根");
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-01②：migrateToV3 把坏清单误报成「没有清单」 ═══");
{
  const src = read("part7.js");
  const i = src.indexOf("export function migrateToV3");
  const seg = i >= 0 ? src.slice(i, i + 3000) : "";
  const naive = /Object\.keys\(manifest\)\.length === 0\)\s*return\s*\{[^}]*没有清单/.test(seg.replace(/\s+/g, " ")) ||
    (/Object\.keys\(manifest\)\.length === 0/.test(seg) && /没有清单/.test(seg) && !/manifestBroken/.test(seg));
  console.log(`        有 manifestBroken 分支？ ${/manifestBroken/.test(seg)}；裸的「没有清单」返回？ ${/没有清单/.test(seg)}`);
  ok("F-01② 坏清单（有文件但读不出）不被误报成「没有清单」", !naive, "readManifest 返回 undefined ⇒ 误报『没有清单，先 ledger_init』 ⇒ 会覆盖现有项目");
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-01③：migrateToV3 对悬空符号链接是否先 existsSync 再 lstatSync ═══");
{
  // ★★★ 尺子错第 39 处（修正）：第一版我用 `/existsSync(memAbs)[\s\S]{0,400}?renameSync/` 判，
  //   而两者之间隔着 6 行注释（>400 字符）⇒ 匹配不到 ⇒ **假 PASS**。
  //   ⇒ 判据：**核"两行的先后关系"就按行号比**，别用"中间隔多少字符"去赌。
  const lines = fs.readFileSync(path.join(ROOT, "lib", "part7.js"), "utf8").split("\n");
  let existsLine = -1,
    renameLine = -1,
    lstatLine = -1;
  for (let n = 400; n < Math.min(lines.length, 480); n++) {
    const L = lines[n];
    if (existsLine < 0 && /!\s*fs\.existsSync\(\s*memAbs\s*\)/.test(L)) existsLine = n + 1;
    if (renameLine < 0 && /renameSync\(\s*partialAbs\s*,\s*memAbs\s*\)/.test(L)) renameLine = n + 1;
    if (lstatLine < 0 && /lstatSync\(\s*memAbs\s*\)/.test(L)) lstatLine = n + 1;
  }
  console.log(`        existsSync(memAbs) 在 ${existsLine} 行；renameSync(partial→mem) 在 ${renameLine} 行；lstatSync(memAbs) 在 ${lstatLine} 行`);
  const badOrder = existsLine > 0 && renameLine > existsLine && (lstatLine < 0 || lstatLine > renameLine);
  ok("F-01③ 悬空符号链接不被 existsSync 误判为「不存在」", !badOrder, `existsSync 先判（${existsLine}）再 rename（${renameLine}）⇒ 悬空链接 existsSync=false ⇒ 直接 rename ⇒ 抛未捕获 ENOTDIR，绕过 ${lstatLine} 行的符号链接拦截`);
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-02③：ledger_read(target:\"archive\") 是否只校验 mBase 不校验归档目录 ═══");
{
  const src = read("part4.js");
  // 取 archive 分支（从 2018 行附近的 rel 解析到 isUnderReal 检查）
  const anchor = src.indexOf("const rel = typeof args?.archiveFile");
  const seg = anchor >= 0 ? src.slice(anchor, anchor + 1200) : "";
  const checksMBase = /isUnderReal\(\s*mBase\s*,\s*file\s*\)/.test(seg);
  const checksDir = /isUnderReal\(\s*dir\s*,\s*file\s*\)/.test(seg);
  console.log(`        校验 isUnderReal(mBase, file)？ ${checksMBase}；校验 isUnderReal(dir, file)？ ${checksDir}`);
  ok("F-02③ archiveFile 被限制在归档目录内（不只项目根内）", checksDir, '只校验 mBase ⇒ archiveFile:"PRINCIPLES.md" 就能读出归档目录外的核心记忆');
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-03①：defineGoalsTool 在校验前就改清单 ═══");
{
  // ★★★ 尺子错第 38 处（修正）：第一版我用 `src.indexOf('if (id === "") return')` 找 id 校验位置，
  //   结果命中了**第 418 行 lessons 工具**那一处（比 goals 更早）⇒ 判成"校验在前"⇒ **假 PASS**。
  //   ⇒ 判据：**比两个位置之前，必须先锚定"在同一个函数体内"**。
  const src = read("part2-tools.js");
  // 先切出 defineGoalsTool 函数体
  const gStart = src.indexOf("export function defineGoalsTool");
  const nextFn = src.indexOf("\nexport function ", gStart + 10);
  const gBody = src.slice(gStart, nextFn > 0 ? nextFn : src.length);
  const gOffset = gStart;
  const regRel = gBody.indexOf("registerGoalsInManifest(root, info, targetRel)");
  const idRel = gBody.indexOf('if (id === "") return { ok: false');
  const regIdx = regRel >= 0 ? gOffset + regRel : -1;
  const idIdx = idRel >= 0 ? gOffset + idRel : -1;
  console.log(`        （锚定 defineGoalsTool 体内）registerGoalsInManifest @${regIdx}；id 校验 @${idIdx}`);
  ok("F-03① registerGoalsInManifest 在 id/op 校验**之后**才执行", regIdx > 0 && idIdx > 0 && regIdx > idIdx, "登记在 id 校验之前 ⇒ 对不存在的 id 执行 rm/status 也会把 goals 字段写进清单（磁盘没生成文件，清单已被改）");
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-03①b：单文件 op:rm 是否补了 isUnderReal 守卫 ═══");
{
  const src = read("part2-tools.js");
  const i = src.indexOf('if (op === "rm")');
  const seg = i >= 0 ? src.slice(i, i + 2500) : "";
  const writes = /writeFileAtomic\(\s*abs\s*,/.test(seg);
  const guard = /isUnderReal\(\s*mBaseG\s*,\s*abs\s*\)/.test(seg) || /isUnderReal\([^)]*abs\)/.test(seg);
  console.log(`        单文件 rm 分支 writeFileAtomic(abs)？ ${writes}；有 isUnderReal 守卫？ ${guard}`);
  ok("F-03①b 单文件 rm 写之前校验 abs 在记忆根内", !writes || guard, "直接 writeFileAtomic(abs) 而未校验边界");
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-04①：index.js 70% 水位自造分支是否漏判 silentBecauseDecided ═══");
{
  const src = read("index.js");
  const i = src.indexOf("text === undefined &&");
  const seg = i >= 0 ? src.slice(Math.max(0, i - 300), i + 900) : "";
  const hasSilent = /silentBecauseDecided/.test(seg);
  console.log(`        该分支附近出现 silentBecauseDecided？ ${hasSilent}`);
  ok("F-04① 70% 自造注入分支判了 silentBecauseDecided", hasSilent, "漏判 ⇒ 用户明确说「不要台账」的会话仍被强令写台账，破坏硬契约");
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-04②：offerConformChoice「不用改」是否会用空对象覆盖坏清单 ═══");
{
  const src = read("part3.js");
  const i = src.indexOf("offerConformChoice");
  const seg = i >= 0 ? src.slice(i, i + 3000) : "";
  const bad = /readManifest\([^)]*\)\s*\?\?\s*\{\}/.test(seg);
  console.log(`        出现 readManifest(...) ?? {} ？ ${bad}`);
  ok("F-04② 清单读不出时不裸写覆盖", !bad, "readManifest 返回 undefined ⇒ cur={} ⇒ writeManifestSynced 把原清单覆盖成只有 protocolDeclined 的单字段 JSON");
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-04③：repairConformance 是否补写 active ═══");
{
  const src = read("part4.js");
  const i = src.indexOf("export function repairConformance");
  const seg = i >= 0 ? src.slice(i, i + 9000) : "";
  const writesActive = /nextManifest\.active\s*=/.test(seg);
  console.log(`        repairConformance 里有 nextManifest.active = … ？ ${writesActive}`);
  ok("F-04③ repairConformance 补写 active（不修出缺 active 的坏档）", writesActive, "漏写 active ⇒ 生成的 .dsh-ledger.json 被 readManifest 判为坏档（manifest-missing-active）");
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-04③b：defineStatusTool 的 modeSource 是否考虑 priority ═══");
{
  const src = read("part3.js");
  const i = src.indexOf('modeSource:');
  const seg = i >= 0 ? src.slice(Math.max(0, i - 700), i + 300) : "";
  const hasPrecedence = /precedenceFromManifest/.test(seg);
  console.log(`        modeSource 计算里出现 precedenceFromManifest？ ${hasPrecedence}`);
  ok("F-04③b modeSource 尊重 settingPrecedence", hasPrecedence, '恒报 "manifest" ⇒ 面板模式与来源自相矛盾');
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-06①：client.js 首次点删除是否硬传 confirm:true ═══");
{
  const src = read("client.js");
  const hits = [...src.matchAll(/send\(\s*\{\s*op:\s*"delete"[^}]*\}\s*,\s*"已删除。"/g)].map((m) => m[0].replace(/\s+/g, " "));
  console.log(`        形如 send({op:"delete",...,"已删除。"}) 的调用 ${hits.length} 处`);
  for (const h of hits) console.log(`        ${h.slice(0, 110)}`);
  const hardConfirm = hits.some((h) => /confirm\s*:\s*true/.test(h));
  ok("F-06① 首次点删除不携带 confirm:true", !hardConfirm, "硬传 confirm:true ⇒ 面板打开期间被写入内容的扩展被无提示删除，服务端 needConfirm 形同虚设");
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-06②：needConfirm 回调把 usage.detail 当成扩展名 ═══");
{
  const src = read("client.js");
  const i = src.indexOf("needConfirm");
  const seg = i >= 0 ? src.slice(i, i + 900) : "";
  const badName = /name:\s*r\?\.usage\?\.detail/.test(seg) || /setPending\([^)]*name:\s*r\?\.usage\?\.detail/.test(src);
  console.log(`        name: r?.usage?.detail ？ ${badName}`);
  ok("F-06② 二次确认条上的名称是真扩展名", !badName, '把 "1 个文件 / 约 42 字符" 当成名字 ⇒ 确认条渲染出「<统计文本>里已经有内容」');
}

console.log(`\nPROBE-COMPLETE  ${pass} PASS / ${fail} FAIL`);
