/**
 * ★★★ 只读核实：**重启之后，新代码（`ledger_recall`）到底有没有在活内核里生效？**
 *
 * 判据（本机既有先例 `_probe-live-version.mjs`）：
 *   ① **结构性**：活内核发给模型的 `request/header.data.header.tools` 里**有没有 `ledger_recall`**。
 *      —— 这是最硬的判据：工具表就是内核**实际装配出来的**，不是文件里写了就算。
 *   ② **文本性**：注入里有没有出现新的「被压掉的历史」小节。
 *
 * ★ 为什么必须实测：用户说"已经重启了"，但**"重启了" ≠ "加载的是我改的那一版"**
 *   （本机铁律第二条：验证某东西能否工作，必须真让它工作）。
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

const ROOT = path.join(os.homedir(), ".dsh", "sessions");
const found = [];
const walk = (dir, depth) => {
  if (depth > 3) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === "session.v4.jsonl.zstd") {
      try { found.push({ p, mtime: fs.statSync(p).mtimeMs, size: fs.statSync(p).size }); } catch {}
    }
  }
};
walk(ROOT, 0);
found.sort((a, b) => b.mtime - a.mtime);
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);

console.log("═".repeat(84));
console.log("① 最近改动的会话日志（前 6 个）—— 找「重启之后那一个」");
console.log("═".repeat(84));
for (const f of found.slice(0, 6)) {
  console.log(`  ${hm(f.mtime)}  ${(f.size / 1024).toFixed(0).padStart(7)} KB  ${f.p.replace(ROOT, "…")}`);
}
if (found.length === 0) { console.log("  ★ 没找到任何会话日志 ⇒ 无法判定"); process.exit(0); }

const newest = found[0];
console.log(`\n  最新 = ${newest.p}`);
console.log(`  改动时间 = ${hm(newest.mtime)}`);

let evs = [];
try {
  for (const line of decodeAll(fs.readFileSync(newest.p)).split("\n")) {
    if (line === "") continue;
    try { evs.push(JSON.parse(line)); } catch {}
  }
} catch (e) {
  console.log(`  ✗ 解不开：${e.message}`);
}
console.log(`  事件数 = ${evs.length}`);

console.log("\n" + "═".repeat(84));
console.log("② ★★★ 硬判据：活内核发出的工具表里，有没有 `ledger_recall`？");
console.log("═".repeat(84));
const hdrs = evs.filter((e) => e.type === "request/header");
console.log(`  request/header 事件 = ${hdrs.length}`);
if (hdrs.length === 0) {
  console.log("  ★ 这个会话日志里没有 header ⇒ 换下一个候选（可能日志刚建、还没发过请求）");
}
const h = hdrs[hdrs.length - 1];
const tools = h?.data?.header?.tools ?? [];
const names = tools.map((t) => t.name);
console.log(`  最后一次 header：${names.length} 个工具（${hm(h?.time ?? 0)}）`);
const ledgerTools = names.filter((n) => /^ledger_/.test(n)).sort();
console.log(`  其中 ledger_* = ${ledgerTools.length} 个：`);
for (const n of ledgerTools) console.log(`    · ${n}`);
const HAS = names.includes("ledger_recall");
console.log(`\n  ⇒ ★ ${HAS
  ? "**ledger_recall 在活内核的工具表里** ⇒ 新代码**已生效**"
  : "**工具表里没有 ledger_recall** ⇒ 新代码**尚未生效**（要么没重启到，要么加载失败）"}`);

console.log("\n" + "═".repeat(84));
console.log("③ 次判据：注入里有没有出现新的「被压掉的历史」小节");
console.log("═".repeat(84));
const inj = evs.filter((e) => e.type === "user/message")
  .map((e) => {
    const c = e.data?.content;
    return Array.isArray(c) ? c.map((b) => b.text ?? "").join("") : String(c ?? "");
  });
const hitInject = inj.filter((t) => t.includes("被压掉的历史") || t.includes("ledger_recall"));
console.log(`  user/message 注入 ${inj.length} 条；含新小节的 = ${hitInject.length}`);
if (hitInject.length > 0) {
  const t = hitInject[hitInject.length - 1];
  const i = t.indexOf("被压掉的历史");
  console.log(`  最近一条的相关片段：`);
  console.log("  " + "-".repeat(76));
  console.log(t.slice(Math.max(0, i - 100), i + 400).split("\n").map((l) => "  " + l).join("\n"));
  console.log("  " + "-".repeat(76));
} else {
  console.log("  ⇒ 还没有出现（可能：重启后尚未触发压缩 ⇒ 索引为空 ⇒ 不推行。**这是正常行为**，不是缺陷。）");
}

console.log("\n" + "═".repeat(84));
console.log("④ 旁证：压缩计数与最近用量");
console.log("═".repeat(84));
const ends = evs.filter((e) => e.type === "compaction/end");
console.log(`  本日志里 compaction/end = ${ends.length} 次`);
const withUsage = evs.filter((e) => e.type === "assistant/message" && e.data?.usage);
if (withUsage.length > 0) {
  const last = withUsage[withUsage.length - 1].data.usage;
  console.log(`  最近一次请求：totalTokens=${Number(last.totalTokens || 0).toLocaleString()} · ` +
    `cacheRead=${Number(last.cacheReadTokens || 0).toLocaleString()} · input=${Number(last.inputTokens || 0).toLocaleString()}`);
}
console.log("\n  ★ 对照：本插件自检报「注册 15 个工具」是**单元级**结论；");
console.log("     上面②才是**活内核级**证据。两者一致才算真生效。");
