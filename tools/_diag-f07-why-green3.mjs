/** _diag-f07-why-green3.mjs —— 把 used 收集的**每个跳过条件**都打印出来。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = process.argv[2] ?? "lib/settings-http.js";
const text = fs.readFileSync(path.join(ROOT, FILE), "utf8");

// 直接把 _check-f07-imports.mjs 的判定函数拿过来跑，但打印每一步
const mod = await import(`file:///${path.join(ROOT, "tools", "_check-f07-imports.mjs").replace(/\\/g, "/")}`).catch(
  (e) => {
    console.log("导入失败（它 process.exit 了）：", e.message);
    return null;
  }
);

// 既然 import 会 exit，就手动复刻并打印
const lines = text.split("\n");
function stripNonCode(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === q) {
          i++;
          break;
        }
        if (src[i] === "\n") out += "\n";
        i++;
      }
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
const codeLines = stripNonCode(text).split("\n");

const GLOBALS = new Set(
  ("process console JSON Math Date String Number Boolean Object Array Promise RegExp Error Map Set Symbol BigInt " +
    "Buffer globalThis this super return function async await true false null undefined NaN Infinity typeof " +
    "instanceof in of new delete void setTimeout clearTimeout URL parseInt parseFloat isNaN encodeURIComponent " +
    "decodeURIComponent fs path")
    .split(/\s+/)
);
const KEYWORDS = new Set(
  ("import from export default const let var function class return if else for while do switch case break continue " +
    "try catch finally throw new typeof instanceof in of delete void this super async await yield")
    .split(/\s+/)
);

const target = "setActiveSettings";
for (let i = 0; i < codeLines.length; i++) {
  const raw = codeLines[i];
  for (const m of raw.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (m[0] !== target) continue;
    const idx = m.index;
    const prevChar = idx > 0 ? raw[idx - 1] : "(行首)";
    const after = raw.slice(idx + m[0].length).trimStart();
    console.log(`L${i + 1}  命中 ${target}`);
    console.log(`   raw        = ${JSON.stringify(raw)}`);
    console.log(`   前一个字符 = ${JSON.stringify(prevChar)}`);
    console.log(`   后面剩余   = ${JSON.stringify(after.slice(0, 30))}`);
    console.log(`   是属性名?  = ${prevChar === "."}`);
    console.log(`   像对象键?  = ${after.startsWith(":") && !after.startsWith("::")}`);
    console.log(`   在 KEYWORDS/GLOBALS? = ${KEYWORDS.has(target)} / ${GLOBALS.has(target)}`);
  }
}
