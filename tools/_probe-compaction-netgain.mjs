/**
 * ★★★ 只读：**压缩的真实净收益** —— 每次压掉多少、压完立即水位多少。
 *
 * ★ 这是回答"为什么压缩始终实现不了目标"的核心指标。
 *   如果「压完立即水位」仍然很高 ⇒ 压缩的收益被「压缩后重新注入」吃掉了。
 *
 * ★ 尺子纪律：
 *   · 压缩前水位取 compaction/summary 的 usage.inputTokens+cacheReadTokens（那次 LLM 调用看进去的量）
 *   · 压掉量取 shadowedTokenCount（内核自己算的被替换掉的 token）
 *   · 压后水位取**该次 compaction/end 之后第一条** assistant/message 的 usage 合计
 *   · 三者都是内核自己写的数字，不是我推的
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const starts = []; let i = buf.indexOf(MAGIC);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  starts.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < starts.length; k += 1) {
    try { const d = zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1])); if (d.length) out.push(d); } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};
const fmt = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });

const SESS = path.join(os.homedir(), ".dsh", "sessions",
  "--D-Deepseek~5DE5~4F5C~533A-20-DSH~63D2~4EF6-04-~5176~4F59~63D2~4EF6-10.~9879~76EE~53F0~8D26--",
  "session-a5dd1f8f-8f7a-4590-9ede-34f72354dad8", "session.v4.jsonl.zstd");
const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}

const sums = evs.filter((e) => e.type === "compaction/summary");
const ends = evs.filter((e) => e.type === "compaction/end");
const msgs = evs.filter((e) => e.type === "assistant/message" && e.data?.usage);

const rows = [];
for (const s of sums) {
  const d = s.data ?? {};
  const u = d.usage ?? {};
  const seen = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0);
  const shadowed = d.shadowedTokenCount ?? null;
  // 压后第一条 assistant/message
  const after = msgs.find((m) => m.time > s.time);
  const au = after?.data?.usage ?? {};
  const afterTotal = (au.inputTokens ?? 0) + (au.cacheReadTokens ?? 0) + (au.outputTokens ?? 0);
  rows.push({
    time: s.time,
    model: d.model ?? "?",
    maxTokens: d.maxTokens ?? null,
    seen, shadowed,
    afterTotal: afterTotal || null,
    beforeTotal: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.outputTokens ?? 0),
  });
}

console.log("═══ 每次压缩的真实数字（内核自报）═══");
console.log("时间              压缩调用看进去   压掉(shadowed)   压后立即水位   净留存");
console.log("─".repeat(88));
for (const r of rows) {
  const net = r.shadowed !== null && r.afterTotal ? r.afterTotal : null;
  console.log(
    `${fmt(r.time)}  ${String(r.seen).padStart(9)}  ${String(r.shadowed ?? "?").padStart(13)}  ${String(r.afterTotal ?? "?").padStart(12)}  ${String(net ?? "?").padStart(8)}`
  );
}

// ── 汇总（带时间窗：最近 8 次 vs 全部）
const withAll = rows.filter((r) => r.shadowed && r.afterTotal);
const avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
console.log("\n═══ 汇总 ═══");
console.log(`  可算净留存的压缩次数 = ${withAll.length} / ${rows.length}`);
console.log(`  平均压掉 shadowed = ${avg(withAll.map((r) => r.shadowed))}`);
console.log(`  平均压后立即水位 = ${avg(withAll.map((r) => r.afterTotal))}`);
const last8 = withAll.slice(-8);
console.log(`  ★ 最近 8 次：压掉均值 ${avg(last8.map((r) => r.shadowed))} · 压后水位均值 ${avg(last8.map((r) => r.afterTotal))}`);

// ── 压缩用的模型与 maxTokens（压缩本身是一次 LLM 调用，会失败）
console.log("\n═══ 压缩调用用的 provider / model / maxTokens ═══");
const byModel = new Map();
for (const s of sums) {
  const d = s.data ?? {};
  const k = `${d.provider ?? "?"}/${d.model ?? "?"} max=${d.maxTokens ?? "?"}`;
  byModel.set(k, (byModel.get(k) || 0) + 1);
}
for (const [k, v] of byModel) console.log(`  ${k}  ×${v}`);

// ── 压缩输出长度（summary 正文），看是不是被 maxTokens 截断
console.log("\n═══ 压缩产出正文长度（最后 6 次）═══");
for (const s of sums.slice(-6)) {
  const d = s.data ?? {};
  const txt = Array.isArray(d.summary) ? d.summary.map((x) => x?.text ?? "").join("") : String(d.summary ?? "");
  const rawLen = typeof d.rawOutput === "string" ? d.rawOutput.length : (Array.isArray(d.rawOutput) ? JSON.stringify(d.rawOutput).length : 0);
  const outTok = d.usage?.outputTokens ?? "?";
  console.log(`  ${fmt(s.time)}  summaryChars=${String(txt.length).padStart(6)}  rawOutputChars=${String(rawLen).padStart(7)}  outputTokens=${outTok}  maxTokens=${d.maxTokens}`);
}

// ── 两次压缩之间的"存活时间"：用间隔看压缩频率
console.log("\n═══ 压缩间隔（小时）═══");
const gaps = [];
for (let i = 1; i < sums.length; i += 1) gaps.push((sums[i].time - sums[i - 1].time) / 3600000);
console.log(`  次数=${gaps.length} 均值=${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2)}h 最短=${Math.min(...gaps).toFixed(2)}h 最长=${Math.max(...gaps).toFixed(2)}h`);
