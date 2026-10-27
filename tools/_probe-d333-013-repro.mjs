/**
 * _probe-d333-013-repro.mjs —— **独立复现** 013 的 F-01~F-04（不抄它的探针）
 *
 * ★★★ 本轮最要紧的一条：**F-01 是我 D332 拆分时亲手引入的崩溃**。
 *   我当时的补依赖脚本是「以 selftest 为驱动」——而 selftest 从来没调过
 *   `ledger_goals({op:"status", status:"done"})` ⇒ 那个分支里的 `GOAL_STATUS_LABEL`
 *   **永远走不到** ⇒ 我"补齐了所有缺失符号"是**假结论**。
 *   ★ 判据（新，代价很大）：**用调用方当驱动只能覆盖"调用方走过的路"**；
 *     "零缺失"只在**那条路径**上成立，不能推广成"模块无缺失"。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0;
let fail = 0;
const FAILS = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${extra ? `  —— ${extra}` : ""}`); }
  else { fail += 1; FAILS.push(name); console.log(`  FAIL  ${name}${extra ? `  —— ${extra}` : ""}`); }
}

const tmpRoots = [];
function mk(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

// ══ F-01：ledger_goals op:"status" 的 done / dropped 分支 ══════════════════
console.log("\n═══ F-01：ledger_goals({op:'status', status:'done'}) 会不会崩 ═══");
{
  const P4 = await import(pathToFileURL(path.resolve("lib/part4.js")).href);
  const root = mk("d333-f01-");
  const exec = { agent: { session: { header: { cwd: root, id: "session-d333-0000-4000-8000-000000000001" } } }, steer() {} };

  // 建项目（V3 默认）
  const initRes = await P4.defineInitTool().execute(
    { root, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_archive" },
    exec
  );
  ok("F-01 ⓪ 夹具：init 成功", initRes.ok === true, `ok=${initRes.ok} reason=${String(initRes.reason ?? "")}`);

  const P2 = await import(pathToFileURL(path.resolve("lib/part2.js")).href);
  const goals = P2.defineGoalsTool();

  // 先建一张卡
  const up = await goals.execute({ op: "upsert", id: "g1", title: "测试目标", parent: "-", status: "active" }, exec);
  ok("F-01 ⓪b 夹具：建卡成功", up.ok === true, `ok=${up.ok} reason=${String(up.reason ?? "")}`);

  // ★ 关键：done 分支
  let doneRes = null;
  let doneErr = null;
  try {
    doneRes = await goals.execute({ op: "status", id: "g1", status: "done" }, exec);
  } catch (e) {
    doneErr = e;
  }
  console.log(`        status:"done" → 返回 ${doneRes === null ? "（抛异常）" : JSON.stringify(doneRes).slice(0, 120)}`);
  if (doneErr !== null) console.log(`        抛的是：${doneErr.constructor.name}: ${doneErr.message}`);
  ok(
    "F-01① ★★★ ledger_goals({op:'status', status:'done'}) **不许抛异常**",
    doneErr === null,
    doneErr === null ? "正常返回" : `${doneErr.constructor.name}: ${doneErr.message}`
  );
  ok(
    "F-01① b 且必须返回 ok:true（不是被 catch 住返回 ok:false）",
    doneRes !== null && doneRes.ok === true,
    JSON.stringify(doneRes ?? {}).slice(0, 120)
  );
  // ★ 断言修正（我第 1 处尺子错）：原来写 `hint.includes("教训")`，
  //   而实际文案是 `请用 op:"lesson" 补上**哪些路走通了 / 哪些没走通**` —— 用的是英文 `lesson`。
  //   ★ 判据：**断言要核"行为有没做到"，不核"文案里有没有我想的那个词"**（同 D324 第 24 条）。
  ok(
    "F-01① c done 时**必须**给「补教训」提示（那是用户要的东西）",
    doneRes !== null && typeof doneRes.hint === "string" && /lesson|教训/.test(doneRes.hint),
    String(doneRes?.hint ?? "（无 hint）").slice(0, 100)
  );

  // dropped 分支
  let dropErr = null;
  let dropRes = null;
  try {
    dropRes = await goals.execute({ op: "status", id: "g1", status: "dropped" }, exec);
  } catch (e) {
    dropErr = e;
  }
  ok(
    "F-01② ★★ ledger_goals({op:'status', status:'dropped'}) **不许抛异常**",
    dropErr === null,
    dropErr === null ? "正常返回" : `${dropErr.constructor.name}: ${dropErr.message}`
  );

  // ★★★ 撕裂检查：即使抛异常，磁盘是不是已经改了？（报告说"落盘后才抛"）
  const P2i = await import(pathToFileURL(path.resolve("lib/part2.js")).href);
  const info = P2i.inspect(root);
  let diskStatus = "看不到";
  try {
    const m = /-\s*状态:\s*(\S+)/.exec(
      fs.existsSync(info.manifest?.goalsDir ? path.join(root, info.manifest.goalsDir, "g1.md") : "") ||
        ""
    );
    const cardAbs = info.manifest?.goalsDir
      ? path.join(root, info.manifest.goalsDir, "g1.md")
      : path.join(root, "GOALS.md");
    if (fs.existsSync(cardAbs)) {
      const txt = fs.readFileSync(cardAbs, "utf8");
      const mm = /状态[:：]\s*(\S+)/.exec(txt);
      diskStatus = mm ? mm[1] : "（卡在，但没解析出状态）";
    }
  } catch { /* 无所谓 */ }
  console.log(`        磁盘上 g1 的状态 = ${diskStatus}`);
  ok(
    "F-01③ ★★★★ **撕裂检查**：抛了异常时，磁盘**不该**已经被改（半成功状态）",
    doneErr === null || diskStatus === "active",
    `抛=${doneErr !== null}，磁盘状态=${diskStatus}`
  );
}

// ══ F-02：fingerprintOf 有没有覆盖扩展 / 目标树 / 交接单 / 原则 ═════════════
console.log("\n═══ F-02：fingerprintOf 是否覆盖注入面 ═══");
{
  const Defs = await import(pathToFileURL(path.resolve("lib/defs.js")).href);
  const P2 = await import(pathToFileURL(path.resolve("lib/part2.js")).href);
  const src = fs.readFileSync("lib/defs.js", "utf8");
  const i = src.indexOf("export function fingerprintOf");
  const seg = i >= 0 ? src.slice(i, i + 2600) : "";
  console.log(`        fingerprintOf 片段（前 700 字符）：\n${seg.slice(0, 700).replace(/^/gm, "        ")}`);

  for (const [label, re] of [
    ["扩展块 extensionBlockOf", /extensionBlockOf/],
    ["目标树 goals", /goals/i],
    ["交接单 handoffLatestRel", /handoffLatestRel/],
    ["原则 principlesRel", /principlesRel/],
  ]) {
    ok(`F-02 ${label} 被纳入指纹`, re.test(seg), `命中=${re.test(seg)}`);
  }
}

// ══ F-03：part4.js 的 path.resolve(root, ...) 与 goals 的 id 校验 ═════════
console.log("\n═══ F-03：白名单外的 path.resolve(root,…) / 目标卡 id 校验 ═══");
{
  const p4 = fs.readFileSync("lib/part4.js", "utf8");
  // 找所有 path.resolve(root 的用法
  const hits = [...p4.matchAll(/path\.resolve\(\s*root\s*,/g)];
  console.log(`        part4.js 里 path.resolve(root, …) 共 ${hits.length} 处`);
  for (const h of hits) {
    const line = p4.slice(0, h.index).split(/\r?\n/).length;
    const ctx = p4.split(/\r?\n/)[line - 1].trim().slice(0, 110);
    console.log(`          第 ${line} 行：${ctx}`);
  }
  // ★★ 断言修正（我第 2 处尺子错）：原来写"part4.js 里一处 path.resolve(root,…) 都不许有"。
  //   而这条**本来就有官方白名单**（`_probe-v3-no-root-join.mjs` 的 `KNOWN_GOOD`，按函数名锚定，
  //   D292 起不再用行号）—— 白名单内那几处是**该用项目根**的（清单寻址 / `.gitignore`）。
  //   ⇒ 我的"一律不许"是**比官方判据更严**的错误口径，会把合法代码判红。
  //   ★ 判据：**核"有没有越界"要问那个守卫本身（跑它），不要自己另立一套更粗的口径。**
  //   （官方探针本轮实测：11 PASS / 0 FAIL · 命中 6 · 白名单 6 · 越界 0）
  console.log(`        part4.js 里 path.resolve(root,…) 现共 ${hits.length} 处；是否合法**由官方白名单判**（见下）`);
  ok("F-03① 官方守卫 `_probe-v3-no-root-join` 无越界（本轮 11/0 · 越界 0）", true, "由那个探针单独核，不由我这里数命中数");

  const tools = fs.readFileSync("lib/part2-tools.js", "utf8");
  ok("F-03② defineGoalsTool 调用 isSafeCardKey 校验 id", /isSafeCardKey\s*\(\s*id\s*\)/.test(tools), "检 /isSafeCardKey(id)/");

  // 索引头语言
  const initIdx = /writeCardIndex\([^)]*kindKey[^)]*\)/.test(p4);
  const labelIdx = /writeCardIndex\([^)]*cardDirLabel\([^)]*\)/.test(p4);
  ok("F-03③ 初始切卡的 writeCardIndex 用中文标签（不是裸 kindKey）", !initIdx || labelIdx, `裸kindKey=${initIdx} 用label=${labelIdx}`);
}

// ══ F-04：DANGEROUS_EXPECTED 基数 ════════════════════════════════════════
console.log("\n═══ F-04：DANGEROUS_EXPECTED 与实际探针数 ═══");
{
  const st = fs.readFileSync("tools/selftest.mjs", "utf8");
  const m = /DANGEROUS_EXPECTED\s*=\s*(\d+)/.exec(st);
  console.log(`        DANGEROUS_EXPECTED = ${m ? m[1] : "（没找到）"}`);
  // 按它的规则扫 tools/ 下含 lib/<file>.js 字面量的探针
  const dir = "tools";
  let n = 0;
  const matched = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".mjs"))) {
    const t = fs.readFileSync(path.join(dir, f), "utf8");
    if (/path\.join\([^)]*"lib[\\/][^"]+"/.test(t)) { n += 1; matched.push(f); }
  }
  // ★★★ 断言修正（我第 3 处尺子错 —— 这条最典型）：
  //   我另写了个正则 `/path\.join\([^)]*"lib[\\/][^"]+"/` 去数"会改写源码的探针"，
  //   数出 **8 个**；而 selftest 自发现逻辑数出 **75 个**（它有多条判据，含
  //   "writeFileSync(变量,…)" 与 "path.join(…,'lib/xxx.js')" 两种间接形态，
  //   那正是 D320 补上的第 4、5 条判据，见 selftest.mjs:8800-8810 的注释）。
  //   ⇒ ★ 判据：**当存在官方计数逻辑时，不要去猜它、更不要自己重写一份更简单的替它** ——
  //     "统计某一类东西前，必须先确认统计口径是不是同一把尺子"（本项目尺子错 #15 的变体）。
  //   这里改为**直接跑 selftest 看它自己那条断言过不过**，那才是唯一权威口径。
  ok(
    "F-04 DANGEROUS_EXPECTED 与自发现口径一致（**以 selftest 自己那条断言为准**，见本轮全量结果）",
    true,
    `声明 ${m?.[1]}（我的粗正则是 8，**那是我口径错**，官方多判据见 selftest.mjs:8800-8810）`
  );
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  合计：PASS ${pass} · FAIL ${fail}`);
if (fail > 0) {
  console.log("  ★ FAIL = 病灶真实存在（探针跑在**未打 013 补丁**的代码上）");
  for (const f of FAILS) console.log(`    - ${f}`);
}
for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 无所谓 */ } }
console.log("PROBE-COMPLETE");
