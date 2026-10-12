/**
 * ★★★ 只读：**实测「兑现率」** —— 目标压 N 点，实际压掉几点？
 *
 * ★ 为什么先做这个：台账 §一 的表里写着「实绩 ~4.9 点 / 目标 10，根因 D70」。
 *   可我最近**亲眼看到**的三次回执是 **8.8 / 9.2 / 8.7** —— 与 4.9 差了一倍。
 *   ⇒ 要么那条已过期（棘轮修复 D86/D95 之后变好了），要么我看的样本是特例。
 *   ★ **不许靠"我记得"** —— 把全会话的每一次都数出来。
 *
 * ★ 判据来源：插件自己注入的回执文本（唯一带"目标/实绩"两行的东西）：
 *     `· **目标**：压掉 N 点（= 设置 deltaRemovePoints…）`
 *     `· **实绩：压前 X% → 压后 Y%**，即**实际压掉 Z 点**`
 *   ★ 这两行是**同一把尺子**量的（见 D73），所以比值可以直接算。
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
const textOf = (d) => {
  const c = d?.content ?? d?.message?.content;
  if (Array.isArray(c)) return c.map((x) => x?.text ?? "").join("");
  return typeof c === "string" ? c : "";
};

const RE_TARGET = /\*\*目标\*\*：压掉\s*([\d.]+)\s*点/;
const RE_ACTUAL = /\*\*实绩：压前\s*([\d.]+)%\s*→\s*压后\s*([\d.]+)%\*\*，即\*\*实际压掉\s*([\d.]+)\s*点\*\*/;
const RE_NONE = /量不到压后水位/;

const rows = [];
for (const e of evs) {
  if (e.type !== "user/message") continue;
  if (e.data?.source?.kind !== "project-ledger-notes") continue;
  const t = textOf(e.data);
  const mt = RE_TARGET.exec(t);
  const ma = RE_ACTUAL.exec(t);
  if (ma !== null) {
    rows.push({
      at: e.time, seq: e.seq,
      target: mt === null ? undefined : Number(mt[1]),
      before: Number(ma[1]), after: Number(ma[2]), actual: Number(ma[3]),
    });
  } else if (mt !== null && RE_NONE.test(t)) {
    rows.push({ at: e.time, seq: e.seq, target: Number(mt[1]), unmeasured: true });
  }
}

console.log("═".repeat(96));
console.log("① 逐次列出（目标 vs 实绩，**同一把尺子**）");
console.log("═".repeat(96));
console.log("  时间              目标  压前%   压后%   实绩   兑现率");
for (const r of rows) {
  if (r.unmeasured === true) {
    console.log(`  ${hm(r.at)}   ${String(r.target).padStart(4)}    —— 量不到压后水位（不计入统计）`);
    continue;
  }
  const rate = r.target === undefined ? NaN : (r.actual / r.target) * 100;
  console.log(
    `  ${hm(r.at)}   ${String(r.target ?? "?").padStart(4)}  ${r.before.toFixed(1).padStart(6)}  ` +
    `${r.after.toFixed(1).padStart(6)}  ${r.actual.toFixed(1).padStart(5)}  ` +
    `${Number.isFinite(rate) ? `${rate.toFixed(0)}%` : "—"}`
  );
}

const ok = rows.filter((r) => r.unmeasured !== true && Number.isFinite(r.target));
console.log("\n" + "═".repeat(96));
console.log("② 汇总（★ 只算**同尺子可比**的那些）");
console.log("═".repeat(96));
if (ok.length === 0) {
  console.log("  （没有可统计的样本）");
} else {
  const sumA = ok.reduce((s, r) => s + r.actual, 0);
  const sumT = ok.reduce((s, r) => s + r.target, 0);
  console.log(`  样本 ${ok.length} 次 · 量不到的 ${rows.length - ok.length} 次`);
  console.log(`  目标合计 ${sumT.toFixed(1)} 点 · 实绩合计 ${sumA.toFixed(1)} 点`);
  console.log(`  ★★ **总兑现率 = ${((sumA / sumT) * 100).toFixed(1)}%**`);
  console.log(`  平均每次：目标 ${(sumT / ok.length).toFixed(2)} · 实绩 ${(sumA / ok.length).toFixed(2)}`);

  // ★ 分期：棘轮修复（D86/D95，约 10-11 19:2x 之后）前后各算一次
  //   判据用**实测可见的分界**：第一份胶囊在 19:24 就存在，但棘轮修复的落点是 D95（10-11 23:0x）。
  //   ⇒ 这里按"最近三小时"与"更早"粗暴对半分，只为看趋势，不当作精确分期。
  const mid = ok[Math.floor(ok.length / 2)]?.at;
  const early = ok.filter((r) => r.at < mid);
  const late = ok.filter((r) => r.at >= mid);
  const rateOf = (list) => {
    const a = list.reduce((s, r) => s + r.actual, 0);
    const t = list.reduce((s, r) => s + r.target, 0);
    return t === 0 ? NaN : (a / t) * 100;
  };
  console.log("");
  console.log(`  ── 对半分期（只为看趋势）──`);
  console.log(`     前半 ${early.length} 次：兑现率 ${rateOf(early).toFixed(1)}%`);
  console.log(`     后半 ${late.length} 次：兑现率 ${rateOf(late).toFixed(1)}%`);
}

console.log("\n" + "═".repeat(96));
console.log("③ 与台账里那条**旧数字**对照");
console.log("═".repeat(96));
console.log("  台账 §一 的表写着：「实绩 ~4.9 点 / 目标 10，根因 D70」");
console.log(`  ★ 实测：${ok.length === 0 ? "无样本" : `实绩平均 ${(ok.reduce((s, r) => s + r.actual, 0) / ok.length).toFixed(2)} 点 / 目标 ${(ok.reduce((s, r) => s + r.target, 0) / ok.length).toFixed(2)} 点`}`);
console.log("  ⇒ 若实测明显高于 4.9，则那条**已过期**（棘轮修复 D86/D95 之后变好），台账要更正。");
