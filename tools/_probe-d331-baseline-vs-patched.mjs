/**
 * _probe-d331-baseline-vs-patched.mjs —— **补丁前/补丁后对跑**，坐实那 4 条 FAIL 是环境差异
 *
 * ★ 方法（D330 立）：同一个副本形状，跑两次——一次不打补丁（基线），一次打补丁。
 *   若两次的 FAIL 集合**完全相同** ⇒ 那 4 条与补丁无关，是副本环境差异。
 *   若补丁后多出 FAIL ⇒ 补丁引入了回归，必须查。
 *
 * ★★ 为什么要多花这一轮（约 2×70s）：
 *   "补丁后 4 条红" 单独看，**无法区分**「本来就是红的」与「补丁弄红的」。
 *   这正是 D330 学到的：**要用同一夹具对跑两版**，不能只看一版。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const REPO = process.cwd();
const PATCH = path.join(REPO, "docs", "外来修复补丁", "dsh-ledger-memory-v1.6.2-audit-fixes (4).patch");

function stageCopy(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `d331-${tag}-`));
  fs.cpSync(path.join(REPO, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.cpSync(path.join(REPO, "tools"), path.join(dir, "tools"), {
    recursive: true,
    filter: (src) => {
      const b = path.basename(src);
      if (/^_condense-/.test(b)) return false;
      if (/^_dedupe-/.test(b)) return false;
      if (/^_probe-d331/.test(b)) return false;
      return true;
    },
  });
  for (const n of fs.readdirSync(REPO)) {
    const src = path.join(REPO, n);
    if (!fs.statSync(src).isFile()) continue;
    fs.copyFileSync(src, path.join(dir, n));
  }
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-m", "base"], {
    cwd: dir,
    stdio: "ignore",
  });
  return dir;
}

function runSelftest(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, "tools", "selftest.mjs")], {
    cwd: dir,
    encoding: "utf8",
    timeout: 1800000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NO_PROXY: "github.com" },
  });
  const out = String(r.stdout ?? "") + String(r.stderr ?? "");
  const m = /合计：PASS (\d+) · SKIP (\d+) · FAIL (\d+)/.exec(out);
  const fails = out
    .split(/\r?\n/)
    .filter((l) => /^\s*FAIL\s+/.test(l))
    .map((l) => l.replace(/^\s*FAIL\s+/, "").trim());
  return { out, totals: m === null ? null : { pass: +m[1], skip: +m[2], fail: +m[3] }, fails };
}

// ── A. 基线（不打补丁）────────────────────────────────────────────────────
console.log("\n═══ A. 基线副本（**不打**补丁）═══");
const dirA = stageCopy("base");
const A = runSelftest(dirA);
console.log(`  ${JSON.stringify(A.totals)}`);
console.log(`  FAIL ${A.fails.length} 条：`);
for (const f of A.fails) console.log(`    - ${f.slice(0, 140)}`);

// ── B. 打补丁 ─────────────────────────────────────────────────────────────
console.log("\n═══ B. 补丁副本（**打**补丁）═══");
const dirB = stageCopy("patch");
const ap = spawnSync("git", ["apply", PATCH], { cwd: dirB, encoding: "utf8" });
console.log(`  git apply 退出码 = ${ap.status}`);
if (ap.status !== 0) {
  console.log(`🔴 打不上：${String(ap.stderr).slice(0, 400)}`);
  console.log("PROBE-FAILED");
  process.exit(1);
}
const B = runSelftest(dirB);
console.log(`  ${JSON.stringify(B.totals)}`);
console.log(`  FAIL ${B.fails.length} 条：`);
for (const f of B.fails) console.log(`    - ${f.slice(0, 140)}`);

// ── C. 差分 ───────────────────────────────────────────────────────────────
console.log("\n═══ C. 差分判定 ═══");
const setA = new Set(A.fails);
const setB = new Set(B.fails);
const onlyB = B.fails.filter((f) => !setA.has(f));   // 补丁**引入**的新红
const onlyA = A.fails.filter((f) => !setB.has(f));   // 补丁**修好**的红
const both = B.fails.filter((f) => setA.has(f));     // 两版都红 = 环境差异

console.log(`  两版都红（环境差异）：${both.length} 条`);
for (const f of both) console.log(`    · ${f.slice(0, 130)}`);
console.log(`  只有补丁版红（★ 可能是补丁回归）：${onlyB.length} 条`);
for (const f of onlyB) console.log(`    🔴 ${f.slice(0, 130)}`);
console.log(`  只有基线红（补丁修好的）：${onlyA.length} 条`);
for (const f of onlyA) console.log(`    ✅ ${f.slice(0, 130)}`);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${extra === undefined ? "" : `  —— ${extra}`}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${extra === undefined ? "" : `  —— ${extra}`}`); }
}
console.log("\n═══ D. 结论判定 ═══");
ok("基线副本本身能跑完（有合计行）", A.totals !== null, JSON.stringify(A.totals));
ok("补丁副本本身能跑完（有合计行）", B.totals !== null, JSON.stringify(B.totals));
ok(
  "★ 补丁**没有引入任何新红**（onlyB 必须为空）",
  onlyB.length === 0,
  onlyB.length === 0 ? "零回归" : `${onlyB.length} 条：${onlyB.map((f) => f.slice(0, 60)).join(" | ")}`
);
ok(
  "★ 补丁让通过数**净增**（它加的情形 126 断言确实在跑）",
  B.totals !== null && A.totals !== null && B.totals.pass > A.totals.pass,
  `基线 ${A.totals?.pass} → 补丁 ${B.totals?.pass}`
);

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  基线：${JSON.stringify(A.totals)}`);
console.log(`  补丁：${JSON.stringify(B.totals)}`);
console.log(`  净增 PASS = ${B.totals.pass - A.totals.pass}（补丁新增的情形 126 断言数）`);
console.log(`  补丁引起的回归 = ${onlyB.length} 条`);
console.log(`  合计：PASS ${pass} · FAIL ${fail}`);
for (const d of [dirA, dirB]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 无所谓 */ }
}
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
