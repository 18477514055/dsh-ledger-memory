/** _diag-d323-break3b.mjs —— 复刻破坏3 的处理，把结果落盘检查。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "lib", "settings-http.js"), "utf8");

const at = src.indexOf("export function saveSettings");
const seg = src.slice(at);
const lineRe = /^\s*const verdict = assertAuthorized\(scope, req\);\s*$/m;
const m = lineRe.exec(seg);
console.log("命中:", JSON.stringify(m?.[0]));

let next = src.slice(0, at) + seg.replace(lineRe, "// (反向验证：自查被挪走)");
console.log("替换后 assertAuthorized 在 saveSettings 段里还在吗:",
  next.slice(next.indexOf("export function saveSettings")).includes("assertAuthorized"));

const editAt = next.indexOf(".edit(", at);
console.log("editAt =", editAt);
const closeIdx = next.indexOf("});", editAt);
console.log("' });' at", closeIdx);
const insertAt = next.indexOf("\n", closeIdx);
console.log("insertAt =", insertAt);

const final = next.slice(0, insertAt + 1) + "    const verdict2 = assertAuthorized(scope, req);\n" + next.slice(insertAt + 1);

// 现在按探针的判据检查
const at2 = final.indexOf("export function saveSettings");
const seg2 = final.slice(at2, at2 + 8000);
const editRel = seg2.indexOf(".edit(");
const assertRel = seg2.indexOf("assertAuthorized");
console.log("\n探针判据：assertRel =", assertRel, " editRel =", editRel, " ⇒ 会红?", editRel > assertRel);
console.log("\n插入点附近：");
console.log(JSON.stringify(final.slice(insertAt - 80, insertAt + 80)));
