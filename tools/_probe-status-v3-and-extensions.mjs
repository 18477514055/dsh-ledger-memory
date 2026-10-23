#!/usr/bin/env node
/**
 * 反向验证 D305 / D306（010 的 B-04 与 C-02）：
 *   ① `ledger_status` 必须能回答"这项目是第几代"（memoryRoot / memoryBase / isV3 / autoStage / manifestMirror）；
 *   ② `memorySurfaces` 必须收录 `extensions/`，且**只在它真的存在时**才收录。
 *
 * ★ 全程一次性目录，不碰真实工作区。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const LIB = path.join(PROJECT, "lib");

const part2 = await import(pathToFileURL(path.join(LIB, "part2.js")).href);
const part3 = await import(pathToFileURL(path.join(LIB, "part3.js")).href);
const part6 = await import(pathToFileURL(path.join(LIB, "part6.js")).href);
const part8 = await import(pathToFileURL(path.join(LIB, "part8.js")).href);

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail === undefined ? "" : `  —— ${detail}`}`);
};

function mkFixture(kind, withExt) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ledger-st-${kind}-`));
  const m = { version: 1, revision: 7, active: "LEDGER.md", archiveDir: "_ledger-archive" };
  if (kind === "v3") m.memoryRoot = "mem-ledger-memory";
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify(m, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# t\n", "utf8");
  fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });
  const memBase = kind === "v3" ? path.join(root, "mem-ledger-memory") : root;
  if (kind === "v3") fs.mkdirSync(memBase, { recursive: true });
  if (withExt) {
    fs.mkdirSync(path.join(memBase, "extensions", "example-1"), { recursive: true });
    fs.writeFileSync(path.join(memBase, "extensions", "registry.json"), JSON.stringify({ items: [] }, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(memBase, "extensions", "example-1", "note.md"), "# 扩展\n", "utf8");
  }
  return root;
}

console.log("═".repeat(76));
console.log("反向验证 D305/D306：ledger_status 的 V3 回显 + 面表收录 extensions/");
console.log("═".repeat(76));

// ── ① 结构断言：status 返回体里必须有那几个字段（读源码，因为 execute 需要活内核） ──
console.log("\n【①】ledger_status 的字段（结构断言 + 取值计算）");
const p3 = fs.readFileSync(path.join(LIB, "part3.js"), "utf8");
for (const k of ["memoryRoot:", "memoryBase:", "isV3:", "memoryRootUnsafe:", "autoGitAddConfigured:", "autoStage:", "manifestMirror:"]) {
  ok(`① 源码里有 \`${k}\``, p3.includes(k), "");
}
// ★ 取值必须真的能算出来（不是只写了个字段名）
const v3 = mkFixture("v3", true);
const infoV3 = part2.inspect(v3);
ok("① V3 夹具：inspect 给出 memoryRoot", infoV3.memoryRoot === "mem-ledger-memory", String(infoV3.memoryRoot));
ok("① V3 夹具：memoryBaseOf 落到子目录", part2.memoryBaseOf(infoV3, v3) === path.join(v3, "mem-ledger-memory"), part2.memoryBaseOf(infoV3, v3));
ok("① V3 夹具：isV3 的判据（memoryBase !== root）为真", path.resolve(part2.memoryBaseOf(infoV3, v3)) !== path.resolve(v3), "");
// ★★★ 这里必须**建一个 .git** 才测得到"V3 拒绝 stage"：
//   🔴 我第一版没建，断言靠 "项目不是 git 仓库" 通过了 —— **那是假绿**：
//     它证明的是"不是仓库就不 stage"，与 V3 无关。夹具前提错了 ⇒ 全绿也是假绿（纪律 8）。
fs.mkdirSync(path.join(v3, ".git"), { recursive: true });
fs.writeFileSync(path.join(v3, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
const stageV3 = part2.shouldAutoStage(part2.inspect(v3));
ok(
  "① V3（**真 git 仓库**）+ 清单 autoGitAdd:true ⇒ 仍然拒绝、且理由是 V3",
  stageV3.allow === false && stageV3.v3 === true,
  `allow=${stageV3.allow} v3=${stageV3.v3} reason=${String(stageV3.reason).slice(0, 30)}`
);
const v2 = mkFixture("v2", false);
const infoV2 = part2.inspect(v2);
ok("① V2 夹具：memoryRoot 为 undefined（不是 V3）", infoV2.memoryRoot === undefined, String(infoV2.memoryRoot));
ok("① V2 夹具：isV3 的判据为假（memoryBase === root）", path.resolve(part2.memoryBaseOf(infoV2, v2)) === path.resolve(v2), "");

// ── ② 面表：extensions 只在存在时进榜 ────────────────────────────────────
console.log("\n【②】记忆面地图收录 extensions/");
const surfWith = part6.memorySurfaces(infoV3);
const hasExt = surfWith.some((s) => s.rel === "extensions");
ok("② 有扩展时：面表里**有** extensions", hasExt, surfWith.map((s) => s.rel).join(","));
const extItem = surfWith.find((s) => s.rel === "extensions");
ok("② 它归在 conclusion（判据型，不与调研稿抢排序）", extItem?.kind === "conclusion", String(extItem?.kind));
ok("② 它用 memory 基准（跟着 memoryRoot 走）", extItem?.base === "memory", String(extItem?.base));

const v3NoExt = mkFixture("v3", false);
const surfNoExt = part6.memorySurfaces(part2.inspect(v3NoExt));
ok("② 没有扩展时：面表里**没有** extensions（不稀释信号）", !surfNoExt.some((s) => s.rel === "extensions"), "");

// ── ③ 口径分叉钉住：part8 的 EXT_DIR 必须与 part6 的常量相同 ──────────────
console.log("\n【③】两处字面量必须相同（口径分叉只会在有人比对时暴露）");
ok("③ part8.EXT_DIR === 'extensions'", part8.EXT_DIR === "extensions", String(part8.EXT_DIR));
ok(
  "③ part6 里那个常量也是 'extensions'",
  fs.readFileSync(path.join(LIB, "part6.js"), "utf8").includes('const EXTENSIONS_DIR = "extensions";'),
  ""
);

// ── ④ 反向：摘掉 extensions 那段 ⇒ ② 必须变红 ───────────────────────────
console.log("\n【④】反向验证");
const P6 = path.join(LIB, "part6.js");
const src6 = fs.readFileSync(P6, "utf8");
const NEEDLE = 'push(EXTENSIONS_DIR, "扩展记忆", "conclusion"';
if (!src6.includes(NEEDLE)) {
  ok("④ 反向验证前置：part6 里有那一行 push", false, "找不到 ⇒ 前提不成立");
} else {
  const backup = src6;
  try {
    // 把"存在才 push"改成"永不 push"（模拟 010 报的那个状态）
    fs.writeFileSync(P6, src6.replace(NEEDLE, 'void 0; // 反向验证：不收录 \n      push("__never__", "扩展记忆", "conclusion"'), "utf8");
    const mod6 = await import(`${pathToFileURL(P6).href}?t=${Date.now()}`);
    const s2 = mod6.memorySurfaces(part2.inspect(mkFixture("v3", true)));
    ok("④ 反向（摘掉收录）：extensions **不再**进榜 ⇒ 断言能看见红", !s2.some((s) => s.rel === "extensions"), "");
  } finally {
    fs.writeFileSync(P6, backup, "utf8");
    console.log(`  （part6.js 已还原 ${Buffer.byteLength(fs.readFileSync(P6))} B）`);
  }
  ok("④ 还原后与原件逐字相同", fs.readFileSync(P6, "utf8") === backup, "");
}

const bad = results.filter((r) => r.pass !== true).length;
console.log("\n" + "─".repeat(76));
console.log(`${results.length - bad} PASS / ${bad} FAIL`);
console.log("─".repeat(76));
process.exit(bad === 0 ? 0 : 1);
