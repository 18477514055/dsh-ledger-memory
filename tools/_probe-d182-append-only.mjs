/**
 * 探针：验证「索引到上限后，新记录会被当场砍掉」这个判断。
 *
 * ★ 为什么要单独验（纪律：「0 命中先怀疑尺子」的反面 —— 这次是**推理也要验**）：
 *   我读代码推出 `list.push(rec)` 后紧跟 `list.length = idxMax`
 *   是**尾部截断**（保留最旧的 N 条、丢掉刚加的最新一条）。
 *   但"我读代码觉得"不构成证据 ⇒ 用**同一个函数**跑一遍看结果。
 *
 * ★ 判据：喂 62 条（> 60），看**第 61、62 条**在不在结果里。
 *   · 在  ⇒ 我的判断错了（那就不该改这一处）
 *   · 不在 ⇒ 判断成立，且这是**真缺陷**（长会话里索引会永久冻结在最早的 60 段）
 */
import fs from "node:fs";
import path from "node:path";

const LIB = path.join(import.meta.dirname, "..", "lib", "index.js");
const raw = fs.readFileSync(LIB, "utf8");

// ── 复刻那三行的**确切语义**（不是"大意"）──────────────────────────────
const idxMax = 60;
function mimicReduce(pushNew) {
  let list = [];
  for (let i = 1; i <= 62; i += 1) {
    const rec = { summarySeq: i };
    if (!list.some((x) => x.summarySeq === rec.summarySeq)) {
      list.push(rec);
      if (pushNew && list.length > idxMax) list.length = idxMax;
    }
  }
  return list;
}

const withReduce = mimicReduce(true);
console.log("=== 现状（有 list.length = idxMax）===");
console.log("条数:", withReduce.length);
console.log("seq 范围:", withReduce[0].summarySeq, "…", withReduce.at(-1).summarySeq);
console.log("第 61 条在不在:", withReduce.some((x) => x.summarySeq === 61));
console.log("第 62 条在不在:", withReduce.some((x) => x.summarySeq === 62));
console.log("★ 结论:", withReduce.some((x) => x.summarySeq === 62)
  ? "新记录**保住了**（我的判断错了）"
  : "新记录被**当场丢弃** ⇒ 判断成立，确是缺陷");

// ── 对照：只要挪成"保留最新"就正常 ──────────────────────────────────────
function mimicSliceLatest() {
  let list = [];
  for (let i = 1; i <= 62; i += 1) {
    const rec = { summarySeq: i };
    if (!list.some((x) => x.summarySeq === rec.summarySeq)) {
      list.push(rec);
      if (list.length > idxMax) list = list.slice(list.length - idxMax);
    }
  }
  return list;
}
const sliced = mimicSliceLatest();
console.log("\n=== 对照（改为保留最新 N 条）===");
console.log("条数:", sliced.length, "seq 范围:", sliced[0].summarySeq, "…", sliced.at(-1).summarySeq);

// ── 顺带：这一处是否**真的**在源码里（防止我记错行）────────────────────
console.log("\n=== 源码核对 ===");
const line = raw.split(/\r?\n/).findIndex((l) => l.includes("list.length = idxMax"));
const around = raw.split(/\r?\n/).slice(line - 2, line + 2);
console.log(`源码第 ${line + 1} 行附近：`);
for (const l of around) console.log("  " + l.trim());
