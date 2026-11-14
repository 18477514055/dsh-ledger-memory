#!/usr/bin/env node
/**
 * D365 专项：核 019 补丁改过的**剥离线**（`applyFingerprint3` 的围栏感知 + 行尾空白处理）。
 *
 * 这里量三类东西，**分开报**，因为它们性质完全不同：
 *
 *   【A】**补丁修好的正向能力** —— 必须绿（否则等于没修）
 *   【B】**补丁引入的回归** —— 必须绿；这一轮实测抓到一个真的（见下）
 *   【C】★ **已知、记录在案、本轮不修的老缺陷** —— 明确标成 `KNOWN`，既不算绿也不算回归
 *
 * ★★★ 为什么要单独分一个 `KNOWN` 档（这是本文件存在的最大理由）：
 *   把已知老缺陷混进 FAIL ⇒ 下一轮的人分不清"补丁坏了"还是"本来就这样"；
 *   把它们直接删掉或写成 PASS ⇒ **那是自欺**（纪律 21「断言也会过期」的反面）。
 *   所以：**报出来、标清楚、给指针、不让它污染退出码。**
 *
 * ── 【B】补丁引入的回归（已修）────────────────────────────────────────
 *   🔴 现象：首行带行尾空格（`"第一行  \n第二行"`）的文件，写入后 `verifySeal` 报
 *     「内容校验位不符（存 0385777c，实 61f8655a）⇒ **正文被改过**」
 *     —— **一次正常写入被当成"文件被外部改坏"**，这是最坏的一种假警报。
 *   ★ 根因：补丁去掉了无差别的 `l.replace(/\s+$/, "")`（对），但插信标那条
 *     `lines[i] = ${lines[i].replace(/\s+$/, "")} <!--dsh-id:…-->` **仍然先清行尾**，
 *     而 seal 是在清之前算的 ⇒ 两条路径对不上。
 *   ★ 修法：信标插在**行尾空白之前**（`内容 + " " + 信标 + 原行尾空白`），
 *     剥离侧只摘「一个空格 + 信标」，不再额外清行尾 ⇒ 逐字可逆。
 *
 * ── 【C】已知老缺陷（`src` 末尾换行会被吃掉）─────────────────────────
 *   ★ 位置：`lib/fingerprint.js` 末尾那行 `s.replace(/^\n+/, "").replace(/\s+$/, "")`
 *   ★ 影响：带尾换行的文件 strip 后少一个 `\n`；文件末尾的双空格硬换行会丢。
 *   ★ 为什么本轮**不**顺手修（已实测确认，不是偷懒）：
 *     ① 写入侧把"原文末尾有没有换行"这个信息**归一化掉了** ⇒ strip 侧**无法区分**
 *        `"…第二行"` 与 `"…第二行\n"` 写出来的文件是**逐字节相同**的。⇒ 逐字还原在
 *        当前写入格式下**在数学上不可能**，必须先改写入格式；
 *     ② 而改 seal 的计算口径 ⇒ **全库现有指纹的 seal 会集体失效**，
 *        `verifySeal` 会对整个记忆库误报「正文被改过」⇒ 必须配迁移方案。
 *   ⇒ 已记入 `decisions/D364.md`（"单独开一轮"）与 `D365`，**不是被遗忘**。
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const fp = await import("../lib/fingerprint.js");

let pass = 0;
let fail = 0;
let known = 0;
const rows = [];

function ok(tag, title, cond, detail) {
  if (cond) {
    pass += 1;
    rows.push(`PASS   [${tag}] ${title}${detail === undefined ? "" : ` — ${detail}`}`);
  } else {
    fail += 1;
    rows.push(`FAIL   [${tag}] ${title}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}
/** 已知老缺陷：**如实报**，但不计入 FAIL（未修是既定事实，不是本轮回归）。 */
function knownFail(tag, title, condIfFixed, detail) {
  if (condIfFixed) {
    // 万一哪天真的修好了 —— 也要报出来，否则这条 KNOWN 会变成"永远正确"的死判据
    pass += 1;
    rows.push(`PASS   [${tag}] ${title} — ★ 已知缺陷**已被修掉**，请把这条从 KNOWN 移到 PASS`);
    return;
  }
  known += 1;
  rows.push(`KNOWN  [${tag}] ${title} — ${detail}`);
}

const id = { kind: "custom", key: "笔记.txt", project: "abcdef0123456789" };

// ═══════════════════════════════════════════════════════════════════
// 【A】补丁声称修好的能力
// ═══════════════════════════════════════════════════════════════════

// A1 正文双空格硬换行：加指纹后必须仍在
{
  const src = "第一行  \n第二行  \n第三行\n";
  const withFp = fp.applyFingerprint3(src, id).text;
  const kept = withFp.split("\n").filter((l) => l.endsWith("  ")).length;
  ok("A", "加指纹后正文双空格硬换行仍在（F-05b 正向面）", kept === 2, `保留 ${kept} 行（期望 2）`);
}

// A2 代码围栏内的示例载体：既不被剥掉，strip 后也可逆
{
  const src =
    "正文\n\n```markdown\n[dsh-fp-link]: dsh-ledger-fp v=1 kind=custom project=deadbeefdeadbeef key=x check=00000000 seal=00000000\n```\n\n结尾\n";
  const withFp = fp.applyFingerprint3(src, id).text;
  ok(
    "A",
    "代码围栏内的示例载体不被剥掉（F-05b 正向面）",
    withFp.includes("[dsh-fp-link]: dsh-ledger-fp v=1 kind=custom project=deadbeefdeadbeef"),
    "",
  );
  const back = fp.applyFingerprint3(withFp, id, { strip: true }).text;
  // ★ 该夹具以 \n 结尾 ⇒ 落在【C】那条已知缺陷上，所以这里只比对**去掉尾部换行**后的相等性，
  //   把"围栏内容没被吃"与"尾换行被吃"这两件事分开判（否则一条断言同时测两件事，红了说不清是谁）。
  const norm = (x) => x.replace(/\s+$/, "");
  ok(
    "A",
    "代码围栏内容 strip 后可逆（与尾换行无关的那部分）",
    norm(back) === norm(src),
    `剥回=${JSON.stringify(norm(back).slice(-40))}`,
  );
}

// A3 旧版 HTML 注释损坏必须进 corrupt
{
  const bad = "# 标题\n\n<!-- dsh-ledger-fp: 这不是合法载荷 -->\n正文\n";
  const r = fp.readFingerprint3(bad, { root: ROOT });
  ok(
    "A",
    "损坏的旧版 <!-- dsh-ledger-fp: --> 必须记入 corrupt（F-05c①）",
    Array.isArray(r.corrupt) && r.corrupt.includes("legacy"),
    `corrupt=${JSON.stringify(r.corrupt || null)}`,
  );
}

// ═══════════════════════════════════════════════════════════════════
// 【B】补丁引入的回归（已修，必须持续绿）
// ═══════════════════════════════════════════════════════════════════
for (const [label, src] of [
  ["首行带双空格", "第一行  \n第二行\n"],
  ["首行带单尾空格", "第一行 \n第二行\n"],
  ["首行正常", "第一行\n第二行\n"],
  ["首行带 tab", "第一行\t\n第二行\n"],
]) {
  const w = fp.applyFingerprint3(src, id).text;
  const r = fp.readFingerprint3(w, { root: ROOT });
  const vs = fp.verifySeal(w, r);
  ok(
    "B",
    `写入后 verifySeal 不得误报「正文被改过」（${label}）`,
    r.ok === true && vs.ok === true,
    `read.ok=${r.ok} verifySeal=${JSON.stringify(vs)}`,
  );
  const back = fp.applyFingerprint3(w, id, { strip: true }).text;
  ok(
    "B",
    `首行的行尾空白必须逐字还原（${label}）`,
    back.split("\n")[0] === src.split("\n")[0],
    `原文首行=${JSON.stringify(src.split("\n")[0])} 剥回=${JSON.stringify(back.split("\n")[0])}`,
  );
}

// 双空格不在首行时（补丁之前的那条也能过，用来确认没被顺手改坏）
{
  const src = "第一行\n第二行  \n第三行\n";
  const w = fp.applyFingerprint3(src, id).text;
  const r = fp.readFingerprint3(w, { root: ROOT });
  ok("B", "非首行的双空格硬换行不触发 seal 误报", fp.verifySeal(w, r).ok === true, "");
}

// 幂等（补丁前后都必须成立；D364 我在这一条上栽过一次）
{
  const src = "## 标题\n\n正文  \n带尾换行\n";
  const once = fp.applyFingerprint3(src, id).text;
  const twice = fp.applyFingerprint3(once, id).text;
  ok("B", "加指纹幂等（第二次逐字节相同）", once === twice, `长度 ${once.length} → ${twice.length}`);
  const a = fp.readFingerprint3(once, { root: ROOT });
  const b = fp.readFingerprint3(twice, { root: ROOT });
  ok(
    "B",
    "幂等后 seal 仍然有效且不变",
    a.ok === true && b.ok === true && a.seal === b.seal,
    `seal1=${a.seal} seal2=${b.seal}`,
  );
}

// ═══════════════════════════════════════════════════════════════════
// 【C】已知老缺陷（记录在案，本轮不修 —— 见文件头）
// ═══════════════════════════════════════════════════════════════════
{
  const src = "第一行笔记\n第二行\n";
  const w = fp.applyFingerprint3(src, id).text;
  const back = fp.applyFingerprint3(w, id, { strip: true }).text;
  knownFail(
    "C",
    "strip 逐字还原带尾换行的原文",
    back === src,
    `原文=${JSON.stringify(src)} 剥回=${JSON.stringify(back)}（少一个 \\n；根因：写入侧归一化了尾换行，见文件头【C】）`,
  );
}
{
  const src = "第一行  \n第二行  ";
  const w = fp.applyFingerprint3(src, id).text;
  const back = fp.applyFingerprint3(w, id, { strip: true }).text;
  knownFail(
    "C",
    "strip 逐字还原「文件末尾的双空格」",
    back === src,
    `原文=${JSON.stringify(src)} 剥回=${JSON.stringify(back)}（文件末尾的尾空白不可逆）`,
  );
}
{
  const src = "";
  const w = fp.applyFingerprint3(src, id).text;
  const okEmpty = w.length > 0;
  ok("C", "空文件也能加指纹（不崩）", okEmpty, `写出 ${w.length} 字节`);
}

console.log(rows.join("\n"));
console.log("─".repeat(72));
console.log(`合计：PASS ${pass} · FAIL ${fail} · KNOWN ${known}（KNOWN = 已记录在案的老缺陷，不计入失败）`);
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
