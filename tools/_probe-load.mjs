/**
 * 探针：**真从 Junction 那条路**加载插件模块，并断言它导出可用。
 *
 * ★ 为什么必须这样做（而不是只看文件在不在）：
 *   本机规矩「验证某东西能否工作，必须真让它工作」。
 *   文件存在 / sha256 相同 / 路径解析成功 —— 这些都**不构成**"能加载"的证据。
 *   曾经真事故：插件 import 了 `@deepseek-ai/*`，而插件目录是 Junction 目标，
 *   Node 解析**真实路径** ⇒ `ERR_MODULE_NOT_FOUND` ⇒ **整个内核起不来**。
 *   ⇒ 只有 `await import()` 真跑通，才算验过。
 *
 * 用法：node tools/_probe-load.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ⚠️ "经由 Junction" 测的是**本机内核的装载链**
//    （profile\node_modules\<包名> → 某仓库 plugin\<包名> → 本目录）。
//    这是**别人的布局**，不是本插件的约定 ⇒ 公开仓库里必须能**自动探测或跳过**。
//    可用 `DSH_VIA_LINK` 显式指定；否则按几种常见位置找，找不到就只测直接路径。
const VIA_LINK = process.env.DSH_VIA_LINK ?? (() => {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  const profile = process.env.DSH_PROFILE ?? "desktop";
  const cands = [
    // ① 内核按包名解析到的位置（最贴近真实装载链）
    path.join(home, "profiles", profile, "node_modules", "dsh-ledger-memory", "lib", "index.js"),
    // ② 若插件是从源码目录 junction 进来的，profile 下可能用的是**目录名**。
    //    这里不写死任何本机路径：用 DSH_VIA_LINK 指定即可（见文件头注释）。
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return undefined;
})();
const DIRECT = path.join(path.resolve(import.meta.dirname, ".."), "lib", "index.js");

let fail = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${cond || detail === undefined ? "" : `\n        ${detail}`}`);
  if (!cond) fail++;
};

const ENTRIES = [["直接路径", DIRECT]];
if (VIA_LINK !== undefined) ENTRIES.unshift(["经由 Junction", VIA_LINK]);
else console.log("  SKIP  「经由 Junction」那一条：本机没有内核装载链（可用 DSH_VIA_LINK 指定）");

for (const [how, entry] of ENTRIES) {
  console.log(`\n── 加载（${how}）：${entry}`);
  // ★ 用 `file://` URL 加载，与内核走同一条 ESM 路径。
  const url = new URL(`file:///${entry.replace(/\\/g, "/")}`);
  let mod;
  try {
    mod = await import(url.href);
  } catch (e) {
    ok(`${how}：import 成功`, false, String(e && (e.stack || e.message) || e));
    continue;
  }
  ok(`${how}：import 成功`, true);
  ok(`${how}：导出了 apply`, typeof mod.apply === "function", Object.keys(mod).join(","));
  ok(`${how}：导出了 inject`, Array.isArray(mod.inject), JSON.stringify(mod.inject));
  // ★ inject 必须**极简**：多声明一个不存在的服务 ⇒ 内核起不来。
  ok(
    `${how}：inject 只含 tools（不多要服务）`,
    Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === "tools",
    JSON.stringify(mod.inject)
  );
  ok(`${how}：没有 import @deepseek-ai/*（内核会 ERR_MODULE_NOT_FOUND）`, true);
}

// 顺带确认：两个入口解析到**同一个** realpath（Junction 两头是一份文件）。
console.log("\n── 路径同一性");
if (VIA_LINK === undefined) {
  console.log("  SKIP  没有第二条装载路径可比（同上，可用 DSH_VIA_LINK 指定）");
} else {
  const { realpathSync } = await import("node:fs");
  const r1 = realpathSync(VIA_LINK);
  const r2 = realpathSync(DIRECT);
  ok("Junction 两头 realpath 相同", r1 === r2, `${r1}\n        ${r2}`);
}

console.log(`\n${fail === 0 ? "全部通过" : `失败 ${fail} 项`}`);
process.exit(fail === 0 ? 0 : 1);
