// D328：把 010 给 clampNumber 的那一行补丁**单独实现**，验它到底能不能做到幂等。
// 010 §3.2 声称：`clampNumber("triageOwedMaxAgeMs", 1200000)` 应幂等返回 1200000。
// 它的补丁行：
//   const rawNum = scale > 1 && isFinite(lo) && isFinite(hi) && v >= lo*scale && v <= hi*scale && v > hi
//     ? Number(v)/scale : Number(v);
// ★ 注意 `v <= hi*scale`：1200000 <= 240*60000 = 14,400,000 ⇒ 成立
//   且 `v > hi`：1200000 > 240 ⇒ 成立 ⇒ 除以 scale ⇒ 20 ⇒ 再乘 scale ⇒ 1200000 ✓（对这一个值成立）
// ★★ 但它对 **面板值** 也会误伤吗？面板 20 ⇒ v=20 ⇒ `v > hi(240)` 为假 ⇒ 不除 ⇒ 正确。
// ★★★ 真正要问的是：**这个判据能不能分清「面板值」与「内部值」**。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defs = await import(pathToFileURL(path.join(ROOT, "lib", "defs.js")).href);
const spec = (defs.SETTING_SPECS ?? []).find((s) => s.key === "triageOwedMaxAgeMs");
const scale = spec.scale;
const lo = spec.min;
const hi = spec.max;

/** 010 的补丁版 clampNumber（只改 rawNum 那一行）。 */
function clamp010(v) {
  const stepIsInt = Number.isInteger(spec.step);
  const rawNum =
    scale > 1 && Number.isFinite(lo) && Number.isFinite(hi) && v >= lo * scale && v <= hi * scale && v > hi
      ? Number(v) / scale
      : Number(v);
  const n0 = stepIsInt ? Math.round(rawNum) : rawNum;
  const n = Math.min(hi, Math.max(lo, n0));
  return n * scale;
}

/** 现行实现（未打 010 补丁）。 */
function clampNow(v) {
  const stepIsInt = Number.isInteger(spec.step);
  const n0 = stepIsInt ? Math.round(Number(v)) : Number(v);
  const n = Math.min(hi, Math.max(lo, n0));
  return n * scale;
}

console.log(`spec: scale=${scale} min=${lo} max=${hi} step=${spec.step}`);
console.log("");
console.log("═══ A. 面板值（用户填的分钟数）═══");
console.log("输入\t现行\t010补丁\t期望（=输入×scale）");
for (const p of [1, 5, 20, 60, 240]) {
  const want = p * scale;
  console.log(`${p}\t${clampNow(p)}\t${clamp010(p)}\t${want}\t${clamp010(p) === want ? "✓" : "✗"}`);
}
console.log("");
console.log("═══ B. 内部值（saveSettings 把 currentSettings 又喂回去）═══");
console.log("输入(ms)\t现行→分钟\t010补丁→分钟\t期望分钟");
let allGood = true;
for (const p of [1, 5, 20, 60, 240]) {
  const internal = p * scale;
  const nowMin = clampNow(internal) / scale;
  const fixMin = clamp010(internal) / scale;
  const ok = fixMin === p;
  if (!ok) allGood = false;
  console.log(`${internal}\t${nowMin}\t${fixMin}\t${p}\t${ok ? "✓" : "✗"}`);
}
console.log("");
console.log(allGood ? "⇒ ★ 010 的补丁**确实修好了**二次缩放（内部值幂等）" : "⇒ 010 的补丁**没修好**");
console.log("");
console.log("═══ C. 边界：乱填一个大数（面板单位）═══");
for (const p of [999, 100000]) {
  const want = Math.min(hi, Math.max(lo, p)) * scale;
  console.log(`面板 ${p} ⇒ 010补丁 ${clamp010(p)}（期望 ${want}）${clamp010(p) === want ? "✓" : "✗ 误当成内部值了"}`);
}
console.log("");
console.log("★ C 段是它这个判据的**真实弱点**：`v > hi` 把「面板填得比 max 还大」误判成内部值。");
console.log("PROBE-COMPLETE");
