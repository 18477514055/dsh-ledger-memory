// D328：F-02 的**正确**验证 —— 我第一版把「先夹到 max=240 再乘 scale」错标成「放大 12x」。
// 真相：clampNumber 先 `Math.min(hi, Math.max(lo, n0))`（hi=240，面板单位）
//       再 `* scale`（60000）⇒ 内部值 1,200,000 被夹到 240 ⇒ 14,400,000 = **240 分钟 = 4 小时**。
// 这**正好**是 010 说的「20 分钟变 4 小时」。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const part1 = await import(pathToFileURL(path.join(ROOT, "lib", "part1.js")).href);

const KEY = "triageOwedMaxAgeMs";
const SCALE = 60000;
const MAX_PANEL = 240;

console.log("═══ ① clampNumber 对「面板单位值」正常（一次换算）═══");
for (const panel of [5, 20, 60, 240, 999]) {
  const r = part1.clampNumber(KEY, panel);
  console.log(`  面板 ${panel} 分钟 → 内部 ${r.value} ms（${r.value / SCALE} 分钟）${r.clamped ? "  夹取:" + r.clamped : ""}`);
}

console.log("");
console.log("═══ ② 把**内部值**再喂回 clampNumber（= saveSettings 那条路）═══");
for (const panel of [5, 20, 60]) {
  const internal = panel * SCALE;
  const r = part1.clampNumber(KEY, internal); // 内部 ms 被当面板分钟喂进去
  const outMin = r.value / SCALE;
  console.log(
    `  面板 ${panel} 分钟 ⇒ 内部 ${internal} ms ⇒ 再归一化 ⇒ ${r.value} ms = **${outMin} 分钟**` +
      (outMin !== panel ? "  ← ⚠ 变了" : "")
  );
}

console.log("");
const twenty = part1.clampNumber(KEY, 20 * SCALE);
console.log(`★ 关键断言：20 分钟存一次就变成 ${twenty.value / SCALE} 分钟（010 说「变 4 小时」）`);
console.log(`★ 240 = 该项的 max ⇒ **这是「夹到上限」不是「等比放大」**（我第一版标 12x 是错的）`);
console.log(`★ 与 010 对照："20 分钟变 4 小时" ⇒ ${twenty.value / SCALE === 240 ? "**完全吻合**" : "不吻合"}`);
console.log("PROBE-COMPLETE");
