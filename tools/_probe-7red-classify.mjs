/**
 * ★★★ 只读探针：判定「摘掉 `!hfQueued` 后变红的那 7 条用例」各属于哪一类。
 *
 * ★ 要回答的判据（纪律 6 / 8）：
 *   红的原因有两种，**必须分开**：
 *     ① **夹具故障** —— 该用例的夹具体里**从不触发 idle 事件** ⇒ 全量队列永不被消费
 *        ⇒ 增量每一步都让路 ⇒ `regionCalls` 恒 0 ⇒ **假红**（不是被测对象的错）。
 *     ② **真设计被破坏** —— 该用例本来就在测"高水位下增量也必须跑"，那是设计意图。
 *
 * ★ 做法（不猜、只做结构分析）：
 *   ① 从 selftest.mjs 里按行号定位那 7 条断言；
 *   ② 用**缩进**找出它们各自所属的用例块（`^    {$` … `^    }$`，全文件风格一致）；
 *   ③ 在块内数：`agent/status` + `idle` 的出现次数（= 全量队列能被消费的唯一途径）；
 *      以及块内设过的水位（`tokenMeter._total = N`）。
 *
 * ★ 为什么要数 idle：`hfCompactAfterTurn` **只有** `agent/status` 的 idle 处理器会消费
 *   （`lib/index.js:11579` 是全文件唯一一处 `delete`）。夹具不派 idle ⇒ 全量永不执行。
 */
import fs from "node:fs";

const SELFTEST = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账\\tools\\selftest.mjs";
const lines = fs.readFileSync(SELFTEST, "utf8").split("\n");

/** 那 7 条断言的行号（来自上一次反向验证的红名单，逐条 grep 定位）。 */
const TARGETS = [
  { line: 8772, name: "而且说明白了卡在哪（37e 分流未做）" },
  { line: 8786, name: "补做分流之后 ⇒ 压缩放行" },
  { line: 8849, name: "超过 20 分钟仍未分流 ⇒ 时限兜底放行" },
  { line: 8896, name: "增量压缩真的跑了" },
  { line: 8899, name: "增量压缩记进了计数器" },
  { line: 8929, name: "steady 下写了台账就能压" },
  { line: 9556, name: "水位 100%、涨够触发线时增量必须真的发生" },
];

/** 找包含第 n 行（1-based）的用例块：向前找 `^    {$`，向后找 `^    }$`。 */
function blockOf(n) {
  const i0 = n - 1;
  let start = -1;
  for (let i = i0; i >= 0; i--) {
    if (/^    \{$/.test(lines[i])) {
      start = i;
      break;
    }
    // 撞到 section 或更外层就算失败
    if (/^section\(/.test(lines[i])) break;
  }
  let end = -1;
  if (start !== -1) {
    for (let i = i0; i < lines.length; i++) {
      if (/^    \}$/.test(lines[i])) {
        end = i;
        break;
      }
    }
  }
  return { start, end };
}

const WINDOW = 1_000_000;
console.log("用例                                              行区间       idle?   水位设置");
console.log("─".repeat(108));

let noIdle = 0;
for (const t of TARGETS) {
  const { start, end } = blockOf(t.line);
  if (start === -1 || end === -1) {
    console.log(`  ${t.name.padEnd(46)} ★ 定位失败（start=${start} end=${end}）`);
    continue;
  }
  const body = lines.slice(start, end + 1);
  // 数 idle 派发：`agent/status` 与 `status: "idle"` 同时出现才算
  const idleFires = body.filter((l) => /agent\/status/.test(l) && /idle/.test(l)).length;
  // 水位设置
  const waters = [...body.join("\n").matchAll(/_total\s*=\s*(\d+)/g)].map((m) =>
    ((Number(m[1]) / WINDOW) * 100).toFixed(1)
  );
  // 也看 _dropTo（压后水位）
  const drops = [...body.join("\n").matchAll(/_dropTo\s*=\s*(\d+)/g)].map((m) =>
    ((Number(m[1]) / WINDOW) * 100).toFixed(1)
  );
  if (idleFires === 0) noIdle++;
  console.log(
    `  ${t.name.padEnd(46)} ${String(start + 1).padStart(5)}–${String(end + 1).padEnd(5)} ` +
      `${idleFires === 0 ? "★ 无 idle" : `有 ${idleFires} 次  `}  ` +
      `水位=[${waters.join(", ")}]${drops.length === 0 ? "" : `  压后=[${drops.join(", ")}]`}`
  );
}

console.log("─".repeat(108));
console.log(`★ 7 条里 **${noIdle} 条**的用例块内**一次 idle 都没派** ⇒ 全量队列永不被消费。`);
console.log(
  noIdle === TARGETS.length
    ? "⇒ 结论：这 7 条全是「全量排了队却没人执行」造成的 —— **夹具没造出 idle 这个前提**。"
    : "⇒ 结论：有部分用例派了 idle ⇒ 需要逐条再看（不能一律判为夹具故障）。"
);
