/**
 * 体检：lib/index.js 里有没有**探针的 bad 串**残留（自改探针把文件改脏了）。
 *
 * ★ 为什么需要：`_probe-assertion-can-fail.mjs` 会**真的改** lib/index.js 再恢复。
 *   一旦哪个用例没恢复成功，文件就带伤，而"语法通过 + 大部分断言过"会让它
 *   看起来没事（实测撞到：line 3708 的旁路变成 `>= 99`，自检只红 1 条）。
 *   ⇒ 这个体检把每个用例的 `bad` 串直接拿去源码里搜，**命中即报**。
 *
 * 用法：node tools/_probe-dirty-source.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "lib", "index.js");
const src = fs.readFileSync(LIB, "utf8");

// 从探针文件里把 CASES 的 good/bad 抽出来（不 import，避免它一跑就改文件）。
const probe = fs.readFileSync(path.join(HERE, "_probe-assertion-can-fail.mjs"), "utf8");
const casesStart = probe.indexOf("const CASES = [");
const casesEnd = probe.indexOf("\n];", casesStart);
const block = probe.slice(casesStart, casesEnd);

/** 抓出每个 name 与它的 bad（good 不一定唯一，bad 通常有辨识度）。 */
const cases = [];
{
  const re = /name:\s*"([^"]+)"[\s\S]*?bad:\s*(`[\s\S]*?`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const raw = m[2];
    let text;
    if (raw.startsWith("`")) text = raw.slice(1, -1);
    else if (raw.startsWith('"')) text = JSON.parse(raw);
    else text = raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    cases.push({ name: m[1], bad: text });
  }
}

let fail = 0;
console.log(`═══ 扫描 ${cases.length} 个用例的 bad 串是否残留在源码里 ═══\n`);
for (const c of cases) {
  // 只查**有辨别力**的 bad（太短的、或与 good 极像的跳过会漏，所以一律查，标出长度）。
  const hit = src.includes(c.bad);
  if (hit) {
    const at = src.indexOf(c.bad);
    const line = src.slice(0, at).split("\n").length;
    console.log(`  ✗ 残留：${c.name}`);
    console.log(`      在 line ${line}：${JSON.stringify(c.bad.slice(0, 90))}`);
    fail += 1;
  }
}
if (fail === 0) {
  console.log("  ✓ 没有发现探针 bad 串残留");
} else {
  console.log(`\n  ★ 有 ${fail} 处残留 ⇒ lib/index.js 被探针改脏了，必须手工修回。`);
}

// ★ 额外体检：`tools/` 下不该有 `_tmp-*` 残留（临时脚本应该自己清理干净）。
//   2026-10-09 实测撞到：`_probe-crash-cleanup.mjs` 把 `process.exit()` 写在 try 里，
//   而 `process.exit()` **不执行未跑到的 finally** ⇒ 它每次都留下 5800 行的副本。
//   ★ 这条体检是"文件级"的，与上面的"源码级"互补。
{
  const toolsDir = path.join(HERE, "..", "tools");
  // `_tmp-crash-leak-test.mjs` 是探针**运行期**才生成的，跑完应当消失；
  // 平时它不该存在（探针自己 writeFileSync + rmSync）。
  const stray = fs.readdirSync(toolsDir).filter((n) => n.startsWith("_tmp-"));
  if (stray.length > 0) {
    console.log(`  ✗ tools/ 下有 ${stray.length} 个 _tmp-* 残留：`);
    for (const n of stray) console.log(`      ${n}`);
    console.log("      （临时脚本没清理干净 —— 检查它的 finally 是否跑得到）");
    fail += 1;
  } else {
    console.log("  ✓ tools/ 下没有 _tmp-* 残留");
  }
}

// 顺带把关键常量的值报出来，便于对照（这几个被探针碰过）。
for (const [label, re] of [
  ["FLUSH_GATE_BYPASS_RATIO", /const FLUSH_GATE_BYPASS_RATIO = ([\d.]+);/],
  ["手动捷径旁路", /if \(opts\?\.manual === ([^)]+)\) return \{ ok: true/],
  ["水位旁路", /if \(typeof opts\?\.ratio === "number" && opts\.ratio >= ([^)]+)\) \{/],
]) {
  const m = src.match(re);
  console.log(`  ${label} = ${m === null ? "(找不到)" : m[1]}`);
}

// ★ 最后一行给一句**明确结论**（便于 `Select-Object -Last 1` 之类的自动汇总）。
console.log(
  fail === 0
    ? "\n探针通过：源码干净（无探针 bad 串残留）"
    : `\n失败 ${fail} 项：源码被改脏了，先修回来`
);
process.exit(fail === 0 ? 0 : 1);
