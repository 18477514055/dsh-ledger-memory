// ★ 验证「onlyB=2 是不是纯粹由口径同步引起」：
//   在**补丁后的副本**里把台账第 84 行的 115/114 改成 117/116，再跑一次自检。
//   若 FAIL 归零 ⇒ 那两条红是情形 43 在**正确报警**（补丁新增了 127/128 两个 section，
//   而台账没跟上），不是补丁引入的缺陷。
//   ★ 本脚本只改 %TEMP% 副本，**不碰生产**。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const B = process.argv[2];
if (!B || !fs.existsSync(B)) {
  console.log("用法：node _diag-d335-countfix.mjs <补丁后副本目录>");
  process.exit(1);
}
const led = path.join(B, "10.项目台账-ledger-memory", "LEDGER.md");
let text = fs.readFileSync(led, "utf8");
const before = (text.match(/\| 情形组 \|.*$/m) ?? [""])[0];
console.log("改前：", before.slice(0, 160));

// 只改那一行的 115→117、114→116（定点，不整份重写其它内容）
text = text.replace(
  /(\| 情形组 \| `section\(` 总数 \*\*)115(\*\*（含「模块契约」）· 带编号「情形 N」= \*\*)114(\*\*)/,
  "$1117$2116$3",
);
const after = (text.match(/\| 情形组 \|.*$/m) ?? [""])[0];
console.log("改后：", after.slice(0, 160));
if (after === before) {
  console.log("❌ 定点替换没命中 —— 台账形状变了，先看清再改");
  process.exit(1);
}
fs.writeFileSync(led, text);

console.log("\n=== 重跑自检 ===");
let out = "";
try {
  out = execFileSync("node", ["tools/selftest.mjs"], {
    cwd: B,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NO_PROXY: "github.com" },
  });
} catch (e) {
  out = String(e.stdout || "");
}
const summary = (out.match(/合计：PASS\s+\d+\s+·\s+SKIP\s+\d+\s+·\s+FAIL\s+\d+/g) || []).pop() ?? "(无汇总)";
const fails = [...out.matchAll(/^\s*FAIL\s+(.+)$/gm)].map((m) => m[1].trim());
console.log(`  ${summary}`);
for (const f of fails) console.log(`    FAIL  ${f.slice(0, 140)}`);
console.log(
  fails.length === 0
    ? "\nPROBE-COMPLETE  ✅ 改口径后 FAIL 归零 ⇒ 那两条红是情形 43 正确报警，不是补丁回归"
    : `\nPROBE-COMPLETE  ⚠️ 仍有 ${fails.length} 条红 ⇒ 需要另查`,
);
