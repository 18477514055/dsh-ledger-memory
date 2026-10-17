/**
 * 三渠道分发包 —— **一个源，三种产物**（D232）。
 *
 * ★★★ 用户的原话（这是本脚本存在的理由）：
 *   *"为了以后的便于区分，我感觉可以专门打包两个渠道的分发包以及插件市场的提交。
 *    我们要做的肯定是先提交本地，然后按照需要上传的和不需要上传的再打包进 github 与 npm 里面。
 *    然后插件市场同步更新。"*
 *
 * ★★ 为什么不是"三套文件"（这是关键判断，别做错）：
 *   三个渠道**要的东西其实是同一个** —— `package.json` 的 `files` 白名单
 *   （`lib/` + `cordis.patch.yml` + `README.md`）。差别只在**分发形态**：
 *
 *   | 渠道 | 拿什么 | 形态 | 额外要求 |
 *   |---|---|---|---|
 *   | **npm** | `files` 白名单 | `.tgz`（npm 自己打） | 必须是 `latest` 那份 |
 *   | **GitHub Release** | 与 npm **逐字相同**的 `.tgz` | 附件 | 便于用户手装，且**可对账** |
 *   | **GitHub 源码** | **整棵树**（含 `tools/`） | git 提交 | 与 npm 包**独立**，要分别核对 |
 *   | **插件市场** | 一份 `tarball` URL + 元数据 | JSON 条目 | 落在官方 bounds 内 |
 *
 *   ⇒ 所以正确的做法是**一个源、三种产物 + 一张对照表**。
 *     维护三套文件必然分叉（本项目反复栽过：「一个事实两个出口」）。
 *
 * ★★★ 为什么必须区分"哪些上传、哪些不上传"（用户那句话的技术含义）：
 *   `tools/` 里**有会改写源码的探针**（`_probe-*`），把它们发进用户的包是**危险的**；
 *   而 `tools/` 又必须进 GitHub 源码（那是取证工具，公开无害但用户不该拿到）。
 *   ⇒ 边界**由 `files` 白名单守着**，而这个脚本的职责是**每次打包前证明这条边界还在**。
 *
 * 跑法：
 *   node tools/_pack-channels.mjs           # 体检 + 打出三份产物（不改 git、不发布）
 *   node tools/_pack-channels.mjs --check   # 只体检，不打包
 *
 * 产物落在 `_dist/<版本>/`：
 *   npm-<name>-<ver>.tgz         ← npm publish 用的那一份（逐字节副本）
 *   github-release-<ver>.tgz     ← 与上面**同一个文件**（硬链接/副本，附对账 sha256）
 *   CHANNELS.md                  ← 四种产物的对照表 + 各自的上传清单
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ★ 必须用 fileURLToPath：`new URL(...).pathname` **不解中文百分号编码** ⇒ 本机路径全含中文。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CHECK_ONLY = process.argv.includes("--check");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

/** 官方 DSH STORE 的源码包界限（真源：`_store-research/automation-policy.json`，只读研究材料）。 */
const STORE_BOUNDS_FILE = path.join(ROOT, "_store-research", "automation-policy.json");
const FALLBACK_BOUNDS = {
  maxTreeEntries: 1200,
  maxRuntimeFiles: 240,
  maxFileBytes: 262144,
  maxTotalRuntimeBytes: 2097152,
};

function storeBounds() {
  try {
    const p = readJson(STORE_BOUNDS_FILE);
    const b = p?.sourceBounds;
    if (b && typeof b === "object") return { bounds: b, source: "_store-research/automation-policy.json" };
  } catch {
    /* 研究材料不在本机（它被 gitignore）⇒ 用记下来的值，并**如实说明来源** */
  }
  return { bounds: FALLBACK_BOUNDS, source: "内置副本（研究材料不在本机 —— D213 记下来的值）" };
}

/**
 * ★★★ 把 `files` 白名单**真的展开**成文件清单。
 *
 * ★ 为什么不 `fs.readdir` 整个仓库再过滤：那会量到"我以为的口径"。
 *   D213 已经证伪过两次 glob 口径（一次量到工作目录、一次量到整棵树）。
 *   ⇒ 判据必须与**真正会被发布的那个集合**同源：`npm pack --dry-run` 的产物。
 */
function packList() {
  const raw = execFileSync("npm.cmd", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: true, // ★ Node 24 起 execFileSync("npm.cmd") 必须带 shell:true（本项目既有教训）
    maxBuffer: 1 << 28,
  });
  // npm 会往 stdout 混进度行 ⇒ 取第一段合法 JSON。
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < 0) throw new Error(`npm pack --dry-run 输出里没有 JSON：\n${raw.slice(0, 400)}`);
  const arr = JSON.parse(raw.slice(start, end + 1));
  const one = Array.isArray(arr) ? arr[0] : undefined;
  if (one === undefined || !Array.isArray(one.files)) throw new Error("npm pack --dry-run 没给出 files 列表");
  return {
    tarball: one.filename,
    size: one.size,
    unpackedSize: one.unpackedSize,
    files: one.files.map((f) => ({ path: f.path, size: f.size ?? 0 })),
  };
}

/** 官方 bounds 体检（拿**真会被扫的源码**算，不含 README/package.json）。 */
function checkStoreBounds(list) {
  const { bounds, source } = storeBounds();
  const SCANNABLE = /\.(m?js|cjs|jsx|ts|tsx|mts|cts)$/i;
  const src = list.files.filter((f) => SCANNABLE.test(f.path));
  const total = src.reduce((n, f) => n + f.size, 0);
  const largest = src.reduce((m, f) => (f.size > m.size ? f : m), { path: "-", size: 0 });
  const bad = [];
  if (!(src.length > 0 && src.length <= bounds.maxRuntimeFiles)) bad.push(`可扫源码数 ${src.length}（上限 ${bounds.maxRuntimeFiles}）`);
  if (!(largest.size <= bounds.maxFileBytes)) bad.push(`最大单文件 ${largest.path} ${largest.size} B（上限 ${bounds.maxFileBytes}）`);
  if (!(total <= bounds.maxTotalRuntimeBytes)) bad.push(`可扫源码合计 ${total} B（上限 ${bounds.maxTotalRuntimeBytes}）`);
  if (!(list.files.length <= bounds.maxTreeEntries)) bad.push(`包面条目 ${list.files.length}（上限 ${bounds.maxTreeEntries}）`);
  return { ok: bad.length === 0, bad, src, total, largest, bounds, source };
}

/**
 * ★★★ 边界体检：**哪些该上传、哪些不该** —— 这是用户那句话的核心。
 *
 * ★ 每条都写成"能证伪"的形式（本项目纪律：断言必须能被弄红）。
 */
function checkBoundary(list) {
  const paths = list.files.map((f) => f.path);
  const problems = [];

  // ① 包内**绝不许**出现 tools/（那里有会改写源码的探针 —— 发进用户的包是危险的）
  const leaked = paths.filter((p) => p.startsWith("tools/"));
  if (leaked.length > 0) problems.push(`包内混进了 tools/：${leaked.slice(0, 5).join(", ")}`);

  // ② 包内绝不许出现开发过程记忆（私有项目名 / 本机路径 / 真实会话编号）
  const MEMORY = /^(LEDGER\.md|JOURNAL\.md|PRINCIPLES\.md|DECISIONS\.md|decisions\/|lessons\/|goals\/|_ledger-log\/|_ledger-archive\/|_handoff\/|_stash\/|docs\/|_store-research\/)/;
  const leakMem = paths.filter((p) => MEMORY.test(p));
  if (leakMem.length > 0) problems.push(`包内混进了开发过程记忆：${leakMem.slice(0, 5).join(", ")}`);

  // ③ 包内绝不许出现临时/备份/产物
  const JUNK = /(_tmp-|\.bak$|\.orig$|~$|\.tgz$|node_modules\/)/;
  const junk = paths.filter((p) => JUNK.test(p));
  if (junk.length > 0) problems.push(`包内混进了临时/备份/产物：${junk.slice(0, 5).join(", ")}`);

  // ④ 必须有的三项（少了就没法装 / 没法审）
  for (const must of ["package.json", "README.md"]) {
    if (!paths.includes(must)) problems.push(`包内缺 ${must}`);
  }
  if (!paths.some((p) => p.startsWith("lib/") && p.endsWith(".js"))) problems.push("包内缺 lib/*.js");
  if (!paths.includes("cordis.patch.yml")) problems.push("包内缺 cordis.patch.yml");

  // ⑤ 版本一致性：package.json / cordis.patch.yml 的身份位
  const pkg = readJson(path.join(ROOT, "package.json"));
  const fourId = ["package.json:name", "cordis.patch.yml:id"];
  try {
    const yml = fs.readFileSync(path.join(ROOT, "cordis.patch.yml"), "utf8");
    if (!yml.includes(`id: ${pkg.name}`)) problems.push(`cordis.patch.yml 的 id 与 package.json name 不一致（应为 ${pkg.name}）`);
  } catch {
    problems.push("读不到 cordis.patch.yml");
  }

  // ⑥ 源码树里**必须**有 tools/（它是取证工具，GitHub 源码要带；但与上一条并不矛盾）
  const gitTracked = execFileSync("git", ["ls-files", "tools"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\n")
    .filter((s) => s.trim() !== "");
  if (gitTracked.length === 0) problems.push("git 里没有跟踪任何 tools/ —— 取证工具没进源码树");

  return { ok: problems.length === 0, problems, fourId, pkg, gitTracked };
}

/** 工作区必须干净 —— 否则"打出来的包"与"提交的源码"不是同一份（第 34 节教训）。 */
function checkClean() {
  const out = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
  return { clean: out === "", dirty: out === "" ? [] : out.split("\n").slice(0, 12) };
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("═══ 三渠道分发包体检（一个源，三种产物）═══\n");

const list = packList();
const pkg = readJson(path.join(ROOT, "package.json"));
const ver = pkg.version;

console.log(`插件：${pkg.name}@${ver}`);
console.log(`包内文件：${list.files.length} 个 · tarball ${list.size} B · 解包 ${list.unpackedSize} B\n`);
list.files.forEach((f) => console.log(`  ${String(f.size).padStart(8)}  ${f.path}`));

const sb = checkStoreBounds(list);
console.log(`\n── ① 插件市场（DSH STORE）源码界限 ── 真源：${sb.source}`);
console.log(`  可扫源码 ${sb.src.length} 个（上限 ${sb.bounds.maxRuntimeFiles}）· 合计 ${sb.total} B（上限 ${sb.bounds.maxTotalRuntimeBytes}）`);
console.log(`  最大单文件 ${sb.largest.path} ${sb.largest.size} B（上限 ${sb.bounds.maxFileBytes}）· 包面条目 ${list.files.length}（上限 ${sb.bounds.maxTreeEntries}）`);
console.log(`  ${sb.ok ? "✅ 在界限内" : "❌ 越界：" + sb.bad.join(" · ")}`);

const bd = checkBoundary(list);
console.log(`\n── ② 哪些该上传 / 哪些不该（这条边界是本脚本的核心职责）──`);
console.log(`  ${bd.ok ? "✅ 边界完好" : "❌ " + bd.problems.join("\n     ")}`);
console.log(`  · 包内（会被每个用户下载）：${list.files.length} 个 —— 只有 lib/ + README + cordis.patch.yml`);
console.log(`  · 源码树（只上 GitHub，不进包）：git 跟踪 ${bd.gitTracked.length} 个 tools/ 探针`);
const nonTools = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\n")
  .filter((s) => s.trim() !== "" && !s.startsWith("tools/"));
console.log(`  · 源码树另外还有 ${nonTools.length} 个非 tools 文件`);

const cl = checkClean();
console.log(`\n── ③ 工作区是否干净（包与源码必须同一份）──`);
console.log(`  ${cl.clean ? "✅ 干净（HEAD 就是将要发布的源码）" : "❌ 有未提交改动 —— 打出来的包与源码不是同一份：\n     " + cl.dirty.join("\n     ")}`);

const allOk = sb.ok && bd.ok && cl.clean;
if (!allOk) {
  console.log("\n❌ 体检未通过 —— 先修上面标红的项，再打包。");
  process.exit(1);
}
console.log("\n✅ 三项体检全部通过。");

if (CHECK_ONLY) {
  console.log("\n（--check：只体检，不打包）");
  process.exit(0);
}

// ── 打包 ────────────────────────────────────────────────────────────────────
const distDir = path.join(ROOT, "_dist", ver);
fs.mkdirSync(distDir, { recursive: true });

console.log("\n═══ 打包 ═══");
const npmTgz = path.join(distDir, `npm-${pkg.name}-${ver}.tgz`);
execFileSync("npm.cmd", ["pack", "--ignore-scripts", "--pack-destination", distDir], {
  cwd: ROOT,
  encoding: "utf8",
  shell: true,
  stdio: "pipe",
});
// npm 打出来的名字是 <name>-<ver>.tgz ⇒ 改名成 npm- 前缀，便于区分。
const rawTgz = path.join(distDir, `${pkg.name}-${ver}.tgz`);
if (!fs.existsSync(rawTgz)) throw new Error(`没找到 npm 产物：${rawTgz}`);
fs.renameSync(rawTgz, npmTgz);
const npmBuf = fs.readFileSync(npmTgz);
const npmSha = sha256(npmBuf);
console.log(`  ✅ npm 用：${path.relative(ROOT, npmTgz)}  ${npmBuf.length} B  sha256 ${npmSha.slice(0, 16)}…`);

// GitHub Release 附件：**与 npm 那份逐字节相同**（这才是可对账的那一份）。
const ghTgz = path.join(distDir, `github-release-v${ver}.tgz`);
fs.copyFileSync(npmTgz, ghTgz);
const ghSha = sha256(fs.readFileSync(ghTgz));
if (ghSha !== npmSha) throw new Error("GitHub 附件与 npm 产物不是逐字节相同 —— 不许发布");
console.log(`  ✅ GitHub Release 附件：${path.relative(ROOT, ghTgz)}  （与 npm **逐字节相同**，已对账）`);

// 对照表
const md = `# ${pkg.name}@${ver} —— 三渠道分发包对照表

> 由 \`tools/_pack-channels.mjs\` 生成（${new Date().toISOString()}）。**不要手改**。

## 一、四种产物，各自上传到哪

| # | 渠道 | 拿什么 | 产物（本目录） | 怎么上传 |
|---|---|---|---|---|
| 1 | **npm** | \`files\` 白名单 | \`${path.basename(npmTgz)}\` | \`npm publish <该 tgz> --userconfig %LOCALAPPDATA%\\dsh-plugin-uploader\\npmrc\` |
| 2 | **GitHub Release** | 与 npm **逐字节相同** | \`${path.basename(ghTgz)}\` | 建成 \`v${ver}\` 的附件 |
| 3 | **GitHub 源码** | **整棵树**（含 \`tools/\`） | 就是 git 提交本身 | \`git push\`（空 commit 也算一次发布） |
| 4 | **插件市场** | 一份 tarball URL + 元数据 | 见下「市场条目」 | 改目录 JSON / 提 PR |

★ **第 2 与第 1 是同一个字节流** —— 这是刻意的：用户手装的那份与 npm 装的那份**必须一致**，
否则"回读五条"里的「包内源码逐字节相同」根本没法对账。

## 二、包内到底有什么（**会被每个用户下载**）

共 ${list.files.length} 个文件：

${list.files.map((f) => `- \`${f.path}\`（${f.size} B）`).join("\n")}

## 三、**不进包**的东西（这是边界，不是遗漏）

| 类别 | 例子 | 为什么不上传 |
|---|---|---|
| 取证探针 | \`tools/\`（${bd.gitTracked.length} 个） | ★ **里面有会改写源码的探针** —— 发进用户的包是危险的。它们只上 GitHub 源码。 |
| 开发过程记忆 | \`LEDGER.md\`·\`JOURNAL.md\`·\`PRINCIPLES.md\`·\`decisions/\`·\`lessons/\`·\`goals/\`·\`_ledger-log/\`·\`_ledger-archive/\`·\`_handoff/\`·\`_stash/\` | 含私有项目名 / 本机路径 / 真实会话编号 |
| 内部文档 | \`docs/\` | 对内（决策 / 踩坑 / 状态），不是给用户读的 |
| 第三方副本 | \`_store-research/\` | 别人的源码，不该混进我们的仓库与包 |
| 产物 / 临时 | \`*.tgz\`·\`node_modules/\`·\`_tmp-*\`·\`*.bak\` | 可重新生成 |

## 四、插件市场（DSH STORE）界限体检

真源：${sb.source}

| 指标 | 实测 | 上限 |
|---|---|---|
| 可扫源码文件数 | ${sb.src.length} | ${sb.bounds.maxRuntimeFiles} |
| 可扫源码合计 | ${sb.total} B | ${sb.bounds.maxTotalRuntimeBytes} B |
| 最大单文件 | \`${sb.largest.path}\` ${sb.largest.size} B | ${sb.bounds.maxFileBytes} B |
| 包面条目 | ${list.files.length} | ${sb.bounds.maxTreeEntries} |

${sb.ok ? "✅ 全部在界限内。" : "❌ 越界：" + sb.bad.join(" · ")}

## 五、发布顺序（★ 顺序不能换）

1. **本地提交**（已完成才能打包 —— 否则包与源码不是同一份）；
2. 本脚本 \`node tools/_pack-channels.mjs\`（体检 + 打三份产物）；
3. \`node tools/_probe-pack-check.mjs <npm tgz>\`（解包核对"这一版修的那行确实在包里"）；
4. \`npm publish\` → **轮询回读**（本项目实测要查到第 5~6 次）；
5. 建 GitHub Release 并上传**同一份** tgz；
6. 更新插件市场条目（tarball 指向第 5 步那个 release 资产）。

## 六、对账用

\`\`\`
npm 产物       sha256 ${npmSha}
GitHub 附件    sha256 ${ghSha}
相同？         ${npmSha === ghSha ? "✅ 是（逐字节）" : "❌ 否"}
\`\`\`
`;
const mdPath = path.join(distDir, "CHANNELS.md");
fs.writeFileSync(mdPath, md, "utf8");
console.log(`  ✅ 对照表：${path.relative(ROOT, mdPath)}`);

console.log(`\n═══ 完成 ═══`);
console.log(`产物目录：${distDir}`);
console.log(`★ 注意：GitHub **源码**这一路就是 git 提交本身（含 tools/），不是这里的 tgz ——`);
console.log(`  两者的差别正是"哪些该上传给用户 / 哪些只上源码"。`);
