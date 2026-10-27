/** _measure-f07d.mjs —— 抽离前核对：符号出处 + part2 顶层是否会触碰被搬走的符号。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const L = fs.readFileSync(path.join(ROOT, "lib", "part2.js"), "utf8").split("\n");

const importedFrom = (n) => {
  for (const l of L) {
    if (!/^import/.test(l)) continue;
    if (!new RegExp(`\\b${n}\\b`).test(l)) continue;
    const m = /from "([^"]+)"/.exec(l);
    if (m) return m[1];
  }
  return "-";
};

console.log("=== 被搬块用到的符号：part2 内声明在哪 / 或从哪 import ===");
const names = [
  "bumpSettingsBroadcast",
  "SETTINGS_PREFIX",
  "settingDefaults",
  "settingsOf",
  "SETTING_SPECS",
  "SETTING_GROUPS",
  "settingsBroadcastSeqOf",
  "normalizeSettings",
  "currentSettings",
  "EXT_MODES",
  "EXT_MODE_KEYS",
  "createExtension",
  "deleteExtension",
  "listExtensions",
  "updateExtension",
  "inspect",
  "parseLevels",
  "projectRootOf",
  "name",
];
for (const n of names) {
  const declIdx = L.findIndex((l) => new RegExp(`^export (?:function|const) ${n}\\b`).test(l));
  console.log(`  ${n.padEnd(26)} part2声明行=${declIdx >= 0 ? declIdx + 1 : "-"}  来源=${importedFrom(n)}`);
}

console.log("\n=== part2 **顶层行**（缩进 0，块外）是否引用了被搬走的符号 ===");
const moved = [
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
let hits = 0;
L.forEach((l, i) => {
  if (i >= 2191 && i < 2804) return; // 块内跳过
  if (!/^\S/.test(l)) return;
  if (/^import |^export |^\}/.test(l)) {
    /* 只关心真正的使用点，但仍列出 import/export 供核对 */
  }
  for (const m of moved) {
    if (new RegExp(`\\b${m}\\b`).test(l)) {
      hits++;
      console.log(`  ${(i + 1).toString().padStart(5)}  ${l.trim().slice(0, 150)}`);
    }
  }
});
console.log(`  合计 ${hits} 处`);

console.log("\n=== 这些符号是否出现在 part2 的 re-export 清单里（搬走就必须保留 export ... from） ===");
for (const m of moved) {
  const reexp = L.some((l) => /^export \{/.test(l) && new RegExp(`\\b${m}\\b`).test(l));
  const reexpFrom = L.some((l) => /^export \{[\s\S]*from/.test(l) && new RegExp(`\\b${m}\\b`).test(l));
  // 简单：逐行找带 from 的 export 行包含该名
  const anyFrom = L.filter((l) => /^export \{.*\}\s*from/.test(l)).some((l) => new RegExp(`\\b${m}\\b`).test(l));
  console.log(`  ${m.padEnd(24)} 在 export{} 中=${reexp}  带from=${anyFrom}`);
}
