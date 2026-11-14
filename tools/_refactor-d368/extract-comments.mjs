/**
 * D368 实施：把「实现考古型注释」抽到 `源码注释/<模块>.md`，源码里只留**一句话结论 + 指针**。
 *
 * ★★★ 三条不可违反的纪律（写进脚本，而不是靠我记性）：
 *   ① **JSDoc（`/** … *\/`）一律不动** —— 那是编辑器与工具链依赖的 API 文档。
 *   ② **被检查器当锚点搜索的注释行一律不动** —— 搬走 = 自检假红（探针会算准锚点）。
 *   ③ **只抽 ≥3 行的连续 `//` 块** —— 单行注释多半是"这里为什么这样写"，就留在原地。
 *
 * ★ 抽离后的形状：
 *      // ✅ 一句话结论（原块的核心断言）
 *      //    详见 源码注释/part3.md#L420-L480
 *
 * ★ 产物是**追加式**的 md（每个模块一节），并保留原始行号，方便按指针回查。
 */
import fs from "node:fs";
import path from "node:path";

const LIB = "lib";
const DOCDIR = "源码注释";
const DRY = process.argv.includes("--dry");
// ★★★ 锚点判据**只从唯一真源 import**，不许在本脚本里再写一份
//   （本轮实测：两份各写一份 ⇒ 一份修好了另一份还是旧的 ⇒ 假红反复出现）。
const { loadCheckerText, isAnchorLine } = await import("./anchor-rule.mjs");
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? process.argv[i + 1] : null;
})();

fs.mkdirSync(DOCDIR, { recursive: true });

const checkers = ["tools/selftest.mjs", ...fs.readdirSync("tools").filter((f) => f.endsWith(".mjs")).map((f) => `tools/${f}`)];
const allCheckerText = checkers.map((f) => fs.readFileSync(f, "utf8")).join("\n");

const bodyOf = (line) => line.replace(/^\s*\/\/\s*/, "").replace(/^★+\s*/, "").trim();

// ★★★ 锚点判据**由锚点真源提供**（见文件顶部的 import）。
//   本轮踩过的坑：先前这里自己写了一份"提取字面量 + 双向包含"的实现，
//   而**全文件扫引号会配错对** ⇒ 真实的 `"// ★★★ D269…完整预检区**"` 根本没被抓出来 ⇒ 假红。
//   ⇒ 判据：**"我提取了字面量" ≠ "我提取到了该有的字面量"**。现在改成量"检查器里有没有这一行的长前缀"。
const checkerText = loadCheckerText(process.cwd());

const files = ONLY ? [ONLY] : ["part1.js", "part2.js", "part3.js", "part4.js", "init-tool.js", "part5.js", "index.js", "defs.js"];

let grandSaved = 0;
const summary = [];

for (const f of files) {
  const abs = path.join(LIB, f);
  const src = fs.readFileSync(abs, "utf8");
  const lines = src.split("\n");
  const beforeBytes = Buffer.byteLength(src, "utf8");

  // 找出所有连续的 `//` 块（≥3 行），且**块内没有锚点**，且**不是 JSDoc**
  const out = [];
  const moved = []; // {startLine, lines[], conclusion}
  let i = 0;
  while (i < lines.length) {
    const isLineComment = /^\s*\/\//.test(lines[i]);
    if (!isLineComment) { out.push(lines[i]); i += 1; continue; }
    let j = i;
    while (j < lines.length && /^\s*\/\//.test(lines[j])) j += 1;
    const blockLen = j - i;
    const block = lines.slice(i, j);

    // 纪律③：只抽 ≥3 行
    if (blockLen < 3) { out.push(...block); i = j; continue; }
    // 纪律②：块内任何一行是锚点 ⇒ 整块不动
    if (block.some((l) => isAnchorLine(l, checkerText))) { out.push(...block); i = j; continue; }
    // 纪律①：块上方若紧邻 JSDoc 结束行（`*/`），说明这段是 JSDoc 的一部分 —— 不动
    const prev = out.length > 0 ? out[out.length - 1].trim() : "";
    if (prev.endsWith("*/")) { out.push(...block); i = j; continue; }
    // 块内容为空壳（只有分隔线）⇒ 保留（可读性），不搬
    // ★★★ 规则修正（本轮实测栽过一次）：上一版把
    //   `// ═══════════════════ 预检区结束 · 下面才开始写盘 ═══════════════════`
    //   判成"纯装饰"整块搬走 —— 因为去掉首尾分隔符后没剩多长。
    //   🔴 后果：`108① a/b` 两条断言当场假红（它们正是**搜索这一行的标记文本**）。
    //   ⇒ 判据：**一行里只要含中文或数字，它就不是装饰**，哪怕被分隔符包着。
    const meaningful = block.filter((l) => {
      const b = bodyOf(l);
      if (b.length === 0) return false;
      const stripped = b.replace(/[═─=\-*~·•_\s]/g, "");
      if (stripped.length === 0) return false;
      // 含中文 / 字母 / 数字 ⇒ 有实质内容
      if (/[\u4e00-\u9fa5A-Za-z0-9]/.test(stripped)) return true;
      return false;
    });
    if (meaningful.length === 0) { out.push(...block); i = j; continue; }

    // ★★★★ 抽离：**首行原样保留**（一个字都不改）。
    //   🔴 为什么（本轮实测栽过）：上一版我把它改写成 `// ✅ 结论…`，
    //     而检查器里存的字面量是 `"// ★★★ D269（修 review F07）：**完整预检区**"`
    //     ⇒ 首行被改写后 `indexOf` 再也找不到 ⇒ `108① a/b` 当场假红。
    //   ★ 判据：**抽离只能删"行"，不能改"留"。** 留下的首行必须是原文逐字。
    const head0 = block[0];
    // ★★ 指针行必须**沿用首行的缩进** —— 这些块有大量位于函数体内部（8/10 格缩进），
    //    写成顶格会破坏可读性（本轮实测：index.js 里出现顶格指针夹在深缩进代码中）。
    const indent = /^(\s*)/.exec(head0)[1];
    moved.push({ startLine: i + 1, endLine: j, block });
    out.push(head0);
    out.push(`${indent}//   ▶ 其余 ${block.length - 1} 行详注已抽到 ${DOCDIR}/${f.replace(/\.js$/, "")}.md（原 ${f}:${i + 1}-${j}）`);
    i = j;
  }

  if (moved.length === 0) { summary.push({ f, saved: 0, blocks: 0 }); continue; }

  const next = out.join("\n");
  const afterBytes = Buffer.byteLength(next, "utf8");
  const saved = beforeBytes - afterBytes;

  // 写 md（只追加/覆盖本节）
  const mdPath = path.join(DOCDIR, `${f.replace(/\.js$/, "")}.md`);
  const sections = moved
    .map((m) => {
      const body = m.block.map((l) => l.replace(/^\s*\/\/\s?/, "")).join("\n");
      return `## ${f}:${m.startLine}-${m.endLine}\n\n\`\`\`\n${body}\n\`\`\`\n`;
    })
    .join("\n");
  const header = `# ${f} 的实现注释（从源码抽离）\n\n> 由 D368 从 \`lib/${f}\` 抽离，**内容一字未改**。\n> 源码里保留一句话结论 + 指向本文件的指针。\n> 目的是让 \`lib/\` 单文件体积回到安全线内（DSH STORE 硬上限 262,144 B）。\n\n`;
  if (!DRY) fs.writeFileSync(mdPath, header + sections, "utf8");

  if (!DRY) fs.writeFileSync(abs, next, "utf8");
  summary.push({ f, saved, blocks: moved.length, md: mdPath });
  grandSaved += saved;
}

console.log("文件".padEnd(16), "抽离块".padStart(7), "净省 B".padStart(9), "产物");
for (const s of summary) {
  console.log(s.f.padEnd(16), String(s.blocks).padStart(7), String(s.saved).padStart(9), s.md ?? "");
}
console.log(`\n合计净省 ${grandSaved} B`);
console.log(DRY ? "（DRY RUN —— 未写盘）" : "EXTRACT-DONE");
