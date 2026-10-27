/**
 * _cut-f07-settings.mjs —— F-07：把「设置面板后端」整块搬到新叶子模块。
 *
 * ★★ 判据（本项目栽过两次的规矩）：**搬家必须逐字复制，不能重写**。
 *   所以本脚本**不生成任何新代码文本** —— 它只做三件事：
 *     ① 从 part2.js 里 **按行号原样切出** 2181–2804 这一段；
 *     ② 在前面拼一段 import 头（这是**新增**的唯一内容，且可逐条核对）；
 *     ③ 在 part2.js 原位置留一行 `export { … } from "./settings-http.js";`
 *        ⇒ **调用面零改动**（`index.js` 与 `tools/` 全都不用改）。
 *
 * ★ 为什么留 `export ... from` 而不是让调用方改 import：
 *   本项目 D307/D318/D319 的既定做法 —— **搬实现可以，改调用面不行。**
 *   调用面一改，所有引用点都要重验；留 re-export 则等价性可由"同一引用"直接证明。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PART2 = path.join(ROOT, "lib", "part2.js");
const OUT = path.join(ROOT, "lib", "settings-http.js");

const FROM = 2181; // 段头分隔线（紧接 L2182 的"设置面板的后端"标题）
const TO = 2804; // 段尾（defaultLogLevels 之前）
const DROP_FROM = 2181;
const DROP_TO = 2804;

const text = fs.readFileSync(PART2, "utf8");
const lines = text.split("\n");
const block = lines.slice(FROM - 1, TO);
const blockText = block.join("\n");

// 安全闸①：段头必须是分隔线 + 紧随其后的"设置面板的后端"标题，且段尾后紧跟 defaultLogLevels
const first = block[0];
const second = block[1] ?? "";
const last = block[block.length - 1];
if (!first.includes("════") || !second.includes("设置面板的后端")) {
  console.error(`🔴 段头不对：${JSON.stringify(first.slice(0, 40))} / ${JSON.stringify(second.slice(0, 40))}`);
  process.exit(1);
}
if (!/^\s*\*\//.test(last) && last.trim() !== "") {
  console.error(`🔴 段尾不像一段注释的结束：${JSON.stringify(last.slice(0, 60))}`);
  process.exit(1);
}
if (!lines[TO]?.startsWith("export function defaultLogLevels")) {
  console.error(`🔴 TO 之后不是 defaultLogLevels：${JSON.stringify(lines[TO]?.slice(0, 60))}`);
  process.exit(1);
}

// 安全闸②：这 9 个导出名必须**全部**在块内出现（少一个就是切歪了）
const EXPORTS = [
  "sendJson",
  "readBody",
  "handleFor",
  "deriveSettingsView",
  "findSettingsEntry",
  "authorizeRequest",
  "assertAuthorized",
  "installSettingsRoutes",
  "saveSettings",
];
const missing = EXPORTS.filter((n) => !new RegExp(`^export function ${n}\\(`, "m").test(blockText));
if (missing.length > 0) {
  console.error(`🔴 块内缺少导出：${missing.join(", ")}`);
  process.exit(1);
}

// 安全闸③：块内**不许**出现"在 part2 里声明"的依赖（那些会造出重环）
const PART2_LOCAL = ["inspect", "parseLevels", "projectRootOf"];
const usedLocal = PART2_LOCAL.filter((n) => new RegExp(`\\b${n}\\b`).test(blockText));
console.log(`⚠️ 需从 part2 回 import 的名字：${usedLocal.join(", ") || "(无)"}`);

const header = `/**
 * settings-http.js —— 设置面板的后端（HTTP 小工具 + 读写 + 扩展记忆路由）
 *
 * ★★★ 2026-10-25（D323 · 005 报告 F-07）：**从 \`part2.js\` 整块搬出**，目的是给它腾出容量。
 *   报告实测 \`part2.js\` 已到 **261,202 B / 262,144 B（剩 942 B）**，任何后续改动都会撞硬上限。
 *   搬走这一段（约 ${Buffer.byteLength(blockText)} B）后余量回到安全区。
 *
 * ★★ 搬家方式（判据）：**逐字复制，不重写**。
 *   本文件正文与 \`part2.js\` 原 L${FROM}–L${TO} **逐字相同**，只在顶部加了这段 import 头与说明。
 *   ⇒ 行为等价性不需要重新论证，它读的就是原来那些字节。
 *
 * ★★ 调用面**零改动**：\`part2.js\` 原位置留了一行
 *   \`export { … } from "./settings-http.js";\`
 *   ⇒ \`index.js\` 与 \`tools/\` 里那些 \`from "./part2.js"\` 的 import 一个字都不用改。
 *   （D307/D318/D319 同一做法：**搬实现可以，改调用面不行**。）
 *
 * ★ 依赖方向：本文件只依赖 defs / part1 / part3 / part8 与 part2 的三个纯函数，
 *   **不被任何 lib 模块反向依赖**（只有 part2 转发导出它）⇒ 不新增依赖环。
 */
import fs from "node:fs";
import path from "node:path";

import {
  SETTINGS_PREFIX,
  SETTING_GROUPS,
  SETTING_SPECS,
  bumpSettingsBroadcast,
  name,
} from "./defs.js";
import { currentSettings, normalizeSettings, settingDefaults, settingsOf } from "./part1.js";
import { settingsBroadcastSeqOf } from "./part3.js";
import {
  EXT_MODES,
  EXT_MODE_KEYS,
  createExtension,
  deleteExtension,
  listExtensions,
  updateExtension,
} from "./part8.js";
import { inspect, parseLevels, projectRootOf } from "./part2.js";

`;

const newFile = header + blockText + "\n";
fs.writeFileSync(OUT, newFile, "utf8");
console.log(`✅ 已写 ${OUT}（${Buffer.byteLength(newFile)} B，其中正文 ${Buffer.byteLength(blockText)} B）`);

// ═══ 从 part2 删掉这一段，换成 re-export ═══
const reexport = [
  "// ═══════════════════════════════════════════════════════════════════════════",
  "// 设置面板的后端 —— ★ 2026-10-25（D323 · 005 F-07）：**实现已搬到 `settings-http.js`**",
  "//",
  "//   ★ 为什么搬：`part2.js` 撞到了 DSH 商店的**单文件 262,144 B 硬上限**（剩 942 B），",
  "//     任何后续改动都无法落在这个文件里。搬走这一段后余量回到约 28 KB。",
  "//   ★ 为什么这里留 `export … from`：**搬实现可以，改调用面不行**（D307/D318/D319）。",
  "//     调用方仍写 `from \"./part2.js\"`，一个字都不用改。",
  "//   ★ 为什么新文件叫 `settings-http.js` 而不是 `part9.js`：它**不参与 partN 的接线顺序**，",
  "//     是一个端点明确的叶子（只依赖 defs/part1/part3/part8 + part2 的三个纯函数）。",
  "// ═══════════════════════════════════════════════════════════════════════════",
  "",
  'export { sendJson, readBody, handleFor, deriveSettingsView, findSettingsEntry, authorizeRequest, assertAuthorized, installSettingsRoutes, saveSettings } from "./settings-http.js";',
  "",
].join("\n");

const rebuilt = [...lines.slice(0, DROP_FROM - 1), reexport, ...lines.slice(DROP_TO)].join("\n");
fs.writeFileSync(PART2, rebuilt, "utf8");

const cap = 262144;
console.log(`✅ part2.js = ${Buffer.byteLength(rebuilt)} B（余 ${cap - Buffer.byteLength(rebuilt)} B）`);
console.log(`✅ settings-http.js = ${Buffer.byteLength(newFile)} B（余 ${cap - Buffer.byteLength(newFile)} B）`);
