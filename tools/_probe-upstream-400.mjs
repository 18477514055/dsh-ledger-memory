/**
 * 只读探针：**上游 400（code 11115 超模型上限）与插件自报水位之间差多少**。
 *
 * ★ 用户报告（2026-10-21 20:49，逐字）：
 *   「本轮运行失败400: {"message":"workbuddy 上游失败：请求被上游拒绝（http 400）
 *     （code 11115，requestId 910cb3ea-…）。本次输入加上历史对话超过了模型上限。…」
 *   「而发现这个报错的时候，水位基本就是五六十左右。」
 *   「我的意思是此时并不是发生在压缩前。而是正常的对话中五六十这个时候本来也不该触发压缩。」
 *
 * ★★ 本探针要回答的**唯一问题**：
 *   报错那一刻，「插件看到的 totalTokens」与「上游看到的输入」是**同一个数**吗？
 *   —— 若两者差得远，说明 **`tokenMeter.measure()` 的量尺与真正发出去的请求体不是一回事**，
 *      那么"五六十"这个水位就是**假的安全信号**（它不保护任何东西）。
 *
 * ★ 三个必须分开量的东西（混在一起就又会是尺子错）：
 *   ① `usage.totalTokens`（官方计费口径，含 reasoning？不含？）
 *   ② `request/header` 里**真正发出去的消息条数 / 字符数**（= 上游真正收到的）
 *   ③ 插件 `measurePressure` 的分子 `meter.measure(session).totalTokens`
 *      —— 只能在活进程里调，本探针**用 ① 代替并明确标注**（不能假装相等）。
 *
 * ★ 本探针**不做任何"所以应该改成 X"的推断**，只把三者的**量级差**摆出来。
 *
 * 跑法：
 *   node tools/_probe-upstream-400.mjs
 *   node tools/_probe-upstream-400.mjs --file "<session.v4.jsonl.zstd 绝对路径>"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const argFile = (() => {
  const i = process.argv.indexOf("--file");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

const SESS_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");

function findNewest(root) {
  const cands = [];
  (function walk(d, depth) {
    if (depth > 4) return;
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.jsonl\.zstd$/.test(e.name)) {
        try {
          cands.push({ p, m: fs.statSync(p).mtimeMs });
        } catch {
          /* 忽略 */
        }
      }
    }
  })(root, 0);
  cands.sort((a, b) => b.m - a.m);
  return cands[0]?.p;
}

const FILE = argFile ?? findNewest(SESS_ROOT);
if (FILE === undefined || !fs.existsSync(FILE)) {
  console.log("SKIP：找不到会话日志");
  process.exit(0);
}
console.log(`会话日志：${FILE}`);
console.log(`大小：${(fs.statSync(FILE).size / 1024 / 1024).toFixed(2)} MB\n`);

// ── 多帧 zstd 解码（只解第一帧会丢掉 99% 的内容）───────────────────────
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const raw = fs.readFileSync(FILE);
const starts = [0];
for (let i = 1; ; ) {
  const p = raw.indexOf(MAGIC, i);
  if (p < 0) break;
  if (p !== 0) starts.push(p);
  i = p + 4;
}
const events = [];
let badFrame = 0;
for (let k = 0; k < starts.length; k += 1) {
  const end = k + 1 < starts.length ? starts[k + 1] : raw.length;
  let out;
  try {
    out = zlib.zstdDecompressSync(raw.subarray(starts[k], end));
  } catch {
    badFrame += 1;
    continue;
  }
  for (const line of out.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 半行/坏行跳过 */
    }
  }
}
console.log(`帧：${starts.length}（坏 ${badFrame}）· 事件：${events.length}\n`);

// ── 1. 有没有留下 400 的痕迹？──────────────────────────────────────────
const errs = events.filter((e) => {
  const s = JSON.stringify(e);
  return s.includes("11115") || s.includes("超过了模型上限") || s.includes("上游失败");
});
console.log(`═══ 1. 日志里带 400 / 11115 / 上游失败 的事件：${errs.length} 条 ═══`);
for (const e of errs.slice(-3)) {
  const s = JSON.stringify(e.data ?? e).slice(0, 400);
  console.log(`  · [${e.type}] ${s}`);
}
console.log("");

// ── 2. usage 走势（官方计费口径）──────────────────────────────────────
const usageMsgs = events.filter((e) => e.type === "assistant/message" && e?.data?.usage);
console.log(`═══ 2. assistant/message 带 usage：${usageMsgs.length} 条 ═══`);
const ukeys = new Set();
for (const m of usageMsgs) for (const k of Object.keys(m.data.usage)) ukeys.add(k);
console.log(`  字段：${[...ukeys].join(" · ")}\n`);

// ── 3. request/header：上游**真正收到**的那一份有多大 ─────────────────
//
// ★ 这是本次唯一能直接量到"发出去多少"的地方。
// ★★ 尺子提示：`request/header` 里的 header 是**请求头/清单**，不一定含完整 messages；
//    所以下面**同时**打印它的字段名与 messages 条数 —— 形状对了再聚合（纪律 16）。
const reqs = events.filter((e) => e.type === "request/header");
console.log(`═══ 3. request/header：${reqs.length} 条 ═══`);
const last = reqs.at(-1);
if (last !== undefined) {
  const d = last.data ?? {};
  console.log(`  顶层键：${Object.keys(last).join(" · ")}`);
  console.log(`  data 键：${Object.keys(d).join(" · ")}`);
  const h = d.header ?? d;
  if (h !== null && typeof h === "object") {
    const hk = Object.keys(h);
    console.log(`  header 键（前 40）：${hk.slice(0, 40).join(" · ")}`);
    for (const k of ["messages", "tools", "system", "model", "maxTokens"]) {
      const v = h[k];
      if (v === undefined) {
        console.log(`    ${k}: <不存在>`);
      } else if (Array.isArray(v)) {
        console.log(`    ${k}: 数组 ${v.length} 条 · ${JSON.stringify(v).length} 字符`);
      } else if (typeof v === "string") {
        console.log(`    ${k}: 字符串 ${v.length} 字符`);
      } else {
        console.log(`    ${k}: ${JSON.stringify(v).slice(0, 200)}`);
      }
    }
  }
}
console.log("");

// ── 4. 关键对照：报错前最后几条 usage vs 当时的消息体量 ────────────────
//
// ★ 判据：把 usage.totalTokens 与"该次请求的消息字符数"并排。
//   若字符数 ≫ totalTokens × 4（粗略 4 字符/token），说明**发出去的东西比计量的多**。
console.log("═══ 4. 最后 12 条 usage（官方计量口径）═══");
console.log("   seq?      input   cacheRead    output     total      命中%");
for (const m of usageMsgs.slice(-12)) {
  const u = m.data.usage;
  const inp = u.inputTokens ?? u.input ?? 0;
  const cr = u.cacheReadTokens ?? u.cacheRead ?? 0;
  const out = u.outputTokens ?? u.output ?? 0;
  const tot = u.totalTokens ?? inp + cr + out;
  const rate = inp + cr > 0 ? ((cr / (inp + cr)) * 100).toFixed(1) : "  -  ";
  console.log(
    `  ${String(m.seq ?? "?").padStart(7)} ${String(inp).padStart(10)} ${String(cr).padStart(11)} ` +
      `${String(out).padStart(9)} ${String(tot).padStart(9)} ${String(rate).padStart(8)}`
  );
}
console.log("");

// ── 5. 会话自带的上下文窗口声明（若日志里有）──────────────────────────
const ctxEvents = events.filter(
  (e) => e.type === "request/context" || JSON.stringify(e.data ?? {}).includes("contextWindow")
);
console.log(`═══ 5. 带 contextWindow 的事件：${ctxEvents.length} 条 ═══`);
for (const e of ctxEvents.slice(-3)) {
  const s = JSON.stringify(e.data ?? e);
  const i = s.indexOf("contextWindow");
  console.log(`  · [${e.type}] ${s.slice(Math.max(0, i - 120), i + 200)}`);
}
console.log("");

// ── 6. 单条最大的 user/message（注入体量排行）─────────────────────────
//
// ★ 目的：若"五六十"时刻上游仍超限，第一嫌疑就是**某一条注入特别大**。
//   ⇒ 把最大的几条按字符数列出来，并标明 kind（注入 vs 用户原话）。
const ums = events.filter((e) => e.type === "user/message");
const sized = ums
  .map((e) => {
    const c = e?.data?.content;
    let n = 0;
    if (Array.isArray(c)) for (const p of c) n += typeof p?.text === "string" ? p.text.length : 0;
    else if (typeof c === "string") n = c.length;
    return { n, kind: e?.data?.source?.kind ?? "?", seq: e.seq, turn: e?.data?.turn };
  })
  .sort((a, b) => b.n - a.n);
console.log(`═══ 6. user/message 共 ${ums.length} 条；最大 12 条（字符）═══`);
for (const s of sized.slice(0, 12)) {
  console.log(`  ${String(s.n).padStart(8)} 字符  kind=${s.kind}  seq=${s.seq ?? "?"}`);
}
const totalChars = sized.reduce((a, b) => a + b.n, 0);
console.log(`  合计：${totalChars.toLocaleString("en-US")} 字符（粗算 ≈ ${Math.round(totalChars / 4).toLocaleString("en-US")} tok）`);
console.log("");

// ── 7. 按 kind 汇总（找出谁是体量主犯）────────────────────────────────
const byKind = new Map();
for (const s of sized) {
  const r = byKind.get(s.kind) ?? { n: 0, c: 0, max: 0 };
  r.n += s.n;
  r.c += 1;
  r.max = Math.max(r.max, s.n);
  byKind.set(s.kind, r);
}
console.log("═══ 7. 按 kind 汇总（总字符 / 条数 / 单条最大）═══");
for (const [k, v] of [...byKind.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(v.n).padStart(9)}  ${String(v.c).padStart(4)} 条  单条最大 ${String(v.max).padStart(7)}  ${k}`);
}
console.log("");
console.log("完成。本探针只报量，不下结论 —— 结论必须另开一轮、用活进程的 meter 数对账。");
