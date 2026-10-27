/**
 * ★ 从 part3.js 剪出「静默判据」那一整块（第 20..72 行）并接到 part6.js 末尾。
 * ★ 规矩：**逐字搬运**，只改两件事 —— ① 去掉块首尾的 export 关键字（part6 末尾统一导出）；
 *   ② 在 part3 原位置留一句 re-export 指针（避免调用方（index.js / 探针）改路径）。
 * ★ 三重后置校验：新块在 part6 里逐字可寻、part3 里已无重复定义、part3 行数确实减少。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/Deepseek工作区/20-DSH插件/04-其余插件/10.项目台账";
const P3 = path.join(ROOT, "lib", "part3.js");
const P6 = path.join(ROOT, "lib", "part6.js");

const p3 = fs.readFileSync(P3, "utf8");
const lines = p3.split("\n");

// 定位块：从 "/**" 开头那句（含 2026-10-24 用户口述规范第 13 点）到 silentBecauseDecided 的结束 "}"
let startMark = -1;
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i].includes("用户口述规范第 13 点") && lines[i].trim().startsWith("*")) {
    // 往上找最近的 "/**"
    for (let j = i; j >= 0; j -= 1) {
      if (lines[j].trim() === "/**") { startMark = j; break; }
    }
    break;
  }
}
if (startMark < 0) { console.log("FAILED: 找不到块起始"); process.exit(1); }

let endMark = -1;
for (let i = startMark; i < lines.length; i += 1) {
  if (lines[i].startsWith("export function silentBecauseDecided")) {
    // 往下找到该函数结束（第一个行首 "}"）
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j] === "}") { endMark = j; break; }
    }
    break;
  }
}
if (endMark < 0) { console.log("FAILED: 找不到块结束"); process.exit(1); }

const block = lines.slice(startMark, endMark + 1);
console.log(`块：part3 第 ${startMark + 1}..${endMark + 1} 行，共 ${block.length} 行`);
console.log(`  首行: ${block[0]}`);
console.log(`  末行: ${block[block.length - 1]}`);

// 校验：块里必须含三个函数名
for (const fn of ["decidedProjects", "markProjectDecided", "silentBecauseDecided"]) {
  if (!block.join("\n").includes(fn)) { console.log(`FAILED: 块里缺 ${fn}`); process.exit(1); }
}

// ── 搬到 part6：改成非 export（part6 末尾统一导出）
const moved = block.map((ln) =>
  ln.replace(/^export function markProjectDecided/, "function markProjectDecided")
    .replace(/^export function clearDecidedProjectsForTest/, "function clearDecidedProjectsForTest")
    .replace(/^export function silentBecauseDecided/, "function silentBecauseDecided")
);

const p6 = fs.readFileSync(P6, "utf8");
const tail = "export { WEIGHT_MUST_INJECT };\n";
if (!p6.includes(tail)) { console.log("FAILED: part6 末尾锚点不对"); process.exit(1); }

const header = `
// ═══════════════════════════════════════════════════════════════════════════
// ★★★★★ 2026-10-24（用户口述规范第 13 点）：**"用户已决定不要台账" ⇒ 一个字都不发**
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么住在 part6：这组判据与"渲染"无关，是**纯粹的"发不发"决定**；
//   而 part3.js 已到 262144 B 硬上限（本轮一度 265,715 B，被自检体积守卫当场抓红）。
//   搬到依赖更轻、有余量的 part6，**不改变任何语义**。
// ★ 依赖方向已核：part3 → part6 已存在；没有任何模块从 part6 import part3 ⇒ 不成环。

`;

const newP6 = p6.replace(tail, header + moved.join("\n") + "\n\n" + tail +
  "export { markProjectDecided, clearDecidedProjectsForTest, silentBecauseDecided };\n");
fs.writeFileSync(P6, newP6, "utf8");

// ── part3：原位换成 re-export（调用方与探针都不必改路径）
const reexport = [
  "// ★★★★★ 2026-10-24：这组「静默判据」已搬到 `part6.js`（part3 触到 262144 B 硬上限）。",
  "//   ★ 这里**只做 re-export**：调用方（index.js / 探针）照旧从 part3 取，路径不必改。",
  "export { markProjectDecided, clearDecidedProjectsForTest, silentBecauseDecided } from \"./part6.js\";",
];
const newLines = [...lines.slice(0, startMark), ...reexport, ...lines.slice(endMark + 1)];
const newP3 = newLines.join("\n");
fs.writeFileSync(P3, newP3, "utf8");

// ── 三重后置校验
const c1 = fs.readFileSync(P6, "utf8").includes("function silentBecauseDecided(info)");
const c2 = !/^export function silentBecauseDecided/m.test(fs.readFileSync(P3, "utf8"));
const c3 = fs.readFileSync(P3, "utf8").includes('from "./part6.js"');
console.log(`\n① part6 里有 silentBecauseDecided 实现: ${c1}`);
console.log(`② part3 里已无重复实现: ${c2}`);
console.log(`③ part3 有 re-export 指针: ${c3}`);
console.log(`part3 行数 ${lines.length} → ${newP3.split("\n").length}`);
console.log(`part3 体积 ${p3.length} → ${newP3.length} B（余 ${262144 - Buffer.byteLength(newP3)}）`);
console.log(`part6 体积 ${p6.length} → ${newP6.length} B（余 ${262144 - Buffer.byteLength(newP6)}）`);
if (!(c1 && c2 && c3)) { console.log("FAILED"); process.exit(1); }
console.log("OK");
