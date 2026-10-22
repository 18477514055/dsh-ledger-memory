/**
 * ★★★ 反向验证（A 方案专用）：把「同一把尺子」故意打破，断言必须**看得见红**。
 *
 * ★ 为什么不复用 `_probe-recall-reverse.mjs`：那是 10-11 为情形 45 写的**会改写源码**的探针，
 *   职责完全不同。本探针**只读**，不碰任何文件。
 *
 * 判据（纪律 10）：反向验证必须摘到「能看见红」为止 ——
 *   摘一处不红，要么断言太弱、要么修复冗余，**两种都要查清**。
 *
 * 做法：造一个**抖动的 session** —— 同一个 seq 第二次被问时返回被裁过的正文。
 *   ⇒ 「索引报的 chars」与「真取到的 text.length」必然对不上。
 *   · 稳定 session ⇒ 必须绿（契约成立）
 *   · 抖动 session ⇒ 必须红（断言有效）
 *
 * 跑法：node tools/_probe-recall-stages-reverse.mjs
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const T = mod.__test;

const BASE = [
  { seq: 10, type: "user/message", time: 1000, data: { message: { role: "user", content: [{ type: "text", text: "甲".repeat(300) }] } } },
  { seq: 11, type: "user/message", time: 2000, data: { message: { role: "user", content: [{ type: "text", text: "乙".repeat(300) }] } } },
];

/** 稳定夹具：每次给同样内容。 */
function stableSession() {
  const m = new Map(BASE.map((e) => [e.seq, e]));
  return { eventAt: (s) => m.get(s) };
}

/** 抖动夹具：第 2 次及以后问同一个 seq，正文被砍掉一半。 */
function jitterSession() {
  const seen = new Map();
  return {
    eventAt(s) {
      const base = BASE.find((e) => e.seq === s);
      if (base === undefined) return undefined;
      const n = (seen.get(s) ?? 0) + 1;
      seen.set(s, n);
      if (n === 1) return base;
      const half = base.data.message.content[0].text.slice(0, 150);
      return { ...base, data: { message: { role: "user", content: [{ type: "text", text: half }] } } };
    },
  };
}

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${extra === undefined ? "" : `  ← ${extra}`}`); }
}

console.log("═══ A. 稳定夹具：契约成立（应全绿）═══");
{
  const s = stableSession();
  const idx = T.readSessionIndex(s, 10, 11, {});
  const picked = T.readSessionPicked(s, idx.rows.map((r) => r.seq), { maxChars: 999999 });
  ok("索引 chars 与真取到的 text.length 一致", idx.rows.every((r) => {
    const p = picked.events.find((e) => e.seq === r.seq);
    return p !== undefined && p.text.length === r.chars;
  }), JSON.stringify(idx.rows.map((r) => ({ seq: r.seq, chars: r.chars }))) + " vs " + JSON.stringify(picked.events.map((e) => ({ seq: e.seq, len: e.text.length }))));
  ok("总字数一致", idx.totalChars === picked.chars, `${idx.totalChars} vs ${picked.chars}`);
}

console.log("\n═══ B. 抖动夹具：契约被打破 ⇒ 上面那两条**必须红** ═══");
{
  const s = jitterSession();
  const idx = T.readSessionIndex(s, 10, 11, {});
  const picked = T.readSessionPicked(s, idx.rows.map((r) => r.seq), { maxChars: 999999 });
  const same = idx.rows.every((r) => {
    const p = picked.events.find((e) => e.seq === r.seq);
    return p !== undefined && p.text.length === r.chars;
  });
  const totalSame = idx.totalChars === picked.chars;
  ok("★ 反向验证：字数对不上 ⇒ 断言会红", same === false, `same=${same}（若这里是 ✅ 说明断言太弱）`);
  ok("★ 反向验证：总字数会对不上 ⇒ 断言会红", totalSame === false, `totalSame=${totalSame}`);
}

console.log("\n═══ C. 闸门下限：200 是硬底线 ═══");
{
  const s = stableSession();
  const r = T.readSessionPicked(s, [10, 11], { maxChars: 1 });
  ok("传 1 会被夹到 200 ⇒ 第 1 条 300 字就超了 ⇒ 截断", r.truncated === true, `chars=${r.chars} truncated=${r.truncated}`);
  ok("确实一个都没返回（300 > 200）", r.events.length === 0, `events=${r.events.length}`);
}

console.log("\n═══ D. 索引不会把正文带出来（这是它省 token 的根本）═══");
{
  const s = stableSession();
  const idx = T.readSessionIndex(s, 10, 11, {});
  const idxChars = idx.rows.reduce((a, r) => a + r.gist.length, 0);
  ok("索引里每一行都不含完整原文", idx.rows.every((r) => !r.gist.includes("甲".repeat(300))) && idx.rows.every((r) => !r.gist.includes("乙".repeat(300))));
  ok("索引比正文短得多", idxChars < idx.totalChars, `gist合计=${idxChars} vs 正文=${idx.totalChars}`);
  console.log(`     gist 合计 ${idxChars} 字 vs 正文 ${idx.totalChars} 字 ⇒ 省 ${(100 - (idxChars / idx.totalChars) * 100).toFixed(0)}%（未计固定开销）`);
}

console.log(`\n${"═".repeat(60)}`);
console.log(`PASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
