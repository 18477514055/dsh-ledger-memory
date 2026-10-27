/**
 * _reverse-verify-d323.mjs —— 证明 `_probe-d323-f07-split.mjs` **不是空判据**。
 *
 * 四种破坏，全部取自本轮**真实做过的动作**（不是虚构）：
 *   ① 把 part2 的转发导出删掉（模拟"搬家但没留转发"）⇒ 调用方会崩，守卫必须红；
 *   ② 让 part2 里留下**重复实现**（模拟"搬家变成复制"）⇒ 两份实现，守卫必须红；
 *   ③ 把 saveSettings 里那次 assertAuthorized 挪到 .edit( 之后（模拟"两层授权搬掉一层"）⇒ 守卫必须红；
 *   ④ 把 part2 塞到贴线（补空白到只剩 1 KB）⇒ 容量守卫必须红。
 *
 * ★ 纪律：**反向验证必须摘到"能看见红"为止** —— 摘一处不红，要么断言太弱、要么修复冗余。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = path.join(ROOT, "tools", "_probe-d323-f07-split.mjs");

function copyTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rev-d323-"));
  fs.cpSync(path.join(ROOT, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.copyFileSync(PROBE, path.join(dir, "tools", "_probe-d323-f07-split.mjs"));
  return dir;
}

function runProbe(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, "tools", "_probe-d323-f07-split.mjs")], {
    cwd: dir,
    encoding: "utf8",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const fails = out
    .split("\n")
    .filter((l) => /^\s+FAIL/.test(l))
    .map((l) => l.trim().slice(0, 100));
  return { code: r.status, out, fails };
}

const cases = [];

// ① 删掉转发导出
{
  const d = copyTree();
  const p = path.join(d, "lib", "part2.js");
  let t = fs.readFileSync(p, "utf8");
  const before = t;
  t = t.replace(
    /^export\s*\{[^}]*\}\s*from\s*["']\.\/settings-http\.js["'];?$/m,
    "// (反向验证：转发被删掉)"
  );
  fs.writeFileSync(p, t, "utf8");
  cases.push({
    name: "破坏1：删掉 part2 → settings-http 的转发导出",
    expect: "red",
    prepared: t !== before,
    ...(() => {
      const r = runProbe(d);
      return { got: r.code === 0 ? "green" : "red", fails: r.fails };
    })(),
  });
  fs.rmSync(d, { recursive: true, force: true });
}

// ② part2 里留下重复实现
{
  const d = copyTree();
  const p = path.join(d, "lib", "part2.js");
  let t = fs.readFileSync(p, "utf8");
  const before = t;
  t = `${t}\nexport function saveSettings(scope, req, res) {\n  return null;\n}\n`;
  fs.writeFileSync(p, t, "utf8");
  cases.push({
    name: "破坏2：part2 里留下重复实现（搬家变成复制）",
    expect: "red",
    prepared: t !== before,
    ...(() => {
      const r = runProbe(d);
      return { got: r.code === 0 ? "green" : "red", fails: r.fails };
    })(),
  });
  fs.rmSync(d, { recursive: true, force: true });
}

// ③ 把 assertAuthorized 挪到 .edit( 之后
{
  const d = copyTree();
  const p = path.join(d, "lib", "settings-http.js");
  let t = fs.readFileSync(p, "utf8");
  const before = t;
  // 把 saveSettings 里第一处 assertAuthorized 调用的**行**删掉，再插到 .edit( 之后
  const at = t.indexOf("export function saveSettings");
  const seg = t.slice(at);
  const lineRe = /^\s*const verdict = assertAuthorized\(scope, req\);\s*$/m;
  const m = lineRe.exec(seg);
  let ok = false;
  if (m) {
    let next = t.slice(0, at) + seg.replace(lineRe, "// (反向验证：自查被挪走)");
    const editAt = next.indexOf(".edit(", at);
    if (editAt > 0) {
      const insertAt = next.indexOf("\n", next.indexOf("});", editAt));
      if (insertAt > 0) {
        next =
          next.slice(0, insertAt + 1) +
          "    const verdict2 = assertAuthorized(scope, req);\n" +
          next.slice(insertAt + 1);
        ok = true;
      }
    }
    fs.writeFileSync(p, next, "utf8");
  }
  cases.push({
    name: "破坏3：saveSettings 的自查被挪到落盘之后",
    expect: "red",
    prepared: ok,
    ...(() => {
      const r = runProbe(d);
      return { got: r.code === 0 ? "green" : "red", fails: r.fails };
    })(),
  });
  fs.rmSync(d, { recursive: true, force: true });
}

// ④ 把 part2 塞到贴线
{
  const d = copyTree();
  const p = path.join(d, "lib", "part2.js");
  const cur = fs.statSync(p).size;
  const CAP = 262144;
  const pad = "\n" + "//".padEnd(CAP - cur - 1024, "x") + "\n";
  fs.appendFileSync(p, pad, "utf8");
  const size = fs.statSync(p).size;
  cases.push({
    name: `破坏4：part2 塞到只剩 ~1 KB（实际 ${size} B）`,
    expect: "red",
    prepared: size > cur,
    ...(() => {
      const r = runProbe(d);
      return { got: r.code === 0 ? "green" : "red", fails: r.fails };
    })(),
  });
  fs.rmSync(d, { recursive: true, force: true });
}

// ═══ 汇总 ═══
console.log("═══ 反向验证（D323 · F-07）═══");
let good = 0;
let bad = 0;
for (const c of cases) {
  // ★ 判据：既要比 got === expect，**还要求 prepared 为真**（夹具没改到就谈不上验证）
  //   且必须**真的看见红**（fails 非空）—— 否则可能只是崩溃（SyntaxError）而不是逻辑红。
  //   ★ 这一条正是 005 报告 F-06① 指出的缺陷：只看 `code !== 0` 会把"崩溃"当"检出"。
  const pass = c.prepared === true && c.got === c.expect && (c.expect === "green" || c.fails.length > 0);
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${c.name}：期望 ${c.expect}，实际 ${c.got}`);
  if (c.prepared !== true) console.log(`        夹具没生效（替换没命中）—— 是夹具故障，不是被测对象的问题`);
  if (c.fails.length) console.log(`        红在：${c.fails.slice(0, 2).join(" | ")}`);
  else if (c.got === "red") console.log(`        🔴 变红了但**没有一条 FAIL 行**（可能是崩溃，不是逻辑检出）`);
  if (pass) good++;
  else bad++;
}
console.log(`\n═══ ${good} 条符合预期 / ${bad} 条不符合 ═══`);
process.exit(bad === 0 ? 0 : 1);
