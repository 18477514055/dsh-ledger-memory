// D225 反向验证：把台账头部「真正生效的行数上限」那句**真的删掉**，
// 断言那条新守卫**必须红**（而不是我看它写得像就信）。
// ★ 只在内存里改、跑完立刻还原（绝不留改动在盘上）。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const LEDGER = path.join(ROOT, "LEDGER.md");
const TARGET = "> ★★★ **真正生效的行数上限**";

const original = fs.readFileSync(LEDGER, "utf8");
const idx = original.indexOf(TARGET);
if (idx < 0) {
  console.error("★ 夹具故障：没找到要摘的那句（不是结论）");
  process.exit(2);
}
const lineEnd = original.indexOf("\n", idx);
const degraded = original.slice(0, idx) + original.slice(lineEnd + 1);
console.log(`  摘掉 ${lineEnd - idx} 个字符（那一整行）`);

let out = "";
try {
  fs.writeFileSync(LEDGER, degraded, "utf8");
  out = execFileSync(process.execPath, [path.join(HERE, "selftest.mjs")], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = String(e.stdout ?? "") + String(e.stderr ?? "");
} finally {
  fs.writeFileSync(LEDGER, original, "utf8"); // ★ 无条件还原
  const back = fs.readFileSync(LEDGER, "utf8") === original;
  console.log(`  已还原：${back ? "是" : "★ 否 —— 立刻人工检查！"}`);
}

// ★ 必须同时断言「自检真跑完了」—— 崩了与全绿长得一样（L34）
const done = /通过\s+(-?\d+)\s+项，失败\s+(\d+)\s+项/.exec(out);
if (done === null) {
  console.log("  ❌ 自检**没有跑完**（没解析到总结行）⇒ 这次反向验证无效，不是结论");
  console.log(out.slice(-600));
  process.exit(2);
}
const pass = Number(done[1]);
const fail = Number(done[2]);
console.log(`  自检跑完：通过 ${pass} 项 / 失败 ${fail} 项`);

const hit = /口径：台账头部\*\*必须声明「真正生效」的那个上限\*\*[^\n]*/.exec(out);
const sawRed = out.includes("FAIL") && /必须声明「真正生效」/.test(out);
console.log("");
console.log(`  ${sawRed ? "✅ 见红" : "❌ 没红"} —— 摘掉那句话后，那条守卫${sawRed ? "确实报红" : "仍然全绿（=断言是空的！）"}`);
if (hit !== null) console.log(`  报红原文：${hit[0].trim().slice(0, 120)}`);
console.log(`  ★ 前提：自检确实跑完了（通过 ${pass}）⇒ 这不是"崩了"伪装成的"没红"`);
process.exit(sawRed ? 0 : 1);
