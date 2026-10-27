// D329：量 lib/ 各模块体积，核 8 KiB 安全红线（253,952 B）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(ROOT, "lib");
const HARD = 262144;
const RED = 253952; // 262144 - 8192

const rows = [];
for (const f of fs.readdirSync(LIB).sort()) {
  if (!f.endsWith(".js")) continue;
  const size = fs.statSync(path.join(LIB, f)).size;
  rows.push({ f, size, left: RED - size });
}
rows.sort((a, b) => b.size - a.size);

console.log("文件".padEnd(26) + "字节".padStart(9) + "距红线(253952)".padStart(16) + "距硬限".padStart(10));
let bad = 0;
for (const r of rows) {
  const flag = r.left < 0 ? "  ← ⚠ 破线" : r.left < 8192 ? "  ← 薄" : "";
  if (r.left < 0) bad += 1;
  console.log(r.f.padEnd(26) + String(r.size).padStart(9) + String(r.left).padStart(16) + String(HARD - r.size).padStart(10) + flag);
}
const total = rows.reduce((s, r) => s + r.size, 0);
console.log("");
console.log(`模块数 ${rows.length} · 合计 ${total} B · 最大 ${rows[0].f} ${rows[0].size} B`);
console.log(bad === 0 ? "⇒ 没有任何模块破线" : `⇒ ${bad} 个模块破线`);
console.log("PROBE-COMPLETE");
