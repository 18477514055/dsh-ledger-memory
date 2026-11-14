/**
 * D375 诊断：为什么 F-02 b/c、F-04 a、F-06 c 在**未修基线**上就是绿的？
 * 只 dump，不判定。目的：分清「断言太弱」与「缺陷不可达」。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fp = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "fingerprint.js")).href);
const part2 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part2.js")).href);
const part3 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part3.js")).href);

function tmp(t) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `d375d-${t}-`));
}
function mk(dir, m) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".dsh-ledger.json"), JSON.stringify(m, null, 2) + "\n", "utf8");
}

// ── F-02 b：memoryRoot 越界时的注入 ────────────────────────────────────────
{
  const t = tmp("f02b");
  const proj = path.join(t, "proj");
  mk(proj, { projectId: fp.newProjectId(), active: "LEDGER.md", memoryRoot: "../outside" });
  fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 根目录旧台账\n", "utf8");
  const info = part2.inspect(proj);
  console.log("=== F-02 b ===");
  console.log("memoryRootUnsafe:", JSON.stringify(info.memoryRootUnsafe));
  console.log("activeRel:", info.activeRel, " activeExists:", info.activeExists, " activeAbs:", info.activeAbs);
  console.log("memoryBase:", info.memoryBase);
  console.log("manifestBroken:", info.manifestBroken);
  const inj = part3.renderInjectionBody(info, Date.now());
  const body = typeof inj === "string" ? inj : JSON.stringify(inj);
  console.log("len:", body.length);
  console.log("含『根目录旧台账』:", body.includes("根目录旧台账"));
  console.log("含『越界』:", body.includes("越界"));
  console.log("前 400 字:", JSON.stringify(body.slice(0, 400)));
  fs.rmSync(t, { recursive: true, force: true });
}

// ── F-02 c：清单 JSON 损坏时的注入 ────────────────────────────────────────
{
  const t = tmp("f02c");
  const proj = path.join(t, "proj");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, ".dsh-ledger.json"), "{ 这不是合法 JSON ", "utf8");
  fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 根目录旧台账\n", "utf8");
  const info = part2.inspect(proj);
  console.log("\n=== F-02 c ===");
  console.log("manifestBroken:", JSON.stringify(info.manifestBroken));
  console.log("activeRel:", info.activeRel, " activeExists:", info.activeExists);
  const inj = part3.renderInjectionBody(info, Date.now());
  const body = typeof inj === "string" ? inj : JSON.stringify(inj);
  console.log("len:", body.length);
  console.log("含『根目录旧台账』:", body.includes("根目录旧台账"));
  console.log("含『损坏』:", body.includes("损坏"));
  console.log("前 400 字:", JSON.stringify(body.slice(0, 400)));
  fs.rmSync(t, { recursive: true, force: true });
}

// ── F-04 a：spliceSingleFileEntry 的 key ─────────────────────────────────
{
  const pid = fp.newProjectId();
  const seeded = fp.applyFingerprint3("<!--dsh-id:" + pid + ":L99-->\n## L99 · 尺子错\n- 标题: x\n", {
    kind: "lessons",
    project: pid,
    key: "-",
  }).text;
  console.log("\n=== F-04 a ===");
  console.log("seeded 前 200 字:", JSON.stringify(seeded.slice(0, 200)));
  const r3seed = fp.readFingerprint3(seeded);
  console.log("seeded 的指纹 id:", JSON.stringify(r3seed.ok ? r3seed.id : r3seed.reason));
  const sp = part2.spliceSingleFileEntry(seeded, /^##\s+L99\b/, /^##\s+/, "", "lessons");
  console.log("matched:", sp.matched, " fpId:", JSON.stringify(sp.fpId));
  const r3 = fp.readFingerprint3(String(sp.text ?? ""));
  console.log("产出指纹 id:", JSON.stringify(r3.ok ? r3.id : r3.reason));
  console.log("产出前 200 字:", JSON.stringify(String(sp.text ?? "").slice(0, 200)));
}

// ── F-06 c：注入层是否剥离指纹 ───────────────────────────────────────────
{
  const t = tmp("f06c");
  const pid = fp.newProjectId();
  const proj = path.join(t, "proj");
  mk(proj, { projectId: pid, active: "LEDGER.md" });
  const stamped = fp.applyFingerprint3("# 台账正文\n\n- 内容\n", { kind: "active", project: pid, key: "-" }).text;
  fs.writeFileSync(path.join(proj, "LEDGER.md"), stamped, "utf8");
  const info = part2.inspect(proj);
  console.log("\n=== F-06 c ===");
  console.log("activeExists:", info.activeExists, " activeLines:", info.activeLines);
  const inj = part3.renderInjectionBody(info, Date.now());
  const body = typeof inj === "string" ? inj : JSON.stringify(inj);
  console.log("len:", body.length);
  console.log("含 dsh-fp-front:", body.includes("dsh-fp-front"));
  console.log("含 <!--dsh-id:", body.includes("<!--dsh-id:"));
  console.log("含 [dsh-fp-link]:", body.includes("[dsh-fp-link]"));
  console.log("含『台账正文』:", body.includes("台账正文"));
  console.log("前 500 字:", JSON.stringify(body.slice(0, 500)));
  fs.rmSync(t, { recursive: true, force: true });
}

console.log("\nDIAG-COMPLETE");
