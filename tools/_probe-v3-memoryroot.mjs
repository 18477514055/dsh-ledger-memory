/**
 * 探针（D289 · V3 阶段 1）：`inspect()` 的 `memoryRoot` 到底管不管用？
 *
 * ★ 这条探针要证明**两件事**，缺一不可：
 *   ① **V2 行为不变**（`memoryRoot` 未登记 ⇒ `memoryBase === projectRoot`，一切照旧）
 *      —— 这是"不破坏第二代"的技术保证。
 *   ② **V3 生效**（登记了 `memoryRoot` ⇒ 所有记忆路径跟着走，而 `.git` / `.gitignore` /
 *      清单**仍留在项目根**）—— 这是新能力真的接上了。
 *
 * ★★ 还要证明**边界**：`memoryRoot` 写成 `../外面` 时必须**降级回项目根**并如实记入
 *   `unsafePaths`，而不是硬用它（否则一个可编辑的清单字段就能把记忆写出项目外）。
 *
 * 跑法：node tools/_probe-v3-memoryroot.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra === undefined ? "" : `  ← ${extra}`}`);
  }
};

const part2 = await import(new URL("./part2.js", `file://${LIB.replace(/\\/g, "/")}/`).href);

/** 造一个最小项目。 */
function makeProject({ withMemoryRoot }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3mr-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true }); // 假装是 git 仓库
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");

  const memDir = `${path.basename(dir)}-ledger-memory`;
  const base = withMemoryRoot ? path.join(dir, memDir) : dir;
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "LEDGER.md"), "# 台账\n- 一条\n", "utf8");
  fs.mkdirSync(path.join(base, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(base, "decisions", "D1.md"), "## D1\n", "utf8");
  fs.mkdirSync(path.join(base, "_ledger-archive"), { recursive: true });

  const manifest = {
    version: 1,
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    decisionsDir: "decisions",
    archiveDir: "_ledger-archive",
    revision: 1,
    maxActiveLines: 400,
    ...(withMemoryRoot ? { memoryRoot: memDir } : {}),
  };
  fs.writeFileSync(path.join(dir, ".dsh-ledger.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { dir, memDir, manifest };
}

console.log("── ① V2 行为不变：没有 memoryRoot ⇒ memoryBase === projectRoot ──");
{
  const { dir } = makeProject({ withMemoryRoot: false });
  const info = part2.inspect(dir);
  ok("① memoryRoot 为 undefined（V2 形态）", info.memoryRoot === undefined, String(info.memoryRoot));
  ok("① memoryBase === projectRoot", info.memoryBase === info.projectRoot, `${info.memoryBase} vs ${info.projectRoot}`);
  ok("① activeAbs 指向项目根下的 LEDGER.md", info.activeAbs === path.join(dir, "LEDGER.md"), info.activeAbs);
  ok("① 清单路径仍在项目根", info.manifestPath === path.join(dir, ".dsh-ledger.json"), info.manifestPath);
  ok("① 没有 unsafePaths", info.unsafePaths === undefined, JSON.stringify(info.unsafePaths));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n── ② V3 生效：登记 memoryRoot ⇒ 记忆路径跟着走 ──");
{
  const { dir, memDir } = makeProject({ withMemoryRoot: true });
  const info = part2.inspect(dir);
  const memAbs = path.join(dir, memDir);
  ok("② memoryRoot 已登记", info.memoryRoot === memDir, String(info.memoryRoot));
  ok("② memoryBase 指向记忆目录", info.memoryBase === memAbs, `${info.memoryBase}`);
  ok("② ★ activeAbs 指向**记忆目录**里的 LEDGER.md", info.activeAbs === path.join(memAbs, "LEDGER.md"), info.activeAbs);
  ok("② decisionsDir 被验过（safeDecisionsDir 有值）", info.decisionsDir === "decisions", String(info.decisionsDir));
  ok("② archiveRel 有值", typeof info.archiveRel === "string" && info.archiveRel === "_ledger-archive");

  // ★★ 关键：项目类路径**必须仍在项目根**
  ok("② ★★ 清单路径仍指向**项目根**（不跟着搬）", info.manifestPath === path.join(dir, ".dsh-ledger.json"), info.manifestPath);
  ok("② ★★ .gitignore 仍在项目根", info.hasGitignore === true);
  ok("② ★★ isGitRepo 仍为 true（找的是项目根的 .git）", info.isGitRepo === true);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n── ③ 边界：memoryRoot 越界 ⇒ 降级回项目根 + 如实记入 unsafePaths ──");
{
  const { dir } = makeProject({ withMemoryRoot: false });
  // 手改清单，把 memoryRoot 指向项目外
  const mp = path.join(dir, ".dsh-ledger.json");
  const manifest = JSON.parse(fs.readFileSync(mp, "utf8"));
  manifest.memoryRoot = "../../escape-outside";
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2), "utf8");

  const info = part2.inspect(dir);
  ok("③ ★ 越界时 memoryBase 降级回项目根", info.memoryBase === info.projectRoot, info.memoryBase);
  ok("③ ★ memoryRoot 不生效（置 undefined）", info.memoryRoot === undefined, String(info.memoryRoot));
  ok(
    "③ ★ 越界原因如实记入 unsafePaths（不是静默忽略）",
    Array.isArray(info.unsafePaths) && info.unsafePaths.some((u) => u.field === "memoryRoot"),
    JSON.stringify(info.unsafePaths),
  );
  // 且**没有**真的去用那个越界目录
  ok("③ ★ activeAbs 仍指向项目根（没被越界值带跑）", info.activeAbs === path.join(dir, "LEDGER.md"), info.activeAbs);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n── ④ 绝对路径形态的 memoryRoot 也按「项目内」校验 ──");
{
  const { dir } = makeProject({ withMemoryRoot: false });
  const mp = path.join(dir, ".dsh-ledger.json");
  const manifest = JSON.parse(fs.readFileSync(mp, "utf8"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-outside-"));
  manifest.memoryRoot = outside; // 绝对路径，且在项目外
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2), "utf8");

  const info = part2.inspect(dir);
  ok("④ 绝对路径越界 ⇒ 同样降级", info.memoryBase === info.projectRoot, info.memoryBase);
  ok("④ 同样记入 unsafePaths", Array.isArray(info.unsafePaths) && info.unsafePaths.some((u) => u.field === "memoryRoot"));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
