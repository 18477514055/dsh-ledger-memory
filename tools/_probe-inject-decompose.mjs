/**
 * 只读：把**我们自己的注入**拆开，看每类内容各占多少字符。
 *
 * 为什么做这个：`_probe-inject-size.mjs` 测出我们 814 条注入共 14,150,520 字符，
 * 平均 17,384 / 条、最大 59,798（**贴着 60000 上限**），占全库注入总量的 **95.1%**。
 * ⇒ 现在要回答的是：**那 17K 花在哪几段**，不然"优化注入"就是空话。
 *
 * 判据：按注入文本里的**标志性标题**分类（这些标题是我们自己渲染的，改文案就得改这里）。
 * ★ 分类不到的归「未识别」，并原样打印开头 —— 不许把识别失败当成"没有"。
 *
 * 跑法：node tools/_probe-inject-decompose.mjs
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
if (FILE === undefined) {
  console.log("SKIP");
  process.exit(0);
}

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
  } catch {
    continue;
  }
  const s = out.toString("utf8");
  const first = s.split("\n").find((l) => l.trim() !== "");
  if (first === undefined) continue;
  try {
    JSON.parse(first);
  } catch {
    continue;
  }
  texts.push(s);
}

/**
 * 标志性标题 ⇒ 类别。**按出现位置切段**：一段从某个标志开始，到下一个标志为止。
 * ★ 顺序无关紧要（用 indexOf 找位置后排序），但标志必须是**我们注入里独有的**。
 */
const MARKERS = [
  ["台账头/说明", "## 当前项目台账（"],
  ["台账必注正文", "<<<LEDGER-BLOCKS"],
  ["台账目录", "### 台账目录（**只有位置**"],
  ["设置快照", "**⚙️ 当前设置**"],
  ["文件锚定", "### ★ 文件锚定（哪个记忆面里有材料"],
  ["记忆面地图", "### ★ 记忆面地图（**除台账外"],
  ["目标树", "### 目标树（**记忆的组织方式**"],
  ["被压掉的历史索引", "### ★ 被压掉的历史：**可以按需读回原文**"],
  ["收尾义务", "★ **本回合收尾义务（不是障碍，做完就安静）**"],
  ["压缩通知", "上下文刚被压缩（台账 + 分流单 + 高保真胶囊已重新注入）"],
  ["分流单", "## ★ 分流单 · 留在上下文的那一份"],
  ["官方原件路径", "★ **官方原件**（内核自己写的、跨重启永在"],
  ["文件格式协议", "### ★ 文件格式协议（**写这些文件前先看这一节**"],
  ["压缩策略合同", "★★★ **压缩策略（这是你与插件之间的合同）**"],
  ["插件能力清单", "### ★ 这个插件**还有这些能力**，本项目尚未启用"],
  ["变更登记", "变更登记（插件自动维护）"],
];

function decompose(text) {
  const hits = [];
  for (const [name, marker] of MARKERS) {
    let idx = text.indexOf(marker);
    while (idx >= 0) {
      hits.push({ name, idx });
      idx = text.indexOf(marker, idx + 1);
    }
  }
  hits.sort((a, b) => a.idx - b.idx);
  // 去重：同一位置多个标志只留第一个
  const uniq = [];
  for (const h of hits) {
    if (uniq.length === 0 || h.idx !== uniq[uniq.length - 1].idx) uniq.push(h);
  }
  const out = [];
  for (let i = 0; i < uniq.length; i += 1) {
    const end = i + 1 < uniq.length ? uniq[i + 1].idx : text.length;
    out.push({ name: uniq[i].name, chars: end - uniq[i].idx });
  }
  if (uniq.length === 0) out.push({ name: "（未识别）", chars: text.length });
  else if (uniq[0].idx > 0) out.unshift({ name: "（标志前导语）", chars: uniq[0].idx });
  return out;
}

// ── 收集我们的注入 ──
const ours = [];
for (const l of texts.join("").split("\n")) {
  if (l.trim() === "") continue;
  let o;
  try {
    o = JSON.parse(l);
  } catch {
    continue;
  }
  if ((o?.type ?? o?.event?.type) !== "user/message") continue;
  const d = o?.data ?? o?.event?.data;
  if (d?.source?.kind !== "project-ledger-notes") continue;
  const content = Array.isArray(d?.content) ? d.content : [];
  const text = content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
  if (text !== "") ours.push({ seq: o?.seq ?? o?.event?.seq, text });
}

console.log(`我们的注入 ${ours.length} 条，合计 ${ours.reduce((s, r) => s + r.text.length, 0)} 字符\n`);

// ── 每类总计 ──
const agg = new Map();
let unrecognized = 0;
for (const r of ours) {
  for (const seg of decompose(r.text)) {
    agg.set(seg.name, (agg.get(seg.name) ?? 0) + seg.chars);
    if (seg.name === "（未识别）") unrecognized += 1;
  }
}
const grand = [...agg.values()].reduce((s, n) => s + n, 0);
console.log("═══ 各类内容总计（按字符）═══\n");
console.log("  类别                          总字符      占比    平均/条");
for (const [k, n] of [...agg.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${String(n).padStart(10)}  ${((n / grand) * 100).toFixed(1).padStart(5)}%  ${String(Math.round(n / ours.length)).padStart(8)}`);
}
console.log(`  ${"合计".padEnd(28)} ${String(grand).padStart(10)}`);
if (unrecognized > 0) console.log(`\n  ⚠ 有 ${unrecognized} 条注入**一条标志都没匹配上** —— 说明有注入类型没被我的判据覆盖，别当成"没有"。`);

// ── 挑一条最大的原样看 ──
const biggest = ours.slice().sort((a, b) => b.text.length - a.text.length)[0];
console.log(`\n═══ 最大的一条（seq=${biggest.seq}，${biggest.text.length} 字符）分段 ═══\n`);
for (const seg of decompose(biggest.text)) {
  console.log(`  ${String(seg.chars).padStart(7)}  ${seg.name}`);
}
