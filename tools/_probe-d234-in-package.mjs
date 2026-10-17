// ★★★★★ D234 入包验证 —— 这一版新增的修复必须在**发布出去的包**里真的存在。
//
// 立这条判据的理由（D232 立下的规矩，这里是第 2 次用）：
//   `_probe-pack-check.mjs` 的标志物清单**停在 D62/A2/A3/D61 时代**，
//   它**没有一条覆盖 D234** ⇒ 即使 D234 根本没进包，那个探针**照样全绿**。
//   ⇒ 判据：**每一版新增的修复，都必须有自己独一无二、能在包里被找到的标志物。**
//
// ★ 这个探针跑的是 **`npm pack --dry-run` 的真实产物清单**（不自己 glob —— D213 已证伪过两次 glob 口径），
//   再从包里**逐字节读回**那些文件、在内容里找标志物。
// ★ 只读、不写、不改任何源码。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const ok = (label, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}${detail === undefined ? "" : `　${detail}`}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail === undefined ? "" : `　${detail}`}`);
  }
};

// ── 取「包面清单」：用 npm 自己的产物，不自己 glob ──────────────────────────
let packJson;
try {
  // ★ Node 24 起 `execFileSync("npm.cmd")` 必须带 `shell:true`（台账硬规矩）。
  const out = execFileSync("npm.cmd", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  packJson = JSON.parse(out.slice(out.indexOf("[")))[0];
} catch (e) {
  console.error(`★ 取包面清单失败（夹具故障，不是结论）：${String(e && e.message)}`);
  process.exit(2);
}

const names = packJson.files.map((f) => f.path);
const textOf = (rel) => {
  const abs = path.resolve(ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
};

console.log("=== 一、边界（这一版仍不许破）===");
ok("★ 包内**没有** `tools/`（那里有会改写源码的探针）", names.every((n) => !n.startsWith("tools/")));
ok("★ 包内**没有**开发过程记录（LEDGER/JOURNAL/decisions/_stash…）",
  names.every((n) => !/^(LEDGER|JOURNAL|PRINCIPLES|DECISIONS)\.md$/i.test(n) &&
    !/^(_stash|_handoff|_ledger-log|_ledger-archive|decisions|lessons|goals|docs)\//.test(n)));
ok("`cordis.patch.yml` 的 id 与 package.json 的 name 一致",
  /-\s*id:\s*dsh-ledger-memory/.test(textOf("cordis.patch.yml")) &&
    JSON.parse(textOf("package.json")).name === "dsh-ledger-memory");

console.log("\n=== 二、D234 的标志物（6 条正向：每一条都必须能在包里找到）===");
// ★ 每条都挑「只有这一版才有」的字符串；旧版本里一个都找不到。
const markers = [
  ["lib/part6.js 存在", () => names.includes("lib/part6.js")],
  ["六维函数 `fileAnchorDims`", () => textOf("lib/part6.js").includes("export function fileAnchorDims")],
  ["按类分组 `anchorWithinKind`（两次混类的修法）",
    () => textOf("lib/part6.js").includes("export function anchorWithinKind")],
  ["根面扫描（`push(\"\", \"根目录稿\", \"material\"`）",
    () => textOf("lib/part6.js").includes('push("", "根目录稿", "material"')],
  ["注入装配点 `renderFileAnchorBlock`", () => textOf("lib/part3.js").includes("export function renderFileAnchorBlock")],
  ["设置项 `fileAnchor` 已登记", () => textOf("lib/defs.js").includes('key: "fileAnchor"')],
];
for (const [label, fn] of markers) ok(label, fn() === true);

console.log("\n=== 三、反向（旧写法必须已消失 —— 否则修复可能是冗余的）===");
// ★ 纪律 10：反向验证必须摘到"能看见红"为止。
//
// ★★★ 这条**第一版就跑红了，而且是假红** —— 值得留档（第 27 次「尺子错」的候选形态）：
//   我原来写的是 `!textOf("lib/part3.js").includes("压缩方式 / 区块注入 / …")`。
//   但**我在修那一行时，把旧字符串原样写进了注释里当作教训留档**
//   ⇒ 判据在注释里命中了它自己 ⇒ 报红，而代码其实**已经修对了**。
//   ★ 根因就是台账纪律 2：「**判据的输入必须是"被测系统自己产生的那部分"**」——
//     **注释是"描述它的文字"，不是"它本身"**。
//   ⇒ 正解：只剥**真正会被求值的那一行**（`PRECEDENCE_KEYS.map(...)` 的模板串），
//     并把行注释整行排除。
const part3 = textOf("lib/part3.js");
const evaluated = part3
  .split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)) // ★ 整行注释排除（它们会引用旧串当留档）
  .join("\n");
ok(
  "★ 注入快照那行**不再手抄 5 个名字**（已改成从 PRECEDENCE_KEYS 现算）",
  !evaluated.includes("压缩方式 / 区块注入 / 行数上限 / 登记条数 / 日志档位"),
  "旧枚举必须已从**可执行代码**中消失（注释里留着当教训不算）"
);
ok(
  "★ 而现算那条真的在（`PRECEDENCE_KEYS.map`）—— 否则上一条会因「删了但没替代」而假绿",
  /PRECEDENCE_KEYS\.map\(/.test(evaluated)
);
ok(
  "★ `fileAnchor` 不只是 spec 有、defaults 也必须真有（否则该项永远取不到值）",
  /fileAnchor:\s*false/.test(textOf("lib/part1.js"))
);

console.log("\n=== 四、本版兼容声明（插件市场查不到的那一条）===");
const pkg = JSON.parse(textOf("package.json"));
// ★★★ 2026-10-17（D234 发布时第 2 次撞同一个病）：这里原来**硬编码 `pkg.version === "1.2.4"`**。
//   结果 1.2.5 一升版，它立刻报红 —— 而**代码一个字没改坏**。
//   读回探针那次是"硬编码回读的版本"，这次是"硬编码本版版本"，**同一个病的两个位置**。
//   ⇒ 判据：**版本号只有一个出处（package.json）**；断言要问的是"它是不是**与 npm 一致**"，
//     不是"它是不是等于某个我抄下来的字面量"。
ok("版本号是合法的三段式 semver", /^\d+\.\d+\.\d+$/.test(pkg.version), `实测 ${pkg.version}`);
const rel = pkg.dsh?.compatibility?.dshReleases ?? {};
ok(
  "★ 兼容表里有当前客户端 `0.2.1-rc.2` 且标 compatible（这正是市场查不到的根因）",
  rel["0.2.1-rc.2"] === "compatible",
  `实测 ${String(rel["0.2.1-rc.2"])}`
);
ok("六维设置项文案已进包（面板该看得见）", textOf("lib/defs.js").includes("文件锚定"));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
