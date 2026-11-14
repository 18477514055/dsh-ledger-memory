// _probe-d356-e2e.mjs —— 端到端验证：真实写一次，指纹真的落盘了吗、解析还正常吗
// ★ 用户要求"整合"，这一步是唯一能证明"真的生效"的判据 —— 不能只看模块单测。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectOf, readFingerprint3, identityOfPath, applyFingerprint3 } from "../lib/fingerprint.js";
import { writeCard, listCards, readCard, renderCardToc } from "../lib/card-ops.js";
import { writeFileAtomic } from "../lib/base.js";
import { splitBlocks } from "../lib/part1.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e === undefined ? "" : "  ← " + e}`); } };
const eq = (n, a, b) => ok(n, a === b, `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`);

// ══════════════════════════════════════════════════════════
console.log("=== 1. projectOf 读得到（带 mtime 缓存）===");
{
  const ROOT = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
  const MEM = path.join(ROOT, "10.项目台账-ledger-memory");
  const p1 = projectOf(ROOT);
  const p2 = projectOf(MEM);
  ok("ROOT 读得到", typeof p1 === "string" && /^[0-9a-f]{16}$/.test(p1), p1);
  eq("MEM 与 ROOT 一致", p2, p1);
  // 缓存命中：再读一次应同值
  eq("二次读取一致（缓存）", projectOf(ROOT), p1);
  // 不存在的目录
  eq("不存在的目录 ⇒ undefined", projectOf("C:\\no\\such\\dir\\xyz"), undefined);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 2. identityOfPath：路径 → 身份（机械映射）===");
{
  const ROOT = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
  const MEM = path.join(ROOT, "10.项目台账-ledger-memory");
  const info = {
    memoryBase: MEM,
    active: "LEDGER.md",
    journal: "JOURNAL.md",
    principles: "PRINCIPLES.md",
    decisionsDir: "decisions",
    lessonsDir: "lessons",
    goalsDir: "goals",
  };
  const cases = [
    [path.join(MEM, "LEDGER.md"), "active", "-"],
    [path.join(MEM, "JOURNAL.md"), "journal", "-"],
    [path.join(MEM, "PRINCIPLES.md"), "principles", "-"],
    [path.join(MEM, "SECURITY.md"), "security", "-"],
    [path.join(MEM, "decisions", "D195.md"), "decisions", "D195"],
    [path.join(MEM, "lessons", "L1.md"), "lessons", "L1"],
    [path.join(MEM, "goals", "g1.md"), "goals", "g1"],
    [path.join(MEM, "_stash", "2026-10", "week4", "x.md"), "stash", "_stash/2026-10/week4/x.md"],
    [path.join(MEM, "_handoff", "h.md"), "handoff", "_handoff/h.md"],
  ];
  for (const [abs, wantKind, wantKey] of cases) {
    const r = identityOfPath(info, abs);
    eq(`  ${path.basename(abs)} → ${wantKind}/${wantKey}`, `${r?.kind}/${r?.key}`, `${wantKind}/${wantKey}`);
  }
  // 非记忆面 ⇒ undefined（不该被加指纹）
  eq("  .gitignore ⇒ undefined", identityOfPath(info, path.join(ROOT, ".gitignore")), undefined);
  eq("  包内 lib/index.js ⇒ undefined", identityOfPath(info, path.join(ROOT, "lib", "index.js")), undefined);
  eq("  memoryRoot 之外 ⇒ undefined", identityOfPath(info, "C:\\Windows\\x.md"), undefined);
  eq("  memoryRoot 本身 ⇒ undefined", identityOfPath(info, MEM), undefined);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 3. ★★★ 真写一张卡：指纹真的落盘了吗 ===");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-e2e-"));
  const mem = path.join(tmp, "mem");
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  // 造一份清单，给一个 projectId
  const PROJ = "0123456789abcdef";
  fs.writeFileSync(path.join(tmp, ".dsh-ledger.json"),
    JSON.stringify({ memoryRoot: "mem", projectId: PROJ }, null, 2), "utf8");

  const r = writeCard(tmp, "decisions", "D195", "## D195 · 某决定\n\n理由正文\n");
  eq("写卡成功", r.ok, true);

  const onDisk = fs.readFileSync(r.path, "utf8");
  ok("★ 文件里有 frontmatter", onDisk.includes("dsh-fp-front"), onDisk.slice(0, 120));
  ok("★ 文件里有链接定义", onDisk.includes("[dsh-fp-link]"));
  ok("★ 文件里有行内信标", onDisk.includes("<!--dsh-id:"));

  const read = readFingerprint3(onDisk);
  eq("★★ 三载体都读得到", read.ok && read.sources.length, 3);
  eq("★★ kind 正确", read.id.kind, "decisions");
  eq("★★ key 正确", read.id.key, "D195");
  eq("★★ projectId 是清单里那个", read.id.project, PROJ);

  // 解析不受影响
  const blocks = splitBlocks(onDisk);
  eq("★ 分块只有 1 块（指纹不参与）", blocks.length, 1);
  ok("★ 块里没有指纹残留", !blocks[0].text.includes("dsh-fp-front") && !blocks[0].text.includes("dsh-id"));
  eq("★ 块内容就是原文", blocks[0].text.trim(), "## D195 · 某决定\n\n理由正文".trim());

  // 卡片工具仍能读
  // ★ 先看真实返回形状（判据纪律：别按自己想象的形状写断言）
  const cards = listCards(tmp, "decisions");
  ok("★ listCards 返回非空", Array.isArray(cards) && cards.length >= 1, JSON.stringify(cards).slice(0, 200));
  ok("★ listCards 里含 D195", JSON.stringify(cards).includes("D195"), JSON.stringify(cards).slice(0, 200));
  const toc = renderCardToc(tmp, "decisions");
  ok("★ TOC 里含 D195", JSON.stringify(toc).includes("D195"), JSON.stringify(toc).slice(0, 200));

  // 再写一次（幂等）
  const r2 = writeCard(tmp, "decisions", "D195", "## D195 · 某决定\n\n理由正文\n");
  eq("二次写成功", r2.ok, true);
  const onDisk2 = fs.readFileSync(r2.path, "utf8");
  eq("★★ 幂等：两次写入逐字节相同", onDisk2, onDisk);

  // 正文变了：身份不变，seal 变
  const r3 = writeCard(tmp, "decisions", "D195", "## D195 · 某决定\n\n理由**被改过**\n");
  const onDisk3 = fs.readFileSync(r3.path, "utf8");
  const read3 = readFingerprint3(onDisk3);
  eq("★★ 正文变 ⇒ 身份不变", `${read3.id.kind}/${read3.id.key}`, "decisions/D195");
  ok("★★ 正文变 ⇒ seal 变了", read3.seal !== read.seal, `${read.seal} → ${read3.seal}`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 4. ★★★ 没 projectId 时：必须**不加指纹**，而不是瞎编一个 ===");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-noproj-"));
  fs.mkdirSync(path.join(tmp, "decisions"), { recursive: true });
  // 清单里没有 projectId
  fs.writeFileSync(path.join(tmp, ".dsh-ledger.json"), JSON.stringify({ memoryRoot: "mem" }, null, 2), "utf8");

  const r = writeCard(tmp, "decisions", "D1", "## D1 · 无项目\n");
  eq("写卡仍然成功（不能因此失败）", r.ok, true);
  const onDisk = fs.readFileSync(r.path, "utf8");
  ok("★ 没有加指纹（因为读不到 projectId）", !onDisk.includes("dsh-fp-front"), onDisk.slice(0, 80));
  eq("★ 内容原样落盘", onDisk, "## D1 · 无项目\n");

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 5. ★★★ writeFileAtomic：指纹失败不能影响写入 ===");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-atomic-"));
  const f = path.join(tmp, "x.md");
  // 故意给一个非法 kind ⇒ applyFingerprint3 会抛
  const r = writeFileAtomic(f, "# 内容\n", { fp: { kind: "Bad Kind", project: "0123456789abcdef", key: "-" } });
  eq("★ 仍然返回 ok（吞掉指纹异常）", r.ok, true);
  eq("★ 内容原样写入", fs.readFileSync(f, "utf8"), "# 内容\n");

  // 合法身份 ⇒ 加指纹
  const f2 = path.join(tmp, "y.md");
  const r2 = writeFileAtomic(f2, "# 内容\n", { fp: { kind: "active", project: "0123456789abcdef", key: "-" } });
  eq("合法身份 ⇒ ok", r2.ok, true);
  ok("合法身份 ⇒ 有指纹", fs.readFileSync(f2, "utf8").includes("dsh-fp-front"));

  // 不给 fp ⇒ 完全不加（保持旧行为）
  const f3 = path.join(tmp, "z.md");
  writeFileAtomic(f3, "# 内容\n", undefined);
  eq("★ 不给 fp ⇒ 逐字节原样（旧行为不变）", fs.readFileSync(f3, "utf8"), "# 内容\n");

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail !== 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
