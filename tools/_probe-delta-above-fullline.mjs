/**
 * ★★★ 只读探针：量化「增量在全量线上方白干」的真实频率。
 *
 * ★ 用户的问题：*"是不是应该限制到了 70% 以上的时候，增量压缩不再发生？"*
 *   上一个实验已证伪"夹具缺 idle"这个解释 ⇒ 现在**用真机数据回答"值不值得改"**。
 *
 * ★ 要量的是两件事（必须分开，纪律 15）：
 *   ① 每次压缩**属于哪条路**（增量 / 全量）—— 只认胶囊头那一行（压前写的）
 *      ★ 但对"是否压成"要用 `compaction/summary` 的序号（胶囊只证明"尝试过"）。
 *   ② 它**发生在什么水位** —— 内核自己的 `assistant/message.usage.totalTokens` ÷ 窗口。
 *
 * ★ 判据（回答用户）：把「增量」四条与「全量」四条并排列出各自的水位，
 *   数出**有多少次增量发生在全量线(75%)以上** —— 那才是"白干"的次数。
 *   ★ 注意区分两个线：用户的设置 **0.75**（`highFidelityCompactRatio`）
 *     与内核的 **0.80**（硬压）。用户问的"70%"其实是他记得的旧值 ⇒ 按 0.75 报。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

function decodeFrames(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  let idx = buf.indexOf(MAGIC, 0);
  while (idx !== -1) {
    starts.push(idx);
    idx = buf.indexOf(MAGIC, idx + 1);
  }
  let out = "";
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      const d = zlib.zstdDecompressSync(buf.subarray(starts[k], end));
      if (d.length) out += d.toString("utf8");
    } catch {
      /* 尾帧不完整 */
    }
  }
  return out;
}
const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");
function newestSession() {
  let best;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === "session.v4.jsonl.zstd") {
        const m = fs.statSync(p).mtimeMs;
        if (best === undefined || m > best.m) best = { p, m };
      }
    }
  };
  walk(SESSIONS, 0);
  return best;
}
const target = newestSession();
const events = [];
for (const l of decodeFrames(fs.readFileSync(target.p)).split("\n")) {
  if (l.trim() === "") continue;
  try {
    events.push(JSON.parse(l));
  } catch {
    /* 跳过 */
  }
}
const timeOf = (e) => {
  for (const k of ["time", "timestamp", "at", "ts"]) {
    const v = e?.[k];
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return undefined;
};
const nameOf = (e) => String(e?.name ?? e?.event ?? e?.type ?? "(无)");
const stamp = (ms) => new Date(ms).toLocaleString("sv-SE").slice(5, 19);

// ── 胶囊来源（压前写；用来认"这次是哪条路"）────────────────────────────
const CAPS = path.join(
  "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账",
  "_ledger-log", "2026-10", "week2", "capsules"
);
const capFiles = fs.readdirSync(CAPS).filter((f) => f.endsWith(".md")).sort();
const caps = capFiles.map((f) => {
  const s = fs.readFileSync(path.join(CAPS, f), "utf8");
  const m = s.match(/来源\*\*[:：]\s*([^\n]+)/);
  // 文件名形如 2026-10-12-011121-fada.md ⇒ 取时间戳（本地）
  const t = f.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
  const when =
    t === null
      ? undefined
      : new Date(Number(t[1]), Number(t[2]) - 1, Number(t[3]), Number(t[4]), Number(t[5]), Number(t[6])).getTime();
  return { file: f, source: m === null ? "?" : m[1].trim(), when };
});

// ── 压缩事件（含压前水位）──────────────────────────────────────────────
const WINDOW = 1_000_000;
let lastTot;
const comps = [];
for (const e of events) {
  const n = nameOf(e);
  if (n === "assistant/message") {
    const tot = e?.data?.usage?.totalTokens;
    if (tot !== undefined) lastTot = tot;
    continue;
  }
  if (n === "compaction/start") {
    comps.push({ t: timeOf(e), before: lastTot === undefined ? undefined : lastTot / WINDOW, turn: e?.data?.turn });
    continue;
  }
  if (n === "compaction/summary") {
    const c = comps.at(-1);
    if (c !== undefined) {
      c.shadowed = e?.data?.shadowedTokenCount;
      const seqs = e?.data?.shadowedSeqs;
      if (Array.isArray(seqs) && seqs.length > 0) c.seqRange = [Math.min(...seqs), Math.max(...seqs)];
    }
  }
}

// ── 配对：胶囊与压缩事件（同一次压缩，胶囊是压前写 ⇒ 时间差通常 < 5 秒）──
console.log("窗口：全部历史（本会话）\n");
console.log("  时刻             压前水位   路径（胶囊来源）        被压 tok   seq 区间      判定");
console.log("─".repeat(104));
let deltaAbove = 0;
let deltaTotal = 0;
let fullTotal = 0;
for (const c of comps) {
  const near = caps
    .filter((x) => x.when !== undefined && c.t !== undefined)
    .map((x) => ({ ...x, d: Math.abs(x.when - c.t) }))
    .filter((x) => x.d <= 8000)
    .sort((a, b) => a.d - b.d)[0];
  const src = near === undefined ? "(无胶囊)" : near.source;
  const isFull = /全量|70%|手动|命令|工具|卡片/.test(src);
  const isDelta = /增量/.test(src);
  if (isDelta) deltaTotal++;
  if (isFull) fullTotal++;
  const w = c.before === undefined ? undefined : c.before * 100;
  let verdict = "";
  if (isDelta && w !== undefined && w >= 75) {
    deltaAbove++;
    verdict = "★ 白干（已在全量线上方）";
  } else if (isDelta) {
    verdict = "○ 正常（全量线下方）";
  } else if (isFull) {
    verdict = "◆ 全量本身";
  }
  console.log(
    `  ${stamp(c.t).padEnd(17)} ${(w === undefined ? "?" : w.toFixed(1) + "%").padStart(7)}   ` +
      `${src.padEnd(22)} ${String(c.shadowed ?? "-").padStart(8)}   ` +
      `${(c.seqRange === undefined ? "-" : `${c.seqRange[0]}..${c.seqRange[1]}`).padEnd(13)} ${verdict}`
  );
}
console.log("─".repeat(104));
console.log(`\n合计：压缩事件 ${comps.length} 次（可认路径：增量 ${deltaTotal} · 全量 ${fullTotal}）`);
console.log(
  `★★ 其中「增量发生在 75% 以上」= **${deltaAbove} 次**` +
    (deltaTotal > 0 ? `（占增量的 ${((deltaAbove / deltaTotal) * 100).toFixed(0)}%）` : "")
);
console.log(
  deltaAbove === 0
    ? "⇒ 结论：本会话**没有**出现「增量在全量线上方白干」⇒ 那个改动省不下任何东西。"
    : `⇒ 结论：白干 **${deltaAbove}** 次（每次多付一次 LLM 摘要）。`
);
