/**
 * 探针（D212 之二）—— **本机上到底有几份插件代码？**
 *
 * ★ 为什么必须查这个：用户问「其他使用**老版本插件**的对话」。
 *   如果全机只有一份代码（profile 里是 `link:` 指向同一目录），
 *   那么"老版本"只能指**同一个进程里、重启之前加载的旧代码**，不可能有并存的第二份。
 *   ⇒ 这个区分直接决定答案对不对。
 *
 * 跑法：node tools/_probe-d212-code-copies.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.USERPROFILE ?? os.homedir();
const DSH = path.join(HOME, ".dsh");
const MINE = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";

console.log("════════ D212b 探针：本机有几份插件代码？ ════════\n");

/** 我的目录是不是被别处以 junction / symlink 指过来（= 同一份代码的另一个入口）。 */
console.log("【①】我的工作目录本身：");
try {
  const st = fs.lstatSync(MINE);
  console.log(`  ${MINE}`);
  console.log(`  是符号链接 = ${st.isSymbolicLink()}（真实目录 ⇒ 它就是那份代码本体）`);
} catch (e) {
  console.log(`  ★ 读不到：${String(e.message)}`);
}

// ── 每个 profile 的 package.json 里，本插件那条是怎么写的 ──────────────────
console.log("\n【②】各 profile 里本插件的登记方式：");
const profilesDir = path.join(DSH, "profiles");
let profiles = [];
try {
  profiles = fs.readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
} catch (e) {
  console.log(`  ★ 读不到 profiles：${String(e.message)}`);
}
for (const p of profiles) {
  const pj = path.join(profilesDir, p, "package.json");
  if (!fs.existsSync(pj)) continue;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(pj, "utf8"));
  } catch {
    continue;
  }
  const dep = (j.dependencies ?? {})["dsh-ledger-memory"];
  if (dep === undefined) continue;
  console.log(`  · profile "${p}" ⇒ ${dep}`);
  // 若是 link:，把指向解出来看看是不是我的目录
  if (typeof dep === "string" && dep.startsWith("link:")) {
    const target = dep.slice(5);
    let real = target;
    try {
      real = fs.realpathSync(target);
    } catch {
      /* 解析不了就原样 */
    }
    const same = path.resolve(real).toLowerCase() === path.resolve(MINE).toLowerCase();
    console.log(`      解析后 ⇒ ${real}`);
    console.log(`      ${same ? "★★ 与我的工作目录**是同一份代码**（同一目录）" : "★ 指向别处！"}`);
  }
}

// ── 有没有**下载下来的实体包**副本（那才是"另一份代码"）──────────────────
console.log("\n【③】有没有实体副本（node_modules 里的真目录，非 link）：");
let found = 0;
for (const p of profiles) {
  for (const nm of ["node_modules"]) {
    const cand = path.join(profilesDir, p, nm, "dsh-ledger-memory");
    if (!fs.existsSync(cand)) continue;
    const st = fs.lstatSync(cand);
    const real = (() => {
      try {
        return fs.realpathSync(cand);
      } catch {
        return "(解析失败)";
      }
    })();
    console.log(`  · ${cand}`);
    console.log(`      是符号链接 = ${st.isSymbolicLink()}｜解析 ⇒ ${real}`);
    found += 1;
  }
}
if (found === 0) console.log("  （没有找到实体副本）");

// ── 本机有没有别的 checkouts（按目录名粗扫，只看工作区顶层）───────────────
console.log("\n【④】工作区里还有没有别的同名插件目录：");
const roots = ["D:\\Deepseek工作区"];
const hits = [];
const walk = (dir, depth) => {
  if (depth > 4) return;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.name === "dsh-int-project-ledger" || e.name === "dsh-ledger-memory") hits.push(full);
    walk(full, depth + 1);
  }
};
for (const r of roots) walk(r, 0);
for (const h of hits) {
  const same = path.resolve(h).toLowerCase() === path.resolve(MINE).toLowerCase();
  console.log(`  · ${h}${same ? "  ← 就是我的工作目录" : "  ★ 另一份！"}`);
}
if (hits.length === 0) console.log("  （没扫到）");

console.log("\n════════ 结论 ════════");
console.log("  ★ 若上面「②」都指向我的目录、「③」没有实体副本 ⇒ **全机只有一份代码**。");
console.log("    那么「老版本插件」只能指：**同一个进程里、本次重启前加载的那份旧代码**。");
console.log("    ⇒ 重启之后所有对话都用新代码；AI 不需要做任何事。");
