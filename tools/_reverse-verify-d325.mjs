/**
 * _reverse-verify-d325.mjs —— 证明 `_probe-d325-symlink-fallback.mjs` 不是空判据。
 *
 * 三种破坏，全部取自 007 报告**真实指出的病灶**：
 *   ① 让 `logFileList` 跟随链接（F-02 的洞）⇒ F-02 必须红；
 *   ② 让 `listExtensions` 单参时 `path.relative(undefined, …)` 抛错（F-07 的洞）⇒ F-07 必须红；
 *   ③ 让 `migrateToV3` 不做嵌套链接预检（F-01 的洞）⇒ F-01 必须红。
 *
 * ★ 纪律：每条都要 `prepared && fails>0 && complete`（缺 PROBE-COMPLETE = 崩溃，不是检出）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = path.join(ROOT, "tools", "_probe-d325-symlink-fallback.mjs");

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rev-d325-"));
  fs.cpSync(path.join(ROOT, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.copyFileSync(PROBE, path.join(dir, "tools", "_probe-d325-symlink-fallback.mjs"));
  return dir;
}

function run(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, "tools", "_probe-d325-symlink-fallback.mjs")], {
    cwd: dir,
    encoding: "utf8",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const fails = out
    .split("\n")
    .filter((l) => /^\s+FAIL/.test(l))
    .map((l) => l.trim().slice(0, 110));
  return { code: r.status, out, fails, complete: /PROBE-COMPLETE/.test(out) };
}

const cases = [];
function tryBreak(name, mutate) {
  const d = stage();
  const prepared = mutate(d);
  const r = run(d);
  cases.push({
    name,
    expect: "red",
    prepared: prepared === true,
    got: r.code === 0 ? "green" : "red",
    fails: r.fails,
    complete: r.complete,
  });
  fs.rmSync(d, { recursive: true, force: true });
}

// ① F-02 在**日志扫描**这一侧的守卫 —— **本机构不出这个洞，如实标"无法验证"**
//
// ★★★★ 2026-10-25（D325）：**这条我连错四次，每次都是不同原因，全部记下来。**
//   ① 全量替换 `isSymbolicLink()` ⇒ 没命中（真实写法带 `e.`）⇒ green；
//   ② 按"第一处"定位 ⇒ 命中 **1994**（归档 walk），探针测的是 3520 ⇒ 打偏 ⇒ green；
//   ③ 按函数归属定位到 3520 也对，仍 green —— 因为 3522 的 `isUnderReal` 是第二道兜底
//      （**第 22 条：我能破坏它 ≠ 它是唯一守卫**）；
//   ④ 两道一起摘，**还是 green** —— 实测（`_diag-d325-f02-guards2.mjs`）返回 `files: []`：
//      junction 在 dirent 里 `isDirectory()=false` ⇒ 摘掉链接守卫后它落进文件名正则、
//      仍然被跳过 ⇒ **本机根本构造不出"跟随链接目录逃逸"这个洞**（要真 symlink 目录，需管理员）。
//   ★ 结论：**这不是判据弱，是夹具能力不足**（纪律第 6/8 条：夹具前提不成立时全绿就是假绿）。
//   ⇒ 如实记为 `unverifiable`，**不算通过、也不算失败**，并写明原因。
cases.push({
  name: "破坏1：logFileList 的两道守卫（本机 junction 构不出该洞 ⇒ 无法验证）",
  expect: "red",
  prepared: true,
  got: "unverifiable",
  fails: [],
  complete: true,
  unverifiable: true,
  why: "junction 的 dirent 是 isDirectory=false ⇒ 摘掉链接守卫后仍被文件名正则挡掉 ⇒ 本机造不出这个洞",
});

// ② listExtensions 单参时崩（去掉 F-07 的兜底）
//
// ★★★ 2026-10-25（D325）：第一版我把 `baseRoot` **全量**替换成 `fallbackRoot` ⇒
//   `baseRoot` 的**声明行**也被改掉（`const fallbackRoot = …`）⇒ 与形参重名 / 或整段逻辑崩
//   ⇒ **模块在 import 阶段就挂** ⇒ 探针连第一行都没跑、没有 PROBE-COMPLETE。
//   ★ 判据：**全量替换一个"被声明又被使用"的名字，会连声明一起改掉** ——
//     必须只改**使用点**（`path.relative(baseRoot, …)`），或干脆在**调用处**制造那个洞。
//   现在的做法：**不动 lib**，改夹具 —— 直接让探针里那次单参调用传一个"会让它崩"的形状？
//   不行，那测的就不是产品代码了。
//   ⇒ 正解：只替换 `path.relative(baseRoot,` 这种**使用点**为 `path.relative(fallbackRoot,`。
tryBreak("破坏2：listExtensions 单参时 path.relative(undefined) 崩（F-07 的洞）", (d) => {
  const p = path.join(d, "lib", "part8.js");
  const t = fs.readFileSync(p, "utf8");
  const before = t;
  // 只改使用点，不碰声明
  const next = t.replace(/path\.relative\(\s*baseRoot\s*,/g, "path.relative(fallbackRoot,");
  if (next === before) {
    console.log(`        [夹具] 🔴 没找到 path.relative(baseRoot, …) 使用点`);
    return false;
  }
  const n = (t.match(/path\.relative\(\s*baseRoot\s*,/g) || []).length;
  console.log(`        [夹具] 改了 ${n} 处使用点（声明未动）`);
  fs.writeFileSync(p, next, "utf8");
  return true;
});

// ③ migrateToV3 不做嵌套链接预检（F-01 的洞）
//
// ★ 真名：`lib/part7.js:196  const checkNoNestedSymlink = (dirAbs) => {` —— 是**箭头函数**，
//   我第一版按 `function checkNoNestedSymlink(` 找 ⇒ 没命中 ⇒ 报"夹具没生效"。
//   ⇒ 按"含这个名字且是箭头函数赋值"定位，改成恒返回 true（= 认为没有嵌套链接）。
tryBreak("破坏3：migrateToV3 的嵌套链接预检恒判「安全」（F-01 的洞）", (d) => {
  const p = path.join(d, "lib", "part7.js");
  const lines = fs.readFileSync(p, "utf8").split("\n");
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/const checkNoNestedSymlink = \(/.test(lines[i])) {
      hit = i;
      break;
    }
  }
  if (hit < 0) return false;
  console.log(`        [夹具] 命中 part7.js:${hit + 1}`);
  // 把它整段换成恒真（找到匹配的收尾 `};`）
  let depth = 0;
  let end = hit;
  for (let i = hit; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth === 0 && i > hit) {
      end = i;
      break;
    }
  }
  const replacement = ["const checkNoNestedSymlink = (_dirAbs) => {", "  return true; // 破坏：恒判安全", "};"];
  lines.splice(hit, end - hit + 1, ...replacement);
  fs.writeFileSync(p, lines.join("\n"), "utf8");
  return true;
});

console.log("═══ 反向验证（D325 · 007 的 F-01/F-02/F-07）═══");
let good = 0;
let bad = 0;
let unverifiable = 0;
for (const c of cases) {
  if (c.unverifiable === true) {
    unverifiable++;
    console.log(`  ⏭ SKIP  ${c.name}`);
    console.log(`        原因：${c.why}`);
    continue;
  }
  const passed = c.prepared === true && c.got === c.expect && c.fails.length > 0 && c.complete === true;
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${c.name}：期望 ${c.expect}，实际 ${c.got}`);
  if (c.prepared !== true) console.log(`        夹具没生效（替换没命中）—— 是夹具故障，不是被测对象的问题`);
  if (c.complete !== true) console.log(`        🔴 探针没跑完（缺 PROBE-COMPLETE）—— 这是崩溃，不是检出`);
  if (c.fails.length) console.log(`        红在：${c.fails.slice(0, 2).join(" | ")}`);
  else if (c.got === "red") console.log(`        🔴 变红了但没有 FAIL 行`);
  if (passed) good++;
  else bad++;
}
console.log(`\n═══ ${good} 条符合预期 / ${bad} 条不符合 / ${unverifiable} 条本机无法验证 ═══`);
if (unverifiable > 0) console.log(`★ 有 ${unverifiable} 条**没被验证**（夹具能力不足），不算"全绿"。`);
process.exit(bad === 0 && unverifiable === 0 ? 0 : bad === 0 ? 2 : 1);
