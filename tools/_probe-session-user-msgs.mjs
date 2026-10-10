/**
 * 只读：把多帧 zstd 的官方会话日志解出来。
 *
 * ★ 踩到的两个坑（都记下来，免得下次再花时间）：
 *   ① `zstdDecompressSync(整个文件)` **只解第一帧** ⇒ 实测得到 0.0 MB、1 行；
 *   ② `createZstdDecompress()` 流式喂整块，也没解出内容（同样 0.0 MB，且不报错）。
 *   ⇒ 这种 `jsonl.zstd` 是**每次落盘追加一帧**拼起来的，必须**按帧切**。
 *      但魔数 `28 b5 2f fd` 会在压缩数据里**偶然出现**（本文件命中 7549 次，
 *      而帧间隔只有一两百字节 ⇒ 显然大量是巧合）。
 *      ⇒ 判据不能只看魔数：**每一段要真的能解开、且解出来是合法 JSON**，否则丢弃。
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

// ★ 会话文件路径：`DSH_SESSION_FILE` 可指定；否则取 sessions 下**最新**的那个。
const SESS_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");
const FILE = process.env.DSH_SESSION_FILE ?? (() => {
  const cands = [];
  (function walk(d, depth) {
    if (depth > 4) return;
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.jsonl\.zstd$/.test(e.name)) cands.push({ p, m: fs.statSync(p).mtimeMs });
    }
  })(SESS_ROOT, 0);
  cands.sort((a, b) => b.m - a.m);
  return cands[0]?.p;
})();
if (FILE === undefined) {
  console.log("  SKIP  本机没有会话文件（设 DSH_SESSION_FILE 指定一个）");
  process.exit(0);
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const raw = fs.readFileSync(FILE);
console.log(`文件 ${(raw.length / 1024 / 1024).toFixed(1)} MB`);

// 先收集所有魔数位置作为**候选**边界
const cand = [0];
for (let i = 1; ; ) {
  const p = raw.indexOf(MAGIC, i);
  if (p < 0) break;
  cand.push(p);
  i = p + 4;
}
console.log(`候选边界 ${cand.length} 个`);

// 逐段试解：能解出**合法 JSON 文本**的才算真帧
const texts = [];
let goodFrames = 0;
for (let k = 0; k < cand.length; k += 1) {
  const start = cand[k];
  const end = k + 1 < cand.length ? cand[k + 1] : raw.length;
  const slice = raw.subarray(start, end);
  let out;
  try {
    out = zlib.zstdDecompressSync(slice);
  } catch {
    continue; // 巧合的魔数 ⇒ 解不开，丢
  }
  const s = out.toString("utf8");
  // ★ 有效性判据：解出来必须是 JSONL（第一行以 { 开头且能 parse）
  const firstLine = s.split("\n").find((l) => l.trim() !== "");
  if (firstLine === undefined) continue;
  try {
    JSON.parse(firstLine);
  } catch {
    continue; // 解得出但不是 JSON ⇒ 也是巧合
  }
  goodFrames += 1;
  texts.push(s);
}
console.log(`真帧 ${goodFrames} 个，拼出 ${(texts.join("").length / 1024 / 1024).toFixed(2)} MB 文本`);

const text = texts.join("");
const lines = text.split("\n").filter((l) => l.trim() !== "");
console.log(`JSONL 行数 ${lines.length}\n`);

/** 判断一行是否 user/message 并取文本。 */
function userTextOf(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  const t = o?.type ?? o?.event?.type;
  const d = o?.data ?? o?.event?.data;
  const msg = d?.message ?? d;
  if (t !== "user/message" && msg?.role !== "user") return undefined;
  const parts = Array.isArray(msg?.content) ? msg.content : [];
  const txt = parts
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  if (txt === "") return undefined;
  return { txt, src: msg?.source?.kind, seq: o?.seq ?? o?.event?.seq, time: o?.time ?? o?.event?.time };
}

const all = [];
for (const l of lines) {
  const u = userTextOf(l);
  if (u !== undefined) all.push(u);
}
console.log(`user/message 事件 ${all.length} 条\n`);

const from = Number(process.argv[2] ?? 0);
const count = Number(process.argv[3] ?? 10);

// ★ `--json` ：输出结构化 JSON（便于按关键词筛、按序号定位，不靠人眼读大段文本）。
if (process.argv.includes("--json")) {
  const out = all.map((u, i) => ({ i, seq: u.seq, time: u.time, source: u.src, text: u.txt }));
  fs.writeFileSync(process.argv[process.argv.indexOf("--json") + 1], JSON.stringify(out, null, 1), "utf8");
  console.log(`已写出 ${out.length} 条 → ${process.argv[process.argv.indexOf("--json") + 1]}`);
  process.exit(0);
}
// ★ `--grep <词>` ：只列出命中的序号 + 前 200 字（快速定位"哪一条在讲什么"）。
const gi = process.argv.indexOf("--grep");
if (gi > 0) {
  const kw = process.argv[gi + 1];
  const hits = all
    .map((u, i) => ({ i, ...u }))
    .filter((u) => u.txt.includes(kw));
  console.log(`含「${kw}」的用户消息 ${hits.length} 条：\n`);
  for (const h of hits) {
    const when = typeof h.time === "number" ? new Date(h.time).toLocaleString("zh-CN") : "?";
    console.log(`#${h.i}  ${when}  len=${h.txt.length}`);
    console.log(`    ${h.txt.replace(/\n/g, " / ").slice(0, 220)}`);
  }
  process.exit(0);
}

for (const [i, u] of all.slice(from, from + count).entries()) {
  const when = typeof u.time === "number" ? new Date(u.time).toLocaleString("zh-CN") : "?";
  console.log(`${"═".repeat(72)}`);
  console.log(`#${from + i}  seq=${u.seq}  ${when}  source=${u.src ?? "?"}`);
  console.log(u.txt.length > 3000 ? `${u.txt.slice(0, 3000)}\n…（共 ${u.txt.length} 字）` : u.txt);
}
