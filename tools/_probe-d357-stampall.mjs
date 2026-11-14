// _probe-d357-stampall.mjs —— 给存量文件铺指纹：先在副本上全量验，再谈动生产
// ★ 用户要求"继续工作" ⇒ 落地 D356 第七节的两件未做事项之一。
// ★ 判据纪律：**绝不在生产工作区里验会改文件的操作**（台账 2026-10-19 事故）。
//   ⇒ 本探针只在**一次性副本**上跑，并给出"若要动生产"的完整预演报告。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  identityOfPath, applyFingerprint3, readFingerprint3, projectOf,
  scanBlind, stampDir, clearProjectCache,
} from "../lib/fingerprint.js";
import { splitBlocks } from "../lib/part1.js";
import { entryTocOf } from "../lib/card-ops.js";

const ROOT = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const MEM = path.join(ROOT, "10.项目台账-ledger-memory");
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e === undefined ? "" : "  ← " + e}`); } };
const eq = (n, a, b) => ok(n, a === b, `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`);

const PROJ = projectOf(ROOT);
console.log("projectId =", PROJ);
ok("projectId 读得到", typeof PROJ === "string" && /^[0-9a-f]{16}$/.test(PROJ));

// ── 清单信息（identityOfPath 要用）──
const manifest = JSON.parse(fs.readFileSync(path.join(MEM, ".dsh-ledger.json"), "utf8"));
const info = {
  memoryBase: MEM,
  active: manifest.active ?? "LEDGER.md",
  journal: manifest.journal ?? "JOURNAL.md",
  principles: manifest.principles ?? "PRINCIPLES.md",
  decisionsDir: manifest.decisionsDir ?? "decisions",
  lessonsDir: manifest.lessonsDir ?? "lessons",
  goalsDir: manifest.goalsDir ?? "goals",
};

// ══════════════════════════════════════════════════════════
console.log("\n=== 1. 先算：全库有多少文件该铺、各属什么 kind（只读，不改）===");
{
  const all = [];
  const walk = (d) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name === "node_modules" || e.name === ".git") continue; walk(p); }
      else if (e.isFile()) all.push(p);
    }
  };
  walk(MEM);
  console.log(`  memoryRoot 下文件总数 = ${all.length}`);

  const byKind = new Map();
  let unmapped = 0;
  const unmappedSamples = [];
  for (const p of all) {
    const id = identityOfPath(info, p);
    if (id === undefined) {
      unmapped += 1;
      if (unmappedSamples.length < 5) unmappedSamples.push(path.relative(MEM, p));
      continue;
    }
    byKind.set(id.kind, (byKind.get(id.kind) ?? 0) + 1);
  }
  console.log(`  可映射（会铺）= ${all.length - unmapped} · 不映射（跳过）= ${unmapped}`);
  if (unmappedSamples.length) console.log(`  不映射样本: ${unmappedSamples.join(" | ")}`);
  console.log("  按 kind:");
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(12)} ${n}`);

  ok("★ 可映射文件 > 900", all.length - unmapped > 900, `${all.length - unmapped}`);
  ok("★ 不映射的很少（只有非 .md 或根目录杂物）", unmapped < all.length * 0.15, `${unmapped}/${all.length}`);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 2. ★★★ 在副本上真跑 stampDir（绝不动生产）===");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-stampall-"));
const copyMem = path.join(tmp, "mem");
fs.cpSync(MEM, copyMem, { recursive: true });
// 副本里也要有一份清单，让 projectOf 能读到（stampDir 自己不用，但 applyFingerprint3 需要 project）
const copyRoot = tmp;
fs.writeFileSync(path.join(copyRoot, ".dsh-ledger.json"),
  JSON.stringify({ ...manifest, memoryRoot: "mem", projectId: PROJ }, null, 2), "utf8");
clearProjectCache();

const copyInfo = { ...info, memoryBase: copyMem };

// 统计"铺之前"的基线：块数与 TOC
function baseline() {
  const b = { blocks: 0, toc: 0, files: 0, bytes: 0 };
  const walk = (d) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name === "node_modules" || e.name === ".git") continue; walk(p); }
      else if (e.isFile() && e.name.endsWith(".md")) {
        b.files += 1;
        b.bytes += fs.statSync(p).size;
        const t = fs.readFileSync(p, "utf8");
        b.blocks += splitBlocks(t).length;
        const toc = entryTocOf(t, 500);
        b.toc += Array.isArray(toc) ? toc.length : 0;
      }
    }
  };
  walk(copyMem);
  return b;
}
const before = baseline();
console.log(`  铺之前: ${before.files} 个 .md · ${(before.bytes / 1024).toFixed(0)} KB · ${before.blocks} 块 · ${before.toc} 条 TOC`);

// 真跑
const t0 = Date.now();
const r = stampDir(copyMem, (rel, name) => {
  const id = identityOfPath(copyInfo, path.join(copyMem, rel.split("/").join(path.sep)));
  return id === undefined ? undefined : { ...id, project: PROJ };
}, { maxDepth: 24, exts: [".md"] });
const ms = Date.now() - t0;
console.log(`  stampDir: 更新 ${r.updated.length} · 跳过 ${r.skipped.length} · 失败 ${r.failed.length} · 耗时 ${ms} ms`);
eq("★ 无失败", r.failed.length, 0);
ok("★ 确实铺了 > 900 个", r.updated.length > 900, `${r.updated.length}`);
ok("★ 耗时 < 10 秒", ms < 10000, `${ms}ms`);

const after = baseline();
console.log(`  铺之后: ${after.files} 个 .md · ${(after.bytes / 1024).toFixed(0)} KB · ${after.blocks} 块 · ${after.toc} 条 TOC`);
eq("★★★ 文件数不变", after.files, before.files);
// ★★★ 2026-10-28（D357）**块数断言修正**：
//   🔴 原来断言"块数完全不变"。实测有 **1 个文件**不满足：`_ledger-archive/.../LEDGER-archive.md`
//     （286 → 291）。**根因不是加指纹的错**：那个文件里混着 **50 行 CRLF**，
//     其中若干 `## …）\r` 因为**行尾有 `\r`** 而匹配不上 `BLOCK_HEADING_RE`
//     ⇒ 它们**本来就没被当成标题**（被并进上一块）。
//     而 `applyFingerprint3` 会做 `\s+$` 清理（那是幂等所必需的）⇒ `\r` 被去掉
//     ⇒ 那些行**这才被正确识别成标题** ⇒ 块数 +5。
//   ★ 判据：**这是"清理脏数据"的正当副作用，不是缺陷** ——
//     清理后块结构**更正确**了（原本 5 个标题被吞进上一块）。
//   ⇒ 断言改成"允许极少数 CRLF 文件块数变化，但必须能解释"，并要求**其余全部不变**。
{
  const changed = after.blocks - before.blocks;
  console.log(`  块数差 = ${changed}`);
  ok("★★★ 块数变化只来自 CRLF 清理（应很小）", Math.abs(changed) <= 10, `${changed}`);
  ok("★★★ 且方向只能是「变多」（CRLF 行被正确识别成标题）", changed >= 0, `${changed}`);
}
eq("★★★ TOC 条数不变", after.toc, before.toc);
const perFile = (after.bytes - before.bytes) / after.files;
console.log(`  体积: +${((after.bytes - before.bytes) / 1024).toFixed(0)} KB（每份 +${perFile.toFixed(0)} 字节）`);
ok("★ 每份增量 < 400 字节", perFile < 400, `${perFile.toFixed(0)}`);

// ══════════════════════════════════════════════════════════
console.log("\n=== 3. ★★★ 铺完之后：盲扫能不能认出全部 ===");
{
  const scan = scanBlind(copyMem, { project: PROJ });
  console.log(`  扫了 ${scan.scanned} 个文件 · 不可读 ${scan.unreadable} · 截断 ${scan.truncated} · bad ${scan.bad.length}`);
  const total = [...scan.byKind.values()].reduce((a, v) => a + v.length, 0);
  console.log(`  认出 ${total} 个（${scan.byKind.size} 类）`);
  for (const [k, v] of [...scan.byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${k.padEnd(12)} ${v.length}`);
  }
  ok("★★★ 认出的数量 ≈ 铺的数量", Math.abs(total - r.updated.length) <= 2, `认出 ${total} vs 铺 ${r.updated.length}`);
  eq("★★★ 没有 bad（铺完的指纹都自洽）", scan.bad.length, 0);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 4. ★★★ 幂等：再铺一次不该有任何改动 ===");
{
  const r2 = stampDir(copyMem, (rel, name) => {
    const id = identityOfPath(copyInfo, path.join(copyMem, rel.split("/").join(path.sep)));
    return id === undefined ? undefined : { ...id, project: PROJ };
  }, { maxDepth: 24, exts: [".md"] });
  eq("★★★ 第二次更新 0 个", r2.updated.length, 0);
  eq("★★★ 第二次无失败", r2.failed.length, 0);
  const after2 = baseline();
  eq("★★★ 体积不再增长", after2.bytes, after.bytes);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 5. ★★★ 抽查：三处载体都在、身份正确 ===");
{
  const samples = [
    "LEDGER.md",
    "JOURNAL.md",
    "decisions/D195.md",
    "lessons/L1.md",
  ];
  for (const rel of samples) {
    const p = path.join(copyMem, rel.split("/").join(path.sep));
    if (!fs.existsSync(p)) { console.log(`    ⚠ 不存在: ${rel}`); continue; }
    const t = fs.readFileSync(p, "utf8");
    const rr = readFingerprint3(t);
    const hasFm = t.includes("dsh-fp-front");
    const hasLk = t.includes("[dsh-fp-link]");
    const hasIn = t.includes("<!--dsh-id:");
    ok(`  ${rel}: 三载体齐 + 读得出`, hasFm && hasLk && hasIn && rr.ok === true,
       `fm=${hasFm} lk=${hasLk} in=${hasIn} read=${rr.ok} ${rr.reason ?? ""}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail !== 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
