#!/usr/bin/env node
/**
 * D365 专项核实：**F-06**（单文件 `LESSONS.md` / `GOALS.md` 的 rm / upsert 会
 * ① 被围栏里的伪标题截断 ② 删末条时吞掉 `[dsh-fp-link]:` 载体 ③ add 追加到载体之后）。
 *
 * ★ 报告给了行号，但**行号不是证据**（尺子错第 24 条：别按源码长什么样写判据）。
 *   这里直接**调那三个函数**，看文件**真的**变成什么样 —— 这才是"能不能用"的证据
 *   （全局规矩第二条：验证某东西能否工作，必须真让它工作）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let pass = 0;
let fail = 0;
const rows = [];
const ok = (title, cond, detail) => {
  if (cond) {
    pass += 1;
    rows.push(`PASS  ${title}${detail === undefined ? "" : ` — ${detail}`}`);
  } else {
    fail += 1;
    rows.push(`FAIL  ${title}${detail === undefined ? "" : ` — ${detail}`}`);
  }
};

const fp = await import("../lib/fingerprint.js");
const PID = "0123456789abcdef";

// ═══════════════════════════════════════════════════════════════════
// ① 围栏里的伪标题会不会把「删一条」变成「删半条」
// ═══════════════════════════════════════════════════════════════════
{
  // 造一份**带三载体指纹**的 LESSONS.md，其中 L1 正文里有一个 ``` 围栏，
  // 围栏里写着 `## 教训 L2 · 这是示例` —— 这正是报告说的"伪标题"。
  const body = [
    "# 经验与教训",
    "",
    "## 教训 L1 · 第一条",
    "",
    "- 根因: 示例",
    "",
    "````markdown",
    "## 教训 L2 · 这是围栏里的示例，不是真条目",
    "````",
    "",
    "## 教训 L2 · 真第二条",
    "",
    "- 根因: 第二条",
    "",
  ].join("\n");
  const sealed = fp.applyFingerprint3(body, { kind: "lessons", project: PID, key: "-" }).text;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d365-f06-"));
  const file = path.join(dir, "LESSONS.md");
  fs.writeFileSync(file, sealed, "utf8");

  // 用正则**模拟**报告里描述的旧实现（非贪婪 + 允许围栏里的伪标题当终点），
  // 看它到底会不会截断 —— 这是"旧实现会坏"的**实证**，不是引用报告的说法。
  const naive = /##\s*教训\sL1\s?·[\s\S]*?(?=\n##\s*教训\s|$)/;
  const m = naive.exec(sealed);
  const matched = m === null ? "" : m[0];
  const cutInsideFence = m !== null && !matched.includes("```") === false && !/````\s*$/m.test(matched);
  rows.push(
    `INFO  旧式非贪婪正则匹配到的片段末尾 = ${JSON.stringify(matched.slice(-60))}`,
  );
  // 判据：匹配片段**没有**包含整个围栏 ⇒ 说明它在围栏内部提前终止了
  const includesWholeFence = matched.includes("```") && (matched.match(/```/g) || []).length >= 2;
  ok(
    "① 旧式「非贪婪 + 不看围栏」的实现会在围栏内部提前截断（实证）",
    !includesWholeFence,
    `片段含围栏标记数=${(matched.match(/```/g) || []).length}（偶数=围栏完整）${cutInsideFence ? "" : ""}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
// ② 真调生产函数：删最后一条之后，指纹封条还在不在、能不能通过 verifySeal
// ═══════════════════════════════════════════════════════════════════
{
  const { defineLessonsTool } = await import("../lib/part2-tools.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d365-f06b-"));
  const mem = path.join(dir, "proj-ledger-memory");
  fs.mkdirSync(mem, { recursive: true });
  // ★★★ 夹具纪律（D286 连踩三次那条）：清单必须**完整可读**，否则生产函数会
  //   「读到清单但缺必填字段 ⇒ 什么都不写」直接拒 —— 那是**夹具故障**，
  //   上一版我漏了 `active` 就撞上了，而且差点把"夹具没跑通"读成"F-06 没修好"。
  fs.writeFileSync(
    path.join(mem, ".dsh-ledger.json"),
    JSON.stringify({ projectId: PID, active: "LEDGER.md", lessons: "LESSONS.md" }, null, 2) + "\n",
    "utf8",
  );
  const file = path.join(mem, "LESSONS.md");
  const body = [
    "# 经验与教训",
    "",
    "## 教训 L1 · 第一条",
    "",
    "- 根因: 根因一",
    "",
    "## 教训 L2 · 第二条",
    "",
    "- 根因: 根因二",
    "",
  ].join("\n");
  fs.writeFileSync(file, fp.applyFingerprint3(body, { kind: "lessons", project: PID, key: "-" }).text, "utf8");

  const before = fs.readFileSync(file, "utf8");
  ok("② 夹具自检：LESSONS.md 开局就带指纹", /dsh-fp-front:/.test(before), "");
  // ★ 夹具形状必须先看清楚（尺子错第 16 条：统计前先把一条原样 dump 出来）
  rows.push(`INFO  写盘后的 LESSONS.md 前 240 字 = ${JSON.stringify(before.slice(0, 240))}`);

  // ★★★ 真调生产函数（不是静态核）—— 全局规矩第二条：验证能否工作，必须真让它工作。
  //   工具对象形如 `{ name, description, parameters, execute(args, exec) }`。
  const tool = defineLessonsTool();
  const exec = { agent: undefined }; // 单文件模式走 rootFromExec(root)，这里显式给 root
  const rmRes = await tool.execute({ op: "rm", id: "L2", root: mem, projectRoot: mem }, exec);

  const after = fs.readFileSync(file, "utf8");
  const remainsLink = after.includes("[dsh-fp-link]:");
  // ★★★ 判据纪律：`l2Gone` 必须**量"删掉了"**，而不是"没读到"。
  //   上一版我写成 `!/##教训 L2 · 真第二条/.test(after)` —— 当 fixture 名与正文措辞
  //   对不上时它会**恒为 true**（尺子错第 20 条：参数/判据写错 ⇒ 断言永远全绿）。
  //   ⇒ 改成：先确认**删之前确实有** L2 那一行，再看删之后确实没有。
  const l2Before = /^##\s*教训\sL2\b/m.test(before);
  const l2After = /^##\s*教训\sL2\b/m.test(after);
  const l2Gone = l2Before && !l2After;
  const l1Kept = /^##\s*教训\sL1\b/m.test(after);

  // ★ 关键：**先把删除真做成**，再做后面的断言。做不成 ⇒ 如实报"没测到"，不许写 PASS。
  ok(
    "② 夹具自检：rm L2 真的执行成功（否则下面两条无意义）",
    rmRes?.ok === true && l2Gone,
    `rmRes=${JSON.stringify(rmRes)?.slice(0, 160)}；删前有 L2=${l2Before}；删后还有 L2=${l2After}；L2 已消失=${l2Gone}`,
  );
  ok(
    "② 删除条目后 L1 那条完整保留",
    l1Kept,
    `含 L1? ${l1Kept}`,
  );
  ok(
    "② 删除末条后 `[dsh-fp-link]:` 载体仍在（否则 verifySeal 必然失败）",
    remainsLink,
    `含 dsh-fp-link? ${remainsLink}`,
  );
  // ★ 最终判据：整个文件**仍然是一个指纹完好、内容未被改坏**的文件
  const p3 = fp.readFingerprint3(after, { root: mem });
  const vs = fp.verifySeal(after, p3);
  ok(
    "② 删除后文件指纹仍然有效、seal 仍然对得上（F-06②的实质）",
    p3.ok === true && vs.ok === true,
    `read.ok=${p3.ok} verifySeal=${JSON.stringify(vs)} reason=${String(p3.reason || "").slice(0, 90)}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
// ③ 静态核：补丁是否真的把围栏感知的切片函数接进了三条路径
// ═══════════════════════════════════════════════════════════════════
{
  const p2 = fs.readFileSync(path.join(ROOT, "lib", "part2.js"), "utf8");
  const p2t = fs.readFileSync(path.join(ROOT, "lib", "part2-tools.js"), "utf8");
  const hasSplice = /export function spliceSingleFileEntry/.test(p2);
  ok("③ part2.js 里存在 spliceSingleFileEntry（围栏+指纹感知的切片替换）", hasSplice, "");
  const usedInP2 = (p2.match(/spliceSingleFileEntry\s*\(/g) || []).length;
  const usedInP2t = (p2t.match(/spliceSingleFileEntry\s*\(/g) || []).length;
  ok(
    "③ 它真的被接进了生产路径（part2.js / part2-tools.js 里都有调用）",
    usedInP2 >= 2 && usedInP2t >= 1,
    `part2.js 调用 ${usedInP2} 次（含定义 1 次）· part2-tools.js 调用 ${usedInP2t} 次`,
  );
}

console.log(rows.join("\n"));
console.log("─".repeat(72));
console.log(`合计：PASS ${pass} · FAIL ${fail}`);
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
