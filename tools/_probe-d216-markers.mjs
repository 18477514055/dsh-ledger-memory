// D216 · 核对 `_probe-pack-check.mjs` 的 7 个标志物**是否在包内**（跨全部 lib 文件找）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tgz = process.argv[2];
if (tgz === undefined) {
  console.log("用法: node tools/_probe-d216-markers.mjs <tgz>");
  process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "markers-"));
fs.copyFileSync(tgz, path.join(tmp, "p.tgz"));
execFileSync("tar", ["-xzf", path.join(tmp, "p.tgz"), "-C", tmp], { stdio: "pipe" });
const pkg = path.join(tmp, "package");

// 包内全部 lib/*.js 拼接（**这才是"包内源码"的全体**）
const libDir = path.join(pkg, "lib");
const libText = fs
  .readdirSync(libDir)
  .filter((f) => f.endsWith(".js"))
  .sort()
  .map((f) => fs.readFileSync(path.join(libDir, f), "utf8"))
  .join("\n");

const MARKERS = [
  ["D62 口径修复", "Math.max(1, Math.floor(nodeSum - removeRatio * pressure.window))"],
  ["D62 兜底分支", "量不到节点时就退回旧口径"],
  ["A2 内容指纹幂等", "batch:${bodySha}"],
  ["A2 内容不变量", "既不在新台账、也不在 entries 里"],
  ["A2 ifRevision 拒绝", "stale: true"],
  ["A3 保留扩展字段", "hadPrevManifest"],
  ["D61 胶囊落盘", "capsules.json"],
];

console.log(`包内 lib/ 文件 ${fs.readdirSync(libDir).length} 个（拼接后 ${Buffer.byteLength(libText, "utf8")} B）\n`);
let bad = 0;
for (const [name, key] of MARKERS) {
  const hit = libText.includes(key);
  if (!hit) bad += 1;
  // 顺带报它在**哪个模块**里（便于确认拆分没弄丢它）
  let where = "(未找到)";
  for (const f of fs.readdirSync(libDir).filter((x) => x.endsWith(".js")).sort()) {
    if (fs.readFileSync(path.join(libDir, f), "utf8").includes(key)) {
      where = f;
      break;
    }
  }
  console.log(`  ${hit ? "✓" : "✗"} ${name.padEnd(20)} ← ${where}`);
}
console.log(`\n缺失 ${bad} / ${MARKERS.length}`);

fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = bad === 0 ? 0 : 1;
