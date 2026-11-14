/**
 * 只读探针（D383）：`compactLineReport` 的**三种渠道形态**必须各算对。
 *
 * 为什么要有它：这个函数是"面板线 vs 内核线"的**唯一出处**，
 * 它算错的表现不是报错，而是**默默把压缩频率改掉**（用户特意提过"别压太勤"）。
 * ⇒ 必须把三类真实数字钉死，任何一类变了当场见红。
 */
import { compactLineReport } from "../lib/gates.js";

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra === undefined ? "" : " → " + extra}`);
  }
};

const W = 1000000;
const LINE = 0.7;

// ① 本机 opencode-go：maxTokens 384,000 ⇒ 内核线 55.05%，我们那条 70% 走不到
const a = compactLineReport({ window: W, maxTokens: 384000 }, LINE);
ok("① 内核阈值 = 550,464", a.kernelTokens === 550464, String(a.kernelTokens));
ok("① 内核百分比 55%", a.kernelPct === 55, String(a.kernelPct));
ok("① 我们的线 = 700,000", a.ourTokens === 700000, String(a.ourTokens));
ok("① reachable = false（走不到）", a.reachable === false, String(a.reachable));

// ② 其余渠道（maxTokens 128,000）⇒ 压力预算 806,464 > 800,000 ⇒ 0.8 赢
const b = compactLineReport({ window: W, maxTokens: 128000 }, LINE);
ok("② 内核阈值仍是 800,000", b.kernelTokens === 800000, String(b.kernelTokens));
ok("② reachable = true（照旧生效）", b.reachable === true, String(b.reachable));

// ③ 取不到 maxTokens ⇒ 退回老算法（只有 0.8），不许因此判"走不到"
const c = compactLineReport({ window: W }, LINE);
ok("③ 无 maxTokens 时按 0.8 算", c.kernelTokens === 800000, String(c.kernelTokens));
ok("③ reachable = true", c.reachable === true, String(c.reachable));

// ④ 窗口取不到 ⇒ 返回 undefined（宁可不报，不报假）
ok("④ 缺 window ⇒ undefined", compactLineReport({ maxTokens: 1 }, LINE) === undefined);

// ⑤ headroom 常量必须是内核默认值（写成别的会静默偏移 6.5 个点）
ok("⑤ headroom = 65,536", a.headroom === 65536, String(a.headroom));

console.log(`\n合计：PASS ${pass} · FAIL ${fail}`);
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
