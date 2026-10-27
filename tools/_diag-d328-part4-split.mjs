// D328：part4.js 被我写到 255,252 B（余 6,892 < 8 KiB 红线）⇒ 必须真拆，不能靠删注释。
//
// 拆哪个：D325/D327 早就点名过两个内聚簇：
//   ① 日志回溯读取簇（logFileList/normTime/aggregateFiles/logRead/appendAudit）
//   ② 独立工具簇（defineNoteTool / defineHandoffTool / defineLockTool）
// ★ 判据（D307 纪律）：**搬实现可以，改调用面不行** —— 起一个新模块，
//   part4.js 里留 `import` + `export ... from`，所有 `from "./part4.js"` 的调用方零改动。
//
// 本脚本只做**边界勘察**（不写盘）：把两个簇的行范围、字节量、对外导出的名字列清楚。
import fs from "node:fs";

const src = fs.readFileSync("lib/part4.js", "utf8");
const lines = src.split(/\r?\n/);

/** 找 `export function NAME` / `export const NAME` 的起止（按顶层花括号配对）。 */
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
    if (started && depth === 0) return { name, start: start + 1, end: i + 1 };
  }
  return undefined;
}

const LOG_CLUSTER = ["appendAudit", "logFileList", "normTime", "aggregateFiles", "logRead"];
const TOOL_CLUSTER = ["defineNoteTool", "defineHandoffTool", "defineLockTool"];

const out = [];
for (const [label, names] of [["日志回溯读取簇", LOG_CLUSTER], ["独立工具簇", TOOL_CLUSTER]]) {
  console.log("═══ " + label + " ═══");
  let lo = Infinity;
  let hi = 0;
  for (const n of names) {
    const f = findFn(n);
    if (f === undefined) {
      console.log(`  ${n}  → ⚠ 没找到`);
      continue;
    }
    const bytes = Buffer.byteLength(lines.slice(f.start - 1, f.end).join("\n"), "utf8");
    lo = Math.min(lo, f.start);
    hi = Math.max(hi, f.end);
    console.log(`  ${n.padEnd(20)} L${f.start}–L${f.end}　${f.end - f.start + 1} 行　${bytes} B`);
  }
  if (lo !== Infinity) {
    const total = Buffer.byteLength(lines.slice(lo - 1, hi).join("\n"), "utf8");
    console.log(`  ⇒ 簇整体 L${lo}–L${hi}（${hi - lo + 1} 行，约 ${total} B）`);
    out.push({ label, lo, hi, total });
  }
  console.log("");
}

// 这两个簇（含注释）合起来能搬多少
const totalBytes = out.reduce((s, x) => s + x.total, 0);
console.log(`两簇合计约 ${totalBytes} B ⇒ 搬走后 part4 可降到约 ${fs.statSync("lib/part4.js").size - totalBytes} B`);
console.log("");
console.log("★ 注意：簇里若有**互相依赖**（logRead 用 logFileList、defineLockTool 用 findWorkspaceRoot），");
console.log("  拆出去时要连带把 import 一起搬（part4 已有的 import 可以直接复制到新文件）。");
console.log("PROBE-COMPLETE");
