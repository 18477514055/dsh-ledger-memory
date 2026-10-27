/**
 * _probe-no-restate.mjs —— D315：「补完收尾工具后不要复述回答」的守卫
 *
 * 用户原话（逐字）：*"本来模型做完所有回答之后，准备结束回合的时候会自动触发台账落实和分流等
 * 工具嘛，但是触发完这些工具之后，模型有时候又会把前面给我的回答（有点累赘了）。"*
 *
 * ── 这个探针要证明三件事 ──────────────────────────────────────────
 *   ① 文案实体存在且**只在一个地方定义**（part6），不是在三个文件里各写一份
 *   ② **两个入口都真的用到了它**（steer 那条 + 回合开头提醒那条）—— 只修一处就是修一半
 *   ③ 文案本身**说清了边界**（不许重述工作结论 / 最多一行 / 只讲工具结果）
 *
 * ★★ 判据（本项目纪律）：**探针必须能看见红**。下面每条断言都配一条"摘掉就红"的反向验证，
 *   见 `_reverse-verify-no-restate.mjs`。
 */
import fs from "node:fs";
import path from "node:path";

const LIB = "lib";
const read = (f) => fs.readFileSync(path.join(LIB, f), "utf8");

const results = [];
function check(ok, label, detail) {
  results.push({ ok, label, detail });
}

const part3 = read("part3.js");
const part6 = read("part6.js");
const index = read("index.js");

// ── ① 定义唯一：part6 里有一处 `export const NO_RESTATE_AFTER_OBLIGATION =`
const defCount = (part6.match(/export const NO_RESTATE_AFTER_OBLIGATION\s*=/g) || []).length;
check(defCount === 1, "① 文案实体在 part6 定义，且只有一处", `命中 ${defCount} 处`);
check(
  !/const NO_RESTATE_AFTER_OBLIGATION\s*=/.test(part3),
  "①b part3 里没有第二份定义（只引用）",
  /const NO_RESTATE_AFTER_OBLIGATION\s*=/.test(part3) ? "part3 里又定义了一份" : "只有引用"
);
check(
  !/const NO_RESTATE_AFTER_OBLIGATION\s*=/.test(index),
  "①c index.js 里没有第二份定义（只引用）",
  /const NO_RESTATE_AFTER_OBLIGATION\s*=/.test(index) ? "index.js 里又定义了一份" : "只有引用"
);

// ── ② 两个入口都真的用到（import 了 + 用了）
//   ★ 注意：`import` 进来但没用 = 死引用，所以"用到"必须查**使用处**，不能只查 import。
const part3Uses = (part3.match(/NO_RESTATE_AFTER_OBLIGATION/g) || []).length;
// part3 里应出现 3 次：import 1 + export 转发 1 + 实际使用 1
check(part3Uses >= 3, "②a part3 里既有 import/转发、也有实际使用", `出现 ${part3Uses} 次`);
check(
  /`★ 做完就直接继续原来的工作[\s\S]{0,200}NO_RESTATE_AFTER_OBLIGATION/.test(part3),
  "②b part3 的 steer 文案里真拼进了它（在「做完接着干」那句之后）",
  "拼在 steer 的 text 里"
);

const indexUses = (index.match(/NO_RESTATE_AFTER_OBLIGATION/g) || []).length;
// index 里应出现 2 次：import 1 + 实际使用 1
check(indexUses >= 2, "②c index.js 里既有 import、也有实际使用", `出现 ${indexUses} 次`);
// ★ 第一版这里写的是 `/needTriage[\s\S]{0,300}NO_RESTATE/`，**报了假红**：
//   真实代码在两者之间夹了 4 行中文注释，而 `{0,300}` 数的是字符、注释早就超了。
//   ⇒ 改成盯**结构**：它必须是一个**以 `+` 结尾的表达式**（即拼进模板字符串），
//     且它后面紧跟的就是「为什么每回合都要做」那句 —— 那才是"拼在义务清单之后"的证据。
//   ★ 教训同 D-尺子错第 10 条：**断言红了先分清「代码错」与「断言写得不够宽」**。
check(
  /^\s*NO_RESTATE_AFTER_OBLIGATION \+$/m.test(index) &&
    /NO_RESTATE_AFTER_OBLIGATION \+\s*\n\s*"★ \*\*为什么每回合都要做\*\*/m.test(index),
  "②d index.js 的回合开头提醒里真拼进了它（以 `+` 拼进义务清单之后的模板）",
  "是独立一行 `NO_RESTATE_AFTER_OBLIGATION +`，后接「为什么每回合都要做」"
);

// ── ③ 文案说清了边界
const m = part6.match(/export const NO_RESTATE_AFTER_OBLIGATION\s*=\s*([\s\S]*?);\n/);
const body = m ? m[1] : "";
check(/不要再把这一轮的工作结论重述一遍/.test(body), "③a 明确禁止「重述工作结论」", "命中");
check(/最多一行/.test(body), "③b 给了上限（最多一行）", "命中");
check(/不要\*\*重新总结|不要\*\*重新总结改了什么/.test(body) || /不要\*\*重新总结/.test(body), "③c 明确点名不许重做「总结改了什么/验了什么/下一步」", "命中");
check(/用户已经看到那条回答了/.test(body), "③d 说了**为什么**（用户已经看过）", "命中");

// ── ④ 旧文案那句还在（不是被替换掉，而是被补充）
check(/不必向我汇报这件事本身/.test(part3), "④ 原有那句「不必汇报补工具的过程」仍在（是补充不是替换）", "在 part3");

// ── ⑤ 尺子自检：文案不能被拼进**错误的位置**
//   ★ 这条治的是"改错文件/改错行"这类静默错误：如果它被拼进了 `ledger_write` 的回执里，
//     上面所有断言照样全绿，而用户永远看不到。
const wrongSpots = [
  { name: "台账回执", re: /NO_RESTATE_AFTER_OBLIGATION[\s\S]{0,100}changedBy/ },
];
let wrongHits = 0;
for (const w of wrongSpots) {
  if (w.re.test(part3) || w.re.test(index)) wrongHits++;
}
check(wrongHits === 0, "⑤ 没有被拼进台账回执等无关位置", `误拼 ${wrongHits} 处`);

// ── 汇总
let pass = 0;
let fail = 0;
for (const r of results) {
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label}  —— ${r.detail}`);
  if (r.ok) pass++;
  else fail++;
}
// ★ 结论行格式**与本目录其它探针一致**（`═══ N PASS / M FAIL ═══`）。
//   我第一版写成 `PASS 13 / FAIL 0`，结果 selftest 里那条按惯例写的正则匹配不到，
//   报了一个**假红**。★ 判据：**同一个目录里的探针，结论行必须是同一种形状** ——
//   否则每接一个探针就要在 selftest 里写一条不同的正则，迟早错一个。
console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail ? 1 : 0);
