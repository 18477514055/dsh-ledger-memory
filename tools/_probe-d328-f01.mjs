// D328：核 F-01（项目锁「自囚」）。
// ★ 尺子错 #48（本轮自己撞的）：第一版我把 `execute(args, {})` 第二个参数传了空对象，
//   而工具是从 `exec.agent` 取会话的 ⇒ 全部报「拿不到会话编号」。
//   **夹具没走通 ≠ 被测对象有问题**（纪律 #6）。这次把 exec 传对。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (f) => import(pathToFileURL(path.join(ROOT, "lib", f)).href);
const part1 = await load("part1.js");
const part2 = await load("part2.js");
const part4 = await load("part4.js");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "d328ws-"));
const a = path.join(ws, "proj-a");
const b = path.join(ws, "proj-b");
for (const d of [a, b]) {
  fs.mkdirSync(path.join(d, ".git"), { recursive: true });
  fs.writeFileSync(path.join(d, "LEDGER.md"), "# 台账\n", "utf8");
  fs.writeFileSync(path.join(d, ".dsh-ledger.json"), JSON.stringify({ active: "LEDGER.md", archiveDir: "_a" }), "utf8");
}
fs.writeFileSync(path.join(ws, "AGENTS.md"), "# ws\n", "utf8");

const SID = "session-d3280001-0000-4000-8000-000000000000";
const agent = { session: { header: { id: SID, cwd: ws }, events: () => [] } };
const exec = { agent };
const lockTool = part4.defineLockTool();

const show = (t, r) => console.log(`  ${t}\n      → ${JSON.stringify(r).slice(0, 260)}`);

console.log("═══ 0. 前置 ═══");
console.log("   会话 cwd = " + ws);
console.log("   findWorkspaceRoot(ws) = " + (part2.findWorkspaceRoot(ws) ?? "(undefined)"));
console.log("   findWorkspaceRoot(a)  = " + (part2.findWorkspaceRoot(a) ?? "(undefined)"));

console.log("");
console.log("═══ 1. 锁到 proj-a ═══");
show("ledger_lock(root=<abs proj-a>)", await lockTool.execute({ root: a }, exec));
console.log("   lockedRootOf = " + (part1.lockedRootOf(agent) ?? "(无)"));

console.log("");
console.log("═══ 2. 锁着 proj-a 时切到兄弟项目 proj-b（F-01 的核心）═══");
show("ledger_lock(root=<abs proj-b>)", await lockTool.execute({ root: b }, exec));
show("ledger_lock(root=\"proj-b\")", await lockTool.execute({ root: "proj-b" }, exec));
show("ledger_lock(root=\"../proj-b\")", await lockTool.execute({ root: "../proj-b" }, exec));

console.log("");
console.log("═══ 3. 越界必须仍然被拦（不能为了修自囚把墙拆了）═══");
const outside = path.join(os.tmpdir(), "d328-outside-" + Date.now());
fs.mkdirSync(outside, { recursive: true });
show("ledger_lock(root=<abs outside>)", await lockTool.execute({ root: outside }, exec));
show("ledger_lock(root=\"../../../etc\")", await lockTool.execute({ root: "../../../etc" }, exec));

part1.setProjectLock(agent, undefined);
fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });
console.log("PROBE-COMPLETE");
