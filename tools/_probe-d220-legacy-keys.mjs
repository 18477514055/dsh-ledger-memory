// D220 · 查清 .dsh-ledger.json 里那三个"旧单文件键"的实际影响
//
// 背景：清单里同时有 `decisions: "DECISIONS.md"` 与 `decisionsDir: "decisions"`（两个轴），
//   而 `DECISIONS.md` **已不在盘上**（卡片化后删了）⇒ `decisionsRel` 指向一个不存在的文件。
// ★ 关键问题：这会不会让**合规检查误报**？（代码注释里写着"情形 21b 实测撞到"）
//
// 用法：node tools/_probe-d220-legacy-keys.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, ".dsh-ledger.json"), "utf8"));

console.log("═══ ① 清单里两套键 vs 盘上实况 ═══");
const rows = [
  ["decisions", "decisionsDir", "decisions"],
  ["lessons", "lessonsDir", "lessons"],
  ["goals", "goalsDir", "goals"],
];
for (const [fileKey, dirKey, dirName] of rows) {
  const fileVal = manifest[fileKey];
  const dirVal = manifest[dirKey];
  const fileExists = typeof fileVal === "string" && fs.existsSync(path.join(ROOT, fileVal));
  const dirExists = typeof dirVal === "string" && fs.existsSync(path.join(ROOT, dirVal));
  const dirCount = dirExists
    ? fs.readdirSync(path.join(ROOT, dirVal)).filter((n) => n.endsWith(".md")).length
    : 0;
  console.log(`  ${fileKey.padEnd(11)} = ${JSON.stringify(fileVal).padEnd(18)} 文件在盘上? ${fileExists ? "✅ 在" : "⛔ 不在"}`);
  console.log(`  ${dirKey.padEnd(11)} = ${JSON.stringify(dirVal).padEnd(18)} 目录在盘上? ${dirExists ? `✅ 在（${dirCount} 张卡）` : "⛔ 不在"}  ← 实际生效的是这个`);
}

console.log("\n═══ ② 那三个遗留键在代码里被读的**位置与用途** ═══");
const libDir = path.join(ROOT, "lib");
const hits = [];
for (const f of fs.readdirSync(libDir).filter((n) => n.endsWith(".js"))) {
  const lines = fs.readFileSync(path.join(libDir, f), "utf8").split("\n");
  lines.forEach((l, i) => {
    if (/manifest\?\.(decisions|lessons|goals)\b/.test(l)) hits.push(`${f}:${i + 1}  ${l.trim()}`);
  });
}
for (const h of hits) console.log("  " + h);
console.log(`  ⇒ ${hits.length} 处（全在 inspect() 里算 *Rel；卡片模式下该值只当「迁移来源」）`);

console.log("\n═══ ③ ★ 直接问运行时：合规检查现在报什么 ═══");
const { inspect, conformanceOf } = await import(path.join(libDir, "part2.js")).catch(() => ({}));
if (typeof inspect !== "function") {
  console.log("  （取不到 inspect —— 它是内部函数，改走 conformanceOf 或跳过）");
} else {
  const info = inspect(ROOT);
  console.log(`  decisionsRel = ${JSON.stringify(info.decisionsRel)}  source=${info.decisionsSource}`);
  console.log(`  decisionsDir = ${JSON.stringify(info.decisionsDir)}`);
  console.log(`  lessonsRel   = ${JSON.stringify(info.lessonsRel)}    lessonsDir=${JSON.stringify(info.lessonsDir)}`);
  console.log(`  goalsRel     = ${JSON.stringify(info.goalsRel)}      goalsDir=${JSON.stringify(info.goalsDir)}`);
  if (typeof conformanceOf === "function") {
    const c = conformanceOf(info);
    console.log(`\n  合规：ok=${c.ok}`);
    if (Array.isArray(c.reasons)) for (const r of c.reasons) console.log(`    ⚠ ${r}`);
    if (Array.isArray(c.fixable)) for (const r of c.fixable) console.log(`    → 可修：${r}`);
    if (!c.reasons || c.reasons.length === 0) console.log("    ✅ 没有不合适项");
  }
}
