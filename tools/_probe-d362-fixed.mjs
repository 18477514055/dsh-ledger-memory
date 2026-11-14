// _probe-d362-fixed.mjs —— Gemini 018 六项**守卫**（断言「已修好」）
//
// ★★ 与 _probe-d362-verify.mjs（取证器）**分两份**：
//   取证器断言"缺陷存在"（修好后必红）；这份断言"已修好"（修好才绿）。
//   合成一份 = 要么假绿要么永久红（D361 教训）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LIB = (n) => pathToFileURL(path.join(ROOT, "lib", n)).href;
const fp = await import(LIB("fingerprint.js"));

let pass = 0, fail = 0;
const ok = (t, c, extra) => {
  if (c) { pass++; console.log(`  PASS  ${t}`); }
  else { fail++; console.log(`  FAIL  ${t}${extra === undefined ? "" : `\n        ${String(extra).slice(0, 600)}`}`); }
};
const mk = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `g362-${t}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };
const PID = "0123456789abcdef";

console.log("═══ F-01：ExtensionsPage 的 cur 必须先于依赖数组声明 ═══");
{
  const src = fs.readFileSync(path.join(ROOT, "lib", "client.js"), "utf8");
  const lines = src.split("\n");
  const ai = lines.findIndex((l) => l.includes("const send = useCallback("));
  // ★ 修好后 cur 在 send **之前** ⇒ 要全文件找，不能再加 i > ai 的条件（我第一版就栽在这）
  const bi = lines.findIndex((l) => l.includes("const cur = projects.find"));
  let depEnd = -1, depLine = "";
  for (let i = ai; i < Math.min(ai + 60, lines.length); i++) {
    if (/^\s*\[[^\]]*\]\s*$/.test(lines[i]) && i > ai + 2) { depEnd = i; depLine = lines[i]; break; }
  }
  console.log(`  send@${ai + 1} · cur@${bi + 1} · 依赖数组@${depEnd + 1}`);
  console.log(`  依赖数组 ⇒ ${JSON.stringify(depLine.trim())}`);
  const curBeforeDeps = bi !== -1 && depEnd !== -1 && bi < depEnd;
  ok("① cur 声明在依赖数组**之前**（TDZ 消除）", curBeforeDeps, `curAt=${bi + 1} depEnd=${depEnd + 1}`);
  ok("① 且 cur 仍被依赖数组引用（不是靠删引用蒙混）", depLine.includes("cur"), depLine);
  ok("① cur 声明确实存在（不是被删掉）", bi !== -1, `bi=${bi}`);
}

console.log("\n═══ F-02a：标记还在但载荷坏 ⇒ 必须区分「没有」与「坏了」 ═══");
{
  const good = fp.applyFingerprint3("## D7 · 测试\n\n正文\n", { kind: "decisions", project: PID, key: "D7" });
  const broken = good.text.replace(/check=[0-9a-f]{8}/g, "check=zzzzzzzz").replace(/<!--dsh-id:[^>]*-->/g, "");
  const markersStillThere = broken.includes("dsh-fp-front:") && broken.includes("[dsh-fp-link]: dsh-ledger-fp");
  const p3 = fp.readFingerprint3(broken);
  console.log("  readFingerprint3 ⇒", JSON.stringify(p3)?.slice(0, 300));
  ok("② 夹具：标记字面还在", markersStillThere);
  ok("② 判为 ok:false", p3?.ok !== true, JSON.stringify(p3)?.slice(0, 200));
  ok("② 理由**不再**是「三处载体都没有」", !String(p3?.reason ?? "").includes("三处载体都没有"), p3?.reason);
  ok("② 理由点到「损坏 / 改坏」", /损坏|改坏/.test(String(p3?.reason ?? "")), p3?.reason);

  const mem = mk("f02a");
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(mem, "decisions", "D7.md"), broken, "utf8");
  const r = fp.resolveByIdentity(mem, { name: "decisions/D7.md", kind: "decisions", project: PID, key: "D7" });
  const scan = fp.scanBlind(mem, {});
  console.log("  resolveByIdentity ⇒", JSON.stringify(r)?.slice(0, 260));
  console.log(`  scanBlind: scanned=${scan.scanned} bad=${scan.bad?.length ?? 0}`);
  ok("② 按名解析**拒绝**放行（不再当无指纹老文件）", !(r?.ok === true && String(r?.note ?? "").includes("无指纹")), JSON.stringify(r)?.slice(0, 260));
  ok("② 盲扫把它记进 bad", (scan.bad?.length ?? 0) >= 1, JSON.stringify(scan.bad)?.slice(0, 260));
  rm(mem);
}

console.log("\n═══ F-02b：行内信标的卡片 key 不能冒充单例 ═══");
{
  const mem = mk("f02b");
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(mem, "LEDGER.md"), `## 教训 L1 · 甲 <!--dsh-id:${PID}:D195-->\n\n正文\n`, "utf8");
  const r = fp.resolveByIdentity(mem, { name: "LEDGER.md", kind: "active", project: PID, key: "" });
  console.log("  resolveByIdentity(LEDGER.md, key=\"\") ⇒", JSON.stringify(r)?.slice(0, 300));
  ok("②b 卡片 key 冒充单例 ⇒ 必须拒绝", r?.ok !== true, JSON.stringify(r)?.slice(0, 300));

  // 反面：真正的单例（key="-"）必须仍然通过 —— 否则就是"修不好靠放宽"的反向病
  const mem2 = mk("f02b2");
  fs.writeFileSync(path.join(mem2, "LEDGER.md"), `# 台账 <!--dsh-id:${PID}:--->\n\n正文\n`, "utf8");
  const r2 = fp.resolveByIdentity(mem2, { name: "LEDGER.md", kind: "active", project: PID, key: "" });
  console.log("  真的单例（key=\"-\"）⇒", JSON.stringify(r2)?.slice(0, 240));
  ok("②b 真单例（key=\"-\"）**仍然通过**（不能靠一刀切封死）", r2?.ok === true, JSON.stringify(r2)?.slice(0, 240));
  rm(mem); rm(mem2);
}

console.log("\n═══ F-02c：同目录有完整卡时，仅剩行内信标的改名卡仍能找回 ═══");
{
  const mem = mk("f02c");
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  const other = fp.applyFingerprint3("## D196 · 另一条\n\n正文\n", { kind: "decisions", project: PID, key: "D196" });
  fs.writeFileSync(path.join(mem, "decisions", "D196.md"), other.text, "utf8");
  fs.writeFileSync(path.join(mem, "decisions", "renamed-195.md"), `## D195 · 要找的 <!--dsh-id:${PID}:D195-->\n\n正文\n`, "utf8");

  const r = fp.resolveByIdentity(mem, { name: "decisions/D195.md", kind: "decisions", project: PID, key: "D195" });
  console.log("  resolveByIdentity ⇒", JSON.stringify(r)?.slice(0, 400));
  ok("②c 改名卡靠行内信标找回", r?.ok === true, JSON.stringify(r)?.slice(0, 400));
  ok("②c 且指到了真实位置 renamed-195.md", String(r?.abs ?? "").includes("renamed-195") || String(r?.rel ?? "").includes("renamed-195"), JSON.stringify(r)?.slice(0, 300));
  rm(mem);
}

console.log("\n═══ F-03：跨 4096 边界的 link 载体必须完整 ═══");
{
  const mem = mk("f03");
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  const good = fp.applyFingerprint3("## D9 · 边界\n\n正文\n", { kind: "decisions", project: PID, key: "D9" });
  const linkLine = good.text.split("\n").find((l) => l.startsWith("[dsh-fp-link]:"));
  const HALF = 20;
  const fillLen = 4096 - HALF;
  let body = "";
  while (Buffer.byteLength(body) < fillLen) body += "x";
  body = body.slice(0, fillLen);
  const text = body + "\n" + linkLine + "\n";
  const size = Buffer.byteLength(text);
  fs.writeFileSync(path.join(mem, "decisions", "D9.md"), text, "utf8");
  const scan = fp.scanBlind(mem, {});
  const keys = [...scan.byKind.values()].flat().map((x) => x.key);
  console.log(`  文件 ${size} B（link 行跨 4096）⇒ scanBlind keys = ${JSON.stringify(keys)}`);
  ok("③ 跨 4096 边界的 link 载体仍能认出 D9", keys.includes("D9"), JSON.stringify(keys));

  // 多尺寸扫一遍（边界不止一个位置）
  let allOk = true, worst = "";
  for (let delta = 0; delta <= 200; delta += 7) {
    const d2 = mk("f03b");
    fs.mkdirSync(path.join(d2, "decisions"), { recursive: true });
    let b = "";
    const target = 4096 - delta;
    while (Buffer.byteLength(b) < target) b += "y";
    b = b.slice(0, target);
    fs.writeFileSync(path.join(d2, "decisions", "D9.md"), b + "\n" + linkLine + "\n", "utf8");
    const s = fp.scanBlind(d2, {});
    const ks = [...s.byKind.values()].flat().map((x) => x.key);
    if (!ks.includes("D9")) { allOk = false; worst = `delta=${delta} keys=${JSON.stringify(ks)}`; }
    rm(d2);
  }
  ok("③ 边界 ±200 字节全扫一遍仍全部认得出", allOk, worst);
  rm(mem);
}

console.log("\n═══ F-04a：自定义卡片目录必须也盖指纹 ═══");
{
  const mem = mk("f04a");
  const memName = `${path.basename(mem)}-ledger-memory`;
  const memo = path.join(mem, memName);
  fs.mkdirSync(path.join(memo, "custom-decisions"), { recursive: true });
  fs.mkdirSync(path.join(memo, "decisions"), { recursive: true });
  const mf = {
    version: 1, protocolVersion: 3, active: "LEDGER.md", archiveDir: "_arch",
    decisionsDir: "custom-decisions", maxActiveLines: 400, revision: 0, projectId: PID, memoryRoot: memName,
  };
  fs.writeFileSync(path.join(mem, ".dsh-ledger.json"), JSON.stringify(mf, null, 2), "utf8");
  fs.writeFileSync(path.join(memo, ".dsh-ledger.json"), JSON.stringify(mf, null, 2), "utf8");
  fs.writeFileSync(path.join(memo, "LEDGER.md"), "# 台账\n", "utf8");

  const cardOps = await import(LIB("card-ops.js"));
  // ★★ 必须按**生产调用形态**来测（否则测的是我自己编的路径）：
  //    生产是 writeCard(memBase, 叶目录名, key, text) —— root 传的是**内存根**，
  //    dirRel 是相对内存根的叶名（card-ops.js:676 / part4.js:1587 实测如此）。
  const w = cardOps.writeCard(memo, "custom-decisions", "D1", "## D1 · 自定义目录\n\n正文\n");
  const cardPath = path.join(memo, "custom-decisions", "D1.md");
  const txt = fs.existsSync(cardPath) ? fs.readFileSync(cardPath, "utf8") : "";
  const hasFp = txt.includes("dsh-fp-front");
  console.log(`  writeCard(memBase, "custom-decisions") ⇒ ok=${w?.ok}；卡片有指纹=${hasFp}`);
  ok("④a 夹具：卡片写出来了", fs.existsSync(cardPath), `ok=${w?.ok} path=${w?.path}`);
  ok("④a 自定义目录的卡片**现在有**指纹（靠清单反查 decisionsDir）", hasFp, txt.slice(0, 200));

  const p3 = fp.readFingerprint3(txt);
  console.log("  卡片指纹 ⇒", JSON.stringify(p3?.id ?? null));
  ok("④a 指纹 kind 被识别为 decisions（不是 undefined）", p3?.ok === true && p3?.id?.kind === "decisions", JSON.stringify(p3?.id));
  ok("④a 指纹 key 是 D1", String(p3?.id?.key) === "D1", String(p3?.id?.key));

  // 显式 opts.kind 的通道也必须能生效（生产多数调用点走这条）
  const w3 = cardOps.writeCard(memo, "whatever-dir", "D2", "## D2 · 显式 kind\n\n正文\n", { kind: "lessons" });
  const p3b = path.join(memo, "whatever-dir", "D2.md");
  const t3 = fs.existsSync(p3b) ? fs.readFileSync(p3b, "utf8") : "";
  const fp3 = fp.readFingerprint3(t3);
  console.log(`  显式 opts.kind=lessons ⇒ ok=${w3?.ok} kind=${JSON.stringify(fp3?.id?.kind)}`);
  ok("④a 显式 opts.kind 也能盖对 kind", fp3?.ok === true && fp3?.id?.kind === "lessons", JSON.stringify(fp3?.id));
  rm(mem);
}

console.log("\n═══ F-04b：INDEX.md / README.md 不算卡片；多级目录要支持 ═══");
{
  const base = { memoryBase: path.join(os.tmpdir(), "g362-f04b"), decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals" };
  const idx = fp.identityOfPath(base, path.join(base.memoryBase, "decisions", "INDEX.md"));
  const rdm = fp.identityOfPath(base, path.join(base.memoryBase, "decisions", "README.md"));
  const normal = fp.identityOfPath(base, path.join(base.memoryBase, "decisions", "D1.md"));
  console.log(`  INDEX=${JSON.stringify(idx)} README=${JSON.stringify(rdm)} D1=${JSON.stringify(normal)}`);
  ok("④b INDEX.md **不再**被当成卡片", idx === undefined, JSON.stringify(idx));
  ok("④b README.md **不再**被当成卡片", rdm === undefined, JSON.stringify(rdm));
  ok("④b 正常卡 D1.md **仍然**被认出来（不能一刀切封死）", normal !== undefined && normal.kind === "decisions", JSON.stringify(normal));

  const multi = { memoryBase: path.join(os.tmpdir(), "g362-f04b2"), decisionsDir: "custom/decisions-cards", lessonsDir: "lessons", goalsDir: "goals" };
  const m1 = fp.identityOfPath(multi, path.join(multi.memoryBase, "custom", "decisions-cards", "D1.md"));
  console.log("  多级目录 ⇒", JSON.stringify(m1));
  ok("④b 多级卡片目录**现在**认得出来", m1 !== undefined && m1.kind === "decisions", JSON.stringify(m1));
}

console.log("\n═══ F-06：反向验证沙箱写了 package.json ═══");
{
  const src = fs.readFileSync(path.join(ROOT, "tools", "_reverse-verify-d361.mjs"), "utf8");
  const hasPkg = src.includes('type: "module"') || src.includes('"type": "module"');
  console.log("  脚本里含 type: module 写入 =", hasPkg);
  ok("⑥ 沙箱写入 package.json（对老 Node 的加固）", hasPkg);
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
