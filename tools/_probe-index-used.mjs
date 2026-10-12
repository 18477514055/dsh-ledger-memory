/**
 * ★★ 只读：量一件事 —— **索引推行了，模型到底有没有去查？**
 *
 * ★ 为什么必须先量：阶段 1 剩下的最后一件是"把查索引做成**硬前置**"（照抄 `flushBeforeCompact`）。
 *   但**硬闸门有前科**：D59 那次 `triageOwedAt` 没清 ⇒ 闸门连续拦了**近 4 小时**、**零次压缩**。
 *   ⇒ 再加一道硬闸门之前，必须先知道"**这个需求真实存在吗**"。
 *   ★ 判据（台账里早就写死的）：P3 = `ledger_recall` 调用数 ÷ 上线后压缩数。
 *     **样本不足时不许下结论** —— 这条纪律就写在同一份台账里。
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
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);

// ── ① 数 tool/call 里的名字分布（ledger_* 各被调了多少次）───────────────
const calls = evs.filter((e) => e.type === "tool/call");
const byName = new Map();
for (const c of calls) {
  const n = String(c.data?.name ?? "?");
  byName.set(n, (byName.get(n) ?? 0) + 1);
}
console.log("═".repeat(94));
console.log("① `ledger_*` 工具各被调了多少次（全会话）");
console.log("═".repeat(94));
const ledgerCalls = [...byName.entries()].filter(([n]) => n.startsWith("ledger_")).sort((a, b) => b[1] - a[1]);
for (const [n, k] of ledgerCalls) console.log(`  ${String(k).padStart(5)}  ${n}`);
console.log(`  ── 非 ledger 工具共 ${calls.length - ledgerCalls.reduce((s, [, k]) => s + k, 0)} 次调用`);

// ── ② P3 判据：recall 调用数 ÷ 压缩数 ─────────────────────────────────
const compactions = evs.filter((e) => e.type === "compaction/summary").length;
const recalls = byName.get("ledger_recall") ?? 0;
console.log("\n" + "═".repeat(94));
console.log("② ★★ P3 = `ledger_recall` 调用数 ÷ 压缩数（台账里早写死的判据）");
console.log("═".repeat(94));
console.log(`  压缩（compaction/summary） = **${compactions}** 次`);
console.log(`  ledger_recall 调用        = **${recalls}** 次`);
console.log(`  ⇒ P3 = ${recalls} / ${compactions} = **${(recalls / Math.max(1, compactions)).toFixed(3)}**`);

// ── ③ 索引推行了几次（每条注入都算一次推行）───────────────────────────
let pushed = 0;
for (const e of evs) {
  if (e.type !== "user/message") continue;
  if (e.data?.source?.kind !== "project-ledger-notes") continue;
  const c = e.data?.content;
  const t = Array.isArray(c) ? c.map((x) => x?.text ?? "").join("") : String(c ?? "");
  if (t.includes("被压掉的历史")) pushed += 1;
}
console.log("\n" + "═".repeat(94));
console.log("③ 索引被**推行**了多少次（含索引的那几段注入）");
console.log("═".repeat(94));
console.log(`  带「被压掉的历史」那一段的注入 = **${pushed}** 次`);

// ── ④ 结论口径（不许替读者下结论）─────────────────────────────────────
console.log("\n" + "═".repeat(94));
console.log("④ 读法（★ 按台账里那条纪律：样本不足时不许下结论）");
console.log("═".repeat(94));
console.log(`  · 索引被推行 **${pushed}** 次，而模型去查了 **${recalls}** 次。`);
if (compactions < 5) {
  console.log(`  · ⚠️ 但**压缩只有 ${compactions} 次** ⇒ 按"样本不足不许下结论"那条，**现在不能判定**`);
  console.log("    「P3 高低」。");
  console.log(`  · ★ 能说的只有：至今 **${recalls}** 次查询 / **${pushed}** 次推行 ⇒ 实际使用率很低。`);
} else {
  console.log(`  · 压缩 ${compactions} 次 ⇒ 样本够了，可以看 P3 = ${(recalls / compactions).toFixed(3)}。`);
}
console.log("");
console.log("  ★★ 对「要不要加硬闸门」的含义：");
console.log("     · 若使用率**高** ⇒ 索引本来就被用，加闸门纯属多余（且会挡住压缩）。");
console.log("     · 若使用率**低** ⇒ 说明「推了但没人用」，但**加闸门能不能治**是另一回事 ——");
console.log("       D59 的教训是：**硬闸门一旦判据写错，代价是「压缩彻底不发生」**。");
