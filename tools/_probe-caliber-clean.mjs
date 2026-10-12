/**
 * ★★★ 只读探针 ⑭：**水位口径差**（插件自报 vs 内核口径）—— 干净版。
 *
 * ★ 为什么这条重要（台账 §十 第 10 条，也是"全量会不会太晚"的关键）：
 *   插件所有闸门（30/50/70 提醒、75 全量线）都用 `measurePressure`
 *   （= `ctx.get("tokenMeter").measure(session).totalTokens`）。
 *   而内核请求头里是 `usage.totalTokens`。**若两者系统性差几度**：
 *     · 插件偏低 ⇒ 插件的 75% 实际落在内核 79% ⇒ **贴着内核 80% 硬压线**（抓不到胶囊）
 *     · 插件偏高 ⇒ 压得太早（浪费）
 *   ⇒ 台账旧记的假设是「重注加回 ≈4 点（插件报 69%、真实请求 73%）」，**必须核实**。
 *
 * ★★ 上一版为什么不能用（我自己查出的尺子错）：它在**所有注入**里正则抓「水位 NN%」，
 *   而台账正文里被我抄过那句话 ⇒ 抓到的是**引述**，不是真提醒 ⇒ 配对全乱
 *   （出现 +44.5 / −53.2 这种荒谬差值）。★ 这是纪律 4（剥离标记本身不得出现在内容里）的形态。
 *
 * ★ 本版两条硬规矩：
 *   ① **只认水位提醒**（`上下文水位已到` 是 `renderPressureNotice` 的固定开头，别处不会出现）
 *      —— 这是"被测系统自己产生的那部分"（纪律 2）。
 *   ② **配对到同一步**（提醒是 pre-step 生成、随本步请求发出 ⇒ 取其后**同回合**的第一条
 *      `assistant/message`），而不是"60 秒内随便一条"。
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

// ── ① 水位提醒（只认固定开头，排除台账正文里的引述）────────────────────
const NOTICE = "上下文水位已到";
const notices = [];
for (const e of events) {
  if (nameOf(e) !== "user/message") continue;
  if (e?.data?.source?.kind === undefined) continue;
  let text = "";
  const c = e?.data?.content;
  if (Array.isArray(c)) for (const x of c) if (x?.type === "text") text += x.text ?? "";
  // ★ 真提醒带"实测：已用 N tokens / 官方上限 M tokens"这行 ⇒ 用它当**第二道指纹**，
  //   进一步排除"我在台账里引用过这句话"的情形。
  if (!text.includes(NOTICE)) continue;
  if (!/实测：已用\s*[\d,]+\s*tokens/.test(text)) continue; // 引述没有这行
  // ★★★ 尺子修正（第 30 次）：文案是「上下文水位已到 **50%**（现 **69%**）」——
  //   第一个数是**档位**（tier），第二个才是**实测水位**。我第一版抓了第一个
  //   ⇒ 拿"档位"当"水位"（50 vs 实际 69）⇒ 全是垃圾数据。
  //   ★ 正解：抓 `（现 NN%）`；并用「实测：已用 N tokens」**交叉核对**（两者必须自洽）。
  const m = text.match(/（现\s*(\d{1,3})\s*%）/);
  const used = text.match(/已用\s*([\d,]+)\s*tokens\s*\/\s*官方上限\s*([\d,]+)/);
  notices.push({
    t: timeOf(e),
    pct: m === null ? undefined : Number(m[1]),
    used: used === null ? undefined : Number(used[1].replace(/,/g, "")),
    window: used === null ? undefined : Number(used[2].replace(/,/g, "")),
  });
}

// ── ② 内核读数 ────────────────────────────────────────────────────────
const kernel = [];
for (const e of events) {
  if (nameOf(e) !== "assistant/message") continue;
  const tot = e?.data?.usage?.totalTokens;
  const t = timeOf(e);
  if (tot === undefined || t === undefined) continue;
  kernel.push({ t, tot, turn: e?.data?.turn, step: e?.data?.step });
}
/** 压缩事件（用来排除"配到压后读数"的污染）。 */
const comps = [];
for (const e of events) {
  const n = nameOf(e);
  if ((n === "compaction/start" || n === "compaction/end") && timeOf(e) !== undefined) {
    comps.push({ t: timeOf(e), n });
  }
}
/** 提醒与被匹配读数之间**有没有夹着压缩**？有夹就作废（那量的是压后水位，不是同一拍的）。 */
function compactionBetween(a, b) {
  return comps.some((c) => c.t > a && c.t <= b);
}

console.log(`水位提醒（真）${notices.length} 条 · 内核读数 ${kernel.length} 条 · 压缩 ${comps.length} 次\n`);
console.log("提醒时刻            插件自报        内核口径        差值      备注");
console.log("─".repeat(96));
let n = 0;
let sum = 0;
let skipped = 0;
const highBucket = [];
for (const x of notices) {
  // ★★★ 排除"中间夹了压缩"的配对（第 31 次尺子错）：
  //   若提醒之后先发生了一次压缩，那么"提醒后第一条 assistant/message"量的是**压后**水位，
  //   与提醒那一刻**不是同一拍** ⇒ 差值里混进了"这次压缩压掉了多少点"。
  //   ★ 实证：30% 档那几条差值（−7.0 / −9.0 / −10.4）**恰好接近单次增量的落差**（实测 ~9 点）。
  const cand = kernel.filter((y) => y.t >= x.t && y.t - x.t <= 90_000);
  const k = cand.find((y) => !compactionBetween(x.t, y.t));
  if (k === undefined || x.pct === undefined) {
    skipped++;
    const reason = cand.length === 0 ? "配不到读数" : "中间的读数都跟着压缩（排除）";
    console.log(`  ${stamp(x.t)}  ${String(x.pct).padStart(3)}%  （${reason}）`);
    continue;
  }
  const kp = (k.tot / 1_000_000) * 100;
  const d = kp - x.pct;
  n++;
  sum += d;
  if (x.pct >= 50) highBucket.push(d);
  console.log(
    `  ${stamp(x.t)}  ${String(x.pct).padStart(3)}%  (${String(x.used).padStart(7)} tok)  ` +
      `${kp.toFixed(1).padStart(6)}%  ${((d >= 0 ? "+" : "") + d.toFixed(1)).padStart(6)}  ` +
      `turn=${k.turn ?? "-"}/${k.step ?? "-"}` +
      (x.window === 1000000 ? "" : `  ⚠窗口=${x.window}`)
  );
}
console.log("─".repeat(96));
console.log(`★ 有效配对 ${n} 条（排除 ${skipped} 条：中间夹了压缩）`);
console.log(`★ 平均口径差 = ${n === 0 ? "?" : (sum / n).toFixed(2)} 点（内核 − 插件）`);
if (highBucket.length > 0) {
  const hv = highBucket.reduce((a, b) => a + b, 0) / highBucket.length;
  const hm = Math.max(...highBucket.map(Math.abs));
  console.log(`★ 其中**水位 ≥50% 的 ${highBucket.length} 条**：平均 ${hv.toFixed(2)} 点 · 最大绝对偏差 ${hm.toFixed(1)} 点`);
}
console.log(
  "\n★ 正数 = 内核读数**高于**插件自报 ⇒ 插件的闸门实际落在内核更靠后的位置（更危险）。\n" +
    "★ 判据：|平均差| ≲1 点 ⇒ 口径一致，75% 就是内核 ~75%（安全）；\n" +
    "       ≳ +3 点 ⇒ 插件低估 ⇒ 全量线贴到内核 80% 硬压线（**要处理**）。"
);
