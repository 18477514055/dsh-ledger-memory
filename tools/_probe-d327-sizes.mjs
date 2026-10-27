// D327：与 Gemini 009 §2 体积表逐项对账。
// ★ 判据：009 声明的**基线**应是 4015f11（它自己写的快照），补后应是 1,959,418。
import fs from "node:fs";
import path from "node:path";

const LIB = "lib";

// 009 §2 表：模块 -> [基线字节, 补后字节, 基线行数, 补后行数]
const R = {
  "base.js": [26122, 26122, 525, 525],
  "card-ops.js": [45014, 45014, 839, 839],
  "client.js": [121198, 121198, 2439, 2439],
  "defs.js": [227128, 227143, 3870, 3870],
  "gates.js": [9031, 9031, 144, 144],
  "index.js": [146983, 146983, 2054, 2054],
  "log-collector.js": [16904, 16904, 334, 334],
  "manifest-mirror.js": [13720, 13720, 237, 237],
  "part1.js": [233825, 234011, 4339, 4340],
  "part2.js": [236861, 237439, 4465, 4478],
  "part3.js": [243885, 243820, 3807, 3805],
  "part4.js": [253727, 253118, 4260, 4263],
  "part5.js": [171096, 171140, 3008, 3008],
  "part6.js": [59562, 59562, 932, 932],
  "part7.js": [34147, 34147, 642, 642],
  "part8.js": [51265, 51265, 1077, 1077],
  "part8tool.js": [6998, 6998, 161, 161],
  "pure-ops.js": [7494, 7494, 142, 142],
  "settings-http.js": [31249, 31249, 679, 679],
  "v3-conformance.js": [23060, 23060, 325, 325],
};

const files = fs.readdirSync(LIB).filter((f) => f.endsWith(".js")).sort();
let totalB = 0;
let totalL = 0;
let missB = [];
let missL = [];
const CAP = 262144;

console.log("模块\t实测字节\t009基线\t差\t实测行(wc)\t009基线行\t差");
for (const f of files) {
  const buf = fs.readFileSync(path.join(LIB, f));
  const size = fs.statSync(path.join(LIB, f)).size;
  let nl = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) nl++;
  totalB += size;
  totalL += nl;
  const r = R[f];
  const db = r === undefined ? "缺" : String(size - r[0]);
  const dl = r === undefined ? "缺" : String(nl - r[2]);
  if (r === undefined || size !== r[0]) missB.push(f + ":" + db);
  if (r === undefined || nl !== r[2]) missL.push(f + ":" + dl);
  console.log([f, size, r ? r[0] : "缺", db, nl, r ? r[2] : "缺", dl].join("\t"));
}

console.log("");
console.log("模块数 = " + files.length);
console.log("实测字节合计 = " + totalB + "（009 声明基线 1,959,269 ⇒ 差 " + (totalB - 1959269) + "）");
console.log("实测行数合计(wc -l) = " + totalL + "（009 声明基线 34,279 ⇒ 差 " + (totalL - 34279) + "）");
console.log("字节不符项：" + (missB.length === 0 ? "无" : missB.join(", ")));
console.log("行数不符项：" + (missL.length === 0 ? "无" : missL.join(", ")));
console.log("");
const thin = files
  .map((f) => ({ f, left: CAP - fs.statSync(path.join(LIB, f)).size }))
  .sort((a, b) => a.left - b.left)
  .slice(0, 4);
console.log("距上限最近 4 个：");
for (const t of thin) console.log("  " + t.f + " 余 " + t.left + " B");
console.log("");
console.log("★ 009 声称补丁让 part4 净降 609 B、余量扩到 9,026 B —— 待应用后复算");
console.log("PROBE-COMPLETE");
