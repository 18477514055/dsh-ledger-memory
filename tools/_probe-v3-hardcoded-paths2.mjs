/**
 * 阶段 0.1b（V3 地基）：把 0.1 扫出的 92 处"可疑路径"**分成两类**，
 * 因为它们的风险完全不同 —— 混在一起报等于没报。
 *
 *   ① **直接拼字面量文件名**（`path.join(root, "LEDGER.md")`）
 *      ⇒ **真硬编码**。迁移后它会指旧位置 ⇒ 必改。
 *   ② **参数是变量**（`path.resolve(root, relPath)`）
 *      ⇒ 多半只是把**调用方传进来的 rel 转发**一下。**关键看 `relPath` 从哪来**：
 *        · 若来自 `info.xxxRel`（inspect 给的）⇒ 迁移后自动跟随，**不用改**；
 *        · 若来自用户参数 / 清单原始值 ⇒ 需要确认基准。
 *
 * ★ 本脚本只做分类与**上下文取样**（往上看 3 行找变量来源），不下最终结论 ——
 *   结论要人看上下文才能定（这是"判据只吃被测对象"的边界）。
 *
 * 跑法：node tools/_probe-v3-hardcoded-paths2.mjs
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");
const MD = path.join(HERE, "_v3-hardcoded-paths.md");

// 从 0.1 的产物里读回可疑清单（避免两套扫描逻辑分叉）
const md = fs.readFileSync(MD, "utf8");
const rows = [];
for (const line of md.split(/\r?\n/)) {
  const m = line.match(/^- `lib\/([^:]+):(\d+)` — (.*)$/);
  if (m) rows.push({ file: m[1], line: Number(m[2]), text: m[3] });
}

const literal = [];
const viaVar = [];

for (const r of rows) {
  const call = r.text.match(/path\.(?:join|resolve)\(([^)]*)\)/);
  if (!call) {
    viaVar.push({ ...r, ctx: "(没解析出参数)" });
    continue;
  }
  const args = call[1];
  // ① 形如 `path.xxx(root, "字面量"...)`
  if (/^\s*[\w$.]+\s*,\s*["'`]/.test(args)) {
    literal.push(r);
    continue;
  }
  // ② 其余：取上文 3 行，找「第二个参数那个变量」是从哪来的
  const src = fs.readFileSync(path.join(LIB, r.file), "utf8").split(/\r?\n/);
  const second = (args.split(",")[1] ?? "").trim().replace(/[)}\s].*$/, "");
  const ctx = [];
  for (let i = Math.max(0, r.line - 4); i < r.line; i++) {
    const L = src[i];
    if (L === undefined) continue;
    if (
      second !== "" &&
      (L.includes(`const ${second}`) || L.includes(`let ${second}`) || L.includes(`${second} =`))
    ) {
      ctx.push(`L${i + 1}: ${L.trim().slice(0, 110)}`);
    }
  }
  viaVar.push({ ...r, second, ctx: ctx.join(" | ") || "(上文没找到来源)" });
}

console.log(`═══ 0.1b 分类 ═══\n可疑总计 ${rows.length} 处\n`);
console.log(`① 直接拼字面量文件名（真硬编码，必改）= ${literal.length} 处`);
for (const r of literal) console.log(`   lib/${r.file}:${r.line}  ${r.text}`);
console.log("");
console.log(`② 参数是变量（多为 rel 转发，需看来源）= ${viaVar.length} 处`);
for (const r of viaVar) {
  console.log(`   lib/${r.file}:${r.line}  [${r.second ?? "?"}]  ${r.text}`);
  if (r.ctx && r.ctx !== "(上文没找到来源)") console.log(`        来源: ${r.ctx}`);
}

// 写分类结果
const out = path.join(HERE, "_v3-hardcoded-paths-classified.md");
const lines = [
  "# V3 阶段 0.1b：可疑路径的**分类**（不是结论，是分组）",
  "",
  `> 生成：node tools/_probe-v3-hardcoded-paths2.mjs · 总计 ${rows.length} 处`,
  "",
  "## ① 直接拼字面量文件名 —— **真硬编码，V3 必改**",
  "",
  ...literal.map((r) => `- \`lib/${r.file}:${r.line}\` — ${r.text}`),
  "",
  "## ② 参数是变量 —— 要看变量来源，多半不用改",
  "",
];
for (const r of viaVar) {
  lines.push(`- \`lib/${r.file}:${r.line}\` [\`${r.second ?? "?"}\`] — ${r.text}`);
  if (r.ctx) lines.push(`  - 来源：${r.ctx}`);
}
fs.writeFileSync(out, lines.join("\n"), "utf8");
console.log(`\n分类结果已写至: ${out}`);
