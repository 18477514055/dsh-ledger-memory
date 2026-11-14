/**
 * ★★★ 只读：**本会话**（a5dd1f8f）的压缩实况统计 —— 给"压缩任务单"提供可核对数字。
 *
 * ★ 为什么另写一份：`_probe-compaction-count.mjs` 硬编码的是**另一个会话**
 *   (`session-fada6e5f…`, week2)。拿它的数字当本会话基线 = 尺子错。
 *
 * ★ 纪律：
 *   · 只按 `j.type` **精确匹配**，绝不用 `includes` 判事件类型
 *   · 报数时**同时报分母**（start 数 / end 数 / 失败数），不单报一个数
 *   · 取不到就报 FAILED 并说清拿到了什么，不猜
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const starts = [];
  let i = buf.indexOf(MAGIC);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  starts.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < starts.length; k += 1) {
    try {
      const d = zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1]));
      if (d.length) out.push(d);
    } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};

const fmt = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });

// 本会话的官方日志目录（路径里的中文被 DSH 转义过）
const SESSDIR = path.join(
  os.homedir(), ".dsh", "sessions",
  "--D-Deepseek~5DE5~4F5C~533A-20-DSH~63D2~4EF6-04-~5176~4F59~63D2~4EF6-10.~9879~76EE~53F0~8D26--",
  "session-a5dd1f8f-8f7a-4590-9ede-34f72354dad8",
  "session.v4.jsonl.zstd",
);

if (!fs.existsSync(SESSDIR)) {
  console.log(`FAILED: 会话日志不存在 → ${SESSDIR}`);
  process.exit(1);
}

const st = fs.statSync(SESSDIR);
console.log("═══ 源文件 ═══");
console.log(`  ${SESSDIR}`);
console.log(`  size = ${st.size} B  mtime = ${fmt(st.mtimeMs)}`);

const text = decodeAll(fs.readFileSync(SESSDIR));
const evs = [];
for (const line of text.split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
console.log(`  解出事件 ${evs.length} 条`);

// ── ① 事件类型直方图（只数 compaction* / 与之相关）───────────────────────
console.log("\n═══ ① compaction* 事件类型直方图 ═══");
const hist = new Map();
for (const e of evs) if (typeof e.type === "string" && e.type.startsWith("compaction")) hist.set(e.type, (hist.get(e.type) || 0) + 1);
if (hist.size === 0) console.log("  (一条都没有)");
for (const [k, v] of [...hist.entries()].sort()) console.log(`  ${k.padEnd(28)} ${v}`);

const starts = evs.filter((e) => e.type === "compaction/start");
const ends = evs.filter((e) => e.type === "compaction/end");
console.log(`\n  start = ${starts.length} · end = ${ends.length} · ★ 未配对(start 多于 end) = ${starts.length - ends.length}`);

// ── ② 逐次列出：时间 / turn（null=回合末，数字=回合内）/ 结果 ────────────
console.log("\n═══ ② 逐次压缩（时间 / 归属 / 是否配对 end）═══");
for (const s of starts) {
  const d = s.data ?? {};
  const who = d.sourceCommandId !== undefined ? "手动(命令)" : d.turn === null ? "回合末" : `回合内(turn=${d.turn})`;
  // 找它之后最近的 end（简化：按时间顺序）
  const e = ends.find((x) => x.time >= s.time);
  const paired = e ? (e.time - s.time) : null;
  const ratio = d.beforeTokens ?? d.tokensBefore ?? null;
  const after = e?.data ? (e.data.afterTokens ?? e.data.tokensAfter ?? null) : null;
  console.log(`  ${fmt(s.time)}  ${who.padEnd(16)} 配对=${paired === null ? "否" : `是(+${Math.round(paired / 1000)}s)`}  before=${ratio ?? "?"} after=${after ?? "?"}  keys=${Object.keys(d).join(",")}`);
}

// ── ③ 报错：找含 workbuddy / 502 / fetch failed 的任何事件 ────────────────
console.log("\n═══ ③ 压缩失败证据（在事件里找 502 / workbuddy / fetch failed）═══");
let hits = 0;
for (const e of evs) {
  const s = JSON.stringify(e);
  if (/workbuddy|transport error|fetch failed|上游失败/.test(s)) {
    hits += 1;
    if (hits <= 8) {
      console.log(`  [${e.type}] ${fmt(e.time)}`);
      const m = s.match(/[^"]{0,160}(?:workbuddy|transport error|fetch failed|上游失败)[^"]{0,200}/);
      console.log(`      … ${(m ? m[0] : s).slice(0, 320)} …`);
    }
  }
}
console.log(`  命中 ${hits} 条事件`);

// ── ④ 水位：最后一次 assistant message 的 usage ──────────────────────────
console.log("\n═══ ④ 最近一次真 token 用量（assistant/message.data.usage）═══");
const msgs = evs.filter((e) => e.type === "assistant/message" && e.data?.usage);
console.log(`  带 usage 的 assistant/message = ${msgs.length} 条`);
const last = msgs[msgs.length - 1];
if (last) {
  const u = last.data.usage;
  console.log(`  最后一次 ${fmt(last.time)}`);
  console.log(`    inputTokens=${u.inputTokens} cacheReadTokens=${u.cacheReadTokens} outputTokens=${u.outputTokens} totalTokens=${u.totalTokens}`);
  const sum = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.outputTokens ?? 0);
  console.log(`    校验 total ≡ in+cache+out : ${sum} vs ${u.totalTokens} → ${sum === u.totalTokens ? "成立" : "不成立"}`);
}

// ── ⑤ 会话跨度 ───────────────────────────────────────────────────────────
const t0 = evs[0]?.time, t1 = evs[evs.length - 1]?.time;
console.log("\n═══ ⑤ 会话跨度 ═══");
console.log(`  ${fmt(t0)} → ${fmt(t1)}  约 ${((t1 - t0) / 3600000).toFixed(1)} 小时`);
