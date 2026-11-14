// _probe-d362-verify.mjs —— Gemini 018 六项**取证器**（断言「缺陷存在」）
//
// ★★ 这份是取证器，不是守卫：修好之后它应当**变红**。
//   守卫在 _probe-d362-fixed.mjs。合成一份 = 要么假绿要么永久红（D361 教训 #23）。
// ★ 每条都必须构造「不修就会漏」的输入，不能只看代码长什么样（D324 #22）。
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
const mk = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `d362-${t}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };
const PID = "0123456789abcdef";

console.log("═══ F-01：client.js ExtensionsPage 的 cur  TDZ ═══");
{
  const src = fs.readFileSync(path.join(ROOT, "lib", "client.js"), "utf8");
  const lines = src.split("\n");
  const ai = lines.findIndex((l) => l.includes("const send = useCallback("));
  const bi = lines.findIndex((l) => l.includes("const cur = projects.find"));
  console.log(`  send 起于第 ${ai + 1} 行；cur 声明在第 ${bi + 1} 行`);
  // 依赖数组：从 send 起往下找第一个以 "] " 或 "]," 结尾的依赖行
  let depEnd = -1, depLine = "";
  for (let i = ai; i < Math.min(ai + 40, lines.length); i++) {
    if (/^\s*\[[^\]]*\]\s*$/.test(lines[i]) && i > ai + 2) { depEnd = i; depLine = lines[i]; break; }
  }
  console.log(`  依赖数组在第 ${depEnd + 1} 行 ⇒ ${JSON.stringify(depLine.trim())}`);
  const depsBeforeCur = depEnd !== -1 && depEnd < bi;
  const hasCurDep = depLine.includes("cur");
  console.log(`  依赖数组出现在 cur 声明**之前** = ${depsBeforeCur}；且引用了 cur = ${hasCurDep}`);
  // 语义：useCallback 的依赖数组在渲染同步求值 ⇒ cur 在 TDZ ⇒ ReferenceError
  const body = lines.slice(ai, bi + 1).join("\n");
  const sendCbUsesCurInside = /cur\?\.root/.test(body);
  ok("① 缺陷存在：依赖数组在 cur 之前，且引用了 cur?.root", depsBeforeCur && hasCurDep, `depEnd=${depEnd + 1} curAt=${bi + 1}`);
  ok("① 且 send 回调体里也用了 cur?.root（说明不是笔误，是同一个变量）", sendCbUsesCurInside);
}

console.log("\n═══ F-02a：载体标记还在、载荷被改坏 ⇒ 是否被当「无指纹老文件」 ═══");
{
  const good = fp.applyFingerprint3("## D7 · 测试\n\n正文\n", { kind: "decisions", project: PID, key: "D7" });
  // ★ 构造要点：让**三处载体的载荷全部解析失败**，但**标记字面仍留在文件里**
  //   ① check 改成非十六进制 ⇒ frontmatter / link 的 PAYLOAD_RE 失败
  //   ② 行内信标整段删掉 ⇒ 不能靠它救回来（否则测不到"全坏"那条路）
  const broken = good.text.replace(/check=[0-9a-f]{8}/g, "check=zzzzzzzz").replace(/<!--dsh-id:[^>]*-->/g, "");
  const markersStillThere =
    broken.includes("dsh-fp-front:") && broken.includes("[dsh-fp-link]: dsh-ledger-fp");
  console.log("  三处载荷全坏，但标记字面还在 =", markersStillThere);
  const p3 = fp.readFingerprint3(broken);
  console.log("  改坏后 readFingerprint3 ⇒", JSON.stringify(p3)?.slice(0, 260));
  console.log("  原因 =", JSON.stringify(p3?.reason));
  const saysNoCarrier = String(p3?.reason ?? "").includes("三处载体都没有");
  const saysCorrupt = /损坏|改坏|自证位|格式/.test(String(p3?.reason ?? ""));
  ok("② 缺陷存在：标记还在但载荷坏 ⇒ 报「三处载体都没有」（不区分「没有」与「坏了」）",
    markersStillThere && p3?.ok !== true && saysNoCarrier && !saysCorrupt, p3?.reason);

  // 下游是否因此放行
  const mem = mk("f02a");
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(mem, "decisions", "D7.md"), broken, "utf8");
  const r = fp.resolveByIdentity(mem, { name: "decisions/D7.md", kind: "decisions", project: PID, key: "D7" });
  console.log("  resolveByIdentity ⇒", JSON.stringify(r)?.slice(0, 300));
  const scan = fp.scanBlind(mem, {});
  console.log(`  scanBlind: scanned=${scan.scanned} bad=${scan.bad?.length ?? 0}`);
  ok("② 缺陷存在：被改坏的文件**没有**被记进 bad（防伪不生效）", (scan.bad?.length ?? 0) === 0, JSON.stringify(scan.bad));
  ok("② 缺陷存在：按名解析把它当「无指纹老文件」放行", r?.ok === true, JSON.stringify(r)?.slice(0, 300));
  rm(mem);
}

console.log("\n═══ F-02b：仅行内信标的卡片 key 能否冒充单例 LEDGER.md ═══");
{
  const mem = mk("f02b");
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  // 一张只有行内信标的决策卡，内容被覆盖到 LEDGER.md
  fs.writeFileSync(path.join(mem, "LEDGER.md"), `## 教训 L1 · 甲 <!--dsh-id:${PID}:D195-->\n\n正文\n`, "utf8");
  const r = fp.resolveByIdentity(mem, { name: "LEDGER.md", kind: "active", project: PID, key: "" });
  console.log("  resolveByIdentity(LEDGER.md, key=\"\") ⇒", JSON.stringify(r)?.slice(0, 300));
  ok("②b 缺陷存在：卡片 key=D195 冒充了单例 LEDGER.md（key=\"\"）", r?.ok === true, JSON.stringify(r)?.slice(0, 300));
  rm(mem);
}

console.log("\n═══ F-02c：同目录有别的完整卡 ⇒ 仅剩行内信标的改名卡还能不能找回 ═══");
{
  const mem = mk("f02c");
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  // 另一张**完整**的卡
  const other = fp.applyFingerprint3("## D196 · 另一条\n\n正文\n", { kind: "decisions", project: PID, key: "D196" });
  fs.writeFileSync(path.join(mem, "decisions", "D196.md"), other.text, "utf8");
  // 目标卡：改名为 renamed-195.md，只剩行内信标
  fs.writeFileSync(path.join(mem, "decisions", "renamed-195.md"), `## D195 · 要找的 <!--dsh-id:${PID}:D195-->\n\n正文\n`, "utf8");

  const r = fp.resolveByIdentity(mem, { name: "decisions/D195.md", kind: "decisions", project: PID, key: "D195" });
  console.log("  resolveByIdentity ⇒", JSON.stringify(r)?.slice(0, 400));
  ok("②c 缺陷存在：因同目录有完整卡而短路，改名卡找不回", r?.ok !== true, JSON.stringify(r)?.slice(0, 400));
  rm(mem);
}

console.log("\n═══ F-03：4096 字节边界把 [dsh-fp-link] 劈成两半 ═══");
{
  const mem = mk("f03");
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  const good = fp.applyFingerprint3("## D9 · 边界\n\n正文\n", { kind: "decisions", project: PID, key: "D9" });
  const linkLine = good.text.split("\n").find((l) => l.startsWith("[dsh-fp-link]:"));
  console.log(`  link 载体行长度 = ${Buffer.byteLength(linkLine)} B`);
  // 构造：让 link 行恰好跨第 4096 字节
  // 文件 = 正文填充 + "\n" + linkLine + "\n"
  // 目标：linkLine 起始偏移 = 4096 - k (k=20，插入的 \n 会劈断它)
  const HALF = 20;
  const fillLen = 4096 - HALF;
  let body = "";
  while (Buffer.byteLength(body) < fillLen) body += "x";
  body = body.slice(0, fillLen);
  const text = body + "\n" + linkLine + "\n";
  const size = Buffer.byteLength(text);
  console.log(`  构造文件大小 = ${size} B；link 行起始于 ${fillLen + 1} B（跨 4096 边界）`);
  fs.writeFileSync(path.join(mem, "decisions", "D9.md"), text, "utf8");

  const scan = fp.scanBlind(mem, {});
  const keys = [...scan.byKind.values()].flat().map((x) => x.key);
  console.log("  scanBlind 扫到的 key ⇒", JSON.stringify(keys));
  ok("③ 缺陷存在：跨 4096 边界的 link 载体丢了（D9 认不出）", !keys.includes("D9"), JSON.stringify(keys));
  rm(mem);
}

console.log("\n═══ F-04a：自定义卡片目录写入时漏盖指纹 ═══");
{
  const mem = mk("f04a");
  const memName = `${path.basename(mem)}-ledger-memory`;
  const memo = path.join(mem, memName);
  fs.mkdirSync(path.join(memo, "custom-decisions"), { recursive: true });
  const mf = {
    version: 1, protocolVersion: 3, active: "LEDGER.md", archiveDir: "_arch",
    decisionsDir: "custom-decisions", maxActiveLines: 400, revision: 0, projectId: PID, memoryRoot: memName,
  };
  fs.writeFileSync(path.join(mem, ".dsh-ledger.json"), JSON.stringify(mf, null, 2), "utf8");
  fs.writeFileSync(path.join(memo, ".dsh-ledger.json"), JSON.stringify(mf, null, 2), "utf8");
  fs.writeFileSync(path.join(memo, "LEDGER.md"), "# 台账\n", "utf8");

  const cardOps = await import(LIB("card-ops.js"));
  // ★ 真签名是 (root, dirRel, key, text) —— 四参，没有 opts
  // ★★ 且 dirRel 是**相对项目根**（cardDirAbs = path.resolve(root, dirRel)），
  //    所以自定义目录要写成 `内存根/自定义目录`，不是光写叶名（上次就错在这）。
  const dirRel = `${memName}/custom-decisions`;
  const w = cardOps.writeCard(mem, dirRel, "D1", "## D1 · 自定义目录\n\n正文\n");
  console.log("  writeCard 回执 ⇒", JSON.stringify(w)?.slice(0, 260));
  const cardPath = path.join(memo, "custom-decisions", "D1.md");
  const exists = fs.existsSync(cardPath);
  const txt = exists ? fs.readFileSync(cardPath, "utf8") : "";
  const hasFp = txt.includes("dsh-fp-front") || txt.includes("dsh-fp-link") || txt.includes("dsh-id:");
  console.log(`  卡片应在 ${cardPath}`);
  console.log(`  存在=${exists} 有指纹=${hasFp}`);
  ok("④a 夹具走通：卡片真的写在内存根下的自定义目录里", exists, `ok=${w?.ok} path=${w?.path}`);
  ok("④a 缺陷存在：叶目录名不是 decisions/lessons/goals ⇒ **没有**指纹", exists && !hasFp, `exists=${exists} hasFp=${hasFp}`);

  // 对照组：标准目录名**有**指纹（证明差异来自"叶目录名反推 kind"这一条）
  const w2 = cardOps.writeCard(mem, `${memName}/decisions`, "D2", "## D2 · 标准目录\n\n正文\n");
  const p2 = path.join(memo, "decisions", "D2.md");
  const txt2 = fs.existsSync(p2) ? fs.readFileSync(p2, "utf8") : "";
  const hasFp2 = txt2.includes("dsh-fp-front");
  console.log(`  对照（标准目录 decisions/D2.md）⇒ 存在=${fs.existsSync(p2)} 有指纹=${hasFp2}`);
  ok("④a 对照：标准的 decisions 目录**有**指纹（差异只在叶名反推）", hasFp2, `ok=${w2?.ok}`);
  rm(mem);
}

console.log("\n═══ F-04b：INDEX.md 被误判为卡片 / 多级目录不支持 ═══");
{
  const base = { memoryBase: path.join(os.tmpdir(), "d362-f04b"), decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals" };
  const idx = fp.identityOfPath(base, path.join(base.memoryBase, "decisions", "INDEX.md"));
  const rdm = fp.identityOfPath(base, path.join(base.memoryBase, "decisions", "README.md"));
  console.log("  identityOfPath(decisions/INDEX.md) ⇒", JSON.stringify(idx));
  console.log("  identityOfPath(decisions/README.md) ⇒", JSON.stringify(rdm));
  ok("④b 缺陷存在：INDEX.md 被当成决策卡", idx !== undefined && String(idx?.key).toUpperCase() === "INDEX", JSON.stringify(idx));
  ok("④b 缺陷存在：README.md 被当成决策卡", rdm !== undefined, JSON.stringify(rdm));

  const multi = { memoryBase: path.join(os.tmpdir(), "d362-f04b2"), decisionsDir: "custom/decisions-cards", lessonsDir: "lessons", goalsDir: "goals" };
  const m1 = fp.identityOfPath(multi, path.join(multi.memoryBase, "custom", "decisions-cards", "D1.md"));
  console.log("  identityOfPath(多级目录 custom/decisions-cards/D1.md) ⇒", JSON.stringify(m1));
  ok("④b 缺陷存在：多级卡片目录认不出", m1 === undefined, JSON.stringify(m1));
}

console.log("\n═══ F-06：反向验证沙箱在 %TEMP% 下能否 import ESM ═══");
{
  console.log(`  本机 Node = ${process.version}`);
  const d = mk("f06");
  const dst = path.join(d, "lib");
  fs.cpSync(path.join(ROOT, "lib"), dst, { recursive: true });
  let err = null;
  try {
    await import(pathToFileURL(path.join(dst, "fingerprint.js")).href);
  } catch (e) {
    err = e;
  }
  console.log("  直接 import 临时目录里的 lib  ⇒", err === null ? "成功" : `${err.name}: ${String(err.message).slice(0, 140)}`);
  // ★★ 如实记：报告的 F-06 断言"必抛 SyntaxError"，**本机 Node 24 不复现**
  //   （Node ≥22 起默认开启模块语法自动探测，无 package.json 也能按 ESM 加载）
  ok("⑥ 报告的 F-06 **在本机不可复现**（Node 24 自动探测 ESM）", err === null, err?.message);
  ok("⑥ 但补 package.json 仍是**无害加固**（对老 Node 有用），值得一并接受", true);

  // 对照：补一个 package.json 也照样正常（证明加固不破坏现状）
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  let err2 = null;
  try {
    await import(pathToFileURL(path.join(dst, "fingerprint.js")).href + `?fix=${Date.now()}`);
  } catch (e) {
    err2 = e;
  }
  console.log("  补 package.json 后再 import ⇒", err2 === null ? "成功" : `${err2.name}: ${String(err2.message).slice(0, 140)}`);
  ok("⑥ 加固后不影响现状（补了 package.json 一样能加载）", err2 === null, err2?.message);
  rm(d);
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
console.log("PROBE-COMPLETE");
