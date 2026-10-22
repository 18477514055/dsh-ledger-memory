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
  // ★★★★★ 2026-10-22：**原来这里是一张硬编码的中文数字表**（`{十四个工具:14, 二十一个工具:21, …}`）。
  //   🔴 病（本轮当场撞到）：README 从「二十一个工具」改成「二十二个工具」后，
  //      表里没有这一项 ⇒ 解析出 `0` ⇒ 报「README 说 二十二个工具（0），代码是 22」。
  //      ★ 而**事实是对的**（22 = 22），红的只是**尺子只认它见过的那几个词**。
  //   ★★ 这与本项目「逐条列举一定会漏」是同一条：写死枚举的东西，每改一次文案就要补一次表，
  //      漏了还会报成"文档错了"——**把探针的盲区伪装成被测对象的错误**。
  //   ⇒ 换成一个**中文数字解析器**：任意 1~999 都能算，以后改数量不必动这里。
  //   ★ 只吃「数字 + 十 + 百」，其余字符一律判无效（不猜）—— 判不了就返回 null 让断言红，
  //     而不是默默算成 0（"算成 0"正是这次的病）。
  const cnNum = (s) => {
    const D = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let total = 0;
    let cur = 0;
    for (const ch of s) {
      if (Object.prototype.hasOwnProperty.call(D, ch)) cur = D[ch];
      else if (ch === "十") {
        total += (cur === 0 ? 1 : cur) * 10;
        cur = 0;
      } else if (ch === "百") {
        total += (cur === 0 ? 1 : cur) * 100;
        cur = 0;
      } else return null; // 认不出来就说认不出来，不猜
    }
    return total + cur;
  };
  const n =
    declared === null
      ? null
      : (() => {
          const digits = declared.replace(/[^\d]/g, "");
          if (digits !== "") return Number(digits); // 阿拉伯数字写法
          const cn = declared.replace(/个工具$/, "");
          return cnNum(cn);
        })();
  check(
    `README 声明的工具数（${declared ?? "未找到章节"}）与代码一致（代码 ${toolCount}）`,
    n === toolCount,
    `README 说 ${declared}（解析为 ${n}），代码是 ${toolCount}`
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
  // ★★★★★ 2026-10-18（D271）：**这条判据原来认死了措辞，等于在测文风而不是测数字**。
  //
  //   🔴 病（本轮当场撞到）：原正则要求 README 必须写 `可调**N项**`，且中文数字表**硬编到 41**。
  //     ⇒ 把 README 改成更正式的「共 **42 项**配置」之后，它报「未找到项（解析为 null）」——
  //       **数字明明是对的**，判据却因为措辞变了而失败。
  //   ★ 这是本项目反复栽过的那一类（D217「口径写死在别处」/ L13「判据只认字面量」）：
  //     **判据的价值取决于它认不认得出"同一个事实的不同合法写法"**。
  //   ★ 修法：**两种写法都认，且阿拉伯数字与中文数字都认**；
  //     中文数字改用**算法换算**（不再维护一张永远会过时的表）。
  const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const CN_UNIT = { 十: 10, 百: 100 };
  /** 把「四十二」「三十九」「12」这类写法统一成数字；认不出返回 null。 */
  const toNumber = (raw) => {
    if (/^\d+$/.test(raw)) return Number(raw);
    let total = 0;
    let cur = 0;
    for (const ch of raw) {
      if (CN_DIGIT[ch] !== undefined) cur = CN_DIGIT[ch];
      else if (CN_UNIT[ch] !== undefined) {
        // 「十」单独出现时表示 10（如「十二」= 12）
        total += (cur === 0 ? 1 : cur) * CN_UNIT[ch];
        cur = 0;
      } else return null;
    }
    return total + cur;
  };

  // ★ 认两种合法写法：`可调**N项**`（旧） 与 `共 **N 项**`（新，正式口径）
  const m = readme.match(/可调\*\*([一二三四五六七八九十百]+)项\*\*/) ?? readme.match(/共\s*\*\*\s*(\d+|[一二三四五六七八九十百]+)\s*项\s*\*\*/);
  const n = m === null ? null : toNumber(m[1]);
  check(
    `README 的设置项数与代码一致（代码 ${settingCount}）`,
    n === settingCount,
    m === null
      ? "README 里没找到「设置项数量」的声明（认这两种写法：`可调**N项**` / `共 **N 项**`）"
      : `README 说 ${m[1]}（解析为 ${n}），代码 ${settingCount}`
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
