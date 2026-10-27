/** _diag-f07-why-green2.mjs —— 逐层追踪 setActiveSettings 在判定链上被哪一步放过。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = fs.readFileSync(path.join(ROOT, "lib", "settings-http.js"), "utf8");
const lines = text.split("\n");

// 复刻扫描器的 stripNonCode
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

const code = stripNonCode(text);
const codeLines = code.split("\n");
console.log("剥离后行数 =", codeLines.length, " 原文行数 =", lines.length);
console.log("=== 剥离后 L642 附近 ===");
for (let i = 638; i < 646; i++) console.log((i + 1).toString().padStart(5), JSON.stringify(codeLines[i]));

// 逐层判据
const bound = new Set();
let inImport = false;
const boundHits = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (!inImport && /^import\b/.test(l)) inImport = !/from\s*["']/.test(l);
  if (inImport) {
    const b = /\{([^}]*)\}/.exec(l);
    if (b) for (const x of b[1].split(",")) {
      const t = x.trim().split(/\s+as\s+/).pop().trim();
      if (t) {
        bound.add(t);
        if (t === "setActiveSettings") boundHits.push(i + 1);
      }
    }
    if (/from\s*["']/.test(l)) inImport = false;
    continue;
  }
  const b = /\{([^}]*)\}/.exec(l);
  if (/^import/.test(l) && b) for (const x of b[1].split(",")) {
    const t = x.trim().split(/\s+as\s+/).pop().trim();
    if (t) bound.add(t);
  }
}
console.log("\nbound.has(setActiveSettings) =", bound.has("setActiveSettings"));

// 找 setActiveSettings 在剥离后的行
console.log("\n=== 剥离后含 setActiveSettings 的行 ===");
codeLines.forEach((l, i) => {
  if (/setActiveSettings/.test(l)) console.log(`  L${i + 1}: ${JSON.stringify(l)}`);
});
