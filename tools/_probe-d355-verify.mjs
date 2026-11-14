// _probe-d355-verify.mjs —— 修复后的影响复测：三载体 + splitBlocks 跳过
// ★ 对着 D355 第一轮抓出的三个失败项逐条验：
//   F1 分块数变（LEDGER 15→16，frontmatter 自成一块）
//   F2 每张卡块数 +1
//   F3 seal 变 ⇒ block hash 变（块级注入省字失效）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { splitBlocks } from "../lib/part1.js";
import { entryTocOf } from "../lib/card-ops.js";
import { applyFingerprint3, readFingerprint3 } from "../lib/fingerprint.js";

const MEM = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账\\10.项目台账-ledger-memory";
const TOK = 1.72;
const PROJ = "0123456789abcdef";
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e === undefined ? "" : "  ← " + e}`); } };
const eq = (n, a, b) => ok(n, a === b, `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`);

// ══════════════════════════════════════════════════════════
console.log("=== F1. 台账分块数（原 15 → 16，现应不变）===");
{
  const raw = fs.readFileSync(path.join(MEM, "LEDGER.md"), "utf8");
  const after = applyFingerprint3(raw, { kind: "active", project: PROJ, key: "-" }).text;
  const b1 = splitBlocks(raw), b2 = splitBlocks(after);
  eq("★ 分块数不变", b2.length, b1.length);
  console.log(`  ${b1.length} → ${b2.length}`);

  // 逐块 hash 必须**逐一相同**（这是"内容没变就不重注"的前提）
  let same = 0;
  for (let i = 0; i < b1.length; i += 1) if (b1[i].hash === b2[i].hash) same += 1;
  eq("★★ 逐块 hash 全部相同", same, b1.length);

  // 注入正文里不该出现任何载体
  const inj = b2.map((x) => x.text).join("\n");
  ok("★ frontmatter 不进分块", !inj.includes("dsh-fp-front"));
  ok("★ 链接定义不进分块", !inj.includes("[dsh-fp-link]"));
  console.log(`  注入正文长度: ${b1.reduce((a, x) => a + x.text.length, 0)} → ${b2.reduce((a, x) => a + x.text.length, 0)}`);
  eq("★★ 注入正文长度完全不变", b2.reduce((a, x) => a + x.text.length, 0), b1.reduce((a, x) => a + x.text.length, 0));

  // 但文件里确实写了
  ok("文件里确实有 frontmatter", after.includes("dsh-fp-front"));
  ok("文件里确实有链接定义", after.includes("[dsh-fp-link]"));
  ok("文件里确实有行内信标", after.includes("<!--dsh-id:"));
}

// ══════════════════════════════════════════════════════════
console.log("\n=== F2. 卡片块数（原每张 +1，现应不变）===");
{
  const decDir = path.join(MEM, "decisions");
  const cards = fs.readdirSync(decDir).filter((f) => /^D\d+\.md$/.test(f)).slice(0, 10);
  let sameBlocks = 0, sameToc = 0, sameHashes = 0;
  for (const f of cards) {
    const raw = fs.readFileSync(path.join(decDir, f), "utf8");
    const key = f.replace(/\.md$/, "");
    const after = applyFingerprint3(raw, { kind: "decisions", project: PROJ, key }).text;
    const b1 = splitBlocks(raw), b2 = splitBlocks(after);
    if (b1.length === b2.length) sameBlocks += 1; else console.log(`    ⚠ ${f} 块数 ${b1.length}→${b2.length}`);
    const t1 = entryTocOf(raw, 200), t2 = entryTocOf(after, 200);
    const n1 = Array.isArray(t1) ? t1.length : -1, n2 = Array.isArray(t2) ? t2.length : -1;
    if (n1 === n2) sameToc += 1; else console.log(`    ⚠ ${f} TOC ${n1}→${n2}`);
    if (b1.every((x, i) => b2[i]?.hash === x.hash)) sameHashes += 1; else console.log(`    ⚠ ${f} 有块 hash 变了`);
  }
  eq(`★ ${cards.length} 张卡块数不变`, sameBlocks, cards.length);
  eq(`★ ${cards.length} 张卡 TOC 不变`, sameToc, cards.length);
  eq(`★★ ${cards.length} 张卡逐块 hash 不变`, sameHashes, cards.length);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== F3. ★★★★ seal 变 ⇒ block hash 必须**不变**（这是原失败项）===");
{
  const raw = "# 标题\n\n正文第一段\n\n## 小节\n\n正文第二段\n";
  const a1 = applyFingerprint3(raw, { kind: "active", project: PROJ, key: "-" }).text;
  // 手工把 seal 改成别的值（模拟"写了一次、seal 变了"）
  const a2 = a1.replace(/seal=[0-9a-f]{8}/g, "seal=ffffffff");
  const h1 = splitBlocks(a1).map((b) => b.hash).join(",");
  const h2 = splitBlocks(a2).map((b) => b.hash).join(",");
  eq("★★★ seal 变了，block hash 完全不变", h2, h1);
  // 反向：正文变了，hash 必须变
  const a3 = a1.replace("正文第一段", "正文被改了");
  const h3 = splitBlocks(a3).map((b) => b.hash).join(",");
  ok("★★★ 反向：正文变 ⇒ hash 必须变", h3 !== h1);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== F4. 三载体读写与冲突 ===");
{
  const raw = "# D195 · 决定\n\n理由\n";
  const t = applyFingerprint3(raw, { kind: "decisions", project: PROJ, key: "D195" }).text;
  const r = readFingerprint3(t);
  eq("读得出", r.ok, true);
  eq("三处来源", r.sources.length, 3);
  eq("kind", r.id.kind, "decisions");
  eq("key", r.id.key, "D195");

  // 幂等
  let t2 = t;
  for (let i = 0; i < 3; i += 1) t2 = applyFingerprint3(t2, { kind: "decisions", project: PROJ, key: "D195" }).text;
  eq("frontmatter 只 1 处", (t2.match(/dsh-fp-front:/g) ?? []).length, 1);
  eq("链接定义只 1 处", (t2.match(/\[dsh-fp-link\]:/g) ?? []).length, 1);
  eq("行内只 1 处", (t2.match(/<!--dsh-id:/g) ?? []).length, 1);

  // 冲突：改链接那处的 key
  const bad = t.replace(/\[dsh-fp-link\]: dsh-ledger-fp (v=\d+ kind=decisions project=[0-9a-f]{16} key=)D195/,
                        "[dsh-fp-link]: dsh-ledger-fp $1D999");
  const rb = readFingerprint3(bad);
  eq("★ 冲突被报出", rb.ok, false);
  ok("★ 理由点名不一致", String(rb.reason).includes("不一致"), rb.reason);
  ok("★ 回显全部来源", Array.isArray(rb.all) && rb.all.length >= 2);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== F5. 抗洗能力（三载体 7/8 是否还在）===");
{
  const raw = "# D195 · 决定\n\n理由\n\n- 一\n- 二\n";
  const t = applyFingerprint3(raw, { kind: "decisions", project: PROJ, key: "D195" }).text;
  const washes = {
    "strip 注释": (x) => x.replace(/<!--[\s\S]*?-->/g, ""),
    "往返(保留fm)": (x) => x.replace(/<!--[\s\S]*?-->/g, ""),
    "往返(丢fm)": (x) => x.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, ""),
    "prettier": (x) => x.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n"),
    "CRLF": (x) => x.replace(/\n/g, "\r\n"),
    "加BOM": (x) => "\uFEFF" + x,
    "整体缩进": (x) => x.split("\n").map((l) => (l ? "  " + l : l)).join("\n"),
    "只留可见文本": (x) => x.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\[[^\]]+\]:.*$/gm, ""),
  };
  let alive = 0;
  for (const [n, fn] of Object.entries(washes)) {
    const r = readFingerprint3(fn(t));
    if (r.ok) alive += 1;
    console.log(`  ${n.padEnd(14)} ${r.ok ? `✅（${r.sources.join("+")}）` : "❌"}`);
  }
  console.log(`  存活 ${alive}/8`);
  ok("★ 至少 7/8", alive >= 7, `${alive}/8`);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== F6. 真实体量：331 张卡加三载体后的增量 ===");
{
  const decDir = path.join(MEM, "decisions");
  const files = fs.readdirSync(decDir).filter((f) => f.endsWith(".md"));
  let before = 0, after = 0;
  for (const f of files) {
    const raw = fs.readFileSync(path.join(decDir, f), "utf8");
    before += Buffer.byteLength(raw, "utf8");
    after += Buffer.byteLength(applyFingerprint3(raw, { kind: "decisions", project: PROJ, key: f.replace(/\.md$/, "") }).text, "utf8");
  }
  const per = (after - before) / files.length;
  console.log(`  ${files.length} 份：${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB（+${((after - before) / 1024).toFixed(1)} KB）`);
  console.log(`  平均每份 +${per.toFixed(0)} 字节`);
  console.log(`  全库 990 份估算 +${(per * 990 / 1024).toFixed(0)} KB`);
  ok("每份 < 400 字节", per < 400, `${per.toFixed(0)}`);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== F7. BOM 与幂等（D352 那个 bug 不能回来）===");
{
  const withBom = "\uFEFF# 带 BOM\n\n正文\n";
  const a1 = applyFingerprint3(withBom, { kind: "active", project: PROJ, key: "-" }).text;
  ok("BOM 仍在最前", a1.startsWith("\uFEFF"));
  const a2 = applyFingerprint3(a1, { kind: "active", project: PROJ, key: "-" }).text;
  eq("★★ 幂等：二次写入内容不变", a2, a1);
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail !== 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
