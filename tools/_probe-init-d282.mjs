// D282 验证：ledger_init 现在能不能**一步建成第 2 代**？
// ★ 一律用临时目录，不碰生产工作区。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = path.resolve(import.meta.dirname, "..");
const mod = await import(pathToFileURL(path.join(here, "lib", "index.js")).href);
const defs = await import(pathToFileURL(path.join(here, "lib", "defs.js")).href);

const CFG = { maxActiveLines: 400, highFidelityCompactRatio: 0.7, mode: "surgical", nudgeMinRatio: 0.7, blockInjection: true };
const run = { registeredTools: new Map() };
try {
  mod.apply({
    effect: () => {}, on: () => {}, inject: () => {}, provide: () => {},
    tools: { register(d) { run.registeredTools.set(typeof d === "string" ? d : d?.name, d); } },
    commands: { register() {} },
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    plugin: () => {}, get: () => undefined, set: () => {},
  }, CFG);
} catch (e) { console.log("apply:", e.message); }

const init = run.registeredTools.get("ledger_init");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const execIn = (root, sid) => ({ agent: { session: { header: { id: sid, cwd: root } } } });

function report(title, root, r) {
  const m = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8"));
  console.log(`\n═══ ${title} ═══`);
  console.log("  ok =", r.ok);
  console.log("  protocolVersion =", JSON.stringify(m.protocolVersion));
  for (const k of ["decisionsDir", "lessonsDir", "goalsDir", "logDir"]) {
    console.log(`  ${k.padEnd(13)} = ${JSON.stringify(m[k])}`);
  }
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).filter((n) => n !== ".git");
  console.log("  建出的目录 =", dirs.length ? dirs.join("  ") : "（无）");
  const g = defs.protocolGapOf(m);
  console.log("  → outdated =", g.outdated, "· effectiveVersion =", g.effectiveVersion);
  if (r.protocol) console.log("  回执 protocol =", JSON.stringify(r.protocol).slice(0, 220));
  return m;
}

// ① 旧行为：不给卡片目录 ⇒ 仍是第 1 代（不许被"改坏"）
{
  const root = tmp("d282-a-");
  const r = await init.execute({ active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", initialActive: "# 台账\n" }, execIn(root, "s-d282-a"));
  const m = report("① 只给必备三件（旧行为，应仍是第 1 代）", root, r);
  const ok = m.protocolVersion === 1 && defs.protocolGapOf(m).outdated === true;
  console.log(`  ${ok ? "✅" : "❌"} 期望第 1 代且 outdated=true`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ② 新能力：给全部四个 ⇒ 一步建成第 2 代
{
  const root = tmp("d282-b-");
  const r = await init.execute({
    active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive",
    decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals", logDir: "_ledger-log",
    initialActive: "# 台账\n",
  }, execIn(root, "s-d282-b"));
  const m = report("② 给齐 card 三目录 + logDir（应一步建成第 2 代）", root, r);
  const g = defs.protocolGapOf(m);
  const ok = m.protocolVersion === 2 && g.outdated === false && g.missing.length === 0;
  console.log(`  ${ok ? "✅" : "❌"} 期望第 2 代且 outdated=false、missing=0`);
  for (const d of ["decisions", "lessons", "goals"]) {
    const exists = fs.existsSync(path.join(root, d));
    console.log(`  ${exists ? "✅" : "❌"} 目录 ${d} 已建`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

// ③ 只给卡片目录、不给 logDir ⇒ 仍是第 1 代（不能跳代）
{
  const root = tmp("d282-c-");
  const r = await init.execute({
    active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive",
    decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals", initialActive: "# 台账\n",
  }, execIn(root, "s-d282-c"));
  const m = report("③ 给了卡片化但没 logDir（应仍是第 1 代）", root, r);
  const ok = m.protocolVersion === 1;
  console.log(`  ${ok ? "✅" : "❌"} 期望第 1 代（不能跳代）`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ④ 边界：decisionsDir 是绝对路径 ⇒ 必须拒
{
  const root = tmp("d282-d-");
  let msg = "(没抛错 ❌)";
  try {
    await init.execute({ active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", decisionsDir: "C:\\evil" }, execIn(root, "s-d282-d"));
  } catch (e) { msg = e.message; }
  console.log(`\n═══ ④ 绝对路径的 decisionsDir ═══\n  ${msg.includes("相对路径") || msg.includes("逃出") ? "✅ 被拒：" : "❌ 没拒："}${msg.slice(0, 90)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ⑤ 边界：decisionsDir 逃出项目根
{
  const root = tmp("d282-e-");
  let msg = "(没抛错 ❌)";
  try {
    await init.execute({ active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", lessonsDir: "../outside" }, execIn(root, "s-d282-e"));
  } catch (e) { msg = e.message; }
  console.log(`\n═══ ⑤ 逃出项目根的 lessonsDir ═══\n  ${msg.includes("逃出") ? "✅ 被拒：" : "❌ 没拒："}${msg.slice(0, 90)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("\n全部临时目录已清理。");
