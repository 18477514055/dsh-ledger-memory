/**
 * ★★★ 只读探针 ⑬：真机上「全量排了队」与「全量真跑了」**配对核对**。
 *
 * ★ 这是决定 `!hfQueued` 能不能动的那把钥匙，比逐条改夹具便宜得多：
 *   `!hfQueued` 存在的理由是"**怕全量排了队却永不执行** ⇒ 那时若增量也让路，
 *   就彻底没人压了"（D59 那个"近 4 小时零压缩"的形态）。
 *   ⇒ 那么**量真机**：每一次「即将执行一次高保真压缩」宣言，后面**是否真的跟了一次全量执行**？
 *     · 每次宣言都有执行 ⇒ 队列不会卡 ⇒ `!hfQueued` 只是"白干一次增量"的代价，**可以改**
 *     · 有宣言没有执行     ⇒ 队列真会卡 ⇒ `!hfQueued` 是**安全网**，不能直接摘
 *
 * ★ 尺子（纪律 2/15，两个来源分开数）：
 *   ① **宣言**：`user/message` 的**注入**里含「即将执行一次高保真压缩」**且**含「压缩会自动发生」
 *      —— 后者是同句里的固定措辞；只用前者会被**我自己写进台账的引述**污染（已栽过）。
 *   ② **执行**：`compaction/start` 事件，用胶囊头「自动（70% 水位）/手动」认是不是全量。
 *      ★ 胶囊是**压前**写的 ⇒ 认"是哪条路"可靠；但**成功与否**要看 `compaction/summary`。
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
const events = [];
for (const l of decodeFrames(fs.readFileSync(newestSession().p)).split("\n")) {
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

// ── ① 宣言（真宣言：注入 + 两个关键词都在）────────────────────────────
const decls = [];
for (const e of events) {
  if (nameOf(e) !== "user/message") continue;
  if (e?.data?.source?.kind === undefined) continue;
  let text = "";
  const c = e?.data?.content;
  if (Array.isArray(c)) for (const x of c) if (x?.type === "text") text += x.text ?? "";
  if (text.includes("即将执行一次高保真压缩") && text.includes("压缩会自动发生")) {
    decls.push({ t: timeOf(e), kind: e?.data?.source?.kind });
  }
}

// ── ② 每次压缩起止（用胶囊头认路径）────────────────────────────────────
const CAPS = path.join(
  "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账",
  "_ledger-log", "2026-10", "week2", "capsules"
);
const caps = fs
  .readdirSync(CAPS)
  .filter((f) => f.endsWith(".md"))
  .map((f) => {
    const s = fs.readFileSync(path.join(CAPS, f), "utf8");
    const m = s.match(/来源\*\*[:：]\s*([^\n]+)/);
    const t = f.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
    const when =
      t === null
        ? undefined
        : new Date(+t[1], +t[2] - 1, +t[3], +t[4], +t[5], +t[6]).getTime();
    return { file: f, source: m === null ? "?" : m[1].trim(), when };
  });

const starts = [];
const summaries = [];
for (const e of events) {
  const n = nameOf(e);
  if (n === "compaction/start") starts.push({ t: timeOf(e), turn: e?.data?.turn });
  if (n === "compaction/summary") summaries.push({ t: timeOf(e), shadowed: e?.data?.shadowedTokenCount });
}
/** 给一次 compaction/start 认路径：取时间最近（≤8s）的那颗胶囊来源。 */
function sourceOf(t) {
  const near = caps
    .filter((x) => x.when !== undefined && t !== undefined)
    .map((x) => ({ ...x, d: Math.abs(x.when - t) }))
    .filter((x) => x.d <= 8000)
    .sort((a, b) => a.d - b.d)[0];
  return near === undefined ? "(无胶囊)" : near.source;
}
function okOf(t) {
  const s = summaries.find((x) => x.t !== undefined && t !== undefined && Math.abs(x.t - t) <= 90_000 && x.t >= t);
  return s === undefined ? false : true;
}

console.log(`宣言 ${decls.length} 条 · 压缩 start ${starts.length} 次 · summary ${summaries.length} 次\n`);
console.log("★ 逐条核对：每条宣言之后，是否真的跟了一次【全量】执行");
console.log("─".repeat(100));
// ★★★ 尺子修正（第一版栽在这）：宣言与"全量执行"之间**可能夹着一次增量**
//   （01:11:05 宣言 → 16s 后 01:11:21 增量 → 109s 后 01:12:54 全量）。
//   ⇒ 若取"宣言后第一次压缩"，会把那次增量误判成"宣言没兑现"（**假阴性**）。
//   ⇒ 正解：在窗口内找**第一次属于全量的**压缩；只有"窗口内一次全量都没有"才算没兑现。
const FULL_WINDOW_MS = 20 * 60 * 1000;
let matched = 0;
let unmatched = 0;
for (const d of decls) {
  const inWindow = starts
    .filter((x) => x.t !== undefined && x.t >= d.t && x.t - d.t <= FULL_WINDOW_MS)
    .sort((a, b) => a.t - b.t);
  const firstFull = inWindow.find((x) => !/增量/.test(sourceOf(x.t)));
  const deltasBefore = inWindow.filter((x) => /增量/.test(sourceOf(x.t))).length;
  if (firstFull === undefined) {
    unmatched++;
    console.log(
      `  ${stamp(d.t)} [${d.kind}] ⇒ ★★ **窗口内没有任何全量**（前面有 ${deltasBefore} 次增量）`
    );
    continue;
  }
  matched++;
  const delay = Math.round((firstFull.t - d.t) / 1000);
  console.log(
    `  ${stamp(d.t)} [${d.kind}] ⇒ ${String(delay).padStart(5)}s 后 ${stamp(firstFull.t)} ` +
      `★ 全量（${sourceOf(firstFull.t)}）turn=${firstFull.turn ?? "-"} 压成=${okOf(firstFull.t) ? "是" : "否"}` +
      (deltasBefore > 0 ? `  ⚠ 其间插了 ${deltasBefore} 次增量` : "")
  );
}
console.log("─".repeat(100));
console.log(`★ 配对：宣言后**确实跑了全量** = ${matched} 条；**一次全量都没有** = ${unmatched} 条`);
console.log(
  unmatched === 0
    ? "⇒ ★ 结论：真机上「宣言 ⇒ 全量执行」**每次都兑现**（只是中间可能先插一次增量）\n" +
        "   ⇒ 队列不会卡死 ⇒ `!hfQueued` 不是防卡的；它现在的唯一作用是「让增量在那一档白干一次」。"
    : "⇒ ★ 结论：**存在宣言完全没兑现的情形** ⇒ 队列真会卡 ⇒ `!hfQueued` 是安全网，**不能直接摘**。"
);
