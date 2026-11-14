/**
 * ★★★ 只读：把 `project-ledger-notes` 这 1944 万字符拆成六类。
 *
 * ★ 为什么必须拆：台账正文 / 变更通知 / 水位通知 / 收尾义务 / 台账回执 / 回合末选择
 *   这六类的**字符量差两个数量级**，混在一起算均值等于没算（纪律第 15/25 条）。
 *
 * ★ 分类靠正文特征，不靠关键词猜（先 dump 一条原样出来核对形状）。
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

const notes = evs.filter((e) => e.type === "user/message" && e.data?.source?.kind === "project-ledger-notes");
const textOf = (e) => Array.isArray(e.data?.content)
  ? e.data.content.reduce((a, c) => a + (typeof c?.text === "string" ? c.text : ""), "")
  : "";

// ── 先 dump 三条原样（形状对了再写聚合）
console.log("═══ ⓪ 先看形状：三条最短 / 中等 / 最长 的开头 200 字符 ═══");
const withLen = notes.map((e) => ({ e, t: textOf(e), n: textOf(e).length })).sort((a, b) => a.n - b.n);
for (const pick of [withLen[0], withLen[Math.floor(withLen.length / 2)], withLen[withLen.length - 1]]) {
  console.log(`\n  [${pick.n} 字符] ${fmt(pick.e.time)}`);
  console.log("  " + pick.t.slice(0, 220).replace(/\n/g, " ⏎ "));
}

// ── 分类规则（按开头特征，而不是"含某词"）
const classify = (t) => {
  if (t.includes("<<<LEDGER-BLOCKS")) return "台账正文（LEDGER-BLOCKS）";
  if (t.startsWith("## 变更登记") || t.includes("变更登记（插件自动维护）")) return "变更登记";
  if (/水位|上下文已用|已用\s*\d+%/.test(t.slice(0, 300))) return "水位通知";
  if (/收尾义务|ledger_triage|ledger_write.*台账/.test(t.slice(0, 400))) return "收尾义务";
  if (/回执|已写入|changedBy/.test(t.slice(0, 400))) return "台账回执";
  if (/checkpoint|四选一|要不要记录/.test(t.slice(0, 400))) return "回合末选择";
  if (t.includes("文件锚定") || t.includes("六维")) return "文件锚定段";
  return "其它/未归类";
};

console.log("\n\n═══ ① 六类拆分（project-ledger-notes，共 " + notes.length + " 条）═══");
const buckets = new Map();
for (const e of notes) {
  const t = textOf(e);
  const k = classify(t);
  if (!buckets.has(k)) buckets.set(k, { n: 0, chars: 0, max: 0, min: Infinity, samples: [] });
  const b = buckets.get(k);
  b.n += 1; b.chars += t.length; b.max = Math.max(b.max, t.length); b.min = Math.min(b.min, t.length);
  if (b.samples.length < 1) b.samples.push({ t: t.slice(0, 120).replace(/\n/g, " ⏎ "), time: e.time });
}
const arr = [...buckets.entries()].sort((a, b) => b[1].chars - a[1].chars);
const grand = arr.reduce((a, [, v]) => a + v.chars, 0);
console.log("类别                          条数     总字符      占比     均值    最大");
console.log("─".repeat(84));
for (const [k, v] of arr) {
  console.log(
    `${k.padEnd(26)} ${String(v.n).padStart(5)} ${String(v.chars).padStart(11)} ${(v.chars / grand * 100).toFixed(1).padStart(7)}% ${String(Math.round(v.chars / v.n)).padStart(7)} ${String(v.max).padStart(7)}`
  );
}
console.log(`合计 ${grand} 字符 ≈ ${Math.round(grand / 3.2)} tok`);

// ── 台账正文这一类的"每次注入多大"、"变化多少"
console.log("\n═══ ② 台账正文（LEDGER-BLOCKS）逐次尺寸与相邻差异 ═══");
const corpus = notes.filter((e) => textOf(e).includes("<<<LEDGER-BLOCKS")).map((e) => ({ time: e.time, t: textOf(e) }));
console.log(`  含 LEDGER-BLOCKS 的注入 = ${corpus.length} 条`);
if (corpus.length > 1) {
  const lens = corpus.map((c) => c.t.length);
  console.log(`  长度：min=${Math.min(...lens)} max=${Math.max(...lens)} 均值=${Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)}`);
  const last = corpus.slice(-10);
  console.log("  最近 10 次：长度 / 与上一次的字符差异（重叠比）");
  for (let i = 1; i < last.length; i += 1) {
    const a = last[i - 1].t, b = last[i].t;
    // 求最长公共前缀，量"开头有多少是一模一样的"
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
    // 粗略：按行集算 Jaccard
    const sa = new Set(a.split("\n").map((x) => x.trim()).filter(Boolean));
    const sb = new Set(b.split("\n").map((x) => x.trim()).filter(Boolean));
    let inter = 0; for (const x of sb) if (sa.has(x)) inter += 1;
    const jac = inter / (sa.size + sb.size - inter);
    console.log(`     ${fmt(last[i].time)}  ${String(b.length).padStart(6)} 字符 公共前缀=${String(p).padStart(5)} 行集合重合=${(jac * 100).toFixed(1)}%  新增行=${sb.size - inter} 消失行=${sa.size - inter}`);
  }
}

// ── ③ 失败签名：有 start、有 end、但没有 summary
console.log("\n═══ ③ 压缩失败签名（start + end 但无 summary）═══");
const starts = evs.filter((e) => e.type === "compaction/start");
const sums = new Set(evs.filter((e) => e.type === "compaction/summary").map((e) => e.data?.compactionId));
let failN = 0;
for (const s of starts) {
  const id = s.data?.compactionId;
  if (!sums.has(id)) {
    failN += 1;
    const end = evs.find((e) => e.type === "compaction/end" && e.data?.compactionId === id);
    console.log(`  ★ ${fmt(s.time)} id=${id} 有end=${!!end} turn=${JSON.stringify(s.data?.turn)}`);
  }
}
console.log(`  失败（无 summary）= ${failN} / ${starts.length} 次 start`);
