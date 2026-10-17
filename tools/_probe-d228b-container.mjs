// D228② · 在**容器根**（非 git）上实测 inspect()：问题记录会落到哪。
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const t = mod.__test ?? mod.default?.__test;

// 容器根 = 本项目的上两级
const CONTAINER = path.resolve(ROOT, "..", "..");
console.log("容器根 =", CONTAINER);
console.log("是否 git 仓库 =", fs.existsSync(path.join(CONTAINER, ".git")));

const info = t.inspect(CONTAINER);
console.log("\n═══ inspect(容器根) 实测 ═══");
console.log("  isGitRepo          =", info.isGitRepo);
console.log("  containerWorkspace =", info.containerWorkspace);
console.log("  notesRel           =", info.notesRel);
console.log("  notesAbs           =", info.notesAbs);
console.log("  notesSource        =", info.notesSource);

console.log("\n═══ 结论 ═══");
if (info.notesAbs === undefined) {
  console.log("  ❌ 仍解析不出 ⇒ ledger_note 会拒绝");
} else {
  console.log("  ✅ 会落到：", info.notesAbs);
  console.log("     来源：", info.notesSource, "（guess = 命中了已存在的候选目录）");
}
