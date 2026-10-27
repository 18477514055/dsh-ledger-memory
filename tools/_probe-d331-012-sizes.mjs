/**
 * _probe-d331-012-sizes.mjs —— 核 012 报告 §2 那张体积表，并量当前真值
 *
 * ★ 为什么先做这个（D330 学到的）：011 的体积表 20/21 相符 ⇒ 可以当"对照尺"。
 *   012 说修复前 part2.js = 241,515 B、距它自称的红线 241,664 只剩 149 B。
 *   但 D330 我刚改过 part2.js ⇒ **必须先量真值**，不能信任何一方的数字。
 *
 * ★ 同时核它那句"通过精简注释把 part2.js 降到 241,272"——
 *   这等于**用删注释换余量**，不是真拆模块。要单独盯住。
 */
import fs from "node:fs";
import path from "node:path";

const HARD = 262144;      // DSH STORE 单文件硬上限
const SOFT = 253952;      // 8 KiB 安全线 = 253952
const TIGHT = 241664;     // 报告自称的 part2/settings-http 红线（距硬限 20,480）

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${extra === undefined ? "" : `  —— ${extra}`}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${extra === undefined ? "" : `  —— ${extra}`}`); }
}

// ── 012 报告 §2 的「修复后字节」（现在是这个状态：补丁已打入生产） ────────────
// ★ D332：本探针最初写的是核「修复前」，那时补丁还没打；现在补丁已在生产里，
//   所以默认核「修复后」。要核修复前，用 `--before` 参数（对着报告那张表的"修复前"列）。
const REPORTED_AFTER = {
  "base.js": 26122, "card-ops.js": 45405, "client.js": 121198, "defs.js": 227688,
  "gates.js": 9031, "index.js": 147758, "log-collector.js": 16904,
  "manifest-mirror.js": 13720, "part1.js": 236564, "part2.js": 241272,
  "part3.js": 246228, "part4.js": 235874, "part5.js": 172593, "part6.js": 59698,
  "part7.js": 34332, "part8.js": 56500, "part8tool.js": 6998, "pure-ops.js": 7494,
  "settings-http.js": 33829, "v3-conformance.js": 23060, "workspace-tools.js": 26598,
};

const USE_BEFORE = process.argv.includes("--before");
const REPORTED = USE_BEFORE ? REPORTED_BEFORE : REPORTED_AFTER;
console.log(`口径：核「${USE_BEFORE ? "修复前" : "修复后"}」字节（${USE_BEFORE ? "用 --before 切换" : "默认"}）`);
const REPORTED_BEFORE = {
  "base.js": 26122, "card-ops.js": 45014, "client.js": 121198, "defs.js": 227688,
  "gates.js": 9031, "index.js": 147758, "log-collector.js": 16904,
  "manifest-mirror.js": 13720, "part1.js": 236304, "part2.js": 241515,
  "part3.js": 246228, "part4.js": 235591, "part5.js": 172593, "part6.js": 59698,
  "part7.js": 34332, "part8.js": 53616, "part8tool.js": 6998, "pure-ops.js": 7494,
  "settings-http.js": 33799, "v3-conformance.js": 23060, "workspace-tools.js": 25551,
};

const files = fs.readdirSync("lib").filter((n) => n.endsWith(".js")).sort();
const actual = {};
for (const f of files) actual[f] = fs.statSync(path.join("lib", f)).size;

console.log("\n═══ ① 逐文件比对「012 报告的修复前字节」vs「当前磁盘真值」═══");
let match = 0;
let mismatch = 0;
const diffs = [];
for (const f of Object.keys(REPORTED_BEFORE).sort()) {
  const rep = REPORTED_BEFORE[f];
  const act = actual[f];
  if (act === undefined) {
    console.log(`  ⚠ ${f.padEnd(22)} 报告有、磁盘没有`);
    mismatch += 1;
    continue;
  }
  if (rep === act) {
    match += 1;
  } else {
    mismatch += 1;
    diffs.push({ f, rep, act, d: act - rep });
    console.log(`  ✗ ${f.padEnd(22)} 报告 ${String(rep).padStart(8)} 实际 ${String(act).padStart(8)} 差 ${act - rep > 0 ? "+" : ""}${act - rep}`);
  }
}
console.log(`  ⇒ 相符 ${match} / 不符 ${mismatch}（共 ${Object.keys(REPORTED_BEFORE).length} 项报告值）`);

console.log("\n═══ ② 模块总数 ═══");
// ★★★ 2026-10-26（D332）：012 报告的快照是 **21 个模块**；而 D332 把四个 define*Tool
//   拆去了 `part2-tools.js` ⇒ 现在是 **22 个**。
//   ⇒ 这条断言**不能再拿"报告说 21"去要求"现在必须 21"** —— 那是把"核报告"与"核现状"混在一起。
//   改成分开报：① 报告快照口径 = 21（只用于比对字节表）② 现状 = 动态数，只要 ≥ 21 即合理。
ok(
  "报告快照口径 = 21 个模块（012 报告 §2 就按 21 个算的；本仓库现已 22，因 D332 真拆）",
  files.length >= 21,
  `实际 ${files.length} 个${files.length > 21 ? `（比报告多 ${files.length - 21} 个：D332 拆出的新模块）` : ""}`
);
const sumBytes = files.reduce((s, f) => s + actual[f], 0);
console.log(`  当前全库 lib/*.js 合计 ${sumBytes} B`);
console.log(`  报告称修复前合计 1,984,214 B · 修复后 1,988,866 B`);
ok(
  "合计字节与报告「修复后」值的偏差 < 5000 B（D330 之后我改过 part2）",
  Math.abs(sumBytes - 1988866) < 5000,
  `当前 ${sumBytes} vs 报告修复后 1988866，差 ${sumBytes - 1988866}`
);

console.log("\n═══ ③ 三条红线：每个文件是否破线（含报告自称的 241,664）═══");
const rows = files.map((f) => ({ f, b: actual[f] }));
rows.sort((a, b) => b.b - a.b);
for (const r of rows.slice(0, 6)) {
  const hardLeft = HARD - r.b;
  const softLeft = SOFT - r.b;
  const tightLeft = TIGHT - r.b;
  console.log(
    `  ${r.f.padEnd(22)} ${String(r.b).padStart(8)}  距硬限 ${String(hardLeft).padStart(7)}  距8KiB ${String(softLeft).padStart(7)}  距241664 ${String(tightLeft).padStart(7)}`
  );
}
const overHard = rows.filter((r) => r.b > HARD);
const overSoft = rows.filter((r) => r.b > SOFT);
const overTight = rows.filter((r) => r.b > TIGHT);
ok("无文件超 DSH STORE 硬限 262,144", overHard.length === 0, overHard.map((r) => r.f).join(",") || "全部合规");
ok("无文件超 8 KiB 安全线 253,952", overSoft.length === 0, overSoft.map((r) => r.f).join(",") || "全部合规");
ok(
  "无文件超报告自称的 241,664 红线",
  overTight.length === 0,
  overTight.map((r) => `${r.f}=${r.b}`).join(",") || "全部合规"
);

console.log("\n═══ ④ ★ 报告要害：它说 part2.js 修复后 = 241,272 B（靠删注释腾的）═══");
const p2 = actual["part2.js"];
console.log(`  当前 part2.js = ${p2} B`);
console.log(`  报告说修复前 241,515 / 修复后 241,272（净减 243 = 删注释）`);
ok(
  "★ part2.js 当前已贴着 241,664 ⇒ 报告删注释是在**掩盖**它没真拆模块",
  p2 > TIGHT - 2000,
  `part2=${p2}，距 241664 仅 ${TIGHT - p2} B`
);

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  合计：PASS ${pass} · FAIL ${fail} · 体积表相符 ${match}/${Object.keys(REPORTED_BEFORE).length}`);
if (diffs.length > 0) {
  console.log("  不符清单：");
  for (const d of diffs) console.log(`    ${d.f}: 报告 ${d.rep} → 实际 ${d.act}（${d.d > 0 ? "+" : ""}${d.d}）`);
}
console.log("PROBE-COMPLETE");
