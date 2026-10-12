/**
 * ★★★ 只读：查清「设了 0.75，为什么全量自动到 78.4% 才触发」。
 *
 * 用户第 2 点原话（逐字）：
 *   *"我在设置面板中实际设置的是0.75自动执行一次全量压缩，但是全量压缩从来没有自动进行过，
 *     刚才甚至已经到了78%，79的样子，已经接近危险边缘了，全量压缩还是没有发生，说明这个自动化也有bug。"*
 *
 * ★ 前半句已被证伪（19:27:38 真跑了，压掉 68.3 点）。
 * ★ 后半句（"到 78、79 还没压"）**是对的** —— 本探针查的就是它**为什么**。
 *
 * 两个候选病因，本探针要分开它们：
 *   病因 A：**排队判据挂在 `text !== undefined` 上**（lib/index.js L10907-10913）
 *           ⇒ 只有"那一步恰好有东西要注入"（台账指纹变了 / 有水位提醒）才会排队。
 *           若中间那些步没有注入 ⇒ 水位一路涨到"下一次恰好有注入"才排。
 *   病因 B：**增量让路**（L9937-9957）把该排的全量挡掉，而增量自己又没跑成。
 *
 * 判据（只吃"被测系统自己产生的那部分"）：
 *   · 注入落成 `user/message`（台账原文：'⚠ 本插件注入落成 `user/message`'）
 *   · 水位取 `assistant/message.data.usage.totalTokens`
 *   ⇒ 把两者按时间并列，看"水位已 ≥75% 但没有注入"的步有多少。
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
const WIN = 1000000;

const T0 = Date.parse("2026-10-11T19:24:00+08:00");
const T1 = Date.parse("2026-10-11T19:31:00+08:00");

console.log("═".repeat(96));
console.log("① 19:24~19:31 的「水位」与「注入」并列（注入 = 本插件落成的 user/message）");
console.log("═".repeat(96));

// 注入 = 本插件写的 user/message。判据：文本里含本插件的标记词。
const INJ = /本插件|项目台账|上下文水位|逐字胶囊|被压掉|ledger_/;
const rows = [];
for (const e of evs) {
  if (e.time < T0 || e.time > T1) continue;
  if (e.type === "assistant/message" && e.data?.usage) {
    rows.push({ at: e.time, kind: "assistant", pct: Number(e.data.usage.totalTokens || 0) / WIN * 100 });
  } else if (e.type === "user/message") {
    const txt = JSON.stringify(e.data ?? {}).slice(0, 4000);
    if (INJ.test(txt)) rows.push({ at: e.time, kind: "注入", pct: undefined });
  } else if (e.type === "compaction/start" || e.type === "compaction/end") {
    rows.push({ at: e.time, kind: e.type.split("/")[1], pct: undefined });
  }
}
rows.sort((a, b) => a.at - b.at);

let lastPct = NaN;
for (const r of rows) {
  if (r.kind === "assistant") { lastPct = r.pct; continue; }
  const tag = r.kind === "注入" ? "★ 注入" : `  ${r.kind}`;
  console.log(`  ${hm(r.at)}  ${tag.padEnd(8)}  （当时水位 ≈ ${Number.isFinite(lastPct) ? lastPct.toFixed(1) + "%" : "?"}）`);
}

// ── 关键计数：水位 ≥75% 的 assistant 步里，有多少步**没有**紧随其后的注入 ──
console.log("\n" + "═".repeat(96));
console.log("② ★★★ 判据：水位 ≥75% 的那些步里，有多少步**根本没有注入**（= 不会排队）");
console.log("═".repeat(96));
const assists = rows.filter((r) => r.kind === "assistant");
const injs = rows.filter((r) => r.kind === "注入");
let over75 = 0, over75WithInj = 0;
const over75List = [];
for (const a of assists) {
  if (a.pct < 75) continue;
  over75 += 1;
  // 找在这个 assistant 消息之后、下一个 assistant 消息之前的那次注入
  const next = assists.find((x) => x.at > a.at);
  const has = injs.some((x) => x.at > a.at && (next === undefined || x.at < next.at));
  if (has) over75WithInj += 1;
  over75List.push(`${hm(a.at)} ${a.pct.toFixed(1)}% ${has ? "有注入" : "☠ 无注入"}`);
}
console.log(`  水位 ≥75% 的 assistant 步：**${over75}** 步`);
console.log(`  其中「下一步有注入」的：**${over75WithInj}** 步  ⇒ 能排队的只有这些`);
console.log(`  ⇒ ★ 若 over75WithInj < over75，则 **病因 A 成立**（排队被"是否有注入"挡住了）`);
console.log("");
for (const l of over75List) console.log(`    ${l}`);

console.log("\n" + "═".repeat(96));
console.log("③ 那次自动全量（19:27:38）到底排在哪一步上");
console.log("═".repeat(96));
const fire = Date.parse("2026-10-11T19:27:38+08:00");
const before = rows.filter((r) => r.at <= fire).slice(-6);
for (const r of before) console.log(`  ${hm(r.at)}  ${r.kind}  ${r.pct === undefined ? "" : r.pct.toFixed(1) + "%"}`);
console.log(`  ⇒ 19:27:38 排上队。这之前的注入是：${injs.filter((x) => x.at < fire).slice(-3).map((x) => hm(x.at)).join(" / ") || "（无）"}`);

console.log("\n" + "═".repeat(96));
console.log("④ 病灶定位（代码）");
console.log("═".repeat(96));
console.log("  lib/index.js L10907-10913：");
console.log("      if (");
console.log("        text !== undefined &&          ← ★★★ 排队的前提是「这一步有东西要注入」");
console.log("        hfSettings.highFidelityCompact === true &&");
console.log("        hfSettings.autoCompact === true &&");
console.log("        deltaHandled !== true");
console.log("      ) {");
console.log("  ⇒ 它在 `else` 分支里：台账指纹没变 ⇒ `text` 保持 undefined ⇒ **整段跳过**。");
console.log("  ⇒ 而水位到线这件事**与台账有没有变毫无关系**。");
console.log("  ⇒ 后果：安全网要等到「下一次恰好有注入」才排 —— 期间水位继续涨。");
