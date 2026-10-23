#!/usr/bin/env node
/**
 * 反向验证 D303：**清单双份（根 = 权威，记忆子目录 = 镜像）必须同步**。
 *
 * 用户原话（逐字）：*"清单保留在外，也在子目录中复制一份（注意同步）"*
 *
 * ★★★ 要证明的六条（缺一不算，纪律 10）：
 *   ① V3：`ledger_init` 之后镜像**真的**出现在 `<memoryRoot>/.dsh-ledger.json`，且与根**逐字节相同**；
 *   ② V2：**没有**镜像（不传 memoryRoot ⇒ 行为与改造前逐字一致）；
 *   ③ `bumpRevision`（每一笔台账写入都走它）之后镜像**跟着变**（这是最容易漏的一处）；
 *   ④ 幂等：内容已相同 ⇒ **不重写**（`changed:false`，mtime 不动）；
 *   ⑤ 权威只读根：**把镜像手改成垃圾，插件读到的仍是根的内容**（证明镜像不会被当成数据源）；
 *   ⑥ 反向：把某个写入口的同步摘掉 ⇒ ③ 必须**变红**。
 *
 * ★ 全程在 `os.tmpdir()` 的一次性目录里跑，不碰真实工作区。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const LIB = path.join(PROJECT, "lib");

const mm = await import(pathToFileURL(path.join(LIB, "manifest-mirror.js")).href);
const part2 = await import(pathToFileURL(path.join(LIB, "part2.js")).href);
const part1 = await import(pathToFileURL(path.join(LIB, "part1.js")).href);
const part4 = await import(pathToFileURL(path.join(LIB, "part4.js")).href);

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail === undefined ? "" : `  —— ${detail}`}`);
};

const MANIFEST = ".dsh-ledger.json";
const MIRROR_NAME = ".dsh-ledger.json";

function mkFixture(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ledger-mirror-${kind}-`));
  const args = {
    root,
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    archiveDir: "_ledger-archive",
  };
  if (kind === "v3") args.memoryRoot = "mem-ledger-memory";
  return { root, args };
}

/** 直接调 ledger_init 的执行体（它是 defineInitTool 返回对象里的 execute） */
async function runInit(args) {
  const tool = part4.defineInitTool();
  // execute(args, exec) —— exec 只需要能给 root；不传 exec 时 tool 内部走 rootFromExec 的兜底
  return tool.execute(args, { agent: undefined });
}

console.log("═".repeat(76));
console.log("反向验证 D303：清单双份（根 = 权威 · 子目录 = 镜像 · 必须同步）");
console.log("═".repeat(76));

// ── ① V3：init 之后镜像存在且逐字节相同 ─────────────────────────────────
console.log("\n【夹具 A】V3（传 memoryRoot）");
const A = mkFixture("v3");
const rA = await runInit(A.args);
const rootManifestA = path.join(A.root, MANIFEST);
const mirrorA = path.join(A.root, "mem-ledger-memory", MIRROR_NAME);
ok("A0 基线：根清单存在", fs.existsSync(rootManifestA), "");
ok("① init 之后镜像**真的**存在", fs.existsSync(mirrorA), mirrorA);
ok(
  "① 镜像与根**逐字节相同**",
  fs.existsSync(mirrorA) && fs.readFileSync(mirrorA, "utf8") === fs.readFileSync(rootManifestA, "utf8"),
  ""
);
ok("① 回执里如实报告了镜像", rA?.manifestMirror !== undefined, JSON.stringify(rA?.manifestMirror ?? null));
const verA = mm.verifyManifestMirror(A.root, JSON.parse(fs.readFileSync(rootManifestA, "utf8")));
ok("① verifyManifestMirror 判为 in-sync", verA.state === "in-sync", verA.state);

// ── ② V2：没有镜像 ──────────────────────────────────────────────────────
console.log("\n【夹具 B】V2（不传 memoryRoot）");
const B = mkFixture("v2");
const rB = await runInit(B.args);
const subFilesB = fs.readdirSync(B.root).filter((n) => n !== "LEDGER.md" && n !== "DECISIONS.md" && n !== "_ledger-archive");
ok("② V2 项目根下没有多出任何子目录", !subFilesB.some((n) => fs.statSync(path.join(B.root, n)).isDirectory()), subFilesB.join(","));
ok("② V2 回执里**没有** manifestMirror 字段", rB?.manifestMirror === undefined, String(rB?.manifestMirror));
ok("② V2 的 verifyManifestMirror 判为 v2（本就该没有）", mm.verifyManifestMirror(B.root, { active: "LEDGER.md" }).state === "v2", "");

// ── ③ bumpRevision 之后镜像跟着变（每一笔台账写入都走这里）──────────────
console.log("\n【夹具 A 续】bumpRevision ⇒ 镜像必须跟着走");
const beforeRev = JSON.parse(fs.readFileSync(rootManifestA, "utf8")).revision;
const newRev = part1.bumpRevision(A.root);
const mirrorJson = JSON.parse(fs.readFileSync(mirrorA, "utf8"));
ok("③ bumpRevision 返回了新 revision", typeof newRev === "number", String(newRev));
ok(
  "③ 镜像里的 revision 也是新的（没落后）",
  mirrorJson.revision === newRev,
  `镜像=${mirrorJson.revision} 根=${JSON.parse(fs.readFileSync(rootManifestA, "utf8")).revision}`
);
ok(
  "③ 镜像与根仍逐字节相同",
  fs.readFileSync(mirrorA, "utf8") === fs.readFileSync(rootManifestA, "utf8"),
  ""
);
ok("③ verifyManifestMirror 仍判 in-sync", mm.verifyManifestMirror(A.root, JSON.parse(fs.readFileSync(rootManifestA, "utf8"))).state === "in-sync", "");

// ── ④ 幂等：内容相同不重写 ──────────────────────────────────────────────
console.log("\n【夹具 A 续】幂等");
const mtimeBefore = fs.statSync(mirrorA).mtimeMs;
const again = mm.syncManifestMirror(A.root, JSON.parse(fs.readFileSync(rootManifestA, "utf8")));
const mtimeAfter = fs.statSync(mirrorA).mtimeMs;
ok("④ 内容相同时 changed === false", again.changed === false, JSON.stringify(again));
ok("④ mtime 没有变（没制造无意义的写盘）", mtimeBefore === mtimeAfter, `${mtimeBefore} → ${mtimeAfter}`);

// ── ⑤ 权威只读根：把镜像改成垃圾，读到的仍是根 ──────────────────────────
console.log("\n【夹具 A 续】权威只读根（镜像被污染也不影响插件）");
fs.writeFileSync(mirrorA, '{"完全不是清单": true}\n', "utf8");
const readBack = part2.readManifest(A.root);
ok("⑤ 镜像被手改成垃圾后，readManifest 读到的仍是**根**的内容", readBack?.active === "LEDGER.md", `active=${readBack?.active}`);
ok("⑤ 且镜像里的垃圾键**没有**渗进读结果", readBack !== undefined && readBack["完全不是清单"] === undefined, "");
ok(
  "⑤ verifyManifestMirror 如实报 stale（不同步要说出来）",
  mm.verifyManifestMirror(A.root, readBack).state === "stale",
  mm.verifyManifestMirror(A.root, readBack).state
);

// ── ⑥ 反向：摘掉 bumpRevision 里的同步 ⇒ ③ 必须变红 ─────────────────────
console.log("\n【反向】摘掉 bumpRevision 的同步");
const P1 = path.join(LIB, "part1.js");
const src1 = fs.readFileSync(P1, "utf8");
const NEEDLE = "syncManifestMirror(root, next, manifestText);";
if (!src1.includes(NEEDLE)) {
  ok("⑥ 反向验证前置：part1.js 里有那行同步", false, "找不到 ⇒ 前提不成立");
} else {
  try {
    fs.writeFileSync(P1, src1.replace(NEEDLE, "/* 反向验证：故意不同步 */"), "utf8");
    const A2 = mkFixture("v3");
    await runInit(A2.args); // 先建（init 那条路仍有同步）
    const mirrorA2 = path.join(A2.root, "mem-ledger-memory", MIRROR_NAME);
    // 清掉镜像，模拟"init 建完、之后一直没有同步"
    fs.rmSync(mirrorA2, { force: true });
    const mod1 = await import(`${pathToFileURL(P1).href}?t=${Date.now()}`);
    mod1.bumpRevision(A2.root);
    const reappeared = fs.existsSync(mirrorA2);
    ok("⑥ 反向（摘掉同步）：bumpRevision 后镜像**没有**跟着建/更新 ⇒ 断言能看见红", reappeared === false, `exists=${reappeared}`);
  } finally {
    fs.writeFileSync(P1, src1, "utf8");
    console.log(`  （part1.js 已还原 ${Buffer.byteLength(fs.readFileSync(P1))} B）`);
  }
  ok("⑥ 还原后与原件逐字相同", fs.readFileSync(P1, "utf8") === src1, "");
}

const bad = results.filter((r) => r.pass !== true).length;
console.log("\n" + "─".repeat(76));
console.log(`${results.length - bad} PASS / ${bad} FAIL`);
console.log("─".repeat(76));
process.exit(bad === 0 ? 0 : 1);
