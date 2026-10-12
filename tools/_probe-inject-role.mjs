/**
 * ★★★ 只读：核「注入落成 role:"user"」这个危险载体（对标 billion-context issue #1634）。
 *
 * **#1634 的病**（`bug`+`p1`，**环境就是 DSH `desktop` lane**，2026-09-29 提出、当天 PR #1649 修）：
 *   内部簿记以 `role:"user"` 注入 ⇒ **模型回答压缩元数据而不应答用户**，
 *   且 *"the pollution is **self-reinforcing** inside the session"*。
 *
 * **我们的自述**：注入落成 `user/message`（`lib/index.js` L11190 `role: "user"`）。
 * ⇒ **同一危险载体**，必须量清三件事：
 *   ① 我们的注入占"user 角色"消息的多大比例（比例越高，"用户之声"被污染得越重）；
 *   ② 我们的注入文本里**有没有"要求模型回应"的措辞**（#1634 的直接触发条件）；
 *   ③ 有没有**把用户原话与注入混同**的证据（那是"模型把摘要当正文"的机制）。
 *
 * ★ 判据只用 `data.source.kind`（**不是** role，也不是关键词）—— 这是 D84 那次的教训。
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
const SID = "session-fada6e5f-52f2-4a4f-b52a-3c2483db117e";
const SESS = path.join(os.homedir(), ".dsh", "sessions", "--D-Deepseek~5DE5~4F5C~533A--", SID, "session.v4.jsonl.zstd");
const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
evs.sort((a, b) => a.seq - b.seq);

/**
 * 取一条事件的文本。
 * ★★ 坑（本探针第一版就栽了）：**两种事件的形状不同** ——
 *   · `user/message`        → `data.content`（数组）
 *   · `assistant/message`   → `data.message.content`（数组）
 *   ⇒ 第一版只读 `data.content` ⇒ assistant **全部取成空串** ⇒ ④ 得"0 个"
 *     那种数（纪律第 3 条：取不到值先怀疑取法）。
 */
const textOf = (d) => {
  const c = d?.content ?? d?.message?.content;
  if (Array.isArray(c)) return c.map((x) => x?.text ?? "").join("");
  return typeof c === "string" ? c : "";
};

// ── ① 按 source.kind 统计所有 user/message ────────────────────────────────
console.log("═".repeat(94));
console.log("① `user/message` 按 `source.kind` 分布（★ 判据用 kind，不用 role）");
console.log("═".repeat(94));
const byKind = new Map();
let userMsgs = 0;
for (const e of evs) {
  if (e.type !== "user/message") continue;
  userMsgs += 1;
  const k = e.data?.source?.kind ?? "(无 kind)";
  if (!byKind.has(k)) byKind.set(k, { n: 0, chars: 0, sample: "" });
  const rec = byKind.get(k);
  rec.n += 1;
  const t = textOf(e.data);
  rec.chars += t.length;
  if (rec.sample === "" && t !== "") rec.sample = t.replace(/\s+/g, " ").slice(0, 100);
}
const sorted = [...byKind.entries()].sort((a, b) => b[1].n - a[1].n);
console.log(`  总计 ${userMsgs} 条 user/message`);
for (const [k, r] of sorted) {
  const pct = ((r.n / userMsgs) * 100).toFixed(1);
  console.log(`  ${String(r.n).padStart(6)} 条 (${pct.padStart(5)}%)  ${String(r.chars).padStart(9)} 字符  kind=${k}`);
  console.log(`                                         例：${r.sample}`);
}
console.log(`\n  ★ 真用户原话 = kind "user" ⇒ **${byKind.get("user")?.n ?? 0}** 条`);
console.log(`  ★ 我们的注入 = kind "project-ledger-notes" ⇒ **${byKind.get("project-ledger-notes")?.n ?? 0}** 条`);

// ── ② 我们的注入里有没有"要求模型回应"的措辞（#1634 的直接触发条件）────────
console.log("\n" + "═".repeat(94));
console.log("② ★★★ 我们的注入文本里**有没有「要求模型回应」的措辞**");
console.log("═".repeat(94));
// ★★★ 尺子修正（第一版**错了**，记下来）：注入 = **插件自己写的那段** + **被追加的整份台账**。
//   而台账正文里本来就有"请"字（例如"请用一行写一条 L1"）⇒ 在**整段**上匹配判据，
//   判据会**永远为真** —— 这正是本项目「尺子错」第 2 条的形态
//   （*判据的输入必须是「被测系统自己产生的那部分」*）。
//   ⇒ 只取**头部 300 字**（插件的包装区），并在结论里如实标注这个限制。
const HEAD_CHARS = 300;
const ASK = /请(在|你)|告诉用户|转告用户|务必|必须.{0,6}(回复|回答)|你这次的回复/;
const ours = evs.filter((e) => e.type === "user/message" && e.data?.source?.kind === "project-ledger-notes");
let askCount = 0;
const askSamples = [];
let receiptCount = 0;
for (const e of ours) {
  const t = textOf(e.data);
  if (/^## 项目台账：本轮已被改动/.test(t.trim())) receiptCount += 1;
  if (ASK.test(t.slice(0, HEAD_CHARS))) {
    askCount += 1;
    if (askSamples.length < 6) askSamples.push(t.replace(/\s+/g, " ").slice(0, 150));
  }
}
console.log(`  我们的注入共 ${ours.length} 条：`);
console.log(`    · **回执类**（标题「本轮已被改动（请转告用户）」）＝ **${receiptCount}** 条（${((receiptCount / Math.max(1, ours.length)) * 100).toFixed(1)}%）`);
console.log(`    · 含「要求回应」措辞的 ＝ **${askCount}** 条（${((askCount / Math.max(1, ours.length)) * 100).toFixed(1)}%）`);
console.log(`  ★ 判据只吃**头部 ${HEAD_CHARS} 字**（插件自己的包装区）；
     若在**整段**上匹配，判据会被追加的台账正文污染（里面本来就有「请」）⇒ 恒为真。`);
for (const s of askSamples) console.log(`    · ${s}`);

// ── ③ 危险度量：注入里的"用户原话"是**我们复述的**，还是真原话？ ──────────
console.log("\n" + "═".repeat(94));
console.log("③ 注入里的原话片段 vs 真用户原话（看有没有把用户的话搬进注入）");
console.log("═".repeat(94));
const real = evs.filter((e) => e.type === "user/message" && e.data?.source?.kind === "user")
  .map((e) => textOf(e.data)).filter((t) => t.trim() !== "");
console.log(`  真用户原话 ${real.length} 条，总 ${real.reduce((s, t) => s + t.length, 0)} 字符`);
// 取最后 5 条真原话的前 12 字，看是否也出现在我们的注入里
let appear = 0;
for (const t of real.slice(-30)) {
  const probe = t.replace(/\s+/g, "").slice(0, 12);
  if (probe.length < 6) continue;
  if (ours.some((e) => textOf(e.data).includes(probe))) appear += 1;
}
console.log(`  最近 30 条真原话里，有 ${appear} 条的**前 12 字**也出现在我们的注入里`);
console.log(`  ⇒ ★ 若 >0，说明注入**确实携带了用户原话**（这是胶囊的设计意图，但也意味着`);
console.log(`     "注入"与"用户原话"在角色层无法区分 —— 正是 #1634 的载体风险）。`);

// ── ④ 有没有"模型回答注入而不回答用户"的迹象 ──────────────────────────────
console.log("\n" + "═".repeat(94));
console.log("④ ★ 迹象：assistant 回合的第一句是不是在**回应台账回执**（而非用户）");
console.log("═".repeat(94));
const RECEIPT = /本轮台账被改动|台账被改动|已记入台账|per the ledger|台账回执/;
let asstWithReceiptFirst = 0, asstTotal = 0;
for (let i = 0; i < evs.length; i += 1) {
  const e = evs[i];
  if (e.type !== "assistant/message") continue;
  const t = textOf(e.data);
  if (t.trim() === "") continue;
  asstTotal += 1;
  if (RECEIPT.test(t.slice(0, 220))) asstWithReceiptFirst += 1;
}
console.log(`  assistant 文本回合 ${asstTotal} 个；其中**前 220 字里就提台账回执**的 ${asstWithReceiptFirst} 个`);
console.log(`  ⇒ 这个数**高不一定坏**（我们**故意**要求它转告），但它同时说明：`);
console.log(`     注入确实被模型当成"一条要回应的 user 消息"处理了 —— 与 #1634 同机制，只是我们**有意为之**。`);

// ── ⑤ 关键区分：注入有没有"上下文框定"（声明自己不是用户指令）────────────
console.log("\n" + "═".repeat(94));
console.log("⑤ ★★★ 注入有没有**自我框定**（「这是上下文，不是用户当前指令」）");
console.log("═".repeat(94));
const FRAME = /not user|不是用户|do not override|不覆盖|属于本工作目录|belongs to THIS conversation|Use them as guidance/;
let framed = 0;
for (const e of ours) if (FRAME.test(textOf(e.data))) framed += 1;
console.log(`  带框定的注入 **${framed} / ${ours.length}**（${((framed / Math.max(1, ours.length)) * 100).toFixed(1)}%）`);
console.log(`  ★ 我们的通用注入头确实有："…belong to THIS conversation's working directory … do not override …"`);
console.log(`  ★ 但**回执类注入**（「请转告用户」）是**指令**，没有框定 —— 那正是 role:"user" 最危险的一种。`);
