// D326：复算 lib/ 全部模块的真实字节数与行数，与 Gemini 008 报告 §2 体积表逐项对账。
// 判据纪律：字节数用 fs.statSync().size（不看 package 也不看报告）；行数用换行符计数。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const libDir = path.join(root, "lib");

const files = fs.readdirSync(libDir).filter((f) => f.endsWith(".js")).sort();

const rows = [];
let totalB = 0;
let totalL = 0;
for (const f of files) {
  const p = path.join(libDir, f);
  const buf = fs.readFileSync(p);
  const size = fs.statSync(p).size;
  let nl = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) nl++;
  // wc -l 语义：换行符个数；文本文件末尾若无换行则行数 = nl + 1
  const wcL = nl;
  rows.push({ f, size, bytes: buf.length, wcL });
  totalB += size;
  totalL += wcL;
}

// 008 报告声明的基线字节（§2 表「基线字节数」列）
const REPORT = {
  "base.js": 26122,
  "card-ops.js": 45014,
  "client.js": 121198,
  "defs.js": 227128,
  "gates.js": 9031,
  "index.js": 146983,
  "log-collector.js": 16904,
  "manifest-mirror.js": 13720,
  "part1.js": 233825,
  "part2.js": 235982,
  "part3.js": 243885,
  "part4.js": 253475,
  "part5.js": 169652,
  "part6.js": 59562,
  "part7.js": 33412,
  "part8.js": 51265,
  "part8tool.js": 6998,
  "pure-ops.js": 7494,
  "settings-http.js": 31249,
  "v3-conformance.js": 23060,
};
const REPORT_LINES = {
  "base.js": 525, "card-ops.js": 839, "client.js": 2439, "defs.js": 3871,
  "gates.js": 144, "index.js": 2054, "log-collector.js": 334, "manifest-mirror.js": 237,
  "part1.js": 4340, "part2.js": 4456, "part3.js": 3808, "part4.js": 4257,
  "part5.js": 2978, "part6.js": 932, "part7.js": 627, "part8.js": 1077,
  "part8tool.js": 161, "pure-ops.js": 142, "settings-http.js": 679, "v3-conformance.js": 325,
};

let pass = 0;
let fail = 0;
const ok = (t, c) => {
  if (typeof c !== "boolean") throw new TypeError("ok() 第二个参数必须是布尔：" + t);
  if (c) { pass++; console.log("PASS  " + t); } else { fail++; console.log("FAIL  " + t); }
};

console.log("== 实测（lib/ 全部 .js） ==");
console.log("模块数 = " + files.length);
console.log("字节合计 = " + totalB);
console.log("行数合计（wc -l 语义）= " + totalL);
console.log("");

console.log("== 逐项对账（实测 vs 008 §2 基线） ==");
console.log("模块\t实测字节\t报告字节\t差\t实测行\t报告行\t差");
const missB = [];
const missL = [];
for (const r of rows) {
  const rb = REPORT[r.f];
  const rl = REPORT_LINES[r.f];
  const db = rb === undefined ? "缺" : String(r.size - rb);
  const dl = rl === undefined ? "缺" : String(r.wcL - rl);
  if (rb === undefined || r.size !== rb) missB.push(r.f + ":" + db);
  if (rl === undefined || r.wcL !== rl) missL.push(r.f + ":" + dl);
  console.log([r.f, r.size, rb ?? "缺", db, r.wcL, rl ?? "缺", dl].join("\t"));
}
console.log("");
console.log("字节不符项：" + (missB.length === 0 ? "无" : missB.join(", ")));
console.log("行数不符项：" + (missL.length === 0 ? "无" : missL.join(", ")));
console.log("");

ok("模块数 = 20", files.length === 20);
ok("字节合计 = 1,955,959（008 声明基线合计）", totalB === 1955959);
ok("行数合计 = 34,245（008 声明基线合计）", totalL === 34245);
ok("20 个模块的基线字节逐项全对", missB.length === 0);
ok("20 个模块的基线行数逐项全对", missL.length === 0);

// 余量
const CAP = 262144;
const thin = rows.map((r) => ({ f: r.f, left: CAP - r.size })).sort((a, b) => a.left - b.left).slice(0, 5);
console.log("");
console.log("== 距 262,144 B 上限最近的 5 个 ==");
for (const t of thin) console.log("  " + t.f + "  余 " + t.left + " B");
ok("最薄的是 part4.js", thin[0].f === "part4.js");
ok("part4.js 余量 = 8,669 B（008 说补前 8,669）", thin[0].left === 8669);

console.log("");
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
