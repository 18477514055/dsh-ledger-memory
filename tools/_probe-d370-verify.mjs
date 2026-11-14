#!/usr/bin/env node
/**
 * D370 取证器：逐条核实 `docs/3.8flash实地跑/002.md` 的 7 项发现（F-01 ~ F-07）。
 *
 * ★★★ 断言一律写成「**缺陷不应该存在**」⇒ 跑在**未修**代码上会大面积 FAIL，
 *   跑在**已修**代码上才全绿。★ 基线红数必须写进决策卡。
 *
 * ★★★★ 报告自称「补丁后 PASS 2363 · SKIP 6」，而基线是「PASS 2364 · SKIP 5」——
 *   **断言数增加了 6 条，PASS 反而少了 1 条、SKIP 多了 1 条**。这个组合可疑，
 *   必须自己验（D365/D367 都栽在"补丁自带回归"上）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
const rows = [];
const ok = (title, cond, detail) => {
  if (cond) { pass += 1; rows.push(`PASS  ${title}${detail === undefined ? "" : ` — ${detail}`}`); }
  else { fail += 1; rows.push(`FAIL  ${title}${detail === undefined ? "" : ` — ${detail}`}`); }
};
const PID = "0123456789abcdef";
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `d370-${tag}-`));

const fp = await import("../lib/fingerprint.js");
const part2 = await import("../lib/part2.js");
const part4 = await import("../lib/part4.js");
const part8 = await import("../lib/part8.js");
const cardOps = await import("../lib/card-ops.js");

function mkProject(tag, extra = {}) {
  const root = tmp(tag);
  const man = {
    version: 3,
    memoryRoot: "mem",
    projectId: PID,
    active: "LEDGER.md",
    journal: "JOURNAL.md",
    archiveDir: "_ledger-archive",
    ...extra,
  };
  const t = JSON.stringify(man, null, 2) + "\n";
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), t, "utf8");
  const mem = path.join(root, "mem");
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, ".dsh-ledger.json"), t, "utf8");
  return { root, mem };
}

const readFp = (abs) => {
  if (!fs.existsSync(abs)) return { exists: false };
  const text = fs.readFileSync(abs, "utf8");
  const r3 = fp.readFingerprint3(text, {});
  return { exists: true, ok: r3.ok, id: r3.id, sources: r3.sources };
};

// ═══════════════════════════════════════════════════════════════════
// F-01（P1）扩展记忆三载体指纹完全缺失
// ═══════════════════════════════════════════════════════════════════
{
  const { root, mem } = mkProject("f01");
  const info = part2.inspect(root);
  const c = part8.createExtension(info, root, { name: "ext1", description: "d", mode: "journal" });
  const extId = c?.created?.id ?? "ext1";

  // F-01-1：新建的单文件扩展模板必须带指纹
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.md$/i.test(e.name)) out.push(p);
    }
    return out;
  };
  const extDir = path.join(mem, "extensions", extId);
  const files = fs.existsSync(extDir) ? walk(extDir) : [];
  const templateFp = files.length > 0 ? readFp(files[0]) : { exists: false };
  ok("F-01-1 新建扩展的单文件模板带三载体指纹", templateFp.ok === true, JSON.stringify(templateFp).slice(0, 160));

  // F-01-2：单文件扩展写入后必须带指纹
  const w = part8.writeExtension(part2.inspect(root), root, extId, { append: true, content: "- 记一笔\n" });
  const after = files.length > 0 ? readFp(files[0]) : { exists: false };
  ok("F-01-2 单文件扩展写入后仍带指纹", after.ok === true, `w=${JSON.stringify(w)?.slice(0, 80)} fp=${JSON.stringify(after).slice(0, 120)}`);

  // F-01-3：卡片型扩展写入后必须带指纹
  const c2 = part8.createExtension(part2.inspect(root), root, { name: "extCard", description: "d", mode: "active" });
  const cardId = c2?.created?.id ?? "extCard";
  const wc = part8.writeExtension(part2.inspect(root), root, cardId, { content: "# 卡片正文\n" });
  const cardDir = path.join(mem, "extensions", cardId);
  const cardFiles = fs.existsSync(cardDir) ? walk(cardDir) : [];
  const cardFp = cardFiles.length > 0 ? readFp(cardFiles[0]) : { exists: false };
  ok("F-01-3 卡片型扩展写入后带三载体指纹", cardFp.ok === true, `wc=${JSON.stringify(wc)?.slice(0, 80)} fp=${JSON.stringify(cardFp).slice(0, 120)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
// F-02（P1）resolveByIdentity 按名解析路径逃逸
// ═══════════════════════════════════════════════════════════════════
{
  // F-02（P1）resolveByIdentity 按名解析路径逃逸
  //
  // ★★★★★ 判据修正（本轮第一版假绿）：第一版我把外部文件建在 `<root>/..`，
  //   而 `projRoot` 是 `<root>/proj` ⇒ `../xxx` 相对 projRoot 落在 `<root>`，**仍在允许范围内**？
  //   不 —— 实测更糟：`ok:true` 且返回了**项目外**的绝对路径（我第一版判据把路径算错才放行）。
  //   ★ 判据：必须**真的把文件放在 projRoot 之外**，并检查返回的 abs 是否越界。
  const base = tmp("f02");
  const projRoot = path.join(base, "proj");
  const outsideDir = path.join(base, "outside");
  fs.mkdirSync(projRoot, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const secret = path.join(outsideDir, "secret.md");
  fs.writeFileSync(secret, "# 外部秘密文件\n\n- 不该被读到\n", "utf8");

  const checkEscape = (res, label) => {
    if (res?.ok !== true) return { escaped: false, why: "ok!==true（已拒）" };
    try {
      const abs = path.resolve(String(res.abs ?? ""));
      const rootAbs = path.resolve(projRoot);
      const inside = abs === rootAbs || abs.startsWith(rootAbs + path.sep);
      return { escaped: !inside, why: `abs=${abs}` };
    } catch {
      return { escaped: false, why: "abs 无法解析" };
    }
  };

  let r1;
  try { r1 = fp.resolveByIdentity(projRoot, { name: "../outside/secret.md" }); }
  catch (e) { r1 = { threw: String(e?.message ?? e) }; }
  const e1 = checkEscape(r1, "rel");
  ok("F-02 按名解析不许用 ../ 逃出项目根", e1.escaped === false, `${e1.why} | ${JSON.stringify(r1)?.slice(0, 150)}`);

  let r2;
  try { r2 = fp.resolveByIdentity(projRoot, { name: secret }); }
  catch (e) { r2 = { threw: String(e?.message ?? e) }; }
  const e2 = checkEscape(r2, "abs");
  ok("F-02b 按名解析拒绝绝对路径", e2.escaped === false, `${e2.why} | ${JSON.stringify(r2)?.slice(0, 150)}`);

  fs.rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
// F-03（P2）archiveLedger 漏回显 backup
// ═══════════════════════════════════════════════════════════════════
{
  const { root, mem } = mkProject("f03");
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# 台账\n\n- [s] A 条\n- [s] B 条\n", "utf8");
  let r;
  try {
    r = await part4.archiveLedger(root, { entries: "- [s] A 条", newActive: "# 台账\n\n- [s] B 条\n", force: true });
  } catch (e) {
    r = { threw: String(e?.message ?? e) };
  }
  const hasBackupField = r?.backup !== undefined || r?.backupFailed !== undefined;
  ok("F-03 archiveLedger 回执里回显 backup / backupFailed", hasBackupField === true, JSON.stringify({ ok: r?.ok, backup: r?.backup, backupFailed: r?.backupFailed }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
// F-04（P2）writePrinciples 原子写失败残留 throw
// ═══════════════════════════════════════════════════════════════════
{
  // 判据：源码里不许有 `throw new Error` 出现在 writePrinciples 的原子写失败分支
  const src = fs.readFileSync(path.join(process.cwd(), "lib", "part2.js"), "utf8");
  const i = src.indexOf("export function writePrinciples");
  const seg = i < 0 ? "" : src.slice(i, i + 6000);
  const hasThrow = /if\s*\(\s*_w\.ok\s*!==\s*true\s*\)\s*throw new Error/.test(seg);
  ok("F-04 writePrinciples 原子写失败时不再 throw（改返回 ok:false）", hasThrow === false, hasThrow ? "仍存在 throw new Error" : "已无 throw");
}

// ═══════════════════════════════════════════════════════════════════
// F-05（P2）identityOfPath 卡片目录漏排 SECURITY.md
// ═══════════════════════════════════════════════════════════════════
{
  const root = tmp("f05");
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify({
    version: 3, memoryRoot: ".", projectId: PID,
    active: "LEDGER.md", journal: "JOURNAL.md", decisionsDir: "decisions", archiveDir: "_a",
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
  fs.writeFileSync(path.join(root, "JOURNAL.md"), "# 流水\n", "utf8");
  fs.mkdirSync(path.join(root, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(root, "decisions", "SECURITY.md"), "# 安全说明\n", "utf8");

  const info = part2.inspect(root);
  const id = fp.identityOfPath(info, path.join(root, "decisions", "SECURITY.md"));
  ok("F-05 卡片目录里的 SECURITY.md 不被当成卡片（identityOfPath 返回 undefined）", id === undefined, JSON.stringify(id));
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
// F-06（P3）scanFingerprints 损坏指纹文案分叉
// ═══════════════════════════════════════════════════════════════════
{
  const src = fs.readFileSync(path.join(process.cwd(), "lib", "fingerprint.js"), "utf8");
  // 找出 scanFingerprints 与 scanBlind 两处对"损坏"的判据
  const inScanFp = /includes\(\s*"损坏或被篡改"\s*\)/.test(src);
  const hasUniform = /includes\(\s*"损坏"\s*\)/.test(src);
  ok("F-06 损坏指纹的匹配文案不再分叉（不再用『损坏或被篡改』这个对不上的串）", inScanFp === false, `「损坏或被篡改」出现=${inScanFp} 统一「损坏」出现=${hasUniform}`);
}

// ═══════════════════════════════════════════════════════════════════
// F-07（P3）locateProjectRoots 入参类型防御
// ═══════════════════════════════════════════════════════════════════
{
  // F-07（P3）locateProjectRoots 入参类型防御
  //
  // ★★★★ 判据修正（本轮第二个假绿）：第一版我调 `locateProjectRoots(undefined)`（**不传 projectId**），
  //   它返回空结果 ⇒ 我判 PASS。**但那是被 `PROJ_RE` 校验顺带挡住的，不是类型防御。**
  //   实测：`locateProjectRoots(undefined, "合法projectId")` ⇒ 抛
  //   `TypeError: The "paths[0]" argument must be of type string. Received undefined`。
  //   ⇒ **必须带上合法 projectId 再测**，否则测的是另一道闸。
  const VALID_PID = "0123456789abcdef";

  let r1;
  try { r1 = fp.locateProjectRoots(undefined, VALID_PID); } catch (e) { r1 = { threw: String(e?.message ?? e) }; }
  ok("F-07 locateProjectRoots(undefined, 合法projectId) 不抛异常", r1?.threw === undefined, String(r1?.threw ?? JSON.stringify(r1)).slice(0, 160));

  let r2;
  try { r2 = fp.locateProjectRoots("", VALID_PID); } catch (e) { r2 = { threw: String(e?.message ?? e) }; }
  const roots2 = Array.isArray(r2?.roots) ? r2.roots.length : -1;
  // 空串不许退化成"扫描宿主当前目录"
  ok("F-07b locateProjectRoots(\"\", 合法projectId) 不退化去扫 process.cwd()", r2?.threw === undefined && roots2 === 0, JSON.stringify({ threw: r2?.threw, roots: roots2 }).slice(0, 160));
}

console.log(rows.join("\n"));
console.log("─".repeat(72));
console.log(`合计：PASS ${pass} · FAIL ${fail}`);
console.log("PROBE-COMPLETE");
process.exit(0);
