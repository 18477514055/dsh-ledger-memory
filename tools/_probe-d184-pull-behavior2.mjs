/**
 * ★★★★★ 只读实测（D184 · 修正版）：**压缩后不给正文，模型到底去不去读台账文件？**
 *
 * ★ 为什么要出修正版（**尺子错，我自己抓的**）：
 *   第一版把"任何事件 JSON 里出现 `LEDGER.md` 或 `ledger_read`"都算成"去读了"——
 *   而 **assistant 的正文里提到这两个词**同样命中 ⇒ 系数虚高
 *   （实测 8 条注入"全部命中"，那是**不可能**的：模型不可能每次都去读）。
 *   ★ 这正是本项目**纪律 2**：判据的输入必须是**被测对象自己产生的那部分**。
 *   ⇒ 修正为：**只认 `tool/call` 事件**，且 `data.name` 是真实工具名 `read` / `ledger_read`，
 *     并且那次调用的 `arguments` 里**真的指向台账类文件**。
 *
 * ★ 先验尺子（纪律：先证明尺子对）：脚本先打印**每一个真实 tool/call 的工具名分布**，
 *   确认 `read` / `ledger_read` 确实以这个形态出现 —— 不然"0 命中"根本不能解释成"没读"。
 *
 * 只读。跑法：node tools/_probe-d184-pull-behavior2.mjs
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

// ── 尺子先验①：tool/call 的真实形状 ──
bar("① 尺子先验 —— `tool/call` 的真实形状（取一条原样打印）");
const anyCall = evs.find((e) => e.type === "tool/call");
console.log(JSON.stringify(anyCall, null, 2).slice(0, 900));

// ── 尺子先验②：真实工具名分布（确认 read / ledger_read 以什么名字出现）──
bar("② 尺子先验 —— 全会话 `tool/call` 的工具名分布（前 20）");
const nameCount = new Map();
for (const e of evs) {
  if (e.type !== "tool/call") continue;
  const n = e.data?.name ?? e.data?.toolName ?? e.data?.call?.name ?? "(无 name 字段)";
  nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
}
for (const [n, c] of [...nameCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(c).padStart(5)}  ${n}`);
}
console.log(`  ⇒ 共 ${nameCount.size} 种工具名，${[...nameCount.values()].reduce((a, b) => a + b, 0)} 次调用`);

/** 取一次 tool/call 的"工具名"（多字段兜底，但**不猜**：都没有就如实报未知）。 */
const toolNameOf = (e) => e.data?.name ?? e.data?.toolName ?? e.data?.call?.name;
/** 取该次调用的参数文本（用来判"读的是不是台账类文件"）。 */
const argsOf = (e) => JSON.stringify(e.data?.arguments ?? e.data?.input ?? e.data?.call?.arguments ?? "");

const isLedgerRead = (e) => {
  if (e.type !== "tool/call") return false;
  const n = toolNameOf(e);
  const a = argsOf(e);
  if (n === "ledger_read") return true;                       // 专用工具：必是读台账
  if (n !== "read") return false;                             // 其余工具一律不算
  return /LEDGER\.md|DECISIONS\.md|JOURNAL\.md|GOALS\.md|PRINCIPLES\.md/.test(a);
};

bar("③ 逐条注入：之后 200 事件内，**真实**读台账的次数");
const inj = evs
  .map((e, i) => ({ e, i }))
  .filter(({ e }) => e.type === "user/message" && textOf(e).includes("belong to THIS conversation"));

let post0 = 0, post0Read = 0, other = 0, otherRead = 0;
const rows = [];
for (const { e, i } of inj) {
  const t = textOf(e);
  const hasBlocks = t.includes("LEDGER-BLOCKS");
  const m = t.match(/该读的块连正文\*\*（(\d+)\s*块/);
  const mustN = m ? Number(m[1]) : undefined;
  const win = evs.slice(i + 1, i + 201);
  const hits = win
    .map((w, k) => ({ w, k }))
    .filter(({ w }) => isLedgerRead(w));
  const kind = !hasBlocks ? "整份" : mustN === 0 ? "★压缩后 0 块" : `区块 ${mustN} 块`;
  const isPost = hasBlocks && mustN === 0;
  if (isPost) { post0 += 1; if (hits.length) post0Read += 1; }
  else { other += 1; if (hits.length) otherRead += 1; }
  rows.push({ t: hm(e.time ?? 0), kind, n: hits.length, first: hits[0]?.k, isPost });
}
for (const r of rows) {
  console.log(`  ${r.t}  ${r.kind.padEnd(14)} 真实读台账 ${String(r.n).padStart(2)} 次` +
    (r.n ? ` · 首次在 +${r.first} 事件` : ""));
}

bar("④ ★★★ 汇总 —— pull 到底灵不灵");
console.log(`  压缩后「0 块」注入：${post0} 条 ⇒ 其中之后**真去读了台账**的 ${post0Read} 条`);
console.log(`  其余注入（有正文）：${other} 条 ⇒ 其中同样窗口内真去读了台账的 ${otherRead} 条`);
console.log(
  "\n  ★ 两条都要看：\n" +
    "   · 「0 块」那几条若 **不去读** ⇒ 模型手里**没有当前状态**却在干活 ⇒ 最危险（凭印象推进）；\n" +
    "   · 「有正文」那几条若**读了** ⇒ 说明正文没喂够，或有别的理由要重读（也要看清是什么）。"
);
