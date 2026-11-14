/**
 * D368 切分后的**真实验证**：不是"文件能解析"，而是"工具真能用"。
 *
 * ★★★ 本项目纪律：**"文件存在 / 模块可解析"一律不构成"能用"的证据。**
 *   所以这里真调 `defineInitTool()` 拿到的工具对象，真跑一次 `ledger_init`，
 *   再核对磁盘上真的建出了台账结构。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const part4 = await import("../lib/part4.js");
const part8 = await import("../lib/part8.js");
const index = await import("../lib/index.js");

let pass = 0;
let fail = 0;
const rows = [];
const ok = (t, c, d) => {
  if (c) { pass += 1; rows.push(`PASS  ${t}${d === undefined ? "" : ` — ${d}`}`); }
  else { fail += 1; rows.push(`FAIL  ${t}${d === undefined ? "" : ` — ${d}`}`); }
};

// ① part4 仍能拿到 defineInitTool（re-export 生效）
ok("① part4.defineInitTool 仍是函数（re-export 生效）", typeof part4.defineInitTool === "function", typeof part4.defineInitTool);

// ② index.js 仍能整体加载（import 图没被切坏）
ok("② index.js 能加载且导出 apply", typeof index.apply === "function", typeof index.apply);

// ③ 工具对象形状正确
const tool = part4.defineInitTool();
ok("③ 工具名 = ledger_init", tool?.name === "ledger_init", String(tool?.name));
ok("③ b 有 execute", typeof tool?.execute === "function", typeof tool?.execute);
ok("③ c logLevels Schema 含 L4（D367 修的那条没在搬家中丢失）", tool?.parameters?.properties?.logLevels?.properties?.L4?.type === "boolean", JSON.stringify(Object.keys(tool?.parameters?.properties?.logLevels?.properties ?? {})));

// ④ 与 init-tool.js 直接取到的是同一个实现
const initTool = await import("../lib/init-tool.js");
ok("④ init-tool.js 也导出 defineInitTool 且与 part4 的一致", typeof initTool.defineInitTool === "function" && initTool.defineInitTool === part4.defineInitTool, String(initTool.defineInitTool === part4.defineInitTool));

// ⑤ ★★ 真跑一次 ledger_init：磁盘上必须真建出台账结构
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "d368-init-"));
  const exec = { agent: { session: { header: { id: "d368", cwd: root } } } };
  let res;
  try {
    res = await tool.execute(
      {
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_ledger-archive",
        journal: "JOURNAL.md",
        gitInit: false,
        initialActive: "# 台账\n\n- 第一条\n",
      },
      exec,
    );
  } catch (e) {
    res = { threw: String(e?.message ?? e) };
  }
  const manifestPath = path.join(root, ".dsh-ledger.json");
  const hasManifest = fs.existsSync(manifestPath);
  // ★★★ 夹具修正（本轮第五次栽在夹具上）：V3 会把记忆**下沉到子目录**，
  //   台账实际在 `<root>/<memoryRoot>/LEDGER.md`，不在 `<root>/LEDGER.md`。
  //   → 上一版我按 V2 的位置去找 ⇒ 假红（而 ⑤b/⑤c 都是绿的，说明 init 本身成功）。
  //   ★ 判据：**返回里有 memoryRoot 就必须用它**，不许假设 V2 布局。
  const memDir = typeof res?.memoryRoot === "string" ? path.join(root, res.memoryRoot) : root;
  const ledgerPath = path.join(memDir, "LEDGER.md");
  const hasLedger = fs.existsSync(ledgerPath);
  let manifest = null;
  if (hasManifest) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { manifest = null; }
  }
  ok("⑤ 真跑 ledger_init 返回 ok", res?.ok === true, JSON.stringify(res)?.slice(0, 220));
  ok("⑤ b 磁盘上真的建出了 .dsh-ledger.json", hasManifest, manifestPath);
  ok("⑤ c 清单里真的有 active = LEDGER.md", manifest?.active === "LEDGER.md", String(manifest?.active));
  ok("⑤ d 磁盘上真的建出了 LEDGER.md（V3 ⇒ 在 memoryRoot 里）", hasLedger, ledgerPath);
  if (hasLedger) {
    const t = fs.readFileSync(ledgerPath, "utf8");
    ok("⑤ e LEDGER.md 里有我传的初始内容", t.includes("第一条"), JSON.stringify(t.slice(0, 80)));
  }
  fs.rmSync(root, { recursive: true, force: true });
}

// ⑥ 搬家后 part4 自己仍能导出其余 16 个（一个都没丢）
const EXPECT = [
  "repairConformance", "migrationSignals", "detectMigration", "defineMigrateTool", "defineInitTool",
  "defineConformTool", "defineReadTool", "defineIndexTool", "defineWriteTool", "writeLedger",
  "defineArchiveTool", "archiveLedger", "appendAudit", "logFileList", "normTime", "aggregateFiles", "logRead",
];
const missing = EXPECT.filter((n) => typeof part4[n] !== "function");
ok("⑥ part4 的 17 个导出一个都没丢", missing.length === 0, missing.join(",") || "全在");

console.log(rows.join("\n"));
console.log("─".repeat(70));
console.log(`合计：PASS ${pass} · FAIL ${fail}`);
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
