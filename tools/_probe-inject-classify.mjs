/**
 * 只读：**把 `project-ledger-notes` 拆成各类，再谈"每回合推几次台账正文"**。
 *
 * ★★ 上一版犯的两个错（都是"尺子错"，必须记）：
 *   ① **同类不同源混在一起数**（纪律 15）：`source.kind === "project-ledger-notes"` 这一个 kind
 *      底下其实混着**六种东西**——真台账正文、台账回执、回合末选择、收尾义务、水位通知、变更通知。
 *      它们字符量差两个数量级（2 万 vs 49），混在一起算"平均 17,140"毫无意义。
 *   ② **拿没有的字段去做除法**：我写"853 ÷ 153 turn = 每回合 5.6 条"——
 *      但 `user/message` 事件**根本没有 `turn` 字段**（实测全是 undefined）。
 *      那个 153 是从别处（turn/start 数）拿来的，**两个不同源的数不能这样除**。
 *
 * 本探针只做**分类**与**按类统计**，不报任何"能省 X%"。
 *
 * 跑法：node tools/_probe-inject-classify.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

const SESS_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");
function findNewest(root) {
  const cands = [];
  (function walk(d, depth) {
    if (depth > 4) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/\.jsonl\.zstd$/.test(e.name)) cands.push({ p, m: fs.statSync(p).mtimeMs });
      }
    } catch {}
  })(root, 0);
  cands.sort((a, b) => b.m - a.m);
  return cands[0]?.p;
}
const FILE = process.env.DSH_SESSION_FILE ?? findNewest(SESS_ROOT);
if (FILE === undefined) { console.log("SKIP"); process.exit(0); }

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const raw = fs.readFileSync(FILE);
const cand = [0];
for (let i = 1; ; ) {
  const p = raw.indexOf(MAGIC, i);
  if (p < 0) break;
  cand.push(p);
  i = p + 4;
}
const texts = [];
for (let k = 0; k < cand.length; k += 1) {
  let out;
  try {
    out = zlib.zstdDecompressSync(raw.subarray(cand[k], k + 1 < cand.length ? cand[k + 1] : raw.length));
  } catch { continue; }
  const s = out.toString("utf8");
  const first = s.split("\n").find((l) => l.trim() !== "");
  if (first === undefined) continue;
  try { JSON.parse(first); } catch { continue; }
  texts.push(s);
}
const events = [];
for (const s of texts) {
  for (const l of s.split("\n")) {
    if (l.trim() === "") continue;
    try { events.push(JSON.parse(l)); } catch {}
  }
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c === "string" ? c : c?.type === "text" ? (c.text ?? "") : "")).join("");
}

const users = [];
for (const e of events) {
  if (e.type !== "user/message") continue;
  if (e?.data?.source?.kind !== "project-ledger-notes") continue;
  users.push({ seq: e.seq, chars: 0, text: contentText(e?.data?.content) });
}
for (const u of users) u.chars = u.text.length;

// ── 按**正文特征**分类（不用 kind，因为 kind 只有一个值）──
const signed = (s) => (s.includes("`LEDGER.md`") && s.includes("<<<LEDGER") ? "台账正文" : "");
function classify(t) {
  const head = t.slice(0, 400);
  if (head.includes("<<<LEDGER-BLOCKS") || head.includes("<<<LEDGER")) return "A·台账正文（块级/全文）";
  const s = signed(head);
  if (s) return "A·台账正文";
  if (head.includes("台账回执") || head.includes("本轮台账被改动")) return "B·台账回执";
  if (head.includes("回合末选择")) return "C·回合末选择";
  if (head.includes("本回合收尾义务")) return "D·收尾义务提醒";
  if (/上下文水位已到/.test(head)) return "E·水位通知";
  if (head.includes("本轮台账的变化")) return "F·变更通知";
  if (head.includes("The following project-ledger facts")) return "A·台账正文（旧版题头）";
  return "G·其他";
}

const groups = new Map();
for (const u of users) {
  const k = classify(u.text);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(u);
}

console.log(`project-ledger-notes 共 ${users.length} 条\n`);
console.log("═══ 按正文特征分类 ═══");
console.log("  类别                        条数    总字符      均字符    最大");
for (const [k, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const sum = list.reduce((a, b) => a + b.chars, 0);
  const max = Math.max(...list.map((x) => x.chars));
  console.log(`  ${k.padEnd(26)} ${String(list.length).padStart(5)} ${String(sum).padStart(10)} ${String(Math.round(sum / list.length)).padStart(9)} ${String(max).padStart(8)}`);
}
console.log("");

// ── 只对「台账正文」这一类做后续统计 ──
const bodyKeys = [...groups.keys()].filter((k) => k.startsWith("A·"));
const body = bodyKeys.flatMap((k) => groups.get(k) ?? []);
body.sort((a, b) => a.seq - b.seq);
console.log(`═══ 台账正文：${body.length} 条 · 合计 ${body.reduce((a, b) => a + b.chars, 0).toLocaleString("en-US")} 字符 ═══`);
console.log(`  seq ${body[0]?.seq} … ${body[body.length - 1]?.seq}`);
console.log(`  均 ${Math.round(body.reduce((a, b) => a + b.chars, 0) / body.length).toLocaleString("en-US")} 字符\n`);

// ── 用 turn/start 数出真实回合数（并说明这是不同源，不能直接除）──
const turnStarts = events.filter((e) => e.type === "turn/start").length;
console.log("═══ 分母（说明用）═══");
console.log(`  turn/start 事件数：${turnStarts}  ← 这是"回合数"的唯一可用来源`);
console.log(`  user/message 带 turn 字段的：${events.filter((e) => e.type === "user/message" && e.data?.turn !== undefined).length} 条`);
console.log(`  ⇒ ★ 台账正文 ${body.length} 条 ÷ ${turnStarts} 回合 = ${(body.length / turnStarts).toFixed(2)} 次/回合`);
console.log(`     ★ 这仍然是**粗算**（回合数与会话分段不完全对齐），只能看量级，不能当精确值。`);
console.log("");

// ── 按「相邻两次正文是否相同」判断有没有白推 ──
const crypto = await import("node:crypto");
const h = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
let same = 0;
const diffs = [];
for (let i = 1; i < body.length; i += 1) {
  if (h(body[i].text) === h(body[i - 1].text)) { same += 1; continue; }
  let p = 0;
  const minLen = Math.min(body[i].text.length, body[i - 1].text.length);
  while (p < minLen && body[i].text[p] === body[i - 1].text[p]) p += 1;
  diffs.push({ from: body[i - 1].seq, to: body[i].seq, at: p, ratio: p / body[i - 1].text.length, a: body[i - 1].chars, b: body[i].chars });
}
console.log("═══ 相邻两次台账正文：内容改在前多少比例处 ═══");
console.log(`  完全相同：${same} 对 / ${body.length - 1}`);
console.log(`  有变化：${diffs.length} 对`);
const buckets = new Map();
for (const d of diffs) {
  const b = d.ratio >= 0.9 ? "改在 90% 之后（只动了尾部）" : d.ratio >= 0.5 ? "改在 50~90%" : d.ratio >= 0.2 ? "改在 20~50%" : "改在 20% 之前（动到开头）";
  buckets.set(b, (buckets.get(b) ?? 0) + 1);
}
for (const [k, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)} 对 · ${k}`);
}
console.log("");
console.log("  ★ 判据：改得越靠后 ⇒ 前面对模型越没用变化，但**整份仍要重推一遍**；");
console.log("    改在开头 ⇒ 前面的内容每次都不同（那是真变化，不能省）。");
