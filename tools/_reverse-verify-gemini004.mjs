/**
 * _reverse-verify-gemini004.mjs —— 证明 `_probe-gemini004-findings.mjs` **不是恒真断言**
 * ★ 做法：把 lib/ 拷到 %TEMP% 的一次性目录，在**副本**上逐个"摘掉修复"，跑探针，必须见红。
 * ★ 绝不在生产工作区里改（2026-10-19 回滚事故的教训）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = path.resolve("lib");
const PROBE = path.resolve("tools/_probe-gemini004-findings.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rev-g004-"));

function copyLib() {
  const dir = path.join(TMP, "case-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(SRC, path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync("package.json", path.join(dir, "package.json"));
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.copyFileSync(PROBE, path.join(dir, "tools", "_probe-gemini004-findings.mjs"));
  return dir;
}
function runProbe(dir) {
  try {
    const out = execFileSync("node", ["tools/_probe-gemini004-findings.mjs"], {
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
  const dir = copyLib();
  const r = runProbe(dir);
  cases.push({ name: "对照组（不破坏）", expect: "green", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(dir, { recursive: true, force: true });
}

// 破坏 1：摘掉 writePrinciples 的守卫（F-01①）
{
  const dir = copyLib();
  const p = path.join(dir, "lib/part2.js");
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(/  const unsafePr = refuseIfMemoryRootUnsafe\(info\);\n  if \(unsafePr !== undefined\) return unsafePr;\n/, "");
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(dir);
  cases.push({ name: "破坏1：摘掉 writePrinciples 守卫（F-01①）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(dir, { recursive: true, force: true });
}

// 破坏 2：摘掉 archiveEvictedUserMessage 的 isUnderReal（F-02）
{
  const dir = copyLib();
  const p = path.join(dir, "lib/part2.js");
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(/    if \(isUnderReal\(memBase, file\)\.ok !== true\) return false;\n/, "");
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(dir);
  cases.push({ name: "破坏2：摘掉 archiveEvictedUserMessage 的 isUnderReal（F-02）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(dir, { recursive: true, force: true });
}

// 破坏 3：把 part4 的 ledger_index 守卫摘掉（F-01③）
{
  const dir = copyLib();
  const p = path.join(dir, "lib/part4.js");
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(/      const unsafeIdx = refuseIfMemoryRootUnsafe\(info\);\n/, "");
  t = t.replace(/      if \(args\?\.op === "write" && unsafeIdx !== undefined\) \{\n/, '      if (false) {\n');
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(dir);
  cases.push({ name: "破坏3：摘掉 ledger_index 守卫（F-01③）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(dir, { recursive: true, force: true });
}

// 破坏 4：把 v3-conformance 的 isUnderReal 换回词法 isUnder（F-04）
{
  const dir = copyLib();
  const p = path.join(dir, "lib/v3-conformance.js");
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(
    /const secOk = isUnderReal\(mBaseV3, secAbs\)\.ok === true && fs\.existsSync\(secAbs\);/,
    "const secOk = (() => { try { return fs.realpathSync(secAbs) && isUnder(mBaseV3, secAbs) && fs.existsSync(secAbs); } catch { return isUnder(mBaseV3, secAbs) && fs.existsSync(secAbs); } })();"
  );
  // 需要 isUnder 可用
  t = t.replace(/import \{ isUnderReal \} from "\.\/base\.js";/, 'import { isUnder, isUnderReal } from "./base.js";');
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(dir);
  cases.push({ name: "破坏4：SECURITY.md 换回词法 isUnder（F-04）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(dir, { recursive: true, force: true });
}

// 破坏 5：把 isUnderReal 的 import 删掉但继续用（D307 那个坑：ReferenceError）
{
  const dir = copyLib();
  const p = path.join(dir, "lib/v3-conformance.js");
  let t = fs.readFileSync(p, "utf8");
  // ★★★ 2026-10-25（D320）：这里原来是**精确串** `import { isUnderReal } from "./base.js";`，
  //   而 D320 为了搬 `readManifestDetailed` 把它扩成了 `{ isUnderReal, readTextSafe }`
  //   ⇒ 精确串匹配不到 ⇒ **破坏没被执行** ⇒ 探针跑的是没被破坏的代码 ⇒ 期望红却得绿。
  //   ★ 判据：**破坏脚本的匹配必须锚"名字在花括号里"，不能锚整行字面量** ——
  //     否则只要有人往 import 里加一个名字，这条破坏就静默失效（而它仍然显示"通过"）。
  t = t.replace(/^import\s*\{[^}]*\bisUnderReal\b[^}]*\}\s*from\s*"\.\/base\.js";\s*$/m, "");
  if (!/readTextSafe.*from "\.\/base\.js"|readTextSafe\s*\(/.test(t)) {
    // 若把整行删掉会让 readTextSafe 也丢 —— 补一条只带 readTextSafe 的
    t = 'import { readTextSafe } from "./base.js";\n' + t;
  }
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(dir);
  cases.push({ name: "破坏5：删掉 isUnderReal 的 import 但仍使用（D307 型）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("═══ 反向验证 ═══");
let good = 0;
let bad = 0;
for (const c of cases) {
  const pass = c.got === c.expect;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${c.name}：期望 ${c.expect}，实际 ${c.got}`);
  if (c.f.length) console.log(`        红在：${c.f.slice(0, 3).join(" | ")}`);
  if (pass) good++;
  else bad++;
}
console.log(`\n${bad === 0 ? "PASS" : "FAIL"}  反向验证 ${good}/${cases.length} 符合预期`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
