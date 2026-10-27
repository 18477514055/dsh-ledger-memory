// D330：在一份**一次性副本**上试打 011 的补丁（绝不动生产工作区 —— D324 判据）。
// 用 `git apply --check` 与 `patch --dry-run` 各试一次，报出到底哪些 hunk 对不上。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PATCH = path.join(ROOT, "docs", "外来修复补丁", "dsh-ledger-memory-v1.6.2-audit-fixes (3).patch");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d330-patch-"));
const ISO = path.join(tmp, "proj");
fs.cpSync(ROOT, ISO, {
  recursive: true,
  filter: (src) => {
    const base = path.basename(src);
    // 保留 .git（要试 git apply）；排除大目录
    return base !== "node_modules" && base !== "_ledger-log" && base !== "_stash" && base !== "_ledger-archive";
  },
});
console.log(`一次性副本：${ISO}`);

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

console.log("");
console.log("═══ ① git apply --check（不落盘，只看能不能干净打上）═══");
{
  const r = run("git", ["apply", "--check", "--verbose", PATCH], ISO);
  console.log(`  退出码：${r.code}  ${r.code === 0 ? "✓ 可以干净打入" : "✗ 打不上"}`);
  const lines = r.out.split("\n").filter((l) => l.trim() !== "");
  for (const l of lines.slice(0, 40)) console.log(`    ${l}`);
  if (lines.length > 40) console.log(`    …共 ${lines.length} 行输出`);
}

console.log("");
console.log("═══ ② 逐文件单独 check（定位到底是哪几个文件对不上）═══");
{
  // 按 `+++ b/` 切分补丁
  const text = fs.readFileSync(PATCH, "utf8");
  const parts = [];
  let cur = [];
  for (const l of text.split("\n")) {
    if (l.startsWith("diff -ruN ")) {
      if (cur.length > 0) parts.push(cur.join("\n") + "\n");
      cur = [l];
    } else if (cur.length > 0) {
      cur.push(l);
    }
  }
  if (cur.length > 0) parts.push(cur.join("\n") + "\n");

  let okCount = 0;
  let badCount = 0;
  for (const p of parts) {
    const m = p.match(/^\+\+\+ b\/(\S+)/m);
    const file = m === null ? "(未知)" : m[1];
    const one = path.join(tmp, "one.patch");
    fs.writeFileSync(one, p, "utf8");
    const r = run("git", ["apply", "--check", one], ISO);
    if (r.code === 0) {
      okCount += 1;
      console.log(`  ✓ ${file}`);
    } else {
      badCount += 1;
      const why = r.out.split("\n").filter((l) => l.includes("error:")).slice(0, 2).join(" | ");
      console.log(`  ✗ ${file}  ${why}`);
    }
  }
  console.log("");
  console.log(`  可单独干净打入：${okCount} 个文件 · 打不上：${badCount} 个`);
}

console.log("");
console.log("PROBE-COMPLETE");
