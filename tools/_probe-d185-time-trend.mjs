/**
 * ★★★★★ 只读取证（D185 之四）：**浅折是"什么时候"的产物？**
 *
 * 前三个探针已确立：
 *   ① 摘要在被反复折（134 次里 36 次，最大深度 **16**）；
 *   ② 深度 ≈ 0.304 × 次数（R² = 0.896）；
 *   ③ ★★★ **折得越浅越容易被再折**：≤5万 ⇒ 72.7% · 5~10万 ⇒ 47.2% ·
 *      10~20万 ⇒ 10.0% · 20~35万 ⇒ 5.6% · 35万以上 ⇒ **0%**。
 *
 * ★ 现在要回答那个决策问题：**"浅折"是不是"某个已冻结的模式的产物"？**
 *   若浅折集中在**增量压缩还开着**的那段时期 ⇒ 那么"把增量冻结"这一刀已经切掉了病灶，
 *   **当前（只做全量、70% 线）反而是干净的**；压缩体系没死，死的是"省成本那一支"。
 *   若浅折**至今仍在发生** ⇒ 那就真是结构性的，用户说对了。
 *
 * ★ 判据：按**时间分桶**（按天），看每天折掉量的中位数与深度≥2 的比例。
 *   ★ 同时给出**来源**：我们自己的高保真压缩 vs 内核/官方压缩（用 `compaction/start`
 *     或邻近事件难以区分 ⇒ **改用能确定的口径**：只按 token 量与时间，不做来源猜测）。
 *
 * 只读。跑法：node tools/_probe-d185-time-trend.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

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
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const day = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 10);

const ROOT = path.join(os.homedir(), ".dsh", "sessions");
const files = [];
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
    else if (e.name === "session.v4.jsonl.zstd") files.push(p);
  }
};
walk(ROOT, 0);

const all = [];
for (const p of files) {
  let txt;
  try {
    txt = decodeAll(fs.readFileSync(p));
  } catch {
    continue;
  }
  const items = [];
  for (const line of txt.split("\n")) {
    if (line === "" || !line.includes("compaction/summary")) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "compaction/summary") continue;
    const r = e.data?.shadowedRange ?? {};
    const a = Number(r.start);
    const b = Number(r.end);
    items.push({
      seq: Number(e.seq ?? 0),
      time: Number(e.time ?? 0),
      lo: Number.isFinite(a) && Number.isFinite(b) && a <= b ? a : undefined,
      hi: Number.isFinite(a) && Number.isFinite(b) && a <= b ? b : undefined,
      tok: Number(e.data?.shadowedTokenCount ?? 0),
    });
  }
  if (items.length === 0) continue;
  items.sort((x, y) => x.seq - y.seq);
  const placed = [];
  for (const s of items) {
    const lo = s.lo ?? 0;
    const hi = s.hi ?? s.seq - 1;
    const inner = placed.filter((q) => q.seq >= lo && q.seq <= hi);
    const depth = inner.length > 0 ? 1 + Math.max(...inner.map((q) => q.depth)) : 1;
    placed.push({ seq: s.seq, depth });
    all.push({ tok: s.tok, depth, time: s.time });
  }
}

bar("① 按天：折掉量的中位数 + 深度≥2 的比例（★ 看浅折是什么时候的事）");
const byDay = new Map();
for (const x of all) {
  if (!(x.time > 0)) continue;
  const d = day(x.time);
  if (!byDay.has(d)) byDay.set(d, []);
  byDay.get(d).push(x);
}
const med = (arr) => {
  if (!arr.length) return 0;
  const v = [...arr].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};
console.log("   日期          次数   折掉量中位      ≤10万 的次数   深度≥2 次数   深度≥2 占比");
for (const d of [...byDay.keys()].sort()) {
  const arr = byDay.get(d);
  const shallow = arr.filter((x) => x.tok < 100000).length;
  const deep = arr.filter((x) => x.depth >= 2).length;
  console.log(
    `   ${d}  ${String(arr.length).padStart(5)}  ${String(med(arr.map((x) => x.tok))).padStart(11)}  ` +
      `${String(shallow).padStart(13)}  ${String(deep).padStart(12)}   ${((100 * deep) / arr.length).toFixed(1)}%`
  );
}

bar("② ★★★ 分水岭：折掉量 < 10 万 的那些，发生在哪些天？");
const shallowAll = all.filter((x) => x.tok < 100000 && x.time > 0);
const shallowByDay = new Map();
for (const x of shallowAll) {
  const d = day(x.time);
  shallowByDay.set(d, (shallowByDay.get(d) ?? 0) + 1);
}
console.log("   日期          浅折(<10万)次数");
for (const d of [...shallowByDay.keys()].sort()) {
  console.log(`   ${d}  ${String(shallowByDay.get(d)).padStart(16)}`);
}
const lastShallow = Math.max(...shallowAll.map((x) => x.time));
console.log(`\n  ⇒ **最后一次浅折**：${new Date(lastShallow).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19)}`);
const lastDeep = Math.max(...all.filter((x) => x.tok >= 350000).map((x) => x.time));
console.log(`  ⇒ **最后一次深折(≥35万)**：${new Date(lastDeep).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19)}`);

bar("③ 结论口径（★ 只报数据，不替用户下判断）");
const recent = all.filter((x) => x.time >= lastShallow - 2 * 86400000);
const recentDeep = recent.filter((x) => x.depth >= 2).length;
console.log(`  最近两天里的压缩：${recent.length} 次 · 其中深度≥2 的 ${recentDeep} 次`);
console.log(
  `  全库深度≥2 的压缩共 ${all.filter((x) => x.depth >= 2).length} 次；` +
    `其中发生在"最后一次浅折"之后的：${all.filter((x) => x.depth >= 2 && x.time > lastShallow).length} 次`
);
