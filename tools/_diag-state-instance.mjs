/**
 * 只读诊断：`__test.setDeltaForce` 写的 state，与 pre-step 读的 state **是不是同一个**。
 *
 * ★ 症状：22c-4 的核心断言（AI 未落盘 ⇒ 不许压）**通过**了，
 *   但"落盘后放行""人按的豁免"两条**失败** ⇒ 像是旗子/状态只生效了一次。
 *   ★ 最可疑的假设：`makeCtx` + `mod.apply` 建了**多个 state 实例**，
 *     而我挂的 `latestStateForTest` 只指向**最后一个** ⇒ 写进去的旗子
 *     与 pre-step 真正读的那个不是同一个对象。
 */
import fs from "node:fs";

const p = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账\\lib\\index.js";
const src = fs.readFileSync(p, "utf8");

console.log("=== newState() 被调用几处 ===");
src.split("\n").forEach((t, i) => {
  if (/newState\(\)/.test(t)) console.log(`  ${i + 1}: ${t.trim().slice(0, 140)}`);
});

console.log("\n=== latestStateForTest 的读写处 ===");
src.split("\n").forEach((t, i) => {
  if (/latestStateForTest/.test(t)) console.log(`  ${i + 1}: ${t.trim().slice(0, 140)}`);
});

console.log("\n=== `apply(` 是否每次都会建新 state ===");
const lines = src.split("\n");
lines.forEach((t, i) => {
  if (/^export (?:function|const) apply|function apply\(|apply\s*\(ctx/.test(t)) {
    console.log(`  ${i + 1}: ${t.trim().slice(0, 140)}`);
  }
});
