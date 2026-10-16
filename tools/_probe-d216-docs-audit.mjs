// ═══════════════════════════════════════════════════════════════════════════
// D216 · **用户可见文案的过时审计**（一次扫清，不靠我"想起来哪处"）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 用户报的（逐字）：*"我发现你可能少考虑了一些事情就是一大堆没有改的文案包括插件说明
//   包括给用户读的东西。很多很多信息都没有按照当前的进度去改。"*
//   ⇒ 判据：**不能靠"我看到的"**，必须把"会被人读到的地方"列全，逐处比对**代码真值**。
//
// ★ 什么算"给人读的"（本探针的范围）：
//   ① `package.json` —— `description`（插件页面那一行）/ `keywords`（搜索用）
//   ② `README.md` —— 主要的外向文档（npm 页面 + GitHub 首页）
//   ③ `cordis.patch.yml` —— 顶部注释
//   ④ 代码里**会渲染给用户看的字符串**（卡片文案、提示、错误消息）——
//      这类最多，用"关键词命中断言"的方式抽查
//
// ★ 比对方式：把"文档里的说法"与"代码真值"并排，**人不用猜**。
//
// 用法：node tools/_probe-d216-docs-audit.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const libText = fs
  .readdirSync(path.join(ROOT, "lib"))
  .filter((f) => f.endsWith(".js"))
  .sort()
  .map((f) => fs.readFileSync(path.join(ROOT, "lib", f), "utf8"))
  .join("\n");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const findings = [];
function check(label, ok, detail) {
  findings.push({ label, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (detail !== undefined && !ok) console.log(`      ${detail}`);
}

// ── 代码真值 ────────────────────────────────────────────────────────────────
const toolBlock = libText.match(/for \(const \[label, factory\] of \[([\s\S]*?)\n  \]\) \{/);
const toolCount = toolBlock === null ? 0 : (toolBlock[1].match(/\[\s*(?:"[a-z_]+"|[A-Z_]+),/g) ?? []).length;
const subCount = (libText.match(/sub:\s*"[a-z]+"/g) ?? []).length;
// ★★★★★ 2026-10-16（D222）：设置项数**原来只是在下面那行 log 里写死了一个 38**，
//   根本没有变量 ⇒ 断言也只能写死。⇒ 现在**真的从 spec 数**（与 selftest 情形 43 同口径）。
const settingCount = (libText.match(/^\s{4}key:\s*"[A-Za-z]+",/gm) ?? []).length;

console.log("═══ 代码真值 ═══");
console.log(`  工具 ${toolCount} 个 · 子命令 ${subCount} 个 · 设置项 ${settingCount} 个`);
console.log(`  版本 ${pkg.version}`);

// ── ① README：工具数 ────────────────────────────────────────────────────────
console.log("\n═══ ① README 的工具章节 ═══");
{
  const m = readme.match(/## ([一二三四五六七八九十百]+个工具|[0-9]+ ?个工具)/);
  const declared = m === null ? null : m[1];
  const CN = { 十四个工具: 14, 二十一个工具: 21, 八个工具: 8, 十五个工具: 15, 二十个工具: 20 };
  const n = declared === null ? null : (CN[declared] ?? Number(declared.replace(/[^\d]/g, "")));
  check(
    `README 声明的工具数（${declared ?? "未找到章节"}）与代码一致（代码 ${toolCount}）`,
    n === toolCount,
    `README 说 ${declared}（${n}），代码是 ${toolCount}`
  );
  // 表格行数（| `ledger_xxx` | ... |）
  const rows = [...readme.matchAll(/^\|\s*`(ledger_[a-z_]+)`\s*\|/gm)].map((x) => x[1]);
  check(
    `README 工具表列出 ${rows.length} 行，与代码一致`,
    rows.length === toolCount,
    `表里 ${rows.length} 行：${rows.join(", ")}`
  );
}

// ── ② README：子命令 ────────────────────────────────────────────────────────
console.log("\n═══ ② README 的子命令清单 ═══");
{
  const block = readme.match(/```\n(\/ledger[\s\S]*?)```/);
  const listed = block === null ? [] : [...block[1].matchAll(/\/ledger\s+([a-z]+)/g)].map((m) => m[1]);
  const uniq = [...new Set(listed)];
  check(
    `README 子命令 ${uniq.length} 条，与代码一致（代码 ${subCount}）`,
    uniq.length === subCount,
    `README: ${uniq.join(" ")}`
  );
}

// ── ③ README：设置项数 ──────────────────────────────────────────────────────
console.log("\n═══ ③ README 提到的设置项数 ═══");
{
  // ★★★★★ 2026-10-16（D222）**就地修**：这里原来**把 38 写死在两处**
  //   （`CN` 表 + 断言里那句"代码 38"）⇒ 一加设置项就假红，而且**红的是探针不是产品**。
  //   ★ 与 D217 那次"口径写死在别处"同型 ⇒ 改成**从代码数**（`代码实际` 已有的那个值），
  //     并把中文数字表**补全**（原来只有 3 个词，所以"三十九项"查不出来 ⇒ 报 null）。
  const m = readme.match(/可调\*\*([一二三四五六七八九十百]+)项\*\*/);
  const CN = {
    十三项: 13, 十四项: 14, 三十八项: 38, 三十九项: 39, 四十项: 40, 四十一项: 41,
  };
  const n = m === null ? null : (CN[`${m[1]}项`] ?? null);
  check(
    `README 的设置项数与代码一致（代码 ${settingCount}）`,
    n === settingCount,
    `README 说 ${m === null ? "未找到" : m[1]}项（解析为 ${n}）`
  );
}

// ── ④ README：是否还写着"两种压缩模式/增量是常态"─────────────────────────
console.log("\n═══ ④ README 的压缩叙述 ═══");
check(
  "README 不再宣称「两种压缩模式」（已合并为一种）",
  !/两个压缩模式/.test(readme) && !/两种压缩模式/.test(readme),
  "仍出现「两个/两种压缩模式」"
);
check(
  "README 不再把「增量」写成常态（默认关）",
  !/① 常态 · 增量/.test(readme),
  "仍把增量写成常态层"
);
check(
  "README 说明了增量默认关 / 已合并",
  /默认关/.test(readme) && /合并/.test(readme),
  "缺少「默认关/已合并」的说明"
);

// ── ⑤ package.json description：不能带过时说法 ─────────────────────────────
console.log("\n═══ ⑤ package.json description（插件页面那一行）═══");
const desc = pkg.description ?? "";
check("description 不含「两种压缩模式」", !/两种压缩模式/.test(desc), desc.slice(0, 80));
check("description 不含「三层上下文压缩」", !/三层上下文压缩/.test(desc), desc.slice(0, 80));
check("description 提到了卡片化记忆（新能力）", /卡片/.test(desc), desc);
check("description 长度在 300 字以内（是一行简介）", desc.length <= 300, `长度 ${desc.length}`);
check("description 提到了逐字胶囊", /胶囊/.test(desc), desc);

// ── ⑥ 代码里会渲染给用户看的字符串：有没有过时提法 ─────────────────────────
console.log("\n═══ ⑥ 代码内**渲染给用户**的文案（抽查关键词）═══");
const USER_FACING = [
  ["两种压缩模式", /两种压缩模式|两个压缩模式/],
  ["三层压缩作为现状", /三层上下文压缩/],
  ["八个工具", /八个工具/],
  ["十四个工具", /十四个工具/],
];
for (const [name, re] of USER_FACING) {
  // 只看**非注释**行（注释里的历史陈述是允许的）
  const lines = libText.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const hit = lines.filter((l) => re.test(l));
  check(`代码非注释行里没有「${name}」`, hit.length === 0, hit.slice(0, 2).map((x) => x.trim().slice(0, 80)).join(" | "));
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const bad = findings.filter((f) => !f.ok);
console.log(`\n═══ 汇总：通过 ${findings.length - bad.length} / ${findings.length} ═══`);
for (const b of bad) console.log(`  ❌ ${b.label}\n       ${b.detail ?? ""}`);
process.exitCode = bad.length === 0 ? 0 : 1;
