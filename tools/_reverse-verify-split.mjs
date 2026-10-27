/**
 * _reverse-verify-split.mjs —— 证明 `_probe-split-equivalence.mjs` **不是恒真断言**
 *
 * ★ 破坏的四种形态都取自**我这一轮真实犯过的错**（不是假想的）：
 *   1. 只写 `export ... from`、不写 `import`（D307 型，本轮第三次踩）⇒ 内部 ReferenceError
 *   2. 重写 `mergeGitignore` 的返回形状（我第一版真写成 `{ok, added:n}`）
 *   3. 重写 `stageOutcomeOf` 的返回形状（我第一版真写成 `{staged:number, ok, why}`）
 *   4. `pure-ops` 反过来 import `part2`（成环）
 *
 * ★ 在 %TEMP% 的一次性副本上破坏，绝不动生产工作区。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = path.resolve("lib");
const PROBE = path.resolve("tools/_probe-split-equivalence.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rev-split-"));

function copyLib() {
  const dir = path.join(TMP, "case-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(SRC, path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync("package.json", path.join(dir, "package.json"));
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.copyFileSync(PROBE, path.join(dir, "tools", "_probe-split-equivalence.mjs"));
  return dir;
}
function runProbe(dir) {
  try {
    const out = execFileSync("node", ["tools/_probe-split-equivalence.mjs"], {
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

// 破坏 1：part2 只 export-from、不 import（D307 型）
{
  const d = copyLib();
  const p = path.join(d, "lib/part2.js");
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(
    'import { findDeFactoLedger, mergeGitignore, stageOutcomeOf } from "./pure-ops.js";\n',
    ""
  );
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(d);
  cases.push({ name: "破坏1：只 export-from 不 import（D307 型）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(d, { recursive: true, force: true });
}

// 破坏 2：mergeGitignore 返回形状改回我第一版那个错的
{
  const d = copyLib();
  const p = path.join(d, "lib/pure-ops.js");
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(
    /return \{ changed: true, added: missing, path: file, created: existing === undefined \};/,
    "return { ok: true, added: missing.length };"
  );
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(d);
  cases.push({ name: "破坏2：mergeGitignore 返回形状被改成 {ok, added:number}", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(d, { recursive: true, force: true });
}

// 破坏 3：stageOutcomeOf 返回形状改回我第一版那个错的
{
  const d = copyLib();
  const p = path.join(d, "lib/pure-ops.js");
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(
    /staged: really,/,
    "ok: really,\n    staged: really ? attempted.length : 0,"
  );
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(d);
  cases.push({ name: "破坏3：stageOutcomeOf 的 staged 从布尔改成数字", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(d, { recursive: true, force: true });
}

// 破坏 4：pure-ops 反过来 import part2（成环）
{
  const d = copyLib();
  const p = path.join(d, "lib/pure-ops.js");
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(
    /^import\s*\{[^}]*\}\s*from\s*"\.\/base\.js";/m,
    (m) => m + "\nimport { inspect } from \"./part2.js\";\nvoid inspect;"
  );
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(d);
  cases.push({ name: "破坏4：pure-ops 反向 import part2（成环）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(d, { recursive: true, force: true });
}

console.log("═══ 反向验证 ═══");
let good = 0;
let bad = 0;
for (const c of cases) {
  const pass = c.got === c.expect;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${c.name}：期望 ${c.expect}，实际 ${c.got}`);
  if (c.f.length) console.log(`        红在：${c.f.slice(0, 2).join(" | ")}`);
  if (pass) good++;
  else bad++;
}
console.log(`\n${bad === 0 ? "PASS" : "FAIL"}  反向验证 ${good}/${cases.length} 符合预期`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
