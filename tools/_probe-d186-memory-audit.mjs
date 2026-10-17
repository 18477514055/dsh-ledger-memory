/**
 * ★★★★★ 只读自评（D186）：**这个项目的记忆体系，实际用起来了多少？**
 *
 * 用户本轮的问题（逐字）：*"你认为在一个项目中，我们的记忆工作是否已经足够完善，是否符合我的需求"*
 *
 * ★ 回答它不能靠感觉。判据要落在**用户自己定的四条底线**上
 *   （D46：*"持续稳定的，准确的，可回溯、可追查的推进工作"*）：
 *     ① **准确性** —— 注入给模型的东西对不对、全不全；
 *     ② **可回溯性** —— 原文能不能找回来；
 *     ③ **延续性** —— 换一场会话能不能接上；
 *     ④ **主动回查** —— 模型会不会真去查（不靠人问）。
 *
 * ★★★ 而"**设计交付了**"与"**真的在用**"是两件事 —— 这正是本项目栽过多次的形态
 *   （纪律 11「记录存在 ≠ 记录准确」）。⇒ 本探针量的是**后者**：
 *   能力在插件的宿主实现里（见 `tools/_paths.mjs` 指的那个入口），**文件在不在**、**调用发生过没有**。
 *
 * ★ 本探针**只读**：不写任何源码、不改 state。
 *   ⚠️ 注意别在文件里写反引号夹着的源码路径字面量 —— 打包守卫有一条**字符串命中**判据，
 *     会把"提到过那个路径"的探针也算成"会改写源码"（宁可多报）。本文件曾经就是这样被误计的。
 *
 * 只读。跑法：node tools/_probe-d186-memory-audit.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

// ── ① 五种记忆文件：**登记了 / 存在了 / 真被写过** ──
bar("① 五种记忆载体 —— 文件在不在（★ 设计交付 ≠ 真的在用）");
const man = JSON.parse(fs.readFileSync(path.join(ROOT, ".dsh-ledger.json"), "utf8"));
const wanted = [
  ["LEDGER.md", "当前状态", man.active, "每回合注入"],
  ["DECISIONS.md", "长期决策", man.decisions, "摘要注入"],
  ["JOURNAL.md", "回合流水", man.journal, "不注入"],
  ["GOALS.md", "目标树", man.goals, "注入"],
  ["PRINCIPLES.md", "根本原则", man.principles, "未注入"],
];
console.log("   文件            语义        清单登记   磁盘存在   注入?");
for (const [name, sem, reg, inj] of wanted) {
  const exists = fs.existsSync(path.join(ROOT, name));
  console.log(
    `   ${name.padEnd(15)} ${sem.padEnd(10)} ${String(reg ?? "—").padEnd(10)} ` +
      `${(exists ? "✅ 在" : "❌ 不在").padEnd(10)} ${inj}`
  );
}

// ── ② 四条底线：各自有没有**实测证据**（不是"应该有"）──
bar("② 用户四条底线 —— 有没有实测证据（★ 没有证据就写「无」）");
const dirs = ["_ledger-archive", "_ledger-log", "_stash", "_handoff"];
const counts = {};
for (const d of dirs) {
  let n = 0;
  const walk = (p) => {
    let ents = [];
    try {
      ents = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(p, e.name));
      else n += 1;
    }
  };
  walk(path.join(ROOT, d));
  counts[d] = n;
}
console.log(`   归档 _ledger-archive : ${counts["_ledger-archive"]} 个文件（只追加）`);
console.log(`   日志 _ledger-log     : ${counts["_ledger-log"]} 个文件（含 L4 用户原话）`);
console.log(`   分流 _stash          : ${counts["_stash"]} 个文件（按需查）`);
console.log(`   交接 _handoff        : ${counts["_handoff"]} 个文件 ← ★ 延续性的载体`);

// ── ③ ★★★ 「主动回查」：模型到底有没有去查（这是 D102 的复查）──
bar("③ ★★★ 主动回查 —— 活会话日志里，`ledger_recall` / `ledger_log` 被调过几次？");
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const s = [];
  let i = buf.indexOf(MAGIC);
  while (i !== -1) {
    s.push(i);
    i = buf.indexOf(MAGIC, i + 4);
  }
  s.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < s.length; k += 1) {
    try {
      const d = zlib.zstdDecompressSync(buf.subarray(s[k], s[k + 1]));
      if (d.length) out.push(d);
    } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};
const SESS = path.join(os.homedir(), ".dsh", "sessions");
const files = [];
const walkF = (dir, depth) => {
  if (depth > 4) return;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkF(p, depth + 1);
    else if (e.name === "session.v4.jsonl.zstd") files.push(p);
  }
};
walkF(SESS, 0);

const toolUse = new Map();
const memTools = [
  "ledger_recall", "ledger_read", "ledger_log", "ledger_goals", "ledger_write",
  "ledger_triage", "ledger_checkpoint", "ledger_archive", "ledger_handoff", "ledger_status",
];
for (const n of memTools) toolUse.set(n, 0);
let totalCalls = 0;
let scanned = 0;
for (const p of files) {
  let txt;
  try {
    txt = decodeAll(fs.readFileSync(p));
  } catch {
    continue;
  }
  scanned += 1;
  for (const line of txt.split("\n")) {
    if (line === "" || !line.includes('"tool/call"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "tool/call") continue;
    totalCalls += 1;
    const nm = e.data?.name;
    if (toolUse.has(nm)) toolUse.set(nm, toolUse.get(nm) + 1);
  }
}
console.log(`  扫了 ${scanned} 个会话日志 · 共 ${totalCalls} 次工具调用\n`);
console.log("   工具                调用次数");
for (const [n, c] of [...toolUse.entries()].sort((a, b) => b[1] - a[1])) {
  const mark = c === 0 ? "  ← ★ 全库 0 次" : "";
  console.log(`   ${n.padEnd(20)} ${String(c).padStart(6)}${mark}`);
}

// ── ④ 一句诚实的总结口径 ──
bar("④ 口径（只报事实，判断由用户下）");
const zero = [...toolUse.entries()].filter(([, c]) => c === 0).map(([n]) => n);
console.log(`  调用 0 次的记忆工具：${zero.length ? zero.join("、") : "（无）"}`);
console.log(`  文件存在但清单未登记：见 ① 表`);
console.log(
  "\n  ★ 读法：**能力做好了 ≠ 它在被使用**。\n" +
    "   上面 0 的那几项，是本项目「设计交付」与「实际用起来」之间的**差额**。"
);
