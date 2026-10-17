// D227 · **全量盘点**（只读）：把我们的工具 / 子命令 / 弹卡 / 面板 全部数出来
//
// ★ 为什么要先盘（用户原话）：
//   *"其实大部分的卡片我都没有点过，所以你先彻底归纳一下我们所有的工具啊，命令啊，面板啊之类的东西。
//     我感觉有点累赘了，其中很大一部分甚至不能实现正常的功能。"*
//   ⇒ 判据：**不许凭记忆列举**。全部从源码数出来，并**逐个标出"它有没有被人工走过"**。
//
// ★ 本探针只读、不写任何文件。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const lib = (f) => fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
const files = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js")).sort();
const all = files.map(lib).join("\n");

console.log("═".repeat(78));
console.log("D227 全量盘点（只读 · 从源码数，不凭记忆）");
console.log("═".repeat(78));

// ── 1) 工具 ────────────────────────────────────────────────────────────────
const idxSrc = lib("index.js");
const toolBlock = idxSrc.match(/for \(const \[label, factory\] of \[([\s\S]*?)\n  \]\) \{/);
const tools = toolBlock === null
  ? []
  : [...toolBlock[1].matchAll(/^\s*\[([^\]]+?),/gm)].map((m) => m[1].trim());
// 常量名换成真名
const PRINCIPLE_GRANT_TOOL = "ledger_principles_access";
const CHECKPOINT_TOOL = "ledger_checkpoint";
const nameOf = (raw) => {
  if (/^"[a-z_]+"$/.test(raw)) return raw.slice(1, -1);
  if (raw === "PRINCIPLE_GRANT_TOOL") return PRINCIPLE_GRANT_TOOL;
  if (raw === "CHECKPOINT_TOOL") return CHECKPOINT_TOOL;
  return raw + "（常量）";
};
console.log(`\n【1】工具：共 ${tools.length} 个`);
tools.forEach((t, i) => console.log(`   ${String(i + 1).padStart(2)}. ${nameOf(t)}`));

// ── 2) 子命令 ──────────────────────────────────────────────────────────────
const defsSrc = lib("defs.js");
const subBlock = defsSrc.match(/export const LEDGER_SUBCOMMANDS = \[([\s\S]*?)\n\];/);
const subs = subBlock === null ? [] : [...subBlock[1].matchAll(/sub:\s*"([a-z]+)"/g)].map((m) => m[1]);
console.log(`\n【2】/ledger 子命令：共 ${subs.length} 个`);
console.log(`   ${subs.join(" · ")}`);

// ── 3) 会弹卡片的地方（`uq.ask`）──────────────────────────────────────────
console.log(`\n【3】会弹卡片给用户的地方（uq.ask 调用点）`);
{
  const spots = [];
  for (const f of files) {
    const src = lib(f);
    src.split("\n").forEach((line, i) => {
      if (!/uq\.ask\(/.test(line)) return;
      // 往上找最近的函数名（粗定位即可）
      let fn = "?";
      for (let k = i; k >= 0 && k > i - 120; k -= 1) {
        const m = src.split("\n")[k].match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/);
        if (m !== null) { fn = m[1]; break; }
      }
      spots.push(`${f}:${i + 1}  ${fn}`);
    });
  }
  spots.forEach((s) => console.log(`   • ${s}`));
  console.log(`   ⇒ 共 ${spots.length} 处会向用户弹卡`);
}

// ── 4) 卡片选项集（定义了哪几组选项）─────────────────────────────────────
console.log(`\n【4】预定义的卡片选项组`);
for (const g of ["CHECKPOINT_OPTIONS", "FIRST_TURN_OPTIONS", "CONFORM_OPTIONS"]) {
  const m = defsSrc.match(new RegExp(`export const ${g} = \\[([\\s\\S]*?)\\n\\];`));
  const labels = m === null ? [] : [...m[1].matchAll(/label:\s*"([^"]+)"/g)].map((x) => x[1]);
  console.log(`   • ${g}（${labels.length} 项）：${labels.join(" / ") || "(解析不到，需复核)"}`);
}
// 命令弹的卡片（/ledger 裸敲、principles approve）
console.log(`   • 无参数 /ledger ⇒ 弹出子命令选择卡（由 LEDGER_SUBCOMMANDS 生成）`);

// ── 5) 面板：设置项 + 分组 ────────────────────────────────────────────────
const specSrc = defsSrc.slice(defsSrc.indexOf("export const SETTING_SPECS"), defsSrc.indexOf("export const SETTING_KEYS"));
const specKeys = [...specSrc.matchAll(/^\s{4}key:\s*"([A-Za-z]+)",/gm)].map((m) => m[1]);
const grpBlock = defsSrc.match(/export const SETTING_GROUPS = \[([\s\S]*?)\n\];/);
const groups = grpBlock === null ? [] : [...grpBlock[1].matchAll(/key:\s*"([a-z]+)"[\s\S]{0,80}?label:\s*"([^"]+)"/g)]
  .map((m) => `${m[1]}（${m[2]}）`);
console.log(`\n【5】设置面板：共 ${specKeys.length} 项 · ${groups.length} 组`);
console.log(`   分组：${groups.join(" · ")}`);
console.log(`   设置项：${specKeys.join(", ")}`);

// ── 6) 面板上的按钮 ───────────────────────────────────────────────────────
console.log(`\n【6】面板上的按钮 / 动作`);
{
  const clientSrc = lib("client.js");
  const btns = [...clientSrc.matchAll(/>\s*"([^"]{2,24})"\s*\)|children:\s*"([^"]{2,24})"/g)]
    .map((m) => m[1] ?? m[2]).filter((s) => s !== undefined && !/^[a-z-]+$/.test(s));
  const uniq = [...new Set(btns)];
  uniq.forEach((b) => console.log(`   • ${b}`));
  console.log(`   （粗扫，可能含非按钮文本；共 ${uniq.length} 条）`);
}

// ── 7) 各入口的"人工走过"证据（台账/日志里查）────────────────────────────
console.log(`\n【7】人工/真实调用过得证据（从活动日志里找）`);
{
  const logDir = path.join(ROOT, "_ledger-log");
  const hits = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const t = fs.readFileSync(p, "utf8");
      for (const t2 of [PRINCIPLE_GRANT_TOOL, "ledger_index", "ledger_migrate", "ledger_lessons",
        "ledger_goals", "ledger_lock", "ledger_note", "ledger_log_write", "ledger_conform",
        "ledger_triage", "ledger_recall", "ledger_handoff", "ledger_compact", CHECKPOINT_TOOL]) {
        const c = (t.match(new RegExp(`\\b${t2}\\b`, "g")) ?? []).length;
        if (c > 0) hits.set(t2, (hits.get(t2) ?? 0) + c);
      }
    }
  };
  if (fs.existsSync(logDir)) walk(logDir);
  const rows = [...hits.entries()].sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) console.log("   （活动日志里一个都没提到）");
  rows.forEach(([k, v]) => console.log(`   • ${k}：日志里出现 ${v} 次`));
  console.log(`   ⇒ ★ 这只是"日志里提到过"，**不等于"人工真走过"**（D227 的判据：要两端对账）`);
}
console.log("\n" + "═".repeat(78));
