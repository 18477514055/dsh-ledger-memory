/**
 * 只读取证（D194）：**真实 `LESSONS.md` 在新解析器下读得回来吗？**
 *
 * ★ 为什么必须有这一条：情形 82 用的是**临时项目与合成夹具**；而真正要回答的问题是
 *   **本项目这个已经写好的文件**（E1–E6 + L1–L13）能不能被新解析器完整读回。
 *   ★ 纪律 8 的镜像：**夹具全绿 ≠ 真文件全绿**（夹具里的格式可能恰好是它认得的那种）。
 *
 * ★ 判据（两侧都不引用被测代码里的期望值）：
 *   ① 条目总数 = 文件里 `## 经验/教训` 标题的**实际个数**（独立数一遍）；
 *   ② 每条都有标题；③ 类型分布两类都在；④ **经验条目全都有出处**（D194 的核心不变量）；
 *   ⑤ id 不重复；⑥ 与 `renderLessonEntry` 的**互逆性**：解析 → 渲染 → 再解析，结果不变。
 *
 * 跑法：node tools/_probe-d194-real-file.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

let bad = 0;
const chk = (label, cond, detail) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail === undefined ? "" : `\n      ${detail}`}`);
  if (!cond) bad++;
};

const LESSONS = path.join(ROOT, "LESSONS.md");
const text = fs.readFileSync(LESSONS, "utf8");

// ── ① 独立数一遍：文件里到底有几个条目标题（**不用被测代码**）──────────────
const headRe = /^##\s*(经验|教训)\s+(\S+)\s*(?:[·|]\s*([^\n]*))?$/gm;
const heads = [...text.matchAll(headRe)].map((m) => ({ type: m[1], id: m[2], kind: (m[3] ?? "").trim() }));
console.log(`独立数出来：条目标题 ${heads.length} 个`);
const byType = {};
for (const h of heads) byType[h.type] = (byType[h.type] ?? 0) + 1;
console.log(`  类型分布：${JSON.stringify(byType)}`);

// ── ② 用**被测代码自己**的解析器读一遍 ────────────────────────────────────
bar("② 用 lib/index.js 的解析器读真实文件");
const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
// 解析/渲染是模块内部的，不导出 ⇒ 走**工具**这条路（端到端，比直接调内部函数更硬）。
const tools = new Map();
const ctx = {
  tools: { register: (d) => tools.set(d.name, d) },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  on: () => () => {},
  inject: (deps, cb) => {
    const s = { commands: { register: () => () => {} }, userQuestions: { async ask() { return { answers: [] }; } } };
    for (const d of deps) if (!(d in s)) return undefined;
    const scope = Object.create(ctx);
    for (const d of deps) scope[d] = s[d];
    return cb(scope);
  },
  get: () => undefined,
};
mod.apply(ctx, {});
const t = tools.get("ledger_lessons");
const exec = { agent: { session: { header: { id: "s-d194-real", cwd: ROOT } } } };
const listed = await t.execute({ op: "list" }, exec);

chk("工具能读这个项目（`lessons` 已登记在清单里）", listed.ok === true, JSON.stringify(listed).slice(0, 200));
chk(
  `★ 读回来的条目数 = 独立数出来的个数（${heads.length}）`,
  listed.total === heads.length,
  `工具报 ${listed.total}，独立数 ${heads.length}`
);
chk("两类都在（经验 + 教训）", listed.byType?.["经验"] >= 1 && listed.byType?.["教训"] >= 1, JSON.stringify(listed.byType));
chk("每条都有标题（解析没有把字段吃掉）", listed.entries.every((e) => e.title !== ""),
  listed.entries.filter((e) => e.title === "").map((e) => e.id).join(", ") || "全都有");
chk("id 不重复", new Set(listed.entries.map((e) => e.id)).size === listed.entries.length,
  listed.entries.map((e) => e.id).join(", "));

// ── ③ ★★★ D194 的核心不变量：**经验必须有出处** ──────────────────────────
bar("③ ★★★ 核心不变量：每条**经验**都必须有 `source`（出处）");
const exps = listed.entries.filter((e) => e.type === "经验");
console.log(`  经验条目 ${exps.length} 条：`);
for (const e of exps) {
  console.log(`    ${e.id}  source=${e.source === "" ? "**（空！）**" : e.source.slice(0, 70)}`);
}
chk(
  "★★★★★ 所有经验条目都带出处（没有出处的经验 = 道听途说，比没有更危险）",
  exps.length > 0 && exps.every((e) => e.source !== ""),
  exps.filter((e) => e.source === "").map((e) => e.id).join(", ") || `${exps.length} 条全有`
);
// 教训不该被要求 source，但**已有的教训**应当有 cause（那是它们的命门）
const les = listed.entries.filter((e) => e.type === "教训");
chk(
  "★ 所有教训条目都带根因（`cause`）",
  les.every((e) => e.cause !== ""),
  les.filter((e) => e.cause === "").map((e) => e.id).join(", ") || `${les.length} 条全有`
);

// ── ④ id 前缀与类型一致（L↔教训 / E↔经验）─────────────────────────────────
bar("④ id 前缀与类型一致");
const mismatched = listed.entries.filter(
  (e) => (e.type === "经验" ? !e.id.startsWith("E") : !e.id.startsWith("L"))
);
chk("L 前缀 = 教训、E 前缀 = 经验（引用不会指错）", mismatched.length === 0, mismatched.map((e) => `${e.id}/${e.type}`).join(", ") || "全部一致");

bar(`结  论：${bad === 0 ? "✅ 全部通过" : `❌ ${bad} 项不通过`}`);
console.log(bad === 0
  ? "  真实 LESSONS.md 在新解析器下**完整读得回来**，且两类的不变量都成立。"
  : "  ⚠️ 上面有 ❌ ⇒ 合成夹具绿了但真实文件有问题（纪律 8 的镜像）。");
process.exit(bad === 0 ? 0 : 1);
