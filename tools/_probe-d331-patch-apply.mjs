/**
 * _probe-d331-patch-apply.mjs —— 012 补丁能不能干净打入（在**一次性副本**上验，不动生产）
 *
 * ★ 纪律（D330 立的）：任何外来补丁先走副本。
 * ★ 前置事实：报告称"修复前 part2.js = 241,515 B"，而我 D330 之后磁盘上正是 241,515
 *   ⇒ 报告快照 = 我当前状态 ⇒ 补丁理应能干净打入。但**要实测，不信推断**。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = process.cwd();
const PATCH_CANDIDATES = fs
  .readdirSync(path.join(REPO, "docs", "外来修复补丁"))
  .filter((n) => /^dsh-ledger-memory-v1\.6\.2-audit-fixes \(4\)\.patch$/.test(n))
  .map((n) => path.join(REPO, "docs", "外来修复补丁", n));

if (PATCH_CANDIDATES.length === 0) {
  console.log("🔴 找不到 (4).patch ⇒ 报 PROBE-FAILED，不臆测");
  console.log("PROBE-FAILED");
  process.exit(1);
}
const PATCH = PATCH_CANDIDATES[0];
const patchText = fs.readFileSync(PATCH, "utf8");

console.log("═══ ① 补丁体检 ═══");
console.log(`  路径：${PATCH}`);
console.log(`  字节：${fs.statSync(PATCH).size}`);
console.log(`  行数：${patchText.split(/\r?\n/).length}`);
console.log(`  U+FFFD（编码损坏符）：${(patchText.match(/\uFFFD/g) ?? []).length}`);
console.log(`  首字节是否 BOM：${patchText.charCodeAt(0) === 0xfeff}`);
console.log(`  CRLF 行数：${(patchText.match(/\r\n/g) ?? []).length}`);

// 补丁涉及哪些文件
const touched = [...patchText.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((m) => m[1]);
console.log(`  涉及文件 ${touched.length} 个：`);
for (const t of touched) console.log(`    - ${t}`);

console.log("\n═══ ② 副本上 git apply --check ═══");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d331-apply-"));
function stageCopy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "d331-copy-"));
  // 只复制补丁会碰的文件 + package.json，保持目录形状
  for (const rel of touched) {
    const src = path.join(REPO, rel);
    const dst = path.join(d, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
  return d;
}
const copy = stageCopy();

function run(args, cwd) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_PROXY: "github.com" },
    });
    return { code: 0, out, err: "" };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? ""), err: String(e.stderr ?? "") };
  }
}

// 副本必须是个 git 仓库才能 apply
run(["init"], copy);
run(["add", "-A"], copy);
run(["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-m", "stage"], copy);

const patchInTmp = path.join(tmp, "p.patch");
fs.writeFileSync(patchInTmp, patchText, "utf8");

const check = run(["apply", "--check", "-v", patchInTmp], copy);
console.log(`  --check 退出码：${check.code}`);
if (check.err.trim() !== "") console.log(`  stderr:\n${check.err.split(/\r?\n/).slice(0, 40).join("\n")}`);
if (check.out.trim() !== "") console.log(`  stdout 前 40 行:\n${check.out.split(/\r?\n/).slice(0, 40).join("\n")}`);

console.log("\n═══ ③ 真打入（在副本上）═══");
const applied = run(["apply", patchInTmp], copy);
console.log(`  apply 退出码：${applied.code}`);
if (applied.err.trim() !== "") console.log(`  stderr:\n${applied.err.split(/\r?\n/).slice(0, 40).join("\n")}`);

if (applied.code === 0) {
  console.log("\n  打入后各文件字节：");
  for (const rel of touched) {
    const p = path.join(copy, rel);
    if (fs.existsSync(p)) {
      const b = fs.statSync(p).size;
      console.log(`    ${rel.padEnd(28)} ${String(b).padStart(8)}`);
    }
  }
  // 012 报告声称的"修复后"值，逐项核
  const CLAIMED = {
    "lib/card-ops.js": 45405,
    "lib/part1.js": 236564,
    "lib/part2.js": 241272,
    "lib/part4.js": 235874,
    "lib/part8.js": 56500,
    "lib/settings-http.js": 33829,
    "lib/workspace-tools.js": 26598,
  };
  console.log("\n  与 012 报告的「修复后字节」对照：");
  let hit = 0, miss = 0;
  for (const [rel, want] of Object.entries(CLAIMED)) {
    const p = path.join(copy, rel);
    if (!fs.existsSync(p)) { console.log(`    ${rel.padEnd(28)} 不存在`); miss += 1; continue; }
    const got = fs.statSync(p).size;
    const okv = got === want;
    if (okv) hit += 1; else miss += 1;
    console.log(`    ${rel.padEnd(28)} 报告 ${String(want).padStart(8)} 实得 ${String(got).padStart(8)} ${okv ? "✓" : `✗ 差 ${got - want}`}`);
  }
  console.log(`  ⇒ 相符 ${hit} / 不符 ${miss}`);
}

fs.rmSync(copy, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\nPROBE-COMPLETE");
