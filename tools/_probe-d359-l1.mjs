// _probe-d359-l1.mjs —— 关键一问：L1 回合摘要（唯一"带时间戳的工作流水"）有没有进过重注？
//
// ★ 为什么要问：L1 是我们自己写的「做了什么 / 卡点 / 下一步」，**每条都带秒级时间戳**，
//   现成 375 条躺在磁盘上。但它在设置里被归为「永不注入」档。
//   ⇒ 如果它真的一次都没进过上下文，那用户说的「为每条工作加一个时间点」
//      **根本不需要新写任何东西** —— 数据已经在，只是没被推给模型。
import fs from "node:fs";
import zlib from "node:zlib";

const REAL =
  "C:\\Users\\24239\\.dsh\\sessions\\--D-Deepseek~5DE5~4F5C~533A-20-DSH~63D2~4EF6-04-~5176~4F59~63D2~4EF6-10.~9879~76EE~53F0~8D26--\\session-a5dd1f8f-8f7a-4590-9ede-34f72354dad8\\session.v4.jsonl.zstd";

function readAllEvents(file) {
  const buf = fs.readFileSync(file);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(s, e)).toString("utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* skip */ }
    }
  }
  return out;
}

const events = readAllEvents(REAL);

// ① 全库范围：`(L1) ` 这个标记在任何注入里出现过吗
const MARK = "(L1) ";
let inInject = 0, inAny = 0;
const where = [];
for (const ev of events) {
  if (ev.type !== "user/message") continue;
  const parts = Array.isArray(ev.data.content) ? ev.data.content : [];
  const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  if (!text.includes(MARK)) continue;
  inAny++;
  const kind = ev.data?.source?.kind;
  if (kind !== "user") inInject++;
  where.push({ seq: ev.seq, kind, len: text.length });
}
console.log(`含「(L1) 」字样的 user/message：${inAny} 条（其中非用户原话 = ${inInject}）`);
for (const w of where.slice(-8)) console.log(`  seq=${w.seq} kind=${w.kind} len=${w.len}`);

// ② 最近一次重注里有没有 L1 的痕迹
let last;
for (const ev of events) {
  if (ev.type !== "user/message") continue;
  if (ev.data?.source?.kind !== "project-ledger-notes") continue;
  const parts = Array.isArray(ev.data.content) ? ev.data.content : [];
  const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  if (!text.includes("先做一次「主动回想」")) continue;
  last = { seq: ev.seq, text };
}
console.log(`\n最近一次重注 seq=${last.seq}：`);
for (const n of ["(L1) ", "L1-turns", "回合摘要", "ledger_log_write"]) {
  console.log(`  「${n}」 ⇒ ${last.text.includes(n) ? "★ 出现" : "✗ 没有"}`);
}

// ③ 那重注里到底哪一节在说"刚做完了什么"？把「被压段索引」那节的头部原样打出来
const i1 = last.text.indexOf("### ★ 被压掉的历史");
if (i1 !== -1) {
  const i2 = last.text.indexOf("\n### ", i1 + 5);
  const seg = last.text.slice(i1, i2 === -1 ? i1 + 2500 : i2);
  console.log("\n== 被压段索引（原样前 1200 字符）==");
  console.log(seg.slice(0, 1200));
}
