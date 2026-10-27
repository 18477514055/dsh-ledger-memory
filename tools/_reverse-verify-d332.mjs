/**
 * _reverse-verify-d332.mjs —— 反向验证 D332 的验收断言**真能见红**
 *
 * ★ 纪律第 10 条：反向验证必须摘到"能看见红"为止。
 *   如果摘掉转发导出，`_verify-d332-final.mjs` 仍全绿 ⇒ 那套验收就是摆设。
 *
 * ★ 全部在**一次性副本**上做（绝不动生产）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = process.cwd();
const results = [];
let pass = 0, fail = 0;

function stageCopy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rev-d332-"));
  fs.cpSync(path.join(REPO, "lib"), path.join(d, "lib"), { recursive: true });
  fs.cpSync(path.join(REPO, "tools", "_verify-d332-final.mjs"), path.join(d, "tools", "_verify-d332-final.mjs"));
  // 需要 package.json 的 type:module
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(d, "package.json"));
  // 需要 git 才能取 HEAD:lib/part2.js（⑤ 那段比对）
  spawnSync("git", ["init"], { cwd: d, stdio: "ignore" });
  spawnSync("git", ["add", "-A"], { cwd: d, stdio: "ignore" });
  spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-m", "base"], { cwd: d, stdio: "ignore" });
  return d;
}

function runVerify(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, "tools", "_verify-d332-final.mjs")], {
    cwd: dir, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_PROXY: "github.com" },
  });
  const out = String(r.stdout ?? "") + String(r.stderr ?? "");
  const totals = /合计：PASS (\d+) · FAIL (\d+)/.exec(out);
  const sentinel = out.includes("PROBE-COMPLETE") || out.includes("合计：");
  return { out, totals, sentinel, code: r.status };
}

function record(name, prepared, gotRed, sentinel) {
  const hit = prepared && gotRed && sentinel;
  if (hit) pass += 1; else fail += 1;
  results.push({ name, hit, prepared, gotRed, sentinel });
  console.log(`  ${hit ? "✓ 检出" : "✗ 未检出"}  ${name}  —— prepared=${prepared} got=${gotRed ? "red" : "green"} 哨兵=${sentinel}`);
}

// ── 基线：不改副本，必须全绿 ──────────────────────────────────────────────
console.log("\n═══ 基线：未改副本应全绿 ═══");
{
  const d = stageCopy();
  const r = runVerify(d);
  console.log(`  ${JSON.stringify(r.totals)} 哨兵=${r.sentinel}`);
  if (r.totals === null) {
    console.log("🔴 基线跑不通 ⇒ PROBE-FAILED（夹具故障，不当成被测对象的问题）");
    console.log(r.out.slice(-1500));
    fs.rmSync(d, { recursive: true, force: true });
    console.log("PROBE-FAILED");
    process.exit(1);
  }
  fs.rmSync(d, { recursive: true, force: true });
}

// ── 破坏 ①：删掉 part2 的全部转发导出 ──────────────────────────────────────
console.log("\n═══ 破坏 ①：删掉 part2.js 的转发导出 ═══");
{
  const d = stageCopy();
  const p = path.join(d, "lib", "part2.js");
  const src = fs.readFileSync(p, "utf8");
  const re = /export\s*\{[\s\S]*?\}\s*from\s*["']\.\/part2-tools\.js["'];?/;
  const prepared = re.test(src);
  if (prepared) fs.writeFileSync(p, src.replace(re, "/* 破坏：转发删掉 */"), "utf8");
  const r = runVerify(d);
  const gotRed = r.totals !== null && Number(r.totals[2]) > 0;
  console.log(`  合计=${JSON.stringify(r.totals)}`);
  record("破坏 ①：删转发导出 ⇒ ④ 的转发断言必须见红", prepared, gotRed, r.sentinel);
  fs.rmSync(d, { recursive: true, force: true });
}

// ── 破坏 ②：让 index.js 改从 part2-tools.js import（模拟"改了调用面"） ─────
console.log("\n═══ 破坏 ②：让 index.js 改从 part2-tools.js import ═══");
{
  const d = stageCopy();
  const p = path.join(d, "lib", "index.js");
  const src = fs.readFileSync(p, "utf8");
  // 把那四个 tool 从 part2 import 里摘掉，另起一条从 part2-tools 的
  const prepared = /defineGoalsTool[^}]*\}\s*from\s*["']\.\/part2\.js["']/s.test(src);
  if (prepared) {
    const patched = src.replace(
      /import\s*\{([^}]*)\}\s*from\s*["']\.\/part2\.js["']/,
      (m, body) => {
        const items = body.split(",").map((x) => x.trim()).filter((x) => x !== "" && !/^define(Goals|Lessons|PrinciplesAccess|ProposePrinciple)Tool$/.test(x));
        return `import { ${items.join(", ")} } from "./part2.js";\nimport { defineGoalsTool, defineLessonsTool, definePrinciplesAccessTool, defineProposePrincipleTool } from "./part2-tools.js";`;
      }
    );
    fs.writeFileSync(p, patched, "utf8");
  }
  const r = runVerify(d);
  const gotRed = r.totals !== null && Number(r.totals[2]) > 0;
  console.log(`  合计=${JSON.stringify(r.totals)}`);
  record("破坏 ②：调用面改指向新模块 ⇒ ④ 的「仍从 part2.js import」必须见红", prepared, gotRed, r.sentinel);
  fs.rmSync(d, { recursive: true, force: true });
}

// ── 破坏 ③：把实现体改一个字（模拟"重写而不是搬") ─────────────────────────
console.log("\n═══ 破坏 ③：改动新模块里一个 tool 的实现体 ═══");
{
  const d = stageCopy();
  const p = path.join(d, "lib", "part2-tools.js");
  const src = fs.readFileSync(p, "utf8");
  // 在 defineProposePrincipleTool 体里塞一句无害但改字节的语句
  const marker = "export function defineProposePrincipleTool(";
  const prepared = src.includes(marker);
  if (prepared) {
    const idx = src.indexOf(marker);
    const braceIdx = src.indexOf("{", idx);
    const patched = src.slice(0, braceIdx + 1) + "\n  void 0; // 破坏：改一个字节\n" + src.slice(braceIdx + 1);
    fs.writeFileSync(p, patched, "utf8");
  }
  const r = runVerify(d);
  const gotRed = r.totals !== null && Number(r.totals[2]) > 0;
  console.log(`  合计=${JSON.stringify(r.totals)}`);
  record("破坏 ③：实现体被改 ⇒ ⑤ 的「逐字节搬」必须见红", prepared, gotRed, r.sentinel);
  fs.rmSync(d, { recursive: true, force: true });
}

// ── 破坏 ④：把 part2.js 塞回 241,664 以上（模拟"没真拆"） ──────────────────
console.log("\n═══ 破坏 ④：让 part2.js 重新贴到红线（模拟没真拆） ═══");
{
  const d = stageCopy();
  const p = path.join(d, "lib", "part2.js");
  const src = fs.readFileSync(p, "utf8");
  // 追加足够多的无用填充把它顶到 241,664 之上
  const target = 241664 + 100;
  let pad = "\n// padding\n";
  const need = target - Buffer.byteLength(src, "utf8");
  if (need > 0) pad = "\n" + "// " + "x".repeat(Math.max(0, need - 5)) + "\n";
  fs.writeFileSync(p, src + pad, "utf8");
  const r = runVerify(d);
  const gotRed = r.totals !== null && Number(r.totals[2]) > 0;
  console.log(`  合计=${JSON.stringify(r.totals)}`);
  record("破坏 ④：part2.js 顶回红线 ⇒ ② 的「余量 ≥30KB」必须见红", need > 0, gotRed, r.sentinel);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  合计：检出 ${pass} / 未检出 ${fail}（共 ${results.length} 个破坏点）`);
for (const r of results) console.log(`    ${r.hit ? "✓" : "✗"} ${r.name}`);
console.log(fail === 0 ? "  ⇒ 每条验收断言都是**唯一守卫**" : "  ⇒ 🔴 有破坏点没见红 ⇒ 对应断言太弱");
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
