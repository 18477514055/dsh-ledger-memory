// D328：把 part4.js 的「独立工具簇」（defineNoteTool / defineHandoffTool / defineLockTool）
// 整块搬到 lib/workspace-tools.js，part4 只留转发导出。
//
// ★ 纪律：**搬实现可以，改调用面不行**（D307/D318/D319/D323/D326 同一做法）。
// ★ 逐字搬：不重写。import 直接**从 part4 原样复制一份**（多几个没用的 import 无害，
//   少一个就是 ReferenceError —— 宁可多，不可少）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const P4 = "lib/part4.js";
const NEW = "lib/workspace-tools.js";

// 备份
const bk = path.join(os.tmpdir(), "d328-before-split");
fs.mkdirSync(bk, { recursive: true });
fs.copyFileSync(P4, path.join(bk, "part4.js"));
console.log("备份 part4.js → " + bk);

const src = fs.readFileSync(P4, "utf8");
const lines = src.split(/\r?\n/);

function findFn(name) {
  const re = new RegExp(`^export (?:async )?function ${name}\\b`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return undefined;
  let depth = 0;
  let started = false;
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth += 1; started = true; }
      else if (ch === "}") depth -= 1;
    }
    if (started && depth === 0) return { name, start, end: i };
  }
  return undefined;
}

const NAMES = ["defineNoteTool", "defineHandoffTool", "defineLockTool"];
const found = NAMES.map((n) => {
  const f = findFn(n);
  if (f === undefined) { console.log("⚠ 找不到 " + n); process.exit(1); }
  return f;
});

const lo = Math.min(...found.map((f) => f.start));
const hi = Math.max(...found.map((f) => f.end));

// 往前吃掉紧邻的注释块
let cutStart = lo;
while (cutStart > 0) {
  const prev = lines[cutStart - 1].trim();
  if (prev === "" || prev.startsWith("//") || prev.startsWith("*") || prev.startsWith("/*") || prev.endsWith("*/")) {
    cutStart -= 1;
  } else break;
}
let cutEnd = hi;
while (cutEnd + 1 < lines.length && lines[cutEnd + 1].trim() === "") cutEnd += 1;

const moved = lines.slice(cutStart, cutEnd + 1);
console.log(`搬移 L${cutStart + 1}–L${cutEnd + 1}（${moved.length} 行，${Buffer.byteLength(moved.join("\n"), "utf8")} B）`);

// ── 从 part4 原样收集 import 块 ────────────────────────────────────────
const imports = [];
{
  let i = 0;
  while (i < lines.length) {
    if (/^import\s/.test(lines[i])) {
      let j = i;
      while (j + 1 < lines.length && !/from\s+["'][^"']+["']\s*;?\s*$/.test(lines[j])) j += 1;
      imports.push(lines.slice(i, j + 1).join("\n"));
      i = j + 1;
      continue;
    }
    // 遇到第一条非 import 的顶层语句就停（注释不算）
    if (/^(export|const|let|var|function)\b/.test(lines[i])) break;
    i += 1;
  }
}
console.log(`复制 ${imports.length} 条 import`);

const doc = [
  "/**",
  " * workspace-tools.js —— `ledger_note` / `ledger_handoff` / `ledger_lock` 三个工具的定义。",
  " *",
  " * ★★★ 2026-10-26（D328）：**从 `part4.js` 整块搬出**，目的是给它腾容量。",
  " *   🔴 起因：我修 010 F-01（项目锁自囚）时在 `part4.js` 加了两处边界判据，",
  " *     把它从 253,118 B 顶到 **255,252 B** ⇒ 距 262,144 上限只剩 6,892 B，",
  " *     **跌破探针 `_probe-d323-f07-split.mjs` 的 8 KiB 红线**（那条当场变红）。",
  " *   ★ 处置**不是删注释**（那是一次性的，009 那轮已经用过一次），",
  " *     而是按 D325/D327 早就点名的内聚簇**真拆**。",
  " *",
  " * ★★ 搬家方式（判据）：**逐字复制，不重写**。",
  " *   本文件正文与 `part4.js` 原位置逐字相同，只在顶部加 import 头与这段说明。",
  " *   ⇒ 行为等价性不需要重新论证，它读的就是原来那些字节。",
  " *",
  " * ★★ 调用面**零改动**：`part4.js` 原位置留了转发导出，",
  " *   ⇒ `index.js` 与 `tools/` 里那些 `from \"./part4.js\"` 的 import 一个字都不用改。",
  " *   （D307/D318/D319/D323/D326 同一做法：**搬实现可以，改调用面不行**。）",
  " */",
].join("\n");

fs.writeFileSync(NEW, doc + "\n" + imports.join("\n") + "\n\n" + moved.join("\n") + "\n", "utf8");
console.log(`已写 ${NEW}（${fs.statSync(NEW).size} B）`);

const fwd = [
  "// ★★★★ 2026-10-26（D328）：这三个工具已**整块搬出**到 `workspace-tools.js`（给本文件腾容量）。",
  "//   ★ 调用面零改动：`index.js` / `tools/` 里 `from \"./part4.js\"` 的 import 一个字都不用改。",
  "//   ★ 判据：**搬家可以，改调用面不行**（D307/D318/D319/D323/D326 同一做法）。",
  "export { defineNoteTool, defineHandoffTool, defineLockTool } from \"./workspace-tools.js\";",
];
const next = [...lines.slice(0, cutStart), ...fwd, ...lines.slice(cutEnd + 1)].join("\n");
fs.writeFileSync(P4, next, "utf8");
const sz = fs.statSync(P4).size;
console.log(`part4.js → ${sz} B（余 ${262144 - sz} B，8 KiB 红线 ${sz <= 253952 ? "✓ 过" : "✗ 仍超"}）`);
console.log("PROBE-COMPLETE");
