/**
 * _probe-d320-f03-f05.mjs —— D320：Gemini 审查 004 的 F-03 与 F-05 回归守卫
 *
 * F-03：`inspect()` 的边界预检原来**只覆盖 3 个卡片目录**，其余 10 个清单路径裸放行
 *        ⇒ ① `archiveDir: "../outside"` 时 `unsafePaths` 是 undefined（合规第 ⑫ 项看不出来）
 *           ② 入口不置 undefined ⇒ 下游各查各的，漏一处就真越界写
 * F-05：`readManifest` 对「文件不存在」与「文件坏了」一律返回 undefined
 *        ⇒ 一个被手改坏的 V3 清单被当成"从没建过台账" ⇒ 丢掉 memoryRoot ⇒ **静默降级 V2**
 *        ⇒ `refuseIfMemoryRootUnsafe` 整条失效 ⇒ 写进**源码根**
 *
 * ★ 每条都要能"摘掉修复就变红"，见 `_reverse-verify-d320.mjs`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve("lib");
const P2 = await import(pathToFileURL(path.join(ROOT, "part2.js")).href);
const BASE = await import(pathToFileURL(path.join(ROOT, "base.js")).href);
const V3 = await import(pathToFileURL(path.join(ROOT, "v3-conformance.js")).href);

const results = [];
const ok = (c, label, detail) => results.push({ c, label, detail });
const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `d320-${t}-`));

// ═══ F-03：10 个字段全部经过预检 ═══
{
  // 造一个"清单里 8 个路径都写 ../outside"的项目
  const root = tmp("f03");
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify({
      active: "../esc/LEDGER.md",
      decisions: "../esc/DECISIONS.md",
      principles: "../esc/PRINCIPLES.md",
      goals: "../esc/GOALS.md",
      journal: "../esc/JOURNAL.md",
      lessons: "../esc/LESSONS.md",
      archiveDir: "../esc/_ledger-archive",
      logDir: "../esc/_ledger-log",
      notesDir: "../esc/notes",
      handoffDir: "../esc/handoff",
    }),
    "utf8"
  );
  const info = P2.inspect(root);
  const unsafe = Array.isArray(info.unsafePaths) ? info.unsafePaths : [];
  const fields = unsafe.map((u) => u.field);
  // ★★★ 2026-10-25（D320）：**这里必须列全 8 个字段**。
  //   🔴 第一版只列了 6 个（漏了 principles 和 goals），而反向验证当场抓到：
  //     把 `principlesRel` 退回裸透传，探针**照样全绿** —— 因为根本没断言它。
  //   ★ 判据：**"我修了 N 处"就要有 N 条断言** —— 少一条，那一处就是没有守卫的。
  //     （这与本项目那条老病同型：覆盖不全的探针会给出"全部修好"的假证据。）
  for (const want of [
    "active",
    "decisions",
    "principles",
    "goals",
    "journal",
    "lessons",
    "archiveDir",
    "logDir",
    "notesDir",
    "handoffDir",
  ]) {
    ok(fields.includes(want), `F-03 越界的 \`${want}\` 被记进 unsafePaths`, fields.join(",") || "(空)");
  }
  // ★★ `notesDir` / `handoffDir` **不在这个夹具里断言** ——
  //   它们有前置条件（`notesDir` 只在"不是 git 仓库"时才解析；`handoffDir` 要先有 handoff 目录），
  //   在上面的临时目录里根本走不到 `gateRel`。**在够不到的地方断言，只会得到一条恒假或恒真的记录。**
  //   ⇒ 改为**静态断言**：确认这两个字段**确实套了 gateRel**（下面单列），行为正确性由上面 8 条覆盖。
  // 且它们**都降级成 undefined**（不许原样放行）
  ok(info.activeRel === undefined, "F-03 越界的 activeRel 被降级为 undefined", String(info.activeRel));
  ok(info.archiveRel === undefined, "F-03 越界的 archiveRel 被降级为 undefined", String(info.archiveRel));
  ok(info.logRel === undefined, "F-03 越界的 logRel 被降级为 undefined", String(info.logRel));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // 正常项目：不该产生任何 unsafePaths（不能因为加了预检就误伤）
  const root = tmp("f03ok");
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify({ active: "LEDGER.md", archiveDir: "_ledger-archive", logDir: "_ledger-log" }),
    "utf8"
  );
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
  const info = P2.inspect(root);
  ok(info.unsafePaths === undefined, "F-03 正常项目**没有** unsafePaths（不误伤）", JSON.stringify(info.unsafePaths));
  ok(info.activeRel === "LEDGER.md", "F-03 正常项目的 activeRel 原样保留", String(info.activeRel));
  ok(info.archiveRel === "_ledger-archive", "F-03 正常项目的 archiveRel 原样保留", String(info.archiveRel));
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══ F-05：坏档必须与"没有清单"分开 ═══
{
  // A. 真的没有清单 ⇒ ok:true, broken:false
  const root = tmp("f05none");
  const r = V3.readManifestDetailed(root, ".dsh-ledger.json");
  ok(r.ok === true && r.manifest === undefined && r.broken === false, "F-05 无清单 ⇒ ok:true/broken:false（唯一允许'猜'）", JSON.stringify(r));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // B. JSON 语法坏 ⇒ broken:true
  const root = tmp("f05bad");
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), '{ "active": "LEDGER.md", }', "utf8");
  const r = V3.readManifestDetailed(root, ".dsh-ledger.json");
  ok(r.ok === false && r.broken === true, "F-05 JSON 语法坏 ⇒ broken:true", JSON.stringify(r).slice(0, 120));
  ok(/JSON/.test(String(r.why)), "F-05 坏档原因里说清了是 JSON 解析失败", String(r.why).slice(0, 60));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // C. 缺 active ⇒ broken:true 且原因指名 active
  const root = tmp("f05noactive");
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify({ memoryRoot: "mem" }), "utf8");
  const r = V3.readManifestDetailed(root, ".dsh-ledger.json");
  ok(r.ok === false && r.broken === true, "F-05 缺 active ⇒ broken:true", JSON.stringify(r).slice(0, 100));
  ok(/active/.test(String(r.why)), "F-05 原因里点名缺 `active`", String(r.why));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // D. 坏档 ⇒ inspect 标记出来 + refuseIfMemoryRootUnsafe **拒绝写**
  const root = tmp("f05refuse");
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), '{ "active": "LEDGER.md", }', "utf8");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
  const info = P2.inspect(root);
  ok(info.manifestBroken !== undefined, "F-05 inspect 回了 manifestBroken", JSON.stringify(info.manifestBroken || null).slice(0, 90));
  const unsafe = Array.isArray(info.unsafePaths) ? info.unsafePaths : [];
  ok(unsafe.some((u) => u.field === "manifest"), "F-05 manifest 也进了 unsafePaths", unsafe.map((u) => u.field).join(","));
  const guard = BASE.refuseIfMemoryRootUnsafe(info);
  ok(guard !== undefined && guard.ok === false, "F-05 ★ 坏档时 refuseIfMemoryRootUnsafe **拒绝写入**（这是关键）", guard ? "拒绝了" : "🔴 放行了");
  ok(/dsh-ledger\.json/.test(String(guard && guard.reason)), "F-05 拒绝理由里点名了清单文件", String(guard && guard.reason).slice(0, 50));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // E. 正常清单 ⇒ guard 放行（别把正常项目也拦住）
  const root = tmp("f05ok");
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify({ active: "LEDGER.md" }), "utf8");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
  const guard = BASE.refuseIfMemoryRootUnsafe(P2.inspect(root));
  ok(guard === undefined, "F-05 正常清单 ⇒ guard 放行（不误伤）", guard ? "🔴 被拦了" : "放行");
  fs.rmSync(root, { recursive: true, force: true });
}

let pass = 0;
let fail = 0;
for (const r of results) {
  console.log(`  ${r.c ? "PASS" : "FAIL"}  ${r.label}  —— ${r.detail}`);
  if (r.c) pass++;
  else fail++;
}
console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail ? 1 : 0);
