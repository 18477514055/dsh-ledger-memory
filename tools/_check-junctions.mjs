// 只读：检查项目树里有没有联接（junction / symlink）。
// ★ 本机纪律：复制/打包前必须先问"这棵树里有没有联接"——判联接要用 lstatSync / Dirent，
//   statSync 会跟随、把联接当普通目录（踩过）。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const links = [];
let files = 0;
let dirs = 0;

function walk(dir, depth) {
  if (depth > 12) return;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      links.push({ p: path.relative(ROOT, p), kind: "symlink" });
      continue; // 不跟进去
    }
    if (e.isDirectory()) {
      // Windows junction 在 lstat 里表现为目录，但 reparse 属性为真
      const isJ = typeof e.isSymbolicLink === "function" && e.isSymbolicLink();
      if (isJ) {
        links.push({ p: path.relative(ROOT, p), kind: "junction-ish" });
        continue;
      }
      dirs += 1;
      walk(p, depth + 1);
    } else if (e.isFile()) {
      files += 1;
    }
  }
}

walk(ROOT, 0);

console.log("目录数:", dirs);
console.log("文件数:", files);
console.log("联接数:", links.length);
if (links.length > 0) {
  for (const l of links.slice(0, 40)) console.log("  " + l.kind + "  " + l.p);
}
