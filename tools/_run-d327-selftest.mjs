// D327：用 Node 自己跑 selftest 并数数。
// ★★★ 为什么必须这样：PowerShell 的 `>` 会把输出写成 **UTF-16**
//   ⇒ Node 按 utf8 读回来全是 \x00 交错 ⇒ 一条都数不到。
//   台账《其他硬规矩》里**早就写着**「PowerShell 会写成 UTF-16」——
//   我又踩了一次（尺子错 #46）。凡是要落盘给 Node 读的输出，一律走 Node 自己写。
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const r = spawnSync(process.execPath, ["tools/selftest.mjs"], {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
fs.writeFileSync("_tmp-d327-selftest.txt", out, "utf8");

const lines = out.split(/\r?\n/);
const pass = lines.filter((l) => /^\s*PASS\s/.test(l));
const skip = lines.filter((l) => /^\s*SKIP\s/.test(l));
const fail = lines.filter((l) => /^\s*FAIL\s/.test(l));
const sum = lines.find((l) => /合计：PASS/.test(l)) ?? "(找不到合计行)";

console.log("exit = " + r.status);
console.log("PASS 行数 = " + pass.length);
console.log("SKIP 行数 = " + skip.length);
console.log("FAIL 行数 = " + fail.length);
console.log("合计行    = " + sum.trim());
console.log("");
console.log("SKIP 明细：");
for (const l of skip) console.log("  " + l.trim().slice(0, 150));
console.log("");
console.log("对照 009 报的 PASS 2272 / SKIP 1：");
console.log("  PASS 差 = " + (pass.length - 2272) + "　SKIP 差 = " + (skip.length - 1));
console.log("输出已存 → _tmp-d327-selftest.txt（" + out.length + " 字符）");
console.log("PROBE-COMPLETE");
