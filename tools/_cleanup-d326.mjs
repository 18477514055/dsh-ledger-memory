// D326 收尾：清理本轮产生、但**不该留在仓库里**的中间脚本。
//   ★ 判据：保留「能被复用/能被复跑当判据」的；删掉「一次性诊断用完就没用」的。
//   ★ 必须逐个点名（绝不 glob 删），且删前打印清单。
import fs from "node:fs";
import path from "node:path";

const DIR = "tools";

// ── 保留（能被复跑当判据 / 反向验证依赖它）──────────────────────────────
const KEEP = [
  "_probe-d326-008-fixes.mjs",     // 35/0 行为验证
  "_reverse-verify-d326.mjs",      // 12 破坏点，依赖上面那个
  "_probe-d326-sizes.mjs",         // 体积/行数对账（下次报告可复用）
  "_diag-d326-bindings.mjs",       // 「名字有没有绑定」的判据（#37 的产物，可复用）
  "_diag-d326-sections2.mjs",      // 正确的口径数法（113/112）
  "_condense-d326.mjs",            // 台账瘦身脚本（D324/D325 也各留了一个，同惯例）
];

// ── 删掉（一次性排查，已被上面的取代）──────────────────────────────────
const DROP = [
  "_diag-d326-imports.mjs",   // 尺子错 #37 的错误版本，留着会污染自发现的探针扫描
  "_diag-d326-lines.mjs",     // 行数口径排查的中间步骤
  "_diag-d326-lines2.mjs",    // 同上
  "_diag-d326-sections.mjs",  // 尺子错：用 ^section( 漏了缩进的
  "_fix-d326-probe-sid.mjs",  // 一次性批量替换脚本
];

let removed = 0;
for (const f of DROP) {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) {
    console.log("（已不存在）" + f);
    continue;
  }
  const n = fs.statSync(p).size;
  fs.rmSync(p);
  console.log("已删 " + f + "（" + n + " B）");
  removed += 1;
}
console.log("");
console.log("保留：");
for (const f of KEEP) console.log("  " + f + (fs.existsSync(path.join(DIR, f)) ? "" : "  ⚠ 不存在"));
console.log("");
console.log("删除 " + removed + " 个");
console.log("PROBE-COMPLETE");
