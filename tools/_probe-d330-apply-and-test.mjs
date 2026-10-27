// D330：在一次性副本里**真打补丁 + 真跑自检**，核 011 声称的 "PASS 2286 · SKIP 1 · FAIL 0"。
// ★ 生产工作区一行不动（D324 判据：验回滚/验补丁必须在副本上）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PATCH = path.join(ROOT, "docs", "外来修复补丁", "dsh-ledger-memory-v1.6.2-audit-fixes (3).patch");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d330-apply-"));
const ISO = path.join(tmp, "proj");
fs.cpSync(ROOT, ISO, {
  recursive: true,
  filter: (src) => {
    const base = path.basename(src);
    return base !== "node_modules" && base !== "_ledger-log" && base !== "_stash" && base !== "_ledger-archive";
  },
});
console.log(`副本：${ISO}`);

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

console.log("");
console.log("═══ ① 打补丁前：副本自检基线 ═══");
{
  const r = run(process.execPath, [path.join(ISO, "tools", "selftest.mjs")], ISO);
  const m = r.out.match(/合计：PASS (\d+) · SKIP (\d+) · FAIL (\d+)/);
  console.log(`  ${m ? `PASS ${m[1]} · SKIP ${m[2]} · FAIL ${m[3]}` : "取不到合计行（可能崩溃）"}`);
  if (m === null) console.log(r.out.split("\n").slice(-15).join("\n"));
}

console.log("");
console.log("═══ ② 真打补丁 ═══");
{
  const r = run("git", ["apply", PATCH], ISO);
  console.log(`  退出码：${r.code}  ${r.code === 0 ? "✓ 已打入" : "✗ 失败"}`);
  if (r.out.trim() !== "") console.log(`  ${r.out.trim().split("\n").slice(0, 10).join("\n  ")}`);
}

console.log("");
console.log("═══ ③ 打补丁后：体积（能否通过 8 KiB / part2 20 KiB 红线）═══");
{
  const r = run(process.execPath, [path.join(ISO, "tools", "_probe-d323-f07-split.mjs")], ISO);
  const tail = r.out.split("\n").filter((l) => /PASS|FAIL|合计/.test(l)).slice(-8);
  console.log(`  退出码 ${r.code}`);
  for (const l of tail) console.log(`    ${l.trim()}`);
}

console.log("");
console.log("═══ ④ 打补丁后：全量自检（核 011 声称的 2286/1/0）═══");
{
  const r = run(process.execPath, [path.join(ISO, "tools", "selftest.mjs")], ISO);
  const m = r.out.match(/合计：PASS (\d+) · SKIP (\d+) · FAIL (\d+)/);
  console.log(`  实测：${m ? `PASS ${m[1]} · SKIP ${m[2]} · FAIL ${m[3]}` : "取不到合计行（可能崩溃）"}`);
  console.log(`  011 声称：PASS 2286 · SKIP 1 · FAIL 0`);
  if (m !== null) {
    const fail = Number(m[3]);
    console.log(`  ⇒ ${fail === 0 ? "FAIL 0 ✓" : `**有 ${fail} 条 FAIL** ⇒ 补丁引入了回归`}`);
    if (fail > 0) {
      for (const l of r.out.split("\n").filter((x) => /^\s+FAIL/.test(x)).slice(0, 15)) console.log(`    ${l.trim()}`);
    }
  } else {
    console.log("  最后 20 行：");
    for (const l of r.out.split("\n").slice(-20)) console.log(`    ${l}`);
  }
}

console.log("");
console.log(`副本保留在：${ISO}（要复查可直接去那里）`);
console.log("PROBE-COMPLETE");
