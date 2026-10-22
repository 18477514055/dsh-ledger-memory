/**
 * 阶段 0.2（V3 地基）：**验证「只改 inspect() 就够」这个假设成不成立。**
 *
 * ★ 假设（改写计划里的方案）：不碰 `rootFromExec`，只在 `inspect()` 内部把 `*Rel` 的基准
 *   换成 `memoryRoot`。这样 20 个工具入口一行不动、102 处转发自动正确。
 *
 * 🔴 但假设要验证，不能凭想。验证点有两个：
 *   ① `info.*Rel` 到底会不会被 `path.resolve(root, info.xxx)` 这样用？
 *      —— 若是，root 还是项目根、rel 变成相对 memoryRoot ⇒ **拼错**（这正是计划 §5.1 的风险）。
 *   ② 有没有地方**直接**用 `path.join(root, "LEDGER.md")` 这类字面量？
 *      —— 阶段 0.1 已查出：只有 `.gitignore` 一处与记忆相关。
 *
 * ⇒ 所以真正的判据是 **①**。本脚本把它查清。
 *
 * 跑法：node tools/_probe-v3-reljoin-audit.mjs
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");

const files = fs.readdirSync(LIB).filter((f) => f.endsWith(".js")).sort();

// inspect() 返回的字段名（从 part2.js 的 return 块里抓）
const part2 = fs.readFileSync(path.join(LIB, "part2.js"), "utf8");
const returnBlock = part2.slice(part2.indexOf("export function inspect(projectRoot)"));
const fieldNames = [...returnBlock.slice(0, 12000).matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*:/gm)].map(
  (m) => m[1],
);
const uniqFields = [...new Set(fieldNames)].sort();
console.log(`inspect() 返回字段 ${uniqFields.length} 个：`);
console.log(uniqFields.join(", "));
console.log("");

// 哪些字段名以 Rel/Abs/Dir 结尾 —— 这些是"路径类"
const pathFields = uniqFields.filter((f) => /(Rel|Abs|Dir)$/.test(f));
console.log(`其中路径类（Rel/Abs/Dir 结尾）${pathFields.length} 个：`);
console.log(pathFields.join(", "));
console.log("");

/**
 * 关键扫描：找 `path.xxx(..., info.<字段>)` 或 `path.xxx(..., <局部变量>)`
 * 且该局部变量来自 `info.<Rel字段>`。
 */
const hits = [];
for (const f of files) {
  const raw = fs.readFileSync(path.join(LIB, f), "utf8");
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ① 直接：path.xxx(root, info.someRel)
    const direct = line.match(/path\.(?:resolve|join)\([^,)]+,\s*(?:info|Info)\.([A-Za-z_$][\w$]*)/);
    if (direct && /(Rel|Dir)$/.test(direct[1])) {
      hits.push({
        file: f,
        line: i + 1,
        kind: "直接引用 info 的 Rel/Dir 字段",
        field: direct[1],
        text: line.trim().slice(0, 110),
      });
    }

    // ② 间接：const X = info.someRel  →  后面 path.xxx(root, X)
    const assign = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:info|Info)\.([A-Za-z_$][\w$]*)/);
    if (assign && /(Rel|Dir)$/.test(assign[2])) {
      const v = assign[1];
      // 往后找 40 行内有没有 path.xxx(root, v)
      for (let j = i + 1; j < Math.min(lines.length, i + 41); j++) {
        const re = new RegExp(`path\\.(?:resolve|join)\\([^,)]+,\\s*${v}\\b`);
        if (re.test(lines[j])) {
          hits.push({
            file: f,
            line: j + 1,
            kind: `间接（${v} ← info.${assign[2]}）`,
            field: assign[2],
            text: lines[j].trim().slice(0, 110),
          });
        }
      }
    }
  }
}

console.log("═══ 结果：`info.*Rel` 被喂回 `path.xxx(root, …)` 的地方 ═══\n");
if (hits.length === 0) {
  console.log("✅ **0 处**。⇒ 假设成立：`info.*Rel` 从不与 `root` 二次拼接，");
  console.log("   它们要么直接用 `info.*Abs`，要么在 inspect 内部就已经拼好了。");
  console.log("   ⇒ **只改 inspect() 确实够**，20 个入口一行不用动。");
} else {
  console.log(`⚠ ${hits.length} 处 —— 这些地方 root 与 rel 的基准必须一致，否则拼错：\n`);
  for (const h of hits) {
    console.log(`  lib/${h.file}:${h.line}  [${h.kind}]  field=${h.field}`);
    console.log(`     ${h.text}`);
  }
}

// 附带：确认 info.*Abs 的使用量（这些天然安全）
let absUse = 0;
for (const f of files) {
  const raw = fs.readFileSync(path.join(LIB, f), "utf8");
  absUse += (raw.match(/\binfo\.[A-Za-z_$][\w$]*Abs\b/g) ?? []).length;
}
console.log(`\n（参考：直接把 \`info.*Abs\` 当绝对路径用的次数 = ${absUse} —— 这些天然安全）`);

const out = path.join(HERE, "_v3-reljoin-audit.md");
fs.writeFileSync(
  out,
  [
    "# V3 阶段 0.2：`info.*Rel` 是否被二次拼接到 root",
    "",
    `> 生成：node tools/_probe-v3-reljoin-audit.mjs`,
    `> 命中 ${hits.length} 处 · 直接使用 info.*Abs ${absUse} 次`,
    "",
    hits.length === 0
      ? "## ✅ 0 处 ⇒ **只改 inspect() 就够**，20 个工具入口一行不用动。"
      : "## ⚠ 命中",
    "",
    ...hits.map((h) => `- \`lib/${h.file}:${h.line}\` [${h.kind}] field=${h.field} — ${h.text}`),
  ].join("\n"),
  "utf8",
);
console.log(`明细已写至: ${out}`);
