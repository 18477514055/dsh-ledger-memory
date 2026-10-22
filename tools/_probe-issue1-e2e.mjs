// 端到端：真调 ledger_archive（走完整工具路径），复现 issue #1 的场景。
// ★ 只读之外唯一的写操作落在**临时目录**里，不碰生产工作区。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.resolve(import.meta.dirname, "..");
// ★ Windows 下动态 import 必须给 file:// URL，直接给 "D:\..." 会 ERR_UNSUPPORTED_ESM_URL_SCHEME
const mod = await import(pathToFileURL(path.join(HERE, "lib", "index.js")).href);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue1-e2e-"));

// 极简假 ctx（够模块 apply 用）
const run = { registeredTools: new Map(), ctx: undefined, services: {} };
const makeCtx = () => ({
  effect: () => {},
  on: () => {},
  inject: () => {},
  provide: () => {},
  tools: {
    register(def) {
      const name = typeof def === "string" ? def : def?.name;
      run.registeredTools.set(name, def);
    },
  },
  commands: { register() {} },
  logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  plugin: () => {},
  get: () => undefined,
  set: () => {},
});
run.ctx = makeCtx();
try { mod.apply(run.ctx, {}); } catch (e) { console.log("apply 抛出（可忽略）：", e.message); }

const REG = "## 变更登记（插件自动维护）";
const realLine = (t) => `- ${t} (append) [a5dd] +1 行 → 100 行 · revision→1`;

// 造一个有 4 个整节的台账
const body = ["# Ledger", ""];
for (let i = 0; i < 4; i++) {
  body.push(`## 八之${i}`, "");
  for (let j = 0; j < 6; j++) body.push(`- 条目 ${i}-${j}`, "");
  body.push("");
}
const ledgerText = body.join("\n").replace(/\s+$/, "") + `\n\n${REG}\n\n> 说明\n\n${realLine("2026-10-20 10:00:00")}\n`;
fs.writeFileSync(path.join(root, "LEDGER.md"), ledgerText, "utf8");
fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });
fs.writeFileSync(
  path.join(root, ".dsh-ledger.json"),
  JSON.stringify({ version: 1, active: "LEDGER.md", archiveDir: "_ledger-archive", maxActiveLines: 400, archiveWeekMode: "month", revision: 1 }, null, 2),
  "utf8"
);

const exec = { agent: { session: { header: { id: "session-issue0001-aaaa", cwd: root }, id: "session-issue0001-aaaa" } } };
const T = run.registeredTools;
console.log("工具表里有 ledger_archive：", T.has("ledger_archive"));

// 要归档「八之0」整节（6 条）
const entries = ["## 八之0", "", ...Array.from({ length: 6 }, (_, j) => `- 条目 0-${j}`)].join("\n");
// newActive = 剩下的（**保留变更登记区**，这正是触发 bug 的形状）
const newActive =
  ["# Ledger", "", ...body.slice(2).filter((l) => !l.includes("条目 0-")).filter((l) => l !== "## 八之0")]
    .join("\n")
    .replace(/\s+$/, "") + `\n\n${REG}\n\n> 说明\n\n${realLine("2026-10-20 10:00:00")}\n`;

console.log("\n── 调 ledger_archive（newActive 带变更登记区 —— issue 报的形状）──");
const r = await T.get("ledger_archive").execute({ entries, newActive, ifRevision: 1, label: "issue1 端到端" }, exec);
console.log(JSON.stringify(r, null, 2).slice(0, 1200));

if (r.ok === true) {
  const after = fs.readFileSync(path.join(root, "LEDGER.md"), "utf8");
  console.log("\n✅ 归档成功。新台账行数 =", after.replace(/\n$/, "").split("\n").length);
  console.log("   八之0 已移出：", !after.includes("条目 0-0"));
  console.log("   其余四节还在：", ["八之1", "八之2", "八之3"].every((h) => after.includes(`## ${h}`)));
  const arch = fs.readdirSync(path.join(root, "_ledger-archive"), { recursive: true }).filter((f) => String(f).endsWith(".md"));
  console.log("   归档文件：", arch);
  if (arch.length > 0) {
    const at = fs.readFileSync(path.join(root, "_ledger-archive", String(arch[0])), "utf8");
    console.log("   归档里含 6 条条目：", Array.from({ length: 6 }, (_, j) => at.includes(`条目 0-${j}`)).every(Boolean));
  }
} else {
  console.log("\n❌ 仍是失败（若 lostLines>0 就是 bug 还在）");
}

fs.rmSync(root, { recursive: true, force: true });
console.log("\n临时目录已清理：", root);
