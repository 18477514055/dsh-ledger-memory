/**
 * ★★★ 只读：**决定性核对** —— 那些"逐字没命中"的原话，其**实质内容**漏了吗？
 *
 * 上一轮测得：191 条真原话，逐字命中载体仅 **24.1%**。
 * 但"逐字没命中" ≠ "实质漏了"（DECISIONS 可能用**别的措辞**记下同一件事）。
 *
 * ★ 本探针只查**最要命的几条**（用户的原始任务与早期需求），逐条给出：
 *   ① 原话逐字（从日志读）
 *   ② 它的**实质**在哪个载体里以什么措辞出现（人工可核）
 *   判据：**取该原话的 2~3 个特征词，看它们在载体里能不能同时出现**。
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
const ROOT = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const readAll = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const LEDGER = readAll(path.join(ROOT, "LEDGER.md"));
const DECISIONS = readAll(path.join(ROOT, "DECISIONS.md"));
const CAPS_DIR = path.join(ROOT, "_ledger-log", "2026-10", "week2", "capsules");
let CAPS = "";
try { for (const f of fs.readdirSync(CAPS_DIR)) CAPS += readAll(path.join(CAPS_DIR, f)) + "\n"; } catch {}
const L4 = readAll(path.join(ROOT, "_ledger-log", "2026-10", "week2", "L4-user-messages.md"));

const getText = (seq) => {
  const e = bySeq.get(seq);
  if (e?.type !== "user/message") return "";
  const cc = e.data?.content;
  return Array.isArray(cc) ? cc.filter((b) => b.type === "text").map((b) => b.text ?? "").join("") : "";
};

console.log("═".repeat(88));
console.log("① 最要命的核对：**用户的原始任务陈述**（seq 18）还在不在载体里？");
console.log("═".repeat(88));
const t18 = getText(18);
console.log(`  原话（${t18.length} 字符，前 300）：`);
console.log("  " + "-".repeat(80));
console.log(t18.slice(0, 300).split("\n").map((l) => "  " + l).join("\n"));
console.log("  " + "-".repeat(80));

const feats = ["新项目自动初始化", "记忆", "学习", "模型下限", "台账", "初始化"];
console.log("\n  特征词在各载体的命中情况：");
console.log("  特征词".padEnd(22) + "LEDGER".padEnd(10) + "DECISIONS".padEnd(12) + "胶囊".padEnd(8) + "L4");
console.log("  " + "-".repeat(60));
for (const f of feats) {
  const row = [LEDGER, DECISIONS, CAPS, L4].map((c) => (c.includes(f) ? "✔" : "·"));
  console.log(`  ${f.padEnd(20)}${row[0].padEnd(10)}${row[1].padEnd(12)}${row[2].padEnd(8)}${row[3]}`);
}
console.log("");
// 更精确：原话里的长片段（≥8 字符）有几个能在载体里找到
const frags = ["新项目自动初始化", "当 DSH 检测到当前工作", "模型下限", "摆脱上下文的约束", "记忆的重构"];
console.log("  原话里的**长片段**是否被载体保留：");
for (const fr of frags) {
  const where = [["LEDGER", LEDGER], ["DECISIONS", DECISIONS], ["胶囊", CAPS], ["L4", L4]]
    .filter(([, c]) => c.includes(fr)).map(([n]) => n);
  console.log(`    ${fr.padEnd(24)} ${where.length > 0 ? "✔ " + where.join("/") : "✗ **一个载体都没有**"}`);
}

console.log("\n" + "═".repeat(88));
console.log("② 逐条核对：未命中的原话里，**实质**有没有被别的措辞记下？（抽查 6 条）");
console.log("═".repeat(88));
const CASES = [
  { seq: 945, feats: ["四个选项", "不记录台账", "执行压缩"] },
  { seq: 2184, feats: ["日志", "粒度"] },
  { seq: 2942, feats: ["工具", "怎么用"] },
  { seq: 3204, feats: ["不是项目", "问题记录", "台账该记在哪"] },
  { seq: 3254, feats: ["根目录", "怎么写台账", "工作区"] },
];
for (const c of CASES) {
  const t = getText(c.seq);
  console.log(`\n  ── seq ${c.seq} ─────────────────────────────`);
  console.log(`  原话：${t.replace(/\s+/g, " ").slice(0, 90)}…`);
  for (const f of c.feats) {
    const where = [["LEDGER", LEDGER], ["DECISIONS", DECISIONS], ["胶囊", CAPS], ["L4", L4]]
      .filter(([, x]) => x.includes(f)).map(([n]) => n);
    console.log(`     特征词「${f}」` + (where.length > 0 ? ` ⇒ ✔ ${where.join("/")}` : ` ⇒ ✗ 未命中`));
  }
}

console.log("\n" + "═".repeat(88));
console.log("③ ★★★ 那「未命中」到底意味着什么？（两种可能必须分开）");
console.log("═".repeat(88));
console.log("  可能 A：**实质真的漏了** —— 载体里任何措辞都没记下这件事 ⇒ 严重缺陷");
console.log("  可能 B：**只是措辞不同** —— 载体用别的话记了同一件事 ⇒ 不是缺陷");
console.log("");
console.log("  ★ 本探针能给的**客观判据**（不靠语义判断）：");
let a = 0, b = 0;
for (const c of CASES) {
  const t = getText(c.seq);
  if (t === "") continue;
  const hitAny = c.feats.some((f) => [LEDGER, DECISIONS, CAPS, L4].some((x) => x.includes(f)));
  if (hitAny) b += 1; else a += 1;
}
console.log(`     抽查 ${CASES.length} 条：特征词**全未命中** = ${a} 条（倾向 A）· **至少一个命中** = ${b} 条（倾向 B）`);
console.log("");
console.log("  ⚠️⚠️ **必须诚实标注的边界**：这个判据**仍然是代理**，不是语义判断。");
console.log("     · 「特征词没命中」**不能**断言「实质漏了」 —— 特征词是我选的，可能选得不好；");
console.log("     · 要真正判定，必须**人来读**（或调一次 LLM 做语义核对）——**那不该由我这个判据冒充**。");
console.log("");
console.log("  ★ 但有一条**可以现在就下**的结论（不依赖语义）：");
const early = [18, 945, 2184];
let earlyInCarrier = 0;
for (const s of early) {
  const t = getText(s);
  const p = t.replace(/\s+/g, "").replace(/[「」“”"']/g, "").slice(0, 16);
  if (p.length >= 6 && (LEDGER + DECISIONS + CAPS + L4).replace(/\s+/g, "").includes(p)) earlyInCarrier += 1;
}
console.log(`     **早期原话的逐字留存率 = ${earlyInCarrier}/${early.length}**`);
console.log(`     ⇒ 与"全期 24.1%"对比：${earlyInCarrier / early.length < 0.241 ? "★ **早期更低** ⇒ 越早的东西越容易掉出载体（与 `CAPSULE_USER_MSG_MAX=40` 只留最近 40 条吻合）" : "早期并不更低"}`);
