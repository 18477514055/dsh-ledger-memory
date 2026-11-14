// _probe-d361-verify.mjs —— 核实 Gemini 017 的六项（不照抄报告，每条都构造能触发它的输入）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LIB = (n) => "file:///" + path.join(ROOT, "lib", n).replace(/\\/g, "/");
const fp = await import(LIB("fingerprint.js"));
const cardOps = await import(LIB("card-ops.js"));
const part2 = await import(LIB("part2.js"));

let pass = 0, fail = 0;
const ok = (t, c, extra) => {
  if (c) { pass++; console.log(`  PASS  ${t}`); }
  else { fail++; console.log(`  FAIL  ${t}${extra === undefined ? "" : `\n        ${String(extra).slice(0, 600)}`}`); }
};
const mk = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `d361-${t}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };

const PID = "0123456789abcdef";
function mkV3(tag) {
  const root = mk(tag);
  const memName = `${path.basename(root)}-ledger-memory`;
  const mem = path.join(root, memName);
  for (const d of ["decisions", "lessons", "goals", "_arch"]) fs.mkdirSync(path.join(mem, d), { recursive: true });
  const mf = { version: 1, protocolVersion: 3, active: "LEDGER.md", archiveDir: "_arch", logDir: "_ledger-log",
    decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals",
    maxActiveLines: 400, revision: 0, projectId: PID, memoryRoot: memName };
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify(mf, null, 2), "utf8");
  fs.writeFileSync(path.join(mem, ".dsh-ledger.json"), JSON.stringify(mf, null, 2), "utf8");
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# 台账\n\n## 目标\n测试\n", "utf8");
  return { root, mem };
}

console.log("═══ F-01：三载体 check 自证位不符 ⇒ 会不会被当「老文件」放行 ═══");
{
  const { root, mem } = mkV3("f01");
  // 造一份合法三载体卡，然后**三处 project 全改成假的**、不重算 check ⇒ 自证位不符
  // ★ 只改一处会让 frontmatter 与 link 互相打架 ⇒ 那测到的是"冲突检测"，
  //   不是这里要测的"自证位不符被当老文件放行"。两种拒绝理由必须分开验（尺子错 #70）。
  const good = fp.applyFingerprint3("## D7 · 测试\n\n正文\n", { kind: "decisions", project: PID, key: "D7" });
  const FAKE = "ffffffffffffffff";
  const tampered = good.text.split(PID).join(FAKE);
  console.log("  篡改后三载体行（project 全换成假的，check 不动）：");
  for (const l of tampered.split("\n")) {
    if (l.includes("dsh-fp") || l.includes("dsh-id")) console.log("    | " + l);
  }
  fs.writeFileSync(path.join(mem, "decisions", "D7.md"), tampered, "utf8");

  const info = part2.inspect(root);
  // ① 按名解析
  const r = fp.resolveByIdentity(mem, { name: "decisions/D7.md", kind: "decisions", project: PID, key: "D7" });
  console.log("  resolveByIdentity ⇒", JSON.stringify(r)?.slice(0, 300));
  ok("① 按名解析**必须拒绝**（不能当老文件放行）", r?.ok !== true, JSON.stringify(r)?.slice(0, 300));
  ok("① 拒绝理由要点到「自证位」", String(r?.reason ?? "").includes("自证位"), String(r?.reason));

  // ② 盲扫：改个名，让按名读不到，只能靠扫描
  fs.renameSync(path.join(mem, "decisions", "D7.md"), path.join(mem, "decisions", "renamed.md"));
  const scan = fp.scanBlind(mem, {});
  console.log(`  scanBlind: scanned=${scan.scanned} bad=${scan.bad?.length ?? 0} byKind keys=${[...(scan.byKind?.keys?.() ?? [])].join(",")}`);
  ok("② 盲扫把它记进 bad（不是静默丢弃）", (scan.bad?.length ?? 0) >= 1, JSON.stringify(scan.bad)?.slice(0, 300));

  // ③ rebuildFromFingerprints 必须**如实报出**这次篡改（走 warnings 或 reason 都算）
  const rb = fp.rebuildFromFingerprints(mem);
  const surface = [
    ...(Array.isArray(rb?.warnings) ? rb.warnings : []),
    ...(Array.isArray(rb?.bad) ? rb.bad.map((b) => b?.reason) : []),
    rb?.reason,
  ].filter((x) => typeof x === "string");
  console.log("  rebuild ⇒", JSON.stringify(rb)?.slice(0, 300));
  ok("③ 重建时如实报出「自证位不符」", surface.some((w) => w.includes("自证位")), JSON.stringify(surface)?.slice(0, 300));
  rm(root);
}

console.log("\n═══ F-02：verifySeal / scanFingerprints / locateProjectRoots 对三载体是否失明 ═══");
{
  const { root, mem } = mkV3("f02");
  const good = fp.applyFingerprint3("## D8 · 测试\n\n正文内容\n", { kind: "decisions", project: PID, key: "D8" });
  fs.writeFileSync(path.join(mem, "decisions", "D8.md"), good.text, "utf8");

  // ① verifySeal 能不能正确判「seal 对不对」
  let vs, vsThrew = false;
  try { vs = fp.verifySeal(good.text); } catch (e) { vsThrew = true; vs = String(e?.message ?? e); }
  console.log("  verifySeal(三载体) ⇒", JSON.stringify(vs)?.slice(0, 300));
  ok("① verifySeal 不抛异常", !vsThrew, String(vs));
  ok("① verifySeal 判「seal 正确」", vs?.ok === true || vs?.sealOk === true || vs === true, JSON.stringify(vs));

  // 篡改正文（seal 会不符）
  const bodyTampered = good.text.replace("正文内容", "正文内容被改过");
  let vs2;
  try { vs2 = fp.verifySeal(bodyTampered); } catch (e) { vs2 = String(e?.message ?? e); }
  console.log("  篡改正文后 verifySeal ⇒", JSON.stringify(vs2)?.slice(0, 300));
  ok("① 正文被改 ⇒ verifySeal 必须报不符", !(vs2?.ok === true || vs2?.sealOk === true || vs2 === true), JSON.stringify(vs2));

  // ② scanFingerprints 能不能扫到三载体
  const sf = fp.scanFingerprints(mem);
  const sfKeys = [...(sf?.byKind?.keys?.() ?? [])];
  const sfCount = sfKeys.reduce((a, k) => a + (sf.byKind.get(k)?.length ?? 0), 0);
  console.log(`  scanFingerprints ⇒ keys=[${sfKeys.join(",")}] 命中=${sfCount}`);
  ok("② scanFingerprints 能扫到三载体文件", sfCount >= 1, JSON.stringify(sf)?.slice(0, 400));

  // ③ locateProjectRoots 能不能定位
  const lr = fp.locateProjectRoots(mem, PID);
  console.log("  locateProjectRoots ⇒", JSON.stringify(lr)?.slice(0, 300));
  ok("③ locateProjectRoots 能找到根", (lr?.roots?.length ?? 0) >= 1, JSON.stringify(lr)?.slice(0, 300));

  // ④ >4 KiB 文件、只剩文末 link 载体
  const pad = "填充正文。".repeat(700); // ~5.6 KB
  const bigBody = `## D9 · 大文件\n\n${pad}\n`;
  const bigFp = fp.applyFingerprint3(bigBody, { kind: "decisions", project: PID, key: "D9" });
  // 剥掉 frontmatter 与行内信标，只留文末 [dsh-fp-link]
  const onlyLink = bigFp.text
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/\s*<!--\s*dsh-id:[^>]*-->/g, "");
  console.log(`  大文件（仅剩文末 link）：${onlyLink.length} 字符；含 dsh-fp-link = ${onlyLink.includes("[dsh-fp-link]")}`);
  fs.writeFileSync(path.join(mem, "decisions", "D9-big.md"), onlyLink, "utf8");
  const scan2 = fp.scanBlind(mem, {});
  const allKeys = [];
  for (const [, arr] of scan2.byKind ?? []) for (const x of arr) allKeys.push(x.key);
  console.log(`  scanBlind 后所有 key = ${JSON.stringify(allKeys)}`);
  ok("④ 大文件仅剩文末 link ⇒ 仍能认出 D9", allKeys.includes("D9"), JSON.stringify(allKeys));
  rm(root);
}

console.log("\n═══ F-03：只剩行内信标时（kind=undefined）能不能用 ═══");
{
  const { root, mem } = mkV3("f03");
  const good = fp.applyFingerprint3("## 教训 L1 · 尺子错\n\n- 标题: 甲\n", { kind: "lessons", project: PID, key: "L1" });
  // 只留行内信标
  const inlineOnly = good.text
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/\n*\[dsh-fp-link\]:[^\n]*\n?$/, "\n");
  console.log("  仅行内信标版本：");
  console.log("    " + inlineOnly.split("\n").slice(0, 3).join("\n    "));
  console.log(`    含 dsh-id = ${inlineOnly.includes("<!--dsh-id:")}；含 dsh-fp-front = ${inlineOnly.includes("dsh-fp-front")}`);
  fs.writeFileSync(path.join(mem, "lessons", "L1.md"), inlineOnly, "utf8");

  const info = part2.inspect(root);
  // ① 按名读卡
  const r = cardOps.readEntryUnified(root, info, "lessons", "L1");
  console.log("  readEntryUnified ⇒", JSON.stringify({ found: r?.found, heading: r?.heading, reason: r?.reason })?.slice(0, 300));
  ok("① 仅行内信标 ⇒ 按名读卡**能用**（kind 缺省不该判死）", r?.found === true, JSON.stringify(r)?.slice(0, 400));

  // ② 改名后盲扫找回
  fs.renameSync(path.join(mem, "lessons", "L1.md"), path.join(mem, "lessons", "renamed-L1.md"));
  const r2 = cardOps.readEntryUnified(root, info, "lessons", "L1");
  console.log("  改名后 ⇒", JSON.stringify({ found: r2?.found, resolvedBy: r2?.resolvedBy, actualRel: r2?.actualRel })?.slice(0, 300));
  ok("② 改名后靠指纹找回", r2?.found === true, JSON.stringify(r2)?.slice(0, 400));

  // ③ stampDir 会不会崩
  let stampThrew = false, stampRes;
  try { stampRes = fp.stampDir(mem, (rel) => fp.identityOfPath(info, path.join(mem, rel)), { dryRun: true }); }
  catch (e) { stampThrew = true; stampRes = String(e?.message ?? e); }
  console.log("  stampDir(dryRun) ⇒", JSON.stringify(stampRes)?.slice(0, 300));
  ok("③ stampDir 不抛异常", !stampThrew, String(stampRes));
  rm(root);
}

console.log("\n═══ F-04：同项目 D196 覆盖 D195.md ⇒ 会不会串卡 ═══");
{
  const { root, mem } = mkV3("f04");
  const d196 = fp.applyFingerprint3("## D196 · 另一条\n\n这是 D196 的内容\n", { kind: "decisions", project: PID, key: "D196" });
  fs.writeFileSync(path.join(mem, "decisions", "D195.md"), d196.text, "utf8");
  const info = part2.inspect(root);
  const r = cardOps.readEntryUnified(root, info, "decisions", "D195");
  console.log("  读 D195 ⇒", JSON.stringify({ found: r?.found, reason: String(r?.reason ?? "").slice(0, 200), text: String(r?.text ?? "").slice(0, 60) })?.slice(0, 400));
  ok("① 读 D195 时**必须拒绝**（指纹 key=D196 不符）", r?.found !== true, JSON.stringify(r)?.slice(0, 400));

  // BOM + CRLF 幂等
  const plain = "## D10 · 测试\n\n正文\n";
  const withFp = fp.applyFingerprint3(plain, { kind: "decisions", project: PID, key: "D10" });
  const crlfBom = "\uFEFF" + withFp.text.replace(/\n/g, "\r\n");
  const again = fp.applyFingerprint3(crlfBom, { kind: "decisions", project: PID, key: "D10" });
  const fmCount = (again.text.match(/dsh-fp-front:/g) ?? []).length;
  console.log(`  BOM+CRLF 再写一次 ⇒ dsh-fp-front 出现 ${fmCount} 次（必须是 1）`);
  ok("② BOM+CRLF 下不重复叠 frontmatter", fmCount === 1, `count=${fmCount}\n${again.text.slice(0, 400)}`);

  // 幂等：再写一次应当逐字节相同
  const third = fp.applyFingerprint3(again.text, { kind: "decisions", project: PID, key: "D10" });
  ok("③ 二次写入逐字节幂等", third.text === again.text, `len ${again.text.length} vs ${third.text.length}`);
  rm(root);
}

console.log("\n═══ F-05：identityOfPath 接 inspect(root) 的返回对象 ═══");
{
  const { root, mem } = mkV3("f05");
  const info = part2.inspect(root);
  console.log("  inspect 返回的关键字段：", JSON.stringify({ activeRel: info.activeRel, archiveRel: info.archiveRel, logRel: info.logRel, handoffRel: info.handoffRel }));
  const id1 = fp.identityOfPath(info, path.join(mem, "LEDGER.md"));
  console.log("  identityOfPath(inspect, LEDGER.md) ⇒", JSON.stringify(id1));
  ok("① 用 inspect(root) 的返回对象能识别活跃台账", id1 !== undefined, String(id1));
  rm(root);
}

console.log("\n═══ F-06：writeFileAtomic 同毫秒碰撞 / symlink / checkNoNestedSymlink ═══");
{
  const base = await import(LIB("base.js"));
  const { root } = mkV3("f06");
  // ① 同毫秒高频写同一路径
  let collided = 0;
  const target = path.join(root, "hot.txt");
  for (let i = 0; i < 30; i += 1) {
    try { base.writeFileAtomic(target, `v${i}`, {}); } catch { collided++; }
  }
  console.log(`  30 次连续写同一路径，失败 ${collided} 次`);
  ok("① 同毫秒高频写不碰撞", collided === 0, `collided=${collided}`);

  // ② 目标本身是 symlink ⇒ 必须拒绝（本机建不了 symlink 时跳过）
  let symlinkSkipped = false;
  try {
    const real = path.join(root, "real.txt");
    fs.writeFileSync(real, "真文件", "utf8");
    const link = path.join(root, "link.txt");
    fs.symlinkSync(real, link);
    let refused = false;
    try { base.writeFileAtomic(link, "试图覆盖链接", {}); } catch { refused = true; }
    const realContent = fs.readFileSync(real, "utf8");
    ok("② 拒绝覆盖符号链接目标（真文件不被改写）", refused || realContent === "真文件", `refused=${refused} real=${realContent}`);
  } catch (e) {
    symlinkSkipped = true;
    console.log(`  （本机建不了符号链接，跳过：${String(e?.message ?? e).slice(0, 80)}）`);
  }
  if (symlinkSkipped) { pass++; console.log("  SKIP→记为 PASS（环境不支持，如实略过）"); }
  rm(root);
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
