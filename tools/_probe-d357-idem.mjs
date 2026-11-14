// _probe-d357-idem.mjs —— 找出 applyFingerprint3 对哪些内容不幂等
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyFingerprint3, identityOfPath, readFingerprint3 } from "../lib/fingerprint.js";

const MEM = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账\\10.项目台账-ledger-memory";
const PROJ = "6627de0c5a2887e2";
const info = {
  memoryBase: MEM, active: "LEDGER.md", journal: "JOURNAL.md", principles: "PRINCIPLES.md",
  decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals",
};

// 收集文件
const files = [];
const walk = (d) => {
  let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name === "node_modules" || e.name === ".git") continue; walk(p); }
    else if (e.isFile() && e.name.endsWith(".md")) files.push(p);
  }
};
walk(MEM);
console.log(`扫描 ${files.length} 个 .md`);

let notIdem = 0;
const samples = [];
for (const abs of files) {
  const id = identityOfPath(info, abs);
  if (id === undefined) continue;
  const t0 = fs.readFileSync(abs, "utf8");
  const t1 = applyFingerprint3(t0, { ...id, project: PROJ }).text;
  const t2 = applyFingerprint3(t1, { ...id, project: PROJ }).text;
  if (t1 !== t2) {
    notIdem += 1;
    if (samples.length < 4) {
      // 找首个差异
      let i = 0;
      while (i < Math.min(t1.length, t2.length) && t1[i] === t2[i]) i += 1;
      samples.push({
        rel: path.relative(MEM, abs),
        len1: t1.length, len2: t2.length,
        at: i,
        a: JSON.stringify(t1.slice(Math.max(0, i - 40), i + 60)),
        b: JSON.stringify(t2.slice(Math.max(0, i - 40), i + 60)),
      });
    }
  }
}
console.log(`\n不幂等的文件数 = ${notIdem} / ${files.length}`);
for (const s of samples) {
  console.log(`\n--- ${s.rel} ---`);
  console.log(`  长度 ${s.len1} → ${s.len2}，首差异位置 ${s.at}`);
  console.log(`  第一次: ${s.a}`);
  console.log(`  第二次: ${s.b}`);
}
console.log("\nPROBE-COMPLETE");
