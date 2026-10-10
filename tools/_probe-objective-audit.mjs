/**
 * 收官审计：把目标里的每一条**逐条**核对，输出证据。
 * 用法：node tools/_probe-objective-audit.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DIR = path.resolve(import.meta.dirname, "..");
const host = fs.readFileSync(path.join(DIR, "lib", "index.js"), "utf8");
const client = fs.readFileSync(path.join(DIR, "lib", "client.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(DIR, "package.json"), "utf8"));

let fail = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond || detail === undefined ? "" : `\n        ${detail}`}`);
  if (!cond) fail++;
};

console.log("═══ 目标逐条核对 ═══");

// ① 注册进官方设置的配置面板
ok('① 有客户端半边 lib/client.js', fs.existsSync(path.join(DIR, "lib", "client.js")));
ok('① 用平台的 __ModuleLoader__.load 注册', client.includes("window.__ModuleLoader__.load("));

// ② 设置导航里独立一页，用 settings.section
ok('② 挂的是 settings.section', client.includes('const SLOT = "settings.section"'));
ok('② 确实注册进那个 slot', /slots\.inject\(\s*SLOT/.test(client));
ok('② 有自己的 id（不与官方 models/agent-presets/plugins 撞）', client.includes('const SECTION_ID = "project-ledger"'));

// ③ 七项设置
const SEVEN = ["turnEndOffer", "highFidelityCompact", "highFidelityCompactRatio", "autoCompact", "logLevels", "maxActiveLines", "pressureTiers"];
const seen = SEVEN.filter((k) => new RegExp(`key:\\s*"${k}"`).test(host));
ok(`③ 宿主声明了七项（实得 ${seen.length}/7）`, seen.length === 7, seen.join(", "));
ok('③ 客户端不另抄一份（元数据由宿主经 HTTP 提供）', !SEVEN.every((k) => new RegExp(`"${k}"`).test(client)) || client.includes("specs"));

// ④ 手写 StandardSchemaV1 Config，零 import
ok('④ 导出了 Config', /export \{ Config \}|export const Config/.test(host));
ok('④ Config 带 ~standard.validate', host.includes('"~standard"') && host.includes("validate(input)"));
const hostImports = [...host.matchAll(/^import .*?from "([^"]+)"/gm)].map((m) => m[1]);
ok('④★ 宿主只 import node:* 内置模块（零 @deepseek-ai/*）', hostImports.every((s) => s.startsWith("node:")), hostImports.join(", "));

// ⑤ webServer 路由
ok('⑤ 用 ctx.inject(["webServer"])（可选依赖）', host.includes('ctx.inject(["webServer"]'));
ok('⑤ 有路由前缀常量', host.includes("SETTINGS_PREFIX"));
ok('⑤ 用 kind:"exact" 注册', host.includes('kind: "exact"'));

// ⑥ 写入走 configEditor.edit()
ok('⑥ 取 configEditor 服务', host.includes('ctx.get("configEditor")') || host.includes('scope.get("configEditor")'));
ok('⑥★ 调 editor.edit(', /editor\.edit\(/.test(host));
ok('⑥ 没有自己去改 profile 的 patch 文件（红线）', !/writeFileSync\([^)]*cordis\.patch\.yml/.test(host), "发现有直接写 cordis.patch.yml");

// ⑦ 自检与文档
const st = spawnSync(process.execPath, ["tools/selftest.mjs"], { cwd: DIR, encoding: "utf8" });
const green = /通过 (\d+) 项，失败 0 项/.exec(st.stdout ?? "");
ok(`⑦ 自检全过（${green ? green[1] : "?"} 项）`, green !== null);
ok('⑦ 自检里有「情形 27：官方设置面板」', (st.stdout ?? "").includes("情形 27：官方设置面板"));
ok('⑦ README 有设置面板一节', fs.readFileSync(path.join(DIR, "README.md"), "utf8").includes("设置面板"));
ok('⑦ DECISIONS 有 D38', fs.readFileSync(path.join(DIR, "DECISIONS.md"), "utf8").includes("## D38"));

// 双半声明
ok('★ package.json 同时有 dsh.bundle 与 dsh.client', pkg.dsh?.bundle?.patch !== undefined && pkg.dsh?.client?.platform === "web");
ok('★ exports 暴露 ./client', pkg.exports?.["./client"] === "./lib/client.js");

console.log(`\n${fail === 0 ? "目标全部达成" : `未达成 ${fail} 项`}`);
process.exit(fail === 0 ? 0 : 1);
