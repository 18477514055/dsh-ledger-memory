// ═══════════════════════════════════════════════════════════════════════════
// D216 · 解码官方 approved 条目的详情（base64），看**已上架的都是什么形状**
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 要回答的问题（决定策略，不是好奇）：
//   我们把 largest file 拆掉、补上 dsh.compatibility 之后，**能过自动通道吗**？
//   · 官方白名单把 6 个 permission 信号全设 false；
//   · 我们的插件**必然**读写文件、跑 git、用环境变量；
//   ⇒ 若"命中 = 永不可上架"，则自动通道对我们**结构性关闭**，该换策略；
//   ⇒ 若"命中 = 转人工审核"，那我们要做的是**满足人工审核要的那几样**。
//   ★ 论据不许来自我的推理，要看**真实的 approved 条目**里有没有同样用文件/命令的。
//
// 用法：node tools/_probe-d216-approved-shape.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

const DIR = path.join("D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账", "_store-research");
const raw = fs.readFileSync(path.join(DIR, "approved-details.txt"), "utf8");

const records = [];
for (const line of raw.split("\n")) {
  const t = line.trim();
  if (t === "") continue;
  const i = t.indexOf("|");
  if (i < 0) continue;
  const id = t.slice(0, i);
  try {
    const json = JSON.parse(Buffer.from(t.slice(i + 1), "base64").toString("utf8"));
    records.push({ id, ...json });
  } catch {
    records.push({ id, __bad: true });
  }
}
console.log(`解码 approved 详情：${records.length} 条（坏 ${records.filter((r) => r.__bad).length} 条）\n`);

// ── ① 这些条目的 updatePolicy / status ─────────────────────────────────────
const byPolicy = {};
for (const r of records) byPolicy[r.updatePolicy ?? "(无)"] = (byPolicy[r.updatePolicy ?? "(无)"] ?? 0) + 1;
console.log("① updatePolicy 分布：", JSON.stringify(byPolicy));

const byStatus = {};
for (const r of records) byStatus[r.status ?? "(无)"] = (byStatus[r.status ?? "(无)"] ?? 0) + 1;
console.log("   status 分布     ：", JSON.stringify(byStatus));

// ── ② compatibility 的声明形状（这是 ① 那条指控的真答案）──────────────────
console.log("\n② compatibility 字段（前 12 条）：");
for (const r of records.slice(0, 12)) {
  const c = r.compatibility ?? {};
  console.log(`   ${r.id}`);
  console.log(`      dsh        = ${JSON.stringify(c.dsh)}`);
  console.log(`      dshReleases= ${JSON.stringify(c.dshReleases)}`);
  console.log(`      node       = ${JSON.stringify(c.node)}`);
}

// ── ③ ★★★ 它们**有没有** permission 信号相关字段 / 风险记录 ────────────────
console.log("\n③ 详情里有没有 risk / details 里提到 permission signal：");
let withRisk = 0;
let withSignalMention = 0;
for (const r of records) {
  const s = JSON.stringify(r);
  if (r.risk !== undefined) withRisk += 1;
  if (/permission signal/i.test(s)) withSignalMention += 1;
  if (/runtime source contains/i.test(s)) withSignalMention += 1;
}
console.log(`   有 risk 字段的：${withRisk} / ${records.length}`);
console.log(`   提到 permission signal / runtime source contains 的：${withSignalMention}`);

// ── ④ ★★★ 决定性：它们的 details.risk 里，files/network/commands 是怎样的 ──
console.log("\n④ 逐条把 risk 摊开（看已上架的插件是否也用文件/命令）：");
for (const r of records.slice(0, 20)) {
  const risk = r.risk ?? r.details?.risk ?? {};
  const keys = Object.keys(risk);
  console.log(`   ${r.id.padEnd(34)} risk键=[${keys.join(", ")}]`);
  if (keys.length > 0) {
    const perf = risk.permissions ?? risk.signals ?? risk;
    console.log(`        ${JSON.stringify(perf).slice(0, 200)}`);
  }
}

// ── ⑤ 找一个"明显用文件/命令"的已上架插件（例如文件收件箱、缓存保持）──────
console.log("\n⑤ 按 id 找几个**必然用文件系统**的已上架插件：");
const suspects = ["dsh-im-file-inbox", "dsh-cache-stabilizer", "dsh-multi-folder", "dsh-capability-receipt"];
for (const s of suspects) {
  const r = records.find((x) => x.id === s);
  if (r === undefined) {
    console.log(`   ${s}: 未在 approved 列表里`);
    continue;
  }
  console.log(`   ✅ ${s} —— status=${r.status} policy=${r.updatePolicy}`);
  console.log(`        compatibility.dsh = ${JSON.stringify(r.compatibility?.dsh)}`);
  console.log(`        risk = ${JSON.stringify(r.risk ?? r.details?.risk ?? "(无)").slice(0, 220)}`);
}
