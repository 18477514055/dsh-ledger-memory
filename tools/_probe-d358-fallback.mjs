// _probe-d358-fallback.mjs —— 兜底路径真的接上了吗：卡片改名后 ledger_read 还能不能读到
// ★ 这是 D356 §七 遗留的最后一件：`resolveByIdentity` 有没有**调用方**。
// ★ 判据必须走**真实读入口**（`readEntryUnified`），不能只测底层函数。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyFingerprint3, newProjectId, clearProjectCache } from "../lib/fingerprint.js";
import { readEntryUnified } from "../lib/card-ops.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e === undefined ? "" : "  ← " + e}`); } };
const eq = (n, a, b) => ok(n, a === b, `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`);

const PROJ = newProjectId();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-fb-"));
const mem = path.join(tmp, "mem");
fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });

// 清单：给 projectId + 声明卡片模式
fs.writeFileSync(path.join(tmp, ".dsh-ledger.json"),
  JSON.stringify({ memoryRoot: "mem", projectId: PROJ, decisionsDir: "decisions" }, null, 2), "utf8");
fs.writeFileSync(path.join(mem, ".dsh-ledger.json"),
  JSON.stringify({ memoryRoot: "mem", projectId: PROJ, decisionsDir: "decisions" }, null, 2), "utf8");
clearProjectCache();

const info = {
  projectRoot: tmp,
  memoryRoot: "mem",
  // ★ `memoryBaseOf` 优先用 `info.memoryBase`（**绝对路径**）——
  //   不传它就会退回 `projectRoot`，卡片基准就错了（我第一版漏了这条，导致断言假红）。
  memoryBase: mem,
  manifest: { memoryRoot: "mem", projectId: PROJ, decisionsDir: "decisions" },
  decisionsDir: "decisions",
  lessonsDir: "lessons",
  goalsDir: "goals",
  active: "LEDGER.md",
  journal: "JOURNAL.md",
  principles: "PRINCIPLES.md",
};

function putCard(rel, body, key) {
  const abs = path.join(mem, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, applyFingerprint3(body, { kind: "decisions", project: PROJ, key }).text, "utf8");
}

putCard("decisions/D195.md", "## D195 · 某决定\n\n正文内容 A\n", "D195");
putCard("decisions/D196.md", "## D196 · 另一决定\n\n正文内容 B\n", "D196");

// ══════════════════════════════════════════════════════════
console.log("=== 1. 正常情况：按名字读得到（不该走兜底）===");
{
  const r = readEntryUnified(tmp, info, "decisions", "D195");
  eq("found", r.found, true);
  ok("内容对", String(r.text).includes("正文内容 A"), String(r.text).slice(0, 60));
  eq("没有 resolvedBy（说明走的是名字）", r.resolvedBy, undefined);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 2. ★★★★ 卡片被改名 ⇒ 兜底必须接上 ===");
{
  fs.renameSync(path.join(mem, "decisions", "D195.md"), path.join(mem, "decisions", "老早那个决定.md"));
  const r = readEntryUnified(tmp, info, "decisions", "D195");
  eq("★★ 仍然 found", r.found, true);
  eq("★★ resolvedBy = fingerprint", r.resolvedBy, "fingerprint");
  eq("★★ 指出了真实位置", r.actualRel, "decisions/老早那个决定.md");
  ok("★★ 内容正确", String(r.text).includes("正文内容 A"), String(r.text).slice(0, 60));
  ok("★★ note 明说被改名", String(r.note).includes("改过名") || String(r.note).includes("按指纹"), r.note);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 3. ★★★ 连目录都换了 ⇒ 也要找回来 ===");
{
  const newDir = path.join(mem, "随便一个目录");
  fs.mkdirSync(newDir, { recursive: true });
  fs.renameSync(path.join(mem, "decisions", "D196.md"), path.join(newDir, "x.txt"));
  const r = readEntryUnified(tmp, info, "decisions", "D196");
  eq("★★★ 仍然 found", r.found, true);
  eq("★★★ resolvedBy = fingerprint", r.resolvedBy, "fingerprint");
  ok("★★★ 内容正确", String(r.text).includes("正文内容 B"), String(r.text).slice(0, 60));
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 4. ★★★ 真的没有 ⇒ 必须说没有（兜底不许造假）===");
{
  const r = readEntryUnified(tmp, info, "decisions", "D999");
  eq("★ found = false", r.found, false);
  eq("★ 没有 resolvedBy", r.resolvedBy, undefined);
  ok("★ 给了理由", typeof r.reason === "string" && r.reason.length > 0, r.reason);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 5. ★★★ 别的项目的同名卡 ⇒ 必须拒绝（不许把别人的当自己的）===");
{
  const OTHER = newProjectId();
  const abs = path.join(mem, "decisions", "D195.md");
  fs.writeFileSync(abs, applyFingerprint3("## D195 · 别人的卡\n", { kind: "decisions", project: OTHER, key: "D195" }).text, "utf8");
  const r = readEntryUnified(tmp, info, "decisions", "D195");
  // ★★★ 2026-10-29（D358）**行为已定**：名字命中别人的卡时**直接拒绝**，
  //   而**不是**"再去扫一遍找本项目那份"。
  //   ★ 为什么拒绝更好：名字位置上是别人的文件，这本身就是一个**需要人知道的事故**
  //     （说明有别的项目覆盖了我们的路径）。静默换成另一份内容，等于把事故藏起来。
  //   ⇒ 正确期望：found=false，且理由点名 project 不符。
  eq("★★ 拒绝（found=false）", r.found, false);
  ok("★★ 理由点名 project 不符", String(r.reason).includes("project"), r.reason);
  ok("★★ 绝不返回别人的内容", !String(r.text ?? "").includes("别人的卡"), String(r.text ?? "").slice(0, 40));
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 6. 没有 projectId ⇒ 兜底不启用（安全默认）===");
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "fp-fb2-"));
  const mem2 = path.join(tmp2, "mem");
  fs.mkdirSync(path.join(mem2, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(tmp2, ".dsh-ledger.json"),
    JSON.stringify({ memoryRoot: "mem", decisionsDir: "decisions" }, null, 2), "utf8");
  clearProjectCache();
  const info2 = { ...info, projectRoot: tmp2, memoryRoot: "mem", manifest: { memoryRoot: "mem", decisionsDir: "decisions" } };
  // 造一张带指纹但用别的 projectId 的卡（模拟"本项目没 projectId 但文件有"）
  fs.writeFileSync(path.join(mem2, "decisions", "改名了.md"),
    applyFingerprint3("## D1 · x\n", { kind: "decisions", project: newProjectId(), key: "D1" }).text, "utf8");
  const r = readEntryUnified(tmp2, info2, "decisions", "D1");
  eq("★ 没有 projectId ⇒ 不走兜底（found=false）", r.found, false);
  fs.rmSync(tmp2, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail !== 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
