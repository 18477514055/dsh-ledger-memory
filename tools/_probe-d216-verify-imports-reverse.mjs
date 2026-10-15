// ═══════════════════════════════════════════════════════════════════════════
// D216 · `_probe-d216-verify-imports.mjs` 的**尺子自证**（摘掉 import，必须见红）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么必须做（本项目纪律 10）：**反向验证必须摘到"能看见红"为止。**
//   这个校验器上一版**报过假绿**（它把模板字符串整体剥掉 ⇒ `${stampSec(now)}` 一起消失
//   ⇒ 报"全部 ✅"，而运行时当场 `ReferenceError`）⇒ 它现在的"0 问题"**必须先被证明可信**。
//
// 三组：
//   A 摘掉一个**跨模块函数的 import**（真漏）⇒ 必须红
//   B 摘掉一个**跨模块常量的 import**（真漏）⇒ 必须红
//   C 原样不动 ⇒ 必须绿（否则校验器过度敏感，会天天假红）
//
// 用法：node tools/_probe-d216-verify-imports-reverse.mjs <干净的拆分目录>
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SRC = process.argv[2];
if (!SRC) {
  console.error("用法：node tools/_probe-d216-verify-imports-reverse.mjs <干净的拆分目录>");
  process.exit(2);
}
const ROOT = process.cwd();
const VERIFIER = path.join(ROOT, "tools", "_probe-d216-verify-imports.mjs");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "d216-verify-rev-"));

function runVerifier(dir) {
  let out = "";
  try {
    out = execFileSync(process.execPath, [VERIFIER, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = String(e.stdout ?? "");
    if (out === "") throw Object.assign(new Error("校验器没输出：" + String(e.stderr ?? e.message).slice(0, 160)), { noOutput: true });
  }
  const m = /有问题的文件：(\d+) \/ (\d+)/.exec(out);
  if (m === null) throw Object.assign(new Error("校验器输出里没有统计行 ⇒ 它没跑起来"), { noOutput: true });
  return { bad: Number(m[1]), total: Number(m[2]), out };
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " —— " + detail : ""}`);
};

function withSandbox(fn) {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.cpSync(SRC, SANDBOX, { recursive: true, force: true });
  try {
    return fn(SANDBOX);
  } finally {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }
}

/** 把某个名字从"某个文件的某一条 import 行"里摘掉。 */
function dropImport(dir, file, name) {
  const p = path.join(dir, "lib", file);
  const src = fs.readFileSync(p, "utf8");
  const re = new RegExp(`^import \\{([^}]*)\\} from "(\\./[^"]+)";$`, "gm");
  let done = false;
  const out = src.replace(re, (whole, names, from) => {
    const list = names.split(",").map((s) => s.trim()).filter((n) => n !== "");
    if (!list.includes(name) || done) return whole;
    done = true;
    const kept = list.filter((n) => n !== name);
    return kept.length ? `import { ${kept.join(", ")} } from "${from}";` : "";
  });
  if (!done) throw new Error(`在 ${file} 的 import 里没找到 ${name}（摘除点没匹配上）`);
  fs.writeFileSync(p, out, "utf8");
}

// ── C 原样 ⇒ 必须绿（先跑，作为基线）────────────────────────────────────────
{
  const r = runVerifier(SRC);
  check("C 原样不动 ⇒ 校验器应当报 0 问题（否则它过度敏感）", r.bad === 0, `报 ${r.bad}/${r.total}`);
}

// ── A 摘掉跨模块**函数** import ⇒ 必须红 ────────────────────────────────────
{
  // 找一个"part1 用了、定义在别的 part"的函数
  const target = { file: "part1.js", name: "stampSec" };
  try {
    const r = withSandbox((d) => {
      dropImport(d, target.file, target.name);
      return runVerifier(d);
    });
    check(`A 摘掉 ${target.file} 里的 ${target.name} import ⇒ 必须报错`, r.bad > 0, `报 ${r.bad} 个文件有问题`);
  } catch (e) {
    check(`A 摘掉 ${target.file} 里的 ${target.name} import`, false, e.noOutput ? `夹具故障：${e.message}` : e.message);
  }
}

// ── B 摘掉跨模块**常量** import ⇒ 必须红 ────────────────────────────────────
{
  const target = { file: "part1.js", name: "DEFAULT_LOG_LEVELS" };
  try {
    const r = withSandbox((d) => {
      dropImport(d, target.file, target.name);
      return runVerifier(d);
    });
    check(`B 摘掉 ${target.file} 里的 ${target.name} import ⇒ 必须报错`, r.bad > 0, `报 ${r.bad} 个文件有问题`);
  } catch (e) {
    check(`B 摘掉 ${target.file} 里的 ${target.name} import`, false, e.noOutput ? `夹具故障：${e.message}` : e.message);
  }
}

const bad = results.filter((r) => !r.ok);
console.log(`\n结果：通过 ${results.length - bad.length} / ${results.length}`);
if (bad.length > 0) {
  for (const b of bad) console.log(`  ❌ ${b.name} —— ${b.detail}`);
  process.exitCode = 1;
} else {
  console.log("✅ 校验器的尺子可信：真漏 import 会红，原样是绿。");
}
