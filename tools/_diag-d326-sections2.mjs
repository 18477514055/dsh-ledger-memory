// ★ 修正口径：正式判据是 `^\s*section\(`（**允许缩进**，情形 50/51/52/53 就是缩进写的）。
//   我上一个 diag 用了 `^section\(` ⇒ 只数到 98/96，而台账与情形 43 记的是 113/112。
//   这不是台账错，是**我又用错了一次尺子**（纪律 #2 同型：判据只吃被测对象的那部分文本，
//   而"那部分"包括被缩进包裹的那些）。
import fs from "node:fs";

const s = fs.readFileSync("tools/selftest.mjs", "utf8");
const defCount = (s.match(/^function section\(/gm) ?? []).length;
const calls = (s.match(/^\s*section\(/gm) ?? []).length;
const numbered = (s.match(/^\s*section\("情形\s*[0-9]/gm) ?? []).length;
const nums = [...s.matchAll(/^\s*section\("情形\s*([0-9]+)/gm)].map((m) => Number(m[1]));

console.log("`function section(` 定义处数 = " + defCount + "（应为 1，且不该被计入调用）");
console.log("`^\\s*section\\(` 调用总数 = " + calls);
console.log("带编号「情形 N」= " + numbered);
console.log("最大编号 = " + Math.max(...nums));
console.log('真有 section("情形 123")：' + /^\s*section\("情形\s*123/m.test(s));
console.log("");
console.log("对照：我上一个 diag 用 `^section\\(` 得到 98 / 96 ⇒ 差 " + (calls - 98) + " 全是缩进写的");
console.log("PROBE-COMPLETE");
