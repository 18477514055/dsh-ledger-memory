#!/usr/bin/env node
/**
 * 只读诊断：为什么某台设备"安装界面显示最新版、下载却只能装到旧版"。
 *
 * ★ 用法（在**那台有问题的设备**上跑）：
 *     node tools/_probe-install-version.mjs
 *     node tools/_probe-install-version.mjs dsh-other-plugin      # 查别的包
 *
 * ★ 它**只读**：不装、不删、不改任何文件；不发任何写请求。
 *
 * ★ 为什么要单独做这个探针：
 *   2026-10-11 用户报"官方 npm 通道无论怎么下载都只装到 0.1.0，
 *   但界面能显示最新版本号"。我在本机查清了**机制**（见下），
 *   但本机 profile 里本包是 `link:`（指向仓库目录、根本不下载）
 *   ⇒ **本机复现不出来**。所以真正确诊必须在**出问题的那台设备**上跑。
 *
 * ── 机制（本机已用真 pnpm 对照实验坐实）────────────────────────────
 *   semver 里 `^0.1.0` = `>=0.1.0 <0.2.0` —— **0.x 的插入符不许跨次版本**。
 *   于是 profile 的 package.json 里若写着 `^0.1.0`，
 *   那么"再装一次"只是在**这个范围内**解析 ⇒ 永远是 0.1.x。
 *   而**安装界面读的是注册表实时数据**（所以照样显示 0.4.0）。
 *   两者不同源 ⇒ 呈现为"显示最新、装出来最旧"。
 *
 *   实测（真 pnpm，隔离目录）：
 *     起点 无       ⇒ 装出 0.4.0 ✓
 *     起点 0.1.0    ⇒ 装出 0.1.0 ★ 卡住
 *     起点 ^0.1.0   ⇒ 装出 0.1.0 ★ 卡住（0.x 的插入符不跨次版本）
 *     起点 ^0.4.0   ⇒ 装出 0.4.0 ✓
 *
 * ★ 另有一条 DSH 自己的规则（读 app.asar 得到）：
 *   `dsh-plugin-manager` 在**已安装**时会直接**拒绝**安装（reason: `already-installed`），
 *   而不是静默装旧版。所以"装出旧版"与"被拒绝"是**两种不同**的现象，别混。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NAME = process.argv[2] ?? "dsh-ledger-memory";
const HOME = process.env.USERPROFILE ?? os.homedir();
const DSH = process.env.DSH_HOME ?? path.join(HOME, ".dsh");
const only = process.argv.includes("--offline");

console.log(`诊断目标包：${NAME}`);
console.log(`DSH_HOME  ：${DSH}`);
console.log("");

// ── ① 注册表真值（能联网时）──────────────────────────────────
if (!only) {
  console.log("═══ ① 注册表真值（界面显示的就是这份）═══");
  for (const [label, url, pick] of [
    ["官方 npm", `https://registry.npmjs.org/${NAME}`, (j) => j["dist-tags"]?.latest],
    ["npmmirror", `https://registry.npmmirror.com/${NAME}`, (j) => j["dist-tags"]?.latest],
  ]) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) { console.log(`  ${label.padEnd(12)} HTTP ${r.status}`); continue; }
      const j = await r.json();
      const vers = Object.keys(j.versions ?? {});
      console.log(`  ${label.padEnd(12)} latest=${pick(j)}  共 ${vers.length} 版：${vers.join(", ")}`);
    } catch (e) {
      console.log(`  ${label.padEnd(12)} 取不到：${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  console.log("  ⇒ 若这里显示的是新版本，那「界面显示新版」就解释完了，问题在下面 ②/③\n");
}

// ── ② profile 里写的**范围**（★ 真正的成因）──────────────────
console.log("═══ ② profile 的 package.json 里这个包被写成什么范围 ★关键★ ═══");
let range;
const profiles = fs.existsSync(path.join(DSH, "profiles"))
  ? fs.readdirSync(path.join(DSH, "profiles"))
  : [];
for (const p of profiles) {
  const pj = path.join(DSH, "profiles", p, "package.json");
  if (!fs.existsSync(pj)) continue;
  let j;
  try { j = JSON.parse(fs.readFileSync(pj, "utf8")); } catch { continue; }
  const deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) };
  const v = deps[NAME];
  console.log(`  profile「${p}」: ${v === undefined ? "（未声明）" : v}`);
  if (v !== undefined) range = v;
  // 顺带列出所有精确版 vs 插入符版，帮助判断 DSH 的写入习惯
  const exact = Object.entries(deps).filter(([, x]) => /^\d/.test(x));
  const caret = Object.entries(deps).filter(([, x]) => /^[\^~]/.test(x));
  console.log(`      （该 profile 共 ${Object.keys(deps).length} 个依赖：精确版 ${exact.length} 个 / 插入符或波浪号 ${caret.length} 个）`);
}

console.log("");
if (range === undefined) {
  console.log("  ⇒ 这个包里**没有**这个依赖 ⇒ 它要么没装、要么是 link: 之类的其它形式。");
} else if (/^link:|^file:/.test(range)) {
  console.log(`  ⇒ 是本地联接/文件（${range.slice(0, 40)}…）⇒ **根本不走下载**，不会有"版本装不上去"的问题。`);
} else if (/^\d/.test(range)) {
  console.log(`  ★★ 被**精确钉死**在 ${range} ⇒ 再"安装"只会解析出这个精确版本，**永远升不上去**。`);
  console.log(`     ⇒ 解药：先卸载，再安装（或显式指定新版本）。`);
} else if (/^\^0\./.test(range)) {
  console.log(`  ★★★ 命中根因！范围是 ${range}，而 semver 里 \`^0.x.y\` = 「>=0.x.y <0.(x+1).0」`);
  console.log(`     ⇒ **0.x 的插入符不允许跨次版本** ⇒ 永远只能装 0.x.* ⇒ 升不到 0.4.0。`);
  console.log(`     ⇒ 解药：先卸载、再安装（或装的时候显式给 @latest）。`);
} else if (/^\^[1-9]/.test(range)) {
  console.log(`  ⇒ ${range}（1.x 及以上的插入符）⇒ 允许跨次版本 ⇒ **不会有这个问题**。`);
}

// ── ③ 已装的实际版本 + 锁文件 ────────────────────────────────
console.log("\n═══ ③ 磁盘上实际装的是哪一版 ═══");
for (const p of profiles) {
  const base = path.join(DSH, "profiles", p);
  const inst = path.join(base, "node_modules", NAME, "package.json");
  if (fs.existsSync(inst)) {
    try { console.log(`  profile「${p}」node_modules 里：${JSON.parse(fs.readFileSync(inst, "utf8")).version}`); }
    catch { console.log(`  profile「${p}」node_modules 里：package.json 读不出来`); }
  }
  const lock = path.join(base, "pnpm-lock.yaml");
  if (fs.existsSync(lock)) {
    const t = fs.readFileSync(lock, "utf8");
    const m = t.match(new RegExp(`\\n\\s+${NAME.replace(/[/\\]/g, ".")}:[\\s\\S]{0,200}`));
    if (m) console.log(`  profile「${p}」锁文件：${m[0].split("\n").slice(1, 5).map((l) => l.trim()).join(" | ")}`);
  }
}
console.log(`  （看 node_modules 里那一版 —— 那才是"实际装出来的"）`);

// ── ④ pnpm 自己的缓存与闸门 ──────────────────────────────────
console.log("\n═══ ④ 本机 pnpm 的 registry 配置（问的是哪个源）═══");
for (const f of [
  path.join(HOME, ".npmrc"),
  path.join(process.env.LOCALAPPDATA ?? "", "pnpm", "config", "rc"),
  path.join(process.env.APPDATA ?? "", "pnpm", "rc"),
]) {
  if (!fs.existsSync(f)) continue;
  // ★ 只打印**键名**，绝不打印值 —— 那里可能含令牌（凭据红线）
  const keys = fs.readFileSync(f, "utf8").split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => l.split("=")[0].trim());
  console.log(`  ${f}`);
  for (const k of keys) console.log(`      ${k} = <已隐去>`);
}
if (process.env.npm_config_registry) console.log(`  环境变量 npm_config_registry = ${process.env.npm_config_registry}`);

console.log("\n═══ ⑤ 结论怎么读 ═══");
console.log("  · ② 里若看到 `^0.1.0` 或精确 `0.1.0` ⇒ **就是它**，与界面显示无关。");
console.log("  · ③ 里 node_modules 的版本 = 你实际在用的版本。");
console.log("  · 若 ② 干净、③ 却仍是旧版 ⇒ 再看是否有 pnpm 元数据缓存/私有源，需要单独查。");
console.log("\n  解药（按省事程度）：");
console.log("   ① 在 DSH 界面里**先卸载、再安装**（最省事，且治本）");
console.log("   ② 或显式给版本：pnpm add " + NAME + "@latest");
console.log("   ③ 或先把依赖删掉：pnpm remove " + NAME + " && pnpm add " + NAME);
