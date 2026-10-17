/**
 * D231 反向验证 —— 断言**真的能被弄红**吗？
 *
 * ★ 为什么必须做（纪律 10）：摘一处不红 ⇒ 要么断言太弱、要么修复冗余。
 *   本卡新增两条关键断言：
 *     63④  守卫条件里必须同时有 `hasLedger` 与 `!reminded`
 *     63④b `hasLedger` 必须由 `info.activeRel` 算出（**不许写成恒真**）
 * ★ 本条探针模拟三种"看起来修好了、其实没修"的改法，要求它们**都变红**。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ★ 必须用 `fileURLToPath`：`new URL(...).pathname` **不解中文百分号编码**
//   ⇒ 路径里只要含中文就 ENOENT（本机项目路径全是中文，踩过一次就记住了）。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "lib");

const read = (n) => fs.readFileSync(path.join(LIB, n), "utf8");
const idx = read("index.js");

const RE_63_4 =
  /if \(hasLedger && !reminded && \(pend !== undefined \|\| needWrite \|\| needTriage\)\) \{/;
const RE_63_4b_A = /const hasLedger = info\?\.activeRel !== undefined;/;
const RE_63_4b_B = /const hasLedger = true/;

function judge(label, src, expectRed) {
  const a = RE_63_4.test(src);
  const b = RE_63_4b_A.test(src) && !RE_63_4b_B.test(src);
  const red = !a || !b;
  const verdict = red === expectRed ? "OK" : "★ 判据失准";
  console.log(
    `  ${verdict}  ${label}：63④=${a ? "绿" : "红"} 63④b=${b ? "绿" : "红"} ` +
      `⇒ 期望${expectRed ? "红" : "绿"}，实得${red ? "红" : "绿"}`
  );
  return red === expectRed;
}

console.log("═══ D231 反向验证（纪律 10：必须能看见红）═══");
let all = true;

// 基线：真实源码 ⇒ 必须绿
all = judge("基线（真实源码）", idx, false) && all;

// 反向 A：把 `hasLedger` 从守卫里摘掉（= 回到用户报的那个缺陷）
const revA = idx.replace(
  "if (hasLedger && !reminded",
  "if (!reminded"
);
all = judge("反向A 摘掉 hasLedger 守卫", revA, true) && all;

// 反向 B：`hasLedger` 改成恒真（★ 这是最容易漏掉的"假修"：63④ 仍绿）
const revB = idx.replace(
  "const hasLedger = info?.activeRel !== undefined;",
  "const hasLedger = true;"
);
all = judge("反向B hasLedger 恒真（假修）", revB, true) && all;

// 反向 C：把 `!reminded` 摘掉（= 每步都注入，打烂 prompt 缓存）
const revC = idx.replace(
  "if (hasLedger && !reminded",
  "if (hasLedger"
);
all = judge("反向C 摘掉 !reminded（每步注入）", revC, true) && all;

console.log(all ? "\n✅ 四种情形全部符合预期" : "\n❌ 有判据失准 —— 先修断言，别报结论");
process.exit(all ? 0 : 1);
