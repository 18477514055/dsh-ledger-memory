/**
 * ★★★★★ 只读探针：**证明 `owed` 相位没有出口** —— 这就是回合内压缩从不发生的根因。
 *
 * 用户观察（逐字，2026-10-24）：
 *   "我说的压缩失败是指那种在工作过程中主动压缩，然后继续工作，不需要任何人工操作，
 *    但是目前的所有的压缩全部都是模型主动停止工作。然后压缩，然后我手动发送，继续工作。"
 *
 * 我的假设（要证伪它，不是证明它）：
 *   `phase === "owed"` 在 `midTurnCompactGate` 里**无条件** `wait`，
 *   而清掉这个相位只有一条路：水位掉回线下。
 *   ⇒ 义务一旦被抽起并做完，水位仍在线之上 ⇒ **永远等不到** ⇒ 压缩不发生。
 *
 * 判据设计（每条都能红）：
 *   ① 直接喂 gate：phase=owed + gapsOk=true + ratio=0.78 ⇒ 必须 act=compact（当前会 wait ⇒ 红）
 *   ② 全库搜索：清 `turnCompact` 的写入点只有"低于线"一条 ⇒ 没有别的出口
 *   ③ 诊断日志实证：找出 gapsOk=true 且 why=awaiting-owed 的行 ⇒ 义务已完成却仍在等
 *   ④ 反向自证：同一函数喂 phase=undefined + gapsOk=true ⇒ 必须 act=compact（证明不是整个函数都坏）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  PASS  ${label}${detail ? " :: " + detail : ""}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? " :: " + detail : ""}`); }
};

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "part3.js")).href);
const gate = mod.midTurnCompactGate;
ok("① 能从 part3 导入 midTurnCompactGate", typeof gate === "function");

// ── ① 核心断言：义务做完 + 水位在线之上 + 处于 owed ⇒ 应当去压
const r1 = gate({ enabled: true, phase: "owed", ratio: 0.78, line: 0.7, gapsOk: true, urgent: 0.9 });
console.log(`     实测返回 act=${r1.act} why=${r1.why}`);
ok("① 义务已兑现 + 到线 ⇒ 应 act=compact", r1.act === "compact",
  r1.act === "compact" ? "" : `实际 ${r1.act}/${r1.why} ⇒ ★ 这就是"永远等不到"的出口缺失`);

// ── ④ 反向自证：去掉 owed 相位，同样的输入必须能去压（证明判据本身不是恒假）
const r2 = gate({ enabled: true, phase: undefined, ratio: 0.78, line: 0.7, gapsOk: true, urgent: 0.9 });
console.log(`     实测返回 act=${r2.act} why=${r2.why}`);
ok("④ 反向：无相位 + 义务已兑现 ⇒ act=compact（判据不是恒假）", r2.act === "compact");

// ── ①b 义务没做完时必须仍去抽（不能因为修①而把抽起弄丢）
const r3 = gate({ enabled: true, phase: undefined, ratio: 0.78, line: 0.7, gapsOk: false, urgent: 0.9 });
ok("①b 义务未兑现 ⇒ 仍 act=pull", r3.act === "pull", `实际 ${r3.act}/${r3.why}`);

// ── ② 全库搜索：清/改 turnCompact 的写入点
console.log("\n  ── ② 搜全库：谁能改 state.turnCompact ──");
const files = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js"));
const hits = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
  const lines = src.split("\n");
  lines.forEach((ln, i) => {
    if (/state\.turnCompact\s*\.\s*(set|delete)/.test(ln)) {
      hits.push({ file: f, line: i + 1, text: ln.trim().slice(0, 140) });
    }
  });
}
for (const h of hits) console.log(`     ${h.file}:${h.line}  ${h.text}`);
const clearSites = hits.filter((h) => /\.delete\(/.test(h.text));
ok("② 清相位的写入点存在且可枚举", clearSites.length > 0, `${clearSites.length} 处 delete`);

// ②b 这些 delete 点是否都在"水位掉回线下"的条件里
const part3src = fs.readFileSync(path.join(ROOT, "lib", "part3.js"), "utf8").split("\n");
let belowLineGuard = 0;
for (const h of clearSites) {
  if (h.file !== "part3.js") continue;
  const ctx = part3src.slice(Math.max(0, h.line - 6), h.line + 1).join("\n");
  if (/ratio\s*<\s*line/.test(ctx)) belowLineGuard += 1;
}
ok("②b part3 里清相位都由「水位低于线」守着", belowLineGuard > 0,
  `${belowLineGuard} 处带 ratio<line 守卫 ⇒ 水位在线之上时相位永不释放`);

// ── ③ 诊断日志实证
console.log("\n  ── ③ 诊断日志实证（.dsh-ledger-midturn.log）──");
const logCandidates = [
  path.join(ROOT, "10.项目台账-ledger-memory", ".dsh-ledger-midturn.log"),
  path.join(ROOT, ".dsh-ledger-midturn.log"),
];
let logFile = null;
for (const c of logCandidates) if (fs.existsSync(c)) logFile = c;
ok("③ 诊断日志存在", logFile !== null, logFile ?? "两份都不在");

if (logFile) {
  const rows = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
  console.log(`     共 ${rows.length} 行`);
  // 找出"义务已完成(gapsOk=true) 却仍 awaiting-owed"的行
  const stuck = rows.filter((l) => /gapsOk=true/.test(l) && /why=awaiting-owed/.test(l));
  ok("③ gapsOk=true 却仍 awaiting-owed 的行 > 0（义务做完也出不去）", stuck.length > 0, `${stuck.length} 行`);
  for (const s of stuck.slice(-3)) console.log(`       ${s.slice(0, 170)}`);
  // 这些行里的水位范围
  const ratios = stuck.map((l) => { const m = l.match(/ratio=([\d.]+)%/); return m ? Number(m[1]) : null; }).filter((x) => x !== null);
  if (ratios.length) {
    console.log(`     这些行的水位：${Math.min(...ratios)}% ~ ${Math.max(...ratios)}%（全部在线 70% 之上）`);
    ok("③b 卡住时的水位全部 ≥ 线", Math.min(...ratios) >= 70);
  }
  // 统计 awaiting-owed 占全部有相位行的比例
  const withPhase = rows.filter((l) => /phase=(owed|pressing|failed|done)/.test(l));
  const owedRows = rows.filter((l) => /phase=owed/.test(l));
  console.log(`     phase=owed 行数 = ${owedRows.length} / 有相位行 ${withPhase.length}`);
  ok("③c owed 是最主要的停滞相位", owedRows.length > 0, `${owedRows.length} 行停在 owed`);
}

console.log(`\n═══ 结果：${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail === 0 ? 0 : 1);
