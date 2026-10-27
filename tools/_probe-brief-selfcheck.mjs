/**
 * ★★★ 自审：任务单里每一处"文件:行号"与数字，都回磁盘核一遍。
 * 目的：不能把没核过的证据交给第三方模型（本项目最贵的教训之一）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC = path.join(ROOT, "docs", "外发任务单-压缩连成一体-20261024.md");
let pass = 0, fail = 0;
const ok = (l, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${d ? " :: " + d : ""}`); } };

const doc = fs.readFileSync(DOC, "utf8");
ok("任务单存在且非空", doc.length > 10000, `${doc.length} 字符`);

// ── 逐条核对引用
const checks = [
  // [文件, 行号, 必须包含的片段, 说明]
  ["lib/part3.js", 3094, 'x.phase === "owed"', "owed 无条件 wait"],
  ["lib/part3.js", 3129, "ratio < line", "清相位只有水位掉线下"],
  ["lib/part3.js", 3255, 'phase: "owed"', "owed 立起位置"],
  ["lib/index.js", 1661, "turnCompact?.delete", "turn/end 无条件清相位"],
  ["lib/index.js", 330, "agent/pre-step", "我们的 pre-step 接线"],
  ["lib/index.js", 350, "decision?.turn ?? 0", "deps.turn 永远 0 的来源"],
  ["lib/part5.js", 2452, "export async function runTurnCompact", "runTurnCompact 定义"],
  ["lib/part5.js", 2504, "pressure.ratio <= target", "target 门"],
  ["lib/part5.js", 2527, "captureCapsuleBeforeCompact", "抓胶囊"],
  ["lib/part5.js", 2533, 'pushHfSource(state, key, "auto:midturn")', "来源票"],
  ["lib/part5.js", 2536, "compactRegion", "真压"],
];
console.log("── 代码行号核对 ──");
for (const [file, line, expect, label] of checks) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) { ok(`${label} (${file}:${line})`, false, "文件不存在"); continue; }
  const lines = fs.readFileSync(p, "utf8").split("\n");
  const actual = lines[line - 1] ?? "";
  ok(`${label} → ${file}:${line}`, actual.includes(expect), `实际第 ${line} 行: ${actual.trim().slice(0, 100)}`);
}

console.log("\n── 官方内核行号核对 ──");
const KERNEL = "C:/Users/24239/AppData/Local/Temp/dsh-asar-x/dsh-compaction-basic/lib/index.js";
if (!fs.existsSync(KERNEL)) {
  ok("内核源码可读", false, "路径不在 → 任务单该条证据失效，需提醒接手者");
} else {
  const kl = fs.readFileSync(KERNEL, "utf8").split("\n");
  const kchecks = [
    [839, "agent/pre-step"],
    [841, "compactIfNeeded"],
    [851, "return next()"],
    [15, ".8"],
    [941, "thresholdTokens"],
    [948, "compactionRetries"],
  ];
  for (const [ln, exp] of kchecks) {
    ok(`内核 :${ln} 含 ${exp}`, (kl[ln - 1] ?? "").includes(exp), `实际: ${(kl[ln - 1] ?? "").trim().slice(0, 90)}`);
  }
}

console.log("\n── 文件体积核对（硬上限 262,144）──");
const sizes = {};
for (const f of fs.readdirSync(path.join(ROOT, "lib"))) {
  if (!f.endsWith(".js")) continue;
  const s = fs.statSync(path.join(ROOT, "lib", f)).size;
  sizes[f] = s;
  if (s > 262144) ok(`${f} 未超上限`, false, `${s} B`);
}
ok("所有 lib 文件都在 262144 B 以内", Object.values(sizes).every((s) => s <= 262144));
for (const [f, expect] of [["part2.js", 258499], ["part3.js", 252352], ["part5.js", 169640], ["index.js", 145325]]) {
  ok(`${f} = ${expect} B（任务单里写的是这个数）`, sizes[f] === expect, `实际 ${sizes[f]}`);
}

console.log("\n── 任务单里的数字自洽性 ──");
ok("含 '5 / 47' 这个结论数字", /5 \/ 47/.test(doc));
ok("含 '10.6%'", doc.includes("10.6%"));
ok("含 '133' 与 'awaiting-owed'", doc.includes("133") && doc.includes("awaiting-owed"));
ok("已不含过时旧值 126", !/\b126\b/.test(doc), "文档里仍有 126");
ok("含 'act=compact' 出现 0 次的结论", /act=compact[^\n]*0 次|0 次/.test(doc));
ok("写明 '不要 git add -A'", /git add -A/.test(doc));
ok("写明 '不要提交、不要推送'", /不要提交、不要推送/.test(doc));
ok("写明 selftest 基线 2229", doc.includes("2229"));
ok("含用户逐字原话（连成一体）", doc.includes("连成一体"));
ok("含 §8.1 备选架构（只做记忆不做压缩引擎）", doc.includes("只做记忆、不做压缩引擎"));

// ── 诊断日志的 ACT 分布，重算一次
console.log("\n── 重算诊断日志 ACT 分布 ──");
const logs = [
  path.join(ROOT, "10.项目台账-ledger-memory", ".dsh-ledger-midturn.log"),
  path.join(ROOT, ".dsh-ledger-midturn.log"),
];
let total = 0, owed = 0, compactAct = 0, below = 0, pull = 0, unmeas = 0;
for (const lf of logs) {
  if (!fs.existsSync(lf)) continue;
  for (const ln of fs.readFileSync(lf, "utf8").split(/\r?\n/)) {
    if (!ln.trim()) continue;
    total += 1;
    if (/why=awaiting-owed/.test(ln)) owed += 1;
    if (/why=below-line/.test(ln)) below += 1;
    if (/why=owed-first/.test(ln)) pull += 1;
    if (/why=unmeasurable/.test(ln)) unmeas += 1;
    if (/act=compact/.test(ln)) compactAct += 1;
  }
}
console.log(`  合计 ${total} 行 · awaiting-owed ${owed} · below-line ${below} · owed-first ${pull} · unmeasurable ${unmeas} · act=compact ${compactAct}`);
ok("合计 171 行（任务单里写的）", total === 171, `实际 ${total}`);
ok("awaiting-owed = 133", owed === 133, `实际 ${owed}`);
ok("below-line = 26", below === 26, `实际 ${below}`);
ok("owed-first = 8", pull === 8, `实际 ${pull}`);
ok("unmeasurable = 4", unmeas === 4, `实际 ${unmeas}`);
ok("★ act=compact = 0（核心证据）", compactAct === 0, `实际 ${compactAct}`);
ok("任务单里的 133 与实测一致", doc.includes("| **133** |") && owed === 133, `文档写133? ${doc.includes("| **133** |")}`);

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail === 0 ? 0 : 1);
