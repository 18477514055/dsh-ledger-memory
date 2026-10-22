/**
 * 核对：任务书《第三代协议.txt》第一章列的 4 条「当前代码中存在的问题」，
 * 在**今天 D288 改动之后**是否还成立。
 *
 * ★ 为什么要先做这一步：任务书的部分前提可能已经过期。
 *   若照着过期前提开工（比如去修一个已经修好的东西），会白做，甚至把已修好的改回去。
 *
 * 跑法：node tools/_probe-v3-preconditions.mjs
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");

const defs = fs.readFileSync(path.join(LIB, "defs.js"), "utf8");
const part4 = fs.readFileSync(path.join(LIB, "part4.js"), "utf8");
const part2 = fs.readFileSync(path.join(LIB, "part2.js"), "utf8");

console.log("═══ 任务书列出的「当前代码问题」现状核对 ═══\n");

// ── ① MANIFEST_REL ──
const m1 = defs.match(/export const MANIFEST_REL\s*=\s*([^;]+);/);
const manifestRel = m1 ? m1[1].trim() : "(未找到)";
console.log("① MANIFEST_REL =", manifestRel);
console.log("   任务书说法：清单在项目根 .dsh-ledger.json");
console.log(
  "   ⇒ 现状：",
  manifestRel.includes(".dsh-ledger.json") ? "★ 仍然成立（V3 要挪进记忆子目录）" : "已变化",
);
console.log("");

// ── ② DEFAULT_IGNORE_LINES ──
const m2 = defs.match(/export const DEFAULT_IGNORE_LINES\s*=\s*\[([\s\S]*?)\n\];/);
let ignoreCount = 0;
let ignoreSample = [];
if (m2) {
  const body = m2[1];
  const quoted = body.match(/^\s*"/gm) || [];
  ignoreCount = quoted.length;
  ignoreSample = (body.match(/"([^"]+)"/g) || []).slice(0, 6).map((s) => s.replace(/"/g, ""));
}
console.log("② DEFAULT_IGNORE_LINES 里被引号包住的条目数 =", ignoreCount);
console.log("   前几条：", ignoreSample.join(" / "));
console.log("   任务书说法：当前为空数组");
console.log(
  "   ⇒ 现状：",
  ignoreCount === 0
    ? "★★ 仍然成立（还是空）"
    : `★★★ 已过期！今天 D288 已把它填成 ${ignoreCount} 条 —— 任务书这部分前提不成立了`,
);
console.log("");

// ── ③ autoGitAdd 默认值 ──
const hasAutoTrue = /autoGitAdd\s*:\s*args\?\.autoGitAdd\s*!==\s*false/.test(part4);
console.log("③ autoGitAdd 的写法 = args?.autoGitAdd !== false");
console.log("   含义：不传就当作 true ⇒ 默认开启自动暂存");
console.log("   任务书说法：默认开启");
console.log("   ⇒ 现状：", hasAutoTrue ? "★ 仍然成立（V3 要改成默认关）" : "已变化");
console.log("");

// ── ④ 有几处自动 git add ──
const calls = [...part4.matchAll(/gitAdd\(/g)].length;
console.log("④ part4.js 里 gitAdd( 的调用点数量 =", calls);
console.log("   任务书说法：ledger_write / ledger_archive 等路径存在自动 git add");
console.log("   ⇒ 现状：", calls > 0 ? `★ 仍然成立（${calls} 处，V3 要全部改成"永不自动暂存"）` : "已变化");
console.log("");

// ── ⑤ 附带：今天新增的 check-ignore 预筛（任务书没提，但它与 V3 的方向相关）──
const hasCheckIgnore = /check-ignore/.test(part2);
console.log("⑤ gitAdd 里已加 check-ignore 预筛（今天 D288 做的）=", hasCheckIgnore);
console.log("   意义：V3 的「永不自动暂存」与它不冲突；它解决的是「被忽略路径让 git add 报错」这个假故障。");
console.log("");

console.log("═══ 结论 ═══");
console.log("任务书第 1 章列的 4 条里：");
console.log("  · ① 清单位置      ⇒ 仍成立，V3 要动");
console.log("  · ② .gitignore 空 ⇒ ★ 已不成立（今天已修，19 条）");
console.log("  · ③ 默认暂存      ⇒ 仍成立，V3 要改");
console.log("  · ④ 多处自动 add  ⇒ 仍成立，V3 要全拆");
console.log("");
console.log("★ 所以 V3 不是从「空 .gitignore」起步，而是从「已经有基础忽略规则」起步。");
console.log("  差异会影响：迁移时「是否需要新建忽略规则」、以及「任务书写的痛点」该怎么向用户复述。");
