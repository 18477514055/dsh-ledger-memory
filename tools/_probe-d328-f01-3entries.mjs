// D328：三条入口**同一个病**的完整验证（修完之后必须三条全过）。
//   ① ledger_lock 工具  ② /ledger lock 命令  ③ rootFromExec（各工具的 root 参数）
// ★ 同时必须验：**越界仍被拦**（不能为了修自囚把墙拆了）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (f) => import(pathToFileURL(path.join(ROOT, "lib", f)).href);
const part1 = await load("part1.js");
const part3 = await load("part3.js");
const part4 = await load("part4.js");
const part5 = await load("part5.js");

let pass = 0;
let fail = 0;
const ok = (t, c, d) => {
  if (typeof c !== "boolean") throw new TypeError("ok() 第二参必须是布尔：" + t);
  if (c) { pass += 1; console.log("PASS  " + t + (d === undefined ? "" : "  —— " + d)); }
  else { fail += 1; console.log("FAIL  " + t + (d === undefined ? "" : "  —— " + d)); }
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "d328ws3-"));
const a = path.join(ws, "proj-a");
const b = path.join(ws, "proj-b");
const outside = path.join(os.tmpdir(), "d328outside3-" + Date.now());
for (const d of [a, b, outside]) {
  fs.mkdirSync(path.join(d, ".git"), { recursive: true });
  fs.writeFileSync(path.join(d, "LEDGER.md"), "# 台账\n", "utf8");
  fs.writeFileSync(path.join(d, ".dsh-ledger.json"), JSON.stringify({ active: "LEDGER.md", archiveDir: "_a" }), "utf8");
}
fs.writeFileSync(path.join(ws, "AGENTS.md"), "# ws\n", "utf8");

const SID = "session-d3280003-0000-4000-8000-000000000000";
const mkAgent = () => ({ session: { header: { id: SID, cwd: ws }, events: () => [] } });

// ── ① ledger_lock 工具 ────────────────────────────────────────────────
{
  const agent = mkAgent();
  const exec = { agent };
  const tool = part4.defineLockTool();
  await tool.execute({ root: a }, exec);
  ok("① 0 夹具：锁到了 proj-a", part1.lockedRootOf(agent) === a, String(part1.lockedRootOf(agent)));

  const r1 = await tool.execute({ root: b }, exec);
  ok("① a 锁着 proj-a 时，绝对路径切 proj-b 成功", r1?.ok === true, JSON.stringify(r1).slice(0, 120));
  await tool.execute({ root: a }, exec);
  const r2 = await tool.execute({ root: "../proj-b" }, exec);
  ok("① b 锁着 proj-a 时，`../proj-b` 切换成功", r2?.ok === true, JSON.stringify(r2).slice(0, 120));
  await tool.execute({ root: a }, exec);
  const r3 = await tool.execute({ root: "proj-b" }, exec);
  ok("① c 锁着 proj-a 时，相对名 `proj-b` 切换成功", r3?.ok === true, JSON.stringify(r3).slice(0, 120));

  await tool.execute({ root: a }, exec);
  const bad = await tool.execute({ root: outside }, exec);
  ok("① d **跳出最外层工作区仍被拦**（墙没拆）", bad?.ok === false, JSON.stringify(bad).slice(0, 140));
  part1.setProjectLock(agent, undefined);
}

// ── ② /ledger lock 命令 ───────────────────────────────────────────────
{
  const agent = mkAgent();
  const inv = { agent };
  const run = (arg) => part5.runLedgerSub({}, inv, {}, "lock", null, arg);
  await run(a);
  ok("② 0 夹具：命令锁到了 proj-a", part1.lockedRootOf(agent) === a, String(part1.lockedRootOf(agent)));

  const c1 = await run(b);
  ok("② a `/ledger lock <abs proj-b>` 成功", c1?.kind === "success", c1?.kind + " " + String(c1?.text ?? "").slice(0, 80));
  await run(a);
  const c2 = await run("../proj-b");
  ok("② b `/ledger lock ../proj-b` 成功", c2?.kind === "success", c2?.kind + " " + String(c2?.text ?? "").slice(0, 80));
  await run(a);
  const c3 = await run("proj-b");
  ok("② c `/ledger lock proj-b` 成功", c3?.kind === "success", c3?.kind + " " + String(c3?.text ?? "").slice(0, 80));

  await run(a);
  const bad = await run(outside);
  ok("② d **跳出最外层工作区仍被拦**（墙没拆）", bad?.kind === "error", bad?.kind + " " + String(bad?.text ?? "").slice(0, 100));
  part1.setProjectLock(agent, undefined);
}

// ── ③ rootFromExec ────────────────────────────────────────────────────
{
  const agent = mkAgent();
  part1.setProjectLock(agent, a); // 模拟"已锁在 proj-a"
  ok("③ 0 夹具：锁定 = proj-a", part1.lockedRootOf(agent) === a, String(part1.lockedRootOf(agent)));

  let got;
  let err;
  try {
    got = part3.rootFromExec({ agent }, { root: "../proj-b" });
  } catch (e) {
    err = e;
  }
  ok("③ a `root: \"../proj-b\"` 解析成功（锁着 proj-a 时）", err === undefined && got === b, err ? String(err.message).slice(0, 120) : String(got));

  let err2;
  try {
    part3.rootFromExec({ agent }, { root: "../../.." });
  } catch (e) {
    err2 = e;
  }
  ok("③ b **跳出最外层工作区仍被拦**（墙没拆）", err2 !== undefined, err2 === undefined ? "(没抛)" : String(err2.message).slice(0, 100));
  part1.setProjectLock(agent, undefined);
}

fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });
console.log("");
console.log("═══ " + pass + " PASS / " + fail + " FAIL ═══");
console.log("PROBE-COMPLETE pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
