/**
 * _reverse-verify-d320.mjs —— 证明 `_probe-d320-f03-f05.mjs` **不是恒真断言**
 *
 * ★ 四种破坏全部取自**本轮真实的修复点**（不是假想的）：
 *   1. 摘掉某个字段的 `gateRel`（F-03：退回裸透传）⇒ 该字段不再进 unsafePaths
 *   2. **把 `unsafePaths` 的 getter 改回普通属性**（这是我本轮踩的那个坑本身）
 *      ⇒ 字段仍被降级，但拒绝记录全丢 —— 必须能被抓出来
 *   3. `readManifestDetailed` 对坏档返回 `ok:true`（F-05：退回"读不到=没有"）
 *   4. 摘掉 `refuseIfMemoryRootUnsafe` 里的坏档分支（F-05：只报告不拦）
 *
 * ★ 在 %TEMP% 的一次性副本上破坏，绝不动生产工作区。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = path.resolve("lib");
const PROBE = path.resolve("tools/_probe-d320-f03-f05.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rev-d320-"));

function copyLib() {
  const dir = path.join(TMP, "case-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(SRC, path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync("package.json", path.join(dir, "package.json"));
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.copyFileSync(PROBE, path.join(dir, "tools", "_probe-d320-f03-f05.mjs"));
  return dir;
}
function runProbe(dir) {
  try {
    const out = execFileSync("node", ["tools/_probe-d320-f03-f05.mjs"], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") };
  }
}
const fails = (out) => out.split("\n").filter((l) => l.trim().startsWith("FAIL")).map((l) => l.trim());

const cases = [];

// 对照组
{
  const d = copyLib();
  const r = runProbe(d);
  cases.push({ name: "对照组（不破坏）", expect: "green", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(d, { recursive: true, force: true });
}

// 破坏 1：preinciples 的**预计算**那行退回裸透传（F-03）
//
//   ★★★ 2026-10-25（D320）：**第一版破坏我改错了目标**，所以它"不红"。
//     我原来改的是返回对象里那行 `principlesRel: safePrinciplesRel` —— 但 `safePrinciplesRel`
//     是**上面预计算好的变量**，改返回处只等于"换个字段填"，`gateRel` 那一行仍在跑、仍在记
//     `unsafePaths` ⇒ 探针当然全绿。
//   ★ 判据：**破坏要打在"真正起作用的那个赋值"上** —— 打在消费端，等于什么都没破坏。
//     （这也是"反向验证必须摘到能看见红"的另一种形态：不是断言太弱，是我摘错了地方。）
{
  const d = copyLib();
  const p = path.join(d, "lib/part2.js");
  const lines = fs.readFileSync(p, "utf8").split("\n");
  const i = lines.findIndex((l) => /const safePrinciplesRel = gateRel\("principles"/.test(l));
  if (i >= 0) {
    const ind = lines[i].match(/^\s*/)[0];
    lines[i] = `${ind}const safePrinciplesRel = typeof principlesRel === "string" ? principlesRel : undefined;`;
  }
  fs.writeFileSync(p, lines.join("\n"), "utf8");
  const r = runProbe(d);
  cases.push({ name: "破坏1：principles 的预计算退回裸透传（F-03）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(d, { recursive: true, force: true });
}

// 破坏 2：unsafePaths 从 getter 改回普通属性（我本轮踩的坑本身）
{
  const d = copyLib();
  const p = path.join(d, "lib/part2.js");
  let t = fs.readFileSync(p, "utf8");
  // 把 getter 改成"提前求值的普通属性"：读一个快照变量
  t = t.replace(
    /get unsafePaths\(\) \{/,
    "unsafePaths: (() => {"
  ).replace(
    /(\s+\.\.\.unsafePaths,\s*\n\s*\];\s*\n\s*)\},/,
    "$1})(),"
  );
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(d);
  cases.push({ name: "破坏2：unsafePaths 由 getter 退回提前求值（本轮真踩的坑）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(d, { recursive: true, force: true });
}

// 破坏 3：readManifestDetailed 对坏档返回 ok:true（F-05）
{
  const d = copyLib();
  const p = path.join(d, "lib/v3-conformance.js");
  let t = fs.readFileSync(p, "utf8");
  // 把两处 broken:true 改成 ok:true / broken:false
  t = t.replace(/return \{ ok: false, broken: true, why: `JSON 解析失败[^`]*`?[^\n]*\n/, 'return { ok: true, manifest: undefined, broken: false };\n');
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(d);
  cases.push({ name: "破坏3：坏档 JSON 退回 ok:true（F-05）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(d, { recursive: true, force: true });
}

// 破坏 4：摘掉 refuseIfMemoryRootUnsafe 的坏档分支（F-05：只报告不拦）
{
  const d = copyLib();
  const p = path.join(d, "lib/base.js");
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(
    /const badManifest = unsafe\.find\(\(u\) => u && u\.field === "manifest"\);/,
    'const badManifest = undefined; void unsafe.find((u) => u && u.field === "manifest");'
  );
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(d);
  cases.push({ name: "破坏4：坏档时不再拒绝写（F-05）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(d, { recursive: true, force: true });
}

console.log("═══ 反向验证 ═══");
let good = 0;
let bad = 0;
for (const c of cases) {
  const pass = c.got === c.expect && (c.expect === "green" || c.f.length > 0);
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${c.name}：期望 ${c.expect}，实际 ${c.got}`);
  if (c.f.length) console.log(`        红在：${c.f.slice(0, 2).join(" | ")}`);
  if (pass) good++;
  else bad++;
}
console.log(`\n${bad === 0 ? "PASS" : "FAIL"}  反向验证 ${good}/${cases.length} 符合预期`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
