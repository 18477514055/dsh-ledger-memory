/**
 * ★★★★★ 只读实测（D184）：**「压缩后不给正文」这个意外形态，模型到底去不去读文件？**
 *
 * 背景：`renderBlockInjection` 的 `isMust` 因 `||`/`?:` 优先级写反（见 `_probe-d184-precedence.mjs`），
 *   导致**每次压缩之后**的注入都是「必注 0 块」—— 模型手里只有目录，没有正文。
 *
 * ★★★ 这**恰好就是**"按需读取（pull）"那一派的极端形态。
 *   ⇒ 于是它成了一次**免费的自然实验**，而且正好回答用户本轮的问题：
 *     「不推正文、只给指针 ⇒ 模型会不会真的去读？」
 *
 * 判据（只数事实，不做解释）：
 *   对每一条**压缩后 0 块**的注入，看它**之后 120 个事件**里：
 *     ① 有没有 `ledger_read` 调用？② 有没有读 `LEDGER.md` / `DECISIONS.md`？③ 隔了多少步？
 *   对照组：**压缩前 11 块**的注入（那时正文已在手里 ⇒ 本就不需要去读）。
 *
 * ★ 这是本项目 D102 那个结论（`ledger_recall` 26 次压缩里被调用 **0** 次）的**同型复查**，
 *   但对象不同：D102 查的是"被压掉的历史"，这里查的是"**当前状态**"。
 *   ⚠️ 两者不可互相代替 —— 不许拿 D102 的 0 直接给这里下结论。
 *
 * 只读：不写盘、不改 state、只解压读官方 sessions（与既有探针同规矩）。
 * 跑法：node tools/_probe-d184-pull-behavior.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const s = [];
  let i = buf.indexOf(MAGIC);
  while (i !== -1) { s.push(i); i = buf.indexOf(MAGIC, i + 4); }
  s.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < s.length; k += 1) {
    try { const d = zlib.zstdDecompressSync(buf.subarray(s[k], s[k + 1])); if (d.length) out.push(d); } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

const P = path.join(
  os.homedir(), ".dsh", "sessions",
  "--D-Deepseek~5DE5~4F5C~533A-20-DSH~63D2~4EF6-04-~5176~4F59~63D2~4EF6-10.~9879~76EE~53F0~8D26--",
  "session-a5dd1f8f-8f7a-4590-9ede-34f72354dad8", "session.v4.jsonl.zstd"
);
const evs = [];
for (const line of decodeAll(fs.readFileSync(P)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
const textOf = (e) => {
  const c = e.data?.content;
  return Array.isArray(c) ? c.map((b) => b.text ?? "").join("") : String(c ?? "");
};

// ── 先看工具调用在日志里长什么样（尺子先验：先确认取法对）──
bar("① 尺子先验 —— 日志里「工具调用」是哪一种事件？");
const types = new Map();
for (const e of evs) types.set(e.type, (types.get(e.type) ?? 0) + 1);
for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(6)}  ${t}`);
}

const inj = evs
  .map((e, i) => ({ e, i }))
  .filter(({ e }) => e.type === "user/message" && textOf(e).includes("belong to THIS conversation"));

bar(`② 本会话含台账注入的 ${inj.length} 条 —— 分类 + 之后 120 事件里有没有"去读"`);
let nPost = 0;
let nPostRead = 0;
let nPre = 0;
let nPreRead = 0;
for (const { e, i } of inj.slice(-8)) {
  const t = textOf(e);
  const hasBlocks = t.includes("LEDGER-BLOCKS");
  const m = t.match(/该读的块连正文\*\*（(\d+)\s*块/);
  const mustN = m ? Number(m[1]) : undefined;
  const kind = !hasBlocks ? "整份注入" : mustN === 0 ? "★区块注入 · 压缩后 0 块" : `区块注入 · ${mustN} 块`;
  const win = evs.slice(i + 1, i + 121);
  // 找"读台账/决策"的证据：任何事件里出现工具名或路径
  const readHits = [];
  for (const [k, w] of win.entries()) {
    const s = JSON.stringify(w);
    const isRead = /ledger_read|"name"\s*:\s*"read"/.test(s);
    const isLedgerFile = /LEDGER\.md|DECISIONS\.md|JOURNAL\.md/.test(s);
    if (isRead || isLedgerFile) {
      readHits.push({ step: k + 1, type: w.type, txt: s.slice(0, 150) });
    }
  }
  const post = hasBlocks && mustN === 0;
  if (post) { nPost += 1; if (readHits.length > 0) nPostRead += 1; }
  else if (hasBlocks) { nPre += 1; if (readHits.length > 0) nPreRead += 1; }
  console.log(`\n  ${hm(e.time ?? 0)}  ${kind}`);
  const toolCalls = win.filter((w) => /tool/.test(String(w.type)));
  console.log(`     之后 120 事件里：tool 类事件 ${toolCalls.length} 个 · 命中"读台账"线索 ${readHits.length} 条`);
  for (const h of readHits.slice(0, 3)) {
    console.log(`       step+${String(h.step).padStart(3)}  [${h.type}] ${h.txt.replace(/\s+/g, " ").slice(0, 120)}`);
  }
}

bar("③ 汇总（★ 这一格就是「pull 到底灵不灵」的实测答案）");
console.log(`  压缩后「0 块」的注入：${nPost} 条，其中之后 120 事件内**出现过**读台账线索的 ${nPostRead} 条`);
console.log(`  区块注入（有正文）  ：${nPre} 条，其中同样窗口内出现过读台账线索的 ${nPreRead} 条`);
console.log(
  "\n  ★ 读法：这一格只说明「**有没有去读**」，不说明「该不该推」。\n" +
    "     · 若 (nPostRead) 也很高 ⇒ 模型确实会按需去读，pull 有支撑；\n" +
    "     · 若 (nPostRead) = 0 而压缩后它照样在干活 ⇒ 那更要警惕：\n" +
    "       **它可能是在「没有当前状态」的情况下凭印象推进**（那正是记忆污染最危险的形态）。"
);
