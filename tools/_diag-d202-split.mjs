/**
 * 只读诊断：`splitIntoCardParts` 在**真** DECISIONS.md 上为什么"不无损"且有重复键？
 * ★ 纪律：先查清根因再改，不猜。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const T = mod.__test;

const raw = fs.readFileSync(path.join(ROOT, "DECISIONS.md"), "utf8");
const parts = T.splitIntoCardParts(raw, "decisions");

// ── ① 重复键：到底是哪几个？它们长什么样？────────────────────────────
const seen = new Map();
const dups = [];
for (const p of parts) {
  if (seen.has(p.key)) dups.push(p.key);
  seen.set(p.key, (seen.get(p.key) ?? 0) + 1);
}
console.log(`① 重复键 ${dups.length} 个：${dups.slice(0, 20).join(", ")}${dups.length > 20 ? " …" : ""}`);

// 找出重复键**在原文里的行号**与**那行原文**
const lines = raw.split(/\r?\n/);
const re = /^##\s*D(\d+)(?![\dA-Za-z])/;
for (const k of dups.slice(0, 6)) {
  const hits = [];
  lines.forEach((l, i) => {
    const m = re.exec(l);
    if (m !== null && `D${m[1]}` === k) hits.push({ line: i + 1, text: l });
  });
  console.log(`\n  ── ${k} 命中 ${hits.length} 次 ──`);
  for (const h of hits) console.log(`     第 ${h.line} 行: ${h.text.slice(0, 90)}`);
  // 看它前面几行，判断是不是在代码块/引用里
  const first = hits[0]?.line ?? 1;
  console.log("     上文（前 4 行）：");
  for (let i = Math.max(0, first - 5); i < first - 1; i++) console.log(`       | ${lines[i]?.slice(0, 86) ?? ""}`);
}

// ── ② 是否在代码围栏内？────────────────────────────────────────────────
let inFence = false;
let insideCount = 0;
const insideSamples = [];
lines.forEach((l, i) => {
  if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
  const m = /^##\s*D(\d+)(?![\dA-Za-z])/.exec(l);
  if (m !== null && inFence) {
    insideCount++;
    if (insideSamples.length < 6) insideSamples.push({ line: i + 1, text: l.slice(0, 80) });
  }
});
console.log(`\n② 落在**代码围栏内**的 "## D<n>" 行：${insideCount} 行`);
for (const s of insideSamples) console.log(`     第 ${s.line} 行: ${s.text}`);

// ── ③ 丢的那 490 字符在哪？──────────────────────────────────────────────
const rejoined = parts.map((p) => p.text).join("\n");
const strip = (s) => s.replace(/\r?\n\s*\r?\n+/g, "\n\n").trim();
const a = strip(raw);
const b = strip(rejoined);
console.log(`\n③ 归一化后：原文 ${a.length} · 拼回 ${b.length}（差 ${a.length - b.length}）`);
if (a !== b) {
  // 找第一个不同处
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  console.log(`   第一个不同在偏移 ${i}：`);
  console.log(`     原文: ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))}`);
  console.log(`     拼回: ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}`);
}

// ── ④ 逐段核对：哪一段对不上原文里对应的那段 ────────────────────────────
const starts = [];
lines.forEach((l, i) => { const m = re.exec(l); if (m !== null) starts.push({ key: `D${m[1]}`, line: i }); });
let mismatches = 0;
for (let i = 0; i < starts.length && mismatches < 3; i++) {
  const from = starts[i].line;
  const to = i + 1 < starts.length ? starts[i + 1].line : lines.length;
  const expect = lines.slice(from, to).join("\n").replace(/\s+$/, "");
  const got = parts[i]?.text ?? "";
  // 第一张卡会多一段前言 ⇒ 用"包含"判
  const ok = i === 0 ? got.endsWith(expect) : got === expect;
  if (!ok) {
    mismatches++;
    console.log(`\n④ ${starts[i].key}（第 ${from + 1}-${to} 行）对不上：期望 ${expect.length} 字符 · 实得 ${got.length}`);
    console.log(`   期望尾部: ${JSON.stringify(expect.slice(-70))}`);
    console.log(`   实得尾部: ${JSON.stringify(got.slice(-70))}`);
  }
}
console.log(`\n④ 逐段核对：${mismatches === 0 ? "全部对得上" : `${mismatches} 段对不上`}`);
