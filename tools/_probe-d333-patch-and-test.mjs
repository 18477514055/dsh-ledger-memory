/**
 * _probe-d333-patch-and-test.mjs —— 013 补丁：体检 + 副本上打 + **补丁前后对跑**
 *
 * ★ 方法同 D331（已证明好用）：同一个副本形状跑两次——基线 / 打补丁，
 *   只有 `onlyB`（补丁引入的新红）为 0 才算"零回归"。
 *   单独看"补丁后几条红"**分不清**"本来就红"与"补丁弄红"。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const REPO = process.cwd();
const PATCH = path.join(REPO, "docs", "外来修复补丁", "dsh-ledger-memory-v1.6.2-audit-fixes (5).patch");
if (!fs.existsSync(PATCH)) { console.log("🔴 找不到 (5).patch"); console.log("PROBE-FAILED"); process.exit(1); }

// ── ① 体检 ────────────────────────────────────────────────────────────────
console.log("═══ ① 补丁体检 ═══");
const pt = fs.readFileSync(PATCH, "utf8");
console.log(`  字节 ${fs.statSync(PATCH).size} · 行数 ${pt.split(/\r?\n/).length}`);
console.log(`  U+FFFD ${(pt.match(/\uFFFD/g) ?? []).length} · BOM=${pt.charCodeAt(0) === 0xfeff} · CRLF=${(pt.match(/\r\n/g) ?? []).length}`);
const touched = [...pt.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((m) => m[1]);
console.log(`  涉及 ${touched.length} 个文件：`);
for (const t of touched) console.log(`    - ${t}`);

function stageCopy(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `d333-${tag}-`));
  fs.cpSync(path.join(REPO, "lib"), path.join(d, "lib"), { recursive: true });
  fs.cpSync(path.join(REPO, "tools"), path.join(d, "tools"), {
    recursive: true,
    filter: (src) => {
      const b = path.basename(src);
      if (/^_condense-/.test(b)) return false;
      if (/^_dedupe-/.test(b)) return false;
      if (/^_probe-d33[3-9]/.test(b)) return false;
      return true;
    },
  });
  for (const n of fs.readdirSync(REPO)) {
    const src = path.join(REPO, n);
    if (!fs.statSync(src).isFile()) continue;
    fs.copyFileSync(src, path.join(d, n));
  }
  execFileSync("git", ["init"], { cwd: d, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: d, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-m", "base"], { cwd: d, stdio: "ignore" });
  return d;
}

function runSelftest(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, "tools", "selftest.mjs")], {
    cwd: dir, encoding: "utf8", timeout: 1800000, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NO_PROXY: "github.com" },
  });
  const out = String(r.stdout ?? "") + String(r.stderr ?? "");
  const m = /合计：PASS (\d+) · SKIP (\d+) · FAIL (\d+)/.exec(out);
  const fails = out.split(/\r?\n/).filter((l) => /^\s*FAIL\s+/.test(l)).map((l) => l.replace(/^\s*FAIL\s+/, "").trim());
  return { out, totals: m === null ? null : { pass: +m[1], skip: +m[2], fail: +m[3] }, fails };
}

// ── ② 基线 ────────────────────────────────────────────────────────────────
console.log("\n═══ ② 基线副本（不打补丁）═══");
const dirA = stageCopy("base");
const A = runSelftest(dirA);
console.log(`  ${JSON.stringify(A.totals)}`);
for (const f of A.fails) console.log(`    - ${f.slice(0, 130)}`);

// ── ③ 补丁副本 ────────────────────────────────────────────────────────────
console.log("\n═══ ③ 补丁副本 ═══");
const dirB = stageCopy("patch");
const ap = spawnSync("git", ["apply", PATCH], { cwd: dirB, encoding: "utf8" });
console.log(`  git apply 退出码 = ${ap.status}`);
if (ap.status !== 0) {
  console.log(`  stderr: ${String(ap.stderr).slice(0, 800)}`);
  console.log("🔴 打不上 ⇒ PROBE-FAILED（夹具失败，不当成被测对象的问题）");
  console.log("PROBE-FAILED");
  process.exit(1);
}
const B = runSelftest(dirB);
console.log(`  ${JSON.stringify(B.totals)}`);
for (const f of B.fails) console.log(`    - ${f.slice(0, 130)}`);

// ── ④ 差分 ────────────────────────────────────────────────────────────────
console.log("\n═══ ④ 差分判定 ═══");
const setA = new Set(A.fails);
const setB = new Set(B.fails);
const onlyB = B.fails.filter((f) => !setA.has(f));
const onlyA = A.fails.filter((f) => !setB.has(f));
const both = B.fails.filter((f) => setA.has(f));
console.log(`  两版都红（环境差异）：${both.length}`);
for (const f of both) console.log(`    · ${f.slice(0, 120)}`);
console.log(`  只有补丁版红（★ 可能是回归）：${onlyB.length}`);
for (const f of onlyB) console.log(`    🔴 ${f.slice(0, 120)}`);
console.log(`  只有基线红（补丁修好的）：${onlyA.length}`);
for (const f of onlyA) console.log(`    ✅ ${f.slice(0, 120)}`);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${extra ? `  —— ${extra}` : ""}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${extra ? `  —— ${extra}` : ""}`); }
}
console.log("\n═══ ⑤ 结论判定 ═══");
ok("基线副本能跑完", A.totals !== null, JSON.stringify(A.totals));
ok("补丁副本能跑完", B.totals !== null, JSON.stringify(B.totals));
ok("★ 补丁**没有引入新红**（onlyB 为空）", onlyB.length === 0, onlyB.length === 0 ? "零回归" : `${onlyB.length} 条`);
ok("★ 补丁让通过数净增（新增断言真在跑）", B.totals && A.totals && B.totals.pass > A.totals.pass, `基线 ${A.totals?.pass} → 补丁 ${B.totals?.pass}（+${(B.totals?.pass ?? 0) - (A.totals?.pass ?? 0)}）`);

// ── ⑥ 补丁后体积 ──────────────────────────────────────────────────────────
console.log("\n═══ ⑥ 补丁后体积（核报告的 5.1 表）═══");
const CLAIMED_AFTER = {
  "lib/part3.js": 246235, "lib/part1.js": 236564, "lib/part4.js": 236175,
  "lib/defs.js": 228637, "lib/part2.js": 206654, "lib/part2-tools.js": 39526,
  "lib/part8.js": 56500, "lib/card-ops.js": 45405,
};
let hit = 0, miss = 0;
for (const [rel, want] of Object.entries(CLAIMED_AFTER)) {
  const p = path.join(dirB, rel);
  if (!fs.existsSync(p)) { console.log(`  ${rel.padEnd(26)} 不存在`); miss += 1; continue; }
  const got = fs.statSync(p).size;
  const okv = got === want;
  if (okv) hit += 1; else miss += 1;
  console.log(`  ${rel.padEnd(26)} 报告 ${String(want).padStart(7)} 实得 ${String(got).padStart(7)} ${okv ? "✓" : `✗ 差 ${got - want}`}`);
}
console.log(`  ⇒ 体积表相符 ${hit} / 不符 ${miss}`);

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  基线 ${JSON.stringify(A.totals)} → 补丁 ${JSON.stringify(B.totals)}`);
console.log(`  补丁引起的回归 = ${onlyB.length} · 补丁修好的 = ${onlyA.length}`);
console.log(`  合计：PASS ${pass} · FAIL ${fail}`);
for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 无所谓 */ } }
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
