// D328：核 010 F-02 —— 带 scale 的设置项真的会被二次缩放吗？
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defs = await import(pathToFileURL(path.join(ROOT, "lib", "defs.js")).href);
const part1 = await import(pathToFileURL(path.join(ROOT, "lib", "part1.js")).href);

const specs = defs.SETTING_SPECS ?? [];
const scaled = specs.filter((s) => Number.isFinite(s.scale) && s.scale !== 1);
console.log("设置项总数 = " + specs.length);
console.log("带非 1 scale 的 = " + scaled.length);
for (const s of scaled) {
  console.log(`  ${s.key}  scale=${s.scale}  min=${s.min}  max=${s.max}  step=${s.step}`);
}
console.log("");

// 逐项验「二次缩放」：把内部单位值再喂回 clampNumber
let bug = 0;
for (const s of scaled) {
  const internal = 20 * 60 * 1000; // 假设内部是毫秒（20 分钟）
  const panelUnit = internal / s.scale; // 面板单位 = 20
  const once = part1.clampNumber(s.key, panelUnit); // 正常：面板值 → 内部
  const twice = part1.clampNumber(s.key, once.value); // 二次缩放：内部值又当面板值喂进去
  const ratio = once.value === 0 ? NaN : twice.value / once.value;
  const isBug = Math.abs(ratio - s.scale) < 1e-9;
  if (isBug) bug += 1;
  console.log(
    `${s.key}: 面板值 ${panelUnit} →(一次) ${once.value} →(二次) ${twice.value}　放大 ${ratio}x ${isBug ? "← ⚠ 二次缩放确认" : ""}`
  );
}
console.log("");
console.log(bug > 0 ? `⇒ ★ 二次缩放**属实**：${bug} 项会被再乘一次 scale` : "⇒ 二次缩放**不成立**（clampNumber 是幂等的）");
console.log("PROBE-COMPLETE");
