/**
 * ★★★ 反向验证（纪律第 10 条）：**摘到能看见红为止**。
 * 针对 D84 修复（被挤出的用户原话升级归档 + 胶囊指向完整原话）。
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
    tag: "① 恢复成「淘汰即丢」（删掉 evicted 收集）",
    from: `          if (r.userMessages.length > CAPSULE_USER_MSG_MAX) {
            const evicted = r.userMessages.slice(CAPSULE_USER_MSG_MAX);
            r.userMessages.length = CAPSULE_USER_MSG_MAX;
            if (!Array.isArray(r.evictedUserMessages)) r.evictedUserMessages = [];
            r.evictedUserMessages.push(...evicted);
          }`,
    to: `          if (r.userMessages.length > CAPSULE_USER_MSG_MAX) r.userMessages.length = CAPSULE_USER_MSG_MAX;`,
    expect: "46①",
  },
  {
    tag: "② 摘掉「取出并归档」",
    from: `            const evicted = capsule.drainEvicted?.();`,
    to: `            const evicted = undefined; void capsule.drainEvicted;`,
    expect: "46①",
  },
  {
    tag: "③ 摘掉「胶囊说清只有最近 N 条 + 完整在哪」",
    from: `      \`> ⚠️ **这里只有最近的 \${CAPSULE_USER_MSG_MAX} 条**，不是全部。\\n\` +`,
    to: `      \`> （反向验证：指针被摘掉）\\n\` +`,
    expect: "46③",
  },
];

let allRed = true;
for (const c of CASES) {
  if (!orig.includes(c.from)) {
    console.log(`\n✗ ${c.tag}：**锚点没找到** ⇒ 本次反向验证无效（不等于通过）`);
    allRed = false;
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
  console.log(`\n${c.tag}  ⇒ 通过 ${m?.[1] ?? "?"} / 失败 ${m?.[2] ?? "?"}`);
  console.log(`  期望红（含「${c.expect}」）：${hit ? "✔ 确实红了" : "✗ **没红** ⇒ 断言太弱"}`);
  if (!hit) allRed = false;
}
fs.writeFileSync(FILE, orig);
console.log(`\n已恢复。sha256(前16) = ${h(fs.readFileSync(FILE, "utf8"))}（应等于 ${h(orig)}）`);
console.log(allRed ? "\n★★★ 全部变红 ⇒ 断言有判别力。" : "\n⚠ 有没红的 ⇒ 不许当成通过。");
