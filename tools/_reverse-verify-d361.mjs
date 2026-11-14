// _reverse-verify-d361.mjs —— 反向验证：把 017 的每一处修复**单独摘掉**，看守卫会不会变红
//
// ★ 判据（D324 #34）：「我能破坏它」≠「它是那个洞的唯一守卫」。
//   ⇒ 每一条都必须**构造出「没有它就会漏」的输入**，摘掉后必须见到红。
// ★ 做法：把 lib 拷到临时目录，逐条破坏，再 import 那份被破坏的副本跑同一批断言。
//   生产工作区一个字节都不动。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC = path.join(ROOT, "lib");

let pass = 0, fail = 0;
const ok = (t, c, extra) => {
  if (c) { pass++; console.log(`  PASS  ${t}`); }
  else { fail++; console.log(`  FAIL  ${t}${extra === undefined ? "" : `\n        ${String(extra).slice(0, 500)}`}`); }
};
const mk = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `r361-${t}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };
const PID = "0123456789abcdef";
const FAKE = "ffffffffffffffff";

/** 拷一份 lib 到临时目录，返回可 import 的 fingerprint.js URL */
function sandboxLib() {
  const d = mk("lib");
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  const dst = path.join(d, "lib");
  fs.cpSync(SRC, dst, { recursive: true });
  return { dir: d, dst, url: pathToFileURL(path.join(dst, "fingerprint.js")).href };
}

/** 在沙箱副本里做一次文本替换；断言替换真的发生了（否则就是夹具故障，不是被测对象的问题） */
function patchFile(file, from, to, label) {
  const s = fs.readFileSync(file, "utf8");
  if (!s.includes(from)) throw new Error(`夹具故障：${label} —— 找不到要替换的原文`);
  fs.writeFileSync(file, s.split(from).join(to), "utf8");
}

console.log("═══ 反向验证 ①：摘掉 resolveByIdentity 的「自证位」拦截 ═══");
{
  const { dir, dst, url } = sandboxLib();
  patchFile(
    path.join(dst, "fingerprint.js"),
    `(String(p3.reason).includes("不一致") || String(p3.reason).includes("自证位"))`,
    `(String(p3.reason).includes("不一致"))`,
    "resolveByIdentity 自证位拦截",
  );
  const fp = await import(url);

  const mem = mk("r1");
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  const good = fp.applyFingerprint3("## D7 · 测试\n\n正文\n", { kind: "decisions", project: PID, key: "D7" });
  fs.writeFileSync(path.join(mem, "decisions", "D7.md"), good.text.split(PID).join(FAKE), "utf8");

  const r = fp.resolveByIdentity(mem, { name: "decisions/D7.md", kind: "decisions", project: FAKE, key: "D7" });
  console.log("  破坏后 resolveByIdentity ⇒", JSON.stringify(r)?.slice(0, 260));
  ok("① 摘掉后**必须变红**（被当无指纹老文件放行）", r?.ok === true, JSON.stringify(r)?.slice(0, 300));
  ok("① 且理由里出现「无指纹」", String(r?.note ?? "").includes("无指纹"), String(r?.note));
  rm(mem); rm(dir);
}

console.log("\n═══ 反向验证 ②：摘掉 scanBlind 的「自证位」拦截 ═══");
{
  const { dir, dst, url } = sandboxLib();
  patchFile(
    path.join(dst, "fingerprint.js"),
    `        String(p3.reason).includes("不一致") ||
        (verifyCheck && String(p3.reason).includes("自证位"))`,
    `        String(p3.reason).includes("不一致")`,
    "scanBlind 自证位拦截",
  );
  const fp = await import(url);

  const mem = mk("r2");
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  const good = fp.applyFingerprint3("## D7 · 测试\n\n正文\n", { kind: "decisions", project: PID, key: "D7" });
  fs.writeFileSync(path.join(mem, "decisions", "renamed.md"), good.text.split(PID).join(FAKE), "utf8");

  const scan = fp.scanBlind(mem, {});
  console.log(`  破坏后 scanBlind: scanned=${scan.scanned} bad=${scan.bad?.length ?? 0}`);
  ok("② 摘掉后 bad 必须变空（静默丢弃）", (scan.bad?.length ?? 0) === 0, JSON.stringify(scan.bad)?.slice(0, 300));
  rm(mem); rm(dir);
}

console.log("\n═══ 反向验证 ③：摘掉 verifySeal 的三载体支持（退回旧单载体解析器） ═══");
{
  const { dir, dst, url } = sandboxLib();
  // verifySeal 现状：readFingerprint3 优先，失败才回退 parseFingerprint。
  // 摘掉 = 只留旧单载体解析器 ⇒ 三载体文件应当报「无指纹可校验」。
  patchFile(
    path.join(dst, "fingerprint.js"),
    `          const r3 = readFingerprint3(text);
          return r3.ok === true ? r3 : parseFingerprint(text);`,
    `          return parseFingerprint(text);`,
    "verifySeal 的三载体解析",
  );
  const fp = await import(url);

  const good = fp.applyFingerprint3("## D7 · 测试\n\n正文\n", { kind: "decisions", project: PID, key: "D7" });
  const r = fp.verifySeal(good.text);
  console.log("  破坏后 verifySeal(三载体) ⇒", JSON.stringify(r));
  ok("③ 摘掉后必须变红（三载体报「无指纹可校验」）", r?.ok === false, JSON.stringify(r));

  // 同时确认现状（未破坏）是绿的，否则这条反向验证没有区分力
  const { dir: d2, url: u2 } = sandboxLib();
  const fp2 = await import(u2);
  const r2 = fp2.verifySeal(good.text);
  ok("③ 对照组（未破坏）必须判 seal 正确", r2?.ok === true, JSON.stringify(r2));
  rm(d2);
  rm(dir);
}

console.log("\n═══ 反向验证 ④：摘掉 readEntryUnified 的指纹 key 校验（F-04） ═══");
{
  const d = mk("lib4");
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  const dst = path.join(d, "lib");
  fs.cpSync(SRC, dst, { recursive: true });
  const cardOpsFile = path.join(dst, "card-ops.js");
  const part2Url = pathToFileURL(path.join(dst, "part2.js")).href;

  // 破坏：把整段 key 校验的**总开关**关掉（`wantKey !== ""` 是这段的唯一入口条件）
  patchFile(cardOpsFile, `wantKey !== "" &&`, `false &&`, "card-ops 的 key 校验总开关");

  const cardOps = await import(pathToFileURL(cardOpsFile).href);
  const fp = await import(pathToFileURL(path.join(dst, "fingerprint.js")).href);
  const part2 = await import(part2Url);

  // 造一个项目：D195.md 里装的是 key=D196 的卡
  // ★ 夹具必须带清单 —— 否则 readEntryUnified 会说「这一类记忆没有登记」，
  //   那是夹具故障冒充被测对象（纪律 #6）。
  const root = mk("r4");
  const memName = `${path.basename(root)}-ledger-memory`;
  const mem = path.join(root, memName);
  for (const dd of ["decisions", "_arch"]) fs.mkdirSync(path.join(mem, dd), { recursive: true });
  const mf = {
    version: 1, protocolVersion: 3, active: "LEDGER.md", archiveDir: "_arch",
    decisionsDir: "decisions", maxActiveLines: 400, revision: 0,
    projectId: PID, memoryRoot: memName,
  };
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify(mf, null, 2), "utf8");
  fs.writeFileSync(path.join(mem, ".dsh-ledger.json"), JSON.stringify(mf, null, 2), "utf8");
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# 台账\n\n## 目标\n测试\n", "utf8");

  const other = fp.applyFingerprint3("## D196 · 另一条\n\n正文\n", { kind: "decisions", project: PID, key: "D196" });
  fs.writeFileSync(path.join(mem, "decisions", "D195.md"), other.text, "utf8");

  // ★ 真签名是 (root, info, kind, entry) —— 四参，info 要 inspect(root) 的返回
  const info = part2.inspect(root);
  const got = cardOps.readEntryUnified(root, info, "decisions", "D195");
  console.log("  破坏后 读 D195 ⇒", JSON.stringify(got)?.slice(0, 300));
  ok("④ 摘掉后必须变红（把 D196 的内容当 D195 交出去）",
    got?.found === true && String(got?.heading ?? "").includes("D196"),
    JSON.stringify(got)?.slice(0, 300));
  rm(root); rm(d);
}

console.log("\n═══ 反向验证 ⑤：identityOfPath 的 *Rel 兼容（F-05） ═══");
{
  const { dir, dst, url } = sandboxLib();
  patchFile(
    path.join(dst, "fingerprint.js"),
    `[info.active ?? info.activeRel, "active"],`,
    `[info.active, "active"],`,
    "identityOfPath activeRel 兼容",
  );
  const fp = await import(url);
  const info = { memoryBase: path.join(os.tmpdir(), "nowhere"), activeRel: "LEDGER.md" };
  const r = fp.identityOfPath(info, path.join(info.memoryBase, "LEDGER.md"));
  console.log("  破坏后 identityOfPath(inspect 形状) ⇒", JSON.stringify(r));
  ok("⑤ 摘掉 activeRel 兼容后必须变红（认不出活跃台账）", r === undefined, JSON.stringify(r));
  rm(dir);
}

console.log("\n═══ 反向验证 ⑥：rebuildFromFingerprints 的「被拒要说出来」（我本轮补的） ═══");
{
  const { dir, dst, url } = sandboxLib();
  patchFile(
    path.join(dst, "fingerprint.js"),
    `    if (scan.bad.length > 0) {
      return {
        ok: false,
        reason:`,
    `    if (false) {
      return {
        ok: false,
        reason:`,
    "rebuild 的 bad 分支",
  );
  const fp = await import(url);
  const mem = mk("r6");
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  const good = fp.applyFingerprint3("## D7 · 测试\n\n正文\n", { kind: "decisions", project: PID, key: "D7" });
  fs.writeFileSync(path.join(mem, "decisions", "renamed.md"), good.text.split(PID).join(FAKE), "utf8");
  const rb = fp.rebuildFromFingerprints(mem);
  console.log("  破坏后 rebuild ⇒", JSON.stringify(rb)?.slice(0, 260));
  ok("⑥ 摘掉后必须退回「未找到任何指纹文件」（会让人以为根本没有指纹）",
    String(rb?.reason ?? "").includes("未找到任何指纹文件"), String(rb?.reason));
  rm(mem); rm(dir);
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
