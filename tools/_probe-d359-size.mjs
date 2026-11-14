// _probe-d359-size.mjs —— D359 的上下文成本：这一段到底让重注涨了多少？
//
// ★ 判据（D342 立的规矩）：任何"每回合/每次注入加内容"的改动，都必须先量它加多少。
//   换算率 1.72 字符/tok（D342 实测，8 个独立样本一致）。
// ★ 用**真项目**的真 L1 数据，不用假的。
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const { renderRecentWork } = await import("file:///" + path.join(ROOT, "lib", "part2.js").replace(/\\/g, "/"));

const info = {
  projectRoot: ROOT,
  logRel: path.join("10.项目台账-ledger-memory", "_ledger-log"),
  memoryRoot: "10.项目台账-ledger-memory",
};

const t = renderRecentWork(info);
const chars = t.length;
const tok = chars / 1.72;

console.log("== D359「最近的工作」的真实体积（本仓库真数据）==");
console.log(`  字符 = ${chars}`);
console.log(`  tok  = ${tok.toFixed(0)}（换算率 1.72 字符/tok）`);
console.log("");
console.log("== 与已知量级对照 ==");
const BASE = 52552;      // D342 实测：满配常规注入字符
const BASE_TOK = 30553;  // = BASE / 1.72
console.log(`  常规注入满配 = ${BASE} 字符 / ${BASE_TOK} tok（D342 实测）`);
console.log(`  本次新增占比 = ${((100 * chars) / BASE).toFixed(2)}%（相对常规注入）`);
console.log("");
console.log("== 关键：它只加在**压缩后重注**，不进常规注入 ==");
console.log(`  ⇒ 常规注入每回合 +0 字符（一点没变）`);
console.log(`  ⇒ 只有"压缩发生后的那一次"多 ${chars} 字符 ≈ ${tok.toFixed(0)} tok`);
console.log("");
console.log("--- 渲染全文 ---");
console.log(t);
