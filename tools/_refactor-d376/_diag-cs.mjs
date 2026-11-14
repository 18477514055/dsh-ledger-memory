import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

// 模拟 index.js 的加载顺序：先 part1，再取 currentSettings
const P = process.cwd();

const part1 = await import(pathToFileURL(path.join(P, "lib", "part1.js")).href);
console.log("currentSettings 类型:", typeof part1.currentSettings);
console.log("numOf 类型:", typeof part1.numOf);
console.log("splitBlocks 类型:", typeof part1.splitBlocks);
console.log("dshHome 类型:", typeof part1.dshHome);
console.log("settingDefaults 类型:", typeof part1.settingDefaults);

// 试着调一下
try {
  console.log("currentSettings():", JSON.stringify(part1.currentSettings()).slice(0, 80));
} catch (e) {
  console.log("currentSettings() 抛错:", e.message);
}
