/**
 * 只读：**诊断自加进去以后，`midTurnCompactGate` 到底跑没跑过？**
 *
 * ★ 三轮判据都栽在同一件事上（同类不同源，纪律 15 第三次）：
 *   ① 搜 "midturn" ⇒ 365 条，全是 `auto:midturn`（压缩来源票）
 *   ② 搜 `[midturn] act=` ⇒ 36 条，全是**我读源码时落进日志的文件内容**（tool/call · tool/result）
 *   ③ 现在这一版：**换一个不会出现在源码里的判据** —— 看 `[midturn]` 是否出现在
 *      **非 tool/assistant 事件**里，并且用**行首** `[midturn] act=` + 后面跟**具体数值**
 *      （`ratio=12.3%` 这种），源码里是 `${ratio}` 模板，不可能匹配。
 *
 * ★★ 更硬的判据（本版主用）：**诊断里的 `turn=` 是数字，源码里是 `${deps?.turn ?? "?"}`**。
 *   ⇒ 正则 `\[midturn\] act=\w+ why=[\w-]+ phase=\w+ ratio=[\d.]+%` —— 只有**真输出**能匹配。
 *
 * 跑法：node tools/_probe-midturn-real.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
function findNewest(root) {
  const cands = [];
  (function walk(d, depth) {
    if (depth > 4) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/\.jsonl\.zstd$/.test(e.name)) cands.push({ p, m: fs.statSync(p).mtimeMs });
      }
    } catch {}
  })(root, 0);
  cands.sort((a, b) => b.m - a.m);
  return cands[0]?.p;
}
const FILE = process.env.DSH_SESSION_FILE ?? findNewest(path.join(HOME, "sessions"));
if (FILE === undefined) { console.log("SKIP"); process.exit(0); }

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const raw = fs.readFileSync(FILE);
const cand = [0];
for (let i = 1; ; ) {
  const p = raw.indexOf(MAGIC, i);
  if (p < 0) break;
  cand.push(p);
  i = p + 4;
}
const texts = [];
for (let k = 0; k < cand.length; k += 1) {
  let out;
  try {
    out = zlib.zstdDecompressSync(raw.subarray(cand[k], k + 1 < cand.length ? cand[k + 1] : raw.length));
  } catch { continue; }
  const s = out.toString("utf8");
  const first = s.split("\n").find((l) => l.trim() !== "");
  if (first === undefined) continue;
  try { JSON.parse(first); } catch { continue; }
  texts.push(s);
}
const events = [];
for (const s of texts) {
  for (const l of s.split("\n")) {
    if (l.trim() === "") continue;
    try { events.push(JSON.parse(l)); } catch {}
  }
}

// ★ 只认真实输出：ratio 与 line 是具体百分数、turn 是数字
const REAL = /\[midturn\] act=[a-z-]+ why=[\w-]* phase=[\w-]+ ratio=[\d.]+% line=[\d.]+% turn=\d+/;

let realHits = 0;
const realSamples = [];
for (const e of events) {
  const s = JSON.stringify(e);
  // ★ 排除掉"我自己读源码"的那几类事件：源码只会出现在 tool/assistant 里
  if (e.type === "tool/call" || e.type === "tool/result" || e.type === "assistant/message") continue;
  if (REAL.test(s)) {
    realHits += 1;
    if (realSamples.length < 5) {
      const m = s.match(REAL);
      realSamples.push({ type: e.type, seq: e.seq, line: s.slice(m.index, m.index + 260) });
    }
  }
}
console.log(`═══ 真实诊断输出（正则 ${REAL.source.slice(0, 40)}…）═══`);
console.log(`  命中 ${realHits} 条`);
for (const x of realSamples) {
  console.log(`  [${x.type}] seq=${x.seq}`);
  console.log(`    ${x.line}`);
}
console.log("");

// ── 全事件类型再扫一遍（不限类型，但报告是哪些类型）──
const byType = new Map();
for (const e of events) {
  const s = JSON.stringify(e);
  if (!REAL.test(s)) continue;
  byType.set(e.type ?? "?", (byType.get(e.type ?? "?") ?? 0) + 1);
}
console.log("═══ 按事件类型看命中（★ 只应是 logger 类事件，若出现 tool/* 就是我又读源码了）═══");
if (byType.size === 0) console.log("  （无）");
for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)} × ${t}`);
}
console.log("");

// ── 这个进程里插件代码是什么时候被加载的？── 用 grep 事件找最早出现的 Gate 代码
//   判据：新代码含 `state.midTurnDbg`，旧代码没有
let firstNewCodeSeq;
for (const e of events) {
  if (JSON.stringify(e).includes("midTurnDbg")) { firstNewCodeSeq = e.seq; break; }
}
console.log(`═══ 新代码（含 midTurnDbg）最早出现在事件 seq=${firstNewCodeSeq ?? "未出现"} ═══`);
console.log("  ★ 这只能说明「会话日志里第一次出现这段文本」，不等于「进程加载了它」——");
console.log("    因为我自己读文件也会把它写进日志。**所以它不能当加载证据**。");
console.log("");

// ── 硬证据：活内核加载的那一版里有没有 midTurnDbg？── 
//   办法：内核发的工具表（request/header.data.header.tools）里不含插件源码，
//   所以这条路走不通 ⇒ 老实说清"判断不了"
console.log("═══ 能不能从日志判断「活内核加载了新代码」？═══");
console.log("  ❌ **判断不了**。理由：插件源码不会出现在 request/header 的工具表里，");
console.log("     而 logger 输出又不落盘 ⇒ 从现有证据链看不到「插件内部跑了哪个分支」。");
console.log("  ★ 这正是**必须换一种可观测手段**的原因（见下）。");
console.log("");

// ── 回合内压缩现状（这个能确定）──
const comps = events.filter((e) => e.type === "compaction/start");
const inTurn = comps.filter((c) => typeof c?.data?.turn === "number").map((c) => c.data.turn);
const maxTurn = events.filter((e) => e.type === "turn/start")
  .reduce((m, e) => (typeof e?.data?.turn === "number" ? Math.max(m, e.data.turn) : m), 0);
console.log("═══ 能确定的事实 ═══");
console.log(`  compaction/start ${comps.length} 次 · 回合内 ${inTurn.length} 次（turn ${inTurn.join(" / ")}）`);
console.log(`  当前最大 turn ${maxTurn}`);
if (inTurn.length > 0) {
  const last = Math.max(...inTurn);
  console.log(`  最后一次回合内压缩 turn ${last} ⇒ 之后 **${maxTurn - last} 个 turn 没再发生**`);
}
