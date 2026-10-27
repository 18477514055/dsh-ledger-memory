/** _diag-f07-used.mjs —— 打印 used 收集时对 setActiveSettings 的每一个判定条件。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = fs.readFileSync(path.join(ROOT, "lib", "settings-http.js"), "utf8");
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
console.log("剥离后行数 =", codeLines.length);

const TARGET = "setActiveSettings";
console.log("\n=== 剥离后仍含 target 的行 ===");
codeLines.forEach((l, i) => {
  if (l.includes(TARGET)) console.log(`L${i + 1}: ${JSON.stringify(l)}`);
});

// 逐行跑 used 逻辑，但打印 target
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

let inImport = false;
for (let i = 0; i < codeLines.length; i++) {
  const raw = codeLines[i];
  if (!inImport && /^\s*import\b/.test(raw)) {
    inImport = !/from\s*["']/.test(raw);
    continue;
  }
  if (inImport) {
    if (/from\s*["']/.test(raw) || /^\s*["']/.test(raw)) inImport = false;
    continue;
  }
  if (/^\s*export\s*\{/.test(raw)) continue;
  for (const m of raw.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (m[0] !== TARGET) continue;
    const idx = m.index;
    const after = raw.slice(idx + m[0].length).trimStart();
    console.log(`\nL${i + 1} 命中 target`);
    console.log(`  raw = ${JSON.stringify(raw)}`);
    console.log(`  在 GLOBALS? ${GLOBALS.has(TARGET)}   在 KEYWORDS? ${KEYWORDS.has(TARGET)}`);
    console.log(`  after = ${JSON.stringify(after.slice(0, 20))}`);
    console.log(`  跳过条件「像对象键」= ${after.startsWith(":") && !after.startsWith("::")}`);
  }
}
