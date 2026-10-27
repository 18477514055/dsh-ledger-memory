// D330：核 Gemini 011 的 §2.1 模块体积表 —— 它报的「修补前」是否等于我盘的现状。
// ★ 判据（D328 立的）：报告的数字要么对得上当前盘、要么对得上某个历史版本；
//   两者都够不着 ⇒ 是编的（不是"另一份快照"）。
// 本脚本只读，不改任何文件。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(ROOT, "lib");

// 报告 §2.1 报的「修补前 / 修补后」
const REPORTED = {
  "base.js": [26122, 26122],
  "card-ops.js": [45014, 45014],
  "client.js": [121198, 121198],
  "defs.js": [227688, 227688],
  "gates.js": [9031, 9031],
  "index.js": [146983, 147564],
  "log-collector.js": [16904, 16904],
  "manifest-mirror.js": [13720, 13720],
  "part1.js": [235968, 236368],
  "part2.js": [237436, 238833],
  "part3.js": [244878, 246278],
  "part4.js": [233736, 235519],
  "part5.js": [172258, 172621],
  "part6.js": [59562, 59664],
  "part7.js": [34147, 34332],
  "part8.js": [53616, 53616],
  "part8tool.js": [6998, 6998],
  "pure-ops.js": [7494, 7494],
  "settings-http.js": [33799, 33799],
  "v3-conformance.js": [23060, 23060],
  "workspace-tools.js": [25563, 25606],
};

const HARD = 262144;
const rows = [];
let preMatch = 0;
let preMiss = 0;

for (const f of fs.readdirSync(LIB).sort()) {
  if (!f.endsWith(".js")) continue;
  const real = fs.statSync(path.join(LIB, f)).size;
  const rep = REPORTED[f];
  const pre = rep === undefined ? undefined : rep[0];
  const same = pre === real;
  if (rep === undefined) {
    rows.push({ f, real, pre: "(报告未列)", same: "—" });
    continue;
  }
  if (same) preMatch += 1;
  else preMiss += 1;
  rows.push({ f, real, pre, delta: real - pre, same: same ? "✓ 相符" : "✗ 不符" });
}

console.log("文件".padEnd(24) + "盘上实际".padStart(10) + "报告说修补前".padStart(14) + "差".padStart(10) + "  判定");
for (const r of rows) {
  console.log(
    r.f.padEnd(24) +
      String(r.real).padStart(10) +
      String(r.pre).padStart(14) +
      String(r.delta ?? "").padStart(10) +
      "  " + r.same
  );
}

console.log("");
console.log(`报告列了 ${Object.keys(REPORTED).length} 项 · 盘上实测 ${rows.filter((r) => r.pre !== "(报告未列)").length} 项可比`);
console.log(`「修补前」与当前盘相符：${preMatch} 项 · 不符：${preMiss} 项`);

// 关键：报告说修补后 part2 = 238,833 —— 那它声称有个「修补后」的文件，验一下是否超红线
console.log("");
console.log("═══ 报告 §2.1 声称的「修补后」体积 vs 本项目红线（253,952 = 262,144−8,192）═══");
let overRed = 0;
for (const [f, [, post]] of Object.entries(REPORTED)) {
  const red = 253952;
  if (post > red) {
    overRed += 1;
    console.log(`  ✗ ${f} 修补后 ${post} B 已破 8 KiB 红线（余 ${red - post}）`);
  }
}
console.log(overRed === 0 ? "  报告自己报的修补后体积都在红线内" : `  有 ${overRed} 项破线`);

console.log("");
console.log("PROBE-COMPLETE");
