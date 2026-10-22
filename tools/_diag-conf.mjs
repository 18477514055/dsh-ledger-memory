// 看：一个"手工写清单、已合规"的夹具，现在为什么被判 nonconforming。
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { conformanceOf, inspect } from "../lib/part2.js";
import { protocolGapOf } from "../lib/defs.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-conf-"));
// 造一个"看起来完全合规"的项目：有台账 + 决策记录 + 归档
fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n- 一条\n", "utf8");
fs.writeFileSync(path.join(root, "DECISIONS.md"), "# 决策\n\n- D1 某事\n", "utf8");
fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });
// ★ 刻意**不写** protocolVersion（模拟老项目 / 手工夹具）
fs.writeFileSync(
  path.join(root, ".dsh-ledger.json"),
  JSON.stringify(
    {
      version: 1,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_ledger-archive",
      maxActiveLines: 400,
      revision: 3,
    },
    null,
    2
  ) + "\n",
  "utf8"
);

const info = inspect(root);
const conf = conformanceOf(info);
console.log("verdict:", conf.verdict);
console.log("reasons:");
for (const r of conf.reasons) console.log("  ·", r);
console.log("needsAI:");
for (const r of conf.needsAI) console.log("  ·", r);
console.log("fixable:");
for (const r of conf.fixable) console.log("  ·", r);
console.log("\nprotocolGapOf:", JSON.stringify(protocolGapOf(info.manifest)));

fs.rmSync(root, { recursive: true, force: true });
