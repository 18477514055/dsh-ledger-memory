#!/usr/bin/env node
/**
 * D372 取证器：逐条核实 `docs/3.8flash实地跑/003.md` 的发现项（F-01 ~ F-06；F-07 是"设计分析"不是缺陷）。
 *
 * ★★★ 断言一律写成「**缺陷不应该存在**」⇒ 跑在**未修**代码上会 FAIL，跑在**已修**代码上才全绿。
 *   基线红数必须写进决策卡。
 *
 * ★★★★ 报告自身的编号是乱的（必须记下来，别照抄）：
 *   §三汇总表：F-01 扩展写卡空格崩溃 · F-02 行内反引号 · F-03 祖先重复遍历 ·
 *              F-04 writePrinciples 漏回显 backup · F-05 resolveByIdentity 漏判损坏 · F-06 scanBlind 入参防御
 *   §五守卫注释：131⑩ 标成 "F-05 writePrinciples 回显"（实为 F-04）、
 *              131⑪ 标成 "F-06/F-07 scanBlind/scanFingerprints"（实为 F-06 + F-05）。
 *   ⇒ 本探针**按 §三 的汇总表编号**，并在每条标题里注明它测的是什么行为（不信它的编号）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
const rows = [];
const ok = (title, cond, detail) => {
  if (cond) { pass += 1; rows.push(`PASS  ${title}${detail === undefined ? "" : ` — ${String(detail).slice(0, 200)}`}`); }
  else { fail += 1; rows.push(`FAIL  ${title}${detail === undefined ? "" : ` — ${String(detail).slice(0, 200)}`}`); }
};
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), tag));

const fp = await import("../lib/fingerprint.js");
const part2 = await import("../lib/part2.js");
const part8 = await import("../lib/part8.js");
const initTool = await import("../lib/init-tool.js");

const PID = "0123456789abcdef";
const execFor = (root, sid = "s-d372") => ({ agent: { session: { header: { id: sid, cwd: root } } } });

/** 用真入口 init 一遍，拿到带 memoryRoot 的 V3 结构。 */
async function initV3(root, sid) {
  await initTool.defineInitTool().execute(
    { root, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", layout: "v3" },
    execFor(root, sid),
  );
  const memDir = fs.readdirSync(root).find((f) => f.endsWith("-ledger-memory"));
  return { memDir, memAbs: memDir === undefined ? undefined : path.join(root, memDir) };
}

// ═══════════════════════════════════════════════════════════════════
// F-01（P1）扩展写卡路径含空格 ⇒ applyFingerprint3 抛 "key 非法" + key 基准分叉
// ═══════════════════════════════════════════════════════════════════
{
  // ★★★ 判据要点：目录名里**必须有空格**，否则 keyIsSafe 不会拦、缺陷根本不暴露。
  const root = tmp("space test dir-");
  try {
    const { memDir } = await initV3(root, "s-d372-f01");

    // F-01-1 单文件扩展：创建模板 + 写入都不许崩
    let c1;
    let threw1;
    try {
      c1 = part8.createExtension(null, root, { name: "space ext", description: "d", mode: "plain" });
    } catch (e) { threw1 = String(e?.message ?? e); }
    ok("F-01a 路径含空格时 createExtension(单文件) 不抛异常", threw1 === undefined, threw1 ?? JSON.stringify(c1?.created));

    if (c1?.created?.id !== undefined) {
      let threw2;
      let w2;
      try { w2 = part8.writeExtension(null, root, c1.created.id, { content: "# 新内容\n正文\n" }); }
      catch (e) { threw2 = String(e?.message ?? e); }
      ok("F-01b 路径含空格时 writeExtension(单文件) 不抛 key 非法异常", threw2 === undefined, threw2 ?? JSON.stringify(w2));
    } else {
      ok("F-01b 路径含空格时 writeExtension(单文件) 不抛 key 非法异常", false, "夹具没建出扩展 id ⇒ 无法测（不是 PASS）");
    }

    // F-01-2 卡片型扩展：这是报告点名的崩溃点
    let c2;
    let threw3;
    try {
      c2 = part8.createExtension(null, root, { name: "card ext", description: "d", mode: "decisions" });
    } catch (e) { threw3 = String(e?.message ?? e); }

    if (c2?.created?.id !== undefined) {
      let threw4;
      let w4;
      try { w4 = part8.writeExtension(null, root, c2.created.id, { key: "D1", content: "## D1 · 卡片一\n\n正文\n" }); }
      catch (e) { threw4 = String(e?.message ?? e); }
      ok("F-01c 路径含空格时 writeExtension(卡片) 不抛 key 非法异常", threw4 === undefined, threw4 ?? JSON.stringify(w4));

      // F-01-3 ★★★ 判据加强（第一版是弱代理）：不要只断言"以 extensions/ 开头"，
      //   报告的原话是 **"key 与 identityOfPath 口径分叉"** ⇒ 真正该问的是：
      //   `identityOfPath(info, 卡片绝对路径)` 算出来的 key，与**写进去的** key 是否一致。
      const cardAbs = path.join(memDir === undefined ? root : path.join(root, memDir), "extensions", c2.created.id, "cards", "D1.md");
      let keyShown = "（文件不存在）";
      let aligned = false;
      if (fs.existsSync(cardAbs)) {
        const r3 = fp.readFingerprint3(fs.readFileSync(cardAbs, "utf8"));
        const wKey = String(r3.ok ? (r3.id?.key ?? "") : "");
        const info = part2.inspect(root);
        const dKey = String(fp.identityOfPath(info, cardAbs)?.key ?? "");
        keyShown = `写=${wKey} 推=${dKey}`;
        const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
        aligned = wKey !== "" && dKey !== "" && (wKey === dKey || dec(wKey) === dKey);
      }
      ok("F-01d 卡片指纹 key 与 identityOfPath 口径一致（不只是「以 extensions/ 开头」这个弱代理）", aligned === true, keyShown);
    } else {
      ok("F-01c 路径含空格时 writeExtension(卡片) 不抛 key 非法异常", false, threw3 ?? "夹具没建出卡片型扩展 ⇒ 无法测（不是 PASS）");
      ok("F-01d 卡片指纹 key 与 identityOfPath 口径一致（不只是「以 extensions/ 开头」这个弱代理）", false, "夹具没建出卡片型扩展 ⇒ 无法测（不是 PASS）");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════
// F-02（P2）stripFencedCodeForFp 漏排行内反引号 ⇒ 误判损坏 + applyFingerprint3 误删示例
// ═══════════════════════════════════════════════════════════════════
{
  const doc = "## 标题\n\n文档示例：`<!-- dsh-ledger-fp: example -->`\n\n正文。\n";

  // F-02-1 含行内反引号示例的文档不许被判成 legacy 损坏
  const r = fp.readFingerprint3(doc);
  const corrupts = Array.isArray(r.corrupt) ? r.corrupt : [];
  ok("F-02a 含行内反引号示例的文档不被判为 legacy 损坏", !corrupts.includes("legacy"), JSON.stringify({ ok: r.ok, corrupt: corrupts, reason: r.reason }));

  // F-02-2 盖章时不许把反引号里的示例文本吃掉
  const stamped = fp.applyFingerprint3(doc, { kind: "decisions", project: PID, key: "D999" }).text;
  ok("F-02b applyFingerprint3 保留行内反引号内的示例文本（不被清空成 ``）", stamped.includes("`<!-- dsh-ledger-fp: example -->`"), JSON.stringify(stamped.slice(0, 220)));

  // F-02-3 反向：**真正的**裸指纹注释仍必须被判为 legacy 损坏（放宽不能放宽掉这条）
  const realLegacy = `## 标题\n\n<!-- dsh-ledger-fp: decisions ${PID} D1 -->\n\n正文。\n`;
  const r2 = fp.readFingerprint3(realLegacy);
  const c2 = Array.isArray(r2.corrupt) ? r2.corrupt : [];
  ok("F-02c ★反向：裸（非反引号）指纹注释**仍然**被判为 legacy 损坏（放宽没放过头）", c2.includes("legacy"), JSON.stringify({ ok: r2.ok, corrupt: c2 }));

  // F-02-4 ★★★ 真机证据（报告点名的那个文件）：本项目 decisions/D351.md 第 41 行写了
  //   `形如 HTML 注释：\`<!-- dsh-ledger-fp: <类型> <短哈希> -->\``
  //   ⇒ 未修时它**真的**被判 legacy 损坏、并被 scanFingerprints 列进 bad 名单。
  //   ★ 这一条是本轮唯一"有实物证据"的断言（其余都是构造夹具）。
  const decDir = path.join(process.cwd(), "10.项目台账-ledger-memory", "decisions");
  const d351 = path.join(decDir, "D351.md");
  if (fs.existsSync(d351)) {
    const rr = fp.readFingerprint3(fs.readFileSync(d351, "utf8"));
    const cc = Array.isArray(rr.corrupt) ? rr.corrupt : [];
    ok("F-02d ★真机证据：decisions/D351.md（正文含行内反引号示例）不再被判 legacy 损坏", !cc.includes("legacy"), JSON.stringify({ corrupt: cc, reason: String(rr.reason ?? "").slice(0, 70) }));

    const scanMem = fp.scanFingerprints(path.join(process.cwd(), "10.项目台账-ledger-memory"), {});
    const d351Bad = (scanMem.bad ?? []).some((b) => String(b.rel ?? "").includes("D351.md"));
    ok("F-02e ★真机证据：整份记忆面扫描里 D351.md 不再出现在 bad 名单", d351Bad === false, JSON.stringify({ scanned: scanMem.scanned, bad: (scanMem.bad ?? []).length, unreadable: scanMem.unreadable }));
  } else {
    ok("F-02d ★真机证据：decisions/D351.md（正文含行内反引号示例）不再被判 legacy 损坏", false, "找不到 decisions/D351.md ⇒ 夹具前提不成立，不得判 PASS");
    ok("F-02e ★真机证据：整份记忆面扫描里 D351.md 不再出现在 bad 名单", false, "找不到 decisions/D351.md ⇒ 夹具前提不成立，不得判 PASS");
  }

  // ★★★★ F-02f（本轮自己发现的新风险，不是报告里写的）：
  //   `stripFencedCodeForFp` 现在把行内反引号**整段替换成等长空格**。
  //   它只被 `readFingerprint3` 用来"识别载体"，所以对「读」是安全的；
  //   但必须**证明它没影响写路径** —— 否则"重写一次文件"就会把正文里的 `代码` 变成空格。
  //   实测（`tools/_tmp-d372-strip-loss.mjs`）：strip 后行内代码逐字保留 ⇒ 这条守住了。
  const bodyWithInline = "# 标题\n\n运行 `npm.cmd test` 看结果，参数是 `--userconfig`。\n\n完。\n";
  const stampedBody = fp.applyFingerprint3(bodyWithInline, { kind: "decisions", project: PID, key: "D_INLINE" }).text;
  const strippedBack = fp.applyFingerprint3(stampedBody, undefined, { strip: true }).text;
  ok(
    "F-02f ★新风险：strip 路径（会被写回磁盘）不吞正文里的行内代码",
    strippedBack.includes("`npm.cmd test`") && strippedBack.includes("`--userconfig`"),
    JSON.stringify(strippedBack.slice(0, 140)),
  );
}

// ═══════════════════════════════════════════════════════════════════
// F-03（P2）locateProjectRoots 祖先重复遍历 ⇒ hits / scanned 虚高、maxFiles 早耗
// ═══════════════════════════════════════════════════════════════════
{
  const root = tmp("roots-");
  try {
    const sub = path.join(root, "p", "s");
    fs.mkdirSync(sub, { recursive: true });
    const body = fp.applyFingerprint3("# T\n", { kind: "decisions", project: PID, key: "D1" }).text;
    fs.writeFileSync(path.join(sub, "t.md"), body, "utf8");

    const res = fp.locateProjectRoots(sub, PID, { upLevels: 2 });
    const hits = Array.isArray(res?.roots) ? (res.roots[0]?.hits ?? -1) : -1;
    ok("F-03a 单一文件只被计 1 次命中（不许 ×(upLevels+1)）", hits === 1, JSON.stringify({ roots: res?.roots, scanned: res?.scanned }));
    ok("F-03b scanned 等于真实文件数 1", res?.scanned === 1, JSON.stringify({ scanned: res?.scanned }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════
// F-04（P3）writePrinciples 已经备份了，但回执里不回显 backup / backupFailed
// ═══════════════════════════════════════════════════════════════════
{
  const root = tmp("wp-");
  try {
    await initV3(root, "s-d372-f04");
    const first = part2.writePrinciples(root, { content: "# P\n- 原则一\n", authorizedBy: "user" });
    const second = part2.writePrinciples(root, { content: "# P\n- 原则二\n", mode: "append", authorizedBy: "user" });
    const hasField = second?.backup !== undefined || second?.backupFailed !== undefined;
    ok("F-04a writePrinciples 回执回显 backup / backupFailed（与 writeLedger / archiveLedger 同契约）", hasField === true, JSON.stringify({ first: first?.backup, second: second?.backup, secondFailed: second?.backupFailed, ok: second?.ok }));
    ok("F-04b writePrinciples 确实写进去了（回执 lines > 0，不是静默失败）", Number(second?.lines) > 0, JSON.stringify({ lines: second?.lines, ok: second?.ok, reason: second?.reason }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════
// F-05（P3）resolveByIdentity 按名解析漏判「损坏」⇒ 损坏载体被当老文件静默放行
//
// ★★★★★ 结论：**F-05 不可达 ⇒ 报告虚报**（本探针不写 PASS，单设 KNOWN 档）。
//   证据（三档对照实验 `tools/_tmp-d372-f05-reachability.mjs`，每档都真跑 resolveByIdentity）：
//     ① 现状（不一致 / 损坏 / 自证位 三条件都在）⇒ 拒绝
//     ② 只留「损坏」                                ⇒ 拒绝
//     ③ ★未修形状（补丁前只有 不一致 / 自证位）      ⇒ **拒绝** ← 未修代码本来就拦得住
//     ④ ★三条全删（造一个真洞）                      ⇒ 放行 ← 说明该位置确实是唯一守卫，
//                                                     但"损坏"这一类永远走不到这里
//   根因（可确定读到）：`readFingerprint3` 唯一的 corrupt reason 是
//     `载体格式损坏或身份自证位不符（...）`（fingerprint.js:533）—— **永远含「自证位」三个字**
//     ⇒ 旧判据 `includes("自证位")` 本来就把「损坏」整类拦住了。
//   ⇒ 补丁那行 `|| String(p3.reason).includes("损坏")` 是**冗余防御**（无害，但不是修复）。
//    ★ 判据（本轮立的）：**"报告说某处漏判" ≠ "那处真的能被走到"** ——
//      要证明可达，必须构造出**只靠旧判据拦不住**的输入；构造不出来就只能记 KNOWN。
// ═══════════════════════════════════════════════════════════════════
{
  const root = tmp("res-corrupt-");
  try {
    const bad = path.join(root, "bad.md");
    fs.writeFileSync(bad, "---\ndsh-fp-front: corrupt-not-a-real-fingerprint\n---\n# Bad\n\n正文\n", "utf8");

    let r;
    let threw;
    try { r = fp.resolveByIdentity(root, { name: "bad.md", kind: "decisions" }); }
    catch (e) { threw = String(e?.message ?? e); }
    // 这一条**修前修后都绿**，所以它不是"修复的证据"，只作为"现状没坏"的登记。
    ok("F-05（KNOWN·不计入修复证据）损坏载体不被按名解析静默放行 —— 修前修后都绿，因为「自证位」已覆盖", r?.ok !== true || threw !== undefined, threw ?? JSON.stringify({ ok: r?.ok, reason: String(r?.reason ?? "").slice(0, 80) }));

    // ★ 真正有区分力的那条：证明 **旧判据也拦得住**（即缺陷不可达）。
    const reasonAlwaysHasSelfProof = r?.ok === false && String(r?.reason).includes("自证位");
    ok("F-05b ★可达性判据：损坏类 reason 恒含「自证位」⇒ 旧判据本来就能拦住（F-05 不可达）", reasonAlwaysHasSelfProof === true, JSON.stringify({ ok: r?.ok, reason: String(r?.reason ?? "").slice(0, 90) }));

    // ★ 反向：真·无指纹老文件仍必须按名字认
    const plain = path.join(root, "plain.md");
    fs.writeFileSync(plain, "# 纯文本老文件\n\n没有指纹。\n", "utf8");
    const r3 = fp.resolveByIdentity(root, { name: "plain.md", kind: "decisions" });
    ok("F-05c ★反向：真·无指纹老文件仍按名字认（不许矫枉过正全拒）", r3?.ok === true, JSON.stringify({ ok: r3?.ok, reason: r3?.reason, how: r3?.how }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════
// F-06（P4）scanFingerprints / scanBlind 入参防御
// ═══════════════════════════════════════════════════════════════════
{
  // ★★★ 判据要点（继承 D370 F-07 的教训）：必须**同时**看「不抛」与「安全返回空」，
  //   否则被别的闸门顺带挡住也会看起来 PASS。
  // ★★★★★ 判据第二版（第一版假绿）：我第一版只断言 `scanned === 0` ⇒ 未修代码也 PASS。
  //   实测未修时：`{scanned:0, unreadable:1}` —— 它**不抛**，但把"入参非法"记成了
  //   "有一个目录读不出来"。报告的原话正是"增加 `unreadable` 计数"。
  //   ⇒ 真正该守的是 **`unreadable === 0`**：非法入参不该污染可读性指标。
  const safe = (fn, badVal, label) => {
    let threw;
    let res;
    try { res = fn(badVal); } catch (e) { threw = String(e?.message ?? e); }
    const okShape = res !== null && typeof res === "object" && Array.isArray(res.bad) && typeof res?.scanned === "number";
    ok(
      label,
      threw === undefined && okShape && res.scanned === 0 && res.unreadable === 0,
      threw ?? JSON.stringify({ scanned: res?.scanned, unreadable: res?.unreadable, bad: Array.isArray(res?.bad) ? res.bad.length : "非数组" }),
    );
  };

  safe(fp.scanFingerprints, undefined, "F-06a scanFingerprints(undefined) 不抛且安全返回 scanned=0");
  safe(fp.scanFingerprints, "", "F-06b scanFingerprints(\"\") 不抛且安全返回 scanned=0");
  safe(fp.scanBlind, undefined, "F-06c scanBlind(undefined) 不抛且安全返回 scanned=0");
  safe(fp.scanBlind, "", "F-06d scanBlind(\"\") 不抛且安全返回 scanned=0");

  // ★ 反向：合法目录仍必须真扫（防御不能变成"什么都不扫"）
  const root = tmp("scan-ok-");
  try {
    fs.writeFileSync(path.join(root, "a.md"), fp.applyFingerprint3("# A\n", { kind: "decisions", project: PID, key: "D1" }).text, "utf8");
    const r = fp.scanFingerprints(root, {});
    ok("F-06e ★反向：合法目录仍真扫描（scanned ≥ 1，防御没变成什么都不扫）", Number(r?.scanned) >= 1, JSON.stringify({ scanned: r?.scanned, bad: r?.bad?.length }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log(rows.join("\n"));
console.log("─".repeat(74));
console.log(`合计：PASS ${pass} · FAIL ${fail}`);
console.log("PROBE-COMPLETE");
process.exit(0);
