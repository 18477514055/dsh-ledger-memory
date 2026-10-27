/**
 * _reverse-verify-d322.mjs —— 证明 `_probe-d322-f08-f09-f10.mjs` **不是恒真断言**
 *
 * ★ 四种破坏，全部取自本轮真实修复点：
 *   1. 把 part2 里一处 writeFileAtomic 换回手写 tmp+rename（F-08）
 *   2. 恢复 part4 → index.js 的反向边（F-09）
 *   3. 把 engines 降到 18（不覆盖 import.meta.dirname）（F-10）
 *   4. 把变异探针塞回 `npm run probes`（F-10b）
 *
 * ★ 在 %TEMP% 的一次性副本上破坏，绝不动生产工作区。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROBE = path.resolve("tools/_probe-d322-f08-f09-f10.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rev-d322-"));

function copyTree() {
  const dir = path.join(TMP, "case-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync("lib", path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync("package.json", path.join(dir, "package.json"));
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.copyFileSync(PROBE, path.join(dir, "tools/_probe-d322-f08-f09-f10.mjs"));
  return dir;
}
function runProbe(dir) {
  try {
    return { code: 0, out: execFileSync("node", ["tools/_probe-d322-f08-f09-f10.mjs"], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }) };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") };
  }
}
const fails = (out) => out.split("\n").filter((l) => l.trim().startsWith("FAIL")).map((l) => l.trim());

const cases = [];

// 对照组
{
  const d = copyTree();
  const r = runProbe(d);
  cases.push({ name: "对照组（不破坏）", expect: "green", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(d, { recursive: true, force: true });
}

// 破坏 1：把 part2 一处 writeFileAtomic 换回手写三行（F-08）
{
  const d = copyTree();
  const p = path.join(d, "lib/part2.js");
  const lines = fs.readFileSync(p, "utf8").split("\n");
  const i = lines.findIndex((l) => /const _w = writeFileAtomic\(abs, next\);/.test(l));
  if (i >= 0) {
    const ind = lines[i].match(/^\s*/)[0];
    lines.splice(i, 1,
      `${ind}const tmp = \`\${abs}.tmp-\${process.pid}-\${Date.now()}\`;`,
      `${ind}fs.writeFileSync(tmp, next, "utf8");`,
      `${ind}fs.renameSync(tmp, abs);`
    );
  }
  fs.writeFileSync(p, lines.join("\n"), "utf8");
  const r = runProbe(d);
  cases.push({ name: "破坏1：一处 writeFileAtomic 换回手写 tmp+rename（F-08）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(d, { recursive: true, force: true });
}

// 破坏 2：恢复 part4 → index.js 的反向边（F-09）
{
  const d = copyTree();
  const p = path.join(d, "lib/part4.js");
  const t = fs.readFileSync(p, "utf8");
  fs.writeFileSync(p, 'import { apply } from "./index.js";\n' + t, "utf8");
  const r = runProbe(d);
  cases.push({ name: "破坏2：恢复 part4 → index.js 反向边（F-09）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(d, { recursive: true, force: true });
}

// 破坏 3：engines 降到 18（F-10）
{
  const d = copyTree();
  const p = path.join(d, "package.json");
  const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
  pkg.engines = { node: ">=18.0.0" };
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  const r = runProbe(d);
  cases.push({ name: "破坏3：engines 降到 >=18.0.0（F-10）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
  fs.rmSync(d, { recursive: true, force: true });
}

// 破坏 4：把变异探针塞回 probes（F-10b）
{
  const d = copyTree();
  const p = path.join(d, "package.json");
  const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
  pkg.scripts.probes = "node tools/_probe-assertion-can-fail.mjs && node tools/_probe-dirty-source.mjs";
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  const r = runProbe(d);
  cases.push({ name: "破坏4：变异探针塞回 npm run probes（F-10b）", expect: "red", got: r.code === 0 ? "green" : "red", f: fails(r.out) });
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
