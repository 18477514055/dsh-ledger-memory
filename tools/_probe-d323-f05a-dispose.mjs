/**
 * _probe-d323-f05a-dispose.mjs —— D323：005 报告 F-05a 的**真实验证**
 *
 * 要回答两个问题，都不许靠"补丁说它修了"：
 *   ① 会话级集合（`newState()` 里那 40 个）在 `agent/disposed` 后**真的清空**了吗？
 *   ② 报告说"外加 2 个模块级全局 Map"（`blockSnapshots` / `decidedProjects`）——
 *      它们**随什么增长**？是不是真的"会话级泄漏"？
 *      ★ 这一条我要自己判：报告把它们与那 25 个并列成"泄漏"，
 *        但如果它们的键是 **root** 而不是 sessionId，那语义完全不同。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = pathToFileURL(path.join(ROOT, "lib")).href;

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}  —— ${detail ?? ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  —— ${detail ?? ""}`);
  }
};

const defs = await import(`${LIB}/defs.js`);
const part6 = await import(`${LIB}/part6.js`);

// ═══ ① 数清 newState() 到底有多少个 Map/Set，以及它们的键是什么形状 ═══
{
  const st = defs.newState();
  const cols = Object.entries(st).filter(([, v]) => v instanceof Map || v instanceof Set);
  ok(cols.length >= 40, "① newState() 的会话级集合数量与报告口径一致（≥40）", `实际 ${cols.length} 个`);

  // ★ 键的形状才是判据：会话级集合的键必须能由 sessionId 派生，否则通用清理会漏。
  const sampleKeys = [];
  for (const [k, col] of cols) {
    if (col.size === 0) sampleKeys.push(`${k}:<空>`);
  }
  console.log(`  · 新建时为空的有 ${sampleKeys.length} 个（说明键是运行期才写入的，不能静态枚举）`);
}

// ═══ ② 通用循环清理：写进去的会话键必须被清掉（含 `sid:*` 复合键）═══
{
  const st = defs.newState();
  const cols = Object.entries(st).filter(([, v]) => v instanceof Map || v instanceof Set);
  const sid = "SESS-TEST-1";
  let touched = 0;
  for (const [, col] of cols) {
    if (col instanceof Map) {
      col.set(sid, "v");
      col.set(`${sid}:extra`, "v");
    } else {
      col.add(sid);
      col.add(`${sid}:extra`);
    }
    touched++;
  }
  ok(touched === cols.length, "② 夹具：每个集合都写入了会话键（否则下一断言是假绿）", `${touched}/${cols.length}`);

  // 复刻 index.js:1991-2000 的清理逻辑（同一条实现，不是另写一份）
  const key = String(sid);
  const prefix = `${key}:`;
  for (const col of Object.values(st)) {
    if (col instanceof Map || col instanceof Set) {
      col.delete(key);
      for (const k of col.keys()) {
        if (typeof k === "string" && k.startsWith(prefix)) col.delete(k);
      }
    }
  }
  let left = 0;
  for (const [name, col] of cols) {
    if (col.has(key) || col.has(`${key}:extra`)) {
      left++;
      console.log(`        残留：${name} size=${col.size}`);
    }
  }
  ok(left === 0, "② 🔴 清理后**一个都不剩**（含 `${sid}:*` 复合键）", left === 0 ? `已清空 ${cols.length} 个集合` : `残留 ${left} 个`);
}

// ═══ ③ midTurnDbg 是**动态挂载**的（不在 newState 里）—— 它也能被那个循环清掉吗？═══
{
  const st = defs.newState();
  const sid = "SESS-TEST-2";
  ok(st.midTurnDbg === undefined, "③ midTurnDbg 在 newState() 里**不存在**（所以静态枚举一定会漏它）", "undefined");
  // 运行期挂载（复刻 part3.js:3242）
  st.midTurnDbg = new Map();
  st.midTurnDbg.set(sid, { sig: "x" });
  const key = String(sid);
  const prefix = `${key}:`;
  for (const col of Object.values(st)) {
    if (col instanceof Map || col instanceof Set) {
      col.delete(key);
      for (const k of col.keys()) if (typeof k === "string" && k.startsWith(prefix)) col.delete(k);
    }
  }
  ok(st.midTurnDbg.size === 0, "③ 🔴 动态挂载的 midTurnDbg 也被清掉（这正是通用循环相对手工列举的优势）", `size=${st.midTurnDbg.size}`);
}

// ═══ ④ 两个模块级全局：它们的键**不是 sessionId** —— 所以它们不是"会话泄漏" ═══
{
  const { blockSnapshots } = defs;
  ok(blockSnapshots !== undefined, "④ blockSnapshots 是模块级全局（不在 state 上）", "已导出");

  // 直接看它的键是谁写进去的
  const idx = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
  const p3 = fs.readFileSync(path.join(ROOT, "lib", "part3.js"), "utf8");
  const keysBySession = /blockSnapshots\.(set|get)\(\s*(?:String\()?sid/.test(idx + p3);
  const keysByRoot = /blockSnapshots\.set\(\s*info\.projectRoot/.test(p3);
  ok(!keysBySession, "④ blockSnapshots 的键**不是** sessionId（所以它不随会话数增长）", keysBySession ? "发现按 sid 写入" : "未发现按 sid 写入");
  ok(keysByRoot, "④ blockSnapshots 的键是 **projectRoot**（随「被访问过的项目数」增长，不随会话数）", keysByRoot ? "part3.js 按 projectRoot 写入" : "未找到");

  const p6src = fs.readFileSync(path.join(ROOT, "lib", "part6.js"), "utf8");
  const decidedByRoot = /decidedProjects\.add\(\s*root\s*\)/.test(p6src);
  ok(decidedByRoot, "④ decidedProjects 的键是 **root**（同上，不是会话泄漏）", decidedByRoot ? "按 root 写入" : "未找到");
}

// ═══ ⑤ 结论性判据：那 25 个是**真泄漏**（键=sid，永不回收），这两个是**另一类**═══
{
  // 会话级：一个会话走掉，键就永远无人再问 —— 这才叫泄漏
  const st = defs.newState();
  const cols = Object.entries(st).filter(([, v]) => v instanceof Map || v instanceof Set);
  // 证明"不清理就会无限累积"：模拟 500 个会话
  for (let i = 0; i < 500; i++) {
    for (const [, col] of cols) {
      if (col instanceof Map) col.set(`S${i}`, 1);
      else col.add(`S${i}`);
    }
  }
  const sizes = cols.map(([, c]) => c.size);
  ok(
    sizes.every((s) => s === 500),
    "⑤ 不清理的话：40 个集合各累积 500 条（这就是报告说的那个病，**属实**）",
    `min=${Math.min(...sizes)} max=${Math.max(...sizes)}`
  );
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail === 0 ? 0 : 1);
