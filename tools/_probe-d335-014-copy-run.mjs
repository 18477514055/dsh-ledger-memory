// ★ 014 补丁：副本上前后对跑（只比 FAIL 集合的差集 —— D331 立的判据）。
//   为什么不在生产上打：先要证明"补丁不引入新红"，那必须在一次性副本上验。
//   ★ 副本必须带 .git（否则情形 118 的 git 断言全红，差集失去意义）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PATCH = path.join(ROOT, "docs", "外来修复补丁", "dsh-ledger-memory-v1.6.2-audit-fixes (6).patch");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "d335-copy-"));

const SKIP = new Set([".git", "node_modules", "_dist", "_store-research", ".dsh-ledger.json"]);
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

const A = path.join(work, "A-before");
const B = path.join(work, "B-after");
console.log("复制基线（含 .git）…");
// .git 单独拷（要能跑情形 118 的 git 断言）
copyDir(ROOT, A);
copyDir(ROOT, B);
for (const dir of [A, B]) {
  const gs = path.join(ROOT, ".git");
  if (fs.existsSync(gs)) {
    // 只用 git 仓库骨架（objects/refs 太大时用 --shared 不现实，直接 cp）
    fs.cpSync(gs, path.join(dir, ".git"), { recursive: true, force: true });
  }
}
fs.copyFileSync(path.join(ROOT, ".dsh-ledger.json"), path.join(A, ".dsh-ledger.json"));
fs.copyFileSync(path.join(ROOT, ".dsh-ledger.json"), path.join(B, ".dsh-ledger.json"));
console.log(`A(基线) = ${A}\nB(补丁) = ${B}\n`);

// 打补丁到 B
console.log("=== 在 B 上 git apply ===");
try {
  const out = execFileSync("git", ["apply", "--verbose", PATCH], { cwd: B, encoding: "utf8", stdio: "pipe" });
  console.log(out.trim().split("\n").slice(-4).join("\n"));
} catch (e) {
  console.log("❌ git apply 失败：", String(e.stderr || e.message).slice(0, 1200));
  process.exit(1);
}

function runSelftest(dir, label) {
  console.log(`\n=== 跑 ${label} 的 selftest ===`);
  let out = "";
  try {
    out = execFileSync("node", ["tools/selftest.mjs"], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, NO_PROXY: "github.com", DSH_ALLOW_PUBLIC_PUSH: "" },
    });
  } catch (e) {
    out = String(e.stdout || "");
    if (!out) {
      console.log("❌ 跑不起来：", String(e.stderr || e.message).slice(0, 1200));
      return null;
    }
  }
  const pass = (out.match(/^\s*PASS\s/gm) || []).length;
  const skip = (out.match(/^\s*~\s/gm) || []).length;
  const failLines = [...out.matchAll(/^\s*FAIL\s+(.+)$/gm)].map((m) => m[1].trim());
  const summary = (out.match(/合计：PASS\s+\d+\s+·\s+SKIP\s+\d+\s+·\s+FAIL\s+\d+/g) || []).pop() ?? "(无汇总行)";
  const sentinel = /PROBE-COMPLETE|合计：PASS/.test(out);
  console.log(`  ${summary}`);
  console.log(`  PASS=${pass} SKIP=${skip} FAIL=${failLines.length} · 跑完哨兵=${sentinel}`);
  for (const f of failLines) console.log(`    FAIL  ${f.slice(0, 150)}`);
  return { pass, skip, fail: failLines, summary };
}

const ra = runSelftest(A, "基线（补丁前）");
const rb = runSelftest(B, "补丁后");
if (!ra || !rb) process.exit(1);

const setA = new Set(ra.fail);
const setB = new Set(rb.fail);
const onlyB = [...setB].filter((x) => !setA.has(x));
const fixed = [...setA].filter((x) => !setB.has(x));

console.log("\n══════════ 差集 ══════════");
console.log(`基线 : PASS ${ra.pass} · SKIP ${ra.skip} · FAIL ${ra.fail.length}`);
console.log(`补丁 : PASS ${rb.pass} · SKIP ${rb.skip} · FAIL ${rb.fail.length}`);
console.log(`修好（A 有 B 无）: ${fixed.length}`);
for (const f of fixed) console.log(`  ✓ ${f.slice(0, 130)}`);
console.log(`新增（B 独有，**必须为 0**）: ${onlyB.length}`);
for (const f of onlyB) console.log(`  ✗ ${f.slice(0, 130)}`);
console.log(`净增 PASS: ${rb.pass - ra.pass}`);
console.log(`\n副本（可删）：${work}`);
console.log(onlyB.length === 0 ? "\nPROBE-COMPLETE  onlyB=0 ⇒ 零回归" : "\nPROBE-COMPLETE  ⚠️ onlyB≠0 ⇒ 有回归");
