/**
 * ★★★ 反向验证（纪律第 10 条）：**摘到能看见红为止**。
 * 针对 D170 修复（胶囊上限唯一出处 + 归档通道 + 盘上只增不减）。
 *
 * ★ 关键：每条"变异"都对应**一个**我声称有判别力的断言。
 *   若某条变异摘掉后**没红** ⇒ 那条断言其实是假的（不是修复冗余）。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const FILE = "lib/index.js";
const orig = fs.readFileSync(FILE, "utf8");
const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
console.log(`原文件 sha256(前16) = ${h(orig)}`);

const CASES = [
  {
    tag: "M1 把 consume 侧上限改回「写死常量」⇒ 面板调小/调大都失效",
    from: `          trimUserMessagesInPlace(r, capsuleUserMsgMaxOf());`,
    to: `          trimUserMessagesInPlace(r, CAPSULE_USER_MSG_MAX);`,
    expect: "69①",
  },
  {
    tag: "M2 把「截断必进归档」摘掉（只 slice，不收集）⇒ 无声消失复现",
    from: `  const evicted = r.userMessages.slice(cap);
  r.userMessages.length = cap;
  if (!Array.isArray(r.evictedUserMessages)) r.evictedUserMessages = [];
  r.evictedUserMessages.push(...evicted);
  return evicted.length;`,
    to: `  r.userMessages.length = cap;
  return 0;`,
    expect: "69②",
  },
  {
    tag: "M3 让 hydrate 侧不遵守设置（改回写死 40）⇒ 两侧又不同源",
    from: `      trimUserMessagesInPlace(live, capsuleUserMsgMaxOf());
      trimErrorsInPlace(live, capsuleErrorMaxOf());`,
    to: `      trimUserMessagesInPlace(live, CAPSULE_USER_MSG_MAX);
      trimErrorsInPlace(live, capsuleErrorMaxOf());`,
    expect: "69③b",
  },
  {
    tag: "M4 让存储侧也跟随设置 ⇒ 调小后盘上被砍（打穿「只增不减」）",
    from: `        userMessages: um.slice(0, CAPSULE_STORE_USER_HARD_MAX),`,
    to: `        userMessages: um.slice(0, capsuleUserMsgMaxOf()),`,
    expect: "69④c",
  },
  {
    tag: "M5 把存储侧硬上限调到低于设置 max ⇒ 调大设置就静静丢数据",
    from: `const CAPSULE_STORE_USER_HARD_MAX = settingSpecMax("capsuleUserMsgMax", CAPSULE_USER_MSG_MAX);`,
    to: `const CAPSULE_STORE_USER_HARD_MAX = 40;`,
    expect: "69⑧",
  },
  {
    tag: "M6 渲染侧改回「自己拼 + 编一个 _ledger-archive」",
    from: `    const archRel = userMsgArchiveRel(info, new Date());`,
    to: `    const archRel = path.join(info.archiveRel ?? "_ledger-archive", "2026-10/week2/用户原话-完整存档.md");`,
    expect: "69⑦b",
  },
];

let allRed = true;
const results = [];
for (const c of CASES) {
  if (!orig.includes(c.from)) {
    console.log(`\n✗ ${c.tag}：**锚点没找到** ⇒ 本次反向验证无效（不等于通过）`);
    allRed = false;
    results.push({ tag: c.tag, ok: false, why: "锚点没找到" });
    continue;
  }
  fs.writeFileSync(FILE, orig.replace(c.from, c.to));
  let out = "";
  try {
    out = execFileSync(process.execPath, ["tools/selftest.mjs"], { encoding: "utf8" });
  } catch (e) {
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  const m = out.match(/通过 (\d+) 项，失败 (\d+) 项/);
  const idx = out.indexOf("失败清单：");
  const failed = idx === -1 ? "" : out.slice(idx);
  const hit = failed.includes(c.expect);
  // ★ 归一化：别让"预期那条红"被"另外 4 条台账数字守卫也红"掩盖成误判
  const nFail = m?.[2] ?? "?";
  console.log(`\n${c.tag}\n  ⇒ 通过 ${m?.[1] ?? "?"} / 失败 ${nFail}`);
  console.log(`  期望红（含「${c.expect}」）：${hit ? "✔ 确实红了" : "✗ **没红** ⇒ 断言太弱"}`);
  results.push({ tag: c.tag, ok: hit, nFail });
  if (!hit) allRed = false;
}
fs.writeFileSync(FILE, orig);
const restored = h(fs.readFileSync(FILE, "utf8")) === h(orig);
console.log(`\n已恢复。$${h(fs.readFileSync(FILE, "utf8"))} 逐字节还原：${restored ? "✔" : "✗"}`);
console.log(allRed ? "\n★★★ 全部变红 ⇒ 断言有判别力。" : "\n⚠ 有没红的 ⇒ 不许当成通过。");
process.exit(allRed && restored ? 0 : 1);
