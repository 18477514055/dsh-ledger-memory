/**
 * ★★★★★ 只读核实（D184）：**压缩之后，台账正文块到底注了没有？**
 *
 * 起因：本回合（一次 70% 全量压缩之后）的注入里，`<<<LEDGER-BLOCKS` 与
 *   `LEDGER-BLOCKS>>>` **之间是空的** —— 上面那行写着「该读的块连正文（0 块）」，
 *   也就是模型拿到的只有**目录**（标题 + 行数 + 哈希），**一个字正文都没有**。
 *
 * ★ 这与该功能**自己写的安全绳②**直接冲突（"压缩后不省 ⇒ 全部块按必注处理"），
 *   而用户的底线是「不要影响模型的准确性」⇒ 必须查清是活内核跑旧码，还是真缺陷。
 *
 * 三路判据（缺一不可，本项目纪律：**结论必须能被证伪**）：
 *   ① **语法判据**：把 `renderBlockInjection` 里那段 `isMust` 表达式**原样**求值，
 *      看 JS 到底怎么解析 —— 怀疑是 `||` 与 `?:` 的**优先级**把安全绳②反转了。
 *   ② **源码判据**：从磁盘 `lib/index.js` 里**抠出那几行原文**打印（不凭印象复述）。
 *   ③ ★★★ **行为判据（最硬）**：从**活会话日志**里把历次注入的
 *      `LEDGER-BLOCKS` 正文段抠出来量长度 —— 压缩前 vs 压缩后各是什么样。
 *      （★ 只看源码是"看起来会怎样"，日志才是"真的注了什么"。）
 *
 * 只读：不写盘、不改任何 state、不碰官方 sessions（**只解压读**，与本项目既有探针同规矩）。
 * 跑法：node tools/_probe-d184-precedence.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

// ═══════════════════════════════════════════════════════════════════════════
// ① 语法判据：那段表达式，JS 究竟怎么解析？
// ═══════════════════════════════════════════════════════════════════════════
bar("① 语法判据 —— `a === true || b === \"zero\" ? false : X` 怎么解析？");
{
  // ★ 原样抄自 lib/index.js 的 isMust 那几行（只把标识符换成具体值）。
  const evaluate = (afterCompaction, capped, score) =>
    afterCompaction === true ||
    capped === "zero"
      ? false
      : score >= 50;

  const rows = [
    ["压缩后 · 原则块 capped=principle score=95", true, "principle", 95],
    ["压缩后 · 元数据 capped=zero      score=0 ", true, "zero", 0],
    ["非压缩 · 原则块 capped=principle score=95", false, "principle", 95],
    ["非压缩 · 元数据 capped=zero      score=0 ", false, "zero", 0],
    ["非压缩 · 普通块 capped=fusion   score=20", false, "fusion", 20],
  ];
  console.log("  afterCompaction / capped        / score ⇒ isMust（必注？）");
  for (const [label, ac, capped, score] of rows) {
    console.log(`  ${label} ⇒ ${evaluate(ac, capped, score)}`);
  }
  console.log(
    "\n  ★ 关键看第 1 行：**压缩后 + 高分块**本应「必注」，实际算出 **false** ⇒ 进目录。\n" +
      "  ★ 再对：`(A || B) ? false : C` —— `||` 优先级**高于** `?:`，\n" +
      "     所以 `A || B ? false : C` ≡ `(A || B) ? false : C`。\n" +
      "     而 `afterCompaction === true` 恒为真 ⇒ 整条恒取 `false` ⇒ **一块都不必注**。"
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ② 源码判据：把磁盘上那几行**原样**打出来
// ═══════════════════════════════════════════════════════════════════════════
bar("② 源码判据 —— 磁盘上 `renderBlockInjection` 里那几行原文");
const src = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
const all = src.split("\n");
const at = all.findIndex((l) => l.includes("const isMust ="));
if (at < 0) console.log("  ✗ 没找到 `const isMust =`");
else for (let i = at; i < at + 17 && i < all.length; i += 1) console.log(`  ${i + 1}| ${all[i]}`);

// ═══════════════════════════════════════════════════════════════════════════
// ③ 行为判据：活会话日志里，历次注入的台账正文段有多长？
// ═══════════════════════════════════════════════════════════════════════════
bar("③ 行为判据 —— 活会话日志里历次注入的 `LEDGER-BLOCKS` 正文段");

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const s = [];
  let i = buf.indexOf(MAGIC);
  while (i !== -1) {
    s.push(i);
    i = buf.indexOf(MAGIC, i + 4);
  }
  s.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < s.length; k += 1) {
    try {
      const d = zlib.zstdDecompressSync(buf.subarray(s[k], s[k + 1]));
      if (d.length) out.push(d);
    } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};

const SESS = path.join(os.homedir(), ".dsh", "sessions");
const cands = [];
const walk = (dir, depth) => {
  if (depth > 4) return;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === "session.v4.jsonl.zstd") {
      try {
        cands.push({ p, mtime: fs.statSync(p).mtimeMs });
      } catch {}
    }
  }
};
walk(SESS, 0);
cands.sort((a, b) => b.mtime - a.mtime);
const hm = (ms) =>
  new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);

let shown = 0;
for (const c of cands) {
  if (shown >= 2) break;
  let txt = "";
  try {
    txt = decodeAll(fs.readFileSync(c.p));
  } catch {
    continue;
  }
  if (!txt.includes("LEDGER-BLOCKS")) continue;
  // ★ 只看**本项目**那一场：注入里会带台账路径
  if (!txt.includes("10.项目台账") && !txt.includes("dsh-ledger-memory")) continue;

  const evs = [];
  for (const line of txt.split("\n")) {
    if (line === "") continue;
    try {
      evs.push(JSON.parse(line));
    } catch {}
  }
  const msgs = evs.filter((e) => e.type === "user/message");
  const inj = msgs.filter((e) => {
    const cc = e.data?.content;
    const t = Array.isArray(cc) ? cc.map((b) => b.text ?? "").join("") : String(cc ?? "");
    return t.includes("LEDGER-BLOCKS");
  });
  if (inj.length === 0) continue;

  console.log(`  会话日志：${c.p.replace(SESS, "…")}`);
  console.log(`  改动时间：${hm(c.mtime)} · 事件 ${evs.length} · 含块的注入 ${inj.length} 条\n`);
  console.log("    #  时间      正文段字符  必注数（注入自带）");
  let n = 0;
  for (const e of inj) {
    const cc = e.data?.content;
    const t = Array.isArray(cc) ? cc.map((b) => b.text ?? "").join("") : String(cc ?? "");
    const a = t.indexOf("<<<LEDGER-BLOCKS");
    const b = t.indexOf("LEDGER-BLOCKS>>>");
    if (a < 0 || b <= a) continue;
    const body = t.slice(a + "<<<LEDGER-BLOCKS".length, b).trim();
    const m = t.slice(Math.max(0, a - 400), a).match(/该读的块连正文\*\*（(\d+)\s*块/);
    n += 1;
    console.log(
      `   ${String(n).padStart(3)}  ${hm(e.time ?? 0)}  ${String(body.length).padStart(9)}  ${m ? m[1] : "?"}`
    );
  }
  shown += 1;
}
if (shown === 0) console.log("  ★ 没找到含 LEDGER-BLOCKS 的注入 ⇒ 无法判定（**不许当结论**）。");
