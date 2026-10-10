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

// ⑧ ★★★ 两个模式（2026-10-10 用户拍板）
//
//  用户原话：*"我们把它定义为这个插件的两个模式…正常向前推进的任务就执行现在的这个
//  模式，如果需要反复追究的话，就执行第二种模式。最好这个也能在设置面板里体现出来。"*
//  ⇒ 逐条对他的话：① 两个模式都在；② 默认是"正常推进"；③ 面板里能看见。
ok('⑧★ 两种模式都登记了（steady / surgical）', host.includes('const MODE_STEADY') && host.includes('const MODE_SURGICAL'));
ok('⑧★ 默认是「正常推进」（不带配置 = 今天的行为）', /mode:\s*MODE_STEADY/.test(host), "默认值不是 steady");
ok('⑧★ 面板里能选（SETTING_SPECS 里有一项 kind:"choice"）', /key:\s*"mode",\s*\n\s*kind:\s*"choice"/.test(host));
ok('⑧★ 模式是**项目清单优先**（能一个仓库两种活）', /function modeOf\(info\)/.test(host) && host.includes("info?.manifest?.mode"));
ok('⑧★ 有分流工具 ledger_triage（用户说的「划分」）', host.includes('name: "ledger_triage"'));
ok('⑧★ 三个桶都在（留 / 落 / 丢 = keep / stash / drop）',
  host.includes("TRIAGE_KEEP") && host.includes("TRIAGE_STASH") && host.includes("TRIAGE_DROP"));
ok('⑧★ 客户端真的会画选择器（controlFor 认 choice）', client.includes('spec.kind === "choice"'));
ok('⑧★★ 自检里有「情形 37：两个模式」', (st.stdout ?? "").includes("情形 37：两个模式"));

// ⑨ ★★★ 项目锁（2026-10-10 用户拍板）
//
//  用户原话：*"因为总的工作区是有需要读的东西的，所以有时候会把对话建在总的工作区
//  下面，这种时候的话，这个项目的锁定就应该考虑到可以让用户和AI说之后AI调用，
//  或者说把项目注册到对应的文件夹上，以后各种工具的使用都在那个文件夹上。"*
//  以及他否决落注册表时的：*"而不是去动工作区的东西。不应该有这个权利。
//  最开始的提示卡片就可以有这样的选择。"*
ok('⑨★ 有 `ledger_lock` 工具', host.includes('name: "ledger_lock"'));
// ★ 2026-10-10 用户追加要求后，这里从"只在内存"改成了"会落盘、但落在插件自己的家"。
ok('⑨★ 内存里有一份（本会话立刻生效的覆盖层）', host.includes("const sessionProjectLock = new Map()"));
// ★★★ 落盘位置必须在 **DSH 自己的家**（不碰用户工作区）—— 这是用户那条红线的落点。
ok('⑨★★ 锁**会落盘**（跨重启保持），且存在 `plugin-data` 下',
  host.includes('LOCK_STORE_DIRNAME = "plugin-data"') && host.includes("function lockStorePath"));
ok('⑨★★ 落盘路径来自 `DSH_HOME` / `~/.dsh`，**没有硬编码本机路径**',
  /process\.env\.DSH_HOME/.test(host) && /os\.homedir\(\)/.test(host));
ok('⑨★★ 锁按 **sid** 记（"每个对话自己选并保持"），不是按 cwd',
  host.includes("bySession") && !host.includes("byDir"));
ok('⑨★★ **唯一的取锁出口** `activeLockFor`（内存优先 + 落盘兜底 + 存在性校验）',
  host.includes("function activeLockFor(sid)") &&
    /sessionProjectLock\.get\(sid\) \?\? persistentLockFor\(sid\)/.test(host));
ok('⑨★ 工具描述里说明了"跨重启保持"，且说明记录不在用户工作区',
  /The lock PERSISTS across restarts/.test(host));
ok('⑨★ 优先级：cwd 自己有台账 ⇒ 以 cwd 为准（锁只接管没台账的）',
  /readManifest\(here\) !== undefined\) return here/.test(host));
// ★ 解除必须连记录一起删（否则"我解除了，重启又回来"）。
ok('⑨★★ 解锁时**连持久记录一起删**', /delete store\.bySession\[sid\]/.test(host));
ok('⑨★★ 自检把 `DSH_HOME` 指到沙箱（**绝不写用户真正的家**）',
  fs.readFileSync(path.join(DIR, "tools", "selftest.mjs"), "utf8").includes("SANDBOX_HOME"));
ok('⑨★ 首轮卡片里有「锁定」那一项（用户："最开始的提示卡片就可以有这样的选择"）',
  /label: "锁定到某个子项目"/.test(host));
ok('⑨★ 选完给出的指示里要求**先问用户**是哪个子项目（不许自己猜）',
  /先问清是哪个子文件夹/.test(host));
ok('⑨★★ 自检里有「情形 38：项目锁」', (st.stdout ?? "").includes("情形 38：项目锁"));

// 双半声明
ok('★ package.json 同时有 dsh.bundle 与 dsh.client', pkg.dsh?.bundle?.patch !== undefined && pkg.dsh?.client?.platform === "web");
ok('★ exports 暴露 ./client', pkg.exports?.["./client"] === "./lib/client.js");

console.log(`\n${fail === 0 ? "目标全部达成" : `未达成 ${fail} 项`}`);
process.exit(fail === 0 ? 0 : 1);
