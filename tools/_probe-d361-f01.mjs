// _probe-d361-f01.mjs —— F-01 精确构造：三载体**互相一致**但 check 不符（这才单独测出「自证位」）
//
// ★ 为什么要重做：第一版只改了 frontmatter 的 project，导致 frontmatter 与 link **互相打架**
//   ⇒ resolveByIdentity 以「多载体身份不一致」为由拒绝了 ⇒ 测到的是"冲突检测在起作用"，
//   **不是**报告说的"自证位不符被当老文件放行"。两种拒绝理由必须分开验。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LIB = (n) => "file:///" + path.join(ROOT, "lib", n).replace(/\\/g, "/");
const fp = await import(LIB("fingerprint.js"));

let pass = 0, fail = 0;
const ok = (t, c, extra) => {
  if (c) { pass++; console.log(`  PASS  ${t}`); }
  else { fail++; console.log(`  FAIL  ${t}${extra === undefined ? "" : `\n        ${String(extra).slice(0, 600)}`}`); }
};
const mk = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `d361f-${t}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };
const PID = "0123456789abcdef";
const FAKE = "ffffffffffffffff";

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

console.log("═══ F-01 精确：三载体一致但 check 不符 ═══");
{
  const mem = mk("f01");
  mkdir(path.join(mem, "decisions"));

  // 合法文件
  const good = fp.applyFingerprint3("## D7 · 测试\n\n正文\n", { kind: "decisions", project: PID, key: "D7" });
  // ★ 三处 project **全部**改成 FAKE，check 保持原值（不重算）⇒ 三处互相一致，但自证位不符
  const tampered = good.text.split(PID).join(FAKE);
  console.log("  篡改后（三处都改，check 不动）：");
  for (const l of tampered.split("\n")) {
    if (l.includes("dsh-fp") || l.includes("dsh-id")) console.log("    | " + l);
  }

  // 先直接看 readFingerprint3 怎么判
  const p3 = fp.readFingerprint3(tampered);
  console.log("  readFingerprint3 ⇒", JSON.stringify(p3)?.slice(0, 400));
  ok("① readFingerprint3 判为 ok:false 且理由含「自证位」",
    p3?.ok !== true && String(p3?.reason ?? "").includes("自证位"), JSON.stringify(p3)?.slice(0, 300));

  fs.writeFileSync(path.join(mem, "decisions", "D7.md"), tampered, "utf8");

  // ② resolveByIdentity 按名：必须拒绝，且**不能**以「无指纹老文件」放行
  const r = fp.resolveByIdentity(mem, { name: "decisions/D7.md", kind: "decisions", project: FAKE, key: "D7" });
  console.log("  resolveByIdentity ⇒", JSON.stringify(r)?.slice(0, 400));
  const noteIsOld = String(r?.note ?? "").includes("无指纹");
  ok("② 按名解析**不能**以「无指纹老文件」放行", !(r?.ok === true && noteIsOld), JSON.stringify(r)?.slice(0, 400));
  ok("② 拒绝理由**点到「自证位」**（不是笼统的不一致）",
    r?.ok !== true && String(r?.reason ?? "").includes("自证位"), String(r?.reason));

  // ③ scanBlind：改名后必须记进 bad
  fs.renameSync(path.join(mem, "decisions", "D7.md"), path.join(mem, "decisions", "renamed.md"));
  const scan = fp.scanBlind(mem, {});
  console.log(`  scanBlind: scanned=${scan.scanned} bad=${scan.bad?.length ?? 0}`);
  console.log("  bad ⇒", JSON.stringify(scan.bad)?.slice(0, 400));
  ok("③ 盲扫记进 bad", (scan.bad?.length ?? 0) >= 1, JSON.stringify(scan.bad)?.slice(0, 300));
  ok("③ bad 的理由点到「自证位」", (scan.bad ?? []).some((b) => String(b.reason ?? "").includes("自证位")), JSON.stringify(scan.bad)?.slice(0, 300));

  // ④ rebuildFromFingerprints 必须**如实报出**这次篡改（走 warnings 或 reason 都算）
  //   ★ 判据是「报告出来的话里点到自证位」，不是「必须走哪一个字段」——
  //     全部文件都被拒时它是 ok:false，没有 warnings 可言，只能从 reason/bad 里说。
  const rb = fp.rebuildFromFingerprints(mem);
  console.log("  rebuild 返回键 ⇒", Object.keys(rb ?? {}).join(","));
  console.log("  rebuild ⇒", JSON.stringify(rb)?.slice(0, 500));
  const surface = [
    ...(Array.isArray(rb?.warnings) ? rb.warnings : []),
    ...(Array.isArray(rb?.notes) ? rb.notes : []),
    ...(Array.isArray(rb?.bad) ? rb.bad.map((b) => b?.reason) : []),
    rb?.reason,
  ].filter((x) => typeof x === "string");
  ok("④ 重建时如实报出「自证位不符」", surface.some((w) => w.includes("自证位")), JSON.stringify(surface)?.slice(0, 400));

  rm(mem);
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
