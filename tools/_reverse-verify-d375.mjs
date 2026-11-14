/**
 * D375 反向验证器 —— 把 023 补丁的每一处修复**单独撤掉**，确认取证器会红。
 *
 * ★ 判据：反向验证必须摘到「能看见红」为止。摘一处不红 ⇒ 要么断言太弱、要么修复冗余，都要查清。
 * ★ 摘一处不红时**先分清**：「空守」（断言太弱）与「重复」（另有一处等价守卫兜着）。
 * ★ 必须打印 `REVERSE-COMPLETE`。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = path.join(PROJECT_ROOT, "tools", "_probe-d375-verify.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d375-rev-"));

/** from 必须逐字取自当前源码，否则 replace 静默空转。 */
const BREAKS = [
  {
    id: "B1 · F-05a backupBeforeWrite 不归一化前导 ./",
    file: "lib/backup.js",
    from: `  const rawRel = p?.rel;\n  const rel = typeof rawRel === "string" ? rawRel.replace(/^(?:\\.[\\\\/])+/, "") : rawRel;`,
    to: `  const rel = p?.rel;`,
  },
  {
    id: "B2 · F-05b readBackup 不归一化前导 ./",
    file: "lib/backup.js",
    from: `export function readBackup(memBase, rawRel) {\n  const rel = typeof rawRel === "string" ? rawRel.replace(/^(?:\\.[\\\\/])+/, "") : rawRel;`,
    to: `export function readBackup(memBase, rawRel) {\n  const rel = rawRel;`,
  },
  {
    id: "B3 · F-01a 越界路径预检（把预检循环整体短路，回到「先 existsSync 过滤」）",
    file: "lib/part7.js",
    from: `  for (const r of rels) {\n    const trimmed = r.trim();`,
    to: `  for (const r of []) {\n    const trimmed = r.trim();`,
  },
  {
    id: "B4 · F-02a writeManifestMode 的越界守卫",
    file: "lib/part1.js",
    from: `    if (info !== undefined) {\n      const unsafeMode = refuseIfMemoryRootUnsafe(info, ["active"]);\n      if (unsafeMode !== undefined) return unsafeMode;\n    }\n`,
    to: ``,
  },
  {
    id: "B5 · F-03a writeLedger 用目标槽位而非入参指纹",
    file: "lib/part4.js",
    from: `  const rawFpW = r3Ex.ok\n    ? { kind: target, project: r3Ex.id.project ?? projectOf(root), key: "-" }\n    : r3In.ok\n      ? { project: projectOf(root) ?? r3In.id.project }\n      : undefined;`,
    to: `  const rawFpW = r3Ex.ok ? r3Ex.id : r3In.ok ? r3In.id : undefined;`,
  },
  {
    id: "B6 · F-04a spliceSingleFileEntry 的单例 key 收敛",
    file: "lib/part2.js",
    from: `      ? { kind: defaultKind ?? r3.id.kind, project: r3.id.project, key: "-" }`,
    to: `      ? { kind: defaultKind ?? r3.id.kind, project: r3.id.project, key: r3.id.key ?? "-" }`,
  },
  {
    id: "B7 · F-06a inspect().activeLines 剥离后再计行",
    file: "lib/part2.js",
    from: `  const activeCleanText =\n    activeText !== undefined && readFingerprint3(activeText).ok\n      ? applyFingerprint3(activeText, undefined, { strip: true }).text\n      : activeText;\n  const activeLines = activeCleanText === undefined ? 0 : countLines(activeCleanText);`,
    to: `  const activeCleanText = activeText;\n  const activeLines = activeCleanText === undefined ? 0 : countLines(activeCleanText);`,
  },
  {
    id: "B8 · F-06d readEntryUnified 卡片模式剥离",
    file: "lib/card-ops.js",
    from: `    const cleanCardText = readFingerprint3(text).ok\n      ? applyFingerprint3(text, undefined, { strip: true }).text\n      : text;`,
    to: `    const cleanCardText = text;`,
  },
];

function runProbe() {
  try {
    const out = execFileSync(process.execPath, [PROBE], { cwd: PROJECT_ROOT, encoding: "utf8", stdio: "pipe" });
    return out;
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}
function counts(out) {
  const m = /合计：PASS (\d+) · FAIL (\d+) · KNOWN (\d+)/.exec(out);
  return m ? { pass: Number(m[1]), fail: Number(m[2]), known: Number(m[3]) } : undefined;
}

const base = counts(runProbe());
console.log(`基线（补丁已打）：PASS ${base?.pass} · FAIL ${base?.fail} · KNOWN ${base?.known}`);
console.log("─".repeat(66));

let red = 0;
let green = 0;
for (const b of BREAKS) {
  const abs = path.join(PROJECT_ROOT, b.file);
  const orig = fs.readFileSync(abs, "utf8");
  if (!orig.includes(b.from)) {
    console.log(`  ⚠ 空转  ${b.id} —— from 在当前源码里找不到（replace 不会生效）`);
    continue;
  }
  const broken = orig.replace(b.from, b.to);
  if (broken === orig) {
    console.log(`  ⚠ 空转  ${b.id} —— 替换后内容未变`);
    continue;
  }
  fs.writeFileSync(abs, broken, "utf8");
  const n = counts(runProbe());
  fs.writeFileSync(abs, orig, "utf8"); // 立刻恢复
  const isRed = n !== undefined && n.fail > 0;
  if (isRed) red += 1;
  else green += 1;
  console.log(`  ${isRed ? "见红 ✔" : "仍绿 ✘"}  ${b.id}  ⇒ FAIL ${n?.fail ?? "?"}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("─".repeat(66));
console.log(`  反向验证：${red} 见红 / ${green} 仍绿（共 ${BREAKS.length}）`);
const after = counts(runProbe());
console.log(`  恢复后复核：PASS ${after?.pass} · FAIL ${after?.fail} · KNOWN ${after?.known}`);
console.log("REVERSE-COMPLETE");
