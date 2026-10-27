// D330：查 011 补丁的编码问题 —— 它的上下文行 / 内容行是不是被 GBK↔UTF-8 转坏了。
// ★ 为什么要查：补丁里出现 `鈺愨晲…` 这种典型「UTF-8 字节被当 GBK 解读再存成 UTF-8」的痕迹。
//   若上下文行也被转坏，`git apply` 一定对不上（上下文必须逐字节相等于源文件）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = path.join(ROOT, "docs", "外来修复补丁", "dsh-ledger-memory-v1.6.2-audit-fixes (3).patch");

const buf = fs.readFileSync(P);
const text = buf.toString("utf8");

console.log("═══ ① 文件本身是不是干净 UTF-8 ═══");
console.log(`  字节 ${buf.length} · BOM: ${buf[0] === 0xef ? "有" : "无"}`);
const bad = [...text].filter((c) => c === "\uFFFD").length;
console.log(`  U+FFFD（替换字符）个数：${bad}  ${bad === 0 ? "（解码没坏）" : "（解码就坏了）"}`);

console.log("");
console.log("═══ ② 疑似 mojibake 的行有多少 ═══");
const lines = text.split("\n");
// 判据：一行里出现连续的「鈺/鎻/銆/涓/鐨」这类典型 GBK 误读字符
const MOJI = /[鈺鎻銆涓鐨鍐鏂鐩璺閿鍏鍚鍙鍑鍜鍞]/;
let moji = 0;
let ctxMoji = 0;
let addMoji = 0;
const samples = [];
for (const l of lines) {
  if (!MOJI.test(l)) continue;
  moji += 1;
  if (l.startsWith(" ") || l.startsWith("-")) ctxMoji += 1; // 上下文行或以 - 开头的删除行
  if (l.startsWith("+") && !l.startsWith("+++")) addMoji += 1;
  if (samples.length < 4) samples.push(l.slice(0, 100));
}
console.log(`  含 mojibake 痕迹的行：${moji} / ${lines.length}`);
console.log(`  其中「上下文行 / 删除行」：${ctxMoji}  ← 这一类决定补丁能不能对上`);
console.log(`  其中「新增行」：${addMoji}`);
console.log("  样例：");
for (const s of samples) console.log(`    ${s}`);

console.log("");
console.log("═══ ③ 那些 mojibake 是不是「真源对应行的 UTF-8 被当 GBK 读」═══");
// 拿 lib/index.js 的第 100 行附近做对照：若把源文件某行按 GBK→UTF-8 还原能对上补丁里的串，就证实
const src = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8").split("\n");
// 找源里含「插件 id」的行
const srcLine = src.find((l) => l.includes("插件 id"));
console.log(`  源 lib/index.js 里那行（前 90 字符）：`);
console.log(`    ${srcLine === undefined ? "(没找到)" : srcLine.slice(0, 90)}`);

// 试着重编码：把源行按 UTF-8 字节 → 当 GBK 解 → 存 UTF-8，看能否得到补丁里的 `鎻掍欢`
function utf8ToGbkMisread(s) {
  // Node 没有 GBK 编码器；用 iconv-lite 未必装了 ⇒ 只做粗略判定：
  // 若补丁那行能由源行的字节「可打印化」而来，就说明是编码转换问题。
  return undefined;
}
const patchLine = lines.find((l) => l.includes("鎻掍欢 id"));
console.log(`  补丁里对应的上下文行（前 90 字符）：`);
console.log(`    ${patchLine === undefined ? "(没找到)" : patchLine.slice(0, 90)}`);
console.log("");
console.log("  ★ 判据：两者**语义相同但字节不同** ⇒ 上下文行被转坏 ⇒ git apply 必然对不上。");

console.log("");
console.log("═══ ④ 报告自称的验证结果 vs 我实测 ═══");
console.log("  报告：PASS 2286 · SKIP 1 · FAIL 0，且说新增情形 125①~125⑧ 共 8 组");
console.log("  实测：PASS 2293 · SKIP 2 · FAIL 0（**在未打任何补丁的当前盘上**）");
console.log("  ⇒ 若它真在「补丁前」跑出 2286，说明它的快照与我盘不同；若它跑的是补丁后，则 2286 < 2293 也不成立。");

console.log("");
console.log("PROBE-COMPLETE");
