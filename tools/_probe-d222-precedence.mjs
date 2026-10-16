// D222 · 排查「设置面板改了，老项目没同步」——把「谁管用」逐项算出来
//
// ★ 为什么先做这个（纪律 12：「看起来没做」要先分清「没做」与「做了但没被记对」）：
//   要分清**两件截然不同的事**：
//     ① 面板改的东西**到底有没有生效**（非 project-first 的项，改完立刻全局生效）；
//     ② project-first 的那几项，是不是**清单值盖掉了面板值**（设计如此，不是 bug）。
//   ⇒ 只有把两类分开数，才能回答"是不是所有设置都只对新对话生效"。
//
// 用法：node tools/_probe-d222-precedence.mjs [项目目录]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const target = process.argv[2] ?? ROOT;

// ★ 必须在 import lib/ **之前**把家指到沙箱（否则可能摸到用户真实的家）
process.env.DSH_HOME = fs.mkdtempSync(path.join(process.env.TEMP ?? ".", "probe-d222-home-"));

const defs = await import(new URL(`file:///${path.join(ROOT, "lib", "defs.js").replace(/\\/g, "/")}`).href);
const part1 = await import(new URL(`file:///${path.join(ROOT, "lib", "part1.js").replace(/\\/g, "/")}`).href);

const specs = defs.SETTING_SPECS ?? [];
const s = part1.currentSettings();
// ★★★★★ 2026-10-16（D222）：**必须走被测代码自己的那个出口**。
//   ⚠️ 我第一版在这里**自己重写了一遍"清单优先"**（`hasKey ? manifest[k] : s[k]`）——
//     那是我自己的尺子：代码已经改成走 `precedenceValue` 了，探针还按旧口径算
//     ⇒ 它会**继续报"清单盖掉面板"**，与真实行为相反（= 假红，且会误导我改错地方）。
//   本项目纪律 2：**判据的输入必须是"被测对象自己产生的那部分"**。
const precValue = part1.precedenceValue;
const precFromManifest = part1.precedenceFromManifest;

const manPath = path.join(target, ".dsh-ledger.json");
const manifest = fs.existsSync(manPath) ? JSON.parse(fs.readFileSync(manPath, "utf8")) : {};
// ★ 注意顺序：`manifest` 是 `const` ⇒ 必须在它**之后**才能引用（TDZ 会 ReferenceError）。
const info = { manifest };

const hasKey = (k) => Object.prototype.hasOwnProperty.call(manifest, k) && manifest[k] !== undefined && manifest[k] !== null;

const pf = specs.filter((x) => x.scopeNote === "project-first");
const other = specs.filter((x) => x.scopeNote !== "project-first");

console.log("═".repeat(74));
console.log(`项目：${target}`);
console.log(`清单：${fs.existsSync(manPath) ? manPath : "（不存在）"}`);
console.log(`设置项总数：${specs.length}｜其中 project-first：${pf.length}｜其余：${other.length}`);
console.log("═".repeat(74));

console.log(`\n【① project-first 的 ${pf.length} 项 —— 谁管用**问代码自己的出口**】`);
for (const spec of pf) {
  const has = hasKey(spec.key);
  const fromMan = precFromManifest(info, spec.key);
  const win = precValue(info, spec.key);
  console.log(`  ${spec.key.padEnd(20)} 清单里有=${has ? JSON.stringify(manifest[spec.key]) : "（无）"}`);
  console.log(`  ${"".padEnd(20)} 面板=${JSON.stringify(s[spec.key])}`);
  console.log(`  ${"".padEnd(20)} ⇒ 生效=${JSON.stringify(win)}   （来源：${fromMan ? "★ 清单 —— 盖掉面板" : "面板"}）\n`);
}

console.log(`\n【② 另外 ${other.length} 项 —— 面板改完立刻全局生效，与新老对话无关】`);
console.log("  " + other.map((x) => x.key).join(", "));

console.log("\n" + "═".repeat(74));
const overridden = pf.filter((x) => precFromManifest(info, x.key));
console.log("结论：");
console.log(`  · 优先口径 = **${s.settingPrecedence === "project" ? "以项目清单为准" : "以设置面板为准（默认）"}**；`);
console.log(`  · ${other.length} 项跟着面板走 —— **不存在"只对新对话生效"**；`);
console.log(`  · ${pf.length} 项受清单管辖，当前**真正被清单盖住的** ${overridden.length} 项：${overridden.map((x) => x.key).join(", ") || "（无）"}`);
if (overridden.length === 0) console.log("    ⇒ ★ 全部以面板为准：面板一改，这个老项目**立刻跟着变**（它报的那个问题已解）。");
console.log("═".repeat(74));

fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });
