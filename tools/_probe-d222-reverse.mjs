// D222 · 反向验证：把「唯一出口」退回旧的「清单优先」写法，必须**看见红**
//
// ★ 纪律 10：**反向验证必须摘到"能看见红"为止** —— 摘一处不红，
//   要么断言太弱、要么修复冗余，两种都要查清。
// ★ 这里摘的是**唯一出口**：把 `precedenceValue` 的"面板优先"分支砍掉，
//   让它退回老的"清单里有就用清单" ⇒ 那 5 个判定点会全部回到旧行为。
//   如果自检**一条都不红**，说明我新写的那些断言根本没在守这件事。
//
// 用法：node tools/_probe-d222-reverse.mjs [--restore]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, "..", "lib", "part1.js");
const BAK = path.join(process.env.TEMP ?? ".", "part1-before-d222-reverse.js");

if (process.argv.includes("--restore")) {
  fs.copyFileSync(BAK, TARGET);
  console.log("已还原 lib/part1.js");
  process.exit(0);
}

const src = fs.readFileSync(TARGET, "utf8");

// 摘除点：把"面板优先"那一步删掉，直接进"清单优先"逻辑（= 旧行为）
const MARK = `  // ① 面板选了"以面板为准"（默认）⇒ 清单**不参与**（这正是不必逐项目去改的原因）。\n  if (s.settingPrecedence !== PRECEDENCE_PROJECT) return panel;\n`;
if (!src.includes(MARK)) {
  console.error("★ 没定位到那句'面板优先' —— 夹具故障，不是结论");
  process.exit(2);
}

fs.writeFileSync(BAK, src);
fs.writeFileSync(TARGET, src.replace(MARK, "  // （反向验证：这一句被摘掉了 ⇒ 退回旧的清单优先）\n"));
console.log("已摘掉「面板优先」那一句（= 退回旧行为）");
