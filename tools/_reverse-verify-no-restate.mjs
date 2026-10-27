/**
 * _reverse-verify-no-restate.mjs —— 证明 `_probe-no-restate.mjs` **不是恒真断言**
 *
 * 做法：在**一次性副本**里逐个破坏，每次跑探针，必须看见红。
 * ★ 绝不在生产工作区里改（2026-10-19 那次回滚事故的教训）。
 * ★ 每个破坏都在新副本里重来一次，避免"上一个破坏还没复原"造成误判。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = path.resolve("lib");
const PROBE = path.resolve("tools/_probe-no-restate.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rev-no-restate-"));

// 探针要用相对路径 lib/ → 在副本目录里跑
function copyLib() {
  const dir = path.join(TMP, "case-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(SRC, path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync("package.json", path.join(dir, "package.json"));
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.copyFileSync(PROBE, path.join(dir, "tools", "_probe-no-restate.mjs"));
  return dir;
}

function runProbe(dir) {
  try {
    const out = execFileSync("node", ["tools/_probe-no-restate.mjs"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") };
  }
}

const failLines = (out) =>
  out
    .split("\n")
    .filter((l) => l.trim().startsWith("FAIL"))
    .map((l) => l.trim());

const cases = [];

// ── 对照组：不破坏 ⇒ 必须全绿
{
  const dir = copyLib();
  const r = runProbe(dir);
  cases.push({
    name: "对照组（不破坏）",
    expect: "green",
    got: r.code === 0 ? "green" : "red",
    fails: failLines(r.out),
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 破坏 1：摘掉 part6 里的定义（说明符还在，但没内容了 ⇒ 应报红）
{
  const dir = copyLib();
  const p = path.join(dir, "lib/part6.js");
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(/export const NO_RESTATE_AFTER_OBLIGATION\s*=\s*[\s\S]*?;\n/, "export const NO_RESTATE_AFTER_OBLIGATION = \"\";\n");
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(dir);
  cases.push({
    name: "破坏1：文案被清空",
    expect: "red",
    got: r.code === 0 ? "green" : "red",
    fails: failLines(r.out),
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 破坏 2：把 part3 steer 里那一行摘掉（入口少一个）
{
  const dir = copyLib();
  const p = path.join(dir, "lib/part3.js");
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(/^\s*NO_RESTATE_AFTER_OBLIGATION \+$/m, "");
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(dir);
  cases.push({
    name: "破坏2：part3 的 steer 入口摘掉",
    expect: "red",
    got: r.code === 0 ? "green" : "red",
    fails: failLines(r.out),
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 破坏 3：把 index.js 里那一行摘掉（另一个入口少一个）
{
  const dir = copyLib();
  const p = path.join(dir, "lib/index.js");
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(/^\s*NO_RESTATE_AFTER_OBLIGATION \+$/m, "");
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(dir);
  cases.push({
    name: "破坏3：index.js 的回合开头入口摘掉",
    expect: "red",
    got: r.code === 0 ? "green" : "red",
    fails: failLines(r.out),
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 破坏 4：把文案改成"允许重述"（相反语义 ⇒ ③ 系列应报红）
{
  const dir = copyLib();
  const p = path.join(dir, "lib/part6.js");
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(
    /export const NO_RESTATE_AFTER_OBLIGATION\s*=\s*[\s\S]*?;\n/,
    'export const NO_RESTATE_AFTER_OBLIGATION = "★ 补完之后请把工作结论再完整复述一遍。\\n";\n'
  );
  fs.writeFileSync(p, t, "utf8");
  const r = runProbe(dir);
  cases.push({
    name: "破坏4：文案语义反转（改成要求复述）",
    expect: "red",
    got: r.code === 0 ? "green" : "red",
    fails: failLines(r.out),
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 报告
console.log("═══ 反向验证 ═══");
let ok = 0;
let bad = 0;
for (const c of cases) {
  const pass = c.got === c.expect;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${c.name}：期望 ${c.expect}，实际 ${c.got}`);
  if (c.fails.length) console.log(`        红在：${c.fails.slice(0, 3).join(" | ")}`);
  if (pass) ok++;
  else bad++;
}
console.log(`\n${bad === 0 ? "PASS" : "FAIL"}  反向验证 ${ok}/${cases.length} 符合预期`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
