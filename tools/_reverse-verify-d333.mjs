/**
 * _reverse-verify-d333.mjs —— 反向验证 013 的四项修复**真能被证伪**
 *
 * ★ 纪律第 10 条：摘掉修复，必须看见红。全部在**一次性副本**上做。
 * ★ 重点：F-01 是**我 D332 引入的崩溃**，它的守卫必须真的能抓回来 ——
 *   否则"修好了"只是当下这一刻碰巧对。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = process.cwd();
const results = [];
let pass = 0, fail = 0;

function stageCopy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rev-d333-"));
  fs.cpSync(path.join(REPO, "lib"), path.join(d, "lib"), { recursive: true });
  // ★ 夹具（我的一处错）：`cpSync(src 目录…)` 会把**文件**拷进 d，但我要的是 `d/tools/*`。
  //   上一版只 copyFileSync 而不建目录 ⇒ ENOENT。改成先 mkdir 再拷。
  fs.mkdirSync(path.join(d, "tools"), { recursive: true });
  for (const n of ["_probe-d333-013-repro.mjs", "_probe-v3-no-root-join.mjs", "selftest.mjs"]) {
    fs.copyFileSync(path.join(REPO, "tools", n), path.join(d, "tools", n));
  }
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(d, "package.json"));
  // git init：某些探针要读 git（这里非必需，但保持一致）
  spawnSync("git", ["init"], { cwd: d, stdio: "ignore" });
  return d;
}

function runProbe(dir, script) {
  const r = spawnSync(process.execPath, [path.join(dir, "tools", script)], {
    cwd: dir, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_PROXY: "github.com" },
  });
  const out = String(r.stdout ?? "") + String(r.stderr ?? "");
  const m = /合计：PASS (\d+) · FAIL (\d+)/.exec(out);
  const v3 = /═══ (\d+) PASS \/ (\d+) FAIL ═══/.exec(out);
  const totals = m !== null ? { pass: +m[1], fail: +m[2] } : v3 !== null ? { pass: +v3[1], fail: +v3[2] } : null;
  const sentinel = out.includes("PROBE-COMPLETE") || out.includes("═══");
  return { out, totals, sentinel };
}

function record(name, prepared, gotRed, sentinel, detail) {
  const hit = prepared && gotRed && sentinel;
  if (hit) pass += 1; else fail += 1;
  results.push({ name, hit, detail });
  console.log(`  ${hit ? "✓ 检出" : "✗ 未检出"}  ${name}  —— prepared=${prepared} got=${gotRed ? "red" : "green"} 哨兵=${sentinel}`);
}

// ── 基线 ──────────────────────────────────────────────────────────────────
console.log("\n═══ 基线：未改副本应全绿 ═══");
{
  const d = stageCopy();
  const r = runProbe(d, "_probe-d333-013-repro.mjs");
  console.log(`  ${JSON.stringify(r.totals)}`);
  if (r.totals === null) {
    console.log("🔴 基线跑不通 ⇒ PROBE-FAILED（夹具故障不当成被测对象的问题）");
    console.log(r.out.slice(-1200));
    fs.rmSync(d, { recursive: true, force: true });
    console.log("PROBE-FAILED");
    process.exit(1);
  }
  if (r.totals.fail !== 0) {
    console.log(`  ⚠️ 基线有 ${r.totals.fail} 条红（应全绿）—— 记下来，不假装）`);
  }
  fs.rmSync(d, { recursive: true, force: true });
}

// ── 破坏 ①：摘掉 GOAL_STATUS_LABEL 的 import（复现 F-01） ──────────────────
console.log("\n═══ 破坏 ①：从 part2-tools.js 的 defs import 里摘掉 GOAL_STATUS_LABEL ═══");
{
  const d = stageCopy();
  const p = path.join(d, "lib", "part2-tools.js");
  const src = fs.readFileSync(p, "utf8");
  // 只在 import 区域删（不动实现体里的使用）
  const importAreaEnd = src.indexOf("export function define");
  const head = src.slice(0, importAreaEnd);
  const body = src.slice(importAreaEnd);
  const prepared = /GOAL_STATUS_LABEL\s*,/.test(head) || /,\s*GOAL_STATUS_LABEL/.test(head);
  let newHead = head;
  if (prepared) {
    newHead = head
      .replace(/\bGOAL_STATUS_LABEL\s*,\s*/g, "")
      .replace(/,\s*\bGOAL_STATUS_LABEL\b/g, "");
  }
  fs.writeFileSync(p, newHead + body, "utf8");
  const r = runProbe(d, "_probe-d333-013-repro.mjs");
  console.log(`  合计=${JSON.stringify(r.totals)}`);
  record("破坏 ①：摘掉 GOAL_STATUS_LABEL ⇒ F-01 那几条必须见红", prepared, r.totals !== null && r.totals.fail > 0, r.sentinel);
  fs.rmSync(d, { recursive: true, force: true });
}

// ── 破坏 ②：让指纹退回只哈希台账（复现 F-02） ──────────────────────────────
console.log("\n═══ 破坏 ②：让 fingerprintOf 不再纳入扩展/目标树/交接单/原则 ═══");
{
  const d = stageCopy();
  const p = path.join(d, "lib", "defs.js");
  const src = fs.readFileSync(p, "utf8");
  // 找到 auxParts 那几行的采集，把它们变成空
  const markers = ["extensionBlockOf", "handoffLatestRel", "principlesRel"];
  const prepared = markers.some((m) => src.includes(m));
  let patched = src;
  if (prepared) {
    // 粗暴但有效：把这三处采集的源替换成字面量空串（保留结构，避免语法崩）
    patched = patched
      .replace(/extensionBlockOf\s*\([^)]*\)/g, '""')
      .replace(/info\.handoffLatestRel/g, '""')
      .replace(/info\.principlesRel/g, '""');
  }
  fs.writeFileSync(p, patched, "utf8");
  const r = runProbe(d, "_probe-d333-013-repro.mjs");
  console.log(`  合计=${JSON.stringify(r.totals)}`);
  record("破坏 ②：指纹不覆盖注入面 ⇒ F-02 那几条必须见红", prepared, r.totals !== null && r.totals.fail > 0, r.sentinel);
  fs.rmSync(d, { recursive: true, force: true });
}

// ── 破坏 ③：让 part4.js 重新出现白名单外的 path.resolve(root, <记忆风格 Rel>) ──
console.log("\n═══ 破坏 ③：在 part4.js 塞回 path.resolve(root, rel)（**它认的那种形态**）═══");
{
  const d = stageCopy();
  const p = path.join(d, "lib", "part4.js");
  const src = fs.readFileSync(p, "utf8");
  // ★★★ 我的第 4 处尺子错（这一轮）：
  //   上一版我塞的是 `path.resolve(root, "sentinel-rel")` —— **字符串字面量**。
  //   而那个守卫的 `relish` 只认**记忆风格变量/字段**：
  //     `path.resolve(root, rel | dirRel | relPath | goals | principles | ...)`
  //   ⇒ 我塞的形态它**本来就不管**，所以破坏之后它不红是**正确行为**，不是守卫太弱。
  //   ★ 判据：**要破坏一个守卫，必须先读它认什么** ——
  //     "我能破坏它"的前提是"我构造了它该抓的输入"（尺子错 #22 的同型）。
  const NEAR = /const rel = typeof args\?\.archiveFile === "string"/;
  const m = NEAR.exec(src);
  const prepared = m !== null;
  let patched = src;
  if (prepared) {
    const at = m.index;
    // 用**它认的形态**：path.resolve(root, rel)
    patched = src.slice(0, at) + `void path.resolve(root, rel); // 破坏：白名单外的记忆风格项目根解析\n          ` + src.slice(at);
  }
  fs.writeFileSync(p, patched, "utf8");
  const r = runProbe(d, "_probe-v3-no-root-join.mjs");
  console.log(`  合计=${JSON.stringify(r.totals)}`);
  record("破坏 ③：白名单外 path.resolve(root, rel) ⇒ v3-no-root-join 必须见红", prepared, r.totals !== null && r.totals.fail > 0, r.sentinel);
  fs.rmSync(d, { recursive: true, force: true });
}

// ── 破坏 ④：让 goals 的 id 校验退回只用正则（复现 F-03②） ──────────────────
console.log("\n═══ 破坏 ④：defineGoalsTool 不再调 isSafeCardKey(id) ═══");
{
  const d = stageCopy();
  const p = path.join(d, "lib", "part2-tools.js");
  const src = fs.readFileSync(p, "utf8");
  const prepared = /isSafeCardKey\s*\(\s*id\s*\)/.test(src);
  let patched = src;
  if (prepared) patched = src.replace(/isSafeCardKey\s*\(\s*id\s*\)/g, "true");
  fs.writeFileSync(p, patched, "utf8");
  const r = runProbe(d, "_probe-d333-013-repro.mjs");
  console.log(`  合计=${JSON.stringify(r.totals)}`);
  record("破坏 ④：不调 isSafeCardKey(id) ⇒ F-03② 必须见红", prepared, r.totals !== null && r.totals.fail > 0, r.sentinel);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  合计：检出 ${pass} / 未检出 ${fail}（共 ${results.length} 个破坏点）`);
for (const r of results) console.log(`    ${r.hit ? "✓" : "✗"} ${r.name}`);
console.log(fail === 0 ? "  ⇒ 每条修复都是**唯一守卫**（摘掉就红）" : "  ⇒ 🔴 有破坏点没见红 ⇒ 对应守卫太弱");
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
