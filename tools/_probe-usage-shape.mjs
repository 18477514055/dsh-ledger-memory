/**
 * 只读：`assistant/message.data.usage` 的**真实字段形状** + 一次真实的 input/cacheRead 走势。
 *
 * ★ 上一版在 `request/header` 找 usage ⇒ 0/82（尺子错）。
 *   已定位：usage 挂在 **`assistant/message`**（8707 条）与 `compaction/summary`（28 条）。
 * ★ 本探针只做一件事：**把字段名与量级打出来**，不做任何"省了多少"的推断。
 *
 * 跑法：node tools/_probe-usage-shape.mjs
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
for (const l of texts.join("").split("\n")) {
  if (l.trim() === "") continue;
  try { events.push(JSON.parse(l)); } catch {}
}

const msgs = events.filter((e) => e.type === "assistant/message" && e?.data?.usage);
console.log(`assistant/message 带 usage：${msgs.length} 条\n`);

// ── 1. 字段形状 ──
const first = msgs[0]?.data?.usage;
console.log("═══ 第一条 usage 原样 ═══");
console.log(JSON.stringify(first, null, 2));
console.log("");

const keys = new Set();
for (const m of msgs) for (const k of Object.keys(m.data.usage)) keys.add(k);
console.log(`出现过 ${keys.size} 个字段：${[...keys].join(" · ")}\n`);

// ── 2. 恒等式核验：totalTokens ≡ input + cacheRead + output ? ──
let ok = 0, bad = 0, badSample = null;
for (const m of msgs) {
  const u = m.data.usage;
  const n = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.output ?? 0);
  if (u.totalTokens === n) ok += 1;
  else { bad += 1; if (badSample === null) badSample = u; }
}
console.log(`═══ 恒等式 totalTokens = input + cacheRead + output ═══`);
console.log(`  成立 ${ok} · 不成立 ${bad}`);
if (badSample !== null) console.log(`  反例: ${JSON.stringify(badSample)}`);
console.log("");

// ── 3. 走势：取最后 40 条，看 input / cacheRead ──
const tail = msgs.slice(-40);
console.log("═══ 最后 40 条（turn / step / input / cacheRead / output / total / 命中率）═══");
console.log("  turn step      input   cacheRead    output     total    命中%");
for (const m of tail) {
  const u = m.data.usage;
  const inp = u.input ?? 0, cr = u.cacheRead ?? 0, out = u.output ?? 0, tot = u.totalTokens ?? 0;
  const rate = tot > 0 ? ((cr / (inp + cr)) * 100).toFixed(1) : "  -  ";
  console.log(
    `  ${String(m.data.turn ?? "?").padStart(4)} ${String(m.data.step ?? "?").padStart(4)} ${String(inp).padStart(10)} ${String(cr).padStart(11)} ${String(out).padStart(9)} ${String(tot).padStart(9)} ${String(rate).padStart(7)}`
  );
}
console.log("");

// ── 4. 总量 ──
let sumIn = 0, sumCr = 0, sumOut = 0, sumTot = 0;
for (const m of msgs) {
  const u = m.data.usage;
  sumIn += u.input ?? 0;
  sumCr += u.cacheRead ?? 0;
  sumOut += u.output ?? 0;
  sumTot += u.totalTokens ?? 0;
}
console.log("═══ 全会话累计 ═══");
console.log(`  input     ${sumIn.toLocaleString("en-US")}`);
console.log(`  cacheRead ${sumCr.toLocaleString("en-US")}`);
console.log(`  output    ${sumOut.toLocaleString("en-US")}`);
console.log(`  total     ${sumTot.toLocaleString("en-US")}`);
console.log(`  命中率    ${((sumCr / (sumIn + sumCr)) * 100).toFixed(2)}%（cacheRead ÷ (input+cacheRead)）`);
