// D328：核 Gemini 010 的模块表是否对得上本仓库。
// ★ 010 §2 声称 index.js 1,683 B / base.js 25,213 B / defs.js 73,632 B / part4.js 253,118 B
//   —— 前三个与我历史实测差一个量级，必须逐项验。
import fs from "node:fs";
import path from "node:path";

// 010 §2 表（只抄它给的两列：行数、原始字节）
const R010 = {
  "index.js": [50, 1683],
  "base.js": [645, 25213],
  "defs.js": [1458, 73632],
  "gates.js": [216, 11454],
  "pure-ops.js": [280, 12188],
  "v3-conformance.js": [351, 15826],
  "manifest-mirror.js": [146, 6719],
  "log-collector.js": [886, 37058],
  "card-ops.js": [917, 38548],
  "client.js": [647, 25088],
  "settings-http.js": [731, 30023],
  "part1.js": [2718, 119652],
  "part2.js": [4619, 198274],
  "part3.js": [3907, 173275],
  "part4.js": [5489, 253118],
  "part5.js": [2005, 92002],
  "part6.js": [528, 24527],
  "part7.js": [747, 33225],
  "part8.js": [1073, 46356],
  "part8tool.js": [401, 18452],
};

const rows = [];
for (const [f, [rLines, rBytes]] of Object.entries(R010)) {
  // index.js 在根，其余在 lib/
  const p = f === "index.js" ? "index.js" : path.join("lib", f);
  if (!fs.existsSync(p)) {
    rows.push({ f, 实测: "文件不存在" });
    continue;
  }
  const buf = fs.readFileSync(p);
  const size = fs.statSync(p).size;
  let nl = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) nl++;
  rows.push({
    f,
    报告字节: rBytes,
    实测字节: size,
    字节差: size - rBytes,
    报告行: rLines,
    实测行: nl,
    行差: nl - rLines,
  });
}

console.log("模块\t报告字节\t实测字节\t字节差\t报告行\t实测行\t行差");
let hitB = 0, hitL = 0, n = 0;
for (const r of rows) {
  if (r.实测字节 === undefined) { console.log(r.f + "\t—\t" + r.实测 + "\t—"); continue; }
  n++;
  if (r.字节差 === 0) hitB++;
  if (r.行差 === 0) hitL++;
  console.log([r.f, r.报告字节, r.实测字节, r.字节差, r.报告行, r.实测行, r.行差].join("\t"));
}

console.log("");
console.log(`可比模块 = ${n}`);
console.log(`字节相符 = ${hitB} / ${n}`);
console.log(`行数相符 = ${hitL} / ${n}`);
console.log("");
console.log("★ lib/ 实际模块数 = " + fs.readdirSync("lib").filter((x) => x.endsWith(".js")).length);
console.log("★ 010 声称 19 个 lib 模块 + index.js");
console.log("");
// 关键几个单独点出来
for (const f of ["base.js", "defs.js", "part4.js"]) {
  const r = rows.find((x) => x.f === f);
  console.log(`  ${f}: 报告 ${r.报告字节} B / 实测 ${r.实测字节} B ⇒ 差 ${r.字节差} B（${((r.字节差 / r.报告字节) * 100).toFixed(0)}%）`);
}
console.log("PROBE-COMPLETE");
