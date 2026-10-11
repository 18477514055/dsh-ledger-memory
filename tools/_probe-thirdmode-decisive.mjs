/**
 * ★★★ 只读：模式③「每轮独立对话」的**决定性数字**。
 *
 * 上一版两处口径都错了，这一版按纪律重做：
 *   ✗ 旧②：把 `e.data` 整个 JSON 当体积（assistant 里嵌了 source stream，虚高）
 *   ✗ 旧①：`usage.reasoningTokens` 这个字段**根本不存在**（实测只有 4 个字段）
 *
 * 本版做三件**只读**的事：
 *   ① **重建「当前窗口」**（按 surfaceOp 折叠，含 replace）—— 这才是模型真正看见的。
 *   ② **量出「稳定前缀」**（system + developer + 工具定义）—— 用户想锁死的那一段。
 *   ③ **量出「重建一次」的代价** —— 去读台账/决策/源码，各要多少 token。
 *      ★ 这是模式③成败的**唯一判据**：重建便宜 ⇒ 分页划算；重建比常驻还贵 ⇒ 白折腾。
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
const T = (chars) => chars / 4;                 // 与内核 estimate.js 同口径 CHARS_PER_TOKEN=4
const K = (chars) => (T(chars) / 1000).toFixed(1);

console.log("═".repeat(78));
console.log("① ★★★ 重建「当前窗口」（按 surfaceOp 折叠 —— 只看模型真正看见的东西）");
console.log("═".repeat(78));
// 折叠：append 入队；replace 用 splice 换掉一段（与内核 applySurfacePlan L441-444 同语义）
const nodes = [];
const bySeq = new Map();
for (const e of evs) bySeq.set(e.seq, e);
let appends = 0, replaces = 0, skipped = 0;
for (const e of evs) {
  const op = e.surfaceOp;
  if (op === undefined) continue;
  if (op === "append") { nodes.push(e.seq); appends += 1; continue; }
  const si = nodes.indexOf(op.startSeq);
  const ei = nodes.indexOf(op.endSeq);
  if (si === -1 || ei === -1 || si > ei) { skipped += 1; continue; }
  nodes.splice(si, ei - si + 1, e.seq);
  replaces += 1;
}
console.log(`  append=${appends}  replace=${replaces}  无法定位而跳过=${skipped}`);
console.log(`  ⇒ 当前 surface 节点数 = ${nodes.length}`);
console.log(`  （对照：若只数 append 事件 = ${appends} ⇒ 被折叠/替换掉的 = ${appends - nodes.length}）`);

const contentChars = (e) => {
  // ★ 只称「模型可见的那部分」：message.content，不称 e.data 里的 source stream
  const c = e.data?.message?.content;
  if (Array.isArray(c)) return JSON.stringify(c).length;
  if (typeof e.data?.message?.content === "string") return e.data.message.content.length;
  return 0;
};
const comp = new Map();
let totalChars = 0;
for (const seq of nodes) {
  const e = bySeq.get(seq);
  if (e === undefined) continue;
  const c = contentChars(e);
  totalChars += c;
  if (!comp.has(e.type)) comp.set(e.type, { n: 0, chars: 0 });
  const r = comp.get(e.type); r.n += 1; r.chars += c;
}
console.log("\n  按类型（只称 message.content，chars/4）：");
for (const [t, r] of [...comp].sort((a, b) => b[1].chars - a[1].chars)) {
  console.log(`    ${t.padEnd(18)} ${String(r.n).padStart(5)} 个  ${String(r.chars).padStart(9)} chars  ${(100 * r.chars / totalChars).toFixed(1).padStart(5)}%  ≈ ${K(r.chars).padStart(7)}K tok`);
}
console.log(`    ---- 合计 ${String(totalChars).padStart(9)} chars ≈ ${K(totalChars)}K tok`);

// assistant 内容里 reasoning/text/tool-call 各占多少（当前窗口内）
let rC = 0, tC = 0, tcC = 0, rN = 0;
for (const seq of nodes) {
  const e = bySeq.get(seq);
  if (e?.type !== "assistant/message") continue;
  for (const b of e.data?.message?.content ?? []) {
    const c = JSON.stringify(b).length;
    if (b.type === "reasoning") { rC += c; rN += 1; }
    else if (b.type === "text") tC += c;
    else if (b.type === "tool-call") tcC += c;
  }
}
console.log(`\n  ★ 当前窗口里 assistant 的细分：`);
console.log(`    reasoning 块 ${String(rN).padStart(5)} 个  ${String(rC).padStart(9)} chars ≈ ${K(rC).padStart(7)}K tok  ← **不可重放**`);
console.log(`    text 块                  ${String(tC).padStart(9)} chars ≈ ${K(tC).padStart(7)}K tok  ← **不可重放**`);
console.log(`    tool-call 块             ${String(tcC).padStart(9)} chars ≈ ${K(tcC).padStart(7)}K tok  ← 可重放（能再跑一次）`);

console.log("\n" + "═".repeat(78));
console.log("② 稳定前缀（用户想锁死的那一段）到底多大");
console.log("═".repeat(78));
const hdrs = evs.filter((e) => e.type === "request/header");
const h = hdrs[hdrs.length - 1];
let toolChars = 0, toolN = 0;
if (h?.data?.header?.tools) {
  toolN = h.data.header.tools.length;
  toolChars = JSON.stringify(h.data.header.tools).length;
}
const lastHdrSeq = h?.seq ?? -1;
// 前缀 = 最后一个 header 之前所有 system/developer/user，加上工具定义
let preChars = 0;
for (const seq of nodes) {
  const e = bySeq.get(seq);
  if (e === undefined || e.seq > lastHdrSeq) continue;
  if (["system/message", "developer/message"].includes(e.type)) preChars += contentChars(e);
}
console.log(`  工具定义：${toolN} 个 / ${toolChars.toLocaleString()} chars ≈ ${K(toolChars)}K tok`);
console.log(`  system + developer 消息：${preChars.toLocaleString()} chars ≈ ${K(preChars)}K tok`);
console.log(`  ⇒ **稳定前缀 ≈ ${K(toolChars + preChars)}K tok**`);
console.log(`  （用户设想：每次注入只有这一段 + 一个指针）`);

console.log("\n" + "═".repeat(78));
console.log("③ ★★★ 决定性：重建一次要读多少？（模式③的唯一判据）");
console.log("═".repeat(78));
const ROOT = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const targets = [
  ["LEDGER.md", path.join(ROOT, "LEDGER.md")],
  ["DECISIONS.md", path.join(ROOT, "DECISIONS.md")],
  ["README.md", path.join(ROOT, "README.md")],
  ["lib/index.js", path.join(ROOT, "lib", "index.js")],
  ["tools/selftest.mjs", path.join(ROOT, "tools", "selftest.mjs")],
];
let sum = 0;
for (const [name, p] of targets) {
  try {
    const st = fs.statSync(p);
    const c = st.size;
    sum += c;
    console.log(`  ${name.padEnd(20)} ${String(c).padStart(10)} chars ≈ ${K(c).padStart(7)}K tok`);
  } catch { console.log(`  ${name.padEnd(20)} 读不到`); }
}
console.log(`  ---- 五样合计 ${sum.toLocaleString()} chars ≈ ${K(sum)}K tok`);
console.log(`\n  ★ 对照：当前整个窗口 ≈ ${K(totalChars)}K tok`);
console.log(`  ★ 对照：工具定义　 ≈ ${K(toolChars)}K tok`);
const ratio = T(sum) / Math.max(1, T(totalChars));
console.log(`  ⇒ **重建一次 = 当前整个窗口的 ${ratio.toFixed(2)} 倍**`);
if (ratio > 1) {
  console.log("  ⇒ ⚠ **重建比常驻还贵**：全量重建一遍，等于把窗口又装满一次以上。");
  console.log("     ★ 所以「分页」必须**只取一页**，不能「每次都全量重读目录」。");
} else {
  console.log("  ⇒ 重建比常驻便宜 ⇒ 分页在经济上成立。");
}

console.log("\n" + "═".repeat(78));
console.log("④ 参考：本会话真实账单量级（usage 实测，单位=点）");
console.log("═".repeat(78));
const withUsage = evs.filter((e) => e.type === "assistant/message" && e.data?.usage);
const s = (k) => withUsage.reduce((a, e) => a + Number(e.data.usage[k] || 0), 0);
const W = 1000000;
console.log(`  totalTokens（每次请求的窗口大小累加）= ${(s("totalTokens") / W).toFixed(1)} 点  ← 「1M 窗口用出了多少」`);
console.log(`  cacheRead（命中，便宜）              = ${(s("cacheReadTokens") / W).toFixed(1)} 点`);
console.log(`  inputTokens（未命中，全价）          = ${(s("inputTokens") / W).toFixed(3)} 点`);
console.log(`  outputTokens（输出）                 = ${(s("outputTokens") / W).toFixed(2)} 点`);
console.log(`  ⇒ 命中率 = ${(100 * s("cacheReadTokens") / Math.max(1, s("totalTokens"))).toFixed(1)}%`);
console.log(`  ⇒ ★ **每一次请求的平均窗口 = ${Math.round(s("totalTokens") / withUsage.length)} tok**（不是 1M）`);
