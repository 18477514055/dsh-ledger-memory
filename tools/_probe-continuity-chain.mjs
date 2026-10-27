/**
 * ★★★★★ 只读行为探针：**完整连续链路**（用户第 1–8 点的那条链）
 *
 * 用户原话（逐字）：
 *   "到线 ⇒ 收到一个作为义务的提醒（保证模型一定去做，而不是继续工作）
 *    ⇒ 模型落实台账、归档、分流
 *    ⇒ 做完分流之后触发一个东西（检测到分流完毕 + 水位 > 线 ⇒ 向压缩工具发触发消息）
 *      这能保证压缩**立刻**发生，而不是模型继续工作
 *    ⇒ 自动引发全量高保真压缩 ⇒ 压完把压后的上下文发给模型 ⇒ 模型继续工作"
 *
 * ★ 这条探针只做一件事：**把真实状态机一格一格推过去**，看每一步是否真的发生。
 *   不 grep 代码、不读注释 —— 只看 gate/runner 的实际返回值。
 * ★ 判据全部是"可证伪"的：该发的没发、该压的没压 ⇒ 红。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "chain-"));
process.env.DSH_HOME = path.join(fixture, "home");

const { newState, setActiveSettings } = await import(pathToFileURL(path.join(ROOT, "lib", "defs.js")).href);
const { settingsOf } = await import(pathToFileURL(path.join(ROOT, "lib", "part1.js")).href);
const { midTurnCompactGate, runMidTurnCompact } = await import(pathToFileURL(path.join(ROOT, "lib", "part3.js")).href);

let pass = 0, fail = 0;
const ok = (l, c, d = "") => { if (c) { pass++; console.log(`  PASS ${l}`); } else { fail++; console.log(`  FAIL ${l}${d ? " :: " + d : ""}`); } };

const sid = "chain-fixture";
const root = path.join(fixture, "project");
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "LEDGER.md"), "# fixture\n");
fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify({ active: "LEDGER.md", revision: 1 }));

const steers = [];
const agent = { session: { header: { id: sid, cwd: root } }, steer: (m) => steers.push(m) };
const ctx = { logger: { warn() {} } };
// 水位 0.75，线 0.70 ⇒ 已过线
setActiveSettings(settingsOf({ midTurnCompact: true, autoCompact: true, highFidelityCompact: true, diagFile: false, highFidelityCompactRatio: 0.7, turnEndPull: 1, hardMaintenanceGate: true }));

const st = newState();
st.turnObligation.set(sid, { wrote: false, triaged: false });
let compactCalls = 0;
const deps = {
  turn: 77,
  pressure: { ratio: 0.75, total: 750000, window: 1000000 },
  runTurnCompact: async () => { compactCalls += 1; return { compacted: true, before: 0.75, after: 0.12 }; },
};

console.log("═══ 第 1 拍：水位过线，义务未做 ⇒ 应「抽起提醒」 ═══");
const s1 = await runMidTurnCompact(ctx, st, agent, deps);
console.log(`  act=${s1.act} why=${s1.why}  steer次数=${steers.length}  phase=${st.turnCompact.get(sid)?.phase}`);
ok("① 过线 + 义务未做 ⇒ act=pull（发出义务提醒）", s1.act === "pull", `实际 ${s1.act}/${s1.why}`);
ok("①b 真的 steer 了一次（不是只改内部状态）", steers.length === 1, `steers=${steers.length}`);
ok("①c 此时**不许**已经压缩", compactCalls === 0, `compactCalls=${compactCalls}`);

console.log("\n═══ 第 2 拍：模型做完了台账 + 分流 ⇒ 应**立刻**压缩，无需用户发话 ═══");
// 模拟模型完成义务（wrote/triaged，且 seq 未过期）
st.turnObligation.set(sid, { wrote: true, triaged: true, writeSeq: 100, triageSeq: 101, lastNonLedgerSeq: 90 });
const s2 = await runMidTurnCompact(ctx, st, agent, deps);
console.log(`  act=${s2.act} why=${s2.why}  compactCalls=${compactCalls}  phase=${st.turnCompact.get(sid)?.phase}`);
ok("② 义务做完 ⇒ 立刻压缩（同一回合、无新用户消息）", compactCalls === 1, `compactCalls=${compactCalls}, act=${s2.act}/${s2.why}`);
ok("②b 压缩成功 ⇒ 相位进 done", st.turnCompact.get(sid)?.phase === "done", `phase=${st.turnCompact.get(sid)?.phase}`);
ok("②c 不需要用户发任何消息（steers 仍是 1，没有追加）", steers.length === 1, `steers=${steers.length}`);

console.log("\n═══ 第 3 拍：压完之后同回合继续 ⇒ 不应重复压 ═══");
const s3 = await runMidTurnCompact(ctx, st, agent, deps);
console.log(`  act=${s3.act} why=${s3.why}  compactCalls=${compactCalls}`);
ok("③ 压过之后不再重复压（防连环）", compactCalls === 1, `compactCalls=${compactCalls}`);
ok("③b 且不阻断继续工作（返回 none/wait 而不是异常）", s3.act === "none" || s3.act === "wait", `act=${s3.act}`);

console.log("\n═══ 第 4 拍：水位掉回线下 ⇒ 相位重新武装（下一轮还能压）═══");
const lowDeps = { ...deps, pressure: { ratio: 0.30, total: 300000, window: 1000000 } };
const s4 = await runMidTurnCompact(ctx, st, agent, lowDeps);
console.log(`  act=${s4.act} why=${s4.why}  phase=${st.turnCompact.get(sid)?.phase ?? "(已清)"}`);
ok("④ 掉回线下 ⇒ 相位被清（可重新武装）", s4.act === "none" && s4.why === "below-line", `实际 ${s4.act}/${s4.why}`);

console.log("\n═══ 反向：把「义务做完」这一步摘掉 ⇒ 第 2 拍必须压不了 ═══");
const st2 = newState();
st2.turnObligation.set(sid, { wrote: false, triaged: false });
let c2 = 0;
const d2 = { ...deps, runTurnCompact: async () => { c2 += 1; return { compacted: true }; } };
await runMidTurnCompact(ctx, st2, agent, d2);            // 第1拍：pull
const r2 = await runMidTurnCompact(ctx, st2, agent, d2);  // 第2拍：义务仍没做
console.log(`  第2拍 act=${r2.act} why=${r2.why} compactCalls=${c2}`);
ok("⑤ 义务没做完时**不许**压（硬门有效）", c2 === 0, `compactCalls=${c2}`);

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
