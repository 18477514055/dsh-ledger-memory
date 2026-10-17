/**
 * ★★★ 只读复算：**本回合注入为什么是「必注 0 块」？**
 *
 * 现象（活内核 2026-10-14 00:0x 的注入原文）：
 *   `<<<LEDGER-BLOCKS\n\nLEDGER-BLOCKS>>>` —— 正文段**是空的**，
 *   上面一行写着「① **该读的块连正文**（**0** 块）」。
 *
 * 这直接违反区块级注入自己写的**安全绳③**（「任何不确定 ⇒ 退回整份」，`score===0` 兜底必注）。
 * 它同时是用户底线「不要影响模型的准确性」里最硬的一种：
 *   **模型手里没有台账正文，只有目录** —— 而目录只有标题+行数+哈希。
 *
 * 判据：用**磁盘上的 lib/index.js**（`__test`）与**真实 LEDGER.md**，
 *   按 `renderBlockInjection` 里那段 `isMust` 规则**逐块复算**，
 *   打印每块的 score / capped / unanswered / 是否必注。
 *
 * ★ 已知偏差（如实写）：`renderBlockInjection` **没有导出**，
 *   所以这里是**照抄源码那 15 行规则**复算，不是直接调用。
 *   ⇒ 结论只能用于"**磁盘上的代码会不会算出 0 块**"，
 *   不能单独证明"活内核为什么是 0 块"（那要看活内核跑的哪一版）。
 *
 * 只读：不写盘、不改任何 state。
 * 跑法：node tools/_probe-d184-must-blocks.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const T = mod.__test;

const LEDGER = path.join(ROOT, "LEDGER.md");
const raw = fs.readFileSync(LEDGER, "utf8");
console.log(`LEDGER.md = ${raw.length} 字符 / ${raw.split("\n").length} 行`);

const blocks = T.splitBlocks(raw);
console.log(`splitBlocks ⇒ ${blocks.length} 块\n`);

/** 与 `renderBlockInjection` 完全同源的 isMust 规则（照抄，见 lib/index.js:8693-8708）。 */
function mustOf(weighted, opts) {
  const { afterCompaction = false, modelAnswers, changedSet = new Set() } = opts ?? {};
  const must = [];
  const tocOnly = [];
  for (const b of weighted) {
    const w = b.weight ?? {};
    const isMust =
      afterCompaction === true
        ? true
        : w.capped === "zero"
          ? false
          : w.score >= 50 ||
            changedSet.has(b.hash) ||
            (Number.isFinite(w.unanswered) && w.unanswered > 0) ||
            (modelAnswers === undefined && w.score === 0);
    (isMust ? must : tocOnly).push(b);
  }
  return { must, tocOnly };
}

const show = (label, weighted, opts) => {
  const { must, tocOnly } = mustOf(weighted, opts);
  const mustChars = must.reduce((s, b) => s + b.text.length, 0);
  console.log(`\n${"═".repeat(78)}\n${label}\n${"═".repeat(78)}`);
  console.log(`必注 ${must.length} 块 / ${blocks.length} 块 · 正文 ${mustChars} 字符 · 目录行 ${tocOnly.length} 条`);
  for (const b of weighted) {
    const w = b.weight ?? {};
    const isM = must.includes(b);
    console.log(
      `  ${isM ? "★必注" : "  目录"} | score=${String(w.score).padStart(3)} fused=${String(w.fused).padStart(3)} ` +
        `capped=${String(w.capped).padEnd(9)} 未答=${w.unanswered} | ${b.heading.replace(/^#+\s*/, "").slice(0, 34)}`
    );
  }
};

// ① 场景 A：**还没有任何模型判分**（`modelAnswers === undefined`）
show("① modelAnswers = undefined（本会话还没做过带权重分流）", T.weightBlocks(blocks, undefined, undefined), {
  modelAnswers: undefined,
});

// ② 场景 B：**所有块都被模型答满、且四个问题全答 false**（最坏情况）
const allFalse = new Map(blocks.map((b) => [b.hash, { q1: false, q2: false, q3: false, q4: false }]));
show("② 所有块都有判分、且 q1~q4 全 false（最坏情况）", T.weightBlocks(blocks, allFalse, undefined), {
  modelAnswers: allFalse,
});

// ③ 场景 C：只有**部分**块有判分（其余 unanswered ⇒ 兜底必注）
const some = new Map(blocks.slice(0, 3).map((b) => [b.hash, { q1: false, q2: false, q3: false, q4: false }]));
show("③ 只有前 3 块有判分（其余按兜底必注）", T.weightBlocks(blocks, some, undefined), {
  modelAnswers: some,
});

// ④ 全文 vs 目录的体积差（给"注入多少"一个确切数字）
const toc = T.renderToc(blocks, { headingMaxChars: 40 });
console.log(`\n${"═".repeat(78)}\n④ 体积对照\n${"═".repeat(78)}`);
console.log(`整份台账正文        ${raw.length} 字符`);
console.log(`目录（全部 12 块）  ${toc.length} 字符`);
console.log(`正文 − 目录         ${raw.length - toc.length} 字符（省 ${(100 * (1 - toc.length / raw.length)).toFixed(1)}%）`);
