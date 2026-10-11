/**
 * ★ 修「user/message 称出 0 字符」（明显取法错，按纪律第 3 条先怀疑取法），
 *   并算出模式③的**地板值**：只留「稳定前缀 + 用户原话 + assistant 的 text/tool-call」是多少。
 *
 * ★ 本探针自带一个**交叉校验**：重建出的当前窗口 vs 模型最后一次请求自报的 totalTokens。
 *   两者对得上，才敢拿重建结果说话。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const s = []; let i = buf.indexOf(MAGIC);
  while (i !== -1) { s.push(i); i = buf.indexOf(MAGIC, i + 4); }
  s.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < s.length; k += 1) {
    try { const d = zlib.zstdDecompressSync(buf.subarray(s[k], s[k + 1])); if (d.length) out.push(d); } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};
const SESS = path.join(os.homedir(), ".dsh", "sessions", "--D-Deepseek~5DE5~4F5C~533A--",
  "session-fada6e5f-52f2-4a4f-b52a-3c2483db117e", "session.v4.jsonl.zstd");
const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
const bySeq = new Map();
for (const e of evs) bySeq.set(e.seq, e);
const T = (c) => c / 4;
const K = (c) => (T(c) / 1000).toFixed(1);

console.log("═".repeat(78));
console.log("① user/message 的真实结构（先看形状，再称重）");
console.log("═".repeat(78));
const users = evs.filter((e) => e.type === "user/message");
console.log(`  user/message 共 ${users.length} 条`);
const u = users[users.length - 1];
console.log(`  data 的键 = ${Object.keys(u.data ?? {}).join(" · ")}`);
console.log(`  data 前 700 字符：\n  ${JSON.stringify(u.data).slice(0, 700)}`);

// 稳健称重：把 data 里所有字符串都算上，排除明显非正文的大字段留给下面判断
const robustChars = (e) => {
  const d = e.data ?? {};
  if (d.message !== undefined) {
    const c = d.message?.content;
    if (Array.isArray(c)) return JSON.stringify(c).length;
    if (typeof c === "string") return c.length;
    if (typeof d.message === "string") return d.message.length;
  }
  if (typeof d.text === "string") return d.text.length;
  if (typeof d.content === "string") return d.content.length;
  if (Array.isArray(d.content)) return JSON.stringify(d.content).length;
  return JSON.stringify(d).length;   // 兜底：但这会虚高，下面单独标出来
};
const uChars = users.reduce((a, e) => a + robustChars(e), 0);
console.log(`\n  ⇒ 稳健称重合计 = ${uChars.toLocaleString()} chars ≈ ${K(uChars)}K tok`);
console.log(`  （上一版称出 0 字符 ⇒ 已确认为取法错，不是"用户原话不重要"）`);

console.log("\n" + "═".repeat(78));
console.log("② 重建当前窗口 · 带交叉校验");
console.log("═".repeat(78));
const nodes = [];
for (const e of evs) {
  const op = e.surfaceOp;
  if (op === undefined) continue;
  if (op === "append") { nodes.push(e.seq); continue; }
  const si = nodes.indexOf(op.startSeq);
  const ei = nodes.indexOf(op.endSeq);
  if (si === -1 || ei === -1 || si > ei) continue;
  nodes.splice(si, ei - si + 1, e.seq);
}
const cur = nodes.map((s) => bySeq.get(s)).filter(Boolean);
const cat = (e) => {
  if (e.type === "assistant/message") {
    const out = { reasoning: 0, text: 0, toolCall: 0, other: 0 };
    for (const b of e.data?.message?.content ?? []) {
      const c = JSON.stringify(b).length;
      if (b.type === "reasoning") out.reasoning += c;
      else if (b.type === "text") out.text += c;
      else if (b.type === "tool-call") out.toolCall += c;
      else out.other += c;
    }
    return out;
  }
  return { [e.type]: robustChars(e) };
};
const bucket = { reasoning: 0, text: 0, toolCall: 0, tool: 0, user: 0, system: 0, dev: 0, other: 0 };
for (const e of cur) {
  const c = cat(e);
  for (const [k, v] of Object.entries(c)) {
    if (k === "assistant/message") bucket.other += v;
    else if (k === "tool/result") bucket.tool += v;
    else if (k === "user/message") bucket.user += v;
    else if (k === "system/message") bucket.system += v;
    else if (k === "developer/message") bucket.dev += v;
    else if (k in bucket) bucket[k] += v;
    else bucket.other += v;
  }
}
const hdrs = evs.filter((e) => e.type === "request/header");
const h = hdrs[hdrs.length - 1];
const toolChars = h?.data?.header?.tools ? JSON.stringify(h.data.header.tools).length : 0;
const bodyChars = Object.values(bucket).reduce((a, b) => a + b, 0);
const rebuilt = (bodyChars + toolChars) / 4;

const withUsage = evs.filter((e) => e.type === "assistant/message" && e.data?.usage);
const lastUsed = Number(withUsage[withUsage.length - 1].data.usage.totalTokens || 0);

console.log(`  重建：正文 ${bodyChars.toLocaleString()} + 工具头 ${toolChars.toLocaleString()} = ${(bodyChars + toolChars).toLocaleString()} chars`);
console.log(`  ⇒ 重建窗口 = ${Math.round(rebuilt).toLocaleString()} tok`);
console.log(`  ⇒ 模型最后一次请求自报 totalTokens = ${lastUsed.toLocaleString()} tok`);
const err = Math.abs(rebuilt - lastUsed) / Math.max(1, lastUsed) * 100;
console.log(`  ⇒ ★ 误差 = ${err.toFixed(2)}%  ${err < 3 ? "✔ 尺子对得上，可以据此说话" : "✗ 尺子对不上，结论作废"}`);

console.log("\n" + "═".repeat(78));
console.log("③ 当前窗口的构成（模型真正看见的）");
console.log("═".repeat(78));
const rows = [
  ["工具定义（固定）", toolChars, "★ 不可压，用户说不用管"],
  ["system + developer", bucket.system + bucket.dev, "固定前缀"],
  ["assistant · reasoning", bucket.reasoning, "★★ 上一轮的推理过程"],
  ["assistant · tool-call", bucket.toolCall, "可重放"],
  ["assistant · text", bucket.text, "★ 这才是「说过的话」"],
  ["tool/result", bucket.tool, "可重读"],
  ["user/message", bucket.user, "★★ 用户原话"],
];
for (const [n, c, note] of rows) {
  console.log(`  ${n.padEnd(24)} ${String(c).padStart(10)} chars ≈ ${K(c).padStart(6)}K tok  ${(100 * c / (bodyChars + toolChars)).toFixed(1).padStart(5)}%  ${note}`);
}
console.log(`  ${"---- 合计".padEnd(24)} ${String(bodyChars + toolChars).padStart(10)} chars ≈ ${K(bodyChars + toolChars).padStart(6)}K tok`);

console.log("\n" + "═".repeat(78));
console.log("④ ★★★ 模式③的「地板」：如果只留可回溯骨架，窗口剩多少");
console.log("═".repeat(78));
const floor = toolChars + bucket.system + bucket.dev + bucket.user + bucket.text + bucket.toolCall;
console.log(`  地板 = 工具定义 + 前缀 + 用户原话 + assistant 的 text/tool-call`);
console.log(`       = ${floor.toLocaleString()} chars ≈ ${K(floor)}K tok`);
console.log(`  ⇒ 相对当前窗口（${Math.round(rebuilt).toLocaleString()} tok）：**${(100 * T(floor) / rebuilt).toFixed(1)}%**`);
console.log(`  ⇒ ★ 也就是说，被「搬走」的是 **${(100 - 100 * T(floor) / rebuilt).toFixed(1)}%**，`);
console.log(`     其中最大一块是 **reasoning ${K(bucket.reasoning)}K tok（占窗口 ${(100 * bucket.reasoning / (bodyChars + toolChars)).toFixed(1)}%）**`);

console.log("\n" + "═".repeat(78));
console.log("⑤ 参考：历史窗口大小的分布（本会话 22 次压缩）");
console.log("═".repeat(78));
const tt = withUsage.map((e) => Number(e.data.usage.totalTokens || 0)).sort((a, b) => a - b);
const q = (p) => tt[Math.min(tt.length - 1, Math.floor(p * tt.length))];
console.log(`  min=${tt[0].toLocaleString()}  p25=${q(0.25).toLocaleString()}  中位=${q(0.5).toLocaleString()}`);
console.log(`  p75=${q(0.75).toLocaleString()}  p90=${q(0.9).toLocaleString()}  **max=${tt[tt.length - 1].toLocaleString()}**`);
console.log(`  ⇒ ★ 本会话**最高只把窗口用到 ${(tt[tt.length - 1] / 1000000 * 100).toFixed(0)} 万**（窗口是 100 万）`);
console.log(`  ⇒ 平均值 ${Math.round(tt.reduce((a, b) => a + b, 0) / tt.length).toLocaleString()} tok`);
