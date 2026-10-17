// D227⑤ · 接线核查（只读）：12 个子命令 + 7 处弹卡，**是否都真的接到了实现**？
// ★ 用户说：「很大一部分甚至不能实现正常的功能」⇒ 不能只看"它声称做什么"，
//   要查**它有没有对应的执行分支**（本项目 L9 栽过：注释承诺了行为，代码里调用点 = 0）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
const files = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js"));

// ① 子命令 → runLedgerSub 里有没有对应分支
console.log("【1】12 个子命令 → 在 runLedgerSub 里有没有 `sub === \"<x>\"` 分支？\n");
const subs = ["status","show","init","update","archive","compact","light","log","principles","mode","lock","handoff"];
const p5 = read("part5.js");
const subIsHandled = {};
for (const s of subs) {
  const re = new RegExp(`sub\\s*===\\s*"${s}"`);
  const handled = re.test(p5) || re.test(read("index.js")) || re.test(read("part3.js")) || re.test(read("part4.js"));
  subIsHandled[s] = handled;
  console.log(`  ${handled ? "✅" : "❌ 没有分支！"}  /ledger ${s}`);
}
const dead = subs.filter((s) => !subIsHandled[s]);
console.log(`\n  ⇒ 没找到实现分支的子命令：${dead.length === 0 ? "（无）" : dead.join(" · ")}`);

// ② 弹卡点 → 用户选了之后，有没有对应的后续动作
console.log("\n【2】7 处弹卡 → 选了之后有没有真的做事？（看 uq.ask 之后的代码）\n");
const spots = [
  ["part2.js", "definePrinciplesAccessTool"],
  ["part3.js", "offerConformChoice"],
  ["part3.js", "offerProjectChoice"],
  ["part3.js", "offerTurnEndChoice"],
  ["part3.js", "defineCheckpointTool"],
  ["part5.js", "pickLedgerSub"],
];
for (const [f, fn] of spots) {
  const src = read(f);
  const i = src.indexOf(`function ${fn}`);
  if (i < 0) { console.log(`  ⚠️ ${f} ${fn}：没定位到`); continue; }
  const seg = src.slice(i, i + 3000);
  const hasAsk = /uq\.ask\(/.test(seg);
  // 问之后有没有"分支处理"
  const after = seg.slice(seg.indexOf("uq.ask("));
  const branches = (after.match(/if\s*\(/g) ?? []).length;
  console.log(`  • ${f} ${fn}：弹卡=${hasAsk ? "是" : "否"} · 选后分支数=${branches}`);
}

// ③ 工具 → 有没有 execute 实现（不是只有描述）
console.log("\n【3】工具 → 有没有 `execute` 函数？（描述写了但没实现的 = 空壳）\n");
// ★★★★★ 我第一版这里用**固定字符窗口**（`all.slice(i, i+4000)`）——**当场误报了 3 个"没有 execute"**
//   （`ledger_init` / `ledger_triage` / `defineCheckpointTool`），而实际上它们都有，
//   只是 `execute` 在 6000 字符之外。★ 根因：**我的尺子（固定窗口）比被测对象短**
//   （`defineInitTool` 光 parameters 就 160 行）。这与 L18「窗口捞进注释」是**同一族**：
//   **用固定窗口切对象 ⇒ 对象比窗口长时，判据静默失准。**
// ⇒ 正确做法：**按"下一个 `export function define`"切段**（对象边界由代码自己给，不由我猜）。
{
  const names = ["ledger_status","ledger_init","ledger_read","ledger_write","ledger_archive","ledger_log",
    "ledger_recall","ledger_log_write","ledger_note","ledger_handoff","ledger_triage","ledger_lock",
    "ledger_conform","ledger_migrate","ledger_index","ledger_propose_principle","ledger_goals",
    "ledger_lessons","ledger_compact"];
  const constTools = [["ledger_principles_access", "PRINCIPLE_GRANT_TOOL"], ["ledger_checkpoint", "CHECKPOINT_TOOL"]];
  // 每个文件切成「定义段」：从 `export function defineX` 到下一个 `export function`
  const segsOf = (src) => {
    const marks = [...src.matchAll(/^export function [A-Za-z0-9_]+/gm)];
    return marks.map((m, k) => ({
      text: src.slice(m.index, k + 1 < marks.length ? marks[k + 1].index : src.length),
    }));
  };
  const segs = files.flatMap((f) => segsOf(read(f)));
  const findSeg = (toolName) =>
    segs.find((s) => new RegExp(`name:\\s*"${toolName}"`).test(s.text)) ??
    segs.find((s) => new RegExp(`name:\\s*${constTools.find(([, c]) => false) ?? "___none___"}`).test(s.text));
  for (const n of names) {
    const s = findSeg(n);
    console.log(`  ${s !== undefined && /async\s+execute\s*\(/.test(s.text) ? "✅" : "❌ 需要人工复核"}  ${n}`);
  }
  for (const [disp, constName] of constTools) {
    const s = segs.find((x) => new RegExp(`name:\\s*${constName}`).test(x.text));
    console.log(`  ${s !== undefined && /async\s+execute\s*\(/.test(s.text) ? "✅" : "❌ 需要人工复核"}  ${disp}（常量 ${constName}）`);
  }
}
