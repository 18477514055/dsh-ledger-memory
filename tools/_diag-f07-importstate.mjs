/** _diag-f07-importstate.mjs —— 打印 inImport 状态机的每一行状态，看它是否卡死在 true。 */
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
let inImport = false;
console.log("行号  状态  内容");
for (let i = 0; i < Math.min(60, codeLines.length); i++) {
  const raw = codeLines[i];
  const before = inImport;
  let action = "";
  if (!inImport && /^\s*import\b/.test(raw)) {
    inImport = !/from\s*["']/.test(raw);
    action = `→ 进入import (from行? ${!/from\s*["']/.test(raw) ? "否" : "是"})`;
  } else if (inImport) {
    if (/from\s*["']/.test(raw) || /^\s*["']/.test(raw)) {
      inImport = false;
      action = "→ 退出import";
    } else action = "→ 仍在import";
  }
  console.log(`${String(i + 1).padStart(4)}  ${before ? "IN " : "OUT"}  ${JSON.stringify(raw.slice(0, 70))}  ${action}`);
}
console.log(`\nL642 时 inImport 前状态：`);
inImport = false;
for (let i = 0; i < 642; i++) {
  const raw = codeLines[i];
  if (!inImport && /^\s*import\b/.test(raw)) inImport = !/from\s*["']/.test(raw);
  else if (inImport) {
    if (/from\s*["']/.test(raw) || /^\s*["']/.test(raw)) inImport = false;
  }
}
console.log("  inImport =", inImport);
