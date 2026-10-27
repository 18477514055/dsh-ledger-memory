// ★ 014 七项独立复现（**必须在打补丁前跑** —— D327 立的规矩：探针先跑红，才谈修复）。
//   判据：每项都构造"正确行为应该长什么样"，再看现在实际长什么样。
//   ★ 本探针**只读**（不写生产代码），夹具全在 %TEMP% 下。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = (n) => pathToFileURL(path.join(ROOT, "lib", n)).href;

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
const note = (t) => console.log(`        · ${t}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d335-014-"));
console.log(`夹具根：${tmp}\n`);

// ══════════════════════════════════════════════════════════════════
console.log("═══ F-02①：cardDirIsSafe(root, \".\") 是否放行记忆根自身 ═══");
{
  const { cardDirIsSafe, isSafeCardKey, listCards } = await import(LIB("card-ops.js"));
  const root = path.join(tmp, "f02a");
  fs.mkdirSync(root, { recursive: true });
  // 记忆根下放几个"核心记忆"文件 —— 它们绝不该被当成卡片
  for (const n of ["LEDGER.md", "PRINCIPLES.md", "SECURITY.md", "JOURNAL.md"]) {
    fs.writeFileSync(path.join(root, n), `# ${n}\n`);
  }
  const r = cardDirIsSafe(root, ".");
  console.log(`        cardDirIsSafe(root,".") = ${JSON.stringify(r)}`);
  ok('F-02① cardDirIsSafe 拒绝 "."（记忆根自身）', r.ok !== true, `返回 ${JSON.stringify(r)} —— 应拒绝`);

  const ls = listCards(root, ".");
  const keys = ls.map((c) => c.key);
  console.log(`        listCards(root,".") = [${keys.join(", ")}]`);
  ok("F-02① listCards 不把 LEDGER/PRINCIPLES/SECURITY 当成卡片", !keys.includes("LEDGER") && !keys.includes("PRINCIPLES") && !keys.includes("SECURITY"), `实际列出 [${keys.join(", ")}]`);

  ok("F-02①b isSafeCardKey 拒绝 SECURITY（V3 哨兵）", isSafeCardKey("SECURITY") !== true, "SECURITY 未在保留名里 ⇒ 可被当卡写/删");
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-02②：writeCard / removeCard 能否在记忆根无授权覆盖或删除核心记忆 ═══");
{
  const { writeCard, removeCard } = await import(LIB("card-ops.js"));
  const root = path.join(tmp, "f02b");
  fs.mkdirSync(root, { recursive: true });
  const pAbs = path.join(root, "PRINCIPLES.md");
  const ORIG = "# 根本原则\n\n- 用户定的规矩，绝不许模型改\n";
  fs.writeFileSync(pAbs, ORIG);

  const w = writeCard(root, ".", "PRINCIPLES", "# 被我覆盖了\n");
  const afterW = fs.readFileSync(pAbs, "utf8");
  console.log(`        writeCard(root,".","PRINCIPLES") = ${JSON.stringify(w)}`);
  ok("F-02② writeCard 不能在记忆根覆盖 PRINCIPLES.md", afterW === ORIG, `文件已被改写为：${JSON.stringify(afterW.slice(0, 40))}`);

  // 复原再测删
  fs.writeFileSync(pAbs, ORIG);
  const d = removeCard(root, ".", "PRINCIPLES");
  const stillThere = fs.existsSync(pAbs);
  console.log(`        removeCard(root,".","PRINCIPLES") = ${JSON.stringify(d)}`);
  ok("F-02② removeCard 不能在记忆根删除 PRINCIPLES.md", stillThere, "PRINCIPLES.md 已被物理删除");
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-03②：upsert 传 parent:\"-\" 能否把已有子目标提升为树根 ═══");
{
  const m = await import(LIB("goal-ops.js")).catch(() => null);
  // 目标卡的 parent 归一化逻辑住在 part2-tools 里；这里直接核那段源文本的行为
  const src = fs.readFileSync(path.join(ROOT, "lib", "part2-tools.js"), "utf8");
  // 找到 parent 赋值的三元表达式
  const idx = src.indexOf("const parent =");
  const seg = idx >= 0 ? src.slice(idx, idx + 420) : "";
  console.log("        —— 当前 parent 归一化片段 ——");
  for (const l of seg.split("\n").slice(0, 10)) if (l.trim()) console.log(`        ${l.replace(/\s+/g, " ").trim().slice(0, 120)}`);
  // 行为核：模拟那段三元
  const simulate = (rawParent, existingParent) => {
    const t = typeof rawParent === "string" ? rawParent.trim() : rawParent;
    // 复刻源码里的判据（按上面 dump 的形状）
    return rawParent === undefined || rawParent === null || t === "" || t === "-" ? (existingParent ?? null) : String(rawParent).trim();
  };
  const promoted = simulate("-", "g1");
  console.log(`        模拟：rawParent="-", existingParent="g1" ⇒ ${JSON.stringify(promoted)}`);
  ok('F-03② 显式 parent:"-" 能把子目标提升为根（parent=null）', promoted === null, `实际得到 ${JSON.stringify(promoted)} —— 仍是 "g1"，永远提不上去`);
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-03③：多跳祖先环（g1 <- g2, 再把 g1 的 parent 设为 g2）是否被拦 ═══");
{
  const src = fs.readFileSync(path.join(ROOT, "lib", "part2-tools.js"), "utf8");
  const hasVisited = /visited/.test(src.slice(src.indexOf("const parent ="), src.indexOf("const parent =") + 2500));
  const hasSelfOnly = /if\s*\(\s*parent\s*===\s*id\s*\)/.test(src);
  console.log(`        源码里有 visited 祖先链遍历？ ${hasVisited}；只有一跳自环判据？ ${hasSelfOnly}`);
  ok("F-03③ 存在多跳祖先环检测（visited 集合）", hasVisited, "只有 `parent === id` 一跳自环判据 ⇒ 二跳/三跳环全放行");
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-05①：memorySurfaces 的「根目录稿」是否被静默丢弃 ═══");
{
  const src = fs.readFileSync(path.join(ROOT, "lib", "part6.js"), "utf8");
  // ★★★ 2026-10-27（尺子错第 37 处）：第一版我只截了 `function memorySurfaces` 之后 3000 字符，
  //   而注册点在第 330 行、落在窗口之外 ⇒ 探针判"没有注册根目录稿" ⇒ 那条断言**假 PASS**。
  //   ⇒ 判据：**核"某处有没有"时，窗口必须够大**（或干脆全文件搜），别用手指头量一个"应该够了"的长度。
  const i = src.indexOf("function memorySurfaces");
  const seg = src.slice(i); // 从这里到文件末尾 —— 够大，不再赌
  const pushIdx = seg.indexOf("const push =");
  const pushSeg = pushIdx >= 0 ? seg.slice(pushIdx, pushIdx + 900) : "";
  const dropEmpty = /rel\s*===\s*""/.test(pushSeg);
  const rootLabel = /push\(\s*""\s*,/.test(seg) || /"根目录稿"/.test(seg);
  console.log(`        push() 里过滤 rel===""？ ${dropEmpty}；有注册 "根目录稿"（rel 为空串）？ ${rootLabel}`);
  ok('F-05① rel==="" 的「根目录稿」面没有被无条件丢弃', !(dropEmpty && rootLabel), 'push() 无条件 return 掉 rel==="" ⇒ "根目录稿" 永远扫不到');
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-05②：detectTrackedMemory 是否剥除 ./ 前缀 ═══");
{
  const src = fs.readFileSync(path.join(ROOT, "lib", "part2.js"), "utf8");
  const i = src.indexOf("export function detectTrackedMemory");
  const seg = src.slice(i, i + 2500);
  const stripsDotSlash = /replace\(\s*\/\^\(\?:\\\.\\\/\)\+\//.test(seg) || /replace\(\s*\/\^\\\.\\\//.test(seg);
  console.log(`        detectTrackedMemory 里剥 ./ 前缀？ ${stripsDotSlash}`);
  ok("F-05② memoryRoot 带 ./ 前缀时不被切成 \".\"", stripsDotSlash, '未剥 "./" ⇒ "./my-mem".split("/")[0] === "." ⇒ 整棵记忆树漏检');
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-07①：hfSourceShort 是否映射 auto:midturn ═══");
{
  const { hfSourceShort } = await import(LIB("part1.js"));
  const r = hfSourceShort("auto:midturn");
  console.log(`        hfSourceShort("auto:midturn") = ${JSON.stringify(r)}`);
  const leaks = typeof r === "string" && r.includes("auto:midturn");
  ok('F-07① "auto:midturn" 被映射成中文（不泄露内部枚举）', !leaks, `原样返回 ${JSON.stringify(r)}`);
  // 顺带核其余已知来源都没泄露
  for (const s of ["auto", "manual", "user", "auto:midturn"]) {
    const v = hfSourceShort(s);
    if (typeof v === "string" && v.includes(":")) console.log(`        ⚠️ ${s} ⇒ ${v} 仍含内部冒号`);
  }
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-07②：selftest 情形 127 是否真调了 section() ═══");
{
  const st = fs.readFileSync(path.join(ROOT, "tools", "selftest.mjs"), "utf8");
  const has127 = /^section\("情形 127/m.test(st);
  const has127Comment = /\/\/\s*──\s*127：/.test(st);
  const has127Asserts = /127①/.test(st);
  console.log(`        有 section("情形 127")？ ${has127}；有 127 注释？ ${has127Comment}；有 127① 断言？ ${has127Asserts}`);
  ok("F-07② 情形 127 真调了 section()（不是只写注释）", has127, "只写注释不调 section ⇒ 127①~③ 寄生在情形 126 名下（D330 明令禁止的反模式）");
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ F-04④：compactCountsOf 在 state 为空时是否抛 ═══");
{
  const { compactCountsOf } = await import(LIB("part5.js"));
  let threw = null;
  let got;
  try {
    got = compactCountsOf(undefined, "sid");
  } catch (e) {
    threw = String((e && e.message) || e);
  }
  console.log(`        compactCountsOf(undefined,"sid") ⇒ ${threw ? `抛 ${threw}` : JSON.stringify(got)}`);
  ok("F-04④ compactCountsOf 对空 state 不抛（返回 undefined/0）", threw === null, `抛了：${threw}`);
}

console.log(`\nPROBE-COMPLETE  ${pass} PASS / ${fail} FAIL`);
console.log(`夹具目录（可删）：${tmp}`);
