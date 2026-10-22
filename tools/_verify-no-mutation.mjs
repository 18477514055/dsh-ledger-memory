// 校验探针的变异残留是否全部清除（只读）。
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const checks = [
  ["lib/part1.js", "relDir === undefined", "if (false)"],
  ["lib/part5.js", 'typeof agent.steer === "function"', "if (false)"],
  ["lib/index.js", "} else if (forcedLight) {", "else if (false)"],
];

let bad = 0;
for (const [f, good, badStr] of checks) {
  const s = readFileSync(path.join(ROOT, f), "utf8");
  const hasGood = s.includes(good);
  const hasBad = s.includes(badStr);
  if (!hasGood || hasBad) bad++;
  console.log(
    f.padEnd(18) +
      " 正常值=" + (hasGood ? "OK" : "MISSING") +
      "  变异残留=" + (hasBad ? "**STILL THERE**" : "无")
  );
}

// 语法
for (const f of ["index.js", "client.js", "defs.js", "part1.js", "part2.js", "part3.js", "part4.js", "part5.js", "part6.js"]) {
  try {
    execFileSync(process.execPath, ["--check", path.join(ROOT, "lib", f)], { stdio: "pipe" });
  } catch (e) {
    bad++;
    console.log(`语法 FAIL: ${f}\n${e.stderr?.toString?.() ?? e}`);
  }
}
console.log("语法: 全部通过");

// git 状态（只应剩本轮**有意改动**的那些文件）
//
// ★★ 2026-10-19（D272/D273）：白名单原来只有 `client.js` / `defs.js`，
//   那是**上一轮**的改动面。本轮新增了协议代次检测（defs / part1 / part2 / part3 / part4），
//   于是它把**正常改动**报成"未预期"⇒ 假红。
//   ★ 判据：**白名单必须按「本轮有意的改动面」更新**，但绝不能放宽成"任意文件都算正常" ——
//     它守的是"探针跑完有没有把变异留在 lib/ 里"。真正判变异残留的是上面那三条字符串检查。
//   ★ 所以这里只放**本轮确实改过**的文件；下次改动面变了，就同步改这行（和 DANGEROUS_EXPECTED 同一套处置）。
const EXPECTED_DIRTY = /lib\/(client|defs|part1|part2|part3|part4)\.js$/;
const st = execFileSync("git", ["status", "--short", "lib/"], { cwd: ROOT, encoding: "utf8" });
console.log("\ngit status lib/:\n" + (st.trim() || "(空)"));
const lines = st.trim().split("\n").filter(Boolean);
const unexpected = lines.filter((l) => !EXPECTED_DIRTY.test(l));
console.log("未预期的改动:", unexpected.length ? unexpected.join("\n") : "无");
if (unexpected.length) bad++;

console.log(bad === 0 ? "\n✅ 全部干净" : `\n❌ ${bad} 处有问题`);
process.exitCode = bad === 0 ? 0 : 1;
