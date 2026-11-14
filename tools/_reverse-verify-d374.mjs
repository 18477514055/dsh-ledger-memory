/**
 * D374 反向验证器 —— 把 022 补丁的每一处修复**单独撤掉**，确认取证器会红。
 *
 * ★ 判据（本项目纪律 10）：**反向验证必须摘到"能看见红"为止**。
 *   摘一处不红 ⇒ 要么断言太弱、要么修复冗余，两种都要查清。
 * ★ 做法：把补丁改过的每个文件先备份到 %TEMP%，逐处还原成**未修形状**，跑取证器，看红数；
 *   每处验完立即恢复。**绝不留在工作区里**。
 * ★ 必须打印 `REVERSE-COMPLETE`。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = path.join(PROJECT_ROOT, "tools", "_probe-d374-verify.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d374-rev-"));

/**
 * 每个 break：{ id, file, from（修好的原文）, to（未修形状） }
 * ★ `from` 必须**逐字**取自当前源码（否则 replace 不生效 ⇒ 静默空转，那正是"空守"）。
 */
const BREAKS = [
  {
    id: "B1 · F-01a scanBlind 的 skipDirs 撤掉 _backup",
    file: "lib/fingerprint.js",
    from: `      : ["node_modules", ".git", ".dsh", "dist", "build", ".cache", "__pycache__", ".venv", "_backup"],`,
    to: `      : ["node_modules", ".git", ".dsh", "dist", "build", ".cache", "__pycache__", ".venv"],`,
  },
  {
    id: "B2 · F-01c identityOfPath 撤掉 _backup 拦截",
    file: "lib/fingerprint.js",
    from: `  if (parts[0] === "_backup") return undefined;\n`,
    to: ``,
  },
  {
    id: "B3 · F-01h identityOfPath 撤掉保留名/隐藏文件拦截",
    file: "lib/fingerprint.js",
    from: `  if (baseName.startsWith(".") || /^(INDEX|README|SECURITY)\\.(md|markdown|txt)$/i.test(baseName)) return undefined;\n`,
    to: ``,
  },
  {
    id: "B4 · F-01f locateProjectRoots 撤掉 _backup",
    file: "lib/fingerprint.js",
    from: `        if (["node_modules", ".git", ".dsh", "dist", "build", "_backup"].includes(e.name)) continue;`,
    to: `        if (["node_modules", ".git", ".dsh", "dist", "build"].includes(e.name)) continue;`,
  },
  {
    id: "B5 · F-01g stampDir 撤掉 _backup",
    file: "lib/fingerprint.js",
    from: `  const skipDirs = new Set(Array.isArray(opts.skipDirs) && opts.skipDirs.length > 0 ? opts.skipDirs : ["node_modules", ".git", ".dsh", "_backup"]);`,
    to: `  const skipDirs = new Set(Array.isArray(opts.skipDirs) && opts.skipDirs.length > 0 ? opts.skipDirs : ["node_modules", ".git", ".dsh"]);`,
  },
  {
    id: "B6 · F-02a detectTrackedMemory 的 MEMORY_DIRS 撤掉 _backup",
    file: "lib/part2.js",
    from: `      "_handoff",\n      "_backup",\n`,
    to: `      "_handoff",\n`,
  },
  {
    id: "B7 · F-02b pre-commit 正则撤掉 _backup",
    file: "lib/part2.js",
    from: `_stash|_handoff|_backup|extensions)/'`,
    to: `_stash|_handoff|extensions)/'`,
  },
  {
    id: "B8 · F-03 hasDecisionCards 判据失效（恒 false）",
    file: "lib/part4.js",
    from: `  const hasDecisionCards = (() => {\n    if (decMode.card !== true) return false;`,
    to: `  const hasDecisionCards = (() => {\n    return false;\n    // eslint-disable-next-line no-unreachable\n    if (decMode.card !== true) return false;`,
  },
  {
    id: "B9 · F-04a renderExtensionInjection 不剥离指纹",
    file: "lib/part8.js",
    from: `            const rawText = fs.readFileSync(f, "utf8");\n            const r3 = readFingerprint3(rawText);\n            const text = r3.ok ? applyFingerprint3(rawText, undefined, { strip: true }).text : rawText;`,
    to: `            const text = fs.readFileSync(f, "utf8");`,
  },
  {
    id: "B10 · F-05 migrateToV3 撤掉 pushRel(\"_backup\")",
    file: "lib/part7.js",
    from: `  pushRel("extensions");\n  pushRel("_backup");`,
    to: `  pushRel("extensions");`,
  },
  {
    id: "B11 · F-06a renderRecentWork 撤掉 isUnderReal 边界",
    file: "lib/part2.js",
    from: `    if (!isUnderReal(base, root).ok) return "";\n`,
    to: ``,
  },
  {
    id: "B12 · F-06b 同毫秒决胜撤掉（退回只看 mtime）",
    file: "lib/part2.js",
    from: `    files.sort((a, b) => {\n      if (b.mtime !== a.mtime) return b.mtime - a.mtime;\n      const ds = shardOf(b.abs) - shardOf(a.abs);\n      if (ds !== 0) return ds;\n      return b.abs.localeCompare(a.abs);\n    });`,
    to: `    files.sort((a, b) => b.mtime - a.mtime);`,
  },
];

function runProbe() {
  try {
    const out = execFileSync(process.execPath, [PROBE], { cwd: PROJECT_ROOT, encoding: "utf8", stdio: "pipe" });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function failCount(out) {
  const m = /合计：PASS (\d+) · FAIL (\d+) · KNOWN (\d+)/.exec(out);
  return m ? { pass: Number(m[1]), fail: Number(m[2]), known: Number(m[3]) } : undefined;
}

const base = runProbe();
const baseN = failCount(base.out);
console.log(`基线（补丁已打）：PASS ${baseN?.pass} · FAIL ${baseN?.fail} · KNOWN ${baseN?.known}`);
console.log("─".repeat(64));

let red = 0;
const results = [];
for (const b of BREAKS) {
  const abs = path.join(PROJECT_ROOT, b.file);
  const orig = fs.readFileSync(abs, "utf8");
  const backup = path.join(tmp, `${b.id.slice(0, 4)}-${path.basename(b.file)}`);
  fs.writeFileSync(backup, orig, "utf8");

  if (!orig.includes(b.from)) {
    results.push(`  ⚠ 空转  ${b.id} —— from 在当前源码里找不到（replace 不会生效）`);
    console.log(results.at(-1));
    continue;
  }
  const broken = orig.replace(b.from, b.to);
  if (broken === orig) {
    results.push(`  ⚠ 空转  ${b.id} —— 替换后内容未变`);
    console.log(results.at(-1));
    continue;
  }
  fs.writeFileSync(abs, broken, "utf8");
  const r = runProbe();
  fs.writeFileSync(abs, orig, "utf8"); // 立刻恢复

  const n = failCount(r.out);
  const isRed = n !== undefined && n.fail > 0;
  if (isRed) red += 1;
  const line = `  ${isRed ? "见红 ✔" : "仍绿 ✘"}  ${b.id}  ⇒ FAIL ${n?.fail ?? "?"}`;
  results.push(line);
  console.log(line);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("─".repeat(64));
console.log(`  反向验证：${red} / ${BREAKS.length} 处见红`);
const restored = runProbe();
const rn = failCount(restored.out);
console.log(`  恢复后复核：PASS ${rn?.pass} · FAIL ${rn?.fail} · KNOWN ${rn?.known}`);
console.log("REVERSE-COMPLETE");
