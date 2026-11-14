// _probe-d358-scope.mjs —— 边界守卫：指纹**只能**落在台账体系与日志产生的文件上
// ★ 用户原话（逐字）：*"生产文件不用放指纹，因为我们的指纹只需要局限在所有由项目台账
//   体系以及日志所带来的文件就可以了，不用帮别人决定他们的文件中应该放什么。"*
//
// ★ 这条边界必须**可断言**，不能只靠"我实现时是这么想的"。
// ★ 判据：给一批"别人的文件"，`identityOfPath` 必须**全部返回 undefined**。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { identityOfPath, projectOf, newProjectId, clearProjectCache } from "../lib/fingerprint.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MEM = path.join(ROOT, "10.项目台账-ledger-memory");
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e === undefined ? "" : "  ← " + e}`); } };

const info = {
  memoryBase: MEM,
  active: "LEDGER.md",
  journal: "JOURNAL.md",
  principles: "PRINCIPLES.md",
  decisionsDir: "decisions",
  lessonsDir: "lessons",
  goalsDir: "goals",
};

// ══════════════════════════════════════════════════════════
console.log("=== 1. ★★★ 别人的文件：必须全部 undefined（一个都不许加）===");
{
  const others = [
    // 插件自身源码
    "lib/index.js", "lib/fingerprint.js", "lib/part1.js", "lib/card-ops.js",
    // 包面
    "package.json", "README.md", "LICENSE", "cordis.patch.yml",
    // 项目根的文件
    ".gitignore", ".dsh-ledger.json",
    // 探针与文档
    "tools/selftest.mjs", "tools/_probe-d356-e2e.mjs",
    "docs/Gemini静态审查001.md", "docs/3.8flash实地跑/001.md",
    // 根目录调研稿
    "_调研-billion-context.md", "_计划-设置面板.md",
  ];
  let bad = 0;
  for (const rel of others) {
    const abs = path.join(ROOT, rel.split("/").join(path.sep));
    const id = identityOfPath(info, abs);
    if (id !== undefined) { bad += 1; console.log(`    ⚠ 竟然映射了: ${rel} → ${JSON.stringify(id)}`); }
  }
  ok(`★ ${others.length} 个"别人的文件"全部不加指纹`, bad === 0, `${bad} 个被误加`);

  // 相对路径也不能骗过
  const sneaky = [
    path.join(MEM, "..", "lib", "index.js"),
    path.join(MEM, "..", "README.md"),
    path.join(MEM, "..", "..", path.basename(ROOT), "package.json"),
  ];
  let bad2 = 0;
  for (const abs of sneaky) {
    if (identityOfPath(info, abs) !== undefined) { bad2 += 1; console.log(`    ⚠ 被 .. 骗过: ${abs}`); }
  }
  ok("★ 用 `..` 绕不出去", bad2 === 0, `${bad2} 个绕过`);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 2. 台账体系自己的文件：必须全部映射上 ===");
{
  const ours = [
    ["LEDGER.md", "active", "-"],
    ["JOURNAL.md", "journal", "-"],
    ["PRINCIPLES.md", "principles", "-"],
    ["SECURITY.md", "security", "-"],
    ["decisions/D195.md", "decisions", "D195"],
    ["lessons/L1.md", "lessons", "L1"],
    ["goals/g1.md", "goals", "g1"],
  ];
  for (const [rel, kind, key] of ours) {
    const abs = path.join(MEM, rel.split("/").join(path.sep));
    const id = identityOfPath(info, abs);
    ok(`  ${rel} → ${kind}/${key}`, id?.kind === kind && id?.key === key, JSON.stringify(id));
  }
  // 日志与其余记忆面（它们也是"台账体系与日志带来的"）
  const logDirs = [
    ["_ledger-log/2026-10/week4/L1-turns.md", "log"],
    ["_ledger-archive/2026-10/week2/x.md", "archive"],
    ["_stash/2026-10/week4/x.md", "stash"],
    ["_handoff/x.md", "handoff"],
    ["extensions/gemini4-gemini3-8-gpt/cards/R1.md", "extension"],
  ];
  for (const [rel, kind] of logDirs) {
    const abs = path.join(MEM, rel.split("/").join(path.sep));
    const id = identityOfPath(info, abs);
    ok(`  ${rel} → ${kind}`, id?.kind === kind, JSON.stringify(id));
  }
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 3. ★★★ 真实全库：实际会被加指纹的文件，必须 100% 在 memoryRoot 下 ===");
{
  const all = [];
  const walk = (d) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (["node_modules", ".git"].includes(e.name)) continue; walk(p); }
      else if (e.isFile()) all.push(p);
    }
  };
  walk(MEM);
  let mapped = 0, escaped = 0;
  for (const abs of all) {
    if (identityOfPath(info, abs) === undefined) continue;
    mapped += 1;
    const rel = path.relative(MEM, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) { escaped += 1; console.log(`    ⚠ 越界: ${abs}`); }
  }
  console.log(`  memoryRoot 下 ${all.length} 个文件，映射 ${mapped} 个`);
  ok("★★ 映射的 100% 在 memoryRoot 之内", escaped === 0, `${escaped} 个越界`);

  // 反向：整个项目根扫一遍，看有没有 memoryRoot 之外的文件被映射
  const outside = [];
  const walk2 = (d, depth) => {
    if (depth > 3) return;
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (["node_modules", ".git", "10.项目台账-ledger-memory"].includes(e.name)) continue;
        walk2(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        if (identityOfPath(info, p) !== undefined) outside.push(path.relative(ROOT, p));
      }
    }
  };
  walk2(ROOT, 0);
  console.log(`  项目根（排除 memoryRoot）里的 .md：被映射 ${outside.length} 个`);
  ok("★★★ 项目根下没有任何文件被加指纹", outside.length === 0, outside.slice(0, 5).join(", "));
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 4. 清单里没有 projectId 时：一律不加（安全默认）===");
{
  ok("projectOf(不存在的目录) = undefined", projectOf("C:\\no\\such\\dir") === undefined);
  let real = projectOf(ROOT);
  if (real === undefined) {
    const tmpP = fs.mkdtempSync(path.join(os.tmpdir(), "d358-proj-"));
    fs.writeFileSync(path.join(tmpP, ".dsh-ledger.json"), JSON.stringify({ projectId: newProjectId() }), "utf8");
    clearProjectCache();
    real = projectOf(tmpP);
    fs.rmSync(tmpP, { recursive: true, force: true });
  }
  ok("本项目有 projectId", typeof real === "string" && /^[0-9a-f]{16}$/.test(real), real);
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail !== 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
